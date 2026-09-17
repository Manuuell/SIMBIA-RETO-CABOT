"""API del asistente: preguntar, escuchar y resumir documentos."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
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


class TextoVoz(BaseModel):
    texto: str = Field(min_length=1, max_length=20_000)


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
