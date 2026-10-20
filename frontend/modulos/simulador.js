/* Gemelo de la torre: vista 3D, mandos de operador y tendencias.
 *
 * La simulacion vive en el backend (/api/simulador/dinamica) y no guarda
 * nada: cada medio segundo esta pantalla le manda el estado y los mandos y
 * recibe el siguiente tramo de tiempo. Asi un cambio de consigna se nota en
 * el siguiente tramo, como en un DCS.
 *
 * Lo que el operador ajusta (consignas, vecinos, datos de planta) se guarda
 * en localStorage para no perderlo al recargar; la simulacion arranca siempre
 * de la operacion actual en regimen.
 */

import { $, chip, escapar, estado as global, fmt, pedir, sello } from "../comun.js";

const CLAVE = "simbia.gemelo.v1";
const TICK_MS = 500;
const VENTANA_H = 48;
const VELOCIDADES = [
  { h: 1 / 60, et: "1 min/s" }, { h: 1 / 6, et: "10 min/s" }, { h: 1, et: "1 h/s" }, { h: 6, et: "6 h/s" },
];
const CAMPOS_PLANTA = [
  { clave: "consumo_total_m3_dia", etiqueta: "Consumo total de la planta", unidad: "m³/d" },
  { clave: "caudal_circulacion_m3_h", etiqueta: "Caudal de recirculación", unidad: "m³/h" },
  { clave: "delta_t_c", etiqueta: "Salto térmico de diseño", unidad: "°C" },
  { clave: "ciclos_actuales", etiqueta: "Ciclos actuales", unidad: "" },
  { clave: "conductividad_reposicion_us_cm", etiqueta: "Conductividad de la reposición", unidad: "µS/cm" },
  { clave: "conductividad_purga_us_cm", etiqueta: "Conductividad de la purga", unidad: "µS/cm" },
  { clave: "reposicion_medida_m3_h", etiqueta: "Reposición medida", unidad: "m³/h" },
  { clave: "costo_agua_cruda_usd_m3", etiqueta: "Coste del agua cruda", unidad: "USD/m³" },
];
const PARAMS = ["ph", "t_c", "tds", "dureza_ca", "alcalinidad", "cloruros", "sulfatos", "silice", "sst", "dqo", "n_amoniacal", "fosfatos", "hierro"];
const CAMPOS_FUENTE = ["id", "nombre", "caudal_disponible_m3_h", "distancia_km", "precio_usd_m3", "procedencia", "confianza", "sector", "corriente", "tren_sugerido"];
const COLOR = { pv: "#f2762e", sp: "#0f1b24", limite: "#c9372e", cruda: "#2f7fc1", vecinos: "#1e9e63", purga: "#c9901f", evap: "#67747e", lsi: "#d99a0b", ls: "#b48ead" };

let ref = null;          // /api/simulador/referencia
let candidatos = null;   // /api/simulador/candidatos
let T3 = null;           // modulo torre3d.js, se carga al entrar
let torre = null;
const op = cargar() || nuevo();
const sim = { estado: null, info: null, historia: [], ultima: null, jugando: true, pidiendo: false, temporizador: null, geoClave: "" };

// ---------------------------------------------------------------------------
// Estado del operador
// ---------------------------------------------------------------------------

function nuevo() {
  return {
    planta: {}, agua: {}, fuentes: [], tomas: {},
    acido: 0, ventilador: 100, carga: 100, bulbo: 27,
    nivel: { modo: "auto", sp: 67, out: 45 }, cond: { modo: "auto", sp: null, out: 30, rampa: 0 },
    velocidad: 2,
  };
}
function guardar() { try { localStorage.setItem(CLAVE, JSON.stringify(op)); } catch { /* sin almacenamiento */ } }
function cargar() {
  try { const o = JSON.parse(localStorage.getItem(CLAVE)); return o && o.nivel ? { ...nuevo(), ...o } : null; }
  catch { return null; }
}

const soloParams = (c) => Object.fromEntries(PARAMS.filter((p) => c?.[p] != null).map((p) => [p, c[p]]));
// Sin "-0,0": por debajo de la precision mostrada, cero.
const num = (v, d = 1) => (v == null || Number.isNaN(v) ? "—" : fmt.num(Math.abs(v) < 0.5 * 10 ** -d ? 0 : v, d));
const tren = (codigo) => ref?.trenes.find((t) => t.codigo === codigo) || { recuperacion: 1 };

