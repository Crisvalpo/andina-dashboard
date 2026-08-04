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
    // Válvulas / soportes: PENDIENTE = sin registro de montaje
    'PENDIENTE':       [0.55, 0.55, 0.55, 0.4], // Gris

    'MONTADA':         [0.06, 0.75, 0.35, 1],
    'POSICIONADA':     [0.95, 0.45, 0.10, 1]
};

export const BIM_SUBSISTEMA_COLORS = {
    '03350-02-01': [1.0, 0.0, 1.0, 1],    // #FF00FF - Agua de Proceso
    '02/01/3350':  [1.0, 0.0, 1.0, 1],    // #FF00FF - Agua de Proceso (código AppSheet)
    '03350-02-02': [0.0, 1.0, 0.0, 1],    // #00FF00 - Agua de Sello
    '03350-02-03': [1.0, 1.0, 0.0, 1],    // #FFFF00 - Concentrado Cu-Mo Espesador
    '03350-02-04': [0.0, 0.98, 0.98, 1],  // #00FAFA - Agua Recuperada
    '03350-02-05': [1.0, 0.0, 0.0, 1],    // #FF0000 - Colectivo Cu-Mo Tie In 001
    '03350-02-06': [0.44, 0.19, 0.63, 1],  // #7030A0 - Colas Primarias Limpieza
    '03350-02-07': [0.49, 0.21, 0.05, 1],  // #7E350E - Aire Instrumentación
    '03350-02-08': [0.39, 0.10, 0.36, 1],  // #641A5B - Contención de derrames
    '03350-02-09': [1.0, 0.75, 0.0, 1],   // #FFC000 - Red de Incendio
    'SIN SUBSISTEMA': [0.50, 0.50, 0.50, 1]
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

/** Color efectivo de un estado: override guardado > paleta base > subsistemas > auto. */
export function bimColorDeEstado(st) {
    const key = String(st || '').toUpperCase().trim();
    if (bimState.coloresEstados && bimState.coloresEstados[key]) return bimHexARgb(bimState.coloresEstados[key]);
    if (BIM_STATUS_COLORS[key]) return BIM_STATUS_COLORS[key];
    if (BIM_SUBSISTEMA_COLORS[key]) return BIM_SUBSISTEMA_COLORS[key];
    // Buscar coincidencia parcial si key incluye código de subsistema
    for (const subCode of Object.keys(BIM_SUBSISTEMA_COLORS)) {
        if (key.includes(subCode)) return BIM_SUBSISTEMA_COLORS[subCode];
    }
    return bimColorAuto(key);
}

export async function bimCargarColoresEstados() {
    try { bimState.coloresEstados = await (await fetch('/api/bim/estado-colores')).json(); }
    catch (e) { bimState.coloresEstados = {}; }
}

if (typeof window !== 'undefined') {
    window.BIM_STATUS_COLORS      = BIM_STATUS_COLORS;
    window.BIM_SUBSISTEMA_COLORS  = BIM_SUBSISTEMA_COLORS;
    window.bimHexARgb             = bimHexARgb;
    window.bimRgbAHex             = bimRgbAHex;
    window.bimColorAuto           = bimColorAuto;
    window.bimColorDeEstado       = bimColorDeEstado;
    window.bimCargarColoresEstados = bimCargarColoresEstados;
}
