"""Serializacion de los objetos de dominio a JSON."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any

from ..domain.streams import Oferente, Opcion, Tren
from ..domain.water_chem import Calidad
from ..optim.blend import Solucion


def calidad_json(c: Calidad | None) -> dict[str, Any] | None:
    return None if c is None else c.as_dict()


def oferente_json(o: Oferente) -> dict[str, Any]:
    return {
        "codigo": o.codigo, "empresa": o.empresa, "sector": o.sector,
        "corriente": o.corriente,
        "caudal_disponible_m3_h": o.caudal_disponible_m3_h,
        "distancia_km": o.distancia_km, "precio_usd_m3": o.precio_usd_m3,
        "disponibilidad": o.disponibilidad, "notas": o.notas,
        "calidad": calidad_json(o.calidad),
    }


def tren_json(t: Tren) -> dict[str, Any]:
    return {
        "codigo": t.codigo, "nombre": t.nombre,
        "unidades": [u.codigo for u in t.unidades],
        "recuperacion": round(t.recuperacion, 4),
        "capex_usd_m3h": round(t.capex_usd_m3h_producto, 1),
        "opex_usd_m3": round(t.opex_usd_m3_producto, 4),
    }


def opcion_json(o: Opcion, caudal: float) -> dict[str, Any]:
    return {
        "codigo": o.codigo,
        "oferente": o.oferente.codigo,
        "empresa": o.oferente.empresa,
        "corriente": o.oferente.corriente,
        "tren": o.tren.codigo,
        "tren_nombre": o.tren.nombre,
        "distancia_km": o.oferente.distancia_km,
        "caudal_m3_h": round(caudal, 3),
        "caudal_m3_dia": round(caudal * 24, 1),
        "caudal_max_m3_h": round(o.caudal_max_m3_h, 3),
        "costo_usd_m3": round(o.costo_usd_m3, 4),
        "desglose_costo": {k: round(v, 4) for k, v in o.desglose.items()},
        "calidad_producto": calidad_json(o.calidad_producto),
    }


def solucion_json(s: Solucion) -> dict[str, Any]:
    return {
        "factible": s.factible,
        "motivo": s.motivo,
        "ciclos": round(s.ciclos, 2),
        "balance": s.balance.as_dict() if s.balance else None,
        "agua_cruda_m3_h": round(s.caudal_cruda_m3_h, 3),
        "agua_cruda_m3_dia": round(s.caudal_cruda_m3_h * 24, 1),
        "acido_kg_h": round(s.acido_kg_h, 3),
        "aportes": [
            opcion_json(op, s.aportes[op.codigo]) for op in s.opciones_usadas
        ],
        "reuso_total_m3_dia": round(sum(s.aportes.values()) * 24, 1),
        "calidad_aporte": calidad_json(s.calidad_aporte),
        "calidad_circulante": calidad_json(s.calidad_circulante),
        "costo_total_usd_anio": round(s.costo_total_usd_anio, 0),
        "costos": {k: round(v, 0) for k, v in s.costos.items()},
        "ahorro_m3_dia": round(s.ahorro_m3_dia, 1),
        "ahorro_pct_planta": round(s.ahorro_pct_planta, 4),
        "capex_total_usd": round(s.capex_total_usd, 0),
    }


def dc_json(x: Any) -> Any:
    if is_dataclass(x) and not isinstance(x, type):
        return {k: dc_json(v) for k, v in asdict(x).items()}
    if isinstance(x, list):
        return [dc_json(v) for v in x]
    return x
