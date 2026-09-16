"""Instantanea ilustrativa del corredor industrial de Mamonal, Cartagena.

QUE ES ESTO Y QUE NO ES
=======================

**Es** una instantanea de trabajo, sin conexion, que ejercita el pipeline
completo cuando no hay red o cuando una fuente esta caida. Sirve para
demostrar y para desarrollar.

**No es** una consulta en vivo. Con `SIMBIA_SCOUT_MODO=vivo` las mismas
fuentes salen a OpenStreetMap y al portal de datos abiertos de verdad, y
estos registros no se usan.

DOS NIVELES DE VERACIDAD, DELIBERADAMENTE DISTINTOS
---------------------------------------------------

1. **Capa cartografica (`registros_osm`).** Nombres y ubicaciones
   aproximadas de establecimientos industriales del corredor de Mamonal.
   Son hechos publicos de mapa: cualquiera puede verificarlos en
   OpenStreetMap. Las coordenadas estan redondeadas al orden de la centena
   de metros y las superficies son aproximaciones del poligono del predio.

2. **Capa de vertimientos (`registros_permisos`).** Registros de
   DEMOSTRACION, con identificadores `EJEMPLO-nn`. **No se ha consultado
   ningun permiso real y ninguna cifra de esta capa esta atribuida a
   ninguna empresa concreta.** Existen para ejercitar el camino de codigo
   que procesa analitica medida. Al configurar el conjunto de datos real en
   `archivo/fuentes.json`, esta capa se sustituye por permisos autenticos.

REGLA QUE NO SE ROMPE
---------------------

Ninguna caracterizacion de agua de este modulo es una medida atribuida a una
empresa real. Todo lo que el sistema sabe del efluente de una empresa
nombrada sale del arquetipo sectorial (`ciiu.py`), viaja marcado como
INFERIDO y el dashboard lo muestra como tal. La analitica real solo entra
por dos puertas: un permiso de vertimiento autentico, o una caracterizacion
de campo cargada a mano.
"""

from __future__ import annotations

from .base import RegistroCrudo

#: (nombre, lat, lon, area_m2, etiquetas OSM)
#: Coordenadas aproximadas sobre el eje de la via Mamonal. Aproximadas a
#: proposito: sirven para ordenar por cercania, no para replantear una obra.
_ESTABLECIMIENTOS: tuple[tuple[str, float, float, float, str], ...] = (
    (
        "Refineria de Cartagena", 10.3268, -75.5045, 1_400_000.0,
        "landuse=industrial industrial=refinery product=petroleum",
    ),
    (
        "Esenttia", 10.3195, -75.5011, 210_000.0,
        "landuse=industrial industrial=chemical product=polypropylene",
    ),
    (
        "Dow Quimica de Colombia", 10.3162, -75.4998, 95_000.0,
        "landuse=industrial industrial=chemical",
    ),
    (
        "Cementos Argos - Planta Cartagena", 10.3081, -75.4952, 168_000.0,
        "landuse=industrial industrial=cement product=cement",
    ),
    (
        "Biofilm", 10.3211, -75.5028, 78_000.0,
        "landuse=industrial industrial=plastic product=bopp_film",
    ),
    (
        "Ajover", 10.3054, -75.4938, 52_000.0,
        "landuse=industrial industrial=plastic",
    ),
    (
        "Lamitech", 10.3018, -75.4921, 41_000.0,
        "landuse=industrial industrial=paper product=laminates",
    ),
    (
        "Abocol", 10.3229, -75.5033, 132_000.0,
        "landuse=industrial industrial=chemical product=fertilizer",
    ),
    (
        "Proelectrica", 10.3141, -75.4979, 62_000.0,
        "power=plant plant:source=gas landuse=industrial",
    ),
    (
        "Termocandelaria", 10.3103, -75.4964, 74_000.0,
        "power=plant plant:source=gas landuse=industrial",
    ),
    (
        "Contecar - Terminal de Contenedores", 10.3312, -75.5088, 320_000.0,
        "landuse=industrial industrial=port man_made=works",
    ),
    (
        "Cerveceria Bavaria - Planta Cartagena", 10.3402, -75.4894, 58_000.0,
        "landuse=industrial industrial=brewery product=beer",
    ),
    (
        "Indufrial", 10.2987, -75.4903, 36_000.0,
        "landuse=industrial industrial=appliance",
    ),
    (
        "PTAR Punta Canoa - Acuacar", 10.3355, -75.5121, 88_000.0,
        "man_made=wastewater_plant operator=Acuacar",
    ),
    (
        "Alimentos del Caribe", 10.2951, -75.4885, 44_000.0,
        "landuse=industrial industrial=food",
    ),
    (
        "Petroquimica del Caribe", 10.3178, -75.5019, 67_000.0,
        "landuse=industrial industrial=chemical",
    ),
    # Estos dos emparejan con los permisos de demostracion de mas abajo.
    # Existen para que el barrido de ejemplo ejercite la fusion entre
    # fuentes: el mismo establecimiento visto por el mapa y por el registro
    # de vertimientos se funde en un unico prospecto, y la analitica del
    # permiso eleva su confianza de baja a media.
    (
        "Planta quimica de ejemplo A", 10.3151, -75.4988, 88_000.0,
        "landuse=industrial industrial=chemical",
    ),
    (
        "Planta de bebidas de ejemplo B", 10.3391, -75.4903, 47_000.0,
        "landuse=industrial industrial=brewery product=beverages",
    ),
)


