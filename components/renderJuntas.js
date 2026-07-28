/**
 * Render Juntas Component — Andina Piping Dashboard
 *
 * Avance de juntas: contadores ejecutadas/pendientes en unidades y pulgadas,
 * dona de avance, barras por fluido de servicio y tabla de la semana activa.
 * Delega en charts.js los gráficos de soldador y el desglose taller/terreno.
 */
import { state, charts } from '../modules/state.js';
import { setText } from '../utils/domUtils.js';
import {
    getVal, getEstado, getJuntaId, getEtapaBadge, getMaxEtapa,
    getWeekOfDate, parseDate, formatDate
} from '../utils/dataHelpers.js';
import { barLabelsPlugin, doughnutLabelsPlugin } from './chartPlugins.js';
import { renderWelderChart, renderJuntasBreakdown } from './charts.js';

export function renderJuntas() {
    const { juntas, ejecuciones } = state;

    // Construir un Set de IDs de juntas que tienen al menos un registro EJECUTADA
    const ejecutadasSet = new Set(
        ejecuciones
            .filter(e => getEstado(e).toUpperCase().includes('EJECUTAD'))
            .map(e => getJuntaId(e).trim())
            .filter(Boolean)
    );

    // Count por estado: ejecutadas vs sin iniciar
    let ejecutadas = 0, pendiente = 0;
    let ejecutadasPulg = 0, pendientePulg = 0;

    juntas.forEach(j => {
        const id = (j.ID_JUNTA || j['ID_JUNTA '] || '').trim();
        const npsVal = getVal(j, 'NPS') || getVal(j, 'NPS_JUNTA') || 0;
        const nps = parseFloat(npsVal);
        const validNps = isNaN(nps) ? 0 : nps;
        
        if (ejecutadasSet.has(id)) { 
            ejecutadas++; 
            ejecutadasPulg += validNps;
        } else { 
            pendiente++; 
            pendientePulg += validNps;
        }
    });

    setText('j-ejecutadas', `${ejecutadas} / ${ejecutadasPulg.toLocaleString('es-CL', { maximumFractionDigits: 1 })}"`);
    setText('j-pendiente', `${pendiente} / ${pendientePulg.toLocaleString('es-CL', { maximumFractionDigits: 1 })}"`);

    // Welder DI charts
    renderWelderChart();

    // Desglose Taller vs Terreno
    renderJuntasBreakdown();

    // Donut
    if (charts.donut) charts.donut.destroy();
    const dCtx = document.getElementById('donutChart');
    if (dCtx) {
        charts.donut = new Chart(dCtx, {
            type: 'doughnut',
            data: {
                labels: ['Ejecutadas', 'Sin Iniciar'],
                datasets: [{
                    data: [ejecutadas, pendiente],
                    backgroundColor: ['#10b981', '#334155'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                cutout: '60%',
                plugins: { legend: { position: 'bottom', labels: { color: '#64748b', boxWidth: 12 } } }
            },
            plugins: [doughnutLabelsPlugin]
        });
    }

    // Fluid chart
    let fluids = state.catFluidos.map(f => (f.ID_FLUIDO || f['ID_FLUIDO '] || '').trim()).filter(Boolean);
    if (!fluids.length) fluids = ['CT', 'PW', 'IA', 'GW', 'FP', 'RW']; // fallback

    const fluidTotals = fluids.map(f => juntas.filter(j => (j.ID_ISO || j['ID_ISO '] || '').includes(`-${f}-`)).length);
    const fluidExec = fluids.map(f => {
        const juntasDelFluido = juntas.filter(j => (j.ID_ISO || j['ID_ISO '] || '').includes(`-${f}-`));
        return juntasDelFluido.filter(j => {
            const et = getMaxEtapa(j.ID_JUNTA || j['ID_JUNTA ']);
            return et && et.toUpperCase().includes('EJECUTAD');
        }).length;
    });

    if (charts.fluid) charts.fluid.destroy();
    const fCtx = document.getElementById('fluidChart');
    if (fCtx) {
        charts.fluid = new Chart(fCtx, {
            type: 'bar',
            data: {
                labels: fluids,
                datasets: [
                    { label: 'Total', data: fluidTotals, backgroundColor: 'rgba(99,102,241,0.3)', borderRadius: 4 },
                    { label: 'Ejecutadas', data: fluidExec, backgroundColor: '#6366f1', borderRadius: 4 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    y: { 
                        beginAtZero: true, 
                        grid: { color: '#1e293b' }, 
                        ticks: { color: '#64748b' },
                        grace: '12%'
                    },
                    x: { grid: { display: false }, ticks: { color: '#64748b' } }
                },
                plugins: { legend: { labels: { color: '#64748b', boxWidth: 12 } } }
            },
            plugins: [barLabelsPlugin]
        });
    }

    // Table
    const tbody = document.getElementById('juntas-tbody');
    if (!tbody) return;
    const weekData = ejecuciones.filter(e => getWeekOfDate(e.FECHA_EJECUCION) === state.currentWeek);
    const data = weekData.length > 0 ? weekData : [...ejecuciones].sort((a, b) => parseDate(b.FECHA_EJECUCION) - parseDate(a.FECHA_EJECUCION)).slice(0, 20);

    tbody.innerHTML = data.map(e => {
        return `<tr>
            <td>${getJuntaId(e) || '--'}</td>
            <td>${(e.ID_TIPO_UNION || e['ID_TIPO_UNION '] || '--')}</td>
            <td>${getEtapaBadge(getEstado(e))}</td>
            <td>${(e.RESPONSABLE || e['RESPONSABLE '] || '--')}</td>
            <td>${formatDate(e.FECHA_EJECUCION)}</td>
        </tr>`;
    }).join('') || `<tr><td colspan="5" class="empty-msg">Sin registros en S${state.currentWeek}</td></tr>`;
}

if (typeof window !== 'undefined') {
    window.renderJuntas = renderJuntas;
}
