/* Recorrido de presentacion de SIMBIA en 3D: copia de la primera version (demo3d-v1.html).
 *
 * Siete modulos que avanzan con la narracion: cada uno muestra su escena en
 * el gemelo 3D y su panel con las cifras del caso. Lo que pasa en cada escena
 * (una etapa que aparece, la valvula que se cierra) va sincronizado con la
 * frase que lo dice: el avance del modulo es la fraccion del guion ya leida.
 *
 * La narracion usa la voz neural del servidor si esta configurada
 * (/api/asistente/voz), la del navegador si no, y sin voz avanza a ritmo de
 * lectura. Las tres "pistas" exponen lo mismo: progreso() de 0 a 1 y
 * terminada; pausar es detener la pista y reanudar es crear otra desde el
 * mismo punto.
 */

import { crearEscena } from "./demo3d-v1-escena.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fm = (n) => n.toFixed(1).replace(".", ",");
const nf = (n) => Math.round(n).toLocaleString("es-CO");

// ---------------------------------------------------------------------------
// Guion y cifras del caso
// ---------------------------------------------------------------------------

const NOMBRES = ["Panel ejecutivo", "Clúster Mamonal", "Optimizador", "Monitoreo", "Falla crítica", "CFO", "Reporte ESG"];
const GUION = [
  "Bienvenidos a SIMBIA, la plataforma inteligente de gestión hídrica empresarial. Observen en pantalla el gemelo digital de la planta de negro de humo de Cabot. Mapeamos el flujo integral: desde la captación de agua cruda y la piscina de almacenamiento, pasando por el enfriamiento del reactor de pirólisis, la separación de partículas, molienda, peletización y secado, hasta llegar a la piscina de mezcla y el sistema de tratamiento final. Nuestra meta es reducir el consumo de agua fresca en un diez por ciento, garantizando la viabilidad técnica y operativa.",
  "Para lograr esta meta, nos integramos con el clúster industrial de Mamonal. Al conectar fuentes de rechazo de empresas vecinas, como la Fuente B, SIMBIA monitorea de forma continua los parámetros fisicoquímicos: caudal, temperatura, conductividad y sólidos suspendidos. Así, aseguramos en tiempo real el estricto cumplimiento de la normativa ambiental, como la Resolución cero seis treinta y uno sobre vertimientos y la doce cincuenta y seis sobre reúso hídrico.",
  "El corazón de SIMBIA es su optimizador inteligente. A través de algoritmos predictivos, el sistema calcula la mezcla perfecta de efluentes, ajustando las proporciones para maximizar el ahorro económico y volumétrico, sin comprometer jamás la calidad química requerida para la integridad de los equipos de enfriamiento de Cabot.",
  "La digitalización nos permite tener el control absoluto. Los sensores IoT transmiten datos en tiempo real a nuestro cuadro de mando. Supervisamos las 24 horas las fluctuaciones volumétricas y térmicas, garantizando una trazabilidad hídrica impecable que sustenta los reportes de sostenibilidad corporativa y los criterios E, S, G.",
  "Pero, ¿qué sucede ante una emergencia? Si la conductividad de una fuente externa alcanza niveles críticos, SIMBIA no requiere intervención humana. El sistema detecta la anomalía, emite la alerta, bloquea automáticamente la válvula contaminada y compensa el flujo maximizando la recirculación intramuros. La operación de la planta permanece cien por ciento segura e ininterrumpida.",
  "Para el comité de inversiones, los números hablan por sí solos. Evaluamos el costo nivelado del agua a cinco años. El Modo A de simbiosis industrial, con un CAPEX de nueve mil dólares, reduce el costo a un mil trescientos nueve pesos por metro cúbico, generando un ahorro neto superior a noventa y dos millones de pesos. El Modo B de recuperación intramuros, actúa como respaldo, asegurando la autonomía hídrica en punto de equilibrio.",
  "Con un escenario optimista, logramos ahorrar más de treinta y un mil metros cúbicos de agua fresca al año. Cabot está listo, el ecosistema está listo. Es momento de iniciar el piloto de SIMBIA.",
];
const LARGO = GUION.map((s) => s.length);
const TOTAL = LARGO.reduce((a, b) => a + b, 0);
const ACUM = LARGO.map((_, i) => LARGO.slice(0, i).reduce((a, b) => a + b, 0));
const en = (i, frase) => { const j = GUION[i].indexOf(frase); return j < 0 ? 0 : j / LARGO[i]; };
// Frases por modulo, para los subtitulos.
const FRASES = GUION.map((t) => {
  let a = 0;
  return (t.match(/[^.?!]+[.?!]+\s*/g) || [t]).map((f) => { const o = { ini: a, fin: a + f.length, txt: f.trim() }; a += f.length; return o; });
});

