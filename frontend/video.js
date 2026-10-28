/* SIMBIA - video en bucle (video.html).
 *
 * Cuatro partes que se encadenan sin fin, con el guion, las cifras y los
 * tiempos del video original:
 *
 *   1. Problema, solucion e impacto ........ 59,5 s
 *   2. SIMBIA en accion (tablero) .......... 40,5 s
 *   3. Falla critica, en 3D ................ 40 s
 *   4. Reporte ESG, en 3D .................. 20 s
 *
 * Un solo reloj lleva todo: cada parte tiene sus pistas (segundo -> que pasa)
 * y, si hace falta, una funcion por cuadro. Las cifras que cuentan y la escena
 * 3D dependen del segundo, no de temporizadores, asi que el video se puede
 * pausar sin que nada se desacompase.
 */

import { crearEscena } from "./video-escena.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const suave = (x) => x * x * (3 - 2 * x);
const ANCHO = 1280, ALTO = 720;
const FUNDIDO = 0.65;   // s entre una parte y la siguiente

// Cifra con coma decimal y punto de miles, como en el original.
function cifra(v, decimales) {
  const [ent, dec] = v.toFixed(decimales).split(".");
  return ent.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + (dec ? "," + dec : "");
}

// =============================================================================
// Narracion: subtitulo siempre; voz del navegador solo si esta activada
// =============================================================================
const voz = { activa: false, eleccion: null, hay: "speechSynthesis" in window };

function elegirVoz() {
  const nota = (v) => (/natural|google|neural|online|premium|enhanced|microsoft/i.test(v.name) ? 2 : 0)
    + (/es[-_](CO|MX|US|419)/i.test(v.lang) ? 1 : /es[-_]ES/i.test(v.lang) ? 0.5 : 0);
  voz.eleccion = speechSynthesis.getVoices().filter((v) => /^es/i.test(v.lang)).sort((a, b) => nota(b) - nota(a))[0] || null;
}
if (voz.hay) { speechSynthesis.onvoiceschanged = elegirVoz; elegirVoz(); }

function subtitulo(texto) { $("#subtitulo").textContent = texto; }

function decir(texto, ritmo) {
  subtitulo(texto);
  if (!voz.activa || !voz.hay) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(texto);
  u.voice = voz.eleccion;
  u.lang = voz.eleccion ? voz.eleccion.lang : "es-CO";
  u.rate = ritmo;
  speechSynthesis.speak(u);
}

function callar() { if (voz.hay) speechSynthesis.cancel(); }

// =============================================================================
// Utilidades de las partes
// =============================================================================
let tau = 0;   // segundo dentro de la parte actual

// Contadores: cada uno sube de 0 a su cifra en `dur` segundos desde que se pide.
let contadores = [];
function contar(sel, hasta, decimales, dur, sufijo = "") {
  contadores.push({ el: $(sel), hasta, decimales, dur, sufijo, t0: tau });
}
function avanzarContadores() {
  contadores = contadores.filter((c) => {
    const p = clamp((tau - c.t0) / c.dur, 0, 1);
    c.el.textContent = cifra(c.hasta * p, c.decimales) + c.sufijo;
    return p < 1;
  });
}

function anillo(sel, valor) { $(sel).style.strokeDashoffset = 100 - valor; }
function anilloACero(sel) {
  const e = $(sel);
  e.style.transition = "none";
  e.style.strokeDashoffset = 100;
  e.getBoundingClientRect();
  e.style.transition = "";
}

