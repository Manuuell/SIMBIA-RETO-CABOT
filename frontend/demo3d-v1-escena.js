/* Escenario 3D del recorrido de presentacion (demo3d.html).
 *
 * Siete escenas, una por modulo del recorrido, sobre un mismo escenario de
 * estudio: suelo con rejilla que se desvanece hacia el horizonte, luz de
 * mediodia con sombras suaves y reflejos de RoomEnvironment, como la torre de
 * la portada. Las etiquetas son HTML (CSS2DRenderer) con la tipografia del
 * panel, y las tuberias llevan el agua como trazos que avanzan en el sentido
 * del flujo.
 *
 *   crearEscena(contenedor, { etapas, modos, alElegirModo }) -> {
 *     renderer, entrar(i), vista(clave), encuadre(margenes), mezcla(...),
 *     series(...), cuadro(dt, ctx), ar
 *   }
 *
 * Quien la usa decide que modulo se ve y en que punto de la narracion esta
 * (ctx.P, de 0 a 1); la escena solo dibuja ese instante. Nada se descarga:
 * geometria y texturas salen del codigo.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

const COLOR = {
  agua: 0x1f9fb0, aguaClara: 0x3cc8d8, tratada: 0x2aa57f,
  naranja: 0xf2762e, verde: 0x178452, rojo: 0xd2402f, apagado: 0xa7b2b9,
};
const TRM = 3500;

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const suave = (x) => x * x * (3 - 2 * x);
const vaiven = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const rebote = (x) => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2);
const tramo = (v, a, b) => clamp((v - a) / (b - a), 0, 1);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// Los ShaderMaterial no pasan solos por el tono ni por el espacio de color de
// salida: sin esto sus colores no casan con los de los materiales PBR.
const FIN_SHADER = "#include <tonemapping_fragment>\n#include <colorspace_fragment>";

const TIEMPO = { value: 0 };
const PIXELES = { value: 600 };   // alto del lienzo / (2 tan(fov/2)): tamano de las gotas en mundo

// ---------------------------------------------------------------------------
// Texturas procedurales
// ---------------------------------------------------------------------------

function lienzo(w, h, pintar) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  pintar(c.getContext("2d"), w, h);
  return c;
}

function ruido(ctx, w, h, base, variacion, n) {
  ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const v = Math.random() * variacion - variacion / 2;
    ctx.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}

function textura(canvas, rx = 1, ry = 1) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
// Materiales
// ---------------------------------------------------------------------------

function matAgua(color, alfa = 0.94, escala = 1.6) {
  return new THREE.ShaderMaterial({
    transparent: alfa < 1,
    uniforms: { uT: TIEMPO, uC: { value: new THREE.Color(color) }, uA: { value: alfa }, uE: { value: escala } },
    vertexShader: `varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float uT, uA, uE; uniform vec3 uC; varying vec3 vW;
      void main() {
        vec2 p = vW.xz * uE;
        float n = sin(p.x * 1.3 + uT * 1.1) + sin(p.y * 1.7 - uT * 0.9) + sin((p.x + p.y) * 1.1 + uT * 0.7);
        float brillo = pow(0.5 + 0.5 * sin(n * 2.2), 6.0);
        gl_FragColor = vec4(uC * (0.82 + 0.16 * sin(n)) + vec3(brillo * 0.3), uA);
        ${FIN_SHADER}
      }`,
  });
}

// Tuberia translucida con trazos claros que avanzan con el agua. La fase la
// lleva la CPU (tubo.fase) para que cambiar la velocidad no haga saltar los
// trazos.
function matFlujo(color, largo) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: {
      uC: { value: new THREE.Color(color) }, uL: { value: largo },
      uF: { value: 0 }, uV: { value: 1 }, uA: { value: 1 },
    },
    vertexShader: `varying vec2 vUv; varying float vBorde;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        vBorde = pow(1.0 - abs(dot(n, normalize(-mv.xyz))), 1.5);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform vec3 uC; uniform float uL, uF, uV, uA; varying vec2 vUv; varying float vBorde;
      void main() {
        float s = fract(vUv.x * uL / 1.3 - uF);
        float trazo = smoothstep(0.0, 0.1, s) * (1.0 - smoothstep(0.3, 0.46, s)) * uV;
        vec3 c = mix(uC, vec3(1.0), trazo * 0.65 + vBorde * 0.2);
        gl_FragColor = vec4(c, (0.52 + vBorde * 0.4 + trazo * 0.3) * uA);
        ${FIN_SHADER}
      }`,
  });
}

// Haz de luz vertical de las balizas: se desvanece hacia arriba.
function matHaz(color) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uC: { value: new THREE.Color(color) }, uA: { value: 0.2 } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 uC; uniform float uA; varying vec2 vUv;
      void main() {
        gl_FragColor = vec4(uC, pow(1.0 - vUv.y, 1.8) * uA);
        ${FIN_SHADER}
      }`,
  });
}

// Suelo de estudio: blanco con rejilla de 1 y 5 m que se funde con el fondo
// de la pagina a partir de uR.
function matSuelo() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, toneMapped: false,
    uniforms: {
      uR: { value: 44 }, uBase: { value: new THREE.Color(0xffffff) }, uLinea: { value: new THREE.Color(0x9fb1ba) },
    },
    vertexShader: `varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform float uR; uniform vec3 uBase, uLinea; varying vec3 vW;
      float rejilla(vec2 p, float paso) {
        vec2 q = p / paso; vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        float cerca = 1.0 - smoothstep(uR * 0.3, uR, length(vW.xz));
        float l = rejilla(vW.xz, 1.0) * 0.2 + rejilla(vW.xz, 5.0) * 0.45;
        gl_FragColor = vec4(mix(uBase, uLinea, l), cerca * (0.62 + 0.38 * l));
        #include <colorspace_fragment>
      }`,
  });
}

function materiales() {
  const hormigon = lienzo(256, 256, (c, w, h) => ruido(c, w, h, "#c9cac5", 0.08, 12000));
  const losa = lienzo(512, 512, (c, w, h) => {
    ruido(c, w, h, "#e1e3e0", 0.06, 30000);
    c.strokeStyle = "rgba(0,0,0,.07)"; c.lineWidth = 2;
    for (let i = 0; i <= 8; i++) {
      c.beginPath(); c.moveTo(i * w / 8, 0); c.lineTo(i * w / 8, h); c.stroke();
      c.beginPath(); c.moveTo(0, i * h / 8); c.lineTo(w, i * h / 8); c.stroke();
    }
  });
  const pbr = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, ...o });
  return {
    acero: pbr(0xe3e8eb, { metalness: 0.5, roughness: 0.3 }),
    aceroOscuro: pbr(0x51606a, { metalness: 0.7, roughness: 0.35 }),
    hormigon: pbr(0xffffff, { map: textura(hormigon, 2, 2), roughness: 0.92, metalness: 0 }),
    losa: pbr(0xffffff, { map: textura(losa, 4, 2), roughness: 0.95, metalness: 0 }),
    naranja: pbr(COLOR.naranja, { metalness: 0.25, roughness: 0.45 }),
    edificio: pbr(0xf3f5f6, { roughness: 0.8, metalness: 0 }),
    techo: pbr(0x8f9ca5, { metalness: 0.4 }),
    franjaAgua: pbr(COLOR.agua),
    caliente: pbr(0x2d2622, { emissive: COLOR.naranja, emissiveIntensity: 1.3 }),
    vidrio: new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16,
      envMapIntensity: 1.8, side: THREE.DoubleSide, depthWrite: false,
    }),
    agua: matAgua(COLOR.agua),
    aguaTratada: matAgua(COLOR.tratada),
  };
}

const brillo = (color, intensidad = 0.8) =>
  new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensidad, roughness: 0.3 });
const plano = (color, o = {}) => new THREE.MeshBasicMaterial({ color, toneMapped: false, ...o });

// ---------------------------------------------------------------------------
// Primitivas
// ---------------------------------------------------------------------------

const cil = (r, h, seg = 32, r2 = r) => new THREE.CylinderGeometry(r, r2, h, seg);
const caja = (w, h, d) => new THREE.BoxGeometry(w, h, d);

function pieza(geo, mat, padre, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  padre.add(m);
  return m;
}

function lamina(mat, padre, geo, y) {
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  m.receiveShadow = true;
  padre.add(m);
  return m;
}

// Poligonal con las esquinas redondeadas, para que el tubo gire como una curva.
function rutaRedondeada(pts, radio) {
  const ruta = new THREE.CurvePath();
  let previo = pts[0].clone();
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const r = Math.min(radio, a.distanceTo(b) / 2, b.distanceTo(c) / 2);
    const p1 = b.clone().add(a.clone().sub(b).setLength(r));
    const p2 = b.clone().add(c.clone().sub(b).setLength(r));
    ruta.add(new THREE.LineCurve3(previo, p1));
    ruta.add(new THREE.QuadraticBezierCurve3(p1, b.clone(), p2));
    previo = p2;
  }
  ruta.add(new THREE.LineCurve3(previo, pts[pts.length - 1].clone()));
  return ruta;
}

function etiqueta(padre, html, x, y, z, clase = "") {
  const div = document.createElement("div");
  div.className = "e3d " + clase;
  div.innerHTML = `<span>${html}</span>`;
  const o = new CSS2DObject(div);
  o.position.set(x, y, z);
  o.center.set(0.5, 1);
  padre.add(o);
  return o;
}

// ---------------------------------------------------------------------------
// Equipos de la planta de negro de humo. Origen en el suelo, en el centro;
// userData: rx/rz (medio ancho en x/z, para que las tuberias lleguen al
// borde), alto (para la etiqueta) y gira (pieza que rota sobre su eje).
// ---------------------------------------------------------------------------

function captacion(M) {
  const g = new THREE.Group();
  pieza(cil(1.15, 0.8, 48), M.hormigon, g, 0, 0.4, 0);
  lamina(M.agua, g, new THREE.CircleGeometry(0.98, 48), 0.81);
  pieza(caja(1.1, 0.18, 0.7), M.hormigon, g, 0, 0.09, -1.65);
  pieza(caja(0.5, 0.42, 0.42), M.naranja, g, -0.2, 0.39, -1.65);
  const motor = pieza(cil(0.2, 0.55, 20), M.aceroOscuro, g, 0.3, 0.4, -1.65);
  motor.rotation.z = Math.PI / 2;
  const succion = pieza(cil(0.09, 1.05, 12), M.acero, g, -0.2, 0.68, -1.15);
  succion.rotation.x = Math.PI / 2;
  g.userData = { rx: 1.2, rz: 1.2, alto: 1.4 };
  return g;
}

function piscina(M, agua = M.agua, w = 2.8, d = 2.2) {
  const g = new THREE.Group(), h = 0.8, t = 0.18;
  pieza(caja(w, h, t), M.hormigon, g, 0, h / 2, d / 2 - t / 2);
  pieza(caja(w, h, t), M.hormigon, g, 0, h / 2, -d / 2 + t / 2);
  pieza(caja(t, h, d - 2 * t), M.hormigon, g, w / 2 - t / 2, h / 2, 0);
  pieza(caja(t, h, d - 2 * t), M.hormigon, g, -w / 2 + t / 2, h / 2, 0);
  pieza(caja(w - 2 * t, 0.1, d - 2 * t), M.hormigon, g, 0, 0.05, 0);
  lamina(agua, g, new THREE.PlaneGeometry(w - 2 * t, d - 2 * t), h - 0.16);
  // Baranda naranja en el lado largo de atras.
  for (let x = -w / 2 + 0.2; x <= w / 2 - 0.1; x += 0.65) pieza(cil(0.03, 0.55, 8), M.naranja, g, x, h + 0.27, -d / 2 + 0.08);
  const pasamanos = pieza(cil(0.035, w - 0.3, 8), M.naranja, g, 0, h + 0.55, -d / 2 + 0.08);
  pasamanos.rotation.z = Math.PI / 2;
  g.userData = { rx: w / 2, rz: d / 2, alto: 1.5 };
  return g;
}

function reactor(M) {
  const g = new THREE.Group();
  const cuerpo = pieza(cil(0.6, 3.0, 40), M.aceroOscuro, g, 0, 1.0, 0);
  cuerpo.rotation.z = Math.PI / 2;
  const zona = pieza(cil(0.63, 0.5, 40), M.caliente, g, -0.4, 1.0, 0);   // zona de pirolisis, al rojo
  zona.rotation.z = Math.PI / 2;
  for (const x of [-1.0, 1.0]) pieza(caja(0.35, 0.5, 1.0), M.hormigon, g, x, 0.25, 0);
  const tapa = pieza(new THREE.SphereGeometry(0.6, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), M.aceroOscuro, g, 1.5, 1.0, 0);
  tapa.rotation.z = -Math.PI / 2;
  const quemador = pieza(cil(0.32, 0.6, 24), M.acero, g, -1.75, 1.0, 0);
  quemador.rotation.z = Math.PI / 2;
  pieza(cil(0.18, 2.6, 20, 0.24), M.acero, g, 1.1, 2.6, -0.3);
  pieza(cil(0.2, 0.15, 20), M.caliente, g, 1.1, 3.95, -0.3);
  g.userData = { rx: 1.9, rz: 0.7, alto: 4.2 };
  return g;
}

function separacion(M) {   // ciclon sobre patas
  const g = new THREE.Group();
  pieza(cil(0.72, 1.3, 40), M.acero, g, 0, 2.55, 0);
  pieza(cil(0.72, 1.3, 40, 0.16), M.acero, g, 0, 1.25, 0);
  pieza(new THREE.SphereGeometry(0.72, 40, 12, 0, Math.PI * 2, 0, Math.PI / 2), M.acero, g, 0, 3.2, 0);
  pieza(cil(0.16, 0.6, 16), M.aceroOscuro, g, 0, 4.1, 0);
  for (const [x, z] of [[0.55, 0.55], [-0.55, 0.55], [0.55, -0.55], [-0.55, -0.55]]) pieza(cil(0.05, 2.0, 8), M.aceroOscuro, g, x, 1.0, z);
  pieza(cil(0.13, 0.4, 14), M.naranja, g, 0, 0.42, 0);
  g.userData = { rx: 0.85, rz: 0.85, alto: 4.4 };
  return g;
}

function molienda(M) {
  const g = new THREE.Group();
  pieza(caja(1.9, 0.3, 1.5), M.hormigon, g, 0, 0.15, 0);
  pieza(caja(1.3, 1.1, 1.2), M.acero, g, -0.2, 0.85, 0);
  const tambor = pieza(cil(0.45, 1.1, 32), M.aceroOscuro, g, -0.2, 1.65, 0);
  tambor.rotation.x = Math.PI / 2;
  const motor = pieza(cil(0.26, 0.7, 24), M.naranja, g, 0.75, 0.62, 0);
  motor.rotation.z = Math.PI / 2;
  pieza(cil(0.42, 0.55, 24, 0.14), M.acero, g, -0.2, 2.35, 0);   // tolva
  g.userData = { rx: 1.0, rz: 0.8, alto: 2.8 };
  return g;
}

function peletizacion(M) {   // tambor peletizador, apenas inclinado
  const g = new THREE.Group();
  pieza(caja(2.6, 0.25, 1.3), M.hormigon, g, 0, 0.125, 0);
  const tambor = new THREE.Group();
  tambor.position.set(0, 1.05, 0); tambor.rotation.z = 0.08;
  g.add(tambor);
  const cuerpo = pieza(cil(0.55, 2.3, 36), M.acero, tambor);
  cuerpo.rotation.z = Math.PI / 2;
  for (const x of [-0.7, 0.7]) {
    const anillo = pieza(new THREE.TorusGeometry(0.58, 0.07, 10, 40), M.aceroOscuro, tambor, x, 0, 0);
    anillo.rotation.y = Math.PI / 2;
    pieza(caja(0.3, 0.55, 1.0), M.aceroOscuro, g, x, 0.52, 0);
  }
  g.userData = { rx: 1.3, rz: 0.7, alto: 2.2 };
  return g;
}

function secado(M) {   // secador rotatorio con su quemador y la criba
  const g = new THREE.Group();
  const cuerpo = pieza(cil(0.6, 2.8, 36), M.acero, g, 0, 1.0, 0);
  cuerpo.rotation.z = Math.PI / 2;
  for (const x of [-0.8, 0.8]) {
    const aro = pieza(new THREE.TorusGeometry(0.63, 0.08, 10, 40), M.aceroOscuro, g, x, 1.0, 0);
    aro.rotation.y = Math.PI / 2;
    pieza(caja(0.35, 0.45, 1.1), M.hormigon, g, x, 0.225, 0);
  }
  pieza(caja(0.6, 1.2, 0.9), M.naranja, g, 1.7, 0.6, 0);
  pieza(caja(0.8, 0.5, 0.8), M.aceroOscuro, g, -1.75, 0.25, 0);
  g.userData = { rx: 1.6, rz: 0.7, alto: 2.2 };
  return g;
}

function silos(M) {
  const g = new THREE.Group();
  for (const x of [-0.65, 0.65]) {
    pieza(cil(0.55, 1.9, 32), M.acero, g, x, 2.15, 0);
    pieza(cil(0.55, 0.6, 32, 0.12), M.acero, g, x, 0.9, 0);
    pieza(cil(0.08, 0.35, 32, 0.57), M.aceroOscuro, g, x, 3.27, 0);
    for (const [dx, dz] of [[0.38, 0.38], [-0.38, 0.38], [0.38, -0.38], [-0.38, -0.38]]) pieza(cil(0.04, 1.3, 6), M.aceroOscuro, g, x + dx, 0.65, dz);
  }
  pieza(caja(2.1, 0.07, 0.4), M.naranja, g, 0, 3.0, 0);
  g.userData = { rx: 1.25, rz: 0.6, alto: 3.6 };
  return g;
}

function tratamiento(M) {   // clarificador con su puente giratorio y la caseta de quimicos
  const g = new THREE.Group();
  pieza(cil(1.2, 0.7, 48), M.hormigon, g, 0, 0.35, 0);
  lamina(M.aguaTratada, g, new THREE.CircleGeometry(1.06, 48), 0.66);
  const puente = new THREE.Group();
  puente.position.y = 0.82; g.add(puente);
  pieza(caja(2.5, 0.08, 0.22), M.naranja, puente);
  pieza(cil(0.15, 0.3, 16), M.aceroOscuro, g, 0, 0.9, 0);
  pieza(caja(0.9, 0.8, 0.7), M.edificio, g, 0.3, 0.4, 1.75);
  pieza(caja(0.95, 0.06, 0.75), M.techo, g, 0.3, 0.83, 1.75);
  g.userData = { rx: 1.25, rz: 1.25, alto: 1.6, gira: puente };
  return g;
}

function vecino(M) {   // planta generica de Mamonal: nave, tanques y chimenea
  const g = new THREE.Group();
  pieza(caja(4.4, 0.1, 3.6), M.losa, g, 0, 0.05, 0);
  pieza(caja(2.2, 1.3, 1.6), M.edificio, g, -0.8, 0.75, -0.6);
  pieza(caja(2.25, 0.08, 1.65), M.techo, g, -0.8, 1.44, -0.6);
  pieza(caja(2.22, 0.16, 0.04), M.franjaAgua, g, -0.8, 1.1, 0.21);
  for (const z of [-0.7, 0.75]) {
    pieza(cil(0.55, 1.5, 28), M.acero, g, 1.2, 0.85, z);
    pieza(cil(0.2, 0.12, 28, 0.57), M.aceroOscuro, g, 1.2, 1.66, z);
  }
  pieza(cil(0.13, 2.8, 14, 0.17), M.acero, g, -1.7, 1.5, 1.1);
  return g;
}

// ---------------------------------------------------------------------------
// Escena
// ---------------------------------------------------------------------------

export function crearEscena(contenedor, { etapas, modos, alElegirModo = () => {} }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.xr.enabled = true;
  contenedor.appendChild(renderer.domElement);

  const etiquetas = new CSS2DRenderer();
  etiquetas.setSize(innerWidth, innerHeight);
  etiquetas.domElement.className = "etiquetas3d";
  contenedor.appendChild(etiquetas.domElement);

  const escena = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  escena.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  escena.environmentIntensity = 0.5;

  const camara = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.5, 400);
  camara.position.set(40, 34, 52);
  const controles = new OrbitControls(camara, renderer.domElement);
  Object.assign(controles, {
    enableDamping: true, dampingFactor: 0.08, enablePan: false,
    minDistance: 5, maxDistance: 120, maxPolarAngle: Math.PI * 0.48,
  });

  escena.add(new THREE.HemisphereLight(0xffffff, 0xb8c4c9, 0.9));
  const sol = new THREE.DirectionalLight(0xfff4e6, 2.1);
  sol.position.set(18, 34, 22);
  sol.castShadow = true;
  sol.shadow.mapSize.set(2048, 2048);
  Object.assign(sol.shadow.camera, { left: -36, right: 36, top: 36, bottom: -36, near: 1, far: 120 });
  sol.shadow.bias = -0.0004;
  sol.shadow.normalBias = 0.02;
  escena.add(sol);

  const mundo = new THREE.Group();
  escena.add(mundo);
  const suelo = new THREE.Mesh(new THREE.PlaneGeometry(240, 240).rotateX(-Math.PI / 2), matSuelo());
  suelo.renderOrder = -2;
  mundo.add(suelo);
  const sombra = new THREE.Mesh(new THREE.PlaneGeometry(240, 240).rotateX(-Math.PI / 2),
    new THREE.ShadowMaterial({ color: 0x0b2530, opacity: 0.16 }));
  sombra.position.y = 0.004;
  sombra.receiveShadow = true;
  sombra.renderOrder = -1;
  mundo.add(sombra);

  const M = materiales();
  const grupos = Array.from({ length: 7 }, () => {
    const g = new THREE.Group();
    g.visible = false;
    mundo.add(g);
    return g;
  });

  const tubos = [];
  function tubo(padre, puntos, { r = 0.16, color = COLOR.agua, vel = 1, curva = 0.7, bridas = false } = {}) {
    const ruta = puntos.length > 2 ? rutaRedondeada(puntos, curva) : new THREE.LineCurve3(puntos[0], puntos[1]);
    const largo = ruta.getLength();
    const radiales = 16;
    const geo = new THREE.TubeGeometry(ruta, Math.max(4, Math.round(largo * 5)), r, radiales, false);
    const mat = matFlujo(color, largo);
    const malla = new THREE.Mesh(geo, mat);
    malla.renderOrder = 1;
    padre.add(malla);
    if (bridas) {
      for (const u of [0, 1]) {
        const b = pieza(cil(r * 1.4, 0.14, 24), M.acero, padre);
        b.position.copy(ruta.getPointAt(u));
        b.quaternion.setFromUnitVectors(V(0, 1, 0), ruta.getTangentAt(u));
      }
    }
    const fila = radiales * 6;
    const t = {
      malla, mat, vel, fase: Math.random(), total: geo.index.count,
      dibujar(f) {
        malla.visible = f > 0.001;
        geo.setDrawRange(0, Math.ceil(t.total * clamp(f, 0, 1) / fila) * fila);
      },
      color(hex) { mat.uniforms.uC.value.setHex(hex); },
    };
    tubos.push(t);
    return t;
  }

  // Tubo recto a lo largo de +x con origen en su grupo: escalar el grupo en
  // (1, k, k) engorda el tubo sin moverlo.
  function tuboRecto(padre, x0, x1, y, z, opciones) {
    const g = new THREE.Group();
    g.position.set(x0, y, z);
    padre.add(g);
    const t = tubo(g, [V(0, 0, 0), V(x1 - x0, 0, 0)], opciones);
    t.grupo = g;
    return t;
  }

  // =========================================================================
  // 1. Panel ejecutivo: diagrama de flujo de la planta de negro de humo
  // =========================================================================
  const g0 = grupos[0];
  const CENTRO0 = V(-1.5, 0, -1.5);
  pieza(caja(32, 0.12, 15.5), M.losa, g0, CENTRO0.x, -0.04, CENTRO0.z);

  const ETAPAS = [
    ["Captación (agua cruda)", -14, -6, captacion],
    ["Piscina de almacenamiento", -9, -6, (m) => piscina(m)],
    ["Reactor (pirólisis)", -4, -6, reactor],
    ["Separación de partículas", 1, -6, separacion],
    ["Molienda", 6, -6, molienda],
    ["Peletización", 11, -6, peletizacion],
    ["Secado y clasificación", 11, 3, secado],
    ["Almacenamiento de producto", 6, 3, silos],
    ["Piscina de mezcla", 1, 3, (m) => piscina(m)],
    ["Tratamiento / Acondicionamiento", -4, 3, tratamiento],
  ];
  // Alturas de las etiquetas, alternadas para que las vecinas no se pisen; una
  // linea fina las une con su equipo.
  const ALTURA_ETIQUETA = [2.2, 4.4, 7.0, 4.9, 2.9, 5.0, 2.8, 5.0, 2.4, 4.6];
  const guia = new THREE.LineBasicMaterial({ color: 0x0f1b24, transparent: true, opacity: 0.35 });
  const nodos = ETAPAS.map(([nombre, x, z, crear], i) => {
    const g = crear(M);
    g.position.set(x, 0, z);
    g.scale.setScalar(0.001);
    g0.add(g);
    const y = ALTURA_ETIQUETA[i];
    const linea = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(x, g.userData.alto + 0.1, z), V(x, y, z)]), guia);
    linea.visible = false;
    g0.add(linea);
    const e = etiqueta(g0, `<i class="n">${i + 1}</i><span class="nom">${nombre}</span>`, x, y, z, "etapa oculta");
    return { g, e, linea };
  });

  const Y0 = 0.9;
  const borde = (n, d) => (Math.abs(d.x) > 0.5 ? n.g.userData.rx : n.g.userData.rz) + 0.15;
  const tramos0 = [];
  for (let i = 0; i < 9; i++) {
    const a = V(ETAPAS[i][1], Y0, ETAPAS[i][2]), b = V(ETAPAS[i + 1][1], Y0, ETAPAS[i + 1][2]);
    const d = b.clone().sub(a).normalize();
    tramos0.push(tubo(g0, [a.addScaledVector(d, borde(nodos[i], d)), b.addScaledVector(d, -borde(nodos[i + 1], d))],
      { r: 0.17, vel: 1.2 }));
  }
  // El agua tratada vuelve a la piscina de almacenamiento.
  {
    const [, xT, zT] = ETAPAS[9], [, xP, zP] = ETAPAS[1];
    tramos0.push(tubo(g0, [
      V(xT - borde(nodos[9], V(1, 0, 0)), Y0, zT), V(xP, Y0, zT), V(xP, Y0, zP + borde(nodos[1], V(0, 0, 1))),
    ], { r: 0.17, color: COLOR.verde, vel: 1.2 }));
  }

  // Tres anillos alrededor de la planta: los supuestos que el piloto tiene que
  // validar.
  const anillos = [
    ["Calidad de data", COLOR.agua, 18, 0.25, "agua"],
    ["Disponibilidad", COLOR.naranja, 19.6, 0.7, "naranja"],
    ["Viabilidad económica", COLOR.verde, 21.2, 1.15, "verde"],
  ].map(([nombre, color, R, y, clase], i) => {
    const g = new THREE.Group();
    g.position.set(CENTRO0.x, y, CENTRO0.z);
    g.rotation.set((i - 1) * 0.025, 0, (1 - i) * 0.02);
    g0.add(g);
    const elipse = new THREE.Group();
    elipse.scale.set(1, 1, 0.55);
    g.add(elipse);
    const aro = new THREE.Mesh(new THREE.TorusGeometry(R, 0.05, 8, 220), plano(color, { transparent: true, opacity: 0.85 }));
    aro.rotation.x = Math.PI / 2;
    elipse.add(aro);
    const sat = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 12), plano(color));
    g.add(sat);
    etiqueta(sat, `<i class="punto"></i>${nombre}`, 0, 0.55, 0, "anillo " + clase);
    return { sat, R, fase: 0.6 + i * 2.1, vel: (0.1 + i * 0.03) * (i % 2 ? -1 : 1) };
  });

  function actualizar0(P, t, dt) {
    let actual = -1;
    nodos.forEach((n, i) => {
      const a = tramo(P, etapas[i], etapas[i] + 0.035);
      n.g.scale.setScalar(a <= 0 ? 0.001 : Math.max(0.001, rebote(a)));
      n.e.element.classList.toggle("oculta", a < 0.4);
      n.linea.visible = a >= 0.4;
      if (P >= etapas[i]) actual = i;
      if (n.g.userData.gira) n.g.userData.gira.rotation.y += dt * 0.4;
    });
    nodos.forEach((n, i) => n.e.element.classList.toggle("activa", i === actual));
    tramos0.forEach((tb, i) => tb.dibujar(i < 9
      ? tramo(P, etapas[i] + 0.01, Math.max(etapas[i + 1], etapas[i] + 0.05))
      : tramo(P, etapas[9] + 0.01, etapas[9] + 0.08)));
    for (const a of anillos) {
      const th = a.fase + t * a.vel;
      a.sat.position.set(a.R * Math.cos(th), 0, a.R * 0.55 * Math.sin(th));
    }
  }

  // =========================================================================
  // 2. Cluster Mamonal: Cabot en el centro, las fuentes de rechazo alrededor
  //    y la bahia de Cartagena al oeste
  // =========================================================================
  const g1 = grupos[1];
  const SITIOS = { A: [-14, -10], B: [14, -8], C: [-12, 12], D: [15, 12] };
  const costa = (z) => -24 + 2.6 * Math.sin(z * 0.11) + 1.4 * Math.sin(z * 0.29 + 1);
  function alturaTerreno(x, z) {
    // Llano en el centro y en cada planta; lomas suaves hacia fuera; bajo el
    // agua al oeste de la costa.
    let h = 0.12 + (0.9 * Math.sin(x * 0.16 + 1) * Math.cos(z * 0.13) + 0.45 * Math.sin(x * 0.37 + z * 0.29))
      * suave(tramo(Math.hypot(x, z), 9, 28));
    for (const [px, pz] of Object.values(SITIOS)) h = lerp(0.12, h, suave(tramo(Math.hypot(x - px, z - pz), 3.5, 7)));
    return lerp(-1.4, h, suave(tramo(x, costa(z) - 3, costa(z) + 2)));
  }
  {
    const tg = new THREE.PlaneGeometry(96, 84, 96, 84);
    tg.rotateX(-Math.PI / 2);
    const pos = tg.attributes.position, colores = new Float32Array(pos.count * 3);
    const arena = new THREE.Color(0xefe3c6), tierra = new THREE.Color(0xe4eadf), loma = new THREE.Color(0xd2ddcd),
      fondo = new THREE.Color(0xb7c7c3), c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), h = alturaTerreno(x, z);
      pos.setY(i, h);
      if (h < -0.25) c.copy(fondo);
      else if (x < costa(z) + 4 && h < 0.3) c.copy(arena);
      else c.copy(tierra).lerp(loma, clamp((h - 0.25) / 1.1, 0, 1));
      c.toArray(colores, i * 3);
    }
    tg.setAttribute("color", new THREE.BufferAttribute(colores, 3));
    tg.computeVertexNormals();
    const terreno = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
    terreno.receiveShadow = true;
    g1.add(terreno);
    const bahia = new THREE.Mesh(new THREE.PlaneGeometry(32, 84).rotateX(-Math.PI / 2), matAgua(COLOR.agua, 0.9, 0.45));
    bahia.position.set(-32, -0.3, 0);
    g1.add(bahia);
  }

  {
    const cabot = new THREE.Group();
    cabot.position.y = 0.12;
    g1.add(cabot);
    pieza(caja(9, 0.1, 6.5), M.losa, cabot, 0, 0.05, 0);
    for (const [crear, x, z] of [[reactor, -1.6, -1.5], [silos, 2.4, -1.6], [(m) => piscina(m), -2.2, 1.6], [tratamiento, 2.3, 1.5]]) {
      const e = crear(M);
      e.scale.setScalar(0.7);
      e.position.set(x, 0.1, z);
      cabot.add(e);
    }
    etiqueta(g1, `<i class="chev"></i>CABOT`, 0, 5.0, 0, "marca");
  }

  const balizas = {};
  for (const [k, [x, z]] of Object.entries(SITIOS)) {
    const y = alturaTerreno(x, z);
    const planta = vecino(M);
    planta.position.set(x, y, z);
    g1.add(planta);

    const g = new THREE.Group();
    g.position.set(x, y, z);
    g1.add(g);
    const mat = brillo(COLOR.naranja, 0.5);
    pieza(cil(0.05, 4.4, 8), M.aceroOscuro, g, 0, 2.2, 0);
    const bola = pieza(new THREE.SphereGeometry(0.45, 32, 16), mat, g, 0, 4.6, 0);
    const haz = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 9, 24, 1, true), matHaz(COLOR.naranja));
    haz.position.y = 9.1;
    g.add(haz);
    const ondas = [0, 1, 2].map(() => {
      const o = new THREE.Mesh(new THREE.RingGeometry(1, 1.12, 64),
        plano(COLOR.naranja, { transparent: true, depthWrite: false, side: THREE.DoubleSide }));
      o.rotation.x = -Math.PI / 2;
      o.position.y = 0.2;
      g.add(o);
      return o;
    });
    const e = etiqueta(g, `<i class="punto"></i>Fuente ${k}`, 0, 5.5, 0, "fuente");
    balizas[k] = { bola, mat, ondas, e };

    // Tuberia hasta Cabot sobre soportes: baja por el pasillo y entra por el lado.
    const yt = 1.1, zc = z < 0 ? -2.2 : 2.2, xc = x < 0 ? -4.7 : 4.7;
    const pts = [V(x, yt, z - Math.sign(z) * 1.9), V(x, yt, zc), V(xc, yt, zc)];
    tubo(g1, pts, { r: 0.2, vel: 1.3, curva: 1.2 });
    for (let s = 0; s < 1; s += 0.12) {
      const p = rutaRedondeada(pts, 1.2).getPointAt(s), h = alturaTerreno(p.x, p.z);
      pieza(cil(0.05, yt - h, 6), M.aceroOscuro, g1, p.x, h + (yt - h) / 2, p.z);
    }
  }
  const [bx, bz] = SITIOS.B;
  const fichaB = etiqueta(g1,
    "<b>Fuente B</b><em>9,5 m³/h · continuo</em><em>31 °C · 1.850 µS/cm · 38 mg/L</em>",
    bx, alturaTerreno(bx, bz) + 7.2, bz, "ficha oculta");

  function actualizar1(t, enfoqueB) {
    for (const [k, b] of Object.entries(balizas)) {
      const foco = enfoqueB && k === "B";
      b.bola.scale.setScalar(1 + (foco ? 0.35 : 0.12) * Math.sin(t * 3 + k.charCodeAt(0)));
      b.mat.emissiveIntensity = foco ? 0.9 + 0.4 * Math.sin(t * 6) : 0.5;
      b.ondas.forEach((o, j) => {
        const f = (t * 0.45 + j / 3) % 1;
        o.scale.setScalar(1 + f * (foco ? 4.5 : 3));
        o.material.opacity = (1 - f) * 0.7;
      });
      b.e.element.classList.toggle("activa", foco);
    }
    fichaB.element.classList.toggle("oculta", !enfoqueB);
  }

  // =========================================================================
  // 3. Optimizador: el nucleo de SIMBIA mezcla las fuentes A, B y C
  // =========================================================================
  const g2 = grupos[2];
  pieza(cil(3.0, 0.35, 64), M.aceroOscuro, g2, 0, 0.175, 0);
  const banda = pieza(new THREE.TorusGeometry(3.0, 0.06, 8, 96), M.naranja, g2, 0, 0.35, 0);
  banda.rotation.x = Math.PI / 2;
  const vaso = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 6, 64, 1, true), M.vidrio);
  vaso.position.y = 3.35;
  vaso.renderOrder = 3;
  g2.add(vaso);
  for (const y of [0.4, 6.35]) {
    const a = pieza(new THREE.TorusGeometry(2.22, 0.08, 12, 96), M.acero, g2, 0, y, 0);
    a.rotation.x = Math.PI / 2;
  }
  const LIQ = { uT: TIEMPO, uC: { value: new THREE.Color(COLOR.aguaClara) }, uTurb: { value: 0 } };
  const liquido = new THREE.Mesh(new THREE.CylinderGeometry(2.08, 2.08, 4.6, 64, 24), new THREE.ShaderMaterial({
    uniforms: LIQ, transparent: true, depthWrite: false,
    vertexShader: `varying vec3 vP; varying vec3 vN; varying vec3 vV;
      void main() {
        vP = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform float uT, uTurb; uniform vec3 uC; varying vec3 vP; varying vec3 vN; varying vec3 vV;
      void main() {
        float n = sin(vP.x * 3.0 + uT) + sin(vP.y * 4.0 - uT * 1.3 + vP.z) + sin(vP.z * 3.0 + uT * 0.7 + vP.x);
        float ca = pow(0.5 + 0.5 * sin(n * 2.0), 4.0);
        float fr = pow(1.0 - abs(dot(vN, vV)), 2.0);
        vec3 c = uC * (0.62 + 0.22 * ca) + vec3(fr * 0.18);
        vec3 turbia = vec3(0.26, 0.16, 0.04) * (0.85 + 0.25 * sin(n * 3.0));
        c = mix(c, turbia, uTurb);
        gl_FragColor = vec4(c, mix(0.62, 0.93, uTurb) + fr * 0.2);
        ${FIN_SHADER}
      }`,
  }));
  liquido.position.y = 2.75;
  liquido.renderOrder = 2;
  g2.add(liquido);
  {
    const NB = 220, geo = new THREE.BufferGeometry(), semillas = new Float32Array(NB * 4);
    for (let i = 0; i < NB; i++) semillas.set([Math.random() * 6.28, Math.sqrt(Math.random()) * 1.85, Math.random() * 4.6, 0.25 + Math.random() * 0.6], i * 4);
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NB * 3), 3));
    geo.setAttribute("aS", new THREE.BufferAttribute(semillas, 4));
    const burbujas = new THREE.Points(geo, new THREE.ShaderMaterial({
      uniforms: { uT: TIEMPO, uPx: PIXELES }, transparent: true, depthWrite: false,
      vertexShader: `attribute vec4 aS; uniform float uT, uPx; varying float vA;
        void main() {
          float y = mod(aS.z + uT * aS.w, 4.6);
          float a = aS.x + uT * (0.6 + aS.w * 0.3) + y * 0.8;
          float r = aS.y * (0.85 + 0.15 * sin(uT + aS.x * 3.0));
          vec4 mv = modelViewMatrix * vec4(cos(a) * r, 0.2 + y, sin(a) * r, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = (0.1 + 0.12 * aS.w) * uPx / -mv.z;
          vA = smoothstep(0.0, 0.5, y) * smoothstep(4.6, 4.0, y);
        }`,
      fragmentShader: `varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard;
          float rim = smoothstep(0.28, 0.5, d), hi = smoothstep(0.16, 0.0, length(c - vec2(-0.12, 0.12)));
          gl_FragColor = vec4(mix(vec3(1.0), vec3(0.78, 0.97, 1.0), rim) + hi, (0.25 + 0.45 * rim + hi * 0.4) * vA);
          ${FIN_SHADER}
        }`,
    }));
    burbujas.position.y = 0.45;
    burbujas.frustumCulled = false;
    g2.add(burbujas);
  }
  const agitador = new THREE.Group();
  g2.add(agitador);
  pieza(cil(0.07, 5.6, 12), M.acero, agitador, 0, 3.9, 0);
  for (const a of [0, Math.PI / 2]) pieza(caja(2.6, 0.08, 0.32), M.acero, agitador, 0, 1.3, 0).rotation.y = a;
  pieza(caja(5.0, 0.2, 0.36), M.aceroOscuro, g2, 0, 6.55, 0);
  pieza(cil(0.36, 0.7, 24), M.naranja, g2, 0, 7.0, 0);

  const entradas = [["A", -2.2], ["B", 0], ["C", 2.2]].map(([k, z]) => {
    pieza(cil(0.75, 6.2, 32), M.acero, g2, -10.6, 3.1, z);
    pieza(cil(0.77, 0.3, 32), M.franjaAgua, g2, -10.6, 4.6, z);
    pieza(cil(0.2, 0.18, 32, 0.78), M.aceroOscuro, g2, -10.6, 6.29, z);
    etiqueta(g2, `<i class="punto"></i>Fuente ${k}`, -10.6, 7.0, z, "fuente");
    return tuboRecto(g2, -9.85, -2.25, 5.6, z, { r: 0.28, vel: 1.5, bridas: true });
  });
  const INDICADOR = { uQ: { value: 0.9 }, uC: { value: new THREE.Color(COLOR.agua) } };
  {
    const indicador = new THREE.Mesh(new THREE.RingGeometry(3.35, 3.7, 160, 1), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: INDICADOR,
      vertexShader: `varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uQ; uniform vec3 uC; varying vec2 vP;
        void main() {
          float f = fract(atan(vP.y, vP.x) / 6.2831853 + 0.25);
          gl_FragColor = vec4(mix(vec3(0.84, 0.88, 0.9), uC, step(f, uQ)), 0.95);
          ${FIN_SHADER}
        }`,
    }));
    indicador.rotation.x = -Math.PI / 2;
    indicador.position.y = 0.02;
    g2.add(indicador);
  }
  etiqueta(g2, "Núcleo SIMBIA", 0, 7.7, 0, "titulo");
  const ahorro3d = etiqueta(g2, "<b>10,0 %</b><small>Ahorro estimado</small>", 0, 9.4, 0, "dato");

  function mezcla(a, b, c, q, texto) {
    const s = a + b + c || 1;
    [a, b, c].forEach((v, i) => {
      const k = 0.35 + 1.7 * v / s;
      entradas[i].grupo.scale.set(1, k, k);
      entradas[i].vel = 0.4 + 2.2 * v / s;
    });
    LIQ.uTurb.value = 1 - clamp((q - 30) / 60, 0, 1);
    INDICADOR.uQ.value = q / 100;
    INDICADOR.uC.value.setHex(q < 80 ? COLOR.naranja : COLOR.agua);
    ahorro3d.element.querySelector("b").textContent = texto;
    ahorro3d.element.classList.toggle("bajo", q < 80);
  }

  // =========================================================================
  // 4. Monitoreo: tres tableros en vivo alimentados por un concentrador IoT
  // =========================================================================
  const g3 = grupos[3];
  // En arco, como una sala de control: los laterales giran hacia el centro.
  const ARCO = 13, LADO = 0.66;
  const graficos = [
    { titulo: "Caudal (m³/h)", color: "#1f9fb0", min: 22.9, max: 24.7, giro: LADO },
    { titulo: "Índice de calidad (base 85)", color: "#178452", min: 80, max: 90, giro: 0 },
    { titulo: "Temperatura (°C)", color: "#f2762e", min: 29.6, max: 30.6, giro: -LADO },
  ].map((p) => ({ ...p, pos: [-ARCO * Math.sin(p.giro), 3.6, ARCO - ARCO * Math.cos(p.giro)] })).map((p) => {
    const g = new THREE.Group();
    g.position.set(...p.pos);
    g.rotation.y = p.giro;
    g3.add(g);
    pieza(caja(8.9, 4.6, 0.14), M.aceroOscuro, g, 0, 0, -0.08);
    const hp = p.pos[1] - 2.3;
    for (const x of [-3.2, 3.2]) {
      pieza(cil(0.07, hp, 12), M.aceroOscuro, g, x, -2.3 - hp / 2, -0.1);
      pieza(caja(0.9, 0.06, 0.6), M.aceroOscuro, g, x, -p.pos[1] + 0.03, -0.1);
    }
    const c = document.createElement("canvas");
    c.width = 1024; c.height = 528;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const cara = new THREE.Mesh(new THREE.PlaneGeometry(8.7, 4.48), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
    g.add(cara);
    return { ...p, ctx: c.getContext("2d"), tex, w: c.width, h: c.height, serie: [] };
  });
  const hub = new THREE.Group();
  hub.position.set(0, 0, 6.2);
  g3.add(hub);
  pieza(cil(1.0, 0.2, 40), M.aceroOscuro, hub, 0, 0.1, 0);
  pieza(caja(1.2, 0.8, 0.8), M.edificio, hub, 0, 0.6, 0);
  pieza(caja(1.22, 0.12, 0.82), M.naranja, hub, 0, 0.78, 0);
  pieza(cil(0.035, 1.3, 8), M.acero, hub, 0.35, 1.65, 0);
  pieza(new THREE.SphereGeometry(0.12, 16, 10), brillo(COLOR.naranja, 1), hub, 0.35, 2.32, 0);
  const antena = V(0.35, 2.32, 6.2);
  const senales = [0, 1, 2].map(() => {
    const o = new THREE.Mesh(new THREE.TorusGeometry(1, 0.025, 6, 64), plano(COLOR.naranja, { transparent: true, depthWrite: false }));
    o.position.copy(antena);
    o.rotation.x = Math.PI / 2;
    g3.add(o);
    return o;
  });
  const paquetes = graficos.map((gr, i) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 10), plano(new THREE.Color(gr.color)));
    g3.add(m);
    const fin = V(gr.pos[0] + Math.sin(gr.giro) * 0.3, gr.pos[1] - 1.2, gr.pos[2] + Math.cos(gr.giro) * 0.3);
    const medio = antena.clone().lerp(fin, 0.5).add(V(0, 3.5, 0));
    return { m, curva: new THREE.QuadraticBezierCurve3(antena.clone(), medio, fin), fase: i / 3 };
  });

  function redondeado(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  const coma = (v) => v.toFixed(1).replace(".", ",");
  function dibujarGrafico(gr, nc) {
    const { ctx: c, w, h, serie } = gr;
    c.clearRect(0, 0, w, h);
    redondeado(c, 4, 4, w - 8, h - 8, 34);
    c.fillStyle = "rgba(255,255,255,0.97)"; c.fill();
    c.textBaseline = "alphabetic";
    c.fillStyle = "#4b5862"; c.font = "600 30px Inter, system-ui, sans-serif"; c.textAlign = "left";
    c.fillText(gr.titulo, 44, 72);
    c.fillStyle = "#0f1b24"; c.font = "800 72px Figtree, system-ui, sans-serif"; c.textAlign = "right";
    c.fillText(coma(serie.length ? serie[serie.length - 1] : (gr.min + gr.max) / 2), w - 44, 90);
    const x0 = 44, x1 = w - 44, y0 = 132, y1 = h - 50;
    c.strokeStyle = "rgba(15,27,36,0.07)"; c.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      const y = y0 + (y1 - y0) * i / 4;
      c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
    }
    c.fillStyle = "#8a959d"; c.font = "500 20px Inter, system-ui, sans-serif"; c.textAlign = "left";
    c.fillText(coma(gr.max), x0, y0 - 8);
    c.fillText(coma(gr.min), x0, y1 + 28);
    if (serie.length > 1) {
      const X = (i) => x0 + (x1 - x0) * i / (nc - 1), Y = (v) => y1 - (y1 - y0) * clamp((v - gr.min) / (gr.max - gr.min), 0, 1);
      const n = serie.length - 1;
      const trazar = () => { c.beginPath(); serie.forEach((v, i) => (i ? c.lineTo(X(i), Y(v)) : c.moveTo(X(i), Y(v)))); };
      trazar(); c.lineTo(X(n), y1); c.lineTo(X(0), y1); c.closePath();
      const grad = c.createLinearGradient(0, y0, 0, y1);
      grad.addColorStop(0, gr.color + "45"); grad.addColorStop(1, gr.color + "00");
      c.fillStyle = grad; c.fill();
      trazar();
      c.strokeStyle = gr.color; c.lineWidth = 5; c.lineJoin = "round"; c.lineCap = "round"; c.stroke();
      c.fillStyle = gr.color + "33"; c.beginPath(); c.arc(X(n), Y(serie[n]), 18, 0, 7); c.fill();
      c.fillStyle = gr.color; c.beginPath(); c.arc(X(n), Y(serie[n]), 9, 0, 7); c.fill();
    }
    gr.tex.needsUpdate = true;
  }
  let ncSeries = 140, pintado = 0;
  function series(caudal, temperatura, calidad, nc) {
    graficos[0].serie = caudal; graficos[1].serie = calidad; graficos[2].serie = temperatura;
    ncSeries = nc;
  }
  graficos.forEach((gr) => dibujarGrafico(gr, ncSeries));

  function actualizar3(t) {
    if (t - pintado > 0.08) { pintado = t; graficos.forEach((gr) => dibujarGrafico(gr, ncSeries)); }
    senales.forEach((o, j) => {
      const f = (t * 0.6 + j / 3) % 1;
      o.scale.setScalar(0.2 + f * 2.2);
      o.material.opacity = (1 - f) * 0.8;
    });
    for (const p of paquetes) {
      const f = (t * 0.55 + p.fase) % 1;
      p.m.position.copy(p.curva.getPoint(f));
      p.m.scale.setScalar(Math.sin(f * Math.PI) * 1.1 + 0.1);
    }
  }

  // =========================================================================
  // 5. Falla critica: la Fuente A se dispara de conductividad
  // =========================================================================
  const g4 = grupos[4];
  const Y4 = 1.2, Z4 = { A: -4.5, B: -1.5, C: 1.5, R: 4.5 };
  const lineas = {};
  for (const [k, z] of Object.entries(Z4)) {
    const rec = k === "R";
    lineas[k] = tuboRecto(g4, -13.3, -1.8, Y4, z,
      { r: rec ? 0.34 : 0.4, color: rec ? COLOR.verde : COLOR.agua, vel: 1.2, bridas: true });
    for (const x of [-10.5, -4.5]) pieza(cil(0.06, Y4 - 0.4, 8), M.aceroOscuro, g4, x, (Y4 - 0.4) / 2, z);
    if (rec) {
      pieza(caja(1.7, 1.3, 1.3), M.edificio, g4, -14.4, 0.65, z);
      pieza(caja(1.72, 0.14, 1.32), M.franjaAgua, g4, -14.4, 1.0, z);
      pieza(cil(0.32, 0.7, 20), M.naranja, g4, -14.4, 1.65, z);
    } else {
      pieza(cil(0.85, 2.6, 32), M.acero, g4, -14.4, 1.3, z);
      pieza(cil(0.87, 0.28, 32), M.franjaAgua, g4, -14.4, 1.9, z);
      pieza(cil(0.2, 0.2, 32, 0.88), M.aceroOscuro, g4, -14.4, 2.7, z);
    }
    etiqueta(g4, rec ? "Recuperación Intramuros" : `<i class="punto"></i>Fuente ${k}`, -14.4, rec ? 2.3 : 3.2, z,
      rec ? "rec" : "fuente");
  }
  pieza(cil(0.6, 11.4, 32), M.acero, g4, -1.15, Y4, 0).rotation.x = Math.PI / 2;
  tuboRecto(g4, -0.55, 9.3, Y4, 0, { r: 0.55, vel: 1.4, bridas: true });
  pieza(caja(3.8, 0.5, 3.8), M.hormigon, g4, 11.5, 0.25, 0);
  pieza(caja(3.3, 2.5, 3.3), M.edificio, g4, 11.5, 1.75, 0);
  for (const dz of [-0.8, 0.8]) {
    pieza(cil(0.7, 0.6, 32), M.aceroOscuro, g4, 11.5, 3.3, dz);
    pieza(cil(0.72, 0.08, 32), M.naranja, g4, 11.5, 3.62, dz);
  }
  const valvula = new THREE.Group();
  valvula.position.set(-8, Y4, Z4.A);
  g4.add(valvula);
  pieza(new THREE.TorusGeometry(0.62, 0.13, 14, 40), M.aceroOscuro, valvula).rotation.y = Math.PI / 2;
  const eje = new THREE.Group();
  valvula.add(eje);
  pieza(cil(0.55, 0.07, 40), M.naranja, eje).rotation.x = Math.PI / 2;
  pieza(cil(0.05, 0.5, 10), M.acero, valvula, 0, 0.85, 0);
  pieza(caja(0.55, 0.45, 0.55), M.naranja, valvula, 0, 1.3, 0);
  etiqueta(g4, "Válvula A", -8, Y4 + 1.75, Z4.A, "valvula");
  pieza(caja(0.38, 0.32, 0.38), M.edificio, g4, -11.6, Y4 + 0.56, Z4.A);
  const led = pieza(new THREE.SphereGeometry(0.09, 12, 8), plano(0x2fbf71), g4, -11.6, Y4 + 0.78, Z4.A);
  const letrero = etiqueta(g4, "ALERTA: Conductividad 3.900 µS/cm", -8, Y4 + 3.1, Z4.A, "alerta oculta");

  function actualizar4(f, t) {
    const A = lineas.A, destello = Math.sin(t * 8) > 0;
    A.color(!f.fa ? COLOR.agua : f.alarma ? (destello ? COLOR.rojo : 0xff8a7a) : COLOR.apagado);
    A.vel = f.vc >= 1 ? 0 : f.alarma ? 2.6 : 1.2;
    A.mat.uniforms.uA.value = f.vc >= 1 ? 0.55 : 1;
    eje.rotation.y = f.vc * Math.PI / 2;
    const k = 1 + 0.4 * f.rv;
    lineas.R.grupo.scale.set(1, k, k);
    lineas.R.vel = 1.2 + 0.9 * f.rv;
    led.material.color.setHex(f.alarma ? (destello ? COLOR.rojo : 0x5a1a14) : f.vc >= 1 ? COLOR.apagado : 0x2fbf71);
    letrero.element.classList.toggle("oculta", !f.letrero);
  }

  // =========================================================================
  // 6. CFO: modo A y modo B, cada uno sobre su pedestal (se puede pulsar)
  // =========================================================================
  const g5 = grupos[5];
  const millones = (v) => (v < 0 ? "−" : "") + Math.abs(v).toFixed(1).replace(".", ",");
  const cfo = modos.map((m, i) => {
    const color = i ? COLOR.naranja : COLOR.agua, clase = i ? "naranja" : "agua";
    const g = new THREE.Group();
    g.position.x = i ? 5.2 : -5.2;
    g5.add(g);
    const base = pieza(cil(3.8, 0.3, 64), M.edificio, g, 0, 0.15, 0);
    base.userData.modo = i;
    pieza(new THREE.TorusGeometry(3.8, 0.06, 8, 128), plano(color), g, 0, 0.3, 0).rotation.x = Math.PI / 2;
    etiqueta(g, m.nombre, 0, 7.2, 0, "titulo");

    // Status quo frente a CAPEX, al fondo y a la izquierda: detras de los
    // primeros anos, que son los bajos, para que no los tapen.
    const barras = new THREE.Group();
    barras.position.set(0, 0.3, -2.6);
    g.add(barras);
    const hSQ = 4, hC = m.capex / 15000 * 4;
    pieza(cil(0.45, hSQ, 32), new THREE.MeshStandardMaterial({ color: 0x9aa7ae, metalness: 0.4, roughness: 0.4 }), barras, -2.8, hSQ / 2, 0);
    pieza(cil(0.45, hC, 32), new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.4 }), barras, 0.2, hC / 2, 0);
    const notas = [
      etiqueta(barras, "<b>Status Quo</b>$2.193 COP/m³", -2.8, hSQ + 0.3, 0, "mini dos"),
      etiqueta(barras, `<b>CAPEX</b>${m.capex / 1000}k USD`, 0.2, hC + 0.3, 0, "mini dos " + clase),
    ];
    barras.scale.y = 0.001;

    // Ahorro neto acumulado, anos 0 a 5 (millones de COP), delante. Solo se
    // rotulan el primero y el ultimo: el recorrido de la inversion.
    const pil = new THREE.Group();
    pil.position.set(0, 1.9, 1.6);
    g.add(pil);
    pieza(caja(6.6, 0.04, 1.3), new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }), g, 0, 1.9, 1.6);
    for (let y = 0; y <= 5; y++) {
      const v = (y * m.evitado - (m.capex * TRM + y * m.opex * TRM)) / 1e6;
      const h = v / 100 * 2.6, c = v < 0 ? COLOR.rojo : COLOR.agua;
      pieza(caja(0.7, Math.max(Math.abs(h), 0.05), 0.7), brillo(c, 0.35), pil, -2.5 + y, h / 2, 0);
      if (y % 5) continue;
      const e = etiqueta(pil, millones(v), -2.5 + y, h >= 0 ? h + 0.15 : h - 0.15, 0.36, "valor");
      if (h < 0) e.center.set(0.5, 0);
      notas.push(e);
    }
    pil.scale.y = 0.001;
    const ley = etiqueta(g, "<b>Ahorro neto acumulado</b>años 0–5 (millones COP)", 0, 0.5, 3.4, "mini dos");
    ley.center.set(0.5, 0);
    notas.push(ley);
    return { base, barras, pil, notas };
  });

  function actualizar5(abiertos, dt) {
    cfo.forEach((c, i) => {
      const meta = abiertos[i] ? 1 : 0.001;
      c.barras.scale.y += (meta - c.barras.scale.y) * Math.min(1, dt * 4);
      c.pil.scale.y = c.barras.scale.y;
      const ver = c.barras.scale.y > 0.5;
      c.notas.forEach((e) => e.element.classList.toggle("oculta", !ver));
    });
  }

  const rayo = new THREE.Raycaster(), puntero = new THREE.Vector2();
  function pedestalBajo(e) {
    if (!grupos[5].visible) return null;
    const r = renderer.domElement.getBoundingClientRect();
    puntero.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    rayo.setFromCamera(puntero, camara);
    const hit = rayo.intersectObjects(cfo.map((c) => c.base))[0];
    return hit ? hit.object.userData.modo : null;
  }
  let pulsado = null;
  renderer.domElement.addEventListener("pointerdown", (e) => { pulsado = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!pulsado || Math.hypot(e.clientX - pulsado.x, e.clientY - pulsado.y) > 6) return;
    const i = pedestalBajo(e);
    if (i !== null) alElegirModo(i);
  });
  renderer.domElement.addEventListener("pointermove", (e) => {
    renderer.domElement.style.cursor = pedestalBajo(e) !== null ? "pointer" : "";
  });

  // =========================================================================
  // 7. ESG: la lluvia se ordena en la cifra de agua ahorrada
  // =========================================================================
  const g6 = grupos[6];
  const NR = 4500;
  const LLUVIA = { uT: TIEMPO, uE: { value: 0 }, uPx: PIXELES, uC: { value: new THREE.Color(COLOR.agua) } };
  const geoLluvia = new THREE.BufferGeometry();
  {
    const semillas = new Float32Array(NR * 4);
    for (let i = 0; i < NR; i++) semillas.set([(Math.random() - 0.5) * 28, Math.random() * 22, (Math.random() - 0.5) * 10, 2 + Math.random() * 3], i * 4);
    geoLluvia.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NR * 3), 3));
    geoLluvia.setAttribute("aS", new THREE.BufferAttribute(semillas, 4));
    geoLluvia.setAttribute("aT", new THREE.BufferAttribute(new Float32Array(NR * 3), 3));
  }
  function formarTexto() {
    const c = document.createElement("canvas");
    c.width = 1000; c.height = 260;
    const x = c.getContext("2d");
    x.fillStyle = "#000"; x.textAlign = "center"; x.textBaseline = "middle";
    x.font = "800 128px Figtree, system-ui, sans-serif"; x.fillText("31.270 m³/año", 500, 80);
    x.font = "800 104px Figtree, system-ui, sans-serif"; x.fillText("Ahorrados", 500, 200);
    const d = x.getImageData(0, 0, 1000, 260).data, P = [];
    for (let j = 0; j < 260; j += 3) for (let i = 0; i < 1000; i += 3) if (d[(j * 1000 + i) * 4 + 3] > 128) P.push(i, j);
    const destinos = geoLluvia.attributes.aT;
    for (let i = 0; i < NR; i++) {
      const k = Math.floor(Math.random() * (P.length / 2)) * 2;
      destinos.setXYZ(i, (P[k] - 500) / 1000 * 20, (130 - P[k + 1]) / 1000 * 20 + 5.4, (Math.random() - 0.5) * 0.4);
    }
    destinos.needsUpdate = true;
  }
  formarTexto();
  document.fonts?.load("800 128px Figtree").then(formarTexto, () => {});
  const lluvia = new THREE.Points(geoLluvia, new THREE.ShaderMaterial({
    uniforms: LLUVIA, transparent: true, depthWrite: false,
    vertexShader: `attribute vec4 aS; attribute vec3 aT; uniform float uT, uE, uPx;
      void main() {
        float fy = mod(aS.y - uT * aS.w, 22.0);
        vec3 f = vec3(aS.x + sin(uT * 1.3 + aS.y * 0.7) * 0.35, fy, aS.z + cos(uT * 1.1 + aS.x) * 0.25);
        vec3 w = aT + vec3(sin(uT * 2.0 + aT.y * 3.0), cos(uT * 1.7 + aT.x * 2.0), 0.0) * 0.05 * uE;
        vec4 mv = modelViewMatrix * vec4(mix(f, w, uE), 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (0.16 + 0.05 * uE) * uPx / -mv.z;
      }`,
    fragmentShader: `uniform vec3 uC;
      void main() {
        vec2 c = gl_PointCoord - 0.5; float d = length(c); if (d > 0.5) discard;
        float hi = smoothstep(0.18, 0.0, length(c - vec2(-0.1, 0.1)));
        gl_FragColor = vec4(mix(uC, vec3(1.0), hi * 0.8), 0.92 - d * 0.6);
        ${FIN_SHADER}
      }`,
  }));
  lluvia.frustumCulled = false;
  g6.add(lluvia);
  lamina(matAgua(COLOR.agua, 0.45, 0.7), g6, new THREE.CircleGeometry(9, 96), 0.02);
  const gotas = Array.from({ length: 8 }, () => {
    const o = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.6, 48), plano(0xffffff, { transparent: true, depthWrite: false }));
    o.rotation.x = -Math.PI / 2;
    o.position.y = 0.05;
    o.userData.f = Math.random();
    g6.add(o);
    return o;
  });
  const cAgua = new THREE.Color(COLOR.agua), cVerde = new THREE.Color(COLOR.verde);

  function actualizar6(forma, dt) {
    LLUVIA.uE.value = forma;
    LLUVIA.uC.value.lerpColors(cAgua, cVerde, forma);
    for (const o of gotas) {
      o.userData.f += dt * 0.8;
      if (o.userData.f >= 1) {
        o.userData.f = 0;
        const r = Math.sqrt(Math.random()) * 9, a = Math.random() * Math.PI * 2;
        o.position.set(Math.cos(a) * r, 0.05, Math.sin(a) * r);
      }
      o.scale.setScalar(0.4 + o.userData.f * 3);
      o.material.opacity = (1 - o.userData.f) * 0.7 * (1 - forma);
    }
  }

  // =========================================================================
  // Camara: cada vista es la caja del mundo que tiene que verse entera y la
  // direccion desde la que se mira. La distancia sale de proyectar las ocho
  // esquinas en el hueco que dejan los paneles.
  // =========================================================================
  // mece: amplitud (rad) del vaiven lento alrededor del objetivo, que mantiene
  // viva la escena sin perder el encuadre como lo haria un giro completo.
  const VISTAS = {
    0: { caja: [[-17.5, 0, -8.5], [14.5, 5.5, 5.5]], dir: [0.2, 0.66, 0.72], mece: 0.22 },
    1: { caja: [[-17, 0, -12], [18, 5, 14]], dir: [0.05, 0.8, 0.6], mece: 0.25 },
    "1b": { caja: [[10, 0, -11], [18, 10, -5]], dir: [0.55, 0.42, 0.72], mece: 0.12 },
    2: { caja: [[-11.5, 0, -3.5], [3.8, 10, 3.5]], dir: [0.36, 0.32, 0.88], mece: 0.3 },
    3: { caja: [[-11.8, 1.2, -0.5], [11.8, 6, 6.5]], dir: [0, 0.22, 0.98], mece: 0.06 },
    4: { caja: [[-17, 0, -5.5], [13.5, 4.5, 5.5]], dir: [-0.1, 0.66, 0.74], mece: 0.08 },
    5: { caja: [[-9.2, 0, -3.5], [9.2, 7.6, 3.8]], dir: [0, 0.3, 0.95], mece: 0.07 },
    6: { caja: [[-10.5, 2.5, -1], [10.5, 9, 1]], dir: [0, 0.12, 0.99], mece: 0.05 },
  };
  const EJE_Y = V(0, 1, 0);
  const quieto = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let clave = null, viaje = null, libre = { der: 0, abajo: 0, arriba: 0 }, manos = false, soltar = 0;
  let meceAnterior = null, meceInicio = 0;

  function destino(k) {
    const v = VISTAS[k], W = innerWidth, H = innerHeight;
    const fW = Math.max(240, W - libre.der) / W, fH = Math.max(240, H - libre.abajo - libre.arriba) / H;
    const tanV = Math.tan(THREE.MathUtils.degToRad(camara.fov / 2)), tanH = tanV * W / H;
    const [a, b] = v.caja, obj = V((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    const dir = V(...v.dir).normalize();
    const der = V().crossVectors(dir.clone().negate(), V(0, 1, 0)).normalize(), arriba = V().crossVectors(der, dir.clone().negate());
    let d = 0;
    for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) {
      const p = V(x, y, z).sub(obj), cerca = p.dot(dir);
      d = Math.max(d, Math.abs(p.dot(der)) / (fW * tanH) + cerca, Math.abs(p.dot(arriba)) / (fH * tanV) + cerca);
    }
    return { obj, pos: obj.clone().addScaledVector(dir, d * 1.04) };
  }

  function vista(k, inmediata = false) {
    clave = k;
    const { obj, pos } = destino(k);
    viaje = {
      t: 0, dur: inmediata || quieto ? 0.001 : 2.2,
      p0: camara.position.clone(), p1: pos, o0: controles.target.clone(), o1: obj,
      arco: camara.position.distanceTo(pos) * 0.12,
    };
  }

  function desplazamiento() {
    const W = innerWidth, H = innerHeight;
    camara.aspect = W / H;
    if (renderer.xr.isPresenting) camara.clearViewOffset();
    else camara.setViewOffset(W, H, libre.der / 2, (libre.abajo - libre.arriba) / 2, W, H);
    camara.updateProjectionMatrix();
    PIXELES.value = H * renderer.getPixelRatio() / (2 * Math.tan(THREE.MathUtils.degToRad(camara.fov / 2)));
  }

  function encuadre(m) {
    const cambio = Math.abs(m.der - libre.der) + Math.abs(m.abajo - libre.abajo) + Math.abs(m.arriba - libre.arriba);
    libre = m;
    desplazamiento();
    if (clave !== null && cambio > 4) vista(clave);
  }

  controles.addEventListener("start", () => {
    manos = true;
    viaje = null;
    clearTimeout(soltar);
  });
  controles.addEventListener("end", () => {
    soltar = setTimeout(() => { manos = false; meceAnterior = null; }, 5000);
  });

  addEventListener("resize", () => {
    renderer.setSize(innerWidth, innerHeight);
    etiquetas.setSize(innerWidth, innerHeight);
    desplazamiento();
    if (clave !== null) vista(clave, true);
  });
  desplazamiento();

  function camaraCuadro(dt, t) {
    if (viaje) {
      viaje.t += dt;
      const u = clamp(viaje.t / viaje.dur, 0, 1), e = vaiven(u);
      camara.position.lerpVectors(viaje.p0, viaje.p1, e);
      camara.position.y += Math.sin(u * Math.PI) * viaje.arco;
      controles.target.lerpVectors(viaje.o0, viaje.o1, e);
      if (u >= 1) { viaje = null; meceAnterior = null; }
    } else if (!manos && !quieto && clave !== null) {
      // El vaiven arranca en cero donde se dejo la camara: oscila a ambos lados.
      if (meceAnterior === null) { meceInicio = t; meceAnterior = 0; }
      const a = Math.sin((t - meceInicio) * 0.16) * VISTAS[clave].mece;
      const brazo = camara.position.clone().sub(controles.target).applyAxisAngle(EJE_Y, a - meceAnterior);
      camara.position.copy(controles.target).add(brazo);
      meceAnterior = a;
    }
    controles.update();
  }

  // =========================================================================
  // Realidad aumentada (WebXR), cuando el dispositivo la ofrece
  // =========================================================================
  const ar = {
    async soportado() {
      try { return Boolean(navigator.xr && await navigator.xr.isSessionSupported("immersive-ar")); } catch { return false; }
    },
    async alternar() {
      if (renderer.xr.isPresenting) { renderer.xr.getSession().end(); return; }
      const s = await navigator.xr.requestSession("immersive-ar",
        { optionalFeatures: ["local-floor", "dom-overlay"], domOverlay: { root: document.body } });
      await renderer.xr.setSession(s);
    },
  };
  renderer.xr.addEventListener("sessionstart", () => {
    mundo.scale.setScalar(0.04);
    mundo.position.set(0, -0.4, -1.4);
    suelo.visible = false;
    etiquetas.domElement.style.display = "none";
    desplazamiento();
    document.body.classList.add("en-ar");
  });
  renderer.xr.addEventListener("sessionend", () => {
    mundo.scale.setScalar(1);
    mundo.position.set(0, 0, 0);
    suelo.visible = !grupos[1].visible;
    etiquetas.domElement.style.display = "";
    desplazamiento();
    document.body.classList.remove("en-ar");
  });

  // =========================================================================

  function entrar(i) {
    grupos.forEach((g, j) => { g.visible = j === i; });
    suelo.visible = sombra.visible = i !== 1 && !renderer.xr.isPresenting;
    suelo.material.uniforms.uR.value = [46, 0, 26, 30, 30, 26, 30][i];
  }

  function cuadro(dt, ctx) {
    TIEMPO.value = ctx.reloj;
    for (const t of tubos) {
      t.fase += dt * t.vel * 0.8;
      t.mat.uniforms.uF.value = t.fase;
      t.mat.uniforms.uV.value = clamp(t.vel, 0, 1);
    }
    switch (ctx.modulo) {
      case 0: actualizar0(ctx.P, ctx.reloj, dt); break;
      case 1: actualizar1(ctx.reloj, ctx.fuenteB); break;
      case 2: agitador.rotation.y += dt * 2; break;
      case 3: actualizar3(ctx.reloj); break;
      case 4: actualizar4(ctx.falla, ctx.reloj); break;
      case 5: actualizar5(ctx.cfo, dt); break;
      case 6: actualizar6(ctx.forma, dt); break;
    }
    if (!renderer.xr.isPresenting) camaraCuadro(dt, ctx.reloj);
    renderer.render(escena, camara);
    if (!renderer.xr.isPresenting) etiquetas.render(escena, camara);
  }

  return { renderer, entrar, vista, encuadre, mezcla, series, cuadro, ar };
}
