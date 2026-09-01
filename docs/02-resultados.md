# Resultados del caso base

Todos los números provienen de ejecutar `optimizar()` sobre el escenario declarado en
`backend/simbia/config.py`. Son reproducibles: `cd backend && ../.venv/bin/python -m pytest`.

## Línea base frente a óptimo

| | Operación actual | Con SIMBIA |
|---|---|---|
| Ciclos de concentración | 3,2 | 9,0 |
| Reposición del circuito | 1 273 m³/d | 990 m³/d |
| **Agua cruda captada** | **1 273 m³/d** | **149 m³/d** |
| Agua de rechazo reutilizada | 0 | 841 m³/d |
| Purga a vertimiento | 395 m³/d | 107 m³/d |
| Coste total | 739 k USD/año | 275 k USD/año |

**Reducción del consumo de planta: 38,8 %** (meta del reto: 10 %).
Ahorro económico 464 k USD/año, CAPEX 532 k USD, payback 1,15 años,
184,7 t CO₂e/año evitadas.

Nótese que la purga cae un 73 %: subir ciclos ahorra agua **dos veces**, en la captación
y en el vertimiento.

## Mezcla seleccionada

| Vecino | Corriente | Tren | m³/d | USD/m³ |
|---|---|---|---|---|
| Cogeneración | Purga de calderas | Enfriamiento + UF + OI | 193 | 0,678 |
| Cervecería | Agua de lavado y condensados | UF + OI | 402 | 0,580 |
| Planta de plásticos | Enfriamiento de un solo paso | Filtración + desinfección | 247 | 0,338 |
| — | Agua cruda residual | — | 149 | 1,350 |

Dos observaciones que no son obvias de antemano:

- **La ósmosis inversa se paga sola.** No por limpiar el agua, sino porque produce un
  aporte tan poco salino que permite operar a 9 ciclos. El ahorro está tanto en el agua
  que entra como en la purga que deja de salir.
- **La corriente más salina del catálogo (rechazo de OI de la petroquímica, TDS 3 200)
  no se selecciona** pese a ser la más barata de comprar. El optimizador la descarta
  porque limitaría los ciclos. Ese es precisamente el error que cometería un análisis
  hecho a mano mirando solo el precio.

## Qué cuesta cada punto de ahorro

| Nivel de reúso | Ahorro | m³/d | Coste USD/año | CAPEX | Beneficio neto | Payback | Ciclos |
|---|---|---|---|---|---|---|---|
| 0 % | 0,0 % | 0 | 745 145 | 4 k | −6 k | — | 3,1 |
| 5 % | 5,0 % | 145 | 633 964 | 6 k | 105 k | 0,05 a | 4,2 |
| **10 %** | **10,0 %** | **290** | **576 173** | **73 k** | **163 k** | **0,45 a** | **4,6** |
| 15 % | 15,0 % | 435 | 519 950 | 172 k | 219 k | 0,79 a | 5,2 |
| 20 % | 20,0 % | 580 | 463 347 | 274 k | 276 k | 0,99 a | 6,1 |
| 25 % | 25,0 % | 725 | 408 836 | 369 k | 330 k | 1,12 a | 7,4 |
| 30 % | 30,0 % | 870 | 359 228 | 445 k | 380 k | 1,17 a | 9,0 |
| 35 % | 35,0 % | 1 015 | 311 077 | 494 k | 428 k | 1,16 a | 9,0 |
| 38,8 % | 38,8 % | 1 125 | 274 836 | 532 k | 464 k | 1,15 a | 9,0 |

**La curva baja.** Cada m³ reutilizado cuesta entre 0,91 y 1,09 USD **menos** que
captarlo. El 10 % del reto no es un objetivo ambicioso: es el punto de partida, y se
alcanza con 73 k USD y cinco meses de retorno.

El corte está en 38,8 %, y no lo pone la química sino el **tope operativo de reúso**
(85 % de la reposición), un guardarraíl de riesgo que se puede subir si la planta
acepta más dependencia de terceros.

## Robustez

Simulando la caída de cada oferente por separado, **la meta del 10 % se mantiene en los
seis escenarios**. El contrato más valioso es el de la cervecería: perderlo cuesta
28,6 k USD/año adicionales. Ningún vecino es imprescindible — el proyecto es bancable.

## Sensibilidad

| Agua cruda | Beneficio neto |
|---|---|
| 0,45 USD/m³ | 110 k USD/año |
| 0,85 USD/m³ | 267 k USD/año |
| 1,35 USD/m³ | 464 k USD/año |
| 2,00 USD/m³ | 720 k USD/año |
| 3,00 USD/m³ | 1 114 k USD/año |

El proyecto sigue siendo rentable incluso con agua a 0,45 USD/m³. Y se refuerza justo
cuando más se necesita: cuanto más escasa y cara sea el agua, mayor es el valor de la
simbiosis.

## Escenarios extremos verificados

| Escenario | Ahorro | Comportamiento |
|---|---|---|
| Sin los 3 mejores vecinos | 30,3 % | Recurre a ósmosis sobre corrientes salinas |
| Solo la PTAR disponible | 22,1 % | Dos trenes distintos sobre la misma fuente |
| Agua cruda barata (0,45) | 37,7 % | Abandona la OI, baja a 3,9 ciclos: menos CAPEX |
| Tope de reúso al 35 % | 20,5 % | Prioriza las corrientes más limpias |
| **Sin antiincrustante** | 38,2 % | LSI máx. 1,0 → 4,8 ciclos y **CAPEX ×1,24** |
| Meta imposible (50 %) | — | Explica por qué: excede toda la reposición del circuito |

El caso «sin antiincrustante» es el mejor control de sanidad del modelo: al endurecer el
límite de incrustación, el optimizador compensa con más tratamiento y más inversión, en
lugar de fingir que el problema no existe.
