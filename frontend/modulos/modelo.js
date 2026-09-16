/* Modulo 6: modelo y supuestos (referencia). */

import { $, escapar, estado, fmt, pedir } from "../comun.js";

const TONOS = { desplazamiento: "#f2762e", ciclos: "#f5b323", distancia: "#4a9de0", tratamiento: "#2ec27e", incentivo: "#8b97a8" };
const NOMBRE = {
  desplazamiento: "Agua cruda que desplaza", ciclos: "Ciclos a los que deja operar",
  distancia: "Distancia de conduccion", tratamiento: "Costo del tren de tratamiento", incentivo: "Incentivo del vecino",
};
const LIMITES = [
  ["conductividad_us_cm", "Conductividad", "µS/cm"], ["tds_mg_l", "TDS", "mg/L"],
  ["dureza_ca_mg_l", "Dureza calcica", "mg/L CaCO₃"], ["alcalinidad_mg_l", "Alcalinidad", "mg/L CaCO₃"],
  ["cloruros_mg_l", "Cloruros", "mg/L"], ["sulfatos_mg_l", "Sulfatos", "mg/L"], ["silice_mg_l", "Silice", "mg/L"],
  ["sst_mg_l", "SST", "mg/L"], ["dqo_mg_l", "DQO", "mg/L"], ["n_amoniacal_mg_l", "N amoniacal", "mg/L"],
  ["fosfatos_mg_l", "Fosfatos", "mg/L"], ["hierro_mg_l", "Hierro", "mg/L"],
  ["lsi_max", "LSI max (sin antiincrustante)", ""], ["lsi_max_con_antiincrustante", "LSI max (con antiincrustante)", ""],
  ["larson_skold_max", "Larson-Skold max", ""],
];

export default {
  id: "modelo",
  async montar() {
    const pesos = estado.config.pesos_puntaje;
    $("modelo-pesos").innerHTML = Object.entries(pesos).map(([k, v]) => `
      <div style="display:grid;grid-template-columns:1fr 60px;gap:10px;align-items:center;margin-bottom:6px;font-size:12.5px">
        <span>${NOMBRE[k] || k}</span>
        <span style="text-align:right;font-weight:640;color:${TONOS[k]}">${v} %</span>
        <div class="barra-limite" style="grid-column:1/-1"><i style="width:${v / 40 * 100}%;background:${TONOS[k]}"></i></div>
      </div>`).join("");

    const [arq, trenes] = await Promise.all([pedir("/api/scout/arquetipos"), pedir("/api/trenes")]);
    $("tabla-arquetipos").querySelector("tbody").innerHTML = arq.map((x) => `<tr>
      <td><b>${escapar(x.nombre)}</b></td><td class="sub">${x.ciiu.join(", ")}</td><td>${escapar(x.corriente)}</td>
      <td class="num">${fmt.num(x.caudal_ref_m3_h)}</td><td class="num">${fmt.num(x.calidad.tds)}</td>
      <td class="num">${fmt.num(x.calidad.dqo)}</td>
      <td class="num" style="color:${x.incentivo_usd_m3 < 0 ? "var(--ok)" : "var(--texto-tenue)"}">${x.incentivo_usd_m3.toFixed(2)}</td>
      <td class="sub">${escapar(x.limitante)}</td></tr>`).join("");

    $("tabla-trenes").innerHTML = `<table><thead><tr><th>Cod</th><th>Tren</th><th class="num">Recuperacion</th>
      <th class="num">CAPEX USD/(m³/h)</th><th class="num">OPEX USD/m³</th></tr></thead>
      <tbody>${trenes.map((t) => `<tr><td><b>${t.codigo}</b></td><td>${escapar(t.nombre)}<span class="sub">${t.unidades.join(" → ") || "sin unidades"}</span></td>
        <td class="num">${fmt.pct(t.recuperacion, 0)}</td><td class="num">${fmt.num(t.capex_usd_m3h)}</td>
        <td class="num">${t.opex_usd_m3.toFixed(3)}</td></tr>`).join("")}</tbody></table>`;

    const lim = estado.escenario.limites;
    $("tabla-limites").innerHTML = `<table><thead><tr><th>Parametro del agua circulante</th><th class="num">Limite</th></tr></thead>
      <tbody>${LIMITES.map(([k, n, u]) => `<tr><td>${n}</td><td class="num">${fmt.num(lim[k], u ? 0 : 1)} ${u}</td></tr>`).join("")}</tbody></table>
      <p class="pie">Practica habitual para acero al carbono, relleno de PVC e intercambiadores de acero inoxidable 304.
        Ciclos explorables: ${estado.escenario.torre.ciclos_min} a ${estado.escenario.torre.ciclos_max}; linea base ${estado.escenario.torre.ciclos_base}.</p>`;

    $("tabla-oferentes").innerHTML = `<table><thead><tr><th>Cod</th><th>Vecino</th><th>Corriente</th>
      <th class="num">m³/h</th><th class="num">km</th><th class="num">USD/m³</th><th class="num">TDS</th><th class="num">DQO</th><th>Limitante</th></tr></thead>
      <tbody>${estado.oferentes.map((o) => `<tr>
        <td><b>${o.codigo}</b></td><td>${escapar(o.empresa)}</td><td class="sub">${escapar(o.corriente)}</td>
        <td class="num">${o.caudal_disponible_m3_h}</td><td class="num">${o.distancia_km}</td>
        <td class="num" style="color:${o.precio_usd_m3 < 0 ? "var(--ok)" : "inherit"}">${o.precio_usd_m3.toFixed(2)}</td>
        <td class="num">${fmt.num(o.calidad.tds)}</td><td class="num">${fmt.num(o.calidad.dqo)}</td>
        <td class="sub">${escapar(o.notas.split(". ").at(-1))}</td></tr>`).join("")}</tbody></table>`;
  },
};
