"""Herramientas del asistente y su bucle con el proveedor (sin red)."""

from __future__ import annotations

import json
import sys
import types

import pytest

from simbia import ia
from simbia.api import herramientas as h
from simbia.domain.streams import CATALOGO_POR_CODIGO
from simbia.simulador import Fuente


def _prospecto(clave: str, codigo: str, nombre: str, puntaje: float, sector: str = "Industria") -> dict:
    o = CATALOGO_POR_CODIGO[codigo]
    return {
        "clave": clave, "nombre": nombre, "sector": sector, "corriente": o.corriente,
        "caudal_m3_h": o.caudal_disponible_m3_h, "distancia_conduccion_km": o.distancia_km,
        "puntaje": puntaje, "detalle_puntaje": {}, "confianza": 0.6, "confianza_etiqueta": "media",
        "metodo_calidad": "inferido", "metodo_caudal": "inferido", "campos_medidos": [],
        "limitante": "TDS", "notas": "", "calidad": {"tds": o.calidad.tds}, "indices": {},
        "referencias": [], "ficha": None,
    }


@pytest.fixture
def mesa():
    m = h.Mesa(8.0, {"factible": True, "ahorro_pct": 0.38, "payback_anios": 1.1, "ahorro_m3_dia": 1100,
                     "ahorro_economico_usd_anio": 450_000, "capex_usd": 500_000, "ciclos_optimo": 6.4,
                     "ciclos_base": 3.2, "empresas_en_mezcla": [{"empresa": "Plasticos Norte", "aporte_m3_h": 20}]})
    ps = [
        _prospecto("a1", "V6", "Plasticos Norte S.A.", 60, "Transformacion de plasticos"),
        _prospecto("b2", "V4", "Alimentos del Caribe", 40, "Alimentos"),
        _prospecto("c3", "V2", "Termica Mamonal", 30, "Energia"),
        _prospecto("d4", "V1", "Plasticos Sur", 10, "Transformacion de plasticos"),
    ]
    m.prospectos = ps
    codigos = {"a1": "V6", "b2": "V4", "c3": "V2", "d4": "V1"}
    m.fuentes = {
        p["clave"]: Fuente(p["clave"], p["nombre"], CATALOGO_POR_CODIGO[codigos[p["clave"]]].calidad,
                           p["caudal_m3_h"], p["distancia_conduccion_km"], 0.0, tren_sugerido="T1")
        for p in ps
    }
    return m


def _correr(mesa, nombre, **argumentos):
    salida = mesa.ejecutar({"id": nombre, "nombre": nombre, "argumentos": argumentos})
    return mesa.resultados[nombre], json.loads(salida)


def test_la_empresa_se_encuentra_por_nombre_parcial_o_clave(mesa):
    assert mesa.empresa("plasticos norte")["clave"] == "a1"
    assert mesa.empresa("Alimentos")["clave"] == "b2"
    assert mesa.empresa("c3")["nombre"] == "Termica Mamonal"
    with pytest.raises(h.Ambigua) as exc:
        mesa.empresa("Plasticos")
    assert set(exc.value.candidatas) == {"Plasticos Norte S.A.", "Plasticos Sur"}
    with pytest.raises(h.Ambigua):
        mesa.empresa("Naviera Inventada")


def test_buscar_ordena_por_puntaje_y_filtra(mesa):
    r, datos = _correr(mesa, "buscar_empresas", texto="plásticos")
    assert r.ok and datos["total"] == 2
    assert [e["empresa"] for e in datos["empresas"]] == ["Plasticos Norte S.A.", "Plasticos Sur"]
    assert "Buscó «plásticos»" in r.paso and r.detalle[0][0] == "Plasticos Norte S.A."
    r, datos = _correr(mesa, "buscar_empresas", limite=2)
    assert [e["empresa"] for e in datos["empresas"]] == ["Plasticos Norte S.A.", "Alimentos del Caribe"]


def test_simular_una_mezcla_devuelve_cifras_y_paso(mesa):
    r, datos = _correr(mesa, "simular_mezcla", tomas=[{"empresa": "Plasticos Norte", "caudal_m3_h": 15}])
    assert r.ok and datos["factible"] and datos["ahorro_pct_planta"] > 0
    assert datos["tomas"][0]["empresa"] == "Plasticos Norte S.A." and datos["tomas"][0]["tren"] == "T1"
    assert "Simuló la torre con Plasticos Norte S.A. (15,0 m³/h)" in r.paso and "de ahorro" in r.paso
    assert any(e == "Ahorro" for e, _ in r.detalle)


