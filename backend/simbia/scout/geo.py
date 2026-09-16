"""Geometria de la prospeccion: donde esta cada cosa y cuanta tuberia hace falta.

La distancia en linea recta es un limite inferior inutil para presupuestar: una
conduccion sigue corredores existentes, bordea predios ajenos y cruza vias,
lineas ferreas y cuerpos de agua. Subestimar el trazado un 40 % subestima el
CAPEX de conduccion en la misma proporcion, y en este proyecto la conduccion
es una fraccion grande de la inversion.

Aqui se estima el trazado con un factor de tortuosidad por tipo de corredor
mas una penalizacion por cada cruce singular. Es una estimacion declarada, no
un levantamiento topografico: cuando exista el trazado real se sustituye
`distancia_conduccion` por la longitud medida y no cambia nada mas.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import Enum

RADIO_TIERRA_KM = 6371.0088


# --------------------------------------------------------------------------
# Ubicacion de la planta
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Sitio:
    """Un punto en el mapa con nombre."""

    nombre: str
    lat: float
    lon: float


#: Planta Cabot en la zona industrial de Mamonal, Cartagena de Indias.
#: SUPUESTO: coordenada aproximada del centroide del predio, tomada del eje
#: industrial de la via Mamonal. Sustituir por la coordenada levantada del
#: punto de entrega de agua (que es lo que importa, no el centroide del
#: predio: puede haber cientos de metros de diferencia).
PLANTA = Sitio("Cabot - Planta Mamonal", 10.3125, -75.4989)

#: Radio de busqueda por defecto. Mas alla de ~8 km la conduccion deja de ser
#: competitiva frente a captar agua cruda, salvo caudales muy grandes.
RADIO_BUSQUEDA_KM = 8.0


# --------------------------------------------------------------------------
# Distancias
# --------------------------------------------------------------------------

def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distancia geodesica entre dos puntos, en km."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = (
        math.sin(dp / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    )
    return 2 * RADIO_TIERRA_KM * math.asin(math.sqrt(a))


class Corredor(str, Enum):
    """Tipo de trazado disponible entre el oferente y la planta."""

    #: Rack de tuberias o servidumbre industrial ya existente. El mejor caso:
    #: solo hay que tender el tubo sobre soportes que ya estan.
    RACK_INDUSTRIAL = "rack_industrial"
    #: Derecho de via de carretera o linea ferrea. Trazado razonablemente
    #: directo pero con permisos y obra civil.
    VIA_PUBLICA = "via_publica"
    #: Sin corredor: hay que negociar servidumbres predio a predio.
    CAMPO_TRAVIESA = "campo_traviesa"


#: Factor de tortuosidad: cuanto tubo hace falta por cada km en linea recta.
#: Rangos de practica habitual en tendido industrial de tuberia.
FACTOR_TRAZADO: dict[Corredor, float] = {
    Corredor.RACK_INDUSTRIAL: 1.15,
    Corredor.VIA_PUBLICA: 1.35,
    Corredor.CAMPO_TRAVIESA: 1.60,
}


class Cruce(str, Enum):
    """Singularidades que anaden longitud y obra al trazado."""

    VIA_PRINCIPAL = "via_principal"    # cruce bajo calzada: hinca o tunel liner
    FERROCARRIL = "ferrocarril"
    CANO_O_ARROYO = "cano_o_arroyo"
    LINEA_COSTERA = "linea_costera"    # bordear una ensenada o un muelle


#: Longitud equivalente que anade cada cruce, en km de tubo. Recoge el rodeo
#: y el sobrecosto de la obra especial expresado como longitud.
PENALIZACION_CRUCE_KM: dict[Cruce, float] = {
    Cruce.VIA_PRINCIPAL: 0.15,
    Cruce.FERROCARRIL: 0.25,
    Cruce.CANO_O_ARROYO: 0.35,
    Cruce.LINEA_COSTERA: 0.80,
}


def distancia_conduccion_km(
    lat: float,
    lon: float,
    corredor: Corredor = Corredor.VIA_PUBLICA,
    cruces: tuple[Cruce, ...] = (),
    origen: Sitio = PLANTA,
) -> tuple[float, float]:
    """Devuelve (distancia en linea recta, longitud estimada de conduccion).

    Se devuelven las dos porque la diferencia entre ambas es informacion:
    un prospecto a 1 km en linea recta pero con 2,4 km de trazado por bordear
    una ensenada no es el mismo negocio que uno a 1 km sobre un rack existente.
    """
    recta = haversine_km(origen.lat, origen.lon, lat, lon)
    trazado = recta * FACTOR_TRAZADO[corredor]
    trazado += sum(PENALIZACION_CRUCE_KM[c] for c in cruces)
    return round(recta, 3), round(trazado, 3)


# --------------------------------------------------------------------------
# Proyeccion para el mapa
# --------------------------------------------------------------------------

def proyectar(
    lat: float, lon: float, origen: Sitio = PLANTA,
) -> tuple[float, float]:
    """Proyecta a km relativos a la planta (x este, y norte).

    Equirectangular centrada en la planta. A escala de un parque industrial
    (pocos km) el error frente a una proyeccion conforme es despreciable, y
    evita arrastrar una dependencia de proyecciones cartograficas.
    """
    x = (
        math.radians(lon - origen.lon)
        * RADIO_TIERRA_KM
        * math.cos(math.radians(origen.lat))
    )
    y = math.radians(lat - origen.lat) * RADIO_TIERRA_KM
    return round(x, 4), round(y, 4)