// =============================================================================
// 1. Problema, solucion e impacto
// =============================================================================
const N1 = [
  "En la industria, el agua es un insumo crítico, pero su gestión sigue fragmentada: los datos están dispersos, las corrientes de rechazo no tienen destino y no hay control en tiempo real. Mientras tanto, la normativa exige más trazabilidad y reúso.",
  "SIMBIA es una plataforma inteligente que caracteriza cada fuente de agua, optimiza las mezclas con algoritmos y conecta a quienes generan rechazo con quienes necesitan agua, cerrando el acuerdo de forma digital.",
  "Para una empresa ancla como Cabot, que gestiona 23.8 metros cúbicos por hora, un ahorro del 10 por ciento equivale a 57.1 metros cúbicos al día, más de 20 mil al año, con potencial de llegar al 15 por ciento. Además mejora el cumplimiento normativo y las metas corporativas E S G.",
];

// Ilustraciones: cuatro empresas a la izquierda y Cabot a la derecha. En el
// problema las conexiones no llegan; en la solucion pasan por SIMBIA.
const FILAS = [70, 176, 282, 388];
const CABOT = { x: 448, y: 172, w: 140, h: 116 };
const fabrica = "M2 30V14l9 6v-6l9 6v-6l9 6V3h6v27z";
const ficha = (y, i) => `
  <g class="ficha" transform="translate(16 ${y - 40})">
    <rect width="124" height="80" rx="16"/>
    <path class="fabrica" transform="translate(43 10)" d="${fabrica}"/>
    <text x="62" y="64" text-anchor="middle">Empresa ${i + 1}</text>
  </g>`;
const cabot = (pregunta) => `
  <g class="cabot">
    <rect x="${CABOT.x}" y="${CABOT.y}" width="${CABOT.w}" height="${CABOT.h}" rx="20"/>
    <rect class="borde" x="${CABOT.x - 6}" y="${CABOT.y - 6}" width="${CABOT.w + 12}" height="${CABOT.h + 12}" rx="24"/>
    <text x="${CABOT.x + CABOT.w / 2}" y="${CABOT.y + CABOT.h / 2 + 9}" text-anchor="middle">Cabot</text>
    ${pregunta ? `<text class="pregunta" x="${CABOT.x + CABOT.w / 2}" y="${CABOT.y - 30}" text-anchor="middle">?</text>` : ""}
  </g>`;

function ilustraciones() {
  const centro = CABOT.y + CABOT.h / 2;
  $("#svg-problema").innerHTML = FILAS.map((y) => {
    const fin = centro + (y - centro) * 0.45;
    return `<path class="rota" d="M144 ${y} C 230 ${y} 270 ${fin} 344 ${fin}"/>
      <g class="cruz" transform="translate(372 ${fin})"><circle r="15"/><path d="M-6-6 6 6M6-6-6 6"/></g>`;
  }).join("") + FILAS.map(ficha).join("") + cabot(true);

  const nucleo = { x: 318, y: centro };
  $("#svg-solucion").innerHTML = `
    <defs><linearGradient id="grad-marca" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f5b323"/><stop offset="1" stop-color="#f2762e"/></linearGradient></defs>`
    + FILAS.map((y) => `<path class="flujo" d="M144 ${y} C 220 ${y} 250 ${nucleo.y} ${nucleo.x} ${nucleo.y}"/>`).join("")
    + `<path class="flujo verde" d="M${nucleo.x + 70} ${nucleo.y} L${CABOT.x - 8} ${nucleo.y}"/>`
    + FILAS.map(ficha).join("")
    + `<g class="nucleo">
        <circle class="halo" cx="${nucleo.x}" cy="${nucleo.y}" r="94"/>
        <circle class="disco" cx="${nucleo.x}" cy="${nucleo.y}" r="68"/>
        <polygon class="chev" transform="translate(${nucleo.x - 11} ${nucleo.y - 36})" points="0,0 12.1,0 22,11 12.1,22 0,22 9.9,11"/>
        <text x="${nucleo.x}" y="${nucleo.y + 22}" text-anchor="middle">SIMBIA</text>
      </g>`
    + cabot(false);
}

