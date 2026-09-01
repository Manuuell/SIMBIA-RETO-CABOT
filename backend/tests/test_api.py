"""Contrato de la API."""

import pytest
from fastapi.testclient import TestClient

from simbia.main import app


@pytest.fixture(scope="module")
def cliente():
    return TestClient(app)


@pytest.mark.parametrize("ruta", [
    "/salud", "/api/escenario", "/api/oferentes", "/api/trenes",
    "/api/linea-base", "/api/kpis",
])
def test_get_responden(cliente, ruta):
    assert cliente.get(ruta).status_code == 200


def test_optimizar_sin_cuerpo_usa_el_caso_base(cliente):
    d = cliente.post("/api/optimizar", json={}).json()
    assert d["cumple_meta"] is True
    assert d["optimo"]["ahorro_pct_planta"] >= d["meta_reduccion"]


def test_optimizar_respeta_los_ajustes(cliente):
    d = cliente.post("/api/optimizar", json={
        "costo_agua_cruda_usd_m3": 0.5, "max_fraccion_reuso": 0.3,
    }).json()
    o = d["optimo"]
    reuso = sum(a["caudal_m3_h"] for a in o["aportes"])
    # La API redondea caudales a 3 decimales y la reposicion a 2: la tolerancia
    # cubre ese redondeo. La restriccion exacta se comprueba en test_optim.py.
    assert reuso <= 0.3 * o["balance"]["reposicion_m3_h"] + 0.02


def test_excluir_oferentes_cambia_la_mezcla(cliente):
    completo = cliente.post("/api/optimizar", json={}).json()["optimo"]
    usados = {a["oferente"] for a in completo["aportes"]}
    recortado = cliente.post(
        "/api/optimizar", json={"oferentes_excluidos": sorted(usados)}
    ).json()["optimo"]
    assert not ({a["oferente"] for a in recortado["aportes"]} & usados)


def test_oferente_inexistente_es_422(cliente):
    assert cliente.post(
        "/api/optimizar", json={"oferentes_excluidos": ["NO_EXISTE"]}
    ).status_code == 422


def test_parametro_de_sensibilidad_invalido_es_422(cliente):
    assert cliente.post(
        "/api/sensibilidad?parametro=inventado", json={}
    ).status_code == 422


def test_meta_fuera_de_rango_es_422(cliente):
    assert cliente.post(
        "/api/optimizar", json={"meta_reduccion": 1.5}
    ).status_code == 422


def test_operacion_devuelve_serie_y_pronostico(cliente):
    d = cliente.get("/api/operacion?horas=72").json()
    assert len(d["serie"]) == 72
    assert d["pronostico_24h"]
    assert 0.0 <= d["serie"][0]["prob_fuga"] <= 1.0


def test_operacion_acota_la_ventana(cliente):
    assert len(cliente.get("/api/operacion?horas=100000").json()["serie"]) <= 2000


def test_kpis_coherentes(cliente):
    k = cliente.get("/api/kpis").json()
    assert k["ahorro_pct"] >= k["meta_reduccion"]
    assert k["ahorro_pct_con_fugas"] >= k["ahorro_pct"]
    assert k["payback_anios"] > 0
    assert k["ciclos_optimo"] > k["ciclos_base"]


def test_el_dashboard_se_sirve(cliente):
    r = cliente.get("/")
    assert r.status_code == 200 and "SIMBIA" in r.text
