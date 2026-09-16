"""API REST del modulo de prospeccion."""

from __future__ import annotations

import base64
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from ..config import Escenario
from ..optim.blend import linea_base, optimizar
from ..scout import almacen, ciiu, extraccion, permisos, vigilancia, vital
from ..scout.fuentes import Modo, catalogo as catalogo_fuentes, modo_actual
from ..scout.fuentes.base import descargas_en_cache
from ..scout.geo import PLANTA, RADIO_BUSQUEDA_KM, Sitio, proyectar
from ..scout.perfil import ORDEN_ESTADO, Estado, Prospecto
from ..scout.pipeline import Barrido, prospectar
from ..scout.promocion import UMBRAL_PROMOCION, catalogo_desde_prospectos
from ..scout.scoring import PESOS, puntuar_todos
from . import serial

router = APIRouter(prefix="/api/scout")


# --------------------------------------------------------------------------
# Barrido, con memoria para no repetir trabajo entre peticiones
# --------------------------------------------------------------------------

_cache: dict[float, list[Prospecto]] = {}
#: Contexto del ultimo barrido: el objeto Barrido, como se consultaron los
#: permisos y con que modo se hizo. Lo que el dashboard necesita para contar
#: al usuario de donde salio cada cosa.
_ultimo_barrido: dict[str, Any] = {}


def _resolver_modo(modo: str | None) -> Modo:
    if not modo:
        return modo_actual()
    try:
        return Modo(modo.strip().lower())
    except ValueError:
        raise HTTPException(
            422, f"Modo desconocido: {modo}. Validos: {[m.value for m in Modo]}",
        )


def _barrido(
    radio_km: float, refrescar: bool = False, modo: Modo | None = None,
) -> list[Prospecto]:
    """Prospecta, puntua y aplica el estado comercial guardado.

    El resultado se memoriza por radio: el barrido en si es determinista y
    la puntuacion cuesta ~0,2 s, pero la pagina hace media docena de
    peticiones al cargarse y no tiene sentido repetirlo en cada una. Con
    `refrescar` se vuelve a consultar, en el `modo` indicado (o el de la
    configuracion). Un barrido en vivo actualiza la cache en disco, asi que
    el siguiente arranque en offline ya ve lo descargado.
    """
    clave = round(radio_km, 2)
    if refrescar:
        _cache.pop(clave, None)
    if clave not in _cache:
        modo = modo or modo_actual()
        barrido = prospectar(radio_km=radio_km, modo=modo)
        # Los permisos de vertimiento se cruzan ANTES de puntuar, porque
        # elevan la confianza y la confianza es un factor del puntaje.
        lista, origen, fecha = permisos.consultar_detalle(modo=modo)
        enriquecidos, cruzados = permisos.enriquecer(barrido.prospectos, lista)
        # Y los expedientes que alguien vinculo a mano desde el buscador:
        # tambien antes de puntuar, por la misma razon.
        enriquecidos = almacen.aplicar_expedientes(enriquecidos)
        _ultimo_barrido.update({
            "b": barrido, "modo": modo.value,
            "permisos": {
                "total": len(lista), "origen": origen, "fecha_dato": fecha,
                "cruzados": cruzados,
            },
        })
        _cache[clave] = almacen.aplicar_fichas(puntuar_todos(enriquecidos))
    return _cache[clave]


def _invalidar() -> None:
    _cache.clear()


def _prospecto_json(p: Prospecto) -> dict[str, Any]:
    x, y = proyectar(p.lat, p.lon)
    d = p.as_dict()
    d["clave"] = almacen.clave_estable(p.nombre, p.lat, p.lon)
    d["x_km"], d["y_km"] = x, y
    return d


# --------------------------------------------------------------------------
# Estado del sistema
# --------------------------------------------------------------------------

def _resumen_permisos() -> dict[str, Any]:
    lista, origen = permisos.consultar()
    autoridades: dict[str, int] = {}
    for x in lista:
        if x.autoridad:
            autoridades[x.autoridad] = autoridades.get(x.autoridad, 0) + 1
    return {
        "total": len(lista), "origen": origen, "autoridades": autoridades,
        "fuente": "VITAL - Ventanilla Integral de Tramites Ambientales",
        "url": "https://vital-publico.minambiente.gov.co/buscador",
    }


