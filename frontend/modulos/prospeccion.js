/* Vecinos: toda la prospeccion en una pagina.
 *
 * Cada vez que se entra empieza sin datos, con el boton «Analizar empresas»
 * (catalogo.js): el catalogo aparece cuando termina el recorrido. Quien llega
 * a una empresa concreta (asistente, enlace) va directo a ella.
 *
 * A la izquierda, la lista (o el mapa) de empresas con su buscador y filtros;
 * a la derecha, el dossier de la elegida (empresas.js). Lo que antes eran
 * pantallas propias vive ahora en paneles laterales que se abren desde la
 * cabecera: consultar las fuentes y subir documentos (datos.js) y el buscador
 * de VITAL (vital.js). Se montan la primera vez que se abren.
 *
 * Los enlaces de antes siguen valiendo: #datos y #vital?q=... abren su panel,
 * #empresas abre la cartera y #prospectos la lista completa.
 */

import {
  $, bus, cargarBarrido, chip, escapar, estado, fechaCorta, fmt, kpi, nombreAutoridad, permisosDe, sello, tienePermiso,
} from "../comun.js";
import { colorPuntaje, dibujarMapa } from "../mapa.js";
import { analizar, enCurso, pintarArranque } from "./catalogo.js";
import datos from "./datos.js";
import vital, { buscarTexto } from "./vital.js";
import { montarDossier, refrescarDossier, seleccionada, seleccionar as abrirDossier } from "./empresas.js";
import { abrirPanel, montarPanel, NOMBRE_PESO, TONOS } from "./prospectos.js";

const ORDEN_ETAPA = ["contratado", "piloto", "caracterizado", "nda", "contactado", "calificado", "detectado", "descartado"];
const CAJONES = { datos, vital };

// modo: lo que ocupa la zona principal, el dossier de la elegida o el mapa.
const vista = { pestana: "todas", modo: "dossier", texto: "", orden: "puntaje",
  filtros: { viables: true, expediente: false, confianza: false } };
const cajonesMontados = new Set();

// ---------------------------------------------------------------------------
// Datos derivados
// ---------------------------------------------------------------------------

const normalizar = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const etapaDe = (p) => p.ficha?.estado || p.estado || "detectado";
const enCartera = (p) => Boolean(p.ficha?.en_cartera);

function filtrados() {
  const b = estado.barrido;
  if (!b) return [];
  const umbral = estado.config?.umbral_promocion ?? 0.55;
  const texto = normalizar(vista.texto.trim());
  const f = vista.filtros;
  return b.prospectos.filter((p) =>
    (vista.pestana !== "cartera" || enCartera(p))
    && (!f.viables || (p.puntaje || 0) > 0 || enCartera(p))
    && (!f.expediente || tienePermiso(p))
    && (!f.confianza || p.confianza >= umbral)
    && normalizar(`${p.nombre} ${p.sector} ${p.corriente}`).includes(texto))
    .sort((a, c) => {
      switch (vista.orden) {
        case "nombre": return a.nombre.localeCompare(c.nombre, "es");
        case "distancia": return a.distancia_conduccion_km - c.distancia_conduccion_km;
        case "caudal": return c.caudal_m3_h - a.caudal_m3_h;
        case "confianza": return c.confianza - a.confianza;
        case "etapa": return (ORDEN_ETAPA.indexOf(etapaDe(a)) - ORDEN_ETAPA.indexOf(etapaDe(c)))
          || ((c.puntaje || 0) - (a.puntaje || 0));
        default: return ((c.puntaje || 0) - (a.puntaje || 0)) || a.nombre.localeCompare(c.nombre, "es");
      }
    });
}

// ---------------------------------------------------------------------------
// Cabecera: estado de los datos e indicadores
// ---------------------------------------------------------------------------

function pintarEstado(b) {
  const osm = (b.fuentes || []).find((x) => x.fuente === "osm");
  const pv = b.permisos || {};
  const partes = [
    osm ? `<span class="vec-fuente osm">OpenStreetMap <b>${fmt.num(osm.registros)}</b> registros${osm.fecha_dato ? ` · ${fechaCorta(osm.fecha_dato)}` : ""}</span>` : "",
    pv.total != null ? `<span class="vec-fuente vital">VITAL <b>${fmt.num(pv.total)}</b> permisos de vertimiento${pv.fecha_dato ? ` · ${fechaCorta(pv.fecha_dato)}` : ""}</span>` : "",
    `<span class="vec-fuente">radio <b>${b.radio_km} km</b> alrededor de la planta</span>`,
  ].filter(Boolean);
  $("vec-estado").innerHTML = partes.join("")
    + `<button class="secundario pequeno" data-reanalizar title="Repite el análisis: OpenStreetMap, actividad, VITAL y simbiosis">Analizar de nuevo</button>`;
}

