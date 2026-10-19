"""Autenticacion: hash, sesion firmada, guardia y limite de intentos."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from simbia import auth
from simbia.main import app

USUARIO = "prueba@ejemplo.co"
CLAVE = "una-contrasena-larga-1"
SEGUNDO = "segundo@ejemplo.co"
CLAVE_SEGUNDO = "otra-contrasena-larga-2"
SECRETO = "s" * 48


@pytest.fixture
def protegida(monkeypatch, tmp_path):
    """Aplicacion con la autenticacion activa: un principal y uno mas."""
    monkeypatch.setenv("SIMBIA_AUTH_USUARIO", USUARIO)
    monkeypatch.setenv("SIMBIA_AUTH_HASH", auth.hashear(CLAVE))
    monkeypatch.setenv("SIMBIA_AUTH_USUARIOS", f"{SEGUNDO}:{auth.hashear(CLAVE_SEGUNDO)}")
    monkeypatch.setenv("SIMBIA_AUTH_SECRETO", SECRETO)
    monkeypatch.setenv("SIMBIA_AUTH_ADMIN", USUARIO)
    monkeypatch.setenv("SIMBIA_AUTH_USUARIOS_ARCHIVO", str(tmp_path / "usuarios.json"))
    auth.reiniciar_intentos()
    return TestClient(app)


@pytest.fixture
def abierta(monkeypatch):
    for v in (
        "SIMBIA_AUTH_USUARIO", "SIMBIA_AUTH_HASH", "SIMBIA_AUTH_USUARIOS",
        "SIMBIA_AUTH_SECRETO", "SIMBIA_AUTH_ADMIN", "SIMBIA_AUTH_USUARIOS_ARCHIVO",
    ):
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
    cfg = auth.Config({USUARIO: "x"}, SECRETO)
    token = auth.emitir_token(cfg, USUARIO)
    assert auth.usuario_del_token(cfg, token) == USUARIO
    assert auth.usuario_del_token(cfg, token[:-4] + "AAAA") is None
    assert auth.usuario_del_token(cfg, None) is None
    assert auth.usuario_del_token(cfg, "no-es-base64!") is None
    # Otro secreto invalida todas las sesiones.
    assert auth.usuario_del_token(auth.Config({USUARIO: "x"}, "t" * 48), token) is None
    # Un usuario dado de baja deja de entrar aunque su token siga firmado.
    assert auth.usuario_del_token(auth.Config({SEGUNDO: "x"}, SECRETO), token) is None


def test_el_token_caduca():
    cfg = auth.Config({USUARIO: "x"}, SECRETO)
    token = auth.emitir_token(cfg, USUARIO, ahora=1_000_000.0)
    assert auth.usuario_del_token(cfg, token, ahora=1_000_000.0 + auth.DURACION_S - 1)
    assert auth.usuario_del_token(cfg, token, ahora=1_000_000.0 + auth.DURACION_S + 1) is None


# -- guardia ----------------------------------------------------------------

def test_sin_configurar_la_aplicacion_queda_abierta(abierta):
    assert abierta.get("/api/escenario").status_code == 200
    assert abierta.get("/api/sesion").json() == {
        "autenticacion": False, "usuario": None, "administrador": False,
    }
    assert abierta.get("/acceso", follow_redirects=False).status_code == 303


def test_sin_sesion_el_html_redirige_y_la_api_devuelve_401(protegida):
    r = protegida.get("/app", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"] == "/acceso"
    # La landing y lo que necesita para dibujarse son publicos.
    assert protegida.get("/").status_code == 200
    assert protegida.get("/landing.css").status_code == 200
    assert protegida.get("/vendor/three/three.module.min.js").status_code == 200
    assert protegida.get("/app.js", follow_redirects=False).status_code == 303
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
    sesion = protegida.get("/api/sesion").json()
    assert sesion["usuario"] == USUARIO and sesion["administrador"] is True
    assert protegida.get("/acceso", follow_redirects=False).status_code == 303
    protegida.post("/api/salir")
    assert protegida.get("/api/escenario").status_code == 401


def test_el_segundo_usuario_entra_con_su_propia_contrasena(protegida):
    r = protegida.post("/api/acceso", json={"usuario": SEGUNDO, "clave": CLAVE_SEGUNDO})
    assert r.status_code == 200 and r.json()["usuario"] == SEGUNDO
    sesion = protegida.get("/api/sesion").json()
    assert sesion["usuario"] == SEGUNDO and sesion["administrador"] is False
    protegida.post("/api/salir")
    # Las contrasenas no se cruzan entre usuarios.
    assert protegida.post("/api/acceso", json={"usuario": SEGUNDO, "clave": CLAVE}).status_code == 401
    assert protegida.post("/api/acceso", json={"usuario": USUARIO, "clave": CLAVE_SEGUNDO}).status_code == 401


def test_usuarios_del_entorno(monkeypatch):
    for v in ("SIMBIA_AUTH_USUARIO", "SIMBIA_AUTH_HASH", "SIMBIA_AUTH_USUARIOS"):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setenv("SIMBIA_AUTH_SECRETO", SECRETO)
    assert auth.config() is None
    # Solo SIMBIA_AUTH_USUARIOS, sin principal, tambien activa la autenticacion.
    monkeypatch.setenv("SIMBIA_AUTH_USUARIOS", " Uno@X.co:scrypt$a$b ; dos@x.co:scrypt$c$d ")
    assert dict(auth.config().usuarios) == {"uno@x.co": "scrypt$a$b", "dos@x.co": "scrypt$c$d"}
    monkeypatch.setenv("SIMBIA_AUTH_USUARIOS", "sin-hash@x.co")
    with pytest.raises(RuntimeError):
        auth.config()
    monkeypatch.setenv("SIMBIA_AUTH_USUARIOS", "")
    monkeypatch.setenv("SIMBIA_AUTH_HASH", "scrypt$a$b")
    with pytest.raises(RuntimeError):
        auth.config()  # hash sin usuario principal


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
    assert auth._destino_seguro("//malo.com") == "/app"
    assert auth._destino_seguro("https://malo.com") == "/app"
    assert auth._destino_seguro(None) == "/app"


# -- administracion de usuarios ---------------------------------------------

def _entrar_admin(cliente):
    r = cliente.post("/api/acceso", json={"usuario": USUARIO, "clave": CLAVE})
    assert r.status_code == 200


def test_el_administrador_crea_y_desactiva_usuarios(protegida):
    _entrar_admin(protegida)
    tercero = "nuevo@ejemplo.co"
    clave = "clave-temporal-segura-3"
    r = protegida.post("/api/admin/usuarios", json={
        "usuario": tercero, "nombre": "Persona Nueva", "clave": clave,
    })
    assert r.status_code == 201
    lista = protegida.get("/api/admin/usuarios").json()["usuarios"]
    assert any(u["usuario"] == tercero and u["gestionable"] for u in lista)

    protegida.post("/api/salir")
    assert protegida.post("/api/acceso", json={"usuario": tercero, "clave": clave}).status_code == 200
    protegida.post("/api/salir")
    _entrar_admin(protegida)
    assert protegida.post("/api/admin/usuarios/estado", json={
        "usuario": tercero, "activo": False,
    }).status_code == 200
    protegida.post("/api/salir")
    assert protegida.post("/api/acceso", json={"usuario": tercero, "clave": clave}).status_code == 401


def test_cambiar_clave_invalida_la_sesion_anterior(protegida):
    _entrar_admin(protegida)
    tercero = "cambio@ejemplo.co"
    vieja = "clave-temporal-segura-4"
    nueva = "clave-temporal-segura-5"
    protegida.post("/api/admin/usuarios", json={"usuario": tercero, "clave": vieja})
    protegida.post("/api/salir")
    protegida.post("/api/acceso", json={"usuario": tercero, "clave": vieja})
    token_viejo = protegida.cookies.get(auth.COOKIE)
    protegida.post("/api/salir")
    _entrar_admin(protegida)
    assert protegida.post("/api/admin/usuarios/clave", json={
        "usuario": tercero, "clave": nueva,
    }).status_code == 200
    protegida.cookies.set(auth.COOKIE, token_viejo)
    assert protegida.get("/api/escenario").status_code == 401
    protegida.cookies.clear()
    assert protegida.post("/api/acceso", json={"usuario": tercero, "clave": vieja}).status_code == 401
    auth.reiniciar_intentos()
    assert protegida.post("/api/acceso", json={"usuario": tercero, "clave": nueva}).status_code == 200


def test_un_usuario_normal_no_puede_administrar(protegida):
    protegida.post("/api/acceso", json={"usuario": SEGUNDO, "clave": CLAVE_SEGUNDO})
    assert protegida.get("/api/admin/usuarios").status_code == 403
    assert protegida.post("/api/admin/usuarios", json={
        "usuario": "intruso@ejemplo.co", "clave": "clave-temporal-segura-6",
    }).status_code == 403


def test_no_se_puede_duplicar_ni_desactivar_al_administrador(protegida):
    _entrar_admin(protegida)
    assert protegida.post("/api/admin/usuarios", json={
        "usuario": USUARIO, "clave": "clave-temporal-segura-7",
    }).status_code == 409
    assert protegida.post("/api/admin/usuarios/estado", json={
        "usuario": USUARIO, "activo": False,
    }).status_code == 409
