/* Asistente: un panel disponible en toda la aplicacion.
 *
 * Se le escribe (o se le dicta, si el navegador tiene reconocimiento de voz)
 * y responde con lo que la aplicacion sabe ahora mismo: prospectos, cartera,
 * expedientes, documentos guardados y resultado del optimizador. Cada
 * respuesta se puede escuchar; con "leer en voz alta" se reproducen solas.
 */

import { $, anotar, escapar, estado } from "./comun.js";

const historial = [];   // [{rol, contenido}]
let ia = null;
let audioActual = null;
let leerSolas = false;
let contextoClave = "";  // empresa en pantalla, si algun modulo la fija

export function fijarEmpresaEnPantalla(clave) { contextoClave = clave || ""; }

function moduloActual() {
  return (location.hash || "#inicio").slice(1).split("?")[0];
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function abrir() {
  $("asistente").classList.add("abierto");
  $("asistente-entrada").focus();
}
function cerrar() { $("asistente").classList.remove("abierto"); detenerAudio(); }

function pintarEstado() {
  const cab = $("asistente-estado");
  if (!ia) { cab.innerHTML = ""; return; }
  cab.innerHTML = ia.disponible
    ? `<span class="chip ok">${escapar(ia.proveedor)} · ${escapar(ia.modelo)}</span>`
    : `<span class="chip aviso">IA no configurada</span>`;
  $("asistente-voz-auto").closest("label").hidden = !(ia.disponible && ia.voz);
  if (!ia.disponible) {
    $("asistente-mensajes").innerHTML = `<div class="aviso-caja"><b>El asistente necesita un proveedor de IA.</b> ${escapar(ia.motivo)}</div>`;
  } else if (!historial.length) {
    $("asistente-mensajes").innerHTML = `<div class="burbuja asistente">
      Hola. Se lo que sabe la aplicacion ahora mismo: el barrido, la cartera con sus fichas y expedientes, los documentos guardados
      y el resultado del optimizador. Preguntame, por ejemplo:
      <div class="sugerencias">
        <button class="secundario pequeno">¿A quien visito primero y por que?</button>
        <button class="secundario pequeno">Resume lo que sabemos de Mexichem</button>
        <button class="secundario pequeno">¿Que documentos tenemos y que dicen?</button>
        <button class="secundario pequeno">Explica el resultado del caso base</button>
      </div></div>`;
    $("asistente-mensajes").querySelectorAll(".sugerencias button").forEach((b) =>
      b.addEventListener("click", () => { $("asistente-entrada").value = b.textContent; enviar(); }));
  }
}

function pintarMensajes() {
  const caja = $("asistente-mensajes");
  caja.innerHTML = historial.map((m, i) => `
    <div class="burbuja ${m.rol}">
      ${escapar(m.contenido).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>")}
      ${m.rol === "asistente" && ia?.voz ? `<div class="burbuja-acciones"><button class="secundario pequeno btn-escuchar" data-i="${i}">🔊 Escuchar</button></div>` : ""}
    </div>`).join("");
  caja.querySelectorAll(".btn-escuchar").forEach((b) => b.addEventListener("click", () => escuchar(historial[b.dataset.i].contenido, b)));
  caja.scrollTop = caja.scrollHeight;
}

async function enviar() {
  const entrada = $("asistente-entrada");
  const texto = entrada.value.trim();
  if (!texto || !ia?.disponible) return;
  entrada.value = "";
  historial.push({ rol: "usuario", contenido: texto });
  pintarMensajes();
  const caja = $("asistente-mensajes");
  caja.insertAdjacentHTML("beforeend", `<div class="burbuja asistente pensando" id="asistente-pensando"><span class="cargando">Consultando los datos…</span></div>`);
  caja.scrollTop = caja.scrollHeight;
  $("asistente-enviar").disabled = true;
  try {
    const r = await fetch("/api/asistente/preguntar", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mensaje: texto, historial: historial.slice(0, -1).slice(-12),
        modulo: moduloActual(), clave: contextoClave, radio_km: estado.radio,
      }),
    });
    if (r.status === 401) { location.replace("/acceso"); return; }
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || `${r.status}`);
    historial.push({ rol: "asistente", contenido: d.respuesta });
    pintarMensajes();
    if (d.contexto.documentos_sin_resumen) {
      caja.insertAdjacentHTML("beforeend", `<p class="pie">${d.contexto.documentos_sin_resumen} documento(s) guardado(s) sin resumen: en Empresas → documentos → "Resumir" para que el asistente los conozca.</p>`);
    }
    if (leerSolas && ia.voz) escuchar(d.respuesta);
  } catch (e) {
    historial.push({ rol: "asistente", contenido: `No pude responder: ${e.message}` });
    pintarMensajes();
  } finally {
    $("asistente-pensando")?.remove();
    $("asistente-enviar").disabled = false;
    entrada.focus();
  }
}

