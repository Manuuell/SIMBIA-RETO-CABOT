"""Herramientas del asistente: lo que puede consultar, simular y abrir.

El modelo no ve la aplicacion entera: pide una herramienta por su nombre,
con argumentos, y recibe un JSON compacto. Todas leen o simulan; ninguna
guarda ni borra nada. La unica que toca la pantalla, abrir_en_panel, solo
devuelve una accion que ejecuta el navegador de quien pregunta, y la arma el
servidor: el modelo elige el destino y la empresa, no escribe la URL.

Cada resultado trae, ademas de los datos para el modelo, una linea para el
chat («Simulo la torre con Dexton · 12,3 % de ahorro») y unos pocos pares
etiqueta-valor para el desplegable del paso. Es lo que el usuario ve
mientras el asistente trabaja.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from difflib import SequenceMatcher
from functools import cached_property
from typing import Any, Callable

from .. import asistente
from ..domain.streams import TRENES, TRENES_POR_CODIGO
from ..ia import Herramienta
from ..scout import almacen
from ..scout.texto import normalizar, sin_tildes
from ..simulador import Decision, Fuente, Toma, calibrar, desde_prospecto, simular, sugerir
from . import scout as api_scout

MAX_TOMAS = 8
MAX_RESULTADOS = 15
MAX_ACIDO_MG_L = 200.0
MAX_CAUDAL_M3_H = 1_000.0


def _n(valor: float | None, decimales: int = 1) -> str:
    """Una cifra como se escribe en espanol: 1.234,5."""
    if valor is None:
        return "—"
    texto = f"{float(valor):,.{decimales}f}"
    return texto.replace(",", " ").replace(".", ",").replace(" ", ".")


def _pct(fraccion: float | None) -> str:
    return "—" if fraccion is None else f"{_n(fraccion * 100)} %"


def _corto(texto: str, maximo: int = 90) -> str:
    """Recorta en una palabra, no a mitad."""
    texto = " ".join(str(texto).split())
    return texto if len(texto) <= maximo else texto[:maximo].rsplit(" ", 1)[0] + "…"


@dataclass
class Resultado:
    """Lo que devuelve una herramienta."""

    datos: dict[str, Any]                  # lo que lee el modelo
    paso: str                              # una linea para el chat
    ok: bool = True
    detalle: list[list[str]] = field(default_factory=list)   # [etiqueta, valor]
    accion: dict[str, Any] | None = None   # lo que debe abrir el navegador

    def para_chat(self) -> dict[str, Any]:
        return {"estado": "hecho" if self.ok else "error", "texto": self.paso, "detalle": self.detalle}


class Ambigua(ValueError):
    """La empresa pedida no se encontro, o coincide con varias."""

    def __init__(self, pedida: str, candidatas: list[str]):
        self.candidatas = candidatas
        if candidatas:
            super().__init__(f"«{pedida}» puede ser: {', '.join(candidatas)}")
        else:
            super().__init__(f"No hay ninguna empresa como «{pedida}» en el barrido")


class Mesa:
    """Lo que comparten las herramientas mientras se responde una pregunta."""

    def __init__(self, radio_km: float, kpis: dict[str, Any] | None = None):
        self.radio_km = radio_km
        self.kpis = kpis or {}
        self.resultados: dict[str, Resultado] = {}
        #: La ultima mezcla de sugerir_mezcla, lista para abrirla en el gemelo.
        self.mezcla_sugerida: list[dict[str, Any]] = []
        self.nombres_sugeridos: list[str] = []

    @cached_property
    def prospectos(self) -> list[dict[str, Any]]:
        return api_scout.barrido(radio_km=self.radio_km)["prospectos"]

    @cached_property
    def fuentes(self) -> dict[str, Fuente]:
        """Cada prospecto como fuente del simulador, igual que en el gemelo."""
        salida = {}
        for p in api_scout._barrido(max(0.5, min(self.radio_km, 40.0))):
            clave = almacen.clave_estable(p.nombre, p.lat, p.lon)
            salida[clave] = desde_prospecto(p, clave)
        return salida

    @cached_property
    def escenario(self):
        return calibrar().escenario

    def empresa(self, pedida: Any) -> dict[str, Any]:
        """El prospecto que corresponde a un nombre (o una clave)."""
        texto = str(pedida or "").strip()[:200]
        if not texto:
            raise ValueError("Falta el nombre de la empresa")
        ps = self.prospectos
        exacta = [p for p in ps if p["clave"] == texto]
        if exacta:
            return exacta[0]
        q = normalizar(texto) or sin_tildes(texto).lower()
        nombres = {p["clave"]: normalizar(p["nombre"]) for p in ps}
        for prueba in (
            lambda n: n == q,
            lambda n: bool(n) and (q in n or n in q),
            lambda n: all(any(w.startswith(x) for w in n.split()) for x in q.split()),
        ):
            candidatas = [p for p in ps if prueba(nombres[p["clave"]])]
            if len(candidatas) == 1:
                return candidatas[0]
            if candidatas:
                raise Ambigua(texto, [p["nombre"] for p in candidatas[:5]])
        parecidas = sorted(
            ((SequenceMatcher(None, q, nombres[p["clave"]]).ratio(), p) for p in ps),
            key=lambda x: -x[0],
        )
        if parecidas and parecidas[0][0] >= 0.75 and (
            len(parecidas) == 1 or parecidas[0][0] - parecidas[1][0] > 0.08
        ):
            return parecidas[0][1]
        raise Ambigua(texto, [p["nombre"] for r, p in parecidas[:5] if r >= 0.5])

    def fuente(self, p: dict[str, Any]) -> Fuente:
        f = self.fuentes.get(p["clave"])
        if f is None:
            raise ValueError(f"{p['nombre']} no esta disponible como fuente del simulador")
        return f

    def ejecutar(self, llamada: dict[str, Any]) -> str:
        """Corre una herramienta y devuelve el JSON que lee el modelo."""
        nombre = llamada.get("nombre", "")
        definicion = POR_NOMBRE.get(nombre)
        try:
            if definicion is None:
                raise ValueError(f"No existe la herramienta {nombre}")
            permitidos = definicion.parametros.get("properties", {})
            argumentos = {k: v for k, v in (llamada.get("argumentos") or {}).items() if k in permitidos}
            r = FUNCIONES[nombre](self, **argumentos)
        except Ambigua as exc:
            r = Resultado({"error": str(exc), "candidatas": exc.candidatas}, str(exc), ok=False)
        except (TypeError, ValueError, KeyError) as exc:
            r = Resultado({"error": str(exc)}, f"No pudo completarse: {exc}", ok=False)
        except Exception as exc:                        # noqa: BLE001
            r = Resultado({"error": f"{type(exc).__name__}: {exc}"}, "Fallo interno al ejecutar la herramienta", ok=False)
        self.resultados[str(llamada.get("id", ""))] = r
        return json.dumps(r.datos, ensure_ascii=False, default=str)


# --------------------------------------------------------------------------
# Las herramientas
# --------------------------------------------------------------------------

def buscar_empresas(mesa: Mesa, texto: str = "", solo_viables: bool = False, limite: int = 8) -> Resultado:
    texto = str(texto or "").strip()[:200]
    limite = max(1, min(int(limite or 8), MAX_RESULTADOS))
    ps = mesa.prospectos
    if texto:
        q = sin_tildes(texto).lower()
        palabras = [w for w in re.split(r"\W+", q) if len(w) > 2] or [q]

        def contenido(p: dict[str, Any]) -> str:
            return sin_tildes(f"{p['nombre']} {p['sector']} {p['corriente']}").lower()

        ps = [p for p in ps if all(w in contenido(p) for w in palabras)] or [
            p for p in ps if any(w in contenido(p) for w in palabras)
        ]
    if solo_viables:
        ps = [p for p in ps if (p.get("puntaje") or 0) > 0]
    total = len(ps)
    ps = sorted(ps, key=lambda p: -(p.get("puntaje") or 0))[:limite]
    paso = (
        f"Buscó «{texto}» entre los vecinos · {total} resultado{'s' if total != 1 else ''}"
        if texto else f"Repasó los {len(ps)} vecinos con mejor puntaje"
    )
    return Resultado(
        {"total": total, "empresas": [asistente._prospecto_compacto(p) for p in ps]},
        paso,
        detalle=[
            [p["nombre"], f"{_n(p.get('puntaje'), 0)} pts · {_n(p['caudal_m3_h'])} m³/h · {_n(p['distancia_conduccion_km'])} km"]
            for p in ps[:6]
        ],
    )


def ver_empresa(mesa: Mesa, empresa: str) -> Resultado:
    p = mesa.empresa(empresa)
    breve = asistente._prospecto_breve(p)
    documentos = asistente.documentos_de(p, api_scout.EXPEDIENTES)
    return Resultado(
        {**breve, "documentos": documentos},
        f"Leyó la ficha de {p['nombre']}",
        detalle=[
            ["Agua", f"{p['corriente']} · {_n(p['caudal_m3_h'])} m³/h ({p['metodo_caudal']})"],
            ["Calidad", f"{p['metodo_calidad']} · confianza {p['confianza_etiqueta']}"],
            ["Distancia", f"{_n(p['distancia_conduccion_km'])} km de tubería"],
            ["Puntaje", f"{_n(p.get('puntaje'), 0)} de 100 · limita {p['limitante'] or '—'}"],
            ["Expedientes", f"{len(breve['expedientes_vital'])} en VITAL · {len(documentos)} documentos guardados"],
        ],
    )


def _resumen_simulacion(r: dict[str, Any]) -> dict[str, Any]:
    return {
        "alcance": "prefactibilidad en regimen con los datos de planta de referencia",
        "factible": r["factible"], "motivo": r["motivo"], "cumple_meta": r["cumple_meta"],
        "meta_reduccion": r["meta"],
        "ciclos": r["ciclos"], "ciclos_hoy": r["base"]["ciclos"],
        "limitante": r["limitante_texto"],
        "agua_cruda_m3_h": r["agua_cruda_m3_h"], "agua_cruda_hoy_m3_h": r["base"]["reposicion_m3_h"],
        "reuso_m3_h": r["reuso_m3_h"],
        "ahorro_pct_planta": r["ahorro_pct"], "ahorro_m3_dia": r["ahorro_m3_dia"],
        "ahorro_usd_anio": r["ahorro_usd_anio"], "capex_usd": r["capex_usd"],
        "payback_anios": r["payback_anios"],
        "avisos": r["avisos"],
        "tomas": [
            {"empresa": t["nombre"], "tren": t["tren"], "tren_nombre": t["tren_nombre"],
             "caudal_m3_h": t["caudal_m3_h"], "maximo_m3_h": t["maximo_producto_m3_h"],
             "admisible": t["admisible"], "motivo": t["motivo"], "excede": t["excede"],
             "costo_usd_m3": t["costo_usd_m3"]}
            for t in r["tomas"]
        ],
    }


def _detalle_simulacion(s: dict[str, Any]) -> list[list[str]]:
    detalle = [
        ["Ahorro", f"{_pct(s['ahorro_pct_planta'])} del agua de la planta · {_n(s['ahorro_usd_anio'], 0)} USD/año"],
        ["Ciclos", f"{_n(s['ciclos'])} (hoy {_n(s['ciclos_hoy'])})"],
        ["Agua cruda", f"{_n(s['agua_cruda_m3_h'])} m³/h (hoy {_n(s['agua_cruda_hoy_m3_h'])})"],
    ]
    if s["limitante"]:
        detalle.append(["Limita", s["limitante"]])
    if s["capex_usd"]:
        retorno = f" · retorno {_n(s['payback_anios'])} años" if s["payback_anios"] else ""
        detalle.append(["Inversión", f"{_n(s['capex_usd'], 0)} USD{retorno}"])
    detalle += [["Aviso", a] for a in s["avisos"]]
    return detalle


def _nombres(tomas: list[dict[str, Any]]) -> str:
    if len(tomas) > 2:
        return f"{len(tomas)} vecinos"
    return " y ".join(f"{t['empresa']} ({_n(t['caudal_m3_h'])} m³/h)" for t in tomas)


def _cifras(s: dict[str, Any]) -> str:
    if s["avisos"]:
        # El aviso empieza por el nombre de la empresa, que el paso ya dice.
        return f"con avisos: {_corto(s['avisos'][0].split(': ', 1)[-1], 110)}"
    if not s["factible"]:
        return f"no es viable: {_corto(s['motivo'])}"
    return f"{_pct(s['ahorro_pct_planta'])} de ahorro a {_n(s['ciclos'])} ciclos"


def simular_mezcla(mesa: Mesa, tomas: list[dict[str, Any]], acido_mg_l: float = 0.0) -> Resultado:
    if not tomas:
        raise ValueError("Indica al menos una empresa con su caudal")
    if len(tomas) > MAX_TOMAS:
        raise ValueError(f"Como mucho {MAX_TOMAS} empresas por simulacion")
    lista = []
    for t in tomas:
        if not isinstance(t, dict):
            raise ValueError("Cada toma es {empresa, caudal_m3_h, tren}")
        fuente = mesa.fuente(mesa.empresa(t.get("empresa")))
        tren = str(t.get("tren") or fuente.tren_sugerido or "T1").strip().upper()
        if tren not in TRENES_POR_CODIGO:
            raise ValueError(f"Tren desconocido: {tren}")
        if t.get("caudal_m3_h") is None:
            raise ValueError(f"Falta el caudal de {fuente.nombre}")
        caudal = float(t["caudal_m3_h"])
        if not 0 <= caudal <= MAX_CAUDAL_M3_H:
            raise ValueError(f"Caudal fuera de rango: {caudal}")
        lista.append(Toma(fuente, caudal, tren))
    acido = float(acido_mg_l or 0.0)
    if not 0 <= acido <= MAX_ACIDO_MG_L:
        raise ValueError(f"Dosis de acido fuera de rango: {acido}")
    s = _resumen_simulacion(simular(mesa.escenario, Decision(tuple(lista), acido)).as_dict())
    return Resultado(
        s, f"Simuló la torre con {_nombres(s['tomas'])} · {_cifras(s)}",
        detalle=_detalle_simulacion(s),
    )


def sugerir_mezcla(mesa: Mesa, empresas: list[str] | None = None) -> Resultado:
    if empresas:
        fuentes = [mesa.fuente(mesa.empresa(e)) for e in empresas[: MAX_TOMAS * 2]]
    else:
        fuentes = list(mesa.fuentes.values())
    if not fuentes:
        raise ValueError("No hay vecinos en el barrido para optimizar")
    sug = sugerir(mesa.escenario, fuentes)
    if sug.decision is None:
        return Resultado(
            {"modo": "inviable", "motivo": sug.motivo},
            f"Pidió la mezcla al optimizador · ninguna combinación cumple: {_corto(sug.motivo)}",
        )
    s = _resumen_simulacion(simular(mesa.escenario, sug.decision).as_dict())
    mesa.mezcla_sugerida = [
        {"id": t.fuente.id, "caudal_m3_h": round(t.caudal_m3_h, 2), "tren": t.tren} for t in sug.decision.tomas
    ]
    mesa.nombres_sugeridos = [t.fuente.nombre for t in sug.decision.tomas]
    tomas = [
        {"empresa": t.fuente.nombre, "caudal_m3_h": t.caudal_m3_h, "tren": t.tren,
         "tren_nombre": TRENES_POR_CODIGO[t.tren].nombre}
        for t in sug.decision.tomas
    ]
    return Resultado(
        {
            "modo": sug.modo,
            "modo_significa": (
                "la mezcla mas barata que cumple la meta" if sug.modo == "meta"
                else "la meta no se alcanza con estas fuentes: es la mezcla mas barata posible"
            ),
            "motivo": sug.motivo, "acido_mg_l": sug.decision.acido_mg_l, "tomas": tomas,
            "resultado": s,
        },
        f"Pidió la mezcla al optimizador · {_nombres(tomas)}, {_cifras(s)}",
        detalle=[[t["empresa"], f"{_n(t['caudal_m3_h'])} m³/h · {t['tren']} {t['tren_nombre']}"] for t in tomas]
        + _detalle_simulacion(s),
    )


def prefactibilidad(mesa: Mesa) -> Resultado:
    k = mesa.kpis
    if not k:
        raise ValueError("La prefactibilidad no esta disponible ahora")
    if not k.get("factible"):
        return Resultado(k, f"Consultó la prefactibilidad · sin solución factible: {_corto(k.get('motivo', ''))}")
    return Resultado(
        k,
        f"Consultó la prefactibilidad · {_pct(k['ahorro_pct'])} de ahorro, retorno de {_n(k['payback_anios'])} años",
        detalle=[
            ["Ahorro", f"{_n(k['ahorro_m3_dia'], 0)} m³/día · {_n(k['ahorro_economico_usd_anio'], 0)} USD/año"],
            ["Inversión", f"{_n(k['capex_usd'], 0)} USD"],
            ["Ciclos", f"{_n(k['ciclos_optimo'])} (hoy {_n(k['ciclos_base'])})"],
            ["Mezcla", ", ".join(e["empresa"] for e in k.get("empresas_en_mezcla", [])) or "—"],
        ],
    )


PANTALLAS = {
    "vecinos": ("#prospeccion", "Vecinos"),
    "inicio": ("#inicio", "el inicio del panel"),
    "criterios": ("#modelo", "los criterios técnicos"),
}


def abrir_en_panel(
    mesa: Mesa, destino: str, empresa: str = "", tomas: list[dict[str, Any]] | None = None,
) -> Resultado:
    destino = str(destino or "").strip().lower()
    if destino == "empresa":
        p = mesa.empresa(empresa)
        return Resultado(
            {"abierto": f"ficha de {p['nombre']} en Vecinos"},
            f"Abrió la ficha de {p['nombre']} en Vecinos",
            accion={"tipo": "navegar", "hash": f"#prospeccion?empresa={p['clave']}"},
        )
    if destino == "gemelo":
        pedidas = list(tomas or []) or ([{"empresa": empresa}] if empresa else [])
        if not pedidas and mesa.mezcla_sugerida:
            # "Abremela": sin empresas, la mezcla que se acaba de sugerir.
            texto = f"el gemelo con la mezcla sugerida ({', '.join(mesa.nombres_sugeridos)})"
            return Resultado(
                {"abierto": texto}, f"Abrió {texto}",
                accion={"tipo": "gemelo", "tomas": list(mesa.mezcla_sugerida)},
            )
        cargar, nombres = [], []
        for t in pedidas[:MAX_TOMAS]:
            if not isinstance(t, dict):
                raise ValueError("Cada toma es {empresa, caudal_m3_h, tren}")
            p = mesa.empresa(t.get("empresa"))
            item: dict[str, Any] = {"id": p["clave"]}
            if t.get("caudal_m3_h") is not None:
                caudal = float(t["caudal_m3_h"])
                if not 0 <= caudal <= MAX_CAUDAL_M3_H:
                    raise ValueError(f"Caudal fuera de rango: {caudal}")
                item["caudal_m3_h"] = round(caudal, 2)
            if t.get("tren"):
                tren = str(t["tren"]).strip().upper()
                if tren not in TRENES_POR_CODIGO:
                    raise ValueError(f"Tren desconocido: {tren}")
                item["tren"] = tren
            cargar.append(item)
            nombres.append(p["nombre"])
        texto = "el gemelo" + (f" con {', '.join(nombres)}" if nombres else "")
        return Resultado({"abierto": texto}, f"Abrió {texto}", accion={"tipo": "gemelo", "tomas": cargar})
    if destino in PANTALLAS:
        ruta, nombre = PANTALLAS[destino]
        return Resultado({"abierto": nombre}, f"Abrió {nombre}", accion={"tipo": "navegar", "hash": ruta})
    raise ValueError(f"Destino desconocido: {destino}")


# --------------------------------------------------------------------------
# Definiciones para el modelo
# --------------------------------------------------------------------------

_EMPRESA = {"type": "string", "description": "Nombre de la empresa tal como aparece en los datos"}
_TREN = {
    "type": "string",
    "description": "Codigo del tratamiento; si se omite, el sugerido para esa corriente. "
    + "; ".join(f"{t.codigo}: {t.nombre}" for t in TRENES),
}

DEFINICIONES: tuple[Herramienta, ...] = (
    Herramienta(
        "buscar_empresas",
        "Busca vecinos del barrido por nombre, sector o tipo de agua y los ordena por puntaje de "
        "simbiosis. Sin texto, devuelve los de mayor puntaje.",
        {"type": "object", "properties": {
            "texto": {"type": "string", "description": "Nombre, sector o tipo de agua; vacio para listar los mejores"},
            "solo_viables": {"type": "boolean", "description": "Solo los que tienen puntaje mayor que cero"},
            "limite": {"type": "integer", "minimum": 1, "maximum": MAX_RESULTADOS},
        }},
    ),
    Herramienta(
        "ver_empresa",
        "Ficha completa de una empresa: agua y su procedencia, puntaje por componentes, expedientes "
        "de VITAL, etapa comercial y resumenes de sus documentos guardados.",
        {"type": "object", "properties": {"empresa": _EMPRESA}, "required": ["empresa"]},
    ),
    Herramienta(
        "simular_mezcla",
        "Simula la torre en regimen con el agua de uno o varios vecinos: ciclos alcanzables, limite "
        "que manda, agua cruda, ahorro, costo, inversion y avisos de capacidad, tratamiento o "
        "temperatura. Usa los datos de planta de referencia.",
        {"type": "object", "properties": {
            "tomas": {"type": "array", "maxItems": MAX_TOMAS, "items": {
                "type": "object", "properties": {
                    "empresa": _EMPRESA,
                    "caudal_m3_h": {"type": "number", "description": "Agua tratada que entra a la torre, m3/h"},
                    "tren": _TREN,
                }, "required": ["empresa", "caudal_m3_h"],
            }},
            "acido_mg_l": {"type": "number", "description": "H2SO4 dosificado sobre la reposicion, mg/L (0 si no se indica)"},
        }, "required": ["tomas"]},
    ),
    Herramienta(
        "sugerir_mezcla",
        "Pide al optimizador la mezcla mas barata que cumple la meta de ahorro, con todos los "
        "vecinos del barrido o solo con los indicados. Devuelve caudales, trenes y su simulacion.",
        {"type": "object", "properties": {
            "empresas": {"type": "array", "items": _EMPRESA, "description": "Limitar a estas empresas; vacio para usar todas"},
        }},
    ),
    Herramienta(
        "prefactibilidad",
        "Resultado global de prefactibilidad con el catalogo prospectado: ahorro de agua y de "
        "dinero, inversion, retorno, ciclos y empresas en la mezcla.",
        {"type": "object", "properties": {}},
    ),
    Herramienta(
        "abrir_en_panel",
        "Abre una pantalla del panel en el navegador del usuario: la ficha de una empresa en "
        "Vecinos, el gemelo de la torre con unas empresas (y si se quiere, sus caudales y trenes) "
        "ya cargadas, la lista de vecinos, el inicio o los criterios tecnicos. Con destino gemelo "
        "y sin empresas, carga la mezcla que acabas de pedir con sugerir_mezcla. Solo cuando el "
        "usuario pide ver, abrir o ir a algo.",
        {"type": "object", "properties": {
            "destino": {"type": "string", "enum": ["empresa", "gemelo", "vecinos", "inicio", "criterios"]},
            "empresa": _EMPRESA,
            "tomas": {"type": "array", "maxItems": MAX_TOMAS, "items": {
                "type": "object", "properties": {
                    "empresa": _EMPRESA,
                    "caudal_m3_h": {"type": "number"},
                    "tren": _TREN,
                }, "required": ["empresa"],
            }},
        }, "required": ["destino"]},
    ),
)

POR_NOMBRE = {h.nombre: h for h in DEFINICIONES}

FUNCIONES: dict[str, Callable[..., Resultado]] = {
    "buscar_empresas": buscar_empresas,
    "ver_empresa": ver_empresa,
    "simular_mezcla": simular_mezcla,
    "sugerir_mezcla": sugerir_mezcla,
    "prefactibilidad": prefactibilidad,
    "abrir_en_panel": abrir_en_panel,
}


def anuncio(nombre: str, argumentos: dict[str, Any]) -> str:
    """Lo que se ve en el chat mientras la herramienta trabaja."""
    if nombre == "buscar_empresas":
        texto = str(argumentos.get("texto") or "").strip()[:60]
        return f"Buscando «{texto}» entre los vecinos…" if texto else "Repasando los vecinos…"
    if nombre == "ver_empresa":
        return f"Leyendo la ficha de {str(argumentos.get('empresa') or '')[:60]}…"
    return {
        "simular_mezcla": "Simulando la torre…",
        "sugerir_mezcla": "Consultando al optimizador…",
        "prefactibilidad": "Consultando la prefactibilidad…",
        "abrir_en_panel": "Abriendo el panel…",
    }.get(nombre, "Trabajando…")
