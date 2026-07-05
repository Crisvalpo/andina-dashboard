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

/**
 * Asegura que el bucket de almacenamiento para los PDFs exista en Supabase Storage.
 * Si no existe, lo crea programáticamente con visibilidad pública.
 */
async function asegurarBucketExistente() {
    try {
        const supabase = getSupabase();
        const { data: buckets, error: listError } = await supabase.storage.listBuckets();
        if (listError) throw listError;

        const bucketId = 'andina-pdfs';
        const existe = buckets.find(b => b.id === bucketId);
        if (!existe) {
            console.log(`[Supabase Storage] Creando bucket "${bucketId}"...`);
            const { error: createError } = await supabase.storage.createBucket(bucketId, {
                public: true
            });
            if (createError) throw createError;
            console.log(`[Supabase Storage] Bucket "${bucketId}" creado con éxito.`);
        } else {
            console.log(`[Supabase Storage] Bucket "${bucketId}" confirmado.`);
        }
    } catch (e) {
        console.error('[Supabase Storage] Error al verificar/crear el bucket:', e.message);
    }
}

module.exports = { getSupabase, asegurarBucketExistente };

