/* Modulo 0: resultado con los vecinos reales y recorrido por la aplicacion. */

import { $, bus, cargarBarrido, chip, escapar, estado, fechaCorta, fmt, kpi, pedir } from "../comun.js";

const TRAMOS = [
  { id: "datos", n: "Paso 1", t: "Datos externos",
    d: "Consultar OpenStreetMap y los permisos de vertimiento de VITAL; traer los documentos del expediente." },
  { id: "vital", n: "Paso 2", t: "Buscador VITAL",
    d: "Encontrar el expediente de una empresa concreta, redactar la solicitud y vincularlo al prospecto." },
  { id: "prospectos", n: "Paso 3", t: "Prospectos",
    d: "Cada empresa con su agua estimada, su confianza y un puntaje que dice a quien visitar primero." },
  { id: "empresas", n: "Paso 4", t: "Empresas",
    d: "La cartera: las elegidas con su dossier, expedientes, documentos leidos con IA y revision humana." },
  { id: "asistente", n: "Asistente", t: "Pregunta y escucha",
    d: "Se le escribe o se le dicta; responde con los datos de la aplicacion y lo explica hablando." },
];

function conExpediente(b) {
  return b.prospectos.filter((p) => (p.referencias || []).some((r) => r.fuente === "vital")).length;
}

function pintarRecorrido() {
  const b = estado.barrido;
  const osm = (b?.fuentes || []).find((f) => f.fuente === "osm");
  const documentos = b ? b.prospectos.reduce((s, p) => s + (p.ficha?.documentos || []).length, 0) : 0;
  const estadoDe = b ? {
    datos: chip(`${b.resumen.detectados} empresas${osm?.fecha_dato ? " · " + fechaCorta(osm.fecha_dato) : ""}`, "ok"),
    vital: chip(`${conExpediente(b)} con expediente`, "neutra"),
    prospectos: chip(`${b.resumen.viables} con simbiosis viable`, "azul"),
    empresas: chip(`${b.prospectos.filter((p) => p.ficha?.en_cartera).length} en cartera · ${documentos} documento${documentos === 1 ? "" : "s"}`, "neutra"),
  } : {};
  const tramos = TRAMOS.filter((t) => t.id !== "asistente" || estado.config?.extraccion_ia?.disponible);
  $("inicio-recorrido").innerHTML = tramos.map((t) => `
    <a class="tramo" href="#${t.id}">
      <div class="n">${t.n}</div>
      <div class="t">${t.t}</div>
      <div class="d">${t.d}</div>
      <div class="estado">${estadoDe[t.id] || ""}</div>
    </a>`).join("");
}

/* El resultado de portada sale del optimizador corriendo sobre el catalogo
   prospectado, no sobre el catalogo supuesto del caso base. */
async function pintarResultado() {
  let r;
  try {
    r = await pedir("/api/scout/optimizar", {});
  } catch (e) {
    $("inicio-kpis").innerHTML = `<p class="cargando">No se pudo optimizar: ${escapar(e.message)}</p>`;
    return;
  }
  if (!r.factible) {
    $("inicio-meta").innerHTML = chip("sin solucion", "alerta");
    $("inicio-kpis").innerHTML = `<p class="cargando">${escapar(r.motivo || "")}</p>`;
    return;
  }
  const o = r.optimo, b = r.linea_base;
  const ahorroUsd = b.costo_total_usd_anio - o.costo_total_usd_anio;
  const payback = ahorroUsd > 0 ? o.capex_total_usd / ahorroUsd : null;
  const empresas = [...new Set((o.aportes || []).map((a) => a.empresa))];
  $("inicio-meta").innerHTML = chip(r.cumple_meta ? "meta cumplida" : "meta no alcanzada", r.cumple_meta ? "ok" : "alerta");
  $("inicio-kpis").innerHTML = [
    kpi("Reduccion del consumo", fmt.pct(o.ahorro_pct_planta),
      `meta ${fmt.pct(r.meta_reduccion, 0)} · ${fmt.num(o.ahorro_m3_dia)} m³/d de agua cruda evitada`, "destacado"),
    kpi("Agua de vecinos reutilizada", `${fmt.num(o.reuso_total_m3_dia)} m³/d`,
      `${empresas.length} empresa${empresas.length === 1 ? "" : "s"} en la mezcla`),
    kpi("Ciclos de concentracion", `${fmt.num(b.ciclos, 1)} → ${fmt.num(o.ciclos, 1)}`, "menos purga por cada m³ evaporado"),
    kpi("Ahorro economico", `${fmt.usdk(ahorroUsd)}/año`,
      `inversion ${fmt.usdk(o.capex_total_usd)}${payback ? ` · recuperacion ${fmt.num(payback, 1)} años` : ""}`),
  ].join("");
  $("inicio-mezcla").innerHTML = empresas.length
    ? `Mezcla propuesta: ${empresas.map((e) => `<b>${escapar(e)}</b>`).join(", ")}.
       Los datos con menor confianza reciben una disponibilidad conservadora. Consulta la evidencia
       de cada empresa en <a href="#prospectos">Prospectos</a>.`
    : "";
}

export default {
  id: "inicio",
  async montar() {
    pintarRecorrido();
    bus.on("barrido", pintarRecorrido);
    if (!estado.barrido) cargarBarrido().catch(() => {});
    await pintarResultado();
  },
};
