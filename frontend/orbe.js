/* Orbe de particulas del asistente.
 *
 * Una esfera de puntos que gira, con hilos finos entre vecinos, tres orbitas
 * y un nucleo que brilla. Cambia con el estado del asistente (reposo,
 * escuchando, pensando, hablando, sin_ia) y late con la voz cuando habla.
 *
 * Tiene que verse vivo: gira y cabecea, respira, cada punto tiembla en su
 * sitio y unos satelites recorren las orbitas. Pensando gira mas deprisa;
 * hablando late con la voz.
 *
 * Canvas 2D y nada mas: unos quinientos puntos se dibujan sobrados a 60 fps.
 * Se para cuando no se ve. Con "reducir movimiento" sigue girando, pero
 * despacio y sin temblores ni respiracion.
 */

const ESTADOS = {
  reposo: { giro: 0.55, escala: 1.0, agitacion: 0.0, vida: 1.0, color: 1, nucleo: 1.0 },
  escuchando: { giro: 0.75, escala: 1.07, agitacion: 0.22, vida: 1.3, color: 1, nucleo: 1.25 },
  pensando: { giro: 1.8, escala: 0.95, agitacion: 0.5, vida: 1.6, color: 1, nucleo: 0.85 },
  hablando: { giro: 0.7, escala: 1.02, agitacion: 0.12, vida: 1.2, color: 1, nucleo: 1.1 },
  sin_ia: { giro: 0.15, escala: 0.94, agitacion: 0.0, vida: 0.3, color: 0, nucleo: 0.5 },
};


const AGUA = [31, 159, 176];
const NARANJA = [242, 118, 46];
const AMBAR = [245, 179, 35];
const GRIS = [150, 160, 168];
const SATELITES = [NARANJA, AGUA, AMBAR];

const mezclar = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;

function esfera(n) {
  // Fibonacci: reparte los puntos casi por igual sobre la esfera. Uno de
  // cada cinco sale de la capa, como polvo alrededor.
  const oro = Math.PI * (3 - Math.sqrt(5));
  const puntos = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const capa = Math.random() < 0.8 ? 1 + (Math.random() - 0.5) * 0.05 : 1.07 + Math.random() * 0.25;
    puntos.push({
      x: Math.cos(oro * i) * r * capa, y: y * capa, z: Math.sin(oro * i) * r * capa,
      tam: 0.9 + Math.random() * 2.1, tono: Math.random(), fase: Math.random() * Math.PI * 2,
    });
  }
  return puntos;
}

function hilos(puntos) {
  // Cada segundo punto con su vecino mas cercano: una red ligera, no una malla.
  const pares = [];
  for (let i = 0; i < puntos.length; i += 2) {
    let mejor = -1, dmin = Infinity;
    for (let j = 0; j < puntos.length; j++) {
      if (j === i) continue;
      const dx = puntos[i].x - puntos[j].x, dy = puntos[i].y - puntos[j].y, dz = puntos[i].z - puntos[j].z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < dmin) { dmin = d; mejor = j; }
    }
    if (dmin < 0.05) pares.push([i, mejor]);
  }
  return pares;
}

