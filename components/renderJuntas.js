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
import { renderWelderChart } from './charts.js';

export const JUNTA_TYPE_INFO = {
    'BW':  { name: 'Butt Weld',             desc: 'Soldadura a Tope',      icon: 'fa-burn',            color: '#ef4444' },
    'SW':  { name: 'Socket Weld',           desc: 'Enchufe y Soldadura',   icon: 'fa-plug',            color: '#3b82f6' },
    'VIC': { name: 'Grooved (Victaulic)',   desc: 'Acople Ranurado',       icon: 'fa-grip-horizontal', color: '#10b981' },
    'TF':  { name: 'Butt Fusion (HDPE)',    desc: 'Termofusión',           icon: 'fa-fire',            color: '#f59e0b' },
    'THD': { name: 'Threaded (Roscada)',    desc: 'Conexión Roscada',      icon: 'fa-tools',           color: '#8b5cf6' },
    'NPT': { name: 'Threaded NPT',          desc: 'Roscada NPT',           icon: 'fa-wrench',          color: '#a855f7' },
    'SO':  { name: 'Slip On (Bridada)',     desc: 'Soldadura Deslizable',  icon: 'fa-circle-notch',    color: '#06b6d4' },
    'LET': { name: 'Fillet / Weldolet',     desc: 'Filete / Refuerzo',     icon: 'fa-tag',             color: '#ec4899' },
    'BRW': { name: 'Branch Weld',           desc: 'Derivación',            icon: 'fa-code-branch',     color: '#6366f1' },
    'BT':  { name: 'Flanged (Empernada)',   desc: 'Bridada',               icon: 'fa-compress-arrows-alt', color: '#14b8a6' },
    'TW':  { name: 'Tack Weld',             desc: 'Soldadura Puntos',      icon: 'fa-dot-circle',      color: '#64748b' }
};

export const AREA_ORDER = [
    { key: 'TORRE TRANSFERENCIA', label: 'Torre Transferencia', icon: 'fa-broadcast-tower', color: '#6366f1' },
    { key: 'PIPE RACK',           label: 'Pipe Rack',           icon: 'fa-grip-lines',       color: '#10b981' },
    { key: 'BAJO ESPESADOR',      label: 'Bajo Espesador',      icon: 'fa-layer-group',      color: '#0ea5e9' }
];

