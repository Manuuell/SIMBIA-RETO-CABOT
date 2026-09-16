/* Modulo 4: optimizador. Dos pestanas: caso base y prospectos reales. */

import { barras, balanceFlujo, limites, lineas } from "../graficos.js";
import { $, cargarBarrido, chip, error, escapar, estado, fmt, kpi, pedir } from "../comun.js";

const ajustes = {
  costo_agua_cruda_usd_m3: 1.35, costo_vertimiento_usd_m3: 0.85, meta_reduccion: 0.10,
  max_fraccion_reuso: 0.85, usar_antiincrustante: true, oferentes_excluidos: [],
};

// ---------------------------------------------------------------------------
// Caso base
// ---------------------------------------------------------------------------

function pintarKpis(d) {
  const o = d.optimo, b = d.linea_base, cumple = d.cumple_meta;
  const ahorroEcon = b.costo_total_usd_anio - o.costo_total_usd_anio;
  const payback = ahorroEcon > 0 ? o.capex_total_usd / ahorroEcon : null;
  $("kpis").innerHTML = [
    kpi("Reduccion de consumo", o.factible ? fmt.pct(o.ahorro_pct_planta) : "—",
      `meta ${fmt.pct(d.meta_reduccion, 0)} · ${cumple ? "cumplida" : "no cumplida"}`, "destacado"),
    kpi("Agua cruda evitada", `${fmt.num(o.ahorro_m3_dia)} m³/d`, `${fmt.num(o.ahorro_m3_dia * 365 / 1000)} miles de m³/año`),
    kpi("Ahorro economico", `${fmt.usdk(ahorroEcon)}/año`, `${fmt.usdk(b.costo_total_usd_anio)} → ${fmt.usdk(o.costo_total_usd_anio)}`),
    kpi("Inversion", fmt.usdk(o.capex_total_usd), payback ? `payback ${payback.toFixed(2)} años` : "sin retorno"),
    kpi("Ciclos", o.ciclos.toFixed(1), `linea base ${b.ciclos.toFixed(1)}`),
    kpi("Reuso incorporado", `${fmt.num(o.reuso_total_m3_dia)} m³/d`,
      `${o.aportes.length} corriente(s) de ${new Set(o.aportes.map((a) => a.oferente)).size} vecino(s)`),
  ].join("");
  $("estado-meta").innerHTML = o.factible
    ? chip(cumple ? "meta cumplida" : "meta no alcanzada", cumple ? "ok" : "alerta")
    : `${chip("sin solucion", "alerta")} <span style="text-transform:none;letter-spacing:0">${escapar(o.motivo)}</span>`;
}

function pintarBalance(d) {
  const o = d.optimo, b = d.linea_base;
  balanceFlujo($("flujo-base"), {
    titulo: "OPERACION ACTUAL — 100 % agua cruda",
    entradas: [{ etiqueta: "Agua cruda captada", valor: b.agua_cruda_m3_dia, color: "#e5534b" }],
    evaporacion: b.balance.evaporacion_m3_h * 24, purga: b.balance.purga_m3_dia, arrastre: b.balance.arrastre_m3_h * 24,
  });
  balanceFlujo($("flujo-optimo"), {
    titulo: "CON SIMBIA — mezcla optimizada",
    entradas: [
      { etiqueta: "Agua cruda captada", valor: o.agua_cruda_m3_dia, color: "#e5534b" },
      ...o.aportes.map((a) => ({ etiqueta: `${a.oferente} ${a.empresa.split(/[ /]/)[0]} · ${a.tren}`, valor: a.caudal_m3_dia, color: "#2ec27e" })),
    ],
    evaporacion: o.balance.evaporacion_m3_h * 24, purga: o.balance.purga_m3_dia, arrastre: o.balance.arrastre_m3_h * 24,
  });
}

