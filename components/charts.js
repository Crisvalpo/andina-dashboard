/**
 * Chart & Table Renderers — Andina Piping Dashboard
 *
 * Gráficos y tablas que alimentan las secciones Overview y Juntas.
 * Se apoyan en Chart.js, que llega como global desde el CDN (index.html),
 * y guardan cada instancia en `charts` para poder destruirla antes de
 * redibujar: sin ese destroy() Chart.js apila canvas y filtra memoria.
 */
import { state, charts, getProjectWeek } from '../modules/state.js';
import { setText } from '../utils/domUtils.js';
import {
    getVal, getEstado, getJuntaId, getEtapaBadge, getMaxEtapa,
    getMaterialLabel, getWeekOfDate, parseDate, formatDate
} from '../utils/dataHelpers.js';
import { barLabelsPlugin, lineLabelsPlugin } from './chartPlugins.js';

export function renderWelderChart() {
    const { ejecuciones, personal, currentWeek } = state;
    console.log(`[KPI] Rendering DI charts for S${currentWeek}. Executions: ${ejecuciones.length}, Personal: ${personal.length}`);

    // 1. Personal Map (ESTAMPA -> FullName)
    const personalMap = {};
    personal.forEach(p => {
        const estampa = getVal(p, 'ESTAMPA') || getVal(p, 'ID_PERSONAL');
        const firstName = getVal(p, 'NOMBRES');
        const lastName = getVal(p, 'APELLIDOS');
        const combined = getVal(p, 'NOMBRES APELLIDOS');
        
        const fullName = combined || `${firstName} ${lastName}`.trim() || estampa;
        if (estampa) personalMap[estampa] = fullName;
    });

    // Obtenemos ejecuciones históricas ejecutadas
    const histExec = ejecuciones.filter(e => getEstado(e).toUpperCase().includes('EJECUTAD'));

    // Crear mapa de colores consistentes para cada soldador
    const colors = ['#0ea5e9', '#f59e0b', '#10b981', '#a78bfa', '#ef4444', '#38bdf8', '#fb7185', '#14b8a6', '#f43f5e', '#8b5cf6'];
    const welderColorMap = {};
    const allUniqueWelders = new Set();
    
    histExec.forEach(e => {
        const estampa = (getVal(e, 'ESTAMPA_EJECUTOR') || getVal(e, 'RESPONSABLE'));
        if (estampa) {
            const name = personalMap[estampa] || estampa;
            allUniqueWelders.add(name);
        }
    });

    // Ordenar alfabéticamente para asegurar un mapeo de color determinista
    const sortedAllWelders = Array.from(allUniqueWelders).sort();
    sortedAllWelders.forEach((name, i) => {
        welderColorMap[name] = colors[i % colors.length];
    });

    // 2. Weekly Production (Daily)
    const days = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
    const weekExec = ejecuciones.filter(e => {
        const status = getEstado(e).toUpperCase();
        return status.includes('EJECUTAD') && getWeekOfDate(getVal(e, 'FECHA_EJECUCION')) === currentWeek;
    });

    const welderData = {}; // { welder: [0,0,0,0,0,0,0] }
    const dailyTotals = [0, 0, 0, 0, 0, 0, 0];
    let totalWeekDI = 0;

    weekExec.forEach(e => {
        const estampa = (getVal(e, 'ESTAMPA_EJECUTOR') || getVal(e, 'RESPONSABLE'));
        if (!estampa) return;

        const name = personalMap[estampa] || estampa;
        // Try NPS first, then DIAMETRO_WDI
        const npsVal = getVal(e, 'NPS') || getVal(e, 'DIAMETRO_WDI') || 0;
        const nps = parseFloat(npsVal);
        
        if (isNaN(nps)) return;

        totalWeekDI += nps;

        const date = parseDate(getVal(e, 'FECHA_EJECUCION'));
        if (!date) return;
        
        let dIdx = date.getDay(); // 0=Domingo, 1=Lunes, ..., 6=Sábado
        // Mapear: Lunes=0, Martes=1, ..., Sábado=5, Domingo=6
        let arrIdx = dIdx === 0 ? 6 : dIdx - 1;
        
        if (arrIdx < 0 || arrIdx > 6) return;
        
        if (!welderData[name]) welderData[name] = [0, 0, 0, 0, 0, 0, 0];
        welderData[name][arrIdx] += nps;
        dailyTotals[arrIdx] += nps;
    });

    console.log(`[KPI] Total Week DI: ${totalWeekDI}. Welders:`, Object.keys(welderData));
    setText('kpi-di-semana', totalWeekDI.toFixed(1));

    // Render Weekly Chart
    const ctxWeekly = document.getElementById('welderChart');
    if (ctxWeekly) {
        if (charts.welder) charts.welder.destroy();
        const welders = Object.keys(welderData);

        charts.welder = new Chart(ctxWeekly, {
            type: 'bar',
            data: {
                labels: days,
                datasets: welders.map((w, i) => ({
                    label: w,
                    data: welderData[w],
                    backgroundColor: welderColorMap[w] || '#64748b',
                    borderRadius: 4
                }))
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    y: { 
                        beginAtZero: true, 
                        grid: { color: '#1e293b' }, 
                        ticks: { color: '#64748b' }, 
                        title: { display: true, text: 'DI (Pulgadas Diámetro)', color: '#64748b' },
                        grace: '12%'
                    },
                    x: { grid: { display: false }, ticks: { color: '#64748b' } }
                },
                plugins: { legend: { position: 'bottom', labels: { color: '#64748b', boxWidth: 12 } } }
            },
            plugins: [barLabelsPlugin]
        });
    }

    // Render Daily Total Chart
    const ctxDailyTotal = document.getElementById('dailyTotalChart');
    if (ctxDailyTotal) {
        if (charts.dailyTotal) charts.dailyTotal.destroy();
        charts.dailyTotal = new Chart(ctxDailyTotal, {
            type: 'bar',
            data: {
                labels: days,
                datasets: [{
                    label: 'Total Producción Diaria (DI)',
                    data: dailyTotals,
                    backgroundColor: '#10b981',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    y: { 
                        beginAtZero: true, 
                        grid: { color: '#1e293b' }, 
                        ticks: { color: '#64748b' }, 
                        title: { display: true, text: 'DI (Pulgadas Diámetro)', color: '#64748b' },
                        grace: '12%'
                    },
                    x: { grid: { display: false }, ticks: { color: '#64748b' } }
                },
                plugins: { legend: { display: false } }
            },
            plugins: [barLabelsPlugin]
        });
    }

    // 3. Historic Production
    const histMap = {};
    let totalHistDI = 0;

    histExec.forEach(e => {
        const estampa = (getVal(e, 'ESTAMPA_EJECUTOR') || getVal(e, 'RESPONSABLE'));
        const npsVal = getVal(e, 'NPS') || getVal(e, 'DIAMETRO_WDI') || 0;
        const nps = parseFloat(npsVal);
        
        if (isNaN(nps)) return;

        totalHistDI += nps;
        if (!estampa) return;

        const name = personalMap[estampa] || estampa;
        histMap[name] = (histMap[name] || 0) + nps;
    });

    setText('kpi-di-total', totalHistDI.toLocaleString('es-CL', { maximumFractionDigits: 1 }));

    // Render History Chart
    const ctxHist = document.getElementById('welderHistoryChart');
    if (ctxHist) {
        if (charts.welderHist) charts.welderHist.destroy();
        const labels = Object.keys(histMap).sort((a,b) => histMap[b] - histMap[a]);
        const data = labels.map(l => histMap[l]);
        const backgroundColors = labels.map(l => welderColorMap[l] || '#64748b');

        charts.welderHist = new Chart(ctxHist, {
            type: 'bar', // Horizontal bar is set via indexAxis
            data: {
                labels,
                datasets: [{
                    label: 'Total Pulgadas (DI)',
                    data,
                    backgroundColor: backgroundColors,
                    borderRadius: 4
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true, maintainAspectRatio: false,
                scales: {
                    x: { 
                        beginAtZero: true, 
                        grid: { color: '#1e293b' }, 
                        ticks: { color: '#64748b' },
                        grace: '12%'
                    },
                    y: { grid: { display: false }, ticks: { color: '#64748b' } }
                },
                plugins: { legend: { display: false } }
            },
            plugins: [{
                id: 'barLabels',
                afterDatasetsDraw(chart) {
                    const { ctx, data } = chart;
                    ctx.save();
                    ctx.font = 'bold 11px Outfit, sans-serif';
                    ctx.fillStyle = '#cbd5e1';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';

                    chart.getDatasetMeta(0).data.forEach((bar, index) => {
                        const val = data.datasets[0].data[index];
                        const displayVal = val.toLocaleString('es-CL', { maximumFractionDigits: 1 }) + ' DI';
                        const xPos = bar.x + 8;
                        const yPos = bar.y;
                        ctx.fillText(displayVal, xPos, yPos);
                    });
                    ctx.restore();
                }
            }]
        });
    }
}

export function renderJuntasBreakdown() {
    const { juntas, catUniones } = state;

    // Maps for fast lookup
    const catMap = {};
    catUniones.forEach(c => {
        catMap[(c.ID_TIPO_UNION || c['ID_TIPO_UNION '] || '').trim()] = (c.NMB_UNION || c['NMB_UNION '] || '').trim();
    });

    const shop = { total: 0, ejec: 0, materials: {} };
    const field = { total: 0, ejec: 0, materials: {} };

    juntas.forEach(j => {
        const cat = (j.CATEGORIA_JUNTA || j['CATEGORIA_JUNTA '] || '').toUpperCase().trim();
        const tipo = (j.ID_TIPO_UNION || j['ID_TIPO_UNION '] || 'VAR').trim();
        const et = getMaxEtapa(j.ID_JUNTA || j['ID_JUNTA ']);
        const isEjecutada = et && et.toUpperCase().includes('EJECUTAD');

        const isShop = cat === 'S' || cat === 'SHOP' || cat === 'TALLER';
        const target = isShop ? shop : field; // Si no es S, asumimos Field por defecto

        target.total++;
        if (isEjecutada) target.ejec++;

        // Obtener pulgadas de diámetro
        const npsVal = getVal(j, 'NPS') || getVal(j, 'NPS_JUNTA') || 0;
        const nps = parseFloat(npsVal);
        const validNps = isNaN(nps) ? 0 : nps;

        // Obtener material y clave
        const rawMat = getVal(j, 'MATERIAL');
        const matKey = rawMat ? rawMat.trim().toUpperCase() : 'S/M';
        const matLabel = getMaterialLabel(rawMat);

        if (!target.materials[matKey]) {
            target.materials[matKey] = {
                label: matLabel,
                total: 0,
                totalPulg: 0,
                ejec: 0,
                ejecPulg: 0,
                types: {}
            };
        }

        const matObj = target.materials[matKey];
        matObj.total++;
        matObj.totalPulg += validNps;
        if (isEjecutada) {
            matObj.ejec++;
            matObj.ejecPulg += validNps;
        }

        if (!matObj.types[tipo]) {
            matObj.types[tipo] = { total: 0, ejec: 0, name: catMap[tipo] || 'S/D' };
        }
        matObj.types[tipo].total++;
        if (isEjecutada) matObj.types[tipo].ejec++;
    });

    // Render Metrics Cards
    const renderMetrics = (data) => {
        const perc = data.total > 0 ? Math.round((data.ejec / data.total) * 100) : 0;
        return `
            <div class="jc-metric-card">
                <span class="jc-metric-label">TOTAL</span>
                <span class="jc-metric-value">${data.total}</span>
            </div>
            <div class="jc-metric-card">
                <span class="jc-metric-label">EJEC</span>
                <span class="jc-metric-value">${data.ejec}</span>
            </div>
            <div class="jc-metric-card perc">
                <span class="jc-metric-label">% ACUM</span>
                <span class="jc-metric-value">${perc}%</span>
            </div>
        `;
    };

    const shopMetrics = document.getElementById('shop-metrics');
    if (shopMetrics) shopMetrics.innerHTML = renderMetrics(shop);

    const fieldMetrics = document.getElementById('field-metrics');
    if (fieldMetrics) fieldMetrics.innerHTML = renderMetrics(field);

    // Render Materials Groups and their internal cards
    const renderMaterials = (materialsObj) => {
        const materialsKeys = Object.keys(materialsObj).sort((a, b) => materialsObj[b].total - materialsObj[a].total);
        if (!materialsKeys.length) return `<div class="empty-msg" style="padding:1rem">Sin registros</div>`;

        return materialsKeys.map(mKey => {
            const mat = materialsObj[mKey];
            const perc = mat.total > 0 ? Math.round((mat.ejec / mat.total) * 100) : 0;
            const totalPulgStr = mat.totalPulg.toLocaleString('es-CL', { maximumFractionDigits: 1 }) + '"';
            const ejecPulgStr = mat.ejecPulg.toLocaleString('es-CL', { maximumFractionDigits: 1 }) + '"';
            
            // Ordenar los tipos de unión por total descendente
            const typesKeys = Object.keys(mat.types).sort((a, b) => mat.types[b].total - mat.types[a].total);
            const cardsHtml = typesKeys.map(t => {
                const data = mat.types[t];
                return `
                    <div class="jc-card">
                        <div class="jc-card-title">${t}</div>
                        <div class="jc-card-subtitle" title="${data.name}">${data.name}</div>
                        <div class="jc-card-stats">
                            <div><span class="label">TOTAL</span><span class="val">${data.total}</span></div>
                            <div><span class="label">EJEC</span><span class="val done">${data.ejec}</span></div>
                        </div>
                    </div>
                `;
            }).join('');

            return `
                <div class="jc-material-group">
                    <div class="jc-material-header">
                        <div class="jc-material-title">💿 ${mat.label}</div>
                        <div class="jc-material-metrics">
                            <div class="jc-material-metric">TOTAL: <span>${mat.total} / ${totalPulgStr}</span></div>
                            <div class="jc-material-metric">EJEC: <span class="done">${mat.ejec} / ${ejecPulgStr}</span></div>
                            <div class="jc-material-metric perc"><span>${perc}%</span></div>
                        </div>
                    </div>
                    <div class="jc-cards">
                        ${cardsHtml}
                    </div>
                </div>
            `;
        }).join('');
    };

    const sCards = document.getElementById('shop-cards');
    if (sCards) sCards.innerHTML = renderMaterials(shop.materials);

    const fCards = document.getElementById('field-cards');
    if (fCards) fCards.innerHTML = renderMaterials(field.materials);
}

export function renderSCurve() {
    const weekMap = {};
    const todayWeek = getProjectWeek(); // S28

    state.ejecuciones.forEach(e => {
        const estado = getEstado(e).toUpperCase();
        // Solo uniones "EJECUTADA" (terminadas) se grafican en la Curva S
        if (estado.includes('EJECUTAD')) {
            const rawDate = getVal(e, 'FECHA_EJECUCION');
            const w = getWeekOfDate(rawDate);
            // ONLY accept weeks between 0 and current week (S28)
            if (w !== null && w >= 0 && w <= todayWeek) {
                weekMap[w] = (weekMap[w] || 0) + 1;
            }
        }
    });

    const sorted = Object.keys(weekMap).map(Number).sort((a, b) => a - b);

    // If no data in range, show current week as 0 to keep chart axis consistent
    if (!sorted.length) sorted.push(todayWeek);

    let cum = 0;
    const labels = sorted.map(w => `S${w}`);
    const data = sorted.map(w => {
        cum += (weekMap[w] || 0);
        return cum;
    });

    if (charts.sCurve) charts.sCurve.destroy();
    const ctx = document.getElementById('sCurveChart');
    if (!ctx) return;
    charts.sCurve = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Acumulado', data,
                borderColor: '#10b981',
                backgroundColor: 'rgba(16,185,129,0.08)',
                fill: true, tension: 0.3, pointRadius: 4,
                pointBackgroundColor: '#10b981'
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                y: { 
                    beginAtZero: true, 
                    grid: { color: '#1e293b' }, 
                    ticks: { color: '#64748b' },
                    grace: '10%'
                },
                x: { grid: { display: false }, ticks: { color: '#64748b' } }
            },
            plugins: { legend: { display: false } }
        },
        plugins: [lineLabelsPlugin]
    });
}

