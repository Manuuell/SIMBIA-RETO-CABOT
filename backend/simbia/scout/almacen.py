"""Persistencia del modulo de prospeccion.

Dos cosas se guardan en disco y por razones distintas:

**El estado comercial** (`estado.json`). Un barrido es reproducible: si se
vuelve a lanzar manana sale lo mismo. Lo que no es reproducible es el trabajo
humano encima: a quien se llamo, quien contesto, que se firmo. Eso hay que
guardarlo o se pierde.

**Las instantaneas** (`instantaneas/`). Cada barrido se archiva para poder
comparar con el siguiente. Es lo que permite decir "aparecio una empresa
nueva" o "a este vecino le cambiaron el caudal autorizado".

LA CLAVE ESTABLE
----------------

El codigo de un prospecto (`P01`, `P02`...) se asigna por orden de cercania
dentro de un barrido, asi que cambia entre barridos: si aparece una empresa
mas cerca, todo lo de atras se desplaza. Guardar el estado comercial contra
ese codigo perderia el trabajo en cuanto cambiara el catalogo.

Por eso el estado se guarda contra una **clave estable**: hash del nombre
normalizado mas la coordenada redondeada a ~100 m. Sobrevive a cambios de
orden, a variaciones menores del nombre y a que una fuente afine la
coordenada.

No sobrevive a que una empresa cambie de razon social o de coordenada: la
clave deja de coincidir y la ficha queda **huerfana**. Paso en el primer
barrido real: la ficha se creo con "Cementos Argos" (instantanea de trabajo)
y OpenStreetMap la llama "Argos S.A.". Para eso la ficha guarda tambien el
nombre y la coordenada con que se creo, y `vincular_fichas` la reencuentra
por parecido de nombre con dos salvaguardas: si hay coordenada, el prospecto
tiene que estar a menos de 600 m; si no la hay, el candidato tiene que ser
unico. Lo que no se reencuentra se lista como huerfano para reasignarlo a
mano: el trabajo comercial no se pierde en silencio.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .geo import haversine_km
from .perfil import ORDEN_ESTADO, Estado, Prospecto, Referencia
from .texto import normalizar, parecido

BASE = Path(__file__).resolve().parent / "archivo"
ESTADOS = BASE / "estado.json"
INSTANTANEAS = BASE / "instantaneas"


def clave_estable(nombre: str, lat: float, lon: float) -> str:
    """Identidad de un prospecto que sobrevive entre barridos."""
    # 3 decimales de grado son ~110 m: suficiente para tolerar que dos
    # fuentes situen la misma planta en esquinas distintas del predio.
    semilla = f"{normalizar(nombre)}|{lat:.3f}|{lon:.3f}"
    return hashlib.sha256(semilla.encode("utf-8")).hexdigest()[:12]


# --------------------------------------------------------------------------
# Ficha comercial
# --------------------------------------------------------------------------

#: Que hace falta para pasar de cada etapa a la siguiente. El dashboard lo
#: muestra como "siguiente paso", que es la unica pregunta que un comercial
#: se hace al abrir la ficha.
REQUISITO_SIGUIENTE: dict[Estado, str] = {
    Estado.DETECTADO: (
        "Verificar que la corriente existe y estimar su caudal: consulta del "
        "permiso de vertimiento o llamada de sondeo"
    ),
    Estado.CALIFICADO: (
        "Identificar interlocutor tecnico (jefe de planta o de ambiental) y "
        "presentar la propuesta de simbiosis"
    ),
    Estado.CONTACTADO: (
        "Firmar acuerdo de confidencialidad para poder intercambiar analitica "
        "y datos de proceso"
    ),
    Estado.NDA: (
        "Campana de caracterizacion: minimo tres muestras compuestas en "
        "condiciones distintas de operacion"
    ),
    Estado.CARACTERIZADO: (
        "Piloto en campo con el tren de tratamiento propuesto, midiendo "
        "ciclos reales sostenidos"
    ),
    Estado.PILOTO: (
        "Negociar contrato de suministro: caudal firme, calidad garantizada, "
        "penalizaciones y plazo"
    ),
    Estado.CONTRATADO: "Contrato firmado. Pasa a ejecucion de obra.",
    Estado.DESCARTADO: "Descartado. Revisar si cambian las condiciones.",
}


@dataclass
class Ficha:
    """Trabajo humano acumulado sobre un prospecto."""

    clave: str
    estado: Estado = Estado.DETECTADO
    responsable: str = ""
    contacto: str = ""
    proximo_paso: str = ""
    notas: str = ""
    historial: list[dict[str, str]] = field(default_factory=list)
    actualizado: str = ""
    #: Identidad legible con la que se creo, para reencontrarla cuando la
    #: clave deje de coincidir. Las fichas antiguas no traen coordenada.
    nombre: str = ""
    lat: float | None = None
    lon: float | None = None
    #: Tramites de VITAL vinculados a mano desde el buscador. Cada uno lleva
    #: expediente, radicado, autoridad, tramite, titular y fecha. Entran al
    #: prospecto como referencias 'vital', igual que las del cruce automatico.
    expedientes: list[dict[str, str]] = field(default_factory=list)
    #: Documentos del expediente guardados en disco (nombre, ruta, radicado).
    documentos: list[dict[str, Any]] = field(default_factory=list)

    @property
    def avance(self) -> float:
        """Progreso en el embudo, 0-1. Un descarte vale 0."""
        if self.estado is Estado.DESCARTADO:
            return 0.0
        return (ORDEN_ESTADO.index(self.estado) + 1) / len(ORDEN_ESTADO)

    @property
    def requisito(self) -> str:
        return REQUISITO_SIGUIENTE.get(self.estado, "")

    def as_dict(self) -> dict[str, Any]:
        return {
            "clave": self.clave,
            "estado": self.estado.value,
            "responsable": self.responsable,
            "contacto": self.contacto,
            "proximo_paso": self.proximo_paso or self.requisito,
            "requisito": self.requisito,
            "notas": self.notas,
            "historial": self.historial,
            "actualizado": self.actualizado,
            "avance": round(self.avance, 3),
            "nombre": self.nombre,
            "expedientes": self.expedientes,
            "documentos": self.documentos,
        }


def _leer_json(ruta: Path, defecto):
    if not ruta.is_file():
        return defecto
    try:
        return json.loads(ruta.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return defecto


def cargar_fichas() -> dict[str, Ficha]:
    bruto = _leer_json(ESTADOS, {})
    fichas: dict[str, Ficha] = {}
    for clave, d in bruto.items():
        try:
            estado = Estado(d.get("estado", "detectado"))
        except ValueError:
            estado = Estado.DETECTADO
        historial = d.get("historial", [])
        # Las fichas anteriores a `nombre` solo lo tienen en el historial.
        nombre = d.get("nombre") or next(
            (h.get("empresa", "") for h in reversed(historial) if h.get("empresa")), "",
        )
        fichas[clave] = Ficha(
            clave=clave,
            estado=estado,
            responsable=d.get("responsable", ""),
            contacto=d.get("contacto", ""),
            proximo_paso=d.get("proximo_paso", ""),
            notas=d.get("notas", ""),
            historial=historial,
            actualizado=d.get("actualizado", ""),
            nombre=nombre,
            lat=d.get("lat"),
            lon=d.get("lon"),
            expedientes=d.get("expedientes", []),
            documentos=d.get("documentos", []),
        )
    return fichas


def guardar_fichas(fichas: dict[str, Ficha]) -> None:
    BASE.mkdir(parents=True, exist_ok=True)
    ESTADOS.write_text(
        json.dumps(
            {
                k: {
                    "estado": f.estado.value,
                    "responsable": f.responsable,
                    "contacto": f.contacto,
                    "proximo_paso": f.proximo_paso,
                    "notas": f.notas,
                    "historial": f.historial,
                    "actualizado": f.actualizado,
                    "nombre": f.nombre,
                    "lat": f.lat,
                    "lon": f.lon,
                    "expedientes": f.expedientes,
                    "documentos": f.documentos,
                }
                for k, f in fichas.items()
            },
            ensure_ascii=False, indent=2,
        ),
        encoding="utf-8",
    )


def actualizar_ficha(
    clave: str,
    estado: Estado | None = None,
    responsable: str | None = None,
    contacto: str | None = None,
    proximo_paso: str | None = None,
    notas: str | None = None,
    nombre: str = "",
    lat: float | None = None,
    lon: float | None = None,
) -> Ficha:
    """Modifica una ficha y deja rastro del cambio de etapa en el historial."""
    fichas = cargar_fichas()
    ficha = fichas.get(clave) or Ficha(clave=clave)
    ahora = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if nombre:
        ficha.nombre = nombre
    if lat is not None and lon is not None:
        ficha.lat, ficha.lon = lat, lon

    if estado is not None and estado is not ficha.estado:
        ficha.historial.append({
            "fecha": ahora,
            "de": ficha.estado.value,
            "a": estado.value,
            "empresa": nombre,
        })
        ficha.estado = estado
    for campo, valor in (
        ("responsable", responsable), ("contacto", contacto),
        ("proximo_paso", proximo_paso), ("notas", notas),
    ):
        if valor is not None:
            setattr(ficha, campo, valor)

    ficha.actualizado = ahora
    fichas[clave] = ficha
    guardar_fichas(fichas)
    return ficha


#: Parecido de nombre exigido para reenlazar una ficha huerfana. Alto, como en
#: el cruce de permisos: aqui tampoco siempre hay coordenada que desempate.
UMBRAL_REENLACE = 0.88
DISTANCIA_REENLACE_KM = 0.6


def _migrar(fichas: dict[str, Ficha], ficha: Ficha, p: Prospecto, motivo: str) -> Ficha:
    """Mueve una ficha a la clave del prospecto actual, con rastro."""
    nueva = clave_estable(p.nombre, p.lat, p.lon)
    fichas.pop(ficha.clave, None)
    ficha.historial.append({
        "fecha": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "de": ficha.estado.value, "a": ficha.estado.value,
        "empresa": p.nombre,
        "nota": f"{motivo}: antes '{ficha.nombre or ficha.clave}'",
    })
    ficha.clave, ficha.nombre, ficha.lat, ficha.lon = nueva, p.nombre, p.lat, p.lon
    fichas[nueva] = ficha
    return ficha


def vincular_fichas(
    prospectos: list[Prospecto],
) -> tuple[dict[str, Ficha], list[Ficha]]:
    """Fichas por clave del prospecto ACTUAL, y las que no se pudieron enlazar.

    Primero por clave exacta. Lo que queda suelto se intenta por parecido de
    nombre: con coordenada, ademas a menos de 600 m; sin coordenada, solo si
    el candidato es unico. Una ficha reenlazada se migra a la clave nueva y
    se guarda, asi que la siguiente vez ya coincide por clave.
    """
    fichas = cargar_fichas()
    por_clave = {clave_estable(p.nombre, p.lat, p.lon): p for p in prospectos}
    enlazadas: dict[str, Ficha] = {}
    sueltas: list[Ficha] = []
    for clave, f in list(fichas.items()):
        if clave in por_clave:
            enlazadas[clave] = f
        else:
            sueltas.append(f)

    migradas = False
    huerfanas: list[Ficha] = []
    for f in sueltas:
        candidatos = [
            p for c, p in por_clave.items()
            if c not in enlazadas
            and f.nombre and parecido(f.nombre, p.nombre) >= UMBRAL_REENLACE
            and (
                f.lat is None or f.lon is None
                or haversine_km(f.lat, f.lon, p.lat, p.lon) <= DISTANCIA_REENLACE_KM
            )
        ]
        if len(candidatos) == 1 or (
            len(candidatos) > 1 and f.lat is not None and f.lon is not None
        ):
            p = min(
                candidatos,
                key=lambda x: haversine_km(f.lat, f.lon, x.lat, x.lon)
                if f.lat is not None and f.lon is not None else 0.0,
            )
            enlazadas[clave_estable(p.nombre, p.lat, p.lon)] = _migrar(
                fichas, f, p, "reenlazada por parecido de nombre",
            )
            migradas = True
        else:
            huerfanas.append(f)
    if migradas:
        guardar_fichas(fichas)
    return enlazadas, huerfanas


def reasignar_ficha(clave_origen: str, prospecto: Prospecto) -> Ficha:
    """Mueve a mano una ficha huerfana al prospecto indicado."""
    fichas = cargar_fichas()
    ficha = fichas.get(clave_origen)
    if ficha is None:
        raise KeyError(f"No existe la ficha {clave_origen}")
    destino = clave_estable(prospecto.nombre, prospecto.lat, prospecto.lon)
    if destino == clave_origen:
        return ficha
    if destino in fichas:
        raise ValueError(
            f"'{prospecto.nombre}' ya tiene una ficha ({fichas[destino].estado.value}); "
            f"no se fusionan solas para no perder el historial de ninguna"
        )
    ficha = _migrar(fichas, ficha, prospecto, "reasignada a mano")
    ficha.actualizado = datetime.now(timezone.utc).isoformat(timespec="seconds")
    guardar_fichas(fichas)
    return ficha


def aplicar_fichas(prospectos: list[Prospecto]) -> list[Prospecto]:
    """Vuelca el estado comercial guardado sobre un barrido recien hecho."""
    fichas, _ = vincular_fichas(prospectos)
    salida: list[Prospecto] = []
    for p in prospectos:
        ficha = fichas.get(clave_estable(p.nombre, p.lat, p.lon))
        salida.append(p if ficha is None else replace(p, estado=ficha.estado))
    return salida


# --------------------------------------------------------------------------
# Expedientes vinculados a mano
# --------------------------------------------------------------------------

CAMPOS_EXPEDIENTE = (
    "id", "expediente", "radicado", "autoridad", "tramite", "tramite_legible",
    "titular", "fecha",
)


def _identificador(e: dict[str, str]) -> str:
    return e.get("expediente") or e.get("radicado") or e.get("id") or ""


def vincular_expediente(
    clave: str, registro: dict[str, Any], nombre: str = "",
    lat: float | None = None, lon: float | None = None,
) -> Ficha:
    """Guarda en la ficha un tramite de VITAL encontrado con el buscador.

    Es lo que hace una persona cuando el cruce automatico por razon social
    no encontro el permiso (la empresa tramita con otro nombre, o a traves de
    una filial). A partir de aqui el prospecto lleva la referencia y su
    confianza sube exactamente igual que si lo hubiera encontrado el barrido.
    """
    limpio = {k: str(registro.get(k, "") or "") for k in CAMPOS_EXPEDIENTE}
    if not _identificador(limpio):
        raise ValueError("El tramite no tiene expediente, radicado ni identificador")
    fichas = cargar_fichas()
    ficha = fichas.get(clave) or Ficha(clave=clave)
    if nombre:
        ficha.nombre = nombre
    if lat is not None and lon is not None:
        ficha.lat, ficha.lon = lat, lon
    ahora = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if not any(_identificador(e) == _identificador(limpio) for e in ficha.expedientes):
        limpio["vinculado"] = ahora
        ficha.expedientes.append(limpio)
        ficha.historial.append({
            "fecha": ahora, "de": ficha.estado.value, "a": ficha.estado.value,
            "empresa": ficha.nombre,
            "nota": f"expediente {_identificador(limpio)} vinculado desde el buscador de VITAL",
        })
    ficha.actualizado = ahora
    fichas[clave] = ficha
    guardar_fichas(fichas)
    return ficha


def anotar_documento(
    clave: str, documento: dict[str, Any], nombre: str = "",
    lat: float | None = None, lon: float | None = None,
) -> Ficha:
    """Registra en la ficha un documento del expediente guardado en disco."""
    fichas = cargar_fichas()
    ficha = fichas.get(clave) or Ficha(clave=clave)
    if nombre:
        ficha.nombre = nombre
    if lat is not None and lon is not None:
        ficha.lat, ficha.lon = lat, lon
    ahora = datetime.now(timezone.utc).isoformat(timespec="seconds")
    ficha.documentos = [d for d in ficha.documentos if d.get("ruta") != documento.get("ruta")]
    ficha.documentos.append({**documento, "guardado": ahora})
    ficha.actualizado = ahora
    fichas[clave] = ficha
    guardar_fichas(fichas)
    return ficha


def desvincular_expediente(clave: str, identificador: str) -> Ficha:
    fichas = cargar_fichas()
    ficha = fichas.get(clave)
    if ficha is None:
        raise KeyError(f"No existe la ficha {clave}")
    antes = len(ficha.expedientes)
    ficha.expedientes = [e for e in ficha.expedientes if _identificador(e) != identificador]
    if len(ficha.expedientes) == antes:
        raise KeyError(f"La ficha no tiene el expediente {identificador}")
    ficha.actualizado = datetime.now(timezone.utc).isoformat(timespec="seconds")
    guardar_fichas(fichas)
    return ficha


def aplicar_expedientes(prospectos: list[Prospecto]) -> list[Prospecto]:
    """Anade a cada prospecto las referencias de los expedientes vinculados.

    Va ANTES de puntuar: una referencia 'vital' sube la confianza y la
    confianza es un factor del puntaje. No duplica lo que el cruce por razon
    social ya encontro.
    """
    fichas, _ = vincular_fichas(prospectos)
    salida: list[Prospecto] = []
    for p in prospectos:
        ficha = fichas.get(clave_estable(p.nombre, p.lat, p.lon))
        if ficha is None or not ficha.expedientes:
            salida.append(p)
            continue
        ya = {r.identificador for r in p.referencias if r.fuente == "vital"}
        nuevas = tuple(
            Referencia(
                fuente="vital",
                identificador=_identificador(e),
                descripcion=(
                    f"{e.get('tramite_legible') or e.get('tramite')} ante {e.get('autoridad')}"
                    + (f" - radicado {e['radicado']}" if e.get("radicado") else "")
                    + f" (vinculado a mano; titular en VITAL: {e.get('titular')})"
                ),
                url="https://vital-publico.minambiente.gov.co/buscador",
                consultado=str(e.get("vinculado", ""))[:10],
            )
            for e in ficha.expedientes if _identificador(e) not in ya
        )
        salida.append(replace(p, referencias=p.referencias + nuevas) if nuevas else p)
    return salida


# --------------------------------------------------------------------------
# Instantaneas
# --------------------------------------------------------------------------

def guardar_instantanea(prospectos: list[Prospecto]) -> Path:
    """Archiva un barrido para poder compararlo con el siguiente."""
    INSTANTANEAS.mkdir(parents=True, exist_ok=True)
    ahora = datetime.now(timezone.utc)
    ruta = INSTANTANEAS / f"{ahora.strftime('%Y%m%dT%H%M%S')}.json"
    ruta.write_text(
        json.dumps(
            {
                "tomada": ahora.isoformat(timespec="seconds"),
                "prospectos": [
                    {
                        "clave": clave_estable(p.nombre, p.lat, p.lon),
                        "nombre": p.nombre,
                        "sector": p.sector,
                        "caudal_m3_h": p.caudal_m3_h,
                        "confianza": p.confianza,
                        "puntaje": p.puntaje,
                        "distancia_conduccion_km": p.distancia_conduccion_km,
                        "tds": p.calidad.tds,
                        "dqo": p.calidad.dqo,
                    }
                    for p in prospectos
                ],
            },
            ensure_ascii=False, indent=2,
        ),
        encoding="utf-8",
    )
    return ruta


def instantaneas() -> list[Path]:
    if not INSTANTANEAS.is_dir():
        return []
    return sorted(INSTANTANEAS.glob("*.json"))


def leer_instantanea(ruta: Path) -> dict[str, Any]:
    return _leer_json(ruta, {"tomada": "", "prospectos": []})
