/* Inicio: evidencia documental antes de atribuir ahorros a Cabot. */

import { $, bus, cargarBarrido, chip, escapar, estado, fmt, pedir } from "../comun.js";


function pintarAcciones() {
  const b = estado.barrido;
  const ia = Boolean(estado.config?.extraccion_ia?.disponible);
  const radio = estado.radio ? ` a menos de ${fmt.num(estado.radio)} km` : "";
  const vecinos = b
    ? `${b.resumen.detectados} empresas${radio}; ${b.resumen.viables} preseleccionadas por el modelo, pendientes de validación.`
    : "Las empresas alrededor de la planta, con su agua de rechazo y sus expedientes.";
  const acciones = [
    { href: "#prospeccion", n: "01", t: "Ver los vecinos", d: vecinos, ir: "Abrir Vecinos" },
    { href: "#simulador", n: "02", t: "Probarlo en el gemelo",
      d: "Explora supuestos de caudal, ciclos y tratamiento. El resultado no acredita un ahorro real.", ir: "Abrir el gemelo" },
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

const PARAMETROS = [
  ["ph", "pH"], ["t_c", "Temperatura"], ["alcalinidad", "Alcalinidad"],
  ["dureza_ca", "Dureza cálcica"], ["dqo", "DQO"], ["sst", "Sólidos suspendidos"],
  ["hierro", "Hierro total"], ["n_amoniacal", "Nitrógeno amoniacal"],
  ["fosforo_reactivo", "Fósforo reactivo"], ["sulfatos", "Sulfatos"],
  ["tds", "Sólidos disueltos (TDS)"], ["cloruros", "Cloruros"], ["silice", "Sílice"],
];

function enlaceFuente(d, texto = `PDF · p. ${d.pagina_pdf}`) {
  return `<a href="/api/scout/evidencia/documentos/${encodeURIComponent(d.documento)}#page=${d.pagina_pdf}"
    target="_blank" rel="noopener">${escapar(texto)}</a>`;
}

function dato(d) {
  if (!d) return '<span class="sub">Sin dato verificado</span>';
  const valor = Array.isArray(d.valor) ? d.valor.map(v => fmt.num(v, 2)).join("–") : fmt.num(d.valor, Math.min(3, (String(d.valor).split(".")[1] || "").length));
  return `<b>${d.calificador === "<" ? "&lt; " : ""}${valor}${d.calificador === "*" ? "*" : ""}</b>
    ${escapar(d.unidad)}<small>${escapar(d.estadistico)} · ${enlaceFuente(d)}</small>
    ${d.nota ? `<small>${escapar(d.nota)}</small>` : ""}`;
}

const CRITERIOS = { desplazamiento: "agua cruda que podría sustituir", ciclos: "ciclos alcanzables", distancia: "cercanía a Cabot", tratamiento: "costo del tratamiento", incentivo: "incentivo económico estimado" };

function tarjetaSeleccion(c, r) {
  const e = c.evaluacion;
  const fuertes = Object.entries(e.desglose_inicial).sort((a,b) => b[1]-a[1]).slice(0,2).map(([k]) => CRITERIOS[k]);
  const toma = r.cruce.resultado?.tomas.find(t => t.fuente_id === c.id);
  return `<article class="ini-evidencia">
    <div class="ini-candidato-cab"><div><p class="ini-paso">PUESTO ${e.puesto_inicial} DE ${r.barrido.total}</p><h3>${escapar(c.empresa)}</h3></div>
      <div class="ini-score"><strong>${fmt.num(e.puntaje_inicial,1)}</strong><span>/100 · puntaje inicial</span></div></div>
    <p class="ini-razon">Destaca por ${escapar(fuertes.join(" y "))}.</p>
    <p class="sub">${fmt.num(e.distancia_km,1)} km de conducción estimada · puntaje tras incorporar documentos: <b>${fmt.num(e.puntaje_documentado,1)}/100</b></p>
    <div class="ini-hallazgo"><span class="ini-paso">02 · LO QUE ENCONTRAMOS EN SUS DOCUMENTOS</span>
      <p><b>${escapar(c.punto)}</b> · ${escapar(c.muestreo)}</p>
      <div class="ini-hallazgo-datos"><div><strong>${fmt.num(c.caudal.m3_h,2)}</strong><span>m³/h · caudal medido</span></div>
      <div><strong>${fmt.num(c.calidad.dqo.valor,2)}</strong><span>mg O₂/L · DQO</span></div>
      <div><strong>${fmt.num(c.calidad.sst.valor,2)}</strong><span>mg/L · sólidos suspendidos</span></div></div>
      <p>${enlaceFuente(c.caudal,"Ver caracterización")} · ${enlaceFuente(c.permiso,"Ver antecedente del permiso")}</p>
      <p class="pie">${escapar(c.id.startsWith("mexichem") ? "La solicitud cita renovación 0252/2022 y vencimiento declarado 17/03/2027." : "EPA confirma el antecedente de renovación 00218/2022. El laboratorio registra 64,43 mg/L de nitrógeno amoniacal.")}</p>
    </div>
    <p><b>Tratamiento en la mezcla evaluada:</b> ${escapar(toma?.tren_nombre || "Sin aporte seleccionado por el modelo")}</p>
    <details><summary>Por qué cambió el puntaje y alcance de la evidencia</summary>
      <p>El puntaje inicial utiliza el catálogo de prospección. La reevaluación sustituye el caudal y los parámetros que sí aparecen en la caracterización de esta corriente.</p>
      <p>${escapar(c.permiso.detalle)}</p><ul>${[...c.faltantes, ...c.observaciones].map(x => `<li>${escapar(x)}</li>`).join("")}</ul>
    </details>
  </article>`;
}

function pintarCruce(r) {
  const c = r.cruce, o = c.resultado;
  const valido = o?.factible;
  return `<div class="ini-cruce-cab"><div><p class="ini-paso">03 · CRUCE CON LA TORRE DE CABOT</p>
    <h2>${valido ? "Las dos corrientes tienen una combinación factible en el modelo" : "El cruce requiere ajustar la combinación"}</h2></div>
    ${chip(valido ? "Viabilidad preliminar" : "Revisar combinación", valido ? "neutra" : "alerta")}</div>
    ${valido ? `<div class="ini-cruce-metricas">
      <div><strong>${fmt.num(o.ahorro_pct*100,1)} %</strong><span>reducción simulada del consumo total</span></div>
      <div><strong>${fmt.num(o.reuso_m3_h,1)} m³/h</strong><span>aporte tratado de las dos empresas</span></div>
      <div><strong>${fmt.num(o.base.ciclos,1)} → ${fmt.num(o.ciclos,1)}</strong><span>ciclos de la torre en régimen</span></div></div>
      <p>Con los tratamientos propuestos, la reposición de agua cruda pasa de <b>${fmt.num(o.base.reposicion_m3_h,1)}</b> a <b>${fmt.num(o.agua_cruda_m3_h,1)} m³/h</b> en el escenario calculado.</p>
      <div class="ini-tomas">${o.tomas.map(t => `<div><b>${escapar(t.nombre)}</b><span>${fmt.num(t.caudal_m3_h,2)} m³/h tratados</span><small>${escapar(t.tren_nombre)}</small></div>`).join("")}</div>`
      : `<p>${escapar(c.motivo || o?.motivo || "No se encontró una mezcla factible con las entradas actuales.")}</p>`}
    <p class="ini-alcance"><b>Alcance:</b> caracterizaciones reales + parámetros faltantes del catálogo + torre de referencia.
      El caudal de campaña se usa como techo hipotético de suministro. El resultado es simulado y debe calibrarse con datos de Cabot.</p>
    <div class="ini-cruce-accion"><button id="inicio-abrir-gemelo" ${valido ? "" : "disabled"}>Probar estas dos empresas en el gemelo →</button>
      <span class="pie">Carga estas fuentes, tratamientos y caudales en un escenario nuevo. Puedes ajustar la torre y observar su respuesta.</span></div>
    <details><summary>Ver entradas, supuestos y datos para la siguiente validación</summary>
      <p>Referencia de Cabot: ${fmt.num(c.planta_referencia.consumo_total_m3_dia)} m³/d de consumo total; ${fmt.num(c.planta_referencia.caudal_circulacion_m3_h)} m³/h de circulación; ΔT ${fmt.num(c.planta_referencia.delta_t_c,1)} °C.</p>
      ${r.candidatos.map(x => `<p><b>${escapar(x.empresa)} — valores estimados para completar el modelo:</b> ${Object.entries(x.evaluacion.complemento_modelo).map(([k,v]) => `${escapar(k)}: ${fmt.num(v,2)}`).join(" · ")}</p>
        ${Object.entries(x.evaluacion.hipotesis).map(([k,v]) => `<p>${escapar(k)}: ${escapar(v)}</p>`).join("")}`).join("")}
      <ul>${r.pendientes_cabot.map(x => `<li>${escapar(x)}</li>`).join("")}</ul>
    </details>`;
}

async function pintarEvidencia() {
  try {
    const r = await pedir(`/api/scout/evidencia/evaluacion?radio_km=${estado.radio || 8}`);
    $("inicio-titular").textContent = `De ${r.barrido.total} empresas evaluadas, dos candidatas para Cabot`;
    $("inicio-bajada").textContent = "Priorizamos Mexichem y Yara por su puntaje y la evidencia recuperada de sus expedientes. Incorporamos sus caracterizaciones y evaluamos la combinación en el modelo de la torre.";
    $("inicio-resultado").innerHTML = `<p class="ini-paso">01 · DE LA PROSPECCIÓN A LA SELECCIÓN</p>
      <div class="ini-embudo"><div><strong>${r.barrido.total}</strong><span>empresas evaluadas</span></div><i>→</i>
      <div><strong>${r.barrido.con_potencial}</strong><span>con potencial según el modelo</span></div><i>→</i>
      <div><strong>${r.candidatos.length}</strong><span>priorizadas con caracterización</span></div></div>
      <p>La selección combina posición en el ranking y documentos disponibles. El puntaje evalúa sustitución de agua cruda, ciclos, distancia, tratamiento e incentivo económico, ajustados por confianza.</p>
      <details class="ini-ranking"><summary>Ver ranking de las ${r.barrido.total} empresas y criterios</summary>
        <p>${Object.entries(r.barrido.pesos).map(([k,v]) => `${escapar(CRITERIOS[k])}: ${v} %`).join(" · ")}</p>
        <div class="ini-tabla-scroll"><table><thead><tr><th>Puesto</th><th>Empresa</th><th>Puntaje inicial /100</th></tr></thead>
          <tbody>${r.barrido.ranking.map(p => `<tr><td>${p.puesto}</td><td>${escapar(p.empresa)}</td><td>${fmt.num(p.puntaje || 0,1)}</td></tr>`).join("")}</tbody></table></div>
      </details>
      <div class="ini-evidencias">${r.candidatos.map(c => tarjetaSeleccion(c,r)).join("")}</div>`;
    $("inicio-mezcla").innerHTML = pintarCruce(r) + `
      <details class="ini-anexo"><summary>Comparar la caracterización completa y consultar los originales</summary>
        <p>Promedios publicados salvo indicación distinta. Cada columna conserva su punto y fecha de muestreo.</p>
        <div class="ini-tabla-scroll"><table class="ini-tabla-evidencia"><thead><tr><th>Parámetro</th>${r.candidatos.map(c => `<th>${escapar(c.empresa)}</th>`).join("")}</tr></thead>
          <tbody>${PARAMETROS.map(([k,n]) => `<tr><th>${n}</th>${r.candidatos.map(c => `<td>${dato(c.calidad[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
        <ul>${Object.entries(r.documentos).map(([id,d]) => `<li>${enlaceFuente({documento:id,pagina_pdf:1},d.titulo)} · <a href="${escapar(d.url)}" target="_blank" rel="noopener">Fuente pública</a><small class="ini-huella">SHA-256: ${escapar(d.sha256)}</small></li>`).join("")}</ul>
      </details>`;
    $("inicio-abrir-gemelo").addEventListener("click", () => {
      estado.escenarioEvidenciaPendiente = r.cruce;
      location.hash = "simulador?caso=evidencia";
    });
  } catch (e) {
    $("inicio-titular").textContent = "No se pudo completar la evaluación";
    $("inicio-bajada").textContent = "Reintenta para consultar el ranking, la evidencia y el cruce con la torre.";
    $("inicio-resultado").innerHTML = `<p class="error">${escapar(e.message)}</p><button id="inicio-reintentar">Reintentar</button>`;
    $("inicio-mezcla").textContent = "El resultado del cruce no está disponible.";
    $("inicio-reintentar").addEventListener("click", pintarEvidencia);
  }
}

export default {
  id: "inicio",
  async montar() {
    pintarAcciones();
    bus.on("barrido", pintarAcciones);
    if (!estado.barrido) cargarBarrido().catch(() => {});
    await pintarEvidencia();
  },
};
