/* Modo conversacion: hablarle al asistente sin tocar el teclado.
 *
 * Con el modo activo el microfono queda abierto. Lo que se dice aparece en el
 * compositor mientras se habla; al callarse un momento, la pregunta se envia
 * sola; el asistente contesta en voz alta y, al terminar, vuelve a escuchar.
 * Si se le habla mientras contesta, se calla y escucha: se le puede
 * interrumpir a media frase.
 *
 * Dos piezas del navegador:
 *   - SpeechRecognition (Chrome, Edge, Safari) pasa la voz a texto.
 *   - getUserMedia, con cancelacion de eco, y un analizador miden cuanto suena
 *     el microfono. Con eso se detecta que alguien empezo a hablar mientras
 *     suena la respuesta (el reconocimiento esta apagado entonces, para no
 *     transcribir la voz del propio asistente) y el orbe late con quien habla.
 *
 * Estados: inactiva -> escuchando -> esperando (la respuesta se esta
 * generando) -> hablando -> escuchando ... Quien lo usa avisa de los cambios
 * que solo el conoce: cuando empieza a sonar la respuesta (hablando) y cuando
 * termina (escuchar).
 */

const PAUSA_MS = 1300;           // silencio que da el turno por terminado
const INTERRUPCION_MS = 300;     // voz sostenida que cuenta como interrupcion
const UMBRAL_MINIMO = 0.018;     // nivel (RMS) del microfono que ya es voz
const MEDIR_MS = 50;

export function hayConversacion() {
  return Boolean((window.SpeechRecognition || window.webkitSpeechRecognition) && navigator.mediaDevices?.getUserMedia);
}

/**
 * @param {object} o
 * @param {() => AudioContext} o.contextoAudio  el mismo contexto que reproduce la voz
 * @param {(texto: string) => void} o.alTexto   lo reconocido hasta ahora, para mostrarlo
 * @param {(texto: string) => void} o.alTurno   la pregunta, cuando el usuario se calla
 * @param {(estado: string) => void} o.alEstado
 * @param {() => void} o.alInterrumpir          el usuario hablo encima: hay que callar
 * @param {(nivel: number) => void} [o.alNivel] nivel del microfono mientras escucha
 * @param {() => number} [o.nivelSalida]        nivel de la voz del asistente (eco esperable)
 * @param {(mensaje: string) => void} [o.alError]
 */
