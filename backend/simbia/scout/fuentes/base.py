"""Infraestructura comun de las fuentes de datos.

Todas las fuentes comparten cuatro obligaciones, y estan implementadas aqui
una sola vez para que ninguna pueda saltarselas:

1. **robots.txt.** Se consulta y se respeta antes de cualquier peticion HTTP.
   Si el sitio dice que no, la fuente devuelve vacio y lo declara.
2. **Limite de tasa.** Un intervalo minimo entre peticiones por fuente. Estas
   son APIs publicas y gratuitas mantenidas por terceros; saturarlas es a la
   vez maleducado y la forma mas rapida de que te bloqueen.
3. **Cache en disco.** Con TTL. Una consulta repetida no vuelve a salir a la
   red. Ademas es lo que hace posible el modo offline.
4. **Identificacion.** User-Agent con el nombre del proyecto y un contacto,
   para que el administrador del servicio sepa quien le esta consultando.

El modo de operacion se controla con la variable de entorno
`SIMBIA_SCOUT_MODO`:

    offline  (por defecto)  solo fixtures y cache. Nunca sale a la red.
    cache                   usa cache si esta fresca; si no, consulta la red.
    vivo                    consulta siempre la red y refresca la cache.

El valor por defecto es `offline` a proposito: una demostracion no puede
depender de que una API de un tercero este disponible, ni de que haya red.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.robotparser
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

CACHE = Path(__file__).resolve().parent.parent / "archivo" / "cache"
FIXTURES = Path(__file__).resolve().parent.parent / "fixtures"

#: Identificacion en cada peticion. Sustituir el contacto por el real del
#: equipo antes de usarlo contra servicios de terceros en produccion.
USER_AGENT = (
    "SIMBIA/0.2 (simbiosis hidrica industrial; "
    "+https://github.com/reto-cabot/simbia; contacto: equipo@simbia.local)"
)

TIMEOUT_S = 25.0


class Modo(str, Enum):
    OFFLINE = "offline"
    CACHE = "cache"
    VIVO = "vivo"


def ejemplos_activos() -> bool:
    """Si se sirven registros de demostracion cuando no hay dato real.

    Apagado por defecto. Una fuente sin configurar debe decir "no tengo
    dato", no rellenar el hueco con registros inventados: mezclados en la
    misma tabla que los reales, dejan de distinguirse a la primera captura
    de pantalla. Se encienden con `SIMBIA_SCOUT_EJEMPLOS=1` para desarrollar
    o para demostrar el sistema sin ninguna fuente disponible.
    """
    return os.environ.get("SIMBIA_SCOUT_EJEMPLOS", "0").strip() in {"1", "true", "si"}


def modo_actual() -> Modo:
    bruto = os.environ.get("SIMBIA_SCOUT_MODO", "offline").strip().lower()
    try:
        return Modo(bruto)
    except ValueError:
        return Modo.OFFLINE


@dataclass(frozen=True)
class RegistroCrudo:
    """Lo que devuelve una fuente antes de interpretarlo.

    Deliberadamente tonto: identificador, nombre, coordenada y el diccionario
    de atributos tal cual vino. La interpretacion (que arquetipo es, que
    caudal tiene) ocurre despues, en `pipeline.py`, para que se pueda cambiar
    sin volver a consultar la fuente.
    """

    fuente: str
    identificador: str
    nombre: str
    lat: float
    lon: float
    atributos: dict[str, Any] = field(default_factory=dict)
    url: str = ""


@dataclass
class ResultadoFuente:
    """Que devolvio una fuente y en que condiciones. El 'como fue' importa."""

    fuente: str
    registros: list[RegistroCrudo]
    origen: str               # "fixture" | "cache" | "red" | "sin dato"
    consultado: str
    incidencia: str = ""      # vacio si todo fue bien
    #: Cuando el dato sale de la cache, fecha en que se descargo. Es lo que
    #: el usuario necesita saber: "es de hace tres dias" o "de hace un ano".
    fecha_dato: str = ""
    #: Aclaracion que no es un fallo (p. ej. "recortado de 8 km").
    nota: str = ""

    @property
    def ok(self) -> bool:
        return not self.incidencia


# --------------------------------------------------------------------------
# Cache
# --------------------------------------------------------------------------

def _haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    import math
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (
        math.sin((p2 - p1) / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    )
    return 2 * 6371.0088 * math.asin(math.sqrt(a))


def _ruta_cache(fuente: str, clave: str) -> Path:
    h = hashlib.sha256(clave.encode("utf-8")).hexdigest()[:16]
    return CACHE / fuente / f"{h}.json"


def leer_cache_con_fecha(
    fuente: str, clave: str, ttl_horas: float,
) -> tuple[Any | None, str]:
    """(datos, fecha de descarga). Datos None si no hay cache valida."""
    ruta = _ruta_cache(fuente, clave)
    if not ruta.is_file():
        return None, ""
    try:
        envoltorio = json.loads(ruta.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None, ""
    if ttl_horas > 0:
        edad_h = (time.time() - envoltorio.get("guardado_ts", 0)) / 3600.0
        if edad_h > ttl_horas:
            return None, ""
    return envoltorio.get("datos"), str(envoltorio.get("guardado", ""))


def leer_cache(fuente: str, clave: str, ttl_horas: float) -> Any | None:
    return leer_cache_con_fecha(fuente, clave, ttl_horas)[0]


def escribir_cache(
    fuente: str, clave: str, datos: Any, consulta: dict[str, float] | None = None,
) -> None:
    ruta = _ruta_cache(fuente, clave)
    ruta.parent.mkdir(parents=True, exist_ok=True)
    ruta.write_text(
        json.dumps(
            {
                "guardado_ts": time.time(),
                "guardado": datetime.now(timezone.utc).isoformat(),
                "clave": clave,
                #: Centro y radio de la consulta, para poder reutilizar una
                #: descarga mas amplia cuando se pide un radio menor.
                "consulta": consulta or {},
                "datos": datos,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def descargas_en_cache(fuente: str) -> list[dict[str, Any]]:
    """Que consultas de esta fuente hay guardadas: centro, radio y fecha.

    Es lo que el dashboard necesita para decir, antes de lanzar nada, "sin
    red solo puedo servir hasta 8 km".
    """
    carpeta = CACHE / fuente
    if not carpeta.is_dir():
        return []
    salida: list[dict[str, Any]] = []
    for ruta in sorted(carpeta.glob("*.json")):
        try:
            env = json.loads(ruta.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        c = env.get("consulta") or {}
        if not c:
            try:
                lat_c, lon_c, r_c = (
                    float(x) for x in str(env.get("clave", "")).rsplit(":", 1)[-1].split(",")
                )
                c = {"lat": lat_c, "lon": lon_c, "radio_km": r_c}
            except (ValueError, IndexError):
                continue
        salida.append({
            "lat": c["lat"], "lon": c["lon"], "radio_km": c["radio_km"],
            "guardado": str(env.get("guardado", "")),
            "registros": len(env.get("datos") or []),
        })
    return salida


def leer_cache_que_cubra(
    fuente: str, lat: float, lon: float, radio_km: float, ttl_horas: float,
) -> tuple[Any | None, str, float]:
    """Una descarga cacheada del mismo centro cuyo radio cubra al pedido.

    Devuelve (datos, fecha, radio de la descarga). La cache se guarda por
    consulta exacta, asi que pedir 2 km cuando solo se descargaron 8 no
    encuentra nada por clave; pero 2 km es un subconjunto de 8 y no tiene
    sentido decir "sin dato" teniendo el dato. Se elige la descarga valida
    mas ajustada (la de menor radio que aun cubra la peticion).
    """
    carpeta = CACHE / fuente
    if not carpeta.is_dir():
        return None, "", 0.0
    mejor: tuple[float, Any, str] | None = None
    for ruta in carpeta.glob("*.json"):
        try:
            env = json.loads(ruta.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if ttl_horas > 0:
            edad_h = (time.time() - env.get("guardado_ts", 0)) / 3600.0
            if edad_h > ttl_horas:
                continue
        c = env.get("consulta") or {}
        if not c:
            # Descargas anteriores a este campo: se lee la clave, que las
            # fuentes construyen como "...:lat,lon,radio".
            try:
                lat_c, lon_c, r_c = (
                    float(x) for x in str(env.get("clave", "")).rsplit(":", 1)[-1].split(",")
                )
                c = {"lat": lat_c, "lon": lon_c, "radio_km": r_c}
            except (ValueError, IndexError):
                continue
        if abs(c["lat"] - lat) > 1e-4 or abs(c["lon"] - lon) > 1e-4:
            continue
        if c["radio_km"] + 1e-9 < radio_km:
            continue
        if mejor is None or c["radio_km"] < mejor[0]:
            mejor = (c["radio_km"], env.get("datos"), str(env.get("guardado", "")))
    if mejor is None:
        return None, "", 0.0
    return mejor[1], mejor[2], mejor[0]


# --------------------------------------------------------------------------
# Cortesia: robots.txt y limite de tasa
# --------------------------------------------------------------------------

_robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
_ultima_peticion: dict[str, float] = {}


def permitido_por_robots(url: str) -> bool:
    """Consulta robots.txt del dominio. Ante la duda, permite.

    Un fallo al leer robots.txt no es una prohibicion: muchos servicios de
    datos abiertos no publican uno. Lo que si es una prohibicion es un
    robots.txt que existe y dice que no.
    """
    partes = urlparse(url)
    dominio = f"{partes.scheme}://{partes.netloc}"
    if dominio not in _robots:
        parser = urllib.robotparser.RobotFileParser()
        parser.set_url(f"{dominio}/robots.txt")
        try:
            parser.read()
        except Exception:
            parser = None            # sin robots.txt legible: se permite
        _robots[dominio] = parser
    parser = _robots[dominio]
    if parser is None:
        return True
    return parser.can_fetch(USER_AGENT, url)


def esperar_turno(fuente: str, intervalo_s: float) -> None:
    """Bloquea hasta que hayan pasado `intervalo_s` desde la ultima peticion."""
    ultima = _ultima_peticion.get(fuente)
    if ultima is not None:
        pendiente = intervalo_s - (time.monotonic() - ultima)
        if pendiente > 0:
            time.sleep(pendiente)
    _ultima_peticion[fuente] = time.monotonic()


# --------------------------------------------------------------------------
# Fuente
# --------------------------------------------------------------------------

class Fuente(ABC):
    """Interfaz de una fuente de prospectos.

    Anadir una fuente nueva es escribir una subclase con `_consultar_red` y
    `_fixture`, registrarla en `fuentes/__init__.py` y nada mas. El resto del
    pipeline no sabe cuantas fuentes hay ni cuales son.
    """

    codigo: str = ""
    nombre: str = ""
    url_base: str = ""
    licencia: str = ""
    #: Segundos minimos entre peticiones a esta fuente.
    intervalo_s: float = 2.0
    #: Horas de validez de la cache. 0 = no caduca.
    ttl_horas: float = 24.0 * 7
    #: Si la fuente esta lista para consultarse en vivo. Una fuente que aun
    #: necesita que alguien configure un identificador de conjunto de datos
    #: se declara no verificada y solo sirve fixtures.
    verificada: bool = True
    nota_configuracion: str = ""

    # -- a implementar por cada fuente -------------------------------------

    @abstractmethod
    def _clave(self, lat: float, lon: float, radio_km: float) -> str:
        """Clave de cache de una consulta."""

    @abstractmethod
    def _fixture(self) -> list[RegistroCrudo]:
        """Registros de ejemplo, para el modo offline."""

    def _consultar_red(
        self, lat: float, lon: float, radio_km: float,
    ) -> list[RegistroCrudo]:
        """Consulta real. Por defecto, no implementada."""
        raise NotImplementedError

    # -- orquestacion comun ------------------------------------------------

    def consultar(
        self, lat: float, lon: float, radio_km: float,
        modo: Modo | None = None,
    ) -> ResultadoFuente:
        """Consulta la fuente. `modo` sobreescribe el de la variable de entorno
        para esta llamada: es lo que permite que el usuario pida desde el
        dashboard "consulta en vivo ahora" sin reiniciar el servidor."""
        ahora = datetime.now(timezone.utc).isoformat(timespec="seconds")
        modo = modo or modo_actual()
        clave = self._clave(lat, lon, radio_km)

        # La cache va primero en los dos modos que no exigen dato fresco.
        # Un dato real descargado la semana pasada vale mas que una
        # instantanea de demostracion, siempre: `offline` significa "no
        # salgas a la red", no "ignora lo que ya descargaste".
        if modo in (Modo.OFFLINE, Modo.CACHE):
            # Sin red no se puede refrescar, asi que en offline la cache no
            # caduca: es preferible un dato real viejo al de ejemplo.
            ttl = 0.0 if modo is Modo.OFFLINE else self.ttl_horas
            crudo, fecha = leer_cache_con_fecha(self.codigo, clave, ttl)
            if crudo is None:
                # Sin descarga exacta para este radio: vale una mas amplia
                # del mismo centro, recortada. El pipeline filtra por
                # distancia, asi que aqui solo se anota de donde salio.
                crudo, fecha, radio_cache = leer_cache_que_cubra(
                    self.codigo, lat, lon, radio_km, ttl,
                )
                if crudo is not None:
                    dentro = [
                        r for r in crudo
                        if _haversine_km(lat, lon, r["lat"], r["lon"]) <= radio_km
                    ]
                    return ResultadoFuente(
                        self.codigo, [RegistroCrudo(**r) for r in dentro],
                        "cache", ahora, fecha_dato=fecha,
                        nota=(
                            f"recortado de una descarga de {radio_cache:g} km"
                            if radio_cache > radio_km else ""
                        ),
                    )
            if crudo is not None:
                return ResultadoFuente(
                    self.codigo, [RegistroCrudo(**r) for r in crudo],
                    "cache", ahora, fecha_dato=fecha,
                )

        if modo is Modo.OFFLINE:
            return self._sin_dato(ahora)

        if not self.verificada:
            return self._sin_dato(ahora)

        if self.url_base and not permitido_por_robots(self.url_base):
            return self._sin_dato(
                ahora, "robots.txt del servicio no permite esta consulta",
            )

        try:
            esperar_turno(self.codigo, self.intervalo_s)
            registros = self._consultar_red(lat, lon, radio_km)
        except Exception as exc:                       # noqa: BLE001
            # Una fuente caida no puede tumbar la prospeccion entera: se
            # degrada a fixture y se dice claramente que paso.
            return self._sin_dato(ahora, f"{type(exc).__name__}: {exc}")

        escribir_cache(
            self.codigo, clave,
            [
                {
                    "fuente": r.fuente, "identificador": r.identificador,
                    "nombre": r.nombre, "lat": r.lat, "lon": r.lon,
                    "atributos": r.atributos, "url": r.url,
                }
                for r in registros
            ],
            consulta={"lat": lat, "lon": lon, "radio_km": radio_km},
        )
        return ResultadoFuente(self.codigo, registros, "red", ahora)

    def _sin_dato(self, ahora: str, incidencia: str = "") -> ResultadoFuente:
        """Que devolver cuando no hay dato real que servir.

        Con los ejemplos apagados (lo normal) se devuelve vacio y se dice por
        que. Es informacion util: "CARDIQUE no publica permisos de vertimiento
        en el portal" es un hallazgo del proyecto, no un fallo que haya que
        disimular rellenando con registros inventados.
        """
        motivo = incidencia or (
            "" if self.verificada else self.nota_configuracion
        )
        if ejemplos_activos():
            return ResultadoFuente(
                self.codigo, self._fixture(), "fixture", ahora,
                motivo or "sirviendo registros de demostracion",
            )
        return ResultadoFuente(
            self.codigo, [], "sin dato", ahora,
            motivo or "sin datos disponibles para esta consulta",
        )

    def ficha(self) -> dict[str, Any]:
        return {
            "codigo": self.codigo,
            "nombre": self.nombre,
            "url_base": self.url_base,
            "licencia": self.licencia,
            "verificada": self.verificada,
            "nota_configuracion": self.nota_configuracion,
            "ttl_horas": self.ttl_horas,
        }
