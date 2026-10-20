/* Torre de enfriamiento en 3D, parametrica.
 *
 * Torre de tiro inducido y contraflujo, en metros y a escala, dimensionada
 * por el backend (simulador/dinamica.py: celdas, lado, cubierta, ventilador).
 * Nada es un modelo descargado: cada pieza sale de la geometria de diseno, asi
 * que si cambia el caudal de recirculacion de la planta cambia la torre.
 *
 *   crearTorre(contenedor, geometria, opciones) -> {
 *     actualizar(muestra, contexto), vista(nombre), destruir()
 *   }
 *
 * Opciones: `etiquetas` (instrumentos ISA encima, por defecto si),
 * `transparente` (sin cielo ni terreno: la torre y su sombra sobre el fondo
 * de la pagina, para la landing), `autoGiro` y `zoom` (la rueda acerca; en
 * una pagina que se desplaza conviene apagarlo).
 *
 * Las etiquetas de instrumentos (ISA 5.1) son HTML encima del lienzo y
 * muestran el valor del ultimo instante simulado. Los ventiladores giran en
 * tiempo real a sus rpm, aunque la simulacion vaya acelerada.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

const CURB = 1.0;          // borde de la balsa sobre el terreno, m
const PROF_BALSA = 1.8;

// ---------------------------------------------------------------------------
// Texturas procedurales (sin ficheros)
// ---------------------------------------------------------------------------

function lienzo(w, h, pintar) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  pintar(c.getContext("2d"), w, h);
  return c;
}

function ruido(ctx, w, h, base, variacion, n = 9000) {
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const v = Math.random() * variacion - variacion / 2;
    ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

function textura(canvas, rx = 1, ry = 1, color = true) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = 8;
  if (color) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const LIENZOS = {
  hormigon: () => lienzo(256, 256, (c, w, h) => ruido(c, w, h, "#9b9a95", 0.10, 14000)),
  terreno: () => lienzo(512, 512, (c, w, h) => {
    // Losa de hormigon clara, como un patio de planta a pleno sol.
    ruido(c, w, h, "#b9b7b0", 0.08, 40000);
    c.strokeStyle = "rgba(0,0,0,.14)"; c.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { c.beginPath(); c.moveTo(i * w / 4, 0); c.lineTo(i * w / 4, h); c.stroke(); c.beginPath(); c.moveTo(0, i * h / 4); c.lineTo(w, i * h / 4); c.stroke(); }
  }),
  // Panel de PRFV corrugado: crestas verticales. Sirve de color y de relieve.
  corrugado: () => lienzo(128, 8, (c, w) => {
    for (let x = 0; x < w; x++) {
      const v = Math.round(180 + 60 * Math.sin((x / w) * Math.PI * 2 * 4));
      c.fillStyle = `rgb(${v},${v},${v})`; c.fillRect(x, 0, 1, 8);
    }
  }),
  rejilla: () => lienzo(64, 64, (c, w, h) => {
    c.fillStyle = "#4b5056"; c.fillRect(0, 0, w, h);
    c.strokeStyle = "#2a2e33"; c.lineWidth = 3;
    for (let i = 0; i <= 8; i++) { c.beginPath(); c.moveTo(i * 8, 0); c.lineTo(i * 8, h); c.stroke(); }
    c.lineWidth = 1.5;
    for (let i = 0; i <= 4; i++) { c.beginPath(); c.moveTo(0, i * 16); c.lineTo(w, i * 16); c.stroke(); }
  }),
  vapor: () => lienzo(64, 64, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.45, "rgba(255,255,255,.45)"); g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  }),
};

// ---------------------------------------------------------------------------
// Materiales
// ---------------------------------------------------------------------------

function materiales() {
  const corr = LIENZOS.corrugado();
  const prfv = (rx) => new THREE.MeshStandardMaterial({
    color: 0xb4babf, roughness: 0.78, metalness: 0, envMapIntensity: 0.7,
    map: textura(corr, rx, 1), bumpMap: textura(corr, rx, 1, false), bumpScale: 1.4,
  });
  return {
    prfv,
    hormigon: new THREE.MeshStandardMaterial({ color: 0x9c9b96, roughness: 0.93, map: textura(LIENZOS.hormigon(), 6, 1) }),
    terreno: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, map: textura(LIENZOS.terreno(), 18, 18) }),
    chimenea: new THREE.MeshStandardMaterial({ color: 0x7f878e, roughness: 0.82, side: THREE.DoubleSide, envMapIntensity: 0.35 }),
    persiana: new THREE.MeshStandardMaterial({ color: 0x5f676e, roughness: 0.8 }),
    columna: new THREE.MeshStandardMaterial({ color: 0x858d94, roughness: 0.7 }),
    interior: new THREE.MeshStandardMaterial({ color: 0x0e1115, roughness: 1 }),
    galvanizado: new THREE.MeshStandardMaterial({ color: 0xb7bec4, metalness: 0.85, roughness: 0.38 }),
    rejilla: new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.6, map: textura(LIENZOS.rejilla(), 40, 10) }),
    pala: new THREE.MeshStandardMaterial({ color: 0x8e979f, roughness: 0.45, metalness: 0.2 }),
    cubo: new THREE.MeshStandardMaterial({ color: 0x3a4148, metalness: 0.7, roughness: 0.4 }),
    motor: new THREE.MeshStandardMaterial({ color: 0x3b5875, metalness: 0.4, roughness: 0.45 }),
    caliente: new THREE.MeshStandardMaterial({ color: 0x5e7385, metalness: 0.35, roughness: 0.5 }),
    cruda: new THREE.MeshStandardMaterial({ color: 0x2f6091, metalness: 0.35, roughness: 0.5 }),
    vecino: new THREE.MeshStandardMaterial({ color: 0x2c7a68, metalness: 0.35, roughness: 0.5 }),
    purga: new THREE.MeshStandardMaterial({ color: 0x86683a, metalness: 0.35, roughness: 0.5 }),
    acido: new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.2, roughness: 0.5 }),
    valvula: new THREE.MeshStandardMaterial({ color: 0x2b3036, metalness: 0.6, roughness: 0.45 }),
    actuador: new THREE.MeshStandardMaterial({ color: 0xa3acb4, metalness: 0.5, roughness: 0.4 }),
    tanque: new THREE.MeshStandardMaterial({ color: 0xe7e2d3, roughness: 0.55 }),
    agua: new THREE.MeshStandardMaterial({ color: 0x2b4b5a, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.92 }),
    caja: new THREE.MeshStandardMaterial({ color: 0xd9dcdf, roughness: 0.5 }),
  };
}

// ---------------------------------------------------------------------------
// Primitivas
// ---------------------------------------------------------------------------

function caja(m, w, h, d, x, y, z, padre, sombra = true) {
  const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  o.position.set(x, y, z);
  o.castShadow = sombra; o.receiveShadow = true;
  padre.add(o);
  return o;
}

function cilindro(m, r, h, padre, { x = 0, y = 0, z = 0, eje = "y", r2 = r, seg = 24, abierto = false } = {}) {
  const o = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, h, seg, 1, abierto), m);
  if (eje === "x") o.rotation.z = Math.PI / 2;
  if (eje === "z") o.rotation.x = Math.PI / 2;
  o.position.set(x, y, z);
  o.castShadow = true; o.receiveShadow = true;
  padre.add(o);
  return o;
}

/** Tuberia por puntos (tramos rectos) con bridas en cada cambio. */
function tuberia(m, puntos, r, padre, bridas = true) {
  const g = new THREE.Group();
  for (let i = 0; i < puntos.length - 1; i++) {
    const a = new THREE.Vector3(...puntos[i]), b = new THREE.Vector3(...puntos[i + 1]);
    const largo = a.distanceTo(b);
    const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r, largo, 20), m);
    t.position.copy(a).add(b).multiplyScalar(0.5);
    t.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    t.castShadow = true; t.receiveShadow = true;
    g.add(t);
    if (i > 0) {
      const codo = new THREE.Mesh(new THREE.SphereGeometry(r * 1.02, 16, 12), m);
      codo.position.copy(a); g.add(codo);
    }
    if (bridas && largo > 2.5) {
      for (const f of [0.08, 0.92]) {
        const br = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.35, r * 1.35, Math.max(0.05, r * 0.25), 20), m);
        br.position.copy(a).lerp(b, f);
        br.quaternion.copy(t.quaternion);
        g.add(br);
      }
    }
  }
  padre.add(g);
  return g;
}

