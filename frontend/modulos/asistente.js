/* Modulo: el asistente, como pantalla completa.
 *
 * En el centro, el orbe: respira en reposo, emite ondas cuando escucha, gira
 * cuando piensa y vibra con la voz mientras habla (la amplitud sale del audio
 * real, con un AnalyserNode). Debajo, la pregunta y la respuesta en grande;
 * al pie, la barra para escribir o dictar. Mas abajo, la conversacion y lo
 * que el asistente sabe ahora mismo.
 */

import { $, anotar, chip, escapar, estado, pedir } from "../comun.js";

const historial = [];       // [{rol, contenido}]
let ia = null;
let contextoClave = "";
let leerSolas = true;
let audio = null;           // {elemento, ctx, analizador, fuente, raf}
let reconocimiento = null;

export function fijarEmpresaEnPantalla(clave) { contextoClave = clave || ""; }

const SUGERENCIAS = [
  "¿A quien visito primero y por que?",
  "Explica el resultado del caso base en dos frases",
  "¿Que documentos tenemos guardados y que dicen?",
  "¿Que empresas tienen expediente en VITAL?",
  "¿Que le falta a la cartera para llegar al 10 %?",
];

// ---------------------------------------------------------------------------
// Orbe: estados y reaccion al audio
// ---------------------------------------------------------------------------

const MENSAJE_ESTADO = {
  reposo: "Listo. Pregunta lo que quieras sobre los prospectos y los documentos.",
  escuchando: "Te escucho…",
  pensando: "Consultando los datos de la aplicacion…",
  hablando: "Hablando",
  sin_ia: "Sin proveedor de IA configurado.",
};

function ponerEstado(nombre, texto) {
  const orbe = $("orbe");
  orbe.dataset.estado = nombre;
  $("orbe-estado").textContent = texto || MENSAJE_ESTADO[nombre] || "";
  if (nombre !== "hablando") orbe.style.setProperty("--amp", "1");
}

function detenerAudio() {
  if (!audio) return;
  cancelAnimationFrame(audio.raf);
  audio.elemento.pause();
  try { audio.fuente.disconnect(); } catch { /* ya desconectado */ }
  URL.revokeObjectURL(audio.elemento.src);
  audio = null;
  for (let i = 1; i <= 5; i++) $("orbe").style.setProperty(`--b${i}`, "0.15");
  ponerEstado("reposo");
  $("btn-escuchar").textContent = "🔊 Escuchar";
}

async function hablar(texto) {
  detenerAudio();
  if (!ia?.voz) return;
  const btn = $("btn-escuchar"); btn.disabled = true; btn.textContent = "Generando voz…";
  try {
    const r = await fetch("/api/asistente/voz", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texto }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || `${r.status}`);
    const elemento = new Audio(URL.createObjectURL(await r.blob()));
    elemento.crossOrigin = "anonymous";
    // El orbe se mueve con la voz: analizador sobre el audio que suena.
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const fuente = ctx.createMediaElementSource(elemento);
    const analizador = ctx.createAnalyser(); analizador.fftSize = 256; analizador.smoothingTimeConstant = 0.75;
    fuente.connect(analizador); analizador.connect(ctx.destination);
    audio = { elemento, ctx, analizador, fuente, raf: 0 };
    const datos = new Uint8Array(analizador.frequencyBinCount);
    const orbe = $("orbe");
    const animar = () => {
      analizador.getByteFrequencyData(datos);
      // La voz humana vive en los bins bajos; se pondera esa banda para que
      // el orbe responda a la voz y no al ruido de fondo.
      const voz = datos.subarray(2, 40);
      let suma = 0; for (const v of voz) suma += v;
      const media = suma / voz.length / 255;
      orbe.style.setProperty("--amp", (1 + Math.min(media * 1.6, 0.45)).toFixed(3));
      const tramo = Math.floor(voz.length / 5);
      for (let i = 0; i < 5; i++) {
        let pico = 0; for (let j = i * tramo; j < (i + 1) * tramo; j++) pico = Math.max(pico, voz[j]);
        orbe.style.setProperty(`--b${i + 1}`, Math.max(0.15, Math.min(pico / 255 * 1.3, 1)).toFixed(3));
      }
      audio.raf = requestAnimationFrame(animar);
    };
    elemento.addEventListener("ended", detenerAudio);
    await ctx.resume();
    await elemento.play();
    ponerEstado("hablando");
    btn.disabled = false; btn.textContent = "⏹ Parar";
    animar();
  } catch (e) {
    btn.disabled = false; btn.textContent = "🔊 Escuchar";
    ponerEstado("reposo");
    anotar(`Voz: ${escapar(e.message)}`, "alerta");
  }
}

