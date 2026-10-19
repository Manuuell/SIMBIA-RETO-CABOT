/* SIMBIA - portada: la torre en vivo del hero y la entrada al panel.
 *
 * La torre es la misma de torre3d.js que usa el gemelo, con la geometria
 * fija del caso base (GEOMETRIA_CASO_BASE).
 */

async function montarTorre() {
  const caja = document.getElementById("torre-viva");
  if (!caja) return;
  const quieta = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  try {
    const { crearTorre, GEOMETRIA_CASO_BASE } = await import("./torre3d.js");
    crearTorre(caja, GEOMETRIA_CASO_BASE, { etiquetas: false, transparente: true, autoGiro: !quieta, zoom: false });
  } catch {
    // Sin WebGL la portada sigue en pie: solo falta la torre.
    caja.closest(".hero-escena")?.classList.add("sin-3d");
  }
}

/** Con sesion abierta, el boton lleva directo al panel. */
async function ajustarEntrada() {
  try {
    const r = await fetch("/api/sesion");
    if (!r.ok) return;
    const s = await r.json();
    if (s.autenticacion && s.usuario) {
      document.querySelectorAll("#entrar, [data-entrar]").forEach((a) => {
        a.href = "/app";
        a.firstChild.textContent = "Ir al panel ";
      });
      document.getElementById("entrar").textContent = "Ir al panel";
    }
  } catch { /* sin red: el boton queda en "Iniciar sesion" */ }
}

/* -- Simular: la ventana del gemelo reproduciendo una simulacion real ---------
 * gemelo-demo.json es la salida del modelo dinamico del panel (dos semanas,
 * los vecinos entran al empezar el dia 1). Aqui solo se reproduce: dos
 * semanas en unos doce segundos, cuando la ventana entra en pantalla. */

const DURACION_MS = 12000;
// Safari comparte el hilo de la animacion SVG con el desplazamiento de la
// pagina. Quince repintados por segundo bastan para esta demostracion y dejan
// libre el gesto del trackpad; requestAnimationFrame sigue marcando el tiempo.
const INTERVALO_PINTADO_MS = 1000 / 15;
const TREN_CORTO = { T1: "filtración", T6: "UF + ósmosis" };
const coma = (v, d = 1) => v.toLocaleString("es", { minimumFractionDigits: d, maximumFractionDigits: d });

