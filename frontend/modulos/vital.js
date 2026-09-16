/* Modulo: buscador de tramites de VITAL.
 *
 * Busqueda libre con filtros por faceta y paginas, y dos acciones por
 * resultado que cierran el circulo: redactar la solicitud del expediente y
 * vincularlo a un prospecto para que su confianza suba. A la derecha, los
 * prospectos que todavia no tienen expediente, para buscarlos de un clic.
 */

import {
  $, anotar, bus, cargarBarrido, chip, copiar, escapar, estado, fechaCorta,
  nombreParaBuscar, pedir, textoSolicitud, tienePermiso,
} from "../comun.js";

const consulta = {
  q: "", autoridad: "", tramite: "", municipio: "", solo_vertimientos: true,
  pagina: 1, modo: "cache",
};
let resultado = null;
let abierto = null;       // id del registro con el detalle desplegado

// ---------------------------------------------------------------------------
// Busqueda
// ---------------------------------------------------------------------------

function leerFormulario() {
  consulta.q = $("vital-q").value.trim();
  consulta.autoridad = $("vital-aut").value;
  consulta.tramite = $("vital-tra").value;
  consulta.municipio = $("vital-mun").value;
  consulta.solo_vertimientos = $("vital-solo-vert").checked;
  consulta.modo = document.querySelector("#vital-modo input:checked").value;
}

async function buscar(pagina = 1) {
  leerFormulario();
  if (!consulta.q) { $("vital-resumen").innerHTML = `<span style="color:var(--aviso)">Escribe una empresa, un expediente o un radicado.</span>`; return; }
  consulta.pagina = pagina;
  const btn = $("vital-btn"); btn.disabled = true; btn.textContent = "Buscando…";
  $("vital-resultados").innerHTML = `<p class="cargando">Consultando el buscador de VITAL…</p>`;
  const params = new URLSearchParams({ q: consulta.q, pagina, modo: consulta.modo, solo_vertimientos: consulta.solo_vertimientos });
  if (consulta.autoridad) params.append("autoridad", consulta.autoridad);
  if (consulta.tramite) params.append("tramite", consulta.tramite);
  if (consulta.municipio) params.append("municipio", consulta.municipio);
  try {
    resultado = await pedir(`/api/scout/vital/buscar?${params}`);
    abierto = null;
    pintarResultado();
    if (resultado.origen === "sin dato") {
      anotar(`VITAL: sin resultados para <b>${escapar(consulta.q)}</b>`, "aviso", escapar(resultado.incidencia));
    } else {
      anotar(`VITAL: <b>${resultado.total}</b> tramites para <b>${escapar(consulta.q)}</b>${consulta.solo_vertimientos ? " (solo vertimientos)" : ""}`,
        resultado.origen === "red" ? "ok" : "azul",
        resultado.origen === "red" ? "consultado ahora" : `desde la cache${resultado.fecha_dato ? " del " + fechaCorta(resultado.fecha_dato) : ""}`);
    }
  } catch (e) {
    $("vital-resultados").innerHTML = `<div class="error">${escapar(e.message)}</div>`;
  } finally { btn.disabled = false; btn.textContent = "Buscar"; }
}

function opciones(select, valores, actual, vacio) {
  const lista = [...new Set([...(valores || []), ...(actual ? [actual] : [])])];
  select.innerHTML = `<option value="">${vacio}</option>` + lista.map((v) =>
    `<option value="${escapar(v)}"${v === actual ? " selected" : ""}>${escapar(v.trim())}</option>`).join("");
}

