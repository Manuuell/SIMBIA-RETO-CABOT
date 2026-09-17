"""API REST de SIMBIA."""

from __future__ import annotations

from dataclasses import replace
from functools import lru_cache
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..config import Escenario
from ..data.synth import generar
from ..domain.streams import CATALOGO, CATALOGO_POR_CODIGO, TRENES
from ..ml import models as ml
from ..optim import analysis
from ..optim.blend import linea_base, optimizar
from . import serial

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------
# Entradas
# --------------------------------------------------------------------------

class AjustesEscenario(BaseModel):
    """Sobrescrituras del escenario base. Todo es opcional."""

    consumo_total_m3_dia: float | None = Field(None, gt=0)
    costo_agua_cruda_usd_m3: float | None = Field(None, ge=0)
    costo_vertimiento_usd_m3: float | None = Field(None, ge=0)
    caudal_circulacion_m3_h: float | None = Field(None, gt=0)
    delta_t_c: float | None = Field(None, gt=0)
    ciclos_base: float | None = Field(None, gt=1)
    usar_antiincrustante: bool | None = None
    meta_reduccion: float | None = Field(None, ge=0, le=0.9)
    max_fraccion_reuso: float = Field(0.85, ge=0, le=1)
    oferentes_excluidos: list[str] = Field(default_factory=list)

    def construir(self) -> Escenario:
        esc = Escenario()
        planta = esc.planta
        for campo in (
            "consumo_total_m3_dia", "costo_agua_cruda_usd_m3",
            "costo_vertimiento_usd_m3",
        ):
            v = getattr(self, campo)
            if v is not None:
                planta = replace(planta, **{campo: v})
        if self.meta_reduccion is not None:
            planta = replace(planta, meta_reduccion=self.meta_reduccion)

        torre = esc.torre
        for campo in ("caudal_circulacion_m3_h", "delta_t_c", "ciclos_base"):
            v = getattr(self, campo)
            if v is not None:
                torre = replace(torre, **{campo: v})

        return replace(
            esc, planta=planta, torre=torre,
            usar_antiincrustante=(
                esc.usar_antiincrustante if self.usar_antiincrustante is None
                else self.usar_antiincrustante
            ),
        )

    def catalogo(self):
        excluidos = set(self.oferentes_excluidos)
        desconocidos = excluidos - set(CATALOGO_POR_CODIGO)
        if desconocidos:
            raise HTTPException(
                422, f"Oferentes desconocidos: {sorted(desconocidos)}"
            )
        return tuple(o for o in CATALOGO if o.codigo not in excluidos)


# --------------------------------------------------------------------------
# Catalogo y configuracion
# --------------------------------------------------------------------------

@router.get("/escenario")
def escenario() -> dict[str, Any]:
    esc = Escenario()
    return {
        "planta": serial.dc_json(esc.planta),
        "torre": serial.dc_json(esc.torre),
        "limites": serial.dc_json(esc.limites),
        "economia": {
            **serial.dc_json(esc.economia), "crf": round(esc.economia.crf, 5),
        },
        "usar_antiincrustante": esc.usar_antiincrustante,
        "lsi_max_efectivo": esc.lsi_max_efectivo,
    }


@router.get("/oferentes")
def oferentes() -> list[dict[str, Any]]:
    return [serial.oferente_json(o) for o in CATALOGO]


@router.get("/trenes")
def trenes() -> list[dict[str, Any]]:
    return [serial.tren_json(t) for t in TRENES]


# --------------------------------------------------------------------------
# Optimizacion
# --------------------------------------------------------------------------

@router.get("/linea-base")
def base() -> dict[str, Any]:
    return serial.solucion_json(linea_base(Escenario()))


@router.post("/optimizar")
def api_optimizar(ajustes: AjustesEscenario | None = None) -> dict[str, Any]:
    ajustes = ajustes or AjustesEscenario()
    esc = ajustes.construir()
    sol = optimizar(
        esc, max_fraccion_reuso=ajustes.max_fraccion_reuso,
        oferentes=ajustes.catalogo(),
    )
    return {
        "linea_base": serial.solucion_json(linea_base(esc)),
        "optimo": serial.solucion_json(sol),
        "meta_reduccion": esc.planta.meta_reduccion,
        "cumple_meta": sol.factible
        and sol.ahorro_pct_planta >= esc.planta.meta_reduccion,
    }


@router.post("/frontera")
def api_frontera(ajustes: AjustesEscenario | None = None) -> list[dict[str, Any]]:
    ajustes = ajustes or AjustesEscenario()
    return [serial.dc_json(p) for p in analysis.frontera(ajustes.construir())]


@router.post("/contingencias")
def api_contingencias(ajustes: AjustesEscenario | None = None) -> list[dict[str, Any]]:
    ajustes = ajustes or AjustesEscenario()
    return [
        serial.dc_json(c)
        for c in analysis.contingencias(ajustes.construir(), ajustes.catalogo())
    ]


