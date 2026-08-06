/**
 * Herramientas dinámicas del bot Andina — patrón "mapa del mundo"
 * aprendido de LukeMaquinarias (adminHandler + bot_tools_dinamicas).
 *
 * Gemini conoce cada tabla y columna (worldMap) y, cuando un supervisor
 * pide una consulta no cubierta por el código, se AUTO-ESCRIBE la solución:
 * registra una herramienta JS en andina.bot_tools_dinamicas y la ejecuta.
 * El catálogo crece con el uso — las consultas siguientes la reutilizan.
 *
 * Contexto de ejecución de cada herramienta:
 *   - supabase : cliente del esquema 'andina' (lectura/escritura)
 *   - appsheet : { find(tabla) } SOLO LECTURA sobre las tablas del proyecto
 *   - args     : argumentos de la llamada
 */
const { CONFIG } = require('../config');
const { getSupabase } = require('./supabase');
const { fetchAppSheetCached } = require('./appsheet');
const { generarMapaDelMundo } = require('./worldMap');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_ITERACIONES = 4;
const TIMEOUT_TOOL_MS = 8000;

// ---------------------------------------------------------------
// Catálogo
// ---------------------------------------------------------------
async function cargarTools() {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('bot_tools_dinamicas')
        .select('nombre_funcion, descripcion, esquema_json, codigo_javascript');
    if (error) {
        console.error('[botTools] Error cargando catálogo:', error.message);
        return [];
    }
    return data || [];
}

function declaraciones(dbTools) {
    const crearTool = {
        name: 'crear_herramienta_dinamica',
        description: 'Crea y registra una herramienta de consulta dinámica cuando el usuario pida un reporte, listado, conteo o cruce de datos que NO exista en el catálogo. Proporciona código JavaScript asíncrono que use los objetos "supabase" (esquema andina), "appsheet" (solo lectura de tablas del proyecto) y "args".',
        parameters: {
            type: 'OBJECT',
            properties: {
                nombre_funcion: { type: 'STRING', description: "Nombre único snake_case, empieza con 'obtener_' o 'consultar_'." },
                descripcion: { type: 'STRING', description: 'Qué hace y qué retorna.' },
                codigo_javascript: { type: 'STRING', description: 'Código JS asíncrono. Desestructura args en la primera línea. Usa await appsheet.find("Tabla") o supabase.from("tabla"). Termina con return.' },
                esquema_json: { type: 'OBJECT', description: 'Esquema JSON de los parámetros de la función.' }
            },
            required: ['nombre_funcion', 'descripcion', 'codigo_javascript', 'esquema_json']
        }
    };

    const dinamicas = dbTools.map(t => ({
        name: t.nombre_funcion,
        description: t.descripcion,
        parameters: t.esquema_json.parameters || t.esquema_json
    }));

    return [{ functionDeclarations: [crearTool, ...dinamicas] }];
}

