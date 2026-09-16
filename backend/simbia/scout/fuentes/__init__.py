"""Fuentes de datos de la prospeccion.

Anadir una fuente es escribir una subclase de `Fuente` y registrarla aqui.
El pipeline no sabe cuantas hay.
"""

from __future__ import annotations

from .base import Fuente, Modo, RegistroCrudo, ResultadoFuente, modo_actual
from .datos_gov import FuenteDatosGov
from .osm import FuenteOSM


def catalogo() -> list[Fuente]:
    """Fuentes activas, en orden de consulta.

    OSM va primero porque aporta la geometria a la que las demas se cruzan.
    """
    return [FuenteOSM(), FuenteDatosGov()]


__all__ = [
    "Fuente", "FuenteDatosGov", "FuenteOSM", "Modo", "RegistroCrudo",
    "ResultadoFuente", "catalogo", "modo_actual",
]
