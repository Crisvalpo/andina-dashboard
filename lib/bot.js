/**
 * Cerebro del bot WhatsApp del Dashboard Andina.
 * Recibe los mensajes desde el wa-bridge (Baileys), los procesa con Gemini
 * y registra avances de spools directamente en AppSheet (LOG_Spool_MS).
 * Memoria conversacional y usuarios en Supabase local (esquema 'andina').
 */
const crypto = require('crypto');
const { CONFIG } = require('../config');
const { fetchAppSheet, fetchAppSheetCached, invalidarCache } = require('./appsheet');
const { getSupabase } = require('./supabase');
const { getBotConfig } = require('./botConfig');
const { procesarMensaje, sintetizarVoz } = require('./gemini');
const { consultaAvanzada } = require('./botTools');
const { crearTokenSesion } = require('./auth');

/**
 * ID hex de 8 chars seguro para Sheets: un hex como "958e250f" puede ser
 * interpretado como notación científica (9.58E+250) al escribirlo vía API.
 * Regeneramos hasta que contenga una letra que no sea 'e' intermedia numérica.
 */
function idHex8() {
    let id;
    do {
        id = crypto.randomBytes(4).toString('hex');
    } while (/^\d+e\d+$/i.test(id) || /^\d+$/.test(id));
    return id;
}

// ================================================================
// MENSAJERÍA (via wa-bridge)
// ================================================================
function waBridgeHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (CONFIG.WA_BRIDGE_SECRET) headers['x-wa-bridge-secret'] = CONFIG.WA_BRIDGE_SECRET;
    return headers;
}

async function enviarMensajeWhatsApp(jid, phone, texto, conVoz = false) {
    const dest = jid || `${phone}@s.whatsapp.net`;
    let audioBase64 = null;

    // Sintetizar voz solo para respuestas cortas sin links ni listas largas
    const contieneLink = /https?:\/\//.test(texto);
    const esLargo = texto.length > 350 || texto.split('\n').length > 6;
    if (conVoz && !contieneLink && !esLargo) {
        try {
            audioBase64 = await sintetizarVoz(texto);
        } catch (e) {
            console.error('[bot] Error TTS:', e.message);
        }
    }

    try {
        await fetch(`${CONFIG.WA_BRIDGE_URL}/send`, {
            method: 'POST',
            headers: waBridgeHeaders(),
            body: JSON.stringify({
                to: dest,
                text: audioBase64 ? '' : texto,
                audioBase64: audioBase64 || null
            })
        });
    } catch (e) {
        console.error('[bot] Error enviando via bridge:', e.message);
    }
}

/** Envía un documento o imagen por WhatsApp (el bridge descarga la URL). */
async function enviarArchivoWhatsApp(jid, phone, { fileUrl, fileName, mimetype, caption, tipo }) {
    const dest = jid || `${phone}@s.whatsapp.net`;
    try {
        const r = await fetch(`${CONFIG.WA_BRIDGE_URL}/send`, {
            method: 'POST',
            headers: waBridgeHeaders(),
            body: JSON.stringify({ to: dest, fileUrl, fileName, mimetype, caption, tipo })
        });
        const d = await r.json().catch(() => ({}));
        return d.success !== false;
    } catch (e) {
        console.error('[bot] Error enviando archivo via bridge:', e.message);
        return false;
    }
}

/**
 * Convierte los marcadores [[FOTO|Tabla|ruta]] que emite el agente de consultas
 * en imágenes REALES de WhatsApp (vía gettablefileurl) y limpia el texto.
 */
async function procesarMarcadoresFoto(texto, jid, telefono) {
    const rx = /\[\[FOTO\|([^|\]]+)\|([^\]]+)\]\]/g;
    const fotos = [];
    let m;
    while ((m = rx.exec(texto)) !== null && fotos.length < 5) {
        fotos.push({ tabla: m[1].trim(), ruta: m[2].trim() });
    }
    if (!fotos.length) return texto;

    for (const f of fotos) {
        const url = urlArchivoAppSheet(f.tabla, f.ruta);
        if (url) await enviarArchivoWhatsApp(jid, telefono, { fileUrl: url, caption: '', tipo: 'image' });
    }
    let limpio = texto.replace(rx, '').replace(/^[ \t]*[\*\-•][ \t]*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    if (!limpio) limpio = `📷 Te envié ${fotos.length} foto(s).`;
    return limpio;
}

