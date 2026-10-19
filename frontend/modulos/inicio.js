/* Modulo 0: la respuesta al reto en una pantalla.
 *
 * Primero la pregunta que importa (¿llega Cabot al 10 %?), despues de donde
 * sale el agua y al final que hacer a continuacion. El detalle tecnico vive
 * en Vecinos, el Gemelo y Criterios tecnicos.
 */

import { $, bus, cargarBarrido, chip, escapar, estado, fmt, pedir } from "../comun.js";

const pct = (v, d = 1) => fmt.num(v * 100, d) + " %";

function pintarAcciones() {
  const b = estado.barrido;
  const ia = Boolean(estado.config?.extraccion_ia?.disponible);
  const radio = estado.radio ? ` a menos de ${fmt.num(estado.radio)} km` : "";
  const vecinos = b
    ? `${b.resumen.detectados} empresas${radio}; ${b.resumen.viables} con agua que la torre puede aprovechar.`
    : "Las empresas alrededor de la planta, con su agua de rechazo y sus expedientes.";
  const acciones = [
    { href: "#prospeccion", n: "01", t: "Ver los vecinos", d: vecinos, ir: "Abrir Vecinos" },
    { href: "#simulador", n: "02", t: "Probarlo en el gemelo",
      d: "Mueve caudales, ciclos y ácido; la torre responde en 3D como en planta.", ir: "Abrir el gemelo" },
    { href: "#asistente", n: "03", t: "Preguntarle a la IA",
      d: ia ? "Escríbele o díctale: «¿qué vecino conviene visitar primero?»"
        : "Responde con los datos del panel. Falta configurar la clave en el servidor.",
      ir: "Abrir el asistente" },
  ];
  $("inicio-acciones").innerHTML = acciones.map((a) => `
    <a class="ini-accion" href="${a.href}">
      <span class="ini-accion-n">${a.n}</span>
      <b>${a.t}</b>
      <span class="ini-accion-d">${escapar(a.d)}</span>
      <span class="ini-accion-ir">${a.ir} →</span>
    </a>`).join("");
}

function pintarMezcla(o, b) {
  const filas = (o.aportes || []).map((a) => ({
    nombre: a.empresa, detalle: `${a.tren_nombre || a.tren} · a ${fmt.num(a.distancia_km, 1)} km`,
    m3: a.caudal_m3_dia, tono: "vecino",
  }));
  filas.push({ nombre: "Agua cruda", detalle: `la que se sigue captando (hoy son ${fmt.num(b.agua_cruda_m3_dia)} m³/día)`,
    m3: o.agua_cruda_m3_dia, tono: "cruda" });
  const total = filas.reduce((s, f) => s + f.m3, 0) || 1;
  $("inicio-mezcla").innerHTML = `
    <div class="ini-pila" role="img" aria-label="Reparto del agua de reposición">
      ${filas.map((f) => `<i class="${f.tono}" style="flex:${f.m3}" title="${escapar(f.nombre)}"></i>`).join("")}
    </div>
    <ul class="ini-filas">
      ${filas.map((f) => `<li>
        <span class="ini-punto ${f.tono}"></span>
        <span class="ini-fila-nombre"><b>${escapar(f.nombre)}</b><small>${escapar(f.detalle)}</small></span>
        <span class="ini-fila-m3"><b>${fmt.num(f.m3)}</b> m³/día<small>${pct(f.m3 / total, 0)}</small></span>
      </li>`).join("")}
    </ul>
    <p class="pie">El agua de cada vecino pasa por el tratamiento indicado antes de entrar a la torre.
      Detalle y evidencia de cada empresa en <a href="#prospeccion">Vecinos</a>.</p>`;
}

/* El resultado sale del optimizador corriendo sobre el catalogo prospectado,
   no sobre el catalogo supuesto del caso base. */
async function pintarResultado() {
  let r;
  try {
    r = await pedir("/api/scout/optimizar", {});
  } catch (e) {
    $("inicio-resultado").innerHTML = `<p class="cargando">No se pudo calcular: ${escapar(e.message)}</p>`;
    return;
  }
  if (!r.factible) {
    $("inicio-titular").textContent = "Con los datos actuales no hay una mezcla que funcione";
    $("inicio-bajada").textContent = r.motivo || "";
    $("inicio-resultado").innerHTML = chip("sin solución", "alerta");
    $("inicio-mezcla").innerHTML = "";
    return;
  }
  const o = r.optimo, b = r.linea_base, meta = r.meta_reduccion;
  const ahorroUsd = b.costo_total_usd_anio - o.costo_total_usd_anio;
  const payback = ahorroUsd > 0 ? o.capex_total_usd / ahorroUsd : null;
  const empresas = [...new Set((o.aportes || []).map((a) => a.empresa))];
  const escala = Math.max(0.5, Math.ceil(o.ahorro_pct_planta * 1.15 * 10) / 10);

  $("inicio-titular").textContent = r.cumple_meta
    ? `Sí: Cabot puede gastar un ${pct(o.ahorro_pct_planta)} menos de agua`
    : `Todavía no: con estos vecinos se llega al ${pct(o.ahorro_pct_planta)}`;
  $("inicio-bajada").innerHTML = `La meta del reto es ${pct(meta, 0)}. Reutilizando el agua de rechazo de
    ${empresas.length} vecino${empresas.length === 1 ? "" : "s"} y subiendo los ciclos de la torre de
    ${fmt.num(b.ciclos, 1)} a ${fmt.num(o.ciclos, 1)}, la planta deja de captar
    ${fmt.num(o.ahorro_m3_dia)} m³ de agua cruda al día.`;

  $("inicio-resultado").innerHTML = `
    <div class="ini-cifra">
      <span class="ini-cifra-n">−${pct(o.ahorro_pct_planta)}</span>
      <span class="ini-cifra-t">del consumo de agua de la planta</span>
      ${chip(r.cumple_meta ? "meta cumplida" : "meta no alcanzada", r.cumple_meta ? "ok" : "alerta")}
    </div>
    <div class="ini-barra" role="img" aria-label="Reducción ${pct(o.ahorro_pct_planta)} frente a una meta de ${pct(meta, 0)}">
      <i style="width:${Math.min(100, o.ahorro_pct_planta / escala * 100)}%"></i>
      <span class="ini-meta" style="left:${meta / escala * 100}%"><em>meta ${pct(meta, 0)}</em></span>
    </div>
    <div class="ini-escala"><span>0 %</span><span>${pct(escala, 0)}</span></div>
    <dl class="ini-datos">
      <div><dt>Agua cruda captada</dt><dd>${fmt.num(b.agua_cruda_m3_dia)} → <b>${fmt.num(o.agua_cruda_m3_dia)}</b> m³/día</dd></div>
      <div><dt>Agua de vecinos</dt><dd><b>${fmt.num(o.reuso_total_m3_dia)}</b> m³/día</dd></div>
      <div><dt>Ciclos de la torre</dt><dd>${fmt.num(b.ciclos, 1)} → <b>${fmt.num(o.ciclos, 1)}</b></dd></div>
      <div><dt>Ahorro al año (USD)</dt><dd><b>${fmt.usdk(ahorroUsd)}</b></dd>
        <small>inversión ${fmt.usdk(o.capex_total_usd)}${payback ? ` · se paga en ${fmt.num(payback, 1)} años` : ""}</small></div>
    </dl>`;
  pintarMezcla(o, b);
}

export default {
  id: "inicio",
  async montar() {
    pintarAcciones();
    bus.on("barrido", pintarAcciones);
    if (!estado.barrido) cargarBarrido().catch(() => {});
    await pintarResultado();
  },
};