export function renderJuntasPendientesAreas() {
    const { juntas, ejecuciones, catUniones } = state;
    const container = document.getElementById('juntas-pendientes-areas-container');
    if (!container) return;

    // Set de juntas ejecutadas
    const ejecutadasSet = new Set(
        ejecuciones
            .filter(e => getEstado(e).toUpperCase().includes('EJECUTAD'))
            .map(e => getJuntaId(e).trim())
            .filter(Boolean)
    );

    // Mapa de categorías de uniones
    const catMap = {};
    (catUniones || []).forEach(c => {
        const id = (c.ID_TIPO_UNION || c['ID_TIPO_UNION '] || '').trim().toUpperCase();
        const nmb = (c.NMB_UNION || c['NMB_UNION '] || '').trim();
        if (id) catMap[id] = nmb;
    });

    // Estructura por áreas
    const areaData = {
        'TORRE TRANSFERENCIA': { total: 0, pulg: 0, tipos: {} },
        'PIPE RACK':           { total: 0, pulg: 0, tipos: {} },
        'BAJO ESPESADOR':      { total: 0, pulg: 0, tipos: {} },
        'POR DEFINIR':         { total: 0, pulg: 0, tipos: {} }
    };

    let totalPendientesGlobal = 0;
    let totalPulgPendientesGlobal = 0;

    juntas.forEach(j => {
        const id = (j.ID_JUNTA || j['ID_JUNTA '] || '').trim();
        if (ejecutadasSet.has(id)) return; // solo pendientes

        totalPendientesGlobal++;
        const npsVal = getVal(j, 'NPS') || getVal(j, 'NPS_JUNTA') || 0;
        const nps = parseFloat(npsVal);
        const validNps = isNaN(nps) ? 0 : nps;
        totalPulgPendientesGlobal += validNps;

        // Normalizar área
        const rawArea = (j.AREA || j['AREA '] || '').trim().toUpperCase();
        let targetArea = 'POR DEFINIR';
        if (rawArea.includes('TORRE')) {
            targetArea = 'TORRE TRANSFERENCIA';
        } else if (rawArea.includes('PIPE') || rawArea.includes('RACK')) {
            targetArea = 'PIPE RACK';
        } else if (rawArea.includes('ESPESADOR') || rawArea.includes('BAJO')) {
            targetArea = 'BAJO ESPESADOR';
        }

        const ad = areaData[targetArea];
        ad.total++;
        ad.pulg += validNps;

        // Tipo de unión
        const rawTipo = (j['TIPO UNION'] || j.TIPO_UNION || j.ID_TIPO_UNION || j['ID_TIPO_UNION '] || 'VAR').trim().toUpperCase() || 'VAR';
        if (!ad.tipos[rawTipo]) {
            ad.tipos[rawTipo] = { count: 0, pulg: 0 };
        }
        ad.tipos[rawTipo].count++;
        ad.tipos[rawTipo].pulg += validNps;
    });

    // Actualizar badge superior
    const totalBadge = document.getElementById('juntas-pendientes-total-badge');
    if (totalBadge) {
        totalBadge.textContent = `Total: ${totalPendientesGlobal} pendientes (${totalPulgPendientesGlobal.toLocaleString('es-CL', { maximumFractionDigits: 1 })}")`;
    }

    // Renderizar tarjetas por área
    const areasToRender = AREA_ORDER.filter(a => areaData[a.key] && areaData[a.key].total > 0);
    if (areaData['POR DEFINIR'] && areaData['POR DEFINIR'].total > 0) {
        areasToRender.push({ key: 'POR DEFINIR', label: 'Por Definir', icon: 'fa-question-circle', color: '#64748b' });
    }

    let html = areasToRender.map(areaCfg => {
        const ad = areaData[areaCfg.key];
        const tiposOrdenados = Object.keys(ad.tipos).sort((a, b) => ad.tipos[b].count - ad.tipos[a].count);

        const cardsTiposHtml = tiposOrdenados.map(tipoKey => {
            const tData = ad.tipos[tipoKey];
            const info = JUNTA_TYPE_INFO[tipoKey] || {
                name: catMap[tipoKey] || tipoKey,
                desc: 'Unión',
                icon: 'fa-circle-notch',
                color: '#94a3b8'
            };

            const hex = info.color.startsWith('#') ? info.color : '#94a3b8';
            const r = parseInt(hex.slice(1, 3), 16) || 100;
            const g = parseInt(hex.slice(3, 5), 16) || 116;
            const b = parseInt(hex.slice(5, 7), 16) || 139;
            const bgRgba = `rgba(${r}, ${g}, ${b}, 0.15)`;

            const pulgStr = tData.pulg > 0 ? `(${tData.pulg.toLocaleString('es-CL', { maximumFractionDigits: 1 })}")` : '';

            return `
                <div class="junta-type-kpi" title="${info.name} (${info.desc})">
                    <div class="junta-type-icon" style="background:${bgRgba}; color:${info.color}">
                        <i class="fas ${info.icon}"></i>
                    </div>
                    <div class="junta-type-info">
                        <div class="junta-type-name">${tipoKey} - ${info.name}</div>
                        <div class="junta-type-val">${tData.count} <span class="junta-type-pulg">${pulgStr}</span></div>
                    </div>
                </div>
            `;
        }).join('');

        const cardId = `junta-area-${areaCfg.key.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
        const hexArea = areaCfg.color.startsWith('#') ? areaCfg.color : '#6366f1';
        const ra = parseInt(hexArea.slice(1, 3), 16) || 99;
        const ga = parseInt(hexArea.slice(3, 5), 16) || 102;
        const ba = parseInt(hexArea.slice(5, 7), 16) || 241;
        const bgAreaIcon = `rgba(${ra}, ${ga}, ${ba}, 0.15)`;

        return `
            <div class="junta-area-card glass collapsed" id="${cardId}">
                <div class="junta-area-header" onclick="toggleAreaJuntas('${cardId}')" title="Clic para desplegar / contraer detalles">
                    <div class="junta-area-header-left">
                        <div class="kpi-icon" style="width:44px; height:44px; font-size:1.15rem; background:${bgAreaIcon}; border-radius:10px; display:inline-flex; align-items:center; justify-content:center; flex-shrink:0;">
                            <i class="fas ${areaCfg.icon}" style="color:${areaCfg.color}"></i>
                        </div>
                        <div class="junta-area-header-info">
                            <div class="junta-area-title">${areaCfg.label}</div>
                            <div class="junta-area-big-val">${ad.total} <span class="junta-area-big-sub">pendientes (${ad.pulg.toLocaleString('es-CL', { maximumFractionDigits: 1 })}")</span></div>
                        </div>
                    </div>
                    <div class="junta-area-header-right">
                        <div class="junta-area-toggle-icon">
                            <i class="fas fa-chevron-down"></i>
                        </div>
                    </div>
                </div>
                <div class="junta-area-content">
                    <div class="junta-types-grid">
                        ${cardsTiposHtml}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = html || `<div class="empty-msg" style="padding:2rem; text-align:center;">✓ No hay juntas pendientes registradas</div>`;
}

export function toggleAreaJuntas(id) {
    const card = document.getElementById(id);
    if (card) {
        card.classList.toggle('collapsed');
    }
}

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

    // Juntas Pendientes agrupadas por Tipo y Área (Tarjetas de cantidad no gráfica)
    renderJuntasPendientesAreas();

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
    window.renderJuntas      = renderJuntas;
    window.toggleAreaJuntas  = toggleAreaJuntas;
}
