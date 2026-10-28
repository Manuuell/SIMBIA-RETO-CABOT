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
import { crearConversacion, hayConversacion } from "../voz.js";

const historial = [];       // [{rol, contenido, bloques?, meta?}]
const vistas = {};          // nombre -> {historial, form, entrada, enviar, mic, inicio?}
let ia = null;
let iaPendiente = null;
let contextoClave = "";
let leerSolas = leerPreferenciaVoz();
let sonando = null;         // fragmento en curso: {buffer, fuente, inicio, posicion, terminar}
let cola = null;            // cola de fragmentos de voz de la respuesta actual
let reconocimiento = null;
let ctxAudio = null;        // un solo AudioContext para toda la sesion
let salidaVoz = null;       // analizador por el que pasa todo lo que dice el asistente
let animacion = 0;
let avisoSonido = false;
let turno = 0;              // cada pregunta abre uno; lo que acaba de uno viejo no toca la conversacion
let enCurso = null;         // la respuesta que se esta generando: {controlador, hecho}
let orbeGrande = null;
const orbes = [];           // los orbes de particulas: el grande y los de cabecera
let aterrizar = null;       // termina en el acto un vuelo del orbe a medias
let conv = null;            // modo conversacion por voz (voz.js)
let vistaConv = null;       // la vista donde se ve lo que se va dictando
const QUIETO = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// Radio de la esfera en fraccion del lienzo. El pequeno tiene un lienzo mayor
// que su hueco de cabecera (44 px + 9 por lado) para que nada se corte.
const RADIO_GRANDE = 0.33, RADIO_MINI = 0.25, HUECO_MINI = 44, LIENZO_MINI = 62;
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
  orbes.forEach((o) => o.estado(nombre));
}

function ponerAmplitud(media, bandas) {
  document.querySelectorAll("[data-orbe]").forEach((o) => {
    o.style.setProperty("--amp", (1 + Math.min(media * 1.6, 0.45)).toFixed(3));
    bandas.forEach((b, i) => o.style.setProperty(`--b${i + 1}`, b.toFixed(3)));
  });
  orbes.forEach((o) => o.amplitud(media * 1.4));
}

const REPOSO_BANDAS = [0.15, 0.15, 0.15, 0.15, 0.15];
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function detenerAudio() {
  if (cola) { cola.cancelada = true; cola = null; }
  if (sonando) {
    const s = sonando;
    sonando = null;
    soltarFuente(s);
    s.terminar();
  }
  cancelAnimationFrame(animacion);
  animacion = 0;
  ponerAmplitud(0, REPOSO_BANDAS);
  if (estadoActual() === "hablando") ponerEstado("reposo");
}

// ---------------------------------------------------------------------------
// Voz: cada fragmento se sintetiza entero, se decodifica y suena por Web Audio
// ---------------------------------------------------------------------------
//
// Asi un fallo se ve (codigo HTTP, audio vacio) y se reintenta o se salta sin
// dejar muda el resto de la respuesta; el fragmento se puede pausar y retomar
// donde iba (cuando parece que le hablan encima), y nunca se piden mas de dos
// voces a la vez.

