"""Buscador de VITAL: interpretacion, cache por modo y vinculo a prospectos."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from simbia.domain.water_chem import Calidad
from simbia.main import app
from simbia.scout import almacen, vital
from simbia.scout.fuentes import base
from simbia.scout.fuentes.base import Modo
from simbia.scout.perfil import Prospecto

FILA_VITAL = {
    "id_consulta_publica": 982946, "sol_num_silpa": "1070090096221824005",
    "aut_nombre": "EPA- CARTAGENA", "tra_nombre": "348_VITAL_VERTIMIENTO_CUERPO_A",
    "expediente": " -- VDA-00020-24", "nombre_proyecto": "None", "municipio": "None",
    "departamento": None, "tar_fecha_creacion": "2024-11-13T00:00:00",
    "tar_fecha_finalizacion": "2024-11-13T00:00:00",
    "nombre_completo": "PETROAMBIENTAL MAMONAL SAS", "origen": "VITAL",
}
FILA_SILAMC = {
    "id_consulta_publica": 535446, "sol_num_silpa": "VDA-00020-24",
    "aut_nombre": "EPA- CARTAGENA", "tra_nombre": "Vertimiento de Aguas",
    "expediente": "1070090096221824005",
    "nombre_proyecto": "348_VITAL_VERTIMIENTO_CUERPO_A  -  1070090096221824005",
    "tar_fecha_creacion": "2024-11-15T00:00:00", "nombre_completo": "PETROAMBIENTAL MAMONAL SAS",
    "origen": "SILAMC",
}
FILA_OTRA = {
    "id_consulta_publica": 1, "sol_num_silpa": "X-1", "aut_nombre": " CARDIQUE",
    "tra_nombre": "Aprovechamiento Forestal", "expediente": "", "nombre_completo": "MADERAS SAS",
    "tar_fecha_creacion": "2023-01-02T00:00:00", "origen": "VITAL",
}


def _prospecto(**kw) -> Prospecto:
    base_ = dict(
        codigo="P01", nombre="Empresa X", sector="Sector", ciiu="2011", corriente="Rechazo",
        lat=10.32, lon=-75.50, distancia_linea_km=1.0, distancia_conduccion_km=1.4,
        caudal_m3_h=30.0, calidad=Calidad(),
    )
    base_.update(kw)
    return Prospecto(**base_)


# -- interpretacion ----------------------------------------------------------

def test_los_registros_se_limpian_y_se_reconoce_el_vertimiento():
    r = vital.interpretar(FILA_VITAL)
    assert r.expediente == "VDA-00020-24"          # sin el ' -- ' de VITAL
    assert r.proyecto == "" and r.municipio == ""  # 'None' es ausencia
    assert r.fecha == "2024-11-13"
    assert r.tramite_legible == "Vertimiento a cuerpo de agua"
    assert r.es_vertimiento
    assert not vital.interpretar(FILA_OTRA).es_vertimiento
    assert vital.interpretar(FILA_SILAMC).expediente == "1070090096221824005"


def test_varios_expedientes_en_una_celda_se_separan():
    r = vital.interpretar({**FILA_OTRA, "expediente": " -- PDA2877-00-2026 -- VDI3978-00-2026"})
    assert r.expediente == "PDA2877-00-2026 / VDI3978-00-2026"


def test_el_cuerpo_de_la_peticion_lleva_lo_que_el_api_exige():
    b = vital.Busqueda("Yara", autoridades=("EPA- CARTAGENA",), solo_vertimientos=True, pagina=2)
    c = b.cuerpo()
    assert c["type_search"] == "Todos" and c["filters"]["CAMPO"] == -6
    assert c["filters"]["aut_nombre"] == ["EPA- CARTAGENA"]
    assert set(vital.TRAMITES_VERTIMIENTO) <= set(c["filters"]["tra_nombre"])
    assert c["page_number"] == 2


def test_las_facetas_conservan_el_valor_original_pero_no_duplican():
    f = vital._facetas({"aut_nombre": ["EPA- CARTAGENA", " CARDIQUE", "CARDIQUE", "None"], "tra_nombre": []})
    assert f["autoridad"] == ["EPA- CARTAGENA", " CARDIQUE"]
    assert f["tramite"] == []


# -- modos y cache -------------------------------------------------------------

@pytest.fixture
def cache_temporal(tmp_path, monkeypatch):
    monkeypatch.setattr(base, "CACHE", tmp_path)
    return tmp_path


def test_sin_texto_no_se_busca(cache_temporal):
    r = vital.buscar(vital.Busqueda("   "), modo=Modo.VIVO)
    assert r.origen == "sin dato" and "Escribe" in r.incidencia


def test_en_offline_solo_se_sirve_lo_cacheado(cache_temporal, monkeypatch):
    b = vital.Busqueda("Petroambiental")
    r = vital.buscar(b, modo=Modo.OFFLINE)
    assert r.origen == "sin dato" and "cache" in r.incidencia.lower()
    # Se simula una consulta en vivo que deja cache.
    monkeypatch.setattr(vital, "_consultar_red", lambda b: vital.Resultado(
        busqueda=b, registros=[vital.interpretar(FILA_VITAL)], total=1, paginas=1,
        facetas={"autoridad": ["EPA- CARTAGENA"]}, origen="red",
    ))
    r = vital.buscar(b, modo=Modo.VIVO)
    assert r.origen == "red" and r.total == 1
    r = vital.buscar(b, modo=Modo.OFFLINE)
    assert r.origen == "cache" and r.registros[0].titular == "PETROAMBIENTAL MAMONAL SAS"
    assert r.facetas["autoridad"] == ["EPA- CARTAGENA"]


def test_si_la_red_falla_se_degrada_a_cache_y_lo_dice(cache_temporal, monkeypatch):
    b = vital.Busqueda("Petroambiental")
    monkeypatch.setattr(vital, "_consultar_red", lambda b: vital.Resultado(
        busqueda=b, registros=[vital.interpretar(FILA_SILAMC)], total=1, paginas=1, origen="red"))
    vital.buscar(b, modo=Modo.VIVO)

    def caida(b):
        raise ConnectionError("sin ruta")
    monkeypatch.setattr(vital, "_consultar_red", caida)
    r = vital.buscar(b, modo=Modo.VIVO)
    assert r.origen == "cache" and "no respondio" in r.incidencia
    r = vital.buscar(vital.Busqueda("otra cosa"), modo=Modo.VIVO)
    assert r.origen == "sin dato" and "ConnectionError" in r.incidencia


# -- vinculo a prospectos -------------------------------------------------------

@pytest.fixture
def almacen_temporal(tmp_path, monkeypatch):
    monkeypatch.setattr(almacen, "BASE", tmp_path)
    monkeypatch.setattr(almacen, "ESTADOS", tmp_path / "estado.json")


def test_vincular_un_expediente_sube_la_confianza_como_el_cruce_automatico(almacen_temporal):
    p = _prospecto()
    clave = almacen.clave_estable(p.nombre, p.lat, p.lon)
    antes = p.confianza
    f = almacen.vincular_expediente(clave, vital.interpretar(FILA_VITAL).as_dict(), nombre=p.nombre, lat=p.lat, lon=p.lon)
    assert f.expedientes[0]["expediente"] == "VDA-00020-24"
    assert "vinculado desde el buscador" in f.historial[-1]["nota"]
    (con,) = almacen.aplicar_expedientes([p])
    assert any(r.fuente == "vital" and r.identificador == "VDA-00020-24" for r in con.referencias)
    assert con.confianza > antes
    # Vincular dos veces el mismo no duplica; desvincular lo quita.
    almacen.vincular_expediente(clave, vital.interpretar(FILA_VITAL).as_dict())
    assert len(almacen.cargar_fichas()[clave].expedientes) == 1
    almacen.desvincular_expediente(clave, "VDA-00020-24")
    assert almacen.cargar_fichas()[clave].expedientes == []
    with pytest.raises(KeyError):
        almacen.desvincular_expediente(clave, "VDA-00020-24")


def test_un_registro_sin_identificador_no_se_vincula(almacen_temporal):
    with pytest.raises(ValueError):
        almacen.vincular_expediente("x", {"titular": "Alguien", "expediente": "", "radicado": ""})


# -- API -------------------------------------------------------------------------

@pytest.fixture(scope="module")
def cliente():
    return TestClient(app)


def test_el_endpoint_de_busqueda_no_sale_a_la_red_en_offline(cliente, tmp_path, monkeypatch):
    monkeypatch.setattr(base, "CACHE", tmp_path)
    d = cliente.get("/api/scout/vital/buscar?q=Yara&modo=offline").json()
    assert d["origen"] == "sin dato" and d["registros"] == []
    assert cliente.get("/api/scout/vital/buscar?q=Yara&modo=inventado").status_code == 422


def test_vincular_por_api_exige_un_prospecto_del_barrido(cliente, almacen_temporal):
    r = cliente.post("/api/scout/vital/vincular", json={"clave": "no-existe", "registro": FILA_VITAL})
    assert r.status_code == 422
    b = cliente.get("/api/scout/barrido").json()
    if b["prospectos"]:
        clave = b["prospectos"][0]["clave"]
        r = cliente.post("/api/scout/vital/vincular", json={
            "clave": clave, "registro": vital.interpretar(FILA_VITAL).as_dict()})
        assert r.status_code == 200 and r.json()["expedientes"][0]["expediente"] == "VDA-00020-24"
        p = next(x for x in cliente.get("/api/scout/barrido").json()["prospectos"] if x["clave"] == clave)
        assert any(ref["fuente"] == "vital" and ref["identificador"] == "VDA-00020-24" for ref in p["referencias"])
        assert cliente.post("/api/scout/vital/desvincular", json={"clave": clave, "identificador": "VDA-00020-24"}).status_code == 200
        assert cliente.post("/api/scout/vital/desvincular", json={"clave": clave, "identificador": "VDA-00020-24"}).status_code == 404
