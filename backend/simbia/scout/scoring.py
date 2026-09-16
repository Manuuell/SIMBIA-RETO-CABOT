"""Puntaje de simbiosis: a quien hay que ir a ver primero.

El optimizador completo resuelve la mezcla optima, pero necesita un catalogo
cerrado y resuelve un LP por cada nivel de ciclos. En prospeccion el problema
es otro: hay veinte empresas alrededor, el equipo comercial puede visitar tres
este mes, y hay que decidir cuales.

Este modulo responde a eso con un puntaje de 0 a 100 por prospecto. No
sustituye al optimizador: lo precede.

LA PREGUNTA CORRECTA
--------------------

La tentacion es evaluar cada corriente como si fuera el unico aporte de la
torre. Es un error: ninguna corriente de rechazo se usa asi, siempre va
mezclada con agua cruda, y evaluarla al 100 % descarta corrientes
perfectamente utiles al 30 %. La primera version de este modulo hacia eso y
declaraba no viables diez de dieciocho prospectos, incluida una PTAR de
salinidad baja: el indicador estaba saturado y no discriminaba nada.

La pregunta util es otra: **cuanta agua cruda puede desplazar esta corriente
sin bajar los ciclos por debajo de la linea base**. Eso se responde barriendo
la fraccion de mezcla, igual que el optimizador barre los ciclos: para cada
fraccion se construye la mezcla real con el modelo quimico completo y se
calculan los ciclos alcanzables. La mejor combinacion de (tren, fraccion) es
la que mas agua cruda desplaza.

COMPONENTES DEL PUNTAJE
-----------------------

  desplazamiento  40 %  m3/h de agua cruda que evita. Es el objetivo del reto.
  ciclos          20 %  A que ciclos deja operar. Determina cuanta purga se
                        recorta ademas del reemplazo directo.
  distancia       15 %  Manda en el CAPEX de conduccion, que es irrecuperable.
  tratamiento     15 %  Un tren de osmosis se come el ahorro en OPEX.
  incentivo       10 %  Que el vecino pague por entregarla es un plus.

Al final se multiplica por un factor de confianza que nunca baja de 0,55: un
prospecto poco fiable no se descarta, se posterga.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from ..config import Escenario
from ..domain.cooling import balance, ciclos_maximos
from ..domain.streams import AGUA_CRUDA, TRENES, generar_opciones
from ..domain.water_chem import mezclar
from .perfil import Prospecto
from .promocion import a_oferente

PESOS: dict[str, float] = {
    "desplazamiento": 40.0,
    "ciclos": 20.0,
    "distancia": 15.0,
    "tratamiento": 15.0,
    "incentivo": 10.0,
}

#: Fracciones de aporte exploradas. Discretas y no una biseccion porque la
#: frontera de factibilidad no es necesariamente monotona en la fraccion: una
#: corriente puede mejorar el LSI al diluir la dureza del agua cruda y
#: empeorarlo mas alla de cierto punto.
FRACCIONES = (0.10, 0.20, 0.30, 0.45, 0.60, 0.75, 0.90, 1.00)


@dataclass(frozen=True)
class Evaluacion:
    """Mejor forma de aprovechar una corriente, segun el modelo real."""

    tren: str
    tren_nombre: str
    fraccion: float               # fraccion del aporte que cubre
    ciclos_alcanzables: float
    desplazamiento_m3_h: float    # agua cruda que evita captar
    costo_usd_m3: float
    recuperacion: float
    caudal_producto_m3_h: float
    limitante: str | None


def _evaluar(
    prospecto: Prospecto, esc: Escenario, necesidad_m3_h: float,
) -> tuple[Evaluacion | None, str]:
    """Busca el mejor par (tren, fraccion de mezcla) para esta corriente.

    Las reglas de admisibilidad del dominio ya descartan las combinaciones
    que ningun operador aceptaria (agua con 320 mg/L de DQO sin biologico,
    por ejemplo), asi que aqui solo quedan alternativas defendibles.
    """
    opciones = generar_opciones(
        [a_oferente(prospecto)], TRENES,
        crf=esc.economia.crf,
        horas_anio=esc.planta.horas_anio,
        capex_conduccion_usd_m3h_km=esc.economia.capex_conduccion_usd_m3h_km,
        energia_bombeo_kwh_m3_km=esc.economia.energia_bombeo_kwh_m3_km,
        costo_energia_usd_kwh=esc.economia.costo_energia_usd_kwh,
    )
    if not opciones:
        return None, "ningun tren de tratamiento la hace admisible"

    mejor: Evaluacion | None = None
    for o in opciones:
        producto = o.caudal_max_m3_h
        if producto <= 0:
            continue
        for f in FRACCIONES:
            # No se puede aportar mas caudal del que la empresa produce.
            if f * necesidad_m3_h > producto:
                continue
            aporte = mezclar(
                [o.calidad_producto, AGUA_CRUDA], [f, 1.0 - f],
            )
            n, limitante = ciclos_maximos(
                aporte, esc.torre, esc.limites, esc.lsi_max_efectivo,
            )
            # Aportar agua que obliga a bajar ciclos por debajo de la linea
            # base es un mal negocio aunque el agua sea gratis: se recorta
            # menos purga de la que se ahorra en captacion.
            if n < esc.torre.ciclos_base:
                continue
            # Agua cruda evitada: la reposicion a esos ciclos, por la
            # fraccion que cubre esta corriente.
            reposicion = balance(esc.torre, n).reposicion_m3_h
            desplazamiento = min(f * reposicion, producto)
            candidata = Evaluacion(
                tren=o.tren.codigo,
                tren_nombre=o.tren.nombre,
                fraccion=f,
                ciclos_alcanzables=n,
                desplazamiento_m3_h=desplazamiento,
                costo_usd_m3=o.costo_usd_m3,
                recuperacion=o.tren.recuperacion,
                caudal_producto_m3_h=producto,
                limitante=limitante,
            )
            # Se ordena por agua desplazada y se desempata por costo: entre
            # dos formas de desplazar lo mismo, la barata.
            if mejor is None or (
                round(candidata.desplazamiento_m3_h, 2),
                -candidata.costo_usd_m3,
            ) > (
                round(mejor.desplazamiento_m3_h, 2), -mejor.costo_usd_m3,
            ):
                mejor = candidata

    if mejor is None:
        return None, (
            "no hay mezcla que mantenga los ciclos de la linea base: "
            "el agua es demasiado salina o el caudal demasiado pequeno"
        )
    return mejor, ""


def _normalizar(valor: float, malo: float, bueno: float) -> float:
    if bueno == malo:
        return 0.0
    return max(0.0, min(1.0, (valor - malo) / (bueno - malo)))


def puntuar(
    prospecto: Prospecto,
    esc: Escenario | None = None,
    necesidad_m3_h: float | None = None,
) -> Prospecto:
    """Devuelve el prospecto con puntaje, desglose y el plan que lo sustenta."""
    esc = esc or Escenario()
    if necesidad_m3_h is None:
        necesidad_m3_h = balance(esc.torre, esc.torre.ciclos_base).reposicion_m3_h

    ev, motivo = _evaluar(prospecto, esc, necesidad_m3_h)
    if ev is None:
        return replace(
            prospecto, puntaje=0.0,
            detalle_puntaje=dict.fromkeys(PESOS, 0.0),
            notas=f"{prospecto.notas} | No viable: {motivo}",
        )

    componentes = {
        # Desplazar la mitad de la reposicion es un proyecto de primer orden.
        "desplazamiento": _normalizar(
            ev.desplazamiento_m3_h, 0.0, necesidad_m3_h * 0.5,
        ),
        "ciclos": _normalizar(
            ev.ciclos_alcanzables, esc.torre.ciclos_base, esc.torre.ciclos_max,
        ),
        "distancia": 1.0 - _normalizar(prospecto.distancia_conduccion_km, 0.0, 6.0),
        # 0,80 USD/m3 es aproximadamente un tren de osmosis completo: a partir
        # de ahi no queda margen frente al costo del agua cruda.
        "tratamiento": 1.0 - _normalizar(ev.costo_usd_m3, 0.0, 0.80),
        "incentivo": _normalizar(-prospecto.incentivo_usd_m3, -0.10, 0.40),
    }
    detalle = {k: PESOS[k] * v for k, v in componentes.items()}
    factor = 0.55 + 0.45 * prospecto.confianza

    return replace(
        prospecto,
        puntaje=round(sum(detalle.values()) * factor, 1),
        detalle_puntaje=detalle,
        notas=(
            f"{prospecto.notas} | Plan: {ev.tren} ({ev.tren_nombre}) "
            f"cubriendo el {ev.fraccion:.0%} del aporte, "
            f"{ev.ciclos_alcanzables:.1f} ciclos, "
            f"desplaza {ev.desplazamiento_m3_h:.0f} m3/h de agua cruda, "
            f"{ev.costo_usd_m3:.3f} USD/m3"
            + (f", limita {ev.limitante}" if ev.limitante else "")
        ),
    )


def puntuar_todos(
    prospectos: list[Prospecto], esc: Escenario | None = None,
) -> list[Prospecto]:
    esc = esc or Escenario()
    necesidad = balance(esc.torre, esc.torre.ciclos_base).reposicion_m3_h
    puntuados = [puntuar(p, esc, necesidad) for p in prospectos]
    puntuados.sort(key=lambda p: p.puntaje or 0.0, reverse=True)
    return puntuados