function pintarKpis(b) {
  const r = b.resumen;
  const conExp = b.prospectos.filter(tienePermiso).length;
  const cartera = b.prospectos.filter(enCartera);
  $("prospectos-kpis").innerHTML = [
    kpi("Empresas detectadas", r.detectados, `${fmt.num(r.caudal_total_m3_h)} m³/h de rechazo estimado`),
    kpi("Con simbiosis viable", r.viables, "mantienen los ciclos con algún tratamiento"),
    kpi("Con permiso de vertimiento", conExp, "trámite localizado en VITAL"),
    kpi("Confianza suficiente", r.promovibles, `≥ ${estado.config.umbral_promocion} · media ${r.confianza_media.toFixed(2)}`),
    kpi("En cartera", cartera.length, `${fmt.num(cartera.reduce((s, p) => s + p.caudal_m3_h, 0))} m³/h en seguimiento`),
  ].join("");
}

// ---------------------------------------------------------------------------
// Lista y mapa
// ---------------------------------------------------------------------------

function pintarPestanas(b) {
  const n = b.prospectos.length, c = b.prospectos.filter(enCartera).length;
  $("vec-vista").innerHTML = `
    <button role="tab" class="${vista.pestana === "todas" ? "activa" : ""}" data-pestana="todas">Todas <span>${n}</span></button>
    <button role="tab" class="${vista.pestana === "cartera" ? "activa" : ""}" data-pestana="cartera">En cartera <span>${c}</span></button>`;
}

function itemLista(p, activa) {
  const etapa = etapaDe(p);
  const docs = p.ficha?.documentos?.length || 0;
  const permiso = permisosDe(p)[0];
  const punt = p.puntaje == null ? "—" : Math.round(p.puntaje);
  return `<button class="vec-item${activa ? " activa" : ""}" data-clave="${p.clave}">
    <span class="vec-punt" style="--tono:${colorPuntaje(p.puntaje)}" title="Puntaje de simbiosis">${punt}</span>
    <span class="vec-item-cuerpo">
      <span class="vec-item-nombre">${escapar(p.nombre)}${enCartera(p) ? ' <i class="vec-estrella" title="En cartera">★</i>' : ""}</span>
      <span class="vec-item-sub">${escapar(p.sector)} · ${fmt.num(p.caudal_m3_h, 1)} m³/h · ${fmt.num(p.distancia_conduccion_km, 1)} km</span>
      <span class="vec-item-chips">${sello(p.metodo_calidad)}${permiso
        ? `<span class="chip azul vec-chip-permiso" title="Permiso de vertimiento en VITAL">permiso ${escapar(nombreAutoridad(permiso.autoridad))}</span>` : ""}${
        etapa !== "detectado" ? chip(etapa, etapa === "descartado" ? "alerta" : "ok") : ""}${
        docs ? chip(`${docs} doc.`, "neutra") : ""}</span>
    </span>
  </button>`;
}

function pintarLista() {
  const b = estado.barrido;
  if (!b) return;
  const lista = filtrados();
  const elegida = seleccionada();
  pintarPestanas(b);
  $("vec-cuenta").textContent = `${lista.length} de ${vista.pestana === "cartera" ? b.prospectos.filter(enCartera).length : b.prospectos.length}`;
  $("vec-lista").innerHTML = lista.length ? lista.map((p) => itemLista(p, p.clave === elegida)).join("")
    : vista.pestana === "cartera" && !b.prospectos.some(enCartera)
      ? `<div class="vec-vacio">La cartera está vacía. Abre una empresa en <b>Todas</b> y pulsa <b>Seguir en cartera</b>.
         También entran solas al vincular un expediente o guardar un documento.</div>`
      : `<div class="vec-vacio">Ninguna empresa cumple los filtros. <button class="secundario pequeno" data-limpiar>Quitar filtros</button></div>`;
  $("empresa-dossier").hidden = vista.modo === "mapa";
  $("vec-vista-mapa").hidden = vista.modo !== "mapa";
  if (vista.modo === "mapa") {
    // En el mapa se explora: un punto abre la ficha en el panel lateral y el
    // mapa sigue ahi. "Ver dossier completo" lleva al dossier.
    dibujarMapa($("mapa"), { planta: b.planta, prospectos: lista, alSeleccionar: abrirPanel });
    pintarTrazado(lista);
  }
}

