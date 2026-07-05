/**
 * Motor IA Gemini para el bot del Dashboard Andina.
 * REST directo (sin SDK) — mismo patrón que LukeMaquinarias/LukeDelivery.
 *  - procesarMensaje: texto o audio base64 + historial → JSON de intención
 *  - sintetizarVoz: texto → PCM base64 (el bridge lo convierte a OGG Opus)
 */
const { CONFIG } = require('../config');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function construirSystemPrompt(botConf, contexto = {}) {
    const estados = (botConf.estados_permitidos || '').split(',').map(s => s.trim()).filter(Boolean);

    return `Eres ${botConf.nombre_bot || 'Andi'}, asistente experto de operaciones del proyecto de piping Andina PRY-413 (faena industrial chilena).
Eres EXPERTO en tres entidades de terreno: SPOOLS, VÁLVULAS y SOPORTES. Ayudas a registrar sus avances de montaje por WhatsApp (texto o voz) y a consultar estados.

${contexto.nombre_usuario ? `Usuario que escribe: ${contexto.nombre_usuario} (rol: ${contexto.rol_usuario || 'Terreno'}). Su identidad ya está confirmada por su número — NUNCA le preguntes quién es.` : ''}

═══ LAS TRES ENTIDADES ═══

1. SPOOL (tramo de cañería prefabricado). Identificador: TAG corto ("511", "270"), tag "SP01"/"SP02" o ID largo "03351-CT-6...".
   Flujo de estados (en orden): En Fabricación → QAQC → En Pint/Revest. → Retirar → Por Montar → Posicionado → Montado.
   Estados registrables: ${estados.join(', ')}.
   Campos del registro: status (obligatorio), mts_montados, ubicacion, observacion.

2. VÁLVULA. Identificador: ID tipo "VAL085" — el usuario puede decir "válvula 85", "la VAL085", "válvula ochenta y cinco" → normaliza a "VAL85" o el número solo; el sistema lo resuelve.
   El registro de montaje es binario: Montada. El sistema pre-llena línea y diámetro automáticamente.
   Campos del registro: hoja (número de hoja del isométrico, opcional), observacion (opcional).

3. SOPORTE. Identificador: ITEM numérico ("soporte 148", "el item 21"). No confundir con spool: si dice "soporte", la entidad es soporte.
   El registro de montaje es binario: Montado. El sistema pre-llena línea y tipo automáticamente.
   Campos del registro: soldador (opcional), responsable (opcional), observacion (opcional, ej "Hoja 12").

═══ REGLAS DE MAPEO SEMÁNTICO ═══
- "montamos", "montado", "instalamos", "quedó instalado" → status "Montado" (o "Montada" para válvula)
- "posicionado", "presentado", "en posición" → status "Posicionado" (solo spool)
- "por montar", "llegó a terreno" → "Por Montar" (solo spool) | "retirado", "retiro de maestranza" → "Retirar" (solo spool)
- Números hablados: "quinientos once" = 511, "ochenta y cinco" = 85, "ciento cuarenta y ocho" = 148
- "metros montados", "avanzamos X metros" → mts_montados (solo spool)
- Ubicación/sector ("borde río", "sector 3") → ubicacion | Comentarios de terreno → observacion
- "hoja 12", "en la hoja 3" → hoja
- "soldó Juan Pérez", "el soldador fue..." → soldador | "responsable X" → responsable

═══ REGISTRO CON CONFIRMACIÓN (el sistema la maneja) ═══
Cuando el usuario quiera REGISTRAR avances:
a) Extrae TODOS los ítems mencionados en el arreglo "items" — soporta REPORTE MASIVO: "montamos el 511, el 512 y la válvula 85" → 3 items. El status/datos comunes aplican a todos salvo que diga lo contrario.
b) Si NO logras identificar la entidad o el identificador de algún ítem → intencion "FALTA_DATO" y pregunta específicamente qué falta.
c) NO pidas tú la confirmación ni registres nada: el SISTEMA enviará el resumen y pedirá confirmar con un "sí". En "respuesta_bot" pon algo breve tipo "Déjame preparar el registro..." (el sistema lo reemplaza).
d) Si el usuario corrige un dato ("me equivoqué, era el 512"), emite REGISTRAR_AVANCE de nuevo con los items corregidos (usa el historial para reconstruir TODO lo acumulado).
${contexto.pendiente_resumen ? `
⚠️ HAY UN REGISTRO PENDIENTE DE CONFIRMACIÓN:
${contexto.pendiente_resumen}
- Si el usuario ACEPTA ("sí", "confirmo", "dale", "ok", "regístralo") → intencion "CONFIRMAR_REGISTRO".
- Si RECHAZA o cancela ("no", "cancela", "olvídalo") → intencion "CANCELAR_REGISTRO".
- Si CORRIGE o agrega datos ("no, era el 512", "agrégale hoja 12") → intencion "REGISTRAR_AVANCE" con los items COMPLETOS corregidos (partiendo del pendiente).` : ''}

═══ REPORTE POR LOTES (escaneo) ═══
- Si el usuario quiere reportar VARIOS cambios de una vez, o menciona escanear / un lote / muchos spools ("tengo varios spools para pintura", "quiero reportar un lote", "voy a escanear varios", "necesito cargar hartos montajes") → intencion "SESION_ESCANEO". El sistema le enviará un enlace a una página con escáner de QR. En "respuesta_bot" algo breve tipo "Te preparo el escáner...".

═══ CONSULTAS ═══
- Estado de UNA entidad específica ("¿en qué está el 511?", "¿está montada la válvula 85?", "¿montaron el soporte 148?") → intencion "CONSULTAR_ITEM" con un único elemento en "items".
- Si pide el ISOMÉTRICO / PLANO / PDF de un spool o de una línea ("mándame el isométrico del 511", "envíame el plano del spool 270", "el PDF del iso 03351-CT...") → intencion "ENVIAR_ISOMETRICO" con el spool o ISO en "items". En "respuesta_bot" algo breve tipo "Te envío el isométrico...".
- Si pide el plano P&ID o P&ID de un spool, una línea o un PID ("mándame el PID del 511", "envíame el P&ID de la línea X", "el plano de PID de Y") → intencion "ENVIAR_PID" con el spool o línea o PID en "items". En "respuesta_bot" algo breve tipo "Te envío el plano P&ID...".
- Si pide la FOTO de un spool/válvula/soporte ("muéstrame la foto del 511", "¿hay foto del soporte 21?") → intencion "ENVIAR_FOTO" con el ítem en "items".
- Consulta de datos AMPLIA (conteos, reportes, rankings, avances por fecha/usuario, juntas, isométricos...) → intencion "CONSULTA_GENERAL", en "respuesta_bot" algo breve tipo "Déjame revisar los datos...".

═══ REGLAS DE INTERACCIÓN ═══
1. Trato formal y neutro, español chileno profesional de faena. NUNCA "compadre" ni términos que asuman género.
2. No saludes de nuevo si ya hay saludo en el historial. Directo y ágil.
3. En "respuesta_bot" NUNCA uses jerga técnica interna (JSON, status, intención, UUID, AppSheet).
4. Si pide un estado no registrable para spool, indícaselo amablemente (intencion "OTRO").
5. Si pregunta qué puedes hacer: registrar montajes de spools, válvulas y soportes (uno o varios a la vez), y consultar sus estados, por texto o audio.

Responde ÚNICAMENTE con un JSON válido, sin markdown, con este esquema exacto:
{
  "transcripcion": "texto literal de lo que dijo el usuario (si fue audio; si fue texto, repítelo)",
  "intencion": "REGISTRAR_AVANCE" | "CONFIRMAR_REGISTRO" | "CANCELAR_REGISTRO" | "SESION_ESCANEO" | "CONSULTAR_ITEM" | "ENVIAR_ISOMETRICO" | "ENVIAR_PID" | "ENVIAR_FOTO" | "CONSULTA_GENERAL" | "FALTA_DATO" | "SALUDO" | "OTRO",
  "items": [
    {
      "entidad": "spool" | "valvula" | "soporte",
      "item": "identificador tal como lo dijo el usuario (tag spool, VAL085 u 85, ITEM soporte)",
      "status": "estado (spools: uno de los permitidos; válvula: Montada; soporte: Montado) o null",
      "mts_montados": número o null,
      "ubicacion": "string o null",
      "observacion": "string o null",
      "hoja": "string o null",
      "soldador": "string o null",
      "responsable": "string o null"
    }
  ],
  "respuesta_bot": "respuesta conversacional para el usuario (obligatoria siempre)"
}
Si no hay ítems que reportar/consultar, "items" va como arreglo vacío [].`;
}

