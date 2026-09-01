"""Catalogo de oferentes de agua de rechazo y trenes de tratamiento.

Los datos son SUPUESTOS representativos de un parque industrial. La estructura
esta pensada para que cada empresa vecina real se cargue con su caracterizacion
analitica sin tocar codigo.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Sequence

from .water_chem import Calidad, PARAMETROS_CONSERVATIVOS

# --------------------------------------------------------------------------
# Unidades de tratamiento
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Unidad:
    """Operacion unitaria de tratamiento.

    remocion: fraccion removida de cada parametro (0-1).
    recuperacion: fraccion del caudal alimentado que sale como producto.
    capex_usd_m3h: inversion por m3/h de capacidad instalada.
    opex_usd_m3: costo operativo por m3 ALIMENTADO.
    """

    codigo: str
    nombre: str
    remocion: dict[str, float] = field(default_factory=dict)
    recuperacion: float = 1.0
    capex_usd_m3h: float = 0.0
    opex_usd_m3: float = 0.0
    t_salida_c: float | None = None
    delta_alcalinidad: float = 0.0   # fraccion adicional removida de alcalinidad

    def aplicar(self, c: Calidad) -> Calidad:
        campos = {}
        for p in PARAMETROS_CONSERVATIVOS:
            campos[p] = getattr(c, p) * (1.0 - self.remocion.get(p, 0.0))
        # El TDS baja al menos tanto como el promedio de los iones removidos.
        t = c.t_c if self.t_salida_c is None else self.t_salida_c
        return replace(c, t_c=t, **campos)


FILTRO_MULTIMEDIA = Unidad(
    "FMM", "Filtracion multimedia",
    remocion={"sst": 0.85, "hierro": 0.70, "dqo": 0.15},
    recuperacion=0.97, capex_usd_m3h=900.0, opex_usd_m3=0.05,
)
ULTRAFILTRACION = Unidad(
    "UF", "Ultrafiltracion",
    remocion={"sst": 0.98, "hierro": 0.92, "dqo": 0.35, "silice": 0.10},
    recuperacion=0.94, capex_usd_m3h=2_600.0, opex_usd_m3=0.12,
)
BIOLOGICO_MBBR = Unidad(
    "MBBR", "Reactor biologico de lecho movil",
    remocion={"dqo": 0.85, "n_amoniacal": 0.90, "fosfatos": 0.35, "sst": -0.60},
    recuperacion=0.98, capex_usd_m3h=4_200.0, opex_usd_m3=0.22,
)
ABLANDAMIENTO_CAL = Unidad(
    "CAL", "Ablandamiento cal-soda",
    remocion={"dureza_ca": 0.88, "alcalinidad": 0.75, "silice": 0.45,
              "hierro": 0.80, "tds": 0.30, "sst": -0.30},
    recuperacion=0.95, capex_usd_m3h=3_100.0, opex_usd_m3=0.18,
)
INTERCAMBIO_IONICO = Unidad(
    "IX", "Ablandamiento por intercambio ionico",
    remocion={"dureza_ca": 0.96, "hierro": 0.60, "cloruros": -0.05},
    recuperacion=0.99, capex_usd_m3h=1_500.0, opex_usd_m3=0.14,
)
OSMOSIS_INVERSA = Unidad(
    "OI", "Osmosis inversa",
    remocion={"tds": 0.97, "dureza_ca": 0.98, "alcalinidad": 0.95,
              "cloruros": 0.96, "sulfatos": 0.98, "silice": 0.98,
              "sst": 0.99, "dqo": 0.90, "n_amoniacal": 0.85,
              "fosfatos": 0.98, "hierro": 0.98},
    recuperacion=0.75, capex_usd_m3h=5_200.0, opex_usd_m3=0.35,
)
DESINFECCION = Unidad(
    "DES", "Desinfeccion UV + cloracion",
    remocion={"dqo": 0.05},
    recuperacion=1.0, capex_usd_m3h=700.0, opex_usd_m3=0.06,
)
STRIPPING = Unidad(
    "STR", "Stripping de amonio",
    remocion={"n_amoniacal": 0.85, "alcalinidad": 0.30},
    recuperacion=0.96, capex_usd_m3h=2_400.0, opex_usd_m3=0.19,
)
ENFRIAMIENTO = Unidad(
    "ENF", "Intercambiador de recuperacion de calor",
    remocion={}, recuperacion=1.0, capex_usd_m3h=1_100.0, opex_usd_m3=0.03,
    t_salida_c=33.0,
)


@dataclass(frozen=True)
class Tren:
    """Secuencia de unidades. El orden importa: se aplica de izquierda a derecha."""

    codigo: str
    nombre: str
    unidades: tuple[Unidad, ...]

    @property
    def recuperacion(self) -> float:
        r = 1.0
        for u in self.unidades:
            r *= u.recuperacion
        return r

    @property
    def capex_usd_m3h_producto(self) -> float:
        """CAPEX por m3/h de PRODUCTO (no de alimentacion)."""
        total = 0.0
        factor = 1.0 / self.recuperacion if self.recuperacion else 0.0
        # Cada unidad se dimensiona con el caudal que la atraviesa.
        caudal_rel = factor
        for u in self.unidades:
            total += u.capex_usd_m3h * caudal_rel
            caudal_rel *= u.recuperacion
        return total

    @property
    def opex_usd_m3_producto(self) -> float:
        total = 0.0
        caudal_rel = 1.0 / self.recuperacion if self.recuperacion else 0.0
        for u in self.unidades:
            total += u.opex_usd_m3 * caudal_rel
            caudal_rel *= u.recuperacion
        return total

    def aplicar(self, c: Calidad) -> Calidad:
        for u in self.unidades:
            c = u.aplicar(c)
        return c


TRENES: tuple[Tren, ...] = (
    Tren("T0", "Directo (sin tratamiento)", ()),
    Tren("T1", "Filtracion + desinfeccion", (FILTRO_MULTIMEDIA, DESINFECCION)),
    Tren("T2", "Ultrafiltracion + desinfeccion", (ULTRAFILTRACION, DESINFECCION)),
    Tren("T3", "Ablandamiento cal-soda + filtracion",
         (ABLANDAMIENTO_CAL, FILTRO_MULTIMEDIA)),
    Tren("T4", "Filtracion + intercambio ionico",
         (FILTRO_MULTIMEDIA, INTERCAMBIO_IONICO)),
    Tren("T5", "Biologico + UF + desinfeccion",
         (BIOLOGICO_MBBR, ULTRAFILTRACION, DESINFECCION)),
    Tren("T6", "UF + osmosis inversa", (ULTRAFILTRACION, OSMOSIS_INVERSA)),
    Tren("T7", "Biologico + UF + osmosis inversa",
         (BIOLOGICO_MBBR, ULTRAFILTRACION, OSMOSIS_INVERSA)),
    Tren("T8", "Stripping + filtracion + desinfeccion",
         (STRIPPING, FILTRO_MULTIMEDIA, DESINFECCION)),
    Tren("T9", "Enfriamiento + filtracion + desinfeccion",
         (ENFRIAMIENTO, FILTRO_MULTIMEDIA, DESINFECCION)),
    Tren("T10", "Enfriamiento + cal-soda + filtracion + desinfeccion",
         (ENFRIAMIENTO, ABLANDAMIENTO_CAL, FILTRO_MULTIMEDIA, DESINFECCION)),
    Tren("T11", "Enfriamiento + UF + desinfeccion",
         (ENFRIAMIENTO, ULTRAFILTRACION, DESINFECCION)),
    Tren("T12", "Enfriamiento + UF + osmosis inversa",
         (ENFRIAMIENTO, ULTRAFILTRACION, OSMOSIS_INVERSA)),
)

TRENES_POR_CODIGO = {t.codigo: t for t in TRENES}


# --------------------------------------------------------------------------
# Oferentes (empresas vecinas)
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Oferente:
    """Empresa vecina que genera una corriente de rechazo aprovechable."""

    codigo: str
    empresa: str
    sector: str
    corriente: str
    caudal_disponible_m3_h: float
    calidad: Calidad
    distancia_km: float
    #: USD/m3. Negativo = el vecino PAGA por entregarla (evita su costo de
    #: vertimiento). Es la clave economica de la simbiosis industrial.
    precio_usd_m3: float
    disponibilidad: float = 0.95   # factor de disponibilidad anual
    requiere_enfriamiento: bool = False
    notas: str = ""


CATALOGO: tuple[Oferente, ...] = (
    Oferente(
        "V1", "Petroquimica vecina", "Petroquimica",
        "Rechazo de osmosis inversa (desmineralizadora)",
        caudal_disponible_m3_h=45.0,
        calidad=Calidad(
            ph=7.6, t_c=31.0, tds=3_200, dureza_ca=480, alcalinidad=320,
            cloruros=850, sulfatos=720, silice=75, sst=2, dqo=12,
            n_amoniacal=0.3, fosfatos=2.5, hierro=0.10,
        ),
        distancia_km=1.2, precio_usd_m3=-0.15,
        notas="Muy baja carga organica y solidos. Limitante: salinidad.",
    ),
    Oferente(
        "V2", "Cogeneracion / planta de vapor", "Energia",
        "Purga continua de calderas",
        caudal_disponible_m3_h=12.0,
        calidad=Calidad(
            ph=10.2, t_c=95.0, tds=2_800, dureza_ca=15, alcalinidad=900,
            cloruros=180, sulfatos=260, silice=110, sst=3, dqo=5,
            n_amoniacal=1.8, fosfatos=8.0, hierro=0.40,
        ),
        distancia_km=0.8, precio_usd_m3=-0.20, requiere_enfriamiento=True,
        notas="Agua blanda y caliente: permite recuperar calor. "
              "Limitante: alcalinidad y silice.",
    ),
    Oferente(
        "V3", "PTAR del parque industrial", "Servicios",
        "Efluente secundario/terciario",
        caudal_disponible_m3_h=120.0,
        calidad=Calidad(
            ph=7.3, t_c=29.0, tds=850, dureza_ca=190, alcalinidad=260,
            cloruros=230, sulfatos=140, silice=25, sst=18, dqo=55,
            n_amoniacal=6.5, fosfatos=4.2, hierro=0.60,
        ),
        distancia_km=3.5, precio_usd_m3=0.25,
        notas="Gran volumen y baja salinidad. Limitante: organica, "
              "amonio y fosforo (biofouling).",
    ),
    Oferente(
        "V4", "Planta de alimentos", "Alimentos",
        "Purga de torres de enfriamiento",
        caudal_disponible_m3_h=20.0,
        calidad=Calidad(
            ph=8.6, t_c=33.0, tds=1_600, dureza_ca=420, alcalinidad=350,
            cloruros=380, sulfatos=300, silice=90, sst=12, dqo=35,
            n_amoniacal=0.4, fosfatos=9.0, hierro=0.50,
        ),
        distancia_km=0.6, precio_usd_m3=-0.10,
        notas="Cascada de purga a purga. Muy cerca. Arrastra inhibidor "
              "fosfatado (favorece biofouling).",
    ),
    Oferente(
        "V5", "Cerveceria / bebidas", "Alimentos y bebidas",
        "Agua de lavado y condensados contaminados",
        caudal_disponible_m3_h=25.0,
        calidad=Calidad(
            ph=6.8, t_c=34.0, tds=380, dureza_ca=80, alcalinidad=150,
            cloruros=60, sulfatos=55, silice=10, sst=45, dqo=320,
            n_amoniacal=2.0, fosfatos=6.0, hierro=0.30,
        ),
        distancia_km=2.1, precio_usd_m3=-0.30,
        notas="Salinidad muy baja: el mejor candidato quimico. "
              "Limitante: DQO alta, exige tratamiento biologico.",
    ),
    Oferente(
        "V6", "Planta de plasticos", "Manufactura",
        "Enfriamiento de un solo paso (once-through)",
        caudal_disponible_m3_h=60.0,
        calidad=Calidad(
            ph=7.4, t_c=41.0, tds=300, dureza_ca=100, alcalinidad=125,
            cloruros=45, sulfatos=50, silice=13, sst=8, dqo=10,
            n_amoniacal=0.2, fosfatos=0.5, hierro=0.20,
        ),
        distancia_km=1.5, precio_usd_m3=0.10, requiere_enfriamiento=True,
        notas="Practicamente agua cruda, solo calentada. El mejor candidato "
              "global si se resuelve la temperatura.",
    ),
)

CATALOGO_POR_CODIGO = {o.codigo: o for o in CATALOGO}


AGUA_CRUDA = Calidad(
    ph=7.5, t_c=28.0, tds=250, dureza_ca=90, alcalinidad=110,
    cloruros=35, sulfatos=45, silice=12, sst=5, dqo=8,
    n_amoniacal=0.2, fosfatos=0.4, hierro=0.10,
)


# --------------------------------------------------------------------------
# Reglas de admisibilidad operativa
# --------------------------------------------------------------------------
# Los limites de concentracion del agua circulante no bastan: hay riesgos que
# no dependen solo de la concentracion final sino de la naturaleza de la
# corriente (biopelicula, ensuciamiento del relleno, corrosion del cobre).
# Estas reglas descartan combinaciones que ningun operador aceptaria aunque
# la mezcla diluida "cumpla" en el papel.

#: (parametro de la corriente CRUDA, umbral, codigos de unidad que lo habilitan)
REGLAS_ADMISIBILIDAD: tuple[tuple[str, float, frozenset[str]], ...] = (
    ("dqo", 150.0, frozenset({"MBBR", "OI"})),
    ("sst", 30.0, frozenset({"FMM", "UF", "OI"})),
    ("n_amoniacal", 5.0, frozenset({"MBBR", "STR", "OI"})),
    ("hierro", 2.0, frozenset({"FMM", "UF", "OI"})),
)

#: Toda corriente distinta del agua cruda pasa por control microbiologico.
UNIDADES_BARRERA_BIOLOGICA = frozenset({"DES", "OI"})


def admisible(oferente: "Oferente", tren: "Tren") -> tuple[bool, str]:
    """Verifica que el tren resuelva los riesgos intrinsecos de la corriente."""
    codigos = {u.codigo for u in tren.unidades}
    for param, umbral, habilitantes in REGLAS_ADMISIBILIDAD:
        if getattr(oferente.calidad, param) > umbral and not (
            codigos & habilitantes
        ):
            return False, (
                f"{param} de {getattr(oferente.calidad, param):.0f} exige "
                f"al menos una de {sorted(habilitantes)}"
            )
    if not (codigos & UNIDADES_BARRERA_BIOLOGICA):
        return False, "falta barrera microbiologica (desinfeccion u osmosis)"
    return True, ""


@dataclass(frozen=True)
class Opcion:
    """Par (oferente, tren de tratamiento) evaluado: una alternativa de suministro."""

    oferente: Oferente
    tren: Tren
    calidad_producto: Calidad
    caudal_max_m3_h: float          # producto disponible
    costo_usd_m3: float             # total: compra + tratamiento + conduccion
    desglose: dict[str, float]

    @property
    def codigo(self) -> str:
        return f"{self.oferente.codigo}:{self.tren.codigo}"


def generar_opciones(
    oferentes: Sequence[Oferente],
    trenes: Sequence[Tren],
    crf: float,
    horas_anio: float,
    capex_conduccion_usd_m3h_km: float,
    energia_bombeo_kwh_m3_km: float,
    costo_energia_usd_kwh: float,
    t_max_aporte_c: float = 55.0,
) -> list[Opcion]:
    """Producto cartesiano oferente x tren, descartando combinaciones inviables."""
    opciones: list[Opcion] = []
    for of in oferentes:
        for tren in trenes:
            ok, _motivo = admisible(of, tren)
            if not ok:
                continue
            producto = tren.aplicar(of.calidad)
            # El relleno de PVC y las lineas de PEAD no toleran agua muy
            # caliente: por encima de este umbral el enfriamiento es obligado.
            if producto.t_c > t_max_aporte_c:
                continue
            rec = tren.recuperacion
            if rec <= 0:
                continue
            caudal_max = of.caudal_disponible_m3_h * of.disponibilidad * rec

            compra = of.precio_usd_m3 / rec
            opex_trat = tren.opex_usd_m3_producto
            capex_trat = tren.capex_usd_m3h_producto * crf / horas_anio
            capex_cond = (
                capex_conduccion_usd_m3h_km * of.distancia_km / rec
                * crf / horas_anio
            )
            opex_bombeo = (
                energia_bombeo_kwh_m3_km * of.distancia_km
                * costo_energia_usd_kwh / rec
            )
            desglose = {
                "compra": compra,
                "opex_tratamiento": opex_trat,
                "capex_tratamiento": capex_trat,
                "capex_conduccion": capex_cond,
                "opex_bombeo": opex_bombeo,
            }
            opciones.append(
                Opcion(
                    oferente=of, tren=tren, calidad_producto=producto,
                    caudal_max_m3_h=caudal_max,
                    costo_usd_m3=sum(desglose.values()),
                    desglose=desglose,
                )
            )
    return opciones
