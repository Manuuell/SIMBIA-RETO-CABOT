"""API del simulador de la torre.

    GET  /api/simulador/referencia   valores de partida, trenes y parametros
    GET  /api/simulador/candidatos   prospectos del barrido como fuentes
    POST /api/simulador/simular      que le pasa a la torre con estos caudales
    POST /api/simulador/sugerir      la mezcla que propone el optimizador

El estado de la simulacion vive en quien llama: cada peticion trae la planta,
las fuentes y las tomas completas. Asi el servidor no guarda nada entre
peticiones y dos personas pueden simular a la vez sin pisarse.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..config import Escenario
from ..domain.streams import AGUA_CRUDA, TRENES
from ..domain.water_chem import Calidad, PARAMETROS_CONSERVATIVOS
from ..scout import almacen
from ..scout.geo import RADIO_BUSQUEDA_KM
from ..simulador import (
    ETIQUETAS, DatosPlanta, Decision, Fuente, Toma, calibrar, calidad_con,
    desde_prospecto, simular, sugerir,
)
from ..simulador import dinamica
from ..simulador.fuentes import PROCEDENCIAS
from . import scout as api_scout
from . import serial

router = APIRouter(prefix="/api/simulador", tags=["simulador"])

#: Parametros de calidad en el orden en que se muestran.
PARAMETROS_CALIDAD = ("ph", "t_c") + PARAMETROS_CONSERVATIVOS


# --------------------------------------------------------------------------
# Entradas
# --------------------------------------------------------------------------

class CalidadEntrada(BaseModel):
    """Analitica parcial: lo que no se indique se toma de la referencia."""

    ph: float | None = Field(None, ge=0, le=14)
    t_c: float | None = Field(None, ge=0, le=100)
    tds: float | None = Field(None, ge=0)
    dureza_ca: float | None = Field(None, ge=0)
    alcalinidad: float | None = Field(None, ge=0)
    cloruros: float | None = Field(None, ge=0)
    sulfatos: float | None = Field(None, ge=0)
    silice: float | None = Field(None, ge=0)
    sst: float | None = Field(None, ge=0)
    dqo: float | None = Field(None, ge=0)
    n_amoniacal: float | None = Field(None, ge=0)
    fosfatos: float | None = Field(None, ge=0)
    hierro: float | None = Field(None, ge=0)

    def valores(self) -> dict[str, float]:
        return {k: v for k, v in self.model_dump().items() if v is not None}


class PlantaEntrada(BaseModel):
    consumo_total_m3_dia: float | None = Field(None, gt=0)
    caudal_circulacion_m3_h: float | None = Field(None, gt=0)
    delta_t_c: float | None = Field(None, gt=0, le=30)
    ciclos_actuales: float | None = Field(None, gt=1, le=15)
    conductividad_reposicion_us_cm: float | None = Field(None, gt=0)
    conductividad_purga_us_cm: float | None = Field(None, gt=0)
    reposicion_medida_m3_h: float | None = Field(None, gt=0)
    costo_agua_cruda_usd_m3: float | None = Field(None, ge=0)
    costo_vertimiento_usd_m3: float | None = Field(None, ge=0)
    meta_reduccion: float | None = Field(None, ge=0, le=0.9)
    usar_antiincrustante: bool | None = None
    ciclos_tope: float | None = Field(None, gt=2, le=15)
    agua_cruda: CalidadEntrada = Field(default_factory=CalidadEntrada)

    def datos(self) -> DatosPlanta:
        campos = self.model_dump(exclude={"agua_cruda"})
        return DatosPlanta(**campos, agua_cruda=self.agua_cruda.valores())


class FuenteEntrada(BaseModel):
    id: str = Field(min_length=1, max_length=80)
    nombre: str = Field(min_length=1, max_length=160)
    caudal_disponible_m3_h: float = Field(ge=0)
    distancia_km: float = Field(0.0, ge=0, le=100)
    precio_usd_m3: float = Field(0.0, ge=-5, le=5)
    procedencia: Literal["medido", "declarado", "inferido", "supuesto"] = "supuesto"
    confianza: float | None = Field(None, ge=0, le=1)
    sector: str = Field("", max_length=160)
    corriente: str = Field("", max_length=300)
    tren_sugerido: str = Field("", max_length=8)
    calidad: CalidadEntrada = Field(default_factory=CalidadEntrada)

    def fuente(self) -> Fuente:
        return Fuente(
            id=self.id, nombre=self.nombre,
            calidad=calidad_con(Calidad(), self.calidad.valores()),
            caudal_disponible_m3_h=self.caudal_disponible_m3_h,
            distancia_km=self.distancia_km, precio_usd_m3=self.precio_usd_m3,
            procedencia=self.procedencia, confianza=self.confianza,
            sector=self.sector, corriente=self.corriente,
            tren_sugerido=self.tren_sugerido,
        )


class TomaEntrada(BaseModel):
    fuente_id: str
    caudal_m3_h: float = Field(ge=0, le=10_000)
    tren: str = "T1"


class SimulacionEntrada(BaseModel):
    planta: PlantaEntrada = Field(default_factory=PlantaEntrada)
    fuentes: list[FuenteEntrada] = Field(default_factory=list, max_length=60)
    tomas: list[TomaEntrada] = Field(default_factory=list, max_length=60)
    acido_mg_l: float = Field(0.0, ge=0, le=500)
    ciclos: float | None = Field(None, gt=1, le=15)
    #: Solo para /sugerir: tope de la fraccion de reposicion que pueden cubrir
    #: los vecinos.
    max_fraccion_reuso: float = Field(0.85, ge=0, le=1)

    def preparar(self) -> tuple[Escenario, dict[str, Fuente], Any]:
        try:
            planta = calibrar(self.planta.datos())
            fuentes = {f.id: f.fuente() for f in self.fuentes}
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        if len(fuentes) != len(self.fuentes):
            raise HTTPException(422, "Hay fuentes con el mismo id")
        desconocidas = {t.fuente_id for t in self.tomas} - set(fuentes)
        if desconocidas:
            raise HTTPException(422, f"Tomas de fuentes que no estan en la lista: {sorted(desconocidas)}")
        return planta.escenario, fuentes, planta


def _decision(e: SimulacionEntrada, fuentes: dict[str, Fuente]) -> Decision:
    return Decision(
        tomas=tuple(Toma(fuentes[t.fuente_id], t.caudal_m3_h, t.tren) for t in e.tomas),
        acido_mg_l=e.acido_mg_l, ciclos=e.ciclos,
    )


def _respuesta(esc: Escenario, decision: Decision, planta) -> dict[str, Any]:
    try:
        resultado = simular(esc, decision)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    return {**resultado.as_dict(), "planta": planta.as_dict()}


# --------------------------------------------------------------------------
# Rutas
# --------------------------------------------------------------------------

@router.get("/referencia")
def referencia() -> dict[str, Any]:
    """Todo lo que la pantalla necesita para pintar el formulario de planta."""
    planta = calibrar()
    return {
        "planta": planta.as_dict(),
        "parametros": [
            {"clave": p, "etiqueta": ETIQUETAS[p][0], "unidad": ETIQUETAS[p][1],
             "agua_cruda": round(getattr(AGUA_CRUDA, p), 3)}
            for p in PARAMETROS_CALIDAD
        ],
        "etiquetas": {k: {"etiqueta": v[0], "unidad": v[1]} for k, v in ETIQUETAS.items()},
        "trenes": [serial.tren_json(t) for t in TRENES],
        "procedencias": list(PROCEDENCIAS),
    }


@router.get("/candidatos")
def candidatos(radio_km: float = RADIO_BUSQUEDA_KM) -> list[dict[str, Any]]:
    """Los prospectos del barrido como fuentes listas para el simulador."""
    salida = []
    for p in api_scout._barrido(max(0.5, min(radio_km, 40.0))):
        clave = almacen.clave_estable(p.nombre, p.lat, p.lon)
        d = desde_prospecto(p, clave).as_dict()
        d["puntaje"] = None if p.puntaje is None else round(p.puntaje, 1)
        d["en_vital"] = any(r.fuente == "vital" for r in p.referencias)
        salida.append(d)
    return salida


@router.post("/simular")
def api_simular(e: SimulacionEntrada | None = None) -> dict[str, Any]:
    e = e or SimulacionEntrada()
    esc, fuentes, planta = e.preparar()
    return _respuesta(esc, _decision(e, fuentes), planta)


@router.post("/sugerir")
def api_sugerir(e: SimulacionEntrada | None = None) -> dict[str, Any]:
    """La mezcla que propone el optimizador con las fuentes de la lista.

    Devuelve la decision (caudales, trenes y acido) para que la pantalla la
    cargue en sus controles, y la simulacion de esa decision.
    """
    e = e or SimulacionEntrada()
    esc, fuentes, planta = e.preparar()
    s = sugerir(esc, list(fuentes.values()), e.max_fraccion_reuso)
    if s.decision is None:
        return {"modo": s.modo, "motivo": s.motivo, "decision": None, "resultado": None}
    return {
        "modo": s.modo,
        "motivo": s.motivo,
        "decision": {
            "tomas": [
                {"fuente_id": t.fuente.id, "caudal_m3_h": t.caudal_m3_h, "tren": t.tren}
                for t in s.decision.tomas
            ],
            "acido_mg_l": s.decision.acido_mg_l,
        },
        "resultado": _respuesta(esc, s.decision, planta),
    }


# --------------------------------------------------------------------------
# Simulacion dinamica
# --------------------------------------------------------------------------

class LazoEntrada(BaseModel):
    modo: Literal["auto", "man"] = "auto"
    #: None en conductividad: la consigna de la linea base.
    consigna: float | None = None
    salida_pct: float = Field(50.0, ge=0, le=100)
    rampa_por_h: float = Field(0.0, ge=0, le=10_000)


class EstadoEntrada(BaseModel):
    t_h: float = Field(ge=0)
    volumen_m3: float = Field(gt=0)
    conc: dict[str, float]
    integral_nivel: float = 0.0
    integral_cond: float = 0.0
    lv_pct: float = Field(ge=0, le=100)
    av_pct: float = Field(ge=0, le=100)
    cruda_acumulada_m3: float = 0.0
    base_acumulada_m3: float = 0.0
    consigna_cond: float | None = None


class DinamicaEntrada(SimulacionEntrada):
    estado: EstadoEntrada | None = None
    horas: float = Field(1.0, gt=0, le=dinamica.MAX_HORAS_POR_LLAMADA)
    carga_pct: float = Field(100.0, ge=0, le=130)
    t_bulbo_c: float = Field(dinamica.T_BULBO_DISENO_C, ge=0, le=40)
    ventilador_pct: float = Field(100.0, ge=0, le=100)
    nivel: LazoEntrada = Field(default_factory=lambda: LazoEntrada(consigna=dinamica.NIVEL_NOMINAL_PCT))
    conductividad: LazoEntrada = Field(default_factory=LazoEntrada)


def _planta_dinamica(e: SimulacionEntrada) -> tuple[dinamica.Planta, dict[str, Fuente], Any]:
    esc, fuentes, planta = e.preparar()
    return dinamica.preparar(esc), fuentes, planta


def _referencia_dinamica(p: dinamica.Planta) -> dict[str, Any]:
    return {
        "geometria": p.geo.as_dict(),
        "base": {
            "ciclos": p.esc.torre.ciclos_base,
            "reposicion_m3_h": round(p.reposicion_base_m3_h, 2),
            "purga_m3_h": round(p.purga_base_m3_h, 2),
            "conductividad_consigna": round(p.cond_consigna_base, 0),
            "conductividad_reposicion": round(p.cruda.conductividad, 1),
            "nivel_consigna": dinamica.NIVEL_NOMINAL_PCT,
        },
        "capacidades": {
            "reposicion_m3_h": round(p.capacidad_lv_m3_h, 1),
            "purga_m3_h": round(p.capacidad_av_m3_h, 1),
        },
        "limites": {
            "conductividad_us_cm": p.esc.limites.conductividad_us_cm,
            "lsi_max": p.esc.lsi_max_efectivo,
            "larson_skold_max": p.esc.limites.larson_skold_max,
        },
    }


@router.post("/dinamica")
def api_dinamica(e: DinamicaEntrada | None = None) -> dict[str, Any]:
    """Avanza la torre `horas` de simulacion desde `estado`.

    Sin estado, parte de la operacion actual en regimen. El estado completo
    vuelve en la respuesta y la pantalla lo devuelve en la siguiente llamada:
    el servidor no guarda nada entre peticiones.
    """
    e = e or DinamicaEntrada()
    p, fuentes, _ = _planta_dinamica(e)
    estado = (
        dinamica.Estado(**e.estado.model_dump()) if e.estado else dinamica.estado_inicial(p)
    )
    faltan = set(dinamica.PARAMETROS_CONSERVATIVOS) - set(estado.conc)
    if faltan:
        raise HTTPException(422, f"Al estado le faltan concentraciones: {sorted(faltan)}")
    entradas = dinamica.Entradas(
        carga_pct=e.carga_pct, t_bulbo_c=e.t_bulbo_c, ventilador_pct=e.ventilador_pct,
        acido_mg_l=e.acido_mg_l,
        nivel=dinamica.Lazo(e.nivel.modo, e.nivel.consigna if e.nivel.consigna is not None
                            else dinamica.NIVEL_NOMINAL_PCT, e.nivel.salida_pct),
        conductividad=dinamica.Lazo(
            e.conductividad.modo,
            e.conductividad.consigna if e.conductividad.consigna is not None else p.cond_consigna_base,
            e.conductividad.salida_pct,
            e.conductividad.rampa_por_h,
        ),
        tomas=tuple(
            dinamica.TomaDinamica(fuentes[t.fuente_id], t.caudal_m3_h, t.tren) for t in e.tomas
        ),
    )
    try:
        muestras, final = dinamica.avanzar(p, estado, entradas, e.horas)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    return {**_referencia_dinamica(p), "muestras": muestras, "estado": final.as_dict()}
