const express = require('express');
const path = require('path');
const fs = require('fs');
const { CONFIG, resumenSeguro } = require('./config');
const { fetchAppSheet, invalidarCache } = require('./lib/appsheet');
const { crearToken, permisosDeClave, requerirPermiso, TTL_HORAS } = require('./lib/auth');
const app = express();
const PORT = CONFIG.PORT;

app.use(express.static(__dirname));
app.use(express.json({ limit: '50mb' })); // JSON en POST (audios del bot vienen en base64)

// Caché en memoria para optimizar peticiones y consumo de cuota
const cache = {};
const CACHE_TTL = 30 * 1000; // 30 segundos

// Endpoint proxy genérico para las tablas de AppSheet
app.get('/api/data/:tableName', async (req, res) => {
    const { tableName } = req.params;
    const now = Date.now();

    if (cache[tableName] && (now - cache[tableName].timestamp < CACHE_TTL)) {
        console.log(`[Cache Hit] Sirviendo ${tableName} desde caché`);
        return res.json(cache[tableName].data);
    }

    try {
        console.log(`[Cache Miss] Consultando ${tableName} directamente a AppSheet`);
        const data = await fetchAppSheet(tableName);
        cache[tableName] = {
            timestamp: now,
            data: data
        };
        res.json(data);
    } catch (error) {
        console.error(`[Error Proxy] Error al consultar ${tableName}:`, error.message);
        if (cache[tableName]) {
            console.log(`[Cache Fallback] Retornando datos expirados de ${tableName} debido al error`);
            return res.json(cache[tableName].data);
        }
        res.status(500).json({ error: error.message });
    }
});

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

        res.json({
            spool_id:  spoolId,
            guids:     normalizedElements.map(el => el.guid).filter(Boolean),
            elements:  normalizedElements,
            metadata:  spoolMeta || null
        });

    } catch (e) {
        console.error('[BIM Spool Error]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/bim/statuses → Devuelve un mapeo de { [status]: [guid1, guid2, ...] }
app.get('/api/bim/statuses', async (req, res) => {
    try {
        // 1. Obtener todas las tablas necesarias
        const [rawBim, spools, logs] = await Promise.all([
            fetchAppSheet('LIST_Bim_MS'),
            fetchAppSheet('LIST_Spools_MS_'),
            fetchAppSheet('LOG_Spool_MS')
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
        const tagToIdSpool = {};
        spools.forEach(s => {
            const idSpool = String(s['ID_SPOOL'] || '').trim();
            const tagG    = String(s['TAG GESTION'] || '').trim();
            if (tagG && idSpool) {
                tagToIdSpool[tagG] = idSpool;
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
            const s = st.toUpperCase().trim();
            if (s.includes('FABRICA')) return 'EN FABRICACIÓN';
            if (s.includes('QAQC') || s.includes('QA/QC')) return 'QAQC';
            if (s.includes('PINT') || s.includes('REVEST')) return 'EN PINT/REVEST.';
            if (s.includes('RETIRAR')) return 'RETIRAR';
            if (s.includes('POR MONTAR') || s.includes('POR_MONTAR')) return 'POR MONTAR';
            if (s.includes('POSICIONADO')) return 'POSICIONADO';
            if (s.includes('MONTADO') || s.includes('MONTAJE')) return 'MONTADO';
            if (s.includes('ELIMINADO')) return 'ELIMINADO';
            return s;
        }

        const spoolStatuses = {}; // ID_SPOOL -> { status, weight }
        logs.forEach(r => {
            const id = String(r.ID_SPOOL || r['ID_SPOOL '] || '').trim();
            const st = String(r.STATUS || r['STATUS '] || '').trim();
            if (!id || !st) return;
            const w = getStatusWeight(st);
            const prev = spoolStatuses[id];
            if (!prev || w > prev.weight) {
                spoolStatuses[id] = { status: normalizeStatus(st), weight: w };
            }
        });

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

        bimRows.forEach(row => {
            const guid = String(row['Elemento GUID'] || '').trim();
            if (!guid) return;

            const tagG = String(row['SPOOL LUKEAPP'] || '').trim();
            const idSpool = tagToIdSpool[tagG] || tagG; // fallback al tag si no se mapea
            const statusEntry = spoolStatuses[idSpool];
            const status = statusEntry ? statusEntry.status : 'SIN ESTADO';

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
                    "DESCRIPCIÓN": existingRow["DESCRIPCIÓN"] || el.descripcion || el.name || "",
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
                    "DESCRIPCIÓN": el.descripcion || el.name || "",
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
                    "DESCRIPCIÓN": existingRow["DESCRIPCIÓN"] || "",
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
// BOT WHATSAPP (wa-bridge Baileys + Gemini) Y PANEL DE CONFIGURACIÓN
// =================================================================
const { handleWhatsappIncoming } = require('./lib/bot');
const { listarBotConfig, setBotConfig } = require('./lib/botConfig');
const { getSupabase } = require('./lib/supabase');

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
        res.json(await r.json());
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

// SPA fallback (Dashboard principal / Error 404 handler)
app.get('{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Andina Dashboard running on http://localhost:${PORT}`);
});
