"""Expedientes de empresas concretas del corredor de Mamonal.

POR QUE EXISTE
--------------

El arquetipo sectorial (`ciiu.py`) contesta "que produce una planta de este
tipo". Esta capa contesta algo mas fuerte: "que produce ESTA planta". La
diferencia importa cuando el nombre no dice el sector o dice uno equivocado.

Tres ejemplos reales del barrido de Mamonal:

  - "Abocol S.A." no contiene ninguna pista de sector. El clasificador de
    texto la habria dejado sin arquetipo o, peor, la habria metido en quimica
    basica junto al rechazo de desmineralizadora. Es un complejo de
    fertilizantes nitrogenados: su corriente lleva amonio, que es
    precisamente el parametro mas restrictivo del circuito de enfriamiento.
  - "Mexichem S.A." tampoco dice nada. Produce resinas de PVC.
  - "Cotecmar" es un astillero. Un astillero parece un vecino industrial
    cualquiera y no lo es: su efluente arrastra metales de pinturas
    antiincrustantes.

QUE ES CADA ENTRADA
-------------------

Investigacion documental con la fuente citada. Eso la hace **DECLARADA**, no
medida: son datos publicados por la propia empresa o por prensa economica
sobre su actividad y su escala, no una analitica de su vertimiento. El salto
de confianza que produce es el que corresponde a esa distincion.

Lo que este modulo NO hace es inventar caracterizaciones de agua. Determina
el ARQUETIPO al que pertenece la empresa; el agua sigue saliendo del modelo
sectorial, marcada como corresponda. Poner aqui un DQO atribuido a una
empresa nombrada sin haberlo medido seria exactamente lo que el resto del
proyecto se niega a hacer.

COMO SE AMPLIA
--------------

Anadiendo entradas. Cada una necesita nombre reconocible, arquetipo, la
actividad en una linea y al menos una fuente verificable. Sin fuente no entra.
"""

from __future__ import annotations

from dataclasses import dataclass

from .perfil import Metodo
from .texto import normalizar


@dataclass(frozen=True)
class Expediente:
    """Lo que se sabe documentalmente de una empresa concreta."""

    #: Variantes por las que las fuentes cartograficas la nombran.
    nombres: tuple[str, ...]
    razon_social: str
    arquetipo: str          # clave en ciiu.ARQUETIPOS_POR_CLAVE
    ciiu: str
    actividad: str          # que hace, en una linea
    escala: str             # capacidad o tamano declarado
    fuentes: tuple[str, ...]

    def __post_init__(self) -> None:
        if not self.fuentes:
            raise ValueError(
                f"{self.razon_social}: un expediente sin fuente no entra"
            )


EXPEDIENTES: tuple[Expediente, ...] = (
    Expediente(
        nombres=("mexichem", "mexichem resinas", "orbia", "vestolit", "pavco"),
        razon_social="Mexichem Resinas Colombia S.A.S.",
        arquetipo="plasticos",
        ciiu="2013",
        actividad=(
            "Polimerizacion de resinas de PVC (suspension y emulsion). "
            "La polimerizacion en suspension consume agua desmineralizada en "
            "el reactor y genera efluente de lavado con carga organica baja"
        ),
        escala="Capacidad instalada del orden de 400 000 t/ano de resina de PVC",
        fuentes=(
            "https://www.plastico.com/temas/Mexichem-amplia-produccion-de-PVC+105755",
            "https://www.orbia.com/492445/siteassets/6.-sustainability/policies--guidelines/certifications/vestolit-alphagary/cartagena-resinas-colombia-iso-14001_-sp.pdf",
        ),
    ),
    Expediente(
        nombres=("abocol", "yara", "yara colombia", "abonos colombianos"),
        razon_social="Yara Colombia S.A. (antes Abonos Colombianos - Abocol)",
        arquetipo="nitrogenados",
        ciiu="2012",
        actividad=(
            "Complejo de fertilizantes nitrogenados: amoniaco, acido nitrico, "
            "nitrato de amonio, nitrato de calcio y mezclas NPK. El condensado "
            "de proceso del tren de amoniaco es la corriente aprovechable y su "
            "limitante es el amonio"
        ),
        escala=(
            "Amoniaco ~117 000 t/ano, acido nitrico ~266 000 t/ano, "
            "nitrato de amonio ~240 000 t/ano, NPK ~300 000 t/ano"
        ),
        fuentes=(
            "https://www.eluniversal.com.co/economica/2026/06/10/yara-colombia-culmino-el-proyecto-de-ampliacion-de-su-planta-en-cartagena/",
            "https://www.larepublica.co/empresas/en-colombia-estaria-la-cuarta-planta-de-yara-en-america-tras-la-compra-de-abocol-2086356",
        ),
    ),
    Expediente(
        nombres=("seatech", "seatech international", "van camps", "van camp"),
        razon_social="Seatech International Inc.",
        arquetipo="alimentos",
        ciiu="1012",
        actividad=(
            "Procesamiento y enlatado de atun. Cocido, limpieza y esterilizado "
            "generan agua con carga organica y grasas altas, y salinidad por "
            "salmuera"
        ),
        escala="Planta de enlatado con del orden de 2 000 trabajadores directos",
        fuentes=(
            "https://co.linkedin.com/company/seatech-international-inc",
            "https://www.las2orillas.co/seatech-la-empresa-cartagenera-que-hace-el-popular-van-camps-y-tambien-el-atun-de-d1/",
        ),
    ),
    Expediente(
        nombres=("cotecmar",),
        razon_social=(
            "Cotecmar - Corporacion de Ciencia y Tecnologia para el Desarrollo "
            "de la Industria Naval, Maritima y Fluvial"
        ),
        arquetipo="astillero",
        ciiu="3011",
        actividad=(
            "Astillero de construccion y reparacion naval. Diques secos, "
            "arenado y pintura de cascos: el efluente arrastra solidos de "
            "arenado y metales de pinturas antiincrustantes"
        ),
        escala=(
            "Elevador sincronico de 3 600 t, 8 posiciones de dique seco y "
            "4 de reparacion a flote"
        ),
        fuentes=(
            "https://www.portafolio.co/negocios/cotecmar-es-una-fabrica-de-barcos-hechos-a-la-medida-515948",
            "https://www.elespectador.com/colombia/cartagena/cotecmar-20-anos-de-disenar-construir-y-hasta-exportar-barcos-colombianos-article/",
        ),
    ),
)


#: Indice de variante normalizada -> expediente.
_INDICE: dict[str, Expediente] = {
    normalizar(v): e for e in EXPEDIENTES for v in e.nombres
}


def buscar(nombre: str) -> Expediente | None:
    """Localiza el expediente de una empresa por cualquiera de sus nombres.

    Se exige que la variante conocida aparezca como token completo o como
    prefijo de uno. "Yara" no puede casar dentro de "Guayarama": es el mismo
    error de subcadena que ya costo clasificar un patio de contenedores como
    central termica.
    """
    tokens = normalizar(nombre).split()
    if not tokens:
        return None
    for variante, expediente in _INDICE.items():
        partes = variante.split()
        if len(partes) > 1:
            # Variante compuesta: tiene que aparecer entera y en orden.
            if variante in " ".join(tokens):
                return expediente
        elif any(t == partes[0] or t.startswith(partes[0]) for t in tokens):
            return expediente
    return None


def metodo() -> Metodo:
    """Un expediente documentado es informacion DECLARADA, no medida."""
    return Metodo.DECLARADO