@router.get("/estado")
def estado() -> dict[str, Any]:
    """Como esta configurado el modulo: modo, fuentes y funciones opcionales."""
    hay_ia, motivo_ia = extraccion.disponible()
    return {
        "modo": modo_actual().value,
        "planta": {
            "nombre": PLANTA.nombre, "lat": PLANTA.lat, "lon": PLANTA.lon,
        },
        "radio_km": RADIO_BUSQUEDA_KM,
        "umbral_promocion": UMBRAL_PROMOCION,
        "pesos_puntaje": PESOS,
        "fuentes": [f.ficha() for f in catalogo_fuentes()],
        #: Que hay descargado, por fuente: es lo que se puede servir sin red.
        "descargas": {f.codigo: descargas_en_cache(f.codigo) for f in catalogo_fuentes()},
        "extraccion_ia": {
            "disponible": hay_ia, "motivo": motivo_ia,
            "modelo": extraccion.MODELO,
        },
        "arquetipos": len(ciiu.ARQUETIPOS),
        "permisos_vertimiento": _resumen_permisos(),
        "etapas": [e.value for e in ORDEN_ESTADO] + [Estado.DESCARTADO.value],
    }


@router.get("/arquetipos")
def arquetipos() -> list[dict[str, Any]]:
    """Catalogo de arquetipos sectoriales: el modelo que traduce CIIU a agua."""
    return [
        {
            "clave": a.clave, "nombre": a.nombre, "ciiu": list(a.ciiu),
            "corriente": a.corriente,
            "caudal_ref_m3_h": a.caudal_ref_m3_h,
            "cv": a.cv, "limitante": a.limitante,
            "incentivo_usd_m3": a.incentivo_usd_m3,
            "calidad": a.calidad.as_dict(),
            "indices": a.calidad.indices(),
        }
        for a in ciiu.ARQUETIPOS
    ]


# --------------------------------------------------------------------------
# Prospeccion
# --------------------------------------------------------------------------

@router.get("/barrido")
def barrido(
    radio_km: float = RADIO_BUSQUEDA_KM, refrescar: bool = False,
    modo: str | None = None,
) -> dict[str, Any]:
    """Prospectos puntuados. `refrescar=true` vuelve a consultar las fuentes,
    en el `modo` indicado (offline, cache o vivo)."""
    radio_km = max(0.5, min(radio_km, 40.0))
    prospectos = _barrido(radio_km, refrescar, _resolver_modo(modo))
    b = _ultimo_barrido.get("b")

    fichas, _ = almacen.vincular_fichas(prospectos)
    salida = []
    for p in prospectos:
        d = _prospecto_json(p)
        ficha = fichas.get(d["clave"])
        d["ficha"] = ficha.as_dict() if ficha else None
        salida.append(d)

    viables = [p for p in prospectos if (p.puntaje or 0) > 0]
    promovibles = [p for p in prospectos if p.confianza >= UMBRAL_PROMOCION]
    return {
        "prospectos": salida,
        "radio_km": radio_km,
        "modo": _ultimo_barrido.get("modo", modo_actual().value),
        "modo_configurado": modo_actual().value,
        "planta": {"nombre": PLANTA.nombre, "lat": PLANTA.lat, "lon": PLANTA.lon},
        "resumen": {
            "detectados": len(prospectos),
            "viables": len(viables),
            "promovibles": len(promovibles),
            "descartados_sin_arquetipo": b.descartados if b else 0,
            "caudal_total_m3_h": round(sum(p.caudal_m3_h for p in prospectos), 1),
            "caudal_viable_m3_h": round(sum(p.caudal_m3_h for p in viables), 1),
            "confianza_media": (
                round(sum(p.confianza for p in prospectos) / len(prospectos), 3)
                if prospectos else 0.0
            ),
        },
        "fuentes": [
            {
                "fuente": r.fuente, "origen": r.origen,
                "registros": len(r.registros),
                "consultado": r.consultado, "incidencia": r.incidencia,
                "fecha_dato": r.fecha_dato, "nota": r.nota,
                "ok": r.ok,
            }
            for r in (b.fuentes if b else [])
        ],
        "permisos": _ultimo_barrido.get("permisos", {}),
    }


# --------------------------------------------------------------------------
# Pipeline comercial
# --------------------------------------------------------------------------

