/* Asistente de SIMBIA: conversa, consulta y actua con herramientas.
 *
 * La pantalla abre con un saludo, el orbe y acciones rapidas; al preguntar,
 * la conversacion ocupa su lugar. Cuando el asistente usa una herramienta
 * (buscar empresas, leer una ficha, simular la torre, abrir una pantalla) se
 * ve como un paso dentro de su respuesta: primero lo que esta haciendo y, al
 * acabar, lo que salio, con el detalle en un desplegable.
 *
 * La respuesta llega por trozos (SSE) y, si la voz esta activa, cada frase
 * completa se manda a leer sin esperar al final. El orbe late con la voz.
 * La conversacion es una sola aunque se vea en mas de un sitio: cada sitio
 * es una "vista" con su historial y su compositor.
 */

import { $, anotar, chip, escapar, estado, pedir } from "../comun.js";
import { crearOrbe } from "../orbe.js";

const historial = [];       // [{rol, contenido, bloques?, meta?}]
const vistas = {};          // nombre -> {historial, form, entrada, enviar, mic, inicio?}
let ia = null;
let iaPendiente = null;
let contextoClave = "";
let leerSolas = leerPreferenciaVoz();
let audio = null;           // reproduccion en curso: {elemento, fuente, analizador, raf}
let cola = null;            // cola de fragmentos de voz de la respuesta actual
let reconocimiento = null;
let ctxAudio = null;        // un solo AudioContext para toda la sesion
let orbeGrande = null;
let respondiendo = false;
let alNavegar = null;       // lo que hay que hacer antes de que el asistente abra otra pantalla

export function fijarEmpresaEnPantalla(clave) { contextoClave = clave || ""; }

const RAPIDAS = [
  "¿A quién visito primero y por qué?",
  "Sugiere la mejor mezcla y simúlala",
  "¿Cuánto ahorro da la prefactibilidad?",
  "¿Qué dicen los expedientes guardados?",
];

const ICONOS = {
  buscar: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>',
  ficha: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/></svg>',
  simular: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V11M11 20V5M17 20v-7M3 20h18"/></svg>',
  optimizar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.6 5.6 5.4.9-4 4 1 5.8-5-2.7-5 2.7 1-5.8-4-4 5.4-.9z"/></svg>',
  abrir: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/></svg>',
};

// Lo que cuenta la tarjeta "Actividad": cada paso terminado suma en su fila.
const ACTIVIDAD = [
  { clave: "buscar", etiqueta: "Búsquedas de vecinos", herramientas: ["buscar_empresas"] },
  { clave: "ficha", etiqueta: "Fichas leídas", herramientas: ["ver_empresa"] },
  { clave: "simular", etiqueta: "Simulaciones de la torre", herramientas: ["simular_mezcla", "sugerir_mezcla", "prefactibilidad"] },
  { clave: "abrir", etiqueta: "Pantallas abiertas", herramientas: ["abrir_en_panel"] },
];
const cuenta = Object.fromEntries(ACTIVIDAD.map((a) => [a.clave, 0]));
// La tarjeta de contexto resume: los documentos completos estan en Vecinos.
const MAX_DOCUMENTOS_LATERAL = 4;

const PUEDE = [
  { icono: "buscar", texto: "Buscar y comparar vecinos", ejemplo: "Busca las empresas de plásticos y compáralas" },
  { icono: "ficha", texto: "Leer fichas y expedientes", ejemplo: "¿Qué sabemos de Abocol y de dónde sale cada dato?" },
  { icono: "simular", texto: "Simular la torre con un vecino", ejemplo: "¿Qué pasa si tomo 15 m³/h de Dexton?" },
  { icono: "optimizar", texto: "Pedir la mejor mezcla", ejemplo: "Sugiere la mezcla más barata que cumpla la meta" },
  { icono: "abrir", texto: "Abrirte el gemelo o una ficha", ejemplo: "Abre el gemelo con la mezcla sugerida" },
];

// El modulo en el que esta el usuario, para que el asistente sepa de que le hablan.
window.addEventListener("hashchange", () => {
  const anterior = sessionStorage.getItem("simbia.modulo_actual") || "";
  sessionStorage.setItem("simbia.modulo_previo", anterior);
  sessionStorage.setItem("simbia.modulo_actual", (location.hash || "#inicio").slice(1).split("?")[0]);
});

function moduloActual() {
  const visible = document.body.dataset.modulo;
  if (visible && visible !== "asistente") return visible;
  return sessionStorage.getItem("simbia.modulo_previo") || "asistente";
}

