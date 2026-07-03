/**
 * "Mapa del Mundo" del bot Andina.
 * Describe cada tabla y columna que el bot conoce, para que Gemini pueda
 * auto-escribir herramientas de consulta (patrón aprendido de LukeMaquinarias).
 *
 * Diferencia clave vs maquinaria: aquí el mapa NO está hardcodeado.
 * Se genera muestreando las tablas reales de AppSheet, así que si el
 * proyecto crece (columnas o datos nuevos), el mapa se alimenta solo.
 */
const { fetchAppSheetCached } = require('./appsheet');
const { getBotConfig } = require('./botConfig');

// Tablas AppSheet del proyecto (se puede sobreescribir con la clave
// runtime 'tablas_mapa_mundo' desde el panel, separadas por coma).
const TABLAS_APPSHEET_DEFAULT = [
    'LIST_Lineas_MS_', 'LIST_Isos_MS_', 'LIST_Spools_MS_', 'LIST_Juntas_MS_',
    'REG_EjecucionJuntas_MS', 'LOG_Spool_MS', 'LOG_SDI_MS', 'REL_SDIIso_MS',
    'REG_InspeccionVisual_MS', 'REG_DimensionalSpool_MS',
    'CAT_TipoUnion_MS', 'CAT_FluidoServicio_MS', 'CAT_Personal_MS',
    'LOG_Guia_MS', 'LIST_Bim_MS',
    'LIST_Valvulas_MS', 'LIST_Soportes_MS',
    'REG_MontajeValvulas_MS', 'REG_MontajeSoportes_MS'
];

// Esquema Supabase 'andina' (propio del bot, estático y conocido)
const MAPA_SUPABASE = {
    bot_usuarios: { id: 'UUID', telefono: 'TEXT UNIQUE (solo dígitos)', nombre: 'TEXT', rol: 'Terreno | Supervisor | Admin', activo: 'BOOLEAN', created_at: 'TIMESTAMPTZ' },
    bot_mensajes: { id: 'UUID', telefono: 'TEXT', emisor: "'usuario' | 'bot'", tipo: 'texto | audio | imagen | ubicacion', mensaje: 'TEXT', metadata: 'JSONB', created_at: 'TIMESTAMPTZ' },
    bot_registros: { id: 'UUID', telefono: 'TEXT', spool_tag: 'TEXT', id_spool: 'TEXT', status: 'TEXT', observacion: 'TEXT', mts_montados: 'NUMERIC', appsheet_ok: 'BOOLEAN', metadata: 'JSONB', created_at: 'TIMESTAMPTZ' },
    bot_config: { clave: 'TEXT PK', valor: 'TEXT', descripcion: 'TEXT', updated_at: 'TIMESTAMPTZ' },
    bot_tools_dinamicas: { id: 'UUID', nombre_funcion: 'TEXT UNIQUE', descripcion: 'TEXT', codigo_javascript: 'TEXT', esquema_json: 'JSONB', usos: 'INTEGER', created_at: 'TIMESTAMPTZ' }
};

let cacheMapa = null;
let cacheTs = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

/** Infere un tipo legible a partir de valores de muestra. */
function inferirTipo(valores) {
    const noVacios = valores.filter(v => v !== '' && v !== null && v !== undefined).map(String);
    if (!noVacios.length) return 'TEXT (usualmente vacío)';
    const muestra = noVacios.slice(0, 30);
    if (muestra.every(v => /^-?\d+([.,]\d+)?$/.test(v.trim()))) return 'NUMBER';
    if (muestra.every(v => /^\d{2}\/\d{2}\/\d{4}/.test(v.trim()))) return 'DATETIME (MM/DD/YYYY HH:mm:ss)';
    // Enum: pocos valores distintos y cortos → listarlos ayuda mucho a Gemini
    const distintos = [...new Set(noVacios.map(v => v.trim()))];
    if (distintos.length <= 8 && distintos.every(v => v.length <= 30)) {
        return `ENUM: ${distintos.join(' | ')}`;
    }
    return 'TEXT';
}

/**
 * Genera (con caché) el mapa del mundo completo:
 * columnas + tipo inferido + total de filas de cada tabla AppSheet,
 * más el esquema Supabase 'andina'.
 */
async function generarMapaDelMundo(forzar = false) {
    const now = Date.now();
    if (!forzar && cacheMapa && (now - cacheTs < CACHE_TTL)) return cacheMapa;

    const botConf = await getBotConfig().catch(() => ({}));
    const tablas = (botConf.tablas_mapa_mundo || TABLAS_APPSHEET_DEFAULT.join(','))
        .split(',').map(s => s.trim()).filter(Boolean);

    const appsheet = {};
    for (const tabla of tablas) {
        try {
            const rows = await fetchAppSheetCached(tabla);
            const muestra = rows.slice(0, 50);
            const columnas = {};
            const nombresCol = new Set();
            muestra.forEach(r => Object.keys(r).forEach(k => nombresCol.add(k)));
            nombresCol.delete('_RowNumber');
            for (const col of nombresCol) {
                columnas[col] = inferirTipo(muestra.map(r => r[col]));
            }
            appsheet[tabla] = { total_filas: rows.length, columnas };
        } catch (e) {
            appsheet[tabla] = { error: `No accesible: ${e.message}` };
        }
    }

    cacheMapa = { appsheet, supabase_andina: MAPA_SUPABASE, generado: new Date().toISOString() };
    cacheTs = now;
    return cacheMapa;
}

module.exports = { generarMapaDelMundo, TABLAS_APPSHEET_DEFAULT };
