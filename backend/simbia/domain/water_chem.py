"""Quimica del agua: sistema carbonatado, indices de estabilidad y mezcla.

El nucleo tecnico de SIMBIA. Todo el resto (optimizador, IA, dashboard) se
apoya en estas funciones, por lo que estan escritas para ser exactas y
testeables, no aproximadas.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Iterable, Sequence

# --------------------------------------------------------------------------
# Constantes del sistema carbonatado (agua dulce, fuerza ionica baja)
# --------------------------------------------------------------------------

PK1_25 = 6.35     # H2CO3* / HCO3-
PK2_25 = 10.33    # HCO3- / CO3=
PKW_25 = 14.00
LOG_KH_25 = -1.47  # log10 de la constante de Henry del CO2, mol/(L*atm)
PCO2_ATM = 4.2e-4  # presion parcial de CO2 en aire (atm)

# 1 meq/L de alcalinidad = 50 mg/L como CaCO3
MG_CACO3_POR_MEQ = 50.0


def _pk1(t_c: float) -> float:
    """pK1 corregido por temperatura (Plummer & Busenberg, forma reducida)."""
    t_k = t_c + 273.15
    return 356.3094 + 0.06091964 * t_k - 21834.37 / t_k \
        - 126.8339 * math.log10(t_k) + 1684915.0 / (t_k * t_k)


def _pk2(t_c: float) -> float:
    t_k = t_c + 273.15
    return 107.8871 + 0.03252849 * t_k - 5151.79 / t_k \
        - 38.92561 * math.log10(t_k) + 563713.9 / (t_k * t_k)


def _pkw(t_c: float) -> float:
    t_k = t_c + 273.15
    return 4470.99 / t_k - 6.0875 + 0.01706 * t_k


def _log_kh(t_c: float) -> float:
    """log10 de la constante de Henry del CO2, mol/(L*atm). ~-1.47 a 25 C.

    A diferencia de _pk1/_pk2/_pkw, esta correlacion (Plummer & Busenberg)
    devuelve directamente log10(KH) y NO su negativo.
    """
    t_k = t_c + 273.15
    return 108.3865 + 0.01985076 * t_k - 6919.53 / t_k \
        - 40.45154 * math.log10(t_k) + 669365.0 / (t_k * t_k)


def alcalinidad_a_eq(alc_mg_caco3: float) -> float:
    """mg/L como CaCO3 -> eq/L."""
    return alc_mg_caco3 / MG_CACO3_POR_MEQ / 1000.0


def eq_a_alcalinidad(alc_eq: float) -> float:
    return alc_eq * 1000.0 * MG_CACO3_POR_MEQ


def carbono_total(ph: float, alc_mg_caco3: float, t_c: float = 25.0) -> float:
    """Carbono inorganico total C_T (mol/L) a partir de pH y alcalinidad.

    Alk = [HCO3-] + 2[CO3=] + [OH-] - [H+]
    """
    h = 10.0 ** (-ph)
    k1, k2, kw = 10.0 ** -_pk1(t_c), 10.0 ** -_pk2(t_c), 10.0 ** -_pkw(t_c)
    alc = alcalinidad_a_eq(alc_mg_caco3)
    denom = 1.0 + h / k1 + k2 / h          # 1/alpha1
    alpha1 = 1.0 / denom
    alpha2 = alpha1 * k2 / h
    carbonato = alpha1 + 2.0 * alpha2
    ct = (alc - kw / h + h) / carbonato
    return max(ct, 0.0)


def ph_desde_alc_ct(alc_mg_caco3: float, ct: float, t_c: float = 25.0) -> float:
    """pH de un sistema cerrado dados alcalinidad y C_T (biseccion)."""
    k1, k2, kw = 10.0 ** -_pk1(t_c), 10.0 ** -_pk2(t_c), 10.0 ** -_pkw(t_c)
    alc = alcalinidad_a_eq(alc_mg_caco3)

    def residual(ph: float) -> float:
        h = 10.0 ** (-ph)
        alpha1 = 1.0 / (1.0 + h / k1 + k2 / h)
        alpha2 = alpha1 * k2 / h
        return ct * (alpha1 + 2.0 * alpha2) + kw / h - h - alc

    lo, hi = 3.0, 12.0
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if residual(mid) > 0.0:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


def ph_sistema_abierto(
    alc_mg_caco3: float, t_c: float = 25.0, pco2: float = PCO2_ATM
) -> float:
    """pH de agua en equilibrio con el CO2 del aire.

    Es el caso de la torre de enfriamiento: el agua se airea intensamente y
    el CO2 se desorbe hasta equilibrar con la atmosfera, lo que ELEVA el pH
    respecto del agua de reposicion. Ignorar este efecto es el error mas
    comun al estimar el riesgo de incrustacion en torres.
    """
    k1, k2, kw = 10.0 ** -_pk1(t_c), 10.0 ** -_pk2(t_c), 10.0 ** -_pkw(t_c)
    kh = 10.0 ** _log_kh(t_c)
    co2 = kh * pco2  # [H2CO3*] fijado por la atmosfera
    alc = alcalinidad_a_eq(alc_mg_caco3)

    def residual(ph: float) -> float:
        h = 10.0 ** (-ph)
        hco3 = k1 * co2 / h
        co3 = k2 * hco3 / h
        return hco3 + 2.0 * co3 + kw / h - h - alc

    lo, hi = 4.0, 11.5
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if residual(mid) > 0.0:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


# --------------------------------------------------------------------------
# Indices de estabilidad
# --------------------------------------------------------------------------

def ph_saturacion(
    t_c: float, tds_mg_l: float, dureza_ca_mg_l: float, alc_mg_caco3: float
) -> float:
    """pH de saturacion respecto a CaCO3 (Langelier)."""
    tds = max(tds_mg_l, 10.0)
    ca = max(dureza_ca_mg_l, 1.0)
    alc = max(alc_mg_caco3, 1.0)
    t_k = t_c + 273.15
    a = (math.log10(tds) - 1.0) / 10.0
    b = -13.12 * math.log10(t_k) + 34.55
    c = math.log10(ca) - 0.4
    d = math.log10(alc)
    return (9.3 + a + b) - (c + d)


def lsi(ph: float, t_c: float, tds: float, ca: float, alc: float) -> float:
    """Langelier Saturation Index. >0 incrustante, <0 corrosivo."""
    return ph - ph_saturacion(t_c, tds, ca, alc)


def rsi(ph: float, t_c: float, tds: float, ca: float, alc: float) -> float:
    """Ryznar Stability Index. 6.0-7.0 equilibrado, <6 incrustante."""
    return 2.0 * ph_saturacion(t_c, tds, ca, alc) - ph


def psi(t_c: float, tds: float, ca: float, alc: float) -> float:
    """Puckorius Scaling Index: usa el pH de equilibrio, no el medido.

    Mas fiable que LSI/RSI en aguas de torre con dosificacion de acido.
    """
    ph_eq = 4.54 + 0.0183 * max(alc, 1.0)
    return 2.0 * ph_saturacion(t_c, tds, ca, alc) - ph_eq


def larson_skold(cloruros: float, sulfatos: float, alc_mg_caco3: float) -> float:
    """Indice de corrosividad de Larson-Skold (eq Cl+SO4 / eq alcalinidad).

    <0.8 no corrosivo | 0.8-1.2 vigilancia | >1.2 corrosivo para acero.
    """
    eq_cl = cloruros / 35.45
    eq_so4 = sulfatos / 48.03
    eq_alc = max(alc_mg_caco3, 1.0) / 50.0
    return (eq_cl + eq_so4) / eq_alc


# --------------------------------------------------------------------------
# Corriente de agua
# --------------------------------------------------------------------------

#: Parametros que se mezclan de forma lineal por balance de masa.
PARAMETROS_CONSERVATIVOS: tuple[str, ...] = (
    "tds", "dureza_ca", "alcalinidad", "cloruros", "sulfatos",
    "silice", "sst", "dqo", "n_amoniacal", "fosfatos", "hierro",
)


@dataclass(frozen=True)
class Calidad:
    """Vector de calidad de una corriente de agua. Unidades en mg/L salvo nota."""

    ph: float = 7.5
    t_c: float = 28.0
    tds: float = 250.0
    dureza_ca: float = 90.0       # como CaCO3
    alcalinidad: float = 110.0    # como CaCO3
    cloruros: float = 35.0
    sulfatos: float = 45.0
    silice: float = 12.0          # como SiO2
    sst: float = 5.0
    dqo: float = 8.0
    n_amoniacal: float = 0.2
    fosfatos: float = 0.4         # como PO4
    hierro: float = 0.1

    @property
    def conductividad(self) -> float:
        """Conductividad estimada (uS/cm). Regla practica TDS ~ 0.65 x CE."""
        return self.tds / 0.65

    def escalar(self, factor: float, t_c: float | None = None) -> "Calidad":
        """Concentra la corriente `factor` veces (ciclos de concentracion).

        Los conservativos se multiplican; el pH se recalcula por equilibrio
        con el CO2 atmosferico (condicion real de una torre abierta). `t_c`
        permite evaluar el agua a la temperatura de operacion del circuito,
        que es mayor que la del agua de reposicion.
        """
        t_op = self.t_c if t_c is None else t_c
        campos = {p: getattr(self, p) * factor for p in PARAMETROS_CONSERVATIVOS}
        # La materia organica y el amonio se degradan biologicamente en el
        # circuito; se aplica un factor de atenuacion conservador.
        campos["dqo"] = self.dqo * factor * 0.75
        campos["n_amoniacal"] = self.n_amoniacal * factor * 0.60
        nueva_alc = campos["alcalinidad"]
        return replace(
            self,
            **campos,
            t_c=t_op,
            ph=ph_sistema_abierto(nueva_alc, t_op),
        )

    def indices(self) -> dict[str, float]:
        return {
            "lsi": lsi(self.ph, self.t_c, self.tds, self.dureza_ca, self.alcalinidad),
            "rsi": rsi(self.ph, self.t_c, self.tds, self.dureza_ca, self.alcalinidad),
            "psi": psi(self.t_c, self.tds, self.dureza_ca, self.alcalinidad),
            "larson_skold": larson_skold(
                self.cloruros, self.sulfatos, self.alcalinidad
            ),
        }

    def as_dict(self) -> dict[str, float]:
        d = {p: round(getattr(self, p), 3) for p in PARAMETROS_CONSERVATIVOS}
        d["ph"] = round(self.ph, 2)
        d["t_c"] = round(self.t_c, 1)
        d["conductividad"] = round(self.conductividad, 1)
        d.update({k: round(v, 3) for k, v in self.indices().items()})
        return d


def mezclar(
    corrientes: Sequence[Calidad], caudales: Sequence[float]
) -> Calidad:
    """Mezcla corrientes por balance de masa.

    Los conservativos se promedian ponderando por caudal. El pH NO se promedia:
    se mezclan alcalinidad y carbono inorganico total (ambos conservativos en
    ausencia de intercambio gaseoso) y se resuelve el equilibrio carbonatado.
    """
    total = sum(caudales)
    if total <= 0:
        return Calidad()

    campos: dict[str, float] = {}
    for p in PARAMETROS_CONSERVATIVOS:
        campos[p] = sum(
            getattr(c, p) * q for c, q in zip(corrientes, caudales)
        ) / total

    t_mix = sum(c.t_c * q for c, q in zip(corrientes, caudales)) / total
    ct_mix = sum(
        carbono_total(c.ph, c.alcalinidad, c.t_c) * q
        for c, q in zip(corrientes, caudales)
    ) / total
    ph_mix = ph_desde_alc_ct(campos["alcalinidad"], ct_mix, t_mix)

    return Calidad(ph=ph_mix, t_c=t_mix, **campos)


def dosificar_acido(calidad: Calidad, mg_h2so4_por_l: float) -> Calidad:
    """Aplica dosificacion de acido sulfurico.

    1 eq de H2SO4 (49 g) destruye 1 eq de alcalinidad (50 mg como CaCO3) y
    aporta 48.03 mg de SO4=. Es la palanca mas barata para subir ciclos de
    concentracion cuando el agua de aporte es alcalina.
    """
    if mg_h2so4_por_l <= 0:
        return calidad
    eq = mg_h2so4_por_l / 49.04
    alc_nueva = max(calidad.alcalinidad - eq * MG_CACO3_POR_MEQ, 10.0)
    so4_nuevo = calidad.sulfatos + eq * 48.03
    ct = carbono_total(calidad.ph, calidad.alcalinidad, calidad.t_c)
    return replace(
        calidad,
        alcalinidad=alc_nueva,
        sulfatos=so4_nuevo,
        ph=ph_desde_alc_ct(alc_nueva, ct, calidad.t_c),
    )


def acido_para_alcalinidad(alc_inicial: float, alc_objetivo: float) -> float:
    """mg/L de H2SO4 necesarios para bajar de `alc_inicial` a `alc_objetivo`."""
    delta = max(alc_inicial - alc_objetivo, 0.0)
    return delta / MG_CACO3_POR_MEQ * 49.04