// Momento del guion en que se nombra cada etapa de la planta (la 8, el
// almacenamiento de producto, no se nombra: aparece entre la 7 y la 9).
const ETAPAS_EN = ["captación", "piscina de almacenamiento", "reactor", "separación", "molienda", "peletización", "secado", "", "piscina de mezcla", "tratamiento final"].map((k) => (k ? en(0, k) : 0));
ETAPAS_EN[7] = (ETAPAS_EN[6] + ETAPAS_EN[8]) / 2;
const NOMBRES_ETAPAS = ["Captación (agua cruda)", "Piscina de almacenamiento", "Reactor (pirólisis)", "Separación de partículas", "Molienda", "Peletización", "Secado y clasificación", "Almacenamiento de producto", "Piscina de mezcla", "Tratamiento / Acondicionamiento"];
const EV = {
  b: en(1, "como la Fuente B"),
  fa: en(4, "Si la conductividad"), al: en(4, "emite la alerta"), v: en(4, "bloquea automáticamente"),
  c: en(4, "compensa el flujo"), s: en(4, "La operación de la planta"),
  ma: en(5, "El Modo A"), mb: en(5, "El Modo B"),
};

const TRM = 3500, AHORRO_M3 = 20850;
const MODOS = [
  { nombre: "Modo A (Simbiosis)", capex: 9000, opex: 6000, evitado: 45713625, lcow: "1.309" },
  { nombre: "Modo B (Recuperación)", capex: 15000, opex: 10000, evitado: 45713625, lcow: "2.182" },
];

// ---------------------------------------------------------------------------
// Escena
// ---------------------------------------------------------------------------

let pestanaForzada = null;
const cfoAbierto = [{ u: false, forzado: false }, { u: false, forzado: false }];
const escena = crearEscena($("#escena"), {
  etapas: ETAPAS_EN, modos: MODOS,
  alElegirModo(i) { const m = cfoAbierto[i]; m.u = !m.u; m.forzado = true; pestanaForzada = i; },
});

// ---------------------------------------------------------------------------
// Narracion
// ---------------------------------------------------------------------------

const CPS = 13.5;   // caracteres por segundo a ritmo de lectura
const voz = { activa: true, neural: false, navegador: "speechSynthesis" in window, eleccion: null, cps: CPS };
const audio = new Audio();
audio.preload = "auto";
const neurales = new Map();
const SILENCIO = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";

function audioNeural(m) {
  if (m < 0 || m >= GUION.length) return null;
  if (!neurales.has(m)) {
    const p = fetch("/api/asistente/voz", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texto: GUION[m] }),
    }).then((r) => {
      if (r.status === 503) voz.neural = false;
      if (!r.ok) throw new Error(String(r.status));
      return r.blob();
    }).then((b) => URL.createObjectURL(b));
    p.catch(() => neurales.delete(m));
    neurales.set(m, p);
  }
  return neurales.get(m);
}

function elegirVoz() {
  if (!voz.navegador) return;
  const nota = (v) => (/natural|google|neural|online|premium|enhanced|microsoft/i.test(v.name) ? 2 : 0)
    + (/es[-_](CO|MX|US|419)/i.test(v.lang) ? 1 : /es[-_]ES/i.test(v.lang) ? 0.5 : 0);
  voz.eleccion = speechSynthesis.getVoices().filter((v) => /^es/i.test(v.lang)).sort((a, b) => nota(b) - nota(a))[0] || null;
}
if (voz.navegador) { speechSynthesis.onvoiceschanged = elegirVoz; elegirVoz(); }