function leerPreferenciaVoz() {
  try { return localStorage.getItem("simbia.asistente.voz") !== "no"; } catch { return true; }
}

export function cargarIA() {
  if (!iaPendiente) {
    iaPendiente = pedir("/api/asistente/estado")
      .catch((e) => ({ disponible: false, motivo: e.message }))
      .then((r) => { ia = r; return r; });
  }
  return iaPendiente;
}

// ---------------------------------------------------------------------------
// Orbe: estados y reaccion al audio
// ---------------------------------------------------------------------------

const ORBE_HTML = '<span class="orbe-anillo a1"></span><span class="orbe-anillo a2"></span><span class="orbe-anillo a3"></span>'
  + '<span class="orbe-halo"></span><span class="orbe-nucleo"></span><span class="orbe-barras"><i></i><i></i><i></i><i></i><i></i></span>';

function rellenarOrbes(raiz = document) {
  raiz.querySelectorAll("[data-orbe]").forEach((o) => { if (!o.childElementCount) o.innerHTML = ORBE_HTML; });
}

const MENSAJE_ESTADO = {
  reposo: "Lista para ayudarte",
  escuchando: "Te escucho…",
  pensando: "Pensando…",
  hablando: "Hablando",
  sin_ia: "Sin proveedor de IA configurado",
};

function estadoActual() { return document.querySelector("[data-orbe]")?.dataset.estado || "reposo"; }

function ponerEstado(nombre, texto) {
  document.querySelectorAll("[data-orbe]").forEach((o) => {
    o.dataset.estado = nombre;
    if (nombre !== "hablando") o.style.setProperty("--amp", "1");
  });
  document.querySelectorAll("[data-orbe-estado]").forEach((e) => { e.textContent = texto || MENSAJE_ESTADO[nombre] || ""; });
  orbeGrande?.estado(nombre);
}

function ponerAmplitud(media, bandas) {
  document.querySelectorAll("[data-orbe]").forEach((o) => {
    o.style.setProperty("--amp", (1 + Math.min(media * 1.6, 0.45)).toFixed(3));
    bandas.forEach((b, i) => o.style.setProperty(`--b${i + 1}`, b.toFixed(3)));
  });
  orbeGrande?.amplitud(media * 1.4);
}

function detenerAudio() {
  if (cola) { cola.cancelada = true; cola = null; }
  if (audio) {
    cancelAnimationFrame(audio.raf);
    audio.elemento.pause();
    try { audio.fuente.disconnect(); audio.analizador.disconnect(); } catch { /* ya desconectado */ }
    audio = null;
  }
  ponerAmplitud(0, [0.15, 0.15, 0.15, 0.15, 0.15]);
  orbeGrande?.amplitud(0);
  if (estadoActual() === "hablando") ponerEstado("reposo");
}

/** Parte un texto en fragmentos de unas pocas frases, para leerlo por trozos. */
export function fragmentarParaVoz(texto, maxCaracteres = 260) {
  const frases = texto.replace(/\s+/g, " ").match(/[^.!?…]+[.!?…]+["»)]?\s*|[^.!?…]+$/g) || [texto];
  const trozos = [];
  let actual = "";
  for (const f of frases) {
    if (actual && (actual + f).length > maxCaracteres) { trozos.push(actual.trim()); actual = ""; }
    actual += f;
  }
  if (actual.trim()) trozos.push(actual.trim());
  return trozos.filter(Boolean);
}

function contextoAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!ctxAudio) ctxAudio = new Ctx();
  return ctxAudio;
}

async function prepararFragmento(texto) {
  const r = await fetch("/api/asistente/voz/preparar", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texto }),
  });
  if (!r.ok) throw new Error((await r.json()).detail || `${r.status}`);
  const { url } = await r.json();
  // preload=auto: el navegador empieza a descargar (y el servidor a generar)
  // antes de que toque reproducirlo. Asi el siguiente fragmento entra sin hueco.
  const elemento = new Audio(url);
  elemento.preload = "auto";
  return elemento;
}

