"""Balance hidrico del circuito de enfriamiento abierto (torre humeda).

Contiene la relacion que gobierna todo el negocio del reto:

    M = E * N / (N - 1)

donde M = reposicion, E = evaporacion y N = ciclos de concentracion. La
evaporacion la fija la carga termica y NO se puede reducir; el unico grado de
libertad sobre la reposicion son los ciclos, y los ciclos los limita la
CALIDAD del agua de aporte.

De ahi la conclusion contraintuitiva que justifica este software: meter agua
de rechazo (mas salina) sin optimizar BAJA los ciclos alcanzables y puede
AUMENTAR la captacion total de agua cruda. El beneficio solo aparece si la
mezcla, el tratamiento y la dosificacion de acido se resuelven a la vez.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config import LimitesCalidad, TorreConfig
from .water_chem import Calidad

# Calor latente de vaporizacion efectivo del agua a T de torre (kJ/kg) y
# calor especifico (kJ/kg/K).
LAMBDA_KJ_KG = 2_410.0
CP_KJ_KG_K = 4.186


def evaporacion_m3_h(torre: TorreConfig) -> float:
    """Caudal evaporado. Fijado por la carga termica: es irreducible."""
    return (
        torre.caudal_circulacion_m3_h
        * torre.delta_t_c
        * CP_KJ_KG_K
        / LAMBDA_KJ_KG
        * torre.factor_evaporacion
    )


def arrastre_m3_h(torre: TorreConfig) -> float:
    return torre.caudal_circulacion_m3_h * torre.fraccion_arrastre


T_BASIN_C = 32.0   # temperatura del agua fria en la balsa de la torre


@dataclass(frozen=True)
class BalanceTorre:
    ciclos: float
    evaporacion_m3_h: float
    arrastre_m3_h: float
    purga_m3_h: float
    reposicion_m3_h: float

    @property
    def reposicion_m3_dia(self) -> float:
        return self.reposicion_m3_h * 24.0

    @property
    def purga_m3_dia(self) -> float:
        return self.purga_m3_h * 24.0

    def as_dict(self) -> dict[str, float]:
        return {
            "ciclos": round(self.ciclos, 2),
            "evaporacion_m3_h": round(self.evaporacion_m3_h, 2),
            "arrastre_m3_h": round(self.arrastre_m3_h, 3),
            "purga_m3_h": round(self.purga_m3_h, 2),
            "reposicion_m3_h": round(self.reposicion_m3_h, 2),
            "reposicion_m3_dia": round(self.reposicion_m3_dia, 1),
            "purga_m3_dia": round(self.purga_m3_dia, 1),
        }


def balance(
    torre: TorreConfig,
    ciclos: float,
    t_reposicion_c: float | None = None,
    t_basin_c: float = T_BASIN_C,
) -> BalanceTorre:
    """Balance de masa del circuito para unos ciclos de concentracion dados.

    Si se indica `t_reposicion_c`, se contabiliza la carga termica que aporta
    el agua de reposicion cuando entra mas caliente que la balsa. Es el precio
    fisico de aprovechar corrientes calientes (purga de calderas, enfriamiento
    de un solo paso): mas evaporacion y por tanto mas reposicion. Resolviendo

        M = E_proc + M*k + M/N ... =>  M = E_proc * r / (1 - k*r),  r = N/(N-1)

    con k = cp * (T_rep - T_balsa) / lambda.
    """
    if ciclos <= 1.0:
        raise ValueError("Los ciclos de concentracion deben ser > 1.")
    evap_proceso = evaporacion_m3_h(torre)
    drift = arrastre_m3_h(torre)
    r = ciclos / (ciclos - 1.0)

    k = 0.0
    if t_reposicion_c is not None and t_reposicion_c > t_basin_c:
        k = CP_KJ_KG_K * (t_reposicion_c - t_basin_c) / LAMBDA_KJ_KG
    denom = 1.0 - k * r
    if denom <= 0.05:
        raise ValueError(
            "El agua de reposicion esta tan caliente que el circuito no cierra "
            "balance; requiere enfriamiento previo."
        )
    reposicion = evap_proceso * r / denom
    evap_total = reposicion / r
    purga = max(reposicion - evap_total - drift, 0.0)
    return BalanceTorre(ciclos, evap_total, drift, purga, reposicion)


# --------------------------------------------------------------------------
# Ciclos maximos admisibles segun la calidad del agua de aporte
# --------------------------------------------------------------------------

#: (atributo de Calidad, atributo de LimitesCalidad)
_LIMITES_DIRECTOS: tuple[tuple[str, str], ...] = (
    ("tds", "tds_mg_l"),
    ("dureza_ca", "dureza_ca_mg_l"),
    ("alcalinidad", "alcalinidad_mg_l"),
    ("cloruros", "cloruros_mg_l"),
    ("sulfatos", "sulfatos_mg_l"),
    ("silice", "silice_mg_l"),
    ("sst", "sst_mg_l"),
    ("dqo", "dqo_mg_l"),
    ("n_amoniacal", "n_amoniacal_mg_l"),
    ("fosfatos", "fosfatos_mg_l"),
    ("hierro", "hierro_mg_l"),
)


def violaciones(
    circulante: Calidad, limites: LimitesCalidad, lsi_max: float
) -> dict[str, tuple[float, float]]:
    """Parametros del agua circulante fuera de limite -> (valor, limite)."""
    fuera: dict[str, tuple[float, float]] = {}
    for campo, lim_attr in _LIMITES_DIRECTOS:
        valor = getattr(circulante, campo)
        lim = getattr(limites, lim_attr)
        if valor > lim:
            fuera[campo] = (valor, lim)

    if circulante.conductividad > limites.conductividad_us_cm:
        fuera["conductividad"] = (
            circulante.conductividad, limites.conductividad_us_cm
        )

    idx = circulante.indices()
    if idx["lsi"] > lsi_max:
        fuera["lsi"] = (idx["lsi"], lsi_max)
    if idx["larson_skold"] > limites.larson_skold_max:
        fuera["larson_skold"] = (
            idx["larson_skold"], limites.larson_skold_max
        )
    producto = circulante.dureza_ca * circulante.sulfatos
    if producto > limites.producto_caso4_max:
        fuera["producto_caso4"] = (producto, limites.producto_caso4_max)
    return fuera


def ciclos_maximos(
    aporte: Calidad,
    torre: TorreConfig,
    limites: LimitesCalidad,
    lsi_max: float,
    t_operacion_c: float = 38.0,
) -> tuple[float, str | None]:
    """Maximo N alcanzable con esta agua de aporte, y el parametro que lo limita.

    Biseccion sobre N: todas las restricciones son monotonas crecientes con la
    concentracion, por lo que el conjunto factible es un intervalo [1, N_max].
    """
    def factible(n: float) -> bool:
        return not violaciones(
            aporte.escalar(n, t_c=t_operacion_c), limites, lsi_max
        )

    if not factible(torre.ciclos_min):
        circ = aporte.escalar(torre.ciclos_min, t_c=t_operacion_c)
        fuera = violaciones(circ, limites, lsi_max)
        peor = max(fuera, key=lambda k: fuera[k][0] / max(fuera[k][1], 1e-9))
        return 0.0, peor

    if factible(torre.ciclos_max):
        return torre.ciclos_max, None

    lo, hi = torre.ciclos_min, torre.ciclos_max
    for _ in range(40):
        mid = 0.5 * (lo + hi)
        if factible(mid):
            lo = mid
        else:
            hi = mid

    circ = aporte.escalar(hi, t_c=t_operacion_c)
    fuera = violaciones(circ, limites, lsi_max)
    limitante = (
        max(fuera, key=lambda k: fuera[k][0] / max(fuera[k][1], 1e-9))
        if fuera else None
    )
    return lo, limitante


def balance_optimo(
    aporte: Calidad,
    torre: TorreConfig,
    limites: LimitesCalidad,
    lsi_max: float,
    t_operacion_c: float = 38.0,
) -> tuple[BalanceTorre | None, float, str | None]:
    """Balance operando a los ciclos maximos que permite el agua de aporte."""
    n_max, limitante = ciclos_maximos(
        aporte, torre, limites, lsi_max, t_operacion_c
    )
    if n_max <= 1.0:
        return None, n_max, limitante
    return balance(torre, n_max), n_max, limitante
