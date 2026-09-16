/* Pagina de acceso: envia las credenciales y entra a la aplicacion. */

const $ = (id) => document.getElementById(id);
const form = $("form-acceso"), error = $("acceso-error"), boton = $("btn-entrar");

function mostrarError(texto) {
  error.textContent = texto;
  error.hidden = false;
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  error.hidden = true;
  boton.disabled = true; boton.textContent = "Comprobando…";
  try {
    const r = await fetch("/api/acceso", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario: $("usuario").value.trim(), clave: $("clave").value }),
    });
    if (r.ok) {
      // El #modulo no viaja al servidor, asi que se conserva desde aqui.
      const siguiente = new URLSearchParams(location.search).get("siguiente") || ("/" + location.hash);
      // Solo rutas de esta aplicacion: nada de saltar a otro sitio.
      location.replace(siguiente.startsWith("/") && !siguiente.startsWith("//") ? siguiente : "/");
      return;
    }
    let detalle = "No se pudo iniciar sesion.";
    try { detalle = (await r.json()).detail || detalle; } catch { /* sin cuerpo */ }
    mostrarError(detalle);
    if (r.status === 401) { $("clave").value = ""; $("clave").focus(); }
  } catch (e) {
    mostrarError("Sin conexion con el servidor.");
  } finally {
    boton.disabled = false; boton.textContent = "Entrar";
  }
});
