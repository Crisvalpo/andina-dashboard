# Herramienta de corte y coloreo por estado — plan de trabajo

Estado: **análisis cerrado y preguntas respondidas. Sin código escrito.** Rama `feature/herramienta-corte`.
Base: `dd8e078` (merge de la modularización ESM).

Todos los números salen de datos reales de producción medidos el 2026-07-28.

---

## 1. Hallazgos verificados

### 1.1 El coloreo mete tres cosas distintas en el mismo cajón gris

`GET /api/bim/statuses` — [index.js:500](index.js#L500):

```js
const status = statusEntry ? statusEntry.status : 'SIN ESTADO';
```

Ese fallback colapsa situaciones que no tienen nada que ver. Reparto real:

| | GUIDs | |
|---|---:|---|
| Total en `LIST_Bim_MS` | 4608 | |
| `SIN ESTADO` | **3622** | **78.6% del modelo pintado de gris** |
| ├─ sin ningún vínculo | 2636 | catastro pendiente |
| ├─ vinculados a válvula/soporte | 11 | bug 1.2 |
| └─ con spool, sin registro en `LOG_Spool_MS` | 975 | dato que no llegó de terreno |
| Con estado real | 986 | |

"Nadie lo ha vinculado todavía" y "tiene spool pero terreno no reportó" son
problemas de gestión opuestos y hoy se ven idénticos.

### 1.2 `statuses` solo mira la columna de spool

`LIST_Bim_MS` tiene tres columnas de vínculo: `SPOOL LUKEAPP`, `VALVULA LUKEAPP`
y `SOPORTE LUKEAPP`. El endpoint solo lee la primera, así que **11 elementos que
sí están vinculados** (6 válvulas, 5 soportes) caen en `SIN ESTADO`. Son pocos
hoy; escala el día que se catastren válvulas en serio.

### 1.3 Vincular crea la fila, pero sin los datos del modelo

`POST /api/bim/vincular` crea la fila si no existe — [index.js:927](index.js#L927).
Pero `bimSaveLink` envía `cwp: ''` y `autocad_size: ''` vacíos, y saca
`line_number`/`tag` de `el.layer`.

Consecuencia: **una fila recreada es más pobre que la original.** De las 2636 filas
sin vínculo, **1928 llevan `DESCRIPCIÓN` y `CWP` reales** (ej. *"FLANGE ADAPTADOR
N°741, ASTM A536, ASME B16.5, CLASE 150"*). Es un catálogo de componentes del
modelo que hoy **no se regenera** desde el visor.

> Por eso **no** hay que borrar las filas no vinculadas. El problema está en la
> lógica de consulta (1.1), no en los datos. Solo 708 filas tienen GUID y nada
> más, y borrarlas no arregla nada que no arregle ya el cambio de lógica.

### 1.4 La identidad de un trozo es su posición

[bimViewer.js:2330](modules/bimViewer.js#L2330):

```js
const key = `${String(guid).toLowerCase()}#p${idx + 1}`;
```

`idx` es el índice posicional. Esa cadena se guarda en `LIST_Bim_MS` como si fuera
un GUID de elemento. Si un tubo está en `p1|p2|p3` y se añade un corte antes de
`p2`, lo que era `p2` pasa a ser `p3` — pero AppSheet sigue diciendo `p2`.
**La vinculación se queda con el trozo equivocado, en silencio.**

### 1.5 Los trozos son invisibles para APS

Un trozo es un `THREE.Mesh` en una capa de overlay: no tiene `dbId`, no está en el
árbol de instancias, no tiene propiedades consultables. Por eso no participa en el
navegador de Autodesk, `isolate`, `hide`, la selección nativa, el theming ni la
búsqueda por propiedades.

De ahí que existan `bimDivColorearTrozos`, `bimDivFiltrarTrozos`,
`bimDivGhostPorSpool` y `bimDivReocultarOriginales`: son reimplementaciones
manuales de lo que el visor ya hace nativo. **No están mal escritas; pelean contra
la arquitectura.**

Corolario: **no se puede eliminar permanentemente un elemento de un modelo APS ya
cargado**, solo ocultarlo. Cualquier "mostrar todo" nativo resucita el original
cortado, y `bimDivReocultarOriginales` es un parche perpetuo contra eso.

### 1.6 Dos implementaciones paralelas del mismo filtro

`bimAplicarFiltroEstados` resuelve el filtro por `dbId` y luego llama aparte a
`bimDivFiltrarTrozos` para los overlays. Dos caminos que hacen lo mismo con código
distinto: se desincronizan.

### 1.7 Restaurar deja huérfanos

`bimDividirRestaurar` borra la división de `bim_divisiones` pero **no borra las
filas `guid#pN` de `LIST_Bim_MS`**, que quedan apuntando a geometría inexistente.

---

## 2. Decisiones ya tomadas

1. **Para qué existe la herramienta:** repartir un elemento de modelo entre varios
   spools, no "partir un tubo". Cada trozo hereda las propiedades del padre y añade
   las suyas.
2. **Al cortar, el original se oculta para siempre.**
3. **Divisiones planas, un solo nivel.** No se corta un trozo ya cortado; se reedita
   la división original y se añade otro trozo.
4. **Modo edición aísla:** al entrar se oculta todo el modelo salvo el tramo.
5. **Interacción:** seleccionar elemento → pulsar herramienta → entra ya dividido en
   2 → cada click adicional divide **el trozo pinchado en dos** → arrastrar extremos
   para ajustar → pulsar herramienta para salir. Hace falta **deshacer** accesible.
   *(Se eligió "divide el trozo pinchado" frente a "reparte en partes iguales"
   precisamente porque conserva la geometría y el spool de los demás trozos.)*
6. **La app es la autoridad del filtrado**, no el visor. Se asume que el navegador
   de Autodesk nunca verá los trozos; a cambio, los filtros de la app cubren ambos
   mundos.

---

## 3. Respuestas (resueltas 2026-07-28)

**1 · Qué se ve un elemento no vinculado.**
Al entrar a la sección BIM se ve **el modelo completo menos los originales ocultados
por la herramienta de corte**. Al aplicar un filtro de estado, los que coinciden se
pintan con su color y **todo lo demás pasa a rayos X**.

Consecuencia: un elemento sin vincular **no necesita color propio** — es simplemente
"lo demás". Lo que sí debe dejar de pasar es que aparezca dentro del chip
`SIN ESTADO`, porque hoy ensucia el recuento y el resaltado.

> *Lectura mía, a confirmar:* los elementos sin vincular no aparecen en **ningún**
> chip de estado, y su recuento se expone como **métrica de catastro pendiente**, no
> como filtro. Si se prefiere un chip propio "SIN VINCULAR" para dirigir el catastro,
> es un añadido pequeño sobre lo mismo.

**Requisito nuevo:** ofrecer desde la app la **búsqueda por isométrico completo o por
línea**, que hoy se hace con el filtro nativo de APS. Así se deja de depender de unas
herramientas nativas que son ciegas a las modificaciones. → paso 4.6.

**2 · Divisiones y vinculaciones existentes.**
Son reales, las hizo personal de obra y son valiosas — pero ajustar la herramienta
también lo es. Decisión: **basta con registrar a qué TAG GESTIÓN estaba vinculado
cada trozo**; si se pierden las divisiones, se rehacen.

Implica: antes de migrar, **exportar el mapa trozo → TAG GESTIÓN** como respaldo. No
hace falta migración de geometría. → paso 4.2.

**3 · ¿Todo trozo acaba en un spool?**
En teoría sí, pero habrá casos donde se divida y **algunos trozos queden sin
asignar**. Es un estado válido del modelo, no un error.

**4 · ¿Dos trozos del mismo elemento pueden compartir spool?**
**Sí** — se usa para graficar una unión.

Consecuencia importante: el par *(elemento, spool)* **no es único** y por tanto **no
sirve como identidad**. Cada trozo necesita un id propio y estable. Confirma 4.2.

**5 · ¿Se ajustan los cortes después de vincular?**
Existe la posibilidad. La reedición debe **conservar las vinculaciones** de los
trozos que no se tocan.

**6 · ¿Borrar filas al restaurar una división?**
**Sí**, hay que borrar los registros de las divisiones restauradas. → paso 4.2.

**7 · El "mostrar todo" nativo de APS resucita los originales ocultos.**
Se acepta el enfoque de vigilancia: **detectar los "mostrar todo" de APS** y, si no
se puede interceptar el evento, relanzar el ocultado periódicamente — *"funcionaría
como un refresh sin refresh"*. → paso 4.7.

**Transversal · Origen del estado.**
Los estados vienen **netamente de `LOG_Spool_MS`**: es ahí donde terreno los define.
Cualquier otra fuente (`Proceso` / `ESTADO_FABRICACION` de `LIST_Spools_MS_`) no es
autoridad y no debe competir con ella.

---

## 4. Plan de ajuste

Ordenado por dependencia y riesgo. Cada paso es verificable por separado.

### 4.1 Separar los estados del coloreo *(bajo riesgo, alto valor)*

- En `/api/bim/statuses`, dejar de meter en `SIN ESTADO` lo que no tiene vínculo.
  Categorías reales: los estados de `LOG_Spool_MS`, más `SIN ESTADO` = **vinculado a
  un spool que no tiene registro en LOG** (975 hoy).
- Los elementos sin vínculo (2636) salen de los chips y pasan a ser **métrica de
  catastro pendiente**.
- Leer también `VALVULA LUKEAPP` y `SOPORTE LUKEAPP`, no solo spool (hallazgo 1.2):
  hoy 11 elementos vinculados se pintan como si no lo estuvieran.
- **No borrar ninguna fila** (hallazgo 1.3).
- Estado solo desde `LOG_Spool_MS` (respuesta transversal).

### 4.2 Clave estable de trozo *(riesgo medio)*

- Sustituir `guid#pN` posicional por un **id propio generado al crear el trozo**,
  persistido junto a sus `[a,b]` en `bim_divisiones`. No vale *(elemento, spool)*:
  dos trozos pueden compartir spool (respuesta 4).
- **Antes de tocar nada: exportar el mapa trozo → TAG GESTIÓN** (respuesta 2). Las
  divisiones se pueden rehacer; saber a qué spool iban, no.
- La reedición conserva las vinculaciones de los trozos intactos (respuesta 5).
- Al restaurar una división, borrar sus filas en `LIST_Bim_MS` (respuesta 6,
  hallazgo 1.7).

### 4.3 Unificar el filtrado *(refactor interno, sin cambio funcional)*
- Una sola noción de **unidad renderizable**: elemento original no dividido, o trozo.
  Los originales divididos quedan excluidos.
- Una única función resuelve "¿qué unidades cumplen este filtro?"; un despachador
  aplica el resultado por el mecanismo que toque (theming nativo si es `dbId`,
  material de overlay si es trozo).
- Comportamiento por defecto: modelo completo menos los cortados. Con filtro activo:
  los que coinciden con su color, el resto en rayos X (respuesta 1).
- Elimina la divergencia del hallazgo 1.6.

### 4.4 Interacción de corte *(sobre 4.2)*
- Click divide **el trozo pinchado** en dos (decisión 5).
- Deshacer accesible y visible.
- Modo edición aísla el tramo (decisión 4).
- Un trozo puede quedar sin asignar (respuesta 3).

### 4.5 Enriquecer la fila al vincular *(independiente, pequeño)*
- Que `bimSaveLink` lea `CWP`, `AutoCad Size` y `DESCRIPCIÓN` del visor
  (`getProperties`) en vez de mandarlos vacíos (hallazgo 1.3).
- Así una fila creada deja de ser más pobre que una preexistente.

### 4.6 Búsqueda por isométrico y por línea desde la app *(nuevo, respuesta 1)*
- Hoy se hace con el filtro nativo de APS, que es ciego a los trozos.
- Al vivir en la app, cubre por igual originales y trozos, y reduce la dependencia de
  las herramientas nativas.

### 4.7 Vigilancia del "mostrar todo" de APS *(respuesta 7)*
- Detectar el evento nativo de mostrar todo y re-ocultar los originales cortados.
- Si no es interceptable, relanzar el ocultado de forma periódica.
- Reemplaza el parcheo manual disperso de `bimDivReocultarOriginales`.


---

## 5. Capas de vinculación: spool, válvula y soporte

`LIST_Bim_MS` tiene tres columnas de vínculo — `SPOOL LUKEAPP`, `VALVULA LUKEAPP`
y `SOPORTE LUKEAPP` — pero no se tratan igual.

### 5.1 Spool no es una capa

`BIM_CAPAS` en el backend solo define **válvula y soporte**:

```js
const BIM_CAPAS = {
    valvula: { col: 'VALVULA LUKEAPP', listTable: 'LIST_Valvulas_MS', ... },
    soporte: { col: 'SOPORTE LUKEAPP', listTable: 'LIST_Soportes_MS', ... }
};
```

Spool va por un endpoint aparte, `/api/bim/vincular`, con la columna escrita a
mano. Esa asimetría es el origen de todo lo demás: hay dos implementaciones del
mismo concepto, una genérica y otra especial, y solo la genérica sabe de columnas.

### 5.2 Lo que SÍ funciona

`bimSaveLink` enruta bien: `/api/bim/vincular` para spool y
`/api/bim/:capa/vincular` para válvula y soporte, que escribe en `capa.col`.
`bimRemoveLink` hace lo mismo al desvincular. **El flujo principal es correcto.**

Medido sobre producción: 1963 filas con spool, 6 con válvula, 5 con soporte, y
**0 filas con más de una columna rellena**. Los datos están limpios hoy.

### 5.3 Lo que está hardcodeado

Las cuatro llamadas del camino de TROZOS ignoran la capa activa:

| función | llama a | efecto |
|---|---|---|
| `bimTrozoVincular` | `/api/bim/vincular` con `{spool}` | escribe siempre en `SPOOL LUKEAPP` |
| `bimTrozoDesvincular` | `/api/bim/desvincular` | limpia solo `SPOOL LUKEAPP` |
| `bimTrozoEliminarDivision` | `/api/bim/desvincular` | idem |
| `bimDividirRestaurar` | `/api/bim/desvincular` | idem |

Y `bimTrozoPointerUp` **no filtra por capa**: estando en válvulas o soportes se
puede pinchar un trozo, y su panel —que dice "Spool" y usa `trozo-spool-input`—
escribiría en la columna de spool mientras la interfaz dice otra cosa.

### 5.4 La pregunta de diseño, antes de tocar nada

`bimValidarTubo` restringe la herramienta a **tramos rectos de cañería**: una
válvula o un soporte no se cortan. Así que conceptualmente un trozo solo puede
pertenecer a un spool, y que `bimTrozoVincular` escriba en esa columna no es un
error de destino sino de expresión: hace lo correcto por accidente, sin decirlo,
y sin impedir el estado incoherente.

**Si eso se confirma**, la solución NO es hacer los trozos multi-capa, sino dejar
explícito que son de spool y bloquear el camino incoherente. **Si no se confirma**
—si alguna vez hay que cortar algo que se asigne a un soporte— entonces el camino
de trozos necesita el mismo enrutado por capa que `bimSaveLink`.

> **Respondida (2026-07-29): NO.** Un trozo solo puede ser de un spool — la
> herramienta es para cortar cañería. Se bloquea el camino incoherente en vez de
> enrutarlo por capa.
>
> Queda abierta una capa futura, **uniones**, que sería la cuarta categoría junto
> a spool, válvula y soporte. No cambia esta decisión: una unión tampoco se corta.

### 5.5 Plan

Ordenado por riesgo. Los dos primeros no dependen de la respuesta.

**5.5.1 Unificar spool como una capa más** *(refactor, sin cambio funcional)*
Añadir `spool` a `BIM_CAPAS` con su `col`, `listTable` y `listKey`, y hacer que
`/api/bim/vincular` sea un alias de `/api/bim/spool/vincular`. Elimina la
duplicación de 5.1 y con ella la posibilidad de que las dos ramas divarguen.

**5.5.2 Leer las tres columnas al resolver estado** *(ya era el paso 4.1)*
`/api/bim/statuses` solo mira `SPOOL LUKEAPP`, así que los 11 elementos
vinculados a válvula o soporte caen en `SIN ESTADO` y se pintan como huérfanos.

**5.5.3 Hacer explícita la regla del trozo** — HECHO
`bimTrozoPointerUp` no selecciona trozos fuera de la capa spool, y
`bimTrozoVincular` lleva una guarda propia por ser global en `window`. Desvincular
sigue limpiando solo `SPOOL LUKEAPP`, que ahora es correcto: si un trozo solo
puede tener vínculo de spool, limpiar esa columna lo deja sin ningún vínculo.

**5.5.4 El escáner QR debe respetar la capa** — HECHO
`bimOnQRDetected` llamaba siempre a `bimLoadSpool`, así que escanear en la
sección de válvulas buscaba un spool y el mensaje decía "Cargando spool". Ahora
enruta como `bimSearchSpool`.

**5.5.5 Capa futura: uniones**
Añadirla debería ser configuración, no código: una entrada en `BIM_CAPAS`
(columna, tabla maestra, llave, tabla de montaje), otra en `BIM_CAPA_UI`
(etiqueta, placeholder) y un botón en `index.html`. El paso 5.5.1 —unificar spool
como una capa más— es lo que hace que eso sea cierto también para spool.

### 5.6 Verificado y descartado

No son problema, aunque lo parecían:

- `bimSaveLink` y `bimRemoveLink` **sí** enrutan por capa.
- La autoselección por spool al pinchar un elemento **sí** respeta la capa: en
  válvulas y soportes va por el flujo simple (1 elemento = 1 ítem, sin auto-grupo).
- Los datos están limpios: 0 filas con más de una columna de vínculo rellena.
- Los endpoints de capa responden: `/api/bim/valvula/item/VAL001` devuelve ficha y
  etiqueta; los statuses reparten en MONTADO/PENDIENTE.
- Hay 167 válvulas y 515 soportes en las tablas maestras, con 2 y 83 registros de
  montaje. El dato maestro existe; lo que falta es vincularlos al 3D (6 y 5 hoy).

---

## 6. Válvulas y soportes: lo que queda

Hecho ya: enrutado por capa del escáner QR, trozos bloqueados fuera de spool,
estado desde `REG_Montaje*` con la regla de cada capa, bot alineado con las
etapas de válvula, textos del panel de vinculación por capa, y color propio de
cada sección en la barra lateral.

### 6.1 El coloreo global sigue ignorando dos columnas *(el más importante)*

`/api/bim/statuses` — el que pinta el modelo — solo lee `SPOOL LUKEAPP`, así que
los elementos vinculados a válvula o soporte caen en `SIN ESTADO` y se ven como
huérfanos. Hoy son 11 y no se nota; con las 167 válvulas y 515 soportes de las
tablas maestras serían **682 elementos correctamente vinculados pintados como si
nadie los hubiera catastrado**, y el filtro por estado no serviría para dirigir
ese trabajo.

Es el paso 4.1 con el matiz aprendido: no es "leer tres columnas", son **tres
fuentes con tres reglas** — spool desde `LOG_Spool_MS` por fecha, válvula desde
`REG_MontajeValvulas_MS` por su columna `Status`, soporte por presencia de fila.
La función `estadosMontajeDeCapa()` ya resuelve las dos últimas; falta unirlas.

### 6.2 Isométrico y P&ID en válvulas y soportes *(pendiente de evaluar)*

Los spools ofrecen ambos planos en su ficha. Las válvulas y soportes tienen
`ID_LINEA`, que es justo por donde se resuelven: `/api/iso/pdf/:idIso` va por ISO
y `/api/pid/pdf/:spoolId` resuelve el spool a su línea. Técnicamente hay por
dónde, pero falta comprobar si desde `ID_LINEA` se llega al ISO correcto y qué
hacer cuando una línea tiene varias hojas.

### 6.3 Oportunidad de catastro, no de código

**83 registros de montaje de soportes** ya capturados en terreno, y solo **5
soportes vinculados al 3D**. El dato existe; en cuanto se vinculen, esos estados
aparecen solos en el visor. Lo mismo con las 2 válvulas con montaje, ninguna de
ellas vinculada todavía.

### 6.4 Capa futura: uniones

Tras los cambios de esta sesión, añadirla es configuración: una entrada en
`BIM_CAPAS` (backend), otra en `BIM_CAPA_UI` (etiquetas y textos del panel), su
par de variables de color en `style.css` y un botón en `index.html`. Lo único que
aún no es config es que **spool sigue sin ser una capa** (paso 5.5.1).

---

## 7. Soportes por spool (entrega por paquete)

**Objetivo:** saber qué soportes van en cada spool y si están montados, para poder
decir "el spool 509 está terminado: fabricado, montado y con sus soportes puestos".

### 7.1 La relación es muchos a muchos

Un soporte de pipe rack sostiene varias líneas a la vez, y un spool tiene varios
soportes. **No es una columna en `LIST_Soportes_MS`**: funcionaría hasta el primer
soporte compartido y luego habría que deshacerlo con datos ya cargados. Si se
persiste, va en una tabla de relación (`REL_SoporteSpool_MS`).

### 7.2 La línea NO sirve como atajo

`ID_LINEA` une soportes y spools con cobertura total: las 64 líneas con soportes
están todas entre las 101 con spools. Pero la granularidad no alcanza — en
`03351-CT-200-H2-0002-N` hay **36 spools y 54 soportes**. Atribuir los 54 a cada
uno de los 36 no dice nada útil.

Sirve para avance **por línea**, que es una métrica válida y sale gratis hoy. No
sirve para entrega por spool.

### 7.3 Derivar del modelo 3D, no teclearlo

Soportes y spools se vinculan ambos a GUIDs en `LIST_Bim_MS`. Con los dos
vinculados, la **proximidad geométrica** dice qué spool toca cada soporte sin que
nadie lo teclee.

Lo importante del razonamiento: **el trabajo manual es el mismo en ambos caminos**.
Catastrar 515 soportes contra spools a mano, o vincular esos mismos 515 soportes
al 3D. Pero el segundo camino da además la visualización, el filtro por estado y
la relación derivada — y no se equivoca al teclear. Hoy hay 5 soportes vinculados
al 3D de 515.

Ruta recomendada:
1. Vincular soportes al 3D (trabajo de catastro que ya estaba pendiente).
2. Derivar candidatos soporte→spool por proximidad.
3. Que el usuario confirme o corrija en la app; persistir en `REL_SoporteSpool_MS`.
   La geometría propone, la persona decide: en los límites entre spools la
   proximidad sola es ambigua.

### 7.4 El dato de montaje ya existe

**83 de 515 soportes ya tienen registro de montaje** en `REG_MontajeSoportes_MS`.
En cuanto exista la relación, el "¿están montados?" sale solo — no hay que
capturar nada nuevo en terreno.

### 7.5 Lo que NO hay que hacer

Crear una columna de spool en `LIST_Soportes_MS` y regenerar AppSheet: modela un
muchos-a-muchos como uno-a-uno, obliga a rellenar 515 filas a mano, y se rompe con
el primer soporte de rack compartido.

---

## 8. Contexto útil

- `bim-ifc-export.js` ya materializa los trozos como `IfcPipeSegment` reales con
  `Pset_AndinaTrozo` (spool, estado, ISO, fluido, capa, ejecución). Hoy se usa para
  federar en Revit/Navisworks. Si algún día se quiere que los trozos sean ciudadanos
  de primera en APS, ese IFC traducido y cargado como **segundo modelo** es el
  camino — tendrían `dbId`, navegador, theming y búsqueda nativos. Se descartó por
  ahora (decisión 6) porque introduce un ciclo de traducción.
- `LIST_Piping_MS(LIST_Bim_MS).csv` (2685 filas) está versionado en la raíz y parece
  ser el volcado original del modelo. Red de seguridad parcial si alguna vez se toca
  la tabla.
- Logística quedó pendiente aparte: su lógica está entera y arreglada, pero la tabla
  origen `LOG_Guia_MS` está vacía en AppSheet.
