"""Documentos del VITAL antiguo: parseo del HTML downlevel, detalle y cache."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from simbia.main import app
from simbia.scout import documentos as doc
from simbia.scout.fuentes import base
from simbia.scout.fuentes.base import Modo

TRAMITE = doc.Tramite(radicado="1070086000727726002", origen="VITAL", sol_id="408910", solicitante_id="23190")

#: Tal como lo sirve el servidor a un cliente que no es navegador.
HTML_DOWNLEVEL = """
<table class="grilla" id="ctl00_ContentPlaceHolder1_grdVerDocumentos" width="100%">
<tr bgcolor="#BDBE9A"><th scope="col"><font color="White"><b>Nombre Archivo</b></font></th><th scope="col"><font><b>&nbsp;</b></font></th></tr>
<tr valign="middle" bgcolor="#F7F6F3">
<td width="80%"><font face="Arial" color="#333333" size="2">-699880203_32_Solicitud Renovacion PVL y Caracterizacion Emulsi&#243;n_20260512090534.pdf</font></td><td><font size="2">
<a id="ctl00_ContentPlaceHolder1_grdVerDocumentos_ctl03_lnkDescargar" href="javascript:__doPostBack(&#39;ctl00$ContentPlaceHolder1$grdVerDocumentos$ctl03$lnkDescargar&#39;,&#39;&#39;)">Descargar</a>
</font></td></tr>
<tr valign="middle" bgcolor="White">
<td width="80%"><font size="2">AcuseRecibido_1070086000727726002.pdf</font></td><td><font size="2">
<a id="ctl00_ContentPlaceHolder1_grdVerDocumentos_ctl04_lnkDescargar" href="javascript:__doPostBack(&#39;ctl00$ContentPlaceHolder1$grdVerDocumentos$ctl04$lnkDescargar&#39;,&#39;&#39;)">Descargar</a>
</font></td></tr>
</table>
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="abc&#43;def" />
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="xyz" />
"""

#: Y tal como lo ve Chrome.
HTML_NAVEGADOR = """
<tr><td style="width:80%;">425091.rtf</td><td>
<a id="ctl00_ContentPlaceHolder1_grdVerDocumentos_ctl05_lnkDescargar" href="javascript:__doPostBack('ctl00$ContentPlaceHolder1$grdVerDocumentos$ctl05$lnkDescargar','')">Descargar</a>
</td></tr>
"""

DETALLE = {
    "lblnumeroExpediente": "1070086000727726002", "lblSolicitante": "MEXICHEM RESINAS COLOMBIA S.A.",
    "lblCodigoExpediente": " -- COR-00091-26", "lblTramite": "348_VITAL_VERTIMIENTO_CUERPO_A",
    "lblAutoridadAmbiental": "CARDIQUE", "lblNombreProyectoValue": "", "lblUbicacion": "-", "lblSector": "None",
    "lstResumenEstado": {"resumenTramite": [
        {"date": "Radicar Solicitud", "content": "<span class='TareaEjecutada'>Tarea ejecutada</span>"},
        {"date": "Auto de Inicio", "content": "<span class='TareaPendiente'>Tarea pendiente</span>"},
    ]},
    "lsDocumentosSeguimiento": [{"lblDocumento": "348_VITAL_VERTIMIENTO_CUERPO_A  -  1070086000727726002", "lblSolFechaCreacion": "12/05/2026"}],
    "lsDocumentosEvaluacion": [], "lsDocumentosInvestigacion": [], "lsDocumentosCobros": [],
    "lsDocumentosOtros": [], "lsDocumentosRepocision": [], "lsDocumentosModificacion": [],
}


def test_el_html_downlevel_y_el_del_navegador_se_parsean_igual():
    filas = doc._FILA.findall(HTML_DOWNLEVEL)
    assert [f[1].split("$")[-2] for f in filas] == ["ctl03", "ctl04"]
    import html
    assert html.unescape(filas[0][0]).strip().endswith("Caracterizacion Emulsión_20260512090534.pdf")
    assert doc._FILA.findall(HTML_NAVEGADOR)[0][0].strip() == "425091.rtf"
    ocultos = {k: html.unescape(v) for k, v in doc._OCULTO.findall(HTML_DOWNLEVEL)}
    assert ocultos["__VIEWSTATE"] == "abc+def" and "__EVENTVALIDATION" in ocultos


def test_el_json_aspnet_viene_en_dos_formas():
    assert doc._json_aspnet('[{"a": 1}]') == [{"a": 1}]
    assert doc._json_aspnet('{"d": "[{\\"a\\": 1}]"}') == [{"a": 1}]


def test_el_tipo_se_decide_por_los_bytes_no_por_la_cabecera():
    assert doc._tipo("x.pdf", b"%PDF-1.4...") == "application/pdf"
    assert doc._tipo("x.pdf", b"{\\rtf1...") == "application/rtf"
    assert doc._tipo("x.docx", b"PK\\x03\\x04") == "application/zip"
    assert doc._tipo("x.xlsx", b"???") == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    assert doc._tipo("x.bin", b"???") == "application/octet-stream"


def test_el_nombre_de_archivo_se_sanea():
    assert doc.nombre_seguro("../../etc/passwd") == ".._.._etc_passwd"
    assert doc.nombre_seguro("Solicitud (v2) - final.pdf") == "Solicitud (v2) - final.pdf"
    assert doc.nombre_seguro("") == "documento"


@pytest.fixture
def cache_temporal(tmp_path, monkeypatch):
    monkeypatch.setattr(base, "CACHE", tmp_path)


def test_el_detalle_interpreta_estado_y_carpetas_y_cachea(cache_temporal, monkeypatch):
    monkeypatch.setattr(doc, "_consultar_detalle_red", lambda t: (DETALLE, {g: DETALLE.get(g) or [] for g, _ in doc.CARPETAS}))
    monkeypatch.setattr(doc, "_listar_archivos", lambda entrada: ([doc.Archivo(0, "Acuse.pdf", "ctl00$x$ctl02$lnkDescargar")], {}))
    d = doc.detalle(TRAMITE, modo=Modo.VIVO)
    assert d.origen_dato == "red" and d.solicitante.startswith("MEXICHEM")
    assert d.expediente == "COR-00091-26" and d.ubicacion == "" and d.sector == ""
    assert d.estado == [{"paso": "Radicar Solicitud", "hecho": True}, {"paso": "Auto de Inicio", "hecho": False}]
    assert len(d.carpetas) == 1 and d.carpetas[0].titulo == "Solicitud y seguimiento"
    assert d.carpetas[0].archivos[0].nombre == "Acuse.pdf" and d.total_archivos == 1
    # Segunda lectura sin red: sale de la cache con todo dentro.
    d2 = doc.detalle(TRAMITE, modo=Modo.OFFLINE)
    assert d2.origen_dato == "cache" and d2.total_archivos == 1
    assert d2.carpetas[0].archivos[0].objetivo == "ctl00$x$ctl02$lnkDescargar"
    assert d2.as_dict()["url_portal"].startswith("https://vital.minambiente.gov.co/")


def test_sin_cache_en_offline_lo_dice_y_si_la_red_falla_tambien(cache_temporal, monkeypatch):
    d = doc.detalle(TRAMITE, modo=Modo.OFFLINE)
    assert d.origen_dato == "sin dato" and "cache" in d.incidencia

    def caida(t):
        raise ConnectionError("sin ruta")
    monkeypatch.setattr(doc, "_consultar_detalle_red", caida)
    d = doc.detalle(TRAMITE, modo=Modo.VIVO)
    assert d.origen_dato == "sin dato" and "ConnectionError" in d.incidencia


def test_una_carpeta_que_no_se_puede_listar_no_tumba_el_detalle(cache_temporal, monkeypatch):
    monkeypatch.setattr(doc, "_consultar_detalle_red", lambda t: (DETALLE, {g: DETALLE.get(g) or [] for g, _ in doc.CARPETAS}))

    def falla(entrada):
        raise ValueError("ERROR: sin permisos")
    monkeypatch.setattr(doc, "_listar_archivos", falla)
    d = doc.detalle(TRAMITE, modo=Modo.VIVO)
    assert d.carpetas[0].archivos == [] and "No se pudo listar" in d.carpetas[0].incidencia


def test_descargar_rechaza_carpetas_y_paginas_html(monkeypatch):
    with pytest.raises(ValueError):
        doc.descargar(TRAMITE, "lsInventada", 0, 0)
    monkeypatch.setattr(doc, "_consultar_detalle_red", lambda t: (DETALLE, {g: DETALLE.get(g) or [] for g, _ in doc.CARPETAS}))
    with pytest.raises(ValueError):
        doc.descargar(TRAMITE, "lsDocumentosSeguimiento", 5, 0)      # entrada inexistente


# -- API -----------------------------------------------------------------------

@pytest.fixture(scope="module")
def cliente():
    return TestClient(app)


def test_los_identificadores_se_validan(cliente):
    assert cliente.get("/api/scout/vital/detalle?radicado=1&origen=VITAL&sol_id=x/../y&solicitante_id=2").status_code == 422
    assert cliente.get("/api/scout/vital/documento?radicado=1&origen=VITAL&sol_id=1&solicitante_id=2&grupo=lsInventada").status_code == 422


def test_el_detalle_por_api_no_sale_a_la_red_en_offline(cliente, cache_temporal):
    d = cliente.get("/api/scout/vital/detalle?radicado=1&origen=VITAL&sol_id=1&solicitante_id=2&modo=offline").json()
    assert d["origen_dato"] == "sin dato" and d["carpetas"] == []


def test_el_documento_se_sirve_en_linea_con_su_tipo(cliente, monkeypatch):
    monkeypatch.setattr(doc, "descargar", lambda t, g, e, i: doc.Descarga("Acuse recibido.pdf", b"%PDF-1.4 hola", "application/pdf"))
    r = cliente.get("/api/scout/vital/documento?radicado=1&origen=VITAL&sol_id=1&solicitante_id=2&grupo=lsDocumentosSeguimiento")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/pdf")
    assert r.headers["content-disposition"].startswith("inline;") and r.content.startswith(b"%PDF")
    r = cliente.get("/api/scout/vital/documento?radicado=1&origen=VITAL&sol_id=1&solicitante_id=2&grupo=lsDocumentosSeguimiento&descargar=true")
    assert r.headers["content-disposition"].startswith("attachment;")