class CambioFicha(BaseModel):
    clave: str
    estado: str | None = None
    responsable: str | None = None
    contacto: str | None = None
    proximo_paso: str | None = None
    notas: str | None = None
    nombre: str = ""


@router.get("/pipeline")
def pipeline(radio_km: float = RADIO_BUSQUEDA_KM) -> dict[str, Any]:
    """Embudo de contratacion: cuanto caudal hay en cada etapa.

    La cifra que importa no es cuantas empresas hay en cada casilla sino
    cuanto caudal representan: veinte prospectos detectados de 5 m3/h valen
    menos que uno caracterizado de 120.
    """
    prospectos = _barrido(radio_km)
    fichas, huerfanas = almacen.vincular_fichas(prospectos)

    etapas: dict[str, dict[str, Any]] = {
        e.value: {
            "etapa": e.value, "empresas": 0, "caudal_m3_h": 0.0,
            "requisito": almacen.REQUISITO_SIGUIENTE.get(e, ""),
        }
        for e in list(ORDEN_ESTADO) + [Estado.DESCARTADO]
    }
    for p in prospectos:
        clave = almacen.clave_estable(p.nombre, p.lat, p.lon)
        ficha = fichas.get(clave)
        etapa = (ficha.estado if ficha else p.estado).value
        etapas[etapa]["empresas"] += 1
        etapas[etapa]["caudal_m3_h"] += p.caudal_m3_h

    for d in etapas.values():
        d["caudal_m3_h"] = round(d["caudal_m3_h"], 1)

    # Caudal con analitica real detras: lo unico que un banco descontaria.
    asegurado = sum(
        p.caudal_m3_h for p in prospectos
        if (
            fichas.get(almacen.clave_estable(p.nombre, p.lat, p.lon))
            or almacen.Ficha(clave="")
        ).estado in (Estado.CARACTERIZADO, Estado.PILOTO, Estado.CONTRATADO)
    )
    return {
        "etapas": list(etapas.values()),
        "caudal_asegurado_m3_h": round(asegurado, 1),
        #: Solo las que corresponden a un prospecto del barrido actual. Una
        #: ficha cuya empresa ya no aparece no es "trabajo abierto": es
        #: trabajo que hay que reasignar, y va aparte.
        "fichas_abiertas": len(fichas),
        "fichas_huerfanas": [
            {
                "clave": f.clave, "nombre": f.nombre, "estado": f.estado.value,
                "responsable": f.responsable, "contacto": f.contacto,
                "actualizado": f.actualizado,
            }
            for f in huerfanas
        ],
    }


@router.post("/ficha")
def ficha(cambio: CambioFicha) -> dict[str, Any]:
    estado_nuevo = None
    if cambio.estado is not None:
        try:
            estado_nuevo = Estado(cambio.estado)
        except ValueError:
            raise HTTPException(
                422,
                f"Etapa desconocida: {cambio.estado}. "
                f"Validas: {[e.value for e in Estado]}",
            )
    # La ficha guarda nombre y coordenada del prospecto para poder
    # reencontrarla si la clave deja de coincidir en un barrido futuro.
    p = next(
        (x for x in _cache.get(round(RADIO_BUSQUEDA_KM, 2), [])
         if almacen.clave_estable(x.nombre, x.lat, x.lon) == cambio.clave),
        None,
    ) or next(
        (x for lista in _cache.values() for x in lista
         if almacen.clave_estable(x.nombre, x.lat, x.lon) == cambio.clave),
        None,
    )
    f = almacen.actualizar_ficha(
        clave=cambio.clave, estado=estado_nuevo,
        responsable=cambio.responsable, contacto=cambio.contacto,
        proximo_paso=cambio.proximo_paso, notas=cambio.notas,
        nombre=cambio.nombre or (p.nombre if p else ""),
        lat=p.lat if p else None, lon=p.lon if p else None,
    )
    _invalidar()
    return f.as_dict()


class Reasignacion(BaseModel):
    clave_origen: str
    clave_destino: str
    radio_km: float = RADIO_BUSQUEDA_KM


