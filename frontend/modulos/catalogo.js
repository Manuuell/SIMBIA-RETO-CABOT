/* Vecinos: «Analizar empresas», el catalogo armado a la vista.
 *
 * Antes de analizar, la pagina no ensena datos: solo el boton, las cuatro
 * etapas y un radar vacio alrededor de la planta. Al pulsar, el servidor
 * vuelve a cruzar y puntuar de verdad (refrescar=true, en el modo de fuentes
 * configurado), y el recorrido va contando lo que sale, con sus cifras:
 *
 *   1. OpenStreetMap   situa los establecimientos (el radar barre y aparecen)
 *   2. Actividad       el CIIU estima el agua de cada uno (crecen con su caudal)
 *   3. VITAL           cruza los permisos de vertimiento (se marcan en azul)
 *   4. Simbiosis       la quimica de la torre decide quien sirve (se colorean)
 *
 * Las pausas entre etapas son solo para poder leerlas; «Ver ya» las salta y
 * con movimiento reducido no existen. Cada vez que se entra a Vecinos se
 * empieza aqui (prospeccion.js decide cuando).
 */

import { $, cargarBarrido, escapar, estado, fechaCorta, fmt, nombreAutoridad, permisosDe } from "../comun.js";
import { colorPuntaje } from "../mapa.js";

const NS = "http://www.w3.org/2000/svg";
const W = 440, C = W / 2, R = W / 2 - 22;
const MS = { barrido: 1700, ciiu: 1500, vital: 1300, permiso: 260, simbiosis: 1500, cierre: 900 };

const ETAPAS = [
  { id: "osm", titulo: "OpenStreetMap", que: "Establecimientos alrededor de la planta" },
  { id: "ciiu", titulo: "Actividad económica", que: "Qué agua de rechazo produce cada sector" },
  { id: "vital", titulo: "VITAL", que: "Permisos de vertimiento de Cartagena" },
  { id: "simbiosis", titulo: "Simbiosis", que: "Qué mezcla mantiene los ciclos de la torre" },
];

const reducido = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let esperas = [];
let saltar = false;
let corriendo = false;

function pausa(ms) {
  if (saltar || reducido()) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    esperas.push(() => { clearTimeout(t); resolve(); });
  });
}

/** Si hay un recorrido a medias: volver a la seccion no debe pisarlo. */
export const enCurso = () => corriendo;

/** Cuando se consulto la fuente, dicho para personas: la fecha, no el mecanismo. */
function procedencia(origen, fecha) {
  if (origen === "red") return "consultado ahora";
  if (origen === "fixture") return "datos de ejemplo";
  return fecha ? `consulta del ${fechaCorta(fecha)}` : "";
}

// ---------------------------------------------------------------------------
// Radar
// ---------------------------------------------------------------------------

function el(nombre, attrs = {}, texto = null) {
  const n = document.createElementNS(NS, nombre);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (texto !== null) n.textContent = texto;
  return n;
}

function dibujarRadar() {
  const svg = el("svg", { viewBox: `0 0 ${W} ${W}`, class: "radar" });
  const k = R / estado.radio;
  const paso = estado.radio > 6 ? 2 : 1;
  for (let r = paso; r <= estado.radio + 1e-9; r += paso) {
    svg.appendChild(el("circle", { class: "radar-anillo", cx: C, cy: C, r: r * k }));
    svg.appendChild(el("text", { class: "radar-km", x: C + 4, y: C - r * k + 12 }, `${r} km`));
  }
  svg.appendChild(el("line", { class: "radar-eje", x1: C - R, y1: C, x2: C + R, y2: C }));
  svg.appendChild(el("line", { class: "radar-eje", x1: C, y1: C - R, x2: C, y2: C + R }));

  // El haz: cuñas finas de opacidad decreciente detras del borde de ataque,
  // que apunta al este y gira en sentido horario.
  const haz = el("g", { class: "radar-haz" });
  for (let i = 0; i < 9; i++) {
    const a0 = -(i + 1) * 5 * Math.PI / 180, a1 = -i * 5 * Math.PI / 180;
    haz.appendChild(el("path", {
      d: `M ${C} ${C} L ${C + R * Math.cos(a0)} ${C + R * Math.sin(a0)} A ${R} ${R} 0 0 1 ${C + R * Math.cos(a1)} ${C + R * Math.sin(a1)} Z`,
      "fill-opacity": (0.32 * (1 - i / 9)).toFixed(3),
    }));
  }
  haz.appendChild(el("line", { x1: C, y1: C, x2: C + R, y2: C }));
  svg.appendChild(haz);

  svg.appendChild(el("g", { class: "radar-puntos" }));
  svg.appendChild(el("g", { class: "radar-etiquetas" }));

  const planta = el("g", { class: "radar-planta" });
  planta.appendChild(el("circle", { cx: C, cy: C, r: 15 }));
  planta.appendChild(el("path", { d: `M ${C - 6} ${C - 7} L ${C + 7} ${C} L ${C - 6} ${C + 7} Z` }));
  planta.appendChild(el("text", { x: C, y: C + 31, "text-anchor": "middle" }, "Cabot"));
  svg.appendChild(planta);

  $("vec-radar").replaceChildren(svg);
  return svg;
}

