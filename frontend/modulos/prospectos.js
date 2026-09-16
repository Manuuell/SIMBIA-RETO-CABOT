/* Modulo 2: prospectos. Mapa, tabla y panel lateral con el detalle. */

import {
  $, anotar, barraConfianza, bus, cargarBarrido, chip, escapar, estado, fechaCorta,
  fmt, kpi, pedir, prospectoPorClave, sello, tienePermiso,
} from "../comun.js";
import { colorPuntaje, dibujarMapa } from "../mapa.js";

const ETAPAS = ["detectado", "calificado", "contactado", "nda", "caracterizado", "piloto", "contratado", "descartado"];
const TONOS = { desplazamiento: "#f2762e", ciclos: "#f5b323", distancia: "#4a9de0", tratamiento: "#2ec27e", incentivo: "#8b97a8" };
const NOMBRE_PESO = {
  desplazamiento: "agua cruda que desplaza", ciclos: "ciclos a los que deja operar",
  distancia: "distancia de conduccion", tratamiento: "costo del tratamiento", incentivo: "incentivo del vecino",
};

let seleccionada = null;

// ---------------------------------------------------------------------------
// Vista principal
// ---------------------------------------------------------------------------

function pintarKpis(d) {
  const r = d.resumen;
  const conPermiso = d.prospectos.filter(tienePermiso).length;
  $("prospectos-kpis").innerHTML = [
    kpi("Empresas detectadas", r.detectados, `${r.descartados_sin_arquetipo} descartadas sin arquetipo`, "destacado"),
    kpi("Con simbiosis viable", r.viables, "mantienen los ciclos de la linea base con algun tren"),
    kpi("Caudal prospectado", `${fmt.num(r.caudal_total_m3_h)} m³/h`, `${fmt.num(r.caudal_viable_m3_h)} m³/h en las viables`),
    kpi("Con permiso de vertimiento", conPermiso, "expediente localizado en VITAL"),
    kpi("Entran al optimizador", r.promovibles, `confianza ≥ ${estado.config.umbral_promocion} · media ${r.confianza_media.toFixed(2)}`),
  ].join("");
  const f = d.fuentes.find((x) => x.fuente === "osm");
  $("prospectos-origen").innerHTML =
    `fuentes: modo ${d.modo}${f?.fecha_dato ? " · datos del " + fechaCorta(f.fecha_dato) : ""} · cambiar →`;
}

function pilaPuntaje(p) {
  const d = p.detalle_puntaje || {};
  return `<div class="pila">${Object.entries(TONOS).map(([k, c]) =>
    `<i style="width:${d[k] || 0}%;background:${c}" title="${NOMBRE_PESO[k]}: ${(d[k] || 0).toFixed(1)}"></i>`).join("")}</div>`;
}

function filtrados(d) {
  const soloViables = $("filtro-viables").checked, conPermiso = $("filtro-permiso").checked;
  return d.prospectos.filter((p) =>
    (!soloViables || (p.puntaje || 0) > 0) && (!conPermiso || tienePermiso(p)));
}

function pintarTabla(d) {
  const lista = filtrados(d);
  $("prospectos-filtro-txt").textContent = `${lista.length} de ${d.prospectos.length}`;
  $("tabla-prospectos").querySelector("tbody").innerHTML = lista.length ? lista.map((p) => `
    <tr class="clicable${seleccionada === p.clave ? " seleccionada" : ""}" data-clave="${p.clave}">
      <td><b>${escapar(p.nombre)}</b><span class="sub">${escapar(p.corriente)}</span></td>
      <td>${escapar(p.sector)}</td>
      <td class="num" title="linea recta ${p.distancia_linea_km} km">${p.distancia_conduccion_km.toFixed(1)}</td>
      <td class="num">${fmt.num(p.caudal_m3_h, 1)}</td>
      <td>${sello(p.metodo_calidad)}${tienePermiso(p) ? ` <span class="chip azul sin-punto" title="permiso de vertimiento en VITAL">exp.</span>` : ""}</td>
      <td>${barraConfianza(p)}</td>
      <td class="num" style="color:${colorPuntaje(p.puntaje)};font-weight:640">
        ${p.puntaje == null ? "—" : p.puntaje.toFixed(1)}${pilaPuntaje(p)}</td>
      <td><span class="sub" style="text-transform:capitalize">${escapar((p.ficha && p.ficha.estado) || p.estado)}</span></td>
    </tr>`).join("")
    : `<tr><td colspan="8" class="cargando" style="padding:12px 8px">Ningun prospecto cumple el filtro.</td></tr>`;
  $("tabla-prospectos").querySelectorAll("tr.clicable").forEach((tr) =>
    tr.addEventListener("click", () => abrirPanel(tr.dataset.clave)));
}