function cuerpo(horas) {
  const planta = { agua_cruda: { ...op.agua } };
  for (const c of CAMPOS_PLANTA) if (op.planta[c.clave] != null) planta[c.clave] = op.planta[c.clave];
  return {
    planta,
    fuentes: op.fuentes.map((f) => ({
      ...Object.fromEntries(CAMPOS_FUENTE.map((k) => [k, f[k]]).filter(([, v]) => v != null)),
      calidad: soloParams(f.calidad),
    })),
    tomas: op.fuentes.map((f) => ({ fuente_id: f.id, caudal_m3_h: op.tomas[f.id]?.caudal ?? 0, tren: op.tomas[f.id]?.tren || f.tren_sugerido || "T1" })),
    acido_mg_l: op.acido,
    ventilador_pct: op.ventilador,
    carga_pct: op.carga,
    t_bulbo_c: op.bulbo,
    nivel: { modo: op.nivel.modo, consigna: op.nivel.sp, salida_pct: op.nivel.out },
    conductividad: { modo: op.cond.modo, consigna: op.cond.sp, salida_pct: op.cond.out, rampa_por_h: op.cond.rampa || 0 },
    estado: sim.estado,
    horas,
  };
}

// ---------------------------------------------------------------------------
// Bucle de simulacion
// ---------------------------------------------------------------------------

async function tramo(horas) {
  sim.pidiendo = true;
  try {
    const r = await pedir("/api/simulador/dinamica", cuerpo(horas));
    sim.info = r;
    sim.estado = r.estado;
    if (op.cond.sp == null) op.cond.sp = r.base.conductividad_consigna;
    sim.historia.push(...r.muestras);
    const desde = sim.estado.t_h - VENTANA_H;
    while (sim.historia.length && sim.historia[0].t_h < desde) sim.historia.shift();
    sim.ultima = r.muestras[r.muestras.length - 1];
    await asegurarTorre(r.geometria);
    pintar();
  } catch (e) {
    sim.jugando = false;
    pintarTransporte();
    $("gem-alarmas").innerHTML = `<div class="gem-alarma alta"><b>SIM</b> ${escapar(e.message)}</div>`;
  } finally {
    sim.pidiendo = false;
  }
}

function programar() {
  clearTimeout(sim.temporizador);
  sim.temporizador = setTimeout(async () => {
    if (sim.jugando && !sim.pidiendo && document.getElementById("mod-simulador").classList.contains("activo")) {
      await tramo(VELOCIDADES[op.velocidad].h * TICK_MS / 1000);
    }
    programar();
  }, TICK_MS);
}

function reiniciar() {
  sim.estado = null;
  sim.historia = [];
  tramo(1 / 12);
}

async function asegurarTorre(geo) {
  const clave = JSON.stringify(geo);
  if (torre && sim.geoClave === clave) return;
  if (!T3) T3 = await import("../torre3d.js");
  torre?.destruir();
  $("gem-3d").innerHTML = "";
  torre = T3.crearTorre($("gem-3d"), geo, { vecinos: vecinosVisibles() });
  sim.geoClave = clave;
  $("gem-sub").textContent = `${geo.celdas} celdas de ${num(geo.lado_celda_m)} m · tiro inducido, contraflujo · `
    + `ventiladores de ${num(geo.diametro_ventilador_m)} m a ${num(geo.rpm_nominal, 0)} rpm · ${num(geo.volumen_sistema_m3, 0)} m³ en el sistema`;
}

const vecinosVisibles = () => op.fuentes.map((f) => ({ fuente_id: f.id, nombre: f.nombre }));

// ---------------------------------------------------------------------------
// Pintado
// ---------------------------------------------------------------------------