function pintarMezcla(d) {
  const o = d.optimo;
  if (!o.aportes.length) { $("tabla-mezcla").innerHTML = '<p class="pie">Sin aportes de reuso.</p>'; return; }
  $("tabla-mezcla").innerHTML = `<table>
    <thead><tr><th>Vecino</th><th>Corriente</th><th>Tren</th><th class="num">km</th>
      <th class="num">m³/d</th><th class="num">% uso</th><th class="num">USD/m³</th></tr></thead>
    <tbody>${o.aportes.map((a) => `<tr>
      <td><b>${escapar(a.empresa)}</b></td>
      <td class="sub">${escapar(a.corriente)}</td>
      <td>${escapar(a.tren_nombre)}</td>
      <td class="num">${a.distancia_km}</td>
      <td class="num"><b>${fmt.num(a.caudal_m3_dia)}</b></td>
      <td class="num">${fmt.pct(a.caudal_m3_h / a.caudal_max_m3_h, 0)}</td>
      <td class="num" style="color:${a.costo_usd_m3 < 0 ? "var(--ok)" : "inherit"}">${a.costo_usd_m3.toFixed(3)}</td></tr>`).join("")}
    <tr><td colspan="4"><b>Agua cruda residual</b></td>
      <td class="num"><b>${fmt.num(o.agua_cruda_m3_dia)}</b></td><td class="num">—</td>
      <td class="num">${ajustes.costo_agua_cruda_usd_m3.toFixed(3)}</td></tr></tbody></table>
    <p class="pie">USD/m³ incluye compra, tratamiento, conduccion, bombeo y CAPEX anualizado. Negativo = el vecino
      paga por entregar su rechazo porque se ahorra su propio vertimiento.</p>`;

  const c = o.calidad_circulante, lim = estado.escenario.limites;
  limites($("limites-calidad"), [
    { nombre: "Conductividad", valor: c.conductividad, limite: lim.conductividad_us_cm, unidad: "µS/cm" },
    { nombre: "Cloruros", valor: c.cloruros, limite: lim.cloruros_mg_l, unidad: "mg/L" },
    { nombre: "Dureza calcica", valor: c.dureza_ca, limite: lim.dureza_ca_mg_l, unidad: "mg/L" },
    { nombre: "Alcalinidad", valor: c.alcalinidad, limite: lim.alcalinidad_mg_l, unidad: "mg/L" },
    { nombre: "Silice", valor: c.silice, limite: lim.silice_mg_l, unidad: "mg/L" },
    { nombre: "DQO", valor: c.dqo, limite: lim.dqo_mg_l, unidad: "mg/L" },
    { nombre: "LSI (incrustacion)", valor: c.lsi, limite: estado.escenario.lsi_max_efectivo, decimales: 2, unidad: "" },
    { nombre: "Larson-Skold (corrosion)", valor: c.larson_skold, limite: lim.larson_skold_max, decimales: 2, unidad: "" },
  ]);
  $("resumen-quimica").innerHTML = `pH circulante <b>${c.ph}</b> · TDS <b>${fmt.num(c.tds)} mg/L</b> · acido <b>${o.acido_kg_h} kg/h</b> de H₂SO₄`;
}

