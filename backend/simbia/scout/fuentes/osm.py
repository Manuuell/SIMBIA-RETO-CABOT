"""OpenStreetMap via Overpass: quien hay fisicamente alrededor de la planta.

Es la fuente mas util para arrancar y la unica que funciona en cualquier parte
del mundo sin registrarse en nada. Da tres cosas que ninguna otra da juntas:

  - **posicion real**, que es lo que determina el CAPEX de conduccion,
  - **superficie del predio**, unico proxy de tamano disponible sin datos
    financieros, y de ahi sale la estimacion de caudal,
  - **el nombre**, que es la llave para cruzar con los registros nacionales.

Lo que no da es nada sobre el agua. Para eso estan el arquetipo sectorial
(`ciiu.py`) y los registros de vertimientos.

Datos (c) colaboradores de OpenStreetMap, bajo ODbL. La licencia obliga a
atribuir y a compartir derivados en las mismas condiciones; el dashboard
muestra la atribucion.
"""

from __future__ import annotations

import math
from typing import Any

from ..geo import RADIO_TIERRA_KM
from .base import (
    TIMEOUT_S, USER_AGENT, Fuente, RegistroCrudo,
)

ENDPOINT = "https://overpass-api.de/api/interpreter"

#: Etiquetas OSM que identifican un establecimiento industrial. La consulta
#: es deliberadamente amplia: es mas barato descartar un falso positivo en el
#: filtrado que no enterarse de que existe un vecino.
CONSULTA = """
[out:json][timeout:60];
(
  way["landuse"="industrial"](around:{radio_m},{lat},{lon});
  way["man_made"="works"](around:{radio_m},{lat},{lon});
  node["man_made"="works"](around:{radio_m},{lat},{lon});
  way["industrial"](around:{radio_m},{lat},{lon});
  way["power"="plant"](around:{radio_m},{lat},{lon});
  way["man_made"="wastewater_plant"](around:{radio_m},{lat},{lon});
);
out geom tags;
"""


def _area_y_centroide(
    geometria: list[dict[str, float]], lat_ref: float,
) -> tuple[float, float, float]:
    """Area en m2 y centroide de un poligono de OSM.

    Formula del cordon (shoelace) sobre coordenadas proyectadas a metros
    localmente. A escala de un predio industrial la distorsion es
    despreciable y evita depender de una libreria geoespacial.
    """
    if len(geometria) < 3:
        if not geometria:
            return 0.0, 0.0, 0.0
        lat = sum(p["lat"] for p in geometria) / len(geometria)
        lon = sum(p["lon"] for p in geometria) / len(geometria)
        return 0.0, lat, lon

    m_por_grado_lat = RADIO_TIERRA_KM * 1000.0 * math.pi / 180.0
    m_por_grado_lon = m_por_grado_lat * math.cos(math.radians(lat_ref))

    puntos = [
        (p["lon"] * m_por_grado_lon, p["lat"] * m_por_grado_lat)
        for p in geometria
    ]
    if puntos[0] != puntos[-1]:
        puntos.append(puntos[0])

    area2 = 0.0
    cx = cy = 0.0
    for (x0, y0), (x1, y1) in zip(puntos, puntos[1:]):
        cruz = x0 * y1 - x1 * y0
        area2 += cruz
        cx += (x0 + x1) * cruz
        cy += (y0 + y1) * cruz

    area = abs(area2) / 2.0
    if abs(area2) < 1e-9:
        lat = sum(p["lat"] for p in geometria) / len(geometria)
        lon = sum(p["lon"] for p in geometria) / len(geometria)
        return 0.0, lat, lon

    cx /= 3.0 * area2
    cy /= 3.0 * area2
    return area, cy / m_por_grado_lat, cx / m_por_grado_lon


class FuenteOSM(Fuente):
    codigo = "osm"
    nombre = "OpenStreetMap (Overpass API)"
    url_base = ENDPOINT
    licencia = "ODbL 1.0 - (c) colaboradores de OpenStreetMap"
    #: Overpass es un servicio comunitario y gratuito. Su politica de uso
    #: pide moderacion; un intervalo generoso es lo minimo exigible.
    intervalo_s = 5.0
    ttl_horas = 24.0 * 30

    def _clave(self, lat: float, lon: float, radio_km: float) -> str:
        return f"overpass:{lat:.5f},{lon:.5f},{radio_km:.1f}"

    def _consultar_red(
        self, lat: float, lon: float, radio_km: float,
    ) -> list[RegistroCrudo]:
        import httpx2 as httpx

        consulta = CONSULTA.format(
            radio_m=int(radio_km * 1000), lat=lat, lon=lon,
        )
        respuesta = httpx.post(
            ENDPOINT,
            data={"data": consulta},
            headers={"User-Agent": USER_AGENT},
            timeout=TIMEOUT_S,
        )
        respuesta.raise_for_status()
        return self._interpretar(respuesta.json(), lat)

    def _interpretar(
        self, cuerpo: dict[str, Any], lat_ref: float,
    ) -> list[RegistroCrudo]:
        registros: list[RegistroCrudo] = []
        for elemento in cuerpo.get("elements", []):
            etiquetas = elemento.get("tags", {}) or {}
            nombre = (
                etiquetas.get("name")
                or etiquetas.get("operator")
                or etiquetas.get("brand")
                or ""
            ).strip()
            # Un poligono industrial sin nombre no sirve para prospectar: no
            # se puede cruzar con ningun registro ni llamar a nadie.
            if not nombre:
                continue

            if elemento.get("type") == "node":
                area, lat_c, lon_c = 0.0, elemento["lat"], elemento["lon"]
            else:
                area, lat_c, lon_c = _area_y_centroide(
                    elemento.get("geometry", []) or [], lat_ref,
                )
            if not lat_c or not lon_c:
                continue

            ident = f"{elemento.get('type', 'way')}/{elemento.get('id')}"
            registros.append(
                RegistroCrudo(
                    fuente=self.codigo,
                    identificador=ident,
                    nombre=nombre,
                    lat=lat_c,
                    lon=lon_c,
                    atributos={
                        "area_m2": round(area, 0),
                        "etiquetas": " ".join(
                            f"{k}={v}" for k, v in etiquetas.items()
                        ),
                        "operador": etiquetas.get("operator", ""),
                        "producto": etiquetas.get("product", ""),
                        "industria": etiquetas.get("industrial", ""),
                    },
                    url=f"https://www.openstreetmap.org/{ident}",
                )
            )
        return registros

    def _fixture(self) -> list[RegistroCrudo]:
        from .fixtures_mamonal import registros_osm
        return registros_osm()
