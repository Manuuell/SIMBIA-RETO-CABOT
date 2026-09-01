# Modelo técnico

## 1. Balance hídrico del circuito de enfriamiento

Torre de tiro inducido, circuito abierto. Tres salidas de agua:

| Salida | Naturaleza | ¿Reducible? |
|---|---|---|
| **Evaporación (E)** | Calor latente que disipa la carga térmica | **No.** La fija el proceso |
| **Arrastre (A)** | Gotas que escapan del eliminador | Ya está en 0,005 % del caudal circulante |
| **Purga (P)** | Agua concentrada que se descarta para controlar la salinidad | **Sí**, subiendo los ciclos |

Evaporación:

```
E = Q_circ · ΔT · cp / λ · f_evap
```

con cp = 4,186 kJ/kg·K, λ = 2 410 kJ/kg y `f_evap` la fracción del calor disipada como
calor latente (0,55–1,0 según temperatura y humedad ambiente; en clima cálido y húmedo
prácticamente todo el calor se va por evaporación).

Ciclos de concentración: `N = M / (P + A)`. De ahí, con `M = E + P + A`:

```
M = E · N / (N − 1)
```

**Consecuencia práctica:** pasar de N = 3 a N = 6 recorta la reposición un 17 % sin
tocar el proceso. Pasar de N = 6 a N = 9 solo recorta un 4 % más. El rendimiento
decrece rápido, y el coste de conseguirlo (tratamiento, ácido, antiincrustante) crece.
Por eso el punto óptimo hay que calcularlo, no elegirlo por intuición.

### Corrección por temperatura del agua de reposición

Aprovechar corrientes calientes (purga de calderas a 95 °C, enfriamiento de un solo
paso a 41 °C) añade carga térmica al circuito. Con `k = cp·(T_rep − T_balsa)/λ`:

```
M = E_proceso · r / (1 − k·r),    r = N/(N−1)
```

Es el precio físico de reutilizar agua caliente: más evaporación y por tanto más
reposición. El optimizador lo paga o compra un intercambiador de recuperación de calor,
según cuál salga más barato.

## 2. Química del agua

### Sistema carbonatado

Alcalinidad y carbono inorgánico total (C_T) son **conservativos en la mezcla**; el pH
no lo es. Mezclar aguas promediando el pH es incorrecto y puede errar por más de una
unidad. SIMBIA mezcla alcalinidad y C_T por balance de masa y resuelve el equilibrio:

```
Alk = [HCO₃⁻] + 2[CO₃²⁻] + [OH⁻] − [H⁺]
```

con K₁, K₂ y K_w corregidos por temperatura (Plummer & Busenberg).

### El agua de la torre está abierta a la atmósfera

Una torre airea el agua intensamente: el CO₂ se desorbe hasta equilibrar con el aire
(pCO₂ ≈ 4,2 × 10⁻⁴ atm). El pH del agua circulante **no es el del aporte concentrado**,
sino el que resulta de ese equilibrio, y es notablemente más alto.

| Ciclos | Alcalinidad (mg/L CaCO₃) | pH circulante | LSI a 38 °C |
|---|---|---|---|
| 1 | 110 | 8,61 | 0,92 |
| 3 | 330 | 9,05 | 2,27 |
| 4 | 440 | 9,16 | 2,62 |
| 6 | 660 | 9,31 | 3,10 |

Ignorar este efecto subestima gravemente el riesgo de incrustación.

### Índices de estabilidad

- **LSI** (Langelier): `pH − pH_s`. Límite 1,0 sin antiincrustante, 2,6 con él.
- **RSI** (Ryznar) y **PSI** (Puckorius): control cruzado; el PSI usa el pH de
  equilibrio y es más fiable con dosificación de ácido.
- **Larson-Skold**: `(eq Cl⁻ + eq SO₄²⁻) / eq alcalinidad`. > 1,2 corroe el acero.
  **Es invariante de escala** — los ciclos se cancelan — lo que lo convierte en una
  restricción lineal exacta dentro del LP.
- **Producto CaSO₄**: límite práctico de solubilidad del yeso.

### Ácido sulfúrico

1 kg de H₂SO₄ destruye 1,0196 kg de alcalinidad (como CaCO₃) y aporta 0,98 kg de SO₄²⁻.
Es la palanca más barata para subir ciclos cuando el agua es alcalina — pero desplaza el
Larson-Skold hacia la corrosión. El optimizador arbitra ese compromiso; a mano no se hace bien.

## 3. Reglas de admisibilidad

Los límites de concentración no bastan. Hay riesgos que no dependen de la concentración
final sino de la naturaleza de la corriente: biopelícula, ensuciamiento del relleno,
corrosión del cobre. Una corriente con 320 mg/L de DQO no se puede meter «diluida»
aunque la mezcla cumpla en el papel.

| Si la corriente cruda tiene | Exige al menos |
|---|---|
| DQO > 150 mg/L | Tratamiento biológico u ósmosis inversa |
| SST > 30 mg/L | Filtración, ultrafiltración u ósmosis |
| N-amoniacal > 5 mg/L | Biológico, stripping u ósmosis |
| Hierro > 2 mg/L | Filtración, ultrafiltración u ósmosis |

Además, **toda** corriente distinta del agua cruda pasa por barrera microbiológica
(desinfección u ósmosis). Sin esta regla el optimizador propone soluciones que ningún
operador aceptaría.

## 4. Formulación de la optimización

**Variables:** caudal de agua cruda `x₀`, caudal de cada par (oferente, tren) `xᵢ`,
dosis de ácido `a` (kg/h), y los ciclos `N`.

**Objetivo:** minimizar el coste horario total = compra + tratamiento + conducción +
bombeo + CAPEX anualizado + reactivos + vertimiento de la purga.

**Restricciones:**

1. Balance: `x₀ + Σxᵢ = M(N, T_mezcla)`
2. Disponibilidad por oferente (varios trenes comparten la misma fuente)
3. Meta de ahorro: `x₀ ≤ M_base − meta · consumo_planta`
4. Tope operativo a la fracción de reúso (guardarraíl de riesgo, 85 % por defecto)
5. Por cada parámetro *p*: `Σ xᵢ·cᵢₚ ≤ límite_p · M / (N · atenuación_p)`
6. Larson-Skold (lineal exacto)
7. LSI: `Ca · Alk ≤ P_max(N, T, TDS, pH)` — bilineal, por linealización sucesiva
8. Producto CaSO₄ — ídem

**Método:** barrido exterior en N (paso 0,1) × LP interior con 14 iteraciones de
linealización y punto fijo sobre la temperatura de mezcla × 4 niveles de factor de
seguridad. Cada candidato se **verifica con el modelo químico completo** antes de
aceptarse. Tiempo total: ~0,8 s.

## 5. Economía

CAPEX anualizado con factor de recuperación de capital, i = 12 %, n = 15 años
(CRF = 0,1468). Cada unidad de tratamiento se dimensiona con el caudal que realmente la
atraviesa, no con el producto final — importante con ósmosis inversa, cuya recuperación
del 75 % obliga a sobredimensionar todo lo que va aguas arriba.

Un detalle económico que cambia el signo del proyecto: **varios vecinos pagan por
entregar su rechazo**, porque evitan su propio coste de vertimiento. El precio de compra
negativo es el motor de la simbiosis industrial, no una curiosidad contable.
