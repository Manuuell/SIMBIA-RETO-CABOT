"""Persistencia del modulo de prospeccion.

Dos cosas se guardan en disco y por razones distintas:

**El estado comercial** (`estado.json`). Un barrido es reproducible: si se
vuelve a lanzar manana sale lo mismo. Lo que no es reproducible es el trabajo
humano encima: a quien se llamo, quien contesto, que se firmo. Eso hay que
guardarlo o se pierde.

**Las instantaneas** (`instantaneas/`). Cada barrido se archiva para poder
comparar con el siguiente. Es lo que permite decir "aparecio una empresa
nueva" o "a este vecino le cambiaron el caudal autorizado".

LA CLAVE ESTABLE
----------------

El codigo de un prospecto (`P01`, `P02`...) se asigna por orden de cercania
dentro de un barrido, asi que cambia entre barridos: si aparece una empresa
mas cerca, todo lo de atras se desplaza. Guardar el estado comercial contra
ese codigo perderia el trabajo en cuanto cambiara el catalogo.

Por eso el estado se guarda contra una **clave estable**: hash del nombre
normalizado mas la coordenada redondeada a ~100 m. Sobrevive a cambios de
orden, a variaciones menores del nombre y a que una fuente afine la
coordenada. No sobrevive a que una empresa se mude o cambie de razon social,
que es justo cuando conviene revisar el expediente a mano.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .perfil import ORDEN_ESTADO, Estado, Prospecto
from .texto import normalizar

BASE = Path(__file__).resolve().parent / "archivo"
ESTADOS = BASE / "estado.json"
INSTANTANEAS = BASE / "instantaneas"


def clave_estable(nombre: str, lat: float, lon: float) -> str:
    """Identidad de un prospecto que sobrevive entre barridos."""
    # 3 decimales de grado son ~110 m: suficiente para tolerar que dos
    # fuentes situen la misma planta en esquinas distintas del predio.
    semilla = f"{normalizar(nombre)}|{lat:.3f}|{lon:.3f}"
    return hashlib.sha256(semilla.encode("utf-8")).hexdigest()[:12]


# --------------------------------------------------------------------------
# Ficha comercial
# --------------------------------------------------------------------------

#: Que hace falta para pasar de cada etapa a la siguiente. El dashboard lo
#: muestra como "siguiente paso", que es la unica pregunta que un comercial
#: se hace al abrir la ficha.
REQUISITO_SIGUIENTE: dict[Estado, str] = {
    Estado.DETECTADO: (
        "Verificar que la corriente existe y estimar su caudal: consulta del "
        "permiso de vertimiento o llamada de sondeo"
    ),
    Estado.CALIFICADO: (
        "Identificar interlocutor tecnico (jefe de planta o de ambiental) y "
        "presentar la propuesta de simbiosis"
    ),
    Estado.CONTACTADO: (
        "Firmar acuerdo de confidencialidad para poder intercambiar analitica "
        "y datos de proceso"
    ),
    Estado.NDA: (
        "Campana de caracterizacion: minimo tres muestras compuestas en "
        "condiciones distintas de operacion"
    ),
    Estado.CARACTERIZADO: (
        "Piloto en campo con el tren de tratamiento propuesto, midiendo "
        "ciclos reales sostenidos"
    ),
    Estado.PILOTO: (
        "Negociar contrato de suministro: caudal firme, calidad garantizada, "
        "penalizaciones y plazo"
    ),
    Estado.CONTRATADO: "Contrato firmado. Pasa a ejecucion de obra.",
    Estado.DESCARTADO: "Descartado. Revisar si cambian las condiciones.",
}


@dataclass
class Ficha:
    """Trabajo humano acumulado sobre un prospecto."""

    clave: str
    estado: Estado = Estado.DETECTADO
    responsable: str = ""
    contacto: str = ""
    proximo_paso: str = ""
    notas: str = ""
    historial: list[dict[str, str]] = field(default_factory=list)
    actualizado: str = ""

    @property
    def avance(self) -> float:
        """Progreso en el embudo, 0-1. Un descarte vale 0."""
        if self.estado is Estado.DESCARTADO:
            return 0.0
        return (ORDEN_ESTADO.index(self.estado) + 1) / len(ORDEN_ESTADO)

    @property
    def requisito(self) -> str:
        return REQUISITO_SIGUIENTE.get(self.estado, "")

    def as_dict(self) -> dict[str, Any]:
        return {
            "clave": self.clave,
            "estado": self.estado.value,
            "responsable": self.responsable,
            "contacto": self.contacto,
            "proximo_paso": self.proximo_paso or self.requisito,
            "requisito": self.requisito,
            "notas": self.notas,
            "historial": self.historial,
            "actualizado": self.actualizado,
            "avance": round(self.avance, 3),
        }


def _leer_json(ruta: Path, defecto):
    if not ruta.is_file():
        return defecto
    try:
        return json.loads(ruta.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return defecto


def cargar_fichas() -> dict[str, Ficha]:
    bruto = _leer_json(ESTADOS, {})
    fichas: dict[str, Ficha] = {}
    for clave, d in bruto.items():
        try:
            estado = Estado(d.get("estado", "detectado"))
        except ValueError:
            estado = Estado.DETECTADO
        fichas[clave] = Ficha(
            clave=clave,
            estado=estado,
            responsable=d.get("responsable", ""),
            contacto=d.get("contacto", ""),
            proximo_paso=d.get("proximo_paso", ""),
            notas=d.get("notas", ""),
            historial=d.get("historial", []),
            actualizado=d.get("actualizado", ""),
        )
    return fichas


def guardar_fichas(fichas: dict[str, Ficha]) -> None:
    BASE.mkdir(parents=True, exist_ok=True)
    ESTADOS.write_text(
        json.dumps(
            {
                k: {
                    "estado": f.estado.value,
                    "responsable": f.responsable,
                    "contacto": f.contacto,
                    "proximo_paso": f.proximo_paso,
                    "notas": f.notas,
                    "historial": f.historial,
                    "actualizado": f.actualizado,
                }
                for k, f in fichas.items()
            },
            ensure_ascii=False, indent=2,
        ),
        encoding="utf-8",
    )


def actualizar_ficha(
    clave: str,
    estado: Estado | None = None,
    responsable: str | None = None,
    contacto: str | None = None,
    proximo_paso: str | None = None,
    notas: str | None = None,
    nombre: str = "",
) -> Ficha:
    """Modifica una ficha y deja rastro del cambio de etapa en el historial."""
    fichas = cargar_fichas()
    ficha = fichas.get(clave) or Ficha(clave=clave)
    ahora = datetime.now(timezone.utc).isoformat(timespec="seconds")

    if estado is not None and estado is not ficha.estado:
        ficha.historial.append({
            "fecha": ahora,
            "de": ficha.estado.value,
            "a": estado.value,
            "empresa": nombre,
        })
        ficha.estado = estado
    for campo, valor in (
        ("responsable", responsable), ("contacto", contacto),
        ("proximo_paso", proximo_paso), ("notas", notas),
    ):
        if valor is not None:
            setattr(ficha, campo, valor)

    ficha.actualizado = ahora
    fichas[clave] = ficha
    guardar_fichas(fichas)
    return ficha


def aplicar_fichas(prospectos: list[Prospecto]) -> list[Prospecto]:
    """Vuelca el estado comercial guardado sobre un barrido recien hecho."""
    fichas = cargar_fichas()
    salida: list[Prospecto] = []
    for p in prospectos:
        ficha = fichas.get(clave_estable(p.nombre, p.lat, p.lon))
        salida.append(p if ficha is None else replace(p, estado=ficha.estado))
    return salida


# --------------------------------------------------------------------------
# Instantaneas
# --------------------------------------------------------------------------

def guardar_instantanea(prospectos: list[Prospecto]) -> Path:
    """Archiva un barrido para poder compararlo con el siguiente."""
    INSTANTANEAS.mkdir(parents=True, exist_ok=True)
    ahora = datetime.now(timezone.utc)
    ruta = INSTANTANEAS / f"{ahora.strftime('%Y%m%dT%H%M%S')}.json"
    ruta.write_text(
        json.dumps(
            {
                "tomada": ahora.isoformat(timespec="seconds"),
                "prospectos": [
                    {
                        "clave": clave_estable(p.nombre, p.lat, p.lon),
                        "nombre": p.nombre,
                        "sector": p.sector,
                        "caudal_m3_h": p.caudal_m3_h,
                        "confianza": p.confianza,
                        "puntaje": p.puntaje,
                        "distancia_conduccion_km": p.distancia_conduccion_km,
                        "tds": p.calidad.tds,
                        "dqo": p.calidad.dqo,
                    }
                    for p in prospectos
                ],
            },
            ensure_ascii=False, indent=2,
        ),
        encoding="utf-8",
    )
    return ruta


def instantaneas() -> list[Path]:
    if not INSTANTANEAS.is_dir():
        return []
    return sorted(INSTANTANEAS.glob("*.json"))


def leer_instantanea(ruta: Path) -> dict[str, Any]:
    return _leer_json(ruta, {"tomada": "", "prospectos": []})
