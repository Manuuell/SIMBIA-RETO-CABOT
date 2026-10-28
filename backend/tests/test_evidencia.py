"""Evitar que datos de campaña o valores censurados se conviertan en certezas."""

import hashlib

import pytest
from fastapi.testclient import TestClient

from simbia.main import app
from simbia.scout import analitica, evidencia


def test_documentos_y_paginas_son_auditables():
    seleccion = evidencia.seleccion()
    for identificador, fuente in seleccion["documentos"].items():
        archivo = evidencia.documento(identificador)
        assert hashlib.sha256(archivo.read_bytes()).hexdigest() == fuente["sha256"]
        assert archivo.read_bytes().startswith(b"%PDF-")
    for c in seleccion["candidatos"]:
        for dato in [c["caudal"], c["permiso"], *c["calidad"].values()]:
            assert dato["documento"] in seleccion["documentos"]
            assert dato["pagina_pdf"] > 0


def test_caudales_son_del_punto_y_no_el_maximo_global():
    m, y = evidencia.seleccion()["candidatos"]
    assert m["punto"].endswith("Efluente 3")
    assert m["caudal"]["valor"] == 6.73
    assert m["caudal"]["m3_h"] == pytest.approx(24.228)
    assert y["caudal"]["m3_h"] == pytest.approx(38.124)
    assert "hierro" not in y["calidad"]
    assert "dureza_ca" not in m["calidad"]
    assert all(not c["simbiosis_validada"] for c in (m, y))
    assert evidencia.seleccion()["ahorro_validado"] is None


def test_yara_conserva_rangos_y_calificadores_sin_importarlos_como_exactos():
    y = evidencia.seleccion()["candidatos"][1]
    a = analitica.buscar("Yara Colombia")
    assert y["calidad"]["ph"]["valor"] == [7.11, 7.7]
    assert y["calidad"]["fosforo_reactivo"]["calificador"] == "<"
    assert y["calidad"]["sulfatos"]["calificador"] == "*"
    assert not {"ph", "fosfatos", "sulfatos"} & a.medido.keys()
    for campo, valor in a.medido.items():
        assert valor == y["calidad"][campo]["valor"]
    assert a.caudal_m3_h == y["caudal"]["m3_h"]


def test_api_entrega_fuentes_y_rechaza_documentos_no_registrados():
    with TestClient(app) as cliente:
        r = cliente.get("/api/scout/evidencia")
        assert r.status_code == 200
        assert len(r.json()["candidatos"]) == 2
        for identificador in r.json()["documentos"]:
            pdf = cliente.get(f"/api/scout/evidencia/documentos/{identificador}")
            assert pdf.status_code == 200
            assert pdf.headers["content-type"] == "application/pdf"
        assert cliente.get("/api/scout/evidencia/documentos/no-existe").status_code == 404


@pytest.fixture(scope="module")
def evaluacion():
    from simbia.scout.pipeline import prospectar
    from simbia.scout.scoring import puntuar_todos
    from simbia.scout.fuentes import Modo
    return evidencia.evaluar(puntuar_todos(prospectar(modo=Modo.OFFLINE).prospectos))


def test_cruce_solo_usa_las_dos_corrientes_y_sus_datos(evaluacion):
    c = evaluacion["cruce"]
    fuentes = {f["id"]: f for f in c["escenario"]["fuentes"]}
    assert set(fuentes) == {"mexichem-efluente-3", "yara-norte-1"}
    m, y = fuentes.values()
    assert m["caudal_disponible_m3_h"] == 24.228
    assert m["calidad"]["dqo"] == 146.63
    assert y["calidad"]["n_amoniacal"] == 64.43
    assert 7.11 <= y["calidad"]["ph"] <= 7.70
    assert "ph" not in y["campos_medidos"]
    assert c["resultado"]["factible"]
    assert all(not t["excede"] for t in c["resultado"]["tomas"])
    assert c["validacion"]["ahorro_validado"] is False
    assert all(p["evaluacion"]["puesto_inicial"] > 0 for p in evaluacion["candidatos"])


def test_escenario_enviado_al_gemelo_reproduce_el_cruce(evaluacion):
    # Verifica conversión y precisión de la API, no solo la misma función.
    with TestClient(app) as cliente:
        r = cliente.post("/api/simulador/simular", json=evaluacion["cruce"]["escenario"])
    assert r.status_code == 200
    esperado = evaluacion["cruce"]["resultado"]
    for campo in ("factible", "ahorro_pct", "ciclos", "reuso_m3_h", "tomas"):
        assert r.json()[campo] == esperado[campo]


def test_correspondencia_ambigua_no_asigna_datos_a_otra_planta():
    with pytest.raises(ValueError, match="identificar de forma única"):
        evidencia.evaluar([])

