/**
 * Andina Piping Dashboard — app.js
 * AppSheet API V2 | ISO Weeks (Monday start)
 * Secciones: Overview, Juntas, Spools, QC, SDI
 */

// ============ CONFIG ============
const API = {
    appId: 'eb4713b6-0828-4993-b5e1-935eec83cf4e',
    appKey: 'V2-b9qXt-SY9es-eDDQb-L2lXN-NIInJ-U0DvZ-5fa2N-4huez',
    base: 'https://api.appsheet.com/api/v2/apps'
};

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

// ============ INIT ============
document.addEventListener('DOMContentLoaded', () => {
    setWeekDisplay(state.currentWeek);
    refreshData();
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
        if (d2 > 12) { // MM/DD/YYYY
            month = d1 - 1; day = d2;
        } else if (d1 > 12) { // DD/MM/YYYY
            month = d2 - 1; day = d1;
        } else {
            // Ambiguous (e.g. 01/04/2026). Check which one gives Week 28 vs Week 15
            const test1 = new Date(year, d2 - 1, d1); // Assume DD/MM
            const w1 = getProjectWeek(test1);
            const todayW = getProjectWeek(new Date());

            if (Math.abs((w1 || 0) - todayW) < 5) {
                month = d2 - 1; day = d1;
            } else {
                month = d1 - 1; day = d2;
            }
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
function showSection(name) {
    document.querySelectorAll('.section-content').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

    document.getElementById(`${name}-section`).classList.add('active');
    document.getElementById(`nav-${name}`).classList.add('active');

    const titles = {
        overview: 'Dashboard Overview',
        juntas: 'Avance de Juntas',
        spools: 'Fabricación de Spools',
        qc: 'Control de Calidad',
        sdi: 'SDI — Consultas Técnicas'
    };
    document.getElementById('section-title').textContent = titles[name] || name;
    state.currentSection = name;
    renderCurrentSection();
}

function renderCurrentSection() {
    switch (state.currentSection) {
        case 'overview': renderOverview(); break;
        case 'juntas': renderJuntas(); break;
        case 'spools': renderSpools(); break;
        case 'qc': renderQC(); break;
        case 'sdi': renderSDI(); break;
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

    // 2. Weekly Production (Daily)
    const days = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes'];
    const weekExec = ejecuciones.filter(e => {
        const status = getEstado(e).toUpperCase();
        return status.includes('EJECUTAD') && getWeekOfDate(getVal(e, 'FECHA_EJECUCION')) === currentWeek;
    });

    const welderData = {}; // { welder: [0,0,0,0,0] }
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
        
        let dIdx = date.getDay();
        if (dIdx === 0 || dIdx > 5) return; 
        
        if (!welderData[name]) welderData[name] = [0, 0, 0, 0, 0];
        welderData[name][dIdx - 1] += nps;
    });

    console.log(`[KPI] Total Week DI: ${totalWeekDI}. Welders:`, Object.keys(welderData));
    setText('kpi-di-semana', totalWeekDI.toFixed(1));

    // Render Weekly Chart
    const ctxWeekly = document.getElementById('welderChart');
    if (ctxWeekly) {
        if (charts.welder) charts.welder.destroy();
        const welders = Object.keys(welderData);
        const colors = ['#0ea5e9', '#f59e0b', '#10b981', '#a78bfa', '#ef4444', '#38bdf8'];

        charts.welder = new Chart(ctxWeekly, {
            type: 'bar',
            data: {
                labels: days,
                datasets: welders.map((w, i) => ({
                    label: w,
                    data: welderData[w],
                    backgroundColor: colors[i % colors.length],
                    borderRadius: 4
                }))
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true, grid: { color: '#1e293b' }, ticks: { color: '#64748b' }, title: { display: true, text: 'DI (Pulgadas Diámetro)', color: '#64748b' } },
                    x: { grid: { display: false }, ticks: { color: '#64748b' } }
                },
                plugins: { legend: { position: 'bottom', labels: { color: '#64748b', boxWidth: 12 } } }
            }
        });
    }

    // 3. Historic Production
    const histExec = ejecuciones.filter(e => getEstado(e).toUpperCase().includes('EJECUTAD'));
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

        charts.welderHist = new Chart(ctxHist, {
            type: 'bar', // Horizontal bar is set via indexAxis
            data: {
                labels,
                datasets: [{
                    label: 'Total Pulgadas (DI)',
                    data,
                    backgroundColor: '#10b981',
                    borderRadius: 4
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true, maintainAspectRatio: false,
                scales: {
                    x: { beginAtZero: true, grid: { color: '#1e293b' }, ticks: { color: '#64748b' } },
                    y: { grid: { display: false }, ticks: { color: '#64748b' } }
                },
                plugins: { legend: { display: false } }
            }
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
    const url = `${API.base}/${API.appId}/tables/${tableName}/Action`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'ApplicationAccessKey': API.appKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ Action: 'Find', Properties: { Locale: 'es-CL' }, Rows: [] })
        });
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

    const [lineas, isos, spools, juntas, ejecuciones, sdis, relSdiIso, inspecciones, dimensional, catUniones, catFluidos, personal] = await Promise.all([
        fetchTable('LIST_Lineas_MS'),
        fetchTable('LIST_Iso_MS'),
        fetchTable('LIST_Spools_MS'),
        fetchTable('LIST_Juntas_MS'),
        fetchTable('REG_EjecucionJuntas_MS'),
        fetchTable('LOG_SDI_MS'),
        fetchTable('REL_SDIIso_MS'),
        fetchTable('REG_InspeccionVisual_MS'),
        fetchTable('REG_DimensionalSpool_MS'),
        fetchTable('CAT_TipoUnion_MS'),
        fetchTable('CAT_FluidoServicio_MS'),
        fetchTable('CAT_Personal_MS')
    ]);

    state.lineas = lineas;
    state.isos = isos;
    state.spools = spools;
    state.juntas = juntas;
    state.ejecuciones = ejecuciones;
    state.sdis = sdis;
    state.relSdiIso = relSdiIso || [];
    state.inspecciones = inspecciones;
    state.dimensional = dimensional || [];
    state.catUniones = catUniones || [];
    state.catFluidos = catFluidos || [];
    state.personal = personal || [];


    const ok = juntas.length > 0 || lineas.length > 0;
    dot.className = 'api-dot' + (ok ? '' : ' error');

    updateTime();
    renderCurrentSection();
    console.log(`[Dashboard] Datos cargados: ${lineas.length} líneas | ${isos.length} ISOs | ${spools.length} spools | ${sdis.length} SDIs`);
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
    if (e.includes('EMPLANTILL')) return `<span class="badge badge-emplantillado">EMPLANTILLADO</span>`;
    if (e.includes('CORTE')) return `<span class="badge badge-corte">CORTE</span>`;
    return `<span class="badge badge-pending">${estado}</span>`;
}

