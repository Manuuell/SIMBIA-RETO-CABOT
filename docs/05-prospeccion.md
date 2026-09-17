# Módulo de prospección

## El hueco que llena

El optimizador necesita un catálogo de oferentes: seis empresas con su caudal,
su caracterización y su distancia. En el caso base ese catálogo es un supuesto
declarado (`domain/streams.py`). Este módulo lo construye a partir del mundo
real: busca qué empresas hay alrededor de la planta, estima qué agua de rechazo
produce cada una y decide a quién vale la pena ir a ver.

```
fuentes externas → registros crudos → fusión → arquetipo sectorial
      → prospecto con procedencia → puntaje → catálogo → optimizador
```

Ubicación de referencia: **corredor industrial de Mamonal, Cartagena de Indias**.
La coordenada de la planta (`scout/geo.py`) es aproximada y se sustituye por la
del punto de entrega de agua levantado en campo — que no es lo mismo que el
centroide del predio y puede diferir en cientos de metros.

---

## 1. La regla que gobierna el módulo

**Ningún dato viaja sin decir de dónde salió y cuánto vale.**

Un caudal leído de un permiso de vertimiento y uno inferido del código CIIU son
números del mismo tipo y no valen lo mismo. Cada prospecto arrastra el método
con que se obtuvo cada bloque de información, las referencias concretas y una
confianza agregada:

| Método | Qué significa | Confianza base |
|---|---|---|
| `medido` | Analítica de laboratorio de la corriente | 0,95 |
| `declarado` | La empresa o su permiso lo reporta | 0,70 |
| `inferido` | Modelo CIIU → arquetipo de efluente | 0,45 |
| `supuesto` | Rango típico de industria | 0,20 |

La confianza pondera calidad por encima de caudal (65 / 35). Un caudal
equivocado se renegocia; una calidad equivocada hunde los ciclos de la torre y
se descubre cuando ya hay tubería enterrada.

**Ninguna caracterización de agua atribuida a una empresa nombrada es una
medida.** Todo lo que el sistema sabe del efluente de una empresa concreta sale
del arquetipo sectorial y viaja marcado como inferido. La analítica real solo
entra por dos puertas: un permiso de vertimiento auténtico o una campaña de
caracterización cargada a mano.

---

## 2. Fuentes

| Fuente | Aporta | Estado |
|---|---|---|
| OpenStreetMap (Overpass) | Posición, superficie del predio, nombre | Conector verificado |
| datos.gov.co (Socrata) | Caudal autorizado y analítica del permiso | **Sin configurar** |

El conector de datos.gov.co está completo, pero cada conjunto del portal tiene
su propio identificador y sus propios nombres de columna, y no están
normalizados entre entidades. En vez de inventar identificadores que
probablemente no existan, la configuración vive en
`scout/archivo/fuentes.json` y se declara no verificada hasta que alguien con
acceso al portal la rellene. Mientras tanto la fuente sirve datos de ejemplo y
lo dice en el dashboard.

### Lo que se encontró al conectarlo de verdad

Consulta real a Overpass sobre 8 km alrededor de la planta, septiembre de 2026:
**54 establecimientos industriales** con nombre, polígono y etiquetas. De ahí
salen 27 prospectos caracterizados; 26 se descartan por no poder estimarles el
efluente, que es el comportamiento correcto.

Correr contra datos reales destapó tres defectos que la instantánea de trabajo
nunca habría mostrado:

- **`termo` casaba dentro de «In-termo-dal»** —un patio de contenedores— y lo
  clasificaba como central térmica, con su purga de calderas inventada. Las
  pistas simples ahora exigen prefijo de token.
- **`power` casaba con `power=substation`.** Una subestación no purga calderas.
  Ahora se exige `power=plant` o `plant:source`.
- **Las tildes no se normalizaban.** «Daw Química» no casaba con la pista
  `quimica`, y media docena de plantas químicas de Mamonal se quedaban sin
  clasificar en silencio.

Los tres tienen prueba de regresión.

### Los permisos de vertimiento: dónde NO estaban y dónde sí

