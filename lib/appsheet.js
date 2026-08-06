/**
 * Cliente AppSheet compartido (dashboard + bot).
 * Incluye cola de concurrencia y caché en memoria para proteger la cuota de la API (evitando errores 429).
 */
const { CONFIG } = require('../config');

const cache = {};
const pendingPromises = {};
const CACHE_TTL = 30 * 1000; // 30 segundos

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Cola de peticiones para controlar la concurrencia hacia AppSheet.
 * Máximo 2 peticiones simultáneas con 150ms de pausa entre ellas.
 * Esto evita inundar a AppSheet cuando el Dashboard solicita 10+ tablas en paralelo.
 */
let activeRequests = 0;
const MAX_CONCURRENT = 2;
const requestQueue = [];

function enqueueRequest(fn) {
    return new Promise((resolve, reject) => {
        requestQueue.push({ fn, resolve, reject });
        processQueue();
    });
}

function processQueue() {
    if (activeRequests >= MAX_CONCURRENT || requestQueue.length === 0) return;
    activeRequests++;
    const { fn, resolve, reject } = requestQueue.shift();

    fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
            activeRequests--;
            setTimeout(processQueue, 150);
        });
}

async function fetchAppSheetRaw(tableName, action = 'Find', rows = [], userSettings = null, retries = 4) {
    if (!CONFIG.APPSHEET_APP_ID || !CONFIG.APPSHEET_ACCESS_KEY) {
        throw new Error('AppSheet no configurado (APPSHEET_APP_ID / APPSHEET_ACCESS_KEY en .env)');
    }
    const url = `https://api.appsheet.com/api/v2/apps/${CONFIG.APPSHEET_APP_ID}/tables/${tableName}/Action`;
    
    const properties = { Locale: 'es-ES' };
    if (userSettings) {
        properties.UserSettings = userSettings;
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
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

            if (response.status === 429 && attempt < retries) {
                // Backoff con Jitter aleatorio para desincronizar peticiones paralelas
                const backoff = (attempt + 1) * 1000 + Math.floor(Math.random() * 800);
                console.warn(`[AppSheet 429 Rate Limit] Reintentando ${tableName} en ${backoff}ms (intento ${attempt + 1}/${retries})...`);
                await sleep(backoff);
                continue;
            }

            if (!response.ok) {
                const body = await response.text().catch(() => '');
                throw new Error(`AppSheet Error ${response.status}: ${body.slice(0, 300)}`);
            }
            const text = await response.text();
            if (!text) return [];
            return JSON.parse(text);
        } catch (err) {
            if (attempt < retries && (err.message.includes('429') || err.message.includes('fetch failed') || err.message.includes('ECONNRESET'))) {
                const backoff = (attempt + 1) * 1000 + Math.floor(Math.random() * 800);
                console.warn(`[AppSheet Error] Reintentando ${tableName} en ${backoff}ms (${err.message})...`);
                await sleep(backoff);
                continue;
            }
            throw err;
        }
    }
}

/** Petición con encolamiento de concurrencia hacia AppSheet. */
function fetchAppSheet(tableName, action = 'Find', rows = [], userSettings = null) {
    return enqueueRequest(() => fetchAppSheetRaw(tableName, action, rows, userSettings));
}

/** Find con caché (solo lecturas) + deduplicación de peticiones en vuelo (Coalescing). */
async function fetchAppSheetCached(tableName, userSettings = null) {
    const cacheKey = userSettings 
        ? `${tableName}_${JSON.stringify(userSettings)}` 
        : tableName;
    const now = Date.now();

    if (cache[cacheKey] && (now - cache[cacheKey].timestamp < CACHE_TTL)) {
        return cache[cacheKey].data;
    }

    if (pendingPromises[cacheKey]) {
        return pendingPromises[cacheKey];
    }

    pendingPromises[cacheKey] = (async () => {
        try {
            const data = await fetchAppSheet(tableName, 'Find', [], userSettings);
            cache[cacheKey] = { data, timestamp: now };
            return data;
        } finally {
            delete pendingPromises[cacheKey];
        }
    })();

    return pendingPromises[cacheKey];
}

function invalidarCache(tableName) {
    Object.keys(cache).forEach(key => {
        if (key === tableName || key.startsWith(tableName + '_')) {
            delete cache[key];
        }
    });
}

module.exports = { fetchAppSheet, fetchAppSheetCached, invalidarCache };
