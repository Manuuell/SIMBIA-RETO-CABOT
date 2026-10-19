"""Simulacion dinamica de la torre: el circuito en el tiempo, con sus lazos.

El motor estacionario (motor.py) dice a donde llega el circuito. Este dice
como llega: cuanto tarda la conductividad en subir cuando se cambia la
consigna, que hace la valvula de reposicion cuando entra un vecino, que pasa
con el nivel si la purga se abre de golpe. Es lo que ve un operador.

Modelo de mezcla perfecta del agua del sistema (balsa + tuberias + equipos):

    dV/dt      = M_cruda + suma(M_vecinos) - E - D - B
    d(V*C)/dt  = suma(Q_i * C_i) - (B + D) * C        para cada especie conservativa

La evaporacion E no se lleva sales: por eso el circuito se concentra. Los
lazos son los de una torre real:

    LIC-101  nivel de la balsa  -> LV-101, valvula de reposicion de agua cruda
    AIC-102  conductividad      -> AV-102, valvula de purga
    FIC-2nn  caudal de cada vecino, a la consigna del operador
    P-101    bomba dosificadora de acido sulfurico sobre la reposicion
    SIC-103  velocidad de los ventiladores -> temperatura del agua fria

Perturbaciones: carga termica y temperatura de bulbo humedo. La quimica de
cada muestra (pH en equilibrio con el aire, LSI, Larson-Skold y el resto de
limites) sale de las mismas funciones que usan el optimizador y el simulador
estacionario: no hay un segundo modelo quimico.

La geometria (celdas, balsa, ventiladores) se dimensiona con el caudal de
recirculacion y reglas de diseno habituales, declaradas abajo. Es la que
dibuja la vista 3D.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Any, Sequence

from ..config import Escenario
from ..domain import cooling
from ..domain.streams import TRENES_POR_CODIGO
from ..domain.water_chem import (
    MG_CACO3_POR_MEQ, PARAMETROS_CONSERVATIVOS, Calidad, ph_sistema_abierto,
)
from ..optim.blend import agua_cruda
from .fuentes import Fuente, oferente
from .motor import ETIQUETAS, T_OPERACION_C

# --------------------------------------------------------------------------
# Reglas de diseno (supuestos declarados)
# --------------------------------------------------------------------------

#: Carga hidraulica de diseno de una torre de contraflujo, m3/h por m2.
CARGA_HIDRAULICA_M3H_M2 = 12.0
#: Lado de celda estandar (24 ft) y profundidad de balsa.
LADO_CELDA_REF_M = 7.3
PROFUNDIDAD_BALSA_M = 1.8
NIVEL_NOMINAL_PCT = 67.0
#: Agua fuera de la balsa (tuberias, intercambiadores), en horas de recirculacion.
RETENCION_SISTEMA_H = 0.25
#: Ventilador: diametro relativo a la celda y velocidad de punta de pala.
DIAMETRO_VENTILADOR_REL = 0.82
VELOCIDAD_PUNTA_M_S = 60.0
POTENCIA_VENTILADOR_KW = 45.0
#: Aproximacion al bulbo humedo de diseno, a plena carga y ventilacion.
APROXIMACION_DISENO_C = 4.5
T_BULBO_DISENO_C = 27.0
#: Capacidad de las valvulas respecto al caudal de diseno de la linea base.
CAPACIDAD_REPOSICION_REL = 2.2
CAPACIDAD_PURGA_REL = 3.0

DT_H = 1.0 / 60.0            # paso de integracion: un minuto
MUESTRA_H = 5.0 / 60.0       # una muestra cada cinco minutos de simulacion
MAX_HORAS_POR_LLAMADA = 72.0
ATENUACION = {"dqo": 0.75, "n_amoniacal": 0.60}


# --------------------------------------------------------------------------
# Geometria
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Geometria:
    celdas: int
    lado_celda_m: float
    area_balsa_m2: float
    profundidad_balsa_m: float
    volumen_fuera_balsa_m3: float
    diametro_ventilador_m: float
    rpm_nominal: float
    altura_cubierta_m: float
    altura_chimenea_m: float

    def volumen(self, nivel_pct: float) -> float:
        return self.volumen_fuera_balsa_m3 + self.area_balsa_m2 * self.profundidad_balsa_m * nivel_pct / 100.0

    def nivel(self, volumen_m3: float) -> float:
        return (volumen_m3 - self.volumen_fuera_balsa_m3) / (self.area_balsa_m2 * self.profundidad_balsa_m) * 100.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "celdas": self.celdas,
            "lado_celda_m": round(self.lado_celda_m, 2),
            "area_balsa_m2": round(self.area_balsa_m2, 1),
            "profundidad_balsa_m": self.profundidad_balsa_m,
            "volumen_sistema_m3": round(self.volumen(NIVEL_NOMINAL_PCT), 0),
            "diametro_ventilador_m": round(self.diametro_ventilador_m, 2),
            "rpm_nominal": round(self.rpm_nominal, 0),
            "altura_cubierta_m": round(self.altura_cubierta_m, 1),
            "altura_chimenea_m": round(self.altura_chimenea_m, 1),
        }


def dimensionar(esc: Escenario) -> Geometria:
    """Celdas y balsa a partir del caudal de recirculacion."""
    area = esc.torre.caudal_circulacion_m3_h / CARGA_HIDRAULICA_M3H_M2
    celdas = max(1, round(area / LADO_CELDA_REF_M ** 2))
    lado = math.sqrt(area / celdas)
    diametro = DIAMETRO_VENTILADOR_REL * lado
    return Geometria(
        celdas=celdas,
        lado_celda_m=lado,
        area_balsa_m2=area,
        profundidad_balsa_m=PROFUNDIDAD_BALSA_M,
        volumen_fuera_balsa_m3=RETENCION_SISTEMA_H * esc.torre.caudal_circulacion_m3_h,
        diametro_ventilador_m=diametro,
        rpm_nominal=VELOCIDAD_PUNTA_M_S * 60.0 / (math.pi * diametro),
        altura_cubierta_m=round(1.25 * lado + 2.0, 1),
        altura_chimenea_m=round(0.35 * diametro, 1),
    )


# --------------------------------------------------------------------------
# Entradas, estado y control
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Lazo:
    """Un controlador PI: en automatico sigue la consigna; en manual, OUT."""

    modo: str = "auto"          # "auto" | "man"
    consigna: float = 0.0
    salida_pct: float = 50.0
    #: Limite de velocidad de la consigna, unidades por hora; 0 = escalon.
    #: Es la rampa de consigna de cualquier DCS: al subir ciclos, el circuito
    #: necesita dias para renovar su alcalinidad aunque la conductividad
    #: llegue antes, y un escalon cruza el limite de LSI por el camino.
    rampa_por_h: float = 0.0


@dataclass(frozen=True)
class TomaDinamica:
    fuente: Fuente
    caudal_m3_h: float
    tren: str = "T1"


@dataclass(frozen=True)
class Entradas:
    carga_pct: float = 100.0
    t_bulbo_c: float = T_BULBO_DISENO_C
    ventilador_pct: float = 100.0
    acido_mg_l: float = 0.0
    nivel: Lazo = field(default_factory=lambda: Lazo("auto", NIVEL_NOMINAL_PCT, 50.0))
    conductividad: Lazo | None = None     # None: consigna = la de la linea base
    tomas: tuple[TomaDinamica, ...] = ()


@dataclass
class Estado:
    t_h: float
    volumen_m3: float
    conc: dict[str, float]
    integral_nivel: float = 0.0
    integral_cond: float = 0.0
    lv_pct: float = 50.0
    av_pct: float = 30.0
    cruda_acumulada_m3: float = 0.0
    base_acumulada_m3: float = 0.0
    #: Consigna que sigue el lazo de conductividad mientras recorre la rampa.
    consigna_cond: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "t_h": round(self.t_h, 4),
            "volumen_m3": round(self.volumen_m3, 3),
            "conc": {k: round(v, 4) for k, v in self.conc.items()},
            "integral_nivel": round(self.integral_nivel, 5),
            "integral_cond": round(self.integral_cond, 5),
            "lv_pct": round(self.lv_pct, 3),
            "av_pct": round(self.av_pct, 3),
            "cruda_acumulada_m3": round(self.cruda_acumulada_m3, 2),
            "base_acumulada_m3": round(self.base_acumulada_m3, 2),
            "consigna_cond": None if self.consigna_cond is None else round(self.consigna_cond, 3),
        }


#: Sintonia de los lazos (PI en forma estandar, salida en %).
KP_NIVEL, TI_NIVEL_H = 6.0, 0.4             # % de valvula por % de nivel
# Conductividad: ganancia alta porque la purga se satura cerrada al subir la
# consigna; con menos ganancia el lazo reacciona tarde y sobreoscila mas.
KP_COND, TI_COND_H = 0.2, 3.0               # % de valvula por uS/cm


def _pi(pv: float, lazo: Lazo, integral: float, directo: bool, kp: float,
        ti: float) -> tuple[float, float]:
    """Un paso de PI con anti-windup por integracion condicional."""
    if lazo.modo == "man":
        return min(max(lazo.salida_pct, 0.0), 100.0), integral
    error = (pv - lazo.consigna) if directo else (lazo.consigna - pv)
    nueva_integral = integral + error * DT_H / ti
    salida = kp * (error + nueva_integral) + 50.0
    if 0.0 <= salida <= 100.0:
        integral = nueva_integral
    else:
        salida = kp * (error + integral) + 50.0
    return min(max(salida, 0.0), 100.0), integral


# --------------------------------------------------------------------------
# Planta dinamica
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Planta:
    esc: Escenario
    geo: Geometria
    cruda: Calidad
    reposicion_base_m3_h: float
    purga_base_m3_h: float
    capacidad_lv_m3_h: float
    capacidad_av_m3_h: float
    cond_consigna_base: float


def preparar(esc: Escenario) -> Planta:
    geo = dimensionar(esc)
    cruda = agua_cruda(esc)
    base = cooling.balance(esc.torre, esc.torre.ciclos_base, cruda.t_c)
    return Planta(
        esc=esc, geo=geo, cruda=cruda,
        reposicion_base_m3_h=base.reposicion_m3_h,
        purga_base_m3_h=base.purga_m3_h,
        capacidad_lv_m3_h=CAPACIDAD_REPOSICION_REL * base.reposicion_m3_h,
        capacidad_av_m3_h=CAPACIDAD_PURGA_REL * base.purga_m3_h,
        cond_consigna_base=cruda.conductividad * esc.torre.ciclos_base,
    )


def estado_inicial(p: Planta) -> Estado:
    """La operacion actual en regimen: solo agua cruda, a los ciclos de base."""
    n = p.esc.torre.ciclos_base
    lv = 100.0 * p.reposicion_base_m3_h / p.capacidad_lv_m3_h
    av = 100.0 * p.purga_base_m3_h / p.capacidad_av_m3_h
    # Integradores precargados para que, sin error, cada PI de ya la salida
    # de regimen: la simulacion arranca sin salto.
    return Estado(
        t_h=0.0,
        volumen_m3=p.geo.volumen(NIVEL_NOMINAL_PCT),
        conc={k: getattr(p.cruda, k) * n for k in PARAMETROS_CONSERVATIVOS},
        integral_nivel=(lv - 50.0) / KP_NIVEL,
        integral_cond=(av - 50.0) / KP_COND,
        lv_pct=lv,
        av_pct=av,
    )


def _evaporacion(p: Planta, e: Entradas) -> float:
    torre = replace(p.esc.torre, delta_t_c=p.esc.torre.delta_t_c * e.carga_pct / 100.0)
    return cooling.evaporacion_m3_h(torre)


def t_quimica(p: Planta, t_caliente: float) -> float:
    """Temperatura a la que se evalua la quimica del circuito.

    El optimizador y el simulador estacionario la evaluan a T_OPERACION_C.
    Aqui se parte de ese mismo valor y se le suma lo que el agua caliente se
    aparte de la de diseno: en condiciones de diseno los dos modelos dicen lo
    mismo, y si el ventilador baja o el bulbo humedo sube, el LSI lo nota.
    """
    diseno = T_BULBO_DISENO_C + APROXIMACION_DISENO_C + p.esc.torre.delta_t_c
    return T_OPERACION_C + (t_caliente - diseno)


def temperaturas(p: Planta, e: Entradas) -> tuple[float, float, float]:
    """(agua fria, agua caliente, aproximacion). Mas ventilador, menos aproximacion."""
    ventilacion = max(e.ventilador_pct, 15.0) / 100.0
    aproximacion = APROXIMACION_DISENO_C * (max(e.carga_pct, 5.0) / 100.0) ** 0.6 / ventilacion ** 0.7
    fria = e.t_bulbo_c + aproximacion
    return fria, fria + p.esc.torre.delta_t_c * e.carga_pct / 100.0, aproximacion


def _productos(e: Entradas) -> list[tuple[dict[str, float], float, dict[str, Any]]]:
    """Composicion tratada y caudal de cada vecino. Fijos durante una llamada."""
    salida = []
    for t in e.tomas:
        tren = TRENES_POR_CODIGO.get(t.tren)
        if tren is None:
            raise ValueError(f"Tren de tratamiento desconocido: {t.tren}")
        producto = tren.aplicar(oferente(t.fuente).calidad)
        salida.append((
            {k: getattr(producto, k) for k in PARAMETROS_CONSERVATIVOS},
            max(t.caudal_m3_h, 0.0),
            {"fuente_id": t.fuente.id, "caudal_m3_h": round(t.caudal_m3_h, 2), "tren": t.tren},
        ))
    return salida


def _aporte(cruda: dict[str, float], cruda_m3_h: float,
            productos: Sequence[tuple[dict[str, float], float, Any]],
            acido_mg_l: float) -> tuple[dict[str, float], float]:
    """Composicion y caudal del agua que entra, con el acido dosificado.

    Para el balance de masa solo cuentan las especies conservativas, que se
    mezclan linealmente; el pH del circuito se recalcula en equilibrio con el
    aire al muestrear. El acido, como en `dosificar_acido`: destruye
    alcalinidad y aporta sulfato.
    """
    total = cruda_m3_h + sum(q for _, q, _ in productos)
    if total <= 1e-9:
        return dict(cruda), 0.0
    mezcla = {
        k: (cruda[k] * cruda_m3_h + sum(c[k] * q for c, q, _ in productos)) / total
        for k in PARAMETROS_CONSERVATIVOS
    }
    if acido_mg_l > 0:
        eq = acido_mg_l / 49.04
        mezcla["alcalinidad"] = max(mezcla["alcalinidad"] - eq * MG_CACO3_POR_MEQ, 10.0)
        mezcla["sulfatos"] += eq * 48.03
    return mezcla, total


def circulante(p: Planta, conc: dict[str, float], t_c: float) -> Calidad:
    campos = {k: conc[k] * ATENUACION.get(k, 1.0) for k in PARAMETROS_CONSERVATIVOS}
    return Calidad(ph=ph_sistema_abierto(campos["alcalinidad"], t_c), t_c=t_c, **campos)


def _alarmas(p: Planta, nivel: float, margenes: list[tuple[str, float, float]],
             t_fria: float) -> list[dict[str, Any]]:
    salida = []
    if nivel < 30:
        salida.append({"tag": "LIC-101", "texto": "Nivel bajo en la balsa", "severidad": "alta" if nivel < 15 else "media"})
    elif nivel > 90:
        salida.append({"tag": "LIC-101", "texto": "Nivel alto en la balsa: riesgo de rebose", "severidad": "media"})
    for param, valor, limite in margenes:
        if limite > 0 and valor > limite:
            salida.append({"tag": "AIT-102" if param in ("conductividad", "tds") else "QI-104",
                           "texto": f"{ETIQUETAS.get(param, (param, ''))[0]} fuera de limite",
                           "severidad": "alta"})
        elif limite > 0 and valor > 0.95 * limite:
            salida.append({"tag": "QI-104", "texto": f"{ETIQUETAS.get(param, (param, ''))[0]} cerca del limite",
                           "severidad": "baja"})
    if t_fria > 34.0:
        salida.append({"tag": "TI-105", "texto": f"Agua fria a {t_fria:.1f} °C", "severidad": "media"})
    return salida


def avanzar(p: Planta, estado: Estado, e: Entradas, horas: float) -> tuple[list[dict[str, Any]], Estado]:
    """Integra `horas` de simulacion y devuelve las muestras y el estado final."""
    if not 0 < horas <= MAX_HORAS_POR_LLAMADA:
        raise ValueError(f"Se simulan entre 0 y {MAX_HORAS_POR_LLAMADA:g} horas por llamada.")
    s = replace(estado, conc=dict(estado.conc))
    lazo_cond = e.conductividad or Lazo("auto", p.cond_consigna_base, s.av_pct)
    evap = _evaporacion(p, e)
    arrastre = cooling.arrastre_m3_h(p.esc.torre)
    productos = _productos(e)
    filas = [f for _, _, f in productos]
    q_vecinos = sum(q for _, q, _ in productos)
    cruda = {k: getattr(p.cruda, k) for k in PARAMETROS_CONSERVATIVOS}
    t_fria, t_caliente, aproximacion = temperaturas(p, e)
    muestras: list[dict[str, Any]] = []
    pasos = max(1, round(horas / DT_H))
    cada = max(1, round(MUESTRA_H / DT_H))

    for i in range(pasos):
        nivel = p.geo.nivel(s.volumen_m3)
        cond = s.conc["tds"] / 0.65
        if s.consigna_cond is None:
            s.consigna_cond = p.cond_consigna_base if lazo_cond.rampa_por_h > 0 else lazo_cond.consigna
        delta = lazo_cond.consigna - s.consigna_cond
        paso = lazo_cond.rampa_por_h * DT_H if lazo_cond.rampa_por_h > 0 else abs(delta)
        s.consigna_cond += max(-paso, min(paso, delta))
        lazo_ef = replace(lazo_cond, consigna=s.consigna_cond)
        s.lv_pct, s.integral_nivel = _pi(nivel, e.nivel, s.integral_nivel, False, KP_NIVEL, TI_NIVEL_H)
        s.av_pct, s.integral_cond = _pi(cond, lazo_ef, s.integral_cond, True, KP_COND, TI_COND_H)
        cruda_q = p.capacidad_lv_m3_h * s.lv_pct / 100.0
        purga = p.capacidad_av_m3_h * s.av_pct / 100.0
        aporte, total = _aporte(cruda, cruda_q, productos, e.acido_mg_l)

        dv = (total - evap - arrastre - purga) * DT_H
        nuevo_v = max(s.volumen_m3 + dv, p.geo.volumen_fuera_balsa_m3 * 0.5)
        salida_sales = purga + arrastre
        for k in PARAMETROS_CONSERVATIVOS:
            masa = s.conc[k] * s.volumen_m3 + (total * aporte[k] - salida_sales * s.conc[k]) * DT_H
            s.conc[k] = max(masa / nuevo_v, 0.0)
        s.volumen_m3 = nuevo_v
        s.t_h += DT_H
        s.cruda_acumulada_m3 += cruda_q * DT_H
        s.base_acumulada_m3 += p.reposicion_base_m3_h * e.carga_pct / 100.0 * DT_H

        if (i + 1) % cada == 0 or i == pasos - 1:
            circ = circulante(p, s.conc, t_quimica(p, t_caliente))
            margenes = cooling.margenes(circ, p.esc.limites, p.esc.lsi_max_efectivo)
            idx = circ.indices()
            nivel = p.geo.nivel(s.volumen_m3)
            ciclos = s.conc["tds"] / aporte["tds"] if total > 1e-9 and aporte["tds"] > 0 else None
            consumo_h = p.esc.planta.consumo_total_m3_dia / 24.0
            muestras.append({
                "t_h": round(s.t_h, 4),
                "nivel_pct": round(nivel, 2),
                "conductividad": round(circ.conductividad, 1),
                "consigna_cond": round(s.consigna_cond, 1),
                "ciclos": round(ciclos, 3) if ciclos else None,
                "cruda_m3_h": round(cruda_q, 2),
                "vecinos_m3_h": round(q_vecinos, 2),
                "reposicion_m3_h": round(total, 2),
                "purga_m3_h": round(purga, 2),
                "evaporacion_m3_h": round(evap, 2),
                "arrastre_m3_h": round(arrastre, 3),
                "lv_pct": round(s.lv_pct, 1),
                "av_pct": round(s.av_pct, 1),
                "ph": round(circ.ph, 2),
                "lsi": round(idx["lsi"], 3),
                "larson_skold": round(idx["larson_skold"], 3),
                "t_fria_c": round(t_fria, 2),
                "t_caliente_c": round(t_caliente, 2),
                "aproximacion_c": round(aproximacion, 2),
                "rpm": round(p.geo.rpm_nominal * e.ventilador_pct / 100.0, 1),
                "potencia_ventiladores_kw": round(
                    p.geo.celdas * POTENCIA_VENTILADOR_KW * (e.ventilador_pct / 100.0) ** 3, 1),
                "ahorro_pct": round((p.reposicion_base_m3_h * e.carga_pct / 100.0 - cruda_q) / consumo_h, 4),
                "margenes": [
                    {"parametro": k, "valor": round(v, 3), "limite": round(lim, 3)}
                    for k, v, lim in margenes
                ],
                "alarmas": _alarmas(p, nivel, margenes, t_fria),
                "tomas": filas,
            })
    return muestras, s
