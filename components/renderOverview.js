/**
 * Render Overview Component — Andina Piping Dashboard
 */
import { state } from '../modules/state.js';
import { setText } from '../utils/domUtils.js';

export function renderOverview() {
    const { lineas, isos, spools, juntas, ejecuciones, sdis } = state;

    setText('kpi-lineas', lineas.length);
    setText('kpi-isos', isos.length);
    const activeSpools = spools.filter(s => !String(s.Proceso || '').trim().startsWith('00.'));
    setText('kpi-spools-total', activeSpools.length);

    const getValFn = window.getVal || ((obj, key) => obj[key] || '');
    const getMaxEtapaFn = window.getMaxEtapa || (() => '');
    const getEstadoFn = window.getEstado || (() => '');
    const getWeekOfDateFn = window.getWeekOfDate || (() => null);

    const totalPulgadas = juntas.reduce((sum, j) => {
        const npsVal = getValFn(j, 'NPS') || getValFn(j, 'NPS_JUNTA') || 0;
        const nps = parseFloat(npsVal);
        return sum + (isNaN(nps) ? 0 : nps);
    }, 0);
    setText('kpi-total-juntas', `${juntas.length} / ${totalPulgadas.toLocaleString('es-CL', { maximumFractionDigits: 1 })}"`);

    const isoLineSet = new Set(
        isos.map(i => (i.ID_LINEA || i['ID_LINEA '] || '').trim()).filter(Boolean)
    );
    const lineasSinIso = lineas.filter(l => {
        const id = (l.ID_LINEA || l['ID_LINEA '] || '').trim();
        return id && !id.toUpperCase().startsWith('TIE-IN') && !isoLineSet.has(id);
    }).length;
    const subEl = document.getElementById('kpi-lineas-sin-iso-sub');
    if (subEl) subEl.textContent = lineasSinIso > 0 ? `⚠ ${lineasSinIso} sin ISO` : '✓ Todas cubicadas';

    const ejecutadasJuntas = juntas.filter(j => {
        const et = getMaxEtapaFn(j.ID_JUNTA || j['ID_JUNTA ']);
        return et && et.toUpperCase().includes('EJECUTAD');
    });
    const ejecutadasCant = ejecutadasJuntas.length;
    const ejecutadasPulg = ejecutadasJuntas.reduce((sum, j) => {
        const npsVal = getValFn(j, 'NPS') || getValFn(j, 'NPS_JUNTA') || 0;
        const nps = parseFloat(npsVal);
        return sum + (isNaN(nps) ? 0 : nps);
    }, 0);

    const weekExec = ejecuciones.filter(e => {
        const status = getEstadoFn(e).toUpperCase();
        return status.includes('EJECUTAD') && getWeekOfDateFn(e.FECHA_EJECUCION) === state.currentWeek;
    });
    const semanaActualCant = weekExec.length;
    const semanaActualPulg = weekExec.reduce((sum, e) => {
        const npsVal = getValFn(e, 'NPS') || getValFn(e, 'DIAMETRO_WDI') || 0;
        const nps = parseFloat(npsVal);
        return sum + (isNaN(nps) ? 0 : nps);
    }, 0);

    setText('kpi-ejecutadas', `${ejecutadasCant} / ${ejecutadasPulg.toLocaleString('es-CL', { maximumFractionDigits: 1 })}"`);
    setText('kpi-semana', `${semanaActualCant} / ${semanaActualPulg.toLocaleString('es-CL', { maximumFractionDigits: 1 })}"`);

    const tag = document.getElementById('week-tag');
    if (tag) tag.textContent = `S${state.currentWeek}`;

    if (typeof window.renderSCurve === 'function') window.renderSCurve();
    if (typeof window.renderBarChart === 'function') window.renderBarChart();
}

if (typeof window !== 'undefined') {
    window.renderOverview = renderOverview;
}
