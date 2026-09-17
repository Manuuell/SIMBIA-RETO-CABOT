# SIMBIA — Plataforma de simbiosis hídrica industrial asistida por IA

> **Reto Cabot.** Reducir al menos un 10 % el consumo de agua en la planta,
> reutilizando las aguas de rechazo de empresas vecinas para los sistemas de
> enfriamiento.

SIMBIA decide **de qué vecino tomar agua, con qué tratamiento, en qué proporción,
con cuánto ácido y a qué ciclos de concentración operar la torre** — todo a la vez,
porque son decisiones acopladas. Sobre esa base añade tres modelos de IA que
anticipan la demanda, detectan fugas y avisan del ensuciamiento antes de que ocurra.

**Resultado del caso base: 38,8 % de reducción del consumo de planta**
(meta: 10 %), 464 k USD/año de ahorro, payback de 1,15 años.
Alcanzar exactamente el 10 % del reto cuesta **73 k USD con payback de 5 meses**.

---

## La idea que hace falta entender antes de mirar el código

En una torre de enfriamiento abierta:

```
M = E · N / (N − 1)
```

- **E (evaporación)** la fija la carga térmica. **No se puede reducir.** Es agua perdida sí o sí.
- Lo único recortable es la **purga**, y eso depende de **N**, los ciclos de concentración.
- **N lo limita la calidad del agua de aporte**: cuanto más salina, antes se alcanzan
  los límites de incrustación, corrosión y ensuciamiento.

De ahí la trampa del reto: **meter agua de rechazo sin optimizar baja los ciclos
alcanzables y puede aumentar la captación total de agua cruda.** Reutilizar no es
gratis; hay que resolver mezcla, tratamiento, acidificación y ciclos simultáneamente.
Eso es exactamente lo que hace el optimizador.

---

## Arquitectura

```
backend/simbia/
├── config.py              Parámetros y supuestos del caso base (todo editable)
├── domain/
│   ├── water_chem.py      Sistema carbonatado, LSI/RSI/PSI/Larson-Skold, mezcla, ácido
│   ├── cooling.py         Balance de la torre, ciclos máximos admisibles
│   └── streams.py         Catálogo de vecinos, unidades y trenes de tratamiento
├── optim/
│   ├── blend.py           Optimizador: barrido en N + LP con linealización sucesiva
│   └── analysis.py        Frontera coste-ahorro, contingencias, sensibilidad
├── data/synth.py          Generador de histórico sintético (gemelo digital)
├── ml/                    Demanda +24 h · detección de fugas · riesgo de ensuciamiento
├── scout/                 PROSPECCIÓN: de dónde sale el catálogo de vecinos
│   ├── fuentes/           Conectores (OpenStreetMap, datos.gov.co) + caché + robots.txt
│   ├── ciiu.py            Actividad económica → corriente de rechazo estimada
│   ├── geo.py             Distancia de conducción real, no línea recta
│   ├── pipeline.py        Recolectar → fusionar → caracterizar → situar
│   ├── scoring.py         Puntaje de simbiosis con la física del optimizador
│   ├── promocion.py       Puerta de confianza hacia el optimizador
│   ├── almacen.py         Embudo de contratación e instantáneas
│   ├── vigilancia.py      Qué cambió desde la última revisión
│   ├── vital.py           Buscador libre de trámites en VITAL (facetas, páginas, caché)
│   ├── documentos.py      Documentos de un trámite desde el VITAL antiguo: ver, descargar, guardar
│   └── extraccion.py      Permisos de vertimiento en PDF → datos, con Claude
├── api/                   API REST (FastAPI)
└── main.py                Aplicación

frontend/                  Dashboard por módulos, sin dependencias npm (ES modules + SVG)
│   ├── index.html         Barra lateral y un contenedor por módulo
│   ├── app.js             Enrutado por #hash; cada módulo se monta al visitarlo
│   ├── comun.js           Peticiones, almacén compartido y bitácora
│   └── modulos/           inicio · datos · prospectos · embudo · optimizador · operacion · modelo
docs/                      Modelo técnico, supuestos, decisiones y prospección
```

## El dashboard: un módulo por pregunta

| # | Módulo | Pregunta que responde |
|---|---|---|
| 1 | **Datos externos** (`#datos`) | ¿De dónde sale el catálogo? Consultar fuentes, cruzar permisos de vertimiento y traer documentos del expediente, con una bitácora de lo que hizo el sistema. |
| 2 | **Buscador VITAL** (`#vital`) | ¿Qué trámites tiene una empresa concreta ante la autoridad ambiental? Búsqueda libre con filtros, los documentos del expediente para ver, descargar o guardar, la solicitud lista para enviar y el vínculo al prospecto. |
| 3 | **Prospectos** (`#prospectos`) | ¿Quiénes son los vecinos, qué agua producen y a quién visito primero? |
| 4 | **Embudo comercial** (`#embudo`) | ¿Cuánto caudal hay contactado, caracterizado o contratado, y qué cambió en el parque? |
| 5 | **Optimizador** (`#optimizador`) | Dado un catálogo, ¿qué mezclo, con qué tratamiento y a qué ciclos? Con el catálogo supuesto o con los prospectos reales. |
| 6 | **Operación e IA** (`#operacion`) | ¿Cuánta reposición hará falta, hay una fuga, se va a ensuciar el circuito? |
| 7 | **Modelo y supuestos** (`#modelo`) | ¿Qué da por supuesto la aplicación y cómo calcula cada cosa? |

