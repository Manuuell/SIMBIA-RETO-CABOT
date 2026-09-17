"""Documentos de un tramite en el VITAL antiguo (SILPA).

El buscador nuevo (`vital.py`) dice que un tramite existe. Los documentos --la
solicitud, la resolucion, la caracterizacion-- viven en el VITAL antiguo, una
aplicacion ASP.NET con sesion y ViewState. La nota que decia que ese portal
rechazaba clientes que no fueran navegador resulto ser falsa para estas
paginas: se comprobo en septiembre de 2026 descargando desde Python la
solicitud de renovacion del permiso de Mexichem (1,3 MB, PDF valido).

EL FLUJO, TAL COMO LO HACE EL NAVEGADOR
---------------------------------------

1. GET  ReportetramiteCPDetalle.aspx?NumSilpa=&Origen=&TarSolId=&Solicitante=
        -> crea la sesion (cookie ASP.NET_SessionId).
2. POST ReporteTramiteCPDetalle.aspx/ConsultarDetalleSolicitud (JSON con
        comillas simples, tal cual lo manda su JS) -> informacion general,
        estado del tramite y siete listas de "entradas" de documentos
        (seguimiento, evaluacion, investigacion, cobros, otros, reposicion,
        modificacion). Cada entrada es una carpeta, no un archivo.
3. POST ReporteTramiteCPDetalle.aspx/MostrarDocumentos con UNA entrada
        -> la deja en la SESION y devuelve la URL de la pagina de descarga.
4. GET  DescargarDocumentos.aspx -> lista los archivos de esa entrada, con
        un enlace __doPostBack por archivo y los campos ocultos del ViewState.
5. POST DescargarDocumentos.aspx con __EVENTTARGET del archivo -> los bytes.
        El Content-Type dice 'application/base64' aunque sean bytes de PDF:
        hay que fiarse de los bytes, no de la cabecera.

A un cliente que no es navegador le sirve un HTML "downlevel" (con <font> y
&#39;), distinto del que ve Chrome. El parser tolera los dos.

Todo con limite de tasa, User-Agent identificado y cache del detalle (los
bytes de los archivos no se cachean: se guardan en el expediente si el
usuario lo pide).
"""

from __future__ import annotations

import html
import json
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .fuentes.base import (
    TIMEOUT_S, USER_AGENT, Modo, escribir_cache, esperar_turno,
    leer_cache_con_fecha, modo_actual,
)

FUENTE = "vital-detalle"
BASE = "https://vital.minambiente.gov.co/SILPA_UT_PRE/ReporteTramite/"
PAGINA_DETALLE = BASE + "ReportetramiteCPDetalle.aspx"
METODO = BASE + "ReporteTramiteCPDetalle.aspx/"
PAGINA_DESCARGA = BASE + "DescargarDocumentos.aspx"
TTL_HORAS = 24.0 * 7
INTERVALO_S = 1.5
#: Un expediente de licencia puede pesar; por encima de esto no se proxea.
MAX_BYTES = 60 * 1024 * 1024

#: Las siete listas del detalle y el nombre con que se muestran.
CARPETAS: tuple[tuple[str, str], ...] = (
    ("lsDocumentosSeguimiento", "Solicitud y seguimiento"),
    ("lsDocumentosEvaluacion", "Evaluacion"),
    ("lsDocumentosInvestigacion", "Investigacion"),
    ("lsDocumentosCobros", "Cobros"),
    ("lsDocumentosOtros", "Otros"),
    ("lsDocumentosRepocision", "Reposicion"),
    ("lsDocumentosModificacion", "Modificacion"),
)

_FILA = re.compile(
    r"<td[^>]*>\s*(?:<font[^>]*>)?\s*([^<]+?)\s*(?:</font>)?\s*</td>\s*<td>.*?"
    r"__doPostBack\((?:&#39;|')([^&']+)(?:&#39;|')",
    re.S,
)
_OCULTO = re.compile(r'<input type="hidden" name="(__[A-Z]+)" id="__[A-Z]+" value="([^"]*)"')
_JSON_CABECERA = {"Content-Type": "application/json; charset=utf-8"}