function pintarTrazado(lista) {
  const filas = [...lista].sort((a, c) => a.distancia_conduccion_km - c.distancia_conduccion_km).slice(0, 8)
    .map((p) => {
      const factor = p.distancia_linea_km > 0 ? p.distancia_conduccion_km / p.distancia_linea_km : 1;
      return `<tr tabindex="0" class="clicable" data-clave="${p.clave}">
        <td>${escapar(p.nombre)}</td>
        <td class="num">${p.distancia_linea_km.toFixed(2)}</td>
        <td class="num">${p.distancia_conduccion_km.toFixed(2)}</td>
        <td class="num" style="color:var(--aviso)">×${factor.toFixed(2)}</td></tr>`;
    }).join("");
  $("tabla-trazado").innerHTML = `<thead><tr><th>Empresa</th><th class="num">Recta km</th>
    <th class="num">Estimado km</th><th class="num">Factor</th></tr></thead>
    <tbody>${filas || '<tr><td colspan="4">Sin empresas para estos filtros.</td></tr>'}</tbody>`;
}

function cambiarModo(modo) {
  vista.modo = modo;
  $("vec-modo").querySelectorAll("button").forEach((x) => x.classList.toggle("activa", x.dataset.modo === modo));
  pintarLista();
}

function seleccionar(clave) {
  abrirDossier(clave);
  document.querySelectorAll("#vec-lista .vec-item").forEach((x) =>
    x.classList.toggle("activa", x.dataset.clave === clave));
  // En pantallas estrechas el dossier queda debajo: se lleva la vista a el.
  if (!$("vec-catalogo").hidden && window.matchMedia("(max-width: 1100px)").matches) {
    $("empresa-dossier").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function pintarTodo() {
  const b = estado.barrido;
  if (!b) return;
  pintarEstado(b);
  pintarKpis(b);
  pintarLista();
  if (!seleccionada() || !b.prospectos.some((p) => p.clave === seleccionada())) {
    const primera = filtrados()[0];
    if (primera) seleccionar(primera.clave);
  }
}

// ---------------------------------------------------------------------------
// Antes y despues de analizar
// ---------------------------------------------------------------------------

function mostrarCatalogo({ entrada = false } = {}) {
  $("vec-analisis").hidden = true;
  const cat = $("vec-catalogo");
  cat.hidden = false;
  if (entrada) { cat.classList.remove("entra"); void cat.offsetWidth; cat.classList.add("entra"); }
  pintarTodo();
}

function mostrarArranque() {
  $("vec-catalogo").hidden = true;
  $("vec-analisis").hidden = false;
  pintarArranque();
  $("btn-analizar-vecinos").addEventListener("click", () => analizar(() => mostrarCatalogo({ entrada: true })));
}

function reanalizar() {
  mostrarArranque();
  window.scrollTo({ top: 0, behavior: "smooth" });
  analizar(() => mostrarCatalogo({ entrada: true }));
}

/** Quien viene a por una empresa concreta no pasa por el boton. */
function saltarAnalisis() {
  if (!$("vec-catalogo").hidden) return;
  mostrarCatalogo();
}

function pintarAyudaPuntaje() {
  const pesos = estado.config.pesos_puntaje;
  $("ayuda-puntaje").innerHTML = `<p>De 0 a 100. Suma cinco componentes y multiplica por la confianza del dato:</p>
    <p>${Object.entries(pesos).map(([k, v]) =>
      `<b style="color:${TONOS[k]}">${v} %</b> ${NOMBRE_PESO[k]}`).join(" · ")}</p>
    <p>Para cada empresa se busca el mejor par (tratamiento, fracción de mezcla) evaluando la mezcla real con
      el modelo químico completo. Un puntaje de 0 significa que ninguna mezcla mantiene los ciclos de la línea
      base. Una empresa poco fiable no se descarta: se posterga.</p>`;
}

// ---------------------------------------------------------------------------
// Paneles laterales
// ---------------------------------------------------------------------------

async function abrirCajon(nombre, ir = null) {
  cerrarCajones();
  const cajon = $(`cajon-${nombre}`);
  cajon.classList.add("abierto");
  $("velo").classList.add("abierto");
  if (!cajonesMontados.has(nombre)) {
    cajonesMontados.add(nombre);
    await CAJONES[nombre].montar();
  }
  if (ir) $(ir)?.scrollIntoView({ behavior: "smooth", block: "start" });
  else cajon.scrollTop = 0;
}

function cerrarCajones() {
  document.querySelectorAll(".cajon.abierto").forEach((c) => c.classList.remove("abierto"));
  if (!document.querySelector(".panel-lateral.abierto")) $("velo").classList.remove("abierto");
}

function conectar() {
  $("vec-buscar").addEventListener("input", (e) => { vista.texto = e.target.value; pintarLista(); });
  $("vec-orden").addEventListener("change", (e) => { vista.orden = e.target.value; pintarLista(); });
  $("vec-filtros").querySelectorAll("input").forEach((inp) => inp.addEventListener("change", () => {
    vista.filtros[inp.dataset.filtro] = inp.checked;
    inp.closest("label").classList.toggle("activo", inp.checked);
    pintarLista();
  }));
  $("vec-vista").addEventListener("click", (e) => {
    const b = e.target.closest("[data-pestana]");
    if (!b) return;
    vista.pestana = b.dataset.pestana;
    pintarLista();
  });
  $("vec-modo").addEventListener("click", (e) => {
    const b = e.target.closest("[data-modo]");
    if (b) cambiarModo(b.dataset.modo);
  });
  $("tabla-trazado").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-clave]");
    if (tr) abrirPanel(tr.dataset.clave);
  });
  $("tabla-trazado").addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-clave]");
    if (tr && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); abrirPanel(tr.dataset.clave); }
  });
  bus.on("vecinos:dossier", (clave) => { saltarAnalisis(); cambiarModo("dossier"); seleccionar(clave); });
  $("vec-estado").addEventListener("click", (e) => { if (e.target.closest("[data-reanalizar]")) reanalizar(); });
  $("vec-lista").addEventListener("click", (e) => {
    if (e.target.closest("[data-limpiar]")) {
      vista.texto = ""; $("vec-buscar").value = "";
      for (const k of Object.keys(vista.filtros)) vista.filtros[k] = false;
      $("vec-filtros").querySelectorAll("input").forEach((i) => { i.checked = false; i.closest("label").classList.remove("activo"); });
      pintarLista();
      return;
    }
    const item = e.target.closest(".vec-item");
    if (!item) return;
    if (vista.modo !== "dossier") cambiarModo("dossier");
    seleccionar(item.dataset.clave);
  });
  document.querySelectorAll("[data-cajon]").forEach((b) =>
    b.addEventListener("click", () => abrirCajon(b.dataset.cajon, b.dataset.ir || null)));
  document.querySelectorAll("[data-cerrar-cajon]").forEach((b) => b.addEventListener("click", cerrarCajones));
  $("velo").addEventListener("click", cerrarCajones);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrarCajones(); });
}

