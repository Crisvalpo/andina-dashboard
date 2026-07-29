const express = require('express');
const path = require('path');
const fs = require('fs');
const { CONFIG, resumenSeguro } = require('./config');
const { fetchAppSheet, fetchAppSheetCached, invalidarCache } = require('./lib/appsheet');
const { crearToken, permisosDeClave, requerirPermiso, TTL_HORAS, requerirSesion } = require('./lib/auth');
const { getSupabase, asegurarBucketExistente } = require('./lib/supabase');
const app = express();
const PORT = CONFIG.PORT;

app.use(express.static(__dirname));
app.use(express.json({ limit: '50mb' })); // JSON en POST (audios del bot vienen en base64)

// Caché en memoria para optimizar peticiones y consumo de cuota
const cache = {};
const CACHE_TTL = 30 * 1000; // 30 segundos

// Refrescos en vuelo (evita disparar la misma tabla dos veces en paralelo)
const refrescosEnVuelo = new Set();
async function refrescarTabla(tableName) {
    if (refrescosEnVuelo.has(tableName)) return;
    refrescosEnVuelo.add(tableName);
    try {
        const data = await fetchAppSheet(tableName);
        cache[tableName] = { timestamp: Date.now(), data };
    } catch (e) {
        console.error(`[Cache Refresh] ${tableName}:`, e.message);
    } finally {
        refrescosEnVuelo.delete(tableName);
    }
}

// Endpoint proxy genérico para las tablas de AppSheet.
// STALE-WHILE-REVALIDATE: si hay caché (aunque esté vencida) se sirve AL
// INSTANTE y se refresca en segundo plano — el dashboard nunca espera a
// AppSheet salvo la primerísima carga tras el arranque (cubierta por warmup).
app.get('/api/data/:tableName', async (req, res) => {
    const { tableName } = req.params;
    const entry = cache[tableName];

    if (entry) {
        const fresca = (Date.now() - entry.timestamp) < CACHE_TTL;
        res.set('X-Cache', fresca ? 'hit' : 'stale');
        if (!fresca) refrescarTabla(tableName); // background, sin esperar
        return res.json(entry.data);
    }

    try {
        console.log(`[Cache Miss] Consultando ${tableName} directamente a AppSheet`);
        await refrescarTabla(tableName);
        if (cache[tableName]) {
            res.set('X-Cache', 'miss');
            return res.json(cache[tableName].data);
        }
        throw new Error('Sin datos');
    } catch (error) {
        console.error(`[Error Proxy] ${tableName}:`, error.message);
        res.status(500).json({ error: error.message });
    }
});

