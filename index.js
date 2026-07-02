const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = 3005;

// Configuración API AppSheet
const APPSHEET_CONFIG = {
    appId: 'eb4713b6-0828-4993-b5e1-935eec83cf4e',
    accessKey: 'V2-b9qXt-SY9es-eDDQb-L2lXN-NIInJ-U0DvZ-5fa2N-4huez'
};

app.use(express.static(__dirname));
app.use(express.json()); // Habilitar lectura de JSON en peticiones POST


/**
 * Función genérica para consultar AppSheet
 */
async function fetchAppSheet(tableName, action = "Find", rows = []) {
    const url = `https://api.appsheet.com/api/v2/apps/${APPSHEET_CONFIG.appId}/tables/${tableName}/Action`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'ApplicationAccessKey': APPSHEET_CONFIG.accessKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            Action: action,
            Properties: { Locale: "es-ES" },
            Rows: rows
        })
    });
    if (!response.ok) throw new Error(`AppSheet Error: ${response.status}`);
    return await response.json();
}

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
    clientId:     '9InGA6qs4s4myHpKk1vzEoOxmzDGL6qdEis3Ze0nXHUUP2Ru',
    clientSecret: '1T6qha9Y0KArOzbxc2J4MxrYAFVutFUrHykK55mtAEuKLRaMPFwy4naEyJ6frWt1',
    // "ANDINA 29-03-26.nwd" — Proyecto MODELOS PARA VCAD | Últ. mod: 2026-03-29 | Versión 1
    modelUrn: 'dXJuOmFkc2sud2lwcHJvZDpmcy5maWxlOnZmLnpaNmpTZVNxVGNhS3Q1Z0QxaWprcHc_dmVyc2lvbj0x'
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

// POST /api/bim/vincular → Vincula uno o múltiples Elementos GUID a un SPOOL LUKEAPP en AppSheet (LIST_Bim_MS)
app.post('/api/bim/vincular', async (req, res) => {
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

        console.log(`[BIM] Guardando en AppSheet (LIST_Bim_MS): ${elements.length} vinculaciones para Spool "${finalSpoolTag}"`);
        
        // Mapear cada elemento a la estructura de la fila de AppSheet
        const rows = elements.map(el => ({
            "Elemento GUID": el.guid,
            "SPOOL LUKEAPP": finalSpoolTag,
            "CWP": el.cwp || "",
            "DESCRIPCIÓN": el.descripcion || el.name || "",
            "Line Number": el.line_number || el.layer || "",
            "TAG": el.tag || el.layer || "",
            "AutoCad Size": el.autocad_size || ""
        }));

        // Enviar la inserción en bloque (batch)
        const result = await fetchAppSheet('LIST_Bim_MS', 'Add', rows);
        res.json({ success: true, count: rows.length, result });
    } catch (e) {
        console.error('[BIM Vincular Error]', e.message);
        res.status(500).json({ error: e.message });
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