Primera conclusión, contra el catálogo Socrata de datos.gov.co: **CARDIQUE no
publica permisos de vertimiento en el portal de datos abiertos**; solo una
estación de calidad del aire. Sí los publican Corpoboyacá y Corantioquia. La
conclusión fácil era que en Cartagena no hay dato público.

**Es falsa.** Están en VITAL, que es otro sistema: la Ventanilla Integral de
Trámites Ambientales del Ministerio. Para Cartagena hay **132 registros de
vertimiento** — 119 de EPA Cartagena y 13 de CARDIQUE — y su buscador público
expone un endpoint JSON abierto, sin autenticación:

```
POST https://buscador-api.minambiente.gov.co/buscar
{"page_number":1,"page_size":100,"query":"Vertimiento de Aguas Cartagena",
 "type_search":"Todos","filters":{"CAMPO":-6}}
```

No está documentado como API pública: es el que consume el propio buscador web.
Se usa con el mismo cuidado que cualquier fuente de terceros —límite de tasa,
caché, User-Agent identificado— y `permisos.py` asume que puede desaparecer sin
aviso, degradando a caché.

**Qué da y qué no.** Da la existencia del permiso, el titular, la autoridad
competente y el **número de expediente**. No da el caudal ni la caracterización:
eso vive en los documentos del expediente. Por eso el módulo no toca la
caracterización del agua — solo confirma que la corriente existe y está
regulada, y deja apuntado a quién y qué pedir. Una solicitud que dice *«copia
del expediente 1070860522056225001»* se responde; una que dice *«información
sobre vertimientos»* se pierde.

**No da coordenadas**, así que no es una fuente del barrido sino una capa de
enriquecimiento que cruza por razón social contra lo que ya encontró
OpenStreetMap. Sin coordenada con la que desempatar, el umbral de parecido de
nombre sube a 0,88.

Cruzado con las 27 empresas del barrido, **5 tienen permiso confirmado**:
Ecopetrol, Lamitech, Dexton‑Ajover, Argos y Aguas de Cartagena. Su confianza
sube —pero bastante menos que con una analítica: saber que alguien vierte no es
saber qué vierte, y hay una prueba que verifica esa jerarquía.

### El buscador de VITAL, para lo que el barrido no encuentra

El cruce automático lanza tres consultas fijas sobre vertimientos en Cartagena
y casa por razón social. Se le escapa lo previsible: la empresa que tramita con
otro nombre. Mexichem figura en OpenStreetMap como «Mexichem S.A.» y en VITAL
como «MEXICHEM RESINAS COLOMBIA S.A.» ante CARDIQUE, con un permiso de
vertimiento a cuerpo de agua (expediente COR-00091-26) que ninguna de las tres
consultas devolvía.

Para eso está el módulo **Buscador VITAL** (`scout/vital.py`): búsqueda libre
sobre titular, proyecto, expediente y radicado, con las facetas que el propio
API devuelve (autoridad, trámite, municipio) como filtros, paginada y con caché
de dos semanas por consulta. Dos acciones por resultado cierran el círculo:
**redactar la solicitud** del expediente y **vincularlo a un prospecto**. El
vínculo se guarda en la ficha comercial y entra al prospecto como referencia
`vital` *antes* de puntuar, de modo que la confianza sube exactamente igual que
si lo hubiera encontrado el barrido. Es un vínculo declarado: prueba que la
empresa tramita ante la autoridad, no dice qué vierte.

**Y los documentos, sin salir de la herramienta.** El buscador nuevo dice que
un trámite existe; los documentos —la solicitud, la resolución, la
caracterización— viven en el VITAL antiguo (SILPA, ASP.NET con sesión y
ViewState). La nota que decía que ese portal rechazaba clientes que no fueran
navegador resultó falsa para estas páginas: `scout/documentos.py` reproduce el
flujo del navegador (detalle → `ConsultarDetalleSolicitud` → `MostrarDocumentos`
deja la carpeta en la sesión → `DescargarDocumentos.aspx` lista los archivos →
postback por archivo) y la herramienta muestra, por cada trámite, el estado y
las carpetas con sus archivos: **Ver** (en línea), **Descargar** y **Guardar en
expediente** (queda en `archivo/expedientes/<radicado>/` y anotado en la ficha
del prospecto). Con Mexichem se recuperó la solicitud de renovación del permiso
de mayo de 2026: 1,3 MB con las resoluciones, la vigencia y los números de los
informes de caracterización. Dos detalles del servidor: sirve un HTML *downlevel*
(con `<font>` y `&#39;`) a quien no es navegador, y etiqueta los PDF como
`application/base64`; el tipo se decide por los bytes.