/** Un punto por empresa, en su sitio. Su retraso de aparicion es el angulo
 * al que el haz lo alcanza, asi que el barrido los va descubriendo. */
function colocarPuntos(svg, prospectos) {
  const k = R / estado.radio;
  const caudalMax = Math.max(...prospectos.map((p) => p.caudal_m3_h), 1);
  const g = svg.querySelector(".radar-puntos");
  g.replaceChildren();
  const orden = [...prospectos].sort((a, b) => b.caudal_m3_h - a.caudal_m3_h);
  for (const p of orden) {
    let x = p.x_km * k, y = -p.y_km * k;
    const d = Math.hypot(x, y);
    if (d > R - 4) { x *= (R - 4) / d; y *= (R - 4) / d; }
    const angulo = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
    const r = 4 + 15 * Math.sqrt(p.caudal_m3_h / caudalMax);
    const punto = el("g", {
      class: "radar-punto", transform: `translate(${(C + x).toFixed(1)} ${(C + y).toFixed(1)})`,
      "data-viable": (p.puntaje || 0) > 0 ? "1" : "0",
      "data-permiso": permisosDe(p).length ? "1" : "0",
      "data-inferido": p.metodo_calidad === "inferido" ? "1" : "0",
      style: `--retraso:${Math.round(angulo / 360 * MS.barrido)}ms;--s0:${(3 / r).toFixed(3)};--tono:${colorPuntaje(p.puntaje)}`,
    });
    punto.appendChild(el("title", {}, p.nombre));
    punto.appendChild(el("circle", { class: "radar-permiso", r: r + 5 }));
    punto.appendChild(el("circle", { class: "radar-cuerpo", r }));
    g.appendChild(punto);
  }
  // Los tres mejores llevan su nombre al final, sacado a un lado con una
  // guia: en el corredor de Mamonal estan todos cerca de la planta y, puestos
  // junto al punto, se pisarian entre si y con la planta.
  const et = svg.querySelector(".radar-etiquetas");
  et.replaceChildren();
  const mejores = [...prospectos].sort((a, b) => (b.puntaje || 0) - (a.puntaje || 0)).slice(0, 3)
    .map((p, i) => ({ p, i, x: C + p.x_km * k, y: C - p.y_km * k }));
  for (const lado of [-1, 1]) {
    let previa = -Infinity;
    mejores.filter((m) => (m.x < C ? -1 : 1) === lado).sort((a, b) => a.y - b.y).forEach((m) => {
      const y = Math.max(m.y, previa + 22);
      previa = y;
      const x = C + lado * R * 0.46;
      const g = el("g", { style: `--retraso:${m.i * 180}ms` });
      g.appendChild(el("line", { x1: m.x, y1: m.y, x2: x - lado * 4, y2: y - 4 }));
      g.appendChild(el("text", { x, y, "text-anchor": lado < 0 ? "end" : "start" },
        m.p.nombre.length > 20 ? m.p.nombre.slice(0, 19) + "…" : m.p.nombre));
      et.appendChild(g);
    });
  }
}

