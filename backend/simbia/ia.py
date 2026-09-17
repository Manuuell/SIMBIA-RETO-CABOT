"""Proveedor de IA por API: OpenAI (o Anthropic), en un solo sitio.

Todo lo que habla con un modelo de lenguaje pasa por aqui: la extraccion de
permisos en PDF, el asistente y la voz. Asi el resto del codigo no sabe que
proveedor hay, y cambiarlo es cambiar una variable de entorno.

    OPENAI_API_KEY              activa OpenAI (tiene prioridad)
    ANTHROPIC_API_KEY           activa Anthropic si no hay OpenAI
    SIMBIA_IA_MODELO            modelo de texto (defecto segun proveedor)
    SIMBIA_IA_MODELO_VOZ        modelo de voz (solo OpenAI)
    SIMBIA_IA_VOZ               voz (solo OpenAI; defecto 'nova')

Sin clave, todo lo que dependa de esto se declara no disponible y el resto
de la aplicacion sigue funcionando: es una funcion opcional.

Los documentos que se envian al modelo son contenido no confiable: llegan de
fuera y pueden traer texto dirigido al modelo. Cada llamada declara que el
documento es dato, no instruccion, y la salida estructurada acota lo peor
que puede pasar a un numero equivocado.
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)

MODELO_OPENAI = "gpt-4.1-mini"
MODELO_ANTHROPIC = "claude-opus-5"
MODELO_VOZ = "gpt-4o-mini-tts"
VOZ = "nova"
MAX_PDF_MB = 30.0
MAX_TEXTO_VOZ = 2_000


@dataclass(frozen=True)
class Proveedor:
    nombre: str          # "openai" | "anthropic"
    modelo: str
    modelo_voz: str = ""
    voz: str = ""

    @property
    def tiene_voz(self) -> bool:
        return bool(self.modelo_voz)


def proveedor() -> Proveedor | None:
    """El proveedor configurado, o None si no hay ninguno utilizable."""
    if os.environ.get("OPENAI_API_KEY", "").strip():
        try:
            import openai  # noqa: F401
        except ImportError:
            return None
        return Proveedor(
            "openai",
            os.environ.get("SIMBIA_IA_MODELO", "").strip() or MODELO_OPENAI,
            os.environ.get("SIMBIA_IA_MODELO_VOZ", "").strip() or MODELO_VOZ,
            os.environ.get("SIMBIA_IA_VOZ", "").strip() or VOZ,
        )
    if os.environ.get("ANTHROPIC_API_KEY", "").strip() or os.environ.get("ANTHROPIC_AUTH_TOKEN", "").strip():
        try:
            import anthropic  # noqa: F401
        except ImportError:
            return None
        return Proveedor("anthropic", os.environ.get("SIMBIA_IA_MODELO", "").strip() or MODELO_ANTHROPIC)
    return None


def disponible() -> tuple[bool, str]:
    p = proveedor()
    if p is not None:
        return True, ""
    if os.environ.get("OPENAI_API_KEY", "").strip():
        return False, "Hay OPENAI_API_KEY pero falta el paquete 'openai'. Instalar con: pip install openai"
    if os.environ.get("ANTHROPIC_API_KEY", "").strip():
        return False, "Hay ANTHROPIC_API_KEY pero falta el paquete 'anthropic'. Instalar con: pip install anthropic"
    return False, "Sin clave de IA. Definir OPENAI_API_KEY (o ANTHROPIC_API_KEY) en el entorno del servicio."


def modelo_activo() -> str:
    p = proveedor()
    return p.modelo if p else ""


# --------------------------------------------------------------------------
# Texto
# --------------------------------------------------------------------------

def _pdf_a_bloque(ruta: Path, p: Proveedor) -> dict[str, Any]:
    datos = base64.standard_b64encode(ruta.read_bytes()).decode("ascii")
    if p.nombre == "openai":
        return {"type": "input_file", "filename": ruta.name, "file_data": f"data:application/pdf;base64,{datos}"}
    return {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": datos}}


def _comprobar_pdf(ruta: Path) -> None:
    if not ruta.is_file():
        raise FileNotFoundError(f"No existe el archivo: {ruta}")
    tam_mb = ruta.stat().st_size / 1e6
    if tam_mb > MAX_PDF_MB:
        raise ValueError(f"El PDF pesa {tam_mb:.1f} MB y el limite es {MAX_PDF_MB:.0f} MB")


def estructurar_pdf(ruta: Path | str, instrucciones: str, peticion: str, esquema: type[T]) -> T:
    """Lee un PDF y devuelve una instancia del esquema, validada.

    Salida estructurada en los dos proveedores: la respuesta valida contra
    el esquema o falla; no hay prosa que interpretar.
    """
    p = proveedor()
    if p is None:
        raise RuntimeError(disponible()[1])
    ruta = Path(ruta)
    _comprobar_pdf(ruta)
    bloque = _pdf_a_bloque(ruta, p)

    if p.nombre == "openai":
        from openai import OpenAI
        r = OpenAI().responses.parse(
            model=p.modelo,
            instructions=instrucciones,
            input=[{"role": "user", "content": [bloque, {"type": "input_text", "text": peticion}]}],
            text_format=esquema,
        )
        if r.output_parsed is None:
            raise ValueError("La respuesta no pudo validarse contra el esquema esperado")
        return r.output_parsed

    import anthropic
    r = anthropic.Anthropic().messages.parse(
        model=p.modelo, max_tokens=16000, system=instrucciones,
        thinking={"type": "adaptive"},
        messages=[{"role": "user", "content": [bloque, {"type": "text", "text": peticion}]}],
        output_format=esquema,
    )
    if getattr(r, "stop_reason", None) == "refusal":
        raise ValueError("El modelo declino procesar el documento")
    if r.parsed_output is None:
        raise ValueError("La respuesta no pudo validarse contra el esquema esperado")
    return r.parsed_output


def conversar(
    instrucciones: str,
    mensajes: list[dict[str, str]],
    max_tokens: int = 900,
    adjuntos_pdf: list[Path] | None = None,
) -> str:
    """Una respuesta de texto a una conversacion [{rol, contenido}].

    `adjuntos_pdf` se anaden al ultimo mensaje del usuario, para preguntar
    sobre un documento sin pasarlo antes a texto.
    """
    p = proveedor()
    if p is None:
        raise RuntimeError(disponible()[1])
    adjuntos = [_pdf_a_bloque(a, p) for a in (adjuntos_pdf or []) if _comprobar_pdf(a) is None]

    if p.nombre == "openai":
        from openai import OpenAI
        entrada: list[dict[str, Any]] = []
        for i, m in enumerate(mensajes):
            rol = "assistant" if m["rol"] == "asistente" else "user"
            contenido: list[dict[str, Any]] = [{"type": "output_text" if rol == "assistant" else "input_text", "text": m["contenido"]}]
            if rol == "user" and i == len(mensajes) - 1 and adjuntos:
                contenido = adjuntos + contenido
            entrada.append({"role": rol, "content": contenido})
        r = OpenAI().responses.create(
            model=p.modelo, instructions=instrucciones, input=entrada,
            max_output_tokens=max_tokens,
        )
        return (r.output_text or "").strip()

    import anthropic
    entrada = []
    for i, m in enumerate(mensajes):
        rol = "assistant" if m["rol"] == "asistente" else "user"
        contenido: list[dict[str, Any]] = [{"type": "text", "text": m["contenido"]}]
        if rol == "user" and i == len(mensajes) - 1 and adjuntos:
            contenido = adjuntos + contenido
        entrada.append({"role": rol, "content": contenido})
    r = anthropic.Anthropic().messages.create(
        model=p.modelo, max_tokens=max_tokens, system=instrucciones, messages=entrada,
    )
    return "".join(b.text for b in r.content if getattr(b, "type", "") == "text").strip()


# --------------------------------------------------------------------------
# Voz
# --------------------------------------------------------------------------

def sintetizar_voz(texto: str) -> bytes:
    """MP3 con el texto leido. Solo OpenAI tiene voz."""
    p = proveedor()
    if p is None or not p.tiene_voz:
        raise RuntimeError("La voz necesita OpenAI (OPENAI_API_KEY)")
    texto = texto.strip()
    if not texto:
        raise ValueError("Nada que leer")
    if len(texto) > MAX_TEXTO_VOZ:
        texto = texto[:MAX_TEXTO_VOZ].rsplit(" ", 1)[0] + "…"
    from openai import OpenAI
    r = OpenAI().audio.speech.create(
        model=p.modelo_voz, voice=p.voz, input=texto, response_format="mp3",
        instructions="Habla en espanol neutro, con tono claro y cercano, como una colega de ingenieria explicando un resultado.",
    )
    return r.content