async function pintarFrontera() {
  const cont = $("gr-frontera");
  cont.innerHTML = '<p class="cargando">Calculando la curva completa…</p>';
  try {
    const p = (await pedir("/api/frontera", ajustes)).filter((x) => x.factible);
    if (!p.length) { cont.innerHTML = '<p class="pie">Sin puntos factibles.</p>'; return; }
    lineas(cont, [
      { nombre: "Costo total", color: "#f2762e", datos: p.map((x) => ({ x: x.ahorro_pct * 100, y: x.costo_usd_anio / 1000 })), area: true },
      { nombre: "CAPEX", color: "#4a9de0", datos: p.map((x) => ({ x: x.ahorro_pct * 100, y: x.capex_usd / 1000 })), discontinua: true },
    ], { alto: 250, etiquetaY: "k USD", min_izq: 0,
      ticksX: p.filter((_, i) => i % 2 === 0).map((x) => ({ x: x.ahorro_pct * 100, txt: fmt.pct(x.ahorro_pct, 0) })) });
    const meta = ajustes.meta_reduccion;
    const enMeta = p.reduce((a, b) => Math.abs(b.ahorro_pct - meta) < Math.abs(a.ahorro_pct - meta) ? b : a);
    $("tabla-frontera").innerHTML = `<table>
      <thead><tr><th>Nivel de reuso</th><th class="num">Ahorro</th><th class="num">m³/d</th><th class="num">Costo/año</th>
      <th class="num">CAPEX</th><th class="num">Beneficio neto</th><th class="num">Payback</th><th class="num">Ciclos</th></tr></thead>
      <tbody>${p.map((x) => `<tr style="${Math.abs(x.ahorro_pct - meta) < 0.001 ? "background:rgba(242,118,46,.08)" : ""}">
        <td>${fmt.pct(x.meta, 0)}</td><td class="num">${fmt.pct(x.ahorro_pct)}</td>
        <td class="num">${fmt.num(x.ahorro_m3_dia)}</td><td class="num">${fmt.usd(x.costo_usd_anio)}</td>
        <td class="num">${fmt.usdk(x.capex_usd)}</td>
        <td class="num" style="color:${x.ahorro_neto_usd_anio > 0 ? "var(--ok)" : "var(--alerta)"}">${fmt.usdk(x.ahorro_neto_usd_anio)}</td>
        <td class="num">${x.payback_anios ? x.payback_anios.toFixed(2) + " a" : "—"}</td>
        <td class="num">${x.ciclos.toFixed(1)}</td></tr>`).join("")}</tbody></table>
      <p class="pie">La curva baja: cada m³ reutilizado cuesta menos que captarlo. El ${fmt.pct(meta, 0)} del reto
        (${fmt.num(enMeta.ahorro_m3_dia)} m³/d, payback ${enMeta.payback_anios ? enMeta.payback_anios.toFixed(2) : "—"} años)
        es el punto de partida; el optimo economico llega al ${fmt.pct(p.at(-1).ahorro_pct)}.</p>`;
  } catch (e) { error(cont, e); }
}

async function pintarContingencias() {
  const cont = $("tabla-contingencias");
  cont.innerHTML = '<p class="cargando">Simulando la caida de cada vecino…</p>';
  try {
    const c = await pedir("/api/contingencias", ajustes);
    const ref = c[0].costo_usd_anio;
    const critico = c.slice(1).reduce((a, b) => (b.costo_usd_anio > a.costo_usd_anio ? b : a), c[1] || c[0]);
    cont.innerHTML = `<table><thead><tr><th>Escenario</th><th class="num">Ahorro</th><th class="num">Sobrecosto</th><th>Meta</th></tr></thead>
      <tbody>${c.map((x, i) => `<tr>
        <td>${escapar(x.escenario)}</td>
        <td class="num">${x.factible ? fmt.pct(x.ahorro_pct) : "—"}</td>
        <td class="num" style="color:${!i ? "var(--texto-tenue)" : x.costo_usd_anio - ref > 1 ? "var(--aviso)" : "var(--ok)"}">
          ${!i ? "referencia" : x.factible ? "+" + fmt.usdk(x.costo_usd_anio - ref) : "—"}</td>
        <td>${chip(x.cumple_meta ? "cumple" : "no cumple", x.cumple_meta ? "ok" : "alerta")}</td></tr>`).join("")}</tbody></table>
      <p class="pie">El contrato mas valioso es <b>${escapar(critico.escenario.replace("Sin ", ""))}</b>: perderlo cuesta
        ${fmt.usdk(critico.costo_usd_anio - ref)} al año. ${c.slice(1).every((x) => x.cumple_meta)
          ? "La meta se mantiene en todos los escenarios: ningun vecino es imprescindible." : "En algun escenario la meta no se cumple."}</p>`;
  } catch (e) { error(cont, e); }
}