function reproducirElemento(elemento) {
  return new Promise((resolver, rechazar) => {
    const ctx = contextoAudio();
    const fuente = ctx.createMediaElementSource(elemento);
    const analizador = ctx.createAnalyser(); analizador.fftSize = 256; analizador.smoothingTimeConstant = 0.7;
    fuente.connect(analizador); analizador.connect(ctx.destination);
    audio = { elemento, fuente, analizador, raf: 0 };
    const datos = new Uint8Array(analizador.frequencyBinCount);
    const animar = () => {
      if (!audio || audio.elemento !== elemento) return;
      analizador.getByteFrequencyData(datos);
      // La voz humana vive en los bins bajos: se pondera esa banda.
      const voz = datos.subarray(2, 40);
      let suma = 0; for (const v of voz) suma += v;
      const tramo = Math.floor(voz.length / 5);
      const bandas = [];
      for (let i = 0; i < 5; i++) {
        let pico = 0; for (let j = i * tramo; j < (i + 1) * tramo; j++) pico = Math.max(pico, voz[j]);
        bandas.push(Math.max(0.15, Math.min(pico / 255 * 1.3, 1)));
      }
      ponerAmplitud(suma / voz.length / 255, bandas);
      audio.raf = requestAnimationFrame(animar);
    };
    elemento.addEventListener("playing", () => { ponerEstado("hablando"); animar(); }, { once: true });
    elemento.addEventListener("ended", () => { try { fuente.disconnect(); analizador.disconnect(); } catch { /* nada */ } resolver(); }, { once: true });
    elemento.addEventListener("error", () => rechazar(new Error("no se pudo reproducir el audio")), { once: true });
    ctx.resume().then(() => elemento.play()).catch(rechazar);
  });
}

/** Lee una lista de fragmentos en orden; `cola.anadir` acepta mas mientras suena. */
function nuevaCola() {
  const c = { fragmentos: [], preparados: [], cancelada: false, cerrada: false, corriendo: false };
  c.anadir = (texto) => { if (!c.cancelada) { c.fragmentos.push(texto); c.preparados.push(prepararFragmento(texto).catch((e) => e)); c.correr(); } };
  c.cerrar = () => { c.cerrada = true; };
  c.correr = async () => {
    if (c.corriendo) return;
    c.corriendo = true;
    let i = 0;
    try {
      while (!c.cancelada && (i < c.preparados.length || !c.cerrada)) {
        if (i >= c.preparados.length) { await new Promise((r) => setTimeout(r, 120)); continue; }
        const elemento = await c.preparados[i++];
        if (c.cancelada) break;
        if (elemento instanceof Error) throw elemento;
        await reproducirElemento(elemento);
      }
    } catch (e) {
      anotar(`Voz: ${escapar(e.message)}`, "alerta");
    } finally {
      c.corriendo = false;
      if (cola === c) { cola = null; detenerAudio(); }
    }
  };
  return c;
}

function hablar(texto) {
  detenerAudio();
  if (!ia?.voz) return;
  cola = nuevaCola();
  fragmentarParaVoz(texto).forEach((t) => cola.anadir(t));
  cola.cerrar();
}

// ---------------------------------------------------------------------------
// Mensajes y pasos
// ---------------------------------------------------------------------------

const VINETA = /^\s*(?:[-•*]|\d+[.)])\s+/;

/** Negritas, parrafos y listas: lo poco de Markdown que usa el asistente. */
function formatear(texto) {
  return escapar(texto || "").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").split(/\n{2,}/).map((parrafo) => {
    let html = "", lista = [], linea = [];
    const cerrarLista = () => { if (lista.length) { html += `<ul>${lista.map((l) => `<li>${l}</li>`).join("")}</ul>`; lista = []; } };
    const cerrarLinea = () => { if (linea.length) { html += `<p>${linea.join("<br>")}</p>`; linea = []; } };
    for (const l of parrafo.split("\n")) {
      if (VINETA.test(l)) { cerrarLinea(); lista.push(l.replace(VINETA, "")); } else { cerrarLista(); linea.push(l); }
    }
    cerrarLista(); cerrarLinea();
    return html;
  }).join("");
}

const num = (v, d = 0) => Number(v).toLocaleString("es", { minimumFractionDigits: d, maximumFractionDigits: d });

function htmlPaso(p, indice) {
  const icono = p.estado === "en_curso" ? "" : p.estado === "error" ? "!" : "✓";
  const detalle = (p.detalle || []).map(([k, v]) => `<dt>${escapar(k)}</dt><dd>${escapar(v)}</dd>`).join("");
  const cuerpo = detalle
    ? `<details data-paso="${indice}:${escapar(p.id)}"${p.abierto ? " open" : ""}><summary>${escapar(p.texto)}</summary><dl>${detalle}</dl></details>`
    : `<span>${escapar(p.texto)}</span>`;
  return `<li class="paso ${escapar(p.estado)}"><span class="paso-icono" aria-hidden="true">${icono}</span>${cuerpo}</li>`;
}