function pistaMuda(m, desde) {
  const t0 = performance.now();
  const p = {
    terminada: false,
    progreso(ahora) {
      const v = desde + (ahora - t0) / 1000 * CPS / LARGO[m];
      if (v >= 1) p.terminada = true;
      return Math.min(1, v);
    },
    detener() {},
  };
  return p;
}

// Voz del navegador por frases (las largas, por comas): Chrome corta las
// locuciones largas. El avance se estima con los caracteres por segundo que
// se van midiendo y se corrige con los eventos de palabra cuando los hay.
function pistaNavegador(m, desde) {
  const texto = GUION[m], largo = texto.length, trozos = [];
  let a = 0;
  for (const f of texto.match(/[^.?!]+[.?!]+\s*/g) || [texto]) {
    let resto = f;
    while (resto.length > 170) {
      const corte = resto.lastIndexOf(", ", 160);
      if (corte < 40) break;
      trozos.push({ ini: a, txt: resto.slice(0, corte + 2) });
      a += corte + 2;
      resto = resto.slice(corte + 2);
    }
    trozos.push({ ini: a, txt: resto });
    a += resto.length;
  }
  const p = {
    terminada: false, activa: true, n: 0, base: desde * largo, t0: performance.now(), resto: 0, vigia: 0,
    progreso(ahora) { return Math.min(largo, p.base + Math.min((ahora - p.t0) / 1000 * voz.cps, p.resto)) / largo; },
    detener() { p.activa = false; clearTimeout(p.vigia); speechSynthesis.cancel(); },
  };
  function decir(i, desdeCar) {
    const t = trozos[i];
    let ini = Math.max(0, Math.floor(desdeCar - t.ini));
    if (ini > 0) { const sp = t.txt.indexOf(" ", ini); ini = sp < 0 ? ini : sp + 1; }
    const txt = t.txt.slice(ini), n = ++p.n, inicio = performance.now();
    p.base = t.ini + ini; p.resto = txt.length; p.t0 = inicio;
    const sigue = () => { if (i + 1 < trozos.length) decir(i + 1, trozos[i + 1].ini); else p.terminada = true; };
    if (!txt.trim()) { sigue(); return; }
    const u = new SpeechSynthesisUtterance(txt.trim());
    u.lang = voz.eleccion ? voz.eleccion.lang : "es-ES";
    if (voz.eleccion) u.voice = voz.eleccion;
    u.rate = 0.95;
    u.onstart = () => { if (p.activa && n === p.n) p.t0 = performance.now(); };
    u.onboundary = (e) => {
      if (!p.activa || n !== p.n || e.name === "sentence") return;
      p.base = t.ini + ini + e.charIndex; p.resto = txt.length - e.charIndex; p.t0 = performance.now();
    };
    u.onend = () => {
      if (!p.activa || n !== p.n) return;
      const s = (performance.now() - inicio) / 1000;
      if (s > 0.6) voz.cps = voz.cps * 0.5 + (txt.length / s) * 0.5;
      clearTimeout(p.vigia);
      sigue();
    };
    u.onerror = (e) => {
      if (!p.activa || n !== p.n || e.error === "canceled" || e.error === "interrupted") return;
      voz.navegador = false;
      pintarVoz();
      relevar(p, () => pistaMuda(m, p.progreso(performance.now())));
    };
    speechSynthesis.speak(u);
    clearTimeout(p.vigia);
    p.vigia = setTimeout(() => {
      if (!p.activa || n !== p.n) return;
      p.n++;
      speechSynthesis.cancel();
      sigue();
    }, txt.length / voz.cps * 2500 + 5000);
  }
  speechSynthesis.cancel();
  const i0 = Math.max(0, trozos.findIndex((t) => t.ini + t.txt.length > desde * largo));
  decir(i0, desde * largo);
  return p;
}

