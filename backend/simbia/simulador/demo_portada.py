"""Simulacion de la portada: el gemelo real, grabado para reproducirlo.

La portada es publica y la API del simulador esta detras del inicio de
sesion, asi que la animacion de la seccion "Simular" no puede pedir nada al
servidor. Este script hace exactamente lo que hace el panel y graba el
resultado:

    1. toma los vecinos prospectados como fuentes (/candidatos),
    2. pide la mezcla al optimizador (/sugerir),
    3. deja correr la torre un dia como opera hoy y, al empezar el dia 1,
       conecta los vecinos y sube la consigna de conductividad en rampa,
       como el boton "Sugerir mezcla" del gemelo (/dinamica).

Se ejecuta desde backend/:

    python -m simbia.simulador.demo_portada

y escribe frontend/landing/gemelo-demo.json. Hay que volver a correrlo si
cambian el modelo o el catalogo de vecinos.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from fastapi.testclient import TestClient

from ..main import app
from . import dinamica

SALIDA = Path(__file__).resolve().parents[3] / "frontend" / "landing" / "gemelo-demo.json"
CAMPOS_FUENTE = ("id", "nombre", "caudal_disponible_m3_h", "distancia_km", "precio_usd_m3", "procedencia",
                 "confianza", "sector", "corriente", "tren_sugerido")
HORAS_BASE = 24.0       # un dia operando como hoy antes de conectar vecinos
HORAS_TOTAL = 14 * 24.0  # dos semanas: la alcalinidad tarda unos ocho dias en renovarse
CADA_H = 2.0            # resolucion de lo grabado
RAMPA_US_CM_H = 2.0     # la misma rampa que aplica el panel


def _fuente(c: dict) -> dict:
    calidad = {k: v for k, v in (c.get("calidad") or {}).items() if v is not None and k != "conductividad"}
    return {**{k: c[k] for k in CAMPOS_FUENTE if c.get(k) is not None}, "calidad": calidad}


def generar(cliente: TestClient) -> dict:
    candidatos = cliente.get("/api/simulador/candidatos").raise_for_status().json()
    fuentes = [_fuente(c) for c in candidatos]
    sin_tomas = [{"fuente_id": f["id"], "caudal_m3_h": 0.0, "tren": f.get("tren_sugerido") or "T1"} for f in fuentes]
    s = cliente.post("/api/simulador/sugerir", json={"fuentes": fuentes, "tomas": sin_tomas}).raise_for_status().json()
    if not s["decision"]:
        raise SystemExit(f"El optimizador no propone mezcla: {s['motivo']}")
    decision, res = s["decision"], s["resultado"]
    consigna = round(res["ciclos"] * res["aporte"]["conductividad"] * 0.97 / 25) * 25
    tomas = {t["fuente_id"]: t for t in decision["tomas"] if t["caudal_m3_h"] > 0}
    nombres = {c["id"]: c["nombre"] for c in candidatos}
    trenes = {t["codigo"]: t["nombre"] for t in cliente.get("/api/simulador/referencia").raise_for_status().json()["trenes"]}

    muestras, estado, t = [], None, 0.0
    while t < HORAS_TOTAL - 1e-9:
        conectado = t >= HORAS_BASE - 1e-9
        horas = min(dinamica.MAX_HORAS_POR_LLAMADA, (HORAS_BASE if not conectado else HORAS_TOTAL) - t)
        cuerpo = {
            "fuentes": fuentes,
            "tomas": list(tomas.values()) if conectado else sin_tomas,
            "acido_mg_l": decision["acido_mg_l"] if conectado else 0.0,
            "conductividad": {"modo": "auto", "consigna": consigna, "rampa_por_h": RAMPA_US_CM_H} if conectado
            else {"modo": "auto"},
            "estado": estado,
            "horas": horas,
        }
        r = cliente.post("/api/simulador/dinamica", json=cuerpo).raise_for_status().json()
        muestras += r["muestras"]
        estado, t = r["estado"], r["estado"]["t_h"]
        referencia = r

    def redondeo(m: dict) -> dict:
        return {
            "t": round(m["t_h"], 2), "ahorro": round(m["ahorro_pct"], 4),
            "cruda": round(m["cruda_m3_h"], 1), "vecinos": round(m["vecinos_m3_h"], 1),
            "purga": round(m["purga_m3_h"], 1), "cond": round(m["conductividad"]),
            "consigna": round(m["consigna_cond"]), "ciclos": round(m["ciclos"], 2) if m["ciclos"] else None,
            "lsi": round(m["lsi"], 2), "ls": round(m["larson_skold"], 2),
            # "fuera": algun limite superado; "cerca": a menos del 5 % de uno.
            "fuera": sum(a["severidad"] == "alta" for a in m["alarmas"]),
            "cerca": sum(a["severidad"] == "baja" for a in m["alarmas"]),
        }

    grabadas = [redondeo(m) for m in muestras if abs(m["t_h"] / CADA_H - round(m["t_h"] / CADA_H)) < 1e-6]
    return {
        "generado": date.today().isoformat(),
        "conecta_h": HORAS_BASE,
        "meta": 0.10,
        "limites": referencia["limites"],
        "vecinos": [
            {"nombre": nombres[i], "caudal_m3_h": round(t["caudal_m3_h"], 1), "tren": t["tren"],
             "tren_nombre": trenes.get(t["tren"], t["tren"])}
            for i, t in sorted(tomas.items(), key=lambda kv: -kv[1]["caudal_m3_h"])
        ],
        "regimen": {"ahorro": res["ahorro_pct"], "ciclos": res["ciclos"]},
        "muestras": grabadas,
    }


if __name__ == "__main__":
    datos = generar(TestClient(app))
    SALIDA.write_text(json.dumps(datos, ensure_ascii=False, separators=(",", ":")))
    final = datos["muestras"][-1]
    print(f"{SALIDA.name}: {len(datos['muestras'])} muestras, {len(datos['vecinos'])} vecinos, "
          f"ahorro final {final['ahorro'] * 100:.1f} % a {final['ciclos']} ciclos, "
          f"limites superados en {sum(m['fuera'] > 0 for m in datos['muestras'])} muestras")
