/**
 * Render Spools Component — Andina Piping Dashboard
 *
 * Fabricación de spools: tarjetas KPI por estado (dinámicas, se generan desde
 * los estados que existan en LOG_Spool_MS), conteo por área y tres gráficos
 * (distribución por estado, por área y por fluido).
 *
 * El estado vigente de cada spool sale de resolveSpoolStatuses(), la misma
 * regla que usan el visor BIM y el bot: último registro por fecha.
 */
import { state, charts } from '../modules/state.js';
import { setText } from '../utils/domUtils.js';
import { resolveSpoolId, normalizeStatus, resolveSpoolStatuses } from '../utils/statusHelpers.js';
import { getWeekOfDate, parseDate, currentISOWeek } from '../utils/dataHelpers.js';
import { barLabelsPlugin, doughnutLabelsPlugin } from './chartPlugins.js';
import { bimState } from '../modules/bimState.js';
import { bimColorDeEstado, bimRgbAHex, bimCargarColoresEstados } from '../modules/bimColors.js';

// --- Configuración visual de estados conocidos para tarjetas KPI ---
// Los COLORES se obtienen de bimColorDeEstado() para mantener sincronía
// con la sección BIM (incluidos los colores editados por el usuario).
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

/** Obtiene icono, color y label para cualquier estado (conocido o nuevo).
 *  El color se toma de bimColorDeEstado() → misma fuente que el visor 3D. */
export function getSpoolStatusVisual(normalizedStatus) {
    // Color: siempre desde la cadena BIM (override usuario → paleta base → auto-hash)
    const bimRgba = bimColorDeEstado(normalizedStatus);
    const color   = bimRgbAHex(bimRgba);

    const known = SPOOL_STATUS_VISUAL[normalizedStatus];
    if (known) return { ...known, color };

    // Estado desconocido: icono genérico
    return {
        icon: 'fa-tag',
        color,
        label: normalizedStatus.charAt(0) + normalizedStatus.slice(1).toLowerCase(),
        order: 500  // después de los conocidos
    };
}