export function renderBarChart() {
    let fluids = state.catFluidos.map(f => (f.ID_FLUIDO || f['ID_FLUIDO '] || '').trim()).filter(Boolean);
    if (!fluids.length) fluids = ['CT', 'PW', 'IA', 'GW', 'FP', 'RW']; // fallback

    const counts = fluids.map(f =>
        state.ejecuciones.filter(e => {
            const iso = e.ID_ISO || e['ID_ISO '] || '';
            return iso.includes(`-${f}-`) || iso.includes(`/${f}/`);
        }).length
    );

    if (charts.bar) charts.bar.destroy();
    const ctx = document.getElementById('barChart');
    if (!ctx) return;
    charts.bar = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: fluids,
            datasets: [{
                label: 'Actividad', data: counts,
                backgroundColor: ['#6366f1', '#10b981', '#f59e0b', '#38bdf8', '#a78bfa', '#ef4444'],
                borderRadius: 6
            }]
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
            plugins: { legend: { display: false } }
        },
        plugins: [barLabelsPlugin]
    });
}

export function renderLogTable() {
    const tbody = document.getElementById('log-tbody');
    if (!tbody) return;

    const filtered = state.ejecuciones.filter(e => getWeekOfDate(e.FECHA_EJECUCION) === state.currentWeek);
    const data = filtered.length > 0 ? filtered :
        [...state.ejecuciones].sort((a, b) => parseDate(b.FECHA_EJECUCION) - parseDate(a.FECHA_EJECUCION)).slice(0, 10);

    if (!data.length) { tbody.innerHTML = `<tr><td colspan="4" class="empty-msg">Sin movimientos registrados</td></tr>`; return; }

    tbody.innerHTML = data.slice(0, 15).map(e => {
        const spool = (e.ID_SPOOL || e['ID_SPOOL '] || e.ID_ISO || e['ID_ISO '] || '--');
        return `<tr>
            <td>${getJuntaId(e) || '--'}</td>
            <td>${spool}</td>
            <td>${getEtapaBadge(getEstado(e))}</td>
            <td>${formatDate(e.FECHA_EJECUCION)}</td>
        </tr>`;
    }).join('');
}

// Exponer en window: renderOverview/renderJuntas siguen en app.js y algunos
// handlers los invocan por nombre global.
if (typeof window !== 'undefined') {
    window.renderWelderChart     = renderWelderChart;
    window.renderJuntasBreakdown = renderJuntasBreakdown;
    window.renderSCurve          = renderSCurve;
    window.renderBarChart        = renderBarChart;
    window.renderLogTable        = renderLogTable;
}