function htmlMensaje(m, i, escribiendo) {
  if (m.rol === "usuario") {
    return `<article class="mensaje usuario"><div class="mensaje-burbuja">${escapar(m.contenido)}</div></article>`;
  }
  let cuerpo = "", grupo = [];
  const cerrarGrupo = () => { if (grupo.length) { cuerpo += `<ol class="pasos">${grupo.join("")}</ol>`; grupo = []; } };
  for (const b of m.bloques || [{ tipo: "texto", texto: m.contenido }]) {
    if (b.tipo === "paso") { grupo.push(htmlPaso(b, i)); continue; }
    cerrarGrupo();
    if (b.texto?.trim()) cuerpo += `<div class="mensaje-contenido">${formatear(b.texto)}</div>`;
  }
  cerrarGrupo();
  if (!cuerpo) cuerpo = `<div class="mensaje-contenido pensando">Analizando…</div>`;
  const meta = m.meta
    ? `<span class="mensaje-meta">${m.meta.rondas > 1 ? `${m.meta.rondas} rondas · ` : ""}${num(m.meta.segundos, 1)} s · ${num(m.meta.tokens)} tokens</span>`
    : "";
  const acciones = !escribiendo && m.contenido
    ? `<div class="mensaje-acciones">
        <button class="secundario" data-accion="copiar" data-indice="${i}">Copiar</button>
        ${ia?.voz ? `<button class="secundario" data-accion="escuchar" data-indice="${i}">Escuchar</button>` : ""}
      </div>`
    : "";
  return `<article class="mensaje asistente">
    <span class="mensaje-avatar" aria-hidden="true"></span>
    <div><div class="mensaje-cabecera">SIMBIA ${meta}</div>${cuerpo}${escribiendo ? '<span class="cursor-respuesta"></span>' : ""}${acciones}</div>
  </article>`;
}

function pintarHistorial(escribiendo = false, forzarAbajo = false) {
  for (const v of Object.values(vistas)) {
    const vacio = !historial.length;
    if (v.inicio) { v.inicio.hidden = !vacio; v.historial.hidden = vacio; }
    if (vacio) { v.historial.innerHTML = v.vacio ? v.vacio() : ""; continue; }
    const caja = v.historial;
    const pegado = caja.scrollHeight - caja.scrollTop - caja.clientHeight < 90;
    caja.innerHTML = historial.map((m, i) => htmlMensaje(m, i, escribiendo && i === historial.length - 1)).join("");
    if (pegado || forzarAbajo) caja.scrollTop = caja.scrollHeight;
  }
}

function registrarPaso(respuesta, p) {
  const existente = respuesta.bloques.find((b) => b.tipo === "paso" && b.id === p.id);
  if (existente) Object.assign(existente, p); else respuesta.bloques.push({ tipo: "paso", ...p });
  if (p.estado === "en_curso") ponerEstado("pensando", p.texto);
  if (p.estado === "hecho") {
    const fila = ACTIVIDAD.find((a) => a.herramientas.includes(p.herramienta));
    if (fila) { cuenta[fila.clave] += 1; pintarActividad(); }
  }
}

// ---------------------------------------------------------------------------
// Acciones: lo que el asistente abre en el panel
// ---------------------------------------------------------------------------

function irA(hash) {
  const destino = hash.slice(1).split("?")[0];
  const mismo = document.body.dataset.modulo === destino;
  alNavegar?.();
  location.hash = hash;
  // El enrutador no repite un modulo que ya esta en pantalla: se le avisa.
  if (mismo) window.dispatchEvent(new Event("simbia:mostrar"));
}

function ejecutarAccion(a) {
  if (a?.tipo === "gemelo" && Array.isArray(a.tomas)) {
    estado.simuladorPendientes = [...(estado.simuladorPendientes || []), ...a.tomas];
    irA("#simulador");
  } else if (a?.tipo === "navegar" && /^#[a-z]+(\?[a-z_]+=[\w-]+)?$/.test(a.hash || "")) {
    irA(a.hash);
  }
}

// ---------------------------------------------------------------------------
// Preguntar
// ---------------------------------------------------------------------------

function ajustar(entrada) {
  entrada.style.height = "auto";
  entrada.style.height = `${Math.min(entrada.scrollHeight, 150)}px`;
}

function bloquear(si) {
  for (const v of Object.values(vistas)) v.enviar.disabled = si;
}