function getEtapaWeight(estado) {
    if (!estado) return 0;
    const e = estado.toUpperCase();
    if (e.includes('EJECUTAD')) return 3;
    if (e.includes('EMPLANTILL')) return 2;
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
    setText('kpi-spools-total', spools.length);
    setText('kpi-total-juntas', juntas.length);

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
    const ejecutadas = juntas.filter(j => {
        const et = getMaxEtapa(j.ID_JUNTA || j['ID_JUNTA ']);
        return et && et.toUpperCase().includes('EJECUTAD');
    }).length;

    const enProceso = ejecuciones.filter(e => {
        const et = getEstado(e).toUpperCase();
        return et.includes('EMPLANTILL') || et.includes('CORTE');
    }).map(e => getJuntaId(e)).filter((v, i, a) => v && a.indexOf(v) === i).length;

    const sdiPendientes = sdis.filter(s => {
        const est = getVal(s, 'ESTADO').toUpperCase();
        return !est.includes('RESPONDID') && !est.includes('CERRAD');
    }).length;

    // Semana actual
    const semanaActual = ejecuciones.filter(e => getWeekOfDate(e.FECHA_EJECUCION) === state.currentWeek).length;

    setText('kpi-ejecutadas', ejecutadas);
    setText('kpi-en-proceso', enProceso);
    setText('kpi-sdi', sdiPendientes);
    setText('kpi-semana', semanaActual);

    const tag = document.getElementById('week-tag');
    if (tag) tag.textContent = `S${state.currentWeek}`;

    // S-Curve chart
    renderSCurve();

    // Bar chart by fluid
    renderBarChart();

    // Latest movements table
    renderLogTable();
}