export function crearConversacion(o) {
  let activa = false;
  let estado = "inactiva";
  let rec = null, reconociendo = false, actual = "", pausa = 0;
  let reinicios = [];
  let flujo = null, fuente = null, analizador = null, muestras = null, medidor = 0;
  let piso = 0.01, voz = 0;

  function cambiar(nuevo) {
    estado = nuevo;
    o.alEstado(nuevo);
  }

  // -- reconocimiento ------------------------------------------------------

  function nuevoReconocimiento() {
    const Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new Reconocimiento();
    r.lang = "es-CO";
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (ev) => {
      let texto = "";
      for (let i = 0; i < ev.results.length; i++) texto += ev.results[i][0].transcript;
      actual = texto.replace(/\s+/g, " ").trim();
      o.alTexto(actual);
      clearTimeout(pausa);
      pausa = setTimeout(cerrarTurno, PAUSA_MS);
    };
    r.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") fallar("El navegador no deja usar el micrófono para dictar.");
      else if (ev.error === "audio-capture") fallar("No encuentro ningún micrófono.");
      // no-speech, network, aborted: onend vuelve a intentarlo.
    };
    r.onend = () => {
      reconociendo = false;
      if (!activa || estado !== "escuchando") return;
      // Safari corta la sesion al callarse: si ya habia algo, es el turno.
      if (actual.trim()) cerrarTurno(); else reintentar();
    };
    return r;
  }

  function arrancarReconocimiento() {
    if (reconociendo) return;
    rec = nuevoReconocimiento();
    try { rec.start(); reconociendo = true; } catch { reconociendo = false; }
  }

  function pararReconocimiento() {
    clearTimeout(pausa);
    if (rec) {
      rec.onresult = rec.onerror = rec.onend = null;
      try { rec.abort(); } catch { /* ya parado */ }
      rec = null;
    }
    reconociendo = false;
  }

  function reintentar() {
    const ahora = Date.now();
    reinicios = reinicios.filter((t) => ahora - t < 10_000);
    reinicios.push(ahora);
    if (reinicios.length > 6) { fallar("El reconocimiento de voz se detiene una y otra vez."); return; }
    setTimeout(() => { if (activa && estado === "escuchando") arrancarReconocimiento(); }, 250);
  }

  function cerrarTurno() {
    if (estado !== "escuchando" || !actual.trim()) return;
    const texto = actual.trim();
    actual = "";
    pararReconocimiento();
    cambiar("esperando");
    o.alTurno(texto);
  }

  // -- microfono: nivel y deteccion de interrupciones -----------------------

  async function abrirMicrofono() {
    flujo = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const ctx = o.contextoAudio();
    await ctx.resume?.();
    fuente = ctx.createMediaStreamSource(flujo);
    analizador = ctx.createAnalyser();
    analizador.fftSize = 1024;
    fuente.connect(analizador);           // no va a los altavoces: solo se mide
    muestras = new Float32Array(analizador.fftSize);
    medidor = setInterval(medir, MEDIR_MS);
  }

  function nivel() {
    analizador.getFloatTimeDomainData(muestras);
    let suma = 0;
    for (const v of muestras) suma += v * v;
    return Math.sqrt(suma / muestras.length);
  }

  function medir() {
    if (!analizador) return;
    const n = nivel();
    // Ruido de fondo: baja de golpe, sube muy despacio.
    piso = n < piso ? n : piso + (n - piso) * 0.003;
    if (estado === "escuchando") { o.alNivel?.(n); return; }
    if (estado !== "hablando") { voz = 0; return; }
    // Mientras suena la respuesta, algo de ella se cuela por el microfono aunque
    // haya cancelacion de eco: el umbral sube con lo fuerte que suena.
    const umbral = Math.max(UMBRAL_MINIMO * 1.5, piso * 3, (o.nivelSalida?.() || 0) * 0.6);
    voz = n > umbral ? voz + MEDIR_MS : Math.max(0, voz - MEDIR_MS / 2);
    if (voz >= INTERRUPCION_MS) {
      voz = 0;
      o.alInterrumpir();
      escuchar();
    }
  }

  function cerrarMicrofono() {
    clearInterval(medidor);
    medidor = 0;
    try { fuente?.disconnect(); } catch { /* nada */ }
    flujo?.getTracks().forEach((t) => t.stop());
    flujo = fuente = analizador = null;
  }

  function fallar(mensaje) {
    terminar();
    o.alError?.(mensaje);
  }

  // -- control ---------------------------------------------------------------

  function escuchar() {
    if (!activa) return;
    actual = "";
    cambiar("escuchando");
    arrancarReconocimiento();
  }

  function terminar() {
    if (!activa && estado === "inactiva") return;
    activa = false;
    pararReconocimiento();
    cerrarMicrofono();
    cambiar("inactiva");
  }

  return {
    activa: () => activa,
    estado: () => estado,
    async empezar() {
      if (activa) return;
      activa = true;
      reinicios = [];
      try {
        await abrirMicrofono();
      } catch (e) {
        activa = false;
        throw new Error(e?.name === "NotAllowedError" ? "Sin permiso para usar el micrófono." : "No se pudo abrir el micrófono.");
      }
      escuchar();
    },
    terminar,
    /** Vuelve a escuchar: la respuesta termino de sonar (o no tenia voz). */
    escuchar,
    /** La respuesta empezo a sonar: se apaga el dictado y se vigilan interrupciones. */
    hablando() {
      if (!activa) return;
      pararReconocimiento();
      voz = 0;
      cambiar("hablando");
    },
    /** Se envio una pregunta escrita: deja de dictar hasta que acabe la respuesta. */
    esperar() {
      if (!activa) return;
      pararReconocimiento();
      cambiar("esperando");
    },
  };
}
