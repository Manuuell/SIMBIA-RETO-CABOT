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
import datos from "./modulos/datos.js";
import vital from "./modulos/vital.js";
import prospectos from "./modulos/prospectos.js";
import empresas from "./modulos/empresas.js";
import embudo from "./modulos/embudo.js";
import optimizador from "./modulos/optimizador.js";
import operacion from "./modulos/operacion.js";
import modelo from "./modulos/modelo.js";

const MODULOS = { inicio, datos, vital, prospectos, empresas, embudo, optimizador, operacion, asistente, modelo };
const montados = new Set();
let actual = null;

async function mostrar(id) {
  const mod = MODULOS[id] || MODULOS.inicio;
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
    const [config, escenario, oferentes, salud, sesion] = await Promise.all([
      pedir("/api/scout/estado"), pedir("/api/escenario"), pedir("/api/oferentes"), pedir("/salud"),
      pedir("/api/sesion"),
    ]);
    estado.config = config; estado.escenario = escenario; estado.oferentes = oferentes;
    estado.radio = config.radio_km;
    $("pie-modo").innerHTML = `Modo de fuentes: <b>${escapar(config.modo)}</b>`;
    $("pie-version").textContent = `SIMBIA v${salud.version}`;
    if (sesion.autenticacion) {
      $("pie-sesion").innerHTML = `<b>${escapar(sesion.usuario || "")}</b>
        <button class="secundario pequeno" id="btn-salir">Salir</button>`;
      $("btn-salir").addEventListener("click", async () => {
        await fetch("/api/salir", { method: "POST" });
        location.replace("/acceso");
      });
    }
  } catch (e) {
    document.querySelector("main").insertAdjacentHTML("afterbegin",
      `<div class="error">No se pudo hablar con la API: ${escapar(e.message)}</div>`);
    return;
  }
  window.addEventListener("hashchange", enrutar);
  enrutar();
}

arrancar();
