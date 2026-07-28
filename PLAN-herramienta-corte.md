# Herramienta de corte y coloreo por estado — plan de trabajo

Estado: **análisis cerrado, sin código escrito.** Rama `feature/herramienta-corte`.
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

## 3. Preguntas abiertas

Bloquean el modelo de datos. Ordenadas por impacto.

1. **¿Qué debe verse un elemento no vinculado a nada?** ¿Invisible, gris neutro de
   fondo, o color propio que grite "falta por catastrar"? Depende de si el visor es
   para *revisar avance* (estorba) o para *dirigir el catastro* (es justo lo que
   quieres ver). — *Condiciona todo el punto 4.1.*

2. **¿Qué pasa con las divisiones y vinculaciones que ya existen en producción?**
   ¿Hay trozos ya vinculados que migrar a las claves nuevas, o estamos en pruebas y
   se pueden descartar y rehacer? — *Decide si 4.2 necesita migración.*

3. **¿Un trozo siempre acaba perteneciendo a un spool?** ¿O hay casos donde una
   parte queda deliberadamente sin asignar (tubería existente, otro contratista, o
   aún no se sabe)?

4. **¿Puede un mismo elemento tener dos trozos del mismo spool?** Si nunca ocurre,
   el par *(elemento, spool)* es único y la identidad se vuelve trivial.

5. **¿Se ajustan los cortes después de vincular?** ¿Arrastrar extremos es solo
   mientras defines la división, o se vuelve semanas después a corregir un límite de
   un trozo ya vinculado y con estado?

6. **¿`bimDividirRestaurar` debe borrar las filas `guid#pN` de `LIST_Bim_MS`?**
   (Hallazgo 1.7.) Presumiblemente sí, pero confirma que no hay dependencia externa
   de esas filas.

7. **El original oculto "para siempre" choca con el "mostrar todo" nativo de APS**
   (hallazgo 1.5). ¿Se acepta el parche de re-ocultar, o se quita del alcance del
   usuario el botón nativo de mostrar todo?

---

## 4. Plan de ajuste

Ordenado por dependencia y riesgo. Cada paso es verificable por separado.

### 4.1 Separar los estados del coloreo *(bajo riesgo, alto valor)*
**Depende de la pregunta 1.**

- Distinguir en `/api/bim/statuses` tres categorías donde hoy hay una:
  `SIN VINCULAR` · `SIN ESTADO` (vinculado, sin registro) · `SIN REGISTRO` (clave que
  no resuelve, ej. `guid#pN` huérfano).
- Leer también `VALVULA LUKEAPP` y `SOPORTE LUKEAPP`, no solo spool (hallazgo 1.2).
- No borrar ninguna fila (hallazgo 1.3).
- **Métrica que se gana:** cuánto del modelo queda por vincular — hoy no existe.

### 4.2 Clave estable de trozo *(riesgo medio)*
**Depende de la pregunta 2.**

- Sustituir `guid#pN` posicional por una clave que no dependa del orden: id generado
  al crear el trozo y persistido junto a sus `[a,b]` en `bim_divisiones`.
- Migrar o descartar lo existente según la respuesta a la pregunta 2.
- Limpiar huérfanos al restaurar (hallazgo 1.7).

### 4.3 Unificar el filtrado *(refactor interno, sin cambio funcional)*
- Una sola noción de **unidad renderizable**: elemento original no dividido, o trozo.
  Los originales divididos quedan excluidos.
- Una única función resuelve "¿qué unidades cumplen este filtro?"; un despachador
  aplica el resultado por el mecanismo que toque (theming nativo si es `dbId`,
  material de overlay si es trozo).
- Elimina la divergencia del hallazgo 1.6.

### 4.4 Interacción de corte *(sobre 4.2)*
- Click divide **el trozo pinchado** en dos (decisión 5).
- Deshacer accesible y visible.
- Modo edición aísla el tramo (decisión 4).

### 4.5 Enriquecer la fila al vincular *(independiente, pequeño)*
- Que `bimSaveLink` lea `CWP`, `AutoCad Size` y `DESCRIPCIÓN` del visor
  (`getProperties`) en vez de mandarlos vacíos (hallazgo 1.3).
- Así una fila creada deja de ser más pobre que una preexistente.

---

## 5. Contexto útil

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
