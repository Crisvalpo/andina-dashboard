/**
 * Cliente AppSheet compartido (dashboard + bot).
 * Incluye caché en memoria para proteger la cuota de la API.
 */
const { CONFIG } = require('../config');

const cache = {};
const CACHE_TTL = 30 * 1000; // 30 segundos

async function fetchAppSheet(tableName, action = 'Find', rows = [], userSettings = null) {
    if (!CONFIG.APPSHEET_APP_ID || !CONFIG.APPSHEET_ACCESS_KEY) {
        throw new Error('AppSheet no configurado (APPSHEET_APP_ID / APPSHEET_ACCESS_KEY en .env)');
    }
    const url = `https://api.appsheet.com/api/v2/apps/${CONFIG.APPSHEET_APP_ID}/tables/${tableName}/Action`;
    
    const properties = { Locale: 'es-ES' };
    if (userSettings) {
        properties.UserSettings = userSettings;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'ApplicationAccessKey': CONFIG.APPSHEET_ACCESS_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            Action: action,
            Properties: properties,
            Rows: rows
        })
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`AppSheet Error ${response.status}: ${body.slice(0, 300)}`);
    }
    const text = await response.text();
    if (!text) return [];
    return JSON.parse(text);
}

/** Find con caché (solo lecturas). Las escrituras invalidan la caché de esa tabla. */
async function fetchAppSheetCached(tableName, userSettings = null) {
    const cacheKey = userSettings 
        ? `${tableName}_${JSON.stringify(userSettings)}` 
        : tableName;
    const now = Date.now();

    if (cache[cacheKey] && (now - cache[cacheKey].timestamp < CACHE_TTL)) {
        return cache[cacheKey].data;
    }
    const data = await fetchAppSheet(tableName, 'Find', [], userSettings);
    cache[cacheKey] = { data, timestamp: now };
    return data;
}

function invalidarCache(tableName) {
    Object.keys(cache).forEach(key => {
        if (key === tableName || key.startsWith(tableName + '_')) {
            delete cache[key];
        }
    });
}

module.exports = { fetchAppSheet, fetchAppSheetCached, invalidarCache };
