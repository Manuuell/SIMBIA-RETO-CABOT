"""Registros publicos colombianos via Socrata (datos.gov.co).

Aqui esta el dato que de verdad vale: un **permiso de vertimiento** trae
caudal autorizado y caracterizacion analitica de la corriente. Eso convierte
un prospecto inferido en uno medido y multiplica por dos su confianza.

Portal: datos.gov.co, que expone Socrata Open Data API (SODA). El acceso es
publico y sin clave para volumenes moderados; una `app_token` sube el limite
de peticiones y se toma de la variable de entorno `SOCRATA_APP_TOKEN` si
existe.

**Estado: sin verificar.** El conector esta completo, pero cada conjunto de
datos de datos.gov.co tiene su propio identificador de cuatro-cuatro
caracteres y sus propios nombres de columna, y no estan normalizados entre
entidades. En vez de inventar identificadores que probablemente no existan,
la configuracion vive en `archivo/fuentes.json` y se declara no verificada
hasta que alguien con acceso al portal la rellene y la marque. Mientras
tanto la fuente sirve fixtures y lo dice.

Que rellenar: entrar a datos.gov.co, buscar "permisos de vertimiento" o el
conjunto que publique la autoridad ambiental competente (CARDIQUE para el
distrito de Cartagena y el norte de Bolivar; EPA Cartagena en el perimetro
urbano), copiar el identificador del conjunto de la URL y mapear las columnas.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .base import TIMEOUT_S, USER_AGENT, Fuente, RegistroCrudo

CONFIG = Path(__file__).resolve().parent.parent / "archivo" / "fuentes.json"

DOMINIO = "https://www.datos.gov.co"


@dataclass
class ConfiguracionSocrata:
    """Como leer un conjunto de datos concreto del portal.

    Se externaliza a JSON porque cambia sin previo aviso: una entidad
    republica su conjunto con otro identificador y el codigo no deberia
    enterarse.
    """

    conjunto: str = ""                 # identificador tipo "abcd-1234"
    descripcion: str = ""
    verificado: bool = False
    campo_nombre: str = "razon_social"
    campo_lat: str = "latitud"
    campo_lon: str = "longitud"
    campo_caudal: str = "caudal_autorizado_l_s"
    campo_ciiu: str = "codigo_ciiu"
    campo_cuerpo: str = "cuerpo_receptor"
    #: Mapa parametro de SIMBIA -> columna del conjunto. Solo los que existan.
    campos_calidad: dict[str, str] = field(default_factory=dict)

    @property
    def url(self) -> str:
        return f"{DOMINIO}/resource/{self.conjunto}.json"


def cargar_configuracion() -> ConfiguracionSocrata:
    if CONFIG.is_file():
        try:
            bruto = json.loads(CONFIG.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return ConfiguracionSocrata()
        datos = bruto.get("datos_gov", {})
        conocidos = ConfiguracionSocrata.__dataclass_fields__
        return ConfiguracionSocrata(
            **{k: v for k, v in datos.items() if k in conocidos}
        )
    return ConfiguracionSocrata()


class FuenteDatosGov(Fuente):
    codigo = "datos_gov"
    nombre = "datos.gov.co - permisos de vertimiento (Socrata)"
    url_base = DOMINIO
    licencia = "Datos abiertos - Ley 1712 de 2014"
    intervalo_s = 1.5
    ttl_horas = 24.0 * 14

    def __init__(self) -> None:
        self.config = cargar_configuracion()
        self.verificada = bool(
            self.config.conjunto and self.config.verificado
        )
        # La primera frase es la que ve el usuario en la tarjeta; el resto
        # va en el tooltip. Lo importante: no es que falte configurar algo,
        # es que para Cartagena no hay nada que configurar.
        self.nota_configuracion = (
            "No aplica en Cartagena: ni CARDIQUE ni EPA Cartagena publican "
            "permisos de vertimiento en datos.gov.co (comprobado el 16 de "
            "septiembre de 2026 contra el catalogo del portal: 44 conjuntos con "
            "'vertimiento', solo Corpoboyaca y Corantioquia son permisos). "
            "Los permisos de Cartagena salen de VITAL. El conector queda listo "
            "para otras jurisdicciones: rellenar 'datos_gov.conjunto' en "
            "archivo/fuentes.json y marcar verificado=true."
        )

    def _clave(self, lat: float, lon: float, radio_km: float) -> str:
        return f"socrata:{self.config.conjunto}:{lat:.5f},{lon:.5f},{radio_km:.1f}"

    def _consultar_red(
        self, lat: float, lon: float, radio_km: float,
    ) -> list[RegistroCrudo]:
        import httpx2 as httpx

        cabeceras = {"User-Agent": USER_AGENT}
        ficha = os.environ.get("SOCRATA_APP_TOKEN", "").strip()
        if ficha:
            cabeceras["X-App-Token"] = ficha

        c = self.config
        # SoQL: filtro por caja de coordenadas. Se usa una caja y no
        # within_circle porque este ultimo exige que la columna sea de tipo
        # punto geoespacial, y muchos conjuntos publican lat/lon como numeros.
        margen = radio_km / 111.0
        where = (
            f"{c.campo_lat} between {lat - margen} and {lat + margen} "
            f"AND {c.campo_lon} between {lon - margen} and {lon + margen}"
        )
        respuesta = httpx.get(
            c.url,
            params={"$limit": 2000, "$where": where},
            headers=cabeceras,
            timeout=TIMEOUT_S,
        )
        respuesta.raise_for_status()
        return self._interpretar(respuesta.json())

    def _interpretar(self, filas: list[dict[str, Any]]) -> list[RegistroCrudo]:
        c = self.config
        registros: list[RegistroCrudo] = []
        for i, fila in enumerate(filas):
            nombre = str(fila.get(c.campo_nombre, "")).strip()
            try:
                lat = float(fila[c.campo_lat])
                lon = float(fila[c.campo_lon])
            except (KeyError, TypeError, ValueError):
                continue
            if not nombre:
                continue

            atributos: dict[str, Any] = {
                "ciiu": str(fila.get(c.campo_ciiu, "")).strip(),
                "cuerpo_receptor": str(fila.get(c.campo_cuerpo, "")).strip(),
            }
            # El caudal en los permisos viene casi siempre en L/s.
            bruto = fila.get(c.campo_caudal)
            if bruto not in (None, ""):
                try:
                    atributos["caudal_m3_h"] = round(float(bruto) * 3.6, 2)
                except (TypeError, ValueError):
                    pass

            calidad: dict[str, float] = {}
            for parametro, columna in c.campos_calidad.items():
                valor = fila.get(columna)
                if valor in (None, ""):
                    continue
                try:
                    calidad[parametro] = float(valor)
                except (TypeError, ValueError):
                    continue
            if calidad:
                atributos["calidad_medida"] = calidad

            registros.append(
                RegistroCrudo(
                    fuente=self.codigo,
                    identificador=str(
                        fila.get(":id") or fila.get("id") or f"fila-{i}"
                    ),
                    nombre=nombre,
                    lat=lat,
                    lon=lon,
                    atributos=atributos,
                    url=f"{DOMINIO}/d/{c.conjunto}",
                )
            )
        return registros

    def _fixture(self) -> list[RegistroCrudo]:
        from .fixtures_mamonal import registros_permisos
        return registros_permisos()