**La cartera.** Las empresas que el equipo decide seguir —a mano, o solas en
cuanto hay trabajo sobre ellas— tienen su dossier en el módulo *Empresas*:
ficha e historial, caracterización, expedientes y trámites con sus documentos,
documentos guardados y procedencia. Desde ahí un documento guardado se lee con
IA y, tras revisar los valores, se **aplica al prospecto**: lo leído pisa al
arquetipo parámetro por parámetro, el caudal autorizado sustituye al estimado
por superficie y el prospecto pasa a `declarado` (nunca a `medido`: es lo que
la empresa reportó, no una muestra nuestra). Queda en la ficha con su fuente y
se aplica antes de puntuar, como todo lo que cambia la confianza.

Lo que costó descubrir del API, para no repetirlo: `type_search` tiene que ser
`Todos`; `filters` tiene que llevar siempre `{"CAMPO": -6}` o el cuerpo vuelve
vacío; las facetas se filtran con listas (`"aut_nombre": [...]`); los ausentes
llegan como la cadena `"None"`; y `total_pages` asume páginas de 10 haga lo que
haga `page_size`.

### Modos de operación

```bash
SIMBIA_SCOUT_MODO=offline   # por defecto: instantánea de trabajo y caché
SIMBIA_SCOUT_MODO=cache     # caché si está fresca, red si caducó
SIMBIA_SCOUT_MODO=vivo      # consulta siempre las fuentes reales
```

El valor por defecto es `offline` a propósito: una demostración no puede
depender de que haya red ni de que una API de un tercero esté disponible.

### Scraping responsable

Implementado una sola vez en `fuentes/base.py` para que ninguna fuente pueda
saltárselo: **robots.txt** consultado y respetado, **límite de tasa** por fuente
(5 s en Overpass, que es un servicio comunitario gratuito), **caché en disco**
con TTL y **User-Agent identificado** con proyecto y contacto. Una fuente caída
no tumba la prospección: se degrada a la instantánea de trabajo y declara la
incidencia.

### Los documentos del expediente sí son públicos

El buscador nuevo publica metadatos y nada más. Pero el sistema antiguo
(`vital.minambiente.gov.co/SILPA_UT_PRE`) sirve los documentos del expediente,
en dos condiciones: que el trámite tenga `origen = VITAL` (los de `SILAMC`,
que son 93 de cada 99 en Cartagena, solo publican el estado) y que se llegue
por la URL correcta:

```
ReportetramiteCPDetalle.aspx?NumSilpa={n}&Origen=VITAL
                           &TarSolId={id}&Solicitante={solicitante}
```

`NumSilpa` tiene estructura descifrable: `1070` + NIT de la empresa + dígito
de verificación + año + secuencia. La lista de archivos se obtiene con un
POST a `ReporteTramiteCPDetalle.aspx/MostrarDocumentos`, y las descargas son
postbacks de ASP.NET sobre `DescargarDocumentos.aspx`.

**Lo que no se puede automatizar todavía:** ese host rechaza toda conexión que
no venga de un navegador —presumiblemente por huella TLS—, así que ni `curl`
ni el servidor de SIMBIA lo alcanzan. Los expedientes se traen a mano y entran
por `POST /api/scout/ingestar`.

### El arquetipo contra el laboratorio

Del expediente de Yara Colombia (Abocol) salió el **Informe 43028**,
caracterización de junio de 2026 hecha por un laboratorio acreditado por el
IDEAM sobre tres muestras compuestas. Sirve para auditar el modelo sectorial:

| Parámetro | Arquetipo | Laboratorio | Error |
|---|---:|---:|---:|
| SST | 10,0 | 9,67 | +3 % |
| Temperatura | 38,0 | 36,19 | +5 % |
| Dureza cálcica | 140 | 156 | −10 % |
| pH | 8,90 | 7,50 | +19 % |
| **N amoniacal** | **45,0** | **64,4** | **−30 %** |
| DQO | 25,0 | 43,7 | −43 % |
| Sulfatos | 210 | 116 | +80 % |
| Caudal (m³/h) | 90,4 | 38,1 | +137 % |
| Alcalinidad | 290 | 55,7 | **+420 %** |
| Fosfatos | 2,0 | 0,15 | **+1 233 %** |

**Conclusión honesta:** el arquetipo acertó la *forma* de la corriente —
dominada por amonio, sólidos bajos, dureza moderada — y acertó el parámetro
limitante, que es para lo que se diseñó. Pero falló feo en alcalinidad (5×) y
en caudal (2,4×), y la alcalinidad no es un parámetro cualquiera: entra
directo en el LSI y por tanto en los ciclos alcanzables.

Es exactamente el argumento para muestrear: el arquetipo dice a quién visitar,
no cuánto invertir.

### Registros de demostración: apagados por defecto

Existen datos de ejemplo para desarrollar sin ninguna fuente disponible, pero
**no se sirven salvo que se pidan** con `SIMBIA_SCOUT_EJEMPLOS=1`. Mezclados
en la misma tabla que los reales dejan de distinguirse a la primera captura de
pantalla. Una fuente sin dato devuelve vacío y dice por qué.

---

## 3. De actividad económica a agua

Es la pieza que convierte "existe una empresa aquí" en "esta agua se puede
reutilizar". Sin ella la prospección devuelve un listado de razones sociales.

La idea es vieja en ingeniería ambiental: **la actividad determina el
efluente**. Una planta de bebidas produce agua de lavado con DQO alta y
salinidad baja; una desmineralizadora produce rechazo con salinidad alta y DQO
despreciable. El código CIIU identifica la actividad y el arquetipo la traduce
a una caracterización típica.

13 arquetipos cubren el corredor: refinería, química básica, termoeléctrica,
plásticos, cemento, PTAR, bebidas, alimentos, siderurgia, papel, textil,
farmacéutica y portuario. Cada uno declara su corriente, su caudal de
referencia, su caracterización, su coeficiente de variación, su parámetro
limitante y su incentivo económico.

**Lo que no hace es fingir precisión.** Un arquetipo acierta el orden de
magnitud y el parámetro limitante, que es exactamente lo que hace falta para
decidir a quién visitar primero. La analítica real llega después: el arquetipo
prioriza el muestreo, no lo sustituye.

El caudal se escala por la superficie del predio con exponente 0,75 —el consumo
de agua no escala linealmente con la superficie— y se acota entre 0,3× y 3×
para que un polígono mal digitalizado no produzca un caudal absurdo.

### Expedientes de empresas concretas

El arquetipo contesta «qué produce una planta de este tipo». El expediente
(`scout/dossier.py`) contesta algo más fuerte: «qué produce ESTA planta». La
diferencia importa cuando el nombre no dice el sector, que en un parque
industrial real es la mayoría de los casos:

| Empresa | Lo que el nombre sugiere | Lo que es |
|---|---|---|
| Abocol S.A. | nada | Complejo de nitrogenados: NH₃, HNO₃, nitrato de amonio |
| Mexichem S.A. | nada | Resinas de PVC, ~400 kt/año |
| Seatech S.A. | nada | Enlatado de atún, ~2 000 trabajadores |
| Cotecmar | nada | Astillero: metales de pinturas antiincrustantes |

Abocol es el caso que más cambia: su corriente lleva **amonio**, que es
precisamente el parámetro más restrictivo del circuito de enfriamiento. Sin
expediente se habría clasificado como química básica y se le habría atribuido
un rechazo de desmineralizadora, que es otra agua completamente.

