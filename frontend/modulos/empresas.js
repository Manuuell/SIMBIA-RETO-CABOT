/* Modulo: empresas en cartera. Las elegidas, con todo lo que se sabe de cada una.
 *
 * Una empresa entra en la cartera a mano (boton en su ficha) o sola, en
 * cuanto hay trabajo sobre ella: etapa, expediente vinculado, documento
 * guardado o calidad declarada. Aqui esta su dossier: datos y
 * caracterizacion, ficha comercial, expedientes y tramites con sus
 * documentos, procedencia, y la lectura con IA de un documento guardado
 * para aplicar al prospecto lo que declara.
 */

import {
  $, anotar, barraConfianza, bus, cargarBarrido, chip, escapar, estado, fechaCorta,
  fmt, kpi, pedir, sello, textoSolicitud, tienePermiso,
} from "../comun.js";
import { abrirPanel } from "./prospectos.js";

let cartera = null;
let elegida = null;          // clave de la empresa abierta
const detallesTramite = {};  // radicado -> detalle del VITAL antiguo
const lecturas = {};         // ruta -> resultado de la lectura con IA

async function cargar() {
  cartera = await pedir(`/api/scout/cartera?radio_km=${estado.radio}`);
  if (elegida && !cartera.empresas.some((e) => e.clave === elegida)) elegida = null;
  if (!elegida && cartera.empresas.length) elegida = cartera.empresas[0].clave;
  pintar();
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

function pintarLista() {
  const lista = $("empresas-lista");
  $("empresas-kpi").innerHTML = cartera.empresas.length
    ? `${cartera.empresas.length} empresa(s) · ${fmt.num(cartera.empresas.reduce((s, e) => s + e.caudal_m3_h, 0))} m³/h`
    : "";
  if (!cartera.empresas.length) {
    lista.innerHTML = `<div class="info-caja"><b>La cartera esta vacia.</b> Marca una empresa desde su ficha en
      <a href="#prospectos">Prospectos</a> ("Seguir en cartera"), o simplemente trabaja sobre ella: mover de etapa,
      vincular un expediente desde el <a href="#vital">Buscador VITAL</a> o guardar un documento la anaden solas.</div>`;
    return;
  }
  lista.innerHTML = cartera.empresas.map((e) => {
    const f = e.ficha;
    return `<a href="#empresas" class="empresa-item${e.clave === elegida ? " activa" : ""}" data-clave="${e.clave}">
      <div class="nombre">${escapar(e.nombre)}</div>
      <div class="sub">${escapar(e.sector)}</div>
      <div class="chips">${chip(f.estado, f.estado === "descartado" ? "alerta" : f.estado === "detectado" ? "neutra" : "ok")}
        ${sello(e.metodo_calidad)}
        ${(e.referencias || []).some((r) => r.fuente === "vital") ? chip("expediente", "azul") : ""}
        ${(f.documentos || []).length ? chip(`${f.documentos.length} doc.`, "neutra") : ""}</div>
      <div class="sub">${fmt.num(e.caudal_m3_h, 1)} m³/h · puntaje ${(e.puntaje || 0).toFixed(0)} · confianza ${e.confianza.toFixed(2)}</div>
    </a>`;
  }).join("");
  lista.querySelectorAll(".empresa-item").forEach((a) => a.addEventListener("click", (ev) => {
    ev.preventDefault(); elegida = a.dataset.clave; pintar();
  }));
}

// ---------------------------------------------------------------------------
// Dossier
// ---------------------------------------------------------------------------

function tramitesDe(e) {
  /* Expedientes automaticos (referencias 'vital' del cruce) y manuales (ficha),
   * unificados por identificador. Los ids del VITAL antiguo salen de la URL de
   * la referencia o del expediente vinculado. */
  const vistos = new Map();
  for (const r of e.referencias || []) {
    if (r.fuente !== "vital") continue;
    const u = r.url && r.url.includes("NumSilpa=") ? new URL(r.url).searchParams : null;
    vistos.set(r.identificador, {
      identificador: r.identificador, descripcion: r.descripcion, url: r.url, origen: "cruce automatico",
      radicado: u?.get("NumSilpa") || "", sistema: u?.get("Origen") || "", sol_id: u?.get("TarSolId") || "", solicitante_id: u?.get("Solicitante") || "",
    });
  }
  for (const x of e.ficha.expedientes || []) {
    const id = x.expediente || x.radicado;
    vistos.set(id, {
      ...(vistos.get(id) || {}), identificador: id,
      descripcion: `${x.tramite_legible || x.tramite} ante ${(x.autoridad || "").trim()}${x.radicado ? " · radicado " + x.radicado : ""}`,
      origen: "vinculado a mano", titular: x.titular, fecha: x.fecha,
      radicado: x.radicado || "", sistema: x.origen || "VITAL", sol_id: x.sol_id || "", solicitante_id: x.solicitante_id || "",
    });
  }
  return [...vistos.values()];
}

function bloqueTramite(e, t) {
  const puede = t.radicado && t.sol_id && t.solicitante_id;
  const d = detallesTramite[t.radicado];
  let docs = "";
  if (!puede) {
    docs = `<p class="pie">Sin identificadores del VITAL antiguo. <a href="#vital?q=${encodeURIComponent(t.radicado || t.identificador)}">Buscarlo en VITAL</a> para llegar a sus documentos.</p>`;
  } else if (!d) {
    docs = `<div class="acciones" style="margin-top:6px"><button class="secundario pequeno btn-docs" data-radicado="${escapar(t.radicado)}">Ver documentos del tramite</button></div>`;
  } else if (d.cargando) {
    docs = `<p class="cargando">Abriendo el expediente en el VITAL antiguo…</p>`;
  } else if (d.origen_dato === "sin dato") {
    docs = `<div class="aviso-caja">${escapar(d.incidencia)}</div>`;
  } else {
    const q = new URLSearchParams({ radicado: t.radicado, origen: t.sistema || "VITAL", sol_id: t.sol_id, solicitante_id: t.solicitante_id });
    docs = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin:6px 0">${(d.estado || []).map((s) => chip(s.paso, s.hecho ? "ok" : "neutra")).join(" ")}</div>
      ${d.carpetas.map((c) => `<div class="sub" style="margin-top:4px"><b>${escapar(c.titulo)}</b>${c.fecha ? " · " + escapar(c.fecha) : ""}</div>
        ${c.archivos.length ? `<table><tbody>${c.archivos.map((a) => `<tr>
          <td>📄 ${escapar(a.nombre)}</td>
          <td class="num" style="white-space:nowrap">
            <a class="chip azul sin-punto" target="_blank" rel="noopener" href="/api/scout/vital/documento?${q}&grupo=${c.grupo}&entrada=${c.entrada}&indice=${a.indice}">Ver</a>
            <button class="secundario pequeno btn-guardar-doc" data-q="${escapar(q.toString())}" data-grupo="${c.grupo}" data-entrada="${c.entrada}" data-indice="${a.indice}">Guardar</button>
          </td></tr>`).join("")}</tbody></table>` : `<p class="pie">${escapar(c.incidencia || "Carpeta vacia.")}</p>`}`).join("")}
      <p class="pie"><a href="${escapar(d.url_portal)}" target="_blank" rel="noopener">abrir en el portal ↗</a></p>`;
  }
  return `<div class="tramite">
    <div><code>${escapar(t.identificador)}</code> ${chip(t.origen, t.origen === "vinculado a mano" ? "azul" : "neutra")}
      <span class="sub" style="display:inline"> ${escapar(t.descripcion)}</span></div>
    ${docs}
  </div>`;
}

function bloqueDocumentos(e) {
  const docs = e.ficha.documentos || [];
  if (!docs.length) return `<p class="pie">Ninguno todavia. "Guardar" en un documento del tramite lo deja aqui.</p>`;
  const ia = cartera.extraccion_ia;
  return docs.map((d) => {
    const l = lecturas[d.ruta];
    return `<div class="tramite">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        📄 <b>${escapar(d.nombre)}</b><span class="sub" style="display:inline">${(d.bytes / 1e6).toFixed(2)} MB · radicado ${escapar(d.radicado)} · ${fechaCorta(d.guardado)}</span>
        <span style="margin-left:auto;display:flex;gap:6px">
          <a class="chip azul sin-punto" target="_blank" rel="noopener" href="/api/scout/expediente/archivo?ruta=${encodeURIComponent(d.ruta)}">Ver</a>
          <a class="chip neutra sin-punto" href="/api/scout/expediente/archivo?ruta=${encodeURIComponent(d.ruta)}&descargar=true">Descargar</a>
          ${d.tipo === "application/pdf" ? `<button class="pequeno btn-leer" data-ruta="${escapar(d.ruta)}" ${ia.disponible ? "" : `disabled title="${escapar(ia.motivo)}"`}>Leer con IA</button>` : ""}
        </span>
      </div>
      ${l ? bloqueLectura(e, d, l) : ""}
    </div>`;
  }).join("") + (ia.disponible ? "" : `<p class="pie">Leer con IA no esta configurado en este servidor: ${escapar(ia.motivo)}</p>`);
}

function bloqueLectura(e, d, l) {
  if (l.cargando) return `<p class="cargando">Leyendo el documento con ${escapar(estado.config.extraccion_ia.modelo)}…</p>`;
  if (!l.disponible) return `<div class="error" style="margin-top:8px">${escapar(l.error)}</div>`;
  const p = l.permiso, params = Object.entries(l.calidad_parcial || {});
  return `<div class="ok-caja" style="margin-top:8px">
      <b>${escapar(p.razon_social || "Titular no legible")}</b>${p.expediente ? " · exp. " + escapar(p.expediente) : ""}${p.autoridad ? " · " + escapar(p.autoridad) : ""}
      · caudal autorizado <b>${l.caudal_m3_h ?? "—"} m³/h</b> · confianza de lectura ${(p.confianza ?? 0).toFixed(2)}
      ${p.observaciones ? `<br><span class="sub" style="display:inline">${escapar(p.observaciones)}</span>` : ""}
    </div>
    <div style="margin-top:8px">
      <dl class="pares">${params.length ? params.map(([k, v]) => `<dt>${k}</dt><dd>${v} <span class="sub" style="display:inline">(hoy ${fmt.num(e.calidad[k] ?? 0, 1)})</span></dd>`).join("") : "<dt>—</dt><dd>ningun parametro reconocido</dd>"}</dl>
      <div class="acciones">
        <button class="pequeno btn-aplicar" data-ruta="${escapar(d.ruta)}" ${params.length || l.caudal_m3_h ? "" : "disabled"}>Aplicar al prospecto</button>
        <span class="pie" style="margin:0">Pisa el arquetipo en estos parametros y el prospecto pasa a <span class="sello declarado">declarado</span>. Revisa los valores antes.</span>
      </div>
    </div>`;
}

function pintarDossier() {
  const caja = $("empresa-dossier");
  const e = cartera.empresas.find((x) => x.clave === elegida);
  if (!e) { caja.innerHTML = cartera.empresas.length ? "" : `<p class="pie">Nada que mostrar.</p>`; return; }
  const f = e.ficha, c = e.calidad, ix = e.indices || {};
  const plan = e.notas.split(" | ").find((t) => t.startsWith("Plan:") || t.startsWith("No viable")) || "";
  const tramites = tramitesDe(e);
  const primero = tramites[0];

  caja.innerHTML = `
    <div class="cabecera" style="margin-bottom:14px">
      <div>
        <h2 style="font-size:20px;font-weight:660">${escapar(e.nombre)}</h2>
        <p class="sub" style="margin:2px 0 8px">${escapar(e.sector)} · ${escapar(e.corriente)} · ${e.distancia_conduccion_km.toFixed(1)} km de conduccion</p>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${chip(f.estado, "ok")} ${sello(e.metodo_calidad)} ${barraConfianza(e)}
          ${tienePermiso(e) ? chip("expediente localizado", "azul") : chip("sin expediente", "aviso")}</div>
      </div>
      <div class="acciones-cab">
        <button class="secundario pequeno btn-ficha">Editar ficha</button>
        <a class="chip neutra sin-punto" href="#vital?q=${encodeURIComponent(e.nombre.split(/ - | S\\.A/i)[0])}">Buscar en VITAL</a>
        <button class="secundario pequeno btn-quitar">Quitar de la cartera</button>
      </div>
    </div>
    <div class="rejilla kpis" style="grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
      ${kpi("Caudal", `${fmt.num(e.caudal_m3_h, 1)} m³/h`, sello(e.metodo_caudal))}
      ${kpi("Puntaje", (e.puntaje || 0).toFixed(1), "de simbiosis")}
      ${kpi("Confianza", e.confianza.toFixed(2), e.confianza_etiqueta)}
      ${kpi("Etapa", `<span style="font-size:18px;text-transform:capitalize">${escapar(f.estado)}</span>`, f.responsable ? "resp. " + escapar(f.responsable) : "sin responsable")}
    </div>

    <div class="rejilla dos">
      <div class="tarjeta">
        <h3>Ficha comercial</h3>
        <dl class="pares">
          <dt>Responsable</dt><dd>${escapar(f.responsable || "—")}</dd>
          <dt>Contacto</dt><dd>${escapar(f.contacto || "—")}</dd>
          <dt>Siguiente paso</dt><dd>${escapar(f.proximo_paso || f.requisito || "—")}</dd>
          ${f.notas ? `<dt>Notas</dt><dd>${escapar(f.notas)}</dd>` : ""}
          <dt>Actualizada</dt><dd>${fechaCorta(f.actualizado) || "—"}</dd>
        </dl>
        ${(f.historial || []).length ? `<h4 style="margin:12px 0 6px;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--texto-tenue)">Historial</h4>
          <ul class="refs">${f.historial.slice().reverse().slice(0, 8).map((h) => `<li>${h.fecha?.slice(0, 10)} · ${h.nota ? `<i>${escapar(h.nota)}</i>` : `${escapar(h.de)} → <b>${escapar(h.a)}</b>`}</li>`).join("")}</ul>` : ""}
      </div>
      <div class="tarjeta">
        <h3>Caracterizacion ${sello(e.metodo_calidad)}${(e.campos_medidos || []).length ? `<span class="nota">real en: ${e.campos_medidos.join(", ")}</span>` : ""}</h3>
        <dl class="pares">
          <dt>TDS</dt><dd>${fmt.num(c.tds)} mg/L</dd>
          <dt>Cloruros · Sulfatos</dt><dd>${fmt.num(c.cloruros)} · ${fmt.num(c.sulfatos)} mg/L</dd>
          <dt>Dureza Ca · Alcalinidad</dt><dd>${fmt.num(c.dureza_ca)} · ${fmt.num(c.alcalinidad)} mg/L CaCO₃</dd>
          <dt>Silice</dt><dd>${fmt.num(c.silice)} mg/L</dd>
          <dt>DQO · SST</dt><dd>${fmt.num(c.dqo)} · ${fmt.num(c.sst)} mg/L</dd>
          <dt>N amoniacal · Fosfatos</dt><dd>${fmt.num(c.n_amoniacal, 1)} · ${fmt.num(c.fosfatos, 1)} mg/L</dd>
          <dt>pH · T</dt><dd>${c.ph?.toFixed(2)} · ${fmt.num(c.t_c, 1)} °C</dd>
          <dt>LSI · Larson-Skold</dt><dd>${(ix.lsi ?? 0).toFixed(2)} · ${(ix.larson_skold ?? 0).toFixed(2)}</dd>
        </dl>
        <p class="pie">Limitante: ${escapar(e.limitante)}</p>
        ${plan ? `<div class="plan" style="margin-top:8px">${escapar(plan)}</div>` : ""}
      </div>
    </div>

    <div class="tarjeta bloque" style="margin-top:14px">
      <h3>Expedientes y tramites <span class="nota">${tramites.length ? `${tramites.length} en VITAL` : "ninguno localizado"}</span>
        ${primero ? `<button class="secundario pequeno btn-solicitud" style="margin-left:auto">Redactar solicitud</button>` : ""}</h3>
      ${tramites.length ? tramites.map((t) => bloqueTramite(e, t)).join("") : `<p class="pie">Ningun tramite localizado. <a href="#vital?q=${encodeURIComponent(e.nombre.split(/ - | S\\.A/i)[0])}">Buscar en VITAL</a> y vincular el que corresponda.</p>`}
      <div class="caja-solicitud" hidden style="margin-top:10px">
        <textarea rows="12" readonly class="txt-solicitud"></textarea>
        <div class="acciones"><button class="pequeno btn-copiar-solicitud">Copiar solicitud</button><span class="pie" style="margin:0">Rellena los corchetes antes de enviarla.</span></div>
      </div>
    </div>

    <div class="tarjeta bloque">
      <h3>Documentos guardados <span class="nota">en el servidor, junto al resto de la evidencia</span></h3>
      ${bloqueDocumentos(e)}
    </div>

    <div class="tarjeta bloque">
      <h3>Procedencia de los datos</h3>
      <ul class="refs">${(e.referencias || []).map((r) => `<li><code>${escapar(r.fuente)}</code> · ${escapar(r.identificador)}${r.descripcion ? " — " + escapar(r.descripcion) : ""}${r.url ? ` · <a href="${escapar(r.url)}" target="_blank" rel="noopener">ver</a>` : ""}</li>`).join("")}</ul>
    </div>`;

  // -- acciones ------------------------------------------------------------
  caja.querySelector(".btn-ficha").addEventListener("click", () => abrirPanel(e.clave));
  caja.querySelector(".btn-quitar").addEventListener("click", async () => {
    if (!confirm(`¿Quitar ${e.nombre} de la cartera? La ficha y sus documentos se conservan.`)) return;
    await pedir("/api/scout/ficha", { clave: e.clave, nombre: e.nombre, en_cartera: false });
    anotar(`${escapar(e.nombre)} sale de la cartera`, "neutra");
    await cargarBarrido({ refrescar: true });
  });
  caja.querySelector(".btn-solicitud")?.addEventListener("click", () => {
    const box = caja.querySelector(".caja-solicitud"); box.hidden = !box.hidden;
    const aut = (primero.descripcion.split(" ante ")[1] || "").split(/ - | · /)[0];
    box.querySelector(".txt-solicitud").value = textoSolicitud({ empresa: e.nombre, autoridad: aut, expediente: primero.identificador });
  });
  caja.querySelector(".btn-copiar-solicitud")?.addEventListener("click", async (ev) => {
    try { await navigator.clipboard.writeText(caja.querySelector(".txt-solicitud").value); ev.target.textContent = "Copiada"; }
    catch { ev.target.textContent = "No se pudo copiar"; }
  });
  caja.querySelectorAll(".btn-docs").forEach((b) => b.addEventListener("click", () => {
    const t = tramites.find((x) => x.radicado === b.dataset.radicado);
    cargarDetalleTramite(t);
  }));
  caja.querySelectorAll(".btn-guardar-doc").forEach((b) => b.addEventListener("click", () => guardarDocumento(e, b)));
  caja.querySelectorAll(".btn-leer").forEach((b) => b.addEventListener("click", () => leerDocumento(e, b.dataset.ruta)));
  caja.querySelectorAll(".btn-aplicar").forEach((b) => b.addEventListener("click", () => aplicarLectura(e, b.dataset.ruta, b)));
}

async function cargarDetalleTramite(t) {
  detallesTramite[t.radicado] = { cargando: true }; pintarDossier();
  try {
    const q = new URLSearchParams({ radicado: t.radicado, origen: t.sistema || "VITAL", sol_id: t.sol_id, solicitante_id: t.solicitante_id });
    const d = await pedir(`/api/scout/vital/detalle?${q}`);
    detallesTramite[t.radicado] = d;
    anotar(`Expediente ${escapar(t.identificador)}: ${d.total_archivos} documento(s)`, d.origen_dato === "red" ? "ok" : "azul");
  } catch (err) { detallesTramite[t.radicado] = { origen_dato: "sin dato", incidencia: err.message }; }
  pintarDossier();
}

async function guardarDocumento(e, btn) {
  btn.disabled = true; btn.textContent = "Guardando…";
  try {
    const q = Object.fromEntries(new URLSearchParams(btn.dataset.q));
    const r = await pedir("/api/scout/vital/documento/archivar", {
      ...q, grupo: btn.dataset.grupo, entrada: Number(btn.dataset.entrada), indice: Number(btn.dataset.indice),
      clave: e.clave, radio_km: estado.radio,
    });
    anotar(`Documento guardado en la ficha de <b>${escapar(e.nombre)}</b>: ${escapar(r.nombre)}`, "ok");
    await cargarBarrido({ refrescar: true });
  } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = "Guardar"; }
}

async function leerDocumento(e, ruta) {
  lecturas[ruta] = { cargando: true }; pintarDossier();
  try {
    lecturas[ruta] = await pedir("/api/scout/expediente/leer", { ruta });
    const l = lecturas[ruta];
    anotar(l.disponible ? `Documento leido: ${Object.keys(l.calidad_parcial || {}).length} parametros, caudal ${l.caudal_m3_h ?? "—"} m³/h` : `Lectura fallida: ${escapar(l.error)}`, l.disponible ? "ok" : "alerta");
  } catch (err) { lecturas[ruta] = { disponible: false, error: err.message }; }
  pintarDossier();
}

async function aplicarLectura(e, ruta, btn) {
  const l = lecturas[ruta];
  const d = (e.ficha.documentos || []).find((x) => x.ruta === ruta);
  const que = [...Object.keys(l.calidad_parcial || {}), ...(l.caudal_m3_h ? ["caudal"] : [])].join(", ");
  if (!confirm(`Aplicar a ${e.nombre}: ${que}. El prospecto pasara a 'declarado'. ¿Continuar?`)) return;
  btn.disabled = true;
  try {
    await pedir("/api/scout/declarar", { clave: e.clave, calidad: l.calidad_parcial || {}, caudal_m3_h: l.caudal_m3_h, fuente: d?.nombre || ruta, radio_km: estado.radio });
    anotar(`Calidad declarada aplicada a <b>${escapar(e.nombre)}</b> (${que})`, "ok", "el puntaje y la confianza se recalculan");
    delete lecturas[ruta];
    await cargarBarrido({ refrescar: true });
  } catch (err) { alert(err.message); btn.disabled = false; }
}

function pintar() {
  if (!cartera) return;
  pintarLista();
  pintarDossier();
}

export default {
  id: "empresas",
  async montar() {
    bus.on("barrido", () => cargar().catch((e) => { $("empresa-dossier").innerHTML = `<div class="error">${escapar(e.message)}</div>`; }));
    if (!estado.barrido) await cargarBarrido();
    await cargar();
  },
  async mostrar() { if (cartera) await cargar(); },
};
