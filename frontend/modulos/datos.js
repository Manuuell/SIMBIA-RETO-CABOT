/* Modulo 1: extraccion de datos externos.
 *
 * Tres pasos que el usuario ejecuta y ve ejecutarse:
 *   1. consultar las fuentes (OpenStreetMap, datos.gov.co, VITAL) en el modo
 *      que elija, y ver de donde salio cada registro y de cuando es;
 *   2. cruzar los permisos de vertimiento con los prospectos y redactar la
 *      solicitud de expediente con el numero correcto;
 *   3. traer documentos del expediente: archivarlos o leerlos con IA.
 *
 * La bitacora de la derecha cuenta, linea a linea, que hizo el sistema.
 */

import {
  $, anotar, barraConfianza, bitacora, bus, cargarBarrido, chip, escapar,
  estado, fechaCorta, fmt, limpiarBitacora, pedir, sello, textoSolicitud, tienePermiso,
} from "../comun.js";

const INFO_FUENTE = {
  osm: {
    aporta: "Posicion real, superficie del predio y nombre de cada establecimiento industrial. Es la llave para cruzar con los registros nacionales.",
  },
  datos_gov: {
    aporta: "Caudal autorizado y analitica del permiso, cuando la autoridad ambiental lo publica en el portal de datos abiertos.",
  },
  vital: {
    nombre: "VITAL · permisos de vertimiento",
    licencia: "Ministerio de Ambiente · buscador publico",
    aporta: "Existencia del permiso, titular, autoridad competente y numero de expediente. No da coordenadas ni analitica.",
  },
};

/** Primera frase de un texto largo; el resto queda en el title. */
function breve(texto) {
  const t = String(texto || "");
  const corte = t.indexOf(". ");
  return corte > 0 && corte < t.length - 2 ? t.slice(0, corte + 1) : t;
}

// Como se llama cada modo en pantalla (los valores internos no se muestran).
const NOMBRE_MODO = { offline: "ultima consulta", cache: "actualizacion selectiva", vivo: "consulta actual" };

const QUE_PASARA = {
  offline: (c) => `Se usara la <b>ultima consulta disponible</b>: ${c}.`,
  cache: (c) => `Se conservara la evidencia vigente (${c}) y se actualizara solamente lo necesario.`,
  vivo: () => `Se consultaran <b>ahora mismo</b> OpenStreetMap y VITAL. Puede tardar entre 10 y 60 segundos.`,
};

/** Radio maximo descargado de OpenStreetMap alrededor de la planta, o 0. */
function radioDescargado() {
  const cfg = estado.config, pl = cfg.planta;
  const osm = (cfg.descargas?.osm || []).filter((d) =>
    Math.abs(d.lat - pl.lat) < 1e-4 && Math.abs(d.lon - pl.lon) < 1e-4);
  return osm.reduce((m, d) => Math.max(m, d.radio_km), 0);
}

// ---------------------------------------------------------------------------
// Paso 1: fuentes
// ---------------------------------------------------------------------------

function chipOrigen(origen, fecha) {
  switch (origen) {
    case "cache": return chip(`consulta${fecha ? " · " + fechaCorta(fecha) : " disponible"}`, "azul");
    case "red": return chip("descargado ahora", "ok");
    case "fixture": return chip("datos ilustrativos", "aviso");
    case "sin dato": return chip("sin dato", "aviso");
    default: return chip("sin consultar", "neutra");
  }
}

