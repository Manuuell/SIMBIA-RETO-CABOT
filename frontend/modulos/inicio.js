/* Modulo 0: resultado del caso base y recorrido por la aplicacion. */

import { $, bus, chip, escapar, estado, fmt, kpi, pedir } from "../comun.js";

const TRAMOS = [
  { id: "datos", n: "Paso 1", t: "Datos externos",
    d: "Consultar OpenStreetMap y los permisos de vertimiento de VITAL; traer los documentos del expediente." },
  { id: "vital", n: "Paso 2", t: "Buscador VITAL",
    d: "Encontrar el expediente de una empresa concreta, redactar la solicitud y vincularlo al prospecto." },
  { id: "prospectos", n: "Paso 3", t: "Prospectos",
    d: "Cada empresa con su agua estimada, su confianza y un puntaje que dice a quien visitar primero." },
  { id: "embudo", n: "Paso 4", t: "Embudo comercial",
    d: "Cuanto caudal hay contactado, caracterizado o contratado, y que cambio en el parque." },
  { id: "optimizador", n: "Paso 5", t: "Optimizador",
    d: "Que mezclar, con que tren de tratamiento, cuanto acido y a que ciclos. Con el catalogo supuesto o con los prospectos reales." },
  { id: "operacion", n: "Paso 6", t: "Operacion e IA",
    d: "Demanda a 24 h, deteccion de fugas y riesgo de ensuciamiento a 7 dias." },
  { id: "modelo", n: "Referencia", t: "Modelo y supuestos",
    d: "Que da por supuesto la aplicacion y como calcula cada cosa." },
];

function pintarRecorrido() {
  const b = estado.barrido, cfg = estado.config;
  const estadoDe = {
    datos: b ? chip(`${b.resumen.detectados} prospectos · modo ${b.modo}`, "ok")
             : chip(`modo ${cfg.modo}`, "neutra"),
    vital: b ? chip(`${b.prospectos.filter((p) => (p.referencias || []).some((r) => r.fuente === "vital")).length} con expediente`, "neutra") : "",
    prospectos: b ? chip(`${b.resumen.viables} con simbiosis viable`, "azul") : "",
    embudo: estado.pipeline ? chip(`${fmt.num(estado.pipeline.caudal_asegurado_m3_h)} m³/h asegurados`, "neutra") : "",
    optimizador: "",
    operacion: "",
    modelo: chip(`${cfg.arquetipos} arquetipos`, "neutra"),
  };
  $("inicio-recorrido").innerHTML = TRAMOS.map((t) => `
    <a class="tramo" href="#${t.id}">
      <div class="n">${t.n}</div>
      <div class="t">${t.t}</div>
      <div class="d">${t.d}</div>
      <div class="estado">${estadoDe[t.id] || ""}</div>
    </a>`).join("");
}

async function pintarKpis() {
  const k = await pedir("/api/kpis");
  const cumple = k.ahorro_pct >= k.meta_reduccion;
  $("inicio-meta").innerHTML = chip(cumple ? "meta cumplida" : "meta no alcanzada", cumple ? "ok" : "alerta");
  $("inicio-kpis").innerHTML = [
    kpi("Reduccion del consumo", fmt.pct(k.ahorro_pct),
      `meta ${fmt.pct(k.meta_reduccion, 0)} · ${fmt.num(k.ahorro_m3_dia)} m³/d de agua cruda evitada`, "destacado"),
    kpi("Ahorro economico", `${fmt.usdk(k.ahorro_economico_usd_anio)}/año`,
      `inversion ${fmt.usdk(k.capex_usd)} · payback ${k.payback_anios.toFixed(2)} años`),
    kpi("Ciclos de concentracion", `${k.ciclos_base} → ${k.ciclos_optimo}`,
      "menos purga por cada m³ evaporado"),
    kpi("CO₂ evitado", `${fmt.num(k.co2_evitado_t_anio, 0)} t/año`,
      `+ ${fmt.num(k.m3_recuperables_fugas_anio)} m³/año recuperables por deteccion de fugas`),
  ].join("");
}

export default {
  id: "inicio",
  async montar() {
    pintarRecorrido();
    bus.on("barrido", pintarRecorrido);
    bus.on("pipeline", pintarRecorrido);
    await pintarKpis();
  },
};