function pintarResultado() {
  const r = resultado;
  opciones($("vital-aut"), r.facetas.autoridad, consulta.autoridad, "Cualquier autoridad");
  opciones($("vital-tra"), r.facetas.tramite, consulta.tramite, "Cualquier tramite");
  opciones($("vital-mun"), r.facetas.municipio, consulta.municipio, "Cualquier municipio");

  $("vital-chip-origen").innerHTML = r.origen === "red" ? chip("consultado ahora", "ok")
    : r.origen === "cache" ? chip(`cache${r.fecha_dato ? " · " + fechaCorta(r.fecha_dato) : ""}`, "azul")
    : chip("sin dato", "aviso");

  if (r.origen === "sin dato") {
    $("vital-resumen").innerHTML = `<span style="color:var(--aviso)">${escapar(r.incidencia)}</span>`;
    $("vital-resultados").innerHTML = ""; $("vital-paginacion").innerHTML = "";
    return;
  }
  $("vital-resumen").innerHTML = `<b>${r.total}</b> tramite(s) · pagina ${r.pagina} de ${r.paginas || 1}`
    + (r.vertimientos ? ` · ${r.vertimientos} de vertimiento en esta pagina` : "")
    + (r.incidencia ? ` · <span style="color:var(--aviso)">${escapar(r.incidencia)}</span>` : "");

  if (!r.registros.length) { $("vital-resultados").innerHTML = `<p class="pie">Nada con esos filtros. Prueba sin "solo vertimientos" o con menos palabras.</p>`; $("vital-paginacion").innerHTML = ""; return; }

  $("vital-resultados").innerHTML = `<table>
    <thead><tr><th>Titular</th><th>Tramite</th><th>Autoridad</th><th>Expediente</th><th>Fecha</th><th></th></tr></thead>
    <tbody>${r.registros.map((x) => fila(x) + (abierto === x.id ? detalle(x) : "")).join("")}</tbody></table>`;

  $("vital-resultados").querySelectorAll("tr.clicable").forEach((tr) =>
    tr.addEventListener("click", (ev) => {
      // La fila entera abre el detalle; los controles de dentro, no.
      if (ev.target.closest("select, a, textarea, input") ||
          (ev.target.closest("button") && !ev.target.closest(".btn-detalle"))) return;
      abierto = abierto === tr.dataset.id ? null : tr.dataset.id;
      pintarResultado();
    }));
  montarAccionesDetalle();

  $("vital-paginacion").innerHTML = `
    <button class="secundario pequeno" id="vital-prev" ${r.pagina <= 1 ? "disabled" : ""}>← Anterior</button>
    <span class="pie" style="margin:0">pagina ${r.pagina} de ${r.paginas || 1}</span>
    <button class="secundario pequeno" id="vital-next" ${r.pagina >= (r.paginas || 1) ? "disabled" : ""}>Siguiente →</button>`;
  $("vital-prev").addEventListener("click", () => buscar(r.pagina - 1));
  $("vital-next").addEventListener("click", () => buscar(r.pagina + 1));
}

function fila(x) {
  return `<tr class="clicable${abierto === x.id ? " seleccionada" : ""}" data-id="${escapar(x.id)}">
    <td><b>${escapar(x.titular || "—")}</b>${x.proyecto ? `<span class="sub">${escapar(x.proyecto)}</span>` : ""}</td>
    <td>${escapar(x.tramite_legible)}${x.es_vertimiento ? ` <span class="chip azul sin-punto">vertimiento</span>` : ""}</td>
    <td>${escapar(x.autoridad.trim())}</td>
    <td>${x.expediente ? `<code>${escapar(x.expediente)}</code>` : "—"}${x.radicado ? `<span class="sub">rad. ${escapar(x.radicado)}</span>` : ""}</td>
    <td class="sub">${escapar(x.fecha)}</td>
    <td class="num"><button class="secundario pequeno btn-detalle">${abierto === x.id ? "Cerrar" : "Detalle"}</button></td>
  </tr>`;
}

