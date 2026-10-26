/* Dossier de una empresa: todo lo que se sabe de ella, en la pagina Vecinos.
 *
 * La lista para elegirla la pinta prospeccion.js; aqui solo el dossier de la
 * elegida (seleccionar()).
 *
 * Una empresa entra en la cartera a mano (boton en su ficha) o sola, en
 * cuanto hay trabajo sobre ella: etapa, expediente vinculado, documento
 * guardado o calidad declarada. Aqui esta su dossier: datos y
 * caracterizacion, ficha comercial, expedientes y tramites con sus
 * documentos, procedencia, y la lectura con IA de un documento guardado
 * para aplicar al prospecto lo que declara.
 */

import {
  $, anotar, barraConfianza, bus, cargarBarrido, chip, copiar, escapar, estado, fechaCorta,
  fmt, kpi, nombreAutoridad, pedir, permisosDe, sello, textoSolicitud,
} from "../comun.js";
import { abrirPanel } from "./prospectos.js";
import { fijarEmpresaEnPantalla } from "./asistente.js";

let cartera = null;
let elegida = null;          // clave de la empresa abierta
const detallesTramite = {};  // radicado -> detalle del VITAL antiguo
const lecturas = {};         // ruta -> resultado de la lectura con IA
const resumenes = {};        // ruta -> resumen del documento (para el asistente y para leer)
const resumenesPedidos = new Set();
const analisis = {};         // ruta -> analisis completo del documento
let trabajos = {};           // clave -> trabajo del lote (progreso)
const enVital = {};          // clave -> lo que VITAL tiene de la empresa, por nombre
let verTodoVital = false;
let verTodosPermisos = false;
let otrosTramitesAbierto = false;
const MAX_PERMISOS = 3;
let sondeo = null;

const FICHA_VACIA = { estado: "detectado", expedientes: [], documentos: [], historial: [], en_cartera: false };

/** Todos los prospectos del barrido, con ficha (vacia si no tienen). */
function todas() {
  return (estado.barrido?.prospectos || []).map((p) => ({ ...p, ficha: p.ficha || { ...FICHA_VACIA, clave: p.clave } }));
}

function enCartera() { return todas().filter((e) => e.ficha.en_cartera); }

async function cargar() {
  cartera = await pedir(`/api/scout/cartera?radio_km=${estado.radio}`);
  if (elegida && !todas().some((e) => e.clave === elegida)) elegida = null;
  pintar();
}

/** Abre el dossier de una empresa del barrido. */
export function seleccionar(clave) {
  elegida = clave;
  pintar();
}

export const seleccionada = () => elegida;

async function seguir(clave, nombre) {
  await pedir("/api/scout/ficha", { clave, nombre, en_cartera: true });
  anotar(`<b>${escapar(nombre)}</b> entra en la cartera`, "ok");
  elegida = clave;
  await cargarBarrido({ refrescar: true });
}

// ---------------------------------------------------------------------------
// Dossier
// ---------------------------------------------------------------------------

/* Permisos de vertimiento: lo que prueba que la corriente existe y el numero
 * con el que se pide su caracterizacion. Van arriba del dossier, cada uno
 * con su autoridad, expediente, fecha y el titular tal como consta en VITAL
 * (que es lo que deja ver si el cruce por razon social es el bueno). */
function bloquePermisos(e, permisos) {
  const hay = permisos.length > 0;
  const visibles = verTodosPermisos ? permisos : permisos.slice(0, MAX_PERMISOS);
  return `<section class="tarjeta vec-permisos ${hay ? "con" : "sin"}">
    <div class="vec-permisos-cab">
      <span class="vec-permisos-icono" aria-hidden="true"></span>
      <div>
        <h3>${hay ? `Permiso de vertimiento ${chip(permisos.length === 1 ? "consta en VITAL" : `${permisos.length} trámites en VITAL`, "ok")}`
                  : "Sin permiso de vertimiento localizado"}</h3>
        <p class="pie">${hay
          ? "Prueba que la corriente existe y está regulada. Con el número de expediente se pide su caracterización por derecho de petición."
          : "Sin permiso no hay prueba de que la corriente exista ni número con el que pedir su caracterización. Búscalo a su nombre aquí abajo o en el buscador de VITAL."}</p>
      </div>
      ${hay ? `<button class="secundario pequeno btn-solicitud">Redactar solicitud</button>` : ""}
    </div>
    ${hay ? `<div class="vec-permisos-lista">${visibles.map((t) => tarjetaPermiso(t)).join("")}</div>` : ""}
    ${permisos.length > MAX_PERMISOS ? `<button class="secundario pequeno btn-permisos-todos">${verTodosPermisos ? "Mostrar menos" : `Mostrar los ${permisos.length} trámites`}</button>` : ""}
    <div class="caja-solicitud" hidden>
      <textarea rows="12" readonly class="txt-solicitud"></textarea>
      <div class="acciones"><button class="pequeno btn-copiar-solicitud">Copiar solicitud</button><span class="pie" style="margin:0">Rellena los corchetes antes de enviarla.</span></div>
    </div>
    <details class="vec-permisos-otros"${!hay || otrosTramitesAbierto ? " open" : ""}>
      <summary>${hay ? "Otros trámites en VITAL a nombre de la empresa" : `Buscar en VITAL a nombre de ${escapar(e.nombre)}`}</summary>
      <div id="bloque-vital">${bloqueEnVital(e, permisos)}</div>
    </details>
  </section>`;
}