/** Lo que se lee: sin marcas de Markdown y con cada linea terminada en pausa. */
export function textoParaVoz(texto) {
  return (texto || "").split("\n")
    .map((l) => l.replace(VINETA, "").replace(/[*#`]+/g, "").trim())
    .filter(Boolean)
    .map((l) => (/[.!?…:;,]$/.test(l) ? l : `${l}.`))
    .join(" ");
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

/** Despierta el audio dentro de un gesto del usuario: Safari solo lo deja ahi. */
function despertarAudio() {
  try { contextoAudio().resume?.().catch(() => {}); } catch { /* sin Web Audio */ }
}

/** Si el navegador tiene el audio en pausa, lo intenta despertar y, si no puede, lo dice. */
async function asegurarSonido() {
  const ctx = contextoAudio();
  if (ctx.state === "running") return;
  // Sin permiso, resume() puede quedarse pendiente para siempre: no se le espera.
  await Promise.race([ctx.resume().catch(() => {}), esperar(300)]);
  if (ctx.state === "running" || avisoSonido) return;
  avisoSonido = true;
  anotar("El navegador tiene el sonido en pausa: toca cualquier parte de la página para oír la respuesta", "aviso");
  const despertar = () => { avisoSonido = false; ctx.resume().catch(() => {}); };
  document.addEventListener("pointerdown", despertar, { once: true });
  document.addEventListener("keydown", despertar, { once: true });
}

function analizadorSalida() {
  if (!salidaVoz) {
    const ctx = contextoAudio();
    salidaVoz = ctx.createAnalyser();
    salidaVoz.fftSize = 256;
    salidaVoz.smoothingTimeConstant = 0.7;
    salidaVoz.connect(ctx.destination);
  }
  return salidaVoz;
}

/** Un fragmento en audio, ya decodificado. Un fallo suelto se reintenta una vez. */
async function sintetizar(texto) {
  let ultimo = null;
  for (let intento = 0; intento < 2; intento++) {
    if (intento) await esperar(500);
    try {
      const r = await fetch("/api/asistente/voz", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texto }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `HTTP ${r.status}`);
      const datos = await r.arrayBuffer();
      if (!datos.byteLength) throw new Error("el audio llegó vacío");
      return await contextoAudio().decodeAudioData(datos);
    } catch (e) {
      ultimo = e;
    }
  }
  throw ultimo;
}

const frecuencias = new Uint8Array(128);
const ondaSalida = new Float32Array(256);

function animar() {
  if (!sonando?.fuente || !salidaVoz) {
    animacion = 0;
    ponerAmplitud(0, REPOSO_BANDAS);
    return;
  }
  salidaVoz.getByteFrequencyData(frecuencias);
  // La voz humana vive en los bins bajos: se pondera esa banda.
  const voz = frecuencias.subarray(2, 40);
  let suma = 0; for (const v of voz) suma += v;
  const tramo = Math.floor(voz.length / 5);
  const bandas = [];
  for (let i = 0; i < 5; i++) {
    let pico = 0; for (let j = i * tramo; j < (i + 1) * tramo; j++) pico = Math.max(pico, voz[j]);
    bandas.push(Math.max(0.15, Math.min(pico / 255 * 1.3, 1)));
  }
  ponerAmplitud(suma / voz.length / 255, bandas);
  animacion = requestAnimationFrame(animar);
}

function soltarFuente(s) {
  const f = s.fuente;
  if (!f) return;
  s.fuente = null;
  f.onended = null;
  try { f.stop(); } catch { /* ya parada */ }
  f.disconnect();
}

function arrancarFuente(s) {
  const ctx = contextoAudio();
  const fuente = ctx.createBufferSource();
  fuente.buffer = s.buffer;
  fuente.connect(analizadorSalida());
  fuente.onended = () => {
    if (sonando !== s || s.fuente !== fuente) return;
    soltarFuente(s);
    sonando = null;
    s.terminar();
  };
  s.fuente = fuente;
  s.inicio = ctx.currentTime - s.posicion;
  fuente.start(0, s.posicion);
  ponerEstado("hablando", conv?.activa() ? "Hablando · interrúmpeme cuando quieras" : undefined);
  conv?.hablando();
  if (!animacion) animar();
}

/** Suena un fragmento; la promesa se cumple al acabar o al cortarlo. */
function sonar(buffer) {
  return new Promise((terminar) => {
    sonando = { buffer, fuente: null, inicio: 0, posicion: 0, terminar };
    arrancarFuente(sonando);
  });
}

/** Parece que le hablan encima: calla sin perder el sitio. */
function pausarVoz() {
  if (cola) cola.pausada = true;
  const s = sonando;
  if (!s?.fuente) return;
  // Al volver se repite un poco: lo que sono mientras le hablaban no se oyo bien.
  s.posicion = Math.max(0, contextoAudio().currentTime - s.inicio - 0.3);
  soltarFuente(s);
}

/** No era nadie: sigue donde iba. */
function reanudarVoz() {
  if (cola) cola.pausada = false;
  const s = sonando;
  if (!s || s.fuente) return;
  if (s.posicion >= s.buffer.duration - 0.05) { sonando = null; s.terminar(); return; }
  arrancarFuente(s);
}

function nivelVozAsistente() {
  if (!salidaVoz || !sonando?.fuente) return 0;
  salidaVoz.getFloatTimeDomainData(ondaSalida);
  let suma = 0;
  for (const v of ondaSalida) suma += v * v;
  return Math.sqrt(suma / ondaSalida.length);
}

/** Al acabar de leer la respuesta de `deTurno`, la conversacion vuelve a escuchar. */
function volverAEscuchar(deTurno) {
  if (!conv?.activa() || deTurno !== turno) return;
  if (conv.estado() === "hablando" || conv.estado() === "esperando") conv.escuchar();
}

/**
 * Lee fragmentos en orden; `cola.anadir` acepta mas mientras suena. Se
 * sintetiza el que toca y el siguiente, no todos a la vez: diez voces en
 * paralelo topan con el limite del proveedor y alguna llega rota.
 */
function nuevaCola(alTerminar) {
  const c = { textos: [], pedidos: [], actual: 0, cancelada: false, cerrada: false, corriendo: false, pausada: false };
  const pedirVoz = (i) => (c.pedidos[i] ??= sintetizar(c.textos[i]).catch((e) => e));
  c.anadir = (texto) => {
    const limpio = textoParaVoz(texto);
    if (c.cancelada || !limpio) return;
    c.textos.push(limpio);
    if (c.textos.length - 1 <= c.actual + 1) pedirVoz(c.textos.length - 1);
    c.correr();
  };
  c.cerrar = () => { c.cerrada = true; };
  c.correr = async () => {
    if (c.corriendo) return;
    c.corriendo = true;
    let fallos = 0;
    try {
      while (!c.cancelada && (c.actual < c.textos.length || !c.cerrada)) {
        if (c.actual >= c.textos.length) { await esperar(100); continue; }
        const i = c.actual;
        if (i + 1 < c.textos.length) pedirVoz(i + 1);
        const buffer = await pedirVoz(i);
        if (c.cancelada) break;
        if (buffer instanceof Error) {
          // Un trozo que no llega se salta: el resto de la respuesta se sigue oyendo.
          if (fallos++ === 0) anotar(`Voz: no pude leer parte de la respuesta (${escapar(buffer.message)})`, "aviso");
        } else {
          await asegurarSonido();
          while (c.pausada && !c.cancelada) await esperar(100);
          if (c.cancelada) break;
          await sonar(buffer);
        }
        c.actual = i + 1;
      }
    } finally {
      c.corriendo = false;
      if (cola === c) { cola = null; detenerAudio(); }
      if (!c.cancelada) alTerminar?.();
    }
  };
  return c;
}

function hablar(texto) {
  detenerAudio();
  despertarAudio();
  if (!ia?.voz) return;
  const deTurno = turno;
  cola = nuevaCola(() => volverAEscuchar(deTurno));
  fragmentarParaVoz(texto).forEach((t) => cola?.anadir(t));
  cola?.cerrar();
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
    if (v.inicio) {
      v.inicio.hidden = !vacio; v.historial.hidden = vacio;
      v.inicio.closest(".asistente-centro")?.classList.toggle("en-inicio", vacio);
    }
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

/** El orbe ya dice algo mas importante que el progreso de la respuesta. */
const orbeOcupado = () => ["hablando", "escuchando"].includes(estadoActual());

async function preguntar(texto, vista, { desdeVoz = false } = {}) {
  texto = (texto || "").trim();
  if (!texto) return;
  despertarAudio();
  if (respondiendo) {
    // Solo la voz llega con una respuesta en marcha (el boton de enviar esta
    // bloqueado): quien habla encima manda, se deja la anterior y se atiende esto.
    if (!desdeVoz || !enCurso) return;
    turno++;
    enCurso.controlador.abort();
    await enCurso.hecho;
  }
  await cargarIA();
  if (!ia?.disponible) return;
  respondiendo = true;
  const miTurno = ++turno;
  const controlador = new AbortController();
  let terminado = null;
  enCurso = { controlador, hecho: new Promise((r) => { terminado = r; }) };
  detenerAudio();
  // Una pregunta escrita en pleno modo conversacion: se deja de dictar mientras responde.
  if (conv?.estado() === "escuchando") conv.esperar();
  if (vista?.entrada) { vista.entrada.value = ""; ajustar(vista.entrada); }
  const previo = historial.slice(-12).map(({ rol, contenido }) => ({ rol, contenido }));
  // La primera pregunta en la pantalla grande: el orbe se encoge hasta la cabecera.
  if (!historial.length && vista === vistas.pagina) volarOrbe(true);
  historial.push({ rol: "usuario", contenido: texto });
  const respuesta = { rol: "asistente", contenido: "", bloques: [], meta: null };
  historial.push(respuesta);
  pintarHistorial(true, true);
  ponerEstado("pensando");
  bloquear(true);

  // Si hay voz, cada frase completa se manda a leer sin esperar al final.
  let leido = 0, abierto = null, rondas = 0, contexto = null;
  // En modo conversacion la respuesta siempre se oye.
  if (ia.voz && (leerSolas || conv?.activa())) cola = nuevaCola(() => volverAEscuchar(miTurno));
  const colaLocal = cola;
  const enviarFrases = (final) => {
    if (!colaLocal || colaLocal.cancelada) return;
    const pendiente = respuesta.contenido.slice(leido);
    if (final) { if (pendiente.trim()) colaLocal.anadir(pendiente.trim()); leido = respuesta.contenido.length; return; }
    // El primer trozo, una sola frase corta: suena cuanto antes. Los demas, de
    // varias frases, se sintetizan mientras suena el anterior.
    const fronteras = [...pendiente.matchAll(/[.!?…](?=\s)|\n/g)].map((m) => m.index);
    const corte = colaLocal.textos.length
      ? fronteras.filter((i) => i >= 80).pop()
      : fronteras.find((i) => i >= 25);
    if (corte !== undefined) { colaLocal.anadir(pendiente.slice(0, corte + 1).trim()); leido += corte + 1; }
  };

  try {
    const r = await fetch("/api/asistente/preguntar/stream", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controlador.signal,
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
          if (!orbeOcupado()) ponerEstado("reposo", "Respondiendo…");
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
    if (!orbeOcupado()) ponerEstado("reposo", "Respondido. ¿Algo más?");
    if (contexto?.documentos_sin_resumen) anotar(`${contexto.documentos_sin_resumen} documento(s) sin resumen: el asistente no los conoce`, "aviso");
    pintarSabe();
  } catch (e) {
    colaLocal?.cerrar();
    if (controlador.signal.aborted) {
      // Le hablaron encima: lo dicho hasta aqui queda, y el modelo sabe que se corto.
      respuesta.bloques.push({ tipo: "texto", texto: "(Interrumpida)" });
      respuesta.contenido = `${respuesta.contenido.trim()}\n\n(Interrumpida)`.trim();
    } else {
      const aviso = `No pude responder: ${e.message}`;
      respuesta.bloques.push({ tipo: "texto", texto: aviso });
      respuesta.contenido = (respuesta.contenido ? `${respuesta.contenido}\n\n` : "") + aviso;
      ponerEstado("reposo", "Algo falló. Inténtalo de nuevo.");
    }
  } finally {
    respondiendo = false;
    if (enCurso?.controlador === controlador) enCurso = null;
    // Un paso que quedo a medias (se corto la conexion) no puede seguir girando.
    for (const b of respuesta.bloques) if (b.tipo === "paso" && b.estado === "en_curso") b.estado = "error";
    bloquear(false);
    pintarHistorial();
    if (!conv?.activa()) vista?.entrada?.focus();
    // Sin nada que leer (sin voz, o respuesta vacia), se vuelve a escuchar ya;
    // si hay voz, lo hace la cola al terminar de sonar. Si ya hay otra
    // pregunta en marcha, la conversacion es suya.
    if (miTurno === turno && conv?.estado() === "esperando" && (!colaLocal || !colaLocal.textos.length || colaLocal.cancelada)) conv.escuchar();
    terminado();
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
// Modo conversacion: escuchar, responder en voz alta y volver a escuchar
// ---------------------------------------------------------------------------

function marcarConversacion(activa) {
  document.querySelectorAll("[data-conversar]").forEach((b) => {
    b.setAttribute("aria-pressed", String(activa));
    b.classList.toggle("activo", activa);
    b.title = activa ? "Terminar la conversación por voz" : "Conversar por voz";
  });
  for (const v of Object.values(vistas)) {
    v.entrada.placeholder = activa ? "Te escucho… habla cuando quieras" : (v.entrada.dataset.placeholder ??= v.entrada.placeholder);
  }
}

async function alternarConversacion(v) {
  if (conv?.activa()) { conv.terminar(); return; }
  // Dentro del clic, antes de esperar nada: es cuando el navegador deja sonar.
  despertarAudio();
  await cargarIA();
  if (!ia?.disponible) return;
  for (const x of Object.values(vistas)) x.entrada.dataset.placeholder ??= x.entrada.placeholder;
  vistaConv = v;
  detenerAudio();
  conv ??= crearConversacion({
    contextoAudio,
    alTexto: (texto) => { if (vistaConv) { vistaConv.entrada.value = texto; ajustar(vistaConv.entrada); } },
    alTurno: (texto) => preguntar(texto, vistaConv, { desdeVoz: true }),
    alEstado: (e) => {
      marcarConversacion(e !== "inactiva");
      if (e === "escuchando") ponerEstado("escuchando", "Te escucho… habla cuando quieras");
      else if (e === "confirmando") ponerEstado("escuchando", "¿Me dices algo? Te escucho…");
      else if (e === "inactiva" && estadoActual() === "escuchando") ponerEstado("reposo");
    },
    alPausar: pausarVoz,
    alReanudar: reanudarVoz,
    alInterrumpir: detenerAudio,
    alNivel: (n) => {
      const b = Math.max(0.15, Math.min(n * 14, 1));
      ponerAmplitud(Math.min(n * 6, 0.45), [b, b, b, b, b]);
    },
    nivelSalida: nivelVozAsistente,
    alError: (mensaje) => { anotar(`Voz: ${escapar(mensaje)}`, "alerta"); ponerEstado("reposo", mensaje); },
  });
  try {
    await conv.empezar();
  } catch (e) {
    anotar(`Voz: ${escapar(e.message)}`, "alerta");
    ponerEstado("reposo", e.message);
  }
}

// Esc corta la conversacion. Si se cambia de pantalla, lo dictado pasa a la
// ventana flotante si esta abierta; si no, la conversacion termina.
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && conv?.activa()) conv.terminar(); });
window.addEventListener("hashchange", () => setTimeout(() => {
  if (!conv?.activa()) return;
  if (document.body.dataset.modulo === "asistente" && vistas.pagina) vistaConv = vistas.pagina;
  else if (vistas.flotante && !$("asis-flotante").hidden) vistaConv = vistas.flotante;
  else conv.terminar();
}, 0));

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
  if (v.conversar) {
    if (hayConversacion()) v.conversar.addEventListener("click", () => alternarConversacion(v));
    else v.conversar.hidden = true;
  }
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
// Vuelo del orbe entre el inicio y la cabecera
// ---------------------------------------------------------------------------

/** El orbe grande se encoge hasta la cabecera al empezar la conversacion, y
 *  vuelve a crecer desde ahi al empezar otra. Viaja como elemento fijo sobre
 *  la pagina, porque dentro de su contenedor lo recortaria el desplazamiento;
 *  como sigue siendo el mismo lienzo, gira durante todo el viaje. */
function volarOrbe(haciaCabecera) {
  aterrizar?.();
  const lienzo = $("asistente-orbe"), mini = $("asistente-orbe-mini");
  if (QUIETO || !lienzo || !mini || lienzo.hidden || document.body.dataset.modulo !== "asistente") return;
  const grande = lienzo.getBoundingClientRect();
  if (!grande.width) return;
  // Donde queda el orbe pequeno, aunque ahora este plegado: al principio de su
  // fila. La escala hace coincidir las dos esferas, no los lienzos.
  const fila = mini.closest(".asistente-identidad").getBoundingClientRect();
  const dx = fila.left + HUECO_MINI / 2 - (grande.left + grande.width / 2);
  const dy = fila.top + fila.height / 2 - (grande.top + grande.height / 2);
  const escala = (RADIO_MINI * LIENZO_MINI) / (RADIO_GRANDE * grande.width);
  const enCabecera = `translate(${dx}px, ${dy}px) scale(${escala})`;

  const hueco = document.createElement("div");
  hueco.style.cssText = `width:${grande.width}px;height:${grande.height}px;flex:none;margin:4px 0`;
  lienzo.replaceWith(hueco);
  Object.assign(lienzo.style, {
    position: "fixed", left: `${grande.left}px`, top: `${grande.top}px`, width: `${grande.width}px`,
    height: `${grande.height}px`, margin: "0", zIndex: "45", pointerEvents: "none",
  });
  document.body.append(lienzo);
  mini.style.opacity = "0";
  const vuelo = lienzo.animate(
    haciaCabecera
      ? [{ transform: "none" }, { transform: enCabecera }]
      : [{ transform: enCabecera, opacity: 0.5 }, { transform: "none", opacity: 1 }],
    { duration: 700, easing: "cubic-bezier(.2,.75,.25,1)" },
  );
  aterrizar = () => {
    aterrizar = null;
    vuelo.onfinish = vuelo.oncancel = null;
    vuelo.cancel();
    lienzo.removeAttribute("style");
    hueco.replaceWith(lienzo);
    mini.style.opacity = "";
    if (haciaCabecera) mini.animate([{ opacity: 0, transform: "scale(.7)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "ease-out" });
  };
  vuelo.onfinish = vuelo.oncancel = () => aterrizar?.();
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
  if (conv?.activa() && vistaConv === vistas.flotante) conv.terminar();
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
  try { orbes.push(crearOrbe($("flot-orbe"), { puntos: 170, radio: RADIO_MINI })); } catch { /* sin canvas: queda el texto */ }
  montarVista("flotante", {
    historial: $("flot-historial"), form: $("flot-form"), entrada: $("flot-entrada"),
    enviar: $("flot-enviar"), mic: $("flot-mic"), conversar: $("flot-conversar"), vacio: vacioFlotante,
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
  const habia = historial.length > 0;
  historial.length = 0;
  for (const k of Object.keys(cuenta)) cuenta[k] = 0;
  turno++;
  enCurso?.controlador.abort();
  detenerAudio();
  // Lo que estaba diciendo o pensando ya no cuenta: la conversacion vuelve a escuchar.
  if (conv?.activa() && conv.estado() !== "escuchando") conv.escuchar();
  pintarHistorial();
  if (habia) volarOrbe(false);
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
      conversar: $("asistente-conversar"),
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
      // En modo conversacion la respuesta se oye siempre: no se corta.
      if (!leerSolas && !conv?.activa()) detenerAudio();
    });
    try {
      orbeGrande = crearOrbe($("asistente-orbe"), { radio: RADIO_GRANDE });
      orbes.push(orbeGrande, crearOrbe($("asistente-orbe-mini"), { puntos: 170, radio: RADIO_MINI }));
    } catch { $("asistente-orbe").hidden = true; }
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