// Precalentamiento: al arrancar el server se cargan las tablas del dashboard
// para que la primera visita ya encuentre caché caliente.
const TABLAS_WARMUP = [
    'LIST_Lineas_MS_', 'LIST_Isos_MS_', 'LIST_Spools_MS_', 'LIST_Juntas_MS_',
    'REG_EjecucionJuntas_MS', 'LOG_Spool_MS', 'LOG_SDI_MS', 'REL_SDIIso_MS',
    'REG_InspeccionVisual_MS', 'REG_DimensionalSpool_MS',
    'CAT_TipoUnion_MS', 'CAT_FluidoServicio_MS', 'CAT_Personal_MS',
    'REL_PIDLineas_MS', 'LIST_PID_MS'
];
async function precalentarCache() {
    console.log(`[Warmup] Precargando ${TABLAS_WARMUP.length} tablas del dashboard...`);
    // Asegurar que el bucket en Supabase Storage exista
    await asegurarBucketExistente();
    const t0 = Date.now();
    await Promise.allSettled(TABLAS_WARMUP.map(t => refrescarTabla(t)));
    console.log(`[Warmup] Caché caliente en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// API Proxy para datos de la Guía
app.get('/api/guias', async (req, res) => {
    try {
        const guias = await fetchAppSheet('LOG_Guia_MS');
        res.json(guias);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/guia/:id', async (req, res) => {
    const guiaId = req.params.id;
    try {
        // 1. Obtener datos de la guía (Cabecera)
        const guias = await fetchAppSheet('LOG_Guia_MS');
        const guia = guias.find(g => String(g.ID_GUIA) === guiaId || String(g.NUM_GUIA) === guiaId);

        if (!guia) return res.status(404).json({ error: "Guía no encontrada" });

        // 2. Obtener spools vinculados (de la tabla logística REAL)
        const eventos = await fetchAppSheet('LOG_Spool_MS');
        const spoolsEnGuia = eventos.filter(e => String(e.ID_GUIA) === String(guia.ID_GUIA));

        // 3. Obtener detalles técnicos de los spools (NPS, Peso)
        const maestroSpools = await fetchAppSheet('LIST_Spools_MS_');

        const spoolsDetallados = spoolsEnGuia.map(e => {
            const master = maestroSpools.find(m => m.ID_SPOOL === e.ID_SPOOL) || {};
            return {
                ...e,
                TAG_SPOOL: master.SPOOL || master['TAG GESTION'] || e.TAG_SPOOL,
                MAX_NPS_SPOOL: master.NPS || master.MAX_NPS_SPOOL,
                METROS_LINEALES: master.METROS_LINEALES || 0,
                ID_ISO: master.ID_ISO || e.ID_ISO,
                ID_LINEA: master.ID_LINEA
            };
        });

        res.json({ guia, spools: spoolsDetallados });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// =================================================================
// APS (AUTODESK PLATFORM SERVICES) — BIM VIEWER
// Credenciales SOLO en servidor, nunca expuestas al frontend.
// =================================================================
const APS_CONFIG = {
    clientId:     CONFIG.APS_CLIENT_ID,
    clientSecret: CONFIG.APS_CLIENT_SECRET,
    modelUrn:     CONFIG.APS_MODEL_URN
};


// Caché del token APS (se renueva antes de expirar)
let apsTokenCache = { token: null, expiresAt: 0 };

async function getApsToken() {
    const now = Date.now();
    // Reutilizar si le quedan más de 5 minutos de vida
    if (apsTokenCache.token && apsTokenCache.expiresAt - now > 5 * 60 * 1000) {
        return apsTokenCache.token;
    }
    const credentials = Buffer.from(`${APS_CONFIG.clientId}:${APS_CONFIG.clientSecret}`).toString('base64');
    const resp = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials&scope=viewables%3Aread'
    });
    if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`APS Auth Error ${resp.status}: ${err}`);
    }
    const data = await resp.json();
    apsTokenCache = {
        token: data.access_token,
        expiresAt: now + (data.expires_in * 1000)
    };
    console.log(`[APS] Token renovado. Expira en ${data.expires_in}s`);
    return apsTokenCache.token;
}

// GET /api/bim/token → Token temporal para el Viewer SDK (solo lectura)
app.get('/api/bim/token', async (req, res) => {
    try {
        const token = await getApsToken();
        // Solo enviamos el token y el URN (no las credenciales)
        res.json({
            access_token: token,
            model_urn: APS_CONFIG.modelUrn
        });
    } catch (e) {
        console.error('[APS Token Error]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/bim/debug → Diagnóstico: muestra columnas reales de LIST_Bim_MS
// Útil para verificar cómo AppSheet serializa nombres de columna con caracteres especiales
app.get('/api/bim/debug', async (req, res) => {
    try {
        const rawBim = await fetchAppSheet('LIST_Bim_MS');
        const sample = rawBim.slice(0, 3);
        const columnNames = rawBim.length > 0 ? Object.keys(rawBim[0]) : [];
        res.json({
            total_rows:   rawBim.length,
            column_names: columnNames,
            sample_rows:  sample
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// GET /api/bim/debug → Diagnóstico: columnas reales de LIST_Bim_MS
// Columnas confirmadas: "Elemento GUID", "SPOOL LUKEAPP", "CWP", "DESCRIPCIÓN",
//                       "Fastener1_NUMERO_LINEA", "Line Number", "TAG", "AutoCad Size"
app.get('/api/bim/debug', async (req, res) => {
    try {
        const rows = await fetchAppSheet('LIST_Bim_MS');
        const withSpool   = rows.filter(r => String(r['SPOOL LUKEAPP'] || '').trim() !== '').length;
        const withoutSpool = rows.length - withSpool;
        const spoolValues  = [...new Set(
            rows.map(r => String(r['SPOOL LUKEAPP'] || '').trim()).filter(Boolean)
        )].sort((a,b) => Number(a) - Number(b)).slice(0, 30);
        res.json({
            total_rows:          rows.length,
            column_names:        rows.length > 0 ? Object.keys(rows[0]) : [],
            with_spool_lukeapp:  withSpool,
            without_spool:       withoutSpool,
            sample_spool_values: spoolValues,
            sample_rows:         rows.slice(0, 3)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// "SPOOL LUKEAPP" en LIST_Bim_MS = TAG GESTION de LIST_Spools_MS_
// El QR puede traer el TAG GESTION (numérico corto) o el ID_SPOOL completo.
// Parsea FECHA_LEVANTAMIENTO detectando dinámicamente si el formato es MM/DD/YYYY o DD/MM/YYYY.
// La API de AppSheet suele retornar MM/DD/YYYY, pero puede haber inconsistencias de formato.
function parseFechaLog(str) {
    const m = String(str || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return 0;
    const [, p1, p2, yyyy, hh, mi, ss] = m;
    let mm, dd;

    if (+p1 > 12) {
        // Primer valor > 12 -> obligatoriamente DD/MM/YYYY
        dd = +p1;
        mm = +p2;
    } else if (+p2 > 12) {
        // Segundo valor > 12 -> obligatoriamente MM/DD/YYYY
        mm = +p1;
        dd = +p2;
    } else {
        // Ambos <= 12 (ambigüedad). La API de AppSheet típicamente entrega MM/DD/YYYY.
        mm = +p1;
        dd = +p2;
    }

    return new Date(+yyyy, mm - 1, dd, +(hh || 0), +(mi || 0), +(ss || 0)).getTime();
}

// El estado se toma tal cual lo escribe terreno en LOG_Spool_MS; solo se
// homogeneiza la caja. LOG es la única autoridad: plegar variantes aquí
// escondía estados que el usuario sí quiere distinguir (p.ej. "En Pintura").
function normalizarEstadoSpool(st) {
    if (!st) return 'SIN ESTADO';
    return String(st).trim().toUpperCase();
}

/**
 * Estado ACTUAL de cada spool desde LOG_Spool_MS = ÚLTIMO registro con estado,
 * por FECHA_LEVANTAMIENTO (desempate: orden de inserción _RowNumber).
 * Ignora registros con STATUS vacío. Devuelve { ID_SPOOL: {status, raw, fecha} }.
 */
function estadosActualesDeLog(logs) {
    const out = {};
    logs.forEach(r => {
        const id = String(r.ID_SPOOL || r['ID_SPOOL '] || '').trim();
        const st = String(r.STATUS || r['STATUS '] || '').trim();
        if (!id || !st) return;
        const fecha = parseFechaLog(r['FECHA_LEVANTAMIENTO']);
        const row = parseInt(r._RowNumber || '0', 10) || 0;
        const prev = out[id];
        if (!prev || fecha > prev.fecha || (fecha === prev.fecha && row > prev.row)) {
            out[id] = { status: normalizarEstadoSpool(st), raw: st, fecha, row };
        }
    });
    return out;
}

app.get('/api/bim/spool/:spoolId', async (req, res) => {
    const spoolId = decodeURIComponent(req.params.spoolId).trim();

    try {
        // ----------------------------------------------------------------
        // 1. Obtener la metadata del spool primero desde LIST_Spools_MS_
        //    Esto nos permite mapear ID_SPOOL (largo) -> TAG GESTION (corto)
        // ----------------------------------------------------------------
        let spoolMeta = null;
        let tagGestion = spoolId; // Valor por defecto en caso de no encontrarse coincidencia

        try {
            const spools = await fetchAppSheet('LIST_Spools_MS_');
            spoolMeta = spools.find(s => {
                const idSpool = String(s['ID_SPOOL'] || '').trim();
                const tagG    = String(s['TAG GESTION'] || '').trim();
                return idSpool === spoolId || tagG === spoolId || idSpool.toLowerCase() === spoolId.toLowerCase();
            });

            if (spoolMeta) {
                tagGestion = String(spoolMeta['TAG GESTION'] || '').trim();
                console.log(`[BIM] Resolucion: "${spoolId}" mapeado a TAG GESTION: "${tagGestion}" | ID_SPOOL: "${spoolMeta['ID_SPOOL']}"`);
            } else {
                console.log(`[BIM] No se hallo metadata en LIST_Spools_MS_ para "${spoolId}". Se buscara directamente en BIM por este valor.`);
            }
        } catch (e) {
            console.warn('[BIM] No se pudo obtener metadata de LIST_Spools_MS_:', e.message);
        }

        // ----------------------------------------------------------------
        // 2. Obtener elementos BIM desde AppSheet (LIST_Bim_MS)
        //    Columnas: "Elemento GUID", "SPOOL LUKEAPP", "CWP",
        //              "DESCRIPCIÓN", "Line Number", "TAG", "AutoCad Size"
        // ----------------------------------------------------------------
        let bimRows = [];
        try {
            bimRows = await fetchAppSheet('LIST_Bim_MS');
            const withSpool = bimRows.filter(r => String(r['SPOOL LUKEAPP'] || '').trim() !== '').length;
            console.log(`[BIM] LIST_Bim_MS: ${bimRows.length} filas totales, ${withSpool} con SPOOL LUKEAPP`);
        } catch (e) {
            console.warn('[BIM] Error consultando LIST_Bim_MS en AppSheet:', e.message);
            // Fallback: bim-data.json
            const bimDataPath = path.join(__dirname, 'bim-data.json');
            if (fs.existsSync(bimDataPath)) {
                const local = JSON.parse(fs.readFileSync(bimDataPath, 'utf8'));
                bimRows = local.map(el => ({
                    'Elemento GUID':  el.guid,
                    'SPOOL LUKEAPP':  el.spool_lukeapp,
                    'CWP':            el.cwp,
                    'DESCRIPCIÓN':    el.descripcion,
                    'Line Number':    el.numero_linea,
                    'TAG':            el.tag,
                    'AutoCad Size':   el.autocad_size
                }));
            }
        }

        // ----------------------------------------------------------------
        // 3. Filtrar elementos que corresponden al spool buscado
        //    "SPOOL LUKEAPP" de LIST_Bim_MS corresponde a "TAG GESTION"
        // ----------------------------------------------------------------
        const elements = bimRows.filter(row => {
            const spoolVal = String(row['SPOOL LUKEAPP'] || '').trim();
            return spoolVal === tagGestion || 
                   spoolVal === spoolId || 
                   spoolVal.toLowerCase() === tagGestion.toLowerCase() ||
                   spoolVal.toLowerCase() === spoolId.toLowerCase();
        });

        console.log(`[BIM] Spool "${spoolId}" (Tag: "${tagGestion}"): ${elements.length} elementos encontrados en LIST_Bim_MS`);

        // ----------------------------------------------------------------
        // 4. Mapear a estructura normalizada para el frontend
        // ----------------------------------------------------------------
        const normalizedElements = elements.map(row => ({
            guid:         String(row['Elemento GUID'] || '').trim(),
            spool:        String(row['SPOOL LUKEAPP']  || '').trim(),
            cwp:          String(row['CWP']            || '').trim(),
            descripcion:  String(row['DESCRIPCIÓN']    || row['DESCRIPCION'] || '').trim(),
            numero_linea: String(row['Line Number']    || '').trim(),
            tag:          String(row['TAG']            || '').trim(),
            autocad_size: String(row['AutoCad Size']   || '').trim()
        }));

        // Estado ACTUAL desde LOG_Spool_MS (último registro por fecha), no del maestro
        let estadoActual = null, estadoFecha = null;
        try {
            const idSpoolLargo = spoolMeta ? String(spoolMeta['ID_SPOOL'] || '').trim() : spoolId;
            const logs = await fetchAppSheetCached('LOG_Spool_MS');
            const est = estadosActualesDeLog(logs)[idSpoolLargo];
            if (est) { estadoActual = est.status; estadoFecha = est.fecha ? new Date(est.fecha).toISOString() : null; }
        } catch (e) { /* sin log, sin estado */ }

        res.json({
            spool_id:  spoolId,
            guids:     normalizedElements.map(el => el.guid).filter(Boolean),
            elements:  normalizedElements,
            metadata:  spoolMeta || null,
            estado_actual: estadoActual,   // ← fuente de verdad del estado
            estado_fecha:  estadoFecha
        });

    } catch (e) {
        console.error('[BIM Spool Error]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/bim/statuses → Devuelve un mapeo de { [status]: [guid1, guid2, ...] }
// Usa caché 30s para proteger la cuota (el modo EN VIVO sondea cada 10s).
// Los registros vía bot invalidan la caché → visibles en el siguiente tick.
app.get('/api/bim/statuses', async (req, res) => {
    try {
        // 1. Obtener todas las tablas necesarias
        const [rawBim, spools, logs] = await Promise.all([
            fetchAppSheetCached('LIST_Bim_MS'),
            fetchAppSheetCached('LIST_Spools_MS_'),
            fetchAppSheetCached('LOG_Spool_MS')
        ]);

        // Normalizar columnas de LIST_Bim_MS
        const bimRows = rawBim.map(row => {
            const norm = {};
            for (const [k, v] of Object.entries(row)) {
                norm[k.replace(/[\r\n]+/g, ' ').trim()] = v;
            }
            return norm;
        });

        // 2. Mapear TAG GESTION (SPOOL LUKEAPP) -> ID_SPOOL
        // Clave en minúsculas: los tags llegan con diferencias de caso/espacios
        // desde LIST_Bim_MS y el match exacto mandaba spools CON estado a SIN ESTADO.
        const tagToIdSpool = {};
        spools.forEach(s => {
            const idSpool = String(s['ID_SPOOL'] || '').trim();
            const tagG    = String(s['TAG GESTION'] || '').trim();
            if (tagG && idSpool) {
                tagToIdSpool[tagG.toLowerCase()] = idSpool;
            }
        });

        // 3. Resolver el status más avanzado de cada ID_SPOOL
        const STATUS_WEIGHT = {
            'EN FABRICACIÓN': 1, 'EN FABRICACION': 1,
            'QAQC': 2,
            'EN PINT/REVEST.': 3, 'EN PINT': 3,
            'RETIRAR': 4,
            'POR MONTAR': 5,
            'POSICIONADO': 6,
            'MONTADO': 7,
            'ELIMINADO': 8
        };

        function getStatusWeight(status) {
            if (!status) return 0;
            const s = status.toUpperCase().trim();
            if (STATUS_WEIGHT[s] !== undefined) return STATUS_WEIGHT[s];
            for (const [key, w] of Object.entries(STATUS_WEIGHT)) {
                if (s.includes(key)) return w;
            }
            return 0;
        }

        function normalizeStatus(st) {
            if (!st) return 'SIN ESTADO';
            return String(st).trim().toUpperCase();
        }

        // Estado ACTUAL de cada spool = ÚLTIMO registro de LOG_Spool_MS por fecha
        // (desempate por orden de inserción). Ignora registros con STATUS vacío.
        // Mismo criterio que la ficha y el bot: una única fuente de verdad.
        const spoolStatuses = estadosActualesDeLog(logs);

        // Índice case-insensitive del log (algunas filas registran el ID con
        // otro caso, y otras usan directamente el TAG corto)
        const statusLower = {};
        for (const [k, v] of Object.entries(spoolStatuses)) statusLower[k.toLowerCase()] = v;

        // 4. Agrupar GUIDs de LIST_Bim_MS por el status resuelto
        const result = {
            'EN FABRICACIÓN': [],
            'QAQC': [],
            'EN PINT/REVEST.': [],
            'RETIRAR': [],
            'POR MONTAR': [],
            'POSICIONADO': [],
            'MONTADO': [],
            'ELIMINADO': [],
            'SIN ESTADO': []
        };

        // JERARQUÍA por GUID: el mismo GUID puede venir en VARIAS filas de
        // LIST_Bim_MS (duplicados / doble vinculación). Antes caía en más de un
        // grupo a la vez y SIN ESTADO terminaba pintando encima de estados
        // reales. Ahora cada GUID queda en UN solo grupo: gana el estado más
        // avanzado, y SIN ESTADO solo si NINGUNA fila le da estado.
        const porGuid = {}; // guidLower -> { guid, status, peso }
        bimRows.forEach(row => {
            const guid = String(row['Elemento GUID'] || '').trim();
            if (!guid) return;

            const tagG = String(row['SPOOL LUKEAPP'] || '').trim();
            const idSpool = tagToIdSpool[tagG.toLowerCase()] || tagG; // fallback al tag si no se mapea
            // Estado por ID largo o, si el log registró el tag corto, por el tag
            const statusEntry = statusLower[idSpool.toLowerCase()] || statusLower[tagG.toLowerCase()];
            const status = statusEntry ? statusEntry.status : 'SIN ESTADO';
            // Peso: estados conocidos según flujo; estados custom pesan 1 (siempre > SIN ESTADO = 0)
            const peso = statusEntry ? Math.max(getStatusWeight(status), 1) : 0;

            const key = guid.toLowerCase();
            const prev = porGuid[key];
            if (!prev || peso > prev.peso) porGuid[key] = { guid, status, peso };
        });

        Object.values(porGuid).forEach(({ guid, status }) => {
            if (!result[status]) {
                result[status] = [];
            }
            result[status].push(guid);
        });

        res.json(result);
    } catch (e) {
        console.error('[BIM Statuses Error]', e.message);
        res.status(500).json({ error: e.message });
    }
});

/**
 * Intenta descargar un archivo PDF desde Supabase Storage.
 * Si no existe, lo descarga de AppSheet, lo guarda en Supabase Storage y lo retorna.
 */
async function obtenerArchivoConCache(tableName, rawFileName, originalUrl) {
    if (!rawFileName) throw new Error('Nombre de archivo inválido');
    
    // Limpiar el prefijo de la tabla si existe (ej: "LOG_PID_MS::Archivos/PDF/..." -> "Archivos/PDF/...")
    let cleanPath = rawFileName.trim();
    const parts = cleanPath.split('::');
    if (parts.length === 2) {
        cleanPath = parts[1];
    }
    
    const bucketId = 'andina-pdfs';
    const supabase = getSupabase();
    
    // 1. Intentar descargar de Supabase Storage
    try {
        const { data: fileData, error: downloadError } = await supabase.storage.from(bucketId).download(cleanPath);
        if (!downloadError && fileData) {
            console.log(`[Cache Storage] Hit: ${cleanPath}`);
            const arrayBuffer = await fileData.arrayBuffer();
            return Buffer.from(arrayBuffer);
        }
    } catch (storageErr) {
        console.log(`[Cache Storage] Miss/Error en: ${cleanPath}. Descargando de AppSheet...`, storageErr.message);
    }
    
    // 2. Si no existe, descargar de AppSheet
    console.log(`[Cache Storage] Descargando desde AppSheet: ${originalUrl}`);
    const response = await fetch(originalUrl);
    if (!response.ok) {
        throw new Error(`Error descargando de AppSheet (${response.status}): ${response.statusText}`);
    }
    
    const arrayBuffer = await response.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    
    // 3. Guardar en Supabase Storage en segundo plano
    supabase.storage.from(bucketId).upload(cleanPath, fileBuffer, {
        contentType: 'application/pdf',
        upsert: true
    }).then(({ error: uploadError }) => {
        if (uploadError) {
            console.error(`[Cache Storage] Error guardando ${cleanPath} en Supabase:`, uploadError.message);
        } else {
            console.log(`[Cache Storage] Cacheado con éxito: ${cleanPath}`);
        }
    }).catch(err => {
        console.error(`[Cache Storage] Error asíncrono guardando ${cleanPath}:`, err.message);
    });
    
    return fileBuffer;
}

// GET /api/pid/pdf/:query → Obtiene los diagramas P&ID asociados a un spool, línea o ID_PID desde REL_PIDLineas_MS y LIST_PID_MS
app.get('/api/pid/pdf/:query', async (req, res) => {
    const query = decodeURIComponent(req.params.query).trim();
    if (!query) {
        return res.status(400).json({ success: false, message: 'Falta el parámetro de búsqueda' });
    }

    try {
        console.log(`[PID PDF] Buscando planos P&ID para "${query}"...`);
        const [spools, rels, pids] = await Promise.all([
            fetchAppSheetCached('LIST_Spools_MS_'),
            fetchAppSheetCached('REL_PIDLineas_MS'),
            fetchAppSheetCached('LIST_PID_MS')
        ]);

        const appName = CONFIG.APPSHEET_APP_ID || 'LukeAPP_Andina-526211656';

        // 1. Determinar el ID_LINEA
        let idLinea = null;
        
        // Ver si query coincide con el ID_SPOOL o el TAG GESTION de algún spool
        const spool = spools.find(s => 
            String(s.ID_SPOOL || '').trim().toLowerCase() === query.toLowerCase() ||
            String(s['TAG GESTION'] || '').trim().toLowerCase() === query.toLowerCase() ||
            String(s.SPOOL || '').trim().toLowerCase() === query.toLowerCase()
        );

        if (spool) {
            idLinea = String(spool.ID_LINEA || '').trim();
            console.log(`[PID PDF] Resolvimos spool "${query}" a línea: "${idLinea}"`);
        } else {
            // Si no fue spool, ver si coincide directamente con alguna línea
            const lineaExiste = rels.some(r => String(r.ID_LINEA || '').trim().toLowerCase() === query.toLowerCase());
            if (lineaExiste) {
                idLinea = query;
            }
        }

        // 2. Encontrar todos los ID_PID asociados
        let idPidsAsociados = [];
        if (idLinea) {
            idPidsAsociados = rels
                .filter(r => String(r.ID_LINEA || '').trim().toLowerCase() === idLinea.toLowerCase())
                .map(r => String(r.ID_PID || '').trim())
                .filter(Boolean);
        } else {
            // Si no hay línea, ver si la query coincide directamente con un ID_PID del maestro
            const pidExiste = pids.some(p => String(p.ID_PID || '').trim().toLowerCase().includes(query.toLowerCase()));
            if (pidExiste) {
                // Encontrar los matches aproximados o exactos
                idPidsAsociados = [...new Set(
                    pids
                        .filter(p => String(p.ID_PID || '').trim().toLowerCase().includes(query.toLowerCase()))
                        .map(p => String(p.ID_PID || '').trim())
                )];
            }
        }

        if (idPidsAsociados.length === 0) {
            return res.json({ success: false, message: 'No se encontraron P&IDs asociados a esta consulta' });
        }

        // 3. Para cada ID_PID, obtener el registro más actual en LIST_PID_MS según FECHA_CREACION
        const parseFechaCreacion = str => {
            if (!str) return 0;
            const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
            if (!m) return 0;
            const [, dd, mm, yyyy, hh, mi, ss] = m;
            return new Date(+yyyy, +mm - 1, +dd, +hh, +mi, +ss).getTime();
        };

        const resultPids = [];
        
        idPidsAsociados.forEach(idPid => {
            const versiones = pids.filter(p => String(p.ID_PID || '').trim() === idPid && p.ARCHIVO_PDF_VIGENTE);
            if (versiones.length > 0) {
                // Ordenar por FECHA_CREACION desc
                versiones.sort((a, b) => parseFechaCreacion(b.FECHA_CREACION) - parseFechaCreacion(a.FECHA_CREACION));
                const masReciente = versiones[0];
                
                // Formatear archivo y url
                const fileRaw = masReciente.ARCHIVO_PDF_VIGENTE;
                let cleanFile = fileRaw;
                let tableProvider = 'LIST_PID_MS';
                
                const parts = fileRaw.split('::');
                if (parts.length === 2) {
                    tableProvider = parts[0];
                    cleanFile = parts[1];
                }

                const pdfUrl = `https://www.appsheet.com/template/gettablefileurl?appName=${appName}&tableName=${encodeURIComponent(tableProvider)}&fileName=${encodeURIComponent(cleanFile)}`;

                resultPids.push({
                    id_pid: idPid,
                    descripcion: masReciente.DESCRIPCION || '',
                    fecha_creacion: masReciente.FECHA_CREACION || '',
                    revision_vigente: masReciente.REVISION_VIGENTE || '',
                    estado_vigente: masReciente.ESTADO_VIGENTE || '',
                    pdf_url: pdfUrl
                });
            }
        });

        if (resultPids.length === 0) {
            return res.json({ success: false, message: 'No se encontraron archivos PDF vigentes para los P&IDs asociados' });
        }

        res.json({
            success: true,
            query: query,
            linea: idLinea,
            pids: resultPids
        });

    } catch (e) {
        console.error('[PID PDF Error]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/iso/pdf/:isoId → Obtiene la hoja actual y todas las demás hojas de la misma línea (isométrico multi-hoja) desde LOG_Iso_MS
app.get('/api/iso/pdf/:isoId', async (req, res) => {
    const isoId = decodeURIComponent(req.params.isoId).trim();

    try {
        console.log(`[ISO PDF] Buscando hojas e isométricos para "${isoId}"...`);
        const rawIso = await fetchAppSheet('LOG_Iso_MS');
        const appName = CONFIG.APPSHEET_APP_ID || 'LukeAPP_Andina-526211656';

        // 1. Deducir la línea base (prefijo quitando _HOJA-X o similar)
        let lineaPrefijo = isoId;
        const hojaIndex = isoId.toUpperCase().lastIndexOf('HOJA');
        if (hojaIndex > 0) {
            lineaPrefijo = isoId.substring(0, hojaIndex).replace(/[-_]+$/, '');
        }

        const normalizar = (s) => String(s || '').trim().replace(/["'\s]+/g, '').toLowerCase();
        const prefijoNorm = normalizar(lineaPrefijo);
        const isoIdNorm = normalizar(isoId);

        const sheets = [];
        let currentSheet = null;

        // Auxiliar para extraer el número de hoja para el ordenamiento
        const extraerNumeroHoja = (idIso) => {
            const match = idIso.match(/HOJA[-_](\d+)/i);
            return match ? parseInt(match[1], 10) : 999;
        };

        rawIso.forEach(row => {
            const rowIso = String(row['ID_ISO'] || '').trim();
            const rowIsoNorm = normalizar(rowIso);

            // Si coincide con el prefijo de la línea
            if (rowIsoNorm.includes(prefijoNorm) && row['ARCHIVO_PDF_REVISION']) {
                const fileName = row['ARCHIVO_PDF_REVISION'].trim();
                let pdfUrl = '';
                if (fileName.startsWith('http://') || fileName.startsWith('https://')) {
                    pdfUrl = fileName;
                } else {
                    pdfUrl = `https://www.appsheet.com/template/gettablefileurl?appName=${appName}&tableName=LOG_Iso_MS&fileName=${encodeURIComponent(fileName)}`;
                }

                // Extraer el nombre legible de la hoja (por ejemplo, "Hoja 2" o "HOJA-2")
                let label = rowIso;
                const matchHoja = rowIso.match(/HOJA[-_]\d+/i);
                if (matchHoja) {
                    label = matchHoja[0].replace('-', ' ');
                }

                const sheetObj = {
                    id_iso: rowIso,
                    hoja_label: label,
                    hoja_nro: extraerNumeroHoja(rowIso),
                    pdf_url: pdfUrl
                };

                sheets.push(sheetObj);

                // Si es la hoja que se solicitó originalmente
                if (rowIsoNorm === isoIdNorm) {
                    currentSheet = sheetObj;
                }
            }
        });

        // Ordenar hojas de forma numérica ascendente (Hoja 1, Hoja 2, Hoja 10, etc.)
        sheets.sort((a, b) => a.hoja_nro - b.hoja_nro);

        if (sheets.length === 0) {
            return res.json({ success: false, message: 'No se encontraron archivos PDF para esta línea o isométrico' });
        }

        res.json({
            success: true,
            linea: lineaPrefijo,
            current_sheet: currentSheet || sheets[0], // si no se mapeó exacto, tomar la primera
            sheets: sheets
        });
    } catch (e) {
        console.error('[ISO PDF Error]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/iso/proxy-pdf → Actúa como proxy para servir el PDF de AppSheet sin restricciones de X-Frame-Options (usa Supabase Storage como caché)
app.get('/api/iso/proxy-pdf', async (req, res) => {
    const fileUrl = req.query.url;
    if (!fileUrl) {
        return res.status(400).send('Falta el parámetro url');
    }

    try {
        // Extraer fileName de la URL para usarlo de clave
        let fileName = 'archivo.pdf';
        try {
            const urlObj = new URL(fileUrl);
            fileName = urlObj.searchParams.get('fileName') || urlObj.pathname.split('/').pop() || 'archivo.pdf';
        } catch (urlErr) {
            // Si no es URL válida o falla el parser
        }

        // Obtener el buffer del archivo utilizando nuestra lógica de Supabase Storage
        const fileBuffer = await obtenerArchivoConCache('LOG_Iso_MS', fileName, fileUrl);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="plano.pdf"');
        res.send(fileBuffer);
    } catch (e) {
        console.error('[Proxy PDF Error]', e.message);
        res.status(500).send(`Error al cargar el PDF a través del proxy: ${e.message}`);
    }
});


// GET /api/bim/mapeo → Obtiene el mapa de GUID -> SPOOL LUKEAPP de todos los elementos mapeados en AppSheet
app.get('/api/bim/mapeo', async (req, res) => {
    try {
        const rawBim = await fetchAppSheet('LIST_Bim_MS');
        const mapeo = {};
        rawBim.forEach(row => {
            const guid = String(row['Elemento GUID'] || row['Elemento\nGUID'] || '').trim();
            const spool = String(row['SPOOL LUKEAPP'] || '').trim();
            if (guid && spool) {
                mapeo[guid.toLowerCase()] = spool;
            }
        });
        res.json(mapeo);
    } catch (e) {
        console.error('[BIM Mapeo Error]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/bim/spool-index → Índice { tagLower: { id_spool, tag_gestion, id_iso } }
// Permite mostrar el ID_SPOOL largo y el TAG GESTIÓN a partir del SPOOL LUKEAPP (tag corto).
app.get('/api/bim/spool-index', async (req, res) => {
    try {
        const spools = await fetchAppSheet('LIST_Spools_MS_');
        const index = {};
        spools.forEach(s => {
            const tag     = String(s['TAG GESTION'] || '').trim();
            const idSpool = String(s['ID_SPOOL'] || '').trim();
            const idIso   = String(s['ID_ISO'] || '').trim() ||
                (idSpool.includes('_') ? idSpool.substring(0, idSpool.lastIndexOf('_')) : '');
            if (tag) {
                index[tag.toLowerCase()] = { id_spool: idSpool, tag_gestion: tag, id_iso: idIso };
            }
        });
        res.json(index);
    } catch (e) {
        console.error('[BIM Spool-Index Error]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/bim/vincular → Vincula uno o múltiples Elementos GUID a un SPOOL LUKEAPP en AppSheet (LIST_Bim_MS)
// Escritura protegida: requiere clave de edición BIM.
app.post('/api/bim/vincular', requerirPermiso('bim'), async (req, res) => {
    let elements = req.body.elements;
    const spool = req.body.spool;

    // Si viene en el formato antiguo de un solo objeto, envolver en un array para compatibilidad
    if (!elements && req.body.guid) {
        elements = [ req.body ];
    }

    if (!elements || elements.length === 0 || !spool) {
        return res.status(400).json({ error: "Elementos y Spool son requeridos." });
    }

    try {
        // Traducir el ID largo del Spool a TAG GESTION (SPOOL LUKEAPP) si corresponde
        let finalSpoolTag = String(spool).trim();
        try {
            const masterSpools = await fetchAppSheet('LIST_Spools_MS_');
            const foundMaster = masterSpools.find(m => 
                String(m.ID_SPOOL || '').trim().toLowerCase() === finalSpoolTag.toLowerCase() ||
                String(m.SPOOL || '').trim().toLowerCase() === finalSpoolTag.toLowerCase()
            );
            if (foundMaster) {
                finalSpoolTag = foundMaster['TAG GESTION'] || foundMaster.SPOOL || finalSpoolTag;
                console.log(`[BIM Vincular] Traducido spool "${spool}" a tag final "${finalSpoolTag}"`);
            }
        } catch (masterErr) {
            console.error('[BIM Vincular] Advertencia al buscar maestro spools para traducción:', masterErr.message);
        }

        console.log(`[BIM] Validando y guardando vinculaciones para Spool "${finalSpoolTag}" en AppSheet...`);
        
        // 1. Obtener todas las filas actuales de LIST_Bim_MS
        let currentBimRows = [];
        try {
            currentBimRows = await fetchAppSheet('LIST_Bim_MS');
        } catch (fetchErr) {
            console.error('[BIM Vincular] Error al leer LIST_Bim_MS para validación:', fetchErr.message);
            throw new Error(`No se pudo validar el estado de los elementos en AppSheet: ${fetchErr.message}`);
        }

        // Crear un mapa de GUIDs existentes para búsquedas rápidas de O(1)
        const existingGuidsMap = new Map();
        currentBimRows.forEach(row => {
            const guid = String(row['Elemento GUID'] || '').trim();
            if (guid) {
                existingGuidsMap.set(guid.toLowerCase(), row);
            }
        });

        const rowsToAdd = [];
        const rowsToEdit = [];

        for (const el of elements) {
            if (!el.guid) continue;
            const guidKey = String(el.guid).trim().toLowerCase();
            const existingRow = existingGuidsMap.get(guidKey);

            if (existingRow) {
                // Si el elemento ya existe, lo editamos para asignarle el SPOOL LUKEAPP.
                // Conservamos los datos existentes y actualizamos/asignamos el SPOOL LUKEAPP
                rowsToEdit.push({
                    "Elemento GUID": existingRow["Elemento GUID"],
                    "SPOOL LUKEAPP": finalSpoolTag,
                    "CWP": existingRow["CWP"] || el.cwp || "",
                    "Line Number": existingRow["Line Number"] || el.line_number || el.layer || "",
                    "TAG": existingRow["TAG"] || el.tag || el.layer || "",
                    "AutoCad Size": existingRow["AutoCad Size"] || el.autocad_size || ""
                });
            } else {
                // Si el elemento no existe, lo creamos nuevo
                rowsToAdd.push({
                    "Elemento GUID": el.guid,
                    "SPOOL LUKEAPP": finalSpoolTag,
                    "CWP": el.cwp || "",
                    "Line Number": el.line_number || el.layer || "",
                    "TAG": el.tag || el.layer || "",
                    "AutoCad Size": el.autocad_size || ""
                });
            }
        }

        let addResult = null;
        let editResult = null;

        if (rowsToAdd.length > 0) {
            console.log(`[BIM Vincular] Agregando (Add) ${rowsToAdd.length} elementos nuevos en AppSheet`);
            addResult = await fetchAppSheet('LIST_Bim_MS', 'Add', rowsToAdd);
        }

        if (rowsToEdit.length > 0) {
            console.log(`[BIM Vincular] Actualizando (Edit) ${rowsToEdit.length} elementos existentes en AppSheet`);
            editResult = await fetchAppSheet('LIST_Bim_MS', 'Edit', rowsToEdit);
        }

        // Invalidar cachés
        invalidarCache('LIST_Bim_MS');
        delete cache['LIST_Bim_MS'];

        res.json({
            success: true,
            count: elements.length,
            addedCount: rowsToAdd.length,
            editedCount: rowsToEdit.length,
            addResult,
            editResult
        });
    } catch (e) {
        console.error('[BIM Vincular Error]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/bim/desvincular → Desvincula múltiples Elementos GUID en AppSheet (pone SPOOL LUKEAPP = "")
// Escritura protegida: requiere clave de edición BIM.
app.post('/api/bim/desvincular', requerirPermiso('bim'), async (req, res) => {
    const elements = req.body.elements;

    if (!elements || elements.length === 0) {
        return res.status(400).json({ error: "Elementos son requeridos." });
    }

    try {
        console.log(`[BIM] Desvinculando en AppSheet (LIST_Bim_MS): ${elements.length} elementos`);

        // 1. Obtener todas las filas actuales de LIST_Bim_MS
        let currentBimRows = [];
        try {
            currentBimRows = await fetchAppSheet('LIST_Bim_MS');
        } catch (fetchErr) {
            console.error('[BIM Desvincular] Error al leer LIST_Bim_MS:', fetchErr.message);
            throw new Error(`No se pudo leer la base de datos de AppSheet: ${fetchErr.message}`);
        }

        // Crear mapa de GUIDs existentes para búsquedas rápidas
        const existingGuidsMap = new Map();
        currentBimRows.forEach(row => {
            const guid = String(row['Elemento GUID'] || '').trim();
            if (guid) {
                existingGuidsMap.set(guid.toLowerCase(), row);
            }
        });

        const rowsToEdit = [];

        for (const el of elements) {
            if (!el.guid) continue;
            const guidKey = String(el.guid).trim().toLowerCase();
            const existingRow = existingGuidsMap.get(guidKey);

            if (existingRow) {
                // Solo si el elemento existe en AppSheet lo editamos para establecer SPOOL LUKEAPP en vacío
                rowsToEdit.push({
                    "Elemento GUID": existingRow["Elemento GUID"],
                    "SPOOL LUKEAPP": "",
                    "CWP": existingRow["CWP"] || "",
                    "Line Number": existingRow["Line Number"] || "",
                    "TAG": existingRow["TAG"] || "",
                    "AutoCad Size": existingRow["AutoCad Size"] || ""
                });
            }
        }

        let editResult = null;
        if (rowsToEdit.length > 0) {
            console.log(`[BIM Desvincular] Limpiando SPOOL LUKEAPP para ${rowsToEdit.length} elementos en AppSheet`);
            editResult = await fetchAppSheet('LIST_Bim_MS', 'Edit', rowsToEdit);
        }

        // Invalidar cachés
        invalidarCache('LIST_Bim_MS');
        delete cache['LIST_Bim_MS'];

        res.json({
            success: true,
            count: elements.length,
            desvinculadosCount: rowsToEdit.length,
            editResult
        });
    } catch (e) {
        console.error('[BIM Desvincular Error]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =================================================================
// BIM — CAPAS VÁLVULAS Y SOPORTES (misma lógica que spools)
// Vínculo GUID→ítem guardado en columnas de LIST_Bim_MS:
//   válvulas → "VALVULA LUKEAPP" = ID_VALVULA
//   soportes → "SOPORTE LUKEAPP" = ID_Soporte
// El estado de montaje vive en las tablas REG_Montaje*.
// =================================================================
const BIM_CAPAS = {
    valvula: {
        col:         'VALVULA LUKEAPP',
        listTable:   'LIST_Valvulas_MS',
        listKey:     'ID_VALVULA',
        labelCols:   ['ID_VALVULA', 'ID_LINEA'],  // etiqueta visible: VAL113_03351-CT-...
        montajeTable:'REG_MontajeValvulas_MS',
        montajeKey:  'ID_VALVULA',
        montajeStatusCol: 'Status',   // estados reales: "Posicionada", "Montada"...
        montajeFechaCol:  'fecha',    // para quedarse con el ÚLTIMO registro
    },
    soporte: {
        col:         'SOPORTE LUKEAPP',
        listTable:   'LIST_Soportes_MS',
        listKey:     'ID_Soporte',
        labelCols:   ['ITEM', 'ID_LINEA'],
        montajeTable:'REG_MontajeSoportes_MS',
        montajeKey:  'ID_Soporte',
        montajeStatusCol: null,        // sin estado: la presencia de fila = montado
        montajeFechaCol:  'Fecha',     // ojo, con mayúscula (en válvulas es 'fecha')
    }
};

// Etiqueta visible para el usuario que vincula (llave real + contexto de línea)
function bimItemLabel(capa, row) {
    if (!row) return '';
    const parts = (capa.labelCols || [capa.listKey])
        .map(c => String(row[c] || '').trim())
        .filter(Boolean);
    return parts.join('_');
}

// Columnas reales de LIST_Bim_MS que preservamos al editar.
// OJO: se OMITE "DESCRIPCIÓN" a propósito — escribir esa columna (tilde en la Í)
// dispara System.Text.DecoderFallbackException (400) en AppSheet tras regenerar el app.
// Está vacía en todas las filas y no se usa, así que nunca la escribimos.
/**
 * Estado de montaje ACTUAL de cada ítem de una capa, desde su tabla REG_Montaje*.
 *
 * Cada capa tiene su propia regla y no son intercambiables:
 *   válvulas → columna `Status` con estados reales ("Posicionada", "Montada"…)
 *   soportes → sin columna de estado: la presencia de la fila ya significa montado
 *
 * Se queda con el ÚLTIMO registro por fecha (desempate por _RowNumber), igual
 * criterio que los spools sobre LOG_Spool_MS: una única regla para "estado actual".
 *
 * Devuelve { idLower: { status, fecha, row } }. Sin fila -> el ítem no aparece,
 * y quien consulte decide si eso es PENDIENTE.
 */
function estadosMontajeDeCapa(capa, montajeRows) {
    const out = {};
    (montajeRows || []).forEach(r => {
        const id = String(r[capa.montajeKey] || '').trim().toLowerCase();
        if (!id) return;
        const fecha = capa.montajeFechaCol ? parseFechaLog(r[capa.montajeFechaCol]) : 0;
        const row   = parseInt(r._RowNumber || '0', 10) || 0;
        const prev  = out[id];
        if (prev && !(fecha > prev.fecha || (fecha === prev.fecha && row > prev.row))) return;

        // Sin columna de estado, la fila en sí es el estado: montado.
        const bruto = capa.montajeStatusCol ? String(r[capa.montajeStatusCol] || '').trim() : '';
        out[id] = { status: (bruto || 'MONTADO').toUpperCase(), fecha, row };
    });
    return out;
}

const BIM_REAL_COLS = ['Elemento GUID', 'SPOOL LUKEAPP', 'VALVULA LUKEAPP', 'SOPORTE LUKEAPP',
    'CWP', 'Line Number', 'TAG', 'AutoCad Size'];

function bimBuildEditRow(existingRow, colName, valor) {
    const out = {};
    for (const c of BIM_REAL_COLS) {
        if (existingRow[c] !== undefined) out[c] = existingRow[c];
    }
    out['Elemento GUID'] = existingRow['Elemento GUID'];
    out[colName] = valor;
    return out;
}

// GET /api/bim/:capa/mapeo → { [guidLower]: idItem }
app.get('/api/bim/:capa/mapeo', async (req, res) => {
    const capa = BIM_CAPAS[req.params.capa];
    if (!capa) return res.status(404).json({ error: 'Capa no válida' });
    try {
        const rows = await fetchAppSheet('LIST_Bim_MS');
        const mapeo = {};
        rows.forEach(row => {
            const guid = String(row['Elemento GUID'] || '').trim();
            const val  = String(row[capa.col] || '').trim();
            if (guid && val) mapeo[guid.toLowerCase()] = val;
        });
        res.json(mapeo);
    } catch (e) {
        console.error(`[BIM ${req.params.capa} mapeo]`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/bim/:capa/index → { [idLower]: { id, ...campos maestros } }
app.get('/api/bim/:capa/index', async (req, res) => {
    const capa = BIM_CAPAS[req.params.capa];
    if (!capa) return res.status(404).json({ error: 'Capa no válida' });
    try {
        const rows = await fetchAppSheet(capa.listTable);
        const index = {};
        rows.forEach(r => {
            const id = String(r[capa.listKey] || '').trim();
            if (id) index[id.toLowerCase()] = { ...r, _label: bimItemLabel(capa, r) };
        });
        res.json(index);
    } catch (e) {
        console.error(`[BIM ${req.params.capa} index]`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/bim/:capa/item/:id → metadata del ítem + GUIDs vinculados + estado de montaje
app.get('/api/bim/:capa/item/:id', async (req, res) => {
    const capa = BIM_CAPAS[req.params.capa];
    if (!capa) return res.status(404).json({ error: 'Capa no válida' });
    const id = decodeURIComponent(req.params.id).trim();
    try {
        const [listRows, bimRows, montajeRows] = await Promise.all([
            fetchAppSheet(capa.listTable),
            fetchAppSheet('LIST_Bim_MS'),
            fetchAppSheet(capa.montajeTable).catch(() => [])
        ]);

        const meta = listRows.find(r => String(r[capa.listKey] || '').trim().toLowerCase() === id.toLowerCase()) || null;

        const elements = bimRows
            .filter(r => String(r[capa.col] || '').trim().toLowerCase() === id.toLowerCase())
            .map(r => ({
                guid: String(r['Elemento GUID'] || '').trim(),
                cwp:  String(r['CWP'] || '').trim(),
                tag:  String(r['TAG'] || '').trim()
            }));

        // Estado de montaje por la MISMA regla que el filtro por estado: último
        // registro por fecha. Antes se tomaba montajes[0], que es orden arbitrario:
        // con dos reportes de la misma válvula podía ganar el viejo.
        const entrada = estadosMontajeDeCapa(capa, montajeRows)[id.toLowerCase()];
        const montado = !!entrada;
        const statusMontaje = entrada ? entrada.status : 'PENDIENTE';

        res.json({
            id,
            label: bimItemLabel(capa, meta),
            metadata: meta,
            guids: elements.map(e => e.guid).filter(Boolean),
            elements,
            montado,
            status: statusMontaje
        });
    } catch (e) {
        console.error(`[BIM ${req.params.capa} item]`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/bim/:capa/statuses → { Montado:[guids], Pendiente:[guids] } para colorear
app.get('/api/bim/:capa/statuses', async (req, res) => {
    const capa = BIM_CAPAS[req.params.capa];
    if (!capa) return res.status(404).json({ error: 'Capa no válida' });
    try {
        const [bimRows, montajeRows] = await Promise.all([
            fetchAppSheet('LIST_Bim_MS'),
            fetchAppSheet(capa.montajeTable).catch(() => [])
        ]);

        // Antes solo se miraba si EXISTÍA fila de montaje y se repartía en dos
        // cajones fijos. Eso contaba una válvula "Posicionada" como MONTADO, que
        // son etapas distintas: el avance salía inflado. Ahora manda el estado
        // real de la capa; los soportes siguen siendo binarios porque su tabla
        // no tiene columna de estado.
        const estados = estadosMontajeDeCapa(capa, montajeRows);

        const result = { 'PENDIENTE': [] };
        bimRows.forEach(row => {
            const guid = String(row['Elemento GUID'] || '').trim();
            const id   = String(row[capa.col] || '').trim().toLowerCase();
            if (!guid || !id) return;
            const st = estados[id] ? estados[id].status : 'PENDIENTE';
            (result[st] = result[st] || []).push(guid);
        });
        res.json(result);
    } catch (e) {
        console.error(`[BIM ${req.params.capa} statuses]`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/bim/:capa/vincular → asocia GUIDs a un ítem (ID_VALVULA / ID_Soporte)
app.post('/api/bim/:capa/vincular', requerirPermiso('bim'), async (req, res) => {
    const capa = BIM_CAPAS[req.params.capa];
    if (!capa) return res.status(404).json({ error: 'Capa no válida' });

    let elements = req.body.elements;
    const itemId = String(req.body.item || req.body.id || '').trim();
    if (!elements && req.body.guid) elements = [req.body];
    if (!elements || elements.length === 0 || !itemId) {
        return res.status(400).json({ error: 'Elementos e ítem son requeridos.' });
    }

    try {
        // Validar que el ítem exista en la lista maestra
        const listRows = await fetchAppSheet(capa.listTable);
        const existeItem = listRows.some(r => String(r[capa.listKey] || '').trim().toLowerCase() === itemId.toLowerCase());
        if (!existeItem) {
            return res.status(404).json({ error: `${req.params.capa} "${itemId}" no existe en ${capa.listTable}.` });
        }

        const currentBimRows = await fetchAppSheet('LIST_Bim_MS');
        const existing = new Map();
        currentBimRows.forEach(row => {
            const g = String(row['Elemento GUID'] || '').trim();
            if (g) existing.set(g.toLowerCase(), row);
        });

        const rowsToAdd = [], rowsToEdit = [];
        for (const el of elements) {
            if (!el.guid) continue;
            const k = String(el.guid).trim().toLowerCase();
            const row = existing.get(k);
            if (row) {
                rowsToEdit.push(bimBuildEditRow(row, capa.col, itemId));
            } else {
                rowsToAdd.push({
                    'Elemento GUID': el.guid,
                    [capa.col]:      itemId,
                    'CWP':           el.cwp || '',
                    'Line Number':   el.line_number || el.layer || '',
                    'TAG':           el.tag || el.layer || '',
                    'AutoCad Size':  el.autocad_size || ''
                });
            }
        }

        let addResult = null, editResult = null;
        if (rowsToAdd.length)  addResult  = await fetchAppSheet('LIST_Bim_MS', 'Add', rowsToAdd);
        if (rowsToEdit.length) editResult = await fetchAppSheet('LIST_Bim_MS', 'Edit', rowsToEdit);

        invalidarCache('LIST_Bim_MS');
        delete cache['LIST_Bim_MS'];

        res.json({ success: true, count: elements.length, addedCount: rowsToAdd.length, editedCount: rowsToEdit.length });
    } catch (e) {
        console.error(`[BIM ${req.params.capa} vincular]`, e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/bim/:capa/desvincular → limpia la columna de vínculo de los GUIDs
app.post('/api/bim/:capa/desvincular', requerirPermiso('bim'), async (req, res) => {
    const capa = BIM_CAPAS[req.params.capa];
    if (!capa) return res.status(404).json({ error: 'Capa no válida' });

    const elements = req.body.elements;
    if (!elements || elements.length === 0) return res.status(400).json({ error: 'Elementos son requeridos.' });

    try {
        const currentBimRows = await fetchAppSheet('LIST_Bim_MS');
        const existing = new Map();
        currentBimRows.forEach(row => {
            const g = String(row['Elemento GUID'] || '').trim();
            if (g) existing.set(g.toLowerCase(), row);
        });

        const rowsToEdit = [];
        for (const el of elements) {
            if (!el.guid) continue;
            const row = existing.get(String(el.guid).trim().toLowerCase());
            if (row) rowsToEdit.push(bimBuildEditRow(row, capa.col, ''));
        }

        let editResult = null;
        if (rowsToEdit.length) editResult = await fetchAppSheet('LIST_Bim_MS', 'Edit', rowsToEdit);

        invalidarCache('LIST_Bim_MS');
        delete cache['LIST_Bim_MS'];

        res.json({ success: true, count: elements.length, desvinculadosCount: rowsToEdit.length });
    } catch (e) {
        console.error(`[BIM ${req.params.capa} desvincular]`, e.message);
        res.status(500).json({ error: e.message });
    }
});



// =================================================================
// BOT WHATSAPP (wa-bridge Baileys + Gemini) Y PANEL DE CONFIGURACIÓN
// =================================================================
const { handleWhatsappIncoming, resolverSpool, registrarAvanceAppSheet, consultarEstadoSpool, guardarRegistro } = require('./lib/bot');
const { listarBotConfig, setBotConfig, getBotConfig } = require('./lib/botConfig');


// -----------------------------------------------------------------
// AUTENTICACIÓN (claves de escritura). Lectura del dashboard: abierta.
// -----------------------------------------------------------------
// POST /api/auth/login → valida una clave y devuelve un token con permisos.
app.post('/api/auth/login', (req, res) => {
    const clave = (req.body && req.body.clave) || '';
    const permisos = permisosDeClave(clave);
    if (!permisos.length) {
        return res.status(401).json({ success: false, error: 'Clave incorrecta' });
    }
    const token = crearToken(permisos);
    res.json({ success: true, token, permisos, expiraEnHoras: TTL_HORAS });
});

// Webhook de mensajes entrantes (llamado por el wa-bridge; valida su propio secreto)
app.post('/api/whatsapp-incoming', handleWhatsappIncoming);

// GET /api/bim/estado-conteos → por estado: { total, asociados, sin_asociar }
// Cuenta TODOS los spools (LIST_Spools_MS_) por su estado LOG (último registro),
// igual que la sección Spools. 'sin_asociar' = spools sin geometría en el modelo.
// El visor colorea solo los asociados, pero el número refleja el total real.
app.get('/api/bim/estado-conteos', async (req, res) => {
    try {
        const [spools, logs, rawBim] = await Promise.all([
            fetchAppSheetCached('LIST_Spools_MS_'),
            fetchAppSheetCached('LOG_Spool_MS'),
            fetchAppSheetCached('LIST_Bim_MS')
        ]);
        const estados = estadosActualesDeLog(logs); // ID_SPOOL -> { status }
        const tagsAsociados = new Set();
        rawBim.forEach(r => {
            const t = String(r['SPOOL LUKEAPP'] || '').trim().toLowerCase();
            if (t) tagsAsociados.add(t);
        });
        const conteos = {};
        spools.forEach(s => {
            const idSpool = String(s['ID_SPOOL'] || '').trim();
            if (!idSpool) return;
            const tag = String(s['TAG GESTION'] || '').trim().toLowerCase();
            const est = estados[idSpool];
            const status = est ? est.status : 'SIN ESTADO';
            if (!conteos[status]) conteos[status] = { total: 0, asociados: 0, sin_asociar: 0 };
            conteos[status].total++;
            if (tag && tagsAsociados.has(tag)) conteos[status].asociados++;
            else conteos[status].sin_asociar++;
        });
        res.json(conteos);
    } catch (e) {
        console.error('[BIM Estado-Conteos]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =================================================================
// COLORES DE ESTADOS DEL VISOR (dinámicos y editables)
// Overrides guardados como JSON en bot_config('colores_estados_bim').
// =================================================================
app.get('/api/bim/estado-colores', async (req, res) => {
    try {
        const supabase = getSupabase();
        const { data } = await supabase.from('bot_config').select('valor').eq('clave', 'colores_estados_bim').maybeSingle();
        res.json(data && data.valor ? JSON.parse(data.valor) : {});
    } catch (e) {
        res.json({});
    }
});

// POST { estado, color: '#rrggbb' } — color null/'' elimina el override
app.post('/api/bim/estado-colores', requerirPermiso('bim'), async (req, res) => {
    const estado = String(req.body?.estado || '').trim().toUpperCase();
    const color = String(req.body?.color || '').trim();
    if (!estado) return res.status(400).json({ error: 'Falta estado' });
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'Color inválido (#rrggbb)' });
    try {
        const supabase = getSupabase();
        const { data } = await supabase.from('bot_config').select('valor').eq('clave', 'colores_estados_bim').maybeSingle();
        const colores = data && data.valor ? JSON.parse(data.valor) : {};
        if (color) colores[estado] = color.toLowerCase();
        else delete colores[estado];
        await supabase.from('bot_config').upsert(
            { clave: 'colores_estados_bim', valor: JSON.stringify(colores), descripcion: 'Colores por estado del visor BIM (editables desde el filtro)', updated_at: new Date().toISOString() },
            { onConflict: 'clave' }
        );
        res.json({ success: true, colores });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// =================================================================
// DIVISIONES VIRTUALES DE TRAMOS (herramienta "Dividir tramo" del visor)
// Los cortes son fracciones [0..1] sobre el eje del elemento; se guardan
// en Supabase (andina.bim_divisiones) sin tocar el modelo APS.
// =================================================================
/**
 * Normaliza una división persistida a [{id, a, b}].
 *
 * El id identifica al trozo de forma ESTABLE: la clave con la que se vincula a
 * un spool es `guid#p<id>`, no su posición. Sin eso, insertar un corte
 * reetiquetaba a los trozos siguientes y su vinculación se quedaba con el
 * trozo equivocado en silencio.
 *
 * Formato antiguo [[a,b],...]: se le asigna id = posición+1, que es
 * exactamente lo que `#pN` significaba hasta ahora, así que las vinculaciones
 * existentes siguen siendo válidas sin migrar datos.
 */
function normalizarPartesDivision(raw) {
    if (!Array.isArray(raw) || !raw.length) return null;
    return raw.map((p, i) => Array.isArray(p)
        ? { id: i + 1, a: p[0], b: p[1] }
        : { id: Number(p.id) || i + 1, a: p.a, b: p.b }
    );
}

app.get('/api/bim/divisiones', async (req, res) => {
    try {
        const supabase = getSupabase();
        const { data, error } = await supabase.from('bim_divisiones').select('guid, cortes');
        if (error) throw new Error(error.message);
        const out = {};
        (data || []).forEach(r => {
            const partes = normalizarPartesDivision(r.cortes);
            if (partes) out[String(r.guid).toLowerCase()] = partes;
        });
        res.json(out);
    } catch (e) {
        console.error('[BIM Divisiones]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST { guid, partes: [[a,b],...] } (o legado { cortes:[t...] }).
// partes/cortes vacíos elimina la división (restaura el original).
app.post('/api/bim/divisiones', requerirPermiso('bim'), async (req, res) => {
    const guid = String(req.body?.guid || '').trim().toLowerCase();
    if (!guid) return res.status(400).json({ error: 'Falta guid' });

    // partes = [{id, a, b}] con a<b (pueden salir de [0,1] al alargar el clon).
    // Se acepta también el formato antiguo [[a,b],...]: se le asigna id por
    // posición, que es lo que `#pN` significaba, así que no rompe vinculaciones.
    let partes = null;
    if (Array.isArray(req.body?.partes)) {
        partes = req.body.partes
            .map((p, i) => Array.isArray(p) ? { id: i + 1, a: p[0], b: p[1] } : p)
            .filter(p => p && typeof p.a === 'number' && typeof p.b === 'number' &&
                p.b > p.a && p.a > -1 && p.b < 2 && Number.isFinite(Number(p.id)))
            .map(p => ({ id: Number(p.id), a: p.a, b: p.b }));

        // Los ids deben ser únicos: si se repiten, dos trozos compartirían clave
        // y su vinculación al spool se pisaría.
        const vistos = new Set();
        for (const p of partes) {
            if (vistos.has(p.id)) return res.status(400).json({ error: `id de parte duplicado: ${p.id}` });
            vistos.add(p.id);
        }
    } else if (Array.isArray(req.body?.cortes)) {
        const cortes = req.body.cortes.filter(t => typeof t === 'number' && t > 0 && t < 1).sort((a, b) => a - b);
        if (cortes.length) {
            const bordes = [0, ...cortes, 1];
            partes = bordes.slice(0, -1).map((a, i) => ({ id: i + 1, a, b: bordes[i + 1] }));
        } else partes = [];
    }

    try {
        const supabase = getSupabase();
        if (!partes || !partes.length) {
            await supabase.from('bim_divisiones').delete().eq('guid', guid);
            return res.json({ success: true, eliminada: true });
        }
        const { error } = await supabase.from('bim_divisiones').upsert(
            { guid, cortes: partes, updated_at: new Date().toISOString() },
            { onConflict: 'guid' }
        );
        if (error) throw new Error(error.message);
        res.json({ success: true, guid, partes: partes.length });
    } catch (e) {
        console.error('[BIM Divisiones POST]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =================================================================
// ESCANEO DE LOTES (spools) — sesión tokenizada abierta desde el bot.
// La identidad viaja en el token (el usuario ya se autenticó por WhatsApp).
// =================================================================
app.get('/escanear', (req, res) => res.sendFile(path.join(__dirname, 'escanear.html')));

// Datos de la sesión + estados disponibles para el selector final
app.get('/api/escaneo/sesion', requerirSesion, async (req, res) => {
    try {
        const botConf = await getBotConfig();
        const estados = (botConf.estados_permitidos || '').split(',').map(s => s.trim()).filter(Boolean);
        res.json({ success: true, nombre: req.sesion.nombre, rol: req.sesion.rol, estados });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Resolver un valor escaneado (TAG o ID_SPOOL) → spool + su estado actual
app.get('/api/escaneo/resolver', requerirSesion, async (req, res) => {
    const valor = String(req.query.valor || '').trim();
    if (!valor) return res.status(400).json({ success: false, error: 'Falta valor' });
    try {
        const r = await resolverSpool(valor);
        if (!r.encontrado) return res.json({ success: true, encontrado: false });
        if (r.ambiguo) {
            return res.json({ success: true, encontrado: false, ambiguo: true, candidatos: r.candidatos.map(c => c.tagGestion || c.idSpool) });
        }
        const ultimo = await consultarEstadoSpool(r.spool, req.sesion.rol).catch(() => null);
        res.json({
            success: true, encontrado: true,
            tag: r.spool.tagGestion, id_spool: r.spool.idSpool, id_iso: r.spool.idIso,
            estado_actual: ultimo ? ultimo['STATUS'] : null
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Registrar el lote: { tags:[...], status } → un LOG_Spool por spool
app.post('/api/escaneo/registrar', requerirSesion, async (req, res) => {
    const { tags, status } = req.body || {};
    if (!Array.isArray(tags) || !tags.length || !status) {
        return res.status(400).json({ success: false, error: 'Se requieren tags[] y status' });
    }
    try {
        const botConf = await getBotConfig();
        const permitidos = (botConf.estados_permitidos || '').split(',').map(s => s.trim().toLowerCase());
        if (!permitidos.includes(String(status).toLowerCase())) {
            return res.status(400).json({ success: false, error: `Estado "${status}" no permitido` });
        }
        const usuario = { nombre: req.sesion.nombre, rol: req.sesion.rol };
        const resultados = [];
        for (const tag of tags) {
            try {
                const r = await resolverSpool(tag);
                if (!r.encontrado || r.ambiguo) { resultados.push({ tag, ok: false, msg: 'no resuelto' }); continue; }
                const { fila } = await registrarAvanceAppSheet({
                    spool: r.spool, status,
                    usuario: usuario.nombre, ubicacion: null, observacion: null, mts: null, rol: usuario.rol
                });
                await guardarRegistro({
                    telefono: req.sesion.telefono, spool_tag: r.spool.tagGestion, id_spool: r.spool.idSpool,
                    status, appsheet_ok: true, metadata: { via: 'escaneo', id_log_spool: fila['ID_LOG_SPOOL'] }
                }).catch(() => {});
                resultados.push({ tag: r.spool.tagGestion || tag, ok: true });
            } catch (e) {
                resultados.push({ tag, ok: false, msg: e.message.substring(0, 80) });
            }
        }
        const okCount = resultados.filter(r => r.ok).length;
        res.json({ success: true, status, total: tags.length, registrados: okCount, resultados });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Todas las rutas /api/bot/* y /api/config exigen clave de administración del bot.
// (Protege también el QR: quien lo escanee secuestraría la sesión de WhatsApp.)
app.use(['/api/bot', '/api/config'], requerirPermiso('bot'));

// Estado del bridge + número del bot (proxy para no exponer el puerto del bridge)
app.get('/api/bot/status', async (req, res) => {
    try {
        const r = await fetch(`${CONFIG.WA_BRIDGE_URL}/status`, { signal: AbortSignal.timeout(5000) });
        res.json(await r.json());
    } catch (e) {
        res.json({ success: false, status: 'bridge_offline', error: 'El wa-bridge no responde (¿PM2 detenido?)' });
    }
});

// QR para vincular / re-vincular la sesión de WhatsApp
app.get('/api/bot/qr', async (req, res) => {
    try {
        const r = await fetch(`${CONFIG.WA_BRIDGE_URL}/qr`, { signal: AbortSignal.timeout(5000) });
        const data = await r.json();
        if (data.qr && !data.qrDataUrl) {
            data.qrDataUrl = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(data.qr)}&margin=10`;
        }
        res.json(data);
    } catch (e) {
        res.json({ success: false, status: 'bridge_offline', qr: null, qrDataUrl: null });
    }
});

// Reiniciar conexión del bridge. body: { logout: true } fuerza QR nuevo.
app.post('/api/bot/restart', async (req, res) => {
    try {
        const r = await fetch(`${CONFIG.WA_BRIDGE_URL}/restart`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ logout: Boolean(req.body && req.body.logout) }),
            signal: AbortSignal.timeout(10000)
        });
        res.json(await r.json());
    } catch (e) {
        res.status(502).json({ success: false, error: 'El wa-bridge no responde' });
    }
});

// Configuración: entorno (secretos enmascarados) + runtime (editable)
app.get('/api/config', async (req, res) => {
    try {
        let runtime = [];
        let runtimeError = null;
        try {
            runtime = await listarBotConfig();
        } catch (e) {
            runtimeError = e.message;
        }
        res.json({ success: true, env: resumenSeguro(), runtime, runtimeError });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/config', async (req, res) => {
    const { clave, valor } = req.body || {};
    if (!clave) return res.status(400).json({ success: false, error: 'Falta clave' });
    try {
        await setBotConfig(clave, valor);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Usuarios del bot (autorización por número de WhatsApp)
app.get('/api/bot/usuarios', async (req, res) => {
    try {
        const { data, error } = await getSupabase()
            .from('bot_usuarios').select('*').order('created_at', { ascending: false });
        if (error) throw new Error(error.message);
        res.json({ success: true, usuarios: data || [] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/bot/usuarios', async (req, res) => {
    const { telefono, nombre, rol } = req.body || {};
    const tel = String(telefono || '').replace(/[^0-9]/g, '');
    if (!tel || !nombre) return res.status(400).json({ success: false, error: 'Faltan telefono y nombre' });
    try {
        const { error } = await getSupabase().from('bot_usuarios').upsert(
            { telefono: tel, nombre, rol: rol || 'Terreno', activo: true },
            { onConflict: 'telefono' }
        );
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Catálogo de herramientas dinámicas (el bot se las auto-escribe; aquí solo se observan/borran)
app.get('/api/bot/tools', async (req, res) => {
    try {
        const { data, error } = await getSupabase()
            .from('bot_tools_dinamicas')
            .select('nombre_funcion, descripcion, usos, creada_por, created_at')
            .order('created_at', { ascending: false });
        if (error) throw new Error(error.message);
        res.json({ success: true, tools: data || [] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete('/api/bot/tools/:nombre', async (req, res) => {
    try {
        const { error } = await getSupabase()
            .from('bot_tools_dinamicas')
            .delete()
            .eq('nombre_funcion', req.params.nombre);
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.patch('/api/bot/usuarios/:telefono', async (req, res) => {
    const tel = String(req.params.telefono || '').replace(/[^0-9]/g, '');
    const cambios = {};
    if (req.body.activo !== undefined) cambios.activo = Boolean(req.body.activo);
    if (req.body.nombre) cambios.nombre = req.body.nombre;
    if (req.body.rol) cambios.rol = req.body.rol;
    try {
        const { error } = await getSupabase().from('bot_usuarios').update(cambios).eq('telefono', tel);
        if (error) throw new Error(error.message);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Ruta visual de la Guía
app.get('/guia/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'guia.html'));
});

// =================================================================
// LUKE REALTIME — PILOTO SPOOL (GPT Realtime WebRTC — GA Unified)
// Flujo: Navegador → SDP offer → Backend → POST /v1/realtime/calls
//        → SDP answer → Navegador → WebRTC conectado
// =================================================================
app.get(['/realtime', '/realtime.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'realtime.html'));
});

// Acepta el SDP offer del navegador como texto plano
app.use('/api/realtime/session', express.text({ type: ['application/sdp', 'text/plain'] }));

app.post('/api/realtime/session', async (req, res) => {
    if (!CONFIG.OPENAI_API_KEY) {
        return res.status(500).send('OPENAI_API_KEY no está configurada en el servidor (.env).');
    }

    const sdpOffer = req.body;
    if (!sdpOffer || typeof sdpOffer !== 'string' || sdpOffer.length < 10) {
        return res.status(400).send('SDP offer inválido o vacío.');
    }

    // Configuración de la sesión Realtime (modelo, voz, instrucciones, tools)
    const sessionConfig = JSON.stringify({
        type: 'realtime',
        model: CONFIG.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1-mini',
        audio: {
            output: { voice: CONFIG.OPENAI_REALTIME_VOICE || 'ash' }
        },
        instructions: `Eres Luke, asistente de terreno de IWP en proyecto Andina.
Ayudas a trabajadores de montaje industrial a consultar información de spools.
Responde en español, de manera natural, breve y clara.
Cuando el usuario solicite información sobre un spool, utiliza la herramienta buscar_spool.
Nunca inventes información.
Utiliza exclusivamente la información proporcionada por las herramientas.
Mantén el contexto de la conversación.
Si el usuario hace una pregunta relacionada con el spool que acabamos de consultar, entiende que se refiere al mismo spool.
Las respuestas deben ser breves porque el usuario está trabajando en terreno y escucha las respuestas mediante audio.`,
        tools: [
            {
                type: 'function',
                name: 'buscar_spool',
                description: 'Busca información operacional y técnica de un spool del proyecto.',
                parameters: {
                    type: 'object',
                    properties: {
                        spool_id: {
                            type: 'string',
                            description: 'Número o TAG de gestión del spool a consultar (ejemplo: "245" o "SPOOL-245").'
                        }
                    },
                    required: ['spool_id']
                }
            }
        ]
    });

    try {
        // Construir multipart form: sdp + session config
        const formData = new FormData();
        formData.set('sdp', sdpOffer);
        formData.set('session', sessionConfig);

        console.log('[Realtime] Enviando SDP offer a OpenAI /v1/realtime/calls...');

        const response = await fetch('https://api.openai.com/v1/realtime/calls', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`,
            },
            body: formData,
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('[Realtime SDP Error]', response.status, errText);
            return res.status(response.status).send(errText);
        }

        // Devolver el SDP answer al navegador
        const sdpAnswer = await response.text();
        console.log('[Realtime] SDP answer recibida de OpenAI, enviando al navegador.');
        res.type('application/sdp').send(sdpAnswer);

    } catch (e) {
        console.error('[Realtime Session Exception]', e.message);
        res.status(500).send(e.message);
    }
});

// SPA fallback (Dashboard principal / Error 404 handler)
app.get('{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Andina Dashboard running on http://localhost:${PORT}`);
    precalentarCache(); // caché caliente desde el arranque (sin bloquear el listen)
});