function pistaNeural(m, desde) {
  const p = {
    terminada: false, activa: true, esperando: true, sonando: false,
    progreso() { return p.sonando && audio.duration ? audio.currentTime / audio.duration : desde; },
    detener() { p.activa = false; clearTimeout(p.limite); audio.pause(); },
  };
  const otra = () => (voz.navegador ? pistaNavegador(m, desde) : pistaMuda(m, desde));
  p.limite = setTimeout(() => relevar(p, otra), 9000);
  audioNeural(m).then((url) => {
    if (!p.activa) return;
    clearTimeout(p.limite);
    audio.onended = () => { if (p.activa) p.terminada = true; };
    const arrancar = () => {
      if (!p.activa) return;
      audio.currentTime = desde * (audio.duration || 0);
      audio.play().then(() => { p.sonando = true; p.esperando = false; }, () => { voz.neural = false; pintarVoz(); relevar(p, otra); });
    };
    audio.onloadedmetadata = arrancar;
    audio.src = url;
  }).catch(() => { voz.neural = false; pintarVoz(); relevar(p, otra); });
  return p;
}

function relevar(p, crear) {
  if (!p.activa || T.pista !== p) return;
  p.detener();
  T.pista = crear();
}

const T = { mod: -1, p: 0, pausado: true, fin: false, pista: null };

function nuevaPista(m, desde) {
  if (!voz.activa) return pistaMuda(m, desde);
  if (voz.neural) return pistaNeural(m, desde);
  if (voz.navegador) return pistaNavegador(m, desde);
  return pistaMuda(m, desde);
}

function detenerPista() {
  if (T.pista) { T.pista.detener(); T.pista = null; }
}

function iniciar(m) {
  detenerPista();
  T.mod = m; T.p = 0; T.fin = false; T.pausado = false;
  entrar(m);
  T.pista = nuevaPista(m, 0);
  if (voz.neural && voz.activa) audioNeural(m + 1);
  pintarBotones();
}

function pausar() {
  if (T.pausado) return;
  if (T.pista) T.p = Math.max(T.p, T.pista.progreso(performance.now()));
  detenerPista();
  T.pausado = true;
  pintarBotones();
}

function reanudar() {
  if (T.fin || T.mod < 0) { iniciar(0); return; }
  if (!T.pausado) return;
  T.pausado = false;
  T.pista = nuevaPista(T.mod, T.p);
  pintarBotones();
}

function terminar() {
  detenerPista();
  T.p = 1; T.fin = true; T.pausado = true;
  pintarBotones();
}

function avanzar(ahora) {
  if (!T.pista) return;
  T.p = Math.max(T.p, Math.min(1, T.pista.progreso(ahora)));
  if (T.pista.terminada) {
    if (T.mod < GUION.length - 1) iniciar(T.mod + 1);
    else terminar();
  }
}

// ---------------------------------------------------------------------------
// Interfaz
// ---------------------------------------------------------------------------

const pasos = $("#pasos");
NOMBRES.forEach((n, i) => {
  const b = document.createElement("button");
  b.className = "paso";
  b.type = "button";
  b.title = n;
  b.innerHTML = `<span class="n">${i + 1}</span><span class="t">${n}</span>`;
  b.onclick = () => iniciar(i);
  pasos.appendChild(b);
});
$("#portada-modulos").innerHTML = NOMBRES.map((n, i) => `<li><span>${i + 1}</span>${n}</li>`).join("");

const paneles = $$(".panel[data-modulo]");
let actual = -1, claveCamara = "", relojKpi = 0, mezclaTocada = false, pestanaMostrada = -1;
let h1 = [], h2 = [], h3 = [], acumulado = 0;
const NC = 140;

