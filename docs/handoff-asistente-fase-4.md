# Handoff · Asistente de SIMBIA, fase 4: memoria

*Escrito el 19 de octubre de 2026, al cerrar la fase 3. La fase 4 quedó para más adelante a propósito; este documento es lo necesario para retomarla sin repasar la conversación en la que se diseñó.*

El asistente se rehízo en cuatro fases, inspirado en Atlas (github.com/sharith45/atlas-Assistant, del que no se copió código: su núcleo no es público). Las tres primeras están en producción.

## Dónde quedó (fases 1 a 3)

| Fase | Qué hace | Dónde vive |
|---|---|---|
| 1. Cara | Saludo, orbe de partículas que gira y vuela a la cabecera al conversar, acciones rápidas, tarjetas laterales, ventana flotante en todo el panel | `frontend/orbe.js`, `frontend/modulos/asistente.js`, `frontend/app.html` (sección `mod-asistente` y `asis-flotante`), `frontend/estilos.css` |
| 2. Herramientas | Busca vecinos, lee fichas, simula la torre, pide la mezcla al optimizador, consulta la prefactibilidad y abre pantallas. Cada uso se ve en el chat como un paso | `backend/simbia/api/herramientas.py`, `backend/simbia/ia.py` (`conversar_con_herramientas`, OpenAI y Anthropic), `backend/simbia/asistente.py`, `backend/simbia/api/asistente.py` (`/preguntar/stream`) |
| 3. Voz | Modo conversación: micrófono abierto, envía al callarse, responde en voz alta, vuelve a escuchar, se le puede interrumpir | `frontend/voz.js`, cableado en `asistente.js` (`alternarConversacion`) |

Pruebas: `backend/tests/test_asistente.py` y `backend/tests/test_herramientas.py` (sin red: el proveedor se simula).

## Qué es la fase 4

Que el asistente recuerde, entre sesiones y por usuario, lo que importa: preferencias ("háblame en m³/día", "Lamitech ya la visitamos"), decisiones ("descartamos Termocartagena por la temperatura") y pendientes ("falta pedir la caracterización de Abocol"). Hoy todo se pierde al recargar la página.

Atlas lo resuelve con una bóveda de notas y un "córtex" que decide en cada turno qué recordar. Para SIMBIA basta algo más simple y más barato: el modelo guarda una nota solo cuando hace falta, con una herramienta, y el usuario ve y borra lo guardado.

## Diseño propuesto

### Datos

- Un JSON por usuario en `backend/simbia/scout/archivo/memoria/<id>.json`, donde `<id>` son los primeros 16 caracteres del sha256 del correo (no el correo en claro). Ese directorio va al `.gitignore`, como `expedientes/` y `cache/`.
- Sin autenticación (desarrollo local) el usuario es `"local"`.
- Cada nota: `{id, texto (≤ 300 caracteres), tipo: preferencia|decision|pendiente|dato, empresa (clave del prospecto, opcional), creada, usada}`. Como mucho 60 notas: al pasar, se borra la menos usada.
- Escritura atómica (archivo temporal y `os.replace`) y un candado por archivo: dos pestañas pueden escribir a la vez.

### Cómo se escribe

Dos herramientas nuevas en `api/herramientas.py`, con la misma estructura que las demás (`Resultado` con `paso` y `detalle`):

- `recordar(texto, tipo, empresa?)`: paso "Recordó: …".
- `olvidar(id)`: paso "Olvidó: …".

Hay que añadir a `INSTRUCCIONES_HERRAMIENTAS` en `asistente.py` una regla como esta: *"Usa recordar solo si el usuario te pide que recuerdes algo, o si expresa una preferencia o una decisión que seguirá valiendo en otra sesión. No guardes cifras que ya están en los datos de la aplicación."*

La `Mesa` necesita saber quién pregunta: el endpoint `/preguntar/stream` debe recibir el `Request`, sacar el usuario con `auth.usuario_del_token(cfg, request.cookies.get(auth.COOKIE))` (o `"local"` si `auth.config()` es `None`) y pasárselo a `herramientas.Mesa(...)`.

### Cómo se usa