export function renderSpools() {
    const { spools } = state;

    // Pre-cargar colores editados por el usuario desde BIM (no bloquea el render inicial)
    // Si ya hay colores cargados se usa la caché; si no, se hace fetch y se re-renderiza.
    if (!bimState._coloresCargados) {
        bimCargarColoresEstados().then(() => {
            bimState._coloresCargados = true;
            // Re-renderizar tarjetas y chart con los colores reales del usuario
            if (state.currentSection === 'spools') renderSpools();
        });
        bimState._coloresCargados = true; // evitar fetch duplicado
    }

    // --- JERARQUÍA POR STATUS (LOG_Spool_MS) ---
    const statusMap = resolveSpoolStatuses();

    // --- CONTEO DINÁMICO por estado normalizado ---
    const statusCounts = {};  // { 'EN FABRICACIÓN': 57, 'QAQC': 67, ... }
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

    // Agregar "SIN ESTADO" si hay spools sin registro
    if (cSinRegistro > 0) {
        statusCounts['SIN ESTADO'] = cSinRegistro;
    }

    // --- ORDENAR estados: conocidos por orden definido, nuevos alfabético, SIN ESTADO al final ---
    const sortedStatuses = Object.keys(statusCounts).sort((a, b) => {
        const va = getSpoolStatusVisual(a);
        const vb = getSpoolStatusVisual(b);
        // SIN ESTADO siempre al final (antes de Total)
        if (a === 'SIN ESTADO') return 1;
        if (b === 'SIN ESTADO') return -1;
        if (va.order !== vb.order) return va.order - vb.order;
        return a.localeCompare(b);
    });

    // --- CÁLCULO DE SPOOLS MONTADOS POR SEMANA Y DÍA (Filtro Superior state.currentWeek) ---
    const currentWeek = state.currentWeek ?? currentISOWeek();
    const daysLabels = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
    const weekDailyCounts = [0, 0, 0, 0, 0, 0, 0];
    let totalSemanaMontados = 0;

    const dedupeWeekSpoolSet = new Set();
    state.logSpools.forEach(r => {
        const st = (r.STATUS || r['STATUS '] || '').trim().toUpperCase();
        if (st !== 'MONTADO') return;
        const fechaRaw = r.FECHA_LEVANTAMIENTO || r['FECHA_LEVANTAMIENTO '];
        if (getWeekOfDate(fechaRaw) !== currentWeek) return;

        const spoolId = (r.ID_SPOOL || r['ID_SPOOL '] || '').trim();
        const d = parseDate(fechaRaw);
        if (!d || !spoolId) return;

        const dIdx = d.getDay(); // 0=Dom, 1=Lun, ..., 6=Sáb
        const arrIdx = dIdx === 0 ? 6 : dIdx - 1; // 0=Lun, ..., 6=Dom
        if (arrIdx < 0 || arrIdx >= 7) return;

        const dedupeKey = `${spoolId}_${arrIdx}`;
        if (dedupeWeekSpoolSet.has(dedupeKey)) return;
        dedupeWeekSpoolSet.add(dedupeKey);

        weekDailyCounts[arrIdx]++;
        totalSemanaMontados++;
    });

    const diasConMontajeSemana = weekDailyCounts.filter(c => c > 0).length;
    const promedioSemanal = diasConMontajeSemana > 0 ? (totalSemanaMontados / diasConMontajeSemana).toFixed(1) : '0';

    // Montados hoy (fecha calendario actual)
    const now = new Date();
    let montadosHoy = 0;
    const todayISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const dedupeTodaySpoolSet = new Set();
    state.logSpools.forEach(r => {
        const st = (r.STATUS || r['STATUS '] || '').trim().toUpperCase();
        if (st !== 'MONTADO') return;
        const d = parseDate(r.FECHA_LEVANTAMIENTO || r['FECHA_LEVANTAMIENTO ']);
        if (!d) return;
        const dateISO = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (dateISO === todayISO) {
            const spoolId = (r.ID_SPOOL || r['ID_SPOOL '] || '').trim();
            if (spoolId && !dedupeTodaySpoolSet.has(spoolId)) {
                dedupeTodaySpoolSet.add(spoolId);
                montadosHoy++;
            }
        }
    });

    // --- CONTEOS PARA TARJETAS CONTRAÍDAS ---
    const cTotal = spools.length;
    const cEliminados = statusCounts['ELIMINADO'] || 0;
    const cPorMontar = statusCounts['POR MONTAR'] || 0;
    const cPosicionado = statusCounts['POSICIONADO'] || 0;
    const cMontados = statusCounts['MONTADO'] || 0;

    // Suma de todos los otros estados distintos
    let cOtros = 0;
    const otrosDetalle = [];
    Object.keys(statusCounts).forEach(st => {
        if (!['ELIMINADO', 'POR MONTAR', 'POSICIONADO', 'MONTADO'].includes(st)) {
            const cnt = statusCounts[st] || 0;
            cOtros += cnt;
            if (cnt > 0) {
                const lbl = st === 'SIN ESTADO' ? 'Sin Registro' : getSpoolStatusVisual(st).label;
                otrosDetalle.push(`${lbl}: ${cnt}`);
            }
        }
    });

    // --- GENERAR TARJETAS CONTRAÍDAS ---
    const container = document.getElementById('spools-status-cards');
    if (container) {
        /** Convierte hex (#rrggbb) a rgba con alpha 0.15 para fondo del icono */
        function iconBg(hex) {
            if (!hex || typeof hex !== 'string' || !hex.startsWith('#')) return 'rgba(100, 116, 139, 0.15)';
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            return `rgba(${r}, ${g}, ${b}, 0.15)`;
        }

        const visEliminado   = getSpoolStatusVisual('ELIMINADO');
        const visPorMontar   = getSpoolStatusVisual('POR MONTAR');
        const visPosicionado = getSpoolStatusVisual('POSICIONADO');
        const visMontado     = getSpoolStatusVisual('MONTADO');
        const tooltipOtros   = otrosDetalle.join(' | ');

        let cardsHtml = `
            <!-- Total General -->
            <div class="kpi-card glass">
                <div class="kpi-icon" style="background:rgba(56, 189, 248, 0.15)"><i class="fas fa-cubes" style="color:#38bdf8"></i></div>
                <div>
                    <p class="kpi-label">Total</p>
                    <p class="kpi-value">${cTotal}</p>
                </div>
            </div>

            <!-- Eliminados -->
            <div class="kpi-card glass">
                <div class="kpi-icon" style="background:${iconBg(visEliminado.color)}"><i class="fas ${visEliminado.icon}" style="color:${visEliminado.color}"></i></div>
                <div>
                    <p class="kpi-label">${visEliminado.label}</p>
                    <p class="kpi-value">${cEliminados}</p>
                </div>
            </div>

            <!-- Activos -->
            <div class="kpi-card glass">
                <div class="kpi-icon" style="background:rgba(14, 165, 233, 0.15)"><i class="fas fa-industry" style="color:#0ea5e9"></i></div>
                <div>
                    <p class="kpi-label">Activos</p>
                    <p class="kpi-value">${cTotalActivos}</p>
                </div>
            </div>

            <!-- Por Montar -->
            <div class="kpi-card glass">
                <div class="kpi-icon" style="background:${iconBg(visPorMontar.color)}"><i class="fas ${visPorMontar.icon}" style="color:${visPorMontar.color}"></i></div>
                <div>
                    <p class="kpi-label">${visPorMontar.label}</p>
                    <p class="kpi-value">${cPorMontar}</p>
                </div>
            </div>

            <!-- Posicionado -->
            <div class="kpi-card glass">
                <div class="kpi-icon" style="background:${iconBg(visPosicionado.color)}"><i class="fas ${visPosicionado.icon}" style="color:${visPosicionado.color}"></i></div>
                <div>
                    <p class="kpi-label">${visPosicionado.label}</p>
                    <p class="kpi-value">${cPosicionado}</p>
                </div>
            </div>

            <!-- Montados -->
            <div class="kpi-card glass">
                <div class="kpi-icon" style="background:${iconBg(visMontado.color)}"><i class="fas ${visMontado.icon}" style="color:${visMontado.color}"></i></div>
                <div>
                    <p class="kpi-label">${visMontado.label}</p>
                    <p class="kpi-value">${cMontados}</p>
                </div>
            </div>

            <!-- Otros Estados (Suma de los demás) -->
            <div class="kpi-card glass" ${tooltipOtros ? `title="${tooltipOtros}" style="cursor:help;"` : ''}>
                <div class="kpi-icon" style="background:rgba(245, 158, 11, 0.15)"><i class="fas fa-tools" style="color:#f59e0b"></i></div>
                <div>
                    <p class="kpi-label">Otros Estados</p>
                    <p class="kpi-value">${cOtros}</p>
                </div>
            </div>

            <!-- Montados Hoy -->
            <div class="kpi-card glass" style="border: 1px solid rgba(16, 185, 129, 0.3);">
                <div class="kpi-icon" style="background:rgba(16, 185, 129, 0.15)"><i class="fas fa-calendar-day" style="color:#10b981"></i></div>
                <div>
                    <p class="kpi-label">Montados Hoy</p>
                    <p class="kpi-value">${montadosHoy} <span style="font-size:0.75rem; font-weight:normal; color:#10b981;" title="Promedio de la semana S${currentWeek}">(${promedioSemanal} prom/d)</span></p>
                </div>
            </div>
        `;

        container.innerHTML = cardsHtml;
    }

    // --- CONTEO POR ÁREA (LIST_Spools_MS_ columna AREA) ---
    const AREAS_VALIDAS = ['TORRE TRANSFERENCIA', 'TORRE TRASFERENCIA', 'PIPE RACK', 'BAJO ESPESADOR'];
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
        if (isMounted) {
            areaMountedCount[targetArea]++;
        }
    });

    setText('s-area-torre', areaCount['TORRE TRANSFERENCIA']);
    setText('s-area-rack',  areaCount['PIPE RACK']);
    setText('s-area-bajo',  areaCount['BAJO ESPESADOR']);
    setText('s-area-def',   areaCount['POR DEFINIR']);

    // --- Gráfico: Distribución por Estado (DINÁMICO) ---
    const ctxEstado = document.getElementById('spools-estado-chart');
    if (ctxEstado) {
        if (charts.spoolsEstado) charts.spoolsEstado.destroy();

        // Usar los mismos estados dinámicos (sin "SIN ESTADO" que se muestra como "Sin Registro" en el chart)
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
                responsive: true, maintainAspectRatio: false,
                cutout: '70%',
                plugins: { legend: { position: 'right', labels: { color: '#64748b', boxWidth: 12 } } }
            },
            plugins: [doughnutLabelsPlugin]
        });
    }

    // --- Gráfico: Spools por Área ---
    const ctxArea = document.getElementById('spools-area-chart');
    if (ctxArea) {
        if (charts.spoolsArea) charts.spoolsArea.destroy();
        const aLabels = ['Torre Transf.', 'Pipe Rack', 'Bajo Espesador', 'Por Definir'];
        const aMountedData = [
            areaMountedCount['TORRE TRANSFERENCIA'],
            areaMountedCount['PIPE RACK'],
            areaMountedCount['BAJO ESPESADOR'],
            areaMountedCount['POR DEFINIR']
        ];
        const aTotalData = [
            areaCount['TORRE TRANSFERENCIA'],
            areaCount['PIPE RACK'],
            areaCount['BAJO ESPESADOR'],
            areaCount['POR DEFINIR']
        ];
        const aPendingData = aTotalData.map((tot, idx) => tot - aMountedData[idx]);

        charts.spoolsArea = new Chart(ctxArea, {
            type: 'bar',
            data: {
                labels: aLabels,
                datasets: [
                    {
                        label: 'Montados',
                        data: aMountedData,
                        backgroundColor: ['#6366f1', '#10b981', '#0ea5e9', '#64748b'],
                        borderRadius: 6
                    },
                    {
                        label: 'Pendientes',
                        data: aPendingData,
                        backgroundColor: [
                            'rgba(99, 102, 241, 0.25)',
                            'rgba(16, 185, 129, 0.25)',
                            'rgba(14, 165, 233, 0.25)',
                            'rgba(100, 116, 139, 0.25)'
                        ],
                        borderRadius: 6
                    }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    y: { 
                        stacked: true,
                        beginAtZero: true, 
                        grid: { color: '#1e293b' }, 
                        ticks: { color: '#64748b' },
                        grace: '12%'
                    },
                    x: { 
                        stacked: true,
                        grid: { display: false }, 
                        ticks: { color: '#64748b' } 
                    }
                },
                plugins: { legend: { display: false } }
            },
            plugins: [barLabelsPlugin]
        });
    }

    // --- Gráfico: Spools por Fluido ---
    const ctxFluido = document.getElementById('spools-fluido-chart');
    if (ctxFluido) {
        if (charts.spoolsFluido) charts.spoolsFluido.destroy();

        let fluidList = state.catFluidos.map(f => (f.ID_FLUIDO || f['ID_FLUIDO '] || '').trim()).filter(Boolean);
        if (!fluidList.length) fluidList = ['CT', 'PW', 'IA', 'GW', 'FP', 'RW'];

        const fluidosMap = {};
        const fluidosMountedMap = {};
        fluidList.forEach(f => {
            fluidosMap[f] = 0;
            fluidosMountedMap[f] = 0;
        });
        fluidosMap['OTROS'] = 0;
        fluidosMountedMap['OTROS'] = 0;

        spools.forEach(s => {
            const val = (s.ID_ISO || s['ID_ISO '] || s.LINEA || '').toUpperCase();
            const spoolId = resolveSpoolId(s);
            const st = statusMap.get(spoolId);
            const status = st ? normalizeStatus(st) : '';
            if (status === 'ELIMINADO') return;

            const isMounted = status === 'MONTADO';

            const fl = fluidList.find(f => val.includes(`-${f}-`) || val.includes(`/${f}/`));
            const targetFluid = fl || 'OTROS';
            fluidosMap[targetFluid]++;
            if (isMounted) {
                fluidosMountedMap[targetFluid]++;
            }
        });

        const labels = Object.keys(fluidosMap).filter(l => fluidosMap[l] > 0).sort((a, b) => fluidosMap[b] - fluidosMap[a]).slice(0, 6);
        const fTotalData = labels.map(l => fluidosMap[l]);
        const fMountedData = labels.map(l => fluidosMountedMap[l]);
        const fPendingData = fTotalData.map((tot, idx) => tot - fMountedData[idx]);

        charts.spoolsFluido = new Chart(ctxFluido, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Montados',
                        data: fMountedData,
                        backgroundColor: '#0ea5e9',
                        borderRadius: 4
                    },
                    {
                        label: 'Pendientes',
                        data: fPendingData,
                        backgroundColor: 'rgba(14, 165, 233, 0.25)',
                        borderRadius: 4
                    }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    y: { 
                        stacked: true,
                        beginAtZero: true, 
                        grid: { color: '#1e293b' }, 
                        ticks: { color: '#64748b' },
                        grace: '12%'
                    },
                    x: { 
                        stacked: true,
                        grid: { display: false }, 
                        ticks: { color: '#64748b' } 
                    }
                },
                plugins: { legend: { display: false } }
            },
            plugins: [barLabelsPlugin]
        });
    }

    // --- Actualizar indicadores de semana y promedio semanal ---
    const weekTagEl = document.getElementById('spools-chart-week-tag');
    if (weekTagEl) {
        weekTagEl.textContent = `S${currentWeek}`;
    }

    const promedioBadge = document.getElementById('spools-montados-promedio-badge');
    if (promedioBadge) {
        promedioBadge.textContent = `Semana S${currentWeek}: ${totalSemanaMontados} spools (${promedioSemanal} prom/d)`;
    }

    // --- Gráfico: Spools Montados por Día (Semanal) ---
    const ctxMontadosDia = document.getElementById('spools-montados-dia-chart');
    if (ctxMontadosDia) {
        if (charts.spoolsMontadosDia) charts.spoolsMontadosDia.destroy();

        // Gradiente verde esmeralda para las barras de montaje diario
        const ctx2d = ctxMontadosDia.getContext('2d');
        let bgGradient = '#10b981';
        if (ctx2d) {
            const grad = ctx2d.createLinearGradient(0, 0, 0, 260);
            grad.addColorStop(0, '#10b981');
            grad.addColorStop(1, '#059669');
            bgGradient = grad;
        }

        charts.spoolsMontadosDia = new Chart(ctxMontadosDia, {
            type: 'bar',
            data: {
                labels: daysLabels,
                datasets: [{
                    label: `Spools Montados (S${currentWeek})`,
                    data: weekDailyCounts,
                    backgroundColor: bgGradient,
                    hoverBackgroundColor: '#34d399',
                    borderRadius: 6,
                    maxBarThickness: 46
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: { color: '#1e293b' },
                        ticks: {
                            color: '#64748b',
                            precision: 0
                        },
                        grace: '18%'
                    },
                    x: {
                        grid: { display: false },
                        ticks: {
                            color: '#64748b',
                            font: { weight: '500' }
                        }
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (items) => `${items[0].label} (Semana S${currentWeek})`,
                            label: (item) => ` Montados: ${item.raw} spools`
                        }
                    }
                }
            },
            plugins: [barLabelsPlugin]
        });
    }
}

if (typeof window !== 'undefined') {
    window.SPOOL_STATUS_VISUAL  = SPOOL_STATUS_VISUAL;
    window.getSpoolStatusVisual = getSpoolStatusVisual;
    window.renderSpools         = renderSpools;
}