function renderJuntasBreakdown() {
    const { juntas, catUniones } = state;

    // Maps for fast lookup
    const catMap = {};
    catUniones.forEach(c => {
        catMap[(c.ID_TIPO_UNION || c['ID_TIPO_UNION '] || '').trim()] = (c.NMB_UNION || c['NMB_UNION '] || '').trim();
    });

    const shop = { total: 0, ejec: 0, types: {} };
    const field = { total: 0, ejec: 0, types: {} };

    juntas.forEach(j => {
        const cat = (j.CATEGORIA_JUNTA || j['CATEGORIA_JUNTA '] || '').toUpperCase().trim();
        const tipo = (j.ID_TIPO_UNION || j['ID_TIPO_UNION '] || 'VAR').trim();
        const et = getMaxEtapa(j.ID_JUNTA || j['ID_JUNTA ']);
        const isEjecutada = et && et.toUpperCase().includes('EJECUTAD');

        const isShop = cat === 'S' || cat === 'SHOP' || cat === 'TALLER';
        const target = isShop ? shop : field; // Si no es S, asumimos Field por defecto

        target.total++;
        if (isEjecutada) target.ejec++;

        if (!target.types[tipo]) target.types[tipo] = { total: 0, ejec: 0, name: catMap[tipo] || 'S/D' };
        target.types[tipo].total++;
        if (isEjecutada) target.types[tipo].ejec++;
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

    // Render Cards
    const renderCards = (typeObj) => {
        const types = Object.keys(typeObj).sort((a, b) => typeObj[b].total - typeObj[a].total);
        if (!types.length) return `<div class="empty-msg" style="padding:1rem">Sin registros</div>`;
        return types.map(t => {
            const data = typeObj[t];
            return `<div class="jc-card">
                <div class="jc-card-title">${t}</div>
                <div class="jc-card-subtitle" title="${data.name}">${data.name}</div>
                <div class="jc-card-stats">
                    <div><span class="label">TOTAL</span><span class="val">${data.total}</span></div>
                    <div><span class="label">EJEC</span><span class="val done">${data.ejec}</span></div>
                </div>
            </div>`;
        }).join('');
    };

    const sCards = document.getElementById('shop-cards');
    if (sCards) sCards.innerHTML = renderCards(shop.types);

    const fCards = document.getElementById('field-cards');
    if (fCards) fCards.innerHTML = renderCards(field.types);
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
                y: { beginAtZero: true, grid: { color: '#1e293b' }, ticks: { color: '#64748b' } },
                x: { grid: { display: false }, ticks: { color: '#64748b' } }
            },
            plugins: { legend: { display: false } }
        }
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
                y: { beginAtZero: true, grid: { color: '#1e293b' }, ticks: { color: '#64748b' } },
                x: { grid: { display: false }, ticks: { color: '#64748b' } }
            },
            plugins: { legend: { display: false } }
        }
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

    // Count by max etapa per junta
    let ejecutadas = 0, emplantillado = 0, corte = 0, pendiente = 0;

    juntas.forEach(j => {
        const id = (j.ID_JUNTA || j['ID_JUNTA '] || '').trim();
        const etapa = getMaxEtapa(id);
        if (!etapa) { pendiente++; return; }
        const e = etapa.toUpperCase();
        if (e.includes('EJECUTAD')) ejecutadas++;
        else if (e.includes('EMPLANTILL')) emplantillado++;
        else if (e.includes('CORTE')) corte++;
        else pendiente++;
    });

    setText('j-ejecutadas', ejecutadas);
    setText('j-emplantillado', emplantillado);
    setText('j-corte', corte);
    setText('j-pendiente', pendiente);

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
                labels: ['Ejecutadas', 'Emplantillado', 'Corte', 'Sin Iniciar'],
                datasets: [{
                    data: [ejecutadas, emplantillado, corte, pendiente],
                    backgroundColor: ['#10b981', '#6366f1', '#f59e0b', '#334155'],
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
                    y: { beginAtZero: true, grid: { color: '#1e293b' }, ticks: { color: '#64748b' } },
                    x: { grid: { display: false }, ticks: { color: '#64748b' } }
                },
                plugins: { legend: { labels: { color: '#64748b', boxWidth: 12 } } }
            }
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