@router.post("/ficha/reasignar")
def reasignar(cambio: Reasignacion) -> dict[str, Any]:
    """Mueve una ficha huerfana al prospecto elegido, conservando su historial."""
    prospectos = _barrido(cambio.radio_km)
    destino = next(
        (p for p in prospectos
         if almacen.clave_estable(p.nombre, p.lat, p.lon) == cambio.clave_destino),
        None,
    )
    if destino is None:
        raise HTTPException(422, "El prospecto de destino no esta en el barrido actual")
    try:
        f = almacen.reasignar_ficha(cambio.clave_origen, destino)
    except KeyError as exc:
        raise HTTPException(404, str(exc))
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    _invalidar()
    return f.as_dict()


# --------------------------------------------------------------------------
# Vigilancia
# --------------------------------------------------------------------------

@router.get("/vigilancia")
def revisar(radio_km: float = RADIO_BUSQUEDA_KM) -> dict[str, Any]:
    return vigilancia.revisar(_barrido(radio_km))


@router.post("/instantanea")
def archivar(radio_km: float = RADIO_BUSQUEDA_KM) -> dict[str, Any]:
    ruta = almacen.guardar_instantanea(_barrido(radio_km))
    return {
        "archivada": ruta.name,
        "total_instantaneas": len(almacen.instantaneas()),
    }


# --------------------------------------------------------------------------
# Integracion con el optimizador
# --------------------------------------------------------------------------

class AjustesPromocion(BaseModel):
    radio_km: float = Field(RADIO_BUSQUEDA_KM, gt=0, le=40)
    umbral_confianza: float = Field(UMBRAL_PROMOCION, ge=0, le=1)
    max_fraccion_reuso: float = Field(0.85, ge=0, le=1)
    claves: list[str] = Field(
        default_factory=list,
        description="Si se indica, solo estos prospectos. Vacio = todos los "
                    "que superen el umbral de confianza.",
    )


@router.post("/optimizar")
def optimizar_con_prospectos(ajustes: AjustesPromocion | None = None) -> dict[str, Any]:
    """Corre el optimizador real con el catalogo salido de la prospeccion.

    Es el cierre del circulo: las empresas que encontro el barrido entran al
    mismo optimizador que resuelve el caso base, con la misma quimica y las
    mismas restricciones. Lo unico que cambia es de donde salio el catalogo.

    La confianza no se pierde por el camino: `promocion.a_oferente` la
    traduce a un factor de disponibilidad anual, asi que un catalogo poco
    fiable produce una solucion mas conservadora por construccion.
    """
    ajustes = ajustes or AjustesPromocion()
    prospectos = _barrido(ajustes.radio_km)

    if ajustes.claves:
        elegidas = set(ajustes.claves)
        prospectos = [
            p for p in prospectos
            if almacen.clave_estable(p.nombre, p.lat, p.lon) in elegidas
        ]
        if not prospectos:
            raise HTTPException(422, "Ninguna de las claves indicadas existe")

    catalogo = catalogo_desde_prospectos(prospectos, ajustes.umbral_confianza)
    if not catalogo:
        return {
            "factible": False,
            "motivo": (
                f"Ningun prospecto supera el umbral de confianza "
                f"({ajustes.umbral_confianza:.2f}). Hace falta analitica real: "
                f"conseguir permisos de vertimiento o hacer una campana de "
                f"caracterizacion."
            ),
            "catalogo": [],
        }

    esc = Escenario()
    sol = optimizar(
        esc, max_fraccion_reuso=ajustes.max_fraccion_reuso, oferentes=catalogo,
    )
    base = linea_base(esc)
    return {
        "factible": sol.factible,
        "linea_base": serial.solucion_json(base),
        "optimo": serial.solucion_json(sol),
        "cumple_meta": sol.factible
        and sol.ahorro_pct_planta >= esc.planta.meta_reduccion,
        "meta_reduccion": esc.planta.meta_reduccion,
        "catalogo": [
            {
                "codigo": o.codigo, "empresa": o.empresa, "sector": o.sector,
                "caudal_disponible_m3_h": o.caudal_disponible_m3_h,
                "distancia_km": o.distancia_km,
                "precio_usd_m3": o.precio_usd_m3,
                "disponibilidad": o.disponibilidad,
                "notas": o.notas,
            }
            for o in catalogo
        ],
        "umbral_confianza": ajustes.umbral_confianza,
    }


# --------------------------------------------------------------------------
# Buscador de VITAL
# --------------------------------------------------------------------------

