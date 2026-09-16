"""Caracterizaciones analiticas reales de corrientes concretas.

Es el nivel mas alto de evidencia del modulo. Aqui no hay arquetipo sectorial
ni inferencia: son resultados de laboratorio acreditado sobre el vertimiento
de una empresa nombrada, con el informe citado.

Todo lo que entre aqui se marca como MEDIDO y pisa a la estimacion del
arquetipo, parametro por parametro. Lo que el laboratorio no midio se queda
como estaba, inferido y declarado como tal: un informe de caracterizacion
sigue la Resolucion 0631, que no exige todos los parametros que necesita el
balance de una torre de enfriamiento. Cloruros, silice y conductividad no
suelen venir, y no se inventan.

REGLA
-----

Sin informe citado no entra nada. La ruta hasta el documento tiene que poder
recorrerla un tercero.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from ..domain.water_chem import Calidad
from .perfil import Metodo
from .texto import normalizar, parecido


@dataclass(frozen=True)
class Analitica:
    """Resultado de laboratorio de una corriente concreta."""

    #: Variantes del nombre de la empresa, como las escriben las fuentes.
    nombres: tuple[str, ...]
    punto: str                      # que punto de vertimiento es
    laboratorio: str
    informe: str
    fecha: str
    muestras: int
    #: Solo los parametros que el laboratorio midio. El resto no se toca.
    medido: dict[str, float]
    caudal_m3_h: float | None
    expediente: str
    fuente: str                     # de donde salio el documento
    nota: str = ""

    def aplicar(self, base: Calidad) -> tuple[Calidad, frozenset[str]]:
        validos = {k: v for k, v in self.medido.items() if hasattr(base, k)}
        if not validos:
            return base, frozenset()
        return replace(base, **validos), frozenset(validos)


ANALITICAS: tuple[Analitica, ...] = (
    Analitica(
        nombres=("yara colombia", "abocol", "abonos colombianos"),
        punto="Punto 1 - Planta Norte (agua residual no domestica)",
        laboratorio="Laboratorio Microbiologico Barranquilla SAS (LMB)",
        informe="Informe 43028 - caracterizacion de junio de 2026",
        fecha="2026-07-17",
        muestras=3,
        # Promedio de tres muestras compuestas (30/06, 01/07 y 02/07 de 2026).
        # Laboratorio acreditado por el IDEAM bajo NTC-ISO/IEC 17025:2017.
        medido={
            "ph": 7.5,              # rangos 7,11-7,70 en las tres jornadas
            "t_c": 36.19,
            "alcalinidad": 55.73,   # mg CaCO3/L
            "dureza_ca": 156.0,     # mg CaCO3/L
            "dqo": 43.73,           # mg O2/L
            "sst": 9.67,
            "sulfatos": 116.46,
            "n_amoniacal": 64.43,   # mg NH3-N/L
            "fosfatos": 0.15,       # fosforo total, por debajo del limite de cuantificacion
        },
        caudal_m3_h=38.1,           # 10,59 L/s de promedio
        expediente="1070860006333526001",
        fuente=(
            "VITAL - EPA Cartagena, tramite 348_VITAL_VERTIMIENTO_CUERPO_A, "
            "radicado 28/07/2026"
        ),
        nota=(
            "El laboratorio no midio cloruros, silice, hierro ni conductividad: "
            "la Resolucion 0631 no los exige para este sector. Esos cuatro "
            "siguen viniendo del arquetipo y siguen marcados como inferidos."
        ),
    ),
)

UMBRAL_CRUCE = 0.88


def buscar(nombre: str) -> Analitica | None:
    """Analitica de esta empresa, si la hay."""
    objetivo = normalizar(nombre)
    if not objetivo:
        return None
    for a in ANALITICAS:
        if any(parecido(objetivo, v) >= UMBRAL_CRUCE for v in a.nombres):
            return a
    return None


def metodo() -> Metodo:
    """Laboratorio acreditado sobre el vertimiento real: esto si es MEDIDO."""
    return Metodo.MEDIDO