function reloj(t) {
  const dia = Math.floor(t / 24) + 1, h = t % 24;
  const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
  return `Día ${dia} · ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function pintar() {
  const m = sim.ultima, r = sim.info;
  if (!m || !r) return;
  $("gem-reloj").textContent = reloj(m.t_h);
  torre?.actualizar(m, { acido: op.acido, evaporacionBase: r.base.reposicion_m3_h * (r.base.ciclos - 1) / r.base.ciclos });

  const meta = 0.10;
  const ahorrado = (sim.estado.base_acumulada_m3 - sim.estado.cruda_acumulada_m3);
  // Con un tren que no basta, el agua entra pero ese ahorro no se puede firmar.
  const sinValidez = (m.tomas || []).some((t) => t.pedido_m3_h > 0 && !t.admisible);
  const tono = sinValidez || m.ahorro_pct < 0 ? "alerta" : m.ahorro_pct >= meta ? "ok" : "";
  $("gem-kpis").innerHTML = `
    <div><span>Reducción del consumo</span><b class="${tono}">${num(m.ahorro_pct * 100)} %</b><i>${sinValidez ? "no vale: revisa los vecinos" : "meta 10 %"}</i></div>
    <div><span>Ciclos</span><b>${num(m.ciclos, 2)}</b><i>hoy ${num(r.base.ciclos, 1)}</i></div>
    <div><span>Agua cruda</span><b>${num(m.cruda_m3_h)} <small>m³/h</small></b><i>hoy ${num(r.base.reposicion_m3_h)}</i></div>
    <div><span>Purga</span><b>${num(m.purga_m3_h)} <small>m³/h</small></b><i>hoy ${num(r.base.purga_m3_h)}</i></div>
    <div><span>Agua cruda ahorrada</span><b>${num(ahorrado, 0)} <small>m³</small></b><i>desde el inicio</i></div>`;

  const alarmas = m.alarmas || [];
  $("gem-alarmas").innerHTML = alarmas.length
    ? alarmas.map((a) => `<div class="gem-alarma ${a.severidad}"><b>${escapar(a.tag)}</b> ${escapar(a.texto)}</div>`).join("")
    : `<div class="gem-sin-alarmas">Sin alarmas activas</div>`;

  pintarLecturas(m, r);
  pintarTendencias(r);
}

/** Actualiza solo las lecturas de los faceplates (no reconstruye los mandos). */
function pintarLecturas(m, r) {
  const set = (id, v) => { const n = document.getElementById(id); if (n) n.textContent = v; };
  set("fp-cond-pv", num(m.conductividad, 0));
  set("fp-cond-sp", num(op.cond.sp, 0));
  const rampando = m.consigna_cond != null && Math.abs(m.consigna_cond - op.cond.sp) > 1;
  set("fp-cond-ciclos", `≈ ${num(op.cond.sp / (m.conductividad / (m.ciclos || 1)), 2)} ciclos`
    + (rampando ? ` · en rampa: ${num(m.consigna_cond, 0)} µS/cm` : ""));
  set("fp-cond-rampa", num(op.cond.rampa || 0, 1));
  set("fp-cond-out", `${num(m.av_pct, 0)} %`);
  barra("fp-cond-bar", m.av_pct);
  set("fp-niv-pv", num(m.nivel_pct, 1));
  set("fp-niv-sp", num(op.nivel.sp, 0));
  set("fp-niv-out", `${num(m.lv_pct, 0)} %`);
  barra("fp-niv-bar", m.lv_pct);
  set("fp-acido-sp", num(op.acido, 1));
  set("fp-acido-kg", `${num(op.acido * m.reposicion_m3_h / 1000, 2)} kg/h · pH ${num(m.ph, 2)}`);
  set("fp-vent-sp", num(op.ventilador, 0));
  set("fp-vent-info", `${num(m.rpm, 0)} rpm · ${num(m.potencia_ventiladores_kw, 0)} kW · agua fría ${num(m.t_fria_c)} °C`);
  set("fp-carga-sp", num(op.carga, 0));
  set("fp-bulbo-sp", num(op.bulbo, 1));
  set("fp-proc-info", `evaporación ${num(m.evaporacion_m3_h)} m³/h · agua caliente ${num(m.t_caliente_c)} °C`);
  document.querySelectorAll("[data-modo-lazo]").forEach((b) => {
    const lazo = op[b.dataset.modoLazo];
    b.textContent = lazo.modo === "auto" ? "AUTO" : "MAN";
    b.classList.toggle("man", lazo.modo === "man");
  });
  document.querySelectorAll("[data-sp-man]").forEach((fila) => { fila.hidden = op[fila.dataset.spMan].modo !== "man"; });
  document.querySelectorAll("[data-sp-auto]").forEach((fila) => { fila.hidden = op[fila.dataset.spAuto].modo === "man"; });
  set("fp-cond-man", num(op.cond.out, 0));
  set("fp-niv-man", num(op.nivel.out, 0));
  const porId = Object.fromEntries((m.tomas || []).map((t) => [t.fuente_id, t]));
  op.fuentes.forEach((f) => {
    const t = porId[f.id];
    set(`fp-v-${f.id}`, num(t?.caudal_m3_h ?? op.tomas[f.id]?.caudal ?? 0, 1));
    const aviso = document.getElementById(`fp-av-${f.id}`);
    if (!aviso) return;
    const textos = [];
    if (t?.pedido_m3_h > 0 && !t.admisible) textos.push(`${tren(t.tren).nombre ?? t.tren} no basta: ${t.motivo}.`);
    if (t?.pedido_m3_h > 0 && t.excede) textos.push(`Con este tren solo puede entregar ${num(t.maximo_m3_h)} m³/h.`);
    aviso.textContent = textos.join(" ");
    aviso.hidden = !textos.length;
  });
}

function barra(id, pct) {
  const n = document.getElementById(id);
  if (n) n.style.width = `${Math.min(Math.max(pct, 0), 100)}%`;
}

// ---------------------------------------------------------------------------
// Mandos
// ---------------------------------------------------------------------------

/** Pulsador que repite mientras se mantiene apretado. */
function pulsador(boton, accion) {
  let t1 = null, t2 = null;
  const parar = () => { clearTimeout(t1); clearInterval(t2); };
  boton.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    accion();
    t1 = setTimeout(() => { t2 = setInterval(accion, 70); }, 380);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => boton.addEventListener(ev, parar));
  boton.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); accion(); } });
}

function fila(etiqueta, id, unidad, paso, cambiar, extra = "") {
  return `<div class="fp-fila" ${extra}>
    <span class="fp-et">${etiqueta}</span>
    <div class="fp-paso"><button class="fp-menos" data-paso="${id}" data-dir="-1" aria-label="Bajar ${etiqueta}">−</button>
      <b id="${id}">—</b><button class="fp-mas" data-paso="${id}" data-dir="1" aria-label="Subir ${etiqueta}">+</button></div>
    <span class="fp-u">${unidad}</span>
  </div>`;
}

const CAMBIOS = {};
function registrar(id, paso, min, max, leer, escribir) {
  CAMBIOS[id] = (dir) => { escribir(Math.min(max, Math.max(min, Math.round((leer() + dir * paso) / paso) * paso))); guardar(); if (sim.ultima) pintarLecturas(sim.ultima, sim.info); };
}

function pintarMandos() {
  const caja = $("gem-mandos");
  caja.innerHTML = `
    <div class="fp">
      <div class="fp-cab"><b>AIC-102</b><span>Conductividad · purga</span><button class="fp-modo" data-modo-lazo="cond">AUTO</button></div>
      <div class="fp-pv"><b id="fp-cond-pv">—</b><span>µS/cm</span></div>
      <div data-sp-auto="cond">${fila("Consigna", "fp-cond-sp", "µS/cm", 25)}${fila("Rampa", "fp-cond-rampa", "µS/cm·h", 0.5)}
        <p class="fp-nota" id="fp-cond-ciclos"></p></div>
      <div data-sp-man="cond" hidden>${fila("Apertura", "fp-cond-man", "%", 1)}</div>
      <div class="fp-out"><span>AV-102</span><div class="fp-barra"><i id="fp-cond-bar"></i></div><b id="fp-cond-out">—</b></div>
    </div>
    <div class="fp">
      <div class="fp-cab"><b>LIC-101</b><span>Nivel de balsa · reposición</span><button class="fp-modo" data-modo-lazo="nivel">AUTO</button></div>
      <div class="fp-pv"><b id="fp-niv-pv">—</b><span>%</span></div>
      <div data-sp-auto="nivel">${fila("Consigna", "fp-niv-sp", "%", 1)}</div>
      <div data-sp-man="nivel" hidden>${fila("Apertura", "fp-niv-man", "%", 1)}</div>
      <div class="fp-out"><span>LV-101</span><div class="fp-barra"><i id="fp-niv-bar"></i></div><b id="fp-niv-out">—</b></div>
    </div>
    <div class="fp">
      <div class="fp-cab"><b>P-101</b><span>Dosificación de H₂SO₄</span></div>
      ${fila("Dosis", "fp-acido-sp", "mg/L", 0.5)}
      <p class="fp-nota" id="fp-acido-kg"></p>
    </div>
    <div class="fp">
      <div class="fp-cab"><b>SIC-103</b><span>Ventiladores</span></div>
      ${fila("Velocidad", "fp-vent-sp", "%", 5)}
      <p class="fp-nota" id="fp-vent-info"></p>
    </div>
    <div class="fp">
      <div class="fp-cab"><b>Proceso</b><span>Perturbaciones</span></div>
      ${fila("Carga térmica", "fp-carga-sp", "%", 5)}
      ${fila("Bulbo húmedo", "fp-bulbo-sp", "°C", 0.5)}
      <p class="fp-nota" id="fp-proc-info"></p>
    </div>
    <div class="fp">
      <div class="fp-cab"><b>FIC-2nn</b><span>Agua de vecinos</span></div>
      <div id="fp-vecinos"></div>
      <div class="fp-acciones">
        <button class="secundario pequeno" id="fp-agregar">＋ Añadir vecino</button>
        <button class="pequeno" id="fp-sugerir">Sugerir mezcla</button>
      </div>
      <div class="sim-selector" id="fp-selector" hidden>
        <input type="search" id="fp-buscar" placeholder="Buscar empresa…" autocomplete="off">
        <div class="sim-selector-lista" id="fp-lista"></div>
      </div>
      <p class="fp-nota" id="fp-sug-msg"></p>
    </div>
    <details class="fp fp-planta">
      <summary><b>Datos de planta</b><span id="fp-planta-nota"></span></summary>
      <p class="fp-nota">Vacío = valor de referencia (en gris). Al aplicar, la simulación vuelve a arrancar.</p>
      <div class="fp-campos" id="fp-planta"></div>
      <button class="pequeno" id="fp-aplicar">Aplicar y reiniciar</button>
    </details>`;

  registrar("fp-cond-sp", 25, 300, 6000, () => op.cond.sp ?? 0, (v) => { op.cond.sp = v; });
  registrar("fp-cond-man", 1, 0, 100, () => op.cond.out, (v) => { op.cond.out = v; });
  registrar("fp-cond-rampa", 0.5, 0, 50, () => op.cond.rampa || 0, (v) => { op.cond.rampa = v; });
  registrar("fp-niv-sp", 1, 20, 95, () => op.nivel.sp, (v) => { op.nivel.sp = v; });
  registrar("fp-niv-man", 1, 0, 100, () => op.nivel.out, (v) => { op.nivel.out = v; });
  registrar("fp-acido-sp", 0.5, 0, 80, () => op.acido, (v) => { op.acido = v; });
  registrar("fp-vent-sp", 5, 0, 100, () => op.ventilador, (v) => { op.ventilador = v; });
  registrar("fp-carga-sp", 5, 10, 120, () => op.carga, (v) => { op.carga = v; });
  registrar("fp-bulbo-sp", 0.5, 10, 33, () => op.bulbo, (v) => { op.bulbo = v; });
  caja.querySelectorAll("[data-paso]").forEach((b) => pulsador(b, () => CAMBIOS[b.dataset.paso]?.(Number(b.dataset.dir))));
  caja.querySelectorAll("[data-modo-lazo]").forEach((b) => b.addEventListener("click", () => {
    const lazo = op[b.dataset.modoLazo];
    // Paso sin salto: al ir a manual, la salida se queda donde estaba.
    if (lazo.modo === "auto") {
      lazo.modo = "man";
      lazo.out = Math.round(b.dataset.modoLazo === "cond" ? sim.ultima?.av_pct ?? lazo.out : sim.ultima?.lv_pct ?? lazo.out);
    } else lazo.modo = "auto";
    guardar();
    if (sim.ultima) pintarLecturas(sim.ultima, sim.info);
  }));
  $("fp-agregar").addEventListener("click", abrirSelector);
  $("fp-buscar").addEventListener("input", pintarSelector);
  $("fp-sugerir").addEventListener("click", sugerir);
  $("fp-aplicar").addEventListener("click", () => {
    guardar();
    torre?.destruir(); torre = null; sim.geoClave = "";
    reiniciar();
  });
  pintarPlanta();
  pintarVecinos();
}

function pintarPlanta() {
  const ph = (c) => ref?.planta?.[c.clave] != null ? num(ref.planta[c.clave], c.clave.includes("costo") ? 2 : 1) : "sin dato";
  $("fp-planta").innerHTML = CAMPOS_PLANTA.map((c) => `<label class="sim-campo${op.planta[c.clave] != null ? " de-planta" : ""}">
      <span class="sim-campo-et">${c.etiqueta}${c.unidad ? ` <i>${c.unidad}</i>` : ""}</span>
      <input type="number" step="any" min="0" data-campo="${c.clave}" value="${op.planta[c.clave] ?? ""}" placeholder="${ph(c)}"></label>`).join("")
    + (ref?.parametros || []).map((p) => `<label class="sim-campo${op.agua[p.clave] != null ? " de-planta" : ""}">
      <span class="sim-campo-et">Agua cruda · ${escapar(p.etiqueta)}${p.unidad ? ` <i>${escapar(p.unidad)}</i>` : ""}</span>
      <input type="number" step="any" min="0" data-param="${p.clave}" value="${op.agua[p.clave] ?? ""}" placeholder="${num(p.agua_cruda, p.agua_cruda < 10 ? 1 : 0)}"></label>`).join("");
  $("fp-planta").querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => {
    const v = inp.value.trim() === "" ? null : Number(inp.value);
    const destino = inp.dataset.campo ? op.planta : op.agua;
    const k = inp.dataset.campo || inp.dataset.param;
    if (v == null || Number.isNaN(v)) delete destino[k]; else destino[k] = v;
    inp.closest("label").classList.toggle("de-planta", v != null);
    notaPlanta();
  }));
  notaPlanta();
}

function notaPlanta() {
  const n = Object.keys(op.planta).length + Object.keys(op.agua).length;
  $("fp-planta-nota").textContent = n ? `${n} dato${n === 1 ? "" : "s"} de planta` : "todo de referencia";
}

function pintarVecinos() {
  const caja = $("fp-vecinos");
  if (!op.fuentes.length) {
    caja.innerHTML = `<p class="fp-nota">Sin vecinos: la torre solo toma agua cruda. Añade uno o pide la mezcla al optimizador.</p>`;
  } else {
    caja.innerHTML = op.fuentes.map((f, i) => {
      const t = op.tomas[f.id] || { caudal: 0, tren: f.tren_sugerido || "T1" };
      return `<div class="fp-vecino" data-id="${escapar(f.id)}">
        <div class="fp-vecino-cab"><b title="${escapar(f.nombre)}">FIC-${201 + i} · ${escapar(f.nombre)}</b> ${sello(f.procedencia || "supuesto")}
          <button class="fp-quitar" aria-label="Quitar ${escapar(f.nombre)}">✕</button></div>
        <select class="fp-tren">${(ref?.trenes || []).map((x) => `<option value="${x.codigo}"${x.codigo === t.tren ? " selected" : ""}>${x.codigo} · ${escapar(x.nombre)}</option>`).join("")}</select>
        ${fila("Caudal", `fp-v-${f.id}`, "m³/h", 0.5)}
        <p class="fp-aviso" id="fp-av-${escapar(f.id)}" role="status" hidden></p>
      </div>`;
    }).join("");
    op.fuentes.forEach((f) => {
      const max = f.caudal_disponible_m3_h * tren(op.tomas[f.id]?.tren || f.tren_sugerido || "T1").recuperacion;
      registrar(`fp-v-${f.id}`, 0.5, 0, Math.max(max, 0), () => op.tomas[f.id]?.caudal ?? 0,
        (v) => { op.tomas[f.id] = { ...(op.tomas[f.id] || { tren: f.tren_sugerido || "T1" }), caudal: v }; });
    });
    caja.querySelectorAll("[data-paso]").forEach((b) => pulsador(b, () => CAMBIOS[b.dataset.paso]?.(Number(b.dataset.dir))));
    caja.querySelectorAll(".fp-vecino").forEach((filaV) => {
      const id = filaV.dataset.id;
      filaV.querySelector(".fp-tren").addEventListener("change", (e) => {
        // Un tren con menos recuperacion entrega menos: el caudal no pasa del nuevo maximo.
        const f = op.fuentes.find((x) => x.id === id);
        const max = f.caudal_disponible_m3_h * tren(e.target.value).recuperacion;
        op.tomas[id] = { caudal: Math.min(op.tomas[id]?.caudal ?? 0, max), tren: e.target.value };
        guardar(); pintarVecinos();
      });
      filaV.querySelector(".fp-quitar").addEventListener("click", () => {
        op.fuentes = op.fuentes.filter((x) => x.id !== id);
        delete op.tomas[id];
        guardar(); pintarVecinos(); torre?.vecinos(vecinosVisibles());
      });
    });
  }
  if (sim.ultima) pintarLecturas(sim.ultima, sim.info);
}

async function cargarCandidatos() {
  if (!candidatos) candidatos = await pedir(`/api/simulador/candidatos?radio_km=${global.radio || 8}`);
  return candidatos;
}

function agregar(c, caudal = null) {
  if (op.fuentes.some((f) => f.id === c.id)) return false;
  op.fuentes.push({ ...c, calidad: soloParams(c.calidad) });
  const t = c.tren_sugerido || "T1";
  op.tomas[c.id] = { tren: t, caudal: caudal ?? Math.min(10, Math.floor(c.caudal_disponible_m3_h * tren(t).recuperacion * 2) / 2) };
  return true;
}

async function abrirSelector() {
  const sel = $("fp-selector");
  sel.hidden = !sel.hidden;
  if (sel.hidden) return;
  $("fp-lista").innerHTML = `<p class="cargando">Cargando prospectos…</p>`;
  await cargarCandidatos();
  pintarSelector();
  $("fp-buscar").focus();
}

function pintarSelector() {
  const q = $("fp-buscar").value.trim().toLowerCase();
  const lista = (candidatos || []).filter((c) => `${c.nombre} ${c.sector}`.toLowerCase().includes(q));
  $("fp-lista").innerHTML = lista.map((c) => {
    const ya = op.fuentes.some((f) => f.id === c.id);
    return `<button class="sim-opcion" data-id="${escapar(c.id)}"${ya ? " disabled" : ""}>
      <span><b>${escapar(c.nombre)}</b> ${sello(c.procedencia)}<span class="sub">${escapar(c.sector)}</span></span>
      <span class="sim-opcion-cifras">${fmt.num(c.caudal_disponible_m3_h)} m³/h<span class="sub">${ya ? "ya está" : `puntaje ${c.puntaje ?? "—"}`}</span></span>
    </button>`;
  }).join("") || `<p class="pie">Ningún prospecto coincide.</p>`;
  $("fp-lista").querySelectorAll(".sim-opcion").forEach((b) => b.addEventListener("click", () => {
    if (agregar(candidatos.find((x) => x.id === b.dataset.id))) {
      guardar(); pintarVecinos(); torre?.vecinos(vecinosVisibles());
    }
    $("fp-selector").hidden = true;
  }));
}

async function sugerir() {
  const b = $("fp-sugerir");
  b.disabled = true; b.textContent = "Optimizando…";
  try {
    const todos = !op.fuentes.length;
    if (todos) (await cargarCandidatos()).forEach((c) => agregar(c, 0));
    const c = cuerpo(1);
    delete c.estado;
    const r = await pedir("/api/simulador/sugerir", c);
    if (!r.decision) { $("fp-sug-msg").textContent = r.motivo; return; }
    const usados = new Set(r.decision.tomas.map((t) => t.fuente_id));
    if (todos) op.fuentes = op.fuentes.filter((f) => usados.has(f.id));
    for (const f of op.fuentes) op.tomas[f.id] = { ...op.tomas[f.id], caudal: 0 };
    for (const t of r.decision.tomas) op.tomas[t.fuente_id] = { caudal: t.caudal_m3_h, tren: t.tren };
    op.acido = r.decision.acido_mg_l;
    // La consigna de conductividad que corresponde a los ciclos propuestos,
    // con un 3 % de margen bajo el limite que manda.
    const res = r.resultado;
    if (res?.aporte?.conductividad && res.ciclos) {
      // Con rampa: la alcalinidad del circuito tarda dias en renovarse y un
      // escalon de consigna cruza el limite de LSI por el camino.
      op.cond = { ...op.cond, modo: "auto", sp: Math.round(res.ciclos * res.aporte.conductividad * 0.97 / 25) * 25, rampa: 2 };
    }
    $("fp-sug-msg").textContent = r.modo === "meta"
      ? `Propuesta del optimizador: ${num(res.ahorro_pct * 100)} % a ${num(res.ciclos, 1)} ciclos en régimen. La consigna sube en rampa de 2 µS/cm por hora para no cruzar el límite de incrustación mientras el circuito se renueva.`
      : "Con estos vecinos no se llega a la meta: es la mezcla más barata posible.";
    guardar(); pintarVecinos(); torre?.vecinos(vecinosVisibles());
  } catch (e) {
    $("fp-sug-msg").textContent = e.message;
  } finally {
    b.disabled = false; b.textContent = "Sugerir mezcla";
  }
}

// ---------------------------------------------------------------------------
// Transporte y vistas
// ---------------------------------------------------------------------------

function pintarTransporte() {
  $("gem-play").textContent = sim.jugando ? "❚❚" : "▶";
  $("gem-play").setAttribute("aria-label", sim.jugando ? "Pausar" : "Seguir");
  $("gem-velocidades").innerHTML = VELOCIDADES.map((v, i) =>
    `<button role="radio" aria-checked="${i === op.velocidad}" class="${i === op.velocidad ? "activa" : ""}" data-v="${i}">${v.et}</button>`).join("");
}

// ---------------------------------------------------------------------------
// Tendencias (lienzo, estilo DCS)
// ---------------------------------------------------------------------------

function tendencia(canvas, series, { min = null, max = null, decimales = 0 } = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const c = canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const todos = series.flatMap((s) => s.puntos.map((p) => p[1])).filter((v) => v != null && Number.isFinite(v));
  if (!todos.length) return;
  let lo = min ?? Math.min(...todos), hi = max ?? Math.max(...todos);
  if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const t1 = sim.estado?.t_h ?? 0, t0 = Math.max(0, t1 - VENTANA_H);
  const ml = 44, mr = 8, mt = 6, mb = 18;
  const X = (t) => ml + (t - t0) / Math.max(t1 - t0, 1e-6) * (w - ml - mr);
  const Y = (v) => mt + (1 - (v - lo) / (hi - lo)) * (h - mt - mb);
  c.font = "10px Inter, -apple-system, Segoe UI, sans-serif";
  c.fillStyle = "#67747e"; c.strokeStyle = "rgba(15,27,36,.08)"; c.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const v = lo + (hi - lo) * i / 3, y = Y(v);
    c.beginPath(); c.moveTo(ml, y); c.lineTo(w - mr, y); c.stroke();
    c.textAlign = "right"; c.fillText(v.toLocaleString("es", { maximumFractionDigits: decimales }), ml - 6, y + 3);
  }
  const paso = t1 - t0 > 24 ? 12 : t1 - t0 > 6 ? 2 : 1;
  c.textAlign = "center";
  for (let t = Math.ceil(t0 / paso) * paso; t <= t1; t += paso) {
    c.fillText(`${Math.round(t)} h`, X(t), h - 4);
  }
  for (const s of series) {
    c.beginPath();
    c.strokeStyle = s.color; c.lineWidth = s.grosor || 1.6;
    c.setLineDash(s.discontinua ? [5, 4] : []);
    let empezado = false;
    for (const [t, v] of s.puntos) {
      if (v == null) continue;
      if (!empezado) { c.moveTo(X(t), Y(v)); empezado = true; } else c.lineTo(X(t), Y(v));
    }
    c.stroke();
  }
  c.setLineDash([]);
}

function leyenda(id, items) {
  $(id).innerHTML = items.map(([t, col, disc]) => `<span><i style="background:${col}${disc ? ";height:0;border-top:2px dashed " + col + ";background:none" : ""}"></i>${t}</span>`).join("");
}

function pintarTendencias(r) {
  const H = sim.historia;
  const p = (k) => H.map((m) => [m.t_h, m[k]]);
  tendencia($("gem-t-cond"), [
    { puntos: H.map((m) => [m.t_h, r.limites.conductividad_us_cm]), color: COLOR.limite, discontinua: true, grosor: 1 },
    { puntos: H.map((m) => [m.t_h, m.consigna_cond ?? op.cond.sp]), color: COLOR.sp, discontinua: true, grosor: 1 },
    { puntos: p("conductividad"), color: COLOR.pv, grosor: 2 },
  ]);
  leyenda("gem-leg-cond", [["PV", COLOR.pv], ["consigna", COLOR.sp, true], ["límite", COLOR.limite, true]]);
  tendencia($("gem-t-caudal"), [
    { puntos: p("evaporacion_m3_h"), color: COLOR.evap },
    { puntos: p("cruda_m3_h"), color: COLOR.cruda, grosor: 2 },
    { puntos: p("vecinos_m3_h"), color: COLOR.vecinos, grosor: 2 },
    { puntos: p("purga_m3_h"), color: COLOR.purga, grosor: 2 },
  ], { min: 0, decimales: 0 });
  leyenda("gem-leg-caudal", [["cruda", COLOR.cruda], ["vecinos", COLOR.vecinos], ["purga", COLOR.purga], ["evaporación", COLOR.evap]]);
  tendencia($("gem-t-quim"), [
    { puntos: H.map((m) => [m.t_h, r.limites.lsi_max]), color: COLOR.lsi, discontinua: true, grosor: 1 },
    { puntos: H.map((m) => [m.t_h, r.limites.larson_skold_max]), color: COLOR.ls, discontinua: true, grosor: 1 },
    { puntos: p("lsi"), color: COLOR.lsi, grosor: 2 },
    { puntos: p("larson_skold"), color: COLOR.ls, grosor: 2 },
  ], { decimales: 1 });
  leyenda("gem-leg-quim", [["LSI", COLOR.lsi], ["Larson-Skold", COLOR.ls], ["límites", "#67747e", true]]);
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

async function atenderPendientes() {
  const pendientes = global.simuladorPendientes || [];
  if (!pendientes.length) return;
  global.simuladorPendientes = [];
  const lista = await cargarCandidatos();
  let alguno = false;
  for (const id of pendientes) {
    const c = lista.find((x) => x.id === id);
    if (c && agregar(c)) alguno = true;
  }
  if (alguno) { guardar(); pintarVecinos(); torre?.vecinos(vecinosVisibles()); }
}

export default {
  id: "simulador",
  async montar() {
    ref = await pedir("/api/simulador/referencia");
    pintarTransporte();
    pintarMandos();
    $("gem-play").addEventListener("click", () => { sim.jugando = !sim.jugando; pintarTransporte(); });
    $("gem-reiniciar").addEventListener("click", reiniciar);
    $("gem-velocidades").addEventListener("click", (e) => {
      const b = e.target.closest("[data-v]");
      if (!b) return;
      op.velocidad = Number(b.dataset.v); guardar(); pintarTransporte();
    });
    $("gem-vistas").addEventListener("click", (e) => {
      const b = e.target.closest("[data-vista]");
      if (!b) return;
      torre?.vista(b.dataset.vista);
      $("gem-vistas").querySelectorAll("button").forEach((x) => x.classList.toggle("activa", x === b));
    });
    window.addEventListener("resize", () => sim.info && pintarTendencias(sim.info));
    await tramo(1 / 12);
    programar();
  },
  async mostrar() {
    await atenderPendientes();
  },
};