En `construir_contexto` (o al armar las instrucciones), se añade un bloque `memoria_del_usuario` con las notas más relevantes: primero las de la empresa en pantalla, luego las más recientes, hasta unas 20. Va dentro del CONTEXTO y, como todo lo demás, **es dato, no instrucción**.

### API

- `GET /api/asistente/memoria`: las notas del usuario actual.
- `DELETE /api/asistente/memoria/{id}`: borra una nota.
- `DELETE /api/asistente/memoria`: borra todas.

Ninguna acepta un usuario por parámetro: siempre el de la sesión.

### Pantalla

Una tarjeta "Memoria" en la columna derecha del asistente (Atlas la llama "Memoria activa"), entre "Contexto conectado" y "Lo que puede hacer":

- Lista de notas con su tipo y un botón para borrar cada una.
- "Olvidar todo", con confirmación.
- Cuando una respuesta usa una nota, el paso "Recordó" o el bloque de contexto lo deja ver en el chat.

### Seguridad y privacidad

- Aislamiento por usuario: una nota nunca entra en el contexto de otro.
- Inyección: un documento de VITAL podría intentar que el asistente "recuerde" una orden. Por eso las notas tienen un tipo cerrado, un largo máximo, no se ejecutan, y entran al contexto marcadas como dato. Conviene una prueba con un documento malicioso simulado.
- El usuario puede ver y borrar todo lo que se guardó de él.

## Pruebas que debería traer

- Almacén: guardar, listar, borrar, límite de 60 y escritura concurrente.
- Aislamiento: dos usuarios no ven las notas del otro, ni por API ni en el contexto.
- Herramientas: `recordar` y `olvidar`, con argumentos malos (texto vacío, tipo desconocido, id ajeno).
- API: los tres endpoints, con sesión y sin sesión (401).
- Contexto: las notas entran como `memoria_del_usuario` y las de la empresa en pantalla van primero.
- Bucle con el proveedor simulado: "recuerda que ya visitamos Lamitech" produce un paso `recordar` y la nota queda guardada.

## Criterios para darla por terminada

1. Decirle "recuerda que ya visitamos Lamitech", recargar la página y preguntar "¿a quién visito primero?": no propone Lamitech, o dice que ya se visitó.
2. La nota aparece en la tarjeta "Memoria" y se puede borrar; después de borrarla, el asistente ya no la usa.
3. Otro usuario no ve la nota.
4. Todas las pruebas pasan y se comprobó con el modelo real.

## Cómo probar con el modelo real

En local no hay clave de IA. Lo que se hizo en las fases 2 y 3:

- **Pantalla:** un servidor local con una clave falsa (`OPENAI_API_KEY=sk-falsa… uvicorn … --port 8125`) para que el panel crea que hay IA, y en el navegador se simulan las respuestas de `/api/asistente/preguntar/stream`.
- **Modelo real:** un script en el VPS que llama a `simbia.api.asistente.preguntar_stream(Pregunta(...))` y lee su `body_iterator` con `asyncio`. La clave se carga sin mostrarla: `source <(sudo grep -E "^(OPENAI_API_KEY|SIMBIA_IA_[A-Z_]+)=" /etc/simbia.env)`. El script se borra al terminar.

## Otros pendientes del asistente

- **Gasto por pregunta:** cada pregunta usa entre 20.000 y 60.000 tokens, porque el contexto completo (unos 15.000 caracteres) viaja en cada ronda. Con las herramientas ya disponibles se puede recortar a un resumen (pantalla, prefactibilidad, cartera) y dejar el resto a `buscar_empresas` y `ver_empresa`.
- **Extensión:** a veces se pasa de los 4 puntos (con Abocol dio 6).
- **Voz:**
  - Firefox no tiene reconocimiento de voz: allí el botón de conversación no aparece.
  - La interrupción depende de la cancelación de eco del navegador. Con altavoces muy altos y sin cascos, la propia voz del asistente podría contarse como interrupción. El umbral sube con el volumen de la respuesta (`voz.js`, `medir`), pero no se ha probado con un micrófono real en Safari.
- **Logos de la portada:** faltan los archivos `frontend/landing/caribe-innova.png` y `frontend/landing/cabot.png`. Mientras no estén, la franja "Un reto de" muestra los nombres en texto.