function tarjetaFuente({ codigo, nombre, licencia, verificada, nota, aporta, resultado }) {
  const r = resultado || {};
  return `<div class="fuente" data-fuente="${codigo}">
    <div class="nombre">${escapar(nombre)}
      ${verificada ? "" : (nota || "").startsWith("No aplica") ? chip("no aplica aqui", "neutra") : chip("sin configurar", "aviso")}</div>
    <div class="aporta">${escapar(aporta)}</div>
    <div class="resultado">
      <b>${r.registros ?? "—"}</b> ${codigo === "vital" ? "permisos" : "registros"}
      ${chipOrigen(r.origen, r.fecha_dato)}
      ${r.nota ? `<span class="aporta">${escapar(r.nota)}</span>` : ""}
    </div>
    ${r.incidencia && r.origen !== "cache" ? `<div class="incidencia" title="${escapar(r.incidencia)}">${escapar(breve(r.incidencia))}</div>` : ""}
    ${!r.incidencia && !verificada && nota ? `<div class="incidencia" title="${escapar(nota)}" style="${nota.startsWith("No aplica") ? "color:var(--texto-tenue)" : ""}">${escapar(breve(nota))}</div>` : ""}
    <div class="aporta" style="color:var(--texto-tenue)">${escapar(licencia)}</div>
  </div>`;
}

function pintarFuentes() {
  const cfg = estado.config, b = estado.barrido;
  const porCodigo = Object.fromEntries((b?.fuentes || []).map((f) => [f.fuente, f]));
  // Una fuente que no aplica en esta zona (datos.gov.co no publica los
  // permisos de Cartagena) no se muestra: no aporta nada que decidir.
  const aplican = cfg.fuentes.filter((f) => f.verificada || !(f.nota_configuracion || "").startsWith("No aplica"));
  const tarjetas = aplican.map((f) => tarjetaFuente({
    codigo: f.codigo, nombre: f.nombre, licencia: f.licencia, verificada: f.verificada,
    nota: f.nota_configuracion, aporta: INFO_FUENTE[f.codigo]?.aporta || "",
    resultado: porCodigo[f.codigo],
  }));
  const pv = b?.permisos || {};
  tarjetas.push(tarjetaFuente({
    codigo: "vital", nombre: INFO_FUENTE.vital.nombre, licencia: INFO_FUENTE.vital.licencia,
    verificada: true, aporta: INFO_FUENTE.vital.aporta,
    resultado: b ? { registros: pv.total, origen: pv.origen, fecha_dato: pv.fecha_dato } : null,
  }));
  $("fuentes-lista").innerHTML = tarjetas.join("");

  if (b) {
    const total = (b.fuentes || []).reduce((s, f) => s + f.registros, 0);
    const conDato = (b.fuentes || []).filter((f) => f.registros > 0).length;
    $("paso1-estado").innerHTML = chip(
      `${total} registros de ${conDato} fuente${conDato === 1 ? "" : "s"} → ${b.resumen.detectados} prospectos`,
      total ? "ok" : "aviso",
    );
    $("paso1-num").className = "paso-num " + (total ? "hecho" : "");
    $("datos-chip-modo").innerHTML = chip(`ultimo barrido: ${NOMBRE_MODO[b.modo] || b.modo} · radio ${b.radio_km} km`, "neutra");
  } else {
    $("paso1-estado").innerHTML = chip("sin ejecutar", "neutra");
    $("datos-chip-modo").innerHTML = chip(`modo por defecto: ${NOMBRE_MODO[cfg.modo] || cfg.modo}`, "neutra");
  }
  pintarQuePasara();
}

function modoElegido() {
  return document.querySelector("#modo-opciones input:checked").value;
}

