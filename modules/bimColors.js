/**
 * BIM Status Colors — Andina Piping Dashboard
 *
 * Fuente única del color de cada estado de spool: el visor 3D y las tarjetas
 * KPI de la sección Spools pintan desde aquí, así que un color editado por el
 * usuario se refleja en ambos sitios.
 *
 * Prioridad: override guardado en servidor > paleta base > color auto por hash.
 *
 * Solo depende de bimState.coloresEstados. bimGuardarColorEstado se queda en
 * app.js a propósito: necesita auth y repintar chips, filtro y trozos.
 */
import { bimState } from './bimState.js';

export const BIM_STATUS_COLORS = {
    'MONTADO':         [0.06, 0.75, 0.35, 1], // Verde brillante
    'POSICIONADO':     [0.95, 0.45, 0.10, 1], // Naranja
    'POR MONTAR':      [0.95, 0.85, 0.10, 1], // Amarillo
    'EN PINT/REVEST.': [0.65, 0.30, 0.95, 1], // Morado
    'QAQC':            [0.10, 0.65, 0.95, 1], // Azul
    'EN FABRICACIÓN':  [0.30, 0.80, 0.95, 1], // Celeste
    'RETIRAR':         [0.95, 0.15, 0.15, 1], // Rojo
    'ELIMINADO':       [0.40, 0.40, 0.40, 0.5], // Gris translúcido
    // Intensidad 1: la 4ª componente de setThemingColor es cuánto TIÑE, no
    // transparencia. Con 0.3 el gris casi no se veía y parecía "sin pintar".
    'SIN ESTADO':      [0.50, 0.50, 0.50, 1], // Gris
    // Válvulas / soportes (estado binario)
    'PENDIENTE':       [0.55, 0.55, 0.55, 0.4]  // Gris (pendiente de montaje)
};

export function bimHexARgb(hex) {
    const h = String(hex).replace('#', '');
    return [parseInt(h.substr(0, 2), 16) / 255, parseInt(h.substr(2, 2), 16) / 255, parseInt(h.substr(4, 2), 16) / 255, 1];
}

export function bimRgbAHex(arr) {
    return '#' + arr.slice(0, 3).map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

/** Color automático y estable para estados nuevos (hash → tono HSL). */
export function bimColorAuto(st) {
    let h = 0;
    for (let i = 0; i < st.length; i++) h = (h * 31 + st.charCodeAt(i)) >>> 0;
    const hue = h % 360, s = 0.72, l = 0.55;
    const k = n => (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4), 1];
}

/** Color efectivo de un estado: override guardado > paleta base > auto. */
export function bimColorDeEstado(st) {
    const key = String(st || '').toUpperCase();
    if (bimState.coloresEstados && bimState.coloresEstados[key]) return bimHexARgb(bimState.coloresEstados[key]);
    if (BIM_STATUS_COLORS[key]) return BIM_STATUS_COLORS[key];
    return bimColorAuto(key);
}

export async function bimCargarColoresEstados() {
    try { bimState.coloresEstados = await (await fetch('/api/bim/estado-colores')).json(); }
    catch (e) { bimState.coloresEstados = {}; }
}

if (typeof window !== 'undefined') {
    window.BIM_STATUS_COLORS      = BIM_STATUS_COLORS;
    window.bimHexARgb             = bimHexARgb;
    window.bimRgbAHex             = bimRgbAHex;
    window.bimColorAuto           = bimColorAuto;
    window.bimColorDeEstado       = bimColorDeEstado;
    window.bimCargarColoresEstados = bimCargarColoresEstados;
}