function fase(svg, nombre) {
  svg.dataset.fase = nombre;
}

// ---------------------------------------------------------------------------
// Etapas
// ---------------------------------------------------------------------------

function etapa(id, clase, cifra = null) {
  const li = $("vec-etapas").querySelector(`[data-etapa="${id}"]`);
  li.classList.remove("activa", "hecha", "error");
  li.classList.add(clase);
  if (clase === "activa") li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  if (cifra !== null) li.querySelector(".vec-etapa-cifra").innerHTML = cifra;
  // La lista de permisos alarga el panel: la etapa en curso no se sale de la vista.
  if (clase === "activa") requestAnimationFrame(() => li.scrollIntoView({ behavior: reducido() ? "auto" : "smooth", block: "nearest" }));
  return li;
}

/** Cuenta de 0 a n en los <b data-n> de un contenedor. */
function contar(contenedor) {
  contenedor.querySelectorAll("b[data-n]").forEach((b) => {
    const n = Number(b.dataset.n), dec = Number(b.dataset.dec || 0);
    if (reducido() || saltar) { b.textContent = fmt.num(n, dec); return; }
    const t0 = performance.now(), dur = 700;
    const paso = (t) => {
      const f = Math.min(1, (t - t0) / dur);
      b.textContent = fmt.num(n * (1 - (1 - f) ** 3), dec);
      if (f < 1) requestAnimationFrame(paso);
    };
    requestAnimationFrame(paso);
  });
}

const num = (n, dec = 0) => `<b data-n="${n}" data-dec="${dec}">0</b>`;

// ---------------------------------------------------------------------------
// Vista
// ---------------------------------------------------------------------------

/** El estado de partida: boton, etapas pendientes y radar vacio. */
export function pintarArranque() {
  $("vec-analisis").innerHTML = `
    <div class="vec-arranque">
      <div class="vec-arranque-texto">
        <p class="vec-antetitulo">Catálogo de vecinos</p>
        <h2>¿Quién, alrededor de la planta, produce agua que le sirva a la torre?</h2>
        <p class="vec-arranque-intro">SIMBIA sitúa las empresas con OpenStreetMap, estima por su actividad el agua de
          rechazo de cada una, cruza los permisos de vertimiento de VITAL y prueba con la química de la torre cuáles sirven.</p>
        <ol class="vec-etapas" id="vec-etapas">${ETAPAS.map((e, i) => `
          <li class="vec-etapa" data-etapa="${e.id}">
            <span class="vec-etapa-n" aria-hidden="true"><span>${i + 1}</span></span>
            <div class="vec-etapa-cuerpo">
              <b class="vec-etapa-titulo">${e.titulo}</b>
              <span class="vec-etapa-que">${e.que}</span>
              <span class="vec-etapa-cifra"></span>
              <div class="vec-etapa-extra"></div>
            </div>
          </li>`).join("")}
        </ol>
        <div class="vec-arranque-acciones">
          <button class="vec-analizar" id="btn-analizar-vecinos">Analizar empresas</button>
          <button class="secundario pequeno" id="btn-saltar-analisis" hidden>Ver el catálogo ya</button>
          <span class="pie" id="vec-arranque-pie">Radio de ${estado.radio} km alrededor de la planta</span>
        </div>
      </div>
      <div class="vec-radar" id="vec-radar" aria-hidden="true"></div>
    </div>`;
  dibujarRadar();
}