function pintarQuePasara() {
  const modo = modoElegido();
  const radio = parseFloat($("radio-km").value) || 0;
  const maxOsm = radioDescargado();
  const osm = (estado.config.descargas?.osm || []).find((d) => d.radio_km === maxOsm);
  const partes = [];
  if (osm) partes.push(`OpenStreetMap hasta <b>${maxOsm} km</b> (${osm.registros} registros del ${fechaCorta(osm.guardado)})`);
  const pv = estado.barrido?.permisos;
  if (pv?.total && pv.origen === "cache") partes.push(`VITAL ${pv.total} permisos${pv.fecha_dato ? " del " + fechaCorta(pv.fecha_dato) : ""}`);
  const cache = partes.length ? partes.join("; ") : "todavia no hay nada descargado";
  let texto = QUE_PASARA[modo](cache);
  if (modo !== "vivo" && radio > maxOsm) {
    texto += ` <span style="color:var(--aviso)"><b>Atencion:</b> pides ${radio} km y ${maxOsm
      ? `solo hay ${maxOsm} km descargados` : "no hay nada descargado"}; ${modo === "offline"
      ? "sin red el resultado saldra vacio. Elige <b>En vivo</b> para descargar ese radio."
      : "se consultara la red para cubrirlo."}</span>`;
  } else if (modo === "offline" && maxOsm && radio < maxOsm) {
    texto += ` Con ${radio} km se recorta la descarga de ${maxOsm} km.`;
  }
  $("que-pasara").innerHTML = texto;
}

function nombreFuente(codigo) {
  return estado.config.fuentes.find((f) => f.codigo === codigo)?.nombre || codigo;
}

const RADIO_MAX_KM = 40;

/** Deja el radio dentro de [0,5; 40] y avisa si hubo que recortarlo. */
function radioPedido() {
  const campo = $("radio-km");
  const pedido = parseFloat(campo.value) || 8;
  const valido = Math.max(0.5, Math.min(RADIO_MAX_KM, pedido));
  if (valido !== pedido) {
    campo.value = valido;
    $("radio-nota").textContent = pedido > RADIO_MAX_KM
      ? `El maximo es ${RADIO_MAX_KM} km: mas alla la conduccion no compite con captar agua cruda y la consulta a OpenStreetMap se vuelve inviable.`
      : `El minimo es 0,5 km.`;
  } else {
    $("radio-nota").textContent = "";
  }
  return valido;
}

async function ejecutarBarrido() {
  const boton = $("btn-barrido");
  const modo = modoElegido();
  const pedido = parseFloat($("radio-km").value) || 8;
  estado.radio = radioPedido();
  boton.disabled = true; boton.textContent = "Consultando…";
  $("paso1-estado").innerHTML = chip("en curso", "azul");
  anotar(`Barrido iniciado (<b>${NOMBRE_MODO[modo] || modo}</b>), radio ${estado.radio} km`, "acento",
    pedido !== estado.radio ? `pediste ${pedido} km; el tope es ${RADIO_MAX_KM} km` : "");
  const t0 = performance.now();
  try {
    const d = await cargarBarrido({ refrescar: true, modo });
    // Un barrido en vivo deja una descarga nueva: se vuelve a leer que hay.
    try { estado.config = await pedir("/api/scout/estado"); } catch { /* sin consecuencias */ }
    for (const f of d.fuentes) {
      const nombre = nombreFuente(f.fuente);
      if (f.registros) {
        anotar(`<b>${escapar(nombre)}</b>: ${f.registros} registros`, f.origen === "red" ? "ok" : "azul",
          (f.origen === "cache" ? `consulta disponible${f.fecha_dato ? " del " + fechaCorta(f.fecha_dato) : ""}` : "consultados ahora")
          + (f.nota ? ` · ${escapar(f.nota)}` : ""));
      } else {
        const maxOsm = radioDescargado();
        anotar(`<b>${escapar(nombre)}</b>: sin datos`, "aviso",
          f.fuente === "osm" && modo !== "vivo" && estado.radio > maxOsm
            ? `no hay descarga que cubra ${estado.radio} km (maximo descargado: ${maxOsm || 0} km). Repite el barrido en modo En vivo.`
            : escapar(breve(f.incidencia)));
      }
    }
    const pv = d.permisos || {};
    if (pv.total) {
      anotar(`<b>VITAL</b>: ${pv.total} permisos de vertimiento en Cartagena`, pv.origen === "red" ? "ok" : "azul",
        `${pv.cruzados} coinciden por razon social con prospectos del barrido` +
        (pv.origen === "cache" && pv.fecha_dato ? ` · consulta del ${fechaCorta(pv.fecha_dato)}` : ""));
    } else {
      anotar("<b>VITAL</b>: sin permisos disponibles en este modo", "aviso");
    }
    const r = d.resumen;
    anotar(`Fusion y caracterizacion: <b>${r.detectados} prospectos</b>`, "ok",
      `${r.descartados_sin_arquetipo} registros descartados por no poder estimar su efluente (no se inventa agua)`);
    anotar(`Puntaje calculado: ${r.viables} con simbiosis viable, ${r.promovibles} superan el umbral de confianza ${estado.config.umbral_promocion}`, "ok",
      `${((performance.now() - t0) / 1000).toFixed(1)} s en total`);
  } catch (e) {
    anotar(`Error en el barrido: ${escapar(e.message)}`, "alerta");
    $("paso1-estado").innerHTML = chip("fallo", "alerta");
  } finally {
    boton.disabled = false; boton.textContent = "Actualizar catalogo";
  }
}

