"""API del asistente: preguntar, escuchar y resumir documentos."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import json
import secrets
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from .. import asistente, ia
from ..scout.geo import RADIO_BUSQUEDA_KM
from . import routes as api_base
from . import scout as api_scout

router = APIRouter(prefix="/api/asistente")


def _exigir_ia() -> ia.Proveedor:
    p = ia.proveedor()
    if p is None:
        raise HTTPException(503, ia.disponible()[1])
    return p


@router.get("/estado")
def estado() -> dict[str, Any]:
    p = ia.proveedor()
    ok, motivo = ia.disponible()
    return {
        "disponible": ok, "motivo": motivo,
        "proveedor": p.nombre if p else None, "modelo": p.modelo if p else None,
        "voz": bool(p and p.tiene_voz), "modelo_voz": p.modelo_voz if p else None,
    }


@router.get("/contexto")
def contexto(radio_km: float = RADIO_BUSQUEDA_KM, clave: str = "") -> dict[str, Any]:
    """Que sabe el asistente ahora mismo, sin llamar al modelo."""
    barrido = api_scout.barrido(radio_km=radio_km)
    c = asistente.construir_contexto({}, barrido, api_scout.EXPEDIENTES, clave=clave)
    return {
        "prospectos": len(c.prospectos) + len(c.cartera),
        "cartera": [p["empresa"] for p in c.cartera],
        "documentos": [
            {"empresa": d["empresa"], "archivo": d["archivo"], "con_resumen": not isinstance(d["resumen"], str)}
            for d in c.documentos
        ],
        "empresa_en_pantalla": c.empresa_en_pantalla,
        "modo_fuentes": c.resumen_barrido.get("modo_fuentes"),
    }


class Pregunta(BaseModel):
    mensaje: str = Field(min_length=1, max_length=asistente.MAX_MENSAJE)
    historial: list[dict[str, str]] = Field(default_factory=list)
    modulo: str = ""
    clave: str = ""
    radio_km: float = RADIO_BUSQUEDA_KM


@router.post("/preguntar")
def preguntar(q: Pregunta) -> dict[str, Any]:
    """Responde con lo que la aplicacion sabe ahora mismo."""
    _exigir_ia()
    barrido = api_scout.barrido(radio_km=q.radio_km)
    try:
        kpis = api_base.kpis()
    except Exception:                                   # noqa: BLE001
        kpis = {}
    contexto = asistente.construir_contexto(
        kpis, barrido, api_scout.EXPEDIENTES, modulo=q.modulo, clave=q.clave,
    )
    try:
        respuesta = asistente.responder(q.mensaje, q.historial, contexto)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except Exception as exc:                            # noqa: BLE001
        raise HTTPException(502, f"El proveedor de IA no respondio: {type(exc).__name__}: {exc}")
    return {
        "respuesta": respuesta,
        "contexto": {
            "prospectos": len(contexto.prospectos), "cartera": len(contexto.cartera),
            "documentos": len(contexto.documentos),
            "documentos_sin_resumen": sum(1 for d in contexto.documentos if isinstance(d["resumen"], str)),
            "empresa_en_pantalla": contexto.empresa_en_pantalla,
        },
    }


def _contexto_de(q: "Pregunta") -> asistente.Contexto:
    barrido = api_scout.barrido(radio_km=q.radio_km)
    try:
        kpis = api_base.kpis()
    except Exception:                                   # noqa: BLE001
        kpis = {}
    return asistente.construir_contexto(
        kpis, barrido, api_scout.EXPEDIENTES, modulo=q.modulo, clave=q.clave,
    )


def _resumen_contexto(c: asistente.Contexto) -> dict[str, Any]:
    return {
        "prospectos": len(c.prospectos), "cartera": len(c.cartera),
        "documentos": len(c.documentos),
        "documentos_sin_resumen": sum(1 for d in c.documentos if isinstance(d["resumen"], str)),
        "empresa_en_pantalla": c.empresa_en_pantalla,
    }


#: nginx retiene las respuestas hasta completarlas salvo que se le diga que no.
#: Sin esta cabecera, el streaming llegaria de golpe al final.
SIN_BUFFER = {"X-Accel-Buffering": "no", "Cache-Control": "no-store"}


@router.post("/preguntar/stream")
def preguntar_stream(q: Pregunta):
    """La respuesta segun se genera, como eventos SSE: {delta} ... {fin, contexto}."""
    _exigir_ia()
    contexto = _contexto_de(q)
    resumen = _resumen_contexto(contexto)

    def evento(obj: dict[str, Any]) -> str:
        return "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"

    def generar():
        try:
            for trozo in asistente.responder_stream(q.mensaje, q.historial, contexto):
                if trozo:
                    yield evento({"delta": trozo})
            yield evento({"fin": True, "contexto": resumen})
        except ValueError as exc:
            yield evento({"error": str(exc)})
        except Exception as exc:                        # noqa: BLE001
            yield evento({"error": f"El proveedor de IA no respondio: {type(exc).__name__}: {exc}"})

    return StreamingResponse(generar(), media_type="text/event-stream", headers=SIN_BUFFER)


class TextoVoz(BaseModel):
    texto: str = Field(min_length=1, max_length=20_000)


# Textos pendientes de leer: id -> (texto, caduca). La reproduccion en el
# navegador necesita una URL GET para sonar mientras descarga; el texto se
# deja aqui un momento en vez de meterlo en la URL.
_voces: dict[str, tuple[str, float]] = {}
VOZ_TTL_S = 600
VOZ_MAX = 200


def _limpiar_voces() -> None:
    ahora = time.time()
    for k in [k for k, (_, caduca) in _voces.items() if caduca < ahora]:
        _voces.pop(k, None)
    while len(_voces) > VOZ_MAX:
        _voces.pop(next(iter(_voces)), None)


@router.post("/voz/preparar")
def voz_preparar(t: TextoVoz) -> dict[str, Any]:
    """Registra un texto y devuelve la URL desde la que suena en streaming."""
    p = _exigir_ia()
    if not p.tiene_voz:
        raise HTTPException(503, "La voz necesita OpenAI (OPENAI_API_KEY)")
    if not t.texto.strip():
        raise HTTPException(422, "Nada que leer")
    _limpiar_voces()
    id_ = secrets.token_urlsafe(12)
    _voces[id_] = (t.texto, time.time() + VOZ_TTL_S)
    return {"id": id_, "url": f"/api/asistente/voz/{id_}.mp3"}


@router.get("/voz/{id_}.mp3")
def voz_stream(id_: str):
    """El MP3 por trozos segun se genera: el navegador reproduce mientras llega."""
    p = _exigir_ia()
    if not p.tiene_voz:
        raise HTTPException(503, "La voz necesita OpenAI (OPENAI_API_KEY)")
    entrada = _voces.get(id_)
    if entrada is None or entrada[1] < time.time():
        raise HTTPException(404, "Ese texto ya no esta disponible; vuelve a pedir la voz")
    texto = entrada[0]

    def generar():
        try:
            yield from ia.sintetizar_voz_stream(texto)
        except Exception:                               # noqa: BLE001
            return

    return StreamingResponse(generar(), media_type="audio/mpeg", headers=SIN_BUFFER)


@router.post("/voz")
def voz(t: TextoVoz):
    """El texto leido en voz alta, como MP3."""
    p = _exigir_ia()
    if not p.tiene_voz:
        raise HTTPException(503, "La voz necesita OpenAI (OPENAI_API_KEY)")
    try:
        audio = ia.sintetizar_voz(t.texto)
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except Exception as exc:                            # noqa: BLE001
        raise HTTPException(502, f"El proveedor de voz no respondio: {type(exc).__name__}: {exc}")
    return Response(content=audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})


class DocumentoAResumir(BaseModel):
    ruta: str
    forzar: bool = False


@router.post("/documento/resumen")
def resumen_documento(d: DocumentoAResumir) -> dict[str, Any]:
    """Resume un documento guardado (una vez; despues sale de la cache)."""
    _exigir_ia()
    archivo = api_scout._ruta_expediente(d.ruta)
    if archivo.read_bytes()[:4] != b"%PDF":
        raise HTTPException(422, "Solo se resumen PDF")
    try:
        return asistente.resumir_documento(archivo, forzar=d.forzar)
    except Exception as exc:                            # noqa: BLE001
        raise HTTPException(502, f"No se pudo resumir: {type(exc).__name__}: {exc}")


@router.get("/documento/resumen")
def leer_resumen(ruta: str) -> dict[str, Any]:
    """El resumen ya generado, sin llamar al modelo; 404 si no existe."""
    archivo = api_scout._ruta_expediente(ruta)
    r = asistente.ruta_resumen(archivo)
    if not r.is_file():
        raise HTTPException(404, "Sin resumen todavia")
    import json
    return json.loads(r.read_text(encoding="utf-8"))
