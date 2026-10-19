/* SIMBIA - arranque y enrutado por modulos.
 *
 * Cada modulo exporta { id, montar(), mostrar() }. `montar` se ejecuta una
 * vez, la primera vez que se visita; `mostrar` cada vez que se entra. Asi la
 * pagina arranca rapido y las partes pesadas (frontera, contingencias) solo
 * se calculan si alguien las mira.
 */

import { $, estado, pedir, escapar } from "./comun.js";
import asistente from "./modulos/asistente.js";
import inicio from "./modulos/inicio.js";
import prospeccion from "./modulos/prospeccion.js";
import embudo from "./modulos/embudo.js";
import optimizador from "./modulos/optimizador.js";
import operacion from "./modulos/operacion.js";
import modelo from "./modulos/modelo.js";
import simulador from "./modulos/simulador.js";
import administracion from "./modulos/administracion.js";

const MODULOS = { inicio, prospeccion, embudo, optimizador, operacion, simulador, asistente, modelo, administracion };
// Las cuatro pantallas de prospeccion son ahora una sola. Sus enlaces siguen
// valiendo: llevan a Vecinos, y Vecinos abre lo que cada uno pedia.
const ALIAS = { datos: "prospeccion", vital: "prospeccion", prospectos: "prospeccion", empresas: "prospeccion" };
const montados = new Set();
let actual = null;

async function mostrar(id) {
  const mod = MODULOS[ALIAS[id] || id] || MODULOS.inicio;
  id = mod.id;
  document.querySelectorAll(".modulo").forEach((s) => s.classList.toggle("activo", s.id === `mod-${id}`));
  document.querySelectorAll("#nav-modulos a").forEach((a) =>
    a.classList.toggle("activo", a.dataset.modulo === id));
  window.scrollTo({ top: 0 });
  actual = id;
  try {
    if (!montados.has(id)) { montados.add(id); await mod.montar(); }
    await mod.mostrar?.();
  } catch (e) {
    const sec = $(`mod-${id}`);
    sec.insertAdjacentHTML("afterbegin", `<div class="error" style="margin-bottom:14px">${escapar(e.message)}</div>`);
  }
}

function enrutar() {
  const id = (location.hash || "#inicio").slice(1).split("?")[0];
  if (id !== actual) mostrar(id);
}

async function arrancar() {
  try {
    const [config, escenario, oferentes, sesion] = await Promise.all([
      pedir("/api/scout/estado"), pedir("/api/escenario"), pedir("/api/oferentes"), pedir("/api/sesion"),
    ]);
    estado.config = config; estado.escenario = escenario; estado.oferentes = oferentes;
    estado.sesion = sesion;
    estado.radio = config.radio_km;
    // El asistente siempre esta en el menu; sin clave, su pantalla lo explica.
    if (sesion.autenticacion) {
      const enlaceAdmin = document.querySelector('[data-modulo="administracion"]');
      if (enlaceAdmin) enlaceAdmin.hidden = !sesion.administrador;
      if ($("grupo-administracion")) $("grupo-administracion").hidden = !sesion.administrador;
      $("pie-sesion").innerHTML = `<span class="sesion-identidad"><b>${escapar(sesion.nombre || sesion.usuario || "")}</b>
        ${sesion.nombre ? `<small>${escapar(sesion.usuario || "")}</small>` : ""}</span>
        ${sesion.administrador ? '<a class="secundario pequeno" href="#administracion">Administrar</a>' : ""}
        <button class="secundario pequeno" id="btn-salir">Salir</button>`;
      $("btn-salir").addEventListener("click", async () => {
        await fetch("/api/salir", { method: "POST" });
        location.replace("/");
      });
    }
  } catch (e) {
    document.querySelector("main").insertAdjacentHTML("afterbegin",
      `<div class="error">No se pudo cargar la plataforma: ${escapar(e.message)}</div>`);
    return;
  }
  window.addEventListener("hashchange", enrutar);
  enrutar();
}

arrancar();
