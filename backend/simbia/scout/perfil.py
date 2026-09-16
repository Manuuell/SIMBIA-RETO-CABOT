"""Modelo de datos de la prospeccion.

La regla de oro del modulo: NINGUN dato viaja sin decir de donde salio y
cuanto vale. Un caudal medido en el permiso de vertimiento y un caudal
inferido del codigo CIIU son numeros del mismo tipo pero no valen lo mismo,
y el resto del sistema tiene que poder distinguirlos.

Por eso cada prospecto arrastra:
  - el metodo con que se obtuvo cada bloque de informacion,
  - las referencias concretas (fuente, identificador, fecha de consulta),
  - una confianza agregada que penaliza las inferencias.

El optimizador solo acepta prospectos por encima de un umbral de confianza,
y el dashboard nunca muestra un numero inferido con el mismo peso visual que
uno medido.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date
from enum import Enum
from typing import Any

from ..domain.water_chem import Calidad


class Metodo(str, Enum):
    """Como se obtuvo un dato. Ordenado de mas a menos fiable."""

    MEDIDO = "medido"          # analitica de laboratorio del vertimiento real
    DECLARADO = "declarado"    # la empresa o el permiso lo declara, sin analitica
    INFERIDO = "inferido"      # modelo CIIU -> arquetipo de efluente
    SUPUESTO = "supuesto"      # rango tipico de industria, sin nada especifico


#: Confianza base por metodo. Es deliberadamente severa con lo inferido: un
#: arquetipo sectorial acierta el orden de magnitud, no el numero.
CONFIANZA_METODO: dict[Metodo, float] = {
    Metodo.MEDIDO: 0.95,
    Metodo.DECLARADO: 0.70,
    Metodo.INFERIDO: 0.45,
    Metodo.SUPUESTO: 0.20,
}


class Estado(str, Enum):
    """Etapa del prospecto en el embudo de contratacion.

    El orden importa: es el avance del pipeline y lo usa el dashboard para
    ordenar y para calcular cuanto caudal esta realmente asegurado.
    """

    DETECTADO = "detectado"              # aparecio en una fuente, nada mas
    CALIFICADO = "calificado"            # pasa el filtro tecnico y economico
    CONTACTADO = "contactado"            # hay interlocutor identificado
    NDA = "nda"                          # acuerdo de confidencialidad firmado
    CARACTERIZADO = "caracterizado"      # hay analitica real de la corriente
    PILOTO = "piloto"                    # prueba en campo en curso
    CONTRATADO = "contratado"            # contrato de suministro firmado
    DESCARTADO = "descartado"            # no viable (tecnico, economico o comercial)


ORDEN_ESTADO: tuple[Estado, ...] = (
    Estado.DETECTADO, Estado.CALIFICADO, Estado.CONTACTADO, Estado.NDA,
    Estado.CARACTERIZADO, Estado.PILOTO, Estado.CONTRATADO,
)

#: Solo desde CARACTERIZADO hay analitica real: antes, el caudal comprometido
#: es una expectativa, no un compromiso.
ESTADOS_CON_ANALITICA = frozenset({
    Estado.CARACTERIZADO, Estado.PILOTO, Estado.CONTRATADO,
})


@dataclass(frozen=True)
class Referencia:
    """Puntero al registro concreto del que salio un dato.

    Sirve para dos cosas: auditar (un tercero puede ir a verificarlo) y
    detectar cambios (la vigilancia compara registros por identificador).
    """

    fuente: str            # codigo de la fuente: "osm", "datos_gov", "ciiu", "manual"
    identificador: str     # id del registro dentro de la fuente
    descripcion: str = ""
    url: str = ""
    consultado: str = field(default_factory=lambda: date.today().isoformat())

    def as_dict(self) -> dict[str, str]:
        return {
            "fuente": self.fuente, "identificador": self.identificador,
            "descripcion": self.descripcion, "url": self.url,
            "consultado": self.consultado,
        }


@dataclass(frozen=True)
class Prospecto:
    """Una empresa vecina candidata a entregar su agua de rechazo.

    Es el equivalente prospectivo del `Oferente` del catalogo: misma
    informacion, pero con procedencia y confianza en vez de darla por buena.
    `promocion.py` convierte uno en otro cuando la confianza lo permite.
    """

    codigo: str
    nombre: str
    sector: str
    ciiu: str
    corriente: str                    # descripcion de la corriente de rechazo

    lat: float
    lon: float
    distancia_linea_km: float         # distancia geodesica (limite inferior)
    distancia_conduccion_km: float    # trazado estimado de tuberia

    caudal_m3_h: float
    calidad: Calidad

    metodo_caudal: Metodo = Metodo.INFERIDO
    metodo_calidad: Metodo = Metodo.INFERIDO
    #: Parametros con analitica real, aunque el resto sea inferido. Un permiso
    #: de vertimiento suele traer DQO, SST y pH medidos y nada mas.
    campos_medidos: frozenset[str] = frozenset()

    #: Lo que el vecino se ahorra por no verter, USD/m3. Negativo significa
    #: que le sale a cuenta pagar por entregarla: es el motor de la simbiosis.
    incentivo_usd_m3: float = 0.0

    estado: Estado = Estado.DETECTADO
    referencias: tuple[Referencia, ...] = ()
    limitante: str = ""
    notas: str = ""
    #: Rellenado por scoring.py. Fuera del constructor normal.
    puntaje: float | None = None
    detalle_puntaje: dict[str, float] = field(default_factory=dict)

    # ------------------------------------------------------------------
    # Confianza
    # ------------------------------------------------------------------

    @property
    def confianza(self) -> float:
        """Confianza agregada del prospecto, 0-1.

        Pondera calidad por encima de caudal: un caudal equivocado se
        renegocia, una calidad equivocada hunde los ciclos de la torre y se
        descubre cuando ya hay tuberia enterrada.
        """
        base = (
            0.65 * CONFIANZA_METODO[self.metodo_calidad]
            + 0.35 * CONFIANZA_METODO[self.metodo_caudal]
        )
        # Cada parametro con analitica real sube la confianza, con retornos
        # decrecientes: los primeros son los que mas informan.
        if self.campos_medidos:
            base += (1.0 - base) * min(0.6, 0.09 * len(self.campos_medidos))
        # Un permiso de vertimiento radicado prueba que la corriente existe y
        # esta regulada. Sube la confianza, pero mucho menos que una
        # analitica: saber que alguien vierte no es saber que vierte.
        if any(r.fuente == "vital" for r in self.referencias):
            base += (1.0 - base) * 0.25
        # Haber avanzado en el embudo implica contacto real con la empresa.
        if self.estado in ESTADOS_CON_ANALITICA:
            base = max(base, 0.9)
        return round(min(base, 0.99), 3)

    @property
    def confianza_etiqueta(self) -> str:
        c = self.confianza
        if c >= 0.80:
            return "alta"
        if c >= 0.55:
            return "media"
        return "baja"

    @property
    def caudal_m3_dia(self) -> float:
        return self.caudal_m3_h * 24.0

    def con_estado(self, estado: Estado) -> "Prospecto":
        return replace(self, estado=estado)

    def as_dict(self) -> dict[str, Any]:
        return {
            "codigo": self.codigo,
            "nombre": self.nombre,
            "sector": self.sector,
            "ciiu": self.ciiu,
            "corriente": self.corriente,
            "lat": round(self.lat, 6),
            "lon": round(self.lon, 6),
            "distancia_linea_km": round(self.distancia_linea_km, 2),
            "distancia_conduccion_km": round(self.distancia_conduccion_km, 2),
            "caudal_m3_h": round(self.caudal_m3_h, 1),
            "caudal_m3_dia": round(self.caudal_m3_dia, 0),
            "calidad": self.calidad.as_dict(),
            "indices": self.calidad.indices(),
            "metodo_caudal": self.metodo_caudal.value,
            "metodo_calidad": self.metodo_calidad.value,
            "campos_medidos": sorted(self.campos_medidos),
            "incentivo_usd_m3": round(self.incentivo_usd_m3, 3),
            "estado": self.estado.value,
            "confianza": self.confianza,
            "confianza_etiqueta": self.confianza_etiqueta,
            "referencias": [r.as_dict() for r in self.referencias],
            "limitante": self.limitante,
            "notas": self.notas,
            "puntaje": None if self.puntaje is None else round(self.puntaje, 1),
            "detalle_puntaje": {
                k: round(v, 1) for k, v in self.detalle_puntaje.items()
            },
        }