Cada entrada lleva **fuente citada y verificable — sin fuente no entra**, y hay
una prueba que lo comprueba. Eso la hace `declarada`, no medida: son datos
publicados sobre la actividad y la escala de la empresa, no una analítica de su
vertimiento. Y el expediente **determina el arquetipo, nunca la caracterización
del agua**: poner ahí un DQO atribuido a una empresa nombrada sin haberlo medido
sería exactamente lo que el resto del proyecto se niega a hacer. También hay una
prueba de eso.

---

## 4. Fusión entre fuentes

La misma empresa aparece en varias fuentes con nombres distintos. Fusionar de
menos duplica prospectos y el optimizador cuenta dos veces la misma agua;
fusionar de más mezcla la analítica de una empresa con la ubicación de otra.

Por eso el criterio exige **las dos cosas a la vez**: parecido de nombre ≥ 0,82
tras normalizar (sin tildes, sin sufijos societarios) **y** a menos de 600 m.
Un solo criterio no basta.

---

## 5. Distancia de conducción

La línea recta es un límite inferior inútil para presupuestar. Una conducción
sigue corredores existentes, bordea predios ajenos y cruza vías y caños.
Subestimar el trazado un 40 % subestima el CAPEX de conducción en la misma
proporción.

```
longitud = geodésica × factor_de_tortuosidad + Σ penalización_por_cruce
```

| Corredor | Factor | | Cruce | Equivalente |
|---|---|---|---|---|
| Rack industrial existente | 1,15 | | Vía principal | +0,15 km |
| Derecho de vía pública | 1,35 | | Ferrocarril | +0,25 km |
| Campo traviesa | 1,60 | | Caño o arroyo | +0,35 km |
| | | | Línea costera | +0,80 km |

Es una estimación declarada, no un levantamiento topográfico. Cuando exista el
trazado medido se sustituye y no cambia nada más. Al optimizador viaja el
trazado, nunca la geodésica.

---

## 6. Puntaje de simbiosis

### La pregunta correcta

La tentación es evaluar cada corriente como si fuera el único aporte de la
torre. Es un error, y lo comprobamos: la primera versión de este módulo hacía
eso y declaraba **no viables diez de dieciocho prospectos**, incluida una PTAR
de salinidad baja. El indicador estaba saturado en ambos extremos y no
discriminaba nada.

Ninguna corriente de rechazo se usa al 100 %: siempre va mezclada con agua
cruda. La pregunta útil es **cuánta agua cruda puede desplazar esta corriente
sin bajar los ciclos por debajo de la línea base**.

Eso se responde barriendo la fracción de mezcla —igual que el optimizador barre
los ciclos—: para cada par (tren de tratamiento, fracción) se construye la
mezcla real con el modelo químico completo y se calculan los ciclos
alcanzables. Es **la misma física del optimizador**, no una regla de pulgar.

El barrido es discreto y no una bisección porque la frontera de factibilidad no
es necesariamente monótona en la fracción: una corriente puede mejorar el LSI
al diluir la dureza del agua cruda y empeorarlo más allá de cierto punto.

### Componentes

| Peso | Componente | Por qué |
|---|---|---|
| 40 % | Agua cruda desplazada | Es el objetivo del reto |
| 20 % | Ciclos alcanzables | Determina cuánta purga se recorta además |
| 15 % | Distancia de conducción | Manda en el CAPEX, que es irrecuperable |
| 15 % | Costo del tren | Un tren de ósmosis se come el ahorro en OPEX |
| 10 % | Incentivo del vecino | Que pague por entregarla es un plus, no la base |

El resultado se multiplica por un factor de confianza que **nunca baja de
0,55**: un prospecto poco fiable no se descarta, se posterga.

---

## 7. Puerta al optimizador

Un prospecto es una hipótesis; un oferente es una entrada de catálogo sobre la
que se decide invertir. Convertir lo primero en lo segundo tiene una puerta
explícita: el **umbral de confianza** (0,55 por defecto). Por debajo, el
prospecto no entra al optimizador aunque químicamente sea magnífico, porque
optimizar sobre datos inventados produce un plan de inversión inventado.