/** URL pública de un archivo almacenado por AppSheet (PDFs de ISOs, fotos de terreno). */
function urlArchivoAppSheet(tabla, rutaArchivo) {
    const ruta = String(rutaArchivo || '').trim();
    if (!ruta) return null;
    if (/^https?:\/\//.test(ruta)) return ruta;
    return `https://www.appsheet.com/template/gettablefileurl?appName=${CONFIG.APPSHEET_APP_ID}&tableName=${encodeURIComponent(tabla)}&fileName=${encodeURIComponent(ruta)}`;
}

async function enviarPresencia(jid, phone, grabando = false) {
    try {
        await fetch(`${CONFIG.WA_BRIDGE_URL}/presence`, {
            method: 'POST',
            headers: waBridgeHeaders(),
            body: JSON.stringify({
                to: jid || `${phone}@s.whatsapp.net`,
                state: grabando ? 'recording' : 'composing'
            })
        }).catch(() => {});
    } catch (e) { /* no crítico */ }
}

// ================================================================
// PERSISTENCIA (Supabase esquema 'andina')
// ================================================================
async function buscarUsuario(telefono) {
    const supabase = getSupabase();
    const { data } = await supabase
        .from('bot_usuarios')
        .select('*')
        .eq('telefono', telefono)
        .maybeSingle();
    return data;
}

async function registrarUsuarioPendiente(telefono, nombre) {
    const supabase = getSupabase();
    await supabase.from('bot_usuarios').upsert(
        { telefono, nombre: nombre || 'Desconocido', activo: false },
        { onConflict: 'telefono', ignoreDuplicates: true }
    );
}

// Mapeo del ROL de la app AppSheet al rol del bot
const ROL_APP_A_BOT = {
    'ADMIN': 'Admin', 'SUPERVISOR': 'Supervisor', 'TERRENO': 'Terreno',
    'OT': 'OT', 'QAQC': 'QAQC', 'LOGISTICA': 'Logistica', 'SOLO LECTURA': 'Solo Lectura'
};

/**
 * Auto-autorización: si el número que escribe está en LIST_usuariosApp_MS
 * (columna WHATSAPP), se registra activo automáticamente heredando su ROL real.
 * Los números de la app pueden venir sin código país (963375742) → match por sufijo.
 */
async function autoAutorizarDesdeApp(telefono, pushName) {
    try {
        const usuariosApp = await fetchAppSheetCached('LIST_usuariosApp_MS');
        const norm = s => String(s || '').replace(/[^0-9]/g, '');
        const tel = norm(telefono);

        const hit = usuariosApp.find(u => {
            const w = norm(u['WHATSAPP']);
            return w.length >= 8 && (tel.endsWith(w) || w.endsWith(tel));
        });
        if (!hit) return null;

        const rolApp = String(hit['ROL'] || '').trim().toUpperCase();
        const rol = ROL_APP_A_BOT[rolApp] || 'Terreno';
        const nombre = String(hit['USUARIO'] || pushName || 'Usuario App').trim();

        const supabase = getSupabase();
        await supabase.from('bot_usuarios').upsert(
            { telefono, nombre, rol, activo: true },
            { onConflict: 'telefono' }
        );
        console.log(`[bot] ✨ Auto-autorizado desde LIST_usuariosApp: ${nombre} (${rol})`);
        return { telefono, nombre, rol, activo: true };
    } catch (e) {
        console.error('[bot] Error en auto-autorización:', e.message);
        return null;
    }
}

async function guardarMensaje(telefono, emisor, mensaje, tipo = 'texto', metadata = {}) {
    const supabase = getSupabase();
    await supabase.from('bot_mensajes').insert({ telefono, emisor, mensaje, tipo, metadata });
}

async function cargarHistorial(telefono, limite = 10) {
    const supabase = getSupabase();
    const { data } = await supabase
        .from('bot_mensajes')
        .select('emisor, mensaje')
        .eq('telefono', telefono)
        .order('created_at', { ascending: false })
        .limit(limite);
    if (!data || !data.length) return [];
    return data.reverse().map(m => ({
        role: m.emisor === 'usuario' ? 'user' : 'model',
        parts: [{ text: m.mensaje || '' }]
    }));
}

async function guardarRegistro(registro) {
    const supabase = getSupabase();
    await supabase.from('bot_registros').insert(registro);
}

// ================================================================
// SPOOLS (AppSheet)
// ================================================================
/**
 * Resuelve un término dicho por el usuario ("511", "SP02", ID largo)
 * contra el maestro LIST_Spools_MS_.
 * @returns { encontrado, ambiguo, spool: {idSpool, idIso, tagGestion}, candidatos }
 */
async function resolverSpool(termino) {
    const term = String(termino || '').trim();
    if (!term) return { encontrado: false, ambiguo: false, candidatos: [] };

    const master = await fetchAppSheetCached('LIST_Spools_MS_');
    const t = term.toLowerCase();

    const normalizar = (m) => {
        const idSpool = String(m['ID_SPOOL'] || '').trim();
        // ID_ISO: columna directa o derivado del ID largo (todo antes del último "_")
        const idIso = String(m['ID_ISO'] || '').trim() ||
            (idSpool.includes('_') ? idSpool.substring(0, idSpool.lastIndexOf('_')) : '');
        return {
            idSpool,
            idIso,
            tagGestion: String(m['TAG GESTION'] || m['SPOOL'] || '').trim()
        };
    };

    // 1. Coincidencia exacta por TAG GESTION o ID_SPOOL
    let candidatos = master.filter(m =>
        String(m['TAG GESTION'] || '').trim().toLowerCase() === t ||
        String(m['ID_SPOOL'] || '').trim().toLowerCase() === t ||
        String(m['SPOOL'] || '').trim().toLowerCase() === t
    );

    // 1.5. Tolerancia de ceros a la izquierda para TAGs numéricos.
    // Los TAG GESTION del proyecto usan ceros (053, 068...) pero el usuario
    // (o Gemini normalizando el número) puede decir "68" → hay que igualar 68 == 068.
    if (!candidatos.length && /^\d+$/.test(t)) {
        const n = parseInt(t, 10);
        candidatos = master.filter(m => {
            const tag = String(m['TAG GESTION'] || '').trim();
            return /^\d+$/.test(tag) && parseInt(tag, 10) === n;
        });
    }

    // 2. Fallback: sufijo del ID largo (ej: "SP02" → "..._SP02")
    if (!candidatos.length) {
        candidatos = master.filter(m =>
            String(m['ID_SPOOL'] || '').trim().toLowerCase().endsWith(`_${t}`)
        );
    }

    if (!candidatos.length) return { encontrado: false, ambiguo: false, candidatos: [] };
    if (candidatos.length > 1) {
        return {
            encontrado: true,
            ambiguo: true,
            candidatos: candidatos.slice(0, 5).map(normalizar)
        };
    }
    return { encontrado: true, ambiguo: false, spool: normalizar(candidatos[0]), candidatos: [] };
}

function fechaAppSheet() {
    // Formato MM/DD/YYYY HH:mm:ss — AppSheet API usa MM/DD independiente del Locale
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: CONFIG.ZONA_HORARIA,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).formatToParts(new Date());
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    return `${p.month}/${p.day}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

function formatearFechaChile(fechaStr) {
    // AppSheet devuelve MM/DD/YYYY — convertir a DD/MM/YYYY para display chileno
    if (!fechaStr) return '—';
    const match = String(fechaStr).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (match) {
        const [, mm, dd, yyyy] = match;
        return `${dd.padStart(2,'0')}/${mm.padStart(2,'0')}/${yyyy}`;
    }
    return fechaStr;
}

async function registrarAvanceAppSheet({ spool, status, usuario, ubicacion, observacion, mts, rol }) {
    const fila = {
        'ID_LOG_SPOOL': idHex8(),
        'ID_SPOOL': spool.idSpool,
        'ID_ISO': spool.idIso,
        'TAG_SPOOL': spool.tagGestion,
        'STATUS': status,
        'UBICACION LEVANTAMIENTO': ubicacion || '',
        'SECTOR LEVANTAMIENTO': '',
        'FOTO': '',
        'OBSERVACION TERRENO': observacion || '',
        'FECHA_LEVANTAMIENTO': fechaAppSheet(),
        // MTS MONTADOS es Decimal REQUERIDO en AppSheet: '' es rechazado (400). Default '0'.
        'MTS MONTADOS': (mts !== null && mts !== undefined && mts !== '') ? String(mts) : '0',
        'USUARIO': usuario
    };
    // LOG_Spool_MS filtra por rol vía CONFIG_Permisos. TERRENO/SUPERVISOR/ADMIN/OT/QAQC
    // tienen permiso de Add; usamos TERRENO como mínimo si el usuario no tiene rol.
    const rolFinal = String(rol || 'TERRENO').toUpperCase().trim();
    const userSettings = { "Rol": rolFinal };
    const resultado = await fetchAppSheet('LOG_Spool_MS', 'Add', [fila], userSettings);
    invalidarCache('LOG_Spool_MS');
    return { fila, resultado };
}

async function consultarEstadoSpool(spool, rol = null) {
    const userSettings = rol ? { "Rol": String(rol).toUpperCase().trim() } : null;
    const logs = await fetchAppSheetCached('LOG_Spool_MS', userSettings);
    // AppSheet devuelve MM/DD/YYYY HH:mm:ss — parsear correctamente
    const parseMMDD = s => {
        const m = String(s||'').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{1,2}):?(\d{1,2})?)?/);
        if (!m) return 0;
        return new Date(+m[3], +m[1]-1, +m[2], +(m[4]||0), +(m[5]||0), +(m[6]||0)).getTime();
    };
    const registros = logs
        .filter(r => String(r['ID_SPOOL'] || '').trim() === spool.idSpool)
        .sort((a, b) => {
            const diff = parseMMDD(b['FECHA_LEVANTAMIENTO']) - parseMMDD(a['FECHA_LEVANTAMIENTO']);
            if (diff !== 0) return diff;
            // Desempate por _RowNumber (fila más alta = más reciente en AppSheet)
            return (parseInt(b._RowNumber || 0, 10)) - (parseInt(a._RowNumber || 0, 10));
        });
    return registros[0] || null;
}

// ================================================================
// VÁLVULAS Y SOPORTES (AppSheet) — Andi experto en las 3 entidades
// ================================================================
/**
 * Resuelve lo que dijo el usuario ("VAL085", "válvula 85", "85")
 * contra LIST_Valvulas_MS. El sistema pre-llena línea/NPS desde el maestro.
 */
async function resolverValvula(termino) {
    const t = String(termino || '').trim().toUpperCase();
    if (!t) return { encontrado: false };
    const master = await fetchAppSheetCached('LIST_Valvulas_MS');

    // Normalizar: "85" o "VAL85" → probar VAL085 (pad 3), VAL85 y literal
    const num = t.replace(/^VAL/i, '').replace(/[^0-9]/g, '');
    const candidatosIds = [t];
    if (num) {
        candidatosIds.push(`VAL${num.padStart(3, '0')}`, `VAL${num}`);
    }

    for (const id of candidatosIds) {
        const hit = master.find(m => String(m['ID_VALVULA'] || '').trim().toUpperCase() === id);
        if (hit) {
            return {
                encontrado: true,
                valvula: {
                    id: String(hit['ID_VALVULA']).trim(),
                    linea: String(hit['ID_LINEA'] || '').trim(),
                    nps: String(hit['DIAM.'] || '').trim(),
                    clase: String(hit['CLASE'] || '').trim(),
                    descripcion: String(hit['DESCRIPCION'] || '').trim()
                }
            };
        }
    }
    return { encontrado: false };
}

/**
 * Resuelve un soporte por ITEM ("148") o ID_Soporte completo
 * contra LIST_Soportes_MS. Pre-llena línea/tipo desde el maestro.
 */
async function resolverSoporte(termino) {
    const t = String(termino || '').trim().toLowerCase();
    if (!t) return { encontrado: false };
    const master = await fetchAppSheetCached('LIST_Soportes_MS');

    const num = t.replace(/[^0-9]/g, '');
    const hit = master.find(m =>
        String(m['ID_Soporte'] || '').trim().toLowerCase() === t ||
        (num && String(m['ITEM'] || '').trim() === num)
    );
    if (!hit) return { encontrado: false };
    return {
        encontrado: true,
        soporte: {
            id: String(hit['ID_Soporte']).trim(),
            item: String(hit['ITEM'] || '').trim(),
            linea: String(hit['ID_LINEA'] || '').trim(),
            tipo: String(hit['ID_TipoSoporte'] || '').trim(),
            diam: String(hit['DIAM.'] || '').trim()
        }
    };
}

/**
 * Último registro de montaje de una válvula/soporte.
 *
 * Devuelve el MÁS RECIENTE por fecha, no el primero que aparezca: una válvula
 * puede tener varios reportes (posicionada y luego montada) y el orden de las
 * filas de AppSheet es arbitrario. Mismo criterio que usa el dashboard.
 */
async function montajeExistente(capa, id, rol = null) {
    const tabla    = capa === 'valvula' ? 'REG_MontajeValvulas_MS' : 'REG_MontajeSoportes_MS';
    const key      = capa === 'valvula' ? 'ID_VALVULA' : 'ID_Soporte';
    const colFecha = capa === 'valvula' ? 'fecha' : 'Fecha';   // ojo: distinta caja en cada tabla
    const userSettings = rol ? { "Rol": String(rol).toUpperCase().trim() } : null;
    const rows = await fetchAppSheetCached(tabla, userSettings).catch(() => []);

    const propias = rows.filter(r => String(r[key] || '').trim().toLowerCase() === id.toLowerCase());
    if (!propias.length) return null;
    return propias.reduce((mejor, r) => {
        const f = Date.parse(String(r[colFecha] || '').trim().replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$1-$2')) || 0;
        const fm = Date.parse(String(mejor[colFecha] || '').trim().replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$1-$2')) || 0;
        if (f > fm) return r;
        if (f < fm) return mejor;
        return (parseInt(r._RowNumber || 0, 10) > parseInt(mejor._RowNumber || 0, 10)) ? r : mejor;
    });
}

/**
 * Posición de un estado de válvula dentro de la progresión configurada.
 * El ORDEN de `estados_valvula_permitidos` ES la progresión: no hay tabla de
 * pesos aparte que se pueda desincronizar de la lista.
 * 0 = desconocido (no bloquea, porque puede venir de un flujo externo).
 */
function pesoEstadoValvula(estado, permitidos) {
    const e = String(estado || '').trim().toLowerCase();
    if (!e) return 0;
    const i = permitidos.findIndex(p => p.toLowerCase() === e);
    return i === -1 ? 0 : i + 1;
}

/**
 * Registra montaje de válvula en REG_MontajeValvulas_MS (pre-llenado desde maestro).
 * El estado ya no es fijo: una válvula pasa por etapas (Posicionada → Montada) y
 * el bot debe poder reportar cualquiera de ellas.
 */
async function registrarMontajeValvula({ valvula, hoja, usuario, rol, status }) {
    const fila = {
        'ID_MontajeValvula': idHex8(),
        'ID_VALVULA': valvula.id,
        'ID_LINEA': valvula.linea,
        'Hoja': hoja || '',
        'Status': status || 'Montada',
        'NPS': valvula.nps,
        'fecha': fechaAppSheet(),
        'FotoTerreno': '',
        'usuarioReporte': usuario
    };
    const userSettings = { "Rol": String(rol || 'TERRENO').toUpperCase().trim() };
    const resultado = await fetchAppSheet('REG_MontajeValvulas_MS', 'Add', [fila], userSettings);
    invalidarCache('REG_MontajeValvulas_MS');
    return { fila, resultado };
}

// ================================================================
// CONFIRMACIÓN PREVIA + REPORTE MASIVO
// El bot NUNCA escribe sin que el usuario confirme el resumen con un "sí".
// ================================================================
const PENDIENTE_TTL_MIN = 15;

async function guardarPendiente(telefono, items, resumen) {
    const supabase = getSupabase();
    await supabase.from('bot_confirmaciones').upsert(
        { telefono, items, resumen, created_at: new Date().toISOString() },
        { onConflict: 'telefono' }
    );
}

async function obtenerPendiente(telefono) {
    const supabase = getSupabase();
    const { data } = await supabase.from('bot_confirmaciones').select('*').eq('telefono', telefono).maybeSingle();
    if (!data) return null;
    const edadMin = (Date.now() - new Date(data.created_at).getTime()) / 60000;
    if (edadMin > PENDIENTE_TTL_MIN) {
        await borrarPendiente(telefono);
        return null;
    }
    return data;
}

async function borrarPendiente(telefono) {
    const supabase = getSupabase();
    await supabase.from('bot_confirmaciones').delete().eq('telefono', telefono);
}

/**
 * Enriquece un nombre de persona contra CAT_Personal_MS (agrega estampa/cargo).
 * NOTA: las columnas Soldador/Responsable de REG_MontajeSoportes son Ref con
 * Valid_If que rechaza TODA escritura vía API (probado: nombre, ID, estampa).
 * Por eso el dato se registra en ObservacionMontaje — no se pierde.
 */
async function resolverPersona(nombre) {
    if (!nombre) return null;
    const personal = await fetchAppSheetCached('CAT_Personal_MS').catch(() => []);
    const t = String(nombre).trim().toLowerCase();
    const hit = personal.find(p => {
        const n = String(p['NOMBRES APELLIDOS'] || '').trim().toLowerCase();
        return n === t || n.includes(t) || t.includes(n);
    });
    if (hit) {
        const estampa = String(hit['ESTAMPA'] || '').trim();
        return `${String(hit['NOMBRES APELLIDOS']).trim()}${estampa ? ` (${estampa})` : ''}`;
    }
    return String(nombre).trim();
}

/**
 * Valida los ítems capturados por Gemini contra los maestros.
 * Devuelve ítems listos para ejecutar + errores + resumen para confirmar.
 */
async function validarItems(itemsIA, usuario, botConf) {
    const validados = [];
    const errores = [];
    const estadosPermitidos = (botConf.estados_permitidos || '')
        .split(',').map(s => s.trim().toLowerCase());
    // El ORDEN de esta lista es la progresión de etapas de una válvula
    const estadosValvula = (botConf.estados_valvula_permitidos || 'Posicionada,Montada')
        .split(',').map(s => s.trim()).filter(Boolean);

    for (const it of (itemsIA || [])) {
        const entidad = it.entidad || 'spool';
        const idDicho = String(it.item || '').trim();
        if (!idDicho) continue;

        if (entidad === 'valvula') {
            const r = await resolverValvula(idDicho);
            if (!r.encontrado) { errores.push(`❌ Válvula "${idDicho}": no existe en el maestro`); continue; }
            // Estado dicho por el usuario; si no lo dijo, la última etapa (Montada)
            const statusV = estadosValvula.find(e => e.toLowerCase() === String(it.status || '').trim().toLowerCase())
                || (it.status ? null : estadosValvula[estadosValvula.length - 1]);
            if (!statusV) {
                errores.push(`⚠️ Válvula ${r.valvula.id}: estado "${it.status}" no habilitado (disponibles: ${estadosValvula.join(', ')})`); continue;
            }

            // Anti-duplicados por ETAPA: antes cualquier registro previo bloqueaba,
            // así que una válvula posicionada no podía avanzar a montada.
            const previo = await montajeExistente('valvula', r.valvula.id, usuario.rol);
            if (previo) {
                const pPrevio = pesoEstadoValvula(previo['Status'], estadosValvula);
                const pNuevo  = pesoEstadoValvula(statusV, estadosValvula);
                if (pNuevo <= pPrevio) {
                    errores.push(`ℹ️ Válvula ${r.valvula.id}: ya registrada como ${previo['Status'] || 'Montada'} el ${formatearFechaChile(previo['fecha'])}`); continue;
                }
            }
            validados.push({
                entidad: 'valvula', valvula: r.valvula, hoja: it.hoja || null, observacion: it.observacion || null, status: statusV,
                linea: `🔧 Válvula *${r.valvula.id}* (${r.valvula.nps || '—'}, línea ${r.valvula.linea}) → *${statusV}*` + (it.hoja ? ` | Hoja ${it.hoja}` : '')
            });

        } else if (entidad === 'soporte') {
            const r = await resolverSoporte(idDicho);
            if (!r.encontrado) { errores.push(`❌ Soporte ITEM "${idDicho}": no existe en el maestro`); continue; }
            const previo = await montajeExistente('soporte', r.soporte.id, usuario.rol);
            if (previo) { errores.push(`ℹ️ Soporte ITEM ${r.soporte.item}: ya registrado el ${formatearFechaChile(previo['Fecha'])}`); continue; }
            // Soldador/Responsable son Ref no escribibles vía API → van a observación
            const soldadorTxt = it.soldador ? await resolverPersona(it.soldador) : null;
            const responsableTxt = it.responsable ? await resolverPersona(it.responsable) : null;
            const observacion = [
                it.observacion,
                it.hoja ? `Hoja ${it.hoja}` : '',
                soldadorTxt ? `Soldador: ${soldadorTxt}` : '',
                responsableTxt ? `Responsable: ${responsableTxt}` : ''
            ].filter(Boolean).join(' | ') || null;
            validados.push({
                entidad: 'soporte', soporte: r.soporte, observacion,
                linea: `🛠 Soporte *ITEM ${r.soporte.item}* (${r.soporte.tipo}, línea ${r.soporte.linea}) → *Montado*` +
                    (soldadorTxt ? ` | Soldador: ${soldadorTxt}` : '') + (responsableTxt ? ` | Resp: ${responsableTxt}` : '')
            });

        } else {
            const status = it.status;
            if (!status) { errores.push(`❌ Spool "${idDicho}": falta el estado a registrar`); continue; }
            if (!estadosPermitidos.includes(String(status).toLowerCase())) {
                errores.push(`⚠️ Spool "${idDicho}": estado "${status}" no habilitado (disponibles: ${botConf.estados_permitidos})`); continue;
            }
            const r = await resolverSpool(idDicho);
            if (!r.encontrado) { errores.push(`❌ Spool "${idDicho}": no existe en el maestro`); continue; }
            if (r.ambiguo) {
                errores.push(`⚠️ Spool "${idDicho}": coincide con varios (${r.candidatos.map(c => c.tagGestion || c.idSpool).join(', ')}) — especifica cuál`); continue;
            }
            validados.push({
                entidad: 'spool', spool: r.spool, status,
                mts: it.mts_montados ?? null, ubicacion: it.ubicacion || null, observacion: it.observacion || null,
                linea: `📦 Spool *${r.spool.tagGestion || r.spool.idSpool}* → *${status}*` +
                    (it.mts_montados ? ` | ${it.mts_montados} mts` : '') + (it.ubicacion ? ` | ${it.ubicacion}` : '')
            });
        }
    }
    return { validados, errores };
}

/** Ejecuta los registros ya confirmados. Devuelve el texto de resultado. */
async function ejecutarRegistros(validados, usuario, botConf, telefono) {
    const lineas = [];
    for (const v of validados) {
        try {
            if (v.entidad === 'valvula') {
                const { fila } = await registrarMontajeValvula({
                    valvula: v.valvula, hoja: v.hoja, status: v.status,
                    usuario: usuario.nombre || botConf.usuario_registro_defecto, rol: usuario.rol
                });
                await guardarRegistro({
                    telefono, spool_tag: v.valvula.id, id_spool: v.valvula.linea, status: v.status || 'Montada',
                    observacion: v.observacion || v.hoja, appsheet_ok: true,
                    metadata: { entidad: 'valvula', id_montaje: fila['ID_MontajeValvula'] }
                });
                lineas.push(`✅ Válvula *${v.valvula.id}* → ${(v.status || 'Montada').toLowerCase()}`);
            } else if (v.entidad === 'soporte') {
                const { fila } = await registrarMontajeSoporte({
                    soporte: v.soporte, observacion: v.observacion,
                    usuario: usuario.nombre || botConf.usuario_registro_defecto, rol: usuario.rol
                });
                await guardarRegistro({
                    telefono, spool_tag: `ITEM ${v.soporte.item}`, id_spool: v.soporte.id, status: 'Montado',
                    observacion: v.observacion, appsheet_ok: true,
                    metadata: { entidad: 'soporte', id_montaje: fila['ID_MontajeSoporte'] }
                });
                lineas.push(`✅ Soporte *ITEM ${v.soporte.item}* montado`);
            } else {
                const { fila } = await registrarAvanceAppSheet({
                    spool: v.spool, status: v.status,
                    usuario: usuario.nombre || botConf.usuario_registro_defecto,
                    ubicacion: v.ubicacion, observacion: v.observacion, mts: v.mts, rol: usuario.rol
                });
                await guardarRegistro({
                    telefono, spool_tag: v.spool.tagGestion, id_spool: v.spool.idSpool, status: v.status,
                    observacion: v.observacion, mts_montados: v.mts, appsheet_ok: true,
                    metadata: { entidad: 'spool', id_log_spool: fila['ID_LOG_SPOOL'] }
                });
                lineas.push(`✅ Spool *${v.spool.tagGestion || v.spool.idSpool}* → ${v.status}`);
            }
        } catch (e) {
            console.error(`[bot] Error registrando ${v.entidad}:`, e.message);
            lineas.push(`❌ ${v.linea.split('→')[0].trim()}: error al guardar (${e.message.substring(0, 80)})`);
        }
    }
    return lineas;
}

/** Registra montaje de soporte en REG_MontajeSoportes_MS (pre-llenado desde maestro).
 *  Soldador/Responsable NO se escriben (Ref con Valid_If anti-API): van en ObservacionMontaje. */
async function registrarMontajeSoporte({ soporte, observacion, usuario, rol }) {
    const fila = {
        'ID_MontajeSoporte': idHex8(),
        'ID_Soporte': soporte.id,
        'ID_LINEA': soporte.linea,
        'Fecha': fechaAppSheet(),
        'FotoTerreno': '',
        'ObservacionMontaje': observacion || '',
        'UsuarioReporte': usuario
    };
    const userSettings = { "Rol": String(rol || 'TERRENO').toUpperCase().trim() };
    const resultado = await fetchAppSheet('REG_MontajeSoportes_MS', 'Add', [fila], userSettings);
    invalidarCache('REG_MontajeSoportes_MS');
    return { fila, resultado };
}

// ================================================================
// HANDLER PRINCIPAL DEL WEBHOOK
// ================================================================
async function handleWhatsappIncoming(req, res) {
    // Validar secreto compartido con el bridge
    if (CONFIG.WA_BRIDGE_SECRET) {
        if (req.headers['x-wa-bridge-secret'] !== CONFIG.WA_BRIDGE_SECRET) {
            console.warn('[bot] 🚫 Secreto de bridge inválido');
            return res.status(401).json({ success: false, message: 'No autorizado' });
        }
    }

    const { phone, jid, message, audio, pushName, senderPn } = req.body || {};

    let searchPhone = senderPn || phone || '';
    searchPhone = String(searchPhone).split('@')[0].split(':')[0];
    const telefono = searchPhone.replace(/[^0-9]/g, '');

    if (!telefono) return res.status(400).json({ success: false, message: 'Falta phone' });

    // ACK inmediato: el bridge consolidado reintenta (y reprocesa) el mensaje si no
    // responde 2xx dentro de su timeout interno (10s) — el pipeline real de abajo
    // (Gemini + AppSheet + envío de WhatsApp/PDFs) puede tardar bastante más que eso,
    // así que confirmamos la recepción ya y seguimos procesando en segundo plano.
    res.status(200).json({ success: true, action: 'RECEIVED' });

    const esAudio = Boolean(audio && audio.data);
    console.log(`[bot] De: ${telefono} | ${esAudio ? '🎤 Audio' : `💬 "${(message || '').substring(0, 80)}"`}`);

    try {
        const botConf = await getBotConfig();
        enviarPresencia(jid, telefono, esAudio);

        // 1. Autorización por número. LIST_usuariosApp_MS es la FUENTE DE VERDAD:
        // se re-sincroniza rol/nombre en CADA mensaje (caché 30s — sin costo extra).
        // Cambiar un rol en AppSheet se refleja en el bot al siguiente mensaje.
        let usuario = await buscarUsuario(telefono);
        const sync = await autoAutorizarDesdeApp(telefono, pushName);
        if (sync) usuario = sync;

        if (!usuario || !usuario.activo) {
            if (String(botConf.permitir_invitados) === 'true') {
                // MODO INVITADO: solo lectura (consultas, isométricos, fotos).
                // Queda registrado como pendiente para aprobarlo después si corresponde.
                if (!usuario) await registrarUsuarioPendiente(telefono, pushName);
                usuario = { telefono, nombre: pushName || 'Invitado', rol: 'Invitado', activo: true, invitado: true };
                console.log(`[bot] 👋 Invitado: ${telefono} (${usuario.nombre})`);
            } else {
                if (!usuario) await registrarUsuarioPendiente(telefono, pushName);
                await guardarMensaje(telefono, 'usuario', message || '[audio]', esAudio ? 'audio' : 'texto', { autorizado: false });
                await enviarMensajeWhatsApp(jid, telefono, botConf.mensaje_no_autorizado, false);
                return;
            }
        }

        const responderConVoz = esAudio && String(botConf.responder_con_voz) === 'true';

        // 2. ¿Hay un registro esperando confirmación?
        const pendiente = await obtenerPendiente(telefono);

        // Shortcut sin IA: respuesta corta de texto a la confirmación pendiente
        if (pendiente && !esAudio && message && !usuario.invitado) {
            const txt = message.trim().toLowerCase();
            const esSi = /^(s[ií]+\b|s[ií] ?po|sipo|confirmo|confirmar|dale|ok(ey)?|listo|correcto|afirmativo|ya\b|regis?tra(lo)?s?)/.test(txt);
            const esNo = /^(no+\b|cancela|cancelar|anula|olv[ií]da|nada)/.test(txt);

            if (esSi || esNo) {
                await guardarMensaje(telefono, 'usuario', message, 'texto', { confirmacion: esSi });
                let respuestaC, actionC;
                if (esSi) {
                    const lineas = await ejecutarRegistros(pendiente.items, usuario, botConf, telefono);
                    respuestaC = `🧾 *Registro completado*\n\n${lineas.join('\n')}\n\n👤 ${usuario.nombre}`;
                    actionC = 'REGISTROS_EJECUTADOS';
                } else {
                    respuestaC = '👍 Registro cancelado. No se guardó nada.';
                    actionC = 'REGISTRO_CANCELADO';
                }
                await borrarPendiente(telefono);
                await enviarMensajeWhatsApp(jid, telefono, respuestaC, false);
                await guardarMensaje(telefono, 'bot', respuestaC, 'texto', { action: actionC });
                return;
            }
        }

        // 3. Procesar con Gemini (texto o audio) + memoria + contexto de pendiente
        const historial = await cargarHistorial(telefono, parseInt(botConf.max_historial || '10', 10));
        const ia = await procesarMensaje({
            texto: message,
            audio: esAudio ? audio : null,
            historial,
            botConf,
            contexto: {
                nombre_usuario: usuario.nombre,
                rol_usuario: usuario.rol,
                pendiente_resumen: pendiente ? pendiente.resumen : null
            }
        });

        const textoUsuario = ia.transcripcion || message || '[audio]';
        await guardarMensaje(telefono, 'usuario', textoUsuario, esAudio ? 'audio' : 'texto', { intencion: ia.intencion });

        let respuesta = ia.respuesta_bot || 'No logré entender tu mensaje, ¿puedes repetirlo?';
        let action = ia.intencion || 'OTRO';

        // 4. Rutear según intención
        // Items capturados (soporta reporte masivo). Compat con schema plano antiguo.
        const items = Array.isArray(ia.items) ? [...ia.items] : [];
        if (!items.length && (ia.item || ia.spool)) {
            items.push({
                entidad: ia.entidad || 'spool', item: ia.item || ia.spool, status: ia.status,
                mts_montados: ia.mts_montados, ubicacion: ia.ubicacion, observacion: ia.observacion,
                hoja: ia.hoja, soldador: ia.soldador, responsable: ia.responsable
            });
        }
        const primer = items[0] || {};
        let confirmacionEnTexto = false;

        if (usuario.invitado && ['REGISTRAR_AVANCE', 'CONFIRMAR_REGISTRO', 'SESION_ESCANEO'].includes(ia.intencion)) {
            // Invitados: SOLO lectura. Nada de escrituras en AppSheet.
            respuesta = '👋 Estás en *modo visita*: puedo mostrarte estados de spools, válvulas y soportes, isométricos y fotos.\n\nPara *reportar avances* necesitas estar registrado en el proyecto — solicita acceso al administrador.';
            action = 'INVITADO_BLOQUEADO';

        } else if (ia.intencion === 'SESION_ESCANEO') {
            // Reporte por LOTES: genera una sesión tokenizada (hereda la identidad
            // del usuario) y le manda el link a la página de escaneo de QR.
            const token = crearTokenSesion({ telefono, nombre: usuario.nombre, rol: usuario.rol });
            const link = `${CONFIG.PUBLIC_URL}/escanear?t=${encodeURIComponent(token)}`;
            respuesta = `📷 *Modo escaneo de lote*\n\nAbre este enlace y escanea los QR de los spools uno tras otro; al final eliges el estado para todos:\n\n${link}\n\n⏱ Válido por 4 horas. Escanea el TAG o el ID_SPOOL, da igual.`;
            action = 'SESION_ESCANEO';

        } else if (ia.intencion === 'CONFIRMAR_REGISTRO' && pendiente) {
            const lineas = await ejecutarRegistros(pendiente.items, usuario, botConf, telefono);
            await borrarPendiente(telefono);
            respuesta = `🧾 *Registro completado*\n\n${lineas.join('\n')}\n\n👤 ${usuario.nombre}`;
            action = 'REGISTROS_EJECUTADOS';

        } else if (ia.intencion === 'CANCELAR_REGISTRO' && pendiente) {
            await borrarPendiente(telefono);
            respuesta = '👍 Registro cancelado. No se guardó nada.';
            action = 'REGISTRO_CANCELADO';

        } else if (ia.intencion === 'REGISTRAR_AVANCE' && items.length) {
            // NUNCA se escribe directo: se valida, se muestra lo comprendido
            // (clave si el mensaje vino por VOZ) y se pide confirmar con un "sí".
            const { validados, errores } = await validarItems(items, usuario, botConf);

            if (!validados.length) {
                respuesta = `No pude preparar el registro:\n\n${errores.join('\n')}`;
                action = 'REGISTRO_INVALIDO';
                await borrarPendiente(telefono);
            } else {
                const resumen = `🧾 *Ok, esto es lo que entendí. Confirma el registro:*\n\n${validados.map(v => `• ${v.linea}`).join('\n')}` +
                    (errores.length ? `\n\n*No se incluirán:*\n${errores.join('\n')}` : '') +
                    `\n\n👤 Reporta: ${usuario.nombre}\n\nResponde *sí* para guardar, *no* para cancelar, o corrige/agrega datos (hoja, observación, soldador, metros...).`;
                await guardarPendiente(telefono, validados, resumen);
                respuesta = resumen;
                action = 'CONFIRMACION_PENDIENTE';
                confirmacionEnTexto = true; // la validación va SIEMPRE como mensaje de texto
            }

        } else if (['CONSULTA_GENERAL', 'OTRO'].includes(ia.intencion) &&
                   (botConf.roles_consulta_avanzada || 'Supervisor,Admin')
                       .split(',').map(s => s.trim().toLowerCase())
                       .includes(String(usuario.rol || '').toLowerCase())) {
            // Supervisores/Admins: consultas libres sobre el mapa del mundo.
            // Gemini se auto-escribe la herramienta si la consulta no existe aún.
            try {
                respuesta = await consultaAvanzada({
                    texto: textoUsuario,
                    historial,
                    usuario,
                    botConf
                });
                // Fotos marcadas [[FOTO|tabla|ruta]] → se envían como imágenes reales
                respuesta = await procesarMarcadoresFoto(respuesta, jid, telefono);
                action = 'CONSULTA_AVANZADA';
            } catch (e) {
                console.error('[bot] Error en consulta avanzada:', e.message);
                // Mantener la respuesta conversacional simple de la primera pasada
            }
        } else if (ia.intencion === 'CONSULTA_GENERAL') {
            // Usuario sin rol de consulta avanzada
            respuesta = 'Esa consulta de datos amplia está disponible solo para supervisores. Puedo ayudarte a registrar un avance ("registra el montaje del spool 511") o consultar el estado de un spool específico.';
            action = 'CONSULTA_NO_AUTORIZADA';
        } else if (['CONSULTAR_ITEM', 'CONSULTAR_SPOOL'].includes(ia.intencion) && primer.item) {
            const itemDicho = primer.item;
            const entidad = primer.entidad || 'spool';

            if (entidad === 'valvula') {
                const r = await resolverValvula(itemDicho);
                if (!r.encontrado) {
                    respuesta = `🔍 No encontré la válvula "${itemDicho}" en el maestro del proyecto.`;
                    action = 'VALVULA_NO_ENCONTRADA';
                } else {
                    const previo = await montajeExistente('valvula', r.valvula.id, usuario.rol);
                    respuesta = previo
                        ? `🔧 Válvula *${r.valvula.id}* (${r.valvula.nps || '—'})\n🧵 Línea: ${r.valvula.linea}\n✅ *${previo['Status'] || 'Montada'}* el ${formatearFechaChile(previo['fecha'])}\n👤 ${previo['usuarioReporte'] || '—'}`
                        : `🔧 Válvula *${r.valvula.id}* (${r.valvula.nps || '—'})\n🧵 Línea: ${r.valvula.linea}\n⏳ *Pendiente de montaje*`;
                    action = 'CONSULTA_RESPONDIDA';
                }

            } else if (entidad === 'soporte') {
                const r = await resolverSoporte(itemDicho);
                if (!r.encontrado) {
                    respuesta = `🔍 No encontré el soporte con ITEM "${itemDicho}" en el maestro del proyecto.`;
                    action = 'SOPORTE_NO_ENCONTRADO';
                } else {
                    const previo = await montajeExistente('soporte', r.soporte.id, usuario.rol);
                    respuesta = previo
                        ? `🛠 Soporte *ITEM ${r.soporte.item}* (${r.soporte.tipo}, ${r.soporte.diam || '—'})\n🧵 Línea: ${r.soporte.linea}\n✅ *Montado* el ${formatearFechaChile(previo['Fecha'])}\n👤 ${previo['UsuarioReporte'] || '—'}` +
                          (previo['Soldador'] ? `\n👨‍🏭 Soldador: ${previo['Soldador']}` : '')
                        : `🛠 Soporte *ITEM ${r.soporte.item}* (${r.soporte.tipo}, ${r.soporte.diam || '—'})\n🧵 Línea: ${r.soporte.linea}\n⏳ *Pendiente de montaje*`;
                    action = 'CONSULTA_RESPONDIDA';
                }

            } else {
                const r = await resolverSpool(itemDicho);
                if (!r.encontrado) {
                    respuesta = `🔍 No encontré el spool "${itemDicho}" en el maestro del proyecto.`;
                    action = 'SPOOL_NO_ENCONTRADO';
                } else if (r.ambiguo) {
                    const lista = r.candidatos.map(c => `• ${c.tagGestion || c.idSpool}`).join('\n');
                    respuesta = `Hay varios spools que coinciden:\n${lista}\n\n¿Cuál necesitas consultar?`;
                    action = 'SPOOL_AMBIGUO';
                } else {
                    const ultimo = await consultarEstadoSpool(r.spool, usuario.rol);
                    respuesta = ultimo
                        ? `📦 Spool *${r.spool.tagGestion || r.spool.idSpool}*\n🏗 Último estado: *${ultimo['STATUS']}*\n🗓 ${formatearFechaChile(ultimo['FECHA_LEVANTAMIENTO'])}\n👤 ${ultimo['USUARIO'] || '—'}` +
                          (ultimo['OBSERVACION TERRENO'] ? `\n📝 ${ultimo['OBSERVACION TERRENO']}` : '')
                        : `El spool *${r.spool.tagGestion || r.spool.idSpool}* aún no tiene registros de avance.`;
                    action = 'CONSULTA_RESPONDIDA';
                }
            }

        } else if (ia.intencion === 'ENVIAR_PID' && primer.item) {
            let termino = String(primer.item).trim();
            let etiqueta = termino;
            
            const rSpool = await resolverSpool(termino);
            if (rSpool.encontrado && !rSpool.ambiguo) {
                etiqueta = `spool ${rSpool.spool.tagGestion || rSpool.spool.idSpool}`;
            }

            try {
                const rPid = await fetch(`http://localhost:${CONFIG.PORT}/api/pid/pdf/${encodeURIComponent(termino)}`);
                const dPid = await rPid.json();
                
                if (dPid.success && dPid.pids && dPid.pids.length) {
                    let enviados = 0;
                    for (const p of dPid.pids.slice(0, 3)) {
                        const proxyUrl = `http://localhost:${CONFIG.PORT}/api/iso/proxy-pdf?url=${encodeURIComponent(p.pdf_url)}`;
                        
                        const ok = await enviarArchivoWhatsApp(jid, telefono, {
                            fileUrl: proxyUrl,
                            fileName: `${String(p.id_pid).replace(/[^\w\-\.]+/g, '_')}.pdf`,
                            mimetype: 'application/pdf',
                            caption: `📐 Diagrama P&ID: ${p.id_pid}\n📝 Desc: ${p.descripcion || 'Sin desc'}\n🗓 Rev: ${p.revision_vigente} | Estado: ${p.estado_vigente}`.trim(),
                            tipo: 'document'
                        });
                        if (ok) enviados++;
                    }
                    
                    respuesta = enviados
                        ? `📐 Te envié ${enviados} plano(s) P&ID relacionados con ${etiqueta}.` +
                          (dPid.pids.length > 3 ? `\n(Se encontraron ${dPid.pids.length} en total — enviando los 3 más actuales.)` : '')
                        : '⚠️ No pude descargar el plano P&ID. Intenta de nuevo en unos minutos.';
                    action = enviados ? 'PID_ENVIADO' : 'PID_ERROR_ENVIO';
                } else {
                    respuesta = `🔍 No encontré ningún diagrama P&ID relacionado con "${etiqueta}".`;
                    action = 'PID_SIN_PDF';
                }
            } catch (e) {
                console.error('[bot] Error enviando PID:', e.message);
                respuesta = '⚠️ Tuve un problema obteniendo el diagrama P&ID. Intenta de nuevo.';
                action = 'PID_ERROR';
            }

        } else if (ia.intencion === 'ENVIAR_ISOMETRICO' && primer.item) {
            // Resolver por spool (tag) o directamente por ID_ISO
            let idIso = String(primer.item).trim();
            let etiqueta = idIso;
            const rSpool = await resolverSpool(primer.item);
            if (rSpool.encontrado && !rSpool.ambiguo) {
                idIso = rSpool.spool.idIso;
                etiqueta = `spool ${rSpool.spool.tagGestion || rSpool.spool.idSpool}`;
            }
            try {
                const rIso = await fetch(`http://localhost:${CONFIG.PORT}/api/iso/pdf/${encodeURIComponent(idIso)}`);
                const dIso = await rIso.json();
                if (dIso.success && dIso.sheets && dIso.sheets.length) {
                    // Priorizar la hoja exacta; máximo 3 PDFs por mensaje
                    const hojas = [...dIso.sheets].sort((a, b) =>
                        (a.id_iso === (dIso.current_sheet?.id_iso) ? -1 : 0) - (b.id_iso === (dIso.current_sheet?.id_iso) ? -1 : 0)
                    ).slice(0, 3);
                    let enviados = 0;
                    for (const sh of hojas) {
                        const ok = await enviarArchivoWhatsApp(jid, telefono, {
                            fileUrl: sh.pdf_url,
                            fileName: `${(sh.id_iso || idIso).replace(/[^\w\-\.]+/g, '_')}.pdf`,
                            mimetype: 'application/pdf',
                            caption: `📐 Isométrico ${sh.hoja_label || sh.id_iso || ''}`.trim(),
                            tipo: 'document'
                        });
                        if (ok) enviados++;
                    }
                    respuesta = enviados
                        ? `📐 Te envié ${enviados} hoja(s) del isométrico de ${etiqueta}.` +
                          (dIso.sheets.length > 3 ? `\n(La línea tiene ${dIso.sheets.length} hojas en total — pide una específica si necesitas otra.)` : '')
                        : '⚠️ No pude descargar el PDF del isométrico. Intenta de nuevo en unos minutos.';
                    action = enviados ? 'ISO_ENVIADO' : 'ISO_ERROR_ENVIO';
                } else {
                    respuesta = `🔍 No encontré PDF de isométrico para "${etiqueta}".`;
                    action = 'ISO_SIN_PDF';
                }
            } catch (e) {
                console.error('[bot] Error enviando isométrico:', e.message);
                respuesta = '⚠️ Tuve un problema obteniendo el isométrico. Intenta de nuevo.';
                action = 'ISO_ERROR';
            }

        } else if (ia.intencion === 'ENVIAR_FOTO' && primer.item) {
            const entidadF = primer.entidad || 'spool';
            let fotos = [];   // { url, caption }
            let etiqueta = String(primer.item).trim();

            if (entidadF === 'valvula') {
                const r = await resolverValvula(primer.item);
                if (r.encontrado) {
                    etiqueta = `válvula ${r.valvula.id}`;
                    const regs = await fetchAppSheetCached('REG_MontajeValvulas_MS').catch(() => []);
                    fotos = regs
                        .filter(x => String(x['ID_VALVULA'] || '').trim() === r.valvula.id && String(x['FotoTerreno'] || '').trim())
                        .map(x => ({
                            url: urlArchivoAppSheet('REG_MontajeValvulas_MS', x['FotoTerreno']),
                            caption: `🔧 ${r.valvula.id} — ${x['Status'] || 'Montada'} (${formatearFechaChile(x['fecha'])})`
                        }));
                }
            } else if (entidadF === 'soporte') {
                const r = await resolverSoporte(primer.item);
                if (r.encontrado) {
                    etiqueta = `soporte ITEM ${r.soporte.item}`;
                    const regs = await fetchAppSheetCached('REG_MontajeSoportes_MS').catch(() => []);
                    fotos = regs
                        .filter(x => String(x['ID_Soporte'] || '').trim() === r.soporte.id && String(x['FotoTerreno'] || '').trim())
                        .map(x => ({
                            url: urlArchivoAppSheet('REG_MontajeSoportes_MS', x['FotoTerreno']),
                            caption: `🛠 ITEM ${r.soporte.item} — Montado (${formatearFechaChile(x['Fecha'])})`
                        }));
                }
            } else {
                const r = await resolverSpool(primer.item);
                if (r.encontrado && !r.ambiguo) {
                    etiqueta = `spool ${r.spool.tagGestion || r.spool.idSpool}`;
                    const logs = await fetchAppSheetCached('LOG_Spool_MS', { "Rol": String(usuario.rol || 'TERRENO').toUpperCase() }).catch(() => []);
                    fotos = logs
                        .filter(x => String(x['ID_SPOOL'] || '').trim() === r.spool.idSpool && String(x['FOTO'] || '').trim())
                        .sort((a, b) => new Date(b['FECHA_LEVANTAMIENTO'] || 0) - new Date(a['FECHA_LEVANTAMIENTO'] || 0))
                        .map(x => ({
                            url: urlArchivoAppSheet('LOG_Spool_MS', x['FOTO']),
                            caption: `📦 ${r.spool.tagGestion || r.spool.idSpool} — ${x['STATUS']} (${formatearFechaChile(x['FECHA_LEVANTAMIENTO'])})`
                        }));
                }
            }

            if (!fotos.length) {
                respuesta = `📷 No hay fotos registradas para ${etiqueta}.`;
                action = 'FOTO_NO_DISPONIBLE';
            } else {
                let enviadas = 0;
                for (const f of fotos.slice(0, 3)) {
                    const ok = await enviarArchivoWhatsApp(jid, telefono, {
                        fileUrl: f.url, caption: f.caption, tipo: 'image'
                    });
                    if (ok) enviadas++;
                }
                respuesta = enviadas
                    ? `📷 Te envié ${enviadas} foto(s) de ${etiqueta}.` + (fotos.length > 3 ? ` (Hay ${fotos.length} en total.)` : '')
                    : '⚠️ No pude descargar las fotos. Intenta de nuevo.';
                action = enviadas ? 'FOTO_ENVIADA' : 'FOTO_ERROR_ENVIO';
            }
        }

        // 5. Responder y guardar (la confirmación de registro va siempre en texto)
        const vozFinal = responderConVoz && !confirmacionEnTexto;
        await enviarMensajeWhatsApp(jid, telefono, respuesta, vozFinal);
        await guardarMensaje(telefono, 'bot', respuesta, vozFinal ? 'audio' : 'texto', { action });

    } catch (err) {
        console.error('[bot] Error general:', err.message, err.stack);
        try {
            await enviarMensajeWhatsApp(jid, telefono,
                '⚠️ Tuvimos un inconveniente procesando tu mensaje. Por favor intenta de nuevo en texto o con un audio más corto.',
                false);
        } catch (e) { /* mejor esfuerzo */ }
        // El ACK al bridge ya se envió arriba; acá sólo queda loguear.
    }
}

module.exports = {
    handleWhatsappIncoming, enviarMensajeWhatsApp, formatearFechaChile,
    // Reutilizados por la página de escaneo de lotes (index.js)
    resolverSpool, registrarAvanceAppSheet, consultarEstadoSpool, guardarRegistro
};