La prospección alimenta al optimizador: las empresas que encuentra el barrido
entran al mismo optimizador, con la misma química y las mismas restricciones. Lo
único que cambia es de dónde salió el catálogo — y la confianza de cada dato
viaja con él, traducida a factor de disponibilidad anual.

Las pantallas de trabajo muestran datos y acciones; la explicación larga vive en
desplegables «¿Cómo se lee?» y en el módulo de referencia.

## Puesta en marcha

```bash
python3 -m venv .venv && ./.venv/bin/pip install -r backend/requirements.txt
```

Entrenar los modelos (opcional: la API los entrena sola la primera vez):

```bash
cd backend && ../.venv/bin/python -m simbia.ml.train
```

Levantar la aplicación:

```bash
./.venv/bin/python -m uvicorn simbia.main:app --app-dir backend --port 8123
```

Dashboard en `http://localhost:8123` · API documentada en `http://localhost:8123/docs`

La prospección arranca **sin salir a la red** (caché local), para que nada
dependa de que haya conexión o de que una API de terceros esté en pie. Desde el
módulo *Datos externos* se puede lanzar un barrido en modo `cache` o `vivo` sin
reiniciar nada; para cambiar el modo por defecto del servidor:

```bash
SIMBIA_SCOUT_MODO=vivo ./.venv/bin/python -m uvicorn simbia.main:app --app-dir backend --port 8123
```

Pruebas:

```bash
cd backend && ../.venv/bin/python -m pytest
```

---

## Qué hace cada pieza

### 1. Gemelo digital químico (`domain/`)

No es una hoja de cálculo con reglas de tres. Resuelve el **equilibrio carbonatado**
real: al mezclar dos aguas no se promedia el pH, se mezclan alcalinidad y carbono
inorgánico total y se resuelve el equilibrio. Y el agua circulante se evalúa **en
equilibrio con el CO₂ atmosférico**, porque una torre airea intensamente y eso sube
el pH varias décimas — ignorarlo es el error más común al estimar la incrustación.

### 2. Optimizador (`optim/blend.py`)

El problema es no lineal (los ciclos multiplican a las concentraciones; el LSI depende
del producto Ca × alcalinidad). Se resuelve como:

1. Barrido exterior sobre **N** discreto. Fijado N, la demanda M es constante.
2. Para cada N, un **LP (HiGHS)** sobre caudales y dosis de ácido: los límites por
   parámetro son lineales porque la concentración en el circuito es exactamente N veces
   la del aporte.
3. Las dos restricciones bilineales (LSI y producto CaSO₄) por **linealización sucesiva**.
4. La temperatura de la mezcla cambia la evaporación, así que M se resuelve por
   **punto fijo** dentro del mismo bucle.
5. **Toda solución se verifica con el modelo químico completo y no lineal.** Si falla,
   se aprieta un factor de seguridad y se repite. Nunca se reporta como factible una
   solución que el modelo real rechaza.

El índice de Larson-Skold no necesita linealización: es invariante de escala, los
ciclos se cancelan y queda lineal.

### 3. Inteligencia predictiva (`ml/`)

| Modelo | Para qué sirve | Desempeño (validación temporal) |
|---|---|---|
| Demanda de reposición +24 h | Contratar por adelantado el caudal a los vecinos | MAE 2,19 m³/h · MAPE 5,2 % · **41 % mejor que persistencia** |
| Detección de fugas | Residual del balance de masa + clasificador | F1 0,69 · AUC-PR 0,73 · ~2 700 m³/año recuperables |
| Riesgo de ensuciamiento 7 d | Bajar ciclos o cambiar la mezcla **antes** | AUC-ROC 0,90 · recall 75 % · lift ×3,1 |

Tres decisiones de método que sostienen esas cifras:

- **Partición temporal** (70 % pasado / 30 % futuro), nunca aleatoria. La validación
  cruzada aleatoria sobre series temporales infla las métricas.
- **Referencias ingenuas explícitas.** Un MAE sin comparar contra persistencia no dice nada.
- **El detector de fugas es híbrido**: la señal es el residual entre el caudal medido y
  el que *exige* el balance de masa. El ML solo separa fuga de ruido; la física hace el
  trabajo pesado.

---

### 4. Prospección de socios (`scout/`)

El optimizador necesita un catálogo de oferentes. Este módulo lo construye a
partir del mundo real, en el corredor industrial de Mamonal (Cartagena):

```
fuentes externas → registros crudos → fusión → arquetipo sectorial
      → prospecto con procedencia → puntaje → catálogo → optimizador
```

