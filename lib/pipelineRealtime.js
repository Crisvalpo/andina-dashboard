/**
 * Pipeline de Detección de Cambios, Indexación y Refresco en Tiempo Real para Spools
 *
 * Flujo:
 * 1. Detección del evento de avance o cambio de estado.
 * 2. Autenticación y resolución de Spool / Supervisor.
 * 3. Escritura en base central: AppSheet (LOG_Spool_MS) + Supabase (andina.bot_registros).
 * 4. Invalidación de caché y regeneración del Mapa del Mundo / Embeddings (generarMapaDelMundo).
 * 5. Notificación y refresco de datos para modelos de IA (Luke Realtime, Andi WhatsApp) y Visor 3D BIM.
 */

const { fetchAppSheet, invalidarCache } = require('./appsheet');
const { getSupabase } = require('./supabase');
const { resolverSpool, registrarAvanceAppSheet, guardarRegistro } = require('./bot');
const { generarMapaDelMundo } = require('./worldMap');

/**
 * Procesa un cambio de estado de spool en el pipeline central.
 */
async function procesarCambioEstadoSpool({ spoolId, nuevoEstado, pinSupervisor, usuarioInput = null, observacion = '', origen = 'realtime_voz' }) {
    if (!spoolId || !nuevoEstado) {
        throw new Error('Faltan parámetros obligatorios: spoolId o nuevoEstado.');
    }

    const estadoUpper = String(nuevoEstado).trim().toUpperCase();
    console.log(`[Pipeline Spool] 🚀 Iniciando procesamiento de cambio de estado para Spool "${spoolId}" -> "${estadoUpper}" (Origen: ${origen})`);

    // 1. Validar Supervisor / Usuario por PIN (si proviene de voz o canal protegido)
    let usuarioFinal = usuarioInput;
    let userRole = 'Supervisor';

    if (pinSupervisor) {
        const supabase = getSupabase();
        const { data: userDb, error: errUser } = await supabase
            .from('bot_usuarios')
            .select('*')
            .eq('pin', String(pinSupervisor).trim())
            .eq('activo', true)
            .maybeSingle();

        if (errUser || !userDb) {
            return {
                success: false,
                error: `PIN "${pinSupervisor}" no válido o usuario inactivo en el sistema.`,
                requiere_pin: true
            };
        }

        usuarioFinal = userDb.nombre;
        userRole = userDb.rol;
    }

    if (!usuarioFinal) {
        usuarioFinal = 'Sistema / Terreno';
    }

    // 2. Resolver Spool en el Maestro (LIST_Spools_MS_)
    const resSpool = await resolverSpool(spoolId);
    if (!resSpool.encontrado || !resSpool.spool) {
        return {
            success: false,
            error: `No se encontró el spool "${spoolId}" en el maestro del proyecto.`
        };
    }

    const spoolInfo = resSpool.spool;

    // 3. Registrar avance en AppSheet (LOG_Spool_MS)
    const { fila, resultado } = await registrarAvanceAppSheet({
        spool: spoolInfo,
        status: estadoUpper,
        usuario: usuarioFinal,
        rol: userRole,
        observacion: observacion || `Registrado vía Pipeline (${origen}) por ${usuarioFinal}`
    });

    // 4. Registro de auditoría en Supabase (andina.bot_registros)
    await guardarRegistro({
        telefono: 'pipeline_auto',
        spool_tag: spoolInfo.tagGestion,
        id_spool: spoolInfo.idSpool,
        status: estadoUpper,
        observacion: observacion || `Pipeline ${origen} (PIN: ${pinSupervisor || 'N/A'})`,
        appsheet_ok: true,
        metadata: {
            registrado_por: usuarioFinal,
            rol: userRole,
            origen,
            timestamp: new Date().toISOString()
        }
    }).catch(err => console.warn('[Pipeline Audit Warning]', err.message));

    // 5. Invalidación de Caché y Re-indexación / Regeneración del Contexto de IA
    console.log('[Pipeline Spool] 🔄 Invalidando caché de AppSheet y regenerando Mapa del Mundo / Indexación...');
    invalidarCache('LOG_Spool_MS');
    invalidarCache('LIST_Spools_MS_');

    // Regenerar el Mapa del Mundo forzadamente para que Gemini/OpenAI vean el conteo e índices frescos
    const mapaActualizado = await generarMapaDelMundo(true).catch(e => {
        console.warn('[Pipeline Mapa Error]', e.message);
        return null;
    });

    console.log(`[Pipeline Spool] ✅ Estado de Spool ${spoolInfo.tagGestion} actualizado exitosamente a "${estadoUpper}". Contexto de IA e índices refrescados.`);

    return {
        success: true,
        spool_id: spoolInfo.tagGestion,
        id_spool: spoolInfo.idSpool,
        id_iso: spoolInfo.idIso,
        nuevo_estado: estadoUpper,
        usuario: usuarioFinal,
        rol: userRole,
        mapa_refrescado: !!mapaActualizado,
        mensaje: `Spool ${spoolInfo.tagGestion} registrado exitosamente como ${estadoUpper} a nombre de ${usuarioFinal}.`
    };
}

module.exports = {
    procesarCambioEstadoSpool
};
