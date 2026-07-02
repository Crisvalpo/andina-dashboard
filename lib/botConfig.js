/**
 * Configuración runtime del bot, almacenada en andina.bot_config (Supabase).
 * Editable desde el panel "Bot WhatsApp" del dashboard sin redeploy.
 * Los secretos NO viven aquí — solo en .env (ver config.js).
 */
const { getSupabase } = require('./supabase');

// Valores por defecto: se usan si la clave no existe aún en la tabla.
const DEFAULTS = {
    nombre_bot: {
        valor: 'Andi',
        descripcion: 'Nombre con el que se presenta el asistente'
    },
    estados_permitidos: {
        valor: 'Retirar,Por Montar,Posicionado,Montado',
        descripcion: 'Estados que el bot puede registrar en LOG_Spool_MS (separados por coma)'
    },
    responder_con_voz: {
        valor: 'true',
        descripcion: 'Si el usuario envía audio, el bot responde con nota de voz (TTS)'
    },
    mensaje_no_autorizado: {
        valor: 'Hola 👋 Tu número aún no está autorizado en el Dashboard Andina. Solicita acceso al administrador del proyecto.',
        descripcion: 'Respuesta a números no registrados/activos'
    },
    max_historial: {
        valor: '10',
        descripcion: 'Cantidad de mensajes previos que se entregan como memoria a Gemini'
    },
    usuario_registro_defecto: {
        valor: 'Bot WhatsApp',
        descripcion: 'Valor de USUARIO en AppSheet si el usuario no tiene nombre registrado'
    }
};

let cacheConfig = null;
let cacheTs = 0;
const CACHE_TTL = 60 * 1000;

/** Devuelve la config runtime como objeto plano { clave: valor }, con defaults aplicados. */
async function getBotConfig(forzar = false) {
    const now = Date.now();
    if (!forzar && cacheConfig && (now - cacheTs < CACHE_TTL)) return cacheConfig;

    const supabase = getSupabase();
    const { data, error } = await supabase.from('bot_config').select('clave, valor');
    if (error) throw new Error(`bot_config: ${error.message}`);

    const conf = {};
    for (const [clave, def] of Object.entries(DEFAULTS)) conf[clave] = def.valor;
    for (const row of (data || [])) conf[row.clave] = row.valor;

    cacheConfig = conf;
    cacheTs = now;
    return conf;
}

/** Lista completa para el panel (clave, valor, descripción). */
async function listarBotConfig() {
    const supabase = getSupabase();
    const { data, error } = await supabase.from('bot_config').select('*').order('clave');
    if (error) throw new Error(`bot_config: ${error.message}`);

    const porClave = Object.fromEntries((data || []).map(r => [r.clave, r]));
    const out = [];
    for (const [clave, def] of Object.entries(DEFAULTS)) {
        const row = porClave[clave];
        out.push({
            clave,
            valor: row ? row.valor : def.valor,
            descripcion: (row && row.descripcion) || def.descripcion,
            persistida: Boolean(row)
        });
        delete porClave[clave];
    }
    // Claves extra creadas manualmente
    for (const row of Object.values(porClave)) {
        out.push({ clave: row.clave, valor: row.valor, descripcion: row.descripcion || '', persistida: true });
    }
    return out;
}

async function setBotConfig(clave, valor) {
    const supabase = getSupabase();
    const descripcion = DEFAULTS[clave] ? DEFAULTS[clave].descripcion : null;
    const { error } = await supabase.from('bot_config').upsert(
        { clave, valor: String(valor), descripcion, updated_at: new Date().toISOString() },
        { onConflict: 'clave' }
    );
    if (error) throw new Error(`bot_config upsert: ${error.message}`);
    cacheConfig = null; // invalidar caché
}

module.exports = { getBotConfig, listarBotConfig, setBotConfig, DEFAULTS };
