/**
 * Cliente Supabase (self-hosted local) para el bot del dashboard.
 * Usa service_role sobre el esquema dedicado 'andina' — mismo patrón
 * que LukeMaquinarias con su esquema 'maquinaria'.
 */
const { createClient } = require('@supabase/supabase-js');
const { CONFIG } = require('../config');

let client = null;

function getSupabase() {
    if (client) return client;

    if (!CONFIG.SUPABASE_URL || !CONFIG.SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('Supabase no configurado (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en .env)');
    }

    client = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        db: { schema: CONFIG.SUPABASE_SCHEMA }
    });
    return client;
}

module.exports = { getSupabase };
