/* Administración de acceso. Solo el correo administrador recibe esta vista y
 * el servidor vuelve a comprobar el permiso en cada operación. */

import { $, copiar, escapar, pedir } from "../comun.js";

let datos = null;

function mostrarError(error = null) {
  const caja = $("admin-error");
  caja.hidden = !error;
  let mensaje = error ? String(error.message || error).replace(/^\/api\/[^:]+:\s*\d+\s*/, "") : "";
  try { mensaje = JSON.parse(mensaje).detail || mensaje; } catch { /* respuesta sin JSON */ }
  caja.textContent = mensaje;
}

function claveTemporal() {
  const grupos = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%*-_"];
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = grupos.map((g, i) => g[bytes[i] % g.length]);
  const todos = grupos.join("");
  for (let i = 4; i < bytes.length; i++) chars.push(todos[bytes[i] % todos.length]);
  // Fisher-Yates usando otro bloque criptográfico para no dejar los cuatro
  // caracteres obligatorios siempre al principio.
  const orden = crypto.getRandomValues(new Uint8Array(chars.length));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = orden[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function fecha(iso) {
  if (!iso) return "Configuración del servidor";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `Creado ${d.toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" })}`;
}

function pintar() {
  const usuarios = datos?.usuarios || [];
  const activos = usuarios.filter((u) => u.activo).length;
  $("admin-resumen").innerHTML = `
    <div><b>${usuarios.length}</b><span>cuentas</span></div>
    <div><b>${activos}</b><span>activas</span></div>
    <div><b>${usuarios.filter((u) => u.administrador).length}</b><span>administrador principal</span></div>`;
  $("admin-usuarios").innerHTML = usuarios.map((u) => `
    <article class="admin-usuario${u.activo ? "" : " inactivo"}">
      <div class="admin-avatar">${escapar((u.nombre || u.usuario)[0].toUpperCase())}</div>
      <div class="admin-identidad">
        <b>${escapar(u.nombre || u.usuario.split("@")[0])}</b>
        <span>${escapar(u.usuario)}</span>
        <small>${escapar(fecha(u.creado))}</small>
      </div>
      <div class="admin-estado">
        ${u.administrador ? '<span class="chip azul sin-punto">Administrador</span>' : ""}
        <span class="chip ${u.activo ? "ok" : "neutra"} sin-punto">${u.activo ? "Activa" : "Desactivada"}</span>
      </div>
      <div class="admin-acciones">
        ${u.gestionable ? `
          <button class="secundario pequeno" data-admin-clave data-usuario="${escapar(u.usuario)}">Nueva contraseña</button>
          <button class="${u.activo ? "secundario" : ""} pequeno" data-admin-estado data-usuario="${escapar(u.usuario)}" data-activo="${u.activo ? "false" : "true"}">
            ${u.activo ? "Desactivar" : "Activar"}
          </button>` : '<span class="admin-protegida">Cuenta protegida en el servidor</span>'}
      </div>
    </article>`).join("");
}

function mostrarClave(usuario, clave, titulo) {
  const aviso = $("admin-aviso");
  aviso.hidden = false;
  aviso.innerHTML = `<div><b>${escapar(titulo)}</b>
    <span>Usuario: ${escapar(usuario)}</span>
    <code>${escapar(clave)}</code>
    <small>Cópiala ahora y envíala por un canal seguro. SIMBIA no puede volver a mostrarla.</small></div>
    <button class="secundario pequeno" id="admin-copiar-clave">Copiar contraseña</button>`;
  $("admin-copiar-clave").addEventListener("click", async (ev) => {
    // En Safari currentTarget vuelve a null cuando el listener asincrono cede
    // el control. Conservamos el nodo antes del await.
    const boton = ev.currentTarget;
    const ok = await copiar(clave);
    boton.textContent = ok ? "Copiada" : "No se pudo copiar";
  });
  aviso.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function cargar() {
  datos = await pedir("/api/admin/usuarios");
  pintar();
}

async function crear(ev) {
  ev.preventDefault();
  // `currentTarget` solo esta garantizado durante la fase sincrona del
  // listener. Safari lo limpia mientras esperamos la respuesta del servidor.
  const formulario = ev.currentTarget;
  const boton = $("admin-crear");
  const usuario = $("admin-correo").value.trim().toLowerCase();
  const nombre = $("admin-nombre").value.trim();
  const clave = $("admin-clave").value;
  boton.disabled = true;
  boton.textContent = "Creando…";
  mostrarError();
  try {
    await pedir("/api/admin/usuarios", { usuario, nombre, clave });
    formulario.reset();
    mostrarClave(usuario, clave, "Cuenta creada");
    await cargar();
  } catch (error) {
    mostrarError(error);
  } finally {
    boton.disabled = false;
    boton.textContent = "Crear usuario";
  }
}

async function accion(ev) {
  const claveBtn = ev.target.closest("[data-admin-clave]");
  if (claveBtn) {
    const usuario = claveBtn.dataset.usuario;
    const clave = claveTemporal();
    if (!confirm(`Generar una contraseña nueva para ${usuario}. La sesión que tenga abierta se cerrará. ¿Continuar?`)) return;
    claveBtn.disabled = true;
    mostrarError();
    try {
      await pedir("/api/admin/usuarios/clave", { usuario, clave });
      mostrarClave(usuario, clave, "Contraseña restablecida");
    } catch (error) { mostrarError(error); }
    finally { claveBtn.disabled = false; }
    return;
  }
  const estadoBtn = ev.target.closest("[data-admin-estado]");
  if (!estadoBtn) return;
  const usuario = estadoBtn.dataset.usuario;
  const activo = estadoBtn.dataset.activo === "true";
  if (!activo && !confirm(`Desactivar a ${usuario}. Su sesión dejará de funcionar inmediatamente. ¿Continuar?`)) return;
  estadoBtn.disabled = true;
  mostrarError();
  try {
    await pedir("/api/admin/usuarios/estado", { usuario, activo });
    await cargar();
  } catch (error) { mostrarError(error); }
  finally { estadoBtn.disabled = false; }
}

export default {
  id: "administracion",
  async montar() {
    $("admin-form").addEventListener("submit", crear);
    $("admin-generar").addEventListener("click", () => { $("admin-clave").value = claveTemporal(); });
    $("admin-usuarios").addEventListener("click", accion);
    $("admin-clave").value = claveTemporal();
    await cargar();
  },
  async mostrar() { if (datos) await cargar(); },
};
