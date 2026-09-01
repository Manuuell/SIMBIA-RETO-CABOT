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
├── api/                   API REST (FastAPI)
└── main.py                Aplicación

frontend/                  Dashboard sin dependencias npm (ES modules + SVG)
docs/                      Modelo técnico, supuestos y decisiones de diseño
```

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

Ver [`docs/03-supuestos.md`](docs/03-supuestos.md) para la lista completa de supuestos
y qué dato real reemplaza a cada uno.
