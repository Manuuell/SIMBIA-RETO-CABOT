"""Simulador de la torre: motor, calibracion y API."""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from simbia.domain import cooling
from simbia.domain.streams import AGUA_CRUDA, CATALOGO_POR_CODIGO
from simbia.main import app
from simbia.optim.blend import linea_base
from simbia.simulador import (
    DatosPlanta, Decision, Fuente, Toma, calibrar, simular, sugerir,
)


def _fuente(codigo: str, caudal: float | None = None) -> Fuente:
    o = CATALOGO_POR_CODIGO[codigo]
    return Fuente(
        codigo, o.empresa, o.calidad,
        o.caudal_disponible_m3_h if caudal is None else caudal,
        o.distancia_km, o.precio_usd_m3,
    )


@pytest.fixture(scope="module")
def esc():
    return calibrar().escenario


# -- planta y calibracion -----------------------------------------------------

def test_sin_datos_es_el_caso_base_y_todo_es_supuesto():
    pc = calibrar()
    assert pc.agua_cruda == AGUA_CRUDA
    assert set(pc.origen.values()) == {"supuesto"}


def test_los_ciclos_salen_de_las_conductividades():
    pc = calibrar(DatosPlanta(conductividad_reposicion_us_cm=400, conductividad_purga_us_cm=1600))
    assert pc.escenario.torre.ciclos_base == pytest.approx(4.0)
    assert pc.origen["ciclos_actuales"] == "planta"


def test_la_reposicion_medida_calibra_la_evaporacion():
    pc = calibrar(DatosPlanta(reposicion_medida_m3_h=45.0))
    torre = pc.escenario.torre
    modelada = cooling.balance(torre, torre.ciclos_base, pc.agua_cruda.t_c).reposicion_m3_h
    assert modelada == pytest.approx(45.0, rel=1e-6)
    assert not pc.avisos


def test_una_reposicion_imposible_se_avisa_en_vez_de_esconderla():
    pc = calibrar(DatosPlanta(reposicion_medida_m3_h=90.0))
    assert pc.escenario.torre.factor_evaporacion == pytest.approx(1.10)
    assert any("fuga" in a for a in pc.avisos)


def test_el_agua_cruda_de_la_planta_llega_al_optimizador():
    salobre = calibrar(DatosPlanta(agua_cruda={"tds": 900, "cloruros": 300})).escenario
    base = linea_base(salobre)
    assert base.calidad_aporte.tds == 900
    assert base.calidad_circulante.cloruros > linea_base().calidad_circulante.cloruros


def test_parametro_de_calidad_desconocido():
    with pytest.raises(ValueError):
        calibrar(DatosPlanta(agua_cruda={"arsenico": 1.0}))


# -- motor --------------------------------------------------------------------

def test_sin_vecinos_opera_a_los_ciclos_que_admite_el_agua_propia(esc):
    r = simular(esc)
    assert r.factible
    assert r.ciclos >= esc.torre.ciclos_base
    assert r.limitante is not None
    assert r.ahorro_pct >= 0
    # La palanca sin vecinos coincide con la simulacion sin tomas.
    assert r.solo_cruda["ciclos"] == pytest.approx(r.ciclos, abs=0.01)


def test_a_los_ciclos_actuales_no_hay_ahorro(esc):
    r = simular(esc, Decision(ciclos=esc.torre.ciclos_base))
    assert r.ciclos_fijados
    assert r.agua_cruda_m3_h == pytest.approx(r.base.caudal_cruda_m3_h, rel=1e-6)
    assert r.ahorro_pct == pytest.approx(0.0, abs=1e-9)


def test_la_trampa_del_reto_agua_salina_sin_tratar_hunde_los_ciclos(esc):
    """El rechazo de OI sin desalar baja los ciclos; con OI los sube."""
    sin = simular(esc)
    salina = simular(esc, Decision((Toma(_fuente("V1"), 10.0, "T1"),)))
    desalada = simular(esc, Decision((Toma(_fuente("V1"), 10.0, "T6"),)))
    assert salina.ciclos < sin.ciclos
    assert not salina.factible
    assert desalada.factible and desalada.ciclos > sin.ciclos
    assert desalada.ahorro_pct > sin.ahorro_pct


def test_mas_agua_de_la_que_cabe_obliga_a_purgar(esc):
    r = simular(esc, Decision((Toma(_fuente("V6", caudal=200.0), 60.0, "T1"),)))
    assert r.limitante == "exceso_aporte"
    assert r.agua_cruda_m3_h == pytest.approx(0.0, abs=0.01)


def test_un_tren_que_no_basta_hace_la_solucion_inviable(esc):
    r = simular(esc, Decision((Toma(_fuente("V5"), 10.0, "T1"),)))   # DQO 320 sin biologico
    assert not r.factible
    assert r.tomas[0]["admisible"] is False
    assert r.avisos


