/* Esquema relativo: conserva coordenadas y escala; no representa un trazado. */
const NS = "http://www.w3.org/2000/svg";
function el(nombre, attrs = {}, texto = null) {
  const n = document.createElementNS(NS, nombre);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (texto !== null) n.textContent = texto;
  return n;
}
function html(nombre, clase, texto) {
  const n = document.createElement(nombre);
  n.className = clase;
  if (texto != null) n.textContent = texto;
  return n;
}
const num = (v, dec = 1) => Number.isFinite(v) ? v.toLocaleString("es-CO", { maximumFractionDigits: dec }) : "—";
function colorPuntaje(p) {
  if (p == null || p <= 0) return "#b8c2c8";
  const t = Math.max(0, Math.min(1, p / 60));
  const a = [168, 180, 188], b = [242, 118, 46];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
}

export function dibujarMapa(contenedor, { planta, prospectos, alSeleccionar }) {
  contenedor.replaceChildren();
  if (!prospectos.length) {
    contenedor.append(html("p", "cargando", "Ninguna empresa cumple los filtros actuales."));
    return;
  }
  const ordenados = [...prospectos].sort((a, b) => (b.puntaje || 0) - (a.puntaje || 0));
  const puestos = new Map(ordenados.map((p, i) => [p.clave, i + 1]));
  const cartera = p => Boolean(p.ficha?.en_cartera);
  const destacados = [...ordenados].sort((a, b) => Number(cartera(b)) - Number(cartera(a))).slice(0, 8);
  const W = 560, H = 500, cx = W / 2, cy = H / 2;
  const alcance = Math.max(...prospectos.map(p => Math.hypot(p.x_km, p.y_km)), 1) * 1.15;
  const k = 208 / alcance;
  const X = p => cx + p.x_km * k, Y = p => cy - p.y_km * k;
  const maxQ = Math.max(...prospectos.map(p => p.caudal_m3_h || 0), 1);

  const cabecera = html("div", "mapa-controles");
  cabecera.innerHTML = '<div><p class="mapa-eyebrow">ENTORNO INDUSTRIAL · MAMONAL</p><h3>Empresas alrededor de Cabot</h3><p class="pie">Explora su ubicación y abre la ficha de cada empresa.</p></div><div class="mapa-zoom"><button type="button" class="secundario pequeno" data-zoom="1.5" aria-label="Acercar mapa">+</button><button type="button" class="secundario pequeno" data-zoom="0.6666667" aria-label="Alejar mapa">−</button><button type="button" class="secundario pequeno" data-zoom="0">Centrar</button></div>';
  contenedor.append(cabecera);
  const cuerpo = html("div", "mapa-cuerpo");
  const lienzo = html("div", "mapa-lienzo");
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet", "aria-label": "Posiciones relativas a Cabot. Norte arriba. Las empresas se pueden abrir con Enter; use los botones para ampliar." });
  const fondo = el("g", { class: "mapa-reticula" });
  fondo.append(el("line", { x1: cx, y1: 20, x2: cx, y2: H - 20 }), el("line", { x1: 35, y1: cy, x2: W - 35, y2: cy }));
  const paso = alcance > 6 ? 2 : alcance > 3 ? 1 : 0.5;
  for (let r = paso; r <= alcance; r += paso) {
    fondo.append(el("circle", { class: "anillo", cx, cy, r: r * k }));
    // Etiquetas al este: dejan libre el corredor industrial norte-sur.
    fondo.append(el("text", { class: "anillo-txt", x: cx + r * k - 4, y: cy - 8, "text-anchor": "end" }, `${num(r)} km`));
  }
  svg.append(fondo);
  const ductos = el("g"), nodos = new Map(), lineas = new Map(), botones = new Map();
  svg.append(ductos);
  const ficha = html("div", "mapa-lectura");
  ficha.setAttribute("aria-live", "polite");
  const enfocar = p => {
    nodos.forEach((n, clave) => n.classList.toggle("mapa-activo", clave === p.clave));
    lineas.forEach((n, clave) => n.classList.toggle("mapa-activo", clave === p.clave));
    botones.forEach((n, clave) => n.classList.toggle("mapa-activo", clave === p.clave));
    if (nodos.has(p.clave)) svg.append(nodos.get(p.clave));
    ficha.replaceChildren(html("b", "", p.nombre), html("span", "", `${num(p.distancia_conduccion_km)} km de conducción estimada · ${num(p.caudal_m3_h)} m³/h de catálogo`));
  };
  [...ordenados].sort((a, b) => b.caudal_m3_h - a.caudal_m3_h).forEach(p => {
    const linea = el("line", { class: "mapa-conexion", x1: cx, y1: cy, x2: X(p), y2: Y(p) });
    ductos.append(linea); lineas.set(p.clave, linea);
    const g = el("g", { class: "mapa-nodo", tabindex: "0", role: "button", "aria-label": `${p.nombre}. Puntaje ${num(p.puntaje)} de 100. Abrir ficha.` });
    g.append(el("title", {}, `${p.nombre}\n${num(p.caudal_m3_h)} m³/h · calidad ${p.metodo_calidad}\n${num(p.distancia_conduccion_km)} km de conducción estimada`));
    g.append(el("circle", { class: "mapa-halo", cx: X(p), cy: Y(p), r: 17 }));
    g.append(el("circle", { class: "mapa-punto", cx: X(p), cy: Y(p), r: 6 + 7 * Math.sqrt(Math.max(0, p.caudal_m3_h || 0) / maxQ), fill: colorPuntaje(p.puntaje), "stroke-dasharray": p.metodo_calidad === "inferido" ? "3 2" : "" }));
    if (destacados.includes(p)) g.append(el("text", { class: "mapa-numero", x: X(p), y: Y(p) + 3 }, String(puestos.get(p.clave))));
    g.addEventListener("pointerenter", () => enfocar(p));
    g.addEventListener("focus", () => enfocar(p));
    g.addEventListener("click", () => alSeleccionar?.(p.clave));
    g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alSeleccionar?.(p.clave); } });
    nodos.set(p.clave, g); svg.append(g);
  });
  const cabot = el("g", { class: "mapa-cabot" });
  cabot.append(el("title", {}, planta.nombre), el("circle", { cx, cy, r: 15 }));
  cabot.append(el("path", { d: `M${cx-5},${cy+6} v-10 l5,3 v-5 l6,4 v8 Z` }));
  cabot.append(el("rect", { x: cx - 79, y: cy - 10, width: 56, height: 21, rx: 10 }));
  cabot.append(el("text", { x: cx - 51, y: cy + 4, "text-anchor": "middle" }, "CABOT"));
  svg.append(cabot);
  lienzo.append(html("span", "mapa-norte", "↑ N"), html("span", "mapa-conteo", `${prospectos.length} empresas visibles`), svg, ficha);
  const lateral = html("div", "mapa-seleccion");
  lateral.append(html("p", "mapa-eyebrow", "EMPRESAS DESTACADAS"), html("p", "mapa-explicacion", "Cartera primero; después, mayor puntaje. El número indica su puesto en el filtro actual."));
  destacados.forEach(p => {
    const b = html("button", "mapa-empresa"); b.type = "button";
    b.append(html("span", "mapa-puesto", String(puestos.get(p.clave))));
    const texto = html("span", "mapa-empresa-texto");
    texto.append(html("b", "", p.nombre), html("small", "", `${num(p.distancia_conduccion_km)} km estimados${cartera(p) ? " · En cartera" : ""}`));
    b.append(texto, html("span", "mapa-score", `${num(p.puntaje)} /100`));
    b.addEventListener("pointerenter", () => enfocar(p));
    b.addEventListener("focus", () => enfocar(p));
    b.addEventListener("click", () => alSeleccionar?.(p.clave));
    botones.set(p.clave, b); lateral.append(b);
  });
  cuerpo.append(lienzo, lateral); contenedor.append(cuerpo);
  enfocar(destacados[0]);

  let vista = { x: 0, y: 0, w: W, h: H }, arrastre = null;
  const actualizar = () => svg.setAttribute("viewBox", `${vista.x} ${vista.y} ${vista.w} ${vista.h}`);
  cabecera.querySelectorAll("[data-zoom]").forEach(b => b.addEventListener("click", () => {
    const factor = Number(b.dataset.zoom);
    if (!factor) vista = { x: 0, y: 0, w: W, h: H };
    else {
      const w = Math.max(W / 8, Math.min(W, vista.w / factor)), h = w * H / W;
      vista = { x: vista.x + (vista.w - w) / 2, y: vista.y + (vista.h - h) / 2, w, h };
    }
    actualizar();
  }));
  svg.addEventListener("pointerdown", e => {
    if (e.target.closest(".mapa-nodo")) return;
    arrastre = { x: e.clientX, y: e.clientY, vista: { ...vista } }; svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", e => {
    if (!arrastre) return;
    const escala = Math.min(svg.clientWidth / vista.w, svg.clientHeight / vista.h);
    vista.x = arrastre.vista.x - (e.clientX - arrastre.x) / escala;
    vista.y = arrastre.vista.y - (e.clientY - arrastre.y) / escala;
    actualizar();
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(ev => svg.addEventListener(ev, () => { arrastre = null; }));
  const ley = html("div", "mapa-claves");
  ley.innerHTML = '<span><i class="mapa-clave-punto"></i>Tamaño: caudal de catálogo</span><span><i class="mapa-clave-score"></i>Color: puntaje bajo → alto</span><span><i class="mapa-clave-inferido"></i>Borde discontinuo: calidad inferida</span>';
  contenedor.append(ley, html("p", "mapa-nota", "Esquema de proximidad · Norte arriba · Anillos: distancia en línea recta. La conexión resaltada no representa una tubería ni un trazado aprobado."));
}
export { colorPuntaje };