const propuesta = (() => {
  const puntos = $$("#seg-propuesta .punto"), chips = $$("#seg-propuesta .chip");
  const ACTOS = ["p-titulo", "p-problema", "p-solucion", "p-impacto", "p-cierre"];
  const acto = (id) => {
    for (const a of ACTOS) $("#" + a).classList.toggle("on", a === id);
    $(".marca-fija").classList.toggle("on", ["p-problema", "p-solucion", "p-impacto"].includes(id));
  };
  const ver = (e) => () => e.classList.add("s");
  return {
    id: "propuesta", nodo: $("#seg-propuesta"), dur: 59.5,
    entrar() {
      acto(null);
      for (const e of [...puntos, ...chips]) e.classList.remove("s");
      for (const s of ["#c1", "#c2", "#c3"]) $(s).textContent = "0";
      for (const s of ["#b1", "#b2"]) $(s).style.height = "0";
    },
    pistas: [
      [0, () => { acto("p-titulo"); subtitulo("SIMBIA · Gestión inteligente y eficiente del agua industrial"); }],
      // El problema
      [3, () => { acto("p-problema"); decir(N1[0], 0.98); }],
      [6.5, ver(puntos[0])], [10.5, ver(puntos[1])], [14, ver(puntos[2])], [17, ver(chips[0])],
      // La solucion
      [20, () => { acto("p-solucion"); decir(N1[1], 0.98); }],
      [23, ver(puntos[3])], [26, ver(puntos[4])], [30, ver(puntos[5])], [33.5, ver(chips[1])],
      // El impacto
      [36, () => { acto("p-impacto"); decir(N1[2], 0.98); }],
      [39.5, () => contar("#c1", 23.8, 1, 1.5)],
      [44, () => { contar("#c2", 57.1, 1, 1.5); $("#b1").style.height = "260px"; $("#b2").style.height = "234px"; }],
      [48.5, () => contar("#c3", 20850, 0, 1.8)],
      [52.5, () => chips.slice(2).forEach((c) => c.classList.add("s"))],
      // Cierre
      [56, () => { acto("p-cierre"); subtitulo(""); }],
    ],
  };
})();

// =============================================================================
// 2. SIMBIA en accion: el tablero detecta una corriente, la simula, se firma
// el acuerdo y se cumple la meta
// =============================================================================
const N2 = [
  "Bienvenido a SIMBIA. Hoy, Cabot tiene el desafío de ahorrar 57 metros cúbicos de agua en su operación.",
  "Nuestra plataforma de IoT detecta en tiempo real una corriente de rechazo disponible de una empresa vecina.",
  "El motor de algoritmos entra en acción. Analizamos la temperatura y la química. Es compatible en un 98%.",
  "Con un solo clic, se formaliza el acuerdo digital, logrando el 100% de la meta diaria y reduciendo el impacto ambiental. Esto es gestión hídrica inteligente.",
];

