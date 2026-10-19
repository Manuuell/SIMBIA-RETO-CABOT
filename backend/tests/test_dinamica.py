"""Simulacion dinamica de la torre: balances, lazos y API."""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from simbia.domain import cooling
from simbia.domain.streams import CATALOGO_POR_CODIGO
from simbia.main import app
from simbia.simulador import Fuente, calibrar
from simbia.simulador import dinamica as d


@pytest.fixture(scope="module")
def planta():
    return d.preparar(calibrar().escenario)


def _fuente(codigo: str) -> Fuente:
    o = CATALOGO_POR_CODIGO[codigo]
    return Fuente(codigo, o.empresa, o.calidad, o.caudal_disponible_m3_h, o.distancia_km, o.precio_usd_m3)


def _consigna(p, ciclos):
    return d.Lazo("auto", p.cruda.conductividad * ciclos, 50.0)


def test_la_geometria_sale_del_caudal_de_recirculacion(planta):
    g = planta.geo
    assert g.celdas * g.lado_celda_m ** 2 == pytest.approx(
        planta.esc.torre.caudal_circulacion_m3_h / d.CARGA_HIDRAULICA_M3H_M2)
    assert 150 < g.rpm_nominal < 250
    assert g.nivel(g.volumen(d.NIVEL_NOMINAL_PCT)) == pytest.approx(d.NIVEL_NOMINAL_PCT)


def test_la_operacion_actual_esta_en_regimen(planta):
    muestras, final = d.avanzar(planta, d.estado_inicial(planta), d.Entradas(), 48)
    ultima = muestras[-1]
    assert ultima["nivel_pct"] == pytest.approx(d.NIVEL_NOMINAL_PCT, abs=0.2)
    assert ultima["ciclos"] == pytest.approx(planta.esc.torre.ciclos_base, rel=0.01)
    assert ultima["cruda_m3_h"] == pytest.approx(planta.reposicion_base_m3_h, rel=0.01)
    assert ultima["ahorro_pct"] == pytest.approx(0.0, abs=0.002)


def test_los_balances_de_agua_y_sales_cierran(planta):
    s0 = d.estado_inicial(planta)
    e = d.Entradas(conductividad=_consigna(planta, 4.0),
                   tomas=(d.TomaDinamica(_fuente("V6"), 8.0, "T1"),))
    muestras, final = d.avanzar(planta, s0, e, 24)
    # Agua: lo que entra menos lo que sale es lo que cambia el volumen.
    paso = d.MUESTRA_H
    entra = sum(m["reposicion_m3_h"] for m in muestras) * paso
    sale = sum(m["evaporacion_m3_h"] + m["arrastre_m3_h"] + m["purga_m3_h"] for m in muestras) * paso
    assert final.volumen_m3 - s0.volumen_m3 == pytest.approx(entra - sale, abs=0.02 * entra)
    # Sales: el TDS del sistema no puede crecer mas de lo que entro.
    masa0 = s0.conc["tds"] * s0.volumen_m3
    masa1 = final.conc["tds"] * final.volumen_m3
    assert masa1 > masa0


def test_subir_la_consigna_sube_los_ciclos_y_baja_la_reposicion(planta):
    s = d.estado_inicial(planta)
    e = d.Entradas(conductividad=_consigna(planta, 4.0))
    for _ in range(4):
        muestras, s = d.avanzar(planta, s, e, 48)
    ultima = muestras[-1]
    assert ultima["ciclos"] == pytest.approx(4.0, rel=0.02)
    esperada = cooling.balance(planta.esc.torre, 4.0).reposicion_m3_h
    assert ultima["cruda_m3_h"] == pytest.approx(esperada, rel=0.03)
    assert ultima["ahorro_pct"] > 0.03


def test_un_vecino_desplaza_agua_cruda_a_traves_del_lazo_de_nivel(planta):
    s = d.estado_inicial(planta)
    e = d.Entradas(tomas=(d.TomaDinamica(_fuente("V6"), 15.0, "T1"),))
    muestras, s = d.avanzar(planta, s, e, 24)
    ultima = muestras[-1]
    assert ultima["vecinos_m3_h"] == pytest.approx(15.0)
    assert ultima["cruda_m3_h"] < planta.reposicion_base_m3_h - 10
    assert ultima["nivel_pct"] == pytest.approx(d.NIVEL_NOMINAL_PCT, abs=1.0)