// ---------------------------------------------------------------------------
// Voz
// ---------------------------------------------------------------------------

function detenerAudio() {
  if (audioActual) { audioActual.pause(); URL.revokeObjectURL(audioActual.src); audioActual = null; }
  document.querySelectorAll(".btn-escuchar").forEach((b) => { b.textContent = "🔊 Escuchar"; b.disabled = false; });
}

async function escuchar(texto, boton) {
  detenerAudio();
  if (boton) { boton.disabled = true; boton.textContent = "Generando…"; }
  try {
    const r = await fetch("/api/asistente/voz", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texto }),
    });
    if (!r.ok) throw new Error((await r.json()).detail || `${r.status}`);
    const url = URL.createObjectURL(await r.blob());
    audioActual = new Audio(url);
    audioActual.addEventListener("ended", detenerAudio);
    await audioActual.play();
    if (boton) { boton.disabled = false; boton.textContent = "⏹ Parar"; boton.onclick = detenerAudio; }
  } catch (e) {
    if (boton) { boton.disabled = false; boton.textContent = "🔊 Escuchar"; }
    anotar(`Voz: ${escapar(e.message)}`, "alerta");
  }
}

function montarDictado() {
  const Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $("asistente-mic");
  if (!Reconocimiento) { btn.hidden = true; return; }
  let activo = null;
  btn.addEventListener("click", () => {
    if (activo) { activo.stop(); return; }
    activo = new Reconocimiento();
    activo.lang = "es-CO"; activo.interimResults = true;
    btn.classList.add("grabando"); btn.textContent = "⏹";
    activo.onresult = (ev) => { $("asistente-entrada").value = [...ev.results].map((r) => r[0].transcript).join(" "); };
    activo.onend = () => { activo = null; btn.classList.remove("grabando"); btn.textContent = "🎤"; if ($("asistente-entrada").value.trim()) enviar(); };
    activo.onerror = () => { activo = null; btn.classList.remove("grabando"); btn.textContent = "🎤"; };
    activo.start();
  });
}

// ---------------------------------------------------------------------------

export async function montarAsistente() {
  $("btn-asistente").addEventListener("click", abrir);
  $("asistente-cerrar").addEventListener("click", cerrar);
  $("asistente-enviar").addEventListener("click", enviar);
  $("asistente-entrada").addEventListener("keydown", (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); enviar(); } });
  $("asistente-voz-auto").addEventListener("change", (ev) => { leerSolas = ev.target.checked; if (!leerSolas) detenerAudio(); });
  $("asistente-limpiar").addEventListener("click", () => { historial.length = 0; detenerAudio(); pintarEstado(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && $("asistente").classList.contains("abierto")) cerrar(); });
  montarDictado();
  try { ia = await (await fetch("/api/asistente/estado")).json(); }
  catch { ia = { disponible: false, motivo: "sin respuesta del servidor" }; }
  pintarEstado();
}
