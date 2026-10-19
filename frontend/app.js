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
import cuenta from "./modulos/cuenta.js";

const MODULOS = { inicio, prospeccion, embudo, optimizador, operacion, simulador, asistente, modelo, administracion, cuenta };
// Las cuatro pantallas de prospeccion son ahora una sola. Sus enlaces siguen
// valiendo: llevan a Vecinos, y Vecinos abre lo que cada uno pedia.
const ALIAS = { datos: "prospeccion", vital: "prospeccion", prospectos: "prospeccion", empresas: "prospeccion" };
const montados = new Set();
let actual = null;

async function mostrar(id) {
  if (id === "administracion" && !estado.sesion?.administrador) id = "cuenta";
  const mod = MODULOS[ALIAS[id] || id] || MODULOS.inicio;
  id = mod.id;
  document.querySelectorAll(".modulo").forEach((s) => s.classList.toggle("activo", s.id === `mod-${id}`));
  document.querySelectorAll("#nav-modulos a").forEach((a) =>
    a.classList.toggle("activo", a.dataset.modulo === id));
  document.querySelectorAll("[data-cuenta-modulo]").forEach((a) =>
    a.classList.toggle("activo", a.dataset.cuentaModulo === id));
  $("menu-cuenta")?.classList.remove("abierto");
  $("btn-cuenta")?.setAttribute("aria-expanded", "false");
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
      const nombre = sesion.nombre || sesion.usuario?.split("@")[0] || "Cuenta";
      $("pie-sesion").innerHTML = `
        <div class="cuenta-menu" id="menu-cuenta">
          <div class="cuenta-menu-cab">
            <span class="cuenta-avatar">${escapar(nombre[0].toUpperCase())}</span>
            <span><b>${escapar(nombre)}</b><small>${escapar(sesion.usuario || "")}</small></span>
          </div>
          <a href="#cuenta" data-cuenta-modulo="cuenta"><span>○</span><span><b>Mi cuenta</b><small>Identidad y sesión</small></span></a>
          ${sesion.administrador ? '<a href="#administracion" data-cuenta-modulo="administracion"><span>◇</span><span><b>Administración</b><small>Usuarios y accesos</small></span></a>' : ""}
          <button type="button" id="btn-salir"><span>↪</span><span><b>Cerrar sesión</b><small>Volver a la portada</small></span></button>
        </div>
        <button type="button" class="cuenta-disparador" id="btn-cuenta" aria-haspopup="menu" aria-expanded="false">
          <span class="cuenta-avatar">${escapar(nombre[0].toUpperCase())}</span>
          <span class="cuenta-disparador-id"><b>${escapar(nombre)}</b><small>${escapar(sesion.usuario || "")}</small></span>
          <span class="cuenta-hamburguesa" aria-hidden="true"><i></i><i></i><i></i></span>
        </button>`;
      $("btn-cuenta").addEventListener("click", (ev) => {
        ev.stopPropagation();
        const abierto = $("menu-cuenta").classList.toggle("abierto");
        ev.currentTarget.setAttribute("aria-expanded", String(abierto));
      });
      $("btn-salir").addEventListener("click", async () => {
        await fetch("/api/salir", { method: "POST" });
        location.replace("/");
      });
      document.addEventListener("click", (ev) => {
        if (!ev.target.closest(".lateral-pie")) {
          $("menu-cuenta")?.classList.remove("abierto");
          $("btn-cuenta")?.setAttribute("aria-expanded", "false");
        }
      });
      document.addEventListener("keydown", (ev) => {
        if (ev.key === "Escape") {
          $("menu-cuenta")?.classList.remove("abierto");
          $("btn-cuenta")?.setAttribute("aria-expanded", "false");
          $("btn-cuenta")?.focus();
        }
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
