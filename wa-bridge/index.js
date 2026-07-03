/**
 * WA-Bridge — Dashboard Andina (instancia exclusiva)
 * Microservicio WhatsApp basado en Baileys.
 * Puerto: 3035 (separado de delivery=3015 y equipos=3025).
 *
 * Reenvía los mensajes entrantes (texto/audio/imagen/ubicación) al webhook
 * del dashboard Express (/api/whatsapp-incoming) y expone endpoints para
 * enviar mensajes, presencia, estado, QR (dataURL) y reinicio de sesión.
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const pino = require("pino");
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { exec } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const PORT = process.env.WA_BRIDGE_PORT || 3035;
const WEBHOOK_URL = process.env.WA_WEBHOOK_URL || "http://localhost:3005/api/whatsapp-incoming";
const AUTH_DIR = path.join(__dirname, "auth_info_baileys");
const TAG = "[andina-wa-bridge]";

let sock = null;
let connectionState = "disconnected";
let latestQr = null;
let botNumber = null;
let botName = null;
let lastConnectedAt = null;

// Cache anti-duplicados (mismo patrón que LukeDelivery/LukeMaquinarias)
const processedMessageIds = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedMessageIds.entries()) {
    if (now - ts > 5 * 60 * 1000) processedMessageIds.delete(id);
  }
}, 60000);

// ================================================================
// CONEXIÓN WHATSAPP
// ================================================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`${TAG} Baileys v${version.join(".")}`);

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      console.log(`\n🔌 ${TAG} Escanea este QR para vincular el bot del Dashboard:`);
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "close") {
      connectionState = "disconnected";
      botNumber = null;
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
          : true;
      console.log(`${TAG} Conexión cerrada, reconectando:`, shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      } else {
        console.log(`${TAG} Sesión desvinculada (loggedOut). Limpiando credenciales para nuevo QR...`);
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (err) {
          console.error(`${TAG} Error limpiando credenciales:`, err.message);
        }
        latestQr = null;
        connectToWhatsApp();
      }
    } else if (connection === "open") {
      connectionState = "connected";
      latestQr = null;
      lastConnectedAt = new Date().toISOString();
      botNumber = sock.user?.id ? sock.user.id.split("@")[0].split(":")[0] : null;
      botName = sock.user?.name || null;
      console.log(`${TAG} ✅ Conectado a WhatsApp como +${botNumber} (${botName || "sin nombre"})`);
    } else if (connection === "connecting") {
      connectionState = "connecting";
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // ================================================================
  // MENSAJES ENTRANTES → webhook del dashboard
  // ================================================================
  sock.ev.on("messages.upsert", async (m) => {
    if (m.type !== "notify") return;

    for (const msg of m.messages) {
      if (msg.key.fromMe) continue;
      // Ignorar grupos: el bot es de reporte 1 a 1
      if (msg.key.remoteJid?.endsWith("@g.us")) continue;

      const msgId = msg.key.id;
      if (msgId) {
        if (processedMessageIds.has(msgId)) continue;
        processedMessageIds.set(msgId, Date.now());
      }

      const senderJid = msg.key.remoteJid;
      const getCleanId = (jid) => (jid ? jid.split("@")[0].split(":")[0] : null);
      const mePhone = sock.user?.id ? getCleanId(sock.user.id) : null;
      const meLid = sock.user?.lid ? getCleanId(sock.user.lid) : null;
      const senderClean = getCleanId(senderJid);

      if ((mePhone && senderClean === mePhone) || (meLid && senderClean === meLid)) continue;

      const messageText =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        "";

      const isAudio = !!msg.message?.audioMessage;
      const isImage = !!msg.message?.imageMessage;
      const isLocation = !!msg.message?.locationMessage || !!msg.message?.liveLocationMessage;

      if (!messageText.trim() && !isAudio && !isImage && !isLocation) continue;

      let audioData = null;
      if (isAudio) {
        console.log(`${TAG} 🎤 Audio de ${senderClean}`);
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {}, {
            logger: pino({ level: "silent" }),
            reuploadRequest: sock.updateMediaMessage,
          });
          audioData = {
            data: buffer.toString("base64"),
            mimeType: msg.message.audioMessage.mimetype || "audio/ogg; codecs=opus",
          };
        } catch (err) {
          console.error(`${TAG} Error descargando audio:`, err.message);
        }
      }

      let imageData = null;
      if (isImage) {
        console.log(`${TAG} 📷 Imagen de ${senderClean}`);
        try {
          const buffer = await downloadMediaMessage(msg, "buffer", {}, {
            logger: pino({ level: "silent" }),
            reuploadRequest: sock.updateMediaMessage,
          });
          imageData = {
            data: buffer.toString("base64"),
            mimeType: msg.message.imageMessage.mimetype || "image/jpeg",
          };
        } catch (err) {
          console.error(`${TAG} Error descargando imagen:`, err.message);
        }
      }

      let locationData = null;
      if (isLocation) {
        const loc = msg.message?.locationMessage || msg.message?.liveLocationMessage;
        locationData = {
          latitude: loc.degreesLatitude,
          longitude: loc.degreesLongitude,
          name: loc.name || null,
          address: loc.address || null,
        };
      }

      try {
        const headers = { "Content-Type": "application/json" };
        if (process.env.WA_BRIDGE_SECRET) {
          headers["x-wa-bridge-secret"] = process.env.WA_BRIDGE_SECRET;
        }

        const response = await fetch(WEBHOOK_URL, {
          method: "POST",
          headers,
          body: JSON.stringify({
            phone: senderClean,
            jid: senderJid,
            message: messageText,
            audio: audioData,
            image: imageData,
            location: locationData,
            pushName: msg.pushName || null,
            timestamp: msg.messageTimestamp,
            senderPn: msg.key.senderPn || null,
          }),
        });

        console.log(`${TAG} Webhook → ${response.status}`);
      } catch (err) {
        console.error(`${TAG} Error webhook:`, err.message);
      }
    }
  });
}

// ================================================================
// API ENDPOINTS
// ================================================================

// Estado + número del bot (para el panel de configuración del dashboard)
app.get("/status", (req, res) => {
  res.json({
    success: true,
    service: "andina-wa-bridge",
    status: connectionState,
    botNumber,
    botName,
    lastConnectedAt,
    hasQr: Boolean(latestQr),
  });
});

// QR como string + dataURL (para renderizar en el panel web)
app.get("/qr", async (req, res) => {
  let qrDataUrl = null;
  if (latestQr) {
    try {
      qrDataUrl = await QRCode.toDataURL(latestQr, { margin: 1, width: 300 });
    } catch (e) {
      console.error(`${TAG} Error generando dataURL del QR:`, e.message);
    }
  }
  res.json({ success: true, qr: latestQr, qrDataUrl, status: connectionState, botNumber });
});

// Reiniciar la conexión. Con { logout: true } desvincula la sesión
// (borra credenciales) para forzar un QR nuevo.
app.post("/restart", async (req, res) => {
  const { logout } = req.body || {};
  try {
    if (sock) {
      try {
        if (logout) await sock.logout().catch(() => {});
        sock.end(undefined);
      } catch (e) { /* socket ya cerrado */ }
      sock = null;
    }
    if (logout) {
      try {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } catch (e) {
        console.error(`${TAG} Error limpiando credenciales:`, e.message);
      }
    }
    latestQr = null;
    connectionState = "disconnected";
    botNumber = null;
    setTimeout(() => connectToWhatsApp(), 500);
    res.json({ success: true, message: logout ? "Sesión desvinculada, se generará un QR nuevo" : "Reconectando..." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Enviar mensaje de texto, audio (PCM base64 → OGG Opus), documento o imagen
app.post("/send", async (req, res) => {
  const { to, text, audioBase64, fileUrl, fileName, mimetype, caption, tipo } = req.body;

  if (!to) return res.status(400).json({ success: false, message: "Falta destinatario (to)" });
  if (connectionState !== "connected" || !sock) {
    return res.status(503).json({ success: false, message: "WhatsApp no conectado" });
  }

  try {
    const formattedNum = to.includes("@") ? to : `${to.replace(/[^0-9]/g, "")}@s.whatsapp.net`;
    let sentMsg;

    if (fileUrl) {
      // Documento o imagen desde URL (ej: isométricos PDF / fotos de terreno en AppSheet)
      console.log(`${TAG} 📎 Enviando ${tipo || "document"} desde URL: ${fileName || fileUrl.substring(0, 60)}`);
      const fResp = await fetch(fileUrl);
      if (!fResp.ok) throw new Error(`No se pudo descargar el archivo (HTTP ${fResp.status})`);
      const buffer = Buffer.from(await fResp.arrayBuffer());

      if ((tipo || "document") === "image") {
        sentMsg = await sock.sendMessage(formattedNum, {
          image: buffer,
          caption: caption || "",
        });
      } else {
        sentMsg = await sock.sendMessage(formattedNum, {
          document: buffer,
          mimetype: mimetype || "application/pdf",
          fileName: fileName || "documento.pdf",
          caption: caption || "",
        });
      }
    } else if (audioBase64) {
      const pcmBuffer = Buffer.from(audioBase64, "base64");
      const tempId = crypto.randomBytes(16).toString("hex");
      const tempPcmPath = path.join(__dirname, `temp_${tempId}.pcm`);
      const tempOggPath = path.join(__dirname, `temp_${tempId}.ogg`);

      try {
        fs.writeFileSync(tempPcmPath, pcmBuffer);

        // PCM crudo de Gemini (24kHz mono 16-bit LE) → Opus OGG para WhatsApp
        await new Promise((resolve, reject) => {
          exec(`ffmpeg -y -f s16le -ar 24000 -ac 1 -i "${tempPcmPath}" -c:a libopus -b:a 64k "${tempOggPath}"`, (err, stdout, stderr) => {
            if (err) {
              console.error(`${TAG} Error de ffmpeg:`, stderr);
              return reject(err);
            }
            resolve();
          });
        });

        const oggBuffer = fs.readFileSync(tempOggPath);
        sentMsg = await sock.sendMessage(formattedNum, {
          audio: oggBuffer,
          mimetype: "audio/ogg; codecs=opus",
          ptt: true,
        });
      } finally {
        try {
          if (fs.existsSync(tempPcmPath)) fs.unlinkSync(tempPcmPath);
          if (fs.existsSync(tempOggPath)) fs.unlinkSync(tempOggPath);
        } catch (cleanupErr) {
          console.error(`${TAG} Error limpiando temporales:`, cleanupErr.message);
        }
      }
    } else {
      if (!text) return res.status(400).json({ success: false, message: "Falta texto para enviar" });
      sentMsg = await sock.sendMessage(formattedNum, { text });
    }

    res.json({ success: true, data: sentMsg });
  } catch (err) {
    console.error(`${TAG} Error enviando mensaje:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Presencia (escribiendo/grabando)
app.post("/presence", async (req, res) => {
  const { to, state } = req.body;
  if (!to || !state) return res.status(400).json({ success: false, message: "Falta 'to' o 'state'" });
  if (connectionState !== "connected" || !sock) {
    return res.status(503).json({ success: false, message: "WhatsApp no conectado" });
  }
  try {
    const formattedNum = to.includes("@") ? to : `${to.replace(/[^0-9]/g, "")}@s.whatsapp.net`;
    await sock.sendPresenceUpdate(state, formattedNum);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ================================================================
// ARRANCAR SERVIDOR
// ================================================================
app.listen(PORT, () => {
  console.log(`\n🚀 Andina WA-Bridge corriendo en puerto ${PORT}`);
  console.log(`📡 Webhook destino: ${WEBHOOK_URL}\n`);
  connectToWhatsApp();
});