// ---------------------------------------------------------------------------
// Conversacion
// ---------------------------------------------------------------------------

function moduloAnterior() {
  // El asistente sabe desde que modulo llego el usuario, si lo guardo.
  return sessionStorage.getItem("simbia.modulo_previo") || "asistente";
}

function pintarDialogo() {
  const ultimoUsuario = [...historial].reverse().find((m) => m.rol === "usuario");
  const ultimoAsistente = historial.at(-1)?.rol === "asistente" ? historial.at(-1) : null;
  $("asistente-pregunta").textContent = ultimoUsuario ? ultimoUsuario.contenido : "";
  $("asistente-respuesta").innerHTML = ultimoAsistente
    ? escapar(ultimoAsistente.contenido).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>")
    : "";
  $("asistente-respuesta-acciones").hidden = !ultimoAsistente;
  $("btn-escuchar").hidden = !(ia?.voz);
}

function pintarHistorial() {
  const caja = $("asistente-historial");
  caja.innerHTML = historial.length
    ? historial.map((m) => `<div class="burbuja ${m.rol}">${escapar(m.contenido).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>")}</div>`).join("")
    : `<p class="pie">Todavia no hay conversacion.</p>`;
  caja.scrollTop = caja.scrollHeight;
}

async function preguntar(texto) {
  texto = (texto || "").trim();
  if (!texto || !ia?.disponible) return;
  detenerAudio();
  $("asistente-entrada").value = "";
  historial.push({ rol: "usuario", contenido: texto });
  pintarDialogo(); pintarHistorial();
  ponerEstado("pensando");
  $("asistente-enviar").disabled = true;
  try {
    const r = await fetch("/api/asistente/preguntar", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mensaje: texto, historial: historial.slice(0, -1).slice(-12),
        modulo: moduloAnterior(), clave: contextoClave, radio_km: estado.radio,
      }),
    });
    if (r.status === 401) { location.replace("/acceso"); return; }
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || `${r.status}`);
    historial.push({ rol: "asistente", contenido: d.respuesta });
    pintarDialogo(); pintarHistorial();
    ponerEstado("reposo", "Respondido. ¿Algo mas?");
    if (leerSolas && ia.voz) hablar(d.respuesta);
    pintarSabe();
  } catch (e) {
    historial.push({ rol: "asistente", contenido: `No pude responder: ${e.message}` });
    pintarDialogo(); pintarHistorial();
    ponerEstado("reposo", "Algo fallo. Intentalo de nuevo.");
  } finally {
    $("asistente-enviar").disabled = false;
    $("asistente-entrada").focus();
  }
}

// ---------------------------------------------------------------------------
// Dictado
// ---------------------------------------------------------------------------

function montarDictado() {
  const Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $("asistente-mic");
  if (!Reconocimiento) { btn.hidden = true; return; }
  btn.addEventListener("click", () => {
    if (reconocimiento) { reconocimiento.stop(); return; }
    detenerAudio();
    reconocimiento = new Reconocimiento();
    reconocimiento.lang = "es-CO"; reconocimiento.interimResults = true;
    btn.classList.add("grabando"); btn.textContent = "⏹";
    ponerEstado("escuchando");
    reconocimiento.onresult = (ev) => { $("asistente-entrada").value = [...ev.results].map((r) => r[0].transcript).join(" "); };
    reconocimiento.onend = () => {
      reconocimiento = null; btn.classList.remove("grabando"); btn.textContent = "🎤";
      const t = $("asistente-entrada").value.trim();
      if (t) preguntar(t); else ponerEstado("reposo");
    };
    reconocimiento.onerror = () => { reconocimiento = null; btn.classList.remove("grabando"); btn.textContent = "🎤"; ponerEstado("reposo", "No pude oirte."); };
    reconocimiento.start();
  });
}

// ---------------------------------------------------------------------------
// Que sabe ahora
// ---------------------------------------------------------------------------

