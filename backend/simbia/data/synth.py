"""Generador de historico sintetico para entrenar y validar los modelos de IA.

IMPORTANTE
----------
No hay datos reales de la planta. Este generador NO inventa correlaciones: usa
el mismo modelo fisico del gemelo digital (evaporacion, ciclos, balance) y le
anade la variabilidad que sufre una planta real -- clima, carga de produccion,
ruido de instrumentacion, fugas, derivas de calidad en los vecinos.

Cuando exista el historico del SCADA, este modulo se reemplaza por el cargador
correspondiente y los modelos se reentrenan sin tocar el resto del sistema.
Todo lo que la IA aprenda aqui es, por construccion, fisica del sistema mas
patrones de fallo; ninguna conclusion economica del reto depende de estos datos.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from ..config import Escenario
from ..domain import cooling
from ..domain.streams import AGUA_CRUDA, CATALOGO
from ..domain.water_chem import ph_sistema_abierto, lsi

SEMILLA = 20260901


@dataclass
class ConfigSintetica:
    horas: int = 24 * 30 * 18          # 18 meses
    lat_tropical: bool = True          # estacionalidad suave, clima calido
    prob_fuga: float = 0.004           # arranque de fuga por hora
    duracion_fuga_media_h: float = 60.0
    magnitud_fuga: tuple[float, float] = (0.04, 0.18)  # fraccion extra de makeup
    ruido_caudalimetro: float = 0.02
    semilla: int = SEMILLA


def _ar1(
    n: int, sigma: float, phi: float, rng: np.random.Generator
) -> np.ndarray:
    """Ruido AR(1) de media cero cuya desviacion ESTACIONARIA es `sigma`.

    El filtro x[i] = phi*x[i-1] + (1-phi)*e[i] reduce la varianza en
    sqrt((1-phi)/(1+phi)); se compensa la innovacion para no perderla.
    """
    escala = sigma / np.sqrt((1.0 - phi) / (1.0 + phi))
    e = rng.normal(0.0, escala, n)
    x = np.empty(n)
    x[0] = e[0] * np.sqrt((1.0 - phi) / (1.0 + phi))
    for i in range(1, n):
        x[i] = phi * x[i - 1] + (1.0 - phi) * e[i]
    return x


def _clima(n: int, rng: np.random.Generator, tropical: bool) -> tuple[np.ndarray, np.ndarray]:
    """Temperatura ambiente (C) y humedad relativa (0-1) horarias."""
    t = np.arange(n)
    hora = t % 24
    dia_anio = (t // 24) % 365

    amp_estacional = 2.5 if tropical else 9.0
    media = 28.5 if tropical else 16.0
    estacional = amp_estacional * np.sin(2 * np.pi * (dia_anio - 100) / 365)
    diurna = 4.2 * np.sin(2 * np.pi * (hora - 9) / 24)
    # Persistencia meteorologica: los frentes duran dias, no horas.
    ruido = _ar1(n, sigma=1.6, phi=0.75, rng=rng)
    t_amb = media + estacional + diurna + ruido

    hr = 0.74 - 0.010 * (t_amb - media) + rng.normal(0, 0.05, n)
    hr = np.clip(hr, 0.35, 0.98)
    return t_amb, hr


def _carga_produccion(n: int, rng: np.random.Generator) -> np.ndarray:
    """Factor de carga de la planta (0-1). Continua con paradas programadas."""
    carga = 0.92 + _ar1(n, sigma=0.045, phi=0.85, rng=rng)
    # Paradas de mantenimiento: 3 al anio, 2-5 dias.
    n_paradas = max(1, int(n / (24 * 120)))
    for _ in range(n_paradas):
        ini = rng.integers(0, max(n - 120, 1))
        dur = int(rng.integers(48, 120))
        carga[ini:ini + dur] *= rng.uniform(0.15, 0.35)
    return np.clip(carga, 0.05, 1.05)


def _fraccion_evaporativa(t_amb: np.ndarray, hr: np.ndarray) -> np.ndarray:
    """Fraccion del calor disipado por evaporacion.

    En aire humedo y calido la transferencia sensible es pobre y practicamente
    todo el calor se va como calor latente; en aire seco y frio, menos.
    """
    f = 0.62 + 0.011 * (t_amb - 15.0) + 0.22 * (hr - 0.5)
    return np.clip(f, 0.55, 1.0)


def generar(
    esc: Escenario | None = None, cfg: ConfigSintetica | None = None
) -> pd.DataFrame:
    """Historico horario del circuito de enfriamiento."""
    esc = esc or Escenario()
    cfg = cfg or ConfigSintetica()
    rng = np.random.default_rng(cfg.semilla)
    n = cfg.horas

    t_amb, hr = _clima(n, rng, cfg.lat_tropical)
    carga = _carga_produccion(n, rng)
    f_evap = _fraccion_evaporativa(t_amb, hr)

    circ = esc.torre.caudal_circulacion_m3_h * (0.55 + 0.45 * carga)
    delta_t = esc.torre.delta_t_c * (0.7 + 0.3 * carga)
    evap = circ * delta_t * cooling.CP_KJ_KG_K / cooling.LAMBDA_KJ_KG * f_evap
    drift = circ * esc.torre.fraccion_arrastre

    # El operador controla la purga por consigna de conductividad, con
    # histeresis y deriva: los ciclos reales oscilan alrededor del objetivo.
    ciclos_obj = esc.torre.ciclos_base
    # La variabilidad la aporta sobre todo la operacion (AR), no el calendario:
    # una deriva estacional dominante haria que cualquier modelo de riesgo
    # aprendiese solo "en que mes estamos" y no las condiciones de operacion.
    ciclos = ciclos_obj + _ar1(n, sigma=0.35, phi=0.95, rng=rng)
    ciclos += 0.10 * np.sin(2 * np.pi * np.arange(n) / (24 * 90))
    ciclos = np.clip(ciclos, 1.8, 7.5)

    purga = np.maximum(evap / (ciclos - 1.0) - drift, 0.0)
    reposicion_real = evap + purga + drift

    # --- Fugas -----------------------------------------------------------
    fuga = np.zeros(n)
    i = 0
    while i < n:
        if rng.random() < cfg.prob_fuga:
            dur = int(rng.exponential(cfg.duracion_fuga_media_h)) + 4
            mag = rng.uniform(*cfg.magnitud_fuga)
            fin = min(i + dur, n)
            rampa = np.linspace(0.3, 1.0, fin - i)
            fuga[i:fin] = mag * rampa
            i = fin
        i += 1
    reposicion_con_fuga = reposicion_real * (1.0 + fuga)

    # --- Instrumentacion --------------------------------------------------
    def ruido(x, sigma):
        return x * (1.0 + rng.normal(0, sigma, n))

    reposicion_medida = ruido(reposicion_con_fuga, cfg.ruido_caudalimetro)
    purga_medida = ruido(purga, cfg.ruido_caudalimetro * 1.5)
    circ_medida = ruido(circ, 0.015)
    delta_t_medida = delta_t + rng.normal(0, 0.25, n)

    # --- Quimica del circulante ------------------------------------------
    alc_circ = AGUA_CRUDA.alcalinidad * ciclos
    tds_circ = AGUA_CRUDA.tds * ciclos
    ca_circ = AGUA_CRUDA.dureza_ca * ciclos
    t_circ = 32.0 + 0.45 * (t_amb - 28.0) + delta_t
    ph_circ = np.array([
        ph_sistema_abierto(a, tc) for a, tc in zip(alc_circ, t_circ)
    ])
    lsi_circ = np.array([
        lsi(p, tc, td, ca, a)
        for p, tc, td, ca, a in zip(ph_circ, t_circ, tds_circ, ca_circ, alc_circ)
    ])
    conductividad = tds_circ / 0.65 * (1.0 + rng.normal(0, 0.02, n))

    # --- Ensuciamiento: un INTEGRADOR, no un ruido ------------------------
    # La incrustacion no aparece de golpe: se acumula. La tasa instantanea de
    # deposicion depende del LSI, de la temperatura de piel y del tiempo de
    # retencion (ciclos altos = poca purga); el deposito es la integral de esa
    # tasa con una constante de tiempo larga, y se resetea con cada limpieza
    # quimica. Por eso el estado a 7 dias SI es predecible desde el presente:
    # lo que se predice es la inercia de un acumulador, no un evento aleatorio.
    tasa = (
        np.clip(lsi_circ - 1.6, 0, None) * 1.0
        + np.clip(t_circ - 37.0, 0, None) * 0.08
        + np.clip(ciclos - 3.6, 0, None) * 0.20
    ) * (1.0 + rng.normal(0, 0.10, n))

    TAU = 0.9985            # ~28 dias de memoria
    UMBRAL_LIMPIEZA = 260.0
    deposito = np.zeros(n)
    limpiando = 0
    for i in range(1, n):
        if limpiando > 0:
            deposito[i] = deposito[i - 1] * 0.72   # limpieza quimica en curso
            limpiando -= 1
        else:
            deposito[i] = TAU * deposito[i - 1] + max(tasa[i], 0.0)
            if deposito[i] > UMBRAL_LIMPIEZA:
                limpiando = int(rng.integers(36, 96))

    # Senal OBSERVABLE del ensuciamiento: el acercamiento de la torre al bulbo
    # humedo se degrada al ensuciarse el relleno. Es lo que ve el operador; el
    # deposito en si nunca se mide y no se entrega a los modelos.
    # No es una lectura limpia del deposito: el acercamiento depende tambien
    # de la carga termica, del bulbo humedo y del caudal de aire, y arrastra
    # ruido de instrumentacion. El modelo tiene que separar la senal del
    # ensuciamiento de esos factores, que es el problema real.
    aproximacion_c = (
        3.6
        + 0.010 * deposito
        + 1.10 * (carga - 0.92)
        + 0.05 * (t_amb - 28.0)
        - 1.30 * (hr - 0.74)
        + _ar1(n, sigma=0.35, phi=0.60, rng=rng)
    )

    futuro = pd.Series(deposito).shift(-168).to_numpy()
    # El umbral que define "riesgo alto" se calibra con el primer 70 % de la
    # serie -- el mismo tramo con el que se entrenan los modelos. Calibrarlo
    # sobre la serie completa filtraria el futuro dentro de las etiquetas.
    corte = int(len(futuro) * 0.70)
    umbral = np.nanquantile(futuro[:corte], 0.80)
    riesgo = (futuro > umbral).astype(int)

    idx = pd.date_range("2025-01-01", periods=n, freq="h")
    df = pd.DataFrame({
        "t_amb_c": t_amb,
        "humedad_rel": hr,
        "carga_produccion": carga,
        "caudal_circulacion_m3_h": circ_medida,
        "delta_t_c": delta_t_medida,
        "ciclos": ciclos,
        "purga_m3_h": purga_medida,
        "conductividad_us_cm": conductividad,
        "ph_circulante": ph_circ,
        "lsi_circulante": lsi_circ,
        "t_circulante_c": t_circ,
        "aproximacion_c": aproximacion_c,
        "reposicion_m3_h": reposicion_medida,
        # --- Variables no observables: solo para validar los modelos -----
        "_evaporacion_real_m3_h": evap,
        "_reposicion_sin_fuga_m3_h": reposicion_real,
        "_fuga_fraccion": fuga,
        "_deposito": deposito,
        "fuga_activa": (fuga > 0.02).astype(int),
        "riesgo_fouling_7d": riesgo,
    }, index=idx)
    df.index.name = "timestamp"
    return df.iloc[:-168]     # se descarta la cola sin etiqueta futura


def generar_calidad_oferentes(
    horas: int = 24 * 30 * 18, semilla: int = SEMILLA
) -> pd.DataFrame:
    """Deriva temporal de la calidad de cada corriente de rechazo vecina.

    Modelo AR(1) alrededor de la caracterizacion nominal, con choques
    ocasionales (cambio de campania, limpieza CIP, arranque de una unidad).
    Es la incertidumbre que obliga a re-optimizar la mezcla en continuo.
    """
    rng = np.random.default_rng(semilla + 7)
    idx = pd.date_range("2025-01-01", periods=horas, freq="h")
    marcos = []
    for of in CATALOGO:
        base_tds = of.calidad.tds
        base_dqo = of.calidad.dqo
        base_q = of.caudal_disponible_m3_h

        def deriva(media: float, sigma_rel: float, phi: float = 0.97) -> np.ndarray:
            return np.clip(
                media + _ar1(horas, media * sigma_rel, phi, rng),
                media * 0.35, media * 2.2,
            )

        tds = deriva(base_tds, 0.10)
        dqo = deriva(max(base_dqo, 1.0), 0.18)
        caudal = deriva(base_q, 0.07)
        # Choques: paradas del vecino (caudal a cero).
        for _ in range(max(1, horas // (24 * 90))):
            ini = int(rng.integers(0, max(horas - 72, 1)))
            dur = int(rng.integers(8, 72))
            caudal[ini:ini + dur] = 0.0
        marcos.append(pd.DataFrame({
            "oferente": of.codigo,
            "tds": tds, "dqo": dqo, "caudal_disponible_m3_h": caudal,
        }, index=idx))
    out = pd.concat(marcos)
    out.index.name = "timestamp"
    return out