/** Corre el analisis y el recorrido. `alTerminar` muestra el catalogo. */
export async function analizar(alTerminar) {
  const boton = $("btn-analizar-vecinos"), saltarBtn = $("btn-saltar-analisis");
  saltar = false; esperas = []; corriendo = true;
  boton.disabled = true; boton.textContent = "Analizando…";
  saltarBtn.hidden = false;
  saltarBtn.onclick = () => { saltar = true; esperas.splice(0).forEach((f) => f()); };
  $("vec-analisis").classList.add("en-curso");
  $("vec-analisis").scrollIntoView({ behavior: reducido() ? "auto" : "smooth", block: "start" });
  const svg = dibujarRadar();
  fase(svg, "buscando");
  etapa("osm", "activa", "Consultando…");

  let b;
  try {
    [b] = await Promise.all([cargarBarrido({ refrescar: true }), pausa(500)]);
  } catch (e) {
    etapa("osm", "error", `<span class="vec-etapa-fallo">${escapar(e.message)}</span>`);
    boton.disabled = false; boton.textContent = "Reintentar";
    saltarBtn.hidden = true;
    $("vec-analisis").classList.remove("en-curso");
    corriendo = false;
    return;
  }

  // 1 · OpenStreetMap: el haz barre y aparecen los establecimientos.
  const osm = (b.fuentes || []).find((f) => f.fuente === "osm") || {};
  colocarPuntos(svg, b.prospectos);
  fase(svg, "osm");
  const cuandoOsm = procedencia(osm.origen, osm.fecha_dato);
  contar(etapa("osm", "activa",
    `${num(osm.registros ?? 0)} registros con polígono${cuandoOsm ? ` · ${escapar(cuandoOsm)}` : ""}`));
  await pausa(MS.barrido);
  etapa("osm", "hecha");

  // 2 · Actividad economica: cada uno crece con el agua que se le estima.
  const r = b.resumen;
  fase(svg, "ciiu");
  contar(etapa("ciiu", "activa",
    `${num(r.detectados)} con agua de proceso · ${num(r.caudal_total_m3_h)} m³/h de rechazo estimado`
    + (r.descartados_sin_arquetipo ? `<span class="vec-etapa-nota">${r.descartados_sin_arquetipo} descartados: oficinas, bodegas o patios sin agua de proceso</span>` : "")));
  await pausa(MS.ciiu);
  etapa("ciiu", "hecha");

  // 3 · VITAL: los que tienen permiso de vertimiento se marcan uno a uno.
  const pv = b.permisos || {};
  const conPermiso = b.prospectos.map((p) => ({ p, permisos: permisosDe(p) })).filter((x) => x.permisos.length)
    .sort((a, c) => (c.p.puntaje || 0) - (a.p.puntaje || 0));
  fase(svg, "vital");
  const li = etapa("vital", "activa",
    `${num(pv.total ?? 0)} permisos de vertimiento · ${num(conPermiso.length)} empresas del catálogo con el suyo`
    + `<span class="vec-etapa-nota">${escapar(procedencia(pv.origen, pv.fecha_dato))}</span>`);
  contar(li);
  li.querySelector(".vec-etapa-extra").innerHTML = `<ul class="vec-etapa-permisos">${conPermiso.map(({ p, permisos }, i) => {
    const t = permisos[0];
    const autoridad = nombreAutoridad(t.autoridad);
    return `<li style="--retraso:${i * MS.permiso}ms" title="${escapar(`${p.nombre} · ${autoridad}${permisos.length > 1 ? ` · ${permisos.length} trámites` : ""}`)}">
      <b>${escapar(p.nombre)}</b><span>${escapar(autoridad.split(" ")[0])}${t.fecha ? ` ${t.fecha.slice(0, 4)}` : ""}</span></li>`;
  }).join("")}</ul>`;
  await pausa(MS.vital + conPermiso.length * MS.permiso);
  etapa("vital", "hecha");

  // 4 · Simbiosis: la quimica decide; los que no mantienen los ciclos se apagan.
  fase(svg, "simbiosis");
  const mejores = [...b.prospectos].sort((a, c) => (c.puntaje || 0) - (a.puntaje || 0)).slice(0, 3);
  contar(etapa("simbiosis", "activa",
    `${num(r.viables)} de ${r.detectados} mantienen los ciclos · ${num(r.caudal_viable_m3_h)} m³/h viables`
    + `<span class="vec-etapa-nota">Mejor puntaje: ${mejores.map((p) => `${escapar(p.nombre)} ${Math.round(p.puntaje || 0)}`).join(" · ")}</span>`));
  await pausa(MS.simbiosis);
  etapa("simbiosis", "hecha");

  boton.textContent = "Catálogo listo";
  saltarBtn.hidden = true;
  await pausa(MS.cierre);
  corriendo = false;
  $("vec-analisis").classList.remove("en-curso");
  alTerminar(b);
}