Y la confianza no se pierde al cruzar la puerta: se traduce al **factor de
disponibilidad anual** del oferente. Un catálogo poco fiable produce por
construcción una solución más conservadora. Es la forma de que la incertidumbre
llegue al optimizador como un número y no como una nota al pie.

---

## 8. Embudo de contratación

Ocho etapas, de `detectado` a `contratado`, más `descartado`. Cada una declara
qué hace falta para salir de ella —conseguir el permiso, identificar
interlocutor, firmar NDA, hacer la campaña de muestreo, correr el piloto—, que
es la única pregunta que un comercial se hace al abrir la ficha.

La cifra que importa no es cuántas empresas hay en cada casilla sino **cuánto
caudal representan**: veinte prospectos detectados de 5 m³/h valen menos que uno
caracterizado de 120. El dashboard muestra aparte el **caudal asegurado**: el
que tiene analítica real detrás, que es lo único que un banco descontaría.

### La clave estable

El código de un prospecto (`P01`, `P02`…) se asigna por orden de cercanía y
cambia entre barridos. Guardar el trabajo comercial contra ese código lo
perdería en cuanto cambiara el catálogo. Por eso el estado se guarda contra un
hash del nombre normalizado más la coordenada redondeada a ~110 m. Sobrevive a
cambios de orden, a variaciones del nombre y a que una fuente afine la
coordenada. No sobrevive a que una empresa se mude o cambie de razón social,
que es justo cuando conviene revisar el expediente a mano.

---

## 9. Vigilancia

Un barrido es una foto; lo que interesa a medio plazo es la película. Cada
barrido se archiva y se compara con el anterior: altas, bajas, cambios de
caudal (≥ 20 %), de salinidad (≥ 15 %), de confianza (≥ 0,15) y de puntaje
(≥ 8 puntos).

Los umbrales son deliberadamente altos. Un detector que avisa de todo se ignora
en dos semanas, y entonces no avisa de nada.

---

## 10. Extracción de permisos con IA

El permiso de vertimiento trae caudal autorizado y la tabla de caracterización:
exactamente lo que le falta al arquetipo. Y es un PDF, a veces escaneado, con
los parámetros en castellano administrativo y las unidades mezcladas. Ninguna
expresión regular sobrevive a la variedad de formatos de una decena de
autoridades ambientales.

Se resuelve con **salida estructurada** (`claude-opus-5`): la respuesta valida
contra un esquema tipado o falla, así que no hay que interpretar prosa. Después
se traducen los nombres administrativos al vocabulario de SIMBIA —con sinónimos
y conversión de unidades— y se reparten en modelables, informativos (DBO₅,
grasas, color: informan aunque no entren al balance) y no reconocidos, que se
reportan en vez de ignorarse.

**Lo extraído entra como `declarado`, nunca como `medido`**: un permiso declara
lo que la empresa reportó a la autoridad, no una muestra tomada por nosotros.

**Seguridad.** El PDF es contenido no confiable y puede contener texto dirigido
al modelo. Dos defensas: la salida estructurada acota la superficie a un esquema
fijo —lo peor que puede pasar es un número equivocado, no una acción— y el
prompt declara explícitamente que el documento es dato y no instrucción. La
cifra extraída se muestra para confirmación antes de tocar nada.

Es una función **opcional**: sin el paquete `anthropic` o sin credenciales, se
declara no disponible y el resto de la prospección funciona igual.

---

## Qué cambia cuando lleguen los datos reales

| Hoy | Con datos reales |
|---|---|
| Coordenada aproximada de la planta | Punto de entrega levantado en campo |
| Instantánea de trabajo de Mamonal | Consulta en vivo a Overpass |
| Conector de permisos sin configurar | Conjunto de datos real en `fuentes.json` |
| Caracterización por arquetipo (`inferido`) | Permiso o campaña de muestreo (`declarado` / `medido`) |
| Trazado estimado por factor de tortuosidad | Longitud del trazado replanteado |

**Lo que no cambia es la estructura.** La química, el balance, las
restricciones, el puntaje y la puerta de confianza son los mismos. Cambian los
números, no el método — y el sistema ya está construido para decir, en cada
celda, cuál de las dos columnas está mirando.