async function preguntar(texto, vista) {
  texto = (texto || "").trim();
  if (!texto || respondiendo) return;
  await cargarIA();
  if (!ia?.disponible) return;
  respondiendo = true;
  detenerAudio();
  if (vista?.entrada) { vista.entrada.value = ""; ajustar(vista.entrada); }
  const previo = historial.slice(-12).map(({ rol, contenido }) => ({ rol, contenido }));
  historial.push({ rol: "usuario", contenido: texto });
  const respuesta = { rol: "asistente", contenido: "", bloques: [], meta: null };
  historial.push(respuesta);
  pintarHistorial(true, true);
  ponerEstado("pensando");
  bloquear(true);

  // Si hay voz, cada frase completa se manda a leer sin esperar al final.
  let leido = 0, abierto = null, rondas = 0, contexto = null;
  if (leerSolas && ia.voz) { detenerAudio(); cola = nuevaCola(); }
  const colaLocal = cola;
  const enviarFrases = (final) => {
    if (!colaLocal || colaLocal.cancelada) return;
    const pendiente = respuesta.contenido.slice(leido);
    if (final) { if (pendiente.trim()) colaLocal.anadir(pendiente.trim()); leido = respuesta.contenido.length; return; }
    const corte = Math.max(pendiente.lastIndexOf(". "), pendiente.lastIndexOf("? "), pendiente.lastIndexOf("! "), pendiente.lastIndexOf("\n"));
    if (corte >= 60) { colaLocal.anadir(pendiente.slice(0, corte + 1).trim()); leido += corte + 1; }
  };

  try {
    const r = await fetch("/api/asistente/preguntar/stream", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mensaje: texto, historial: previo, modulo: moduloActual(), clave: contextoClave, radio_km: estado.radio }),
    });
    if (r.status === 401) { location.replace("/acceso"); return; }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `${r.status}`);
    const lector = r.body.getReader(), decodificador = new TextDecoder();
    let resto = "";
    for (;;) {
      const { value, done } = await lector.read();
      if (done) break;
      resto += decodificador.decode(value, { stream: true });
      const tramas = resto.split("\n\n"); resto = tramas.pop();
      for (const trama of tramas) {
        const linea = trama.split("\n").find((l) => l.startsWith("data: "));
        if (!linea) continue;
        const d = JSON.parse(linea.slice(6));
        if (d.error) throw new Error(d.error);
        if (d.delta) {
          if (!abierto) { abierto = { tipo: "texto", texto: "" }; respuesta.bloques.push(abierto); }
          abierto.texto += d.delta;
          respuesta.contenido += d.delta;
          if (estadoActual() !== "hablando") ponerEstado("reposo", "Respondiendo…");
          enviarFrases(false);
        }
        if (d.paso) { abierto = null; registrarPaso(respuesta, d.paso); }
        if (d.accion) ejecutarAccion(d.accion);
        if (d.ronda) rondas = d.ronda.n;
        if (d.fin) { contexto = d.contexto; respuesta.meta = { rondas, segundos: d.segundos, tokens: d.tokens }; }
      }
      pintarHistorial(true);
    }
    respuesta.contenido = respuesta.contenido.trim();
    enviarFrases(true);
    colaLocal?.cerrar();
    if (estadoActual() !== "hablando") ponerEstado("reposo", "Respondido. ¿Algo más?");
    if (contexto?.documentos_sin_resumen) anotar(`${contexto.documentos_sin_resumen} documento(s) sin resumen: el asistente no los conoce`, "aviso");
    pintarSabe();
  } catch (e) {
    colaLocal?.cerrar();
    const aviso = `No pude responder: ${e.message}`;
    respuesta.bloques.push({ tipo: "texto", texto: aviso });
    respuesta.contenido = (respuesta.contenido ? `${respuesta.contenido}\n\n` : "") + aviso;
    ponerEstado("reposo", "Algo falló. Inténtalo de nuevo.");
  } finally {
    respondiendo = false;
    // Un paso que quedo a medias (se corto la conexion) no puede seguir girando.
    for (const b of respuesta.bloques) if (b.tipo === "paso" && b.estado === "en_curso") b.estado = "error";
    bloquear(false);
    pintarHistorial();
    vista?.entrada?.focus();
  }
}

// ---------------------------------------------------------------------------
// Dictado
// ---------------------------------------------------------------------------

