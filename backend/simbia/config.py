"""Parametros y supuestos del caso base.

TODOS los valores de este modulo son SUPUESTOS editables. No se dispone aun
de datos reales de la planta ni de las empresas vecinas; cada constante esta
anotada con su origen (rango tipico de industria) para que se sustituya por
el dato real en cuanto este disponible.
"""

from __future__ import annotations

from dataclasses import dataclass, field


# --------------------------------------------------------------------------
# 1. Planta (caso base)
# --------------------------------------------------------------------------

@dataclass
class PlantaConfig:
    """Configuracion de la planta Cabot (supuesto: planta de negro de humo)."""

    nombre: str = "Cabot - Planta (caso base)"
    zona: str = "Parque industrial con vecinos generadores de rechazo"

    # Consumo total de agua cruda de la planta, m3/dia. Es el DENOMINADOR de
    # la meta del reto (reducir >=10%). Supuesto: planta de negro de humo con
    # quench + peletizado + enfriamiento + vapor.
    consumo_total_m3_dia: float = 2_900.0

    # Meta del reto.
    meta_reduccion: float = 0.10

    # Costo del agua cruda (captacion + tratamiento + tasa por uso), USD/m3.
    costo_agua_cruda_usd_m3: float = 1.35

    # Costo de vertimiento/descarga de la purga, USD/m3.
    costo_vertimiento_usd_m3: float = 0.85

    # Factor de emision del ciclo del agua (captacion, bombeo, potabilizacion),
    # kg CO2e/m3. Rango tipico 0.3-0.7.
    factor_co2_kg_m3: float = 0.45

    # Horas de operacion al anio (planta continua).
    horas_anio: float = 8_400.0


# --------------------------------------------------------------------------
# 2. Circuito de enfriamiento
# --------------------------------------------------------------------------

@dataclass
class TorreConfig:
    """Torre de enfriamiento de tiro inducido, circuito abierto."""

    caudal_circulacion_m3_h: float = 2_600.0   # caudal recirculado
    delta_t_c: float = 8.5                     # rango termico (T_ent - T_sal)

    # Fraccion de la carga termica disipada por evaporacion. 1.0 en clima
    # calido y humedo; baja a ~0.75 en clima frio y seco.
    factor_evaporacion: float = 0.95

    # Arrastre (drift) como fraccion del caudal de circulacion.
    # Eliminadores modernos: 0.002% - 0.005%.
    fraccion_arrastre: float = 5.0e-5

    # Ciclos de concentracion de operacion actual (linea base).
    ciclos_base: float = 3.2

    # Rango de ciclos explorable por el optimizador.
    ciclos_min: float = 2.0
    ciclos_max: float = 9.0


# --------------------------------------------------------------------------
# 3. Limites de calidad del agua CIRCULANTE (no del makeup)
# --------------------------------------------------------------------------

@dataclass
class LimitesCalidad:
    """Limites del agua circulante en la torre.

    Referencia: practica habitual de tratamiento de aguas de enfriamiento
    (acero al carbono + relleno de PVC + intercambiadores de acero inox 304).
    Se declaran como limites duros del optimizador.
    """

    conductividad_us_cm: float = 3_500.0
    tds_mg_l: float = 2_400.0
    dureza_ca_mg_l: float = 800.0        # como CaCO3
    alcalinidad_mg_l: float = 600.0      # como CaCO3
    cloruros_mg_l: float = 500.0         # acero al carbono con inhibidor
    sulfatos_mg_l: float = 1_200.0
    silice_mg_l: float = 150.0           # como SiO2
    sst_mg_l: float = 25.0
    dqo_mg_l: float = 120.0
    n_amoniacal_mg_l: float = 2.0        # corrosion de Cu + demanda de biocida
    fosfatos_mg_l: float = 15.0          # como PO4
    hierro_mg_l: float = 1.0

    # Indices de estabilidad del agua circulante.
    lsi_max: float = 1.0                 # sin antiincrustante
    lsi_max_con_antiincrustante: float = 2.6
    lsi_min: float = -0.5                # por debajo, agua corrosiva
    larson_skold_max: float = 1.2        # >1.2 -> corrosivo para acero

    # Producto de solubilidad practico CaSO4 (mg/L Ca as CaCO3 x mg/L SO4).
    producto_caso4_max: float = 500_000.0


# --------------------------------------------------------------------------
# 4. Economia del proyecto
# --------------------------------------------------------------------------

@dataclass
class EconomiaConfig:
    tasa_descuento: float = 0.12
    vida_util_anios: int = 15
    # Factor de anualizacion del CAPEX (recuperacion de capital).
    @property
    def crf(self) -> float:
        i, n = self.tasa_descuento, self.vida_util_anios
        return i * (1 + i) ** n / ((1 + i) ** n - 1)

    # Costo de conduccion (tuberia + bombeo) por m3/h instalado y por km.
    capex_conduccion_usd_m3h_km: float = 3_200.0
    # Energia de bombeo por km de conduccion, kWh/m3.
    energia_bombeo_kwh_m3_km: float = 0.05
    costo_energia_usd_kwh: float = 0.11

    # Reactivos.
    costo_h2so4_usd_kg: float = 0.22
    costo_antiincrustante_usd_m3_makeup: float = 0.045


@dataclass
class Escenario:
    """Agrupa toda la configuracion de una corrida."""

    planta: PlantaConfig = field(default_factory=PlantaConfig)
    torre: TorreConfig = field(default_factory=TorreConfig)
    limites: LimitesCalidad = field(default_factory=LimitesCalidad)
    economia: EconomiaConfig = field(default_factory=EconomiaConfig)
    usar_antiincrustante: bool = True

    @property
    def lsi_max_efectivo(self) -> float:
        return (
            self.limites.lsi_max_con_antiincrustante
            if self.usar_antiincrustante
            else self.limites.lsi_max
        )


ESCENARIO_BASE = Escenario()
