"""Vigilancia: que ha cambiado en el parque industrial desde la ultima vez.

Un barrido es una foto. Lo que interesa a medio plazo es la pelicula: una
empresa nueva se instala, a un vecino le renuevan el permiso con otro caudal,
una planta cierra una linea y su rechazo se reduce a la mitad. Cualquiera de
esas cosas cambia el plan optimo, y ninguna avisa por su cuenta.

Este modulo compara el barrido actual contra la ultima instantanea archivada
y devuelve una lista de cambios con severidad. La severidad no es decorativa:
gobierna que se muestra arriba en el dashboard y que merece una llamada.

Los umbrales son deliberadamente altos. Un detector que avisa de todo se
ignora en dos semanas, y entonces no avisa de nada.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any

from .almacen import clave_estable, instantaneas, leer_instantanea
from .perfil import Prospecto


class Severidad(str, Enum):
    ALTA = "alta"      # cambia el plan: hay que recalcular y probablemente llamar
    MEDIA = "media"    # conviene revisarlo en el siguiente comite
    BAJA = "baja"      # se registra, no se actua


#: Variacion relativa a partir de la cual un cambio es noticia.
UMBRAL_CAUDAL = 0.20        # 20 % de caudal mueve el dimensionado
UMBRAL_SALINIDAD = 0.15     # 15 % de TDS mueve los ciclos alcanzables
UMBRAL_PUNTAJE = 8.0        # puntos absolutos


@dataclass(frozen=True)
class Cambio:
    tipo: str
    severidad: Severidad
    clave: str
    empresa: str
    descripcion: str
    antes: str = ""
    ahora: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "tipo": self.tipo, "severidad": self.severidad.value,
            "clave": self.clave, "empresa": self.empresa,
            "descripcion": self.descripcion, "antes": self.antes,
            "ahora": self.ahora,
        }


def _relativo(antes: float, ahora: float) -> float:
    if not antes:
        return 1.0 if ahora else 0.0
    return (ahora - antes) / abs(antes)


def comparar(
    prospectos: list[Prospecto], anterior: dict[str, Any],
) -> list[Cambio]:
    """Diferencias entre el barrido actual y una instantanea archivada."""
    previos = {
        p["clave"]: p for p in anterior.get("prospectos", [])
    }
    actuales = {
        clave_estable(p.nombre, p.lat, p.lon): p for p in prospectos
    }
    cambios: list[Cambio] = []

    # -- altas ---------------------------------------------------------
    for clave, p in actuales.items():
        if clave in previos:
            continue
        cambios.append(Cambio(
            tipo="alta", severidad=Severidad.ALTA, clave=clave,
            empresa=p.nombre,
            descripcion=(
                f"Oferente nuevo en el radio: {p.sector}, "
                f"{p.caudal_m3_h:.0f} m3/h estimados a "
                f"{p.distancia_conduccion_km:.1f} km"
            ),
            ahora=f"{p.caudal_m3_h:.0f} m3/h",
        ))

    # -- bajas ---------------------------------------------------------
    for clave, previo in previos.items():
        if clave in actuales:
            continue
        cambios.append(Cambio(
            tipo="baja", severidad=Severidad.ALTA, clave=clave,
            empresa=previo.get("nombre", clave),
            descripcion=(
                "Ya no aparece en las fuentes. Puede ser cierre, cambio de "
                "razon social o que la fuente dejo de publicarlo: verificar "
                "antes de sacarlo del plan"
            ),
            antes=f"{previo.get('caudal_m3_h', 0):.0f} m3/h",
        ))

    # -- variaciones ---------------------------------------------------
    for clave, p in actuales.items():
        previo = previos.get(clave)
        if previo is None:
            continue

        d = _relativo(float(previo.get("caudal_m3_h", 0)), p.caudal_m3_h)
        if abs(d) >= UMBRAL_CAUDAL:
            cambios.append(Cambio(
                tipo="caudal",
                severidad=Severidad.ALTA if abs(d) >= 0.4 else Severidad.MEDIA,
                clave=clave, empresa=p.nombre,
                descripcion=(
                    f"El caudal disponible {'subio' if d > 0 else 'bajo'} "
                    f"un {abs(d):.0%}: revisar dimensionado de la conduccion"
                ),
                antes=f"{previo.get('caudal_m3_h', 0):.0f} m3/h",
                ahora=f"{p.caudal_m3_h:.0f} m3/h",
            ))

        d = _relativo(float(previo.get("tds", 0)), p.calidad.tds)
        if abs(d) >= UMBRAL_SALINIDAD:
            cambios.append(Cambio(
                tipo="salinidad",
                severidad=Severidad.ALTA if d > 0 else Severidad.MEDIA,
                clave=clave, empresa=p.nombre,
                descripcion=(
                    f"La salinidad {'subio' if d > 0 else 'bajo'} un "
                    f"{abs(d):.0%}: cambia los ciclos alcanzables"
                ),
                antes=f"{previo.get('tds', 0):.0f} mg/L TDS",
                ahora=f"{p.calidad.tds:.0f} mg/L TDS",
            ))

        antes_conf = float(previo.get("confianza", 0))
        if p.confianza - antes_conf >= 0.15:
            cambios.append(Cambio(
                tipo="confianza", severidad=Severidad.MEDIA,
                clave=clave, empresa=p.nombre,
                descripcion=(
                    "Aparecio informacion nueva (analitica o permiso): el "
                    "prospecto es ahora mas fiable"
                ),
                antes=f"{antes_conf:.2f}", ahora=f"{p.confianza:.2f}",
            ))

        antes_pts = previo.get("puntaje")
        if antes_pts is not None and p.puntaje is not None:
            delta = p.puntaje - float(antes_pts)
            if abs(delta) >= UMBRAL_PUNTAJE:
                cambios.append(Cambio(
                    tipo="puntaje", severidad=Severidad.MEDIA,
                    clave=clave, empresa=p.nombre,
                    descripcion=(
                        f"El puntaje de simbiosis se movio {delta:+.0f} puntos"
                    ),
                    antes=f"{float(antes_pts):.0f}", ahora=f"{p.puntaje:.0f}",
                ))

    orden = {Severidad.ALTA: 0, Severidad.MEDIA: 1, Severidad.BAJA: 2}
    cambios.sort(key=lambda c: (orden[c.severidad], c.empresa))
    return cambios


def revisar(prospectos: list[Prospecto]) -> dict[str, Any]:
    """Compara contra la ultima instantanea disponible."""
    archivo = instantaneas()
    if not archivo:
        return {
            "hay_referencia": False,
            "referencia": "",
            "cambios": [],
            "resumen": (
                "Primera pasada: no hay instantanea anterior con la que "
                "comparar. Al archivar esta, la proxima ya detecta cambios."
            ),
        }
    anterior = leer_instantanea(archivo[-1])
    cambios = comparar(prospectos, anterior)
    altas = sum(1 for c in cambios if c.severidad is Severidad.ALTA)
    return {
        "hay_referencia": True,
        "referencia": anterior.get("tomada", ""),
        "instantaneas_archivadas": len(archivo),
        "cambios": [c.as_dict() for c in cambios],
        "resumen": (
            f"{len(cambios)} cambio(s) desde {anterior.get('tomada', '')[:10]}"
            + (f", {altas} de severidad alta" if altas else "")
            if cambios else
            f"Sin cambios desde {anterior.get('tomada', '')[:10]}"
        ),
    }
