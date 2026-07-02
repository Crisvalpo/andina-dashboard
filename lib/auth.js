/**
 * Control de acceso del Dashboard Andina.
 *
 * Modelo: LECTURA abierta para todos (modelo 3D, dashboards, consultas).
 * ESCRITURA protegida por claves compartidas, validadas EN EL SERVIDOR:
 *   - clave BIM  → permiso 'bim'  (vincular elementos 3D a spools en AppSheet)
 *   - clave Bot  → permiso 'bot'  (administrar el bot: config, usuarios, QR)
 *
 * Los tokens son stateless (HMAC-SHA256 firmado con SESSION_SECRET), así que
 * sobreviven a reinicios de PM2 sin necesidad de tabla de sesiones.
 * Las claves y el secreto viven SOLO en .env, nunca se exponen por API.
 */
const crypto = require('crypto');
const { CONFIG } = require('../config');

const TTL_HORAS = 12;

function b64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function firmar(body) {
    return b64url(crypto.createHmac('sha256', CONFIG.SESSION_SECRET || 'insecure-dev-secret').update(body).digest());
}

/** Compara dos strings en tiempo constante (evita fuga de info por timing). */
function igualSeguro(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

/** Crea un token firmado con la lista de permisos concedidos. */
function crearToken(permisos) {
    const payload = { p: permisos, exp: Date.now() + TTL_HORAS * 3600 * 1000 };
    const body = b64url(JSON.stringify(payload));
    return `${body}.${firmar(body)}`;
}

/** Verifica un token. Devuelve la lista de permisos si es válido, o null. */
function verificarToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [body, sig] = token.split('.');
    if (!igualSeguro(sig, firmar(body))) return null;
    try {
        const payload = JSON.parse(b64urlDecode(body).toString('utf8'));
        if (!payload.exp || Date.now() > payload.exp) return null;
        return Array.isArray(payload.p) ? payload.p : [];
    } catch (e) {
        return null;
    }
}

/**
 * Valida una clave contra las configuradas y devuelve los permisos que otorga.
 * Una clave puede desbloquear más de un área si coincide con varias.
 */
function permisosDeClave(clave) {
    if (!clave) return [];
    const perms = [];
    if (CONFIG.CLAVE_BIM && igualSeguro(clave, CONFIG.CLAVE_BIM)) perms.push('bim');
    if (CONFIG.CLAVE_BOT && igualSeguro(clave, CONFIG.CLAVE_BOT)) perms.push('bot');
    return perms;
}

/** Extrae el token del header (Authorization: Bearer / x-edit-token). */
function tokenDeRequest(req) {
    const auth = req.headers['authorization'];
    if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
    return req.headers['x-edit-token'] || null;
}

/** Middleware Express: exige que el token tenga el permiso indicado. */
function requerirPermiso(permiso) {
    return (req, res, next) => {
        const perms = verificarToken(tokenDeRequest(req));
        if (!perms || !perms.includes(permiso)) {
            return res.status(401).json({
                success: false,
                error: 'no_autorizado',
                message: `Acción restringida: requiere clave de ${permiso === 'bim' ? 'edición BIM' : 'administración del bot'}.`
            });
        }
        req.permisos = perms;
        next();
    };
}

module.exports = { crearToken, verificarToken, permisosDeClave, requerirPermiso, TTL_HORAS };
