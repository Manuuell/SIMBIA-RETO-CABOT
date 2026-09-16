"""Autenticacion: hash, sesion firmada, guardia y limite de intentos."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from simbia import auth
from simbia.main import app

USUARIO = "prueba@ejemplo.co"
CLAVE = "una-contrasena-larga-1"
SECRETO = "s" * 48


@pytest.fixture
def protegida(monkeypatch):
    """Aplicacion con la autenticacion activa."""
    monkeypatch.setenv("SIMBIA_AUTH_USUARIO", USUARIO)
    monkeypatch.setenv("SIMBIA_AUTH_HASH", auth.hashear(CLAVE))
    monkeypatch.setenv("SIMBIA_AUTH_SECRETO", SECRETO)
    auth.reiniciar_intentos()
    return TestClient(app)


@pytest.fixture
def abierta(monkeypatch):
    for v in ("SIMBIA_AUTH_USUARIO", "SIMBIA_AUTH_HASH", "SIMBIA_AUTH_SECRETO"):
        monkeypatch.delenv(v, raising=False)
    return TestClient(app)


# -- contrasena -------------------------------------------------------------

def test_el_hash_no_contiene_la_contrasena_y_verifica():
    h = auth.hashear(CLAVE)
    assert CLAVE not in h and h.startswith("scrypt$")
    assert auth.verificar(CLAVE, h)
    assert not auth.verificar(CLAVE + "x", h)
    assert not auth.verificar(CLAVE, "basura")
    assert auth.hashear(CLAVE) != h, "cada hash lleva su propia sal"


# -- sesion -----------------------------------------------------------------

def test_el_token_se_valida_y_no_se_deja_manipular():
    cfg = auth.Config(USUARIO, "x", SECRETO)
    token = auth.emitir_token(cfg)
    assert auth.usuario_del_token(cfg, token) == USUARIO
    assert auth.usuario_del_token(cfg, token[:-4] + "AAAA") is None
    assert auth.usuario_del_token(cfg, None) is None
    assert auth.usuario_del_token(cfg, "no-es-base64!") is None
    # Otro secreto invalida todas las sesiones.
    assert auth.usuario_del_token(auth.Config(USUARIO, "x", "t" * 48), token) is None


def test_el_token_caduca():
    cfg = auth.Config(USUARIO, "x", SECRETO)
    token = auth.emitir_token(cfg, ahora=1_000_000.0)
    assert auth.usuario_del_token(cfg, token, ahora=1_000_000.0 + auth.DURACION_S - 1)
    assert auth.usuario_del_token(cfg, token, ahora=1_000_000.0 + auth.DURACION_S + 1) is None


# -- guardia ----------------------------------------------------------------

def test_sin_configurar_la_aplicacion_queda_abierta(abierta):
    assert abierta.get("/api/escenario").status_code == 200
    assert abierta.get("/api/sesion").json() == {"autenticacion": False, "usuario": None}
    assert abierta.get("/acceso", follow_redirects=False).status_code == 303


def test_sin_sesion_el_html_redirige_y_la_api_devuelve_401(protegida):
    r = protegida.get("/", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/acceso"
    r = protegida.get("/prospeccion.html", follow_redirects=False)
    assert r.headers["location"].startswith("/acceso?siguiente=")
    assert protegida.get("/api/escenario").status_code == 401
    assert protegida.get("/docs").status_code == 401
    # Lo que la pagina de acceso necesita si esta disponible.
    assert protegida.get("/acceso").status_code == 200
    assert protegida.get("/estilos.css").status_code == 200
    assert protegida.get("/salud").status_code == 200


def test_entrar_salir(protegida):
    r = protegida.post("/api/acceso", json={"usuario": USUARIO.upper(), "clave": CLAVE})
    assert r.status_code == 200 and auth.COOKIE in r.cookies
    assert protegida.get("/api/escenario").status_code == 200
    assert protegida.get("/api/sesion").json()["usuario"] == USUARIO
    assert protegida.get("/acceso", follow_redirects=False).status_code == 303
    protegida.post("/api/salir")
    assert protegida.get("/api/escenario").status_code == 401


def test_credenciales_incorrectas(protegida):
    assert protegida.post("/api/acceso", json={"usuario": USUARIO, "clave": "otra-cosa-larga"}).status_code == 401
    assert protegida.post("/api/acceso", json={"usuario": "otro@x.co", "clave": CLAVE}).status_code == 401
    assert protegida.get("/api/escenario").status_code == 401


def test_cinco_fallos_bloquean_la_ip(protegida):
    for _ in range(auth.MAX_INTENTOS):
        assert protegida.post("/api/acceso", json={"usuario": USUARIO, "clave": "mal-mal-mal-mal"}).status_code == 401
    r = protegida.post("/api/acceso", json={"usuario": USUARIO, "clave": CLAVE})
    assert r.status_code == 429 and "Retry-After" in r.headers
    # Pasado el bloqueo, vuelve a entrar.
    auth.reiniciar_intentos()
    assert protegida.post("/api/acceso", json={"usuario": USUARIO, "clave": CLAVE}).status_code == 200


def test_la_cookie_no_es_legible_por_javascript(protegida):
    r = protegida.post("/api/acceso", json={"usuario": USUARIO, "clave": CLAVE})
    cabecera = r.headers["set-cookie"].lower()
    assert "httponly" in cabecera and "samesite=lax" in cabecera


def test_el_destino_de_vuelta_no_puede_salir_de_la_aplicacion():
    assert auth._destino_seguro("/#datos") == "/#datos"
    assert auth._destino_seguro("//malo.com") == "/"
    assert auth._destino_seguro("https://malo.com") == "/"
    assert auth._destino_seguro(None) == "/"