// ---------------------------------------------------------------------------
// Paso 2: permisos de vertimiento
// ---------------------------------------------------------------------------

function refsVital(p) {
  return (p.referencias || []).filter((r) => r.fuente === "vital");
}

function solicitudDe(p, ref) {
  const autoridad = (ref.descripcion.split(" ante ")[1] || "").split(" - ")[0];
  return textoSolicitud({ empresa: p.nombre, autoridad, expediente: ref.identificador });
}

let solicitudAbierta = null;

function pintarPermisos() {
  const b = estado.barrido;
  if (!b) {
    $("permisos-resumen").innerHTML = `<p class="pie">Ejecuta el barrido del paso 1 para cruzar los permisos.</p>`;
    $("permisos-tabla").innerHTML = "";
    $("paso2-estado").innerHTML = chip("pendiente", "neutra");
    return;
  }
  const con = b.prospectos.filter(tienePermiso);
  const pv = b.permisos || {};
  $("paso2-estado").innerHTML = chip(`${con.length} empresas con expediente`, con.length ? "ok" : "aviso");
  $("paso2-num").className = "paso-num " + (con.length ? "hecho" : "pendiente");
  $("permisos-resumen").innerHTML = `<p class="pie" style="margin-bottom:10px">
    De <b>${pv.total || 0}</b> permisos de vertimiento radicados en Cartagena, <b>${con.length}</b> coinciden
    por razon social con prospectos del barrido. Su confianza sube y ya se sabe a quien y que pedir.</p>`;

  if (!con.length) { $("permisos-tabla").innerHTML = ""; return; }
  const filas = con.map((p) => {
    const refs = refsVital(p);
    const r = refs[0];
    const abierta = solicitudAbierta === p.clave;
    return `<tr class="clicable${abierta ? " seleccionada" : ""}" data-clave="${p.clave}">
      <td><b>${escapar(p.nombre)}</b><span class="sub">${escapar(p.sector)}</span></td>
      <td>${escapar(r.descripcion.split(" - ")[0])}<span class="sub">${refs.length > 1 ? refs.length + " tramites" : ""}</span></td>
      <td><code>${escapar(r.identificador)}</code></td>
      <td>${barraConfianza(p)}</td>
      <td class="num"><button class="secundario pequeno btn-solicitud">${abierta ? "Cerrar" : "Redactar solicitud"}</button></td>
    </tr>` + (abierta ? `<tr><td colspan="5" style="padding:0 8px 12px">
      <textarea rows="14" readonly id="texto-solicitud">${escapar(solicitudDe(p, r))}</textarea>
      <div class="acciones">
        <button class="pequeno" id="btn-copiar-solicitud">Copiar al portapapeles</button>
        <span class="pie" style="margin:0">Rellena los corchetes antes de enviarla. Cita siempre el numero de expediente.</span>
      </div></td></tr>` : "");
  }).join("");
  $("permisos-tabla").innerHTML = `<table>
    <thead><tr><th>Empresa</th><th>Tramite y autoridad</th><th>Expediente</th><th>Confianza</th><th></th></tr></thead>
    <tbody>${filas}</tbody></table>`;

  $("permisos-tabla").querySelectorAll(".btn-solicitud").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      const clave = ev.target.closest("tr").dataset.clave;
      solicitudAbierta = solicitudAbierta === clave ? null : clave;
      pintarPermisos();
    });
  });
  $("btn-copiar-solicitud")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("texto-solicitud").value);
      anotar("Texto de la solicitud copiado al portapapeles", "ok");
    } catch {
      $("texto-solicitud").select();
      anotar("No se pudo acceder al portapapeles: el texto queda seleccionado para copiarlo a mano", "aviso");
    }
  });
}