function pintarTrazado(d) {
  const filas = [...d.prospectos]
    .sort((a, b) => a.distancia_conduccion_km - b.distancia_conduccion_km).slice(0, 8)
    .map((p) => {
      const sobre = p.distancia_linea_km > 0 ? p.distancia_conduccion_km / p.distancia_linea_km : 1;
      return `<tr class="clicable" data-clave="${p.clave}">
        <td>${escapar(p.nombre.slice(0, 26))}</td>
        <td class="num">${p.distancia_linea_km.toFixed(2)}</td>
        <td class="num">${p.distancia_conduccion_km.toFixed(2)}</td>
        <td class="num" style="color:var(--aviso)">×${sobre.toFixed(2)}</td></tr>`;
    }).join("");
  $("tabla-trazado").innerHTML = `<thead><tr><th>Empresa</th><th class="num">Recta km</th>
    <th class="num">Trazado km</th><th class="num">Factor</th></tr></thead><tbody>${filas}</tbody>`;
  $("tabla-trazado").querySelectorAll("tr.clicable").forEach((tr) =>
    tr.addEventListener("click", () => abrirPanel(tr.dataset.clave)));
}

function pintarAyudaPuntaje() {
  const pesos = estado.config.pesos_puntaje;
  $("ayuda-puntaje").innerHTML = `<p>De 0 a 100. Suma cinco componentes y multiplica por la confianza del dato:</p>
    <p>${Object.entries(pesos).map(([k, v]) =>
      `<b style="color:${TONOS[k]}">${v} %</b> ${NOMBRE_PESO[k]}`).join(" · ")}</p>
    <p>Para cada prospecto se busca el mejor par (tren de tratamiento, fraccion de mezcla) evaluando la
      mezcla real con el modelo quimico completo. Un puntaje de 0 significa que ninguna mezcla mantiene
      los ciclos de la linea base. Un prospecto poco fiable no se descarta, se posterga.</p>`;
}

function pintarTodo(d) {
  pintarKpis(d);
  pintarTabla(d);
  pintarTrazado(d);
  dibujarMapa($("mapa"), { planta: d.planta, prospectos: d.prospectos, alSeleccionar: abrirPanel });
  if (seleccionada && $("panel-prospecto").classList.contains("abierto")) pintarPanel(seleccionada);
}

// ---------------------------------------------------------------------------
// Panel lateral
// ---------------------------------------------------------------------------

export function abrirPanel(clave) {
  seleccionada = clave;
  pintarPanel(clave);
  $("panel-prospecto").classList.add("abierto");
  $("velo").classList.add("abierto");
  document.querySelectorAll("#tabla-prospectos tr").forEach((tr) =>
    tr.classList.toggle("seleccionada", tr.dataset.clave === clave));
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
  $("btn-guardar-ficha").addEventListener("click", guardarFicha);
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

export default {
  id: "prospectos",
  async montar() {
    pintarAyudaPuntaje();
    $("velo").addEventListener("click", cerrarPanel);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrarPanel(); });
    ["filtro-viables", "filtro-permiso"].forEach((id) => {
      const inp = $(id);
      inp.checked = id === "filtro-viables";
      inp.addEventListener("change", () => {
        inp.closest("label").classList.toggle("activo", inp.checked);
        if (estado.barrido) pintarTabla(estado.barrido);
      });
    });
    bus.on("barrido", pintarTodo);
    if (estado.barrido) pintarTodo(estado.barrido);
    else await cargarBarrido();
  },
};