function detalle(x) {
  const prospectos = [...(estado.barrido?.prospectos || [])].sort((a, b) => a.nombre.localeCompare(b.nombre));
  const identificador = x.expediente || x.radicado;
  const sugerido = prospectos.find((p) => nombreParaBuscar(p.nombre) && nombreParaBuscar(x.titular).startsWith(nombreParaBuscar(p.nombre).split(" ")[0]));
  return `<tr><td colspan="6" style="padding:4px 8px 14px">
    <div class="rejilla dos" style="gap:14px">
      <div>
        <dl class="pares">
          <dt>Titular</dt><dd>${escapar(x.titular)}</dd>
          <dt>Tramite</dt><dd>${escapar(x.tramite_legible)}${x.tramite !== x.tramite_legible ? ` <span class="sub">(${escapar(x.tramite)})</span>` : ""}</dd>
          <dt>Autoridad</dt><dd>${escapar(x.autoridad.trim())}</dd>
          <dt>Expediente</dt><dd>${x.expediente ? `<code>${escapar(x.expediente)}</code>` : "—"}</dd>
          <dt>Radicado</dt><dd>${x.radicado ? `<code>${escapar(x.radicado)}</code>` : "—"}</dd>
          ${x.proyecto ? `<dt>Proyecto</dt><dd>${escapar(x.proyecto)}</dd>` : ""}
          ${x.municipio ? `<dt>Municipio</dt><dd>${escapar(x.municipio)}</dd>` : ""}
          <dt>Fechas</dt><dd>${escapar(x.fecha)}${x.fecha_fin && x.fecha_fin !== x.fecha ? " → " + escapar(x.fecha_fin) : ""} · origen ${escapar(x.origen)}</dd>
        </dl>
        <div class="acciones">
          ${identificador ? `<button class="secundario pequeno btn-copiar" data-texto="${escapar(identificador)}">Copiar ${x.expediente ? "expediente" : "radicado"}</button>` : ""}
          ${identificador ? `<button class="secundario pequeno btn-solicitud">Redactar solicitud</button>` : ""}
          <a class="chip neutra sin-punto" href="${escapar(x.url)}" target="_blank" rel="noopener">Abrir buscador de VITAL ↗</a>
        </div>
        <div class="caja-solicitud" hidden style="margin-top:10px">
          <textarea rows="12" readonly class="txt-solicitud"></textarea>
          <div class="acciones"><button class="pequeno btn-copiar-solicitud">Copiar solicitud</button>
            <span class="pie" style="margin:0">Rellena los corchetes antes de enviarla.</span></div>
        </div>
      </div>
      <div>
        <h4 style="margin:0 0 8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--texto-tenue)">Vincular a un prospecto</h4>
        <p class="pie" style="margin:0 0 8px">El prospecto pasa a llevar este expediente como referencia y su confianza sube, igual que si el cruce automatico lo hubiera encontrado.</p>
        ${identificador ? `
        <select class="sel-prospecto">
          <option value="">— elegir prospecto —</option>
          ${prospectos.map((p) => `<option value="${p.clave}"${sugerido && p.clave === sugerido.clave ? " selected" : ""}>${escapar(p.nombre)}${tienePermiso(p) ? " · ya tiene expediente" : ""}</option>`).join("")}
        </select>
        <div class="acciones"><button class="pequeno btn-vincular" ${sugerido ? "" : "disabled"}>Vincular</button>
          ${sugerido ? `<span class="pie" style="margin:0">sugerido por el nombre: <b>${escapar(sugerido.nombre)}</b></span>` : ""}</div>`
        : `<p class="pie">Este tramite no trae expediente ni radicado: no hay nada que vincular.</p>`}
        <p class="pie">Es un vinculo <b>declarado</b>: prueba que la empresa tramita ante la autoridad, no dice que vierte. La analitica sigue saliendo del expediente.</p>
      </div>
    </div>
  </td></tr>`;
}

function montarAccionesDetalle() {
  const caja = $("vital-resultados");
  const x = resultado.registros.find((r) => r.id === abierto);
  if (!x) return;
  caja.querySelectorAll(".btn-copiar").forEach((b) => b.addEventListener("click", async () => {
    b.textContent = (await copiar(b.dataset.texto)) ? "Copiado" : "No se pudo copiar";
  }));
  caja.querySelector(".btn-solicitud")?.addEventListener("click", () => {
    const c = caja.querySelector(".caja-solicitud");
    c.hidden = !c.hidden;
    c.querySelector(".txt-solicitud").value = textoSolicitud({
      empresa: x.titular, autoridad: x.autoridad.trim(), expediente: x.expediente || x.radicado,
    });
  });
  caja.querySelector(".btn-copiar-solicitud")?.addEventListener("click", async (ev) => {
    ev.target.textContent = (await copiar(caja.querySelector(".txt-solicitud").value)) ? "Copiada" : "No se pudo copiar";
  });
  const sel = caja.querySelector(".sel-prospecto"), btn = caja.querySelector(".btn-vincular");
  sel?.addEventListener("change", () => { btn.disabled = !sel.value; });
  btn?.addEventListener("click", async () => {
    btn.disabled = true; btn.textContent = "Vinculando…";
    try {
      const f = await pedir("/api/scout/vital/vincular", { clave: sel.value, registro: x, radio_km: estado.radio });
      anotar(`Expediente <b>${escapar(x.expediente || x.radicado)}</b> vinculado a <b>${escapar(f.nombre)}</b>`, "ok",
        "la confianza del prospecto sube; se ve en Prospectos");
      await cargarBarrido({ refrescar: true });
      pintarResultado();
    } catch (e) { alert(e.message); btn.disabled = false; btn.textContent = "Vincular"; }
  });
}