/** Valvula de control de globo con actuador de diafragma, sobre una linea en X o Z. */
function valvulaControl(M, x, y, z, r, padre) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const cuerpo = new THREE.Mesh(new THREE.SphereGeometry(r * 1.7, 20, 14), M.valvula);
  cuerpo.castShadow = true; g.add(cuerpo);
  cilindro(M.valvula, r * 0.9, r * 2.2, g, { y: r * 2.2 });
  cilindro(M.galvanizado, 0.03, 0.55, g, { x: -0.1, y: r * 3.3 + 0.25 });
  cilindro(M.galvanizado, 0.03, 0.55, g, { x: 0.1, y: r * 3.3 + 0.25 });
  cilindro(M.actuador, 0.36, 0.2, g, { y: r * 3.3 + 0.6, r2: 0.28 });
  cilindro(M.actuador, 0.36, 0.06, g, { y: r * 3.3 + 0.48 });
  padre.add(g);
  return g;
}

function caudalimetro(M, x, y, z, r, eje, padre) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  cilindro(M.valvula, r * 1.3, 0.6, g, { eje });
  caja(M.caja, 0.22, 0.28, 0.18, 0, r * 1.3 + 0.2, 0, g);
  padre.add(g);
  return g;
}

function etiqueta(texto, x, y, z, padre) {
  const div = document.createElement("div");
  div.className = "tag3d";
  div.innerHTML = `<b>${texto}</b><span></span>`;
  const o = new CSS2DObject(div);
  o.position.set(x, y, z);
  padre.add(o);
  return { div, valor: div.querySelector("span"), objeto: o };
}

