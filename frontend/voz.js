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
 * Una subida del microfono mientras suena la respuesta no basta para cortarla:
 * puede ser el eco de su propia voz o un ruido. Se pausa la respuesta y se
 * escucha (confirmando); si llegan palabras es una interrupcion y la respuesta
 * se descarta, y si no, sigue donde iba.
 *
 * Estados: inactiva -> escuchando -> esperando (la respuesta se esta
 * generando) -> hablando [-> confirmando -> hablando | escuchando] ->
 * escuchando ... Quien lo usa avisa de los cambios que solo el conoce: cuando
 * empieza a sonar la respuesta (hablando) y cuando termina (escuchar).
 */

const PAUSA_FINAL_MS = 900;          // silencio tras una frase que el reconocedor ya dio por cerrada
const PAUSA_PARCIAL_MS = 1700;       // silencio tras una frase a medias: quiza solo esta pensando
const INTERRUPCION_MS = 300;         // voz sostenida que hace sospechar una interrupcion
const CONFIRMAR_MS = 3000;           // lo que se espera, como mucho, a que la sospecha traiga palabras
const SILENCIO_CONFIRMAR_MS = 1200;  // silencio que la descarta antes
const UMBRAL_MINIMO = 0.018;         // nivel (RMS) del microfono que ya es voz
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
 * @param {() => void} o.alPausar               parece que hablan encima: pausar la respuesta
 * @param {() => void} o.alReanudar             no era nadie: seguir donde iba
 * @param {() => void} o.alInterrumpir          el usuario hablo encima: hay que callar
 * @param {(nivel: number) => void} [o.alNivel] nivel del microfono mientras escucha
 * @param {() => number} [o.nivelSalida]        nivel de la voz del asistente (eco esperable)
 * @param {(mensaje: string) => void} [o.alError]
 */
export function crearConversacion(o) {
  let activa = false;
  let estado = "inactiva";
  let rec = null, reconociendo = false, actual = "", pausa = 0, reintento = 0;
  let reinicios = [];
  let flujo = null, fuente = null, analizador = null, muestras = null, medidor = 0;
  let piso = 0.01, voz = 0, salida = 0;
  let sospechaDesde = 0, silencio = 0;

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
      const resultados = [...ev.results];
      actual = resultados.map((x) => x[0].transcript).join(" ").replace(/\s+/g, " ").trim();
      if (!actual) return;
      reinicios = [];
      if (estado === "confirmando") {
        // Llegaron palabras: era alguien hablando, no el eco de la respuesta.
        if (actual.length < 2) return;
        o.alInterrumpir();
        cambiar("escuchando");
      }
      if (estado !== "escuchando") return;
      o.alTexto(actual);
      clearTimeout(pausa);
      const cerrada = resultados[resultados.length - 1].isFinal;
      pausa = setTimeout(cerrarTurno, cerrada ? PAUSA_FINAL_MS : PAUSA_PARCIAL_MS);
    };
    r.onerror = (ev) => {
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") fallar("El navegador no deja usar el micrófono para dictar.");
      else if (ev.error === "audio-capture") fallar("No encuentro ningún micrófono.");
      // no-speech, network, aborted: onend vuelve a intentarlo.
    };
    r.onend = () => {
      reconociendo = false;
      if (!activa) return;
      // Safari corta la sesion al callarse: si ya habia algo, es el turno.
      if (estado === "escuchando" && actual.trim()) cerrarTurno();
      else if (estado === "escuchando" || estado === "confirmando") reintentar();
    };
    return r;
  }

  function arrancarReconocimiento() {
    if (reconociendo) return;
    rec = nuevoReconocimiento();
    // Si no arranca (el anterior aun se esta cerrando), lo reintenta el medidor.
    try { rec.start(); reconociendo = true; } catch { reconociendo = false; }
  }

  function pararReconocimiento() {
    clearTimeout(pausa);
    clearTimeout(reintento);
    reintento = 0;
    if (rec) {
      rec.onresult = rec.onerror = rec.onend = null;
      try { rec.abort(); } catch { /* ya parado */ }
      rec = null;
    }
    reconociendo = false;
  }

  function reintentar() {
    if (reintento) return;
    const ahora = Date.now();
    reinicios = reinicios.filter((t) => ahora - t < 10_000);
    reinicios.push(ahora);
    if (reinicios.length > 6) { fallar("El reconocimiento de voz se detiene una y otra vez."); return; }
    reintento = setTimeout(() => {
      reintento = 0;
      if (activa && (estado === "escuchando" || estado === "confirmando")) arrancarReconocimiento();
    }, 250);
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
    // La voz del asistente vuelve al microfono con retraso (y mas aun con
    // altavoces bluetooth): se compara contra su pico reciente, no contra el
    // instante, para que el eco de una palabra no cuente en el hueco siguiente.
    salida = Math.max(o.nivelSalida?.() || 0, salida * 0.85);
    if (estado === "escuchando") {
      o.alNivel?.(n);
      // El reconocedor se cayo sin avisar o no llego a arrancar: se levanta.
      if (!reconociendo && !reintento) reintentar();
      return;
    }
    if (estado === "confirmando") { o.alNivel?.(n); vigilarSospecha(n); return; }
    if (estado !== "hablando") { voz = 0; return; }
    // Mientras suena la respuesta, algo de ella se cuela por el microfono aunque
    // haya cancelacion de eco: el umbral sube con lo fuerte que suena.
    const umbral = Math.max(UMBRAL_MINIMO * 1.5, piso * 3, salida * 0.6);
    voz = n > umbral ? voz + MEDIR_MS : Math.max(0, voz - MEDIR_MS / 2);
    if (voz >= INTERRUPCION_MS) sospechar();
  }

  function sospechar() {
    voz = 0;
    silencio = 0;
    sospechaDesde = Date.now();
    actual = "";
    cambiar("confirmando");
    o.alPausar();
    arrancarReconocimiento();
  }

  function vigilarSospecha(n) {
    silencio = n > Math.max(UMBRAL_MINIMO, piso * 3) ? 0 : silencio + MEDIR_MS;
    if (silencio < SILENCIO_CONFIRMAR_MS && Date.now() - sospechaDesde < CONFIRMAR_MS) return;
    // Ni una palabra: era su propio eco o un ruido. La respuesta sigue.
    pararReconocimiento();
    actual = "";
    cambiar("hablando");
    o.alReanudar();
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
    if (!activa || estado === "escuchando") return;
    actual = "";
    cambiar("escuchando");
    arrancarReconocimiento();
  }

  function terminar() {
    if (!activa && estado === "inactiva") return;
    activa = false;
    pararReconocimiento();
    cerrarMicrofono();
    salida = 0;
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
      if (!activa || estado === "confirmando") return;
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
