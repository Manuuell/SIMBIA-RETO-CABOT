"""La quimica es el cimiento: si falla, todo lo demas es ruido."""

import math

import pytest

from simbia.domain import water_chem as w


def test_constantes_de_equilibrio_a_25c():
    assert w._pk1(25.0) == pytest.approx(6.35, abs=0.02)
    assert w._pk2(25.0) == pytest.approx(10.33, abs=0.02)
    assert w._pkw(25.0) == pytest.approx(14.00, abs=0.02)
    assert w._log_kh(25.0) == pytest.approx(-1.47, abs=0.02)


def test_carbonato_ida_y_vuelta():
    """pH -> C_T -> pH debe cerrar."""
    for ph in (6.5, 7.5, 8.4, 9.2):
        for alc in (50.0, 150.0, 400.0):
            ct = w.carbono_total(ph, alc, 25.0)
            assert w.ph_desde_alc_ct(alc, ct, 25.0) == pytest.approx(ph, abs=1e-3)


def test_sistema_abierto_sube_el_ph_con_la_alcalinidad():
    phs = [w.ph_sistema_abierto(a) for a in (50, 150, 400, 800)]
    assert phs == sorted(phs)
    # Rango tipico de un agua de torre bien aireada.
    assert 7.8 < phs[0] < 9.9 and 8.5 < phs[-1] < 10.0


def test_indices_de_estabilidad_conocidos():
    # Agua blanda y poco alcalina: corrosiva (LSI < 0, RSI > 7).
    blanda = w.Calidad(ph=7.0, t_c=25, tds=120, dureza_ca=30, alcalinidad=25)
    i = blanda.indices()
    assert i["lsi"] < 0 and i["rsi"] > 7

    # Agua dura y alcalina a pH alto: incrustante.
    dura = w.Calidad(ph=8.6, t_c=45, tds=1500, dureza_ca=600, alcalinidad=400)
    j = dura.indices()
    assert j["lsi"] > 0 and j["rsi"] < 6


def test_larson_skold_es_invariante_de_escala():
    """Clave para el optimizador: por eso la restriccion queda LINEAL."""
    c = w.Calidad(cloruros=100, sulfatos=200, alcalinidad=150)
    base = w.larson_skold(c.cloruros, c.sulfatos, c.alcalinidad)
    for n in (2.0, 4.0, 7.5):
        assert w.larson_skold(
            c.cloruros * n, c.sulfatos * n, c.alcalinidad * n
        ) == pytest.approx(base, rel=1e-9)


def test_mezcla_conserva_masa():
    a = w.Calidad(tds=200, cloruros=30, alcalinidad=100)
    b = w.Calidad(tds=2000, cloruros=600, alcalinidad=400)
    m = w.mezclar([a, b], [75.0, 25.0])
    assert m.tds == pytest.approx(0.75 * 200 + 0.25 * 2000)
    assert m.cloruros == pytest.approx(0.75 * 30 + 0.25 * 600)
    assert m.alcalinidad == pytest.approx(0.75 * 100 + 0.25 * 400)


def test_mezcla_de_dos_iguales_no_cambia_nada():
    a = w.Calidad(ph=8.1, alcalinidad=220, tds=600)
    m = w.mezclar([a, a], [10.0, 30.0])
    assert m.ph == pytest.approx(a.ph, abs=1e-3)
    assert m.alcalinidad == pytest.approx(a.alcalinidad)


def test_el_ph_de_mezcla_no_es_el_promedio_aritmetico():
    """Promediar pH es un error clasico; aqui se mezcla el sistema carbonatado."""
    acida = w.Calidad(ph=5.5, alcalinidad=5.0)
    alcalina = w.Calidad(ph=9.5, alcalinidad=500.0)
    m = w.mezclar([acida, alcalina], [50.0, 50.0])
    assert abs(m.ph - 7.5) > 0.3      # el promedio ingenuo daria 7.5


def test_escalar_concentra_los_conservativos():
    a = w.Calidad(tds=250, cloruros=35, alcalinidad=110, dqo=8)
    c = a.escalar(4.0, t_c=38.0)
    assert c.tds == pytest.approx(1000.0)
    assert c.cloruros == pytest.approx(140.0)
    assert c.t_c == 38.0
    # La materia organica se atenua biologicamente: no concentra al 100 %.
    assert c.dqo < 8 * 4.0


def test_acido_destruye_alcalinidad_y_aporta_sulfato():
    a = w.Calidad(ph=8.2, alcalinidad=300.0, sulfatos=50.0)
    d = w.dosificar_acido(a, 98.08)      # 2 eq/L * ... -> 2 meq
    eq = 98.08 / 49.04
    assert d.alcalinidad == pytest.approx(300.0 - eq * 50.0, abs=1e-6)
    assert d.sulfatos == pytest.approx(50.0 + eq * 48.03, abs=1e-6)
    assert d.ph < a.ph


def test_acido_para_alcalinidad_es_inverso_de_dosificar():
    a = w.Calidad(ph=8.4, alcalinidad=420.0)
    mg = w.acido_para_alcalinidad(420.0, 150.0)
    assert w.dosificar_acido(a, mg).alcalinidad == pytest.approx(150.0, abs=1e-6)