function tarjetaPermiso(t) {
  const dato = (titulo, valor, copiable = false) => `<div><dt>${titulo}</dt><dd>${valor ? `<code>${escapar(valor)}</code>${copiable
    ? ` <button class="vec-copiar" data-copiar="${escapar(valor)}" title="Copiar" aria-label="Copiar ${titulo.toLowerCase()}">Copiar</button>` : ""}` : "—"}</dd></div>`;
  return `<article class="vec-permiso">
    <div class="vec-permiso-cab">
      <div class="vec-permiso-autoridad">
        <b>${escapar(nombreAutoridad(t.autoridad) || "Autoridad ambiental")}</b>
        <span>${escapar(t.tramite || "Vertimiento")}${t.fecha ? ` · radicado el ${fechaCorta(t.fecha)}` : ""}</span>
      </div>
      ${chip(t.origen, t.origen === "vinculado a mano" ? "azul" : "neutra")}
    </div>
    <dl class="vec-permiso-datos">
      ${dato("Expediente", t.expediente || t.identificador, true)}
      ${dato("Radicado", t.radicado !== (t.expediente || t.identificador) ? t.radicado : "")}
      <div class="ancho"><dt>Titular en VITAL</dt><dd>${escapar(t.titular || "—")}</dd></div>
    </dl>
    ${documentosPermiso(t)}
  </article>`;
}

