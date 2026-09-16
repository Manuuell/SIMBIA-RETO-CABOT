/* Utilidades compartidas por todos los modulos del dashboard. */

import { fmt } from "./graficos.js";

export { fmt };
export const $ = (id) => document.getElementById(id);

export async function pedir(ruta, cuerpo) {
  const r = await fetch(ruta, cuerpo === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  if (r.status === 401) {
    // La sesion caduco o no existe: a la pagina de acceso, volviendo aqui despues.
    location.replace(`/acceso?siguiente=${encodeURIComponent(location.pathname + location.hash)}`);
    throw new Error("Sesion requerida");
  }
  if (!r.ok) throw new Error(`${ruta}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

export const escapar = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function kpi(etiqueta, valor, detalle, clase = "") {
  return `<div class="tarjeta kpi ${clase}">
    <div class="etiqueta">${etiqueta}</div>
    <div class="valor">${valor}</div>
    <div class="detalle">${detalle}</div>
  </div>`;
}

export const sello = (m) => `<span class="sello ${m}">${m}</span>`;
export const chip = (texto, clase = "neutra") => `<span class="chip ${clase}">${texto}</span>`;

export function barraConfianza(p) {
  return `<span class="conf ${p.confianza_etiqueta}" title="Confianza ${p.confianza}">
    <i style="--pct:${(p.confianza * 100).toFixed(0)}%"></i>
    <span style="font-size:11px">${p.confianza_etiqueta}</span>
  </span>`;
}

export function fechaCorta(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
}

export function error(contenedor, e) {
  contenedor.innerHTML = `<div class="error">${escapar(e.message || e)}</div>`;
}

// ---------------------------------------------------------------------------
// Almacen compartido. Los modulos leen de aqui y se suscriben a los cambios.
// ---------------------------------------------------------------------------

const oyentes = {};

export const bus = {
  on(evento, fn) { (oyentes[evento] ||= []).push(fn); },
  emit(evento, dato) { (oyentes[evento] || []).forEach((fn) => fn(dato)); },
};

export const estado = {
  config: null,        // /api/scout/estado
  escenario: null,     // /api/escenario
  oferentes: [],       // /api/oferentes
  barrido: null,       // /api/scout/barrido
  pipeline: null,      // /api/scout/pipeline
  vigilancia: null,    // /api/scout/vigilancia
  radio: 8,
  cargandoBarrido: null,
};

/** Carga (o recarga) el barrido y todo lo que depende de el. */
export async function cargarBarrido({ refrescar = false, modo = null } = {}) {
  if (estado.cargandoBarrido && !refrescar) return estado.cargandoBarrido;
  const q = new URLSearchParams({ radio_km: estado.radio });
  if (refrescar) q.set("refrescar", "true");
  if (modo) q.set("modo", modo);
  estado.cargandoBarrido = (async () => {
    const d = await pedir(`/api/scout/barrido?${q}`);
    const [pipe, vig] = await Promise.all([
      pedir(`/api/scout/pipeline?radio_km=${estado.radio}`),
      pedir(`/api/scout/vigilancia?radio_km=${estado.radio}`),
    ]);
    estado.barrido = d; estado.pipeline = pipe; estado.vigilancia = vig;
    bus.emit("barrido", d);
    return d;
  })();
  try { return await estado.cargandoBarrido; }
  finally { /* se mantiene la promesa para deduplicar; refrescar la sustituye */ }
}

export async function recargarPipeline() {
  const [pipe, vig] = await Promise.all([
    pedir(`/api/scout/pipeline?radio_km=${estado.radio}`),
    pedir(`/api/scout/vigilancia?radio_km=${estado.radio}`),
  ]);
  estado.pipeline = pipe; estado.vigilancia = vig;
  bus.emit("pipeline", pipe);
}

/** Clave -> prospecto, sobre el barrido actual. */
export const prospectoPorClave = (clave) =>
  (estado.barrido?.prospectos || []).find((p) => p.clave === clave);

export const tienePermiso = (p) => (p.referencias || []).some((r) => r.fuente === "vital");

// ---------------------------------------------------------------------------
// Bitacora: la lista de lo que hizo el sistema, para el modulo de datos.
// ---------------------------------------------------------------------------

const lineas = [];

export function anotar(texto, tono = "neutra", sub = "") {
  const ahora = new Date();
  lineas.push({
    hora: ahora.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    texto, tono, sub,
  });
  bus.emit("bitacora", lineas);
}

export function limpiarBitacora() {
  lineas.length = 0;
  bus.emit("bitacora", lineas);
}

export const bitacora = () => lineas;

// ---------------------------------------------------------------------------
// Derecho de peticion: el texto que convierte un numero de expediente en una
// solicitud que la autoridad responde. Lo usan Datos externos y el buscador.
// ---------------------------------------------------------------------------

export function textoSolicitud({ empresa, autoridad, expediente }) {
  return `Señores
${autoridad || "Autoridad ambiental competente"}
Cartagena de Indias

Asunto: Derecho de peticion de informacion (art. 23 C.P., Ley 1755 de 2015) - expediente ${expediente}

[Nombre del solicitante], identificado(a) con [documento], en representacion de [empresa],
en ejercicio del derecho de peticion solicito copia de los siguientes documentos del
expediente ${expediente}, correspondiente al permiso de vertimiento de ${empresa}:

1. Acto administrativo que otorga o renueva el permiso de vertimiento, con el caudal autorizado.
2. Caracterizacion fisicoquimica mas reciente del vertimiento (Resolucion 0631 de 2015),
   incluyendo pH, temperatura, solidos suspendidos totales, DQO, cloruros, sulfatos, dureza,
   alcalinidad, silice, nitrogeno amoniacal y fosforo total.
3. Informes de monitoreo del ultimo año, si los hubiere.

Motivo: evaluacion tecnica de reutilizacion de aguas de rechazo industriales en sistemas de
enfriamiento (simbiosis hidrica industrial), en el corredor de Mamonal.

Autorizo notificaciones al correo [correo electronico].

Atentamente,
[Nombre y firma]`;
}

/** Nucleo de una razon social para buscarla: sin sufijos ni particulas. */
export function nombreParaBuscar(nombre) {
  const sin = String(nombre || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(s\.?a\.?s?|ltda|sas|e\.?s\.?p|cia|compania|colombiana|colombia|planta|de|del|la|el|y)\b/gi, " ")
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .trim().split(/\s+/).filter(Boolean);
  return sin.slice(0, 2).join(" ");
}

export async function copiar(texto) {
  try { await navigator.clipboard.writeText(texto); return true; }
  catch { return false; }
}
