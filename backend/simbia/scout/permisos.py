"""Permisos de vertimiento reales, via el buscador publico de VITAL.

QUE ES ESTO
-----------

VITAL (Ventanilla Integral de Tramites Ambientales, del Ministerio de Ambiente)
publica los tramites ambientales radicados ante las autoridades del pais. Entre
ellos, los **permisos de vertimiento**: el acto por el que una empresa queda
autorizada a descargar agua residual, y por tanto la prueba documental de que
esa empresa genera una corriente de rechazo.

Que un vecino tenga permiso de vertimiento vigente cambia su condicion de forma
sustantiva. Deja de ser "una planta de este sector probablemente bote agua" y
pasa a ser "esta empresa esta autorizada a verter, ante esta autoridad, con
este numero de expediente". Ademas entrega lo unico que hace accionable un
derecho de peticion: **el numero de expediente**. Una solicitud que dice
"solicito copia del expediente 1070860522056225001" se responde; una que dice
"solicito informacion sobre vertimientos" se pierde.

LO QUE SI Y LO QUE NO DA
------------------------

**Si da:** existencia del permiso, razon social del titular, autoridad
ambiental competente, numero de expediente y fechas.

**No da:** el caudal autorizado ni la caracterizacion analitica. Eso vive en
los documentos del expediente, que no estan en el buscador. Por eso este
modulo no toca la caracterizacion del agua: solo confirma que la corriente
existe y esta regulada, y deja apuntado a quien y que pedir. El PDF que
llegue despues lo procesa `extraccion.py`.

**Tampoco da coordenadas.** Por eso no es una `Fuente` del barrido -- no puede
situar una empresa en el mapa. Es una capa de **enriquecimiento**: cruza por
razon social contra los prospectos que ya encontro OpenStreetMap.

HALLAZGO
--------

Buscando la fuente de estos datos, lo primero fue el portal de datos abiertos
(datos.gov.co). Ahi **no estan**: CARDIQUE solo publica una estacion de calidad
del aire, y los conjuntos de permisos de vertimiento que existen son de
Corpoboyaca y Corantioquia. La conclusion facil era que en Cartagena no hay
dato publico.

Es falsa. Estan en VITAL, que es otro sistema: para Cartagena hay del orden de
130 registros de vertimiento, la mayoria de EPA Cartagena y el resto de
CARDIQUE. Entre ellos varias empresas del corredor de Mamonal.

API
---

El buscador publico expone un endpoint JSON abierto, sin autenticacion:

    POST https://buscador-api.minambiente.gov.co/buscar
    {"page_number": 1, "page_size": 100, "query": "...",
     "type_search": "Todos", "filters": {"CAMPO": -6}}

No esta documentado como API publica: es el que consume el propio buscador
web. Se usa con el mismo cuidado que cualquier otra fuente de terceros --
limite de tasa, cache y User-Agent identificado -- y el codigo asume que puede
desaparecer sin aviso, degradando a lo que haya en cache.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date
from typing import Any

from .fuentes.base import (
    TIMEOUT_S, USER_AGENT, Modo, escribir_cache, esperar_turno,
    leer_cache_con_fecha, modo_actual,
)
from .perfil import Prospecto, Referencia
from .texto import normalizar, parecido

ENDPOINT = "https://buscador-api.minambiente.gov.co/buscar"
FUENTE = "vital"
TTL_HORAS = 24.0 * 14
INTERVALO_S = 1.5

#: Terminos de busqueda del barrido por defecto. VITAL indexa texto libre
#: sobre nombre de proyecto, expediente y solicitante, asi que se lanzan
#: varias consultas y se unen los resultados.
CONSULTAS = (
    "Vertimiento de Aguas Cartagena",
    "Vertimiento Mamonal",
    "Vertimientos Bolivar Cartagena",
)

#: Solo interesan los tramites de vertimiento. El buscador devuelve tambien
#: correspondencia, concesiones y otros tramites que no dicen nada del agua
#: de rechazo.
TRAMITES_DE_INTERES = ("vertimiento",)

#: Para cruzar un permiso con un prospecto hace falta un parecido alto. Aqui
#: no hay coordenada con la que desempatar como en la fusion del barrido, asi
#: que el unico criterio disponible tiene que ser exigente.
UMBRAL_CRUCE = 0.88


@dataclass(frozen=True)
class Permiso:
    """Un permiso de vertimiento radicado."""

    titular: str
    autoridad: str
    expediente: str
    tramite: str
    radicado: str
    fecha: str

    @property
    def url(self) -> str:
        return "https://vital-publico.minambiente.gov.co/buscador"

    def as_dict(self) -> dict[str, str]:
        return {
            "titular": self.titular, "autoridad": self.autoridad,
            "expediente": self.expediente, "tramite": self.tramite,
            "radicado": self.radicado, "fecha": self.fecha[:10],
        }


def _interpretar(filas: list[dict[str, Any]]) -> list[Permiso]:
    permisos: list[Permiso] = []
    for f in filas:
        tramite = (f.get("tra_nombre") or "").strip()
        if not any(t in tramite.lower() for t in TRAMITES_DE_INTERES):
            continue
        titular = (f.get("nombre_completo") or "").strip()
        if not titular:
            continue
        permisos.append(Permiso(
            titular=titular,
            autoridad=(f.get("aut_nombre") or "").strip(),
            expediente=(f.get("expediente") or "").strip(),
            tramite=tramite,
            radicado=(f.get("sol_num_silpa") or "").strip(),
            fecha=(f.get("tar_fecha_creacion") or "").strip(),
        ))
    return permisos


def _consultar_red(consulta: str, paginas: int = 2) -> list[Permiso]:
    import httpx2 as httpx

    salida: list[Permiso] = []
    for pagina in range(1, paginas + 1):
        esperar_turno(FUENTE, INTERVALO_S)
        r = httpx.post(
            ENDPOINT,
            json={
                "page_number": pagina, "page_size": 100, "query": consulta,
                "type_search": "Todos", "filters": {"CAMPO": -6},
            },
            headers={"User-Agent": USER_AGENT},
            timeout=TIMEOUT_S,
        )
        r.raise_for_status()
        cuerpo = r.json()
        salida.extend(_interpretar(cuerpo.get("data") or []))
        if pagina >= (cuerpo.get("total_pages") or 1):
            break
    return salida


def consultar(
    consultas: tuple[str, ...] = CONSULTAS, modo: Modo | None = None,
) -> tuple[list[Permiso], str]:
    """Permisos de vertimiento de la zona. Devuelve (permisos, origen).

    Respeta el modo global (o el que se pase): en `offline` no sale a la red
    y sirve lo que haya en cache. Si la fuente falla, se degrada a cache y
    sigue: un buscador de un tercero caido no puede tumbar la prospeccion.
    """
    permisos, origen, _fecha = consultar_detalle(consultas, modo)
    return permisos, origen


def consultar_detalle(
    consultas: tuple[str, ...] = CONSULTAS, modo: Modo | None = None,
) -> tuple[list[Permiso], str, str]:
    """Como `consultar`, y ademas la fecha del dato cuando sale de cache."""
    clave = "|".join(consultas)
    modo = modo or modo_actual()
    ttl = 0.0 if modo is Modo.OFFLINE else TTL_HORAS
    cacheado, fecha = leer_cache_con_fecha(FUENTE, clave, ttl)

    if cacheado is not None and modo is not Modo.VIVO:
        return [Permiso(**p) for p in cacheado], "cache", fecha
    if modo is Modo.OFFLINE:
        return [], "sin dato", ""

    try:
        vistos: dict[str, Permiso] = {}
        for c in consultas:
            for p in _consultar_red(c):
                # El mismo expediente aparece en varias consultas.
                vistos.setdefault(p.expediente or f"{p.titular}|{p.radicado}", p)
        permisos = list(vistos.values())
    except Exception:                                # noqa: BLE001
        if cacheado is not None:
            return [Permiso(**p) for p in cacheado], "cache", fecha
        return [], "sin dato", ""

    escribir_cache(FUENTE, clave, [vars(p) for p in permisos])
    return permisos, "red", ""


# --------------------------------------------------------------------------
# Enriquecimiento
# --------------------------------------------------------------------------

def cruzar(nombre: str, permisos: list[Permiso]) -> list[Permiso]:
    """Permisos cuyo titular es, con alta probabilidad, esta empresa."""
    if not nombre.strip():
        return []
    objetivo = normalizar(nombre)
    if not objetivo:
        return []
    return [
        p for p in permisos
        if parecido(objetivo, p.titular) >= UMBRAL_CRUCE
    ]


def enriquecer(
    prospectos: list[Prospecto], permisos: list[Permiso] | None = None,
) -> tuple[list[Prospecto], int]:
    """Anota en cada prospecto los permisos de vertimiento que le constan.

    No toca la caracterizacion del agua: el buscador no la publica. Lo que
    aporta es certeza de que la corriente existe y esta regulada, mas el
    numero de expediente con el que pedirla. Eso sube la confianza, pero
    menos de lo que la subiria una analitica: saber que alguien vierte no es
    saber que vierte.
    """
    if permisos is None:
        permisos, _ = consultar()
    if not permisos:
        return prospectos, 0

    salida: list[Prospecto] = []
    tocados = 0
    for p in prospectos:
        suyos = cruzar(p.nombre, permisos)
        if not suyos:
            salida.append(p)
            continue
        tocados += 1
        refs = tuple(
            Referencia(
                fuente=FUENTE,
                identificador=x.expediente or x.radicado,
                descripcion=(
                    f"{x.tramite} ante {x.autoridad}"
                    + (f" - radicado {x.radicado}" if x.radicado else "")
                ),
                url=x.url,
                consultado=date.today().isoformat(),
            )
            for x in suyos
        )
        autoridades = sorted({x.autoridad for x in suyos if x.autoridad})
        salida.append(replace(
            p,
            referencias=p.referencias + refs,
            #: Se declara como campo medido ficticio NO: la confianza sube por
            #: la via honesta, que es tener referencia documental del tramite.
            notas=(
                f"{p.notas} | Permiso de vertimiento radicado ante "
                f"{', '.join(autoridades) or 'la autoridad ambiental'} "
                f"(expediente {suyos[0].expediente or suyos[0].radicado}): "
                f"pedir la caracterizacion por derecho de peticion citando "
                f"ese numero"
            ),
        ))
    return salida, tocados
