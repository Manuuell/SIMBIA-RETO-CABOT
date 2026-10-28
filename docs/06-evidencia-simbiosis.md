# Preselección documental para Cabot

Revisión: 26 de octubre de 2026. Se parte de las empresas y expedientes ya
analizados en SIMBIA. Son candidatos para evaluación; no hay una simbiosis
validada ni un ahorro demostrado.

| Empresa y corriente | Campaña | Caudal promedio publicado | Fuente local |
|---|---|---|---|
| Mexichem, PVC Emulsión, Efluente 3 | 15–19/12/2025 | 6,73 L/s = 24,228 m³/h | [Solicitud y caracterización, PDF p. 22](../backend/simbia/scout/evidencias/mexichem-2026.pdf) |
| Yara, Punto 1, Planta Norte | 30/06–02/07/2026 | 10,59 L/s = 38,124 m³/h | [Informe LMB 43028, PDF p. 16](../backend/simbia/scout/evidencias/yara-43028-2026.pdf) |

Se convierten los promedios publicados multiplicando por 3,6. No se extrapolan
a volúmenes diarios disponibles ni se suman campañas diferentes. Mexichem
registra hasta 7,5 L/s: los 27 m³/h que devolvía la extracción global son un
máximo, no el promedio de la corriente elegida.

## Qué se puede cruzar

El inicio compara química del mismo punto de cada empresa: pH, temperatura,
alcalinidad, DQO y sólidos, además de los parámetros disponibles solo en una
de ellas. Cada dato conserva unidad, estadístico, página y documento.
Cloruros, sílice y TDS permanecen ausentes; no se completan con arquetipos.

En Yara se conserva el rango de pH y los calificadores analíticos. El fósforo
reactivo menor que 0,15 mg P-PO4/L no se importa como fosfatos exactos en
mg PO4/L. Tampoco se importa sulfatos como valor exacto ignorando el asterisco
del laboratorio. En Mexichem, el promedio de hierro oculta un valor individual
de 3,05 mg/L: es necesario evaluar la variabilidad, no solo promedios.

## Estado de los permisos

- Mexichem: la solicitud radicada en 2026 cita CARDIQUE 1635/2016,
  0252/2022 y 1385/2022, y declara vencimiento el 17/03/2027. Es una
  declaración de la empresa: falta verificar los actos originales.
- Yara: [EPA-AUTO-000446-2025](https://epacartagena.gov.co/web/wp-content/uploads/2025/06/EPA-AUTO-000446-2025.pdf)
  confirma como antecedente el permiso 387/2016 y renovación 00218/2022.
  También registra desviaciones de nitrógeno total y sulfuros en 2024.
  Falta el acto íntegro, confirmar vigencia y revisar cierre del seguimiento.

Un trámite encontrado no se presenta como autorización otorgada. Las
caracterizaciones y estos antecedentes tampoco prueban autorización de reúso.

## Pendientes para una decisión

1. Recuperar los actos completos usando los radicados
   1070086000727726002 (Mexichem) y 1070860006333526001 (Yara).
2. Completar los parámetros faltantes de cada corriente y confirmar volumen,
   horarios y disponibilidad real para terceros con cada empresa.
3. Obtener consumo y balance medidos de Cabot, química del agua actual y límites
   de operación de la torre. La configuración actual es un supuesto.
4. Ensayar mezcla y tratamiento; evaluar variabilidad, trazado, costos y
   condiciones aplicables al reúso antes de calcular un ahorro defendible.

## Implementación y mantenimiento

La fuente estructurada es `backend/simbia/scout/evidencias/seleccion.json`.
Incluye URL pública, páginas PDF y SHA-256 de cada original. Los PDFs quedan
versionados con la aplicación para que no dependan de la caché de VITAL.
La API `/api/scout/evidencia` expone la selección y
`/api/scout/evidencia/documentos/{identificador}` sirve solo archivos registrados.

El inicio muestra un recorrido de decisión: barrido y ranking inicial, hallazgos
de los documentos y cruce con el modelo de la torre. La ruta
`/api/scout/evidencia/evaluacion` recalcula la evaluación usando exclusivamente
las dos corrientes seleccionadas y sus parámetros medidos. Los campos
restantes se identifican como estimaciones; para el pH de Yara se usa el punto
medio del rango observado como hipótesis, sin llamarlo promedio medido.

Se conservan por separado el puntaje inicial y el puntaje tras incorporar los
documentos. El ranking no se altera para colocar artificialmente a las dos
empresas en los primeros puestos. La decisión combina posición en el ranking
y evidencia disponible.

El cruce devuelve las mismas fuentes, tratamientos, caudales y dosis que
carga el botón «Probar estas dos empresas en el gemelo». El resultado del
inicio es de régimen estacionario. El gemelo arranca en la línea base y
ajusta la consigna en rampa; sus valores transitorios pueden diferir. Se
conserva una copia local de la configuración anterior al abrir este caso.

El optimizador verifica de nuevo la mezcla después de agrupar los trenes por
fuente: limita el caudal a la recuperación del tren elegido y comprueba su
factibilidad con el simulador. Así no se presentan mezclas que excedan la
alimentación de una fuente al cambiar su tratamiento.

Al revisar extracción IA, se bloquea aplicar un caudal global cuando no existe
un único punto; no se mezcla con la química de otro punto. La revisión manual
del PDF sigue siendo necesaria, especialmente para valores con límites.

Validación: 154 pruebas de evidencia, simulador, prospección y API. Una prueba
reenvía el escenario del inicio al endpoint del simulador y exige idénticos
caudales, ciclos, factibilidad y reducción calculada. Se comprobó en Safari
que el botón carga Mexichem y Yara en los controles de la torre.
Cambios locales, sin despliegue a producción.