// ---------------------------------------------------------------------------
// La torre
// ---------------------------------------------------------------------------

/* Geometria que el backend dimensiona para el caso base (4 celdas de 7,4 m).
 * La portada y el acceso la usan fija para no depender de la API, que esta
 * detras del inicio de sesion. */
export const GEOMETRIA_CASO_BASE = {
  celdas: 4, lado_celda_m: 7.36, area_balsa_m2: 216.7, profundidad_balsa_m: 1.8,
  volumen_sistema_m3: 911, diametro_ventilador_m: 6.04, rpm_nominal: 190,
  altura_cubierta_m: 11.2, altura_chimenea_m: 2.1,
};

export function crearTorre(contenedor, geo, {
  vecinos = [], etiquetas: conEtiquetas = true, transparente = false, autoGiro = false, zoom = true,
} = {}) {
  const n = geo.celdas, s = geo.lado_celda_m, L = n * s, W = s;
  const Lb = L + 1.2, Wb = W + 1.2;
  const Hin = 0.42 * s;
  const y0 = CURB;
  const Hdeck = Math.max(geo.altura_cubierta_m, y0 + Hin + 4);
  const D = geo.diametro_ventilador_m;
  const Hst = Math.max(geo.altura_chimenea_m, 1.6);

  // -- escena -----------------------------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: transparente, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.8;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  contenedor.appendChild(renderer.domElement);

  const etiquetas = conEtiquetas ? new CSS2DRenderer() : null;
  if (etiquetas) {
    etiquetas.domElement.className = "torre3d-etiquetas";
    contenedor.appendChild(etiquetas.domElement);
  }

  const escena = new THREE.Scene();
  if (!transparente) {
    // Cielo claro de mediodia, a juego con el panel blanco.
    escena.background = new THREE.Color(0xe6edf0);
    escena.fog = new THREE.Fog(0xe6edf0, 110, 300);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  escena.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  escena.environmentIntensity = 0.5;

  const camara = new THREE.PerspectiveCamera(34, 1, 0.5, 600);
  const controles = new OrbitControls(camara, etiquetas ? etiquetas.domElement : renderer.domElement);
  controles.enableDamping = true;
  controles.enableZoom = zoom;
  controles.enablePan = !transparente;
  controles.autoRotate = autoGiro;
  controles.autoRotateSpeed = 0.55;
  controles.dampingFactor = 0.08;
  controles.maxPolarAngle = Math.PI * 0.49;
  controles.minDistance = 6;
  controles.maxDistance = 160;

  escena.add(new THREE.HemisphereLight(0xdfe7ef, 0x3a3d40, 0.4));
  const sol = new THREE.DirectionalLight(0xfff1e0, 2.0);
  sol.position.set(L * 0.6 + 20, 48, 26);
  sol.castShadow = true;
  sol.shadow.mapSize.set(2048, 2048);
  const ext = Math.max(L, 30) * 0.9;
  Object.assign(sol.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 160 });
  sol.shadow.bias = -0.0004;
  escena.add(sol);

  const M = materiales();
  const torre = new THREE.Group();
  escena.add(torre);

  // Transparente: del terreno solo queda la sombra, para que la torre se
  // asiente sobre el color de la pagina sin un plano gris alrededor.
  const suelo = new THREE.Mesh(
    new THREE.PlaneGeometry(260, 260),
    transparente ? new THREE.ShadowMaterial({ opacity: 0.22 }) : M.terreno,
  );
  suelo.rotation.x = -Math.PI / 2;
  suelo.receiveShadow = true;
  escena.add(suelo);

  // -- balsa de hormigon ---------------------------------------------------------
  const tMuro = 0.3;
  caja(M.hormigon, Lb, CURB, tMuro, 0, CURB / 2, Wb / 2 - tMuro / 2, torre);
  caja(M.hormigon, Lb, CURB, tMuro, 0, CURB / 2, -Wb / 2 + tMuro / 2, torre);
  caja(M.hormigon, tMuro, CURB, Wb, Lb / 2 - tMuro / 2, CURB / 2, 0, torre);
  caja(M.hormigon, tMuro, CURB, Wb, -Lb / 2 + tMuro / 2, CURB / 2, 0, torre);
  const agua = new THREE.Mesh(new THREE.PlaneGeometry(Lb - 2 * tMuro, Wb - 2 * tMuro), M.agua);
  agua.rotation.x = -Math.PI / 2;
  agua.receiveShadow = true;
  torre.add(agua);
  const nivelAY = (pct) => CURB - PROF_BALSA + PROF_BALSA * Math.min(Math.max(pct, 0), 100) / 100;
  agua.position.y = nivelAY(67);

  // -- zona de entrada de aire: persianas en los lados largos ---------------------
  caja(M.interior, L - 0.06, Hin, W - 0.06, 0, y0 + Hin / 2, 0, torre, false);
  const nLamas = Math.floor((Hin - 0.2) / 0.24);
  const lama = new THREE.BoxGeometry(s - 0.2, 0.025, 0.36);
  const lamas = new THREE.InstancedMesh(lama, M.persiana, n * 2 * nLamas);
  const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), e1 = new THREE.Euler(), uno = new THREE.Vector3(1, 1, 1);
  let k = 0;
  for (let c = 0; c < n; c++) {
    for (const lado of [1, -1]) {
      for (let i = 0; i < nLamas; i++) {
        e1.set(lado * 0.66, 0, 0); q.setFromEuler(e1);
        mtx.compose(new THREE.Vector3(-L / 2 + (c + 0.5) * s, y0 + 0.18 + i * 0.24, lado * (W / 2 + 0.1)), q, uno);
        lamas.setMatrixAt(k++, mtx);
      }
    }
  }
  lamas.castShadow = true; lamas.receiveShadow = true;
  torre.add(lamas);
  const columnas = new THREE.InstancedMesh(new THREE.BoxGeometry(0.22, Hin, 0.22), M.columna, (n + 1) * 2);
  k = 0;
  for (let c = 0; c <= n; c++) for (const lado of [1, -1]) {
    mtx.compose(new THREE.Vector3(-L / 2 + c * s, y0 + Hin / 2, lado * (W / 2 + 0.05)), new THREE.Quaternion(), uno);
    columnas.setMatrixAt(k++, mtx);
  }
  columnas.castShadow = true;
  torre.add(columnas);

  // -- cerramiento de PRFV ---------------------------------------------------------
  const yC = y0 + Hin, hC = Hdeck - yC;
  const panel = (w, h, x, y, z, ry) => {
    const o = new THREE.Mesh(new THREE.PlaneGeometry(w, h), M.prfv(Math.max(1, Math.round(w / 0.9))));
    o.position.set(x, y, z); o.rotation.y = ry;
    o.castShadow = true; o.receiveShadow = true;
    torre.add(o);
  };
  panel(L, hC, 0, yC + hC / 2, W / 2, 0);
  panel(L, hC, 0, yC + hC / 2, -W / 2, Math.PI);
  panel(W, Hdeck - y0, L / 2, y0 + (Hdeck - y0) / 2, 0, Math.PI / 2);
  panel(W, Hdeck - y0, -L / 2, y0 + (Hdeck - y0) / 2, 0, -Math.PI / 2);
  // Juntas horizontales y pilares de celda: lo que hace que se lea como obra.
  for (let y = yC + 2.4; y < Hdeck - 0.3; y += 2.4) {
    for (const z of [W / 2 + 0.03, -W / 2 - 0.03]) caja(M.columna, L + 0.04, 0.07, 0.05, 0, y, z, torre);
    for (const x of [L / 2 + 0.03, -L / 2 - 0.03]) caja(M.columna, 0.05, 0.07, W + 0.04, x, y, 0, torre);
  }
  for (let c = 0; c <= n; c++) for (const z of [W / 2 + 0.06, -W / 2 - 0.06]) {
    caja(M.columna, 0.16, hC, 0.1, -L / 2 + c * s, yC + hC / 2, z, torre);
  }

  // -- cubierta, barandas ----------------------------------------------------------
  const cubierta = caja(M.rejilla, L + 0.4, 0.18, W + 0.4, 0, Hdeck, 0, torre);
  cubierta.material = [M.columna, M.columna, M.rejilla, M.columna, M.columna, M.columna];
  const yB = Hdeck + 0.09;
  const borde = [[-L / 2 - 0.15, -W / 2 - 0.15], [L / 2 + 0.15, -W / 2 - 0.15], [L / 2 + 0.15, W / 2 + 0.15], [-L / 2 - 0.15, W / 2 + 0.15]];
  const postes = [];
  for (let i = 0; i < 4; i++) {
    const [ax, az] = borde[i], [bx, bz] = borde[(i + 1) % 4];
    const largo = Math.hypot(bx - ax, bz - az), np = Math.ceil(largo / 1.8);
    for (let j = 0; j < np; j++) postes.push([ax + (bx - ax) * j / np, az + (bz - az) * j / np]);
    for (const h of [1.07, 0.53]) tuberia(M.galvanizado, [[ax, yB + h, az], [bx, yB + h, bz]], 0.022, torre, false);
    caja(M.galvanizado, Math.abs(bx - ax) + 0.04, 0.1, Math.abs(bz - az) + 0.04, (ax + bx) / 2, yB + 0.05, (az + bz) / 2, torre);
  }
  const posteM = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.024, 0.024, 1.07, 10), M.galvanizado, postes.length);
  postes.forEach(([x, z], i) => { mtx.compose(new THREE.Vector3(x, yB + 0.535, z), new THREE.Quaternion(), uno); posteM.setMatrixAt(i, mtx); });
  posteM.castShadow = true;
  torre.add(posteM);

  // -- escala de gato con jaula en el testero ----------------------------------------
  const xE = L / 2 + 0.35, zE = W / 2 - 1.2;
  for (const dz of [-0.23, 0.23]) caja(M.galvanizado, 0.05, Hdeck + 1.1, 0.06, xE, (Hdeck + 1.1) / 2, zE + dz, torre);
  const nPeld = Math.floor(Hdeck / 0.3);
  const peld = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.016, 0.016, 0.46, 8), M.galvanizado, nPeld);
  for (let i = 0; i < nPeld; i++) {
    mtx.compose(new THREE.Vector3(xE, 0.3 + i * 0.3, zE), new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), uno);
    peld.setMatrixAt(i, mtx);
  }
  torre.add(peld);
  for (let y = 2.4; y < Hdeck + 1; y += 0.9) {
    const aro = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.015, 6, 20, Math.PI), M.galvanizado);
    aro.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    aro.position.set(xE + 0.02, y, zE);
    torre.add(aro);
  }

  // -- chimeneas, ventiladores, motores ----------------------------------------------
  const ventiladores = [];
  const r0 = D / 2 + 0.12;
  const perfil = [[r0, 0], [r0, Hst * 0.25], [r0 * 1.05, Hst * 0.62], [r0 * 1.14, Hst]].map(([r, y]) => new THREE.Vector2(r, y));
  const geoChim = new THREE.LatheGeometry(perfil, 48);
  for (let c = 0; c < n; c++) {
    const cx = -L / 2 + (c + 0.5) * s;
    const ch = new THREE.Mesh(geoChim, M.chimenea);
    ch.position.set(cx, Hdeck + 0.09, 0);
    ch.castShadow = true; ch.receiveShadow = true;
    torre.add(ch);
    const aro = new THREE.Mesh(new THREE.TorusGeometry(r0 * 1.14, 0.05, 8, 48), M.chimenea);
    aro.rotation.x = Math.PI / 2;
    aro.position.set(cx, Hdeck + 0.09 + Hst, 0);
    torre.add(aro);

    const rotor = new THREE.Group();
    rotor.position.set(cx, Hdeck + 0.6, 0);
    cilindro(M.cubo, 0.38, 0.4, rotor);
    const largoPala = D / 2 - 0.45;
    const geoPala = new THREE.BoxGeometry(largoPala, 0.035, 0.42);
    geoPala.translate(largoPala / 2 + 0.3, 0, 0);
    for (let b = 0; b < 8; b++) {
      const pala = new THREE.Mesh(geoPala, M.pala);
      pala.rotation.set(0.22, (b / 8) * Math.PI * 2, 0, "YXZ");
      pala.castShadow = true;
      rotor.add(pala);
    }
    torre.add(rotor);
    ventiladores.push(rotor);
    caja(M.cubo, 0.7, 0.55, 0.7, cx, Hdeck + 0.2, 0, torre);
    const mx = cx + r0 * 1.14 + 0.7;
    caja(M.motor, 0.95, 0.7, 0.75, mx, Hdeck + 0.45, 0, torre);
    cilindro(M.motor, 0.32, 0.5, torre, { eje: "x", x: mx - 0.6, y: Hdeck + 0.45 });
    cilindro(M.galvanizado, 0.06, mx - cx - 0.6, torre, { eje: "x", x: (cx + mx - 0.6) / 2, y: Hdeck + 0.3 });
  }

  // -- agua caliente: montante y colector por la cara posterior ----------------------------
  const zC = -W / 2 - 1.1, yDist = yC + 1.4, rC = Math.min(0.42, 0.11 + geo.celdas * 0.07);
  tuberia(M.caliente, [[-L / 2 - 14, 0.9, zC - 1.5], [-L / 2 - 1.6, 0.9, zC - 1.5], [-L / 2 - 1.6, yDist, zC - 1.5], [-L / 2 - 1.6, yDist, zC], [L / 2 - s / 2, yDist, zC]], rC, torre);
  for (let c = 0; c < n; c++) {
    const cx = -L / 2 + (c + 0.5) * s;
    tuberia(M.caliente, [[cx, yDist, zC], [cx, yDist, -W / 2]], rC * 0.62, torre, false);
    cilindro(M.valvula, rC * 0.8, 0.18, torre, { eje: "z", x: cx, y: yDist, z: zC + 0.55 });
    cilindro(M.galvanizado, 0.025, 0.5, torre, { x: cx, y: yDist + rC * 0.8 + 0.2, z: zC + 0.55 });
    const volante = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.025, 8, 24), M.galvanizado);
    volante.rotation.x = Math.PI / 2;
    volante.position.set(cx, yDist + rC * 0.8 + 0.45, zC + 0.55);
    torre.add(volante);
    caja(M.galvanizado, 0.12, yDist - 0.4, 0.12, cx, (yDist - 0.4) / 2 + 0.2, zC, torre);
  }

  // -- agua fria: salida del sumidero y bombas ---------------------------------------
  const xB = Lb / 2 + 4.2, zB = W / 4;
  tuberia(M.caliente, [[Lb / 2 - 0.1, 0.55, zB], [xB - 1.4, 0.55, zB]], rC, torre);
  const etTF = etiqueta("TI-105", Lb / 2 + 1.0, 1.6, zB, torre);
  for (const [i, dz] of [[0, -1.3], [1, 1.3]].map((x) => x)) {
    const g = new THREE.Group();
    g.position.set(xB, 0, zB + dz);
    caja(M.hormigon, 2.6, 0.3, 1.2, 0.6, 0.15, 0, g);
    cilindro(M.motor, 0.55, 0.42, g, { eje: "z", y: 0.85 });
    cilindro(M.motor, 0.34, 1.3, g, { eje: "x", x: 1.15, y: 0.85 });
    tuberia(M.caliente, [[0, 1.3, 0], [0, 2.6, 0], [10, 2.6, 0]], rC * 0.7, g);
    torre.add(g);
    tuberia(M.caliente, [[xB - 1.4, 0.55, zB], [xB - 1.4, 0.55, zB + dz], [xB - 0.3, 0.85, zB + dz]], rC * 0.7, torre, false);
    if (i === 0) etiqueta("CWP-101A/B", xB + 0.5, 2.0, zB + 2.4, torre).valor.textContent = "a proceso";
  }

  // -- reposicion de agua cruda: FT-101 y LV-101 ---------------------------------------------
  const zR = W / 4, yR = 0.55, rR = 0.16;
  tuberia(M.cruda, [[-Lb / 2 - 18, yR, zR], [-Lb / 2 + 0.2, yR, zR]], rR, torre);
  for (let x = -Lb / 2 - 17; x < -Lb / 2 - 1; x += 3) caja(M.hormigon, 0.3, yR - rR, 0.6, x, (yR - rR) / 2, zR, torre);
  caudalimetro(M, -Lb / 2 - 9, yR, zR, rR, "x", torre);
  valvulaControl(M, -Lb / 2 - 5, yR, zR, rR, torre);
  const etFT101 = etiqueta("FT-101", -Lb / 2 - 9, yR + 1.0, zR, torre);
  const etLV101 = etiqueta("LV-101", -Lb / 2 - 5, yR + 2.6, zR - 0.4, torre);
  cilindro(M.caja, 0.1, 0.9, torre, { x: -Lb / 2 + 0.6, y: CURB + 0.45, z: -W / 4 });
  caja(M.caja, 0.25, 0.3, 0.25, -Lb / 2 + 0.6, CURB + 1.0, -W / 4, torre);
  const etLIT = etiqueta("LIT-101", -Lb / 2 + 0.6, CURB + 1.6, -W / 4, torre);

  // -- dosificacion de acido: TK-101 y P-101 ---------------------------------------------------
  const xA = -Lb / 2 - 7.5, zA = zR + 3.6;
  caja(M.hormigon, 3.4, 0.15, 2.6, xA, 0.075, zA, torre);
  for (const [w, d, x, z] of [[3.4, 0.15, 0, 1.25], [3.4, 0.15, 0, -1.25], [0.15, 2.6, 1.65, 0], [0.15, 2.6, -1.65, 0]]) {
    caja(M.hormigon, w, 0.45, d, xA + x, 0.3, zA + z, torre);
  }
  cilindro(M.tanque, 0.75, 1.9, torre, { x: xA - 0.5, y: 1.1, z: zA });
  caja(M.motor, 0.5, 0.35, 0.35, xA + 0.9, 0.35, zA, torre);
  tuberia(M.acido, [[xA + 0.9, 0.5, zA], [xA + 0.9, 1.1, zA], [xA + 0.9, 1.1, zR + 0.4], [xA + 0.9, yR + rR, zR + 0.4]], 0.03, torre, false);
  const etP101 = etiqueta("P-101 · H₂SO₄", xA, 2.9, zA + 0.4, torre);

  // -- purga: AIT-102, AV-102 y arqueta ------------------------------------------------------
  const zP = -W / 4, rP = 0.12;
  tuberia(M.purga, [[Lb / 2 - 0.1, 0.4, zP], [Lb / 2 + 12, 0.4, zP], [Lb / 2 + 12, 0.1, zP]], rP, torre);
  valvulaControl(M, Lb / 2 + 7, 0.4, zP, rP, torre);
  caja(M.hormigon, 1.6, 0.25, 1.6, Lb / 2 + 12, 0.12, zP, torre);
  caja(M.rejilla, 1.4, 0.04, 1.4, Lb / 2 + 12, 0.26, zP, torre);
  cilindro(M.galvanizado, 0.04, 1.4, torre, { x: Lb / 2 + 2.2, y: 0.7, z: zP - 0.7 });
  caja(M.caja, 0.45, 0.55, 0.22, Lb / 2 + 2.2, 1.5, zP - 0.7, torre);
  const etAIT = etiqueta("AIT-102", Lb / 2 + 2.2, 2.2, zP - 0.7, torre);
  const etAV = etiqueta("AV-102", Lb / 2 + 7, 1.9, zP, torre);
  etiqueta("Vertimiento", Lb / 2 + 12, 1.0, zP, torre).valor.textContent = "";

  // -- ventiladores y evaporacion: etiquetas de cubierta ---------------------------------------
  const etSI = etiqueta("SIC-103", -L / 2 + 0.5 * s + r0 * 1.14 + 0.7, Hdeck + 1.4, 0, torre);
  const etEvap = etiqueta("Evaporacion", 0, Hdeck + Hst + 3.0, 0, torre);

  // -- vecinos: una linea por toma, entrando por la cara frontal -------------------------------
  const lineasVecinos = new THREE.Group();
  torre.add(lineasVecinos);
  let etVecinos = [];
  function pintarVecinos(lista) {
    lineasVecinos.clear();
    etVecinos.forEach((e) => e.objeto.parent?.remove(e.objeto));
    etVecinos = [];
    const activos = lista.slice(0, 6);
    activos.forEach((v, i) => {
      const x = -L / 2 + ((i + 0.5) / Math.max(activos.length, 1)) * L * 0.8 + L * 0.1;
      const zIn = Wb / 2 - 0.1, zOut = Wb / 2 + 16, y = 0.45;
      tuberia(M.vecino, [[x, y, zOut], [x, y, zIn]], 0.11, lineasVecinos);
      for (let z = zIn + 2; z < zOut; z += 3) caja(M.hormigon, 0.45, y - 0.11, 0.3, x, (y - 0.11) / 2, z, lineasVecinos);
      caudalimetro(M, x, y, zIn + 5.5, 0.11, "z", lineasVecinos);
      valvulaControl(M, x, y, zIn + 3, 0.11, lineasVecinos);
      const et = etiqueta(`FIC-${201 + i}`, x, y + 1.9, zIn + 3, lineasVecinos);
      et.div.title = v.nombre;
      et.div.dataset.nombre = v.nombre;
      etVecinos.push({ ...et, id: v.fuente_id, nombre: v.nombre });
    });
  }
  pintarVecinos(vecinos);

  // -- pluma de vapor ---------------------------------------------------------------------
  const texVapor = textura(LIENZOS.vapor(), 1, 1);
  const particulas = [];
  for (let c = 0; c < n; c++) {
    for (let i = 0; i < 26; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: texVapor, color: 0xf2f4f6, transparent: true, opacity: 0, depthWrite: false }));
      sp.userData = { celda: c, vida: Math.random() * 7, dur: 6 + Math.random() * 3, ox: (Math.random() - 0.5) * D * 0.6, oz: (Math.random() - 0.5) * D * 0.6 };
      escena.add(sp);
      particulas.push(sp);
    }
  }
  let intensidadVapor = 1;

  // -- camara y vistas ----------------------------------------------------------------------
  const VISTAS = {
    general: { pos: [L * 0.75 + 16, Hdeck + 9, W / 2 + 34], obj: [0, Hdeck * 0.42, 0] },
    frente: { pos: [0, Hdeck * 0.55, W / 2 + 42], obj: [0, Hdeck * 0.45, 0] },
    cubierta: { pos: [L * 0.35, Hdeck + 20, W / 2 + 14], obj: [0, Hdeck, 0] },
    reposicion: { pos: [-Lb / 2 - 20, 7, W / 2 + 15], obj: [-Lb / 2 - 6, 1, zR] },
    purga: { pos: [Lb / 2 + 18, 7, -W / 2 - 14], obj: [Lb / 2 + 5, 1, zP] },
  };
  let transicion = null;
  function vista(nombre, inmediata = false) {
    const v = VISTAS[nombre] || VISTAS.general;
    if (inmediata) {
      camara.position.set(...v.pos); controles.target.set(...v.obj); controles.update(); return;
    }
    transicion = { t: 0, p0: camara.position.clone(), o0: controles.target.clone(),
      p1: new THREE.Vector3(...v.pos), o1: new THREE.Vector3(...v.obj) };
  }
  vista("general", true);

  // -- bucle -------------------------------------------------------------------------------
  let rpm = geo.rpm_nominal;
  let visible = true;
  const reloj = new THREE.Clock();
  const tamano = () => {
    const w = contenedor.clientWidth, h = contenedor.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    etiquetas?.setSize(w, h);
    camara.aspect = w / h;
    camara.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(tamano);
  ro.observe(contenedor);
  tamano();
  const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; });
  io.observe(contenedor);

  let rafId = 0;
  function cuadro() {
    rafId = requestAnimationFrame(cuadro);
    const dt = Math.min(reloj.getDelta(), 0.05);
    if (!visible) return;
    const w = (rpm / 60) * Math.PI * 2;
    for (const v of ventiladores) v.rotation.y -= w * dt;
    for (const sp of particulas) {
      const u = sp.userData;
      u.vida += dt;
      if (u.vida > u.dur) { u.vida = 0; u.dur = 6 + Math.random() * 3; }
      const f = u.vida / u.dur;
      const cx = -L / 2 + (u.celda + 0.5) * s;
      sp.position.set(cx + u.ox + f * 6, Hdeck + Hst + 0.5 + f * 14, u.oz + f * 1.5);
      const esc = D * (0.5 + f * 1.6);
      sp.scale.set(esc, esc, 1);
      sp.material.opacity = intensidadVapor * 0.16 * Math.sin(Math.PI * Math.min(f * 1.4, 1)) * (1 - f * 0.5);
    }
    if (transicion) {
      transicion.t = Math.min(transicion.t + dt / 0.9, 1);
      const k2 = 1 - Math.pow(1 - transicion.t, 3);
      camara.position.lerpVectors(transicion.p0, transicion.p1, k2);
      controles.target.lerpVectors(transicion.o0, transicion.o1, k2);
      if (transicion.t >= 1) transicion = null;
    }
    controles.update();
    renderer.render(escena, camara);
    etiquetas?.render(escena, camara);
  }
  cuadro();

  // -- datos -------------------------------------------------------------------------------
  const num = (v, d = 1) => (v == null ? "—" : Number(v).toLocaleString("es", { minimumFractionDigits: d, maximumFractionDigits: d }));
  function alarma(et, activa) { et.div.classList.toggle("alarma", Boolean(activa)); }

  function actualizar(m, ctx = {}) {
    if (!m) return;
    rpm = m.rpm ?? rpm;
    agua.position.y = nivelAY(m.nivel_pct);
    intensidadVapor = Math.min(Math.max(m.evaporacion_m3_h / Math.max(ctx.evaporacionBase || m.evaporacion_m3_h, 1), 0.2), 1.6);
    const tags = new Set((m.alarmas || []).map((a) => a.tag));
    etLIT.valor.textContent = `${num(m.nivel_pct)} %`; alarma(etLIT, tags.has("LIC-101"));
    etLV101.valor.textContent = `${num(m.lv_pct, 0)} % abierta`;
    etFT101.valor.textContent = `${num(m.cruda_m3_h)} m³/h`;
    etAIT.valor.textContent = `${num(m.conductividad, 0)} µS/cm`; alarma(etAIT, tags.has("AIT-102"));
    etAV.valor.textContent = `${num(m.purga_m3_h)} m³/h · ${num(m.av_pct, 0)} %`;
    etP101.valor.textContent = `${num(ctx.acido ?? 0)} mg/L`;
    etSI.valor.textContent = `${num(m.rpm, 0)} rpm · ${num(m.potencia_ventiladores_kw, 0)} kW`;
    etTF.valor.textContent = `${num(m.t_fria_c)} °C`; alarma(etTF, tags.has("TI-105"));
    etEvap.valor.textContent = `${num(m.evaporacion_m3_h)} m³/h`;
    const porId = Object.fromEntries((m.tomas || []).map((t) => [t.fuente_id, t]));
    const conAlarma = new Set((m.alarmas || []).map((a) => a.fuente_id).filter(Boolean));
    for (const et of etVecinos) {
      const t = porId[et.id];
      et.valor.textContent = `${et.nombre.slice(0, 18)} · ${num(t?.caudal_m3_h ?? 0)} m³/h`;
      alarma(et, conAlarma.has(et.id));
    }
  }

  return {
    actualizar,
    vista,
    vecinos: pintarVecinos,
    destruir() {
      cancelAnimationFrame(rafId);
      ro.disconnect(); io.disconnect();
      controles.dispose();
      renderer.dispose();
      escena.traverse((o) => { o.geometry?.dispose?.(); });
      contenedor.innerHTML = "";
    },
  };
}