function entrar(m) {
  actual = m;
  escena.entrar(m);
  paneles.forEach((e) => e.classList.toggle("activo", +e.dataset.modulo === m));
  [...pasos.children].forEach((b, i) => {
    b.classList.toggle("activo", i === m);
    b.setAttribute("aria-current", i === m ? "step" : "false");
  });
  if (m === 0) relojKpi = reloj;
  if (m === 2) mezclaTocada = false;
  if (m === 3) {
    // Las graficas arrancan con el historico de los ultimos segundos.
    h1 = []; h2 = []; h3 = []; acumulado = 0;
    for (let i = NC - 1; i >= 0; i--) { const t = reloj - i * 0.12; h1.push(sim1(t)); h2.push(sim2(t)); h3.push(sim3(t)); }
    escena.series(h1, h2, h3, NC);
  }
  if (m === 5) { pestanaMostrada = -1; pestanaForzada = null; cfoAbierto.forEach((o) => { o.u = false; o.forzado = false; }); }
  claveCamara = "";
  encuadrar();
}

// El 3D se centra en el hueco que deja el panel: a la derecha en escritorio,
// encima del panel en el movil.
function encuadrar() {
  const panel = paneles.find((e) => +e.dataset.modulo === actual);
  const movil = innerWidth <= 760;
  const der = !movil && panel ? innerWidth - panel.offsetLeft + 8 : 0;
  const abajo = movil && panel ? innerHeight - panel.offsetTop + 8 : 150;   // mando y subtitulos
  const arriba = movil ? 64 : 88;
  document.documentElement.style.setProperty("--der", der + "px");
  escena.encuadre({ der, abajo, arriba });
}
addEventListener("resize", encuadrar);

// -- optimizador --------------------------------------------------------------
const sA = $("#sA"), sB = $("#sB"), sC = $("#sC");
function calidad() {
  const a = +sA.value, b = +sB.value, c = +sC.value, s = a + b + c || 1;
  const e = Math.abs(a / s - 0.4) + Math.abs(b / s - 0.35) + Math.abs(c / s - 0.25);
  const q = Math.max(0, 100 - e * 95), bajo = q < 80, ahorro = fm(q * 0.11) + " %";
  const el = $("#q");
  el.textContent = Math.round(q);
  el.classList.toggle("bajo", bajo);
  $("#qb").style.width = q + "%";
  $("#qb").classList.toggle("bajo", bajo);
  $("#sv").textContent = ahorro;
  $("#sv").classList.toggle("bajo", bajo);
  $("#oA").textContent = Math.round(a); $("#oB").textContent = Math.round(b); $("#oC").textContent = Math.round(c);
  escena.mezcla(a, b, c, q, ahorro);
}
[sA, sB, sC].forEach((s) => s.addEventListener("input", () => { mezclaTocada = true; calidad(); }));
calidad();

// -- monitoreo ----------------------------------------------------------------
const sim1 = (t) => 23.8 + 0.4 * Math.sin(t * 1.3) + 0.18 * Math.sin(t * 3.7);
const sim2 = (t) => 30.1 + 0.25 * Math.sin(t * 0.9 + 1) + 0.1 * Math.sin(t * 3.1);
const sim3 = (t) => 85 + 2.2 * Math.sin(t * 0.8 + 2) + Math.sin(t * 2.9);