# --------------------------------------------------------------------------
# Modelo
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Tramite:
    """Identidad de un tramite en el VITAL antiguo. Sale del buscador nuevo."""

    radicado: str          # sol_num_silpa
    origen: str            # VITAL | SILAMC
    sol_id: str            # tar_sol_id
    solicitante_id: str    # sol_id_solicitante

    @property
    def clave(self) -> str:
        return f"{self.radicado}|{self.origen}|{self.sol_id}|{self.solicitante_id}"

    @property
    def url_portal(self) -> str:
        return (
            f"{PAGINA_DETALLE}?NumSilpa={self.radicado}&Origen={self.origen}"
            f"&TarSolId={self.sol_id}&Solicitante={self.solicitante_id}&TipoConsulta=Todos"
        )


@dataclass
class Archivo:
    indice: int
    nombre: str
    objetivo: str          # __EVENTTARGET del postback

    def as_dict(self) -> dict[str, Any]:
        return {"indice": self.indice, "nombre": self.nombre, "extension": Path(self.nombre).suffix.lower()}


@dataclass
class Carpeta:
    grupo: str             # clave de la lista en el detalle
    titulo: str
    entrada: int           # posicion dentro de la lista
    etiqueta: str          # lo que VITAL llama 'lblDocumento'
    fecha: str
    archivos: list[Archivo] = field(default_factory=list)
    incidencia: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "grupo": self.grupo, "titulo": self.titulo, "entrada": self.entrada,
            "etiqueta": self.etiqueta, "fecha": self.fecha,
            "archivos": [a.as_dict() for a in self.archivos], "incidencia": self.incidencia,
        }


@dataclass
class Detalle:
    tramite: Tramite
    solicitante: str = ""
    expediente: str = ""
    tramite_nombre: str = ""
    autoridad: str = ""
    proyecto: str = ""
    ubicacion: str = ""
    sector: str = ""
    estado: list[dict[str, str]] = field(default_factory=list)
    carpetas: list[Carpeta] = field(default_factory=list)
    origen_dato: str = "red"
    fecha_dato: str = ""
    incidencia: str = ""

    @property
    def total_archivos(self) -> int:
        return sum(len(c.archivos) for c in self.carpetas)

    def as_dict(self) -> dict[str, Any]:
        return {
            "radicado": self.tramite.radicado, "origen": self.tramite.origen,
            "sol_id": self.tramite.sol_id, "solicitante_id": self.tramite.solicitante_id,
            "url_portal": self.tramite.url_portal,
            "solicitante": self.solicitante, "expediente": self.expediente,
            "tramite": self.tramite_nombre, "autoridad": self.autoridad,
            "proyecto": self.proyecto, "ubicacion": self.ubicacion, "sector": self.sector,
            "estado": self.estado, "carpetas": [c.as_dict() for c in self.carpetas],
            "total_archivos": self.total_archivos,
            "origen_dato": self.origen_dato, "fecha_dato": self.fecha_dato,
            "incidencia": self.incidencia,
        }


# --------------------------------------------------------------------------
# Sesion con el VITAL antiguo
# --------------------------------------------------------------------------

_cliente = None
_candado = threading.Lock()


def _sesion():
    """Un cliente con cookies, compartido: la sesion ASP.NET vive en ellas."""
    global _cliente
    import httpx2 as httpx
    with _candado:
        if _cliente is None:
            _cliente = httpx.Client(
                headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT_S * 2,
                follow_redirects=True,
            )
        return _cliente


def _reiniciar_sesion() -> None:
    global _cliente
    with _candado:
        if _cliente is not None:
            _cliente.close()
        _cliente = None


def _limpio(v: Any) -> str:
    t = "" if v is None else str(v).strip()
    return "" if t == "None" else t


def _json_aspnet(texto: str) -> Any:
    """Los metodos de pagina devuelven o bien la lista, o bien {'d': '<json>'}."""
    cuerpo = json.loads(texto)
    if isinstance(cuerpo, dict) and "d" in cuerpo:
        return json.loads(cuerpo["d"]) if isinstance(cuerpo["d"], str) else cuerpo["d"]
    return cuerpo