const plataforma = (() => {
  const seg = $("#seg-plataforma"), tablero = $("#d-tablero"), cursor = $("#d-cursor");
  const filas = $$("#d-cols > div:first-of-type .fila");
  const mapa = ["#d-or", "#d-w1", "#d-w2"];

  // El cursor va al centro del boton: las dos cajas estan escaladas igual, asi
  // que la proporcion vale en pixeles del video.
  function apuntar(sel) {
    const a = seg.getBoundingClientRect(), b = $(sel).getBoundingClientRect();
    cursor.style.opacity = 1;
    cursor.style.left = ((b.left - a.left + b.width / 2) / a.width) * 100 + "%";
    cursor.style.top = ((b.top - a.top + b.height / 2) / a.height) * 100 + "%";
  }
  function pulsar(sel) {
    const e = $(sel);
    e.classList.add("fl");
    setTimeout(() => e.classList.remove("fl"), 250);
  }
  function gotas() {
    const caja = $("#d-gotas");
    caja.innerHTML = Array.from({ length: 35 }, () =>
      `<i style="left:${(Math.random() * 100).toFixed(1)}%;animation-delay:${(Math.random() * 2.5).toFixed(2)}s"></i>`).join("");
  }

  return {
    id: "plataforma", nodo: seg, dur: 40.5,
    entrar() {
      tablero.className = "tablero";
      $("#d-pan").classList.remove("pan");
      for (const s of mapa) $(s).classList.remove("on");
      for (const s of ["#d-alerta", "#d-sim", "#d-contrato", "#d-meta"]) $(s).classList.remove("s", "x");
      $("#d-cols").classList.remove("sc");
      for (const f of filas) f.classList.remove("ck");
      for (const s of ["#r1", "#r2", "#r3"]) anilloACero(s);
      $("#n1").textContent = "0"; $("#n3").textContent = "0";
      $("#p2").textContent = "0%"; $("#p3").textContent = "0";
      for (const s of ["#d-g1", "#d-g2"]) $(s).classList.remove("w");
      cursor.style.transition = "none";
      cursor.style.opacity = 0; cursor.style.left = "90%"; cursor.style.top = "95%";
      cursor.getBoundingClientRect();
      cursor.style.transition = "";
      $("#d-gotas").innerHTML = "";
    },
    pistas: [
      // Tablero
      [0.5, () => {
        decir(N2[0], 0.95);
        tablero.classList.add("in");
        $("#d-pan").classList.add("pan");
        contar("#n1", 23.8, 1, 2); contar("#n3", 4.2, 1, 2.2);
        anillo("#r1", 35);
      }],
      // Alerta
      [10, () => {
        decir(N2[1], 0.95);
        tablero.classList.add("borroso");
        for (const s of mapa) $(s).classList.add("on");
      }],
      [11.5, () => $("#d-alerta").classList.add("s")],
      [14, () => apuntar("#d-b1")],
      [15.5, () => pulsar("#d-b1")],
      [16, () => { $("#d-alerta").classList.remove("s"); cursor.style.opacity = 0; }],
      // Simulacion
      [17, () => { decir(N2[2], 0.95); $("#d-sim").classList.add("s"); $("#d-cols").classList.add("sc"); }],
      ...filas.map((f, i) => [18 + i * 0.7, () => f.classList.add("ck")]),
      [21, () => { anillo("#r2", 98); contar("#p2", 98, 0, 2, "%"); }],
      [24, () => apuntar("#d-b2")],
      [25.5, () => pulsar("#d-b2")],
      [26, () => { $("#d-sim").classList.remove("s"); cursor.style.opacity = 0; }],
      // Acuerdo y meta
      [27, () => { decir(N2[3], 0.95); $("#d-contrato").classList.add("s"); }],
      [28.5, () => $("#d-g1").classList.add("w")],
      [30, () => $("#d-g2").classList.add("w")],
      [33, () => $("#d-contrato").classList.add("x")],
      [34, () => {
        tablero.classList.remove("borroso");
        $("#d-meta").classList.add("s");
        anillo("#r3", 100); contar("#p3", 57.1, 1, 2.2);
        gotas();
      }],
    ],
  };
})();

