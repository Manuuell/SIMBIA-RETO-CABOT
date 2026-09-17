"""Buscador de tramites de VITAL, para consultar a mano lo que haga falta.

`permisos.py` hace un barrido fijo (tres consultas sobre vertimientos en
Cartagena) para enriquecer los prospectos en bloque. Esto es lo otro: una
busqueda libre, con filtros y paginada, para cuando una persona quiere
encontrar el expediente de una empresa concreta, ver que tramites tiene
abiertos o localizar un radicado. Es lo que el portal publico hace mal.

LO QUE SE APRENDIO DEL API
--------------------------

Comprobado en septiembre de 2026 contra `buscador-api.minambiente.gov.co`:

- `type_search` tiene que ser "Todos": cualquier otro valor devuelve un
  cuerpo vacio. La busqueda es texto libre sobre titular, proyecto,
  expediente y radicado.
- `filters` tiene que llevar siempre `{"CAMPO": -6}`; sin esa clave el API
  devuelve `null`. Las facetas se filtran anadiendo listas:
  `{"CAMPO": -6, "aut_nombre": ["EPA- CARTAGENA"], "tra_nombre": [...]}`.
- Cada respuesta trae `filters` con las facetas disponibles para esa
  consulta (autoridad, tramite, municipio, sector), que es lo que permite
  ofrecer filtros sin inventar catalogos.
- Los valores ausentes vienen como la cadena "None". El expediente de los
  registros de origen VITAL viene como " -- VDA-00020-24"; el de SILAMC, como
  el numero largo. Se limpian aqui para que el resto no lo sepa.
- Los tramites de vertimiento aparecen con cuatro nombres distintos segun la
  epoca y el sistema de origen; `TRAMITES_VERTIMIENTO` los reune.
- `total_pages` se calcula con paginas de 10 haga lo que haga `page_size`
  (245 resultados -> 25 paginas). Las paginas se calculan aqui con `total`.

Como el resto de fuentes: limite de tasa, User-Agent identificado y cache
por consulta con TTL. En modo offline solo se sirve lo cacheado.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .fuentes.base import (
    TIMEOUT_S, USER_AGENT, Modo, escribir_cache, esperar_turno,
    leer_cache_con_fecha, modo_actual,
)
from .permisos import ENDPOINT, INTERVALO_S

FUENTE = "vital-busqueda"
TTL_HORAS = 24.0 * 14
POR_PAGINA = 25
PORTAL = "https://vital-publico.minambiente.gov.co/buscador"

#: Nombres con los que VITAL etiqueta un tramite de vertimiento.
TRAMITES_VERTIMIENTO: tuple[str, ...] = (
    "Vertimiento de Aguas", "Vertimientos",
    "348_VITAL_VERTIMIENTO_CUERPO_A", "VITAL_VERTIMIENTO_SUELO",
)

#: Codigos internos del sistema -> nombre que entiende una persona.
_TRAMITE_LEGIBLE = {
    "348_VITAL_VERTIMIENTO_CUERPO_A": "Vertimiento a cuerpo de agua",
    "VITAL_VERTIMIENTO_SUELO": "Vertimiento al suelo",
}


def _limpio(valor: Any) -> str:
    """Los ausentes llegan como 'None' (texto). Y hay espacios sobrantes."""
    if valor is None:
        return ""
    texto = str(valor).strip()
    return "" if texto == "None" else texto


def _expediente(valor: Any) -> str:
    texto = _limpio(valor)
    # " -- VDA-00020-24 -- PDA2877-00-2026": varios numeros separados por --.
    partes = [p.strip() for p in texto.split("--") if p.strip()]
    return " / ".join(partes)


@dataclass(frozen=True)
class Registro:
    """Un tramite tal como lo publica el buscador, ya limpio."""

    id: str
    titular: str
    tramite: str
    tramite_legible: str
    autoridad: str
    expediente: str
    radicado: str
    proyecto: str
    municipio: str
    departamento: str
    fecha: str              # AAAA-MM-DD de creacion
    fecha_fin: str
    origen: str             # VITAL | SILAMC
    #: Identificadores que necesita el VITAL antiguo para el detalle y los
    #: documentos (ver documentos.py). Sin ellos no hay forma de llegar.
    sol_id: str = ""
    solicitante_id: str = ""

    @property
    def es_vertimiento(self) -> bool:
        return self.tramite in TRAMITES_VERTIMIENTO or "vertimiento" in self.tramite.lower()

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "titular": self.titular,
            "tramite": self.tramite, "tramite_legible": self.tramite_legible,
            "autoridad": self.autoridad, "expediente": self.expediente,
            "radicado": self.radicado, "proyecto": self.proyecto,
            "municipio": self.municipio, "departamento": self.departamento,
            "fecha": self.fecha, "fecha_fin": self.fecha_fin, "origen": self.origen,
            "sol_id": self.sol_id, "solicitante_id": self.solicitante_id,
            "es_vertimiento": self.es_vertimiento, "url": PORTAL,
        }


def interpretar(fila: dict[str, Any]) -> Registro:
    tramite = _limpio(fila.get("tra_nombre"))
    return Registro(
        id=_limpio(fila.get("id_consulta_publica")),
        titular=_limpio(fila.get("nombre_completo")),
        tramite=tramite,
        tramite_legible=_TRAMITE_LEGIBLE.get(tramite, tramite),
        autoridad=_limpio(fila.get("aut_nombre")),
        expediente=_expediente(fila.get("expediente")),
        radicado=_limpio(fila.get("sol_num_silpa")),
        proyecto=_limpio(fila.get("nombre_proyecto")),
        municipio=_limpio(fila.get("municipio")),
        departamento=_limpio(fila.get("departamento")),
        fecha=_limpio(fila.get("tar_fecha_creacion"))[:10],
        fecha_fin=_limpio(fila.get("tar_fecha_finalizacion"))[:10],
        origen=_limpio(fila.get("origen")),
        sol_id=_limpio(fila.get("tar_sol_id")),
        solicitante_id=_limpio(fila.get("sol_id_solicitante")),
    )


@dataclass
class Busqueda:
    """Que se pidio. Es tambien la clave de cache."""

    texto: str
    autoridades: tuple[str, ...] = ()
    tramites: tuple[str, ...] = ()
    municipios: tuple[str, ...] = ()
    solo_vertimientos: bool = False
    pagina: int = 1
    por_pagina: int = POR_PAGINA

    def cuerpo(self) -> dict[str, Any]:
        filtros: dict[str, Any] = {"CAMPO": -6}
        if self.autoridades:
            filtros["aut_nombre"] = list(self.autoridades)
        tramites = list(self.tramites)
        if self.solo_vertimientos:
            tramites = sorted(set(tramites) | set(TRAMITES_VERTIMIENTO))
        if tramites:
            filtros["tra_nombre"] = tramites
        if self.municipios:
            filtros["municipio"] = list(self.municipios)
        return {
            "page_number": max(1, self.pagina),
            "page_size": max(1, min(self.por_pagina, 100)),
            "query": self.texto.strip(),
            "type_search": "Todos",
            "filters": filtros,
        }

    #: Sube cuando cambia lo que se guarda por registro: una cache anterior
    #: no tendria los campos nuevos y se serviria incompleta.
    VERSION_CACHE = 2

    @property
    def clave(self) -> str:
        return json.dumps({"v": self.VERSION_CACHE, **self.cuerpo()}, sort_keys=True, ensure_ascii=False)


@dataclass
class Resultado:
    busqueda: Busqueda
    registros: list[Registro] = field(default_factory=list)
    total: int = 0
    paginas: int = 0
    facetas: dict[str, list[str]] = field(default_factory=dict)
    origen: str = "sin dato"        # red | cache | sin dato
    fecha_dato: str = ""
    incidencia: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "texto": self.busqueda.texto,
            "pagina": self.busqueda.pagina,
            "por_pagina": self.busqueda.por_pagina,
            "total": self.total,
            "paginas": self.paginas,
            "registros": [r.as_dict() for r in self.registros],
            "facetas": self.facetas,
            "origen": self.origen,
            "fecha_dato": self.fecha_dato,
            "incidencia": self.incidencia,
            "vertimientos": sum(1 for r in self.registros if r.es_vertimiento),
        }


def _facetas(crudas: dict[str, Any] | None) -> dict[str, list[str]]:
    """Facetas con nombres nuestros, limpias y sin duplicados por espacios."""
    crudas = crudas or {}
    salida: dict[str, list[str]] = {}
    for nuestro, suyo in (
        ("autoridad", "aut_nombre"), ("tramite", "tra_nombre"),
        ("municipio", "municipio"), ("sector", "nombre_sec_padre"),
    ):
        vistos: dict[str, str] = {}
        for v in crudas.get(suyo) or []:
            limpio = _limpio(v)
            if limpio and limpio.lower() not in vistos:
                # Se guarda el valor ORIGINAL (con sus espacios): es el que el
                # API acepta como filtro. Solo se deduplica para mostrar.
                vistos[limpio.lower()] = str(v)
        salida[nuestro] = list(vistos.values())
    return salida


def _de_cache(b: Busqueda, datos: dict[str, Any], fecha: str) -> Resultado:
    return Resultado(
        busqueda=b,
        registros=[Registro(**{"sol_id": "", "solicitante_id": "", **r}) for r in datos["registros"]],
        total=datos["total"], paginas=datos["paginas"],
        facetas=datos.get("facetas", {}), origen="cache", fecha_dato=fecha,
    )


def _consultar_red(b: Busqueda) -> Resultado:
    import httpx2 as httpx

    esperar_turno("vital", INTERVALO_S)
    r = httpx.post(
        ENDPOINT, json=b.cuerpo(),
        headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT_S,
    )
    r.raise_for_status()
    cuerpo = r.json()
    if not isinstance(cuerpo, dict):
        raise ValueError("el buscador devolvio un cuerpo vacio (filtros no admitidos)")
    registros = [interpretar(f) for f in cuerpo.get("data") or []]
    total = int(cuerpo.get("total") or 0)
    return Resultado(
        busqueda=b, registros=registros,
        total=total,
        paginas=max(1, math.ceil(total / b.cuerpo()["page_size"])) if total else 0,
        facetas=_facetas(cuerpo.get("filters")),
        origen="red",
    )


def buscar(b: Busqueda, modo: Modo | None = None) -> Resultado:
    """Ejecuta la busqueda respetando el modo: offline solo sirve cache."""
    modo = modo or modo_actual()
    if not b.texto.strip():
        return Resultado(busqueda=b, incidencia="Escribe algo que buscar.")

    ttl = 0.0 if modo is Modo.OFFLINE else TTL_HORAS
    datos, fecha = leer_cache_con_fecha(FUENTE, b.clave, ttl)
    if datos is not None and modo is not Modo.VIVO:
        return _de_cache(b, datos, fecha)
    if modo is Modo.OFFLINE:
        return Resultado(
            busqueda=b,
            incidencia="Sin red no hay resultados para esta busqueda: no esta en la cache. Cambia a 'Cache primero' o 'En vivo'.",
        )

    try:
        resultado = _consultar_red(b)
    except Exception as exc:                                # noqa: BLE001
        if datos is not None:
            viejo = _de_cache(b, datos, fecha)
            viejo.incidencia = f"El buscador no respondio ({type(exc).__name__}); se muestra la cache."
            return viejo
        return Resultado(busqueda=b, incidencia=f"El buscador de VITAL no respondio: {type(exc).__name__}: {exc}")

    escribir_cache(FUENTE, b.clave, {
        "registros": [vars(r) for r in resultado.registros],
        "total": resultado.total, "paginas": resultado.paginas,
        "facetas": resultado.facetas,
    })
    return resultado


def ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