// ---------------------------------------------------------------------------
// Paso 3: documentos del expediente
// ---------------------------------------------------------------------------

let archivoActual = null;

function pintarEstadoIA() {
  const ia = estado.config.extraccion_ia;
  $("paso3-estado").innerHTML = ia.disponible
    ? chip(`IA disponible · ${ia.modelo}`, "ok")
    : chip("archivo de evidencia habilitado", "neutra");
}

function pintarDocumento() {
  const caja = $("documento-caja");
  if (!archivoActual) { caja.innerHTML = ""; return; }
  const ia = estado.config.extraccion_ia;
  const prospectos = [...(estado.barrido?.prospectos || [])].sort((a, b) => a.nombre.localeCompare(b.nombre));
  caja.innerHTML = `<div class="documento">
    <div class="nombre">${escapar(archivoActual.name)}
      ${chip(`${(archivoActual.size / 1e6).toFixed(2)} MB`, "neutra")}
      ${archivoActual.type === "application/pdf" || archivoActual.name.toLowerCase().endsWith(".pdf") ? "" : chip("no parece un PDF", "aviso")}
    </div>
    <div>
      <label>Empresa a la que pertenece</label>
      <select id="doc-empresa">
        <option value="">— sin asociar —</option>
        ${prospectos.map((p) => `<option value="${p.clave}">${escapar(p.nombre)}</option>`).join("")}
      </select>
    </div>
    <div>
      <label>Numero de expediente</label>
      <input type="text" id="doc-expediente" placeholder="p. ej. 1070860522056225001">
    </div>
    <div class="acciones">
      <button class="secundario" id="btn-archivar">Archivar en el expediente</button>
      <button id="btn-leer-ia" ${ia.disponible ? "" : `disabled title="${escapar(ia.motivo)}"`}>Leer con IA</button>
      <button class="secundario pequeno" id="btn-doc-quitar">Quitar</button>
      ${ia.disponible ? "" : `<span class="pie" style="margin:0">${escapar(ia.motivo)}</span>`}
    </div>
  </div>`;

  $("doc-empresa").addEventListener("change", (ev) => {
    const p = prospectos.find((x) => x.clave === ev.target.value);
    const ref = p ? refsVital(p)[0] : null;
    if (ref && !$("doc-expediente").value) $("doc-expediente").value = ref.identificador;
  });
  $("btn-doc-quitar").addEventListener("click", () => { archivoActual = null; pintarDocumento(); $("documento-resultado").innerHTML = ""; });
  $("btn-archivar").addEventListener("click", archivar);
  $("btn-leer-ia").addEventListener("click", leerConIA);
}

function leerBase64(archivo) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1]);
    fr.onerror = rej;
    fr.readAsDataURL(archivo);
  });
}

function empresaElegida() {
  const sel = $("doc-empresa");
  return sel.value ? sel.options[sel.selectedIndex].text : "";
}

