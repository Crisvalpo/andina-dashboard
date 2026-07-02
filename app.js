/**
 * Andina Piping Dashboard — app.js
 * AppSheet API V2 | ISO Weeks (Monday start)
 * Secciones: Overview, Juntas, Spools, QC, SDI
 */

// ============ CONFIG ============
// (Las credenciales de AppSheet ahora se administran de forma segura en el backend)

// Fecha de inicio del proyecto (Local 00:00:00)
const PROJECT_START_DATE = new Date(2025, 8, 15); // Septiembre 15, 2025

function getProjectWeek(d = new Date()) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return null;
    const start = new Date(PROJECT_START_DATE);
    start.setHours(0, 0, 0, 0);
    const current = new Date(d);
    current.setHours(0, 0, 0, 0);
    const diff = current - start;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    return Math.floor(days / 7);
}

// ============ STATE ============
const state = {
    lineas: [],
    isos: [],
    spools: [],
    juntas: [],
    ejecuciones: [],   // REG_EjecucionJuntas_MS
    logSpools: [],     // LOG_Spool_MS
    sdis: [],
    relSdiIso: [],     // REL_SDIIso_MS
    inspecciones: [],  // REG_InspeccionVisual_MS
    dimensional: [],   // REG_DimensionalSpool_MS
    personal: [],      // CAT_Personal_MS
    catUniones: [],    // CAT_TipoUnion_MS
    catFluidos: [],    // CAT_FluidoServicio_MS
    currentWeek: getProjectWeek(),
    currentSection: 'overview'
};

let charts = {};

// Plugins globales para mostrar etiquetas en los gráficos
const barLabelsPlugin = {
    id: 'barLabels',
    afterDatasetsDraw(chart) {
        const { ctx } = chart;
        ctx.save();
        ctx.font = 'bold 10px Outfit, sans-serif';
        ctx.fillStyle = '#cbd5e1';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        const isStacked = chart.options.scales?.y?.stacked || chart.options.scales?.x?.stacked;

        if (isStacked) {
            // Para gráficos apilados, dibujamos una sola etiqueta en la parte superior de la pila
            const datasets = chart.data.datasets;
            if (datasets.length >= 2) {
                const metaLast = chart.getDatasetMeta(datasets.length - 1);
                metaLast.data.forEach((bar, index) => {
                    const montados = datasets[0].data[index] || 0;
                    const pendientes = datasets[1].data[index] || 0;
                    const total = montados + pendientes;
                    
                    if (total === 0) return;

                    // Formato: "Montados/Total"
                    const displayVal = `${montados}/${total}`;
                    const xPos = bar.x;
                    const yPos = bar.y - 4; // 4px arriba de la barra total

                    ctx.fillText(displayVal, xPos, yPos);
                });
            }
        } else {
            // Comportamiento original para gráficos no apilados
            chart.data.datasets.forEach((dataset, datasetIndex) => {
                const meta = chart.getDatasetMeta(datasetIndex);
                meta.data.forEach((bar, index) => {
                    const val = dataset.data[index];
                    if (val === 0 || val === null || val === undefined) return;
                    
                    const displayVal = typeof val === 'number' ? val.toLocaleString('es-CL', { maximumFractionDigits: 1 }) : val;
                    const xPos = bar.x;
                    const yPos = bar.y - 4; // 4px arriba de la barra
                    
                    ctx.fillText(displayVal, xPos, yPos);
                });
            });
        }
        ctx.restore();
    }
};

const doughnutLabelsPlugin = {
    id: 'doughnutLabels',
    afterDatasetsDraw(chart) {
        const { ctx, data } = chart;
        ctx.save();
        ctx.font = 'bold 11px Outfit, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        chart.getDatasetMeta(0).data.forEach((slice, index) => {
            const val = data.datasets[0].data[index];
            if (val === 0 || val === null || val === undefined) return;
            
            const pos = typeof slice.tooltipPosition === 'function' ? slice.tooltipPosition() : null;
            if (pos) {
                ctx.fillText(val, pos.x, pos.y);
            }
        });
        ctx.restore();
    }
};

const lineLabelsPlugin = {
    id: 'lineLabels',
    afterDatasetsDraw(chart) {
        const { ctx, data } = chart;
        ctx.save();
        ctx.font = 'bold 10px Outfit, sans-serif';
        ctx.fillStyle = '#cbd5e1';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        chart.getDatasetMeta(0).data.forEach((point, index) => {
            const val = data.datasets[0].data[index];
            if (val === null || val === undefined) return;
            
            const xPos = point.x;
            const yPos = point.y - 6; // 6px arriba del punto
            ctx.fillText(val, xPos, yPos);
        });
        ctx.restore();
    }
};

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
    setWeekDisplay(state.currentWeek);

    // Auto-navegar a BIM si el QR incluye ?spool= en la URL
    const urlParams  = new URLSearchParams(window.location.search);
    const spoolParam = urlParams.get('spool');
    if (spoolParam) {
        // Cargar datos del dashboard en background y abrir BIM directamente
        refreshData();
        showSection('bim');
    } else {
        refreshData();
    }

    setInterval(updateTime, 60000);
    updateTime();
});

// ============ UTILS: SEMANA PROYECTO ============
function currentISOWeek() {
    return getProjectWeek();
}