/** Lo que pide un enlace antiguo (#datos, #vital?q=, #empresas, #prospectos). */
async function atenderEnlace() {
  const [ruta, qs] = (location.hash || "").slice(1).split("?");
  const q = new URLSearchParams(qs || "");
  if (ruta === "empresas") vista.pestana = "cartera";
  if (ruta === "prospectos") vista.pestana = "todas";
  if (ruta === "empresas" || ruta === "prospectos" || q.get("empresa")) saltarAnalisis();
  if (ruta !== "prospeccion") history.replaceState(null, "", "#prospeccion");
  if (q.get("empresa")) seleccionar(q.get("empresa"));
  pintarLista();
  if (ruta === "datos") await abrirCajon("datos");
  if (ruta === "vital") {
    await abrirCajon("vital");
    if (q.get("q")) buscarTexto(q.get("q"));
  }
}

// La primera entrada ya pinta el arranque en montar(), antes de cargar nada.
let recienMontado = false;

export default {
  id: "prospeccion",
  async montar() {
    conectar();
    montarPanel();
    pintarAyudaPuntaje();
    bus.on("barrido", pintarTodo);
    mostrarArranque();
    recienMontado = true;
    await montarDossier();
    if (!estado.barrido) await cargarBarrido();
    pintarTodo();
  },
  async mostrar() {
    // Cada entrada a Vecinos empieza por «Analizar empresas», salvo que haya
    // un recorrido a medias o el enlace pida una empresa (atenderEnlace).
    if (!recienMontado && !enCurso()) mostrarArranque();
    recienMontado = false;
    await refrescarDossier();
    await atenderEnlace();
  },
};