async function archivar() {
  const btn = $("btn-archivar"); btn.disabled = true;
  const empresa = empresaElegida(), expediente = $("doc-expediente").value.trim();
  anotar(`Archivando <b>${escapar(archivoActual.name)}</b>${empresa ? " para " + escapar(empresa) : ""}…`, "azul");
  try {
    const d = await pedir("/api/scout/ingestar", {
      nombre: archivoActual.name, contenido_b64: await leerBase64(archivoActual), empresa, expediente,
    });
    $("documento-resultado").innerHTML = `<div class="ok-caja" style="margin-top:12px">
      <b>Archivado.</b> ${fmt.num(d.bytes)} bytes guardados en <code>${escapar(d.guardado.split("/scout/").pop())}</code>
      ${d.es_pdf ? "" : " · <b>atencion:</b> el contenido no empieza como un PDF"}
      ${empresa ? `<br>Asociado a ${escapar(empresa)}${expediente ? ", expediente " + escapar(expediente) : ""}.` : ""}
    </div>`;
    anotar(`Documento archivado (${fmt.num(d.bytes)} bytes)`, "ok", d.es_pdf ? "" : "el contenido no parece un PDF");
    $("paso3-num").className = "paso-num hecho";
  } catch (e) {
    $("documento-resultado").innerHTML = `<div class="error" style="margin-top:12px">${escapar(e.message)}</div>`;
    anotar(`Error al archivar: ${escapar(e.message)}`, "alerta");
  } finally { btn.disabled = false; }
}

async function leerConIA() {
  const btn = $("btn-leer-ia"); btn.disabled = true; btn.textContent = "Leyendo…";
  const salida = $("documento-resultado");
  salida.innerHTML = `<p class="cargando">Enviando el PDF al modelo y validando la salida contra el esquema…</p>`;
  anotar(`Leyendo <b>${escapar(archivoActual.name)}</b> con ${estado.config.extraccion_ia.modelo}…`, "azul");
  try {
    const d = await pedir("/api/scout/extraer", {
      nombre: archivoActual.name, contenido_b64: await leerBase64(archivoActual),
    });
    if (!d.disponible) {
      salida.innerHTML = `<div class="error" style="margin-top:12px">${escapar(d.error)}</div>`;
      anotar(`La lectura no se pudo completar: ${escapar(d.error)}`, "alerta");
      return;
    }
    const p = d.permiso;
    const params = Object.entries(d.calidad_parcial).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
    const infos = Object.entries(d.informativos).map(([k, v]) => `<dt>${escapar(k)}</dt><dd>${v}</dd>`).join("");
    salida.innerHTML = `
      <div class="ok-caja" style="margin-top:12px">
        <b>${escapar(p.razon_social || "Titular no legible")}</b>
        ${p.expediente ? ` · exp. ${escapar(p.expediente)}` : ""}${p.autoridad ? ` · ${escapar(p.autoridad)}` : ""}<br>
        Caudal autorizado: <b>${d.caudal_m3_h ?? "—"} m³/h</b>
        ${p.cuerpo_receptor ? ` · vertido a ${escapar(p.cuerpo_receptor)}` : ""}
        ${p.vigencia_hasta ? ` · vigente hasta ${escapar(p.vigencia_hasta)}` : ""}
        · lectura con confianza <b>${(p.confianza ?? 0).toFixed(2)}</b>
      </div>
      <div class="rejilla dos" style="margin-top:12px">
        <div>
          <h4 style="margin:0 0 6px;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--texto-tenue)">
            Parametros que entran al modelo ${sello("declarado")}</h4>
          <dl class="pares">${params || "<dt>—</dt><dd>ninguno reconocido</dd>"}</dl>
        </div>
        <div>
          <h4 style="margin:0 0 6px;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--texto-tenue)">
            Informativos y sin mapear</h4>
          <dl class="pares">${infos || "<dt>—</dt><dd>ninguno</dd>"}</dl>
          ${d.no_reconocidos.length ? `<p class="pie">Sin mapear: ${escapar(d.no_reconocidos.join(", "))}</p>` : ""}
        </div>
      </div>
      ${p.observaciones ? `<p class="pie">Observaciones del modelo: ${escapar(p.observaciones)}</p>` : ""}`;
    anotar(`Lectura completada: ${Object.keys(d.calidad_parcial).length} parametros reconocidos, caudal ${d.caudal_m3_h ?? "no legible"} m³/h`, "ok",
      "lo extraido se muestra para confirmar; no modifica ningun prospecto por si solo");
    $("paso3-num").className = "paso-num hecho";
  } catch (e) {
    salida.innerHTML = `<div class="error" style="margin-top:12px">${escapar(e.message)}</div>`;
    anotar(`Error en la lectura: ${escapar(e.message)}`, "alerta");
  } finally { btn.disabled = false; btn.textContent = "Leer con IA"; }
}