// -- CFO ----------------------------------------------------------------------
function tabla(i) {
  const m = MODOS[i];
  const fila = (concepto, anio, usd, cop, m3, evitado, clase = "") =>
    `<tr class="${clase}"><td>${concepto}</td><td>${anio}</td><td>${nf(usd)}</td><td>${nf(cop)}</td><td>${nf(m3)}</td><td>${nf(evitado)}</td><td class="${evitado - cop < 0 ? "neg" : ""}">${nf(evitado - cop)}</td></tr>`;
  let filas = fila("CAPEX inicial", 0, m.capex, m.capex * TRM, 0, 0, "inicial");
  let usd = m.capex, cop = m.capex * TRM, evitado = 0;
  for (let y = 1; y <= 5; y++) {
    filas += fila("OPEX anual", y, m.opex, m.opex * TRM, AHORRO_M3, m.evitado);
    usd += m.opex; cop += m.opex * TRM; evitado += m.evitado;
  }
  filas += fila("Total proyectado", "—", usd, cop, AHORRO_M3 * 5, evitado, "total");
  $("#tb").innerHTML = `
    <div class="cifras">
      <div><small>CAPEX</small><b>$${nf(m.capex)} <i>USD</i></b></div>
      <div><small>Total ahorro neto</small><b class="ok">$${nf(evitado - cop)} <i>COP</i></b></div>
      <div><small>LCOW a 5 años</small><b>$${m.lcow} <i>COP/m³</i></b></div>
    </div>
    <div class="tabla-desliza"><table class="tabla">
      <thead><tr><th>Concepto</th><th>Año</th><th>Costo (USD)</th><th>Costos (COP)</th><th>Ahorro (m³)</th><th>Costo Evitado (COP)</th><th>Ahorro Neto (COP)</th></tr></thead>
      <tbody>${filas}</tbody>
    </table></div>`;
  $("#tA").classList.toggle("activa", i === 0);
  $("#tB").classList.toggle("activa", i === 1);
  $("#tA").setAttribute("aria-selected", String(i === 0));
  $("#tB").setAttribute("aria-selected", String(i === 1));
}
$("#tA").onclick = () => { pestanaForzada = 0; };
$("#tB").onclick = () => { pestanaForzada = 1; };

// -- falla critica ---------------------------------------------------------------
const ESTADOS_FALLA = ["⚠ ALERTA: Conductividad 3.900 µS/cm", "Cerrando válvula de Fuente A…", "Recuperación Intramuros 10% → 12%", "Flujo asegurado"];
$("#pasos-falla").innerHTML = ESTADOS_FALLA.map((t) => `<li>${t}</li>`).join("");

function estadoFalla(P) {
  const fa = P >= EV.fa, vc = clamp((P - EV.v) / (EV.c - EV.v), 0, 1), rv = clamp((P - EV.c) / (EV.s - EV.c), 0, 1);
  const alarma = fa && vc < 1;
  let texto = "Operación normal", clase = "", paso = -1;
  if (alarma && P < EV.v) { texto = ESTADOS_FALLA[0]; clase = "critico"; paso = 0; }
  else if (vc > 0 && vc < 1) { texto = ESTADOS_FALLA[1]; clase = "advertencia"; paso = 1; }
  else if (vc >= 1 && P < EV.s) { texto = ESTADOS_FALLA[2]; clase = "advertencia"; paso = 2; }
  else if (P >= EV.s) { texto = ESTADOS_FALLA[3]; clase = "ok"; paso = 3; }
  return { fa, vc, rv, alarma, texto, clase, paso, letrero: P >= EV.al && P < EV.v + (EV.c - EV.v) * 0.6 };
}

// -- ESG ------------------------------------------------------------------------
$("#go").onclick = () => {
  const e = $("#aviso");
  e.classList.add("visible");
  clearTimeout(e._t);
  e._t = setTimeout(() => e.classList.remove("visible"), 3500);
};

// -- controles --------------------------------------------------------------------
function pintarBotones() {
  const pp = $("#pp"), sonando = !T.pausado;
  // Los iconos son SVG: `hidden` como propiedad no existe ahi, va como atributo.
  pp.querySelector(".i-pausa").toggleAttribute("hidden", !sonando);
  pp.querySelector(".i-play").toggleAttribute("hidden", sonando);
  pp.querySelector("span").textContent = sonando ? "Pausar" : T.fin ? "Repetir" : "Reanudar";
  pp.title = (sonando ? "Pausar" : T.fin ? "Repetir el recorrido" : "Reanudar") + " (espacio)";
}

function pintarVoz() {
  const b = $("#vb");
  b.querySelector(".i-voz").toggleAttribute("hidden", !voz.activa);
  b.querySelector(".i-mudo").toggleAttribute("hidden", voz.activa);
  b.setAttribute("aria-pressed", String(voz.activa));
  b.title = voz.activa ? "Silenciar la narración" : "Activar la narración";
  const tipo = !voz.activa ? "Narración silenciada: el recorrido avanza a ritmo de lectura."
    : voz.neural ? "Narración con la voz neural de SIMBIA."
      : voz.navegador ? "Narración con la voz del navegador."
        : "Tu navegador no tiene voz: el recorrido avanzará a ritmo de lectura.";
  $("#vn").textContent = tipo;
}