Cuatro decisiones que lo sostienen:

- **Ningún dato viaja sin procedencia.** Cada cifra lleva sello de `medido`,
  `declarado`, `inferido` o `supuesto`, y una confianza agregada que pondera la
  calidad por encima del caudal. Un caudal equivocado se renegocia; una calidad
  equivocada hunde los ciclos y se descubre con la tubería ya enterrada.
- **La actividad económica determina el efluente.** 13 arquetipos sectoriales
  traducen el código CIIU a una caracterización típica. Aciertan el orden de
  magnitud y el parámetro limitante — que es lo que hace falta para decidir a
  quién visitar primero. Priorizan el muestreo, no lo sustituyen.
- **El puntaje usa la física del optimizador, no reglas de pulgar.** Para cada
  prospecto se barre la fracción de mezcla con agua cruda y se calcula, con el
  modelo químico completo, cuánta agua cruda desplaza sin bajar de los ciclos
  base. La primera versión evaluaba cada corriente al 100 % de aporte y
  declaraba no viables diez de dieciocho: el indicador estaba saturado y no
  discriminaba nada.
- **La confianza es una puerta, no un adorno.** Por debajo del umbral un
  prospecto no entra al optimizador aunque químicamente sea magnífico, y el que
  entra lo hace con su confianza traducida a factor de disponibilidad anual.

Encima de eso: mapa del parque con distancia de conducción real (no geodésica),
embudo de contratación medido en caudal y no en número de empresas, vigilancia
de cambios entre barridos, y extracción de permisos de vertimiento en PDF con
salida estructurada — que es lo que convierte un prospecto inferido en uno
declarado.

**Conectado a datos reales.** Consulta a OpenStreetMap sobre 8 km alrededor de
Mamonal: 54 establecimientos con polígono y etiquetas, 27 prospectos
caracterizados. Cuatro de ellos con expediente documental y fuentes citadas
—Abocol/Yara, Mexichem, Seatech, Cotecmar—, que es lo que permite saber que
Abocol produce amonio y no rechazo de desmineralizadora. Con ese catálogo real
el optimizador alcanza **37,8 % de reducción** y cumple la meta.

**Permisos de vertimiento reales.** Buscando la fuente aparecieron 132 registros
de vertimiento de Cartagena en VITAL —119 de EPA Cartagena, 13 de CARDIQUE—, con
API JSON abierta. No estaban en datos.gov.co, que es donde todo el mundo mira
primero. Cinco de nuestras empresas tienen permiso confirmado con su número de
expediente, que es justo lo que hace accionable un derecho de petición para pedir
la caracterización.

**Y una caracterización de laboratorio real.** Del expediente de Yara Colombia
(Abocol) se recuperó el Informe 43028: tres muestras compuestas analizadas por
un laboratorio acreditado por el IDEAM. Sirvió para auditar el modelo sectorial
— acertó la forma de la corriente y el parámetro limitante (amonio, −30 %), y
falló en alcalinidad (+420 %) y caudal (+137 %). Ese prospecto pasa a
`medido`, con confianza 0,98.

Los registros de demostración están **apagados** salvo que se pidan con
`SIMBIA_SCOUT_EJEMPLOS=1`: mezclados con los reales dejan de distinguirse.

Detalle completo en [`docs/05-prospeccion.md`](docs/05-prospeccion.md).

---

## Honestidad sobre los datos

**No hay datos reales de la planta ni de las empresas vecinas.** Todo parte de rangos
típicos de industria, declarados y anotados uno a uno en `backend/simbia/config.py` y
`backend/simbia/domain/streams.py`.

El histórico para la IA es **sintético, generado por el propio gemelo digital**: no
inventa correlaciones, usa la misma física del optimizador más la variabilidad que
sufre una planta real (clima, carga, ruido de instrumentación, fugas, derivas de los
vecinos). Al conectar el SCADA se sustituye `data/synth.py` por el cargador real y los
modelos se reentrenan sin tocar nada más.

**Lo que no cambia al llegar los datos reales es la estructura**: la química, el
balance, las restricciones y la economía. Cambian los números, no las conclusiones
metodológicas.

**En la prospección, dos niveles de veracidad deliberadamente distintos.** La capa
cartográfica usa nombres y ubicaciones aproximadas de establecimientos del corredor
de Mamonal: son hechos públicos de mapa, verificables en OpenStreetMap. La capa de
vertimientos son registros de **demostración** con identificadores `EJEMPLO-nn`: no
se ha consultado ningún permiso real y ninguna cifra está atribuida a ninguna empresa
concreta. La regla que no se rompe: **ninguna caracterización de agua de una empresa
nombrada es una medida** — todo lo que el sistema sabe de su efluente sale del modelo
sectorial y viaja marcado como inferido.

Ver [`docs/03-supuestos.md`](docs/03-supuestos.md) para la lista completa de supuestos
y qué dato real reemplaza a cada uno, y
[`docs/05-prospeccion.md`](docs/05-prospeccion.md) para el módulo de prospección.