function elegirArchivo(archivo) {
  if (!archivo) return;
  archivoActual = archivo;
  $("documento-resultado").innerHTML = "";
  pintarDocumento();
  anotar(`Documento seleccionado: <b>${escapar(archivo.name)}</b> (${(archivo.size / 1e6).toFixed(2)} MB)`, "neutra");
}

// ---------------------------------------------------------------------------
// Bitacora
// ---------------------------------------------------------------------------

function pintarBitacora(lineas) {
  const caja = $("bitacora");
  if (!lineas.length) { caja.innerHTML = `<p class="vacia">Todavia no se ha ejecutado nada.</p>`; return; }
  caja.innerHTML = lineas.map((l) => `<div class="linea">
    <span class="hora">${l.hora}</span><span class="ico ${l.tono}"></span>
    <span class="txt">${l.texto}${l.sub ? `<span class="sub">${l.sub}</span>` : ""}</span>
  </div>`).join("");
  caja.scrollTop = caja.scrollHeight;
}

// ---------------------------------------------------------------------------

function pintarTodo() {
  pintarFuentes();
  pintarPermisos();
  pintarEstadoIA();
  pintarDocumento();
}

export default {
  id: "datos",
  async montar() {
    document.querySelectorAll("#modo-opciones input").forEach((inp) => {
      inp.checked = inp.value === estado.config.modo;
      inp.addEventListener("change", () => {
        document.querySelectorAll("#modo-opciones label").forEach((l) =>
          l.classList.toggle("activo", l.querySelector("input").checked));
        pintarQuePasara();
      });
    });
    document.querySelectorAll("#modo-opciones label").forEach((l) =>
      l.classList.toggle("activo", l.querySelector("input").checked));
    $("radio-km").value = estado.radio;
    $("radio-km").addEventListener("input", pintarQuePasara);
    $("radio-km").addEventListener("change", () => { radioPedido(); pintarQuePasara(); });
    $("btn-barrido").addEventListener("click", ejecutarBarrido);
    $("btn-bitacora-limpiar").addEventListener("click", limpiarBitacora);
    bus.on("bitacora", pintarBitacora);
    bus.on("barrido", pintarTodo);

    const zona = $("zona-pdf"), campo = $("archivo-pdf");
    zona.addEventListener("click", () => campo.click());
    campo.addEventListener("change", () => elegirArchivo(campo.files[0]));
    ["dragenter", "dragover"].forEach((ev) =>
      zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.add("encima"); }));
    ["dragleave", "drop"].forEach((ev) =>
      zona.addEventListener(ev, (e) => { e.preventDefault(); zona.classList.remove("encima"); }));
    zona.addEventListener("drop", (e) => elegirArchivo(e.dataTransfer.files[0]));

    pintarBitacora(bitacora());
    pintarTodo();
    if (!estado.barrido) {
      anotar(`Cargando el ultimo barrido conocido…`, "neutra");
      try {
        const d = await cargarBarrido();
        anotar(`${d.resumen.detectados} prospectos cargados en la aplicacion`, "ok",
          "para volver a consultar las fuentes, elige un modo y pulsa Ejecutar barrido");
      } catch (e) {
        anotar(`No se pudo cargar el barrido: ${escapar(e.message)}`, "alerta");
      }
    }
  },
};
