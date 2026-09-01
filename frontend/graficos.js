// Graficos SVG minimos, sin dependencias externas.

const NS = "http://www.w3.org/2000/svg";

export const fmt = {
  num: (v, d = 0) => v.toLocaleString("es", { minimumFractionDigits: d, maximumFractionDigits: d }),
  pct: (v, d = 1) => (v * 100).toLocaleString("es", { minimumFractionDigits: d, maximumFractionDigits: d }) + " %",
  usd: (v) => "$" + Math.round(v).toLocaleString("es"),
  usdk: (v) => (Math.abs(v) >= 1000 ? "$" + (v / 1000).toFixed(0) + "k" : "$" + Math.round(v)),
};

function el(nombre, attrs = {}, texto = null) {
  const n = document.createElementNS(NS, nombre);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (texto !== null) n.textContent = texto;
  return n;
}

function lienzo(ancho, alto) {
  const svg = el("svg", {
    viewBox: `0 0 ${ancho} ${alto}`,
    width: "100%",
    height: alto,
    preserveAspectRatio: "xMidYMid meet",
  });
  return svg;
}

const COLOR_EJE = "#3a4757";
const COLOR_TEXTO = "#8b97a8";

function ejes(svg, m, ancho, alto, ticksY, ticksX, etiquetaY) {
  for (const t of ticksY) {
    svg.appendChild(el("line", {
      x1: m.i, y1: t.y, x2: ancho - m.d, y2: t.y,
      stroke: COLOR_EJE, "stroke-width": 1, "stroke-dasharray": "2 4", opacity: .6,
    }));
    svg.appendChild(el("text", {
      x: m.i - 8, y: t.y + 4, "text-anchor": "end",
      fill: COLOR_TEXTO, "font-size": 10,
    }, t.txt));
  }
  for (const t of ticksX) {
    svg.appendChild(el("text", {
      x: t.x, y: alto - m.b + 16, "text-anchor": "middle",
      fill: COLOR_TEXTO, "font-size": 10,
    }, t.txt));
  }
  if (etiquetaY) {
    svg.appendChild(el("text", {
      x: m.i - 8, y: m.s - 10, "text-anchor": "end",
      fill: COLOR_TEXTO, "font-size": 10, "font-weight": 600,
    }, etiquetaY));
  }
}