// ---------------------------------------------------------------
// Ejecución sandbox de una herramienta
// ---------------------------------------------------------------
async function ejecutarTool(tool, args, usuario = null) {
    const supabase = getSupabase();
    const userSettings = usuario && usuario.rol ? { "Rol": String(usuario.rol).toUpperCase().trim() } : null;
    const appsheet = {
        // Solo lectura: las escrituras a AppSheet pasan por el flujo de registro validado.
        find: (tabla) => fetchAppSheetCached(tabla, userSettings)
    };

    const fn = new Function('supabase', 'appsheet', 'args', `
        return (async () => {
            ${tool.codigo_javascript}
        })();
    `);
    const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout de ejecución excedido (${TIMEOUT_TOOL_MS / 1000}s)`)), TIMEOUT_TOOL_MS)
    );
    const resultado = await Promise.race([fn(supabase, appsheet, args || {}), timeout]);

    // Contador de usos (mejor esfuerzo, no bloquea)
    supabase.from('bot_tools_dinamicas')
        .select('usos').eq('nombre_funcion', tool.nombre_funcion).maybeSingle()
        .then(({ data }) => {
            if (data) {
                return supabase.from('bot_tools_dinamicas')
                    .update({ usos: (data.usos || 0) + 1 })
                    .eq('nombre_funcion', tool.nombre_funcion);
            }
        })
        .catch(() => {});

    return resultado;
}

async function registrarTool({ nombre_funcion, descripcion, codigo_javascript, esquema_json }, creadaPor) {
    const supabase = getSupabase();
    const { error } = await supabase.from('bot_tools_dinamicas').upsert(
        [{ nombre_funcion, descripcion, codigo_javascript, esquema_json, creada_por: creadaPor || null }],
        { onConflict: 'nombre_funcion' }
    );
    if (error) return `Error al registrar: ${error.message}`;
    return `Éxito: herramienta "${nombre_funcion}" registrada. Ya puedes llamarla con sus argumentos.`;
}

// ---------------------------------------------------------------
// Agente: consulta avanzada con function-calling loop
// ---------------------------------------------------------------
async function consultaAvanzada({ texto, historial = [], usuario, botConf }) {
    if (!CONFIG.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurada');

    const mapa = await generarMapaDelMundo();
    let dbTools = await cargarTools();
    let tools = declaraciones(dbTools);

    const systemPrompt = `Eres ${botConf.nombre_bot || 'Andi'}, asistente de datos del proyecto de piping Andina PRY-413 (faena industrial chilena).
Interactúas con: ${usuario.nombre} (rol: ${usuario.rol}). Tiene acceso de consulta a todos los datos del proyecto.

CAPACIDAD ESPECIAL — HERRAMIENTAS DINÁMICAS:
Conoces el mapa completo de datos del proyecto (abajo). Si el usuario pide un reporte, conteo, listado o cruce de datos que NO exista en tu catálogo de herramientas, DEBES programar la consulta tú mismo llamando a "crear_herramienta_dinamica" (en silencio) y luego ejecutarla y responder con los resultados. Si ya existe una herramienta que sirve, úsala directamente.

REGLAS DE COMPORTAMIENTO:
1. IDIOMA OBLIGATORIO: Responde SIEMPRE en español chileno profesional de faena, trato formal y neutro. NUNCA respondas en inglés ni en otro idioma, sin importar el idioma del resultado de las herramientas. Respuestas concisas, formateadas para WhatsApp (listas cortas, negritas con *asteriscos*).
2. PROHIBIDO reportar el flujo técnico interno: nunca digas "he creado una herramienta", "consultando la base de datos", ni menciones JSON/SQL/tablas internas. Ejecuta en silencio y entrega el dato.
3. Si el resultado es muy largo (>15 filas), resume: totales, top 5-10, y ofrece detallar.
4. Los datos operacionales del proyecto (spools, juntas, isométricos, líneas, guías, SDI, inspecciones QC, BIM) viven en AppSheet: usa await appsheet.find("NombreTabla") que retorna el array completo de filas; filtra/agrega con JavaScript (los valores llegan como strings — convierte con parseFloat/trim cuando compares o sumes).
5. Los datos propios del bot (usuarios WhatsApp, mensajes, registros hechos por bot, herramientas) viven en Supabase esquema 'andina': usa supabase.from("tabla") SIN prefijo de esquema.
6. AppSheet es SOLO LECTURA desde tus herramientas. Si el usuario quiere REGISTRAR un avance de spool, dile que te lo pida directamente ("registra el montaje del spool X") — ese flujo existe aparte.
7. Las fechas en AppSheet se almacenan y devuelven en formato DD/MM/YYYY HH:mm:ss (Locale es-ES). Es decir, el PRIMER campo es el DÍA y el SEGUNDO es el MES (ej: "09/07/2026" = 9 de julio de 2026, NO septiembre 7). Al programar herramientas dinámicas que comparen o ordenen fechas, parsea SIEMPRE como DD/MM/YYYY: new Date(+parts[2], +parts[1]-1, +parts[0]). Al responderle al usuario, las fechas ya están en formato DD/MM/AAAA — preséntalas tal cual. El flujo de estados de un spool es: En Fabricación → QAQC → En Pint/Revest. → Retirar → Por Montar → Posicionado → Montado. El estado ACTUAL de un spool es el registro más reciente (o más avanzado) de LOG_Spool_MS para su ID_SPOOL.
8. En LOG_Spool_MS el identificador corto que usa la gente ("511", "270") es TAG_SPOOL; el largo es ID_SPOOL. En LIST_Spools_MS_ el corto es "TAG GESTION".
9. FOTOS: muchas tablas tienen columnas de imagen (FOTO, FotoTerreno, ...) cuyos valores son rutas internas tipo "Archivos/Imagenes/....jpg". El sistema SÍ envía esas imágenes REALES al chat de WhatsApp. Para mostrar una foto, incluye en tu respuesta UNA LÍNEA con el marcador exacto:
   [[FOTO|NombreTablaAppSheet|ruta]]
   (ej: [[FOTO|REG_InspeccionVisual_MS|Archivos/Imagenes/InspeccionVisual/004e96b3.FOTO.200337.jpg]])
   Máximo 4 fotos por respuesta. PROHIBIDO pegar la ruta cruda como texto, PROHIBIDO inventar URLs http (esas rutas NO son enlaces web), y PROHIBIDO decir que "no puedes mostrar imágenes" — el sistema las adjunta automáticamente por ti cuando usas el marcador.
10. USUARIOS Y PINS: Cada usuario en Supabase ('bot_usuarios') posee un PIN personal único de 4 dígitos en la columna 'pin'. Al crear un nuevo usuario con supabase.from("bot_usuarios").upsert({ ... }), SIEMPRE debes generar o incluir un PIN único de 4 dígitos (ej: String(Math.floor(1000 + Math.random() * 9000))) e informárselo de forma destacada al usuario/admin en tu respuesta. Si te consultan por el PIN de un supervisor o usuario, consulta la tabla 'bot_usuarios' de Supabase y entrega los PINs registrados de forma clara.

DIRECTRICES AL PROGRAMAR codigo_javascript:
- Desestructura los parámetros desde 'args' en la primera línea.
- AppSheet: const filas = await appsheet.find("LOG_Spool_MS"); luego filtra con .filter()/.reduce().
- Supabase: const { data, error } = await supabase.from("bot_usuarios").select("*"); if (error) throw error;
- Comparaciones de texto: case-insensitive con .toLowerCase().includes(...) en AppSheet, .ilike() en Supabase.
- Retorna SIEMPRE el resultado (array o valor). Máximo ~50 filas: si hay más, retorna un resumen o slice.
- Ejemplo:
  const { status } = args;
  const filas = await appsheet.find("LOG_Spool_MS");
  const filtradas = filas.filter(f => String(f.STATUS || "").toLowerCase().includes(String(status).toLowerCase()));
  return { total: filtradas.length, muestra: filtradas.slice(0, 20).map(f => ({ tag: f.TAG_SPOOL, fecha: f.FECHA_LEVANTAMIENTO, usuario: f.USUARIO })) };

MAPA DEL MUNDO (tablas AppSheet del proyecto, con tipos inferidos de datos reales, y esquema Supabase 'andina'):
${JSON.stringify(mapa, null, 1)}`;

    let contents = [
        ...historial,
        { role: 'user', parts: [{ text: texto }] }
    ];
    let respuestaFinal = '';

    for (let i = 1; i <= MAX_ITERACIONES; i++) {
        const res = await fetch(
            `${GEMINI_BASE}/${CONFIG.GEMINI_MODEL}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    contents,
                    tools
                })
            }
        );
        if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).substring(0, 200)}`);

        const data = await res.json();
        const candidate = data.candidates?.[0];
        const parts = candidate?.content?.parts || [];

        const textParts = parts.filter(p => p.text);
        if (textParts.length) respuestaFinal = textParts.map(p => p.text).join('\n');

        const calls = parts.filter(p => p.functionCall);
        if (!calls.length) break; // respuesta final sin más herramientas

        console.log(`[botTools] Iteración ${i}: Gemini pide ${calls.length} función(es)`);
        const functionResponses = [];

        for (const call of calls) {
            const { name, args } = call.functionCall;
            let resultado;
            try {
                if (name === 'crear_herramienta_dinamica') {
                    console.log(`[botTools] 🛠️ Nueva herramienta: ${args.nombre_funcion}`);
                    resultado = await registrarTool(args, usuario.nombre);
                    dbTools = await cargarTools();           // refrescar catálogo
                    tools = declaraciones(dbTools);          // disponible en la próxima iteración
                } else {
                    const tool = dbTools.find(t => t.nombre_funcion === name);
                    if (!tool) {
                        resultado = `Error: la herramienta "${name}" no está registrada.`;
                    } else {
                        console.log(`[botTools] ⚡ Ejecutando: ${name}`, JSON.stringify(args || {}));
                        const out = await ejecutarTool(tool, args, usuario);
                        resultado = JSON.stringify(out);
                        if (resultado && resultado.length > 30000) {
                            resultado = resultado.substring(0, 30000) + '... [truncado, pide un resumen]';
                        }
                    }
                }
            } catch (e) {
                resultado = `Error de ejecución: ${e.message}`;
            }
            functionResponses.push({
                functionResponse: { name, response: { result: resultado } }
            });
        }

        contents.push(candidate.content);
        contents.push({ role: 'function', parts: functionResponses });
    }

    return respuestaFinal || 'No logré resolver la consulta, ¿puedes reformularla?';
}

module.exports = { consultaAvanzada, cargarTools };