function montarDictado(v) {
  const Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Reconocimiento) { v.mic.hidden = true; return; }
  v.mic.addEventListener("click", () => {
    if (reconocimiento) { reconocimiento.stop(); return; }
    detenerAudio();
    reconocimiento = new Reconocimiento();
    reconocimiento.lang = "es-CO"; reconocimiento.interimResults = true;
    v.mic.classList.add("grabando");
    ponerEstado("escuchando");
    const terminar = () => { reconocimiento = null; v.mic.classList.remove("grabando"); };
    reconocimiento.onresult = (ev) => { v.entrada.value = [...ev.results].map((r) => r[0].transcript).join(" "); ajustar(v.entrada); };
    reconocimiento.onend = () => {
      terminar();
      const t = v.entrada.value.trim();
      if (t) preguntar(t, v); else ponerEstado("reposo");
    };
    reconocimiento.onerror = () => { terminar(); ponerEstado("reposo", "No pude oírte."); };
    reconocimiento.start();
  });
}

// ---------------------------------------------------------------------------
// Vistas
// ---------------------------------------------------------------------------

async function alPulsarEnHistorial(ev) {
  const sugerencia = ev.target.closest("[data-pregunta]");
  if (sugerencia) { preguntar(sugerencia.dataset.pregunta, vistaDe(ev.currentTarget)); return; }
  const boton = ev.target.closest("[data-accion]");
  if (!boton) return;
  const mensaje = historial[Number(boton.dataset.indice)];
  if (!mensaje) return;
  if (boton.dataset.accion === "escuchar") { hablar(mensaje.contenido); return; }
  try { await navigator.clipboard.writeText(mensaje.contenido); boton.textContent = "Copiado"; }
  catch { boton.textContent = "No se pudo"; }
  setTimeout(() => { boton.textContent = "Copiar"; }, 1400);
}

/** Recuerda que desplegables estan abiertos: el historial se repinta en cada trozo. */
function alDesplegar(ev) {
  const d = ev.target;
  if (!d.matches?.("details[data-paso]")) return;
  const [i, id] = [d.dataset.paso.slice(0, d.dataset.paso.indexOf(":")), d.dataset.paso.slice(d.dataset.paso.indexOf(":") + 1)];
  const paso = historial[Number(i)]?.bloques?.find((b) => b.tipo === "paso" && b.id === id);
  if (paso) paso.abierto = d.open;
}

function vistaDe(caja) { return Object.values(vistas).find((v) => v.historial === caja); }

export function montarVista(nombre, v) {
  vistas[nombre] = v;
  v.form.addEventListener("submit", (ev) => { ev.preventDefault(); preguntar(v.entrada.value, v); });
  v.entrada.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); preguntar(v.entrada.value, v); }
  });
  v.entrada.addEventListener("input", () => ajustar(v.entrada));
  v.historial.addEventListener("click", alPulsarEnHistorial);
  v.historial.addEventListener("toggle", alDesplegar, true);
  montarDictado(v);
  pintarHistorial();
}

export function alAbrirPantalla(fn) { alNavegar = fn; }

// ---------------------------------------------------------------------------
// Pantalla completa: saludo y tarjetas
// ---------------------------------------------------------------------------

function saludo() {
  const h = new Date().getHours();
  const parte = h < 12 ? "Buenos días" : h < 19 ? "Buenas tardes" : "Buenas noches";
  // Solo el nombre que se le puso a la cuenta: el usuario del correo
  // ("estebanmanuel66") no es un nombre con el que saludar a nadie.
  let nombre = (estado.sesion?.nombre || "").trim().split(/\s+/)[0] || "";
  if (nombre) nombre = nombre[0].toUpperCase() + nombre.slice(1);
  return nombre ? `${parte}, ${nombre}` : parte;
}

function pintarActividad() {
  const caja = $("asistente-actividad");
  if (!caja) return;
  caja.innerHTML = ACTIVIDAD.map((a) =>
    `<li>${ICONOS[a.clave]}<span>${a.etiqueta}</span><b>${cuenta[a.clave]}</b></li>`).join("");
}

function pintarPuede() {
  const caja = $("asistente-puede");
  if (!caja) return;
  caja.innerHTML = PUEDE.map((p) =>
    `<li><button type="button" data-ejemplo="${escapar(p.ejemplo)}" title="${escapar(p.ejemplo)}">${ICONOS[p.icono]}<span>${p.texto}</span></button></li>`).join("");
  caja.querySelectorAll("[data-ejemplo]").forEach((b) => b.addEventListener("click", () => {
    const entrada = $("asistente-entrada");
    entrada.value = b.dataset.ejemplo; ajustar(entrada); entrada.focus();
  }));
}