// ---------------------------------------------------------------------------
// Laterales: pendientes y vinculados
// ---------------------------------------------------------------------------

function pintarLaterales() {
  const b = estado.barrido;
  if (!b) return;
  const sin = b.prospectos.filter((p) => !tienePermiso(p) && (p.puntaje || 0) > 0)
    .sort((a, c) => (c.puntaje || 0) - (a.puntaje || 0));
  $("vital-pendientes").innerHTML = sin.length ? `<table><tbody>${sin.map((p) => `<tr>
      <td><b>${escapar(p.nombre)}</b><span class="sub">${escapar(p.sector)} · puntaje ${(p.puntaje || 0).toFixed(0)}</span></td>
      <td class="num"><button class="secundario pequeno btn-buscar-p" data-q="${escapar(nombreParaBuscar(p.nombre))}">Buscar</button></td>
    </tr>`).join("")}</tbody></table>`
    : `<p class="pie">Todos los prospectos viables tienen expediente localizado.</p>`;
  $("vital-pendientes").querySelectorAll(".btn-buscar-p").forEach((btn) => btn.addEventListener("click", () => {
    $("vital-q").value = btn.dataset.q;
    $("vital-solo-vert").checked = false;      // la empresa puede tramitar otra cosa
    buscar(1);
    $("vital-q").scrollIntoView({ behavior: "smooth", block: "center" });
  }));

  const con = b.prospectos.filter((p) => (p.ficha?.expedientes || []).length);
  $("vital-vinculados").innerHTML = con.length ? con.map((p) => `
    <div style="padding:6px 0;border-bottom:1px solid var(--borde-suave)">
      <b>${escapar(p.nombre)}</b>
      ${p.ficha.expedientes.map((e) => `<div class="sub" style="display:flex;gap:8px;align-items:center;margin-top:3px">
        <code>${escapar(e.expediente || e.radicado)}</code> ${escapar(e.tramite_legible || e.tramite)} · ${escapar((e.autoridad || "").trim())}
        <button class="secundario pequeno btn-quitar" data-clave="${p.clave}" data-id="${escapar(e.expediente || e.radicado)}" style="margin-left:auto">Quitar</button>
      </div>`).join("")}
    </div>`).join("")
    : `<p class="pie">Ninguno todavia. Busca una empresa y pulsa "Vincular" en el detalle de un tramite.</p>`;
  $("vital-vinculados").querySelectorAll(".btn-quitar").forEach((btn) => btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await pedir("/api/scout/vital/desvincular", { clave: btn.dataset.clave, identificador: btn.dataset.id });
      anotar(`Expediente ${escapar(btn.dataset.id)} desvinculado`, "neutra");
      await cargarBarrido({ refrescar: true });
    } catch (e) { alert(e.message); btn.disabled = false; }
  }));
}

// ---------------------------------------------------------------------------

export default {
  id: "vital",
  async montar() {
    $("vital-form").addEventListener("submit", (ev) => { ev.preventDefault(); buscar(1); });
    ["vital-aut", "vital-tra", "vital-mun", "vital-solo-vert"].forEach((id) =>
      $(id).addEventListener("change", () => {
        $("vital-solo-vert").closest("label").classList.toggle("activo", $("vital-solo-vert").checked);
        if (resultado) buscar(1);
      }));
    document.querySelectorAll("#vital-modo input").forEach((inp) => inp.addEventListener("change", () => {
      document.querySelectorAll("#vital-modo label").forEach((l) => l.classList.toggle("activo", l.querySelector("input").checked));
    }));
    bus.on("barrido", pintarLaterales);
    if (estado.barrido) pintarLaterales(); else await cargarBarrido();
    // Si se llega con ?q= en el hash (#vital?q=Yara), se busca directamente.
    const q = new URLSearchParams(location.hash.split("?")[1] || "").get("q");
    if (q) { $("vital-q").value = q; buscar(1); }
  },
};
