/* Mapa relativo sin conexión. Las líneas indican proximidad, no rutas levantadas. */

const NS = "http://www.w3.org/2000/svg";

function el(nombre, attrs = {}, texto = null) {
  const n = document.createElementNS(NS, nombre);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (texto !== null) n.textContent = texto;
  return n;
}

/* Escala de puntaje: gris (irrelevante) -> ambar -> naranja (prioritario).
 * Deliberadamente no es rojo-verde: rojo y verde ya significan alerta y
 * limite cumplido en el resto de la aplicacion, y ademas es la pareja que
 * mas gente confunde. */
function colorPuntaje(p) {
  if (p == null || p <= 0) return "#3f4b5c";
  const t = Math.max(0, Math.min(1, p / 60));
  const a = [110, 124, 145], b = [242, 118, 46];
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(",")})`;
}

export function dibujarMapa(contenedor, { planta, prospectos, alSeleccionar }) {
  contenedor.innerHTML = "";
  if (!prospectos.length) {
    contenedor.innerHTML = '<p class="cargando">Sin prospectos que dibujar.</p>';
    return;
  }

  const W = 640, H = 460, M = 26;
  // Escala cuadrada: si x e y tuvieran escalas distintas, las distancias
  // dejarian de ser comparables visualmente y el mapa mentiria.
  //
  // El alcance se toma de la distancia RADIAL maxima, no de la coordenada
  // maxima. Con la coordenada, los anillos de distancia se quedaban cortos
  // respecto a los prospectos mas lejanos (un punto a 45 grados y 4 km tiene
  // coordenadas de solo 2,8) y la escala del mapa dejaba de coincidir con la
  // que anunciaban las etiquetas.
  const alcance = Math.max(
    ...prospectos.map((p) => Math.hypot(p.x_km, p.y_km)), 1,
  ) * 1.12;
  const k = Math.min((W - 2 * M) / 2, (H - 2 * M) / 2) / alcance;
  const cx = W / 2, cy = H / 2;
  const X = (xkm) => cx + xkm * k;
  const Y = (ykm) => cy - ykm * k;

  const svg = el("svg", {
    viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet",
  });

  // -- anillos de distancia ------------------------------------------------
  const paso = alcance > 6 ? 2 : alcance > 3 ? 1 : 0.5;
  for (let r = paso; r <= alcance; r += paso) {
    svg.appendChild(el("circle", { class: "anillo", cx, cy, r: r * k }));
    svg.appendChild(el("text", {
      class: "anillo-txt", x: cx + 3, y: Y(r) - 3,
    }, `${r} km`));
  }

  // -- conducciones --------------------------------------------------------
  // Se dibujan primero para que queden por debajo de los nodos.
  const gDuctos = el("g");
  prospectos.forEach((p) => {
    gDuctos.appendChild(el("line", {
      class: "ducto" + ((p.puntaje || 0) >= 45 ? " destacado" : ""),
      x1: cx, y1: cy, x2: X(p.x_km), y2: Y(p.y_km),
    }));
  });
  svg.appendChild(gDuctos);

  // -- prospectos ----------------------------------------------------------
  const caudalMax = Math.max(...prospectos.map((p) => p.caudal_m3_h), 1);
  // Radio proporcional a la RAIZ del caudal: es el area la que se percibe
  // como cantidad, no el radio. Escalar el radio linealmente exagera las
  // diferencias por un factor de dos.
  const radio = (q) => 4 + 13 * Math.sqrt(q / caudalMax);

  const ordenados = [...prospectos].sort((a, b) => b.caudal_m3_h - a.caudal_m3_h);
  ordenados.forEach((p) => {
    const g = el("g", { class: "nodo", tabindex: "0", role: "button",
      "aria-label": `${p.nombre}. Puntaje ${p.puntaje ?? "sin evaluar"}. Ver detalle` });
    g.appendChild(el("title", {}, [
      p.nombre,
      `${p.sector}`,
      `${p.caudal_m3_h} m³/h · ${p.distancia_conduccion_km} km de conduccion`,
      `Puntaje ${p.puntaje ?? "—"} · confianza ${p.confianza} (${p.confianza_etiqueta})`,
      p.limitante,
    ].join("\n")));
    g.appendChild(el("circle", {
      cx: X(p.x_km), cy: Y(p.y_km), r: radio(p.caudal_m3_h),
      fill: colorPuntaje(p.puntaje),
      "fill-opacity": 0.55,
      stroke: colorPuntaje(p.puntaje),
      "stroke-width": 1.4,
      // Borde discontinuo = caracterizacion inferida, no declarada.
      "stroke-dasharray": p.metodo_calidad === "inferido" ? "3 2.5" : "",
    }));
    if (alSeleccionar) {
      g.addEventListener("click", () => alSeleccionar(p.clave));
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); alSeleccionar(p.clave); }
      });
    }
    svg.appendChild(g);
  });

  // Distribuir etiquetas en dos columnas evita colisiones en el corredor.
  const mejores = [...prospectos].sort((a, b) => (b.puntaje || 0) - (a.puntaje || 0)).slice(0, 8);
  [-1, 1].forEach((lado) => {
    const grupo = mejores.filter((p) => (p.x_km < 0 ? -1 : 1) === lado).sort((a, b) => b.y_km - a.y_km);
    let anterior = 20;
    grupo.forEach((p, i) => {
      const y = Math.max(anterior + 24, Math.min(H - 36 - (grupo.length - i - 1) * 24, Y(p.y_km)));
      anterior = y;
      const x = lado < 0 ? 150 : W - 150;
      svg.appendChild(el("line", { x1: X(p.x_km), y1: Y(p.y_km), x2: x, y2: y - 4, stroke: "#566579", "stroke-width": 0.6 }));
      svg.appendChild(el("text", { class: "nodo-txt", x, y: y - 7, "text-anchor": lado < 0 ? "end" : "start" },
        p.nombre.length > 24 ? p.nombre.slice(0, 23) + "…" : p.nombre));
    });
  });

  // -- planta --------------------------------------------------------------
  const gp = el("g");
  gp.appendChild(el("path", {
    d: `M ${cx - 8} ${cy - 8} L ${cx + 8} ${cy} L ${cx - 8} ${cy + 8} Z`,
    fill: "#f5b323",
  }));
  gp.appendChild(el("circle", {
    cx, cy, r: 13, fill: "none", stroke: "#f5b323", "stroke-width": 1.2,
  }));
  gp.appendChild(el("text", {
    class: "planta-txt", x: cx, y: cy + 28, "text-anchor": "middle",
  }, planta.nombre));
  svg.appendChild(gp);

  const cabecera = document.createElement("div");
  cabecera.className = "mapa-controles";
  cabecera.innerHTML = '<div><h3>Mapa de proximidad</h3><span class="pie">Norte ↑ · posiciones relativas a Cabot</span></div><div class="acciones"><button type="button" class="secundario pequeno" data-zoom="2" aria-label="Acercar mapa">+</button><button type="button" class="secundario pequeno" data-zoom="0.5" aria-label="Alejar mapa">−</button><button type="button" class="secundario pequeno" data-zoom="0">Restablecer</button></div>';
  contenedor.appendChild(cabecera);
  contenedor.appendChild(svg);
  svg.setAttribute("aria-label", "Mapa de proximidad de prospectos. Use los botones para ampliar y arrastre para explorar.");
  let vista = { x: 0, y: 0, w: W, h: H }, arrastre = null;
  const actualizar = () => svg.setAttribute("viewBox", `${vista.x} ${vista.y} ${vista.w} ${vista.h}`);
  cabecera.querySelectorAll("button").forEach((boton) => boton.addEventListener("click", () => {
    const factor = Number(boton.dataset.zoom);
    if (!factor) vista = { x: 0, y: 0, w: W, h: H };
    else {
      const ancho = Math.max(W / 8, Math.min(W, vista.w / factor));
      const alto = ancho * H / W;
      vista = { x: vista.x + (vista.w - ancho) / 2, y: vista.y + (vista.h - alto) / 2, w: ancho, h: alto };
    }
    actualizar();
  }));
  svg.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".nodo")) return;
    arrastre = { x: e.clientX, y: e.clientY, vista: { ...vista } };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!arrastre) return;
    const escala = Math.min(svg.clientWidth / vista.w, svg.clientHeight / vista.h);
    vista.x = arrastre.vista.x - (e.clientX - arrastre.x) / escala;
    vista.y = arrastre.vista.y - (e.clientY - arrastre.y) / escala;
    actualizar();
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((evento) => svg.addEventListener(evento, () => { arrastre = null; }));

  const ley = document.createElement("div");
  ley.className = "leyenda";
  ley.innerHTML =
    "<span><i style=\"width:10px;height:10px;border-radius:50%;background:#f2762e\"></i> tamaño = caudal · color = puntaje</span>" +
    "<span><i style=\"width:10px;height:10px;border-radius:50%;border:1.5px dashed #8391a3;background:none\"></i> borde discontinuo = calidad inferida</span>" +
    "<span><i style=\"background:#f2762e\"></i> vínculo directo, no trazado real</span>";
  contenedor.appendChild(ley);
}

export { colorPuntaje };