def _consultar_detalle_red(t: Tramite) -> tuple[dict[str, Any], dict[str, Any]]:
    """Devuelve (datos del detalle, entradas crudas por grupo)."""
    c = _sesion()
    esperar_turno("vital-antiguo", INTERVALO_S)
    c.get(PAGINA_DETALLE, params={
        "NumSilpa": t.radicado, "Origen": t.origen, "TarSolId": t.sol_id,
        "Solicitante": t.solicitante_id, "TipoConsulta": "Todos",
    }).raise_for_status()
    esperar_turno("vital-antiguo", INTERVALO_S)
    # Su propio JS manda un JSON con comillas simples. Se imita tal cual.
    cuerpo = (
        f"{{'parametroDetalle':'{t.radicado}', 'idSolicitante':'{t.solicitante_id}', "
        f"'sol_id':'{t.sol_id}', 'origen':'{t.origen}' }}"
    )
    r = c.post(METODO + "ConsultarDetalleSolicitud", content=cuerpo, headers=_JSON_CABECERA)
    r.raise_for_status()
    datos = _json_aspnet(r.text)
    if not datos:
        raise ValueError("el detalle vino vacio")
    return datos[0], {grupo: datos[0].get(grupo) or [] for grupo, _ in CARPETAS}


def _listar_archivos(entrada: dict[str, Any]) -> tuple[list[Archivo], dict[str, str]]:
    """Fija la entrada en la sesion y lee la pagina de descarga."""
    c = _sesion()
    esperar_turno("vital-antiguo", INTERVALO_S)
    r = c.post(
        METODO + "MostrarDocumentos",
        content="{'lstDocumentosSeguimiento':'" + json.dumps(entrada) + "' }",
        headers=_JSON_CABECERA,
    )
    r.raise_for_status()
    if "ERROR" in r.text[:40].upper():
        raise ValueError(r.text.strip('" '))
    esperar_turno("vital-antiguo", INTERVALO_S)
    pagina = c.get(PAGINA_DESCARGA)
    pagina.raise_for_status()
    archivos = [
        Archivo(i, html.unescape(nombre).strip(), objetivo)
        for i, (nombre, objetivo) in enumerate(_FILA.findall(pagina.text))
    ]
    ocultos = {k: html.unescape(v) for k, v in _OCULTO.findall(pagina.text)}
    return archivos, ocultos


def _interpretar(t: Tramite, datos: dict[str, Any]) -> Detalle:
    resumen = (datos.get("lstResumenEstado") or {}).get("resumenTramite") or []
    return Detalle(
        tramite=t,
        solicitante=_limpio(datos.get("lblSolicitante")),
        expediente=_limpio(datos.get("lblCodigoExpediente")).lstrip("- ").strip(),
        tramite_nombre=_limpio(datos.get("lblTramite")),
        autoridad=_limpio(datos.get("lblAutoridadAmbiental")),
        proyecto=_limpio(datos.get("lblNombreProyectoValue")),
        ubicacion=_limpio(datos.get("lblUbicacion")).strip("- "),
        sector=_limpio(datos.get("lblSector")),
        estado=[
            {
                "paso": _limpio(p.get("date")),
                "hecho": "ejecutada" in _limpio(p.get("content")).lower(),
            }
            for p in resumen
        ],
    )