// =============================================================================
// 3. Falla critica (3D): a los 10 s la Fuente A se dispara de conductividad
// =============================================================================
const falla = (() => {
  const pasos = $$("#f-pasos li");
  let ultimo = "";
  return {
    id: "falla", nodo: $("#seg-falla"), dur: 40, tres: "falla",
    entrar() { ultimo = ""; },
    pistas: [],
    cuadro(t, ctx) {
      const f = t - 10;
      const fa = f >= 0, alarma = f >= 0 && f < 10.5;
      const vc = clamp((f - 8) / 2.5, 0, 1), rv = clamp((f - 10.5) / 1.5, 0, 1);
      let texto = "Operación normal", clase = "", paso = -1;
      if (f >= 0 && f < 8) { texto = pasos[0].textContent; clase = "critico"; paso = 0; }
      else if (f >= 8 && f < 10.5) { texto = pasos[1].textContent; clase = "advertencia"; paso = 1; }
      else if (f >= 10.5 && f < 13) { texto = pasos[2].textContent; clase = "advertencia"; paso = 2; }
      else if (f >= 13) { texto = pasos[3].textContent; clase = "ok"; paso = 3; }
      if (texto !== ultimo) {
        ultimo = texto;
        const st = $("#f-estado");
        st.textContent = texto;
        st.className = "estado " + clase;
        pasos.forEach((li, i) => {
          li.classList.toggle("hecho", i < paso || (i === paso && i === 3));
          li.classList.toggle("ahora", i === paso && i < 3);
        });
        $("#f-rp").textContent = f >= 10.5 ? "12%" : "10%";
      }
      // El primer golpe de la alarma parpadea; despues late.
      let vineta = 0;
      if (alarma) vineta = f < 2.5 ? (Math.random() > 0.5 ? 0.85 : 0.15) : 0.35 + 0.3 * Math.sin(ctx.reloj * 8);
      $("#vineta").style.opacity = vineta;
      ctx.falla = {
        fa, alarma, vc, rv,
        letrero: f >= 2.5 && f < 10.5 && (f > 4 || Math.floor(f * 5) % 2 === 0),
      };
    },
    salir() { $("#vineta").style.opacity = 0; },
  };
})();

// =============================================================================
// 4. Reporte ESG (3D): la lluvia se ordena en una gota entre los 8 y los 16 s
// =============================================================================
const esg = {
  id: "esg", nodo: $("#seg-esg"), dur: 20, tres: "esg",
  entrar() {},
  pistas: [],
  cuadro(t, ctx) { ctx.forma = suave(clamp((t - 8) / 8, 0, 1)); },
};

const PARTES = [propuesta, plataforma, falla, esg];
const TOTAL = PARTES.reduce((s, p) => s + p.dur + FUNDIDO, 0);

// =============================================================================
// Musica ambiental generativa (Web Audio; sin archivos): la del original
// =============================================================================
const musica = (() => {
  let ac, salida, sonando = false, temporizador = 0, siguiente = 0, compas = 0, atenuada = false;
  const BPM = 70, B = 60 / BPM, NIVEL = 0.6, hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const ACORDES = [
    { b: 48, pad: [55, 59, 64, 67], ar: [72, 76, 79, 83, 84] },
    { b: 45, pad: [57, 60, 64, 67], ar: [69, 72, 76, 79, 81] },
    { b: 41, pad: [53, 57, 60, 64], ar: [65, 69, 72, 76, 77] },
    { b: 43, pad: [55, 59, 62, 64], ar: [67, 71, 74, 76, 79] },
  ];
  function iniciar() {
    ac = new (window.AudioContext || window.webkitAudioContext)();
    salida = ac.createGain(); salida.gain.value = 0;
    const filtro = ac.createBiquadFilter(); filtro.type = "lowpass"; filtro.frequency.value = 3000;
    const eco = ac.createConvolver(), n = Math.floor(ac.sampleRate * 2.8), buf = ac.createBuffer(2, n, ac.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.4);
    }
    eco.buffer = buf;
    const humedo = ac.createGain(); humedo.gain.value = 0.5;
    salida.connect(filtro); filtro.connect(ac.destination); filtro.connect(eco); eco.connect(humedo); humedo.connect(ac.destination);
  }
  function nota(m, t, d, tipo, v, ataque) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = tipo; o.frequency.value = hz(m); o.detune.value = (Math.random() - 0.5) * 8;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + ataque); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(salida); o.start(t); o.stop(t + d + 0.1);
  }
  function bloque(t0, c) {
    const L = 8 * B, patron = [0, 2, 1, 3, 2, 4, 3, 1, 0, 3, 2, 4, 1, 2, 3, 2];
    c.pad.forEach((m) => { nota(m, t0, L * 1.05, "triangle", 0.05, 1.6); nota(m + 12, t0 + 0.05, L, "sine", 0.018, 2); });
    nota(c.b, t0, L, "sine", 0.11, 0.4);
    for (let i = 0; i < 16; i++) {
      if (i % 8 === 7 || (i % 5 === 4 && compas % 2)) continue;
      nota(c.ar[patron[i] % c.ar.length], t0 + i * B / 2, 1.8, "sine", 0.045 + Math.random() * 0.02, 0.01);
    }
  }
  function volumen() {
    if (!ac) return;
    const t = ac.currentTime;
    salida.gain.cancelScheduledValues(t);
    salida.gain.setValueAtTime(salida.gain.value, t);
    salida.gain.linearRampToValueAtTime(sonando ? (atenuada ? 0.3 : 1) * NIVEL : 0, t + 1.2);
  }
  function bombear() { while (sonando && siguiente < ac.currentTime + 1.5) { bloque(siguiente, ACORDES[compas % 4]); siguiente += 8 * B; compas++; } }
  document.addEventListener("visibilitychange", () => {
    if (!ac) return;
    if (document.hidden) ac.suspend(); else if (sonando) ac.resume();
  });
  return {
    get sonando() { return sonando; },
    empezar() {
      try {
        if (!ac) iniciar();
        ac.resume();
        if (!sonando) { sonando = true; siguiente = ac.currentTime + 0.15; bombear(); if (!temporizador) temporizador = setInterval(bombear, 400); }
        volumen();
      } catch { /* sin audio: el video sigue */ }
    },
    parar() { sonando = false; volumen(); setTimeout(() => { if (ac && !sonando) ac.suspend(); }, 1500); },
    atenuar(a) { atenuada = a; volumen(); },
  };
})();