@router.get("/vital/buscar")
def vital_buscar(
    q: str = "",
    autoridad: list[str] = Query(default=[]),
    tramite: list[str] = Query(default=[]),
    municipio: list[str] = Query(default=[]),
    solo_vertimientos: bool = False,
    pagina: int = 1,
    por_pagina: int = vital.POR_PAGINA,
    modo: str | None = None,
) -> dict[str, Any]:
    """Busqueda libre en el buscador publico de VITAL, con facetas y paginas."""
    b = vital.Busqueda(
        texto=q, autoridades=tuple(autoridad), tramites=tuple(tramite),
        municipios=tuple(municipio), solo_vertimientos=solo_vertimientos,
        pagina=max(1, pagina), por_pagina=max(5, min(por_pagina, 100)),
    )
    return vital.buscar(b, _resolver_modo(modo)).as_dict()


class VinculoExpediente(BaseModel):
    clave: str
    registro: dict[str, Any]
    radio_km: float = RADIO_BUSQUEDA_KM


@router.post("/vital/vincular")
def vital_vincular(v: VinculoExpediente) -> dict[str, Any]:
    """Asocia un tramite encontrado en el buscador a un prospecto del barrido."""
    p = next(
        (x for x in _barrido(v.radio_km)
         if almacen.clave_estable(x.nombre, x.lat, x.lon) == v.clave),
        None,
    )
    if p is None:
        raise HTTPException(422, "El prospecto no esta en el barrido actual")
    try:
        f = almacen.vincular_expediente(v.clave, v.registro, nombre=p.nombre, lat=p.lat, lon=p.lon)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    _invalidar()
    return f.as_dict()


class Desvinculo(BaseModel):
    clave: str
    identificador: str


@router.post("/vital/desvincular")
def vital_desvincular(d: Desvinculo) -> dict[str, Any]:
    try:
        f = almacen.desvincular_expediente(d.clave, d.identificador)
    except KeyError as exc:
        raise HTTPException(404, str(exc))
    _invalidar()
    return f.as_dict()


# --------------------------------------------------------------------------
# Extraccion de permisos
# --------------------------------------------------------------------------

class DocumentoEntrante(BaseModel):
    """Un documento de expediente traido a mano desde el portal."""

    nombre: str
    contenido_b64: str
    empresa: str = ""
    expediente: str = ""


@router.post("/ingestar")
def ingestar(entrada: DocumentoEntrante) -> dict[str, Any]:
    """Guarda un documento de expediente descargado manualmente.

    Existe porque el portal antiguo de VITAL no se deja consultar desde un
    cliente que no sea un navegador: rechaza la conexion por huella TLS.
    Mientras eso no se resuelva, los expedientes se traen a mano y entran por
    aqui, quedando archivados junto al resto de la evidencia del prospecto.
    """
    try:
        crudo = base64.b64decode(entrada.contenido_b64, validate=True)
    except Exception:
        raise HTTPException(422, "El contenido no es base64 valido")

    destino = Path(__file__).resolve().parents[1] / "scout" / "archivo" / "expedientes"
    destino.mkdir(parents=True, exist_ok=True)
    seguro = "".join(
        c if c.isalnum() or c in "-_. " else "_" for c in entrada.nombre
    )[:120]
    ruta = destino / seguro
    ruta.write_bytes(crudo)
    return {
        "guardado": str(ruta), "bytes": len(crudo),
        "empresa": entrada.empresa, "expediente": entrada.expediente,
        "es_pdf": crudo[:5] == b"%PDF-",
    }


class PDFEntrante(BaseModel):
    nombre: str = "permiso.pdf"
    #: Contenido del PDF en base64. Se usa base64 y no multipart para no
    #: anadir python-multipart como dependencia por una funcion opcional.
    contenido_b64: str


@router.post("/extraer")
def extraer(entrada: PDFEntrante) -> dict[str, Any]:
    ok, motivo = extraccion.disponible()
    if not ok:
        raise HTTPException(503, motivo)
    try:
        crudo = base64.b64decode(entrada.contenido_b64, validate=True)
    except Exception:
        raise HTTPException(422, "El contenido no es base64 valido")
    if not crudo.startswith(b"%PDF"):
        raise HTTPException(422, "El archivo no es un PDF")

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=True) as tmp:
        tmp.write(crudo)
        tmp.flush()
        resultado = extraccion.extraer_pdf(Path(tmp.name))
    return resultado.as_dict()
