"""El optimizador nunca debe entregar una solucion que no cumpla la quimica."""

from dataclasses import replace

import pytest

from simbia.config import Escenario
from simbia.domain import cooling
from simbia.domain.streams import CATALOGO, TRENES, admisible, generar_opciones
from simbia.optim.analysis import contingencias, frontera
from simbia.optim.blend import linea_base, optimizar


@pytest.fixture(scope="module")
def esc():
    return Escenario()


@pytest.fixture(scope="module")
def solucion(esc):
    return optimizar(esc)


def test_hay_solucion_y_cumple_la_meta(esc, solucion):
    assert solucion.factible, solucion.motivo
    assert solucion.ahorro_pct_planta >= esc.planta.meta_reduccion


def test_la_solucion_respeta_todos_los_limites(esc, solucion):
    """Verificacion con el modelo quimico completo, no con el linealizado."""
    fuera = cooling.violaciones(
        solucion.calidad_circulante, esc.limites, esc.lsi_max_efectivo
    )
    assert not fuera, f"limites incumplidos: {fuera}"


def test_el_balance_de_caudales_cierra(esc, solucion):
    total = solucion.caudal_cruda_m3_h + sum(solucion.aportes.values())
    assert total == pytest.approx(solucion.balance.reposicion_m3_h, rel=1e-4)


def test_no_se_toma_mas_agua_de_la_disponible(solucion):
    por_oferente: dict[str, float] = {}
    for op in solucion.opciones_usadas:
        alimentacion = solucion.aportes[op.codigo] / op.tren.recuperacion
        por_oferente[op.oferente.codigo] = (
            por_oferente.get(op.oferente.codigo, 0.0) + alimentacion
        )
    for codigo, caudal in por_oferente.items():
        of = next(o for o in CATALOGO if o.codigo == codigo)
        assert caudal <= of.caudal_disponible_m3_h * of.disponibilidad + 1e-6


def test_es_mas_barata_que_la_linea_base(esc, solucion):
    assert solucion.costo_total_usd_anio < linea_base(esc).costo_total_usd_anio


def test_meta_imposible_devuelve_motivo(esc):
    sol = optimizar(esc, meta_reduccion=0.9)
    assert not sol.factible and sol.motivo


def test_sin_oferentes_no_puede_ahorrar(esc):
    sol = optimizar(esc, oferentes=())
    assert not sol.factible


def test_tope_de_reuso_se_respeta(esc):
    sol = optimizar(esc, max_fraccion_reuso=0.30)
    assert sol.factible
    reuso = sum(sol.aportes.values())
    assert reuso <= 0.30 * sol.balance.reposicion_m3_h + 1e-6


def test_sin_antiincrustante_bajan_los_ciclos(esc):
    con = optimizar(esc)
    sin = optimizar(replace(esc, usar_antiincrustante=False))
    assert sin.factible and sin.ciclos < con.ciclos


def test_agua_cruda_mas_cara_no_reduce_el_reuso(esc):
    """Monotonia economica: encarecer la captacion nunca desincentiva reusar."""
    barata = optimizar(
        replace(esc, planta=replace(esc.planta, costo_agua_cruda_usd_m3=0.40))
    )
    cara = optimizar(
        replace(esc, planta=replace(esc.planta, costo_agua_cruda_usd_m3=3.00))
    )
    assert cara.ahorro_pct_planta >= barata.ahorro_pct_planta - 1e-6


def test_la_frontera_es_decreciente_en_costo(esc):
    puntos = [p for p in frontera(esc, metas=(0.0, 0.10, 0.20, 0.30)) if p.factible]
    costos = [p.costo_usd_anio for p in puntos]
    assert costos == sorted(costos, reverse=True)


def test_ninguna_contingencia_rompe_la_meta(esc):
    for c in contingencias(esc):
        assert c.factible and c.cumple_meta, c.escenario


def test_admisibilidad_bloquea_corrientes_sucias():
    sucia = next(o for o in CATALOGO if o.calidad.dqo > 150)
    directo = next(t for t in TRENES if not t.unidades)
    assert not admisible(sucia, directo)[0]


def test_toda_opcion_generada_es_admisible(esc):
    opciones = generar_opciones(
        CATALOGO, TRENES, esc.economia.crf, esc.planta.horas_anio,
        esc.economia.capex_conduccion_usd_m3h_km,
        esc.economia.energia_bombeo_kwh_m3_km,
        esc.economia.costo_energia_usd_kwh,
    )
    assert opciones
    for op in opciones:
        assert admisible(op.oferente, op.tren)[0]


def test_la_osmosis_encarece_pero_limpia():
    esc = Escenario()
    opciones = generar_opciones(
        CATALOGO, TRENES, esc.economia.crf, esc.planta.horas_anio,
        esc.economia.capex_conduccion_usd_m3h_km,
        esc.economia.energia_bombeo_kwh_m3_km,
        esc.economia.costo_energia_usd_kwh,
    )
    for cod in {o.oferente.codigo for o in opciones}:
        del_of = [o for o in opciones if o.oferente.codigo == cod]
        con_oi = [o for o in del_of if "OI" in [u.codigo for u in o.tren.unidades]]
        sin_oi = [o for o in del_of if "OI" not in [u.codigo for u in o.tren.unidades]]
        if con_oi and sin_oi:
            assert min(o.calidad_producto.tds for o in con_oi) < \
                   min(o.calidad_producto.tds for o in sin_oi)