def test_simular_avisa_de_un_tren_que_no_basta(mesa):
    r, datos = _correr(mesa, "simular_mezcla", tomas=[{"empresa": "Termica", "caudal_m3_h": 5, "tren": "t1"}])
    assert r.ok and not datos["factible"] and datos["avisos"]
    assert "con avisos" in r.paso and "enfriamiento" in r.paso


@pytest.mark.parametrize("tomas, error", [
    ([{"empresa": "Plasticos Norte"}], "Falta el caudal"),
    ([{"empresa": "Plasticos Norte", "caudal_m3_h": 5, "tren": "T99"}], "Tren desconocido"),
    ([{"empresa": "Plasticos", "caudal_m3_h": 5}], "puede ser"),
    ([], "al menos una empresa"),
])
def test_simular_con_datos_malos_falla_con_motivo(mesa, tomas, error):
    r, datos = _correr(mesa, "simular_mezcla", tomas=tomas)
    assert not r.ok and error in datos["error"]


def test_abrir_en_panel_arma_la_accion_en_el_servidor(mesa):
    r, _ = _correr(mesa, "abrir_en_panel", destino="empresa", empresa="Alimentos")
    assert r.accion == {"tipo": "navegar", "hash": "#prospeccion?empresa=b2"}
    r, _ = _correr(mesa, "abrir_en_panel", destino="gemelo",
                   tomas=[{"empresa": "Plasticos Norte", "caudal_m3_h": 12.345, "tren": "t2"}, {"empresa": "Termica"}])
    assert r.accion == {"tipo": "gemelo", "tomas": [{"id": "a1", "caudal_m3_h": 12.35, "tren": "T2"}, {"id": "c3"}]}
    assert r.paso == "Abrió el gemelo con Plasticos Norte S.A., Termica Mamonal"
    r, _ = _correr(mesa, "abrir_en_panel", destino="criterios")
    assert r.accion == {"tipo": "navegar", "hash": "#modelo"}
    r, datos = _correr(mesa, "abrir_en_panel", destino="javascript:alert(1)")
    assert not r.ok and r.accion is None and "Destino desconocido" in datos["error"]


def test_abrir_el_gemelo_sin_empresas_carga_la_mezcla_sugerida(mesa):
    r, _ = _correr(mesa, "abrir_en_panel", destino="gemelo")
    assert r.accion == {"tipo": "gemelo", "tomas": []}        # sin sugerencia: el gemelo tal cual
    r, datos = _correr(mesa, "sugerir_mezcla")
    assert r.ok and datos["tomas"]
    r, _ = _correr(mesa, "abrir_en_panel", destino="gemelo")
    sugeridas = {t["empresa"] for t in datos["tomas"]}
    assert {t["id"] for t in r.accion["tomas"]} == {p["clave"] for p in mesa.prospectos if p["nombre"] in sugeridas}
    assert all(t["caudal_m3_h"] > 0 and t["tren"] for t in r.accion["tomas"])
    assert r.paso.startswith("Abrió el gemelo con la mezcla sugerida (")


def test_prefactibilidad_y_herramienta_desconocida(mesa):
    r, datos = _correr(mesa, "prefactibilidad")
    assert r.ok and datos["ahorro_pct"] == 0.38 and "38,0 %" in r.paso
    r, datos = _correr(mesa, "borrar_todo")
    assert not r.ok and "No existe" in datos["error"]


def test_los_argumentos_que_no_estan_en_el_esquema_se_ignoran(mesa):
    r, _ = _correr(mesa, "ver_empresa", empresa="Alimentos", ruta="/etc/passwd")
    assert r.ok and r.paso == "Leyó la ficha de Alimentos del Caribe"


def test_las_definiciones_casan_con_las_funciones():
    assert set(h.POR_NOMBRE) == set(h.FUNCIONES)
    for d in h.DEFINICIONES:
        assert d.parametros["type"] == "object" and d.descripcion
    assert h.anuncio("ver_empresa", {"empresa": "Lamitech"}) == "Leyendo la ficha de Lamitech…"


# -- bucle con el proveedor -----------------------------------------------------------

def _ev(tipo, **campos):
    return types.SimpleNamespace(type=tipo, **campos)


