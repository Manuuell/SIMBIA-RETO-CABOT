"""Del prospecto al catalogo del optimizador.

Un `Prospecto` es una hipotesis: hay una empresa ahi y probablemente su
rechazo se parezca a esto. Un `Oferente` es una entrada del catalogo que el
optimizador trata como un hecho y sobre la que decide invertir.

Convertir lo primero en lo segundo es la decision mas delicada del modulo, y
por eso tiene una puerta explicita: el umbral de confianza. Por debajo de el,
el prospecto no entra al optimizador aunque quimicamente sea magnifico,
porque optimizar sobre datos inventados produce un plan de inversion
inventado.

El umbral por defecto (0,55) deja fuera lo puramente inferido a partir del
sector y deja pasar lo que tiene al menos analitica declarada. Se puede bajar
a proposito para explorar "que pasaria si", pero entonces el resultado va
marcado como exploratorio.
"""

from __future__ import annotations

from ..domain.streams import Oferente
from .perfil import Prospecto

#: Confianza minima para que un prospecto entre al optimizador.
UMBRAL_PROMOCION = 0.55

#: Temperatura por encima de la cual la corriente exige enfriamiento previo.
#: Coherente con el limite del relleno de PVC del catalogo del dominio.
T_EXIGE_ENFRIAMIENTO_C = 45.0


def a_oferente(prospecto: Prospecto, codigo: str | None = None) -> Oferente:
    """Traduce un prospecto a una entrada de catalogo.

    Dos ajustes al pasar de uno a otro:

    - **Disponibilidad castigada por confianza.** El factor de disponibilidad
      anual del catalogo mide cuanto tiempo la corriente esta realmente ahi.
      Un prospecto poco fiable merece un factor menor: no porque la planta
      vaya a parar mas, sino porque la propia existencia del caudal es menos
      segura. Es la forma de que la incertidumbre llegue al optimizador como
      un numero y no como una nota al pie.
    - **La distancia que viaja es la del trazado**, no la geodesica. El
      optimizador la multiplica por el costo de conduccion por km, asi que
      meterle la linea recta subestimaria el CAPEX sistematicamente.
    """
    disponibilidad = round(0.95 * (0.6 + 0.4 * prospecto.confianza), 3)
    return Oferente(
        codigo=codigo or prospecto.codigo,
        empresa=prospecto.nombre,
        sector=prospecto.sector,
        corriente=prospecto.corriente,
        caudal_disponible_m3_h=prospecto.caudal_m3_h,
        calidad=prospecto.calidad,
        distancia_km=prospecto.distancia_conduccion_km,
        precio_usd_m3=prospecto.incentivo_usd_m3,
        disponibilidad=disponibilidad,
        requiere_enfriamiento=prospecto.calidad.t_c > T_EXIGE_ENFRIAMIENTO_C,
        notas=(
            f"Prospecto {prospecto.codigo} - confianza {prospecto.confianza} "
            f"({prospecto.confianza_etiqueta}), calidad {prospecto.metodo_calidad.value}, "
            f"caudal {prospecto.metodo_caudal.value}. {prospecto.limitante}"
        ),
    )


def promovibles(
    prospectos: list[Prospecto], umbral: float = UMBRAL_PROMOCION,
) -> list[Prospecto]:
    return [p for p in prospectos if p.confianza >= umbral]


def catalogo_desde_prospectos(
    prospectos: list[Prospecto], umbral: float = UMBRAL_PROMOCION,
) -> tuple[Oferente, ...]:
    """Catalogo listo para `optimizar()`, con codigos estables y unicos."""
    return tuple(
        a_oferente(p, codigo=f"S{i:02d}")
        for i, p in enumerate(promovibles(prospectos, umbral), start=1)
    )
