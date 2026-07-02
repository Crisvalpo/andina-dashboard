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

// ================================================================
// MENSAJERÍA (via wa-bridge)
// ================================================================
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
            headers: { 'Content-Type': 'application/json' },
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

async function enviarPresencia(jid, phone, grabando = false) {
    try {
        await fetch(`${CONFIG.WA_BRIDGE_URL}/presence`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
    // Formato MM/DD/YYYY HH:mm:ss en la zona horaria del proyecto
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: CONFIG.ZONA_HORARIA,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
    }).formatToParts(new Date());
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    return `${p.month}/${p.day}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

async function registrarAvanceAppSheet({ spool, status, usuario, ubicacion, observacion, mts }) {
    const fila = {
        'ID_LOG_SPOOL': crypto.randomBytes(4).toString('hex'),
        'ID_SPOOL': spool.idSpool,
        'ID_ISO': spool.idIso,
        'TAG_SPOOL': spool.tagGestion,
        'STATUS': status,
        'UBICACION LEVANTAMIENTO': ubicacion || '',
        'SECTOR LEVANTAMIENTO': '',
        'FOTO': '',
        'OBSERVACION TERRENO': observacion || '',
        'FECHA_LEVANTAMIENTO': fechaAppSheet(),
        'MTS MONTADOS': (mts !== null && mts !== undefined) ? String(mts) : '',
        'USUARIO': usuario
    };
    const resultado = await fetchAppSheet('LOG_Spool_MS', 'Add', [fila]);
    invalidarCache('LOG_Spool_MS');
    return { fila, resultado };
}

async function consultarEstadoSpool(spool) {
    const logs = await fetchAppSheetCached('LOG_Spool_MS');
    const registros = logs
        .filter(r => String(r['ID_SPOOL'] || '').trim() === spool.idSpool)
        .sort((a, b) => new Date(b['FECHA_LEVANTAMIENTO'] || 0) - new Date(a['FECHA_LEVANTAMIENTO'] || 0));
    return registros[0] || null;
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

    const esAudio = Boolean(audio && audio.data);
    console.log(`[bot] De: ${telefono} | ${esAudio ? '🎤 Audio' : `💬 "${(message || '').substring(0, 80)}"`}`);

    try {
        const botConf = await getBotConfig();
        enviarPresencia(jid, telefono, esAudio);

        // 1. Autorización por número
        const usuario = await buscarUsuario(telefono);
        if (!usuario || !usuario.activo) {
            if (!usuario) await registrarUsuarioPendiente(telefono, pushName);
            await guardarMensaje(telefono, 'usuario', message || '[audio]', esAudio ? 'audio' : 'texto', { autorizado: false });
            await enviarMensajeWhatsApp(jid, telefono, botConf.mensaje_no_autorizado, false);
            return res.status(200).json({ success: true, action: 'NO_AUTORIZADO' });
        }

        const responderConVoz = esAudio && String(botConf.responder_con_voz) === 'true';

        // 2. Procesar con Gemini (texto o audio) + memoria
        const historial = await cargarHistorial(telefono, parseInt(botConf.max_historial || '10', 10));
        const ia = await procesarMensaje({
            texto: message,
            audio: esAudio ? audio : null,
            historial,
            botConf,
            contexto: { nombre_usuario: usuario.nombre, rol_usuario: usuario.rol }
        });

        const textoUsuario = ia.transcripcion || message || '[audio]';
        await guardarMensaje(telefono, 'usuario', textoUsuario, esAudio ? 'audio' : 'texto', { intencion: ia.intencion });

        let respuesta = ia.respuesta_bot || 'No logré entender tu mensaje, ¿puedes repetirlo?';
        let action = ia.intencion || 'OTRO';

        // 3. Rutear según intención
        if (ia.intencion === 'REGISTRAR_AVANCE' && ia.spool && ia.status) {
            const estadosPermitidos = (botConf.estados_permitidos || '')
                .split(',').map(s => s.trim().toLowerCase());

            if (!estadosPermitidos.includes(String(ia.status).toLowerCase())) {
                respuesta = `⚠️ El estado "${ia.status}" no está habilitado para registro por WhatsApp. Estados disponibles: ${botConf.estados_permitidos}.`;
                action = 'ESTADO_NO_PERMITIDO';
            } else {
                const r = await resolverSpool(ia.spool);

                if (!r.encontrado) {
                    respuesta = `🔍 No encontré el spool "${ia.spool}" en el maestro del proyecto. Verifica el número e inténtalo de nuevo.`;
                    action = 'SPOOL_NO_ENCONTRADO';
                } else if (r.ambiguo) {
                    const lista = r.candidatos.map(c => `• ${c.tagGestion || c.idSpool}`).join('\n');
                    respuesta = `Encontré varios spools que coinciden con "${ia.spool}":\n${lista}\n\n¿Cuál corresponde?`;
                    action = 'SPOOL_AMBIGUO';
                } else {
                    const { fila } = await registrarAvanceAppSheet({
                        spool: r.spool,
                        status: ia.status,
                        usuario: usuario.nombre || botConf.usuario_registro_defecto,
                        ubicacion: ia.ubicacion,
                        observacion: ia.observacion,
                        mts: ia.mts_montados
                    });

                    await guardarRegistro({
                        telefono,
                        spool_tag: r.spool.tagGestion,
                        id_spool: r.spool.idSpool,
                        status: ia.status,
                        observacion: ia.observacion,
                        mts_montados: ia.mts_montados,
                        appsheet_ok: true,
                        metadata: { id_log_spool: fila['ID_LOG_SPOOL'] }
                    });

                    respuesta = `✅ *Avance registrado*\n\n📦 Spool: *${r.spool.tagGestion || r.spool.idSpool}*\n🏗 Estado: *${ia.status}*` +
                        (ia.mts_montados ? `\n📏 Metros: ${ia.mts_montados}` : '') +
                        (ia.ubicacion ? `\n📍 Ubicación: ${ia.ubicacion}` : '') +
                        (ia.observacion ? `\n📝 Obs: ${ia.observacion}` : '') +
                        `\n👤 ${usuario.nombre}`;
                    action = 'AVANCE_REGISTRADO';
                }
            }
        } else if (ia.intencion === 'CONSULTAR_SPOOL' && ia.spool) {
            const r = await resolverSpool(ia.spool);
            if (!r.encontrado) {
                respuesta = `🔍 No encontré el spool "${ia.spool}" en el maestro del proyecto.`;
                action = 'SPOOL_NO_ENCONTRADO';
            } else if (r.ambiguo) {
                const lista = r.candidatos.map(c => `• ${c.tagGestion || c.idSpool}`).join('\n');
                respuesta = `Hay varios spools que coinciden:\n${lista}\n\n¿Cuál necesitas consultar?`;
                action = 'SPOOL_AMBIGUO';
            } else {
                const ultimo = await consultarEstadoSpool(r.spool);
                respuesta = ultimo
                    ? `📦 Spool *${r.spool.tagGestion || r.spool.idSpool}*\n🏗 Último estado: *${ultimo['STATUS']}*\n🗓 ${ultimo['FECHA_LEVANTAMIENTO']}\n👤 ${ultimo['USUARIO'] || '—'}` +
                      (ultimo['OBSERVACION TERRENO'] ? `\n📝 ${ultimo['OBSERVACION TERRENO']}` : '')
                    : `El spool *${r.spool.tagGestion || r.spool.idSpool}* aún no tiene registros de avance.`;
                action = 'CONSULTA_RESPONDIDA';
            }
        }

        // 4. Responder y guardar
        await enviarMensajeWhatsApp(jid, telefono, respuesta, responderConVoz);
        await guardarMensaje(telefono, 'bot', respuesta, responderConVoz ? 'audio' : 'texto', { action });

        return res.status(200).json({ success: true, action });

    } catch (err) {
        console.error('[bot] Error general:', err.message, err.stack);
        try {
            await enviarMensajeWhatsApp(jid, telefono,
                '⚠️ Tuvimos un inconveniente procesando tu mensaje. Por favor intenta de nuevo en texto o con un audio más corto.',
                false);
        } catch (e) { /* mejor esfuerzo */ }
        return res.status(500).json({ success: false, error: err.message });
    }
}

module.exports = { handleWhatsappIncoming, enviarMensajeWhatsApp };
