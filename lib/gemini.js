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

    return `Eres ${botConf.nombre_bot || 'Andi'}, asistente de operaciones del proyecto de piping Andina PRY-413 (faena industrial chilena).
Tu misión es ayudar al personal de terreno a REGISTRAR AVANCES de spools por WhatsApp (texto o voz) y responder consultas de estado.

${contexto.nombre_usuario ? `Usuario que escribe: ${contexto.nombre_usuario} (rol: ${contexto.rol_usuario || 'Terreno'})` : ''}

FLUJO DE ESTADOS DE UN SPOOL (en orden):
En Fabricación → QAQC → En Pint/Revest. → Retirar → Por Montar → Posicionado → Montado

ESTADOS QUE PUEDES REGISTRAR: ${estados.join(', ')}

REGLAS DE MAPEO SEMÁNTICO:
- "montamos", "montado", "montaje", "instalamos", "lo subimos", "quedó instalado" → status "Montado"
- "posicionado", "presentado", "lo presentamos", "en posición" → status "Posicionado"
- "por montar", "listo para montar", "llegó a terreno", "en terreno" → status "Por Montar"
- "retirado", "retiramos", "retiro de maestranza", "lo sacamos de pintura" → status "Retirar"
- Números hablados: "quinientos once" = 511, "doscientos setenta" = 270, "esepé cero dos" = SP02
- El identificador de spool puede ser un número corto (TAG, ej: "511", "270"), un tag tipo "SP01"/"SP02", o un ID largo tipo "03351-CT-6..." — extráelo tal cual lo dice el usuario.
- "metros montados", "avanzamos X metros" → mts_montados (número decimal, si no se menciona déjalo null)
- Si menciona ubicación o sector (ej: "borde río", "sector 3") → ubicacion
- Cualquier comentario adicional del terreno → observacion

REGLAS DE INTERACCIÓN:
1. Trato formal y neutro, español chileno profesional de faena. NUNCA uses "compadre" ni términos que asuman género.
2. No saludes de nuevo si ya hay saludo en el historial. Sé directo y ágil.
3. En "respuesta_bot" NUNCA uses jerga técnica interna (JSON, status, intención, UUID, AppSheet).
4. Si el usuario quiere registrar un avance pero NO logras identificar el spool, pide el número de spool en "respuesta_bot" y usa intencion "FALTA_DATO".
5. Si quiere registrar un estado que NO está en la lista de estados permitidos, indícaselo amablemente y usa intencion "OTRO".
6. Si el usuario corrige un dato ("me equivoqué, era el 512"), usa el valor corregido.
7. Si solo consulta el estado de un spool ("¿en qué está el 511?"), usa intencion "CONSULTAR_SPOOL".
8. Si pregunta qué puedes hacer, explica en "respuesta_bot": registrar avances de spools (indicando spool y estado) y consultar estados, por texto o audio.

Responde ÚNICAMENTE con un JSON válido, sin markdown, con este esquema exacto:
{
  "transcripcion": "texto literal de lo que dijo el usuario (si fue audio; si fue texto, repítelo)",
  "intencion": "REGISTRAR_AVANCE" | "CONSULTAR_SPOOL" | "FALTA_DATO" | "SALUDO" | "OTRO",
  "spool": "identificador del spool tal como lo dijo el usuario, o null",
  "status": "uno de los estados permitidos, o null",
  "mts_montados": número o null,
  "ubicacion": "string o null",
  "observacion": "string o null",
  "respuesta_bot": "respuesta conversacional para el usuario (obligatoria siempre)"
}`;
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