async function pintarSabe() {
  const caja = $("asistente-sabe");
  try {
    const c = await pedir(`/api/asistente/contexto?radio_km=${estado.radio}&clave=${encodeURIComponent(contextoClave)}`);
    const sinResumen = c.documentos.filter((d) => !d.con_resumen);
    caja.innerHTML = `
      <div class="sabe-fila">${chip(`${c.prospectos} prospectos`, "neutra")} ${chip(`${c.cartera.length} en cartera`, c.cartera.length ? "ok" : "neutra")}
        ${chip(`${c.documentos.length} documento(s)`, "neutra")} ${chip(`fuentes: ${c.modo_fuentes}`, "neutra")}
        ${c.empresa_en_pantalla ? chip(`en pantalla: ${escapar(c.empresa_en_pantalla)}`, "azul") : ""}</div>
      ${c.cartera.length ? `<p class="pie">Cartera: ${c.cartera.map(escapar).join(", ")}.</p>` : `<p class="pie">La cartera esta vacia: el asistente vera los prospectos, pero no fichas ni documentos. <a href="#empresas">Ir a Empresas</a>.</p>`}
      ${c.documentos.length ? `<ul class="refs">${c.documentos.map((d) => `<li>📄 ${escapar(d.archivo)} <span class="sub" style="display:inline">· ${escapar(d.empresa)}</span> ${d.con_resumen ? chip("resumido", "ok") : chip("sin resumen", "aviso")}</li>`).join("")}</ul>` : ""}
      ${sinResumen.length ? `<p class="pie" style="color:var(--aviso)">${sinResumen.length} documento(s) sin resumen: el asistente no puede leerlos hasta que pulses "Resumir" en <a href="#empresas">Empresas</a>.</p>` : ""}
      <p class="pie">El asistente responde solo con estos datos y dice de donde sale cada cifra. Lo inferido lo presenta como inferido.</p>`;
  } catch (e) {
    caja.innerHTML = `<p class="pie">${escapar(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------------------

export default {
  id: "asistente",
  async montar() {
    $("asistente-form").addEventListener("submit", (ev) => { ev.preventDefault(); preguntar($("asistente-entrada").value); });
    $("asistente-entrada").addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); preguntar($("asistente-entrada").value); } });
    $("asistente-voz-auto").checked = leerSolas;
    $("asistente-voz-auto").addEventListener("change", (ev) => { leerSolas = ev.target.checked; if (!leerSolas) detenerAudio(); });
    $("btn-escuchar").addEventListener("click", () => {
      if (audio) { detenerAudio(); return; }
      const ultimo = [...historial].reverse().find((m) => m.rol === "asistente");
      if (ultimo) hablar(ultimo.contenido);
    });
    $("btn-copiar-respuesta").addEventListener("click", async (ev) => {
      const ultimo = [...historial].reverse().find((m) => m.rol === "asistente");
      try { await navigator.clipboard.writeText(ultimo?.contenido || ""); ev.target.textContent = "Copiada"; } catch { ev.target.textContent = "No se pudo"; }
      setTimeout(() => { ev.target.textContent = "Copiar"; }, 1500);
    });
    $("asistente-limpiar").addEventListener("click", () => { historial.length = 0; detenerAudio(); pintarDialogo(); pintarHistorial(); ponerEstado(ia?.disponible ? "reposo" : "sin_ia"); });
    $("asistente-sugerencias").innerHTML = SUGERENCIAS.map((s) => `<button class="secundario pequeno">${escapar(s)}</button>`).join("");
    $("asistente-sugerencias").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => preguntar(b.textContent)));
    window.addEventListener("hashchange", () => {
      const anterior = sessionStorage.getItem("simbia.modulo_actual") || "";
      sessionStorage.setItem("simbia.modulo_previo", anterior);
      sessionStorage.setItem("simbia.modulo_actual", (location.hash || "#inicio").slice(1).split("?")[0]);
    });
    montarDictado();
    try { ia = await pedir("/api/asistente/estado"); }
    catch (e) { ia = { disponible: false, motivo: e.message }; }
    $("asistente-chip").innerHTML = ia.disponible
      ? chip(`${escapar(ia.proveedor)} · ${escapar(ia.modelo)}${ia.voz ? " · voz" : ""}`, "ok")
      : chip("IA no configurada", "aviso");
    $("asistente-voz-auto").closest("label").hidden = !(ia.disponible && ia.voz);
    if (!ia.disponible) {
      ponerEstado("sin_ia", ia.motivo);
      $("asistente-entrada").disabled = true; $("asistente-enviar").disabled = true;
      $("asistente-sabe").innerHTML = `<p class="pie">Sin proveedor de IA no hay nada que consultar. ${escapar(ia.motivo)}</p>`;
    } else {
      ponerEstado("reposo");
    }
    pintarDialogo(); pintarHistorial();
  },
  async mostrar() { if (ia?.disponible) pintarSabe(); },
};
