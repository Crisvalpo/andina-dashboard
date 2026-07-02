/**
 * Cliente AppSheet compartido (dashboard + bot).
 * Incluye caché en memoria para proteger la cuota de la API.
 */
const { CONFIG } = require('../config');

const cache = {};
const CACHE_TTL = 30 * 1000; // 30 segundos

async function fetchAppSheet(tableName, action = 'Find', rows = []) {
    if (!CONFIG.APPSHEET_APP_ID || !CONFIG.APPSHEET_ACCESS_KEY) {
        throw new Error('AppSheet no configurado (APPSHEET_APP_ID / APPSHEET_ACCESS_KEY en .env)');
    }
    const url = `https://api.appsheet.com/api/v2/apps/${CONFIG.APPSHEET_APP_ID}/tables/${tableName}/Action`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'ApplicationAccessKey': CONFIG.APPSHEET_ACCESS_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            Action: action,
            Properties: { Locale: 'es-ES' },
            Rows: rows
        })
    });
    if (!response.ok) throw new Error(`AppSheet Error: ${response.status}`);
    const text = await response.text();
    if (!text) return [];
    return JSON.parse(text);
}

/** Find con caché (solo lecturas). Las escrituras invalidan la caché de esa tabla. */
async function fetchAppSheetCached(tableName) {
    const now = Date.now();
    if (cache[tableName] && (now - cache[tableName].timestamp < CACHE_TTL)) {
        return cache[tableName].data;
    }
    const data = await fetchAppSheet(tableName);
    cache[tableName] = { data, timestamp: now };
    return data;
}

function invalidarCache(tableName) {
    delete cache[tableName];
}

module.exports = { fetchAppSheet, fetchAppSheetCached, invalidarCache };
