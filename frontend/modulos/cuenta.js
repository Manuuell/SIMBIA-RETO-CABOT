/* Vista de la cuenta activa. Las acciones viven en el menú del pie lateral. */

import { $, escapar, estado } from "../comun.js";

function pintar() {
  const sesion = estado.sesion || {};
  const nombre = sesion.nombre || sesion.usuario?.split("@")[0] || "Usuario";
  $("cuenta-ficha").innerHTML = `
    <div class="cuenta-avatar-grande">${escapar(nombre[0].toUpperCase())}</div>
    <div class="cuenta-datos">
      <span class="admin-sobrelinea">Identidad</span>
      <h2>${escapar(nombre)}</h2>
      <p>${escapar(sesion.usuario || "")}</p>
      <span class="chip ${sesion.administrador ? "azul" : "ok"} sin-punto">
        ${sesion.administrador ? "Administrador principal" : "Usuario de SIMBIA"}
      </span>
    </div>
    <div class="cuenta-seguridad">
      <b>Sesión protegida</b>
      <p>La sesión dura 12 horas. La contraseña no se guarda en el navegador ni puede verse desde la plataforma.</p>
      ${sesion.administrador ? '<a class="secundario pequeno" href="#administracion">Administrar usuarios</a>' : ""}
    </div>`;
}

export default { id: "cuenta", montar: pintar, mostrar: pintar };
