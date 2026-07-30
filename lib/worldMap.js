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
    bot_usuarios: { id: 'UUID', telefono: 'TEXT UNIQUE (solo dígitos)', nombre: 'TEXT', rol: 'Terreno | Supervisor | Admin', pin: 'TEXT 4 dígitos (ej: 1024, 8899)', activo: 'BOOLEAN', created_at: 'TIMESTAMPTZ' },
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
 * Calcula la agregación y el mapa indexado de todos los estados actuales de spools.
 */
async function calcularResumenEstadosSpools() {
    try {
        const [spools, logs] = await Promise.all([
            fetchAppSheetCached('LIST_Spools_MS_').catch(() => []),
            fetchAppSheetCached('LOG_Spool_MS').catch(() => [])
        ]);

        const parseDDMM = s => {
            const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
            return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : 0;
        };

        // Mapa de último estado por ID_SPOOL o TAG GESTIÓN
        const estadoPorSpool = {};
        logs.forEach(row => {
            const spoolId = String(row['ID_SPOOL'] || '').trim();
            const tag = String(row['TAG_SPOOL'] || '').trim();
            const fechaTs = parseDDMM(row['FECHA_LEVANTAMIENTO']);
            const status = String(row['STATUS'] || 'SIN REGISTRO').trim().toUpperCase();

            const key = tag || spoolId;
            if (key && (!estadoPorSpool[key] || fechaTs >= estadoPorSpool[key].fechaTs)) {
                estadoPorSpool[key] = { status, fechaTs, fecha: row['FECHA_LEVANTAMIENTO'] || '', usuario: row['USUARIO'] || '' };
            }
        });

        // Totales por estado
        const totalesPorEstado = {};
        spools.forEach(s => {
            const tag = String(s['TAG GESTION'] || s['SPOOL'] || s['ID_SPOOL'] || '').trim();
            const info = estadoPorSpool[tag] || estadoPorSpool[s['ID_SPOOL']];
            const st = info ? info.status : 'EN FABRICACIÓN';
            totalesPorEstado[st] = (totalesPorEstado[st] || 0) + 1;
        });

        return {
            total_spools_registrados: spools.length,
            total_eventos_terreno: logs.length,
            conteo_spools_por_estado: totalesPorEstado,
            mapa_estados_spool_recientes: estadoPorSpool,
            actualizado_at: new Date().toISOString()
        };
    } catch (e) {
        return { error: `Error calculando resumen de spools: ${e.message}` };
    }
}

/**
 * Calcula el índice y mapeo de URLs PDF públicas para Isométricos y P&IDs.
 */
async function calcularResumenPlanosPdf() {
    try {
        const { CONFIG } = require('../config');
        const appName = CONFIG.APPSHEET_APP_ID || 'LukeAPP_Andina-526211656';
        const [isos, pids] = await Promise.all([
            fetchAppSheetCached('LOG_Iso_MS').catch(() => []),
            fetchAppSheetCached('LIST_PID_MS').catch(() => [])
        ]);

        const mapaIsometricos = {};
        isos.forEach(row => {
            const isoId = String(row['ID_ISO'] || '').trim();
            const fileName = String(row['ARCHIVO_PDF_REVISION'] || '').trim();
            if (isoId && fileName) {
                const pdfUrl = fileName.startsWith('http') ? fileName :
                    `https://www.appsheet.com/template/gettablefileurl?appName=${appName}&tableName=LOG_Iso_MS&fileName=${encodeURIComponent(fileName)}`;
                mapaIsometricos[isoId] = {
                    id_iso: isoId,
                    revision: row['REVISION_NRO'] || '0',
                    pdf_url: pdfUrl
                };
            }
        });

        const mapaPids = {};
        pids.forEach(row => {
            const pidId = String(row['ID_PID'] || '').trim();
            const rawFile = String(row['ARCHIVO_PDF_VIGENTE'] || '').trim();
            if (pidId && rawFile) {
                const cleanFile = rawFile.replace(/^.*::/, '');
                const pdfUrl = cleanFile.startsWith('http') ? cleanFile :
                    `https://www.appsheet.com/template/gettablefileurl?appName=${appName}&tableName=LOG_PID_MS&fileName=${encodeURIComponent(cleanFile)}`;
                mapaPids[pidId] = {
                    id_pid: pidId,
                    descripcion: row['DESCRIPCION'] || '',
                    pdf_url: pdfUrl
                };
            }
        });

        return {
            total_isometricos_pdf: Object.keys(mapaIsometricos).length,
            total_pids_pdf: Object.keys(mapaPids).length,
            mapa_isometricos_pdf: mapaIsometricos,
            mapa_pids_pdf: mapaPids,
            actualizado_at: new Date().toISOString()
        };
    } catch (e) {
        return { error: `Error calculando mapas de PDF: ${e.message}` };
    }
}

/**
 * Genera (con caché) el mapa del mundo completo:
 * columnas + tipo inferido + total de filas de cada tabla AppSheet,
 * el esquema Supabase 'andina', el resumen de estados de spools y el índice de URLs de planos PDF.
 */
async function generarMapaDelMundo(forzar = false) {
    const now = Date.now();
    if (!forzar && cacheMapa && (now - cacheTs < CACHE_TTL)) return cacheMapa;

    const botConf = await getBotConfig().catch(() => ({}));
    const tablas = (botConf.tablas_mapa_mundo || TABLAS_APPSHEET_DEFAULT.join(','))
        .split(',').map(s => s.trim()).filter(Boolean);

    const appsheet = {};
    const resultados = await Promise.allSettled(tablas.map(async (tabla) => {
        const rows = await fetchAppSheetCached(tabla);
        const muestra = rows.slice(0, 50);
        const columnas = {};
        const nombresCol = new Set();
        muestra.forEach(r => Object.keys(r).forEach(k => nombresCol.add(k)));
        nombresCol.delete('_RowNumber');
        for (const col of nombresCol) {
            columnas[col] = inferirTipo(muestra.map(r => r[col]));
        }
        return { tabla, info: { total_filas: rows.length, columnas } };
    }));

    resultados.forEach((res, i) => {
        const tabla = tablas[i];
        if (res.status === 'fulfilled') {
            appsheet[tabla] = res.value.info;
        } else {
            appsheet[tabla] = { error: `No accesible: ${res.reason?.message || 'Error de red'}` };
        }
    });

    const [resumenSpools, resumenPlanos] = await Promise.all([
        calcularResumenEstadosSpools(),
        calcularResumenPlanosPdf()
    ]);

    cacheMapa = {
        appsheet,
        supabase_andina: MAPA_SUPABASE,
        resumen_estados_spools_actuales: resumenSpools,
        resumen_planos_pdf: resumenPlanos,
        generado: new Date().toISOString()
    };
    cacheTs = now;
    return cacheMapa;
}

module.exports = { generarMapaDelMundo, calcularResumenEstadosSpools, calcularResumenPlanosPdf, TABLAS_APPSHEET_DEFAULT };