@router.post("/sensibilidad")
def api_sensibilidad(
    parametro: str = "costo_agua_cruda_usd_m3",
    ajustes: AjustesEscenario | None = None,
) -> list[dict[str, Any]]:
    if parametro not in analysis.PARAMETROS_SENSIBLES:
        raise HTTPException(
            422,
            f"Parametro no soportado. Disponibles: "
            f"{sorted(analysis.PARAMETROS_SENSIBLES)}",
        )
    ajustes = ajustes or AjustesEscenario()
    return [
        serial.dc_json(p)
        for p in analysis.sensibilidad(ajustes.construir(), parametro)
    ]


# --------------------------------------------------------------------------
# Operacion e IA
# --------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _historico():
    return generar()


@lru_cache(maxsize=1)
def _modelos():
    df = _historico()
    cargados = {n: ml.cargar(n) for n in ("demanda", "fugas", "riesgo")}
    if any(v is None for v in cargados.values()):
        demanda, fugas, riesgo = (
            ml.ModeloDemanda(), ml.DetectorFugas(), ml.RiesgoEnsuciamiento()
        )
        demanda.entrenar(df); fugas.entrenar(df); riesgo.entrenar(df)
        cargados = {"demanda": demanda, "fugas": fugas, "riesgo": riesgo}
        ml.guardar(cargados)
    return cargados


@router.get("/ml/metricas")
def metricas() -> dict[str, Any]:
    return {
        n: serial.dc_json(m.metricas) for n, m in _modelos().items()
        if getattr(m, "metricas", None) is not None
    }


@router.get("/operacion")
def operacion(horas: int = 336) -> dict[str, Any]:
    """Ultimas `horas` de operacion con las predicciones de los modelos."""
    horas = max(24, min(horas, 2_000))
    df = _historico()
    mods = _modelos()
    ventana = df.iloc[-horas:]

    prob_fuga = mods["fugas"].predecir(df)[-horas:]
    prob_riesgo = mods["riesgo"].predecir(df)[-horas:]
    x_dem, y_dem = ml.rasgos_demanda(df)
    pred_dem = mods["demanda"].predecir(x_dem)

    serie = [
        {
            "t": ts.isoformat(),
            "reposicion_m3_h": round(float(r.reposicion_m3_h), 2),
            "ciclos": round(float(r.ciclos), 2),
            "conductividad": round(float(r.conductividad_us_cm), 0),
            "lsi": round(float(r.lsi_circulante), 3),
            "aproximacion_c": round(float(r.aproximacion_c), 2),
            "t_amb_c": round(float(r.t_amb_c), 1),
            "carga": round(float(r.carga_produccion), 3),
            "prob_fuga": round(float(pf), 3),
            "prob_riesgo": round(float(pr), 3),
        }
        for (ts, r), pf, pr in zip(ventana.iterrows(), prob_fuga, prob_riesgo)
    ]

    n_pron = min(72, len(x_dem))
    pronostico = [
        {"t": ts.isoformat(), "reposicion_prevista_m3_h": round(float(v), 2)}
        for ts, v in zip(x_dem.index[-n_pron:], pred_dem[-n_pron:])
    ]
    return {
        "serie": serie,
        "pronostico_24h": pronostico,
        "umbral_fuga": mods["fugas"].umbral,
        "umbral_riesgo": mods["riesgo"].umbral,
        "alerta_fuga": bool(prob_fuga[-1] >= mods["fugas"].umbral),
        "alerta_riesgo": bool(prob_riesgo[-1] >= mods["riesgo"].umbral),
    }


@lru_cache(maxsize=1)
def _optimo_base():
    """El caso base es determinista (escenario y catalogo son constantes):
    se resuelve una vez por proceso. En ARM cuesta casi cinco segundos."""
    esc = Escenario()
    return linea_base(esc), optimizar(esc)


@router.get("/kpis")
def kpis() -> dict[str, Any]:
    esc = Escenario()
    base_sol, sol = _optimo_base()
    fugas = _modelos()["fugas"].metricas
    m3_fugas = fugas.m3_recuperables_anio if fugas else 0.0
    consumo_anio = esc.planta.consumo_total_m3_dia * 365.0
    ahorro_anio = sol.ahorro_m3_dia * 365.0
    return {
        "meta_reduccion": esc.planta.meta_reduccion,
        "consumo_actual_m3_dia": esc.planta.consumo_total_m3_dia,
        "ahorro_m3_dia": round(sol.ahorro_m3_dia, 1),
        "ahorro_pct": round(sol.ahorro_pct_planta, 4),
        "ahorro_pct_con_fugas": round(
            (ahorro_anio + m3_fugas) / consumo_anio, 4
        ),
        "m3_recuperables_fugas_anio": round(m3_fugas, 0),
        "ahorro_economico_usd_anio": round(
            base_sol.costo_total_usd_anio - sol.costo_total_usd_anio, 0
        ),
        "capex_usd": round(sol.capex_total_usd, 0),
        "payback_anios": round(
            sol.capex_total_usd
            / max(base_sol.costo_total_usd_anio - sol.costo_total_usd_anio, 1e-9),
            2,
        ),
        "co2_evitado_t_anio": round(
            ahorro_anio * esc.planta.factor_co2_kg_m3 / 1000.0, 1
        ),
        "ciclos_base": esc.torre.ciclos_base,
        "ciclos_optimo": round(sol.ciclos, 2),
    }
