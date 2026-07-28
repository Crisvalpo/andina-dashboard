/**
 * Render Overview Component — Andina Piping Dashboard
 *
 * KPIs de cabecera del proyecto y disparo de los tres gráficos/tabla de la
 * sección: curva S, barras por fluido y últimos movimientos.
 */
import { state } from '../modules/state.js';
import { setText } from '../utils/domUtils.js';
import { getVal, getEstado, getMaxEtapa, getWeekOfDate } from '../utils/dataHelpers.js';
import { renderSCurve, renderBarChart, renderLogTable } from './charts.js';

export function renderOverview() {
    const { lineas, isos, spools, juntas, ejecuciones, sdis } = state;

    // Totales del proyecto
    setText('kpi-lineas', lineas.length);
    setText('kpi-isos', isos.length);
    const activeSpools = spools.filter(s => !String(s.Proceso || '').trim().startsWith('00.'));
    setText('kpi-spools-total', activeSpools.length);
    
    const totalPulgadas = juntas.reduce((sum, j) => {
        const npsVal = getVal(j, 'NPS') || getVal(j, 'NPS_JUNTA') || 0;
        const nps = parseFloat(npsVal);
        return sum + (isNaN(nps) ? 0 : nps);
    }, 0);
    setText('kpi-total-juntas', `${juntas.length} / ${totalPulgadas.toLocaleString('es-CL', { maximumFractionDigits: 1 })}"`);

    // Líneas sin isométrico — excluye TIE-IN (no requieren cubicación)
    const isoLineSet = new Set(
        isos.map(i => (i.ID_LINEA || i['ID_LINEA '] || '').trim()).filter(Boolean)
    );
    const lineasSinIso = lineas.filter(l => {
        const id = (l.ID_LINEA || l['ID_LINEA '] || '').trim();
        return id && !id.toUpperCase().startsWith('TIE-IN') && !isoLineSet.has(id);
    }).length;
    const subEl = document.getElementById('kpi-lineas-sin-iso-sub');
    if (subEl) subEl.textContent = lineasSinIso > 0 ? `⚠ ${lineasSinIso} sin ISO` : '✓ Todas cubicadas';

    // Estado de avance
    // Count juntas by max state reached in REG_EjecucionJuntas_MS
    const ejecutadasJuntas = juntas.filter(j => {
        const et = getMaxEtapa(j.ID_JUNTA || j['ID_JUNTA ']);
        return et && et.toUpperCase().includes('EJECUTAD');
    });
    const ejecutadasCant = ejecutadasJuntas.length;
    const ejecutadasPulg = ejecutadasJuntas.reduce((sum, j) => {
        const npsVal = getVal(j, 'NPS') || getVal(j, 'NPS_JUNTA') || 0;
        const nps = parseFloat(npsVal);
        return sum + (isNaN(nps) ? 0 : nps);
    }, 0);

    const enProcesoJuntas = juntas.filter(j => {
        const et = getMaxEtapa(j.ID_JUNTA || j['ID_JUNTA ']);
        return et && (et.toUpperCase().includes('PREARMAD') || et.toUpperCase().includes('EMPLANTILL') || et.toUpperCase().includes('CORTE'));
    });
    const enProcesoCant = enProcesoJuntas.length;
    const enProcesoPulg = enProcesoJuntas.reduce((sum, j) => {
        const npsVal = getVal(j, 'NPS') || getVal(j, 'NPS_JUNTA') || 0;
        const nps = parseFloat(npsVal);
        return sum + (isNaN(nps) ? 0 : nps);
    }, 0);

    const sdiPendientes = sdis.filter(s => {
        const est = getVal(s, 'ESTADO').toUpperCase();
        return !est.includes('RESPONDID') && !est.includes('CERRAD');
    }).length;

    // Semana actual (filtrando por ejecuciones ejecutadas)
    const weekExec = ejecuciones.filter(e => {
        const status = getEstado(e).toUpperCase();
        return status.includes('EJECUTAD') && getWeekOfDate(e.FECHA_EJECUCION) === state.currentWeek;
    });
    const semanaActualCant = weekExec.length;
    const semanaActualPulg = weekExec.reduce((sum, e) => {
        const npsVal = getVal(e, 'NPS') || getVal(e, 'DIAMETRO_WDI') || 0;
        const nps = parseFloat(npsVal);
        return sum + (isNaN(nps) ? 0 : nps);
    }, 0);

    setText('kpi-ejecutadas', `${ejecutadasCant} / ${ejecutadasPulg.toLocaleString('es-CL', { maximumFractionDigits: 1 })}"`);
    setText('kpi-en-proceso', `${enProcesoCant} / ${enProcesoPulg.toLocaleString('es-CL', { maximumFractionDigits: 1 })}"`);
    setText('kpi-semana', `${semanaActualCant} / ${semanaActualPulg.toLocaleString('es-CL', { maximumFractionDigits: 1 })}"`);

    const tag = document.getElementById('week-tag');
    if (tag) tag.textContent = `S${state.currentWeek}`;

    // S-Curve chart
    renderSCurve();

    // Bar chart by fluid
    renderBarChart();

    // Latest movements table
    renderLogTable();
}

if (typeof window !== 'undefined') {
    window.renderOverview = renderOverview;
}
