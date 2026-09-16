"""De codigo de actividad economica a corriente de rechazo estimada.

Este modulo es el puente entre "existe una empresa aqui" y "esta agua se
puede reutilizar". Sin el, la prospeccion devuelve un listado de razones
sociales y nada mas; con el, devuelve corrientes que el optimizador puede
evaluar.

La idea es sencilla y vieja en ingenieria ambiental: **la actividad determina
el efluente**. Una planta de bebidas produce agua de lavado con DQU alta y
salinidad baja; una desmineralizadora produce rechazo con salinidad alta y
DQO despreciable. El codigo CIIU identifica la actividad, y el arquetipo
traduce esa actividad a una caracterizacion tipica.

Lo que este modulo NO hace es fingir precision. Un arquetipo acierta el orden
de magnitud y el parametro limitante, que es exactamente lo que hace falta
para decidir a quien visitar primero. La analitica real llega despues, y para
eso existe el resto del pipeline: el arquetipo prioriza el muestreo, no lo
sustituye.

Codigos segun CIIU Rev. 4 adaptada para Colombia (DANE).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from ..domain.water_chem import Calidad
from .perfil import Metodo


@dataclass(frozen=True)
class Arquetipo:
    """Corriente de rechazo tipica de un sector.

    caudal_ref_m3_h: caudal de rechazo reutilizable de una planta de tamano
        de referencia del sector. Se escala por el tamano real del predio.
    area_ref_m2: superficie construida de esa planta de referencia.
    cv: coeficiente de variacion tipico dentro del sector. Es la anchura
        honesta de la estimacion: cv=0.5 significa que el valor real cae
        habitualmente entre la mitad y el doble.
    incentivo_usd_m3: lo que el oferente se ahorra por no tener que verter
        esta corriente (tasa retributiva + tratamiento previo al vertimiento).
        Entra al modelo economico como precio negativo: es la razon por la que
        un vecino paga por entregar su rechazo.
    """

    clave: str
    nombre: str
    ciiu: tuple[str, ...]
    corriente: str
    caudal_ref_m3_h: float
    area_ref_m2: float
    calidad: Calidad
    cv: float
    limitante: str
    incentivo_usd_m3: float
    #: Palabras que aparecen en el nombre o las etiquetas OSM de una planta de
    #: este sector. Se usan cuando no hay codigo CIIU, que es lo habitual en
    #: fuentes cartograficas.
    pistas: tuple[str, ...] = ()


# --------------------------------------------------------------------------
# Catalogo de arquetipos
# --------------------------------------------------------------------------
# Valores de rangos tipicos de industria. Cada uno es un SUPUESTO declarado,
# igual que el resto del proyecto: se sustituyen por la analitica del permiso
# de vertimiento en cuanto se consigue.

ARQUETIPOS: tuple[Arquetipo, ...] = (
    Arquetipo(
        clave="refineria",
        nombre="Refinacion de petroleo",
        ciiu=("1921", "1922"),
        corriente="Purga de torres de enfriamiento y efluente de tratamiento",
        caudal_ref_m3_h=180.0, area_ref_m2=400_000.0,
        calidad=Calidad(
            ph=7.8, t_c=36.0, tds=1_850, dureza_ca=340, alcalinidad=310,
            cloruros=420, sulfatos=380, silice=45, sst=25, dqo=95,
            n_amoniacal=12.0, fosfatos=3.5, hierro=1.2,
        ),
        cv=0.45,
        limitante="Amonio y carga organica: exige biologico o afinado",
        incentivo_usd_m3=-0.28,
        pistas=("refineria", "refinery", "reficar", "petroleo", "crudo",
                "industrial=refinery", "ecopetrol"),
    ),
    Arquetipo(
        clave="petroquimica_desmi",
        nombre="Quimica basica - rechazo de desmineralizadora",
        ciiu=("2011", "2029"),
        corriente="Rechazo de osmosis inversa de la planta desmineralizadora",
        caudal_ref_m3_h=45.0, area_ref_m2=150_000.0,
        calidad=Calidad(
            ph=7.9, t_c=30.0, tds=3_200, dureza_ca=560, alcalinidad=420,
            cloruros=780, sulfatos=690, silice=95, sst=6, dqo=12,
            n_amoniacal=0.5, fosfatos=1.2, hierro=0.25,
        ),
        cv=0.35,
        limitante="Salinidad: hunde los ciclos alcanzables de la torre",
        incentivo_usd_m3=-0.15,
        pistas=("quimica", "chemical", "dow", "petroquimica", "polimeros"),
    ),
    Arquetipo(
        clave="nitrogenados",
        nombre="Fertilizantes nitrogenados y acido nitrico",
        ciiu=("2012",),
        corriente="Condensado de proceso de amoniaco y purga de torres",
        caudal_ref_m3_h=90.0, area_ref_m2=220_000.0,
        calidad=Calidad(
            ph=8.9, t_c=38.0, tds=1_150, dureza_ca=140, alcalinidad=290,
            cloruros=160, sulfatos=210, silice=28, sst=10, dqo=25,
            n_amoniacal=45.0, fosfatos=2.0, hierro=0.60,
        ),
        cv=0.50,
        limitante="Amonio muy alto: exige stripping o biologico dedicado",
        incentivo_usd_m3=-0.30,
        pistas=("fertilizante", "abocol", "yara", "amoniaco", "nitrato",
                "nitrogenados", "urea"),
    ),
    Arquetipo(
        clave="termoelectrica",
        nombre="Generacion electrica y cogeneracion",
        ciiu=("3511", "3530"),
        corriente="Purga continua de calderas de recuperacion",
        caudal_ref_m3_h=16.0, area_ref_m2=90_000.0,
        calidad=Calidad(
            ph=10.1, t_c=92.0, tds=2_700, dureza_ca=18, alcalinidad=880,
            cloruros=175, sulfatos=250, silice=105, sst=4, dqo=6,
            n_amoniacal=1.6, fosfatos=7.5, hierro=0.35,
        ),
        cv=0.40,
        limitante="Alcalinidad y silice; ademas llega a 90 C",
        incentivo_usd_m3=-0.22,
        # `power=plant` y no `power` a secas: la etiqueta suelta casa
        # tambien con subestaciones y lineas, que no purgan calderas.
        pistas=("termo", "energia", "generacion", "cogeneracion",
                "power=plant", "plant:source", "plant:method"),
    ),
    Arquetipo(
        clave="plasticos",
        nombre="Transformacion de plasticos",
        # 2013 es "plasticos en formas primarias": la produccion de resina.
        ciiu=("2013", "2220", "2221", "2229"),
        corriente="Enfriamiento de moldes en circuito abierto",
        caudal_ref_m3_h=55.0, area_ref_m2=60_000.0,
        calidad=Calidad(
            ph=7.4, t_c=40.0, tds=310, dureza_ca=105, alcalinidad=130,
            cloruros=48, sulfatos=52, silice=14, sst=9, dqo=11,
            n_amoniacal=0.2, fosfatos=0.6, hierro=0.22,
        ),
        cv=0.30,
        limitante="Practicamente agua cruda calentada: solo la temperatura",
        incentivo_usd_m3=-0.05,
        pistas=("plastico", "plastic", "polipropileno", "esenttia", "envases",
                "film", "biofilm", "ajover", "resinas", "pvc",
                "mexichem", "vinilo", "industrial=plastic"),
    ),
    Arquetipo(
        clave="cemento",
        nombre="Cemento, cal y concreto",
        ciiu=("2394", "2395"),
        corriente="Agua de lavado de equipos y mixers",
        caudal_ref_m3_h=22.0, area_ref_m2=120_000.0,
        calidad=Calidad(
            ph=11.6, t_c=30.0, tds=1_450, dureza_ca=720, alcalinidad=680,
            cloruros=95, sulfatos=340, silice=60, sst=1_800, dqo=25,
            n_amoniacal=0.4, fosfatos=1.0, hierro=3.5,
        ),
        cv=0.55,
        limitante="SST altisimos y pH 11,6: exige sedimentacion y neutralizado",
        incentivo_usd_m3=-0.18,
        pistas=("cemento", "cement", "argos", "concreto", "clinker", "titan"),
    ),
    Arquetipo(
        clave="ptar",
        nombre="Tratamiento de aguas residuales",
        ciiu=("3700",),
        corriente="Efluente secundario o terciario",
        caudal_ref_m3_h=150.0, area_ref_m2=80_000.0,
        calidad=Calidad(
            ph=7.2, t_c=29.0, tds=820, dureza_ca=185, alcalinidad=255,
            cloruros=225, sulfatos=135, silice=24, sst=20, dqo=58,
            n_amoniacal=7.0, fosfatos=4.5, hierro=0.65,
        ),
        cv=0.35,
        limitante="Organica, amonio y fosforo: riesgo de biofouling",
        incentivo_usd_m3=0.20,
        pistas=("ptar", "aguas residuales", "depuradora", "acuacar",
                "tratamiento", "saneamiento", "wastewater_plant",
                "wastewater", "aguas de cartagena"),
    ),
    Arquetipo(
        clave="bebidas",
        nombre="Bebidas y cerveceria",
        ciiu=("1101", "1102", "1103", "1104"),
        corriente="Agua de lavado, CIP y condensados contaminados",
        caudal_ref_m3_h=30.0, area_ref_m2=45_000.0,
        calidad=Calidad(
            ph=6.9, t_c=33.0, tds=395, dureza_ca=85, alcalinidad=160,
            cloruros=62, sulfatos=58, silice=11, sst=42, dqo=310,
            n_amoniacal=2.2, fosfatos=6.5, hierro=0.32,
        ),
        cv=0.50,
        limitante="DQO alta: exige tratamiento biologico previo",
        incentivo_usd_m3=-0.32,
        pistas=("cerveza", "cerveceria", "bavaria", "bebidas", "gaseosa",
                "postobon", "coca", "brewery"),
    ),
    Arquetipo(
        clave="alimentos",
        nombre="Procesamiento de alimentos",
        ciiu=("1011", "1020", "1030", "1040", "1084"),
        corriente="Agua de proceso, escaldado y lavado",
        caudal_ref_m3_h=26.0, area_ref_m2=40_000.0,
        calidad=Calidad(
            ph=6.6, t_c=32.0, tds=980, dureza_ca=190, alcalinidad=210,
            cloruros=310, sulfatos=120, silice=16, sst=160, dqo=620,
            n_amoniacal=14.0, fosfatos=11.0, hierro=0.55,
        ),
        cv=0.60,
        limitante="DQO y grasas muy altas; salinidad por salmueras",
        incentivo_usd_m3=-0.35,
        pistas=("alimentos", "food", "aceite", "harina", "molino",
                "atun", "pesquera", "avicola", "seatech", "camarones",
                "avicampo", "industrial=food", "enlatado"),
    ),
    Arquetipo(
        clave="siderurgia",
        nombre="Siderurgia y metalmecanica",
        ciiu=("2410", "2431", "2599"),
        corriente="Enfriamiento indirecto y agua de laminacion",
        caudal_ref_m3_h=48.0, area_ref_m2=100_000.0,
        calidad=Calidad(
            ph=7.6, t_c=42.0, tds=760, dureza_ca=210, alcalinidad=180,
            cloruros=140, sulfatos=190, silice=30, sst=120, dqo=45,
            n_amoniacal=0.8, fosfatos=2.0, hierro=8.5,
        ),
        cv=0.50,
        limitante="Hierro y solidos en suspension; trazas de aceite",
        incentivo_usd_m3=-0.20,
        pistas=("acero", "siderurgi", "metal", "laminacion", "fundicion",
                "steel"),
    ),
    Arquetipo(
        clave="papel",
        nombre="Papel, carton y empaques",
        ciiu=("1701", "1702", "1709"),
        corriente="Agua blanca de maquina y rechazo de clarificador",
        caudal_ref_m3_h=70.0, area_ref_m2=70_000.0,
        calidad=Calidad(
            ph=7.1, t_c=45.0, tds=1_250, dureza_ca=280, alcalinidad=340,
            cloruros=190, sulfatos=420, silice=38, sst=380, dqo=850,
            n_amoniacal=3.5, fosfatos=5.0, hierro=1.8,
        ),
        cv=0.55,
        limitante="DQO y fibra: exige clarificacion y biologico",
        incentivo_usd_m3=-0.38,
        pistas=("papel", "carton", "empaque", "paper", "corrugado",
                "lamitech"),
    ),
    Arquetipo(
        clave="textil",
        nombre="Textil y tintoreria",
        ciiu=("1311", "1312", "1313"),
        corriente="Bano de tintura y agua de enjuague",
        caudal_ref_m3_h=34.0, area_ref_m2=35_000.0,
        calidad=Calidad(
            ph=9.4, t_c=48.0, tds=2_400, dureza_ca=150, alcalinidad=520,
            cloruros=880, sulfatos=560, silice=22, sst=95, dqo=540,
            n_amoniacal=4.0, fosfatos=8.0, hierro=1.1,
        ),
        cv=0.55,
        limitante="Salinidad, color y DQO a la vez: la peor combinacion",
        incentivo_usd_m3=-0.42,
        pistas=("textil", "tintoreria", "hilanderia", "confeccion"),
    ),
    Arquetipo(
        clave="farmaceutica",
        nombre="Farmaceutica y cosmetica",
        ciiu=("2100", "2023"),
        corriente="Rechazo de agua purificada y lavado de equipos",
        caudal_ref_m3_h=14.0, area_ref_m2=25_000.0,
        calidad=Calidad(
            ph=7.0, t_c=27.0, tds=640, dureza_ca=120, alcalinidad=140,
            cloruros=150, sulfatos=110, silice=18, sst=12, dqo=85,
            n_amoniacal=1.0, fosfatos=2.5, hierro=0.20,
        ),
        cv=0.45,
        limitante="Caudal pequeno; trazas organicas exigen barrera",
        incentivo_usd_m3=-0.25,
        pistas=("farmaceutica", "laboratorio", "pharma", "cosmetica"),
    ),
    Arquetipo(
        clave="astillero",
        nombre="Astillero y reparacion naval",
        ciiu=("3011", "3315"),
        corriente="Agua de dique seco, lavado y arenado de cascos",
        caudal_ref_m3_h=25.0, area_ref_m2=180_000.0,
        calidad=Calidad(
            ph=7.9, t_c=30.0, tds=2_800, dureza_ca=380, alcalinidad=160,
            cloruros=1_150, sulfatos=340, silice=35, sst=450, dqo=90,
            n_amoniacal=1.2, fosfatos=1.5, hierro=12.0,
        ),
        cv=0.70,
        limitante=(
            "Metales de pinturas antiincrustantes, solidos de arenado e "
            "intrusion salina del dique; ademas el caudal es muy intermitente"
        ),
        incentivo_usd_m3=-0.25,
        pistas=("astillero", "cotecmar", "shipyard", "dique seco", "naval",
                "varadero"),
    ),
    Arquetipo(
        clave="portuario",
        nombre="Terminal portuaria y logistica",
        ciiu=("5222", "5210", "4923"),
        corriente="Lavado de patios, muelles y agua de sentina tratada",
        caudal_ref_m3_h=18.0, area_ref_m2=150_000.0,
        calidad=Calidad(
            ph=7.5, t_c=30.0, tds=1_950, dureza_ca=260, alcalinidad=190,
            cloruros=720, sulfatos=280, silice=20, sst=210, dqo=140,
            n_amoniacal=1.5, fosfatos=1.8, hierro=2.4,
        ),
        cv=0.65,
        limitante="Intrusion salina e hidrocarburos; caudal muy irregular",
        incentivo_usd_m3=-0.15,
        pistas=("puerto", "terminal", "muelle", "logistica", "contecar",
                "sociedad portuaria", "contenedores", "intermodal",
                "patio_de_contenedores"),
    ),
)

ARQUETIPOS_POR_CLAVE = {a.clave: a for a in ARQUETIPOS}

#: Indice inverso codigo CIIU -> arquetipo.
_POR_CIIU: dict[str, Arquetipo] = {
    codigo: a for a in ARQUETIPOS for codigo in a.ciiu
}


# --------------------------------------------------------------------------
# Resolucion
# --------------------------------------------------------------------------

def por_ciiu(codigo: str) -> Arquetipo | None:
    """Busca por codigo CIIU. Prueba 4 digitos y luego la division de 2."""
    codigo = (codigo or "").strip()
    if codigo in _POR_CIIU:
        return _POR_CIIU[codigo]
    # Una division CIIU (2 digitos) suele bastar para elegir el arquetipo.
    if len(codigo) >= 2:
        division = codigo[:2]
        for a in ARQUETIPOS:
            if any(c.startswith(division) for c in a.ciiu):
                return a
    return None


def _sin_tildes(texto: str) -> str:
    """Quita tildes antes de comparar.

    Sin esto, "Daw Quimica" casaba y "Daw Quimica" con tilde no: los nombres
    reales de OpenStreetMap las llevan y las pistas no, asi que media docena
    de plantas quimicas de Mamonal se quedaban sin clasificar en silencio.
    """
    return "".join(
        c for c in unicodedata.normalize("NFD", texto)
        if unicodedata.category(c) != "Mn"
    )


def _casa(pista: str, blob: str, tokens: list[str]) -> bool:
    """Decide si una pista aparece en el texto de un establecimiento.

    Dos regimenes, y la distincion importa:

    - Una pista **compuesta** (lleva espacio, `=` o `:`) se busca como
      subcadena. Son etiquetas concretas de OSM o expresiones de varias
      palabras: `power=plant`, `aguas residuales`. Ahi la subcadena es
      exactamente lo que se quiere.

    - Una pista **simple** casa solo con un token que EMPIECE por ella. La
      coincidencia de subcadena suelta produce falsos positivos silenciosos:
      con datos reales de Mamonal, `termo` casaba dentro de "In-termo-dal"
      —un patio de contenedores— y lo clasificaba como central termica, con
      su purga de calderas inventada y todo. El prefijo de token sigue
      capturando "Termocandelaria" y "Termocartagena", que es para lo que
      estaba la pista, y deja fuera la palabra que solo la contiene por
      dentro.
    """
    if any(c in pista for c in " =:"):
        return pista in blob
    return any(t.startswith(pista) for t in tokens)


def por_texto(*textos: str) -> Arquetipo | None:
    """Busca por palabras clave en nombre, descripcion o etiquetas.

    Es el camino habitual: las fuentes cartograficas traen nombre y a lo sumo
    una etiqueta de producto, casi nunca un codigo CIIU.
    """
    blob = _sin_tildes(" ".join(t for t in textos if t).lower())
    if not blob:
        return None
    tokens = re.split(r"[^a-z0-9]+", blob)
    mejor, puntos_mejor = None, 0
    for a in ARQUETIPOS:
        puntos = sum(len(p) for p in a.pistas if _casa(p, blob, tokens))
        if puntos > puntos_mejor:
            mejor, puntos_mejor = a, puntos
    return mejor


def resolver(
    ciiu: str = "", nombre: str = "", etiquetas: str = "",
) -> tuple[Arquetipo | None, Metodo]:
    """Elige arquetipo y declara con que confianza se llego a el.

    Por CIIU la asignacion es solida (DECLARADO: la empresa declaro esa
    actividad ante la camara de comercio). Por texto es una conjetura
    razonable (INFERIDO), y hay que tratarla como tal.
    """
    a = por_ciiu(ciiu)
    if a is not None:
        return a, Metodo.DECLARADO
    a = por_texto(nombre, etiquetas)
    if a is not None:
        return a, Metodo.INFERIDO
    return None, Metodo.SUPUESTO


def caudal_estimado(
    arquetipo: Arquetipo, area_m2: float | None = None,
) -> float:
    """Escala el caudal de referencia por el tamano del predio.

    El area construida es un proxy pobre pero disponible: es lo unico que una
    fuente cartografica da siempre. Se aplica con exponente 0,75 porque el
    consumo de agua no escala linealmente con la superficie (hay servicios
    comunes que no crecen con la planta), y se acota el factor entre 0,3 y 3
    para que un poligono mal digitalizado no produzca un caudal absurdo.
    """
    if not area_m2 or area_m2 <= 0:
        return arquetipo.caudal_ref_m3_h
    factor = (area_m2 / arquetipo.area_ref_m2) ** 0.75
    return round(arquetipo.caudal_ref_m3_h * min(max(factor, 0.3), 3.0), 1)


def rango_caudal(arquetipo: Arquetipo, caudal: float) -> tuple[float, float]:
    """Intervalo honesto alrededor de la estimacion de caudal."""
    return (
        round(caudal * max(0.15, 1.0 - arquetipo.cv), 1),
        round(caudal * (1.0 + arquetipo.cv), 1),
    )
