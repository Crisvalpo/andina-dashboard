/**
 * Render Juntas Component — Andina Piping Dashboard
 */
import { state, charts } from '../modules/state.js';
import { setText } from '../utils/domUtils.js';

export function renderJuntas() {
    const { juntas, ejecuciones } = state;

    const getEstadoFn = window.getEstado || ((obj) => (obj.STATUS || obj.ESTADO || '').trim());
    const getJuntaIdFn = window.getJuntaId || ((obj) => (obj.ID_JUNTA || obj['ID_JUNTA '] || '').trim());
    const getValFn = window.getVal || ((obj, key) => obj[key] || '');

    const ejecutadasSet = new Set(
        ejecuciones
            .filter(e => getEstadoFn(e).toUpperCase().includes('EJECUTAD'))
            .map(e => getJuntaIdFn(e).trim())
            .filter(Boolean)
    );

    let ejecutadas = 0, pendiente = 0;
    let ejecutadasPulg = 0, pendientePulg = 0;

    juntas.forEach(j => {
        const id = (j.ID_JUNTA || j['ID_JUNTA '] || '').trim();
        const npsVal = getValFn(j, 'NPS') || getValFn(j, 'NPS_JUNTA') || 0;
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

    if (typeof window.renderWelderChart === 'function') window.renderWelderChart();
    if (typeof window.renderJuntasBreakdown === 'function') window.renderJuntasBreakdown();

    if (charts.donut) charts.donut.destroy();
    const dCtx = document.getElementById('donutChart');
    if (dCtx && typeof Chart !== 'undefined') {
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
            }
        });
    }
}

if (typeof window !== 'undefined') {
    window.renderJuntas = renderJuntas;
}