// =============================================================================
// Escena 3D y encaje del escenario en la pantalla
// =============================================================================
const escena = crearEscena($("#escena3d"), { ancho: ANCHO, alto: ALTO, libre: { der: 390, arriba: 70, abajo: 0 } });
escena.calentar();

function encajar() {
  const k = Math.min(innerWidth / ANCHO, innerHeight / ALTO);
  $("#escenario").style.setProperty("--k", k);
  escena.medida(k);
}
addEventListener("resize", encajar);
encajar();

// =============================================================================
// Reloj
// =============================================================================
let actual = 0, disparadas = 0, fuera = false, espera = 0, pausado = false, corriendo = false, reloj = 0;

function comenzar(i) {
  actual = i; tau = 0; disparadas = 0; fuera = false; contadores = [];
  subtitulo("");
  const p = PARTES[i];
  p.entrar();
  p.nodo.classList.add("on");
  $("#escena3d").classList.toggle("on", Boolean(p.tres));
  if (p.tres) escena.entrar(p.tres);
}

function terminar() {
  const p = PARTES[actual];
  p.salir?.();
  p.nodo.classList.remove("on");
  $("#escena3d").classList.remove("on");
  subtitulo("");
  callar();
  fuera = true; espera = 0;
}

function reiniciar() {
  for (const p of PARTES) { p.salir?.(); p.nodo.classList.remove("on"); }
  callar();
  subtitulo("");
  comenzar(0);
}

function avanzar(dt, ctx) {
  const p = PARTES[actual];
  if (fuera) {
    espera += dt;
    if (espera >= FUNDIDO) comenzar((actual + 1) % PARTES.length);
    return;
  }
  tau += dt;
  while (disparadas < p.pistas.length && p.pistas[disparadas][0] <= tau) p.pistas[disparadas++][1]();
  avanzarContadores();
  p.cuadro?.(tau, ctx);
  if (tau >= p.dur) terminar();
}