async function pintarSabe() {
  const caja = $("asistente-sabe");
  if (!caja || !ia?.disponible) return;
  try {
    const c = await pedir(`/api/asistente/contexto?radio_km=${estado.radio}&clave=${encodeURIComponent(contextoClave)}`);
    const sinResumen = c.documentos.filter((d) => !d.con_resumen);
    const fuente = c.modo_fuentes === "live" ? "Fuentes públicas consultadas" : "Fuentes públicas verificadas";
    caja.innerHTML = `
      <div class="sabe-fila">${chip(`${c.prospectos} vecinos`, "neutra")} ${chip(`${c.cartera.length} en cartera`, c.cartera.length ? "ok" : "neutra")}
        ${chip(`${c.documentos.length} documentos`, "neutra")}</div>
      ${c.empresa_en_pantalla ? `<p class="pie">En pantalla: <b>${escapar(c.empresa_en_pantalla)}</b></p>` : ""}
      <p class="pie">${escapar(fuente)} · radio de ${estado.radio} km.</p>
      ${c.cartera.length ? `<p class="pie">Cartera: ${c.cartera.map(escapar).join(", ")}.</p>` : ""}
      ${c.documentos.length ? `<p class="pie">${c.documentos.length} documento${c.documentos.length === 1 ? "" : "s"} guardado${c.documentos.length === 1 ? "" : "s"} · ${c.documentos.length - sinResumen.length} analizado${c.documentos.length - sinResumen.length === 1 ? "" : "s"}.</p>
        <ul class="refs">${[...sinResumen, ...c.documentos.filter((d) => d.con_resumen)].slice(0, MAX_DOCUMENTOS_LATERAL).map((d) =>
          `<li><span class="doc-nombre" title="${escapar(`${d.archivo} · ${d.empresa}`)}">📄 ${escapar(d.empresa)} · ${escapar(d.archivo)}</span>${d.con_resumen ? chip("analizado", "ok") : chip("pendiente", "aviso")}</li>`).join("")}</ul>
        ${c.documentos.length > MAX_DOCUMENTOS_LATERAL ? `<p class="pie">y ${c.documentos.length - MAX_DOCUMENTOS_LATERAL} más en Vecinos.</p>` : ""}` : ""}
      ${sinResumen.length ? `<p class="pie" style="color:var(--aviso)">${sinResumen.length} pendiente${sinResumen.length === 1 ? "" : "s"} de análisis en Vecinos.</p>` : ""}`;
  } catch (e) {
    caja.innerHTML = `<p class="pie">${escapar(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Flotante: la misma conversacion en cualquier pantalla del panel
// ---------------------------------------------------------------------------

function rapidasFlotante() {
  const modulo = moduloActual();
  if (modulo === "simulador") return ["Sugiere la mejor mezcla y ábremela en el gemelo", "¿Qué pasa si tomo 15 m³/h de Dexton?"];
  if (modulo === "prospeccion" && contextoClave) return ["¿Qué sabemos de la empresa en pantalla?", "Simula la torre con esta empresa"];
  return RAPIDAS.slice(0, 3);
}

function vacioFlotante() {
  return `<div class="flot-vacio">
    <p class="flot-saludo">${escapar(saludo())}</p>
    <p>Pregúntame por los vecinos, simula una mezcla o pídeme que te abra algo.</p>
    <div class="flot-rapidas">${rapidasFlotante().map((s) => `<button type="button" data-pregunta="${escapar(s)}">${escapar(s)}</button>`).join("")}</div>
  </div>`;
}

function abrirFlotante(enfocar = true) {
  const panel = $("asis-flotante");
  if (!panel || !vistas.flotante) return;
  panel.hidden = false;
  $("asis-lanzador").hidden = true;
  $("asis-lanzador").setAttribute("aria-expanded", "true");
  try { sessionStorage.setItem("simbia.asistente.flotante", "abierto"); } catch { /* sin almacenamiento */ }
  pintarHistorial(false, true);
  if (enfocar) $("flot-entrada").focus();
}

function cerrarFlotante() {
  $("asis-flotante").hidden = true;
  $("asis-lanzador").hidden = false;
  $("asis-lanzador").setAttribute("aria-expanded", "false");
  try { sessionStorage.setItem("simbia.asistente.flotante", "cerrado"); } catch { /* sin almacenamiento */ }
}

/** Se llama al arrancar el panel: el lanzador aparece si hay IA con la que hablar. */
export async function iniciarFlotante() {
  if (!$("asis-flotante")) return;
  rellenarOrbes();
  await cargarIA();
  if (!ia?.disponible) return;
  montarVista("flotante", {
    historial: $("flot-historial"), form: $("flot-form"), entrada: $("flot-entrada"),
    enviar: $("flot-enviar"), mic: $("flot-mic"), vacio: vacioFlotante,
  });
  $("asis-lanzador").hidden = false;
  $("asis-lanzador").addEventListener("click", () => abrirFlotante());
  $("flot-cerrar").addEventListener("click", () => { cerrarFlotante(); $("asis-lanzador").focus(); });
  // "Abrir en grande" navega a #asistente con su enlace; la ventana se cierra.
  $("flot-ampliar").addEventListener("click", cerrarFlotante);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("asis-flotante").hidden && $("asis-flotante").contains(document.activeElement)) cerrarFlotante();
  });
  // Si el asistente abre otra pantalla desde la suya, la conversacion sigue
  // encima, en la ventana flotante.
  alAbrirPantalla(() => { if (document.body.dataset.modulo === "asistente") abrirFlotante(false); });
  // Al cambiar de pantalla, las sugerencias del flotante vacio cambian con ella.
  window.addEventListener("hashchange", () => { if (!historial.length) pintarHistorial(); });
  let abierto = false;
  try { abierto = sessionStorage.getItem("simbia.asistente.flotante") === "abierto"; } catch { /* sin almacenamiento */ }
  if (abierto) abrirFlotante(false);
  ponerEstado("reposo");
}

function nuevaConversacion() {
  historial.length = 0;
  for (const k of Object.keys(cuenta)) cuenta[k] = 0;
  detenerAudio();
  pintarHistorial();
  pintarActividad();
  ponerEstado(ia?.disponible ? "reposo" : "sin_ia", ia?.disponible ? undefined : ia?.motivo);
}

export default {
  id: "asistente",
  async montar() {
    rellenarOrbes();
    montarVista("pagina", {
      historial: $("asistente-historial"), inicio: $("asistente-inicio"), form: $("asistente-form"),
      entrada: $("asistente-entrada"), enviar: $("asistente-enviar"), mic: $("asistente-mic"),
    });
    $("asistente-rapidas").innerHTML = RAPIDAS.map((s) => `<button type="button" data-pregunta="${escapar(s)}">${escapar(s)}</button>`).join("");
    $("asistente-rapidas").addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-pregunta]");
      if (b) preguntar(b.dataset.pregunta, vistas.pagina);
    });
    $("asistente-limpiar").addEventListener("click", nuevaConversacion);
    $("asistente-voz").addEventListener("click", (ev) => {
      leerSolas = !leerSolas;
      ev.currentTarget.setAttribute("aria-pressed", String(leerSolas));
      try { localStorage.setItem("simbia.asistente.voz", leerSolas ? "si" : "no"); } catch { /* sin almacenamiento */ }
      if (!leerSolas) detenerAudio();
    });
    try { orbeGrande = crearOrbe($("asistente-orbe")); } catch { $("asistente-orbe").hidden = true; }
    pintarActividad();
    pintarPuede();

    await cargarIA();
    const modeloVisible = ia?.modelo === "gpt-5.4-mini" ? "GPT-5.4 mini · análisis activo" : ia?.modelo;
    $("asistente-chip").innerHTML = ia.disponible ? chip(escapar(modeloVisible), "ok") : chip("IA no configurada", "aviso");
    $("asistente-voz").hidden = !(ia.disponible && ia.voz);
    $("asistente-voz").setAttribute("aria-pressed", String(leerSolas));
    if (!ia.disponible) {
      ponerEstado("sin_ia", ia.motivo);
      $("asistente-sub").textContent = "Solo falta conectar la IA: el servidor necesita una clave de OpenAI o de Anthropic. El resto del panel funciona igual.";
      $("asistente-rapidas").hidden = true;
      $("asistente-entrada").disabled = true; $("asistente-enviar").disabled = true;
      $("asistente-sabe").innerHTML = `<p class="pie">Sin proveedor de IA no hay nada que consultar. ${escapar(ia.motivo)}</p>`;
    } else {
      ponerEstado("reposo");
    }
    pintarHistorial();
  },
  async mostrar() {
    $("asistente-saludo").textContent = saludo();
    if (ia?.disponible) pintarSabe();
  },
};