/** Grafico de lineas multiserie. series = [{nombre, color, datos:[{x,y}], eje}] */
export function lineas(contenedor, series, opciones = {}) {
  const ancho = opciones.ancho ?? 760;
  const alto = opciones.alto ?? 240;
  const m = { i: 52, d: opciones.ejeDerecho ? 46 : 14, s: 16, b: 28 };
  const svg = lienzo(ancho, alto);

  const todos = series.flatMap((s) => s.datos);
  if (!todos.length) { contenedor.replaceChildren(svg); return; }

  const xs = todos.map((p) => p.x);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const px = (x) => m.i + ((x - xMin) / (xMax - xMin || 1)) * (ancho - m.i - m.d);

  const escalas = {};
  for (const clave of ["izq", "der"]) {
    const ss = series.filter((s) => (s.eje ?? "izq") === clave);
    if (!ss.length) continue;
    const ys = ss.flatMap((s) => s.datos.map((p) => p.y));
    const loFijo = opciones[`min_${clave}`], hiFijo = opciones[`max_${clave}`];
    let lo = loFijo ?? Math.min(...ys);
    let hi = hiFijo ?? Math.max(...ys);
    if (hi === lo) hi = lo + 1;
    // El margen solo se anade a los extremos que el llamante NO ha fijado.
    const margen = (hi - lo) * 0.12;
    if (loFijo === undefined) lo -= margen;
    if (hiFijo === undefined) hi += margen;
    escalas[clave] = { lo, hi, py: (y) => alto - m.b - ((y - lo) / (hi - lo)) * (alto - m.s - m.b) };
  }

  const ticksY = [];
  for (let i = 0; i <= 4; i++) {
    const v = escalas.izq.lo + (i / 4) * (escalas.izq.hi - escalas.izq.lo);
    ticksY.push({ y: escalas.izq.py(v), txt: fmt.num(v, opciones.decimales ?? 0) });
  }
  const ticksX = (opciones.ticksX ?? []).map((t) => ({ x: px(t.x), txt: t.txt }));
  ejes(svg, m, ancho, alto, ticksY, ticksX, opciones.etiquetaY);

  if (escalas.der) {
    for (let i = 0; i <= 4; i++) {
      const v = escalas.der.lo + (i / 4) * (escalas.der.hi - escalas.der.lo);
      svg.appendChild(el("text", {
        x: ancho - m.d + 8, y: escalas.der.py(v) + 4, "text-anchor": "start",
        fill: COLOR_TEXTO, "font-size": 10,
      }, fmt.num(v, opciones.decimalesDer ?? 2)));
    }
  }

  for (const banda of opciones.bandas ?? []) {
    const e = escalas[banda.eje ?? "izq"];
    svg.appendChild(el("rect", {
      x: m.i, y: e.py(banda.hasta), width: ancho - m.i - m.d,
      height: Math.max(e.py(banda.desde) - e.py(banda.hasta), 0),
      fill: banda.color, opacity: banda.opacidad ?? .12,
    }));
  }

  for (const s of series) {
    const e = escalas[s.eje ?? "izq"];
    const d = s.datos.map((p, i) => `${i ? "L" : "M"}${px(p.x).toFixed(1)} ${e.py(p.y).toFixed(1)}`).join(" ");
    if (s.area) {
      svg.appendChild(el("path", {
        d: `${d} L${px(s.datos.at(-1).x)} ${alto - m.b} L${px(s.datos[0].x)} ${alto - m.b} Z`,
        fill: s.color, opacity: .13,
      }));
    }
    svg.appendChild(el("path", {
      d, fill: "none", stroke: s.color,
      "stroke-width": s.grosor ?? 1.8,
      "stroke-dasharray": s.discontinua ? "4 3" : "none",
      "stroke-linejoin": "round", "stroke-linecap": "round",
    }));
  }

  for (const l of opciones.lineasRef ?? []) {
    const e = escalas[l.eje ?? "izq"];
    svg.appendChild(el("line", {
      x1: m.i, x2: ancho - m.d, y1: e.py(l.y), y2: e.py(l.y),
      stroke: l.color, "stroke-width": 1.2, "stroke-dasharray": "5 4", opacity: .9,
    }));
    if (l.texto) {
      svg.appendChild(el("text", {
        x: ancho - m.d - 4, y: e.py(l.y) - 5, "text-anchor": "end",
        fill: l.color, "font-size": 10, "font-weight": 600,
      }, l.texto));
    }
  }
  contenedor.replaceChildren(svg);
}

/** Barras horizontales con valor. datos = [{etiqueta, valor, color, nota}] */
export function barras(contenedor, datos, opciones = {}) {
  const filaAlto = opciones.filaAlto ?? 30;
  const ancho = opciones.ancho ?? 560;
  const anchoEtiqueta = opciones.anchoEtiqueta ?? 190;
  const alto = datos.length * filaAlto + 10;
  const svg = lienzo(ancho, alto);
  const max = Math.max(...datos.map((d) => Math.abs(d.valor)), 1e-9);
  const anchoBarra = ancho - anchoEtiqueta - 74;

  datos.forEach((d, i) => {
    const y = i * filaAlto + 6;
    svg.appendChild(el("text", {
      x: 0, y: y + 13, fill: "#e6edf3", "font-size": 11.5,
    }, d.etiqueta.length > 30 ? d.etiqueta.slice(0, 29) + "…" : d.etiqueta));
    svg.appendChild(el("rect", {
      x: anchoEtiqueta, y: y + 4, width: anchoBarra, height: 12,
      rx: 3, fill: "#232c38",
    }));
    svg.appendChild(el("rect", {
      x: anchoEtiqueta, y: y + 4,
      width: Math.max((Math.abs(d.valor) / max) * anchoBarra, 2),
      height: 12, rx: 3, fill: d.color ?? "#f2762e",
    }));
    svg.appendChild(el("text", {
      x: ancho, y: y + 14, "text-anchor": "end",
      fill: "#8b97a8", "font-size": 11,
    }, d.nota ?? fmt.num(d.valor, 1)));
  });
  contenedor.replaceChildren(svg);
}

