/**
 * Configuración central del Dashboard Andina.
 * Todos los valores viven aquí (cargados desde .env) — nada hardcodeado en el resto del código.
 * Los secretos NUNCA deben exponerse por API ni commitearse (ver .env.example).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const CONFIG = {
    // --- Servidor ---
    PORT: parseInt(process.env.PORT || '3005', 10),
    ZONA_HORARIA: process.env.ZONA_HORARIA || 'America/Santiago',
    PUBLIC_URL: process.env.PUBLIC_URL || 'https://andina.lukeapp.me', // base de links (sesión de escaneo)

    // --- AppSheet (backend de datos del proyecto) ---
    APPSHEET_APP_ID: process.env.APPSHEET_APP_ID || '',
    APPSHEET_ACCESS_KEY: process.env.APPSHEET_ACCESS_KEY || '',

    // --- Supabase local (esquema del bot) ---
    SUPABASE_URL: process.env.SUPABASE_URL || 'http://localhost:8000',
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    SUPABASE_SCHEMA: process.env.SUPABASE_SCHEMA || 'andina',

    // --- Gemini (motor IA del bot) ---
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    GEMINI_TTS_MODEL: process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts',
    GEMINI_TTS_VOZ: process.env.GEMINI_TTS_VOZ || 'Charon',

    // --- WA Bridge (microservicio Baileys) ---
    WA_BRIDGE_URL: process.env.WA_BRIDGE_URL || 'http://localhost:3035',
    WA_BRIDGE_SECRET: process.env.WA_BRIDGE_SECRET || '',

    // --- Autodesk Platform Services (visor BIM) ---
    APS_CLIENT_ID: process.env.APS_CLIENT_ID || '',
    APS_CLIENT_SECRET: process.env.APS_CLIENT_SECRET || '',
    APS_MODEL_URN: process.env.APS_MODEL_URN || '',

    // --- Control de acceso (escritura) ---
    // Claves compartidas por área; validadas en servidor. Solo en .env.
    CLAVE_BIM: process.env.CLAVE_BIM || '',       // desbloquea vincular elementos 3D
    CLAVE_BOT: process.env.CLAVE_BOT || '',       // desbloquea administración del bot
    SESSION_SECRET: process.env.SESSION_SECRET || '', // firma los tokens de sesión
};

// Claves que son secretas: el endpoint /api/config solo informa si están
// configuradas o no, jamás su valor.
const CLAVES_SECRETAS = [
    'APPSHEET_ACCESS_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'GEMINI_API_KEY',
    'WA_BRIDGE_SECRET',
    'APS_CLIENT_SECRET',
    'CLAVE_BIM',
    'CLAVE_BOT',
    'SESSION_SECRET',
];

/**
 * Resumen seguro de la configuración de entorno para mostrar en el panel:
 * valores normales tal cual, secretos solo como boolean "configurada".
 */
function resumenSeguro() {
    const out = {};
    for (const [k, v] of Object.entries(CONFIG)) {
        if (CLAVES_SECRETAS.includes(k)) {
            out[k] = { secreto: true, configurada: Boolean(v) };
        } else {
            out[k] = { secreto: false, valor: v };
        }
    }
    return out;
}

module.exports = { CONFIG, CLAVES_SECRETAS, resumenSeguro };