def detalle(t: Tramite, modo: Modo | None = None) -> Detalle:
    """Informacion, estado y archivos de cada carpeta del tramite."""
    modo = modo or modo_actual()
    ttl = 0.0 if modo is Modo.OFFLINE else TTL_HORAS
    cacheado, fecha = leer_cache_con_fecha(FUENTE, t.clave, ttl)
    if cacheado is not None and modo is not Modo.VIVO:
        d = Detalle(tramite=t, **{k: v for k, v in cacheado["detalle"].items() if k != "carpetas"})
        d.carpetas = [
            Carpeta(**{**c, "archivos": [Archivo(**a) for a in c["archivos"]]})
            for c in cacheado["detalle"]["carpetas"]
        ]
        d.origen_dato, d.fecha_dato = "cache", fecha
        return d
    if modo is Modo.OFFLINE:
        return Detalle(tramite=t, origen_dato="sin dato", incidencia=(
            "Sin red no se puede consultar el detalle de este tramite: no esta en la cache."
        ))

    try:
        datos, entradas = _consultar_detalle_red(t)
    except Exception as exc:                                # noqa: BLE001
        _reiniciar_sesion()
        return Detalle(tramite=t, origen_dato="sin dato", incidencia=(
            f"El VITAL antiguo no respondio: {type(exc).__name__}: {exc}"
        ))

    d = _interpretar(t, datos)
    for grupo, titulo in CARPETAS:
        for i, entrada in enumerate(entradas.get(grupo) or []):
            carpeta = Carpeta(
                grupo=grupo, titulo=titulo, entrada=i,
                etiqueta=_limpio(entrada.get("lblDocumento")),
                fecha=_limpio(entrada.get("lblSolFechaCreacion")),
            )
            try:
                carpeta.archivos, _ = _listar_archivos(entrada)
            except Exception as exc:                        # noqa: BLE001
                carpeta.incidencia = f"No se pudo listar: {type(exc).__name__}: {exc}"
            d.carpetas.append(carpeta)

    escribir_cache(FUENTE, t.clave, {"detalle": {
        "solicitante": d.solicitante, "expediente": d.expediente,
        "tramite_nombre": d.tramite_nombre, "autoridad": d.autoridad,
        "proyecto": d.proyecto, "ubicacion": d.ubicacion, "sector": d.sector,
        "estado": d.estado,
        "carpetas": [
            {**c.as_dict(), "archivos": [vars(a) for a in c.archivos]} for c in d.carpetas
        ],
    }})
    return d


@dataclass
class Descarga:
    nombre: str
    contenido: bytes
    tipo: str


def _tipo(nombre: str, contenido: bytes) -> str:
    """Por los bytes primero; la cabecera del servidor miente."""
    if contenido[:5] == b"%PDF-":
        return "application/pdf"
    if contenido[:5] == b"{\\rtf":
        return "application/rtf"
    if contenido[:2] == b"PK":
        return "application/zip"
    ext = Path(nombre).suffix.lower()
    return {
        ".pdf": "application/pdf", ".rtf": "application/rtf",
        ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    }.get(ext, "application/octet-stream")


def descargar(t: Tramite, grupo: str, entrada: int, indice: int) -> Descarga:
    """Bytes de un archivo. Rehace el flujo entero: la sesion es fragil."""
    if grupo not in {g for g, _ in CARPETAS}:
        raise ValueError(f"Carpeta desconocida: {grupo}")
    try:
        _, entradas = _consultar_detalle_red(t)
        lista = entradas.get(grupo) or []
        if not 0 <= entrada < len(lista):
            raise ValueError("La entrada no existe en ese tramite")
        archivos, ocultos = _listar_archivos(lista[entrada])
        if not 0 <= indice < len(archivos):
            raise ValueError("El archivo no existe en esa carpeta")
        archivo = archivos[indice]
        c = _sesion()
        esperar_turno("vital-antiguo", INTERVALO_S)
        with c.stream(
            "POST", PAGINA_DESCARGA,
            data={**ocultos, "__EVENTTARGET": archivo.objetivo, "__EVENTARGUMENT": ""},
        ) as r:
            r.raise_for_status()
            trozos: list[bytes] = []
            total = 0
            for trozo in r.iter_bytes():
                total += len(trozo)
                if total > MAX_BYTES:
                    raise ValueError(f"El archivo supera {MAX_BYTES // 1024 // 1024} MB")
                trozos.append(trozo)
        contenido = b"".join(trozos)
    except Exception:
        _reiniciar_sesion()
        raise
    if contenido[:200].lstrip().lower().startswith((b"<!doctype", b"<html")):
        raise ValueError("El VITAL antiguo devolvio una pagina en vez del archivo (sesion caducada)")
    return Descarga(nombre=archivo.nombre, contenido=contenido, tipo=_tipo(archivo.nombre, contenido))


def nombre_seguro(nombre: str) -> str:
    limpio = "".join(c if c.isalnum() or c in "-_. ()" else "_" for c in nombre).strip()
    return limpio[:140] or "documento"