$("#pp").onclick = () => (T.pausado ? reanudar() : pausar());
$("#rs").onclick = () => iniciar(0);
$("#ant").onclick = () => iniciar(Math.max(0, (T.mod < 0 ? 0 : T.mod) - 1));
$("#sig").onclick = () => iniciar(Math.min(GUION.length - 1, T.mod + 1));
$("#vb").onclick = () => {
  voz.activa = !voz.activa;
  pintarVoz();
  if (!T.pausado && T.mod >= 0) {
    T.p = Math.max(T.p, T.pista ? T.pista.progreso(performance.now()) : T.p);
    detenerPista();
    T.pista = nuevaPista(T.mod, T.p);
  }
};
// En el telefono los subtitulos taparian la escena: empiezan apagados.
let subtitulos = !matchMedia("(max-width: 760px)").matches;
function pintarSubtitulos() {
  $("#cc").setAttribute("aria-pressed", String(subtitulos));
  $("#cc").classList.toggle("apagado", !subtitulos);
}
$("#cc").onclick = () => { subtitulos = !subtitulos; pintarSubtitulos(); };
pintarSubtitulos();

{
  const raiz = document.documentElement, b = $("#fsb");
  const activa = () => document.fullscreenElement || document.webkitFullscreenElement;
  if (!(raiz.requestFullscreen || raiz.webkitRequestFullscreen)) b.hidden = true;
  b.onclick = async () => {
    try {
      if (activa()) await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      else await (raiz.requestFullscreen || raiz.webkitRequestFullscreen).call(raiz);
    } catch { /* el marco no lo permite */ }
  };
  for (const ev of ["fullscreenchange", "webkitfullscreenchange"]) {
    document.addEventListener(ev, () => {
      b.title = activa() ? "Salir de pantalla completa" : "Pantalla completa";
      b.classList.toggle("activo", Boolean(activa()));
    });
  }
}

escena.ar.soportado().then((ok) => { $("#ar").hidden = !ok; });
$("#ar").onclick = () => escena.ar.alternar().catch(() => { $("#ar").title = "AR no disponible"; });

addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($("#portada").hidden === false) return;
  if (e.key === "ArrowRight" || e.key === "PageDown") { e.preventDefault(); $("#sig").click(); }
  else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); $("#ant").click(); }
  else if (e.key === " ") { e.preventDefault(); $("#pp").click(); }
  else if (e.key === "f" || e.key === "F") $("#fsb").click();
});

// -- portada ---------------------------------------------------------------------
$("#sb").onclick = () => {
  $("#portada").hidden = true;
  // Desbloquea el audio dentro del gesto: Safari no deja sonar despues un
  // elemento que nunca sono por una pulsacion.
  audio.src = SILENCIO;
  audio.play().catch(() => {});
  if (voz.navegador) {
    try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } catch { /* sin voz */ }
    elegirVoz();
  }
  iniciar(0);
};

fetch("/api/asistente/estado", { credentials: "same-origin" })
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => { if (j && j.voz) { voz.neural = true; audioNeural(0); } })
  .catch(() => {})
  .finally(pintarVoz);
pintarVoz();
pintarBotones();

// ---------------------------------------------------------------------------
// Bucle
// ---------------------------------------------------------------------------

let ultimo = performance.now(), reloj = 0;
const salida = (x) => 1 - Math.pow(1 - x, 3);

