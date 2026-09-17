"""Analisis de expedientes en segundo plano.

Para una empresa: sus tramites en VITAL (los del cruce automatico y los
vinculados a mano) -> los archivos PDF de cada carpeta -> descarga y guarda
en el expediente local -> analisis con IA de cada uno. Tarda: cada PDF son
unos segundos de descarga (sesion y ViewState del VITAL antiguo) y otros
tantos de modelo. Por eso va en una cola con un solo hilo, que respeta los
limites de tasa y deja un registro paso a paso que la interfaz muestra.

Nada de lo analizado se aplica al prospecto: eso lo decide una persona
despues, en la revision.
"""

from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from . import analisis, documentos
from .fuentes.base import Modo

#: Limites por tramite y por archivo: un expediente de licencia puede pesar.
MAX_PDF_POR_TRAMITE = 8
MAX_MB_POR_PDF = 25.0


@dataclass
class Trabajo:
    clave: str
    nombre: str
    estado: str = "en cola"          # en cola | en curso | hecho | error
    pasos: list[dict[str, str]] = field(default_factory=list)
    documentos: int = 0
    analizados: int = 0
    inicio: str = ""
    fin: str = ""

    def anotar(self, texto: str, tono: str = "neutra") -> None:
        self.pasos.append({
            "hora": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "texto": texto, "tono": tono,
        })

    def as_dict(self) -> dict[str, Any]:
        return {
            "clave": self.clave, "nombre": self.nombre, "estado": self.estado,
            "pasos": self.pasos[-40:], "documentos": self.documentos,
            "analizados": self.analizados, "inicio": self.inicio, "fin": self.fin,
        }


def tramites_de(prospecto, ficha) -> list[documentos.Tramite]:
    """Los tramites con identificadores del VITAL antiguo, sin duplicar."""
    vistos: dict[str, documentos.Tramite] = {}
    for r in prospecto.referencias:
        if r.fuente != "vital" or "NumSilpa=" not in r.url:
            continue
        q = parse_qs(urlparse(r.url).query)
        t = documentos.Tramite(
            radicado=q.get("NumSilpa", [""])[0], origen=q.get("Origen", ["VITAL"])[0],
            sol_id=q.get("TarSolId", [""])[0], solicitante_id=q.get("Solicitante", [""])[0],
        )
        if t.radicado and t.sol_id and t.solicitante_id:
            vistos[t.radicado] = t
    for e in (ficha.expedientes if ficha else []):
        if e.get("radicado") and e.get("sol_id") and e.get("solicitante_id"):
            vistos[e["radicado"]] = documentos.Tramite(
                radicado=e["radicado"], origen=e.get("origen") or "VITAL",
                sol_id=e["sol_id"], solicitante_id=e["solicitante_id"],
            )
    return list(vistos.values())


class Cola:
    """Un hilo, un trabajo a la vez. Los estados se consultan por clave."""

    def __init__(self) -> None:
        self._cola: queue.Queue[tuple[Trabajo, Callable[[Trabajo], None]]] = queue.Queue()
        self._trabajos: dict[str, Trabajo] = {}
        self._candado = threading.Lock()
        self._hilo: threading.Thread | None = None

    def encolar(self, clave: str, nombre: str, tarea: Callable[[Trabajo], None]) -> Trabajo:
        with self._candado:
            actual = self._trabajos.get(clave)
            if actual is not None and actual.estado in ("en cola", "en curso"):
                return actual
            t = Trabajo(clave=clave, nombre=nombre)
            self._trabajos[clave] = t
            self._cola.put((t, tarea))
            if self._hilo is None or not self._hilo.is_alive():
                self._hilo = threading.Thread(target=self._correr, name="simbia-lote", daemon=True)
                self._hilo.start()
            return t

    def estado(self) -> list[dict[str, Any]]:
        with self._candado:
            return [t.as_dict() for t in self._trabajos.values()]

    def trabajo(self, clave: str) -> Trabajo | None:
        return self._trabajos.get(clave)

    def _correr(self) -> None:
        while True:
            try:
                t, tarea = self._cola.get(timeout=2.0)
            except queue.Empty:
                return
            t.estado = "en curso"
            t.inicio = datetime.now(timezone.utc).isoformat(timespec="seconds")
            try:
                tarea(t)
                t.estado = "hecho"
            except Exception as exc:                        # noqa: BLE001
                t.anotar(f"Fallo: {type(exc).__name__}: {exc}", "alerta")
                t.estado = "error"
            finally:
                t.fin = datetime.now(timezone.utc).isoformat(timespec="seconds")


