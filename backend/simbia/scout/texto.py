"""Normalizacion y comparacion de razones sociales.

Vive aparte porque lo usan tres modulos que no deben depender entre si:
`pipeline` para fusionar registros, `almacen` para construir la clave estable
y `dossier` para localizar expedientes. Tenerlo en `pipeline` provocaba una
importacion circular en cuanto `dossier` lo necesito, que es la senal
habitual de que una funcion esta en el modulo equivocado.
"""

from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

#: Sufijos societarios y particulas que estorban al comparar razones sociales.
_SUFIJOS = re.compile(
    r"\b(s\.?a\.?s?|ltda|sas|s\.?e\.?n\.?c|e\.?s\.?p|"
    r"cia|compania|colombiana|colombia|de|del|la|el|planta)\b",
    re.IGNORECASE,
)


def sin_tildes(texto: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", texto)
        if unicodedata.category(c) != "Mn"
    )


def normalizar(nombre: str) -> str:
    """Reduce una razon social a su nucleo comparable."""
    limpio = _SUFIJOS.sub(" ", sin_tildes(nombre).lower())
    limpio = re.sub(r"[^a-z0-9 ]+", " ", limpio)
    return " ".join(limpio.split())


def parecido(a: str, b: str) -> float:
    """Similitud entre dos razones sociales, 0-1."""
    na, nb = normalizar(a), normalizar(b)
    if not na or not nb:
        return 0.0
    if na in nb or nb in na:
        return 1.0
    return SequenceMatcher(None, na, nb).ratio()
