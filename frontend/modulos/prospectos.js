/* Ficha de un prospecto en panel lateral: plan tecnico, caracterizacion,
 * procedencia y ficha comercial editable. La lista y el mapa viven en la
 * pagina Vecinos (prospeccion.js); este modulo solo abre y guarda la ficha.
 */

import {
  $, anotar, barraConfianza, bus, cargarBarrido, escapar, estado, fechaCorta,
  fmt, kpi, pedir, prospectoPorClave, sello,
} from "../comun.js";
import { colorPuntaje } from "../mapa.js";

const ETAPAS = ["detectado", "calificado", "contactado", "nda", "caracterizado", "piloto", "contratado", "descartado"];
export const TONOS = { desplazamiento: "#f2762e", ciclos: "#f5b323", distancia: "#2f7fc1", tratamiento: "#1e9e63", incentivo: "#67747e" };
export const NOMBRE_PESO = {
  desplazamiento: "agua cruda que desplaza", ciclos: "ciclos a los que deja operar",
  distancia: "distancia de conduccion", tratamiento: "costo del tratamiento", incentivo: "incentivo del vecino",
};

let seleccionada = null;

export function pilaPuntaje(p) {
  const d = p.detalle_puntaje || {};
  return `<div class="pila">${Object.entries(TONOS).map(([k, c]) =>
    `<i style="width:${d[k] || 0}%;background:${c}" title="${NOMBRE_PESO[k]}: ${(d[k] || 0).toFixed(1)}"></i>`).join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Panel lateral
// ---------------------------------------------------------------------------

export function abrirPanel(clave) {
  seleccionada = clave;
  pintarPanel(clave);
  $("panel-prospecto").classList.add("abierto");
  $("velo").classList.add("abierto");
}

function cerrarPanel() {
  $("panel-prospecto").classList.remove("abierto");
  $("velo").classList.remove("abierto");
}

function pintarPanel(clave) {
  const p = prospectoPorClave(clave);
  const panel = $("panel-prospecto");
  if (!p) { panel.innerHTML = `<p class="cargando">Prospecto no encontrado en el barrido actual.</p>`; return; }
  const c = p.calidad, ix = p.indices || {}, f = p.ficha || {};
  const plan = p.notas.split(" | ").filter((t) => t.startsWith("Plan:") || t.startsWith("No viable"))[0] || "";
  const trazado = p.notas.split(" | ")[0];
  const permiso = p.notas.split(" | ").find((t) => t.startsWith("Permiso"));
  const refs = (p.referencias || []).map((r) =>
    `<li><code>${escapar(r.fuente)}</code> · ${escapar(r.identificador)}
      ${r.descripcion ? `— ${escapar(r.descripcion)}` : ""}
      ${r.url ? ` · <a href="${escapar(r.url)}" target="_blank" rel="noopener">ver</a>` : ""}</li>`).join("");
  const medidos = p.campos_medidos || [];

  panel.innerHTML = `
    <button class="secundario pequeno cerrar" id="btn-cerrar-panel">Cerrar</button>
    <h2>${escapar(p.nombre)}</h2>
    <div class="acciones" style="margin:0 0 10px">
      <button class="secundario pequeno" id="btn-ver-dossier">Ver dossier completo</button>
      ${f.en_cartera
        ? `<span class="chip ok sin-punto">En cartera</span>`
        : `<button class="pequeno" id="btn-cartera">Seguir en cartera</button>`}
    </div>
    <p class="sub">${escapar(p.sector)} · ${escapar(p.corriente)}</p>
    <div class="rejilla kpis" style="grid-template-columns:repeat(3,1fr);gap:8px">
      ${kpi("Puntaje", `<span style="color:${colorPuntaje(p.puntaje)}">${p.puntaje == null ? "—" : p.puntaje.toFixed(1)}</span>`, pilaPuntaje(p))}
      ${kpi("Caudal", `${fmt.num(p.caudal_m3_h, 1)} m³/h`, sello(p.metodo_caudal))}
      ${kpi("Confianza", p.confianza.toFixed(2), barraConfianza(p))}
    </div>

    <h4>Plan tecnico que sustenta el puntaje</h4>
    <div class="plan">${escapar(plan || "Sin plan: no hay mezcla viable.")}</div>
    <p class="pie">${escapar(trazado)} · limitante: ${escapar(p.limitante)}</p>
    ${permiso ? `<div class="info-caja" style="margin-top:8px">${escapar(permiso)}</div>` : ""}

    <div class="seccion">
      <h4>Caracterizacion de la corriente ${sello(p.metodo_calidad)}
        ${medidos.length ? `<span style="text-transform:none;letter-spacing:0"> · con analitica real de ${medidos.join(", ")}</span>` : ""}</h4>
      <dl class="pares">
        <dt>TDS</dt><dd>${fmt.num(c.tds)} mg/L</dd>
        <dt>Cloruros · Sulfatos</dt><dd>${fmt.num(c.cloruros)} · ${fmt.num(c.sulfatos)} mg/L</dd>
        <dt>Dureza Ca · Alcalinidad</dt><dd>${fmt.num(c.dureza_ca)} · ${fmt.num(c.alcalinidad)} mg/L CaCO₃</dd>
        <dt>Silice</dt><dd>${fmt.num(c.silice)} mg/L</dd>
        <dt>DQO · SST</dt><dd>${fmt.num(c.dqo)} · ${fmt.num(c.sst)} mg/L</dd>
        <dt>N amoniacal · Fosfatos</dt><dd>${fmt.num(c.n_amoniacal, 1)} · ${fmt.num(c.fosfatos, 1)} mg/L</dd>
        <dt>pH · T</dt><dd>${c.ph?.toFixed(2)} · ${fmt.num(c.t_c, 1)} °C</dd>
        <dt>LSI · Larson-Skold</dt><dd>${(ix.lsi ?? 0).toFixed(2)} · ${(ix.larson_skold ?? 0).toFixed(2)}</dd>
      </dl>
    </div>

    <div class="seccion">
      <h4>Procedencia</h4>
      <ul class="refs">${refs}</ul>
    </div>
    ${(f.documentos || []).length ? `<div class="seccion">
      <h4>Documentos del expediente guardados</h4>
      <ul class="refs">${f.documentos.map((d) => `<li>📄 ${escapar(d.nombre)} <span class="sub" style="display:inline">· ${(d.bytes / 1e6).toFixed(2)} MB · radicado ${escapar(d.radicado)} · ${fechaCorta(d.guardado)}</span></li>`).join("")}</ul>
      <p class="pie">Se leen con IA y se revisan en el dossier de la empresa.</p>
    </div>` : ""}

    <div class="seccion">
      <h4>Ficha comercial</h4>
      <p class="pie" style="margin:0 0 10px"><b>Siguiente paso:</b> ${escapar(f.proximo_paso || f.requisito || "verificar que la corriente existe y estimar su caudal")}</p>
      <div class="ficha-form" data-clave="${p.clave}" data-nombre="${escapar(p.nombre)}">
        <div><label>Etapa</label><select id="ficha-etapa">
          ${ETAPAS.map((e) => `<option value="${e}"${e === (f.estado || p.estado) ? " selected" : ""}>${e}</option>`).join("")}
        </select></div>
        <div><label>Responsable</label><input type="text" id="ficha-resp" value="${escapar(f.responsable || "")}"></div>
        <div class="ancho"><label>Contacto en la empresa</label><input type="text" id="ficha-contacto" value="${escapar(f.contacto || "")}"></div>
        <div class="ancho"><label>Proximo paso (opcional, sustituye al sugerido)</label><input type="text" id="ficha-paso" value="${escapar(f.proximo_paso && f.proximo_paso !== f.requisito ? f.proximo_paso : "")}"></div>
        <div class="ancho"><label>Notas</label><textarea id="ficha-notas" rows="2">${escapar(f.notas || "")}</textarea></div>
      </div>
      <div class="acciones">
        <button id="btn-guardar-ficha">Guardar ficha</button>
        <span class="pie" style="margin:0" id="ficha-msg">${f.actualizado ? "actualizada " + fechaCorta(f.actualizado) : ""}</span>
      </div>
      ${(f.historial || []).length ? `<p class="pie">Historial: ${f.historial.slice(-4).map((h) =>
        h.nota ? `${h.fecha?.slice(0, 10)} <i>${escapar(h.nota)}</i>`
               : `${h.fecha?.slice(0, 10)} ${escapar(h.de)} → <b>${escapar(h.a)}</b>`).join(" · ")}</p>` : ""}
    </div>`;

  $("btn-cerrar-panel").addEventListener("click", cerrarPanel);
  $("btn-ver-dossier").addEventListener("click", () => { cerrarPanel(); bus.emit("vecinos:dossier", p.clave); });
  $("btn-guardar-ficha").addEventListener("click", guardarFicha);
  $("btn-cartera")?.addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    await pedir("/api/scout/ficha", { clave: p.clave, nombre: p.nombre, en_cartera: true });
    anotar(`<b>${escapar(p.nombre)}</b> entra en la cartera`, "ok");
    await cargarBarrido({ refrescar: true });
  });
}

async function guardarFicha() {
  const btn = $("btn-guardar-ficha"); btn.disabled = true;
  const form = document.querySelector("#panel-prospecto .ficha-form");
  try {
    await pedir("/api/scout/ficha", {
      clave: form.dataset.clave, nombre: form.dataset.nombre,
      estado: $("ficha-etapa").value, responsable: $("ficha-resp").value,
      contacto: $("ficha-contacto").value, proximo_paso: $("ficha-paso").value,
      notas: $("ficha-notas").value,
    });
    $("ficha-msg").textContent = "guardada";
    anotar(`Ficha de <b>${escapar(form.dataset.nombre)}</b> guardada: etapa ${$("ficha-etapa").value}`, "ok");
    await cargarBarrido({ refrescar: true });
  } catch (e) {
    $("ficha-msg").innerHTML = `<span style="color:var(--alerta)">${escapar(e.message)}</span>`;
  } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------------------

/** Cierre del panel y repintado cuando cambia el barrido. Una vez. */
export function montarPanel() {
  $("velo").addEventListener("click", cerrarPanel);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrarPanel(); });
  bus.on("barrido", () => {
    if (seleccionada && $("panel-prospecto").classList.contains("abierto")) pintarPanel(seleccionada);
  });
}
