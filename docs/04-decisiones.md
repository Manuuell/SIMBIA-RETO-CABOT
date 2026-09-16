# Decisiones de diseño

Registro de las decisiones no obvias y de por qué se tomaron así.

## Por qué un optimizador y no un simulador

Un simulador respondería «¿qué pasa si mezclo esto?». La pregunta del reto es «¿qué debo
mezclar?», y el espacio de decisión tiene 6 oferentes × 13 trenes × dosis de ácido ×
ciclos continuos. No es un espacio que se explore a mano ni con una hoja de cálculo, y
la intuición falla en un punto concreto: la corriente más barata (rechazo de ósmosis,
TDS 3 200) es la que **peor** resultado da, porque hunde los ciclos alcanzables.

## Por qué barrido en N + LP y no un MINLP

Un MINLP completo sería más elegante y mucho más frágil. Fijando N, casi todas las
restricciones se vuelven exactamente lineales, porque la concentración en el circuito es
N veces la del aporte. Quedan dos términos bilineales que se resuelven por linealización
sucesiva. Resultado: 0,8 s, sin dependencias de solvers comerciales, y con una propiedad
que un MINLP no da gratis — **cada solución se verifica contra el modelo químico real
antes de aceptarse**.

La elección de trenes de tratamiento tampoco necesita variables binarias: cada par
(oferente, tren) es una columna del LP, y el LP elige. La restricción de disponibilidad
por oferente impide que se cuente dos veces la misma agua.

## Por qué el pH no se promedia

Al mezclar dos aguas, el pH no es una media ponderada: es el resultado del equilibrio
carbonatado de la mezcla. Con aguas de alcalinidades muy distintas el error supera una
unidad de pH, y como el LSI depende linealmente del pH, ese error se propaga entero al
riesgo de incrustación. Se mezclan alcalinidad y carbono inorgánico total (ambos
conservativos) y se resuelve el equilibrio por bisección.

## Por qué el agua circulante se evalúa en sistema abierto

Una torre es un aireador. El CO₂ se desorbe hasta equilibrar con la atmósfera y el pH
sube: con 440 mg/L de alcalinidad el agua circulante está a pH 9,16, no al pH del aporte.
Evaluar el LSI con el pH del aporte concentrado subestima la incrustación en más de una
unidad de LSI.

## Por qué existen las reglas de admisibilidad

Sin ellas el optimizador proponía alimentar agua de lavado de cervecería con 320 mg/L de
DQO sin tratar, argumentando que diluida cumplía el límite. Es correcto en el papel y
absurdo en la práctica: el biofouling no depende solo de la concentración media. Las
reglas codifican lo que un operador rechazaría de plano.

## Por qué la temperatura no descarta corrientes

La primera versión descartaba cualquier aporte por encima de 36 °C. Eso eliminaba de un
plumazo dos oferentes enteros, entre ellos el mejor candidato químico. Es un filtro
falso: agua de reposición a 41 °C entrando a 43 m³/h en un circuito de 2 600 m³/h sube la
temperatura de balsa 0,15 °C. Lo correcto es contabilizar la carga térmica que aporta
—más evaporación, más reposición— y dejar que el optimizador decida si compensa pagar un
intercambiador. La temperatura ahora solo descarta por integridad de materiales (55 °C).

## Por qué la frontera se traza acotando el ahorro por arriba

La primera versión pedía «ahorra al menos X %» y la curva salía plana: como reutilizar es
más barato que captar, el óptimo económico se iba siempre al máximo y la restricción de
meta nunca ataba. La curva informativa es la inversa: «¿cuál es el coste mínimo si me
limito a ahorrar como mucho X %?». Eso produce una curva decreciente que muestra el
valor marginal de cada m³ reutilizado, y un corte abrupto donde la química o el
guardarraíl operativo ya no admiten más.

## Por qué el detector de fugas es híbrido y no puro ML

Un clasificador sobre el caudal medido aprendería principalmente el clima y la carga. La
señal correcta es el **residual** entre el caudal medido y el que exige el balance de
masa (E + P + A). La física elimina los confusores; el ML solo tiene que separar fuga de
ruido de instrumentación y de error en la estimación de la evaporación. Por eso el modelo
mira la *dinámica* del residual (medias móviles, tendencia) y no su valor absoluto: el
factor evaporativo real deriva con el clima y sesga el residual lentamente.

## Por qué el ensuciamiento se modela como integrador

La primera versión del generador metía una sinusoide de 90 días en los ciclos de
concentración. El clasificador de riesgo daba AUC 0,85… aprendiendo el calendario. Al
quitar la sinusoide el AUC cayó a 0,53, que es la respuesta honesta: si la consigna de
ciclos es ruido con 16 horas de memoria, el estado a 7 días **no es predecible**.

Lo que sí es predecible es un acumulador. La incrustación no aparece de golpe: la tasa de
deposición depende del LSI, de la temperatura de piel y del tiempo de retención, y el
depósito es su integral con constante de tiempo de ~28 días, reseteada por cada limpieza
química. Predecir el depósito a 7 días es predecir la inercia de un integrador, que es un
problema legítimo y físicamente fundamentado. AUC 0,90, estable entre 12 y 24 meses de
histórico.

El depósito nunca se entrega al modelo: solo se observa a través del acercamiento al
bulbo húmedo, deliberadamente confundido con carga, temperatura ambiente y humedad
(correlación 0,89 con el depósito, no 0,99). Un sensor demasiado limpio habría inflado la
métrica sin que el problema fuera real.

## Por qué la validación es temporal y con referencias explícitas

Validación cruzada aleatoria sobre series temporales infla las métricas: el modelo ve
vecinos temporales de cada punto de test. Aquí es 70 % pasado / 30 % futuro. Y toda
métrica de regresión va acompañada de su referencia ingenua (persistencia y media móvil
de 24 h): un MAE de 2,19 m³/h no significa nada hasta saber que la persistencia da 3,68.

## Por qué el dashboard no usa npm

El proyecto vive en una carpeta de iCloud Drive. Un `node_modules` de ~300 MB y decenas
de miles de ficheros sincronizándose continuamente es un problema real. El dashboard es
HTML, CSS y módulos ES servidos directamente por FastAPI, con gráficos SVG escritos a
medida. Sin paso de compilación, sin dependencias, arranque inmediato. Si el proyecto sale
de iCloud y crece, migrar a React + Vite es directo: la API ya está separada y documentada.

## Por qué el dashboard se divide en módulos con una pantalla cada uno

La primera versión eran dos páginas largas, cada una con ocho secciones y párrafos de
explicación dentro de cada tarjeta. Quien la abría no sabía por dónde empezar ni qué estaba
pasando cuando pulsaba algo. Ahora hay una barra lateral con un módulo por pregunta
(datos externos, prospectos, embudo, optimizador, operación, modelo) y cada pantalla
muestra datos y acciones; la explicación larga vive en desplegables «¿Cómo se lee?» y en
el módulo de referencia. La extracción de datos externos es un flujo de tres pasos con una
bitácora que registra, línea a línea, qué fuente se consultó, de cuándo es el dato y qué
salió: es la forma de que el usuario sepa qué hizo el sistema sin leer el código.
