"""Optimizador de mezcla de aportes al circuito de enfriamiento.

Problema
--------
Decidir simultaneamente:
  * cuanto tomar de cada corriente de rechazo y con que tren de tratamiento,
  * cuanta agua cruda seguir captando,
  * cuanto acido sulfurico dosificar,
  * a que ciclos de concentracion operar la torre,
minimizando el costo total anual y garantizando que el agua circulante cumple
TODOS los limites de calidad, con un ahorro de agua cruda >= la meta del reto.

Metodo
------
El problema es no lineal (los ciclos multiplican a las concentraciones, y el
LSI depende del producto Ca x Alcalinidad y del pH de equilibrio). Se resuelve
como:

  1. Barrido exterior sobre los ciclos de concentracion N (discreto). Fijado N,
     la demanda de reposicion M = E*N/(N-1) es constante.
  2. Para cada N, un LP (HiGHS) sobre los caudales y la dosis de acido. Los
     limites por parametro son lineales porque la concentracion en el circuito
     es exactamente N veces la del aporte.
  3. Las dos restricciones bilineales (LSI via Ca*Alk, y el producto CaSO4) se
     tratan por linealizacion sucesiva alrededor del iterado anterior.
  4. La solucion del LP se VERIFICA con el modelo quimico completo y no lineal.
     Si falla, se aplica un factor de seguridad a los limites y se repite.

El indice de Larson-Skold no necesita linealizacion: es invariante de escala,
por lo que los ciclos se cancelan y queda lineal en los caudales.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

import numpy as np
from scipy.optimize import linprog

from ..config import Escenario
from ..domain import cooling
from ..domain.streams import (
    AGUA_CRUDA, CATALOGO, TRENES, Opcion, generar_opciones,
)
from ..domain.water_chem import (
    Calidad, PARAMETROS_CONSERVATIVOS, dosificar_acido, mezclar,
    ph_sistema_abierto, ph_saturacion,
)

# Conversion de kg/h de reactivo a unidades (mg/L)*(m3/h)
_KG_H_A_CARGA = 1_000.0
#: 1 kg de H2SO4 destruye 1.0196 kg de alcalinidad como CaCO3 y aporta 0.98 kg SO4
ALC_DESTRUIDA_POR_KG_H2SO4 = 1_019.6   # en unidades (mg/L)*(m3/h) por kg/h
SO4_APORTADO_POR_KG_H2SO4 = 980.0

#: Atenuacion biologica en el circuito (coherente con Calidad.escalar)
ATENUACION = {"dqo": 0.75, "n_amoniacal": 0.60}


@dataclass
class Solucion:
    factible: bool
    motivo: str = ""
    ciclos: float = 0.0
    balance: cooling.BalanceTorre | None = None
    caudal_cruda_m3_h: float = 0.0
    acido_kg_h: float = 0.0
    aportes: dict[str, float] = field(default_factory=dict)   # codigo -> m3/h
    opciones_usadas: list[Opcion] = field(default_factory=list)
    calidad_aporte: Calidad | None = None
    calidad_circulante: Calidad | None = None
    costo_total_usd_anio: float = 0.0
    costos: dict[str, float] = field(default_factory=dict)
    ahorro_m3_dia: float = 0.0
    ahorro_pct_planta: float = 0.0
    capex_total_usd: float = 0.0


def _limite_efectivo(esc: Escenario, param: str) -> float:
    lim = getattr(esc.limites, {
        "tds": "tds_mg_l", "dureza_ca": "dureza_ca_mg_l",
        "alcalinidad": "alcalinidad_mg_l", "cloruros": "cloruros_mg_l",
        "sulfatos": "sulfatos_mg_l", "silice": "silice_mg_l",
        "sst": "sst_mg_l", "dqo": "dqo_mg_l",
        "n_amoniacal": "n_amoniacal_mg_l", "fosfatos": "fosfatos_mg_l",
        "hierro": "hierro_mg_l",
    }[param])
    if param == "tds":
        lim = min(lim, esc.limites.conductividad_us_cm * 0.65)
    return lim


def _resolver_para_ciclos(
    esc: Escenario,
    opciones: Sequence[Opcion],
    n: float,
    tope_cruda_m3_h: float,
    piso_cruda_m3_h: float,
    t_operacion_c: float,
    seguridad: float,
    max_fraccion_reuso: float,
) -> tuple[np.ndarray | None, float]:
    """LP para ciclos fijos. Devuelve (vector solucion, costo horario).

    La demanda de reposicion `m` no es constante: depende de la temperatura de
    la mezcla, que a su vez depende de la solucion. Se resuelve por punto fijo
    dentro del mismo bucle que linealiza LSI y CaSO4.
    """
    k = len(opciones)
    nvar = 1 + k + 1                       # cruda, opciones, acido

    # --- Objetivo: costo horario ---------------------------------------
    c = np.zeros(nvar)
    c[0] = esc.planta.costo_agua_cruda_usd_m3
    for i, op in enumerate(opciones):
        c[1 + i] = op.costo_usd_m3
    c[-1] = esc.economia.costo_h2so4_usd_kg

    # --- Coeficientes de calidad por variable ----------------------------
    coef: dict[str, np.ndarray] = {}
    for p in PARAMETROS_CONSERVATIVOS:
        v = np.zeros(nvar)
        v[0] = getattr(AGUA_CRUDA, p)
        for i, op in enumerate(opciones):
            v[1 + i] = getattr(op.calidad_producto, p)
        if p == "alcalinidad":
            v[-1] = -ALC_DESTRUIDA_POR_KG_H2SO4
        elif p == "sulfatos":
            v[-1] = SO4_APORTADO_POR_KG_H2SO4
        elif p == "tds":
            v[-1] = SO4_APORTADO_POR_KG_H2SO4 - ALC_DESTRUIDA_POR_KG_H2SO4
        coef[p] = v

    temp_coef = np.zeros(nvar)
    temp_coef[0] = AGUA_CRUDA.t_c
    for i, op in enumerate(opciones):
        temp_coef[1 + i] = op.calidad_producto.t_c

    # --- Restricciones independientes de m -------------------------------
    fijas: list[np.ndarray] = []
    fijas_b: list[float] = []

    por_oferente: dict[str, list[int]] = {}
    for i, op in enumerate(opciones):
        por_oferente.setdefault(op.oferente.codigo, []).append(i)
    for cod, idxs in por_oferente.items():
        fila = np.zeros(nvar)
        for i in idxs:
            fila[1 + i] = 1.0 / opciones[i].tren.recuperacion
        of = opciones[idxs[0]].oferente
        fijas.append(fila)
        fijas_b.append(of.caudal_disponible_m3_h * of.disponibilidad)

    fila = np.zeros(nvar); fila[0] = 1.0            # meta de ahorro
    fijas.append(fila); fijas_b.append(tope_cruda_m3_h)

    # Larson-Skold: invariante de escala -> exacto y sin dependencia de m.
    ls = esc.limites.larson_skold_max * seguridad
    fila = np.zeros(nvar)
    def _ls_coef(q: Calidad) -> float:
        return q.cloruros / 35.45 + q.sulfatos / 48.03 - ls * q.alcalinidad / 50.0
    fila[0] = _ls_coef(AGUA_CRUDA)
    for i, op in enumerate(opciones):
        fila[1 + i] = _ls_coef(op.calidad_producto)
    fila[-1] = (SO4_APORTADO_POR_KG_H2SO4 / 48.03
                + ls * ALC_DESTRUIDA_POR_KG_H2SO4 / 50.0)
    fijas.append(fila); fijas_b.append(0.0)

    a_fijas = np.vstack(fijas)
    b_fijas = np.array(fijas_b, dtype=float)

    # --- Punto de partida: solo agua cruda -------------------------------
    try:
        m = cooling.balance(esc.torre, n, AGUA_CRUDA.t_c).reposicion_m3_h
    except ValueError:
        return None, float("inf")
    x = np.zeros(nvar); x[0] = m
    mejor: np.ndarray | None = None
    mejor_costo = float("inf")

    for _ in range(14):
        caudal_total = float(x[0] + x[1:1 + k].sum())
        t_mezcla = (
            float(temp_coef @ x) / caudal_total if caudal_total > 1e-9
            else AGUA_CRUDA.t_c
        )
        try:
            m = cooling.balance(esc.torre, n, t_mezcla).reposicion_m3_h
        except ValueError:
            return None, float("inf")

        filas = [a_fijas]
        cotas = [b_fijas]

        extra_f: list[np.ndarray] = []
        extra_b: list[float] = []

        fila = np.zeros(nvar); fila[1:1 + k] = 1.0     # tope de reuso
        extra_f.append(fila); extra_b.append(max_fraccion_reuso * m)

        for p in PARAMETROS_CONSERVATIVOS:
            lim = _limite_efectivo(esc, p) * seguridad
            atenua = ATENUACION.get(p, 1.0)
            extra_f.append(coef[p])
            extra_b.append(lim * m / (n * atenua))

        # Bilineales: LSI (Ca*Alk) y producto CaSO4, por linealizacion sucesiva.
        ca0 = float(coef["dureza_ca"] @ x)
        alk0 = float(coef["alcalinidad"] @ x)
        so40 = float(coef["sulfatos"] @ x)
        tds0 = float(coef["tds"] @ x)

        alk_circ = max(alk0 / m * n, 1.0)
        tds_circ = max(tds0 / m * n, 10.0)
        ph_circ = ph_sistema_abierto(alk_circ, t_operacion_c)
        t_kelvin = t_operacion_c + 273.15
        a_t = (np.log10(tds_circ) - 1.0) / 10.0
        b_t = -13.12 * np.log10(t_kelvin) + 34.55
        prod_max = 10.0 ** (
            esc.lsi_max_efectivo + (9.3 + a_t + b_t) + 0.4 - ph_circ
        )
        rhs_lsi = prod_max * (m ** 2) / (n ** 2) * seguridad
        rhs_caso4 = (
            esc.limites.producto_caso4_max * (m ** 2) / (n ** 2) * seguridad
        )
        for coef_a, coef_b, v_a, v_b, rhs in (
            (coef["dureza_ca"], coef["alcalinidad"], ca0, alk0, rhs_lsi),
            (coef["dureza_ca"], coef["sulfatos"], ca0, so40, rhs_caso4),
        ):
            extra_f.append(v_a * coef_b + v_b * coef_a)
            extra_b.append(rhs + v_a * v_b)

        a_ub = np.vstack(filas + [np.vstack(extra_f)])
        b_ub = np.concatenate(cotas + [np.array(extra_b, dtype=float)])

        a_eq = np.zeros((1, nvar))
        a_eq[0, 0] = 1.0
        a_eq[0, 1:1 + k] = 1.0

        cotas_var: list[tuple[float, float | None]] = [(0.0, None)] * nvar
        if piso_cruda_m3_h > m:
            return None, float("inf")
        cotas_var[0] = (max(piso_cruda_m3_h, 0.0), m)
        for i, op in enumerate(opciones):
            cotas_var[1 + i] = (0.0, op.caudal_max_m3_h)

        res = linprog(c, A_ub=a_ub, b_ub=b_ub, A_eq=a_eq, b_eq=np.array([m]),
                      bounds=cotas_var, method="highs")
        if not res.success:
            return None, float("inf")

        x_nuevo = res.x
        mejor, mejor_costo = x_nuevo, float(res.fun)
        if np.allclose(x_nuevo, x, rtol=1e-6, atol=1e-9):
            break
        x = 0.5 * x + 0.5 * x_nuevo      # amortiguacion

    return mejor, mejor_costo


def _evaluar(
    esc: Escenario, opciones: Sequence[Opcion], x: np.ndarray, n: float,
    t_operacion_c: float,
) -> tuple[Calidad, Calidad, float]:
    """Reconstruye la quimica real (no linealizada) de una solucion."""
    corrientes = [AGUA_CRUDA] + [op.calidad_producto for op in opciones]
    caudales = [float(x[0])] + [float(v) for v in x[1:1 + len(opciones)]]
    aporte = mezclar(corrientes, caudales)
    bal = cooling.balance(esc.torre, n, aporte.t_c)
    acido_mg_l = float(x[-1]) * 1e6 / (bal.reposicion_m3_h * 1000.0)
    aporte = dosificar_acido(aporte, acido_mg_l)
    circulante = aporte.escalar(n, t_c=t_operacion_c)
    return aporte, circulante, acido_mg_l


def optimizar(
    esc: Escenario | None = None,
    meta_reduccion: float | None = None,
    ahorro_maximo: float | None = None,
    max_fraccion_reuso: float = 0.85,
    t_operacion_c: float = 38.0,
    paso_ciclos: float = 0.1,
    oferentes=CATALOGO,
    trenes=TRENES,
) -> Solucion:
    """Resuelve el problema completo y devuelve la mejor configuracion.

    `meta_reduccion` fija el ahorro MINIMO exigido (la meta del reto).
    `ahorro_maximo` lo acota por arriba: sirve para trazar la curva de costo
    frente a nivel de reuso, porque el optimo economico sin tope va mucho mas
    alla del 10% (el agua reusada es mas barata que la captada).
    """
    esc = esc or Escenario()
    meta = esc.planta.meta_reduccion if meta_reduccion is None else meta_reduccion

    opciones = generar_opciones(
        oferentes, trenes, esc.economia.crf, esc.planta.horas_anio,
        esc.economia.capex_conduccion_usd_m3h_km,
        esc.economia.energia_bombeo_kwh_m3_km,
        esc.economia.costo_energia_usd_kwh,
    )

    bal_base = cooling.balance(esc.torre, esc.torre.ciclos_base, AGUA_CRUDA.t_c)
    consumo_h = esc.planta.consumo_total_m3_dia / 24.0
    tope_cruda = bal_base.reposicion_m3_h - meta * consumo_h
    piso_cruda = (
        bal_base.reposicion_m3_h - ahorro_maximo * consumo_h
        if ahorro_maximo is not None else 0.0
    )
    if tope_cruda < 0:
        return Solucion(
            factible=False,
            motivo=(
                f"La meta de {meta:.0%} exige ahorrar {meta * consumo_h:.1f} m3/h, "
                f"mas que toda la reposicion actual del circuito "
                f"({bal_base.reposicion_m3_h:.1f} m3/h). La meta no puede "
                f"cubrirse solo con el sistema de enfriamiento."
            ),
        )

    mejor: Solucion | None = None
    n = esc.torre.ciclos_min
    while n <= esc.torre.ciclos_max + 1e-9:
        for seguridad in (1.0, 0.97, 0.93, 0.88):
            x, costo_h = _resolver_para_ciclos(
                esc, opciones, n, tope_cruda, piso_cruda, t_operacion_c,
                seguridad, max_fraccion_reuso,
            )
            if x is None:
                continue
            try:
                aporte, circulante, _ = _evaluar(esc, opciones, x, n, t_operacion_c)
            except ValueError:
                continue
            fuera = cooling.violaciones(
                circulante, esc.limites, esc.lsi_max_efectivo
            )
            if fuera:
                continue   # el factor de seguridad siguiente aprieta los limites
            sol = _construir(esc, opciones, x, n, t_operacion_c, bal_base)
            if mejor is None or sol.costo_total_usd_anio < mejor.costo_total_usd_anio:
                mejor = sol
            break
        n += paso_ciclos

    if mejor is None:
        return Solucion(
            factible=False,
            motivo=(
                "No existe combinacion de aportes, tratamiento y ciclos que "
                "alcance la meta cumpliendo los limites de calidad. Relaje la "
                "meta, amplie el catalogo de oferentes o habilite osmosis "
                "inversa sobre las corrientes mas salinas."
            ),
        )
    return mejor


def _construir(
    esc: Escenario, opciones: Sequence[Opcion], x: np.ndarray, n: float,
    t_operacion_c: float, bal_base: cooling.BalanceTorre,
) -> Solucion:
    aporte, circulante, acido_mg_l = _evaluar(
        esc, opciones, x, n, t_operacion_c
    )
    bal = cooling.balance(esc.torre, n, aporte.t_c)
    horas = esc.planta.horas_anio

    aportes: dict[str, float] = {}
    usadas: list[Opcion] = []
    costo_reuso = 0.0
    capex = 0.0
    for i, op in enumerate(opciones):
        q = float(x[1 + i])
        if q > 1e-6:
            aportes[op.codigo] = q
            usadas.append(op)
            costo_reuso += q * op.costo_usd_m3 * horas
            capex += (
                q * (op.tren.capex_usd_m3h_producto
                     + esc.economia.capex_conduccion_usd_m3h_km
                     * op.oferente.distancia_km / op.tren.recuperacion)
            )

    cruda = float(x[0])
    acido = float(x[-1])
    costos = {
        "agua_cruda": cruda * esc.planta.costo_agua_cruda_usd_m3 * horas,
        "reuso": costo_reuso,
        "acido": acido * esc.economia.costo_h2so4_usd_kg * horas,
        "antiincrustante": (
            bal.reposicion_m3_h
            * esc.economia.costo_antiincrustante_usd_m3_makeup * horas
            if esc.usar_antiincrustante else 0.0
        ),
        "vertimiento_purga": (
            bal.purga_m3_h * esc.planta.costo_vertimiento_usd_m3 * horas
        ),
    }
    ahorro_h = bal_base.reposicion_m3_h - cruda

    return Solucion(
        factible=True,
        ciclos=n,
        balance=bal,
        caudal_cruda_m3_h=cruda,
        acido_kg_h=acido,
        aportes=aportes,
        opciones_usadas=usadas,
        calidad_aporte=aporte,
        calidad_circulante=circulante,
        costo_total_usd_anio=sum(costos.values()),
        costos=costos,
        ahorro_m3_dia=ahorro_h * 24.0,
        ahorro_pct_planta=ahorro_h * 24.0 / esc.planta.consumo_total_m3_dia,
        capex_total_usd=capex,
    )


def linea_base(esc: Escenario | None = None) -> Solucion:
    """Operacion actual: 100% agua cruda a los ciclos de base."""
    esc = esc or Escenario()
    bal = cooling.balance(esc.torre, esc.torre.ciclos_base)
    horas = esc.planta.horas_anio
    circ = AGUA_CRUDA.escalar(esc.torre.ciclos_base, t_c=38.0)
    costos = {
        "agua_cruda": bal.reposicion_m3_h * esc.planta.costo_agua_cruda_usd_m3 * horas,
        "reuso": 0.0,
        "acido": 0.0,
        "antiincrustante": (
            bal.reposicion_m3_h
            * esc.economia.costo_antiincrustante_usd_m3_makeup * horas
        ),
        "vertimiento_purga": (
            bal.purga_m3_h * esc.planta.costo_vertimiento_usd_m3 * horas
        ),
    }
    return Solucion(
        factible=True, ciclos=esc.torre.ciclos_base, balance=bal,
        caudal_cruda_m3_h=bal.reposicion_m3_h,
        calidad_aporte=AGUA_CRUDA, calidad_circulante=circ,
        costo_total_usd_anio=sum(costos.values()), costos=costos,
    )
