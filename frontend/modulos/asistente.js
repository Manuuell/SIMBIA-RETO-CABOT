/* Espacio de trabajo conversacional del asistente.
 *
 * La conversacion es el contenido principal, el compositor permanece a mano
 * y el contexto conectado se ve en un panel lateral. El orbe queda reducido
 * a un indicador de estado y conserva la reaccion a la voz real.
 */

import { $, anotar, chip, escapar, estado, pedir } from "../comun.js";

const historial = [];       // [{rol, contenido}]
let ia = null;
let contextoClave = "";
let leerSolas = true;
let audio = null;           // reproduccion en curso: {ctx, analizador, raf, elemento, fuente}
let cola = null;            // cola de fragmentos de voz de la respuesta actual
let reconocimiento = null;
let ctxAudio = null;        // un solo AudioContext para toda la sesion

export function fijarEmpresaEnPantalla(clave) { contextoClave = clave || ""; }

const SUGERENCIAS = [
  "¿A quien visito primero y por que?",
  "Resume el potencial de ahorro en dos frases",
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
  if (cola) { cola.cancelada = true; cola = null; }
  if (audio) {
    cancelAnimationFrame(audio.raf);
    audio.elemento.pause();
    try { audio.fuente.disconnect(); audio.analizador.disconnect(); } catch { /* ya desconectado */ }
    audio = null;
  }
  for (let i = 1; i <= 5; i++) $("orbe").style.setProperty(`--b${i}`, "0.15");
  if ($("orbe").dataset.estado === "hablando") ponerEstado("reposo");
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
    const orbe = $("orbe");
    const animar = () => {
      if (!audio || audio.elemento !== elemento) return;
      analizador.getByteFrequencyData(datos);
      // La voz humana vive en los bins bajos: se pondera esa banda.
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
    if ($("orbe").dataset.estado !== "hablando") $("orbe-estado").textContent = "Preparando voz…";
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

async function hablar(texto) {
  detenerAudio();
  if (!ia?.voz) return;
  cola = nuevaCola();
  fragmentarParaVoz(texto).forEach((t) => cola.anadir(t));
  cola.cerrar();
}

// ---------------------------------------------------------------------------
// Conversacion
// ---------------------------------------------------------------------------

function moduloAnterior() {
  // El asistente sabe desde que modulo llego el usuario, si lo guardo.
  return sessionStorage.getItem("simbia.modulo_previo") || "asistente";
}

function formatear(texto) {
  return escapar(texto || "")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function pintarHistorial(enCurso = false) {
  const caja = $("asistente-historial");
  if (!historial.length) {
    caja.innerHTML = `<div class="asistente-vacio">
      <div class="asistente-vacio-marca">S</div>
      <div><h2>¿Qué quieres analizar?</h2>
        <p>Consulta la prospección, compara empresas o pide evidencia de los expedientes. Cada respuesta distingue datos medidos, declarados e inferidos.</p></div>
      <div class="sugerencias">${SUGERENCIAS.slice(0, 4).map((s) => `<button class="secundario" data-pregunta="${escapar(s)}">${escapar(s)}</button>`).join("")}</div>
    </div>`;
    return;
  }
  caja.innerHTML = historial.map((m, i) => {
    const esAsistente = m.rol === "asistente";
    const escribiendo = enCurso && i === historial.length - 1 && esAsistente;
    return `<article class="mensaje ${m.rol}">
      <div class="mensaje-avatar">${esAsistente ? "S" : "TÚ"}</div>
      <div><div class="mensaje-cabecera">${esAsistente ? "SIMBIA" : "Tú"}</div>
        <div class="mensaje-contenido">${m.contenido ? formatear(m.contenido) : "Analizando el contexto…"}${escribiendo ? '<span class="cursor-respuesta"></span>' : ""}</div>
        ${esAsistente && m.contenido ? `<div class="mensaje-acciones">
          <button class="secundario" data-accion="copiar" data-indice="${i}">Copiar</button>
          ${ia?.voz ? `<button class="secundario" data-accion="escuchar" data-indice="${i}">Escuchar</button>` : ""}
        </div>` : ""}
      </div>
    </article>`;
  }).join("");
  caja.scrollTop = caja.scrollHeight;
}

function ajustarEntrada() {
  const entrada = $("asistente-entrada");
  entrada.style.height = "auto";
  entrada.style.height = `${Math.min(entrada.scrollHeight, 150)}px`;
}

async function preguntar(texto) {
  texto = (texto || "").trim();
  if (!texto || !ia?.disponible) return;
  detenerAudio();
  $("asistente-entrada").value = "";
  ajustarEntrada();
  historial.push({ rol: "usuario", contenido: texto });
  pintarHistorial();
  ponerEstado("pensando");
  $("asistente-enviar").disabled = true;
  // La respuesta llega por trozos: se pinta segun llega y, si hay voz, cada
  // frase completa se manda a leer sin esperar al final.
  const respuesta = { rol: "asistente", contenido: "" };
  let leido = 0;                 // hasta donde se ha mandado a la cola de voz
  const conVoz = leerSolas && ia.voz;
  if (conVoz) { detenerAudio(); cola = nuevaCola(); }
  const colaLocal = cola;
  const enviarFrasesCompletas = (final) => {
    if (!colaLocal || colaLocal.cancelada) return;
    const pendiente = respuesta.contenido.slice(leido);
    if (final) { if (pendiente.trim()) colaLocal.anadir(pendiente.trim()); leido = respuesta.contenido.length; return; }
    // Se corta en el ultimo fin de frase, y solo si ya hay un trozo con cuerpo.
    const corte = Math.max(pendiente.lastIndexOf(". "), pendiente.lastIndexOf("? "), pendiente.lastIndexOf("! "), pendiente.lastIndexOf("\n"));
    if (corte >= 60) { colaLocal.anadir(pendiente.slice(0, corte + 1).trim()); leido += corte + 1; }
  };
  try {
    const r = await fetch("/api/asistente/preguntar/stream", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mensaje: texto, historial: historial.slice(0, -1).slice(-12),
        modulo: moduloAnterior(), clave: contextoClave, radio_km: estado.radio,
      }),
    });
    if (r.status === 401) { location.replace("/acceso"); return; }
    if (!r.ok) throw new Error((await r.json()).detail || `${r.status}`);
    historial.push(respuesta);
    pintarHistorial(true);
    const lector = r.body.getReader(), decodificador = new TextDecoder();
    let resto = "", contexto = null;
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
          if (!respuesta.contenido) ponerEstado("reposo", "Respondiendo…");
          respuesta.contenido += d.delta;
          pintarHistorial(true);
          enviarFrasesCompletas(false);
        }
        if (d.fin) contexto = d.contexto;
      }
    }
    respuesta.contenido = respuesta.contenido.trim();
    pintarHistorial();
    enviarFrasesCompletas(true);
    colaLocal?.cerrar();
    ponerEstado($("orbe").dataset.estado === "hablando" ? "hablando" : "reposo", $("orbe").dataset.estado === "hablando" ? "Hablando" : "Respondido. ¿Algo mas?");
    if (contexto?.documentos_sin_resumen) anotar(`${contexto.documentos_sin_resumen} documento(s) sin resumen: el asistente no los conoce`, "aviso");
    pintarSabe();
  } catch (e) {
    colaLocal?.cerrar();
    respuesta.contenido = (respuesta.contenido ? respuesta.contenido + "\n\n" : "") + `No pude responder: ${e.message}`;
    if (!historial.includes(respuesta)) historial.push(respuesta);
    pintarHistorial();
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
    const fuente = c.modo_fuentes === "live" ? "Fuentes públicas consultadas" : "Fuentes públicas verificadas";
    caja.innerHTML = `
      <div class="sabe-fila">${chip(`${c.prospectos} prospectos`, "neutra")} ${chip(`${c.cartera.length} en cartera`, c.cartera.length ? "ok" : "neutra")}
        ${chip(`${c.documentos.length} documentos`, "neutra")}
        ${c.empresa_en_pantalla ? chip(`en pantalla: ${escapar(c.empresa_en_pantalla)}`, "azul") : ""}</div>
      <h3 class="asistente-seccion">Cobertura</h3>
      <p class="pie">${escapar(fuente)} · radio de ${estado.radio} km.</p>
      ${c.cartera.length ? `<h3 class="asistente-seccion">Cartera activa</h3><p class="pie">${c.cartera.map(escapar).join(", ")}.</p>` : `<p class="pie">La cartera está vacía. El asistente puede comparar prospectos, pero aún no tiene fichas ni documentos. <a href="#empresas">Ir a Empresas</a>.</p>`}
      ${c.documentos.length ? `<h3 class="asistente-seccion">Evidencia documental</h3><ul class="refs">${c.documentos.map((d) => `<li>📄 ${escapar(d.archivo)} <span class="sub" style="display:inline">· ${escapar(d.empresa)}</span> ${d.con_resumen ? chip("analizado", "ok") : chip("pendiente", "aviso")}</li>`).join("")}</ul>` : ""}
      ${sinResumen.length ? `<p class="pie" style="color:var(--aviso)">${sinResumen.length} documento(s) pendientes de análisis. Puedes procesarlos desde <a href="#empresas">Empresas</a>.</p>` : ""}
      <h3 class="asistente-seccion">Criterio de respuesta</h3>
      <p class="pie">Separa evidencia medida, datos declarados y estimaciones. Cuando falta soporte, lo indica explícitamente.</p>`;
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
    $("asistente-entrada").addEventListener("input", ajustarEntrada);
    $("asistente-voz-auto").checked = leerSolas;
    $("asistente-voz-auto").addEventListener("change", (ev) => { leerSolas = ev.target.checked; if (!leerSolas) detenerAudio(); });
    $("asistente-limpiar").addEventListener("click", () => { historial.length = 0; detenerAudio(); pintarHistorial(); ponerEstado(ia?.disponible ? "reposo" : "sin_ia"); });
    $("asistente-historial").addEventListener("click", async (ev) => {
      const sugerencia = ev.target.closest("[data-pregunta]");
      if (sugerencia) { preguntar(sugerencia.dataset.pregunta); return; }
      const boton = ev.target.closest("[data-accion]");
      if (!boton) return;
      const mensaje = historial[Number(boton.dataset.indice)];
      if (!mensaje) return;
      if (boton.dataset.accion === "escuchar") { hablar(mensaje.contenido); return; }
      try { await navigator.clipboard.writeText(mensaje.contenido); boton.textContent = "Copiado"; }
      catch { boton.textContent = "No se pudo"; }
      setTimeout(() => { boton.textContent = "Copiar"; }, 1400);
    });
    window.addEventListener("hashchange", () => {
      const anterior = sessionStorage.getItem("simbia.modulo_actual") || "";
      sessionStorage.setItem("simbia.modulo_previo", anterior);
      sessionStorage.setItem("simbia.modulo_actual", (location.hash || "#inicio").slice(1).split("?")[0]);
    });
    montarDictado();
    try { ia = await pedir("/api/asistente/estado"); }
    catch (e) { ia = { disponible: false, motivo: e.message }; }
    const modeloVisible = ia?.modelo === "gpt-5.4-mini" ? "GPT-5.4 mini · análisis activo" : ia?.modelo;
    $("asistente-chip").innerHTML = ia.disponible
      ? chip(escapar(modeloVisible), "ok")
      : chip("IA no configurada", "aviso");
    $("asistente-voz-auto").closest("label").hidden = !(ia.disponible && ia.voz);
    if (!ia.disponible) {
      ponerEstado("sin_ia", ia.motivo);
      $("asistente-entrada").disabled = true; $("asistente-enviar").disabled = true;
      $("asistente-sabe").innerHTML = `<p class="pie">Sin proveedor de IA no hay nada que consultar. ${escapar(ia.motivo)}</p>`;
    } else {
      ponerEstado("reposo");
    }
    pintarHistorial();
  },
  async mostrar() { if (ia?.disponible) pintarSabe(); },
};
