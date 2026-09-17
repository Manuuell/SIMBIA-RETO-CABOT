"""Analisis de documentos y lote de expedientes, sin red ni modelo."""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from simbia import ia
from simbia.main import app
from simbia.scout import analisis, documentos, lote
from simbia.scout.perfil import Referencia


def _analisis(**kw) -> analisis.AnalisisDocumento:
    base = dict(
        tipo_documento="caracterizacion", titulo="Informe", resumen="R", puntos_clave=["a"],
        razon_social="MEXICHEM RESINAS COLOMBIA S.A.S.", nit="", expediente="COR-00091-26", autoridad="CARDIQUE",
        resoluciones=["Resolucion 0252 de 2022"], vigencia_hasta="2027-03-17", cuerpo_receptor="Mar Caribe",
        caudal_autorizado_l_s=7.5, caudal_medido_l_s=0.28, laboratorio="Lab SAS", numero_informe="OT-13996-1",
        acreditado_ideam=True, fecha_muestreo="2025-12-01", muestras=3, puntos_muestreo=["Efluente 1", "Torre"],
        parametros=[
            analisis.ParametroLeido(nombre="DQO", valor=135.9, unidad="mg/L", punto="Efluente 1", fecha="2025-12-01"),
            analisis.ParametroLeido(nombre="DQO", valor=40.0, unidad="mg/L", punto="Torre", fecha="2025-12-01"),
            analisis.ParametroLeido(nombre="pH", valor=7.55, unidad="unidades de pH", punto="Efluente 1", fecha=""),
            analisis.ParametroLeido(nombre="Hierro total", valor=780, unidad="ug/L", punto="Efluente 1", fecha=""),
            analisis.ParametroLeido(nombre="DBO5", valor=63, unidad="mg/L", punto="Efluente 1", fecha=""),
            analisis.ParametroLeido(nombre="Zinc", valor=1.0, unidad="mg/L", punto="Efluente 1", fecha=""),
            analisis.ParametroLeido(nombre="Temperatura", valor=91.4, unidad="F", punto="", fecha=""),
        ],
        confianza=0.9, observaciones="",
    )
    base.update(kw)
    return analisis.AnalisisDocumento(**base)


def test_traducir_reparte_por_punto_y_convierte_unidades():
    t = analisis.traducir(_analisis())
    e1 = t["puntos"]["Efluente 1"]
    assert e1["calidad"]["dqo"] == 135.9 and e1["calidad"]["ph"] == 7.55
    assert e1["calidad"]["hierro"] == 0.78                      # ug/L -> mg/L
    assert e1["informativos"]["dbo5"] == 63 and "Zinc" in e1["no_reconocidos"]
    assert e1["fechas"] == ["2025-12-01"]
    assert t["puntos"]["Torre"]["calidad"]["dqo"] == 40.0
    assert abs(t["puntos"][""]["calidad"]["t_c"] - 33.0) < 0.1  # Fahrenheit -> C
    assert t["caudal_autorizado_m3_h"] == 27.0 and t["caudal_medido_m3_h"] == 1.01
    assert t["es_caracterizacion"]


def test_el_esquema_es_estricto_compatible():
    j = json.dumps(analisis.AnalisisDocumento.model_json_schema())
    assert '"additionalProperties": {' not in j


def test_analizar_documento_cachea_y_normaliza_el_tipo(tmp_path, monkeypatch):
    llamadas = []
    def falso(ruta, instrucciones, peticion, esquema):
        llamadas.append(ruta)
        return _analisis(tipo_documento="lo-que-sea")
    monkeypatch.setattr(ia, "estructurar_pdf", falso)
    pdf = tmp_path / "x.pdf"; pdf.write_bytes(b"%PDF-")
    r = analisis.analizar_documento(pdf)
    assert r["tipo_documento"] == "otro" and r["puntos"]["Efluente 1"]["calidad"]["dqo"] == 135.9
    assert analisis.analizar_documento(pdf) == r and len(llamadas) == 1
    assert analisis.cargar_analisis(pdf)["expediente"] == "COR-00091-26"
    assert analisis.cargar_analisis(tmp_path / "no.pdf") is None


# -- lote ---------------------------------------------------------------------------

class _Prospecto:
    def __init__(self, refs): self.referencias = refs

class _Ficha:
    def __init__(self, exps): self.expedientes = exps


def test_tramites_de_une_cruce_automatico_y_vinculos_manuales():
    url = "https://vital.minambiente.gov.co/x.aspx?NumSilpa=111&Origen=VITAL&TarSolId=22&Solicitante=33&TipoConsulta=Todos"
    p = _Prospecto([
        Referencia(fuente="vital", identificador="A", url=url),
        Referencia(fuente="vital", identificador="B", url="https://vital-publico.minambiente.gov.co/buscador"),   # sin ids
        Referencia(fuente="osm", identificador="way/1"),
    ])
    f = _Ficha([{"radicado": "111", "sol_id": "22", "solicitante_id": "33"}, {"radicado": "222", "sol_id": "5", "solicitante_id": "6", "origen": "SILAMC"}, {"radicado": "333"}])
    ts = lote.tramites_de(p, f)
    assert sorted(t.radicado for t in ts) == ["111", "222"]
    assert next(t for t in ts if t.radicado == "222").origen == "SILAMC"