function documentosPermiso(t) {
  const puede = t.radicado && t.sol_id && t.solicitante_id;
  const d = detallesTramite[t.radicado];
  const portal = t.url ? `<a class="vec-permiso-portal" href="${escapar(t.url)}" target="_blank" rel="noopener">Abrir en VITAL ↗</a>` : "";
  let docs = "";
  if (!puede) {
    docs = `<div class="vec-permiso-acciones"><span class="pie" style="margin:0">Este trámite no enlaza con sus documentos.</span>
      <a href="#vital?q=${encodeURIComponent(t.radicado || t.identificador)}">Buscarlo en VITAL</a>${portal}</div>`;
  } else if (!d) {
    docs = `<div class="vec-permiso-acciones"><button class="secundario pequeno btn-docs" data-radicado="${escapar(t.radicado)}">Ver documentos del trámite</button>${portal}</div>`;
  } else if (d.cargando) {
    docs = `<p class="cargando">Abriendo el expediente en el portal de VITAL…</p>`;
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
  return `<div class="vec-permiso-docs">${docs}</div>`;
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
        ${d.analizado || analisis[d.ruta] ? chip("analizado", "ok") : ""}
        <span style="margin-left:auto;display:flex;gap:6px">
          ${d.tipo === "application/pdf" ? `<button class="pequeno btn-revisar" data-ruta="${escapar(d.ruta)}" ${ia.disponible || d.analizado ? "" : `disabled title="${escapar(ia.motivo)}"`}>${d.analizado || analisis[d.ruta] ? "Revisar" : "Analizar y revisar"}</button>` : ""}
          <a class="chip azul sin-punto" target="_blank" rel="noopener" href="/api/scout/expediente/archivo?ruta=${encodeURIComponent(d.ruta)}">Ver</a>
          <a class="chip neutra sin-punto" href="/api/scout/expediente/archivo?ruta=${encodeURIComponent(d.ruta)}&descargar=true">Descargar</a>
          ${d.tipo === "application/pdf" ? `<button class="secundario pequeno btn-resumir" data-ruta="${escapar(d.ruta)}" ${ia.disponible ? "" : `disabled title="${escapar(ia.motivo)}"`}>Resumir</button>
          <button class="pequeno btn-leer" data-ruta="${escapar(d.ruta)}" ${ia.disponible ? "" : `disabled title="${escapar(ia.motivo)}"`}>Leer con IA</button>` : ""}
        </span>
      </div>
      ${resumenes[d.ruta] ? bloqueResumen(resumenes[d.ruta]) : ""}
      ${l ? bloqueLectura(e, d, l) : ""}
    </div>`;
  }).join("");
}

function bloqueEnVital(e, vinculados) {
  const v = enVital[e.clave];
  if (!v) return `<p class="cargando">Buscando "${escapar(e.nombre)}" en VITAL…</p>`;
  if (v.error) return `<p class="pie" style="color:var(--aviso)">${escapar(v.error)}</p>`;
  if (v.origen === "sin dato") return `<p class="pie">${escapar(v.incidencia)} <button class="secundario pequeno btn-vital-vivo">Consultar en vivo</button></p>`;
  const ya = new Set(vinculados.map((t) => t.identificador));
  const grupos = v.expedientes.filter((g) => !ya.has(g.expediente || g.radicado));
  if (!v.expedientes.length) return `<p class="pie">Nada a nombre de "${escapar(e.nombre)}" (${v.total} resultado(s) para "${escapar(v.consulta)}", ninguno con titular parecido). Prueba en el <a href="#vital?q=${encodeURIComponent(v.consulta)}">Buscador VITAL</a> por si tramita con otra razon social.</p>`;
  if (!grupos.length) return `<p class="pie">Todo lo que hay a su nombre ya esta vinculado.</p>`;
  const mostrar = verTodoVital ? grupos : grupos.slice(0, 10);
  return `<p class="pie" style="margin:0 0 6px">${v.coincidentes} tramite(s) con titular parecido a "${escapar(e.nombre)}" (${v.origen === "cache" ? "consulta disponible" : "consultado ahora"}), en ${v.expedientes.length} expediente(s) o grupo(s). Vincula los que correspondan; una licencia ambiental incluye el permiso de vertimiento.</p>
    <table><tbody>${mostrar.map((g, i) => `<tr>
      <td>${g.expediente ? `<code>${escapar(g.expediente)}</code>` : `<span class="sub" style="display:inline">sin expediente</span>`}<span class="sub">${escapar(g.titular)}</span></td>
      <td>${g.es_vertimiento ? chip("vertimiento", "azul") : g.es_licencia ? chip("licencia ambiental", "ok") : chip("otros tramites", "neutra")}
        <span class="sub">${g.tramites.slice(0, 3).map((t) => `${escapar(t.tramite)} ×${t.n}`).join(" · ")}${g.tramites.length > 3 ? " · …" : ""}</span></td>
      <td class="sub" style="white-space:nowrap">${escapar(g.autoridad)}<br>${escapar(g.desde)}${g.hasta !== g.desde ? " → " + escapar(g.hasta) : ""} · ${g.n}</td>
      <td class="num"><button class="pequeno btn-vincular-grupo" data-i="${i}" ${g.representativo?.sol_id ? "" : `disabled title="este tramite no enlaza con el portal de expedientes"`}>Vincular</button></td>
    </tr>`).join("")}</tbody></table>
    ${grupos.length > 10 ? `<div class="acciones"><button class="secundario pequeno btn-vital-todos">${verTodoVital ? "Mostrar menos" : `Mostrar los ${grupos.length}`}</button></div>` : ""}`;
}

async function cargarEnVital(e, modo) {
  try {
    enVital[e.clave] = await pedir(`/api/scout/vital/por-empresa?clave=${encodeURIComponent(e.clave)}&radio_km=${estado.radio}${modo ? "&modo=" + modo : ""}`);
  } catch (err) { enVital[e.clave] = { error: err.message }; }
  if (elegida === e.clave) pintarDossier();
}

async function vincularGrupo(e, g, btn) {
  btn.disabled = true; btn.textContent = "Vinculando…";
  try {
    await pedir("/api/scout/vital/vincular", { clave: e.clave, registro: g.representativo, radio_km: estado.radio });
    anotar(`${escapar(g.expediente || g.radicado)} (${escapar(g.autoridad)}) vinculado a <b>${escapar(e.nombre)}</b>`, "ok",
      "ya se puede analizar el expediente");
    await cargarBarrido({ refrescar: true });
  } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = "Vincular"; }
}

function bloqueTrabajo(e) {
  const t = trabajos[e.clave];
  if (!t) return "";
  const tono = { "en cola": "neutra", "en curso": "azul", hecho: "ok", error: "alerta" }[t.estado] || "neutra";
  return `<div class="tarjeta bloque" style="margin-top:14px" id="bloque-trabajo">
    <h3>Analisis del expediente ${chip(t.estado, tono)}
      <span class="nota">${t.documentos} documento(s) · ${t.analizados} analizado(s)</span></h3>
    <div class="bitacora" style="max-height:220px">${t.pasos.slice().reverse().map((p) => `<div class="linea">
      <span class="hora">${escapar(p.hora.slice(11, 19))}</span><span class="ico ${p.tono}"></span><span class="txt">${escapar(p.texto)}</span></div>`).join("")}</div>
  </div>`;
}

async function sondear() {
  try {
    const d = await pedir("/api/scout/expediente/analizar/estado");
    const antes = JSON.stringify(trabajos);
    trabajos = Object.fromEntries(d.trabajos.map((t) => [t.clave, t]));
    const cambio = JSON.stringify(trabajos) !== antes;
    if (cambio && trabajos[elegida]) pintarDossier();
    $("empresas-lote").innerHTML = d.activos ? chip(`${d.activos} analisis en curso`, "azul") : "";
    if (!d.activos) {
      clearInterval(sondeo); sondeo = null;
      if (cambio) await cargarBarrido({ refrescar: true });
    }
  } catch { /* sin consecuencias: se reintenta */ }
}

function empezarSondeo() {
  if (sondeo) return;
  sondear();
  sondeo = setInterval(sondear, 2500);
}

async function analizarExpedientes(claves, boton) {
  if (boton) { boton.disabled = true; boton.textContent = "Encolando…"; }
  try {
    const d = await pedir("/api/scout/expediente/analizar", { claves, radio_km: estado.radio });
    anotar(`Analisis encolado: ${d.encolados.map((t) => escapar(t.nombre)).join(", ")}`, "azul",
      "descarga los PDF del expediente en VITAL y los lee con IA; unos segundos por documento");
    empezarSondeo();
  } catch (e) { alert(e.message); }
  finally { if (boton) { boton.disabled = false; boton.textContent = boton.dataset.texto || "Analizar expediente con IA"; } }
}

// ---------------------------------------------------------------------------
// Revision: el humano decide que se aplica y como
// ---------------------------------------------------------------------------

const NOMBRE_PARAM = {
  ph: "pH", t_c: "Temperatura (°C)", tds: "TDS", dureza_ca: "Dureza Ca (CaCO₃)", alcalinidad: "Alcalinidad (CaCO₃)",
  cloruros: "Cloruros", sulfatos: "Sulfatos", silice: "Sílice", sst: "SST", dqo: "DQO", n_amoniacal: "N amoniacal",
  fosfatos: "Fosfatos", hierro: "Hierro",
};

async function abrirRevision(e, ruta) {
  const panel = $("panel-revision");
  panel.innerHTML = `<p class="cargando">Cargando el analisis…</p>`;
  panel.classList.add("abierto"); $("velo").classList.add("abierto");
  const doc = (e.ficha.documentos || []).find((d) => d.ruta === ruta) || { nombre: ruta };
  try {
    let a = analisis[ruta];
    if (!a) {
      const r = await fetch(`/api/scout/expediente/analisis?ruta=${encodeURIComponent(ruta)}`);
      if (r.ok) a = await r.json();
      else {
        panel.innerHTML = `<p class="cargando">Analizando ${escapar(doc.nombre)} con IA (un solo PDF, unos 20 s)…</p>`;
        a = await pedir("/api/scout/expediente/analisis", { ruta });
      }
      analisis[ruta] = a;
    }
    pintarRevision(e, doc, a);
  } catch (err) {
    panel.innerHTML = `<button class="secundario pequeno cerrar" id="btn-cerrar-revision">Cerrar</button><div class="error">${escapar(err.message)}</div>`;
    $("btn-cerrar-revision").addEventListener("click", cerrarRevision);
  }
}

function cerrarRevision() { $("panel-revision").classList.remove("abierto"); $("velo").classList.remove("abierto"); }

function pintarRevision(e, doc, a) {
  const panel = $("panel-revision");
  const puntos = Object.keys(a.puntos || {});
  const conDatos = puntos.filter((p) => Object.keys(a.puntos[p].calidad).length);
  const puntoInicial = conDatos[0] ?? puntos[0] ?? "";
  const esLab = Boolean(a.laboratorio);
  const caudal = a.caudal_autorizado_m3_h ?? a.caudal_medido_m3_h;

  panel.innerHTML = `
    <button class="secundario pequeno cerrar" id="btn-cerrar-revision">Cerrar</button>
    <h2>Revisar: ${escapar(a.titulo || doc.nombre)}</h2>
    <p class="sub">${chip(a.tipo_documento, "neutra")} confianza de lectura ${(a.confianza ?? 0).toFixed(2)} · ${escapar(doc.nombre)}
      · <a href="/api/scout/expediente/archivo?ruta=${encodeURIComponent(doc.ruta)}" target="_blank" rel="noopener">ver PDF</a></p>
    <div class="info-caja" style="font-size:12px">${escapar(a.resumen || "")}</div>
    ${(a.puntos_clave || []).length ? `<ul class="refs" style="margin-top:8px">${a.puntos_clave.map((x) => `<li>${escapar(x)}</li>`).join("")}</ul>` : ""}
    <dl class="pares" style="margin-top:10px">
      ${a.expediente ? `<dt>Expediente</dt><dd>${escapar(a.expediente)}${a.autoridad ? " · " + escapar(a.autoridad) : ""}</dd>` : ""}
      ${(a.resoluciones || []).length ? `<dt>Resoluciones</dt><dd>${escapar(a.resoluciones.join("; "))}</dd>` : ""}
      ${a.vigencia_hasta ? `<dt>Vigencia</dt><dd>${escapar(a.vigencia_hasta)}</dd>` : ""}
      ${a.cuerpo_receptor ? `<dt>Receptor</dt><dd>${escapar(a.cuerpo_receptor)}</dd>` : ""}
      ${esLab ? `<dt>Laboratorio</dt><dd>${escapar(a.laboratorio)}${a.numero_informe ? " · informe " + escapar(a.numero_informe) : ""}${a.acreditado_ideam ? " · " + chip("acreditado IDEAM", "ok") : ""}</dd>` : ""}
      ${a.fecha_muestreo ? `<dt>Muestreo</dt><dd>${escapar(a.fecha_muestreo)}${a.muestras ? " · " + a.muestras + " muestra(s)" : ""}</dd>` : ""}
      ${a.observaciones ? `<dt>Observaciones</dt><dd>${escapar(a.observaciones)}</dd>` : ""}
    </dl>

    <div class="seccion">
      <h4>Que aplicar a ${escapar(e.nombre)}</h4>
      ${puntos.length > 1 ? `<div class="control" style="margin-bottom:8px"><label>Punto de muestreo</label>
        <select id="rev-punto">${puntos.map((p) => `<option value="${escapar(p)}"${p === puntoInicial ? " selected" : ""}>${escapar(p || "(sin punto)")} · ${Object.keys(a.puntos[p].calidad).length} parametro(s)</option>`).join("")}</select>
        <p class="pie">Elige el efluente que se reutilizaria. Los demas puntos no se aplican.</p></div>` : ""}
      <div id="rev-tabla"></div>
      <div style="margin-top:8px;font-size:12.5px">
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="rev-caudal" ${caudal ? "checked" : "disabled"}>
          Caudal: <b>${caudal ?? "—"} m³/h</b> ${a.caudal_autorizado_m3_h ? "(autorizado)" : a.caudal_medido_m3_h ? "(medido)" : ""} <span class="sub" style="display:inline">· hoy ${fmt.num(e.caudal_m3_h, 1)} m³/h ${sello(e.metodo_caudal)}</span></label>
      </div>
    </div>

    <div class="seccion">
      <h4>Como se marca</h4>
      <div class="opciones">
        <label class="${esLab ? "" : "activo"}"><input type="radio" name="rev-metodo" value="declarado" ${esLab ? "" : "checked"}> Declarado</label>
        <label class="${esLab ? "activo" : ""}"><input type="radio" name="rev-metodo" value="medido" ${esLab ? "checked" : ""}> Medido (laboratorio)</label>
      </div>
      <p class="pie"><b>Declarado</b>: lo reporta la empresa o su permiso. <b>Medido</b>: analitica de un laboratorio acreditado sobre esta corriente; exige citar el laboratorio y el informe.</p>
      <div class="ficha-form" id="rev-informe" ${esLab ? "" : "hidden"}>
        <div><label>Laboratorio</label><input type="text" id="rev-lab" value="${escapar(a.laboratorio || "")}"></div>
        <div><label>Informe</label><input type="text" id="rev-inf" value="${escapar(a.numero_informe || "")}"></div>
        <div><label>Fecha de muestreo</label><input type="text" id="rev-fecha" value="${escapar(a.fecha_muestreo || "")}"></div>
        <div><label>Muestras</label><input type="number" id="rev-muestras" value="${a.muestras || 0}" min="0"></div>
      </div>
    </div>

    <div class="acciones" style="margin-top:14px">
      <button id="btn-aplicar-revision">Aplicar al prospecto</button>
      <span class="pie" style="margin:0" id="rev-msg">Pisa el arquetipo solo en los parametros marcados. Se puede repetir con otro documento.</span>
    </div>`;

  const pintarTabla = () => {
    const punto = $("rev-punto") ? $("rev-punto").value : puntoInicial;
    const cal = (a.puntos[punto] || { calidad: {} }).calidad;
    const claves = Object.keys(cal);
    $("rev-tabla").innerHTML = claves.length ? `<table><thead><tr><th></th><th>Parametro</th><th class="num">Documento</th><th class="num">Hoy (${escapar(e.metodo_calidad)})</th></tr></thead>
      <tbody>${claves.map((k) => `<tr>
        <td><input type="checkbox" class="rev-param" value="${k}" checked></td>
        <td>${NOMBRE_PARAM[k] || k}</td>
        <td class="num"><b>${fmt.num(cal[k], k === "ph" ? 2 : 1)}</b></td>
        <td class="num sub">${e.calidad[k] != null ? fmt.num(e.calidad[k], k === "ph" ? 2 : 1) : "—"}</td></tr>`).join("")}</tbody></table>`
      : `<p class="pie">Este punto no trae parametros que el modelo conozca.${(a.puntos[punto]?.no_reconocidos || []).length ? " Sin mapear: " + escapar(a.puntos[punto].no_reconocidos.join(", ")) : ""}</p>`;
  };
  pintarTabla();
  $("rev-punto")?.addEventListener("change", pintarTabla);
  panel.querySelectorAll("input[name=rev-metodo]").forEach((r) => r.addEventListener("change", () => {
    panel.querySelectorAll(".opciones label").forEach((l) => l.classList.toggle("activo", l.querySelector("input").checked));
    $("rev-informe").hidden = panel.querySelector("input[name=rev-metodo]:checked").value !== "medido";
  }));
  $("btn-cerrar-revision").addEventListener("click", cerrarRevision);
  $("btn-aplicar-revision").addEventListener("click", async () => {
    const punto = $("rev-punto") ? $("rev-punto").value : puntoInicial;
    const cal = (a.puntos[punto] || { calidad: {} }).calidad;
    const elegidos = Object.fromEntries([...panel.querySelectorAll(".rev-param:checked")].map((c) => [c.value, cal[c.value]]));
    const metodo = panel.querySelector("input[name=rev-metodo]:checked").value;
    const conCaudal = $("rev-caudal").checked && caudal;
    if (!Object.keys(elegidos).length && !conCaudal) { $("rev-msg").textContent = "Marca al menos un parametro o el caudal."; return; }
    const informe = metodo === "medido" ? { laboratorio: $("rev-lab").value.trim(), informe: $("rev-inf").value.trim(), fecha: $("rev-fecha").value.trim(), muestras: $("rev-muestras").value, punto } : {};
    if (metodo === "medido" && !informe.laboratorio) { $("rev-msg").textContent = "Para marcar como medido hay que citar el laboratorio."; return; }
    if (!confirm(`Aplicar a ${e.nombre} como ${metodo}: ${Object.keys(elegidos).join(", ") || "sin parametros"}${conCaudal ? " y caudal " + caudal + " m³/h" : ""}. ¿Continuar?`)) return;
    $("btn-aplicar-revision").disabled = true;
    try {
      await pedir("/api/scout/declarar", { clave: e.clave, calidad: elegidos, caudal_m3_h: conCaudal ? caudal : null, fuente: doc.nombre, radio_km: estado.radio, metodo, informe });
      anotar(`${escapar(e.nombre)}: ${Object.keys(elegidos).length} parametro(s) aplicados como <b>${metodo}</b> desde ${escapar(doc.nombre)}`, "ok", "confianza y puntaje recalculados");
      cerrarRevision();
      await cargarBarrido({ refrescar: true });
    } catch (err) { $("rev-msg").textContent = err.message; $("btn-aplicar-revision").disabled = false; }
  });
}

function bloqueResumen(r) {
  if (r.cargando) return `<p class="cargando">Resumiendo el documento…</p>`;
  if (r.error) return `<div class="error" style="margin-top:8px">${escapar(r.error)}</div>`;
  return `<div class="info-caja" style="margin-top:8px"><b>${escapar(r.titulo)}</b><br>${escapar(r.resumen)}
    ${(r.puntos_clave || []).length ? `<ul style="margin:6px 0 0;padding-left:18px">${r.puntos_clave.map((x) => `<li>${escapar(x)}</li>`).join("")}</ul>` : ""}
    ${r.caudal_m3_h ? `<p class="pie" style="margin:6px 0 0">Caudal declarado: <b>${r.caudal_m3_h} m³/h</b></p>` : ""}</div>`;
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
  const e = todas().find((x) => x.clave === elegida);
  if (!e) { caja.innerHTML = `<div class="vec-vacio">Elige una empresa de la lista para ver su dossier.</div>`; return; }
  const f = e.ficha, c = e.calidad, ix = e.indices || {};
  const plan = e.notas.split(" | ").find((t) => t.startsWith("Plan:") || t.startsWith("No viable")) || "";
  const tramites = permisosDe(e);
  const primero = tramites[0];

  caja.innerHTML = `
    <div class="cabecera" style="margin-bottom:14px">
      <div>
        <h2 style="font-size:20px;font-weight:660">${escapar(e.nombre)}</h2>
        <p class="sub" style="margin:2px 0 8px">${escapar(e.sector)} · ${escapar(e.corriente)} · ${e.distancia_conduccion_km.toFixed(1)} km de conduccion</p>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${chip(f.estado, "ok")} ${sello(e.metodo_calidad)} ${barraConfianza(e)}
          ${primero ? chip(`permiso ${escapar(nombreAutoridad(primero.autoridad))}`, "azul") : chip("sin permiso localizado", "aviso")}</div>
      </div>
      <div class="acciones-cab">
        <button class="pequeno btn-simulador" title="Llevar este vecino al simulador de la torre">Añadir al simulador</button>
        <button class="secundario pequeno btn-analizar" ${cartera.extraccion_ia.disponible ? "" : `disabled title="${escapar(cartera.extraccion_ia.motivo)}"`}>Analizar expediente con IA</button>
        <button class="secundario pequeno btn-ficha">Editar ficha</button>
        <a class="chip neutra sin-punto" href="#vital?q=${encodeURIComponent(e.nombre.split(/ - | S\\.A/i)[0])}">Buscar en VITAL</a>
        ${f.en_cartera ? `<button class="secundario pequeno btn-quitar">Quitar de la cartera</button>`
                       : `<button class="pequeno btn-seguir-dossier">Seguir en cartera</button>`}
      </div>
    </div>
    <div class="rejilla kpis" style="grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
      ${kpi("Caudal", `${fmt.num(e.caudal_m3_h, 1)} m³/h`, sello(e.metodo_caudal))}
      ${kpi("Puntaje", (e.puntaje || 0).toFixed(1), "de simbiosis")}
      ${kpi("Confianza", e.confianza.toFixed(2), e.confianza_etiqueta)}
      ${kpi("Etapa", `<span style="font-size:18px;text-transform:capitalize">${escapar(f.estado)}</span>`, f.responsable ? "resp. " + escapar(f.responsable) : "sin responsable")}
    </div>

    ${bloquePermisos(e, tramites)}

    <div class="rejilla dos">
      <div class="tarjeta">
        <h3>Ficha comercial</h3>
        <dl class="pares">
          <dt>Responsable</dt><dd>${escapar(f.responsable || "—")}</dd>
          <dt>Contacto</dt><dd>${escapar(f.contacto || "—")}</dd>
          <dt>Siguiente paso</dt><dd>${escapar(f.proximo_paso || f.requisito || "—")}</dd>
          ${f.notas ? `<dt>Notas</dt><dd>${escapar(f.notas)}</dd>` : ""}
          <dt>Actualizada</dt><dd>${fechaCorta(f.actualizado) || "sin ficha todavia"}</dd>
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

    ${bloqueTrabajo(e)}

    <div class="tarjeta bloque" style="margin-top:14px">
      <h3>Documentos guardados <span class="nota">junto al resto de la evidencia de la empresa</span></h3>
      ${bloqueDocumentos(e)}
    </div>

    <div class="tarjeta bloque">
      <h3>Procedencia de los datos</h3>
      <ul class="refs">${(e.referencias || []).map((r) => `<li><code>${escapar(r.fuente)}</code> · ${escapar(r.identificador)}${r.descripcion ? " — " + escapar(r.descripcion) : ""}${r.url ? ` · <a href="${escapar(r.url)}" target="_blank" rel="noopener">ver</a>` : ""}</li>`).join("")}</ul>
    </div>`;

  // -- acciones ------------------------------------------------------------
  caja.querySelector(".btn-ficha").addEventListener("click", () => abrirPanel(e.clave));
  caja.querySelector(".btn-simulador").addEventListener("click", () => {
    estado.simuladorPendientes = [...(estado.simuladorPendientes || []), e.clave];
    anotar(`<b>${escapar(e.nombre)}</b> pasa al simulador de la torre`, "azul");
    location.hash = "#simulador";
  });
  caja.querySelector(".btn-seguir-dossier")?.addEventListener("click", (ev) => { ev.target.disabled = true; seguir(e.clave, e.nombre); });
  caja.querySelector(".btn-analizar")?.addEventListener("click", (ev) => analizarExpedientes([e.clave], ev.target));
  caja.querySelector(".btn-vital-vivo")?.addEventListener("click", () => { delete enVital[e.clave]; pintarDossier(); cargarEnVital(e, "vivo"); });
  caja.querySelector(".btn-vital-todos")?.addEventListener("click", () => { verTodoVital = !verTodoVital; pintarDossier(); });
  caja.querySelectorAll(".btn-vincular-grupo").forEach((b) => b.addEventListener("click", () => {
    const ya = new Set(tramites.map((t) => t.identificador));
    const grupos = enVital[e.clave].expedientes.filter((g) => !ya.has(g.expediente || g.radicado));
    vincularGrupo(e, grupos[Number(b.dataset.i)], b);
  }));
  if (!enVital[e.clave]) cargarEnVital(e);
  caja.querySelectorAll(".btn-revisar").forEach((b) => b.addEventListener("click", () => abrirRevision(e, b.dataset.ruta)));
  caja.querySelector(".btn-quitar")?.addEventListener("click", async () => {
    if (!confirm(`¿Quitar ${e.nombre} de la cartera? La ficha y sus documentos se conservan.`)) return;
    await pedir("/api/scout/ficha", { clave: e.clave, nombre: e.nombre, en_cartera: false });
    anotar(`${escapar(e.nombre)} sale de la cartera`, "neutra");
    await cargarBarrido({ refrescar: true });
  });
  caja.querySelector(".btn-solicitud")?.addEventListener("click", () => {
    const box = caja.querySelector(".caja-solicitud"); box.hidden = !box.hidden;
    box.querySelector(".txt-solicitud").value = textoSolicitud({
      empresa: e.nombre, autoridad: nombreAutoridad(primero.autoridad), expediente: primero.expediente || primero.identificador,
    });
  });
  caja.querySelector(".btn-permisos-todos")?.addEventListener("click", () => { verTodosPermisos = !verTodosPermisos; pintarDossier(); });
  caja.querySelector(".vec-permisos-otros")?.addEventListener("toggle", (ev) => { if (tramites.length) otrosTramitesAbierto = ev.target.open; });
  caja.querySelectorAll(".vec-copiar").forEach((b) => b.addEventListener("click", async () => {
    b.textContent = (await copiar(b.dataset.copiar)) ? "Copiado" : "No se pudo";
    setTimeout(() => { b.textContent = "Copiar"; }, 1600);
  }));
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
  caja.querySelectorAll(".btn-resumir").forEach((b) => b.addEventListener("click", () => resumirDocumento(b.dataset.ruta)));
  // Resumenes ya generados: se muestran sin llamar al modelo.
  (e.ficha.documentos || []).forEach(async (d) => {
    if (resumenes[d.ruta] || resumenesPedidos.has(d.ruta)) return;
    resumenesPedidos.add(d.ruta);
    try { const r = await fetch(`/api/asistente/documento/resumen?ruta=${encodeURIComponent(d.ruta)}`); if (r.ok) { resumenes[d.ruta] = await r.json(); pintarDossier(); } }
    catch { /* sin resumen */ }
  });
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

async function resumirDocumento(ruta) {
  resumenes[ruta] = { cargando: true }; pintarDossier();
  try {
    resumenes[ruta] = await pedir("/api/asistente/documento/resumen", { ruta });
    anotar(`Documento resumido: <b>${escapar(resumenes[ruta].titulo)}</b>`, "ok", "el asistente ya lo conoce");
  } catch (err) { resumenes[ruta] = { error: err.message }; }
  pintarDossier();
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
  fijarEmpresaEnPantalla(elegida);
  pintarDossier();
}

/** Lo que el dossier necesita una sola vez: lote, revision y sondeo. */
export async function montarDossier() {
  $("btn-analizar-todos").addEventListener("click", (ev) => {
    const n = enCartera().length;
    if (!n) { alert("La cartera esta vacia: no hay expedientes que analizar."); return; }
    if (!confirm(`Analizar los expedientes de las ${n} empresa(s) en cartera. Descarga sus PDF de VITAL y los lee con IA (coste por documento). ¿Continuar?`)) return;
    analizarExpedientes([], ev.target);
  });
  $("velo").addEventListener("click", cerrarRevision);
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") cerrarRevision(); });
  empezarSondeo();
  bus.on("barrido", () => cargar().catch((e) => { $("empresa-dossier").innerHTML = `<div class="error">${escapar(e.message)}</div>`; }));
  if (!estado.barrido) await cargarBarrido();
  await cargar();
}

export async function refrescarDossier() { if (cartera) await cargar(); }
