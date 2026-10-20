"""Simulador de la torre: que le pasa si entra esta agua.

El optimizador responde «que debo mezclar». El simulador responde la
pregunta de quien negocia con un vecino: «si esta empresa me da 20 m3/h con
este tratamiento, ¿que le pasa a mi torre?». Los caudales los fija quien usa
el simulador; el motor calcula, con la misma quimica que el optimizador, a
cuantos ciclos se puede operar, que limite impide subir mas, cuanta agua
cruda se deja de captar y cuanto cuesta.

No hay programa lineal: solo balance y quimica. Es rapido a proposito, para
que la pantalla responda mientras se mueve un deslizador. `sugerir` es la
excepcion: llama al optimizador para proponer la mezcla de partida.

Un efecto que el simulador ensena y conviene entender: si entra mas agua de
vecinos de la que la torre necesita, la unica forma de cerrar el balance es
purgar mas, es decir, bajar los ciclos. Mas agua no siempre es mas ahorro.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from ..config import Escenario
from ..domain import cooling
from ..domain.streams import TRENES_POR_CODIGO, Oferente, Tren, admisible, desglose_costo
from ..domain.water_chem import Calidad, dosificar_acido, mezclar
from ..optim.blend import Solucion, agua_cruda, linea_base, optimizar
from .fuentes import Fuente, oferente

#: Temperatura del agua en el circuito, la misma que usa el optimizador.
T_OPERACION_C = 38.0
#: Por encima, el relleno de PVC y las lineas de PEAD no aguantan.
T_MAX_APORTE_C = 55.0
PASO_CICLOS = 0.1
#: Caudal minimo de una toma sugerida, m3/h.
TOMA_MINIMA_M3_H = 0.5

#: parametro -> (etiqueta, unidad). Una sola tabla para backend y pantalla.
ETIQUETAS: dict[str, tuple[str, str]] = {
    "ph": ("pH", ""),
    "t_c": ("Temperatura", "°C"),
    "tds": ("Solidos disueltos", "mg/L"),
    "dureza_ca": ("Dureza calcica", "mg/L CaCO₃"),
    "alcalinidad": ("Alcalinidad", "mg/L CaCO₃"),
    "cloruros": ("Cloruros", "mg/L"),
    "sulfatos": ("Sulfatos", "mg/L"),
    "silice": ("Silice", "mg/L SiO₂"),
    "sst": ("Solidos suspendidos", "mg/L"),
    "dqo": ("DQO", "mg/L"),
    "n_amoniacal": ("Nitrogeno amoniacal", "mg/L"),
    "fosfatos": ("Fosfatos", "mg/L PO₄"),
    "hierro": ("Hierro", "mg/L"),
    "conductividad": ("Conductividad", "µS/cm"),
    "lsi": ("Indice de Langelier", ""),
    "larson_skold": ("Indice de Larson-Skold", ""),
    "producto_caso4": ("Producto Ca × SO₄", ""),
    "exceso_aporte": ("Exceso de aporte", "m³/h"),
    "tope_ciclos": ("Tope de ciclos", ""),
}


# --------------------------------------------------------------------------
# Entradas
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Toma:
    """Agua de una fuente que entra a la torre, ya tratada."""

    fuente: Fuente
    caudal_m3_h: float          # producto entregado a la torre
    tren: str = "T1"


@dataclass(frozen=True)
class Revision:
    """Lo que se comprueba de una toma antes de creerse su agua."""

    oferente: Oferente
    producto: Calidad
    admisible: bool
    motivo: str
    #: Agua del vecino que hace falta para entregar el caudal pedido.
    alimentacion_m3_h: float
    #: Lo mas que el vecino puede entregar con este tren.
    maximo_m3_h: float
    excede: bool


def revisar(fuente: Fuente, tren: Tren, caudal_m3_h: float) -> Revision:
    """Si el tren resuelve la corriente y si el vecino tiene esa agua.

    La usan el simulador estacionario y el dinamico: los dos rechazan lo mismo.
    """
    of = oferente(fuente)
    producto = tren.aplicar(of.calidad)
    ok, motivo = admisible(of, tren)
    if ok and producto.t_c > T_MAX_APORTE_C:
        ok, motivo = False, (
            f"sale a {producto.t_c:.0f} °C; necesita un tren con enfriamiento"
        )
    rec = tren.recuperacion
    alimentacion = caudal_m3_h / rec if rec else float("inf")
    return Revision(
        oferente=of, producto=producto, admisible=ok, motivo=motivo,
        alimentacion_m3_h=alimentacion,
        maximo_m3_h=fuente.caudal_disponible_m3_h * rec,
        excede=alimentacion > fuente.caudal_disponible_m3_h * (1 + 1e-6),
    )


@dataclass(frozen=True)
class Decision:
    tomas: tuple[Toma, ...] = ()
    #: H2SO4 dosificado sobre la reposicion, mg/L.
    acido_mg_l: float = 0.0
    #: Ciclos fijados a mano. None: los maximos que admite la quimica.
    ciclos: float | None = None


# --------------------------------------------------------------------------
# Estado de la torre a unos ciclos dados
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class _Estado:
    ciclos: float
    balance: cooling.BalanceTorre
    cruda_m3_h: float
    exceso_m3_h: float
    aporte: Calidad
    circulante: Calidad
    fuera: dict[str, tuple[float, float]]

    @property
    def factible(self) -> bool:
        return not self.fuera


def _estado(
    esc: Escenario, cruda: Calidad, productos: Sequence[tuple[Calidad, float]],
    acido_mg_l: float, n: float,
) -> _Estado | None:
    """Balance y quimica a N ciclos con los caudales de vecinos fijos.

    El agua cruda cubre lo que falte hasta la reposicion. La reposicion
    depende de la temperatura de la mezcla y la mezcla de la reposicion: se
    resuelve por punto fijo, que converge en dos o tres pasos.
    """
    q_vecinos = sum(q for _, q in productos)
    corrientes = [cruda] + [c for c, _ in productos]
    t = cruda.t_c
    try:
        for _ in range(5):
            bal = cooling.balance(esc.torre, n, t)
            cruda_q = max(bal.reposicion_m3_h - q_vecinos, 0.0)
            mezcla = mezclar(corrientes, [cruda_q] + [q for _, q in productos])
            if abs(mezcla.t_c - t) < 0.01:
                break
            t = mezcla.t_c
        bal = cooling.balance(esc.torre, n, mezcla.t_c)
    except ValueError:
        return None
    cruda_q = bal.reposicion_m3_h - q_vecinos
    exceso = max(-cruda_q, 0.0)
    if exceso > 0:
        mezcla = mezclar(corrientes, [0.0] + [q for _, q in productos])
    aporte = dosificar_acido(mezcla, acido_mg_l)
    circulante = aporte.escalar(n, t_c=T_OPERACION_C)
    fuera = cooling.violaciones(circulante, esc.limites, esc.lsi_max_efectivo)
    if exceso > 1e-6:
        fuera = {**fuera, "exceso_aporte": (q_vecinos, bal.reposicion_m3_h)}
    return _Estado(n, bal, max(cruda_q, 0.0), exceso, aporte, circulante, fuera)


def _peor(fuera: dict[str, tuple[float, float]]) -> str:
    return max(fuera, key=lambda k: fuera[k][0] / max(abs(fuera[k][1]), 1e-9))


def _ciclos_maximos(
    esc: Escenario, cruda: Calidad, productos: Sequence[tuple[Calidad, float]],
    acido_mg_l: float,
) -> tuple[_Estado | None, str | None]:
    """Los ciclos mas altos que admite la quimica y lo que impide subir mas.

    Se recorre de arriba abajo y se para en el primer punto factible: la
    region factible no tiene por que ser un intervalo (una corriente puede
    mejorar el LSI al diluir y empeorarlo despues), y lo que interesa es el
    maximo. Luego se afina entre ese punto y el siguiente.
    """
    torre = esc.torre
    pasos = int(round((torre.ciclos_max - torre.ciclos_min) / PASO_CICLOS))
    rejilla = [torre.ciclos_min + i * PASO_CICLOS for i in range(pasos + 1)]
    rejilla[-1] = torre.ciclos_max

    encima: _Estado | None = None
    for i in range(len(rejilla) - 1, -1, -1):
        e = _estado(esc, cruda, productos, acido_mg_l, rejilla[i])
        if e is not None and e.factible:
            if i == len(rejilla) - 1:
                return e, "tope_ciclos"
            lo, hi = e, encima
            n_lo, n_hi = rejilla[i], rejilla[i + 1]
            for _ in range(12):
                mid = 0.5 * (n_lo + n_hi)
                em = _estado(esc, cruda, productos, acido_mg_l, mid)
                if em is not None and em.factible:
                    lo, n_lo = em, mid
                else:
                    hi, n_hi = em, mid
            return lo, (_peor(hi.fuera) if hi is not None else None)
        encima = e

    # Ni a los ciclos minimos: lo que falla ahi es lo que hay que resolver.
    e = _estado(esc, cruda, productos, acido_mg_l, torre.ciclos_min)
    return None, (_peor(e.fuera) if e is not None and e.fuera else None)


def texto_limitante(clave: str | None, esc: Escenario) -> str:
    if clave is None:
        return ""
    if clave == "tope_ciclos":
        return (f"Se llega al tope operativo de {esc.torre.ciclos_max:g} ciclos: la quimica "
                "permitiria subir mas.")
    if clave == "exceso_aporte":
        return ("Entra mas agua de vecinos de la que la torre necesita: para cerrar el "
                "balance hay que purgar mas, es decir, bajar los ciclos. Reduce el caudal.")
    etiqueta = ETIQUETAS.get(clave, (clave, ""))[0]
    return f"{etiqueta} del agua circulante llega a su limite."


# --------------------------------------------------------------------------
# Resultado
# --------------------------------------------------------------------------

@dataclass
class Simulacion:
    factible: bool
    motivo: str
    ciclos: float
    ciclos_fijados: bool
    limitante: str | None
    balance: cooling.BalanceTorre | None
    agua_cruda_m3_h: float
    reuso_m3_h: float
    acido_mg_l: float
    acido_kg_h: float
    aporte: Calidad | None
    circulante: Calidad | None
    margenes: list[tuple[str, float, float]]
    tomas: list[dict[str, Any]]
    base: Solucion
    solo_cruda: dict[str, Any]
    ahorro_m3_dia: float
    ahorro_pct: float
    meta: float
    costos: dict[str, float]
    capex_usd: float
    #: Lo mas que la torre puede llegar a reponer (a los ciclos minimos). Por
    #: encima, el agua de vecinos sobra: es el tope util de un deslizador.
    reposicion_maxima_m3_h: float = 0.0
    limitante_texto: str = ""
    avisos: list[str] = field(default_factory=list)

    @property
    def cumple_meta(self) -> bool:
        return self.factible and self.ahorro_pct >= self.meta - 1e-9

    @property
    def costo_total_usd_anio(self) -> float:
        return sum(self.costos.values())

    @property
    def ahorro_usd_anio(self) -> float:
        return self.base.costo_total_usd_anio - self.costo_total_usd_anio

    def as_dict(self) -> dict[str, Any]:
        ahorro_usd = self.ahorro_usd_anio
        return {
            "factible": self.factible,
            "motivo": self.motivo,
            "cumple_meta": self.cumple_meta,
            "meta": self.meta,
            "ciclos": round(self.ciclos, 2),
            "ciclos_fijados": self.ciclos_fijados,
            "limitante": self.limitante,
            "limitante_texto": self.limitante_texto,
            "balance": self.balance.as_dict() if self.balance else None,
            "agua_cruda_m3_h": round(self.agua_cruda_m3_h, 2),
            "reuso_m3_h": round(self.reuso_m3_h, 2),
            "reposicion_maxima_m3_h": round(self.reposicion_maxima_m3_h, 2),
            "acido_mg_l": round(self.acido_mg_l, 1),
            "acido_kg_h": round(self.acido_kg_h, 2),
            "aporte": self.aporte.as_dict() if self.aporte else None,
            "circulante": self.circulante.as_dict() if self.circulante else None,
            "margenes": [
                {"parametro": p, "etiqueta": ETIQUETAS.get(p, (p, ""))[0],
                 "unidad": ETIQUETAS.get(p, (p, ""))[1],
                 "valor": round(v, 3), "limite": round(lim, 3),
                 "uso": round(v / lim, 3) if lim else None, "ok": v <= lim}
                for p, v, lim in self.margenes
            ],
            "tomas": self.tomas,
            "base": {
                "ciclos": round(self.base.ciclos, 2),
                "reposicion_m3_h": round(self.base.caudal_cruda_m3_h, 2),
                "purga_m3_h": round(self.base.balance.purga_m3_h, 2) if self.base.balance else None,
                "costos": {k: round(v, 0) for k, v in self.base.costos.items()},
                "costo_total_usd_anio": round(self.base.costo_total_usd_anio, 0),
            },
            "solo_cruda": self.solo_cruda,
            "ahorro_m3_dia": round(self.ahorro_m3_dia, 1),
            "ahorro_pct": round(self.ahorro_pct, 4),
            "costos": {k: round(v, 0) for k, v in self.costos.items()},
            "costo_total_usd_anio": round(self.costo_total_usd_anio, 0),
            "ahorro_usd_anio": round(ahorro_usd, 0),
            "capex_usd": round(self.capex_usd, 0),
            "payback_anios": (
                round(self.capex_usd / ahorro_usd, 2) if ahorro_usd > 0 and self.capex_usd > 0
                else None
            ),
            "avisos": self.avisos,
        }


# --------------------------------------------------------------------------
# Simular
# --------------------------------------------------------------------------

def _evaluar_tomas(
    esc: Escenario, tomas: Sequence[Toma],
) -> tuple[list[tuple[Calidad, float]], list[dict[str, Any]], float, float, list[str]]:
    """Calidad de producto, coste y comprobaciones de cada toma."""
    eco = esc.economia
    horas = esc.planta.horas_anio
    productos: list[tuple[Calidad, float]] = []
    filas: list[dict[str, Any]] = []
    costo_reuso = 0.0
    capex = 0.0
    problemas: list[str] = []
    for toma in tomas:
        tren = TRENES_POR_CODIGO.get(toma.tren)
        if tren is None:
            raise ValueError(f"Tren de tratamiento desconocido: {toma.tren}")
        if toma.caudal_m3_h < 0:
            raise ValueError("El caudal de una toma no puede ser negativo.")
        q = toma.caudal_m3_h
        rev = revisar(toma.fuente, tren, q)
        of, producto, ok, motivo = rev.oferente, rev.producto, rev.admisible, rev.motivo
        rec = tren.recuperacion
        alimentacion, excede = rev.alimentacion_m3_h, rev.excede
        desglose = desglose_costo(
            of, tren, eco.crf, horas, eco.capex_conduccion_usd_m3h_km,
            eco.energia_bombeo_kwh_m3_km, eco.costo_energia_usd_kwh,
        )
        costo_m3 = sum(desglose.values())
        capex_toma = q * (
            tren.capex_usd_m3h_producto
            + eco.capex_conduccion_usd_m3h_km * toma.fuente.distancia_km / rec
        )
        if q > 0:
            productos.append((producto, q))
            costo_reuso += q * costo_m3 * horas
            capex += capex_toma
            if not ok:
                problemas.append(f"{toma.fuente.nombre}: {tren.nombre} no basta ({motivo}).")
            if excede:
                problemas.append(
                    f"{toma.fuente.nombre}: para entregar {q:.1f} m³/h tratados hacen falta "
                    f"{alimentacion:.1f} m³/h y solo tiene {toma.fuente.caudal_disponible_m3_h:.1f}."
                )
        filas.append({
            "fuente_id": toma.fuente.id, "nombre": toma.fuente.nombre,
            "tren": tren.codigo, "tren_nombre": tren.nombre,
            "caudal_m3_h": round(q, 2),
            "alimentacion_m3_h": round(alimentacion, 2),
            "disponible_m3_h": round(toma.fuente.caudal_disponible_m3_h, 2),
            "maximo_producto_m3_h": round(toma.fuente.caudal_disponible_m3_h * rec, 2),
            "excede": excede, "admisible": ok, "motivo": motivo,
            "costo_usd_m3": round(costo_m3, 4),
            "capex_usd": round(capex_toma, 0),
            "calidad_producto": producto.as_dict(),
        })
    return productos, filas, costo_reuso, capex, problemas


def simular(
    esc: Escenario, decision: Decision | None = None,
) -> Simulacion:
    decision = decision or Decision()
    if decision.acido_mg_l < 0:
        raise ValueError("La dosis de acido no puede ser negativa.")
    cruda = agua_cruda(esc)
    base = linea_base(esc)
    consumo_h = esc.planta.consumo_total_m3_dia / 24.0
    meta = esc.planta.meta_reduccion

    productos, filas, costo_reuso, capex, problemas = _evaluar_tomas(esc, decision.tomas)
    avisos = list(problemas)

    # La palanca sin vecinos: los ciclos que admite el agua propia con este
    # acido. Es el ahorro que no depende de negociar con nadie.
    propio, lim_propio = _ciclos_maximos(esc, cruda, [], decision.acido_mg_l)
    solo_cruda = {
        "ciclos": round(propio.ciclos, 2) if propio else None,
        "ahorro_pct": (
            round((base.caudal_cruda_m3_h - propio.cruda_m3_h) / consumo_h, 4)
            if propio else None
        ),
        "limitante": lim_propio,
        "limitante_texto": texto_limitante(lim_propio, esc),
    }

    if decision.ciclos is not None:
        if not esc.torre.ciclos_min <= decision.ciclos <= max(esc.torre.ciclos_max, 15.0):
            raise ValueError(
                f"Los ciclos deben estar entre {esc.torre.ciclos_min:g} y el tope."
            )
        estado = _estado(esc, cruda, productos, decision.acido_mg_l, decision.ciclos)
        if estado is None:
            raise ValueError("El aporte esta tan caliente que el balance no cierra.")
        limitante = _peor(estado.fuera) if estado.fuera else None
        if estado.fuera:
            avisos.append("A estos ciclos el agua circulante se sale de limites.")
    else:
        estado, limitante = _ciclos_maximos(esc, cruda, productos, decision.acido_mg_l)

    if estado is None:
        # Ni a los ciclos minimos: se informa del estado ahi, para ver por que.
        estado = _estado(esc, cruda, productos, decision.acido_mg_l, esc.torre.ciclos_min)
        motivo = (
            "Ni a los ciclos minimos cumple el agua circulante: "
            + texto_limitante(limitante, esc)
        )
        factible = False
    else:
        factible = estado.factible
        motivo = "" if factible else texto_limitante(limitante, esc)
    if problemas:
        factible = False
        motivo = motivo or problemas[0]

    horas = esc.planta.horas_anio
    eco = esc.economia
    bal = estado.balance if estado else None
    cruda_q = estado.cruda_m3_h if estado else 0.0
    reposicion = bal.reposicion_m3_h if bal else 0.0
    acido_kg_h = decision.acido_mg_l * reposicion / 1000.0
    costos = {
        "agua_cruda": cruda_q * esc.planta.costo_agua_cruda_usd_m3 * horas,
        "reuso": costo_reuso,
        "acido": acido_kg_h * eco.costo_h2so4_usd_kg * horas,
        "antiincrustante": (
            reposicion * eco.costo_antiincrustante_usd_m3_makeup * horas
            if esc.usar_antiincrustante else 0.0
        ),
        "vertimiento_purga": (
            (bal.purga_m3_h if bal else 0.0) * esc.planta.costo_vertimiento_usd_m3 * horas
        ),
    }
    ahorro_h = base.caudal_cruda_m3_h - cruda_q
    return Simulacion(
        factible=factible,
        motivo=motivo,
        ciclos=estado.ciclos if estado else 0.0,
        ciclos_fijados=decision.ciclos is not None,
        limitante=limitante,
        limitante_texto=texto_limitante(limitante, esc),
        balance=bal,
        agua_cruda_m3_h=cruda_q,
        reuso_m3_h=sum(q for _, q in productos),
        acido_mg_l=decision.acido_mg_l,
        acido_kg_h=acido_kg_h,
        aporte=estado.aporte if estado else None,
        circulante=estado.circulante if estado else None,
        margenes=(
            cooling.margenes(estado.circulante, esc.limites, esc.lsi_max_efectivo)
            if estado else []
        ),
        tomas=filas,
        base=base,
        solo_cruda=solo_cruda,
        ahorro_m3_dia=ahorro_h * 24.0,
        ahorro_pct=ahorro_h / consumo_h,
        meta=meta,
        costos=costos,
        capex_usd=capex,
        reposicion_maxima_m3_h=cooling.balance(
            esc.torre, esc.torre.ciclos_min, cruda.t_c
        ).reposicion_m3_h,
        avisos=avisos,
    )


# --------------------------------------------------------------------------
# Sugerir la mezcla de partida
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Sugerencia:
    decision: Decision | None
    #: "meta": la mas barata que cumple la meta. "economico": la meta no se
    #: alcanza con estas fuentes y se propone la mas barata posible.
    #: "inviable": ninguna combinacion cumple los limites.
    modo: str
    motivo: str = ""


def sugerir(
    esc: Escenario, fuentes: Sequence[Fuente], max_fraccion_reuso: float = 0.85,
) -> Sugerencia:
    """La mezcla que propone el optimizador con estas fuentes.

    Sin fuentes tambien responde: el optimizador decide entonces solo acido
    y ciclos, que es lo que se puede hacer sin depender de ningun vecino.
    """
    codigos = {f"F{i}": f for i, f in enumerate(fuentes, start=1)}
    oferentes = tuple(oferente(f, codigo=c) for c, f in codigos.items())

    sol = optimizar(esc, oferentes=oferentes, max_fraccion_reuso=max_fraccion_reuso)
    modo, motivo = "meta", ""
    if not sol.factible:
        motivo = sol.motivo
        sol = optimizar(
            esc, meta_reduccion=0.0, oferentes=oferentes,
            max_fraccion_reuso=max_fraccion_reuso,
        )
        modo = "economico"
    if not sol.factible:
        return Sugerencia(None, "inviable", sol.motivo)

    # Una fuente, una toma: si el optimizador repartiera una fuente entre dos
    # trenes, se queda el que mas caudal lleva con el total.
    por_fuente: dict[str, tuple[str, float, float]] = {}
    for op in sol.opciones_usadas:
        q = sol.aportes[op.codigo]
        cod = op.oferente.codigo
        tren, q_tren, total = por_fuente.get(cod, (op.tren.codigo, 0.0, 0.0))
        if q > q_tren:
            tren, q_tren = op.tren.codigo, q
        por_fuente[cod] = (tren, q_tren, total + q)
    # Por debajo de TOMA_MINIMA no se tiende una tuberia: el optimizador las
    # deja por redondeo y en pantalla solo confunden.
    tomas = tuple(
        Toma(codigos[cod], round(total, 2), tren)
        for cod, (tren, _, total) in por_fuente.items()
        if total >= TOMA_MINIMA_M3_H
    )
    reposicion = sol.balance.reposicion_m3_h if sol.balance else 0.0
    acido = sol.acido_kg_h * 1000.0 / reposicion if reposicion else 0.0
    return Sugerencia(Decision(tomas, round(acido, 1)), modo, motivo)