async function pintarSensibilidad() {
  const cont = $("gr-sensibilidad");
  cont.innerHTML = '<p class="cargando">Calculando…</p>';
  try {
    const s = await pedir("/api/sensibilidad?parametro=costo_agua_cruda_usd_m3", ajustes);
    barras(cont, s.map((x) => ({
      etiqueta: `Agua cruda a ${x.valor.toFixed(2)} USD/m³`, valor: x.ahorro_neto_usd_anio,
      color: "#2ec27e", nota: fmt.usdk(x.ahorro_neto_usd_anio) + "/año",
    })), { anchoEtiqueta: 200, ancho: 620 });
  } catch (e) { error(cont, e); }
}

function montarControles() {
  const c = $("controles");
  const sliders = [
    { id: "costo_agua_cruda_usd_m3", etiqueta: "Costo del agua cruda", min: 0.3, max: 3.5, paso: 0.05, unidad: " USD/m³" },
    { id: "costo_vertimiento_usd_m3", etiqueta: "Costo de vertimiento", min: 0, max: 2.5, paso: 0.05, unidad: " USD/m³" },
    { id: "meta_reduccion", etiqueta: "Meta de reduccion", min: 0.05, max: 0.5, paso: 0.01, pct: true },
    { id: "max_fraccion_reuso", etiqueta: "Tope operativo de reuso", min: 0.2, max: 1, paso: 0.05, pct: true },
  ];
  c.innerHTML = sliders.map((s) => `<div class="control">
      <label>${s.etiqueta}<span class="lectura" id="lec-${s.id}"></span></label>
      <input type="range" id="in-${s.id}" min="${s.min}" max="${s.max}" step="${s.paso}" value="${ajustes[s.id]}">
    </div>`).join("")
    + `<div class="control" style="grid-column:1/-1">
        <label>Vecinos disponibles <span class="lectura">desmarcar = contrato caido</span></label>
        <div class="casillas" id="casillas-oferentes"></div>
      </div>`;
  for (const s of sliders) {
    const inp = $("in-" + s.id), lec = $("lec-" + s.id);
    const pintar = () => { const v = parseFloat(inp.value); lec.textContent = s.pct ? fmt.pct(v, 0) : v.toFixed(2) + (s.unidad || ""); };
    inp.addEventListener("input", () => { ajustes[s.id] = parseFloat(inp.value); pintar(); });
    pintar();
  }
  $("casillas-oferentes").innerHTML = estado.oferentes.map((o) => `
    <label class="activo"><input type="checkbox" checked value="${o.codigo}"> ${o.codigo} · ${escapar(o.empresa)}</label>`).join("");
  $("casillas-oferentes").addEventListener("change", (ev) => {
    ev.target.closest("label").classList.toggle("activo", ev.target.checked);
    ajustes.oferentes_excluidos = [...$("casillas-oferentes").querySelectorAll("input:not(:checked)")].map((i) => i.value);
  });
  $("btn-recalcular").addEventListener("click", recalcular);
}

async function recalcular() {
  const btn = $("btn-recalcular");
  btn.disabled = true; btn.textContent = "Optimizando…";
  try {
    const d = await pedir("/api/optimizar", ajustes);
    pintarKpis(d); pintarBalance(d); pintarMezcla(d);
    await Promise.all([pintarFrontera(), pintarContingencias(), pintarSensibilidad()]);
  } catch (e) { error($("kpis"), e); }
  finally { btn.disabled = false; btn.textContent = "Recalcular"; }
}

// ---------------------------------------------------------------------------
// Con prospectos reales
// ---------------------------------------------------------------------------

function pintarQuienes() {
  const b = estado.barrido;
  if (!b) { $("opt-reales-quienes").textContent = "Cargando el barrido…"; return; }
  const umbral = parseFloat($("umbral").value);
  const entran = b.prospectos.filter((p) => p.confianza >= umbral);
  $("opt-reales-quienes").innerHTML = entran.length
    ? `Entran <b>${entran.length}</b> prospectos con confianza ≥ ${umbral.toFixed(2)}: ${entran.map((p) => escapar(p.nombre)).join(", ")}.`
    : `Ningun prospecto alcanza una confianza de ${umbral.toFixed(2)}. Baja el umbral para explorar, o consigue analitica real.`;
}