def test_en_manual_la_valvula_se_queda_donde_la_deja_el_operador(planta):
    e = d.Entradas(conductividad=d.Lazo("man", 0.0, 0.0))
    muestras, s = d.avanzar(planta, d.estado_inicial(planta), e, 12)
    assert all(m["av_pct"] == 0.0 for m in muestras)
    assert muestras[-1]["conductividad"] > muestras[0]["conductividad"]


def test_demasiado_acido_dispara_la_alarma_de_corrosion(planta):
    e = d.Entradas(acido_mg_l=60.0)
    muestras, _ = d.avanzar(planta, d.estado_inicial(planta), e, 48)
    textos = " ".join(a["texto"] for a in muestras[-1]["alarmas"])
    assert "Larson-Skold" in textos


def test_mas_ventilador_agua_mas_fria(planta):
    rapido = d.temperaturas(planta, d.Entradas(ventilador_pct=100))[0]
    lento = d.temperaturas(planta, d.Entradas(ventilador_pct=50))[0]
    assert lento > rapido


def test_horas_fuera_de_rango(planta):
    with pytest.raises(ValueError):
        d.avanzar(planta, d.estado_inicial(planta), d.Entradas(), 0)


# -- API ----------------------------------------------------------------------

@pytest.fixture(scope="module")
def cliente():
    return TestClient(app)


def test_api_dinamica_sin_estado_parte_del_regimen(cliente):
    r = cliente.post("/api/simulador/dinamica", json={"horas": 2})
    assert r.status_code == 200
    d_ = r.json()
    assert d_["geometria"]["celdas"] >= 1
    assert len(d_["muestras"]) == 24
    assert d_["estado"]["t_h"] == pytest.approx(2.0)


def test_api_dinamica_continua_desde_el_estado(cliente):
    a = cliente.post("/api/simulador/dinamica", json={"horas": 1}).json()
    b = cliente.post("/api/simulador/dinamica", json={
        "horas": 1, "estado": a["estado"], "conductividad": {"consigna": 1600},
    }).json()
    assert b["estado"]["t_h"] == pytest.approx(2.0)
    assert b["muestras"][0]["t_h"] > 1.0


def test_api_dinamica_rechaza_estado_incompleto(cliente):
    a = cliente.post("/api/simulador/dinamica", json={"horas": 1}).json()
    estado = dict(a["estado"], conc={"tds": 800})
    assert cliente.post("/api/simulador/dinamica", json={"estado": estado}).status_code == 422


def test_la_rampa_de_consigna_evita_cruzar_el_limite_de_lsi(planta):
    """Subir ciclos de golpe cruza el LSI mientras el circuito se renueva."""
    from simbia.simulador import sugerir, simular
    fuentes = [_fuente(c) for c in CATALOGO_POR_CODIGO]
    sug = sugerir(planta.esc, fuentes)
    r = simular(planta.esc, sug.decision)
    consigna = r.ciclos * r.aporte.conductividad * 0.97
    tomas = tuple(d.TomaDinamica(t.fuente, t.caudal_m3_h, t.tren) for t in sug.decision.tomas)

    def pico_lsi(rampa):
        e = d.Entradas(acido_mg_l=sug.decision.acido_mg_l, tomas=tomas,
                       conductividad=d.Lazo("auto", consigna, 30.0, rampa))
        s, pico, consignas = d.estado_inicial(planta), 0.0, []
        for _ in range(5):
            muestras, s = d.avanzar(planta, s, e, 72)
            pico = max(pico, max(m["lsi"] for m in muestras))
            consignas += [m["consigna_cond"] for m in muestras]
        return pico, consignas

    escalon, _ = pico_lsi(0.0)
    rampa, consignas = pico_lsi(2.0)
    assert escalon > planta.esc.lsi_max_efectivo
    assert rampa <= planta.esc.lsi_max_efectivo
    pasos = [b - a for a, b in zip(consignas, consignas[1:])]
    assert max(pasos) <= 2.0 * d.MUESTRA_H + 0.1   # la muestra redondea a 0,1
