"""La planta tal como la conoce quien usa el simulador.

El simulador no necesita que SIMBIA tenga los datos de Cabot: los pone quien
lo usa. Cada campo es opcional; lo que no se indique se toma del caso base de
`config.py` y queda marcado como supuesto, para que nadie confunda un numero
de partida con uno de la planta.

La reposicion medida es el dato que convierte el modelo en un gemelo: con
ella se calibra la evaporacion para que el balance del modelo cuadre con lo
que marca el caudalimetro. Si para cuadrar hiciera falta una evaporacion
fisicamente imposible, la diferencia no la explica la torre (fuga, consumo en
la linea de reposicion o un dato mal leido) y se avisa en vez de esconderla.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from ..config import Escenario
from ..domain import cooling
from ..domain.streams import AGUA_CRUDA
from ..domain.water_chem import Calidad

#: Rango fisico del factor de evaporacion: ~0,75 en clima frio y seco, ~1,0 en
#: calido y humedo. Fuera de el, el balance no lo explica la torre.
FACTOR_EVAPORACION_MIN = 0.60
FACTOR_EVAPORACION_MAX = 1.10

#: Campos de la planta que se pueden indicar y donde viven en el escenario.
_CAMPOS_PLANTA = ("consumo_total_m3_dia", "costo_agua_cruda_usd_m3",
                  "costo_vertimiento_usd_m3", "meta_reduccion")
_CAMPOS_TORRE = ("caudal_circulacion_m3_h", "delta_t_c")


@dataclass(frozen=True)
class DatosPlanta:
    """Lo que la planta sabe de si misma. Todo opcional."""

    consumo_total_m3_dia: float | None = None
    caudal_circulacion_m3_h: float | None = None
    delta_t_c: float | None = None
    #: Ciclos de operacion actuales. Si no se dan, se deducen de las dos
    #: conductividades, que es como los mide un operador.
    ciclos_actuales: float | None = None
    conductividad_reposicion_us_cm: float | None = None
    conductividad_purga_us_cm: float | None = None
    #: Caudal de reposicion medido. Si se da, calibra la evaporacion.
    reposicion_medida_m3_h: float | None = None
    costo_agua_cruda_usd_m3: float | None = None
    costo_vertimiento_usd_m3: float | None = None
    meta_reduccion: float | None = None
    usar_antiincrustante: bool | None = None
    #: Tope operativo de ciclos que la planta acepta.
    ciclos_tope: float | None = None
    #: Analitica del agua de reposicion actual, parametro a parametro.
    agua_cruda: dict[str, float] = field(default_factory=dict)


@dataclass(frozen=True)
class PlantaCalibrada:
    """El escenario listo para simular y la cuenta de como se obtuvo."""

    escenario: Escenario
    agua_cruda: Calidad
    #: campo -> "planta" (lo indico quien usa el simulador) o "supuesto".
    origen: dict[str, str]
    ajustes: tuple[str, ...] = ()
    avisos: tuple[str, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        esc = self.escenario
        return {
            "consumo_total_m3_dia": esc.planta.consumo_total_m3_dia,
            "caudal_circulacion_m3_h": esc.torre.caudal_circulacion_m3_h,
            "delta_t_c": esc.torre.delta_t_c,
            "ciclos_actuales": round(esc.torre.ciclos_base, 2),
            "factor_evaporacion": round(esc.torre.factor_evaporacion, 3),
            "costo_agua_cruda_usd_m3": esc.planta.costo_agua_cruda_usd_m3,
            "costo_vertimiento_usd_m3": esc.planta.costo_vertimiento_usd_m3,
            "meta_reduccion": esc.planta.meta_reduccion,
            "usar_antiincrustante": esc.usar_antiincrustante,
            "ciclos_tope": esc.torre.ciclos_max,
            "agua_cruda": self.agua_cruda.as_dict(),
            "origen": dict(self.origen),
            "ajustes": list(self.ajustes),
            "avisos": list(self.avisos),
        }


def calidad_con(base: Calidad, valores: dict[str, float]) -> Calidad:
    """`base` con los parametros indicados sustituidos.

    Solo admite atributos de `Calidad`; uno desconocido es un error de quien
    llama, no algo que convenga ignorar en silencio.
    """
    desconocidos = set(valores) - set(Calidad.__dataclass_fields__)
    if desconocidos:
        raise ValueError(f"Parametros de calidad desconocidos: {sorted(desconocidos)}")
    return replace(base, **{k: float(v) for k, v in valores.items()})


def calibrar(datos: DatosPlanta | None = None) -> PlantaCalibrada:
    """Escenario del caso base con lo que la planta haya indicado encima."""
    datos = datos or DatosPlanta()
    base = Escenario()
    origen: dict[str, str] = {}
    ajustes: list[str] = []
    avisos: list[str] = []

    planta = base.planta
    for campo in _CAMPOS_PLANTA:
        valor = getattr(datos, campo)
        origen[campo] = "supuesto" if valor is None else "planta"
        if valor is not None:
            planta = replace(planta, **{campo: float(valor)})

    torre = base.torre
    for campo in _CAMPOS_TORRE:
        valor = getattr(datos, campo)
        origen[campo] = "supuesto" if valor is None else "planta"
        if valor is not None:
            torre = replace(torre, **{campo: float(valor)})

    ciclos = datos.ciclos_actuales
    if ciclos is None and datos.conductividad_reposicion_us_cm and datos.conductividad_purga_us_cm:
        ciclos = datos.conductividad_purga_us_cm / datos.conductividad_reposicion_us_cm
        ajustes.append(
            f"Ciclos actuales {ciclos:.2f}, de dividir la conductividad de la purga "
            f"({datos.conductividad_purga_us_cm:.0f} µS/cm) entre la de la reposicion "
            f"({datos.conductividad_reposicion_us_cm:.0f} µS/cm)."
        )
    if ciclos is not None:
        if ciclos <= 1.05:
            raise ValueError("Los ciclos actuales deben ser mayores que 1.")
        torre = replace(torre, ciclos_base=float(ciclos))
    origen["ciclos_actuales"] = "supuesto" if ciclos is None else "planta"

    if datos.ciclos_tope is not None:
        torre = replace(torre, ciclos_max=float(datos.ciclos_tope))
    origen["ciclos_tope"] = "supuesto" if datos.ciclos_tope is None else "planta"
    if torre.ciclos_max <= torre.ciclos_min:
        raise ValueError(f"El tope de ciclos debe ser mayor que {torre.ciclos_min}.")

    cruda = calidad_con(AGUA_CRUDA, datos.agua_cruda)
    origen["agua_cruda"] = (
        "planta" if datos.agua_cruda else "supuesto"
    )
    if datos.agua_cruda and len(datos.agua_cruda) < 6:
        avisos.append(
            f"La analitica del agua cruda trae {len(datos.agua_cruda)} parametros; "
            "el resto sigue siendo el agua tipo supuesta."
        )

    if datos.reposicion_medida_m3_h is not None:
        modelada = cooling.balance(torre, torre.ciclos_base, cruda.t_c).reposicion_m3_h
        factor = torre.factor_evaporacion * datos.reposicion_medida_m3_h / modelada
        acotado = min(max(factor, FACTOR_EVAPORACION_MIN), FACTOR_EVAPORACION_MAX)
        torre = replace(torre, factor_evaporacion=acotado)
        if acotado == factor:
            ajustes.append(
                f"Evaporacion calibrada con la reposicion medida "
                f"({datos.reposicion_medida_m3_h:.1f} m³/h): factor {factor:.2f}."
            )
        else:
            explicada = cooling.balance(torre, torre.ciclos_base, cruda.t_c).reposicion_m3_h
            avisos.append(
                f"La reposicion medida ({datos.reposicion_medida_m3_h:.1f} m³/h) exigiria "
                f"un factor de evaporacion de {factor:.2f}, fuera de lo fisico "
                f"({FACTOR_EVAPORACION_MIN}-{FACTOR_EVAPORACION_MAX}). La torre explica "
                f"{explicada:.1f} m³/h; la diferencia apunta a una fuga, un consumo en la "
                "linea de reposicion o un dato mal leido."
            )
    origen["reposicion_medida_m3_h"] = (
        "supuesto" if datos.reposicion_medida_m3_h is None else "planta"
    )

    usar_anti = (
        base.usar_antiincrustante if datos.usar_antiincrustante is None
        else datos.usar_antiincrustante
    )
    escenario = replace(
        base, planta=planta, torre=torre, usar_antiincrustante=usar_anti,
        agua_cruda=cruda,
    )
    return PlantaCalibrada(escenario, cruda, origen, tuple(ajustes), tuple(avisos))
