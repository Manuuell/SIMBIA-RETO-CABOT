/* Mapa del parque industrial.
 *
 * SVG a mano, sin libreria de mapas. Motivos: el proyecto entero no tiene
 * dependencias npm, un mapa de teselas exige red (y esta pagina tiene que
 * funcionar sin ella), y a escala de un parque industrial no hace falta
 * cartografia de fondo — lo que importa es la posicion relativa a la planta
 * y la longitud del trazado, no el detalle del terreno.
 *
 * Tres canales visuales, cada uno con un significado y solo uno:
 *   posicion  ->  donde esta realmente (proyeccion equirectangular en km)
 *   tamano    ->  caudal disponible
 *   color     ->  puntaje de simbiosis
 *
 * La confianza NO se codifica con color aqui: el color ya esta ocupado. Se
 * codifica con el trazo del borde, discontinuo cuando el dato es inferido.
 */

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
    const g = el("g", { class: "nodo" });
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
    if (alSeleccionar) g.addEventListener("click", () => alSeleccionar(p.clave));
    svg.appendChild(g);
  });

  // Etiquetas solo de los seis mejores: mas texto se solapa y no se lee.
  [...prospectos]
    .sort((a, b) => (b.puntaje || 0) - (a.puntaje || 0))
    .slice(0, 6)
    .forEach((p) => {
      const corto = p.nombre.length > 26 ? p.nombre.slice(0, 25) + "…" : p.nombre;
      svg.appendChild(el("text", {
        class: "nodo-txt",
        x: X(p.x_km),
        y: Y(p.y_km) - radio(p.caudal_m3_h) - 4,
        "text-anchor": "middle",
      }, corto));
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

  contenedor.appendChild(svg);

  const ley = document.createElement("div");
  ley.className = "leyenda";
  ley.innerHTML =
    "<span><i style=\"width:10px;height:10px;border-radius:50%;background:#f2762e\"></i> area = caudal · color = puntaje</span>" +
    "<span><i style=\"width:10px;height:10px;border-radius:50%;border:1.5px dashed #8391a3;background:none\"></i> borde discontinuo = calidad inferida</span>" +
    "<span><i style=\"background:#f2762e\"></i> trazado de conduccion</span>";
  contenedor.appendChild(ley);
}

export { colorPuntaje };
