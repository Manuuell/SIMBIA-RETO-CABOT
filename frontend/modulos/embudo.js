/* Modulo 3: embudo comercial y vigilancia. */

import {
  $, anotar, bus, cargarBarrido, chip, escapar, estado, fechaCorta, fmt, kpi, pedir,
  recargarPipeline,
} from "../comun.js";
import { abrirPanel } from "./prospectos.js";

const TIPOS = { alta: "nuevas", baja: "desaparecidas", caudal: "caudal", salinidad: "salinidad", confianza: "confianza", puntaje: "puntaje" };
let verTodos = false;

function pintarKpis() {
  const pipe = estado.pipeline, b = estado.barrido;
  const avanzados = b.prospectos.filter((p) => ["contactado", "nda", "caracterizado", "piloto", "contratado"].includes((p.ficha && p.ficha.estado) || p.estado)).length;
  $("embudo-kpis").innerHTML = [
    kpi("Caudal asegurado", `${fmt.num(pipe.caudal_asegurado_m3_h)} m³/h`, "con analitica real detras: caracterizado, piloto o contratado", "destacado"),
    kpi("Fichas abiertas", pipe.fichas_abiertas, "empresas con trabajo comercial registrado"),
    kpi("Con contacto o mas", avanzados, "contactado, NDA, caracterizado, piloto o contratado"),
    kpi("Caudal total en el embudo", `${fmt.num(b.resumen.caudal_total_m3_h)} m³/h`, `${b.resumen.detectados} empresas`),
  ].join("");
}

function pintarEmbudo() {
  const p = estado.pipeline;
  const max = Math.max(...p.etapas.map((e) => e.caudal_m3_h), 1);
  $("embudo").innerHTML = p.etapas.map((e) => `
    <div class="etapa${e.empresas ? "" : " vacia"}">
      <span class="nom">${e.etapa}</span>
      <span class="via"><i style="width:${(e.caudal_m3_h / max * 100).toFixed(1)}%"></i></span>
      <span class="cifra">${fmt.num(e.caudal_m3_h)} m³/h · ${e.empresas}</span>
    </div>`).join("");
  $("embudo-requisitos").innerHTML = p.etapas.filter((e) => e.etapa !== "descartado").map((e) =>
    `<div class="item"><span class="e">${e.etapa}</span><span class="r">${escapar(e.requisito)}</span></div>`).join("");
}

function pintarVigilancia() {
  const v = estado.vigilancia;
  const caja = $("vigilancia");
  $("vigilancia-ref").textContent = v.hay_referencia
    ? `${v.instantaneas_archivadas} archivada(s) · ultima ${fechaCorta(v.referencia)}` : "";
  if (!v.hay_referencia) { caja.innerHTML = `<div class="aviso-caja">${escapar(v.resumen)}</div>`; return; }
  if (!v.cambios.length) { caja.innerHTML = `<div class="ok-caja">${escapar(v.resumen)}</div>`; return; }

  const porTipo = {};
  for (const c of v.cambios) porTipo[c.tipo] = (porTipo[c.tipo] || 0) + 1;
  const lista = verTodos ? v.cambios : v.cambios.slice(0, 8);
  caja.innerHTML = `
    <div class="resumen-cambios">${Object.entries(porTipo).map(([t, n]) =>
      chip(`${n} ${TIPOS[t] || t}`, t === "alta" ? "ok" : t === "baja" ? "alerta" : "aviso")).join("")}</div>
    ${lista.map((c) => `
      <div class="cambio">
        <span class="sev ${c.severidad}">${c.severidad}</span>
        <div><b>${escapar(c.empresa)}</b><p>${escapar(c.descripcion)}</p></div>
        <span class="delta">${escapar(c.antes || "—")} → ${escapar(c.ahora || "—")}</span>
      </div>`).join("")}
    ${v.cambios.length > 8 ? `<div class="acciones"><button class="secundario pequeno" id="btn-ver-todos">
      ${verTodos ? "Mostrar menos" : `Mostrar los ${v.cambios.length}`}</button></div>` : ""}
    <details class="ayuda">
      <summary>Por que hay tantos cambios</summary>
      <div class="cuerpo"><p>Se compara el barrido actual contra la ultima instantanea archivada. Si esa
        instantanea se tomo con otras fuentes o con los registros de ejemplo encendidos, casi todo aparece
        como nuevo o desaparecido. Archiva una instantanea de hoy para que la proxima comparacion sea
        limpia.</p></div>
    </details>`;
  $("btn-ver-todos")?.addEventListener("click", () => { verTodos = !verTodos; pintarVigilancia(); });
}

function pintarFichas() {
  const con = estado.barrido.prospectos.filter((p) => p.ficha);
  $("fichas-tabla").innerHTML = con.length ? `<table>
    <thead><tr><th>Empresa</th><th>Etapa</th><th>Responsable</th><th>Contacto</th><th>Siguiente paso</th><th>Actualizada</th></tr></thead>
    <tbody>${con.map((p) => `<tr class="clicable" data-clave="${p.clave}">
      <td><b>${escapar(p.nombre)}</b><span class="sub">${fmt.num(p.caudal_m3_h, 1)} m³/h</span></td>
      <td style="text-transform:capitalize">${escapar(p.ficha.estado)}</td>
      <td>${escapar(p.ficha.responsable || "—")}</td>
      <td>${escapar(p.ficha.contacto || "—")}</td>
      <td class="sub" style="max-width:340px">${escapar(p.ficha.proximo_paso)}</td>
      <td>${fechaCorta(p.ficha.actualizado)}</td></tr>`).join("")}</tbody></table>`
    : `<p class="pie">Todavia no hay fichas. Abre un prospecto y guarda su etapa, responsable o contacto.</p>`;
  $("fichas-tabla").querySelectorAll("tr.clicable").forEach((tr) =>
    tr.addEventListener("click", () => abrirPanel(tr.dataset.clave)));
}

function pintarTodo() {
  if (!estado.barrido || !estado.pipeline) return;
  pintarKpis(); pintarEmbudo(); pintarVigilancia(); pintarFichas();
}

export default {
  id: "embudo",
  async montar() {
    $("btn-instantanea").addEventListener("click", async (e) => {
      e.target.disabled = true;
      try {
        const d = await pedir(`/api/scout/instantanea?radio_km=${estado.radio}`, {});
        anotar(`Instantanea archivada (${d.archivada}); ${d.total_instantaneas} en total`, "ok");
        await recargarPipeline();
      } catch (err) { alert(err.message); }
      finally { e.target.disabled = false; }
    });
    bus.on("barrido", pintarTodo);
    bus.on("pipeline", pintarTodo);
    if (estado.barrido) pintarTodo(); else await cargarBarrido();
  },
};
