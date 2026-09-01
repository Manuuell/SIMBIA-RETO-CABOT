# Supuestos y qué dato real reemplaza a cada uno

No hay caracterización real de la planta ni de las empresas vecinas. Esta es la lista
completa de lo que se ha supuesto, de dónde sale el valor y qué dato lo sustituye.

> Cambiar cualquiera de estos valores **no requiere tocar código**: están en
> `backend/simbia/config.py` y `backend/simbia/domain/streams.py`, o se ajustan desde
> los controles del dashboard.

## Planta

| Parámetro | Supuesto | Origen | Dato real que lo sustituye |
|---|---|---|---|
| Consumo total | 2 900 m³/d | Planta de negro de humo (quench, peletizado, enfriamiento, vapor) | Facturación de captación / medidor de entrada |
| Coste del agua cruda | 1,35 USD/m³ | Captación + potabilización + tasa por uso en zona industrial | Coste unitario real de la planta |
| Coste de vertimiento | 0,85 USD/m³ | Tasa retributiva + tratamiento del efluente | Factura de vertimiento |
| Factor de emisión del agua | 0,45 kg CO₂e/m³ | Rango 0,3–0,7 del ciclo urbano-industrial | Factor del proveedor / inventario GEI |
| Horas de operación | 8 400 h/año | Planta continua con ~2 semanas de parada | Registro de disponibilidad |

## Circuito de enfriamiento

| Parámetro | Supuesto | Dato real que lo sustituye |
|---|---|---|
| Caudal de circulación | 2 600 m³/h | Curva de la bomba / medidor |
| Rango térmico ΔT | 8,5 °C | Termómetros de entrada y salida de torre |
| Fracción evaporativa | 0,95 | Se calcula del balance con el histórico |
| Arrastre | 0,005 % del circulante | Ficha del eliminador de gotas |
| Ciclos actuales | 3,2 | Conductividad circulante / conductividad de aporte |

Estas cinco cifras son **coherentes entre sí**: producen una reposición de 1 273 m³/d,
el 44 % del consumo de planta, que es la proporción esperable cuando el quench es
consuntivo. Al sustituirlas hay que sustituirlas juntas.

## Límites de calidad del agua circulante

Corresponden a un circuito de acero al carbono con relleno de PVC e intercambiadores de
acero inoxidable 304, con programa de inhibidor. Los umbrales (conductividad 3 500 µS/cm,
cloruros 500 mg/L, sílice 150 mg/L, LSI 2,6 con antiincrustante, Larson-Skold 1,2)
son práctica habitual del tratamiento de aguas de enfriamiento.

**Es el bloque que más conviene validar con el proveedor de tratamiento químico de la
planta**, porque son restricciones duras del optimizador: mover el límite de LSI de 2,6
a 1,0 cambia la solución de 9 a 4,8 ciclos y multiplica el CAPEX por 1,24.

## Empresas vecinas

Los seis oferentes son **arquetipos** de las corrientes que aparecen en un parque
industrial, no empresas identificadas. Cada uno lleva caudal, caracterización analítica
completa, distancia y precio.

| Cód. | Arquetipo | Por qué está en el catálogo |
|---|---|---|
| V1 | Rechazo de ósmosis de una petroquímica | Muy limpio pero muy salino: el caso donde el precio engaña |
| V2 | Purga de calderas | Agua blanda y caliente: prueba la recuperación de calor |
| V3 | Efluente terciario de PTAR | Gran volumen, baja salinidad, carga orgánica y amonio |
| V4 | Purga de torres de un vecino | Cascada purga-a-purga, la simbiosis más directa |
| V5 | Lavado de cervecería | Salinidad mínima, DQO alta: exige tratamiento biológico |
| V6 | Enfriamiento de un solo paso | Casi agua cruda, solo caliente |

**Lo que hay que pedirle a cada vecino real:** caudal disponible y su perfil horario,
analítica completa (los 13 parámetros de `Calidad`), temperatura, disponibilidad anual,
distancia al punto de entrega y disposición a firmar contrato de suministro.

## Costes de tratamiento

CAPEX por m³/h instalado y OPEX por m³ alimentado, para cada operación unitaria
(filtración, UF, biológico, cal-soda, intercambio iónico, ósmosis, desinfección,
stripping, intercambiador). Son órdenes de magnitud de literatura de ingeniería.

**Sustituirlos por cotizaciones reales es el paso que más mueve el resultado económico**,
por delante de cualquier refinamiento del modelo químico.

## Histórico para la IA

Enteramente sintético, generado por `data/synth.py` a partir del mismo modelo físico del
optimizador más:

- Clima horario con estacionalidad tropical suave, ciclo diurno y persistencia AR(1)
- Carga de producción con paradas de mantenimiento
- Ciclos de concentración oscilando por control real del operador
- Fugas con arranque aleatorio, rampa y duración exponencial
- Ruido de instrumentación (2 % en caudalímetros)
- Ensuciamiento como **integrador** con limpiezas químicas periódicas, observable solo
  a través del acercamiento al bulbo húmedo, confundido con carga y clima
- Deriva AR(1) de la calidad y disponibilidad de cada vecino, con paradas

**Lo que este histórico NO puede darte:** la magnitud real de las fugas de la planta, la
frecuencia real de los eventos de ensuciamiento, ni la variabilidad real de los vecinos.
Las métricas de los modelos (MAE 2,19 m³/h, F1 0,69, AUC 0,90) miden que la arquitectura
funciona sobre un sistema con la física correcta — no predicen el desempeño sobre datos
reales. Eso solo se sabe reentrenando con el SCADA.

**Lo que sí es independiente de estos datos:** todo el resultado económico del reto. La
optimización no usa el histórico sintético en ningún punto; usa la caracterización de
las corrientes y la física del circuito.