function progreso() {
  let antes = 0;
  for (let i = 0; i < actual; i++) antes += PARTES[i].dur + FUNDIDO;
  const p = PARTES[actual];
  const t = antes + (fuera ? p.dur + espera : Math.min(tau, p.dur));
  $("#progreso").style.width = (t / TOTAL) * 100 + "%";
}

let ultimo = performance.now();
function cuadro(ahora) {
  const dt = Math.min((ahora - ultimo) / 1000, 0.1);
  ultimo = ahora;
  const paso = corriendo && !pausado ? dt : 0;
  reloj += paso;
  const ctx = { reloj, falla: null, forma: 0 };
  if (corriendo) { avanzar(paso, ctx); progreso(); }
  const p = PARTES[actual];
  if (corriendo && p.tres) escena.cuadro(paso, ctx);
  requestAnimationFrame(cuadro);
}

// =============================================================================
// Mandos
// =============================================================================
function arrancar() {
  $("#portada").hidden = true;
  if (!corriendo) { corriendo = true; ilustraciones(); comenzar(0); }
}

$("#portada").addEventListener("click", () => { musica.empezar(); arrancar(); });

const bMusica = $("#b-musica"), bVoz = $("#b-voz"), bPausa = $("#b-pausa");
bMusica.addEventListener("click", () => {
  if (musica.sonando) musica.parar(); else musica.empezar();
  bMusica.setAttribute("aria-pressed", String(musica.sonando));
});
bVoz.addEventListener("click", () => {
  voz.activa = !voz.activa;
  bVoz.setAttribute("aria-pressed", String(voz.activa));
  if (!voz.activa) callar();
  musica.atenuar(voz.activa);
});
if (!voz.hay) bVoz.hidden = true;

function alternarPausa() {
  pausado = !pausado;
  document.body.classList.toggle("en-pausa", pausado);
  bPausa.setAttribute("aria-label", pausado ? "Reanudar" : "Pausar");
  bPausa.querySelector(".i-pausa").toggleAttribute("hidden", pausado);
  bPausa.querySelector(".i-play").toggleAttribute("hidden", !pausado);
  if (voz.hay) { if (pausado) speechSynthesis.pause(); else speechSynthesis.resume(); }
}
bPausa.addEventListener("click", alternarPausa);
$("#b-reiniciar").addEventListener("click", () => { if (pausado) alternarPausa(); reiniciar(); });

function pantallaCompleta() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
$("#b-pantalla").addEventListener("click", pantallaCompleta);

// Los mandos aparecen al mover el puntero y se esconden solos.
let esconder = 0;
function mostrarMandos() {
  if (!corriendo) return;
  const flotantes = [$("#mandos"), $("#volver")];
  for (const e of flotantes) e.classList.add("ver");
  clearTimeout(esconder);
  esconder = setTimeout(() => {
    if (flotantes.some((e) => e.matches(":focus-within, :focus, :hover"))) return;
    for (const e of flotantes) e.classList.remove("ver");
  }, 2500);
}
addEventListener("pointermove", mostrarMandos);
addEventListener("pointerdown", mostrarMandos);

addEventListener("keydown", (e) => {
  if (!corriendo) return;
  // Con un boton enfocado, la barra espaciadora es de ese boton.
  const enBoton = e.target instanceof Element && e.target.closest("button");
  if (e.key === " " && !enBoton) { e.preventDefault(); alternarPausa(); mostrarMandos(); }
  else if (e.key === "f" || e.key === "F") pantallaCompleta();
});

// ?auto: arranca solo (pantallas de feria). El navegador no deja sonar nada
// sin un gesto, asi que la musica empieza con el primer toque.
if (new URLSearchParams(location.search).has("auto")) {
  arrancar();
  addEventListener("pointerdown", (e) => {
    if (musica.sonando || e.target.closest("#b-musica")) return;
    musica.empezar();
    bMusica.setAttribute("aria-pressed", "true");
  }, { once: true });
  bMusica.setAttribute("aria-pressed", "false");
}

requestAnimationFrame(cuadro);