def test_pedir_mas_de_lo_que_el_vecino_tiene(esc):
    r = simular(esc, Decision((Toma(_fuente("V4"), 30.0, "T6"),)))
    assert r.tomas[0]["excede"] is True
    assert not r.factible


def test_tren_desconocido(esc):
    with pytest.raises(ValueError):
        simular(esc, Decision((Toma(_fuente("V6"), 5.0, "T99"),)))


def test_la_mezcla_sugerida_es_factible_y_cumple_la_meta(esc):
    fuentes = [_fuente(c) for c in CATALOGO_POR_CODIGO]
    s = sugerir(esc, fuentes)
    assert s.modo == "meta" and s.decision is not None
    assert all(t.caudal_m3_h >= 0.5 for t in s.decision.tomas)
    r = simular(esc, s.decision)
    assert r.factible and r.cumple_meta


def test_sin_fuentes_se_sugiere_lo_que_se_puede_hacer_solo(esc):
    s = sugerir(esc, [])
    assert s.decision is not None and not s.decision.tomas
    assert s.modo == "economico"     # la meta no se alcanza sin vecinos
    assert simular(esc, s.decision).factible


def test_mas_ciclos_menos_purga_y_menos_coste_de_vertimiento(esc):
    bajo = simular(esc, Decision(ciclos=3.0))
    alto = simular(esc, Decision(ciclos=3.8))
    assert alto.balance.purga_m3_h < bajo.balance.purga_m3_h
    assert alto.costos["vertimiento_purga"] < bajo.costos["vertimiento_purga"]


# -- API ----------------------------------------------------------------------

@pytest.fixture(scope="module")
def cliente():
    return TestClient(app)


def _fuente_json(codigo: str) -> dict:
    o = CATALOGO_POR_CODIGO[codigo]
    return {
        "id": codigo, "nombre": o.empresa,
        "caudal_disponible_m3_h": o.caudal_disponible_m3_h,
        "distancia_km": o.distancia_km, "precio_usd_m3": o.precio_usd_m3,
        "calidad": {k: v for k, v in o.calidad.__dict__.items()},
    }


def test_api_referencia(cliente):
    d = cliente.get("/api/simulador/referencia").json()
    assert {t["codigo"] for t in d["trenes"]} >= {"T0", "T1", "T6"}
    assert d["planta"]["ciclos_actuales"] == 3.2
    assert any(p["clave"] == "silice" for p in d["parametros"])


def test_api_simular_sin_cuerpo(cliente):
    d = cliente.post("/api/simulador/simular", json={}).json()
    assert d["factible"] and d["ciclos"] > 3.2
    assert d["planta"]["origen"]["agua_cruda"] == "supuesto"
    assert any(m["parametro"] == "lsi" for m in d["margenes"])


def test_api_simular_con_planta_y_tomas(cliente):
    d = cliente.post("/api/simulador/simular", json={
        "planta": {"ciclos_actuales": 3.0, "agua_cruda": {"silice": 20}},
        "fuentes": [_fuente_json("V3")],
        "tomas": [{"fuente_id": "V3", "caudal_m3_h": 10, "tren": "T6"}],
    }).json()
    assert d["planta"]["origen"]["agua_cruda"] == "planta"
    assert d["planta"]["agua_cruda"]["silice"] == 20
    assert d["tomas"][0]["tren"] == "T6"
    assert d["reuso_m3_h"] == pytest.approx(10.0)


@pytest.mark.parametrize("cuerpo", [
    {"tomas": [{"fuente_id": "nadie", "caudal_m3_h": 1}]},
    {"fuentes": [_fuente_json("V3")], "tomas": [{"fuente_id": "V3", "caudal_m3_h": 1, "tren": "T99"}]},
    {"fuentes": [_fuente_json("V3"), _fuente_json("V3")]},
    {"planta": {"agua_cruda": {"ph": 20}}},
])
def test_api_rechaza_entradas_invalidas(cliente, cuerpo):
    assert cliente.post("/api/simulador/simular", json=cuerpo).status_code == 422


def test_api_sugerir_devuelve_decision_y_resultado(cliente):
    d = cliente.post("/api/simulador/sugerir", json={
        "fuentes": [_fuente_json(c) for c in CATALOGO_POR_CODIGO],
    }).json()
    assert d["modo"] == "meta"
    assert d["resultado"]["cumple_meta"] is True
    ids = {t["fuente_id"] for t in d["decision"]["tomas"]}
    assert ids <= set(CATALOGO_POR_CODIGO)


def test_api_candidatos_trae_tren_sugerido(cliente):
    d = cliente.get("/api/simulador/candidatos").json()
    assert d, "el barrido sin red deberia traer prospectos de la cache"
    assert all({"id", "calidad", "tren_sugerido", "procedencia"} <= set(x) for x in d)
