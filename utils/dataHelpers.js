/**
 * Data Helpers — Andina Piping Dashboard
 *
 * Lectura y normalización de las filas crudas que devuelve la API de AppSheet,
 * más el cálculo de etapa de una junta y las utilidades de fecha/semana.
 *
 * Es la capa base de la que dependen todos los componentes de render, así que
 * no debe importar nada fuera de modules/state.js: cualquier dependencia hacia
 * arriba crearía un ciclo.
 */
import { state, getProjectWeek } from '../modules/state.js';

// ============ FECHAS Y SEMANA DE PROYECTO ============

export function currentISOWeek() {
    return getProjectWeek();
}

export function parseDate(str) {
    if (!str) return null;
    if (str instanceof Date) return str;

    // Support YYYY-MM-DD and DD/MM/YYYY or MM/DD/YYYY
    const part = String(str).split(' ')[0];
    const s = part.split(/[-/]/);
    if (s.length !== 3) return new Date(str);

    let year, month, day;
    if (s[0].length === 4) {
        // YYYY-MM-DD
        year = parseInt(s[0]);
        month = parseInt(s[1]) - 1;
        day = parseInt(s[2]);
    } else {
        // DD/MM/YYYY or MM/DD/YYYY
        year = parseInt(s[2]);
        if (year < 100) year += 2000;

        let d1 = parseInt(s[0]);
        let d2 = parseInt(s[1]);

        // Logic: If d2 > 12, it must be the day (MM/DD/YYYY)
        // If d1 > 12, it must be the day (DD/MM/YYYY)
        // If both <= 12, we check if month=d2 (DD/MM) results in a week closer to now
        // Current month is April (3), so if one date gives Jan and other gives April, we pick April.
        if (d1 > 12) {
            // DD/MM/YYYY (Salvaguarda en caso de que venga algún registro en formato español)
            month = d2 - 1; day = d1;
        } else {
            // MM/DD/YYYY (Estándar entregado por la API de AppSheet)
            month = d1 - 1; day = d2;
        }
    }

    const res = new Date(year, month, day);
    return isNaN(res.getTime()) ? null : res;
}

// Format date string to DD/MM/AA
export function formatDate(str) {
    if (!str) return '--';
    const part = str.split(' ')[0];
    const s = part.split('/');
    if (s.length === 3) {
        const yy = s[2].length === 4 ? s[2].slice(2) : s[2];
        return `${s[0].padStart(2, '0')}/${s[1].padStart(2, '0')}/${yy}`;
    }
    return part;
}

export function getWeekOfDate(str) {
    const d = parseDate(str);
    return d ? getProjectWeek(d) : null;
}

// ============ LECTURA DE FILAS APPSHEET ============

export function getVal(row, key) {
    if (!row) return '';
    // Handle both "KEY" and "KEY " (trailing space)
    let v = row[key] || row[key.trim()] || row[key.trim() + ' '] || '';
    if (typeof v === 'string') {
        v = v.trim();
        // Handle decimal comma: "4,00" -> "4.00"
        if (/^\d+,\d+$/.test(v)) v = v.replace(',', '.');
    }
    return v;
}

export function getEstado(row) {
    return getVal(row, 'ESTADO_EJECUCION');
}

export function getJuntaId(row) {
    return getVal(row, 'ID_JUNTA');
}

// ============ ETAPA DE JUNTA ============
// REG_EjecucionJuntas_MS: columna ESTADO_EJECUCION
// Valores: "EJECUTADA" | "EMPLANTILLADO" | "CORTE DIMENSIONADO"

export function getEtapaBadge(estado) {
    if (!estado) return '<span class="badge badge-pending">Sin Registro</span>';
    const e = estado.toUpperCase();
    if (e.includes('EJECUTAD')) return `<span class="badge badge-done">EJECUTADA</span>`;
    if (e.includes('EMPLANTILL') || e.includes('PREARMAD')) return `<span class="badge badge-emplantillado">EMPLANTILLADO</span>`;
    if (e.includes('CORTE')) return `<span class="badge badge-corte">CORTE</span>`;
    return `<span class="badge badge-pending">${estado}</span>`;
}

export function getEtapaWeight(estado) {
    if (!estado) return 0;
    const e = estado.toUpperCase();
    if (e.includes('EJECUTAD')) return 3;
    if (e.includes('EMPLANTILL') || e.includes('PREARMAD')) return 2;
    if (e.includes('CORTE')) return 1;
    return 0;
}

// Para cada junta, encuentra su estado más avanzado en ejecuciones
export function getMaxEtapa(idJunta) {
    const id = (idJunta || '').trim();
    const regs = state.ejecuciones.filter(r => getJuntaId(r) === id);
    if (!regs.length) return null;
    return regs.reduce((best, r) => {
        const estado = getEstado(r);
        return getEtapaWeight(estado) > getEtapaWeight(best) ? estado : best;
    }, '');
}

export function getMaterialLabel(material) {
    if (!material) return 'Sin Material (S/M)';
    const m = material.trim().toUpperCase();
    if (m === 'AG') return 'Acero Galvanizado (AG)';
    if (m === 'CS') return 'Acero Carbono (CS)';
    if (m === 'HDPE') return 'HDPE';
    return material.trim();
}

// Exponer en window: index.html los usa en handlers inline y
// bim-ifc-export.js se carga como script clásico (getVal, parseDate, formatDate).
if (typeof window !== 'undefined') {
    window.currentISOWeek    = currentISOWeek;
    window.parseDate         = parseDate;
    window.formatDate        = formatDate;
    window.getWeekOfDate     = getWeekOfDate;
    window.getVal            = getVal;
    window.getEstado         = getEstado;
    window.getJuntaId        = getJuntaId;
    window.getEtapaBadge     = getEtapaBadge;
    window.getEtapaWeight    = getEtapaWeight;
    window.getMaxEtapa       = getMaxEtapa;
    window.getMaterialLabel  = getMaterialLabel;
}