function cuadro(ahora) {
  const dt = Math.min((ahora - ultimo) / 1000, 0.1);
  ultimo = ahora;
  reloj += dt;
  avanzar(performance.now());

  const m = Math.max(0, actual), P = T.mod < 0 ? 0 : T.p;
  if (actual < 0) entrar(0);

  // Barra de pasos y avance global
  const global = T.mod < 0 ? 0 : T.fin ? 1 : (ACUM[T.mod] + P * LARGO[T.mod]) / TOTAL;
  [...pasos.children].forEach((b, i) => {
    b.style.setProperty("--p", i < m || T.fin ? 1 : i === m ? P : 0);
    b.classList.toggle("hecho", i < m || T.fin);
  });
  const av = `Módulo ${m + 1}/7 · ${Math.round(global * 100)} %`;
  if ($("#avance").textContent !== av) $("#avance").textContent = av;

  // Subtitulos
  const sub = $("#subtitulo");
  let texto = "";
  if (subtitulos && T.mod >= 0 && !T.fin) {
    if (T.pista && T.pista.esperando && !T.pista.sonando) texto = "Preparando la narración…";
    else {
      const c = P * LARGO[m];
      texto = (FRASES[m].find((f) => c < f.fin) || FRASES[m][FRASES[m].length - 1]).txt;
    }
  }
  if (sub.textContent !== texto) sub.textContent = texto;

  // Camara
  const k = m === 1 && P >= EV.b ? "1b" : String(m);
  if (k !== claveCamara) { claveCamara = k; escena.vista(k); }

  const ctx = { modulo: m, P, reloj, fuenteB: P >= EV.b, falla: null, cfo: [false, false], forma: 0 };
  let vineta = 0;

  if (m === 0) {
    const f = salida(clamp((reloj - relojKpi) / 3, 0, 1));
    $("#k1").textContent = fm(23.8 * f);
    $("#k2").textContent = fm(57.1 * f);
    let ix = -1;
    ETAPAS_EN.forEach((v, i) => { if (P >= v) ix = i; });
    const nombre = ix < 0 ? "—" : `${ix + 1}. ${NOMBRES_ETAPAS[ix]}`;
    if ($("#etapa").textContent !== nombre) $("#etapa").textContent = nombre;
  }
  if (m === 2 && !T.pausado && !mezclaTocada) {
    sA.value = 45 + 8 * Math.sin(reloj * 0.9);
    sB.value = 35 + 4 * Math.sin(reloj * 0.7 + 1);
    calidad();
  }
  if (m === 3) {
    acumulado += dt;
    while (acumulado > 0.12) {
      acumulado -= 0.12;
      h1.push(sim1(reloj)); h2.push(sim2(reloj)); h3.push(sim3(reloj));
      if (h1.length > NC) { h1.shift(); h2.shift(); h3.shift(); }
    }
    if (h1.length) {
      $("#m1").textContent = fm(h1[h1.length - 1]);
      $("#m2").textContent = fm(h2[h2.length - 1]);
      $("#m3").textContent = fm(h3[h3.length - 1]);
    }
  }
  if (m === 4) {
    const f = estadoFalla(P);
    ctx.falla = f;
    const st = $("#st");
    if (st.textContent !== f.texto) { st.textContent = f.texto; st.className = "estado " + f.clase; }
    $$("#pasos-falla li").forEach((li, i) => {
      li.classList.toggle("hecho", i < f.paso || (i === f.paso && i === 3));
      li.classList.toggle("ahora", i === f.paso && i < 3);
    });
    $("#rp").textContent = f.rv > 0 ? "12 %" : "10 %";
    if (f.alarma) vineta = 0.35 + 0.3 * Math.sin(reloj * 8);
  }
  if (m === 5) {
    const w = pestanaForzada !== null ? pestanaForzada : (P >= EV.mb ? 1 : 0);
    if (w !== pestanaMostrada) { pestanaMostrada = w; tabla(w); }
    ctx.cfo = cfoAbierto.map((o, i) => (o.forzado ? o.u : (o.u || P >= (i ? EV.mb : EV.ma))));
  }
  if (m === 6) {
    const e = clamp((P - 0.05) / 0.18, 0, 1);
    ctx.forma = e * e * (3 - 2 * e);
  }
  $("#alarma").style.opacity = vineta;

  escena.cuadro(dt, ctx);
}
escena.renderer.setAnimationLoop(cuadro);