export function crearOrbe(lienzo, { puntos: n = 560 } = {}) {
  const ctx = lienzo.getContext("2d");
  const quieto = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ritmo = quieto ? 0.3 : 1;
  const puntos = esfera(n);
  const pares = hilos(puntos);
  const orbitas = [
    { inclinacion: 0.42, giro: 0.2, radio: 1.2, velocidad: 0.35 },
    { inclinacion: 1.15, giro: 1.4, radio: 1.3, velocidad: -0.22 },
    { inclinacion: 2.3, giro: 2.6, radio: 1.13, velocidad: 0.28 },
  ];
  const proy = new Float32Array(n * 3);   // x, y, profundidad de cada punto

  let objetivo = ESTADOS.reposo;
  const actual = { ...ESTADOS.reposo };
  let amp = 0, ampSuave = 0;
  let ancho = 0, alto = 0, dpr = 1;
  // El giro se acumula: si cambia la velocidad (al pensar), no salta.
  let t = 0, angulo = 0, previo = 0, raf = 0, visible = true;

  function medir() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    ancho = lienzo.clientWidth; alto = lienzo.clientHeight;
    if (!ancho || !alto) return;
    lienzo.width = Math.round(ancho * dpr); lienzo.height = Math.round(alto * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function dibujar() {
    if (!ancho || !alto) return;
    ctx.clearRect(0, 0, ancho, alto);
    const cx = ancho / 2, cy = alto / 2;
    ampSuave += (amp - ampSuave) * 0.35;
    const vida = quieto ? 0 : actual.vida;
    const respira = 1 + Math.sin(t * 1.4) * 0.03 * vida;
    const R = Math.min(ancho, alto) * 0.33 * actual.escala * respira * (1 + ampSuave * 0.3);
    const ay = angulo, ax = 0.35 + Math.sin(t * 0.45) * 0.22;
    const cy1 = Math.cos(ay), sy1 = Math.sin(ay), cx1 = Math.cos(ax), sx1 = Math.sin(ax);
    const base = actual.color;

    // Halo del nucleo, detras de todo.
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.75 * actual.nucleo);
    halo.addColorStop(0, rgba(mezclar(GRIS, NARANJA, base), 0.42));
    halo.addColorStop(0.45, rgba(mezclar(GRIS, AMBAR, base), 0.16));
    halo.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.75 * actual.nucleo * (1 + ampSuave * 0.6), 0, Math.PI * 2); ctx.fill();

    // Un velo de color dentro de la esfera: le da cuerpo sin taparla.
    const velo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.05);
    velo.addColorStop(0, rgba(mezclar(GRIS, NARANJA, base), 0.1));
    velo.addColorStop(0.7, rgba(mezclar(GRIS, AGUA, base), 0.07));
    velo.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = velo;
    ctx.beginPath(); ctx.arc(cx, cy, R * 1.05, 0, Math.PI * 2); ctx.fill();

    // Orbitas, cada una con dos satelites que la recorren.
    ctx.lineWidth = 1.2;
    orbitas.forEach((o, k) => {
      const fi = o.giro + angulo * o.velocidad * 1.6;
      const aplaste = Math.abs(Math.cos(o.inclinacion)) * 0.9 + 0.1;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(fi);
      ctx.scale(1, aplaste);
      ctx.strokeStyle = rgba(mezclar(GRIS, NARANJA, base), 0.3);
      ctx.beginPath(); ctx.arc(0, 0, R * o.radio, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
      for (let s = 0; s < 2; s++) {
        const th = angulo * 2.2 * Math.sign(o.velocidad) + k * 2.1 + s * Math.PI;
        const x = Math.cos(th) * R * o.radio, y = Math.sin(th) * R * o.radio * aplaste;
        const sx = cx + x * Math.cos(fi) - y * Math.sin(fi), sy = cy + x * Math.sin(fi) + y * Math.cos(fi);
        const color = mezclar(GRIS, SATELITES[k], base);
        const brillo = ctx.createRadialGradient(sx, sy, 0, sx, sy, 9);
        brillo.addColorStop(0, rgba(color, 0.55));
        brillo.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = brillo;
        ctx.beginPath(); ctx.arc(sx, sy, 9, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = rgba(color, 0.95);
        ctx.beginPath(); ctx.arc(sx, sy, 2.8, 0, Math.PI * 2); ctx.fill();
      }
    });

    // Puntos: temblar, girar y proyectar. Cada uno se mece un poco en su
    // sitio (radial y de lado), asi la nube parece viva aunque gire despacio.
    for (let i = 0; i < n; i++) {
      const p = puntos[i];
      const vaiven = 1 + Math.sin(t * 1.8 + p.fase) * 0.035 * vida
        + Math.sin(t * 2.4 + p.fase) * actual.agitacion * 0.07 + ampSuave * 0.12 * Math.sin(t * 9 + p.fase);
      const d = Math.sin(t * 0.9 + p.fase) * 0.07 * vida;
      const cd = Math.cos(d), sd = Math.sin(d);
      const px = p.x * cd + p.z * sd, pz = -p.x * sd + p.z * cd;
      const x1 = (px * cy1 + pz * sy1) * vaiven;
      const z1 = (-px * sy1 + pz * cy1) * vaiven;
      const y1 = p.y * vaiven;
      const y2 = y1 * cx1 - z1 * sx1;
      const z2 = y1 * sx1 + z1 * cx1;
      const persp = 2.8 / (2.8 + z2);
      proy[i * 3] = cx + x1 * R * persp;
      proy[i * 3 + 1] = cy + y2 * R * persp;
      proy[i * 3 + 2] = (1.3 - z2) / 2.6;      // 1 delante, 0 detras
    }

    ctx.lineWidth = 0.8;
    for (const [i, j] of pares) {
      const prof = (proy[i * 3 + 2] + proy[j * 3 + 2]) / 2;
      ctx.strokeStyle = rgba(mezclar(GRIS, AGUA, base), 0.1 + prof * 0.26);
      ctx.beginPath();
      ctx.moveTo(proy[i * 3], proy[i * 3 + 1]);
      ctx.lineTo(proy[j * 3], proy[j * 3 + 1]);
      ctx.stroke();
    }

    for (let i = 0; i < n; i++) {
      const p = puntos[i];
      const prof = proy[i * 3 + 2];
      const tono = p.tono < 0.55 ? AGUA : p.tono < 0.9 ? NARANJA : AMBAR;
      ctx.fillStyle = rgba(mezclar(GRIS, tono, base), 0.32 + prof * 0.68);
      ctx.beginPath();
      ctx.arc(proy[i * 3], proy[i * 3 + 1], p.tam * (0.55 + prof * 0.75), 0, Math.PI * 2);
      ctx.fill();
    }

    // Escuchando: ondas que salen de la esfera.
    if (objetivo === ESTADOS.escuchando) {
      for (let k = 0; k < 2; k++) {
        const f = ((t * 0.6 + k * 0.5) % 1);
        ctx.strokeStyle = rgba(NARANJA, 0.35 * (1 - f));
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(cx, cy, R * (1.05 + f * 0.35), 0, Math.PI * 2); ctx.stroke();
      }
    }

    // Nucleo: un punto blanco con anillo, como el ojo del asistente.
    const late = 1 + Math.sin(t * (objetivo === ESTADOS.pensando ? 6 : 2.2)) * 0.08 * vida;
    const rn = R * 0.085 * actual.nucleo * late * (1 + ampSuave * 0.8);
    const brillo = ctx.createRadialGradient(cx, cy, 0, cx, cy, rn * 3.2);
    brillo.addColorStop(0, "rgba(255,255,255,0.95)");
    brillo.addColorStop(0.35, rgba(mezclar(GRIS, AMBAR, base), 0.55));
    brillo.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = brillo;
    ctx.beginPath(); ctx.arc(cx, cy, rn * 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(cx, cy, rn, 0, Math.PI * 2); ctx.fill();
  }

  function cuadro(ahora) {
    raf = 0;
    if (!visible || document.hidden) return;
    const dt = Math.min((ahora - (previo || ahora)) / 1000, 0.05);
    previo = ahora;
    for (const k of Object.keys(actual)) actual[k] += (objetivo[k] - actual[k]) * Math.min(1, dt * 3);
    t += dt;
    angulo += dt * actual.giro * ritmo;
    dibujar();
    raf = requestAnimationFrame(cuadro);
  }

  function arrancar() {
    if (!raf && visible && !document.hidden) { previo = 0; raf = requestAnimationFrame(cuadro); }
  }

  const ro = new ResizeObserver(() => { medir(); dibujar(); });
  ro.observe(lienzo);
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) arrancar(); });
  io.observe(lienzo);
  const alCambiarVisibilidad = () => { if (!document.hidden) arrancar(); };
  document.addEventListener("visibilitychange", alCambiarVisibilidad);
  medir();
  arrancar();

  return {
    estado(nombre) {
      objetivo = ESTADOS[nombre] || ESTADOS.reposo;
      if (nombre !== "hablando") amp = 0;
    },
    /** 0 = silencio; ~0.45 = voz alta. */
    amplitud(v) { amp = Math.max(0, Math.min(v, 0.6)); },
    destruir() {
      cancelAnimationFrame(raf);
      ro.disconnect(); io.disconnect();
      document.removeEventListener("visibilitychange", alCambiarVisibilidad);
    },
  };
}