def registros_osm() -> list[RegistroCrudo]:
    """Capa cartografica. Hechos publicos de mapa, sin dato de agua."""
    return [
        RegistroCrudo(
            fuente="osm",
            identificador=f"way/fixture-{i:03d}",
            nombre=nombre,
            lat=lat,
            lon=lon,
            atributos={
                "area_m2": area,
                "etiquetas": etiquetas,
                "operador": "",
                "producto": "",
                "industria": "",
                "_instantanea": True,
            },
            url="https://www.openstreetmap.org/",
        )
        for i, (nombre, lat, lon, area, etiquetas) in enumerate(
            _ESTABLECIMIENTOS, start=1
        )
    ]


#: Registros de DEMOSTRACION de permisos de vertimiento. Identificadores
#: `EJEMPLO-nn` y razones sociales genericas: no corresponden a ninguna
#: empresa real ni a ningun expediente real. Ejercitan el camino de codigo
#: que convierte analitica declarada en un prospecto de confianza alta.
_PERMISOS_EJEMPLO: tuple[dict[str, object], ...] = (
    {
        "id": "EJEMPLO-01",
        "razon_social": "Planta quimica de ejemplo A (registro de demostracion)",
        "lat": 10.3149, "lon": -75.4986,
        "ciiu": "2011",
        "caudal_l_s": 11.5,
        "cuerpo": "Bahia de Cartagena",
        "calidad": {"ph": 7.85, "dqo": 14.0, "sst": 8.0},
    },
    {
        "id": "EJEMPLO-02",
        "razon_social": "Planta de bebidas de ejemplo B (registro de demostracion)",
        "lat": 10.3389, "lon": -75.4901,
        "ciiu": "1103",
        "caudal_l_s": 8.2,
        "cuerpo": "Alcantarillado - Acuacar",
        "calidad": {"ph": 6.95, "dqo": 288.0, "sst": 39.0, "n_amoniacal": 2.4},
    },
    {
        "id": "EJEMPLO-03",
        "razon_social": "Terminal portuaria de ejemplo C (registro de demostracion)",
        "lat": 10.3305, "lon": -75.5079,
        "ciiu": "5222",
        "caudal_l_s": 4.6,
        "cuerpo": "Bahia de Cartagena",
        "calidad": {"ph": 7.4, "dqo": 132.0, "sst": 195.0},
    },
)


def registros_permisos() -> list[RegistroCrudo]:
    """Capa de vertimientos. Registros de demostracion, no expedientes reales."""
    return [
        RegistroCrudo(
            fuente="datos_gov",
            identificador=str(p["id"]),
            nombre=str(p["razon_social"]),
            lat=float(p["lat"]),
            lon=float(p["lon"]),
            atributos={
                "ciiu": p["ciiu"],
                "caudal_m3_h": round(float(p["caudal_l_s"]) * 3.6, 2),
                "cuerpo_receptor": p["cuerpo"],
                "calidad_medida": p["calidad"],
                "_demostracion": True,
            },
            url="",
        )
        for p in _PERMISOS_EJEMPLO
    ]
