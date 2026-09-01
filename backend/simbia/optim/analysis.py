"""Analisis sobre el optimizador: frontera, contingencias y sensibilidad.

Un optimo puntual no convence a un comite de inversion. Lo que decide es
saber cuanto cuesta cada punto porcentual de ahorro, que pasa si un vecino
deja de entregar agua, y como se mueve el negocio si cambia el precio del
agua cruda.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Sequence

from ..config import Escenario
from ..domain.streams import CATALOGO, Oferente
from .blend import Solucion, linea_base, optimizar


@dataclass
class PuntoFrontera:
    meta: float
    factible: bool
    ahorro_pct: float = 0.0
    ahorro_m3_dia: float = 0.0
    costo_usd_anio: float = 0.0
    capex_usd: float = 0.0
    ahorro_neto_usd_anio: float = 0.0
    payback_anios: float | None = None
    ciclos: float = 0.0
    n_oferentes: int = 0


def frontera(
    esc: Escenario | None = None,
    metas: Sequence[float] = tuple(i / 100 for i in range(0, 45, 5)),
) -> list[PuntoFrontera]:
    """Costo minimo alcanzable para cada NIVEL de reuso.

    Se acota el ahorro por arriba y se minimiza costo. Resultado esperado:
    una curva decreciente (cada m3 reusado ahorra dinero) que termina en un
    corte abrupto donde el balance quimico o el tope operativo de reuso ya no
    admiten mas. Ese corte, y no el 10%, es la frontera real del proyecto.
    """
    esc = esc or Escenario()
    base = linea_base(esc)
    puntos: list[PuntoFrontera] = []
    for meta in metas:
        sol = optimizar(esc, meta_reduccion=0.0, ahorro_maximo=meta)
        if not sol.factible:
            puntos.append(PuntoFrontera(meta=meta, factible=False))
            continue
        ahorro_neto = base.costo_total_usd_anio - sol.costo_total_usd_anio
        payback = (
            sol.capex_total_usd / ahorro_neto if ahorro_neto > 0 else None
        )
        puntos.append(
            PuntoFrontera(
                meta=meta, factible=True,
                ahorro_pct=sol.ahorro_pct_planta,
                ahorro_m3_dia=sol.ahorro_m3_dia,
                costo_usd_anio=sol.costo_total_usd_anio,
                capex_usd=sol.capex_total_usd,
                ahorro_neto_usd_anio=ahorro_neto,
                payback_anios=payback,
                ciclos=sol.ciclos,
                n_oferentes=len({c.split(":")[0] for c in sol.aportes}),
            )
        )
    return puntos


@dataclass
class Contingencia:
    escenario: str
    factible: bool
    ahorro_pct: float = 0.0
    costo_usd_anio: float = 0.0
    cumple_meta: bool = False
    motivo: str = ""


def contingencias(
    esc: Escenario | None = None,
    catalogo: Sequence[Oferente] = CATALOGO,
) -> list[Contingencia]:
    """Que pasa si cada oferente deja de entregar agua (riesgo de suministro)."""
    esc = esc or Escenario()
    resultados: list[Contingencia] = []

    completo = optimizar(esc, oferentes=tuple(catalogo))
    resultados.append(
        Contingencia(
            "Todos los oferentes disponibles", completo.factible,
            completo.ahorro_pct_planta, completo.costo_total_usd_anio,
            completo.factible and completo.ahorro_pct_planta >= esc.planta.meta_reduccion,
            completo.motivo,
        )
    )
    for fuera in catalogo:
        restantes = tuple(o for o in catalogo if o.codigo != fuera.codigo)
        sol = optimizar(esc, oferentes=restantes)
        resultados.append(
            Contingencia(
                f"Sin {fuera.codigo} - {fuera.empresa}", sol.factible,
                sol.ahorro_pct_planta, sol.costo_total_usd_anio,
                sol.factible and sol.ahorro_pct_planta >= esc.planta.meta_reduccion,
                sol.motivo,
            )
        )
    return resultados


@dataclass
class PuntoSensibilidad:
    parametro: str
    valor: float
    factible: bool
    ahorro_pct: float = 0.0
    costo_usd_anio: float = 0.0
    ahorro_neto_usd_anio: float = 0.0


#: Parametros con incertidumbre alta y efecto directo sobre la decision.
PARAMETROS_SENSIBLES = {
    "costo_agua_cruda_usd_m3": (0.45, 0.85, 1.35, 2.00, 3.00),
    "costo_vertimiento_usd_m3": (0.20, 0.55, 0.85, 1.40, 2.20),
}


def sensibilidad(
    esc: Escenario | None = None,
    parametro: str = "costo_agua_cruda_usd_m3",
    valores: Sequence[float] | None = None,
) -> list[PuntoSensibilidad]:
    esc = esc or Escenario()
    valores = valores or PARAMETROS_SENSIBLES[parametro]
    puntos: list[PuntoSensibilidad] = []
    for v in valores:
        e2 = replace(esc, planta=replace(esc.planta, **{parametro: v}))
        base = linea_base(e2)
        sol = optimizar(e2)
        puntos.append(
            PuntoSensibilidad(
                parametro, v, sol.factible, sol.ahorro_pct_planta,
                sol.costo_total_usd_anio,
                base.costo_total_usd_anio - sol.costo_total_usd_anio
                if sol.factible else 0.0,
            )
        )
    return puntos