COLA = Cola()


def analizar_empresa(
    trabajo: Trabajo, tramites: list[documentos.Tramite], carpeta_expedientes: Path,
    guardar: Callable[[dict[str, Any]], None], al_terminar: Callable[[], None] | None = None,
) -> None:
    """La tarea completa de una empresa. `guardar` anota cada documento en su ficha."""
    if not tramites:
        trabajo.anotar("Sin tramites con identificadores del VITAL antiguo: nada que descargar. Vincula uno desde el Buscador VITAL.", "aviso")
        return
    trabajo.anotar(f"{len(tramites)} tramite(s) en VITAL", "azul")
    for t in tramites:
        d = documentos.detalle(t, modo=Modo.CACHE)
        if d.origen_dato == "sin dato":
            trabajo.anotar(f"Tramite {t.radicado}: {d.incidencia}", "aviso")
            continue
        trabajo.anotar(f"Tramite {t.radicado} ({d.expediente or 'sin expediente'}): {d.total_archivos} archivo(s)", "azul")
        for c in d.carpetas:
            pdfs = [a for a in c.archivos if a.nombre.lower().endswith(".pdf")][:MAX_PDF_POR_TRAMITE]
            for a in pdfs:
                destino = carpeta_expedientes / documentos.nombre_seguro(t.radicado) / documentos.nombre_seguro(a.nombre)
                if not destino.is_file():
                    try:
                        x = documentos.descargar(t, c.grupo, c.entrada, a.indice)
                    except Exception as exc:                # noqa: BLE001
                        trabajo.anotar(f"No se pudo descargar {a.nombre}: {type(exc).__name__}: {exc}", "alerta")
                        continue
                    if len(x.contenido) > MAX_MB_POR_PDF * 1e6:
                        trabajo.anotar(f"{a.nombre} pesa {len(x.contenido)/1e6:.1f} MB; se omite (tope {MAX_MB_POR_PDF:.0f} MB)", "aviso")
                        continue
                    if x.tipo != "application/pdf":
                        trabajo.anotar(f"{a.nombre} no es un PDF ({x.tipo}); se omite", "aviso")
                        continue
                    destino.parent.mkdir(parents=True, exist_ok=True)
                    destino.write_bytes(x.contenido)
                    trabajo.anotar(f"Descargado {a.nombre} ({len(x.contenido)/1e6:.2f} MB)", "ok")
                else:
                    trabajo.anotar(f"{a.nombre} ya estaba guardado", "neutra")
                relativa = f"expedientes/{destino.parent.name}/{destino.name}"
                guardar({"nombre": a.nombre, "ruta": relativa, "radicado": t.radicado,
                         "bytes": destino.stat().st_size, "tipo": "application/pdf"})
                trabajo.documentos += 1
                if analisis.ruta_analisis(destino).is_file():
                    trabajo.anotar(f"{a.nombre}: ya analizado", "neutra")
                    trabajo.analizados += 1
                    continue
                t0 = time.time()
                try:
                    r = analisis.analizar_documento(destino)
                except Exception as exc:                    # noqa: BLE001
                    trabajo.anotar(f"{a.nombre}: no se pudo analizar: {type(exc).__name__}: {exc}", "alerta")
                    continue
                trabajo.analizados += 1
                n_param = sum(len(p["calidad"]) for p in r["puntos"].values())
                trabajo.anotar(
                    f"{a.nombre}: {r['tipo_documento']} — {n_param} parametro(s) del agua"
                    + (f", caudal autorizado {r['caudal_autorizado_m3_h']} m3/h" if r.get("caudal_autorizado_m3_h") else "")
                    + (f", laboratorio {r['laboratorio']}" if r.get("laboratorio") else "")
                    + f" ({time.time()-t0:.0f} s)", "ok")
    if al_terminar:
        al_terminar()
    trabajo.anotar(f"Terminado: {trabajo.documentos} documento(s), {trabajo.analizados} analizado(s). Revisalos en la cartera.", "ok")