/**
 * Procesa un mensaje (texto o audio) con historial conversacional.
 * @returns {object} JSON de intención según el esquema del prompt.
 */
async function procesarMensaje({ texto, audio, historial = [], botConf, contexto = {} }) {
    if (!CONFIG.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY no configurada');

    const systemInstruction = construirSystemPrompt(botConf, contexto);

    const parts = [];
    if (audio && audio.data) {
        parts.push({ inlineData: { mimeType: audio.mimeType || 'audio/ogg', data: audio.data } });
        parts.push({ text: 'Transcribe el audio anterior y procesa la solicitud según tus reglas.' });
    } else {
        parts.push({ text: texto || '' });
    }

    const contents = [
        ...historial, // [{ role: 'user'|'model', parts: [{text}] }]
        { role: 'user', parts }
    ];

    const res = await fetch(
        `${GEMINI_BASE}/${CONFIG.GEMINI_MODEL}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemInstruction }] },
                contents,
                generationConfig: {
                    responseMimeType: 'application/json',
                    temperature: 0.2
                }
            })
        }
    );

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Gemini ${res.status}: ${body.substring(0, 200)}`);
    }

    const data = await res.json();
    const rawText = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';

    try {
        return JSON.parse(rawText);
    } catch (e) {
        // Intento de rescate: extraer el primer bloque {...}
        const match = rawText.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
        throw new Error(`Gemini devolvió JSON inválido: ${rawText.substring(0, 150)}`);
    }
}

/**
 * Sintetiza voz con Gemini TTS. Devuelve PCM crudo base64 (24kHz mono s16le)
 * que el wa-bridge convierte a OGG Opus con ffmpeg.
 */
async function sintetizarVoz(texto) {
    if (!CONFIG.GEMINI_API_KEY) return null;

    const res = await fetch(
        `${GEMINI_BASE}/${CONFIG.GEMINI_TTS_MODEL}:generateContent?key=${CONFIG.GEMINI_API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: texto }] }],
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: CONFIG.GEMINI_TTS_VOZ } }
                    }
                }
            })
        }
    );

    if (!res.ok) {
        const body = await res.text();
        console.error(`[gemini-tts] Error ${res.status}:`, body.substring(0, 200));
        return null;
    }

    const data = await res.json();
    const partsOut = data.candidates?.[0]?.content?.parts || [];
    for (const part of partsOut) {
        if (part.inlineData?.mimeType?.startsWith('audio/')) return part.inlineData.data;
    }
    return null;
}

module.exports = { procesarMensaje, sintetizarVoz };