// ============ RENDER: SPOOLS ============
function renderSpools() {
    const { spools } = state;

    // Lógica refinada de estados
    const fab = spools.filter(s => {
        const st = (s.ESTADO_FABRICACION || '').toUpperCase();
        return st.includes('EN FABRICACION') && !st.includes('FABRICADO');
    }).length;

    const pintura = spools.filter(s => {
        const cv = (s.ESTADO_CICLO_VIDA || '').toUpperCase();
        return cv.includes('PINTURA');
    }).length;

    const despachados = spools.filter(s => {
        const cv = (s.ESTADO_CICLO_VIDA || '').toUpperCase();
        return cv.includes('DESPACH') || cv.includes('LLEGADA') || cv.includes('TERRENO');
    }).length;

    const montados = spools.filter(s => {
        const cv = (s.ESTADO_CICLO_VIDA || '').toUpperCase();
        return cv.includes('MONTADO') || cv.includes('MONTAJE') || cv.includes('INSTALADO');
    }).length;

    const fabCount = spools.filter(s => (s.ESTADO_FABRICACION || '').toUpperCase().includes('FABRICADO')).length;

    setText('s-total', spools.length);
    setText('s-fab', fab);
    setText('s-fabricados', fabCount);
    setText('s-pintura', pintura);
    setText('s-despachados', despachados);
    setText('s-montados', montados);

    // Gráficos Spools

    // 1. Distribución por Estado
    const ctxEstado = document.getElementById('spools-estado-chart');
    if (ctxEstado) {
        if (charts.spoolsEstado) charts.spoolsEstado.destroy();

        const estadosMap = {};
        spools.forEach(s => {
            let e = (s.ESTADO_FABRICACION || 'PENDIENTE').trim();
            e = e.replace(/^[^\w\s]+/, '').trim(); // Remove emojis
            estadosMap[e] = (estadosMap[e] || 0) + 1;
        });

        const labels = Object.keys(estadosMap);
        const data = Object.values(estadosMap);

        charts.spoolsEstado = new Chart(ctxEstado, {
            type: 'doughnut',
            data: {
                labels,
                datasets: [{
                    data,
                    backgroundColor: [
                        '#64748b', // Pendiente
                        '#6366f1', // Fab
                        '#f59e0b', // Pintura
                        '#10b981', // Despachado
                        '#0ea5e9', // Otro
                        '#ec4899'
                    ],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                cutout: '70%',
                plugins: {
                    legend: { position: 'right', labels: { color: '#64748b', boxWidth: 12 } }
                }
            }
        });
    }

    // 2. Spools por Fluido
    const ctxFluido = document.getElementById('spools-fluido-chart');
    if (ctxFluido) {
        if (charts.spoolsFluido) charts.spoolsFluido.destroy();

        let fluidList = state.catFluidos.map(f => (f.ID_FLUIDO || f['ID_FLUIDO '] || '').trim()).filter(Boolean);
        if (!fluidList.length) fluidList = ['CT', 'PW', 'IA', 'GW', 'FP', 'RW']; // fallback

        const fluidosMap = {};
        fluidList.forEach(f => fluidosMap[f] = 0);
        fluidosMap['OTROS'] = 0;

        spools.forEach(s => {
            const val = (s.ID_ISO || s['ID_ISO '] || s.LINEA || '').toUpperCase();
            const fl = fluidList.find(f => val.includes(`-${f}-`) || val.includes(`/${f}/`));
            if (fl) {
                fluidosMap[fl]++;
            } else {
                fluidosMap['OTROS']++;
            }
        });

        // Solo mostrar los que tienen datos
        const labels = Object.keys(fluidosMap).filter(l => fluidosMap[l] > 0).sort((a, b) => fluidosMap[b] - fluidosMap[a]).slice(0, 6);
        const data = labels.map(l => fluidosMap[l]);

        charts.spoolsFluido = new Chart(ctxFluido, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Spools',
                    data,
                    backgroundColor: '#0ea5e9',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true, grid: { color: '#1e293b' }, ticks: { color: '#64748b' } },
                    x: { grid: { display: false }, ticks: { color: '#64748b' } }
                },
                plugins: {
                    legend: { display: false }
                }
            }
        });
    }
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
