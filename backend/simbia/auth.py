"""Autenticacion de la aplicacion.

Usuarios con contrasena scrypt y sesion en una cookie firmada. Es el mismo
patron que el panel de SentraDNS, en Python y sin dependencias nuevas:

- La contrasena no existe en claro en ningun sitio. Se guarda su hash scrypt
  (con sal) en variables de entorno que systemd lee de un fichero 600 de
  root. `python -m simbia.auth hash` genera el hash leyendo la contrasena por
  stdin, para que no pase por la linea de comandos ni por el historial.
- El usuario principal va en SIMBIA_AUTH_USUARIO + SIMBIA_AUTH_HASH. Los
  demas, en SIMBIA_AUTH_USUARIOS como entradas `usuario:hash` separadas por
  coma o punto y coma. Todos entran con los mismos permisos.
- La sesion es un token `usuario|expira|firma` con HMAC-SHA256 sobre un
  secreto del servidor (SIMBIA_AUTH_SECRETO). No hay estado de sesion en el
  servidor: reiniciar no cierra sesiones, cambiar el secreto las cierra todas.
- Cinco fallos seguidos desde una IP bloquean esa IP quince minutos.

La autenticacion esta ACTIVA solo si hay algun usuario definido. Sin ninguno
(desarrollo local, pruebas) la aplicacion queda abierta y lo dice en el log.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import os
import re
import secrets
import sys
import time
from dataclasses import dataclass
from types import MappingProxyType
from typing import Mapping
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from pydantic import BaseModel

log = logging.getLogger("simbia.auth")

COOKIE = "simbia_sesion"
DURACION_S = 12 * 3600
MAX_INTENTOS = 5
BLOQUEO_S = 15 * 60

#: Lo unico que se puede pedir sin sesion: la pagina de acceso, lo que ella
#: necesita para pintarse, los endpoints de entrar/salir y la salud.
RUTAS_LIBRES = frozenset({
    "/acceso", "/acceso.js", "/estilos.css", "/api/acceso", "/api/salir",
    "/api/sesion", "/salud",
    # La landing es publica: es la puerta de entrada al proyecto.
    "/", "/index.html", "/landing.css", "/landing.js", "/torre3d.js",
})
#: Carpetas publicas: las imagenes de la landing y three.js, que dibuja la
#: torre del hero. Ninguna sirve datos de la aplicacion.
PREFIJOS_LIBRES = ("/landing/", "/vendor/")
#: A donde se entra despues de identificarse.
PANEL = "/app"

_SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1, "dklen": 64}


# --------------------------------------------------------------------------
# Configuracion
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Config:
    #: usuario (en minusculas) -> hash scrypt de su contrasena.
    usuarios: Mapping[str, str]
    secreto: str


def _usuarios_del_entorno() -> dict[str, str]:
    """El principal (SIMBIA_AUTH_USUARIO/HASH) mas los de SIMBIA_AUTH_USUARIOS."""
    usuarios: dict[str, str] = {}
    hash_principal = os.environ.get("SIMBIA_AUTH_HASH", "").strip()
    if hash_principal:
        principal = os.environ.get("SIMBIA_AUTH_USUARIO", "").strip().lower()
        if not principal:
            raise RuntimeError("SIMBIA_AUTH_HASH esta definida pero falta SIMBIA_AUTH_USUARIO.")
        usuarios[principal] = hash_principal
    for entrada in re.split(r"[,;\s]+", os.environ.get("SIMBIA_AUTH_USUARIOS", "").strip()):
        if not entrada:
            continue
        usuario, separador, hash_clave = entrada.partition(":")
        usuario = usuario.strip().lower()
        if not separador or not usuario or not hash_clave.startswith("scrypt$"):
            raise RuntimeError(
                "SIMBIA_AUTH_USUARIOS: cada entrada es usuario:hash, separadas por "
                "coma (el hash sale de `python -m simbia.auth hash usuario`)."
            )
        usuarios[usuario] = hash_clave.strip()
    return usuarios


def config() -> Config | None:
    """None si la autenticacion no esta configurada (aplicacion abierta)."""
    usuarios = _usuarios_del_entorno()
    if not usuarios:
        return None
    secreto = os.environ.get("SIMBIA_AUTH_SECRETO", "").strip()
    if len(secreto) < 32:
        raise RuntimeError(
            "Hay usuarios definidos pero falta SIMBIA_AUTH_SECRETO "
            "(minimo 32 caracteres; openssl rand -hex 32)."
        )
    return Config(MappingProxyType(usuarios), secreto)


# --------------------------------------------------------------------------
# Contrasena
# --------------------------------------------------------------------------

def hashear(clave: str) -> str:
    sal = secrets.token_bytes(16)
    derivada = hashlib.scrypt(clave.encode("utf-8"), salt=sal, **_SCRYPT)
    return f"scrypt${sal.hex()}${derivada.hex()}"


def verificar(clave: str, almacenado: str) -> bool:
    try:
        esquema, sal_hex, hash_hex = almacenado.split("$")
        if esquema != "scrypt":
            return False
        derivada = hashlib.scrypt(
            clave.encode("utf-8"), salt=bytes.fromhex(sal_hex), **_SCRYPT,
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(derivada.hex(), hash_hex)


# --------------------------------------------------------------------------
# Sesion
# --------------------------------------------------------------------------

def _firma(secreto: str, carga: str) -> str:
    return hmac.new(secreto.encode("utf-8"), carga.encode("utf-8"), hashlib.sha256).hexdigest()


def emitir_token(cfg: Config, usuario: str, ahora: float | None = None) -> str:
    expira = int((time.time() if ahora is None else ahora) + DURACION_S)
    carga = f"{usuario}|{expira}"
    return base64.urlsafe_b64encode(f"{carga}|{_firma(cfg.secreto, carga)}".encode("utf-8")).decode("ascii")


def usuario_del_token(cfg: Config, token: str | None, ahora: float | None = None) -> str | None:
    """Usuario de un token valido, o None si esta manipulado, caducado o no es suyo."""
    if not token:
        return None
    try:
        usuario, expira, firma = base64.urlsafe_b64decode(token.encode("ascii")).decode("utf-8").rsplit("|", 2)
        expira_en = int(expira)
    except (ValueError, UnicodeDecodeError):
        return None
    if not hmac.compare_digest(firma, _firma(cfg.secreto, f"{usuario}|{expira}")):
        return None
    if expira_en < (time.time() if ahora is None else ahora):
        return None
    if usuario not in cfg.usuarios:
        return None
    return usuario


# --------------------------------------------------------------------------
# Limite de intentos
# --------------------------------------------------------------------------

_fallos: dict[str, list[float]] = {}


def _ip(request: Request) -> str:
    return request.client.host if request.client else "desconocida"


def segundos_bloqueado(ip: str, ahora: float | None = None) -> int:
    ahora = time.time() if ahora is None else ahora
    recientes = [t for t in _fallos.get(ip, ()) if ahora - t < BLOQUEO_S]
    _fallos[ip] = recientes
    if len(recientes) < MAX_INTENTOS:
        return 0
    return int(BLOQUEO_S - (ahora - recientes[0])) + 1


def registrar_fallo(ip: str, ahora: float | None = None) -> None:
    _fallos.setdefault(ip, []).append(time.time() if ahora is None else ahora)


def reiniciar_intentos() -> None:
    _fallos.clear()


# --------------------------------------------------------------------------
# Rutas y guardia
# --------------------------------------------------------------------------

class Credenciales(BaseModel):
    usuario: str
    clave: str


def _cookie(respuesta, request: Request, token: str | None) -> None:
    seguro = request.url.scheme == "https"
    if token is None:
        respuesta.delete_cookie(COOKIE, path="/", httponly=True, samesite="lax", secure=seguro)
    else:
        respuesta.set_cookie(
            COOKIE, token, max_age=DURACION_S, path="/",
            httponly=True, samesite="lax", secure=seguro,
        )


def _destino_seguro(siguiente: str | None) -> str:
    """Solo rutas relativas de esta aplicacion: nada de redirigir fuera."""
    if siguiente and siguiente.startswith("/") and not siguiente.startswith("//"):
        return siguiente
    return PANEL


def instalar(app: FastAPI, web: Path) -> None:
    """Registra las rutas de acceso y la guardia sobre todo lo demas."""
    router = APIRouter()

    @router.get("/acceso", include_in_schema=False)
    def pagina_acceso(request: Request):
        cfg = config()
        if cfg is None or usuario_del_token(cfg, request.cookies.get(COOKIE)):
            return RedirectResponse(_destino_seguro(request.query_params.get("siguiente")), status_code=303)
        return FileResponse(web / "acceso.html")

    @router.get("/api/sesion")
    def sesion(request: Request) -> dict:
        cfg = config()
        if cfg is None:
            return {"autenticacion": False, "usuario": None}
        return {"autenticacion": True, "usuario": usuario_del_token(cfg, request.cookies.get(COOKIE))}

    @router.post("/api/acceso")
    def entrar(credenciales: Credenciales, request: Request):
        cfg = config()
        if cfg is None:
            return JSONResponse({"detail": "La autenticacion no esta configurada"}, status_code=404)
        ip = _ip(request)
        espera = segundos_bloqueado(ip)
        if espera:
            return JSONResponse(
                {"detail": f"Demasiados intentos. Espera {espera // 60 + 1} min."},
                status_code=429, headers={"Retry-After": str(espera)},
            )
        usuario = credenciales.usuario.strip().lower()
        # Se verifica siempre un hash, aunque el usuario no exista, para que
        # el tiempo de respuesta no delate que usuarios hay.
        almacenado = cfg.usuarios.get(usuario) or next(iter(cfg.usuarios.values()))
        correcta = verificar(credenciales.clave, almacenado)
        if usuario not in cfg.usuarios or not correcta:
            registrar_fallo(ip)
            log.warning("acceso fallido desde %s", ip)
            return JSONResponse({"detail": "Usuario o contrasena incorrectos"}, status_code=401)
        _fallos.pop(ip, None)
        respuesta = JSONResponse({"usuario": usuario})
        _cookie(respuesta, request, emitir_token(cfg, usuario))
        log.info("sesion iniciada por %s desde %s", usuario, ip)
        return respuesta

    @router.post("/api/salir")
    def salir(request: Request):
        respuesta = JSONResponse({"ok": True})
        _cookie(respuesta, request, None)
        return respuesta

    app.include_router(router)

    @app.middleware("http")
    async def guardia(request: Request, call_next):
        cfg = config()
        ruta = request.url.path
        if cfg is None or ruta in RUTAS_LIBRES or ruta.startswith(PREFIJOS_LIBRES):
            return await call_next(request)
        if usuario_del_token(cfg, request.cookies.get(COOKIE)):
            return await call_next(request)
        if ruta.startswith(("/api/", "/openapi", "/docs", "/redoc")):
            return JSONResponse({"detail": "Sesion requerida"}, status_code=401)
        destino = ruta + (f"?{request.url.query}" if request.url.query else "")
        siguiente = f"?siguiente={quote(destino, safe='/#?=&')}" if destino != PANEL else ""
        return RedirectResponse(f"/acceso{siguiente}", status_code=303)

    cfg = config()
    if cfg is None:
        log.warning("sin usuarios definidos: la aplicacion queda ABIERTA sin autenticacion")
    else:
        log.info("autenticacion activa para %d usuario(s)", len(cfg.usuarios))


# --------------------------------------------------------------------------
# Utilidad de linea de comandos
# --------------------------------------------------------------------------

def _main(argv: list[str]) -> int:
    """`hash` imprime el hash; `hash usuario` imprime `usuario:hash`, listo
    para SIMBIA_AUTH_USUARIOS."""
    if argv[1:2] != ["hash"] or len(argv) > 3:
        print("uso: python -m simbia.auth hash [usuario]   (lee la contrasena por stdin o la pide)", file=sys.stderr)
        return 2
    usuario = argv[2].strip().lower() if len(argv) == 3 else ""
    if sys.stdin.isatty():
        import getpass
        clave = getpass.getpass("Contrasena: ")
        if getpass.getpass("Repite la contrasena: ") != clave:
            print("No coinciden.", file=sys.stderr)
            return 1
    else:
        clave = sys.stdin.read().rstrip("\r\n")
    if len(clave) < 12:
        print("La contrasena debe tener al menos 12 caracteres.", file=sys.stderr)
        return 1
    print(f"{usuario}:{hashear(clave)}" if usuario else hashear(clave))
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv))
