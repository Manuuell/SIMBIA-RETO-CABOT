"""Asistente: proveedor, contexto, historial, resumenes y API (sin red)."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from simbia import asistente, ia
from simbia.main import app
from simbia.scout.fuentes import base


@pytest.fixture
def sin_ia(monkeypatch):
    for v in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"):
        monkeypatch.delenv(v, raising=False)


@pytest.fixture
def con_openai(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-prueba")
    monkeypatch.delenv("SIMBIA_IA_MODELO", raising=False)


def test_sin_clave_no_hay_proveedor(sin_ia):
    assert ia.proveedor() is None
    ok, motivo = ia.disponible()
    assert not ok and "OPENAI_API_KEY" in motivo


def test_openai_tiene_prioridad_y_voz(con_openai, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "tambien")
    p = ia.proveedor()
    assert p.nombre == "openai" and p.tiene_voz and p.modelo == ia.MODELO_OPENAI
    monkeypatch.setenv("SIMBIA_IA_MODELO", "gpt-x")
    assert ia.proveedor().modelo == "gpt-x"


def test_la_voz_recorta_textos_largos(con_openai, monkeypatch):
    capturado = {}

    class Voz:
        def create(self, **kw):
            capturado.update(kw)
            class R: content = b"ID3mp3"
            return R()

    class Cliente:
        def __init__(self, *a, **k): self.audio = type("A", (), {"speech": Voz()})()
    import openai
    monkeypatch.setattr(openai, "OpenAI", Cliente)
    assert ia.sintetizar_voz("x" * 5000) == b"ID3mp3"
    assert len(capturado["input"]) <= ia.MAX_TEXTO_VOZ + 1 and capturado["voice"] == "nova"
    with pytest.raises(ValueError):
        ia.sintetizar_voz("   ")


# -- contexto e historial -----------------------------------------------------------

def _barrido():
    return {
        "modo": "offline", "radio_km": 8,
        "resumen": {"detectados": 2, "viables": 2, "caudal_total_m3_h": 100},
        "prospectos": [
            {"clave": "a", "nombre": "Alfa S.A.", "sector": "Quimica", "corriente": "Rechazo", "caudal_m3_h": 40,
             "distancia_conduccion_km": 1.2, "puntaje": 60, "detalle_puntaje": {}, "confianza": 0.71,
             "confianza_etiqueta": "media", "metodo_calidad": "declarado", "metodo_caudal": "inferido",
             "campos_medidos": [], "limitante": "salinidad", "notas": "Trazado | Plan: T1 al 30%",
             "calidad": {"tds": 900}, "indices": {"lsi": 0.1}, "referencias": [{"fuente": "vital", "identificador": "E-1", "descripcion": "Vertimiento ante EPA"}],
             "ficha": {"en_cartera": True, "estado": "contactado", "responsable": "Ana", "historial": [{"de": "detectado", "a": "contactado", "fecha": "2026-09-16"}],
                       "documentos": [{"nombre": "doc.pdf", "ruta": "expedientes/1/doc.pdf", "radicado": "1"}]}},
            {"clave": "b", "nombre": "Beta Ltda", "sector": "Alimentos", "corriente": "Lavado", "caudal_m3_h": 60,
             "distancia_conduccion_km": 3.0, "puntaje": 20, "detalle_puntaje": {}, "confianza": 0.45,
             "confianza_etiqueta": "baja", "metodo_calidad": "inferido", "metodo_caudal": "inferido",
             "campos_medidos": [], "limitante": "DQO", "notas": "Trazado", "calidad": {"tds": 300}, "indices": {}, "referencias": [], "ficha": None},
        ],
    }


def test_el_contexto_separa_cartera_y_resto_y_recoge_resumenes(tmp_path):
    exp = tmp_path / "expedientes"; (exp / "1").mkdir(parents=True)
    (exp / "1" / "doc.pdf").write_bytes(b"%PDF-")
    asistente.ruta_resumen(exp / "1" / "doc.pdf").write_text(json.dumps({"titulo": "Permiso", "resumen": "Todo bien"}), encoding="utf-8")
    c = asistente.construir_contexto({"ahorro_pct": 0.38}, _barrido(), exp, modulo="empresas", clave="a")
    assert [p["empresa"] for p in c.cartera] == ["Alfa S.A."] and [p["empresa"] for p in c.prospectos] == ["Beta Ltda"]
    assert c.cartera[0]["expedientes_vital"][0]["identificador"] == "E-1"
    assert c.cartera[0]["plan"] == "Plan: T1 al 30%" and c.cartera[0]["etapa"] == "contactado"
    assert c.documentos[0]["resumen"]["titulo"] == "Permiso" and c.empresa_en_pantalla == "Alfa S.A."
    texto = c.texto()
    assert "Alfa S.A." in texto and '"ahorro_pct": 0.38' in texto


def test_sin_resumen_el_contexto_lo_dice(tmp_path):
    c = asistente.construir_contexto({}, _barrido(), tmp_path / "expedientes")
    assert isinstance(c.documentos[0]["resumen"], str) and "sin resumen" in c.documentos[0]["resumen"]


def test_el_historial_se_recorta_y_normaliza():
    h = [{"rol": "usuario", "contenido": f"m{i}"} for i in range(30)] + [{"rol": "raro", "contenido": "x"}, {"rol": "asistente", "contenido": "  "}]
    r = asistente.recortar_historial(h)
    assert len(r) == asistente.MAX_HISTORIAL and r[-1] == {"rol": "usuario", "contenido": "x"}


def test_responder_lleva_contexto_e_historial_al_proveedor(con_openai, monkeypatch, tmp_path):
    capturado = {}
    def falso(instrucciones, mensajes, max_tokens=900, adjuntos_pdf=None):
        capturado.update(instrucciones=instrucciones, mensajes=mensajes)
        return "  Alfa es la mejor opcion.  "
    monkeypatch.setattr(ia, "conversar", falso)
    c = asistente.construir_contexto({}, _barrido(), tmp_path)
    r = asistente.responder("¿A quien visito primero?", [{"rol": "usuario", "contenido": "hola"}, {"rol": "asistente", "contenido": "buenas"}], c)
    assert r == "Alfa es la mejor opcion."
    assert "CONTEXTO" in capturado["instrucciones"] and "Alfa S.A." in capturado["instrucciones"]
    assert [m["rol"] for m in capturado["mensajes"]] == ["usuario", "asistente", "usuario"]
    with pytest.raises(ValueError):
        asistente.responder("   ", [], c)


def test_el_resumen_se_genera_una_vez_y_se_cachea(con_openai, monkeypatch, tmp_path):
    llamadas = []
    def falso(ruta, instrucciones, peticion, esquema):
        llamadas.append(ruta)
        return asistente.ResumenDocumento(titulo="T", resumen="R", puntos_clave=["a"], confianza=0.9,
                                          parametros_agua=[asistente.ParametroAgua(nombre="DQO", valor=45.0, unidad="mg/L")], caudal_m3_h=None)
    monkeypatch.setattr(ia, "estructurar_pdf", falso)
    pdf = tmp_path / "x.pdf"; pdf.write_bytes(b"%PDF-")
    r1 = asistente.resumir_documento(pdf); r2 = asistente.resumir_documento(pdf)
    assert r1["titulo"] == "T" and r2 == r1 and len(llamadas) == 1
    assert r1["parametros_agua"] == {"dqo": 45.0}
    asistente.resumir_documento(pdf, forzar=True)
    assert len(llamadas) == 2 and asistente.ruta_resumen(pdf).is_file()


# -- API -------------------------------------------------------------------------------

@pytest.fixture(scope="module")
def cliente():
    return TestClient(app)


def test_sin_ia_los_endpoints_lo_dicen(cliente, sin_ia):
    assert cliente.get("/api/asistente/estado").json()["disponible"] is False
    assert cliente.post("/api/asistente/preguntar", json={"mensaje": "hola"}).status_code == 503
    assert cliente.post("/api/asistente/voz", json={"texto": "hola"}).status_code == 503


def test_preguntar_por_api_con_proveedor_simulado(cliente, con_openai, monkeypatch, tmp_path):
    monkeypatch.setattr(base, "CACHE", tmp_path)
    monkeypatch.setattr(ia, "conversar", lambda instrucciones, mensajes, max_tokens=900, adjuntos_pdf=None: "Respuesta de prueba")
    d = cliente.get("/api/asistente/estado").json()
    assert d["disponible"] and d["proveedor"] == "openai" and d["voz"]
    r = cliente.post("/api/asistente/preguntar", json={"mensaje": "¿Que tenemos?", "modulo": "inicio"})
    assert r.status_code == 200 and r.json()["respuesta"] == "Respuesta de prueba"
    assert "contexto" in r.json()
    monkeypatch.setattr(ia, "sintetizar_voz", lambda texto: b"ID3audio")
    r = cliente.post("/api/asistente/voz", json={"texto": "hola"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("audio/mpeg") and r.content == b"ID3audio"
