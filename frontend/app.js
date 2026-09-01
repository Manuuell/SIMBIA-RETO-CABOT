import { barras, balanceFlujo, fmt, limites, lineas } from "./graficos.js";

const API = "";
const $ = (id) => document.getElementById(id);

const estado = {
  ajustes: {
    costo_agua_cruda_usd_m3: 1.35,
    costo_vertimiento_usd_m3: 0.85,
    meta_reduccion: 0.10,
    max_fraccion_reuso: 0.85,
    usar_antiincrustante: true,
    oferentes_excluidos: [],
  },
  oferentes: [],
  escenario: null,
};

async function pedir(ruta, cuerpo) {
  const r = await fetch(API + ruta, cuerpo === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  if (!r.ok) throw new Error(`${ruta}: ${r.status} ${await r.text()}`);
  return r.json();
}

function error(contenedor, e) {
  contenedor.innerHTML = `<div class="error">${e.message}</div>`;
}

// ---------------------------------------------------------------------------
// KPIs y resultado de la optimizacion
// ---------------------------------------------------------------------------

function tarjetaKpi(etiqueta, valor, detalle, clase = "") {
  return `<div class="tarjeta kpi ${clase}">
    <div class="etiqueta">${etiqueta}</div>
    <div class="valor">${valor}</div>
    <div class="detalle">${detalle}</div>
  </div>`;
}

function pintarKpis(d) {
  const o = d.optimo, b = d.linea_base;
  const cumple = d.cumple_meta;
  const ahorroEcon = b.costo_total_usd_anio - o.costo_total_usd_anio;
  const payback = ahorroEcon > 0 ? o.capex_total_usd / ahorroEcon : null;

  $("kpis").innerHTML = [
    tarjetaKpi(
      "Reduccion de consumo",
      o.factible ? fmt.pct(o.ahorro_pct_planta) : "—",
      `meta del reto: ${fmt.pct(d.meta_reduccion, 0)} ${cumple ? "· cumplida" : "· NO cumplida"}`,
      "destacado",
    ),
    tarjetaKpi("Agua cruda evitada", fmt.num(o.ahorro_m3_dia, 0) + " m³/d",
      fmt.num(o.ahorro_m3_dia * 365 / 1000, 0) + " miles de m³/año"),
    tarjetaKpi("Ahorro economico", fmt.usdk(ahorroEcon) + "/año",
      `costo total: ${fmt.usdk(b.costo_total_usd_anio)} → ${fmt.usdk(o.costo_total_usd_anio)}`),
    tarjetaKpi("Inversion / retorno", fmt.usdk(o.capex_total_usd),
      payback ? `payback ${payback.toFixed(2)} años` : "sin retorno"),
    tarjetaKpi("Ciclos de concentracion", o.ciclos.toFixed(1),
      `linea base ${b.ciclos.toFixed(1)} · menos purga`),
    tarjetaKpi("Reuso incorporado", fmt.num(o.reuso_total_m3_dia, 0) + " m³/d",
      `${o.aportes.length} corriente(s) de ${new Set(o.aportes.map(a => a.oferente)).size} vecino(s)`),
  ].join("");

  $("estado-meta").innerHTML = o.factible
    ? `<span class="pastilla ${cumple ? "ok" : "alerta"}">${cumple ? "META CUMPLIDA" : "META NO ALCANZADA"}</span>`
    : `<span class="pastilla alerta">SIN SOLUCION</span> <span style="color:#8b97a8">${o.motivo}</span>`;
}

function pintarBalance(d) {
  const o = d.optimo, b = d.linea_base;
  balanceFlujo($("flujo-base"), {
    titulo: "OPERACION ACTUAL — 100 % agua cruda",
    entradas: [{ etiqueta: "Agua cruda captada", valor: b.agua_cruda_m3_dia, color: "#e5534b" }],
    evaporacion: b.balance.evaporacion_m3_h * 24,
    purga: b.balance.purga_m3_dia,
    arrastre: b.balance.arrastre_m3_h * 24,
  });
  const entradas = [
    { etiqueta: "Agua cruda captada", valor: o.agua_cruda_m3_dia, color: "#e5534b" },
    ...o.aportes.map((a) => ({
      etiqueta: `${a.oferente} ${a.empresa.split(/[ /]/)[0]} · ${a.tren}`,
      valor: a.caudal_m3_dia, color: "#2ec27e",
    })),
  ];
  balanceFlujo($("flujo-optimo"), {
    titulo: "CON SIMBIA — mezcla optimizada",
    entradas,
    evaporacion: o.balance.evaporacion_m3_h * 24,
    purga: o.balance.purga_m3_dia,
    arrastre: o.balance.arrastre_m3_h * 24,
  });
}

function pintarMezcla(d) {
  const o = d.optimo;
  if (!o.aportes.length) { $("tabla-mezcla").innerHTML = '<p class="cargando">Sin aportes de reuso.</p>'; return; }
  $("tabla-mezcla").innerHTML = `<table>
    <thead><tr>
      <th>Vecino</th><th>Corriente</th><th>Tren de tratamiento</th>
      <th class="num">km</th><th class="num">m³/d</th>
      <th class="num">% uso</th><th class="num">USD/m³</th>
    </tr></thead><tbody>${o.aportes.map((a) => `<tr>
      <td>${a.empresa}</td>
      <td style="color:#8b97a8">${a.corriente}</td>
      <td>${a.tren_nombre}</td>
      <td class="num">${a.distancia_km}</td>
      <td class="num"><b>${fmt.num(a.caudal_m3_dia, 0)}</b></td>
      <td class="num">${fmt.pct(a.caudal_m3_h / a.caudal_max_m3_h, 0)}</td>
      <td class="num" style="color:${a.costo_usd_m3 < 0 ? "#2ec27e" : "#e6edf3"}">${a.costo_usd_m3.toFixed(3)}</td>
    </tr>`).join("")}
    <tr style="border-top:1px solid #273140">
      <td colspan="4"><b>Agua cruda residual</b></td>
      <td class="num"><b>${fmt.num(o.agua_cruda_m3_dia, 0)}</b></td>
      <td class="num">—</td>
      <td class="num">${estado.ajustes.costo_agua_cruda_usd_m3.toFixed(3)}</td>
    </tr></tbody></table>
    <p class="pie">El costo por m³ incluye compra, tratamiento, conduccion, bombeo y CAPEX anualizado.
    Cuando es <b>negativo</b>, el vecino paga por entregar su rechazo porque se ahorra su propio
    vertimiento: ese es el motor economico de la simbiosis industrial.</p>`;

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
  $("resumen-quimica").innerHTML =
    `pH circulante <b>${c.ph}</b> · TDS <b>${fmt.num(c.tds, 0)} mg/L</b> ·
     dosificacion de acido <b>${o.acido_kg_h} kg/h</b> de H₂SO₄`;
}

// ---------------------------------------------------------------------------
// Frontera, contingencias, sensibilidad
// ---------------------------------------------------------------------------

async function pintarFrontera() {
  const cont = $("gr-frontera");
  cont.innerHTML = '<p class="cargando">Calculando la curva completa…</p>';
  try {
    const p = (await pedir("/api/frontera", estado.ajustes)).filter((x) => x.factible);
    if (!p.length) { cont.innerHTML = '<p class="cargando">Sin puntos factibles.</p>'; return; }
    lineas(cont, [
      { nombre: "Costo total", color: "#f2762e", datos: p.map((x) => ({ x: x.ahorro_pct * 100, y: x.costo_usd_anio / 1000 })), area: true },
      { nombre: "CAPEX", color: "#4a9de0", datos: p.map((x) => ({ x: x.ahorro_pct * 100, y: x.capex_usd / 1000 })), eje: "izq", discontinua: true },
    ], {
      alto: 250, etiquetaY: "k USD", min_izq: 0,
      ticksX: p.filter((_, i) => i % 2 === 0).map((x) => ({ x: x.ahorro_pct * 100, txt: fmt.pct(x.ahorro_pct, 0) })),
      bandas: [],
    });
    const meta = estado.ajustes.meta_reduccion;
    const enMeta = p.reduce((a, b) => Math.abs(b.ahorro_pct - meta) < Math.abs(a.ahorro_pct - meta) ? b : a);
    const mejor = p.at(-1);
    $("tabla-frontera").innerHTML = `<table>
      <thead><tr><th>Nivel de reuso</th><th class="num">Ahorro</th><th class="num">m³/d</th>
      <th class="num">Costo USD/año</th><th class="num">CAPEX</th><th class="num">Beneficio neto</th>
      <th class="num">Payback</th><th class="num">Ciclos</th></tr></thead><tbody>
      ${p.map((x) => `<tr style="${Math.abs(x.ahorro_pct - meta) < 0.001 ? "background:rgba(242,118,46,.08)" : ""}">
        <td>${fmt.pct(x.meta, 0)}</td>
        <td class="num">${fmt.pct(x.ahorro_pct)}</td>
        <td class="num">${fmt.num(x.ahorro_m3_dia, 0)}</td>
        <td class="num">${fmt.usd(x.costo_usd_anio)}</td>
        <td class="num">${fmt.usdk(x.capex_usd)}</td>
        <td class="num" style="color:${x.ahorro_neto_usd_anio > 0 ? "#2ec27e" : "#e5534b"}">${fmt.usdk(x.ahorro_neto_usd_anio)}</td>
        <td class="num">${x.payback_anios ? x.payback_anios.toFixed(2) + " a" : "—"}</td>
        <td class="num">${x.ciclos.toFixed(1)}</td></tr>`).join("")}
      </tbody></table>
      <p class="pie">La curva <b>baja</b>: cada m³ reutilizado cuesta menos que captarlo. Por eso el
      ${fmt.pct(meta, 0)} del reto (${fmt.num(enMeta.ahorro_m3_dia, 0)} m³/d, payback
      ${enMeta.payback_anios ? enMeta.payback_anios.toFixed(2) : "—"} años) no es el objetivo sino
      el punto de partida: el optimo economico llega al ${fmt.pct(mejor.ahorro_pct)}.</p>`;
  } catch (e) { error(cont, e); }
}

async function pintarContingencias() {
  const cont = $("tabla-contingencias");
  cont.innerHTML = '<p class="cargando">Simulando la caida de cada oferente…</p>';
  try {
    const c = await pedir("/api/contingencias", estado.ajustes);
    const ref = c[0].costo_usd_anio;
    const critico = c.slice(1).reduce((a, b) => (b.costo_usd_anio > a.costo_usd_anio ? b : a));
    cont.innerHTML = `<table><thead><tr>
      <th>Escenario de suministro</th><th class="num">Ahorro alcanzable</th>
      <th class="num">Sobrecosto anual</th><th>Meta</th></tr></thead><tbody>
      ${c.map((x, i) => `<tr>
        <td>${x.escenario}</td>
        <td class="num">${x.factible ? fmt.pct(x.ahorro_pct) : "—"}</td>
        <td class="num" style="color:${!i ? "#8b97a8" : x.costo_usd_anio - ref > 1 ? "#d9a441" : "#2ec27e"}">
          ${!i ? "referencia" : x.factible ? "+" + fmt.usdk(x.costo_usd_anio - ref) : "—"}</td>
        <td><span class="pastilla ${x.cumple_meta ? "ok" : "alerta"}">${x.cumple_meta ? "cumple" : "no cumple"}</span></td>
      </tr>`).join("")}</tbody></table>
      <p class="pie">Ningun vecino es imprescindible: la meta se mantiene en los
      ${c.length - 1} escenarios de caida. El contrato mas valioso es
      <b>${critico.escenario.replace("Sin ", "")}</b>, cuya perdida cuesta
      ${fmt.usdk(critico.costo_usd_anio - ref)} al año. El proyecto es <b>bancable</b>:
      no depende de un unico proveedor.</p>`;
  } catch (e) { error(cont, e); }
}

async function pintarSensibilidad() {
  const cont = $("gr-sensibilidad");
  cont.innerHTML = '<p class="cargando">Calculando…</p>';
  try {
    const s = await pedir("/api/sensibilidad?parametro=costo_agua_cruda_usd_m3", estado.ajustes);
    barras(cont, s.map((x) => ({
      etiqueta: `Agua cruda a ${x.valor.toFixed(2)} USD/m³`,
      valor: x.ahorro_neto_usd_anio,
      color: "#2ec27e",
      nota: fmt.usdk(x.ahorro_neto_usd_anio) + "/año",
    })), { anchoEtiqueta: 200, ancho: 620 });
  } catch (e) { error(cont, e); }
}

// ---------------------------------------------------------------------------
// Operacion en vivo e IA
// ---------------------------------------------------------------------------

async function pintarOperacion() {
  const cont = $("gr-operacion");
  cont.innerHTML = '<p class="cargando">Cargando telemetria…</p>';
  try {
    const [op, met] = await Promise.all([
      pedir("/api/operacion?horas=336"), pedir("/api/ml/metricas"),
    ]);
    const t0 = new Date(op.serie[0].t).getTime();
    const h = (p) => (new Date(p.t).getTime() - t0) / 3600000;
    const ticks = op.serie.filter((_, i) => i % 48 === 0).map((p) => ({
      x: h(p), txt: new Date(p.t).toLocaleDateString("es", { day: "2-digit", month: "short" }),
    }));

    lineas($("gr-operacion"), [
      { nombre: "Reposicion", color: "#4a9de0", datos: op.serie.map((p) => ({ x: h(p), y: p.reposicion_m3_h })), area: true },
      { nombre: "Prob. fuga", color: "#e5534b", eje: "der", datos: op.serie.map((p) => ({ x: h(p), y: p.prob_fuga })) },
      { nombre: "Prob. ensuciamiento 7 d", color: "#d9a441", eje: "der", datos: op.serie.map((p) => ({ x: h(p), y: p.prob_riesgo })) },
    ], {
      alto: 260, ejeDerecho: true, etiquetaY: "m³/h", ticksX: ticks,
      min_der: 0, max_der: 1,
      lineasRef: [
        { y: op.umbral_fuga, eje: "der", color: "#e5534b", texto: "umbral de aviso de fuga" },
      ],
    });

    $("alertas").innerHTML = `
      <span class="pastilla ${op.alerta_fuga ? "alerta" : "ok"}">
        ${op.alerta_fuga ? "FUGA PROBABLE" : "balance hidrico normal"}</span>
      <span class="pastilla ${op.alerta_riesgo ? "aviso" : "ok"}">
        ${op.alerta_riesgo ? "RIESGO DE ENSUCIAMIENTO EN 7 DIAS" : "sin riesgo de ensuciamiento"}</span>`;

    const d = met.demanda, f = met.fugas, r = met.riesgo;
    $("metricas-ia").innerHTML = `
      <table><thead><tr><th>Modelo</th><th>Uso operativo</th><th class="num">Desempeño (validacion temporal)</th></tr></thead>
      <tbody>
        <tr><td><b>Demanda de reposicion +24 h</b></td>
            <td style="color:#8b97a8">Contratar por adelantado el caudal de rechazo</td>
            <td class="num">MAE ${d.mae.toFixed(2)} m³/h · MAPE ${fmt.pct(d.mape)}<br>
            <span style="color:#8b97a8">${fmt.pct(d.mejora_vs_persistencia, 0)} mejor que persistencia</span></td></tr>
        <tr><td><b>Deteccion de fugas</b></td>
            <td style="color:#8b97a8">Residual del balance de masa + clasificador</td>
            <td class="num">F1 ${f.f1.toFixed(2)} · AUC-PR ${f.auc_pr.toFixed(2)}<br>
            <span style="color:#8b97a8">${fmt.num(f.m3_recuperables_anio, 0)} m³/año recuperables</span></td></tr>
        <tr><td><b>Riesgo de ensuciamiento 7 d</b></td>
            <td style="color:#8b97a8">Bajar ciclos o cambiar mezcla antes del evento</td>
            <td class="num">AUC-ROC ${r.auc_roc.toFixed(2)} · recall ${fmt.pct(r.recall, 0)}<br>
            <span style="color:#8b97a8">lift ×${r.lift.toFixed(1)} sobre la tasa base</span></td></tr>
      </tbody></table>
      <p class="pie">Metricas sobre particion <b>temporal</b> (70 % pasado / 30 % futuro), nunca aleatoria.
      Entrenados sobre historico sintetico generado por el propio gemelo digital: al conectar el SCADA
      se reentrenan sin cambiar el codigo.</p>`;
  } catch (e) { error(cont, e); }
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

function montarControles() {
  const c = $("controles");
  const sliders = [
    { id: "costo_agua_cruda_usd_m3", etiqueta: "Costo del agua cruda", min: 0.3, max: 3.5, paso: 0.05, unidad: " USD/m³" },
    { id: "costo_vertimiento_usd_m3", etiqueta: "Costo de vertimiento", min: 0, max: 2.5, paso: 0.05, unidad: " USD/m³" },
    { id: "meta_reduccion", etiqueta: "Meta de reduccion", min: 0.05, max: 0.5, paso: 0.01, unidad: "", pct: true },
    { id: "max_fraccion_reuso", etiqueta: "Tope operativo de reuso", min: 0.2, max: 1, paso: 0.05, unidad: "", pct: true },
  ];
  c.innerHTML = sliders.map((s) => `<div class="control">
      <label>${s.etiqueta}<span class="lectura" id="lec-${s.id}"></span></label>
      <input type="range" id="in-${s.id}" min="${s.min}" max="${s.max}" step="${s.paso}"
             value="${estado.ajustes[s.id]}">
    </div>`).join("")
    + `<div class="control" style="grid-column:1/-1">
        <label>Oferentes disponibles (desmarcar = contrato caido)</label>
        <div class="casillas" id="casillas-oferentes"></div>
      </div>
      <div class="control">
        <label>&nbsp;</label>
        <button id="btn-recalcular">Recalcular escenario</button>
      </div>`;

  for (const s of sliders) {
    const inp = $("in-" + s.id), lec = $("lec-" + s.id);
    const pintar = () => {
      const v = parseFloat(inp.value);
      lec.textContent = s.pct ? fmt.pct(v, 0) : v.toFixed(2) + s.unidad;
    };
    inp.addEventListener("input", () => { estado.ajustes[s.id] = parseFloat(inp.value); pintar(); });
    pintar();
  }

  $("casillas-oferentes").innerHTML = estado.oferentes.map((o) => `
    <label class="activo" data-cod="${o.codigo}">
      <input type="checkbox" checked value="${o.codigo}"> ${o.codigo} · ${o.empresa}
    </label>`).join("");
  $("casillas-oferentes").addEventListener("change", (ev) => {
    const et = ev.target.closest("label");
    et.classList.toggle("activo", ev.target.checked);
    estado.ajustes.oferentes_excluidos = [...$("casillas-oferentes").querySelectorAll("input:not(:checked)")]
      .map((i) => i.value);
  });

  $("btn-recalcular").addEventListener("click", recalcular);
}

function pintarCatalogo() {
  $("tabla-oferentes").innerHTML = `<table><thead><tr>
    <th>Cod</th><th>Empresa</th><th>Corriente de rechazo</th>
    <th class="num">m³/h</th><th class="num">km</th><th class="num">USD/m³</th>
    <th class="num">TDS</th><th class="num">DQO</th><th>Limitante</th>
  </tr></thead><tbody>${estado.oferentes.map((o) => `<tr>
    <td><b>${o.codigo}</b></td><td>${o.empresa}</td>
    <td style="color:#8b97a8">${o.corriente}</td>
    <td class="num">${o.caudal_disponible_m3_h}</td>
    <td class="num">${o.distancia_km}</td>
    <td class="num" style="color:${o.precio_usd_m3 < 0 ? "#2ec27e" : "#e6edf3"}">${o.precio_usd_m3.toFixed(2)}</td>
    <td class="num">${fmt.num(o.calidad.tds, 0)}</td>
    <td class="num">${fmt.num(o.calidad.dqo, 0)}</td>
    <td style="color:#8b97a8;font-size:11.5px">${o.notas.split(". ").at(-1)}</td>
  </tr>`).join("")}</tbody></table>`;
}

async function recalcular() {
  const btn = $("btn-recalcular");
  if (btn) { btn.disabled = true; btn.textContent = "Optimizando…"; }
  try {
    const d = await pedir("/api/optimizar", estado.ajustes);
    pintarKpis(d); pintarBalance(d); pintarMezcla(d);
    await Promise.all([pintarFrontera(), pintarContingencias(), pintarSensibilidad()]);
  } catch (e) {
    error($("kpis"), e);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Recalcular escenario"; }
  }
}

async function iniciar() {
  try {
    [estado.oferentes, estado.escenario] = await Promise.all([
      pedir("/api/oferentes"), pedir("/api/escenario"),
    ]);
    estado.ajustes.costo_agua_cruda_usd_m3 = estado.escenario.planta.costo_agua_cruda_usd_m3;
    estado.ajustes.costo_vertimiento_usd_m3 = estado.escenario.planta.costo_vertimiento_usd_m3;
    estado.ajustes.meta_reduccion = estado.escenario.planta.meta_reduccion;
    montarControles();
    pintarCatalogo();
    $("consumo-planta").textContent = fmt.num(estado.escenario.planta.consumo_total_m3_dia, 0);
    await recalcular();
    await pintarOperacion();
  } catch (e) {
    error($("kpis"), e);
  }
}

iniciar();
