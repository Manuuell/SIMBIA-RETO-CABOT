"""Preselección documental por corriente, independiente de los arquetipos.

Las fuentes y páginas se conservan junto con los valores publicados. Ningún
caudal de campaña se convierte automáticamente en una oferta para Cabot.
"""

import json
from dataclasses import replace
from pathlib import Path

from .perfil import Metodo
from .scoring import PESOS, puntuar
from .texto import normalizar
from ..simulador import calibrar, desde_prospecto, simular, sugerir

DIRECTORIO = Path(__file__).with_name("evidencias")


def seleccion() -> dict:
    return json.loads((DIRECTORIO / "seleccion.json").read_text(encoding="utf-8"))


def documento(identificador: str) -> Path | None:
    fuente = seleccion()["documentos"].get(identificador)
    return DIRECTORIO / fuente["archivo"] if fuente else None


def validacion_modelo() -> dict:
    return {
        "tipo": "escenario_exploratorio",
        "ahorro_validado": False,
        "motivo": "La línea base de Cabot es supuesta; el catálogo combina mediciones "
                  "parciales y arquetipos. La factibilidad matemática no acredita "
                  "compatibilidad, disponibilidad ni autorización de reúso.",
        "evidencia_url": "/api/scout/evidencia",
    }


def evaluar(prospectos: list) -> dict:
    """Ranking inicial → evidencia por punto → caso reproducible de dos fuentes.

Los valores sin medición conservan el complemento del catálogo, identificado
campo por campo. El caudal de campaña es un techo hipotético de evaluación.
No altera las fichas de los prospectos ni ofrece ese caudal como contratado.
"""
    d = seleccion()
    aliases = {
        "mexichem-efluente-3": {"mexichem sa", "mexichem resinas colombia"},
        "yara-norte-1": {"abocol sa", "yara colombia"},
    }
    ordenados = sorted(prospectos, key=lambda p: p.puntaje or 0, reverse=True)
    fuentes = []
    for c in d["candidatos"]:
        coincidencias = [(i, p) for i, p in enumerate(ordenados, 1)
                         if normalizar(p.nombre) in {normalizar(a) for a in aliases[c["id"]]}]
        if len(coincidencias) != 1:
            raise ValueError(f"No se pudo identificar de forma única {c['empresa']} en el barrido")
        puesto, p = coincidencias[0]
        medidos = {k: v["valor"] for k, v in c["calidad"].items()
                   if isinstance(v["valor"], (int, float))
                   and not v.get("calificador") and hasattr(p.calidad, k)}
        hipotesis = {}
        rangos = {}
        for k, v in c["calidad"].items():
            if isinstance(v["valor"], list) and len(v["valor"]) == 2 and hasattr(p.calidad, k):
                rangos[k] = sum(v["valor"]) / 2
                hipotesis[k] = "Punto medio del rango observado para simular; no es un promedio medido."
        actualizado = puntuar(replace(
            p, calidad=replace(p.calidad, **medidos, **rangos),
            caudal_m3_h=c["caudal"]["m3_h"], corriente=c["punto"],
            campos_medidos=frozenset(medidos), metodo_caudal=Metodo.MEDIDO,
            metodo_calidad=Metodo.MEDIDO, notas="Evaluación de corriente documentada",
        ))
        f = desde_prospecto(actualizado, c["id"]).as_dict()
        # No redondear entradas: inicio y gemelo deben usar el mismo escenario.
        f.update(nombre=c["empresa"], caudal_disponible_m3_h=c["caudal"]["m3_h"],
                 distancia_km=p.distancia_conduccion_km,
                 precio_usd_m3=p.incentivo_usd_m3, procedencia="inferido")
        f["calidad"] = {k: getattr(actualizado.calidad, k) for k in p.calidad.__dataclass_fields__}
        f["campos_medidos"] = sorted(medidos)
        f["campos_complementados"] = sorted(set(p.calidad.__dataclass_fields__) - set(medidos))
        f["evidencia_id"] = c["id"]
        fuentes.append(f)
        c["evaluacion"] = {
            "puesto_inicial": puesto, "puntaje_inicial": p.puntaje,
            "puntaje_documentado": actualizado.puntaje,
            "desglose_inicial": p.detalle_puntaje,
            "desglose_documentado": actualizado.detalle_puntaje,
            "distancia_km": p.distancia_conduccion_km,
            "tren_sugerido": actualizado.tren_sugerido,
            "plan": actualizado.notas,
            "campos_medidos": f["campos_medidos"],
            "hipotesis": hipotesis,
            "complemento_modelo": {k: getattr(actualizado.calidad, k)
                                   for k in f["campos_complementados"]},
        }
    planta = calibrar()
    # Mismos objetos, precisión y motor que recibe el gemelo por su API.
    from ..simulador import Fuente, calidad_con
    from ..domain.water_chem import Calidad
    objetos = [Fuente(**{k: v for k, v in f.items() if k in Fuente.__dataclass_fields__ and k != "calidad"},
                      calidad=calidad_con(Calidad(), {k: v for k, v in f["calidad"].items()
                                                     if k in Calidad.__dataclass_fields__})) for f in fuentes]
    propuesta = sugerir(planta.escenario, objetos)
    decision = propuesta.decision
    resultado = simular(planta.escenario, decision).as_dict() if decision else None
    d["barrido"] = {
        "total": len(ordenados), "con_potencial": sum((p.puntaje or 0) > 0 for p in ordenados),
        "pesos": PESOS,
        "ranking": [{"puesto": i, "empresa": p.nombre, "puntaje": p.puntaje}
                    for i, p in enumerate(ordenados, 1)],
    }
    d["cruce"] = {
        "modo": propuesta.modo, "motivo": propuesta.motivo,
        "resultado": resultado, "planta_referencia": planta.as_dict(),
        "escenario": {
            "planta": {}, "fuentes": fuentes,
            "tomas": [{"fuente_id": t.fuente.id, "caudal_m3_h": t.caudal_m3_h, "tren": t.tren}
                      for t in decision.tomas] if decision else [],
            "acido_mg_l": decision.acido_mg_l if decision else 0,
            "ciclos": decision.ciclos if decision else None,
        },
        "validacion": validacion_modelo(),
    }
    return d