def test_analizar_empresa_descarga_guarda_y_analiza(tmp_path, monkeypatch):
    t = documentos.Tramite("111", "VITAL", "22", "33")
    det = documentos.Detalle(tramite=t, expediente="E-1", origen_dato="red")
    det.carpetas = [documentos.Carpeta(grupo="lsDocumentosSeguimiento", titulo="S", entrada=0, etiqueta="", fecha="",
                                        archivos=[documentos.Archivo(0, "informe.pdf", "x"), documentos.Archivo(1, "notas.rtf", "y"), documentos.Archivo(2, "grande.pdf", "z")])]
    monkeypatch.setattr(documentos, "detalle", lambda tr, modo=None: det)
    def descarga(tr, grupo, entrada, indice):
        if indice == 2:
            return documentos.Descarga("grande.pdf", b"%PDF-" + b"0" * int(lote.MAX_MB_POR_PDF * 1e6 + 10), "application/pdf")
        return documentos.Descarga("informe.pdf", b"%PDF-informe", "application/pdf")
    monkeypatch.setattr(documentos, "descargar", descarga)
    monkeypatch.setattr(ia, "estructurar_pdf", lambda ruta, i, p, e: _analisis())
    guardados = []
    trabajo = lote.Trabajo(clave="k", nombre="Mexichem")
    lote.analizar_empresa(trabajo, [t], tmp_path / "expedientes", guardados.append)
    assert (tmp_path / "expedientes" / "111" / "informe.pdf").read_bytes() == b"%PDF-informe"
    assert not (tmp_path / "expedientes" / "111" / "grande.pdf").exists()
    assert [g["ruta"] for g in guardados] == ["expedientes/111/informe.pdf"]
    assert trabajo.documentos == 1 and trabajo.analizados == 1
    assert analisis.cargar_analisis(tmp_path / "expedientes" / "111" / "informe.pdf")["laboratorio"] == "Lab SAS"
    textos = " ".join(p["texto"] for p in trabajo.pasos)
    assert "grande.pdf pesa" in textos and "Terminado: 1 documento" in textos
    # Segunda pasada: ni descarga ni analiza de nuevo.
    trabajo2 = lote.Trabajo(clave="k", nombre="Mexichem")
    lote.analizar_empresa(trabajo2, [t], tmp_path / "expedientes", guardados.append)
    assert "ya analizado" in " ".join(p["texto"] for p in trabajo2.pasos)


def test_sin_tramites_el_trabajo_lo_dice(tmp_path):
    trabajo = lote.Trabajo(clave="k", nombre="X")
    lote.analizar_empresa(trabajo, [], tmp_path, lambda d: None)
    assert "Sin tramites" in trabajo.pasos[0]["texto"]


def test_la_cola_corre_los_trabajos_en_orden_y_no_duplica():
    cola = lote.Cola()
    hechos = []
    def tarea(t):
        time.sleep(0.15); t.anotar("hola"); hechos.append(t.clave)
    a = cola.encolar("a", "A", tarea)
    assert cola.encolar("a", "A", tarea) is a        # en cola o en curso: no se duplica
    cola.encolar("b", "B", tarea)
    for _ in range(50):
        if all(t["estado"] == "hecho" for t in cola.estado()): break
        time.sleep(0.05)
    assert hechos == ["a", "b"] and a.estado == "hecho" and a.fin
    def rota(t): raise RuntimeError("boom")
    cola.encolar("c", "C", rota)
    for _ in range(50):
        if cola.trabajo("c").estado == "error": break
        time.sleep(0.05)
    assert "boom" in cola.trabajo("c").pasos[-1]["texto"]


# -- API ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def cliente():
    return TestClient(app)


def test_sin_ia_el_lote_lo_dice(cliente, monkeypatch):
    for v in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(v, raising=False)
    assert cliente.post("/api/scout/expediente/analizar", json={}).status_code == 503
    assert cliente.get("/api/scout/expediente/analizar/estado").json()["activos"] >= 0


def test_el_analisis_de_un_documento_por_api(cliente, tmp_path, monkeypatch):
    from simbia.api import scout as api_scout
    monkeypatch.setenv("OPENAI_API_KEY", "sk-prueba")
    monkeypatch.setattr(api_scout, "EXPEDIENTES", tmp_path / "expedientes")
    (tmp_path / "expedientes" / "1").mkdir(parents=True)
    (tmp_path / "expedientes" / "1" / "a.pdf").write_bytes(b"%PDF-1.4")
    assert cliente.get("/api/scout/expediente/analisis?ruta=expedientes/1/a.pdf").status_code == 404
    monkeypatch.setattr(ia, "estructurar_pdf", lambda ruta, i, p, e: _analisis())
    r = cliente.post("/api/scout/expediente/analisis", json={"ruta": "expedientes/1/a.pdf"})
    assert r.status_code == 200 and r.json()["puntos"]["Efluente 1"]["calidad"]["dqo"] == 135.9
    assert cliente.get("/api/scout/expediente/analisis?ruta=expedientes/1/a.pdf").status_code == 200
    assert cliente.post("/api/scout/expediente/analisis", json={"ruta": "../a.pdf"}).status_code == 404
