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
const detalles = {};      // radicado -> detalle del VITAL antiguo (o {cargando: true})

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

function lanzarBusqueda(texto, soloVertimientos = false) {
  $("vital-q").value = texto;
  $("vital-solo-vert").checked = soloVertimientos;
  $("vital-solo-vert").closest("label").classList.toggle("activo", soloVertimientos);
  buscar(1);
}

function pintarInicio(prioridades = []) {
  if (resultado) return;
  $("vital-titulo-resultados").textContent = "Comienza una verificación";
  $("vital-resumen").textContent = "La búsqueda consulta evidencia pública y conserva su fecha.";
  $("vital-resultados").innerHTML = `<div class="vital-vacio"><div class="vital-vacio-contenido">
    <div class="vital-vacio-icono">⌕</div>
    <h3>Del nombre de una empresa a evidencia verificable</h3>
    <p>Busca por razón social, expediente o radicado. Después podrás revisar el trámite, abrir sus documentos y asociarlo al prospecto correcto.</p>
    <div class="vital-flujo">
      <div><span class="vital-flujo-num">1</span><b>Localizar</b><span>Encuentra trámites por empresa o identificador.</span></div>
      <div><span class="vital-flujo-num">2</span><b>Revisar</b><span>Comprueba autoridad, fechas y documentos publicados.</span></div>
      <div><span class="vital-flujo-num">3</span><b>Vincular</b><span>Incorpora el expediente a la ficha del prospecto.</span></div>
    </div>
    ${prioridades.length ? `<div class="vital-accesos"><span class="pie" style="width:100%;margin:0 0 2px">Verifica primero los prospectos con mayor puntaje</span>${prioridades.map((p) => `<button class="secundario pequeno" data-vital-buscar="${escapar(nombreParaBuscar(p.nombre))}">${escapar(p.nombre)}</button>`).join("")}</div>` : ""}
  </div></div>`;
}

async function buscar(pagina = 1) {
  leerFormulario();
  if (!consulta.q) { $("vital-resumen").innerHTML = `<span style="color:var(--aviso)">Escribe una empresa, un expediente o un radicado.</span>`; return; }
  consulta.pagina = pagina;
  const btn = $("vital-btn"); btn.disabled = true; btn.textContent = "Buscando…";
  $("vital-titulo-resultados").textContent = `Buscando “${consulta.q}”`;
  $("vital-resumen").textContent = "Consultando la evidencia disponible…";
  $("vital-resultados").innerHTML = `<div class="vital-vacio"><p class="cargando">Consultando el buscador público de VITAL…</p></div>`;
  $("vital-paginacion").innerHTML = "";
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
        resultado.origen === "red" ? "consultado ahora" : `consulta disponible${resultado.fecha_dato ? " del " + fechaCorta(resultado.fecha_dato) : ""}`);
    }
  } catch (e) {
    $("vital-titulo-resultados").textContent = "No se pudo completar la búsqueda";
    $("vital-resumen").textContent = "Revisa la conexión e inténtalo de nuevo.";
    $("vital-resultados").innerHTML = `<div class="error" style="margin:16px">${escapar(e.message)}</div>`;
  } finally { btn.disabled = false; btn.textContent = "Buscar en VITAL"; }
}

function opciones(select, valores, actual, vacio) {
  const lista = [...new Set([...(valores || []), ...(actual ? [actual] : [])])];
  select.innerHTML = `<option value="">${vacio}</option>` + lista.map((v) =>
    `<option value="${escapar(v)}"${v === actual ? " selected" : ""}>${escapar(v.trim())}</option>`).join("");
}