async function montarDemoGemelo() {
  const caja = document.getElementById("demo-gemelo");
  if (!caja) return;
  let d;
  try {
    d = await (await fetch("landing/gemelo-demo.json")).json();
  } catch {
    return; // sin datos queda la ventana en su estado inicial, que es la operacion de hoy
  }
  const $ = (id) => document.getElementById(id);
  const M = [{ ...d.muestras[0], t: 0 }, ...d.muestras];
  // El modelo conserva todas las muestras para interpolar los indicadores,
  // pero el SVG no necesita dibujar cientos de vertices en cada repintado.
  const saltoGrafica = Math.max(1, Math.ceil(M.length / 140));
  const G = M.filter((_, i) => i % saltoGrafica === 0 || i === M.length - 1);
  const fin = M[M.length - 1].t;
  const W = 320, H = 120;
  const tope = Math.ceil(Math.max(...M.map((m) => m.cruda + m.vecinos)) / 10) * 10;
  const X = (t) => (t / fin) * W;
  const Y = (v) => H - (v / tope) * (H - 6);
  const base = M[0];

  $("gd-eje-medio").textContent = `día ${Math.round(fin / 48)}`;
  $("gd-eje-fin").textContent = `día ${Math.round(fin / 24)}`;
  $("gd-vecinos-lista").innerHTML = d.vecinos.map((v, i) => `
    <div class="gd-fic"><code>FIC-20${i + 1}</code><b>${v.nombre}</b>
      <span>${coma(v.caudal_m3_h)} m³/h · ${TREN_CORTO[v.tren] || v.tren_nombre}</span><i class="gd-led"></i></div>`).join("");
  const fics = [...caja.querySelectorAll(".gd-fic")];
  const marca = $("gd-marca");
  marca.setAttribute("x1", X(d.conecta_h)); marca.setAttribute("x2", X(d.conecta_h));
  $("gd-evento").style.left = `${(X(d.conecta_h) / W) * 100}%`;

  // Areas apiladas hasta el instante t: vecinos abajo, agua cruda encima.
  function area(hasta, actual, abajo, arriba) {
    const pts = G.filter((m) => m.t <= hasta);
    if (!pts.length || pts[pts.length - 1].t < hasta) pts.push(actual);
    if (pts.length < 2) return "";
    const sup = pts.map((m) => `${X(m.t).toFixed(1)},${Y(arriba(m)).toFixed(1)}`);
    const inf = pts.slice().reverse().map((m) => `${X(m.t).toFixed(1)},${Y(abajo(m)).toFixed(1)}`);
    return `M${sup.join("L")}L${inf.join("L")}Z`;
  }

  function muestra(t) {
    let i = M.findIndex((m) => m.t >= t);
    if (i <= 0) return M[Math.max(i, 0)];
    const a = M[i - 1], b = M[i], f = (t - a.t) / (b.t - a.t);
    const mezcla = {};
    for (const k of Object.keys(b)) mezcla[k] = typeof b[k] === "number" && typeof a[k] === "number" ? a[k] + (b[k] - a[k]) * f : b[k];
    return { ...mezcla, fuera: b.fuera, cerca: b.cerca };
  }

  function pintar(t) {
    const m = muestra(t);
    $("gd-dia").textContent = Math.floor(t / 24);
    $("gd-hora").textContent = `${String(Math.floor(t % 24)).padStart(2, "0")}:00`;
    $("gd-ahorro").textContent = `${coma(m.ahorro * 100)} %`;
    $("gd-kpi-ahorro").classList.toggle("ok", m.ahorro >= d.meta);
    $("gd-cruda").textContent = coma(m.cruda);
    $("gd-vecinos").textContent = coma(m.vecinos);
    $("gd-ciclos").textContent = coma(m.ciclos ?? base.ciclos);
    $("gd-p-vecinos").setAttribute("d", area(t, m, () => 0, (x) => x.vecinos));
    $("gd-p-cruda").setAttribute("d", area(t, m, (x) => x.vecinos, (x) => x.vecinos + x.cruda));
    const conectados = t >= d.conecta_h;
    marca.style.opacity = conectados ? 0.5 : 0;
    $("gd-evento").classList.toggle("visible", conectados);
    fics.forEach((f) => f.classList.toggle("abierta", conectados));
    const lsi = `incrustación (LSI) ${coma(m.lsi, 2)} de ${coma(d.limites.lsi_max, 2)}`;
    $("gd-estado").innerHTML = !conectados
      ? "Operación de hoy, sin vecinos"
      : m.fuera ? `<span class="gd-chip fuera">fuera de límite</span>${lsi}`
      : m.cerca ? `<span class="gd-chip cerca">cerca del límite</span>${lsi}`
      : `<span class="gd-chip ok">dentro de límites</span>${lsi}`;
  }

  let inicio = null, cuadro = 0, ultimoPintado = 0, terminada = false;
  function paso(ahora) {
    inicio ??= ahora;
    const t = Math.min(fin, ((ahora - inicio) / DURACION_MS) * fin);
    if (ahora - ultimoPintado >= INTERVALO_PINTADO_MS || t >= fin) {
      pintar(t);
      ultimoPintado = ahora;
    }
    if (t < fin) cuadro = requestAnimationFrame(paso);
    else {
      cuadro = 0;
      terminada = true;
      $("gd-repetir").hidden = false;
    }
  }
  function reproducir() {
    cancelAnimationFrame(cuadro);
    inicio = null;
    ultimoPintado = 0;
    terminada = false;
    $("gd-repetir").hidden = true;
    cuadro = requestAnimationFrame(paso);
  }
  $("gd-repetir").addEventListener("click", reproducir);

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
    pintar(fin);
    $("gd-repetir").hidden = false;
    return;
  }
  pintar(0);
  const vigia = new IntersectionObserver((entradas) => {
    const proporcion = Math.max(...entradas.map((e) => e.intersectionRatio));
    if (proporcion >= 0.4 && !inicio && !terminada) reproducir();
    // Una vez que quien visita la pagina sigue bajando, ya no hay razon para
    // mantener el SVG actualizandose fuera de la vista. Se deja el resultado
    // final y el boton permite repetirlo al volver.
    if (proporcion < 0.1 && cuadro) {
      cancelAnimationFrame(cuadro);
      cuadro = 0;
      terminada = true;
      pintar(fin);
      $("gd-repetir").hidden = false;
    }
  }, { threshold: [0, 0.1, 0.4] });
  vigia.observe(caja);
}

ajustarEntrada();
montarDemoGemelo();
if ("requestIdleCallback" in window) window.requestIdleCallback(montarTorre, { timeout: 800 });
else setTimeout(montarTorre, 200);
