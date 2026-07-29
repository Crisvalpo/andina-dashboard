/**
 * Status Helpers & Spool Status Normalization — Andina Piping Dashboard
 */
import { state } from '../modules/state.js';

export function resolveSpoolId(s) {
    if (!s) return '';
    return (s.ID_SPOOL || s['ID_SPOOL '] || '').trim();
}

export function normalizeStatus(st) {
    if (!st) return '';
    return st.trim().toUpperCase();
}

export function parseFechaSpool(str) {
    const m = String(str || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return 0;
    const [, mm, dd, yy, hh, mi, ss] = m;
    return new Date(+yy, +mm - 1, +dd, +(hh || 0), +(mi || 0), +(ss || 0)).getTime();
}

export function resolveSpoolStatuses() {
    const statusMap = new Map(); // ID_SPOOL -> { status, fecha, row }
    state.logSpools.forEach(r => {
        const id = (r.ID_SPOOL || r['ID_SPOOL '] || '').trim();
        const st = (r.STATUS || r['STATUS '] || '').trim();
        if (!id || !st) return;
        const fecha = parseFechaSpool(r['FECHA_LEVANTAMIENTO']);
        const row = parseInt(r._RowNumber || '0', 10) || 0;
        const prev = statusMap.get(id);
        if (!prev || fecha > prev.fecha || (fecha === prev.fecha && row > prev.row)) {
            statusMap.set(id, { status: st, fecha, row });
        }
    });
    const result = new Map();
    statusMap.forEach((v, k) => result.set(k, v.status));
    return result;
}

// Exponer globalmente para retrocompatibilidad
if (typeof window !== 'undefined') {
    window.resolveSpoolId = resolveSpoolId;
    window.normalizeStatus = normalizeStatus;
    window.parseFechaSpool = parseFechaSpool;
    window.resolveSpoolStatuses = resolveSpoolStatuses;
}
