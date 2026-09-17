"""Cartera de empresas: marcado, calidad declarada y documentos del expediente."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from simbia.domain.water_chem import Calidad
from simbia.main import app
from simbia.scout import almacen
from simbia.scout.perfil import Estado, Metodo, Prospecto


def _prospecto(**kw) -> Prospecto:
    base = dict(
        codigo="P01", nombre="Empresa X", sector="Sector", ciiu="2011", corriente="Rechazo",
        lat=10.32, lon=-75.50, distancia_linea_km=1.0, distancia_conduccion_km=1.4,
        caudal_m3_h=30.0, calidad=Calidad(dqo=200.0, tds=900.0),
    )
    base.update(kw)
    return Prospecto(**base)


@pytest.fixture
def almacen_temporal(tmp_path, monkeypatch):
    monkeypatch.setattr(almacen, "BASE", tmp_path)
    monkeypatch.setattr(almacen, "ESTADOS", tmp_path / "estado.json")


def test_entrar_en_cartera_a_mano_y_por_trabajo(almacen_temporal):
    f = almacen.actualizar_ficha("a", nombre="A", en_cartera=True)
    assert f.en_cartera and almacen.cargar_fichas()["a"].en_cartera
    f = almacen.actualizar_ficha("a", en_cartera=False)
    assert not f.en_cartera
    # Mover de etapa es elegirla; volver a 'detectado' no la saca.
    assert almacen.actualizar_ficha("b", estado=Estado.CONTACTADO, nombre="B").en_cartera
    assert almacen.actualizar_ficha("b", estado=Estado.DETECTADO).en_cartera
    # Vincular un expediente o guardar un documento tambien.
    assert almacen.vincular_expediente("c", {"expediente": "E-1", "titular": "C"}, nombre="C").en_cartera
    assert almacen.anotar_documento("d", {"nombre": "x.pdf", "ruta": "expedientes/1/x.pdf"}, nombre="D").en_cartera


def test_una_ficha_antigua_con_trabajo_entra_sola_en_cartera(almacen_temporal, tmp_path):
    import json
    (tmp_path / "estado.json").write_text(json.dumps({
        "vieja": {"estado": "contactado", "responsable": "X", "historial": [], "actualizado": ""},
        "sin-trabajo": {"estado": "detectado", "historial": [], "actualizado": ""},
        "explicita": {"estado": "contactado", "historial": [], "actualizado": "", "en_cartera": False},
    }))
    f = almacen.cargar_fichas()
    assert f["vieja"].en_cartera and not f["sin-trabajo"].en_cartera and not f["explicita"].en_cartera


def test_la_calidad_declarada_pasa_el_prospecto_a_declarado(almacen_temporal):
    p = _prospecto()
    clave = almacen.clave_estable(p.nombre, p.lat, p.lon)
    antes = p.confianza
    f = almacen.declarar_calidad(
        clave, {"dqo": 45.0, "sst": 12.0, "parametro_inventado": 1.0, "tds": -5.0},
        caudal_m3_h=18.5, fuente="Solicitud renovacion.pdf", nombre=p.nombre, lat=p.lat, lon=p.lon,
    )
    assert f.calidad_declarada == {"dqo": 45.0, "sst": 12.0}     # ni inventados ni negativos
    assert f.caudal_declarado_m3_h == 18.5 and f.en_cartera
    assert "calidad declarada" in f.historial[-1]["nota"]
    (q,) = almacen.aplicar_expedientes([p])
    assert q.calidad.dqo == 45.0 and q.calidad.sst == 12.0 and q.calidad.tds == 900.0
    assert q.caudal_m3_h == 18.5
    assert q.metodo_calidad is Metodo.DECLARADO and q.metodo_caudal is Metodo.DECLARADO
    assert q.campos_medidos >= {"dqo", "sst"}
    assert q.confianza > antes
    assert any(r.fuente == "expediente" for r in q.referencias)
    # Una analitica medida no se degrada a declarada.
    medido = _prospecto(metodo_calidad=Metodo.MEDIDO)
    (m,) = almacen.aplicar_expedientes([medido])
    assert m.metodo_calidad is Metodo.MEDIDO and m.calidad.dqo == 45.0


def test_declarar_nada_se_rechaza(almacen_temporal):
    with pytest.raises(ValueError):
        almacen.declarar_calidad("x", {"inventado": 3}, None, "doc")


# -- API -------------------------------------------------------------------------

@pytest.fixture(scope="module")
def cliente():
    return TestClient(app)


def test_la_cartera_solo_lista_lo_marcado(cliente, almacen_temporal):
    from simbia.api import scout as api_scout
    api_scout._invalidar()
    assert cliente.get("/api/scout/cartera").json()["empresas"] == []
    b = cliente.get("/api/scout/barrido").json()
    if not b["prospectos"]:
        return
    clave = b["prospectos"][0]["clave"]
    r = cliente.post("/api/scout/ficha", json={"clave": clave, "en_cartera": True})
    assert r.status_code == 200 and r.json()["en_cartera"] is True
    c = cliente.get("/api/scout/cartera").json()
    assert [e["clave"] for e in c["empresas"]] == [clave]
    assert "extraccion_ia" in c
    # Declarar por API y verlo reflejado en el barrido.
    r = cliente.post("/api/scout/declarar", json={"clave": clave, "calidad": {"dqo": 33.0}, "caudal_m3_h": 12.0, "fuente": "prueba"})
    assert r.status_code == 200
    p = next(x for x in cliente.get("/api/scout/barrido").json()["prospectos"] if x["clave"] == clave)
    assert p["calidad"]["dqo"] == 33.0 and p["caudal_m3_h"] == 12.0 and p["metodo_calidad"] == "declarado"
    assert cliente.post("/api/scout/declarar", json={"clave": "no-existe", "calidad": {"dqo": 1}}).status_code == 422
    cliente.post("/api/scout/ficha", json={"clave": clave, "en_cartera": False})
    assert cliente.get("/api/scout/cartera").json()["empresas"] == []


def test_los_archivos_del_expediente_no_salen_de_su_carpeta(cliente, tmp_path, monkeypatch):
    from simbia.api import scout as api_scout
    monkeypatch.setattr(api_scout, "EXPEDIENTES", tmp_path / "expedientes")
    (tmp_path / "expedientes" / "123").mkdir(parents=True)
    (tmp_path / "expedientes" / "123" / "a.pdf").write_bytes(b"%PDF-1.4 prueba")
    (tmp_path / "secreto.txt").write_text("no")
    r = cliente.get("/api/scout/expediente/archivo?ruta=expedientes/123/a.pdf")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/pdf")
    assert r.headers["content-disposition"].startswith("inline")
    assert cliente.get("/api/scout/expediente/archivo?ruta=123/a.pdf").status_code == 200
    assert cliente.get("/api/scout/expediente/archivo?ruta=../secreto.txt").status_code == 404
    assert cliente.get("/api/scout/expediente/archivo?ruta=expedientes/../secreto.txt").status_code == 404
    assert cliente.get("/api/scout/expediente/archivo?ruta=expedientes/123/no.pdf").status_code == 404
    r = cliente.post("/api/scout/expediente/leer", json={"ruta": "expedientes/123/a.pdf"})
    assert r.status_code in (503, 200)    # 503 sin IA configurada
