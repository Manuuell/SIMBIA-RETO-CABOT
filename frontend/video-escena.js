/* Escenario 3D del video en bucle (video.html): la falla critica y el ESG.
 *
 * Son las dos escenas del recorrido 3D que el video muestra, con los mismos
 * materiales, tuberias y equipos que demo3d-v1-escena.js, pero sobre un lienzo
 * de tamano fijo (el escenario de 1280x720 del video, que se escala entero
 * para caber en la pantalla) y sin mandos: la camara la lleva el reloj del
 * video.
 *
 *   crearEscena(contenedor, { ancho, alto, libre }) -> {
 *     entrar(clave), medida(escala), calentar(), cuadro(dt, ctx)
 *   }
 *
 * clave: "falla" o "esg". ctx: { reloj, falla: { fa, alarma, vc, rv, letrero },
 * forma } (forma, de 0 a 1: cuanto se ha ordenado la lluvia en la gota).
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

const COLOR = {
  agua: 0x1f9fb0, verde: 0x178452, naranja: 0xf2762e, rojo: 0xd2402f, apagado: 0xa7b2b9,
};

const clamp = THREE.MathUtils.clamp;
const vaiven = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// Los ShaderMaterial no pasan solos por el tono ni por el espacio de color de
// salida: sin esto sus colores no casan con los de los materiales PBR.
const FIN_SHADER = "#include <tonemapping_fragment>\n#include <colorspace_fragment>";

const TIEMPO = { value: 0 };
const PIXELES = { value: 600 };   // alto del lienzo / (2 tan(fov/2)): tamano de las gotas en mundo

// ---------------------------------------------------------------------------
// Texturas y materiales
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

// Suelo de estudio: blanco con rejilla de 1 y 5 m que se funde con el fondo
// del escenario a partir de uR.
function matSuelo() {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, toneMapped: false,
    uniforms: {
      uR: { value: 30 }, uBase: { value: new THREE.Color(0xffffff) }, uLinea: { value: new THREE.Color(0x9fb1ba) },
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
  const pbr = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1, ...o });
  return {
    acero: pbr(0xe3e8eb, { metalness: 0.5, roughness: 0.3 }),
    aceroOscuro: pbr(0x51606a, { metalness: 0.7, roughness: 0.35 }),
    hormigon: pbr(0xffffff, { map: textura(hormigon, 2, 2), roughness: 0.92, metalness: 0 }),
    naranja: pbr(COLOR.naranja, { metalness: 0.25, roughness: 0.45 }),
    edificio: pbr(0xf3f5f6, { roughness: 0.8, metalness: 0 }),
    franjaAgua: pbr(COLOR.agua),
  };
}

const plano = (color, o = {}) => new THREE.MeshBasicMaterial({ color, toneMapped: false, ...o });
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
// Escena
// ---------------------------------------------------------------------------

export function crearEscena(contenedor, { ancho, alto, libre = { der: 0, abajo: 0, arriba: 0 } }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setSize(ancho, alto);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  contenedor.appendChild(renderer.domElement);

  const etiquetas = new CSS2DRenderer();
  etiquetas.setSize(ancho, alto);
  etiquetas.domElement.className = "etiquetas3d";
  contenedor.appendChild(etiquetas.domElement);

  const escena = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  escena.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  escena.environmentIntensity = 0.5;

  const camara = new THREE.PerspectiveCamera(40, ancho / alto, 0.5, 400);
  camara.setViewOffset(ancho, alto, libre.der / 2, (libre.abajo - libre.arriba) / 2, ancho, alto);
  const objetivo = V(0, 0, 0);

  escena.add(new THREE.HemisphereLight(0xffffff, 0xb8c4c9, 0.9));
  const sol = new THREE.DirectionalLight(0xfff4e6, 2.1);
  sol.position.set(18, 34, 22);
  sol.castShadow = true;
  sol.shadow.mapSize.set(2048, 2048);
  Object.assign(sol.shadow.camera, { left: -36, right: 36, top: 36, bottom: -36, near: 1, far: 120 });
  sol.shadow.bias = -0.0004;
  sol.shadow.normalBias = 0.02;
  escena.add(sol);

  const suelo = new THREE.Mesh(new THREE.PlaneGeometry(240, 240).rotateX(-Math.PI / 2), matSuelo());
  suelo.renderOrder = -2;
  escena.add(suelo);
  const sombra = new THREE.Mesh(new THREE.PlaneGeometry(240, 240).rotateX(-Math.PI / 2),
    new THREE.ShadowMaterial({ color: 0x0b2530, opacity: 0.16 }));
  sombra.position.y = 0.004;
  sombra.receiveShadow = true;
  sombra.renderOrder = -1;
  escena.add(sombra);

  const M = materiales();
  const grupos = { falla: new THREE.Group(), esg: new THREE.Group() };
  for (const g of Object.values(grupos)) { g.visible = false; escena.add(g); }

  const tubos = [];
  function tubo(padre, puntos, { r = 0.16, color = COLOR.agua, vel = 1, bridas = false } = {}) {
    const ruta = new THREE.LineCurve3(puntos[0], puntos[1]);
    const largo = ruta.getLength();
    const geo = new THREE.TubeGeometry(ruta, Math.max(4, Math.round(largo * 5)), r, 16, false);
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
    const t = { malla, mat, vel, fase: Math.random(), color(hex) { mat.uniforms.uC.value.setHex(hex); } };
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
  // Falla critica: la Fuente A se dispara de conductividad, su valvula cierra
  // y la recuperacion intramuros compensa el caudal.
  // =========================================================================
  const g4 = grupos.falla;
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

  function actualizarFalla(f, t) {
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
  // ESG: la lluvia cae sobre el estanque y se ordena en una gota de agua que
  // pasa de azul a verde.
  // =========================================================================
  const g6 = grupos.esg;
  const NR = 4500, GOTA = { y: 4.4, r: 2.25 };
  const LLUVIA = { uT: TIEMPO, uE: { value: 0 }, uPx: PIXELES, uC: { value: new THREE.Color(COLOR.agua) } };
  const geoLluvia = new THREE.BufferGeometry();
  {
    const semillas = new Float32Array(NR * 4), destinos = new Float32Array(NR * 3);
    for (let i = 0; i < NR; i++) {
      semillas.set([(Math.random() - 0.5) * 28, Math.random() * 22, (Math.random() - 0.5) * 10, 2 + Math.random() * 3], i * 4);
      // Punto de la gota: esfera cuyo hemisferio de arriba se estira y se
      // estrecha hacia la punta. La mayoria en la superficie, que es la que
      // dibuja la silueta; unos pocos dentro le dan cuerpo.
      const u = V(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      const r = GOTA.r * (Math.random() < 0.85 ? 1 : Math.cbrt(Math.random()) * 0.9);
      const k = Math.max(0, u.y), estrecho = 1 - 0.7 * k * k;
      destinos.set([u.x * r * estrecho, GOTA.y + u.y * r * (1 + 0.95 * k), u.z * r * estrecho], i * 3);
    }
    geoLluvia.setAttribute("position", new THREE.BufferAttribute(new Float32Array(NR * 3), 3));
    geoLluvia.setAttribute("aS", new THREE.BufferAttribute(semillas, 4));
    geoLluvia.setAttribute("aT", new THREE.BufferAttribute(destinos, 3));
  }
  const lluvia = new THREE.Points(geoLluvia, new THREE.ShaderMaterial({
    uniforms: LLUVIA, transparent: true, depthWrite: false,
    vertexShader: `attribute vec4 aS; attribute vec3 aT; uniform float uT, uE, uPx;
      void main() {
        float fy = mod(aS.y - uT * aS.w, 22.0);
        vec3 f = vec3(aS.x + sin(uT * 1.3 + aS.y * 0.7) * 0.35, fy, aS.z + cos(uT * 1.1 + aS.x) * 0.25);
        vec3 w = aT + vec3(sin(uT * 2.0 + aT.y * 3.0), cos(uT * 1.7 + aT.x * 2.0), sin(uT * 1.5 + aT.z * 2.5)) * 0.04 * uE;
        vec4 mv = modelViewMatrix * vec4(mix(f, w, uE), 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (0.16 + 0.04 * uE) * uPx / -mv.z;
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
  lamina(matAgua(COLOR.agua, 0.42, 1.3), g6, new THREE.CircleGeometry(4.8, 96), 0.02);
  const ondas = Array.from({ length: 8 }, () => {
    const o = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.6, 48), plano(0xffffff, { transparent: true, depthWrite: false }));
    o.rotation.x = -Math.PI / 2;
    o.position.y = 0.05;
    o.userData.f = Math.random();
    g6.add(o);
    return o;
  });
  const cAgua = new THREE.Color(COLOR.agua), cVerde = new THREE.Color(0x22a865);

  function actualizarEsg(forma, dt) {
    LLUVIA.uE.value = forma;
    LLUVIA.uC.value.lerpColors(cAgua, cVerde, forma);
    for (const o of ondas) {
      o.userData.f += dt * 0.8;
      if (o.userData.f >= 1) {
        o.userData.f = 0;
        const r = Math.sqrt(Math.random()) * 4.2, a = Math.random() * Math.PI * 2;
        o.position.set(Math.cos(a) * r, 0.05, Math.sin(a) * r);
      }
      o.scale.setScalar(0.4 + o.userData.f * 3);
      o.material.opacity = (1 - o.userData.f) * 0.7 * (1 - forma);
    }
  }

  // =========================================================================
  // Camara: cada vista es la caja del mundo que tiene que verse entera y la
  // direccion desde la que se mira; la distancia sale de proyectar las ocho
  // esquinas en el hueco que deja el panel. Al entrar, la camara llega desde
  // un poco mas lejos y de lado; despues se mece despacio.
  // =========================================================================
  const VISTAS = {
    falla: { caja: [[-17, 0, -5.5], [13.5, 4.5, 5.5]], dir: [-0.12, 0.52, 0.85], mece: 0.08, uR: 30 },
    esg: { caja: [[-6.5, 0, -4.8], [6.5, 9.6, 4.8]], dir: [0, 0.26, 0.97], mece: 0.06, uR: 30 },
  };
  const EJE_Y = V(0, 1, 0);
  const quieto = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let clave = null, viaje = null, meceAnterior = 0, meceT = 0;

  function destino(k) {
    const v = VISTAS[k];
    const fW = (ancho - libre.der) / ancho, fH = (alto - libre.abajo - libre.arriba) / alto;
    const tanV = Math.tan(THREE.MathUtils.degToRad(camara.fov / 2)), tanH = tanV * ancho / alto;
    const [a, b] = v.caja, obj = V((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
    const dir = V(...v.dir).normalize();
    const der = V().crossVectors(dir.clone().negate(), EJE_Y).normalize(), arriba = V().crossVectors(der, dir.clone().negate());
    let d = 0;
    for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) {
      const p = V(x, y, z).sub(obj), cerca = p.dot(dir);
      d = Math.max(d, Math.abs(p.dot(der)) / (fW * tanH) + cerca, Math.abs(p.dot(arriba)) / (fH * tanV) + cerca);
    }
    return { obj, pos: obj.clone().addScaledVector(dir, d * 1.04) };
  }

  function entrar(k) {
    clave = k;
    for (const [n, g] of Object.entries(grupos)) g.visible = n === k;
    suelo.material.uniforms.uR.value = VISTAS[k].uR;
    const { obj, pos } = destino(k);
    const desde = pos.clone().sub(obj).multiplyScalar(1.16).applyAxisAngle(EJE_Y, -0.22).add(obj);
    desde.y += 1.5;
    viaje = { t: 0, dur: quieto ? 0.001 : 3.4, p0: desde, p1: pos, obj };
    camara.position.copy(desde);
    objetivo.copy(obj);
    camara.lookAt(objetivo);
    meceAnterior = 0; meceT = 0;
  }

  function camaraCuadro(dt) {
    if (viaje) {
      viaje.t += dt;
      const e = vaiven(clamp(viaje.t / viaje.dur, 0, 1));
      camara.position.lerpVectors(viaje.p0, viaje.p1, e);
      if (viaje.t >= viaje.dur) viaje = null;
    } else if (!quieto && clave) {
      meceT += dt;
      const a = Math.sin(meceT * 0.16) * VISTAS[clave].mece;
      const brazo = camara.position.clone().sub(objetivo).applyAxisAngle(EJE_Y, a - meceAnterior);
      camara.position.copy(objetivo).add(brazo);
      meceAnterior = a;
    }
    camara.lookAt(objetivo);
  }

  // El escenario del video se dibuja a 1280x720 y se escala para caber en la
  // pantalla: el lienzo se pinta a la resolucion final para que no se vea
  // borroso.
  function medida(escala) {
    renderer.setPixelRatio(Math.min(2.5, (window.devicePixelRatio || 1) * escala));
    renderer.setSize(ancho, alto);
    PIXELES.value = alto * renderer.getPixelRatio() / (2 * Math.tan(THREE.MathUtils.degToRad(camara.fov / 2)));
  }

  // Compila los programas de las dos escenas de antemano: la primera vez que
  // aparece cada una no hay tiron.
  function calentar() {
    for (const g of Object.values(grupos)) g.visible = true;
    renderer.compile(escena, camara);
    for (const g of Object.values(grupos)) g.visible = false;
  }

  function cuadro(dt, ctx) {
    TIEMPO.value = ctx.reloj;
    for (const t of tubos) {
      t.fase += dt * t.vel * 0.8;
      t.mat.uniforms.uF.value = t.fase;
      t.mat.uniforms.uV.value = clamp(t.vel, 0, 1);
    }
    if (clave === "falla" && ctx.falla) actualizarFalla(ctx.falla, ctx.reloj);
    if (clave === "esg") actualizarEsg(ctx.forma, dt);
    camaraCuadro(dt);
    renderer.render(escena, camara);
    etiquetas.render(escena, camara);
  }

  return { entrar, medida, calentar, cuadro };
}