def test_openai_ejecuta_la_herramienta_y_encadena_la_respuesta(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-prueba")
    monkeypatch.delenv("SIMBIA_IA_MODELO", raising=False)
    llamadas_api = []
    rondas = [
        [_ev("response.output_text.delta", delta="Miro. "),
         _ev("response.output_item.done", item=types.SimpleNamespace(
             type="function_call", call_id="c1", name="buscar_empresas", arguments='{"texto": "pl"}')),
         _ev("response.completed", response=types.SimpleNamespace(id="r1", usage=types.SimpleNamespace(total_tokens=50)))],
        [_ev("response.output_text.delta", delta="Listo."),
         _ev("response.completed", response=types.SimpleNamespace(id="r2", usage=types.SimpleNamespace(total_tokens=30)))],
    ]

    class Respuestas:
        def create(self, **kw):
            llamadas_api.append(kw)
            return iter(rondas[len(llamadas_api) - 1])

    class Cliente:
        def __init__(self, *a, **k): self.responses = Respuestas()

    import openai
    monkeypatch.setattr(openai, "OpenAI", Cliente)
    ejecutadas = []
    eventos = list(ia.conversar_con_herramientas(
        "instr", [{"rol": "usuario", "contenido": "hola"}], h.DEFINICIONES,
        lambda ll: ejecutadas.append(ll) or '{"total": 0}',
    ))
    assert [t for t, _ in eventos] == ["texto", "ronda", "llamada", "resultado", "texto", "ronda"]
    assert ejecutadas == [{"id": "c1", "nombre": "buscar_empresas", "argumentos": {"texto": "pl"}}]
    primera, segunda = llamadas_api
    assert primera["tool_choice"] == "auto" and "previous_response_id" not in primera
    assert primera["parallel_tool_calls"] is False
    assert {t["name"] for t in primera["tools"]} == set(h.POR_NOMBRE)
    assert segunda["previous_response_id"] == "r1"
    assert segunda["input"] == [{"type": "function_call_output", "call_id": "c1", "output": '{"total": 0}'}]
    assert eventos[1][1]["tokens"] == 50 and eventos[-1][1]["n"] == 2


def test_en_la_ultima_ronda_ya_no_se_ofrecen_herramientas(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-prueba")
    capturado = {}

    class Respuestas:
        def create(self, **kw):
            capturado.update(kw)
            return iter([_ev("response.completed", response=types.SimpleNamespace(id="r", usage=None))])

    import openai
    monkeypatch.setattr(openai, "OpenAI", lambda *a, **k: types.SimpleNamespace(responses=Respuestas()))
    list(ia.conversar_con_herramientas("i", [{"rol": "usuario", "contenido": "x"}], h.DEFINICIONES,
                                       lambda ll: "{}", max_rondas=1))
    assert capturado["tool_choice"] == "none"


def test_anthropic_ejecuta_la_herramienta_y_devuelve_el_resultado(monkeypatch):
    for v in ("OPENAI_API_KEY",):
        monkeypatch.delenv(v, raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "prueba")
    historias = []
    finales = [
        types.SimpleNamespace(content=[
            types.SimpleNamespace(type="text", text="Busco."),
            types.SimpleNamespace(type="tool_use", id="t1", name="ver_empresa", input={"empresa": "Alfa"}),
        ], usage=types.SimpleNamespace(input_tokens=10, output_tokens=5)),
        types.SimpleNamespace(content=[types.SimpleNamespace(type="text", text="Hecho.")],
                              usage=types.SimpleNamespace(input_tokens=20, output_tokens=4)),
    ]

    class Flujo:
        def __init__(self, n, kw): self.n, self.kw = n, kw
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def __iter__(self):
            texto = finales[self.n].content[0].text
            return iter([_ev("content_block_delta", delta=types.SimpleNamespace(type="text_delta", text=texto))])
        def get_final_message(self): return finales[self.n]

    elecciones = []

    class Mensajes:
        def stream(self, **kw):
            historias.append([dict(m) for m in kw["messages"]])
            elecciones.append(kw["tool_choice"])
            return Flujo(len(historias) - 1, kw)

    falso = types.ModuleType("anthropic")
    falso.Anthropic = lambda *a, **k: types.SimpleNamespace(messages=Mensajes())
    monkeypatch.setitem(sys.modules, "anthropic", falso)
    eventos = list(ia.conversar_con_herramientas(
        "instr", [{"rol": "usuario", "contenido": "hola"}], h.DEFINICIONES, lambda ll: '{"ok": true}',
    ))
    assert [d["delta"] for t, d in eventos if t == "texto"] == ["Busco.", "Hecho."]
    assert [t for t, _ in eventos if t != "texto"] == ["ronda", "llamada", "resultado", "ronda"]
    ultima = historias[1][-1]
    assert ultima["role"] == "user" and ultima["content"] == [
        {"type": "tool_result", "tool_use_id": "t1", "content": '{"ok": true}'}]
    assert elecciones[0] == {"type": "auto", "disable_parallel_tool_use": True}
