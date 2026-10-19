"""Fuentes de agua que pueden entrar al simulador.

Una fuente es un vecino tal como lo ve quien negocia con el: cuanta agua
tiene, como es, a que distancia esta y cuanto se fia uno de esos numeros.
Puede salir de un prospecto del barrido o escribirse a mano cuando el vecino
entrega su analitica; en ambos casos llega al motor con la misma forma.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..domain.streams import Oferente
from ..domain.water_chem import Calidad
from ..scout.perfil import Prospecto

#: Vocabulario de procedencia, el mismo que usa la prospeccion.
PROCEDENCIAS = ("medido", "declarado", "inferido", "supuesto")


@dataclass(frozen=True)
class Fuente:
    id: str
    nombre: str
    calidad: Calidad
    caudal_disponible_m3_h: float
    distancia_km: float
    #: USD/m3 que se paga al vecino. Negativo: el vecino paga por entregarla
    #: porque se ahorra su vertimiento.
    precio_usd_m3: float = 0.0
    procedencia: str = "supuesto"
    confianza: float | None = None
    sector: str = ""
    corriente: str = ""
    tren_sugerido: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "nombre": self.nombre, "sector": self.sector,
            "corriente": self.corriente,
            "caudal_disponible_m3_h": round(self.caudal_disponible_m3_h, 2),
            "distancia_km": round(self.distancia_km, 2),
            "precio_usd_m3": round(self.precio_usd_m3, 3),
            "procedencia": self.procedencia, "confianza": self.confianza,
            "tren_sugerido": self.tren_sugerido,
            "calidad": self.calidad.as_dict(),
        }


def desde_prospecto(p: Prospecto, clave: str) -> Fuente:
    return Fuente(
        id=clave, nombre=p.nombre, calidad=p.calidad,
        caudal_disponible_m3_h=p.caudal_m3_h,
        distancia_km=p.distancia_conduccion_km,
        precio_usd_m3=p.incentivo_usd_m3,
        procedencia=p.metodo_calidad.value, confianza=p.confianza,
        sector=p.sector, corriente=p.corriente, tren_sugerido=p.tren_sugerido,
    )


def oferente(f: Fuente, codigo: str | None = None) -> Oferente:
    """La fuente como entrada de catalogo del optimizador.

    La disponibilidad se castiga con la confianza igual que en
    `scout.promocion`: una fuente poco fiable entra con menos caudal seguro.
    """
    disponibilidad = (
        0.95 if f.confianza is None else round(0.95 * (0.6 + 0.4 * f.confianza), 3)
    )
    return Oferente(
        codigo=codigo or f.id, empresa=f.nombre, sector=f.sector,
        corriente=f.corriente, caudal_disponible_m3_h=f.caudal_disponible_m3_h,
        calidad=f.calidad, distancia_km=f.distancia_km,
        precio_usd_m3=f.precio_usd_m3, disponibilidad=disponibilidad,
    )