/** Diagrama de flujo del balance hidrico (entradas -> torre -> salidas). */
export function balanceFlujo(contenedor, { entradas, evaporacion, purga, arrastre, titulo }) {
  const ancho = 780, alto = 60 + Math.max(entradas.length, 3) * 44;
  const corta = (t, n = 26) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
  //: Alto minimo de banda para que la etiqueta quepa. Los caudales por debajo
  //: de ese umbral (arrastre, tipicamente <0.5 %) dejan de estar a escala.
  const MIN_BANDA = 20;
  const svg = lienzo(ancho, alto);
  const total = entradas.reduce((s, e) => s + e.valor, 0) || 1;
  const salidas = [
    { etiqueta: "Evaporacion", valor: evaporacion, color: "#4a9de0" },
    { etiqueta: "Purga", valor: purga, color: "#d9a441" },
    { etiqueta: "Arrastre", valor: arrastre, color: "#6b7688" },
  ].filter((s) => s.valor > 0.001);

  const xIzq = 214, xTorre = 342, anchoTorre = 116, xDer = xTorre + anchoTorre;
  const yTop = 34, alturaTotal = alto - yTop - 20;

  svg.appendChild(el("text", { x: 0, y: 16, fill: "#8b97a8", "font-size": 11, "font-weight": 600 }, titulo));

  let y = yTop;
  for (const e of entradas) {
    const h = Math.max((e.valor / total) * alturaTotal, MIN_BANDA);
    svg.appendChild(el("path", {
      d: `M${xIzq} ${y} L${xTorre} ${y} L${xTorre} ${y + h} L${xIzq} ${y + h} Z`,
      fill: e.color, opacity: .55,
    }));
    svg.appendChild(el("text", {
      x: xIzq - 8, y: y + h / 2 + 4, "text-anchor": "end",
      fill: "#e6edf3", "font-size": 11,
    }, corta(e.etiqueta)));
    svg.appendChild(el("text", {
      x: xIzq - 8, y: y + h / 2 + 16, "text-anchor": "end",
      fill: "#8b97a8", "font-size": 10,
    }, fmt.num(e.valor, 0) + " m³/d"));
    y += h + 4;
  }

  svg.appendChild(el("rect", {
    x: xTorre, y: yTop, width: anchoTorre, height: alturaTotal,
    rx: 6, fill: "#1d2530", stroke: "#f2762e", "stroke-width": 1.3,
  }));
  svg.appendChild(el("text", {
    x: xTorre + anchoTorre / 2, y: yTop + alturaTotal / 2 - 2,
    "text-anchor": "middle", fill: "#e6edf3", "font-size": 12, "font-weight": 600,
  }, "Torre"));
  svg.appendChild(el("text", {
    x: xTorre + anchoTorre / 2, y: yTop + alturaTotal / 2 + 14,
    "text-anchor": "middle", fill: "#8b97a8", "font-size": 10,
  }, "enfriamiento"));

  y = yTop;
  for (const s of salidas) {
    const h = Math.max((s.valor / total) * alturaTotal, MIN_BANDA);
    svg.appendChild(el("path", {
      d: `M${xDer} ${y} L${xDer + 128} ${y} L${xDer + 128} ${y + h} L${xDer} ${y + h} Z`,
      fill: s.color, opacity: .55,
    }));
    svg.appendChild(el("text", {
      x: xDer + 136, y: y + h / 2 + 4, fill: "#e6edf3", "font-size": 11,
    }, s.etiqueta));
    svg.appendChild(el("text", {
      x: xDer + 136, y: y + h / 2 + 16, fill: "#8b97a8", "font-size": 10,
    }, fmt.num(s.valor, 0) + " m³/d"));
    y += h + 4;
  }
  contenedor.replaceChildren(svg);
}

/** Barras de cumplimiento frente a limite. */
export function limites(contenedor, filas) {
  contenedor.replaceChildren(...filas.map((f) => {
    const frac = Math.min(f.valor / f.limite, 1.25);
    const color = frac > 1 ? "#e5534b" : frac > 0.9 ? "#d9a441" : "#2ec27e";
    const div = document.createElement("div");
    div.style.marginBottom = "9px";
    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:3px">
        <span>${f.nombre}</span>
        <span style="color:#8b97a8;font-variant-numeric:tabular-nums">
          ${fmt.num(f.valor, f.decimales ?? 0)} / ${fmt.num(f.limite, f.decimales ?? 0)} ${f.unidad ?? ""}
        </span>
      </div>
      <div class="barra-limite"><i style="width:${Math.min(frac * 100, 100)}%;background:${color}"></i></div>`;
    return div;
  }));
}
