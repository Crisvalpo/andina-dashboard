/**
 * Render Spools Component — Andina Piping Dashboard
 */
import { state, charts } from '../modules/state.js';
import { setText, iconBg } from '../utils/domUtils.js';
import { resolveSpoolId, normalizeStatus, resolveSpoolStatuses } from '../utils/statusHelpers.js';

export const SPOOL_STATUS_VISUAL = {
    'EN FABRICACIÓN':  { icon: 'fa-tools',                label: 'En Fabricación',  order: 1 },
    'QAQC':            { icon: 'fa-clipboard-check',      label: 'QAQC',             order: 2 },
    'EN PINT/REVEST.': { icon: 'fa-paint-roller',         label: 'En Pint/Revest.',  order: 3 },
    'RETIRAR':         { icon: 'fa-exclamation-triangle',  label: 'Retirar',          order: 4 },
    'POR MONTAR':      { icon: 'fa-truck',                 label: 'Por Montar',       order: 5 },
    'POSICIONADO':     { icon: 'fa-map-marker-alt',        label: 'Posicionado',      order: 6 },
    'MONTADO':         { icon: 'fa-check-circle',          label: 'Montado',          order: 7 },
    'ELIMINADO':       { icon: 'fa-trash-alt',             label: 'Eliminado',        order: 0 },
    'SIN ESTADO':      { icon: 'fa-question-circle',       label: 'Sin Estado',       order: 999 },
};

export function getSpoolStatusVisual(normalizedStatus) {
    const bimColorFn = window.bimColorDeEstado || (() => [0.5, 0.5, 0.5, 1]);
    const bimRgbHexFn = window.bimRgbAHex || (() => '#64748b');

    const bimRgba = bimColorFn(normalizedStatus);
    const color = bimRgbHexFn(bimRgba);

    const known = SPOOL_STATUS_VISUAL[normalizedStatus];
    if (known) return { ...known, color };

    return {
        icon: 'fa-tag',
        color,
        label: normalizedStatus.charAt(0) + normalizedStatus.slice(1).toLowerCase(),
        order: 500
    };
}

export function renderSpools() {
    const { spools } = state;

    if (window.bimState && !window.bimState._coloresCargados && typeof window.bimCargarColoresEstados === 'function') {
        window.bimCargarColoresEstados().then(() => {
            window.bimState._coloresCargados = true;
            if (state.currentSection === 'spools') renderSpools();
        });
        window.bimState._coloresCargados = true;
    }

    const statusMap = resolveSpoolStatuses();
    const statusCounts = {};
    let cSinRegistro = 0;
    let cTotalActivos = 0;

    spools.forEach(s => {
        const spoolId = resolveSpoolId(s);
        const rawStatus = statusMap.get(spoolId);
        if (!rawStatus) {
            cSinRegistro++;
            cTotalActivos++;
            return;
        }
        const normalized = normalizeStatus(rawStatus);
        statusCounts[normalized] = (statusCounts[normalized] || 0) + 1;
        if (normalized !== 'ELIMINADO') cTotalActivos++;
    });

    if (cSinRegistro > 0) {
        statusCounts['SIN ESTADO'] = cSinRegistro;
    }

    const sortedStatuses = Object.keys(statusCounts).sort((a, b) => {
        const va = getSpoolStatusVisual(a);
        const vb = getSpoolStatusVisual(b);
        if (a === 'SIN ESTADO') return 1;
        if (b === 'SIN ESTADO') return -1;
        if (va.order !== vb.order) return va.order - vb.order;
        return a.localeCompare(b);
    });

    const container = document.getElementById('spools-status-cards');
    if (container) {
        let cardsHtml = sortedStatuses.map(st => {
            const vis = getSpoolStatusVisual(st);
            const count = statusCounts[st] || 0;
            return `<div class="kpi-card glass">
                <div class="kpi-icon" style="background:${iconBg(vis.color)}"><i class="fas ${vis.icon}" style="color:${vis.color}"></i></div>
                <div>
                    <p class="kpi-label">${vis.label}</p>
                    <p class="kpi-value">${count}</p>
                </div>
            </div>`;
        }).join('');

        cardsHtml += `<div class="kpi-card glass">
            <div class="kpi-icon" style="background:rgba(56, 189, 248, 0.15)"><i class="fas fa-industry" style="color:#38bdf8"></i></div>
            <div>
                <p class="kpi-label">Total Activos</p>
                <p class="kpi-value">${cTotalActivos}</p>
            </div>
        </div>`;

        container.innerHTML = cardsHtml;
    }

    const areaCount = { 'TORRE TRANSFERENCIA': 0, 'PIPE RACK': 0, 'BAJO ESPESADOR': 0, 'POR DEFINIR': 0 };
    const areaMountedCount = { 'TORRE TRANSFERENCIA': 0, 'PIPE RACK': 0, 'BAJO ESPESADOR': 0, 'POR DEFINIR': 0 };

    spools.forEach(s => {
        const area = (s.AREA || s['AREA '] || '').trim().toUpperCase();
        const spoolId = resolveSpoolId(s);
        const st = statusMap.get(spoolId);
        const status = st ? normalizeStatus(st) : '';
        if (status === 'ELIMINADO') return;

        const isMounted = status === 'MONTADO';

        let targetArea = 'POR DEFINIR';
        if (area.includes('TORRE')) {
            targetArea = 'TORRE TRANSFERENCIA';
        } else if (area.includes('PIPE RACK') || area.includes('RACK')) {
            targetArea = 'PIPE RACK';
        } else if (area.includes('BAJO ESPESADOR') || area.includes('ESPESADOR')) {
            targetArea = 'BAJO ESPESADOR';
        }

        areaCount[targetArea]++;
        if (isMounted) areaMountedCount[targetArea]++;
    });

    setText('s-area-torre', areaCount['TORRE TRANSFERENCIA']);
    setText('s-area-rack',  areaCount['PIPE RACK']);
    setText('s-area-bajo',  areaCount['BAJO ESPESADOR']);
    setText('s-area-def',   areaCount['POR DEFINIR']);

    const ctxEstado = document.getElementById('spools-estado-chart');
    if (ctxEstado && typeof Chart !== 'undefined') {
        if (charts.spoolsEstado) charts.spoolsEstado.destroy();

        const chartData = sortedStatuses
            .map(st => ({
                label: st === 'SIN ESTADO' ? 'Sin Registro' : getSpoolStatusVisual(st).label,
                val: statusCounts[st] || 0,
                color: getSpoolStatusVisual(st).color
            }))
            .filter(x => x.val > 0);

        charts.spoolsEstado = new Chart(ctxEstado, {
            type: 'doughnut',
            data: {
                labels: chartData.map(x => x.label),
                datasets: [{
                    data: chartData.map(x => x.val),
                    backgroundColor: chartData.map(x => x.color),
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'right', labels: { color: '#cbd5e1', font: { family: 'Outfit', size: 12 } } }
                }
            }
        });
    }
}

if (typeof window !== 'undefined') {
    window.renderSpools = renderSpools;
    window.getSpoolStatusVisual = getSpoolStatusVisual;
    window.SPOOL_STATUS_VISUAL = SPOOL_STATUS_VISUAL;
}