async function optimizarReales() {
  const caja = $("resultado-opt"), boton = $("btn-optimizar");
  boton.disabled = true;
  caja.innerHTML = '<p class="cargando">Resolviendo mezcla, tratamiento, acido y ciclos…</p>';
  try {
    const d = await pedir("/api/scout/optimizar", {
      radio_km: estado.radio, umbral_confianza: parseFloat($("umbral").value), max_fraccion_reuso: parseFloat($("reuso").value),
    });
    if (!d.factible) { caja.innerHTML = `<div class="aviso-caja"><b>Sin solucion.</b> ${escapar(d.motivo || "")}</div>`; return; }
    const o = d.optimo, b = d.linea_base, ahorroUsd = b.costo_total_usd_anio - o.costo_total_usd_anio;
    caja.innerHTML = `
      <div class="rejilla kpis" style="margin-bottom:14px">
        ${kpi("Reduccion de consumo", fmt.pct(o.ahorro_pct_planta), `meta 10 % · ${d.cumple_meta ? "cumplida" : "no alcanzada"}`, d.cumple_meta ? "destacado" : "")}
        ${kpi("Agua cruda evitada", `${fmt.num(o.ahorro_m3_dia)} m³/d`, `${fmt.num(o.reuso_total_m3_dia)} m³/d de reuso`)}
        ${kpi("Ahorro economico", `${fmt.usdk(ahorroUsd)}/año`, `inversion ${fmt.usdk(o.capex_total_usd)}`)}
        ${kpi("Ciclos", o.ciclos.toFixed(1), `linea base ${b.ciclos}`)}
      </div>
      <div class="tarjeta">
        <h3>Mezcla con el catalogo prospectado <span class="nota">${d.catalogo.length} empresas con confianza ≥ ${d.umbral_confianza}</span></h3>
        <table><thead><tr><th>Empresa</th><th>Tren</th><th class="num">m³/d</th><th class="num">USD/m³</th></tr></thead>
        <tbody>${(o.aportes || []).map((a) => `<tr>
          <td><b>${escapar(a.empresa || a.oferente)}</b></td><td>${escapar(a.tren_nombre || a.tren)}</td>
          <td class="num">${fmt.num(a.caudal_m3_dia)}</td><td class="num">${(a.costo_usd_m3 ?? 0).toFixed(3)}</td></tr>`).join("")}
        <tr><td colspan="2"><b>Agua cruda residual</b></td><td class="num"><b>${fmt.num(o.agua_cruda_m3_dia)}</b></td><td class="num">—</td></tr>
        </tbody></table>
      </div>`;
  } catch (e) { error(caja, e); }
  finally { boton.disabled = false; }
}

// ---------------------------------------------------------------------------

export default {
  id: "optimizador",
  async montar() {
    ajustes.costo_agua_cruda_usd_m3 = estado.escenario.planta.costo_agua_cruda_usd_m3;
    ajustes.costo_vertimiento_usd_m3 = estado.escenario.planta.costo_vertimiento_usd_m3;
    ajustes.meta_reduccion = estado.escenario.planta.meta_reduccion;
    montarControles();

    $("opt-pestanas").querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
      $("opt-pestanas").querySelectorAll("button").forEach((x) => x.classList.toggle("activa", x === b));
      document.querySelectorAll("#mod-optimizador .pestana").forEach((p) =>
        p.classList.toggle("activa", p.id === `opt-${b.dataset.pestana}`));
      if (b.dataset.pestana === "reales" && !estado.barrido) { await cargarBarrido(); }
      pintarQuienes();
    }));
    $("umbral").value = estado.config.umbral_promocion;
    $("lec-umbral").textContent = estado.config.umbral_promocion.toFixed(2);
    $("umbral").addEventListener("input", (e) => { $("lec-umbral").textContent = parseFloat(e.target.value).toFixed(2); pintarQuienes(); });
    $("reuso").addEventListener("input", (e) => { $("lec-reuso").textContent = fmt.pct(parseFloat(e.target.value), 0); });
    $("btn-optimizar").addEventListener("click", optimizarReales);

    await recalcular();
  },
};