function pintarResultado() {
  const r = resultado;
  opciones($("vital-aut"), r.facetas.autoridad, consulta.autoridad, "Todas las autoridades");
  opciones($("vital-tra"), r.facetas.tramite, consulta.tramite, "Todos los trámites");
  opciones($("vital-mun"), r.facetas.municipio, consulta.municipio, "Todos los municipios");

  $("vital-chip-origen").innerHTML = r.origen === "red" ? chip("Fuente consultada ahora", "ok")
    : r.origen === "cache" ? chip(`Evidencia disponible${r.fecha_dato ? " · " + fechaCorta(r.fecha_dato) : ""}`, "azul")
    : chip("Fuente no disponible", "aviso");
  $("vital-titulo-resultados").textContent = `Resultados para “${consulta.q}”`;

  if (r.origen === "sin dato") {
    $("vital-resumen").innerHTML = `<span style="color:var(--aviso)">${escapar(r.incidencia)}</span>`;
    $("vital-resultados").innerHTML = ""; $("vital-paginacion").innerHTML = "";
    return;
  }
  $("vital-resumen").innerHTML = `<b>${r.total}</b> trámite${r.total === 1 ? "" : "s"} · página ${r.pagina} de ${r.paginas || 1}`
    + (r.vertimientos ? ` · ${r.vertimientos} de vertimiento en esta página` : "")
    + (r.incidencia ? ` · <span style="color:var(--aviso)">${escapar(r.incidencia)}</span>` : "");

  if (!r.registros.length) {
    $("vital-resultados").innerHTML = `<div class="vital-sin-resultados"><div><h3>No encontramos coincidencias</h3>
      <p>Prueba con una razón social más corta, elimina algún filtro o desactiva “Solo vertimientos” para revisar otros trámites de la empresa.</p>
      ${consulta.solo_vertimientos ? `<button class="secundario pequeno" style="margin-top:12px" data-vital-ampliar>Buscar todos los trámites</button>` : ""}</div></div>`;
    $("vital-paginacion").innerHTML = "";
    return;
  }

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
    <span class="pie" style="margin:0">página ${r.pagina} de ${r.paginas || 1}</span>
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
    <div class="documentos" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--borde-suave)">
      <h4 style="margin:0 0 8px;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--texto-tenue)">Documentos del tramite
        <span style="text-transform:none;letter-spacing:0;font-weight:400"> · lo que hay en el expediente, sin salir de aqui</span></h4>
      ${bloqueDocumentos(x)}
    </div>
  </td></tr>`;
}

function puedeVerDocumentos(x) {
  return Boolean(x.radicado && x.sol_id && x.solicitante_id && x.origen);
}

function paramsTramite(x) {
  return new URLSearchParams({ radicado: x.radicado, origen: x.origen, sol_id: x.sol_id, solicitante_id: x.solicitante_id });
}

function bloqueDocumentos(x) {
  if (!puedeVerDocumentos(x)) return `<p class="pie">Este registro no enlaza con el portal de expedientes; no se puede llegar a sus documentos desde aqui.</p>`;
  const d = detalles[x.radicado];
  if (!d) return `<div class="acciones" style="margin-top:0"><button class="pequeno btn-ver-docs">Ver documentos</button>
    <span class="pie" style="margin:0">Consulta el portal de expedientes: unos segundos por carpeta.</span></div>`;
  if (d.cargando) return `<p class="cargando">Abriendo el expediente en el portal de VITAL…</p>`;
  if (d.origen_dato === "sin dato") return `<div class="aviso-caja">${escapar(d.incidencia)}</div>
    <div class="acciones"><button class="secundario pequeno btn-ver-docs" data-modo="vivo">Reintentar en vivo</button></div>`;

  const estado = (d.estado || []).map((e) => chip(e.paso, e.hecho ? "ok" : "neutra")).join(" ");
  const prospectos = [...(estado_prospectos())];
  const carpetas = d.carpetas.length ? d.carpetas.map((c) => `
    <div style="margin-top:8px">
      <div style="font-size:12px;color:var(--texto-2)"><b>${escapar(c.titulo)}</b>${c.etiqueta ? ` · <span class="sub" style="display:inline">${escapar(c.etiqueta)}</span>` : ""}${c.fecha ? ` · ${escapar(c.fecha)}` : ""}</div>
      ${c.incidencia ? `<p class="pie" style="color:var(--aviso)">${escapar(c.incidencia)}</p>` : ""}
      ${c.archivos.length ? `<table><tbody>${c.archivos.map((a) => `<tr>
        <td>${iconoArchivo(a.extension)} ${escapar(nombreLegible(a.nombre))}<span class="sub">${escapar(a.nombre)}</span></td>
        <td class="num" style="white-space:nowrap">
          <a class="chip azul sin-punto" target="_blank" rel="noopener" href="/api/scout/vital/documento?${paramsTramite(x)}&grupo=${c.grupo}&entrada=${c.entrada}&indice=${a.indice}">Ver</a>
          <a class="chip neutra sin-punto" href="/api/scout/vital/documento?${paramsTramite(x)}&grupo=${c.grupo}&entrada=${c.entrada}&indice=${a.indice}&descargar=true">Descargar</a>
          <button class="secundario pequeno btn-archivar-doc" data-grupo="${c.grupo}" data-entrada="${c.entrada}" data-indice="${a.indice}">Guardar en expediente</button>
        </td></tr>`).join("")}</tbody></table>` : (c.incidencia ? "" : `<p class="pie">Carpeta vacia.</p>`)}
    </div>`).join("") : `<p class="pie">El tramite no tiene documentos publicados.</p>`;

  return `
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px">${estado}
      <span class="pie" style="margin:0 0 0 auto">${d.origen_dato === "cache" ? `consulta disponible${d.fecha_dato ? " · " + fechaCorta(d.fecha_dato) : ""}` : "consultado ahora"} ·
        <a href="${escapar(d.url_portal)}" target="_blank" rel="noopener">abrir en el portal ↗</a></span></div>
    ${d.proyecto || d.ubicacion ? `<p class="pie" style="margin:0 0 6px">${escapar([d.proyecto, d.ubicacion].filter(Boolean).join(" · "))}</p>` : ""}
    ${carpetas}
    <p class="pie">"Ver" abre el documento en una pestana nueva (los PDF se muestran en el navegador). "Guardar en expediente" lo guarda en la aplicacion, junto al resto de la evidencia del prospecto, para leerlo con IA en Datos externos.</p>
    <div class="archivado-msg"></div>`;
}

function estado_prospectos() { return estado.barrido?.prospectos || []; }

function iconoArchivo(ext) {
  return ({ ".pdf": "📄", ".rtf": "📝", ".doc": "📝", ".docx": "📝", ".xls": "📊", ".xlsx": "📊", ".jpg": "🖼", ".jpeg": "🖼", ".png": "🖼", ".zip": "🗜" })[ext] || "📎";
}

/** '-699880203_32_Solicitud Renovacion PVL_20260512090534.pdf' -> 'Solicitud Renovacion PVL'. */
function nombreLegible(nombre) {
  let n = nombre.replace(/\.[a-z0-9]+$/i, "");
  n = n.replace(/^-?\d+_\d+_/, "").replace(/_\d{14}$/, "").replace(/_+/g, " ").trim();
  return n || nombre;
}

async function cargarDetalle(x, modo) {
  detalles[x.radicado] = { cargando: true };
  pintarResultado();
  try {
    const q = paramsTramite(x); if (modo) q.set("modo", modo);
    const d = await pedir(`/api/scout/vital/detalle?${q}`);
    detalles[x.radicado] = d;
    if (d.origen_dato === "sin dato") anotar(`Portal de expedientes: sin detalle para ${escapar(x.radicado)}`, "aviso", escapar(d.incidencia));
    else anotar(`Expediente de <b>${escapar(d.solicitante)}</b>: ${d.total_archivos} documento(s) en ${d.carpetas.length} carpeta(s)`,
      d.origen_dato === "red" ? "ok" : "azul", `radicado ${escapar(x.radicado)}${d.expediente ? " · expediente " + escapar(d.expediente) : ""}`);
  } catch (e) {
    detalles[x.radicado] = { origen_dato: "sin dato", incidencia: e.message };
  }
  pintarResultado();
}

async function archivarDocumento(x, btn) {
  const sel = $("vital-resultados").querySelector(".sel-prospecto");
  btn.disabled = true; btn.textContent = "Guardando…";
  try {
    const r = await pedir("/api/scout/vital/documento/archivar", {
      radicado: x.radicado, origen: x.origen, sol_id: x.sol_id, solicitante_id: x.solicitante_id,
      grupo: btn.dataset.grupo, entrada: Number(btn.dataset.entrada), indice: Number(btn.dataset.indice),
      clave: sel?.value || "", radio_km: estado.radio,
    });
    btn.textContent = "Guardado";
    const msg = $("vital-resultados").querySelector(".archivado-msg");
    msg.innerHTML = `<div class="ok-caja" style="margin-top:8px"><b>Guardado.</b> ${escapar(r.nombre)} (${(r.bytes / 1e6).toFixed(2)} MB)${r.ficha ? ` y anotado en la ficha de <b>${escapar(r.ficha.nombre)}</b>` : " (sin prospecto elegido: no se anoto en ninguna ficha)"}.</div>`;
    anotar(`Documento guardado: <b>${escapar(r.nombre)}</b>${r.ficha ? " en la ficha de " + escapar(r.ficha.nombre) : ""}`, "ok");
    if (r.ficha) await cargarBarrido({ refrescar: true });
  } catch (e) {
    btn.disabled = false; btn.textContent = "Guardar en expediente";
    alert(e.message);
  }
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
  caja.querySelectorAll(".btn-ver-docs").forEach((b) => b.addEventListener("click", () => cargarDetalle(x, b.dataset.modo)));
  caja.querySelectorAll(".btn-archivar-doc").forEach((b) => b.addEventListener("click", () => archivarDocumento(x, b)));
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
  const evaluables = b.prospectos.filter((p) => (p.puntaje || 0) > 0);
  const sin = evaluables.filter((p) => !tienePermiso(p))
    .sort((a, c) => (c.puntaje || 0) - (a.puntaje || 0));
  const conEvidencia = evaluables.length - sin.length;
  const asociados = b.prospectos.filter((p) => (p.ficha?.expedientes || []).length);
  const documentos = b.prospectos.reduce((n, p) => n + (p.ficha?.documentos || []).length, 0);
  const avance = evaluables.length ? Math.round(conEvidencia / evaluables.length * 100) : 0;

  $("vital-metricas").innerHTML = `<div class="vital-metricas">
      <div class="vital-metrica"><b>${conEvidencia}</b><span>con evidencia VITAL</span></div>
      <div class="vital-metrica"><b>${sin.length}</b><span>por verificar</span></div>
      <div class="vital-metrica"><b>${documentos}</b><span>documentos guardados</span></div>
    </div>
    <div class="vital-progreso" style="--avance:${avance}%"><i></i></div>
    <div class="vital-progreso-nota"><span>${avance}% de cobertura</span><span>${conEvidencia} de ${evaluables.length} prospectos</span></div>`;

  const pendiente = (p, i) => `<div class="vital-pendiente">
    <span class="vital-rango">${i + 1}</span>
    <div><b title="${escapar(p.nombre)}">${escapar(p.nombre)}</b><span class="sub">${escapar(p.sector)} · puntaje ${(p.puntaje || 0).toFixed(0)}</span></div>
    <button class="secundario pequeno" data-vital-buscar="${escapar(nombreParaBuscar(p.nombre))}">Verificar</button>
  </div>`;
  const principales = sin.slice(0, 6);
  const restantes = sin.slice(6);
  $("vital-pendientes").innerHTML = sin.length ? principales.map(pendiente).join("")
    + (restantes.length ? `<details class="vital-mas"><summary>Ver ${restantes.length} prospectos más</summary>${restantes.map((p, i) => pendiente(p, i + 6)).join("")}</details>` : "")
    : `<p class="pie">Todos los prospectos viables tienen expediente localizado.</p>`;

  $("vital-vinculados").innerHTML = asociados.length ? asociados.map((p) => `
    <div class="vital-vinculo">
      <div class="vital-vinculo-cab"><b>${escapar(p.nombre)}</b>${chip(`${p.ficha.expedientes.length}`, "ok")}</div>
      ${p.ficha.expedientes.map((e) => `<div class="sub">
        <code>${escapar(e.expediente || e.radicado)}</code> · ${escapar((e.autoridad || "").trim())}
        <button class="secundario pequeno btn-quitar" data-clave="${p.clave}" data-id="${escapar(e.expediente || e.radicado)}" style="float:right">Quitar</button>
      </div>`).join("")}
    </div>`).join("")
    : `<p class="pie">Todavía no hay asociaciones manuales. Abre un resultado y selecciona “Vincular”.</p>`;
  $("vital-vinculados").querySelectorAll(".btn-quitar").forEach((btn) => btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await pedir("/api/scout/vital/desvincular", { clave: btn.dataset.clave, identificador: btn.dataset.id });
      anotar(`Expediente ${escapar(btn.dataset.id)} desvinculado`, "neutra");
      await cargarBarrido({ refrescar: true });
    } catch (e) { alert(e.message); btn.disabled = false; }
  }));
  pintarInicio(sin.slice(0, 3));
}

// ---------------------------------------------------------------------------

export default {
  id: "vital",
  async montar() {
    $("vital-chip-origen").innerHTML = chip("Fuente oficial · MinAmbiente", "neutra");
    $("vital-form").addEventListener("submit", (ev) => { ev.preventDefault(); buscar(1); });
    $("mod-vital").addEventListener("click", (ev) => {
      const acceso = ev.target.closest("[data-vital-buscar]");
      if (acceso) {
        lanzarBusqueda(acceso.dataset.vitalBuscar, false);
        $("vital-q").scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (ev.target.closest("[data-vital-ampliar]")) lanzarBusqueda(consulta.q, false);
    });
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