function getISOWeek(d) {
    if (!(d instanceof Date)) d = new Date(d);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function parseDate(str) {
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
function formatDate(str) {
    if (!str) return '--';
    const part = str.split(' ')[0];
    const s = part.split('/');
    if (s.length === 3) {
        const yy = s[2].length === 4 ? s[2].slice(2) : s[2];
        return `${s[0].padStart(2, '0')}/${s[1].padStart(2, '0')}/${yy}`;
    }
    return part;
}

function getWeekOfDate(str) {
    const d = parseDate(str);
    return d ? getProjectWeek(d) : null;
}

function setWeekDisplay(w) {
    const el = document.getElementById('week-number');
    if (el) el.textContent = w;
    const tag = document.getElementById('week-tag');
    if (tag) tag.textContent = `S${w}`;
}

function changeWeek(delta) {
    state.currentWeek = Math.max(1, Math.min(150, state.currentWeek + delta));
    setWeekDisplay(state.currentWeek);
    renderCurrentSection();
}

function goToCurrentWeek() {
    state.currentWeek = currentISOWeek();
    setWeekDisplay(state.currentWeek);
    renderCurrentSection();
}

function updateTime() {
    const t = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('last-update').textContent = t;
}

// ============ NAVIGATION ============
function toggleWelderHistory() {
    const container = document.getElementById('welder-history-container');
    const icon = document.getElementById('hist-toggle-icon');
    if(container.style.display === 'none' || container.style.display === '') {
        container.style.display = 'block';
        icon.style.transform = 'rotate(180deg)';
    } else {
        container.style.display = 'none';
        icon.style.transform = 'rotate(0deg)';
    }
}

function showSection(name) {
    document.querySelectorAll('.section-content').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    const sectionEl = document.getElementById(`${name}-section`);
    const navEl = document.getElementById(`nav-${name}`);

    if (sectionEl) {
        sectionEl.classList.add('active');
        sectionEl.style.display = '';
    }
    if (navEl) navEl.classList.add('active');

    const titles = {
        overview:  'Dashboard Overview',
        juntas:    'Avance de Juntas',
        spools:    'Fabricación de Spools',
        qc:        'Control de Calidad',
        logistica: 'Logística y Despacho',
        sdi:       'SDI — Consultas Técnicas',
        bim:       '🧊 BIM Viewer — Modelo 3D'
    };

    const titleEl = document.getElementById('section-title');
    if (titleEl) titleEl.textContent = titles[name] || name;

    state.currentSection = name;

    // Ocultar filtro de semana en secciones estáticas
    const weekNav = document.getElementById('week-nav-container');
    if (['spools', 'qc', 'sdi', 'logistica', 'bim'].includes(name)) {
        if (weekNav) weekNav.style.display = 'none';
    } else {
        if (weekNav) weekNav.style.display = 'flex';
    }

    renderCurrentSection();
}

function renderCurrentSection() {
    switch (state.currentSection) {
        case 'overview':  renderOverview();  break;
        case 'juntas':    renderJuntas();    break;
        case 'spools':    renderSpools();    break;
        case 'qc':        renderQC();        break;
        case 'sdi':       renderSDI();       break;
        case 'logistica': loadLogistica();   break;
        case 'bim':       initBimViewer();   break;
    }
}

// ============ RENDER: WELDER PERFORMANCE (DI) ============
function renderWelderChart() {
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

// ============ RENDER: SDI (RFI) ============
function renderSDI() {
    const { sdis, relSdiIso } = state;

    const total = sdis.length;
    const respondidas = sdis.filter(s => getVal(s, 'ESTADO').toUpperCase().includes('RESPONDID')).length;
    const pendientes = total - respondidas;

    setText('sdi-total', total);
    setText('sdi-pendientes', pendientes);
    setText('sdi-respondidas', respondidas);

    const tbody = document.getElementById('sdi-tbody');
    if (!tbody) return;

    if (!total) {
        tbody.innerHTML = `<tr><td colspan="5" class="empty-msg">Sin consultas registradas</td></tr>`;
        return;
    }

    tbody.innerHTML = sdis.map(s => {
        const fullCodigo = getVal(s, 'CODIGO DAND');
        const displayCodigo = fullCodigo.length > 5 ? fullCodigo.slice(-5) : fullCodigo;

        const relacionados = relSdiIso.filter(r => getVal(r, 'CODIGO_DAND') === fullCodigo)
            .flatMap(r => {
                const list = getVal(r, 'ISOS_VINCULADOS');
                if (!list) return [];
                // Soportar tanto coma como punto y coma (AppSheet usa , por defecto en EnumList)
                return list.split(/[,;]/).map(iso => iso.trim()).filter(iso => iso);
            })
            .map(iso => `<span class="badge badge-emplantillado">${iso}</span>`)
            .join(' ');

        const estado = getVal(s, 'ESTADO').toUpperCase();
        const isRespondida = estado.includes('RESPONDID');
        const statusIcon = isRespondida ?
            '<i class="fas fa-check-circle" style="color:var(--accent)" title="Respondida"></i>' :
            '<i class="fas fa-dot-circle" style="color:var(--danger)" title="Pendiente"></i>';

        return `<tr>
            <td style="font-weight:700;color:var(--primary-light);white-space:nowrap;font-size:0.9rem" title="${fullCodigo}">...${displayCodigo}</td>
            <td style="min-width:300px">
                <div style="font-weight:600;margin-bottom:8px">${getVal(s, 'NOMBRE Sdis')}</div>
                <div class="sdi-text-box query"><strong>Consulta:</strong> ${getVal(s, 'Descricpión')}</div>
                <div class="sdi-text-box response" style="margin-top:10px"><strong>Respuesta Técnica:</strong> ${getVal(s, 'Descripcion de Respuesta') || '<span class="text-dim">Pendiente de revisión...</span>'}</div>
            </td>
            <td style="text-align:center">${statusIcon}</td>
            <td style="white-space:nowrap">${formatDate(getVal(s, 'FECHA ENVÍO'))}</td>
            <td>${relacionados || '<span class="text-dim">—</span>'}</td>
        </tr>`;
    }).join('');
}

function filterSDI() {
    const q = document.getElementById('sdi-search').value.toLowerCase();
    const rows = document.querySelectorAll('#sdi-tbody tr');
    rows.forEach(row => {
        const text = row.innerText.toLowerCase();
        row.style.display = text.includes(q) ? '' : 'none';
    });
}

// ============ API FETCH ============
async function fetchTable(tableName) {
    const url = `/api/data/${tableName}`;
    try {
        const res = await fetch(url);
        if (!res.ok) { console.error(`[API] ${tableName} → HTTP ${res.status}`); return []; }
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.error(`[API] Fallo red ${tableName}:`, e);
        return [];
    }
}

async function refreshData() {
    console.log('[Dashboard] Cargando datos...');
    const dot = document.getElementById('api-dot');

    const [lineas, isos, spools, juntas, ejecuciones, logSpools, sdis, relSdiIso, inspecciones, dimensional, catUniones, catFluidos, personal] = await Promise.all([
        fetchTable('LIST_Lineas_MS_'),
        fetchTable('LIST_Isos_MS_'),
        fetchTable('LIST_Spools_MS_'),
        fetchTable('LIST_Juntas_MS_'),
        fetchTable('REG_EjecucionJuntas_MS'),
        fetchTable('LOG_Spool_MS'),
        fetchTable('LOG_SDI_MS'),
        fetchTable('REL_SDIIso_MS'),
        fetchTable('REG_InspeccionVisual_MS'),
        fetchTable('REG_DimensionalSpool_MS'),
        fetchTable('CAT_TipoUnion_MS'),
        fetchTable('CAT_FluidoServicio_MS'),
        fetchTable('CAT_Personal_MS')
    ]);

    // Helper to check if a value is truthy in the new AppSheet format
    const isTrueStr = (val) => {
        if (!val) return false;
        const v = String(val).toUpperCase().trim();
        return v !== 'NO' && v !== '0' && v !== '';
    };

    // Adapt Lineas
    const mappedLineas = lineas.map(l => ({
        ...l,
        CLASE_PIPING: l.CLASE || l.CLASE_PIPING || '',
        NPS_SIZE: l.NPS || l.NPS_SIZE || '',
        FLUIDO_SERVICIO: l.SERVICIO || l.FLUIDO_SERVICIO || '',
        MATERIAL_BASE: l['TIPO MATERIAL'] || l.MATERIAL_BASE || '',
        N_PID: l.PLANO_CODELCO || l.N_PID || '',
        TEMP_DISENO_C: l.TEMP_DISEÑO_C || l.TEMP_DISENO_C || '',
        PRESION_DISENO_KG: l.PRESION_DISEÑO_KG || l.PRESION_DISENO_KG || '',
        ESQUEMA_PINTURA: l.ESQUEMA || l.ESQUEMA_PINTURA || '',
        COLOR_PINTURA: l.RAL || l.COLOR_PINTURA || '',
        REVESTIMIENTO_INT: l['REVESTIMIENTO INTERIOR'] || l.REVESTIMIENTO_INT || '',
        AISLACION_EXT: l.AISLACION || l.AISLACION_EXT || ''
    }));

    // Adapt Isos
    const mappedIsos = isos.map(i => ({
        ...i,
        REV_VIGENTE: i.REV || i.REV_VIGENTE || '0',
        ESTADO_VIGENTE: i.ESTATUS || i.ESTADO_VIGENTE || 'Vigente'
    }));

    // Adapt Spools
    const mappedSpools = spools.map(s => {
        const proceso = (s.Proceso || '').trim();
        let estadoFab = s.ESTADO_FABRICACION || proceso || 'PENDIENTE';
        let cicloVida = s.ESTADO_CICLO_VIDA || '';
        
        if (isTrueStr(s.Montaje)) {
            cicloVida = 'MONTADO';
            estadoFab = '🟢 FABRICADO';
        } else if (isTrueStr(s.Posicionado)) {
            cicloVida = 'POSICIONADO';
            estadoFab = '🟢 FABRICADO';
        } else if (isTrueStr(s.Recibido)) {
            cicloVida = 'EN TERRENO';
            estadoFab = '🟢 FABRICADO';
        } else if (isTrueStr(s['Pintura / Revestimiento'])) {
            cicloVida = 'EN PINTURA';
            estadoFab = '🟢 FABRICADO';
        } else if (String(estadoFab).toUpperCase().includes('EJECUTADO') || String(estadoFab).toUpperCase().includes('N/A')) {
            cicloVida = 'FABRICADO';
            estadoFab = '🟢 FABRICADO';
        }

        return {
            ...s,
            Proceso: proceso,
            TAG_SPOOL: s.SPOOL || s['TAG GESTION'] || s.TAG_SPOOL || '',
            ESTADO_FABRICACION: estadoFab,
            ESTADO_CICLO_VIDA: cicloVida,
            UBICACION_ACTUAL: s.Ubicación || s.UBICACION_ACTUAL || ''
        };
    });

    // Adapt Juntas
    const mappedJuntas = juntas.map(j => ({
        ...j,
        CATEGORIA_JUNTA: j.DESTINATION || j.CATEGORIA_JUNTA || '',
        ID_TIPO_UNION: j['TIPO UNION'] || j.ID_TIPO_UNION || '',
        NUM_JUNTA: j['N° UNION'] || j.NUM_JUNTA || '',
        NPS_JUNTA: j.NPS || j.NPS_JUNTA || 0
    }));

    // Crear mapa para obtener el tipo de unión desde el maestro
    const juntaUnionMap = new Map();
    mappedJuntas.forEach(j => {
        const id = (j.ID_JUNTA || j['ID_JUNTA '] || '').trim();
        if (id) juntaUnionMap.set(id, j.ID_TIPO_UNION);
    });

    // Adapt Ejecuciones para usar el tipo de unión del maestro (evita discrepancias de digitación)
    const mappedEjecuciones = ejecuciones.map(e => {
        const idJunta = (e.ID_JUNTA || e['ID_JUNTA '] || '').trim();
        const tipoUnionMaster = juntaUnionMap.get(idJunta);
        return {
            ...e,
            ID_TIPO_UNION: tipoUnionMaster || e.ID_TIPO_UNION || e['ID_TIPO_UNION '] || ''
        };
    });

    state.lineas = mappedLineas;
    state.isos = mappedIsos;
    state.spools = mappedSpools;
    state.juntas = mappedJuntas;
    state.ejecuciones = mappedEjecuciones;
    state.logSpools = logSpools || [];
    state.sdis = sdis;
    state.relSdiIso = relSdiIso || [];
    state.inspecciones = inspecciones;
    state.dimensional = dimensional || [];
    state.catUniones = catUniones || [];
    state.catFluidos = catFluidos || [];
    state.personal = personal || [];


    const ok = mappedJuntas.length > 0 || mappedLineas.length > 0;
    dot.className = 'api-dot' + (ok ? '' : ' error');

    // Actualizar badge de SDI en el menú lateral
    const sdiPendientes = (sdis || []).filter(s => {
        const est = getVal(s, 'ESTADO').toUpperCase();
        return !est.includes('RESPONDID') && !est.includes('CERRAD');
    }).length;

    const badgeSdi = document.getElementById('badge-sdi');
    if (badgeSdi) {
        badgeSdi.textContent = sdiPendientes;
        badgeSdi.style.display = sdiPendientes > 0 ? 'flex' : 'none';
    }

    updateTime();
    renderCurrentSection();
    console.log(`[Dashboard] Datos cargados: ${mappedLineas.length} líneas | ${mappedIsos.length} ISOs | ${mappedSpools.length} spools | ${sdis.length} SDIs`);
}

// ============ ETAPA HELPER ============
// REG_EjecucionJuntas_MS: columna ESTADO_EJECUCION
// Valores: "EJECUTADA" | "EMPLANTILLADO" | "CORTE DIMENSIONADO"

function getVal(row, key) {
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

function getEstado(row) {
    return getVal(row, 'ESTADO_EJECUCION');
}

function getJuntaId(row) {
    return getVal(row, 'ID_JUNTA');
}

function getEtapaBadge(estado) {
    if (!estado) return '<span class="badge badge-pending">Sin Registro</span>';
    const e = estado.toUpperCase();
    if (e.includes('EJECUTAD')) return `<span class="badge badge-done">EJECUTADA</span>`;
    if (e.includes('EMPLANTILL') || e.includes('PREARMAD')) return `<span class="badge badge-emplantillado">EMPLANTILLADO</span>`;
    if (e.includes('CORTE')) return `<span class="badge badge-corte">CORTE</span>`;
    return `<span class="badge badge-pending">${estado}</span>`;
}

function getEtapaWeight(estado) {
    if (!estado) return 0;
    const e = estado.toUpperCase();
    if (e.includes('EJECUTAD')) return 3;
    if (e.includes('EMPLANTILL') || e.includes('PREARMAD')) return 2;
    if (e.includes('CORTE')) return 1;
    return 0;
}

// Para cada junta, encuentra su estado más avanzado en ejecuciones
function getMaxEtapa(idJunta) {
    const id = (idJunta || '').trim();
    const regs = state.ejecuciones.filter(r => getJuntaId(r) === id);
    if (!regs.length) return null;
    return regs.reduce((best, r) => {
        const estado = getEstado(r);
        return getEtapaWeight(estado) > getEtapaWeight(best) ? estado : best;
    }, '');
}

// ============ RENDER: OVERVIEW ============
function renderOverview() {
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

function getMaterialLabel(material) {
    if (!material) return 'Sin Material (S/M)';
    const m = material.trim().toUpperCase();
    if (m === 'AG') return 'Acero Galvanizado (AG)';
    if (m === 'CS') return 'Acero Carbono (CS)';
    if (m === 'HDPE') return 'HDPE';
    return material.trim();
}

function renderJuntasBreakdown() {
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

function toggleJuntaCol(type) {
    const col = document.getElementById(`col-${type}`);
    if (col) {
        col.classList.toggle('collapsed');
    }
}

function renderSCurve() {
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

function renderBarChart() {
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

function renderLogTable() {
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

// ============ RENDER: JUNTAS ============
function renderJuntas() {
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

// ============ SPOOL STATUS: jerarquía desde LOG_Spool_MS ============
// Orden de mayor a menor prioridad (el último en la lista gana)
const SPOOL_STATUS_WEIGHT = {
    'EN FABRICACIÓN': 1, 'EN FABRICACION': 1,
    'QAQC': 2,
    'EN PINT/REVEST.': 3, 'EN PINT': 3,
    'RETIRAR': 4,
    'POR MONTAR': 5,
    'POSICIONADO': 6,
    'MONTADO': 7,
    'ELIMINADO': 8
};

function getSpoolStatusWeight(status) {
    if (!status) return 0;
    const s = status.toUpperCase().trim();
    // Exact match first
    if (SPOOL_STATUS_WEIGHT[s] !== undefined) return SPOOL_STATUS_WEIGHT[s];
    // Partial match
    for (const [key, w] of Object.entries(SPOOL_STATUS_WEIGHT)) {
        if (s.includes(key)) return w;
    }
    return 0;
}

/**
 * Resuelve el status más avanzado de cada spool desde LOG_Spool_MS.
 * Retorna un Map<ID_SPOOL, statusString>.
 */
function resolveSpoolStatuses() {
    const statusMap = new Map(); // ID_SPOOL -> { status, weight }
    state.logSpools.forEach(r => {
        const id = (r.ID_SPOOL || r['ID_SPOOL '] || '').trim();
        const st = (r.STATUS || r['STATUS '] || '').trim();
        if (!id || !st) return;
        const w = getSpoolStatusWeight(st);
        const prev = statusMap.get(id);
        if (!prev || w > prev.weight) {
            statusMap.set(id, { status: st, weight: w });
        }
    });
    // Return Map<ID_SPOOL, statusString>
    const result = new Map();
    statusMap.forEach((v, k) => result.set(k, v.status));
    return result;
}

// ============ RENDER: SPOOLS ============
function renderSpools() {
    const { spools } = state;

    // --- JERARQUÍA POR STATUS (LOG_Spool_MS) ---
    const statusMap = resolveSpoolStatuses();

    // Conteo por status (usando jerarquía LOG_Spool_MS)
    const statusKeys = {
        fabricacion: (s) => { const st = statusMap.get(resolveSpoolId(s)); return st && normalizeStatus(st) === 'EN FABRICACIÓN'; },
        qaqc:        (s) => { const st = statusMap.get(resolveSpoolId(s)); return st && normalizeStatus(st) === 'QAQC'; },
        pintura:     (s) => { const st = statusMap.get(resolveSpoolId(s)); return st && normalizeStatus(st) === 'EN PINT/REVEST.'; },
        retirar:     (s) => { const st = statusMap.get(resolveSpoolId(s)); return st && normalizeStatus(st) === 'RETIRAR'; },
        pormontar:   (s) => { const st = statusMap.get(resolveSpoolId(s)); return st && normalizeStatus(st) === 'POR MONTAR'; },
        posicionado: (s) => { const st = statusMap.get(resolveSpoolId(s)); return st && normalizeStatus(st) === 'POSICIONADO'; },
        montado:     (s) => { const st = statusMap.get(resolveSpoolId(s)); return st && normalizeStatus(st) === 'MONTADO'; },
        eliminado:   (s) => { const st = statusMap.get(resolveSpoolId(s)); return st && normalizeStatus(st) === 'ELIMINADO'; },
    };

    const c00 = spools.filter(statusKeys.eliminado).length;
    const c01 = spools.filter(statusKeys.fabricacion).length;
    const c02 = spools.filter(statusKeys.qaqc).length;
    const c03 = spools.filter(statusKeys.pintura).length;
    const c04 = spools.filter(statusKeys.retirar).length;
    const c05 = spools.filter(statusKeys.pormontar).length;
    const c06 = spools.filter(statusKeys.posicionado).length;
    const c07 = spools.filter(statusKeys.montado).length;
    const cSinRegistro = spools.filter(s => !statusMap.has(resolveSpoolId(s))).length;
    const cTotalActivos = spools.filter(s => {
        const st = statusMap.get(resolveSpoolId(s));
        return !st || normalizeStatus(st) !== 'ELIMINADO';
    }).length;

    setText('s-eliminado', c00);
    setText('s-fabricacion', c01);
    setText('s-qaqc', c02);
    setText('s-pintura', c03);
    setText('s-retirar', c04);
    setText('s-pormontar', c05);
    setText('s-posicionado', c06);
    setText('s-montado', c07);
    setText('s-sinproceso', cSinRegistro);
    setText('s-total', cTotalActivos);

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

    // --- Gráfico: Distribución por Estado (LOG_Spool_MS) ---
    const ctxEstado = document.getElementById('spools-estado-chart');
    if (ctxEstado) {
        if (charts.spoolsEstado) charts.spoolsEstado.destroy();

        const estadosOrden = ['En Fabricación', 'QAQC', 'En Pint/Revest.', 'Retirar', 'Por Montar', 'Posicionado', 'Montado', 'Eliminado', 'Sin Registro'];
        const colores = ['#6366f1','#38bdf8','#f59e0b','#ec4899','#10b981','#0ea5e9','#8b5cf6','#ef4444','#64748b'];
        const data = [c01, c02, c03, c04, c05, c06, c07, c00, cSinRegistro];

        // Solo mostrar los que tienen datos
        const filtered = estadosOrden.map((l, i) => ({ label: l, val: data[i], color: colores[i] })).filter(x => x.val > 0);

        charts.spoolsEstado = new Chart(ctxEstado, {
            type: 'doughnut',
            data: {
                labels: filtered.map(x => x.label),
                datasets: [{
                    data: filtered.map(x => x.val),
                    backgroundColor: filtered.map(x => x.color),
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
}

// Helpers para resolveSpoolStatuses
function resolveSpoolId(s) {
    return (s.ID_SPOOL || s['ID_SPOOL '] || '').trim();
}
function normalizeStatus(st) {
    if (!st) return '';
    const s = st.trim().toUpperCase();
    if (s.includes('FABRICAC')) return 'EN FABRICACIÓN';
    if (s === 'QAQC')          return 'QAQC';
    if (s.includes('PINT'))    return 'EN PINT/REVEST.';
    if (s.includes('RETIR'))   return 'RETIRAR';
    if (s.includes('MONTAR'))  return 'POR MONTAR';
    if (s.includes('POSICION')) return 'POSICIONADO';
    if (s.includes('MONTAD'))  return 'MONTADO';
    if (s.includes('ELIMIN'))  return 'ELIMINADO';
    return st.trim();
}

// ============ RENDER: QC ============
function renderQC() {
    const { inspecciones, ejecuciones, juntas } = state;

    // "Pendiente VT" = juntas EJECUTADA que NO tienen registro de inspección visual
    const inspeccionIds = new Set(
        inspecciones.map(i => (i.ID_JUNTA || i['ID_JUNTA '] || '').trim()).filter(Boolean)
    );
    
    // Obtener juntas ejecutadas únicas
    const ejecutadasIds = ejecuciones
        .filter(e => getEstado(e).toUpperCase().includes('EJECUTAD'))
        .map(e => getJuntaId(e))
        .filter((v, i, a) => v && a.indexOf(v) === i);

    const pendienteVT = ejecutadasIds.filter(id => !inspeccionIds.has(id));

    // Desglose Pendientes Taller vs Terreno
    let pendTaller = 0, pendTerreno = 0;
    const juntasMap = {};
    juntas.forEach(j => juntasMap[(j.ID_JUNTA || j['ID_JUNTA '] || '').trim()] = j);

    pendienteVT.forEach(id => {
        const j = juntasMap[id];
        if (j) {
            const cat = (j.CATEGORIA_JUNTA || j['CATEGORIA_JUNTA '] || '').toUpperCase().trim();
            const isShop = cat === 'S' || cat === 'SHOP' || cat === 'TALLER';
            if (isShop) pendTaller++; else pendTerreno++;
        } else {
            pendTerreno++; // Fallback a Terreno
        }
    });

    // "VT Aprobado" e Inspecciones
    const aprobadas = inspecciones.filter(i => (i.ESTADO || i['ESTADO '] || '').toUpperCase().includes('APROBADO'));
    const rechazadas = inspecciones.filter(i => (i.ESTADO || i['ESTADO '] || '').toUpperCase().includes('RECHAZA'));
    
    // El porcentaje se calcula sobre el total de inspecciones finalizadas (Aprobadas + Rechazadas)
    const totalVAFinalizado = aprobadas.length + rechazadas.length;
    const percAprobacion = totalVAFinalizado > 0 ? Math.round((aprobadas.length / totalVAFinalizado) * 100) : 100;

    // "NDE Solicitado"
    const ndeList = inspecciones.filter(i => (i.PROXIMA_ETAPA || i['PROXIMA_ETAPA '] || i.ESTADO || '').toUpperCase().includes('NDE'));

    setText('qc-aprobado', aprobadas.length);
    setText('qc-rechazado', rechazadas.length);
    setText('qc-nde', ndeList.length);

    // Actualizar Tarjetas de Detalle
    setText('qc-pend-taller', pendTaller);
    setText('qc-pend-terreno', pendTerreno);
    setText('qc-perc-vt', `${percAprobacion}%`);
    setText('qc-nde-sol', ndeList.length);

    // ============ Métrica Dimensional (Spools) ============
    const spoolsFabricados = state.spools.filter(s => (s.ESTADO_FABRICACION || '').toUpperCase().includes('FABRICADO')).length;

    const dccEmitidos = new Set();
    state.dimensional.forEach(d => {
        const id = (d.ID_SPOOL || d['ID_SPOOL '] || '').trim();
        if (id) dccEmitidos.add(id);
    });
    const dimCount = dccEmitidos.size;
    const pendDim = spoolsFabricados - dimCount;

    setText('qc-spool-fab', spoolsFabricados);
    setText('qc-spool-dim', dimCount);
    setText('qc-spool-pend', pendDim > 0 ? pendDim : 0);
}

function fillKanban(containerId, items, label) {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (!items.length) {
        container.innerHTML = `<div class="empty-msg">Sin registros</div>`;
        return;
    }
    container.innerHTML = items.slice(0, 15).map(i => {
        const id = i.ID_JUNTA || i['ID_JUNTA '] || '--';
        const sub = i.ID_ISO || i['ID_ISO '] || '';
        return `<div class="kanban-card">
            <div class="kanban-card-id">${id}</div>
            <div class="kanban-card-sub">${sub}</div>
        </div>`;
    }).join('');
}

// SDI — Próximamente (sección marcada como coming soon)

// ============ UTILS ============
function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

// ============ LOGÍSTICA MODULE ============
async function loadLogistica() {
    const selector = document.getElementById('guide-select');
    if (!selector) return;
    
    // Si ya tiene opciones cargadas, no recargar automáticamente para mayor estabilidad
    if (selector.options.length > 2) return;

    selector.innerHTML = '<option value="">-- Cargando guías... --</option>';

    try {
        const guias = await fetchData('/api/guias');
        selector.innerHTML = '<option value="">-- Seleccione una Guía --</option>';
        
        guias.sort((a,b) => b._RowNumber - a._RowNumber).forEach(g => {
            const opt = document.createElement('option');
            opt.value = g.ID_GUIA || g.NUM_GUIA;
            opt.textContent = `Guía: ${g.NUM_GUIA || g.ID_GUIA} - ${g.CLIENTE || 'Emitida'}`;
            selector.appendChild(opt);
        });
    } catch (e) {
        console.error("Error cargando guías:", e);
        selector.innerHTML = '<option value="">Error al cargar</option>';
    }
}

async function loadLogisticaDetail(guiaId) {
    const tbody = document.getElementById('body-logistica');
    const metaRow = document.getElementById('guide-meta-cards');

    if (!guiaId) {
        if (metaRow) metaRow.style.display = 'none';
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;opacity:0.6;"><i class="fas fa-info-circle"></i> Seleccione una guía para ver el detalle</td></tr>';
        return;
    }

    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;"><i class="fas fa-spinner fa-spin"></i> Cargando spools...</td></tr>';

    try {
        const data = await fetchData(`/api/guia/${guiaId}`);
        const { guia, spools } = data;

        // Mostrar meta data
        if (metaRow) metaRow.style.display = 'grid';
        setText('info-origen', guia.ORIGEN || '-');
        setText('info-destino', guia.DESTINO || '-');
        setText('info-count', spools.length);

        // Render tabla
        if (spools.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;opacity:0.6;">No hay spools vinculados a esta guía.</td></tr>';
        } else {
            tbody.innerHTML = spools.map(s => `
                <tr>
                    <td><strong style="color:var(--primary-light)">${s.ID_SPOOL || '-'}</strong></td>
                    <td>${s.TAG_SPOOL || '-'}</td>
                    <td>${s.MAX_NPS_SPOOL || '-'}</td>
                    <td>${s.METROS_LINEALES || '0'} m</td>
                    <td>${s.ID_ISO || '-'}</td>
                    <td><span class="badge ${s.STATUS === 'RECIBIDO' ? 'badge-done' : 'badge-pending'}">${s.STATUS || 'EN TRANSITO'}</span></td>
                </tr>
            `).join('');
        }
    } catch (e) {
        console.error("Error cargando detalle de guía:", e);
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--error);">Error al cargar datos.</td></tr>';
    }
}

function copyLogisticaTable() {
    const table = document.getElementById('table-logistica');
    if (!table) return;
    
    const rows = table.querySelectorAll('tr');
    let textToCopy = "";

    rows.forEach(row => {
        const cols = row.querySelectorAll('th, td');
        const rowData = [];
        cols.forEach(col => rowData.push(col.innerText.trim()));
        textToCopy += rowData.join("\t") + "\n";
    });

    navigator.clipboard.writeText(textToCopy).then(() => {
        const btn = document.querySelector('.btn-copy-excel');
        if (!btn) return;
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-check"></i> ¡Copiado!';
        btn.style.background = '#059669';
        
        setTimeout(() => {
            btn.innerHTML = originalHTML;
            btn.style.background = '';
        }, 2000);
    }).catch(err => {
        alert("Error al copiar: " + err);
    });
}

// =================================================================
// ============ BIM VIEWER MODULE (APS / Autodesk) =================
// =================================================================

const bimState = {
    viewer:        null,   // Instancia del Autodesk.Viewing.GuiViewer3D
    initialized:   false,  // true cuando el modelo ya cargó
    sdkLoaded:     false,  // true cuando el script del SDK ya está en el DOM
    currentGuids:  [],     // GUIDs del spool actualmente seleccionado
    dbIds:         [],     // dbIds correspondientes en el viewer
    token:         null,
    modelUrn:      null,
    statusesCache: null    // Caché de { status: [guids] }
};

/**
 * Punto de entrada: se llama desde showSection('bim')
 * Carga el SDK si no está cargado, obtiene el token y arranca el viewer.
 */
async function initBimViewer() {
    // Detectar spool desde parámetro QR en la URL (?spool=XXXX)
    const urlParams   = new URLSearchParams(window.location.search);
    const spoolParam  = urlParams.get('spool');

    if (bimState.initialized) {
        // Visor ya listo: si hay parámetro QR, seleccionar directamente
        if (spoolParam) bimLoadSpool(spoolParam);
        return;
    }

    bimSetLoader('Obteniendo token APS...');

    try {
        // 1. Obtener token desde nuestro propio backend (nunca las credenciales crudas)
        const resp = await fetch('/api/bim/token');
        if (!resp.ok) throw new Error(`Error ${resp.status} obteniendo token APS`);
        const data = await resp.json();
        bimState.token    = data.access_token;
        bimState.modelUrn = data.model_urn;

        // 2. Verificar que el URN esté configurado
        if (!bimState.modelUrn || bimState.modelUrn === 'TU_URN_DEL_MODELO_EN_BASE64_AQUI') {
            document.getElementById('bim-loader').style.display    = 'none';
            document.getElementById('bim-urn-missing').style.display = 'flex';
            return;
        }

        // 3. Cargar el SDK de Autodesk Viewer si aún no está en el DOM
        if (!bimState.sdkLoaded) {
            bimSetLoader('Cargando SDK del visor 3D...');
            await bimLoadSdk();
            bimState.sdkLoaded = true;
        }

        // 4. Inicializar el viewer
        bimSetLoader('Inicializando visor...');
        await bimStartViewer();

        // 5. Si vino desde QR, cargar el spool automáticamente
        if (spoolParam) {
            document.getElementById('bim-search-input').value = spoolParam;
            await bimLoadSpool(spoolParam);
        }

    } catch (err) {
        console.error('[BIM] Error inicializando visor:', err);
        bimSetLoader(`❌ Error: ${err.message}`, true);
    }
}

/** Carga el script del Autodesk Viewer SDK de forma dinámica */
function bimLoadSdk() {
    return new Promise((resolve, reject) => {
        if (window.Autodesk) { resolve(); return; }
        const script = document.createElement('script');
        script.src = 'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/viewer3D.min.js';
        script.onload  = resolve;
        script.onerror = () => reject(new Error('No se pudo cargar el SDK de Autodesk Viewer'));
        document.head.appendChild(script);
    });
}

/** Inicializa Autodesk.Viewing y monta el GuiViewer3D */
function bimStartViewer() {
    return new Promise((resolve, reject) => {
        const options = {
            env: 'AutodeskProduction2',
            api: 'streamingV2',
            getAccessToken: (callback) => callback(bimState.token, 3600)
        };

        Autodesk.Viewing.Initializer(options, () => {
            const container = document.getElementById('forgeViewer');
            const viewer    = new Autodesk.Viewing.GuiViewer3D(container, {
                extensions: ['Autodesk.DefaultTools.NavTools']
            });

            const startCode = viewer.start();
            if (startCode > 0) {
                reject(new Error(`Viewer.start() falló con código ${startCode}`));
                return;
            }

            bimState.viewer = viewer;
            
            // Activar modo fantasma (ghosting) para aislar spools y ver el resto del modelo translúcido
            viewer.setGhosting(true);

            bimSetLoader('Cargando modelo 3D...');

            // Cargar el modelo desde el URN
            const urn = bimState.modelUrn.startsWith('urn:')
                ? btoa(bimState.modelUrn).replace(/=/g, '')
                : bimState.modelUrn;

            Autodesk.Viewing.Document.load(
                `urn:${urn}`,
                (doc) => {
                    const viewables = doc.getRoot().getDefaultGeometry();
                    viewer.loadDocumentNode(doc, viewables).then(() => {
                        bimState.initialized = true;
                        document.getElementById('bim-loader').style.display = 'none';

                        // Pre-cargar caché de estados de spools en background para visualización rápida
                        fetch('/api/bim/statuses')
                            .then(r => r.json())
                            .then(data => { bimState.statusesCache = data; })
                            .catch(err => console.error('[BIM] Error precargando estados:', err));

                        // Listener de depuración: muestra en consola F12 las propiedades de cualquier elemento clickeado
                        viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, (event) => {
                            const dbIdArray = event.dbIdArray;
                            if (dbIdArray && dbIdArray.length > 0) {
                                const selId = dbIdArray[0];
                                viewer.getProperties(selId, (pResult) => {
                                    console.log(`[BIM Debug] Elemento seleccionado dbId: ${selId}`, pResult);
                                });
                            }
                        });

                        resolve();
                    });
                },
                (errCode, errMsg) => {
                    reject(new Error(`Error cargando documento APS: ${errMsg} (${errCode})`));
                }
            );
        });
    });
}

/** Busca un spool desde la caja de búsqueda manual */
function bimSearchSpool() {
    const input = document.getElementById('bim-search-input');
    const val   = input ? input.value.trim() : '';
    if (!val) return;
    bimLoadSpool(val);
}

/**
 * Carga y resalta los elementos de un spool en el visor.
 * Llama al backend que resuelve GUIDs + metadata desde bim-data.json + AppSheet.
 */
async function bimLoadSpool(spoolId) {
    if (!bimState.initialized) {
        console.warn('[BIM] Visor no listo todavía.');
        return;
    }

    bimSetMeta('<div class="bim-loading-meta"><div class="bim-spinner-sm"></div> Buscando elementos...</div>');

    try {
        const resp = await fetch(`/api/bim/spool/${encodeURIComponent(spoolId)}`);
        if (!resp.ok) throw new Error(`Error ${resp.status}`);
        const data = await resp.json();

        if (!data.guids || data.guids.length === 0) {
            bimSetMeta(`
                <div class="bim-meta-empty">
                    <i class="fas fa-search"></i>
                    <p>No se encontraron elementos BIM para <strong>${spoolId}</strong></p>
                    <small>Verifica el ID_SPOOL o agrega el mapeo en bim-data.json</small>
                </div>`);
            return;
        }

        bimState.currentGuids = data.guids;

        // Convertir GUIDs a dbIds del viewer
        bimGuidsToDbIds(data.guids, (dbIds) => {
            bimState.dbIds = dbIds;
            if (dbIds.length > 0) {
                bimHighlightElements(dbIds);
                // Si el usuario está en móvil o tablet, colapsar automáticamente la barra
                // lateral para que el modelo 3D sea visible a pantalla completa de inmediato
                if (window.innerWidth <= 1024) {
                    bimCloseSidebar();
                }
            }
        });

        // Renderizar metadata en panel lateral
        bimRenderMeta(data);

    } catch (err) {
        console.error('[BIM] Error cargando spool:', err);
        bimSetMeta(`<div class="bim-meta-empty"><i class="fas fa-exclamation-triangle"></i><p>Error: ${err.message}</p></div>`);
    }
}

/** Convierte GUIDs de Revit a dbIds del Viewer buscando tanto en externalId como en propiedades internas (NWD/Navisworks/IFC) */
function bimGuidsToDbIds(guids, callback) {
    if (!bimState.viewer || !bimState.viewer.model) { callback([]); return; }
    
    console.log('[BIM] Buscando dbIds para los GUIDs:', guids);
    
    // Solicitamos externalId y propiedades comunes que almacenan el GUID de Revit
    bimState.viewer.model.getBulkProperties(
        null, // todos los objetos
        { propFilter: ['externalId', 'GUID', 'Element GUID', 'Revit GUID'] },
        (results) => {
            const guidSet = new Set(guids.map(g => g.toLowerCase()));
            const dbIds = [];

            results.forEach(r => {
                // 1. Caso estándar (RVT): externalId directo
                if (r.externalId && guidSet.has(r.externalId.toLowerCase())) {
                    dbIds.push(r.dbId);
                    return;
                }

                // 2. Caso Navisworks (NWD) o IFC: revisar propiedades del nodo
                if (r.properties && r.properties.length > 0) {
                    for (const prop of r.properties) {
                        const name = String(prop.displayName || prop.attributeName || '').toLowerCase();
                        if (['guid', 'element guid', 'revit guid'].includes(name)) {
                            const val = String(prop.displayValue || '').trim().toLowerCase();
                            if (guidSet.has(val)) {
                                dbIds.push(r.dbId);
                                return; // ya mapeado este nodo, pasar al siguiente
                            }
                        }
                    }
                }
            });

            console.log(`[BIM] Mapeados ${dbIds.length} dbIds de un total de ${guids.length} GUIDs.`, dbIds);
            callback(dbIds);
        },
        (err) => { 
            console.error('[BIM] getBulkProperties error:', err); 
            callback([]); 
        }
    );
}

/** Resalta en verde los dbIds del spool seleccionado */
function bimHighlightElements(dbIds) {
    const viewer = bimState.viewer;
    if (!viewer) return;

    // Aislar y colorear en verde brillante (igual que la imagen de referencia)
    viewer.isolate(dbIds);
    viewer.fitToView(dbIds);

    dbIds.forEach(id => {
        viewer.setThemingColor(id, new THREE.Vector4(0.18, 0.84, 0.44, 1), viewer.model, true);
    });

    // Mostrar botones de acción
    const actionsEl = document.getElementById('bim-actions');
    if (actionsEl) actionsEl.style.display = 'flex';
}

/** Aisla los elementos actuales (solo muestra esos) */
function bimIsolateElements() {
    if (!bimState.viewer || bimState.dbIds.length === 0) return;
    bimState.viewer.isolate(bimState.dbIds);
    bimState.viewer.fitToView(bimState.dbIds);
}

/** Centra la cámara en los elementos seleccionados */
function bimFitToView() {
    if (!bimState.viewer || bimState.dbIds.length === 0) return;
    bimState.viewer.fitToView(bimState.dbIds);
}

/** Restablece la vista del modelo completo */
function bimResetView() {
    if (!bimState.viewer) return;
    bimState.viewer.showAll();
    bimState.viewer.clearThemingColors(bimState.viewer.model);
    bimState.dbIds  = [];
    bimState.currentGuids = [];
    bimState.viewer.fitToView();
    
    // Resetear el select de filtros por estado
    const select = document.getElementById('bim-status-filter');
    if (select) select.value = '';

    const actionsEl = document.getElementById('bim-actions');
    if (actionsEl) actionsEl.style.display = 'none';
    bimSetMeta(`
        <div class="bim-meta-placeholder">
            <i class="fas fa-cube bim-meta-icon"></i>
            <p>Escanea un QR o busca un spool para ver su información y resaltarlo en el modelo 3D</p>
        </div>`);
    const listEl = document.getElementById('bim-elements-list');
    if (listEl) listEl.style.display = 'none';
}

/** Colores premium para cada estado del Spool en el visualizador 3D */
const BIM_STATUS_COLORS = {
    'MONTADO':         new THREE.Vector4(0.06, 0.75, 0.35, 1), // Verde brillante
    'POSICIONADO':     new THREE.Vector4(0.95, 0.45, 0.10, 1), // Naranja
    'POR MONTAR':      new THREE.Vector4(0.95, 0.85, 0.10, 1), // Amarillo
    'EN PINT/REVEST.': new THREE.Vector4(0.65, 0.30, 0.95, 1), // Morado
    'QAQC':            new THREE.Vector4(0.10, 0.65, 0.95, 1), // Azul
    'EN FABRICACIÓN':  new THREE.Vector4(0.30, 0.80, 0.95, 1), // Celeste
    'RETIRAR':         new THREE.Vector4(0.95, 0.15, 0.15, 1), // Rojo
    'ELIMINADO':       new THREE.Vector4(0.40, 0.40, 0.40, 0.5), // Gris translúcido
    'SIN ESTADO':      new THREE.Vector4(0.50, 0.50, 0.50, 0.3)  // Gris opaco
};

/** Filtra e aisla los elementos del modelo 3D según el estado de pre-fabricación seleccionado */
async function bimFilterByStatus() {
    const select = document.getElementById('bim-status-filter');
    const status = select ? select.value : '';
    
    if (!status) {
        bimResetView();
        return;
    }

    if (!bimState.initialized) return;

    // Limpiar input manual y cerrar cualquier lista de spool
    const input = document.getElementById('bim-search-input');
    if (input) input.value = '';
    const listEl = document.getElementById('bim-elements-list');
    if (listEl) listEl.style.display = 'none';

    bimSetMeta(`<div class="bim-loading-meta"><div class="bim-spinner-sm"></div> Buscando spools en estado ${status}...</div>`);

    try {
        let statuses = bimState.statusesCache;
        if (!statuses) {
            const resp = await fetch('/api/bim/statuses');
            if (!resp.ok) throw new Error(`Error ${resp.status}`);
            statuses = await resp.json();
            bimState.statusesCache = statuses;
        }

        const guids = statuses[status] || [];

        if (guids.length === 0) {
            bimSetMeta(`
                <div class="bim-meta-empty">
                    <i class="fas fa-info-circle"></i>
                    <p>No se encontraron elementos mapeados en estado <strong>${status}</strong></p>
                </div>`);
            bimState.viewer.isolate([]);
            return;
        }

        bimSetMeta(`<div class="bim-loading-meta"><div class="bim-spinner-sm"></div> Mapeando ${guids.length} elementos en modelo...</div>`);

        bimGuidsToDbIds(guids, (dbIds) => {
            bimState.dbIds = dbIds;
            const viewer = bimState.viewer;
            if (!viewer) return;

            // Restablecer colores anteriores
            viewer.clearThemingColors(viewer.model);

            if (dbIds.length > 0) {
                // Aislar y centrar en el visor
                viewer.isolate(dbIds);
                viewer.fitToView(dbIds);

                // Colorear con el color correspondiente
                const color = BIM_STATUS_COLORS[status] || new THREE.Vector4(0.18, 0.84, 0.44, 1);
                dbIds.forEach(id => {
                    viewer.setThemingColor(id, color, viewer.model, true);
                });

                // Mostrar botón de acciones rápidas
                const actionsEl = document.getElementById('bim-actions');
                if (actionsEl) actionsEl.style.display = 'flex';

                // Si está en móvil o tablet, cerrar el panel para ver el resultado de inmediato
                if (window.innerWidth <= 1024) {
                    bimCloseSidebar();
                }

                bimSetMeta(`
                    <div class="bim-meta-header" style="background: rgba(99,102,241,0.15); border-color: rgba(99,102,241,0.3);">
                        <i class="fas fa-filter"></i>
                        <span>Estado: ${status}</span>
                        <span class="bim-badge">${dbIds.length} elementos</span>
                    </div>
                    <div class="bim-meta-placeholder" style="padding: 1.5rem 0.5rem;">
                        <p style="font-size:0.78rem;">Se muestran solo los elementos del modelo que actualmente se registran en estado <strong>${status}</strong> en la tabla de control (LOG_Spool_MS).</p>
                    </div>
                `);
            } else {
                bimSetMeta(`
                    <div class="bim-meta-empty">
                        <i class="fas fa-exclamation-triangle"></i>
                        <p>Los elementos en estado <strong>${status}</strong> no corresponden a piezas del modelo 3D cargado.</p>
                    </div>`);
                viewer.isolate([]);
            }
        });

    } catch (err) {
        console.error('[BIM Status Filter Error]', err);
        bimSetMeta(`<div class="bim-meta-empty"><i class="fas fa-exclamation-triangle"></i><p>Error: ${err.message}</p></div>`);
    }
}

/** Renderiza las tarjetas de metadata en el panel lateral */
function bimRenderMeta(data) {
    const meta = data.metadata || {};
    const els  = data.elements || [];

    // Tarjetas de metadata
    const fields = [
        { label: 'ID Spool',    value: data.spool_id,              icon: 'fa-barcode' },
        { label: 'CWP',         value: els[0]?.cwp,                icon: 'fa-map-marker-alt' },
        { label: 'Línea',       value: els[0]?.numero_linea,        icon: 'fa-route' },
        { label: 'TAG',         value: els[0]?.tag,                 icon: 'fa-tag' },
        { label: 'Tamaño',      value: els[0]?.autocad_size,        icon: 'fa-ruler' },
        { label: 'Sistema',     value: meta['SISTEMA'],             icon: 'fa-layer-group' },
        { label: 'NPS',         value: meta['NPS'] ? `${meta['NPS']}"` : null, icon: 'fa-circle-notch' },
        { label: 'Material',    value: meta['MATERIAL'],            icon: 'fa-atom' },
        { label: 'Área',        value: meta['AREA'],                icon: 'fa-map' },
        { label: 'Responsable', value: meta['RESPONSABLE'],         icon: 'fa-user-hard-hat' },
        { label: 'Proceso',     value: meta['Proceso'],             icon: 'fa-cogs' }
    ].filter(f => f.value);

    const metaHtml = fields.map(f => `
        <div class="bim-meta-card">
            <span class="bim-meta-icon-sm"><i class="fas ${f.icon}"></i></span>
            <div>
                <span class="bim-meta-label">${f.label}</span>
                <span class="bim-meta-value">${f.value}</span>
            </div>
        </div>`).join('');

    bimSetMeta(`
        <div class="bim-meta-header">
            <i class="fas fa-cube"></i>
            <span>${data.spool_id}</span>
            <span class="bim-badge">${data.guids.length} elemento${data.guids.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="bim-meta-cards">${metaHtml}</div>`);

    // Lista de elementos
    if (els.length > 0) {
        const ul = document.getElementById('bim-elements-ul');
        if (ul) {
            ul.innerHTML = els.map(el => `
                <li class="bim-element-item">
                    <i class="fas fa-cube" style="color:var(--accent);margin-right:6px"></i>
                    <span title="${el.guid}">${el.descripcion || el.guid.substring(0, 8) + '...'}</span>
                </li>`).join('');
        }
        const listEl = document.getElementById('bim-elements-list');
        if (listEl) listEl.style.display = 'block';
    }
}

/** Helper: actualiza el contenido del panel de metadata */
function bimSetMeta(html) {
    const el = document.getElementById('bim-meta-panel');
    if (el) el.innerHTML = html;
}

/** Helper: actualiza el loader con mensaje opcional de error */
function bimSetLoader(msg, isError = false) {
    const loader = document.getElementById('bim-loader');
    const msgEl  = document.getElementById('bim-loader-msg');
    if (loader) loader.style.display = 'flex';
    if (msgEl)  msgEl.textContent = msg;
    if (isError && loader) {
        loader.style.background = 'rgba(239,68,68,0.08)';
        loader.style.border     = '1px solid rgba(239,68,68,0.2)';
    }
}

// =================================================================
// ============ QR SCANNER MODULE (jsQR + getUserMedia) =============
// =================================================================

const scannerState = {
    stream:       null,   // MediaStream activo
    animFrame:    null,   // requestAnimationFrame ID
    facingMode:   'environment', // 'environment'=trasera, 'user'=frontal
    scanning:     true,   // false cuando se detectó y se pausa
    lastResult:   null    // evitar disparar el mismo QR múltiples veces
};

/**
 * Abre el modal del escáner y arranca la cámara.
 * Requiere HTTPS o localhost para getUserMedia.
 */
async function bimOpenScanner() {
    const modal = document.getElementById('bim-scanner-modal');
    if (!modal) return;

    // Verificar que jsQR esté disponible
    if (typeof jsQR === 'undefined') {
        alert('El módulo jsQR no está disponible. Verifica la conexión a internet.');
        return;
    }

    // Mostrar modal
    modal.style.display = 'flex';
    scannerState.scanning  = true;
    scannerState.lastResult = null;

    bimScannerSetStatus('<i class="fas fa-camera"></i> Apunta al código QR del spool');

    // Ocultar resultado anterior
    const resultEl = document.getElementById('bim-scanner-result');
    if (resultEl) resultEl.style.display = 'none';

    try {
        await bimStartCamera();
    } catch (err) {
        console.error('[QR Scanner] Error iniciando cámara:', err);
        bimScannerSetStatus(`<i class="fas fa-exclamation-triangle" style="color:var(--danger)"></i> ${
            err.name === 'NotAllowedError'
                ? 'Permiso de cámara denegado. Permite el acceso en tu navegador.'
                : 'No se pudo acceder a la cámara: ' + err.message
        }`);
    }
}

/** Inicia el stream de cámara y el loop de escaneo */
async function bimStartCamera() {
    // Detener stream anterior si existe
    bimStopStream();

    const constraints = {
        video: {
            facingMode: scannerState.facingMode,
            width:  { ideal: 1280 },
            height: { ideal: 720 }
        },
        audio: false
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    scannerState.stream = stream;

    const video = document.getElementById('bim-qr-video');
    video.srcObject = stream;

    // Esperar a que el video esté listo y arrancar el loop
    video.onloadedmetadata = () => {
        video.play();
        bimScanLoop();
    };
}

/**
 * Loop de escaneo: captura un frame del video, lo pasa a jsQR.
 * Corre a ~30fps usando requestAnimationFrame.
 */
function bimScanLoop() {
    const video  = document.getElementById('bim-qr-video');
    const canvas = document.getElementById('bim-qr-canvas');
    if (!video || !canvas || !scannerState.scanning) return;

    const ctx = canvas.getContext('2d');

    function tick() {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
            // Ajustar canvas al tamaño del video
            canvas.width  = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height, {
                inversionAttempts: 'dontInvert'
            });

            if (code && code.data) {
                const result = code.data.trim();

                // Evitar disparar el mismo código repetidamente
                if (result !== scannerState.lastResult) {
                    scannerState.lastResult = result;
                    scannerState.scanning   = false; // pausar loop
                    bimOnQRDetected(result);
                    return; // no seguir el loop
                }
            }
        }

        // Continuar loop si no se detectó nada
        if (scannerState.scanning) {
            scannerState.animFrame = requestAnimationFrame(tick);
        }
    }

    scannerState.animFrame = requestAnimationFrame(tick);
}

/**
 * Callback cuando se detecta un QR válido.
 * Muestra flash de confirmación y carga el spool automáticamente.
 */
function bimOnQRDetected(value) {
    console.log('[QR Scanner] Detectado:', value);

    // Flash visual de confirmación
    const resultEl   = document.getElementById('bim-scanner-result');
    const resultText = document.getElementById('bim-scanner-result-text');
    if (resultEl && resultText) {
        resultText.textContent = value;
        resultEl.style.display = 'flex';
    }

    bimScannerSetStatus(`<i class="fas fa-check-circle" style="color:var(--accent)"></i> ¡Detectado! Cargando spool...`);

    // Esperar 1.2s para que el usuario vea el resultado y luego cerrar
    setTimeout(() => {
        bimCloseScanner();

        // Cargar el spool en el visor
        const inputEl = document.getElementById('bim-search-input');
        if (inputEl) inputEl.value = value;

        if (bimState.initialized) {
            bimLoadSpool(value);
        } else {
            // Si el viewer no está listo, inicializarlo primero con el spool
            initBimViewer().then(() => bimLoadSpool(value)).catch(console.error);
        }
    }, 1200);
}

/** Cierra el modal y detiene el stream de cámara */
function bimCloseScanner() {
    const modal = document.getElementById('bim-scanner-modal');
    if (modal) modal.style.display = 'none';

    scannerState.scanning = false;
    if (scannerState.animFrame) {
        cancelAnimationFrame(scannerState.animFrame);
        scannerState.animFrame = null;
    }
    bimStopStream();
}

/** Detiene el stream de cámara y libera el track */
function bimStopStream() {
    if (scannerState.stream) {
        scannerState.stream.getTracks().forEach(t => t.stop());
        scannerState.stream = null;
    }
    const video = document.getElementById('bim-qr-video');
    if (video) video.srcObject = null;
}

/** Alterna entre cámara frontal y trasera */
async function bimFlipCamera() {
    scannerState.facingMode  = scannerState.facingMode === 'environment' ? 'user' : 'environment';
    scannerState.scanning    = true;
    scannerState.lastResult  = null;

    // Detener frame loop actual antes de reiniciar
    if (scannerState.animFrame) {
        cancelAnimationFrame(scannerState.animFrame);
        scannerState.animFrame = null;
    }

    bimScannerSetStatus('<i class="fas fa-sync-alt fa-spin"></i> Cambiando cámara...');
    try {
        await bimStartCamera();
        bimScannerSetStatus('<i class="fas fa-camera"></i> Apunta al código QR del spool');
    } catch (err) {
        bimScannerSetStatus(`<i class="fas fa-exclamation-triangle" style="color:var(--danger)"></i> Error: ${err.message}`);
    }
}

/** Helper: actualiza el texto de estado del escáner */
function bimScannerSetStatus(html) {
    const el = document.getElementById('bim-scanner-status');
    if (el) el.innerHTML = html;
}

// =================================================================
// ============ MOBILE RESPONSIVE DRAWER TOGGLE ====================
// =================================================================

/** Alterna la barra lateral en versión móvil / tablet */
function bimToggleSidebar() {
    const sidebar = document.querySelector('.bim-sidebar');
    const overlay = document.getElementById('bim-sidebar-overlay');
    const btn     = document.getElementById('bim-sidebar-toggle');
    if (!sidebar || !overlay) return;

    const isOpen = sidebar.classList.contains('open');
    if (isOpen) {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
        if (btn) btn.innerHTML = '<i class="fas fa-info-circle"></i>';
    } else {
        sidebar.classList.add('open');
        overlay.classList.add('active');
        if (btn) btn.innerHTML = '<i class="fas fa-times"></i>';
    }
}

/** Cierra la barra lateral en versión móvil / tablet */
function bimCloseSidebar() {
    const sidebar = document.querySelector('.bim-sidebar');
    const overlay = document.getElementById('bim-sidebar-overlay');
    const btn     = document.getElementById('bim-sidebar-toggle');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
    if (btn) btn.innerHTML = '<i class="fas fa-info-circle"></i>';
}
