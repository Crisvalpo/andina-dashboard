/**
 * Andina Piping Dashboard — app.js (Entrypoint & Orchestrator)
 * AppSheet API V2 | ISO Weeks (Monday start)
 * Secciones: Overview, Juntas, Spools, QC, SDI
 */

// ── Modularización ESM (en curso) ────────────────────────────────────────────
// Solo se importa lo que YA fue migrado de forma verificada y fiel. El resto
// de las secciones sigue definido más abajo en este archivo hasta que su
// módulo sea reconstruido sin pérdida de funcionalidad.
import { state, charts } from './modules/state.js';
import { setText } from './utils/domUtils.js';
import { resolveSpoolId, normalizeStatus, resolveSpoolStatuses } from './utils/statusHelpers.js';
import {
    currentISOWeek, parseDate, formatDate, getWeekOfDate,
    getVal, getEstado, getJuntaId, getEtapaBadge, getMaxEtapa
} from './utils/dataHelpers.js';
import { renderOverview } from './components/renderOverview.js';
import { loadLineasData } from './components/renderLineas.js';
import { renderJuntas } from './components/renderJuntas.js';
import { renderSpools } from './components/renderSpools.js';
import { renderQC } from './components/renderQC.js';
import { renderSDI } from './components/renderSDI.js';
import { loadLogistica } from './components/logistica.js';
// bimOpenPdf / bimOpenSelectedPdf / bimOpenSelectedPid se invocan desde
// onclick generados en template strings, así que resuelven por window.
import { initBimSplitResizer } from './components/pdfViewer.js';
import { botInitPanel } from './modules/botHandler.js';
import { initBimViewer } from './modules/bimViewer.js';



// State, charts y Config son importados desde ./modules/state.js


// Los plugins de etiquetas viven en ./components/chartPlugins.js

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

    // Precargar datos de la sección Líneas en segundo plano para apertura instantánea
    loadLineasData().catch(e => console.warn('[Background Load Lineas]', e));

    // Inicializar barra divisoria de PDFs
    initBimSplitResizer();

    setInterval(updateTime, 60000);
    updateTime();
});

// ============ UTILS: SEMANA PROYECTO ============
// currentISOWeek, parseDate, formatDate y getWeekOfDate viven en ./utils/dataHelpers.js

// Sin uso: ISO 8601 real, distinto de la semana de proyecto que usa el dashboard.
function getISOWeek(d) {
    if (!(d instanceof Date)) d = new Date(d);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
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

    // Colapsar barra lateral principal en sección BIM para maximizar el espacio de visualización 3D
    const sidebar = document.querySelector('.sidebar');
    if (sidebar) {
        if (name === 'bim') {
            sidebar.classList.add('collapsed');
            document.body.classList.add('sidebar-collapsed');
        } else {
            sidebar.classList.remove('collapsed');
            document.body.classList.remove('sidebar-collapsed');
        }
    }

    const titles = {
        overview:  'Dashboard Overview',
        lineas:    '📐 Control de Líneas & Test Packs',
        juntas:    'Avance de Juntas',
        spools:    'Fabricación de Spools',
        qc:        'Control de Calidad',
        logistica: 'Logística y Despacho',
        sdi:       'SDI — Consultas Técnicas',
        bim:       '🧊 BIM Viewer — Modelo 3D',
        bot:       '🤖 Bot WhatsApp — Configuración'
    };

    const titleEl = document.getElementById('section-title');
    if (titleEl) titleEl.textContent = titles[name] || name;

    state.currentSection = name;

    // Ocultar filtro de semana en secciones estáticas
    const weekNav = document.getElementById('week-nav-container');
    if (['lineas', 'spools', 'qc', 'sdi', 'logistica', 'bim', 'bot'].includes(name)) {
        if (weekNav) weekNav.style.display = 'none';
    } else {
        if (weekNav) weekNav.style.display = 'flex';
    }

    renderCurrentSection();
}

function renderCurrentSection() {
    switch (state.currentSection) {
        case 'overview':  renderOverview();  break;
        case 'lineas':    loadLineasData();  break;
        case 'juntas':    renderJuntas();    break;
        case 'spools':    renderSpools();    break;
        case 'qc':        renderQC();        break;
        case 'sdi':       renderSDI();       break;
        case 'logistica': loadLogistica();   break;
        case 'bim':       initBimViewer();   break;
        case 'bot':       botInitPanel();    break;
    }
}

// ============ RENDER: WELDER PERFORMANCE (DI) ============
// renderWelderChart vive en ./components/charts.js

// ============ RENDER: SDI (RFI) ============
// renderSDI vive en ./components/renderSDI.js

// filterSDI vive en ./components/renderSDI.js

// ============ API FETCH ============
async function fetchTable(tableName) {
    const url = `/api/data/${tableName}`;
    try {
        const res = await fetch(url);
        if (!res.ok) { console.error(`[API] ${tableName} → HTTP ${res.status}`); return []; }
        // El server sirvió caché vencida al instante y está refrescando por
        // detrás → programar UNA recarga silenciosa para pintar lo fresco.
        if (res.headers.get('X-Cache') === 'stale') programarRefrescoStale();
        const data = await res.json();
        return Array.isArray(data) ? data : [];
    } catch (e) {
        console.error(`[API] Fallo red ${tableName}:`, e);
        return [];
    }
}

let _staleTimer = null;
let _staleUltimo = 0;
function programarRefrescoStale() {
    const ahora = Date.now();
    if (_staleTimer || (ahora - _staleUltimo) < 30000) return; // máx. 1 recarga por ciclo
    _staleTimer = setTimeout(() => {
        _staleTimer = null;
        _staleUltimo = Date.now();
        console.log('[Dashboard] Datos frescos disponibles — actualizando en silencio');
        if (typeof refreshData === 'function') refreshData();
    }, 6000);
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

// getVal, getEstado, getJuntaId, getEtapaBadge, getEtapaWeight y getMaxEtapa
// viven en ./utils/dataHelpers.js

// ============ RENDER: OVERVIEW ============
// renderOverview vive en ./components/renderOverview.js

// getMaterialLabel vive en ./utils/dataHelpers.js

// renderJuntasBreakdown vive en ./components/charts.js

function toggleJuntaCol(type) {
    const col = document.getElementById(`col-${type}`);
    if (col) {
        col.classList.toggle('collapsed');
    }
}

// renderSCurve vive en ./components/charts.js

// renderBarChart vive en ./components/charts.js

// renderLogTable vive en ./components/charts.js

// ============ RENDER: JUNTAS ============
// renderJuntas vive en ./components/renderJuntas.js

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

// resolveSpoolStatuses (y su helper parseFechaSpool) viven en ./utils/statusHelpers.js

// ============ RENDER: SPOOLS ============

// --- Configuración visual de estados conocidos para tarjetas KPI ---
// Los COLORES se obtienen de bimColorDeEstado() para mantener sincronía
// con la sección BIM (incluidos los colores editados por el usuario).
// SPOOL_STATUS_VISUAL vive en ./components/renderSpools.js

/** Obtiene icono, color y label para cualquier estado (conocido o nuevo).
 *  El color se toma de bimColorDeEstado() → misma fuente que el visor 3D. */
// getSpoolStatusVisual vive en ./components/renderSpools.js


// renderSpools vive en ./components/renderSpools.js

// resolveSpoolId y normalizeStatus son importados desde ./utils/statusHelpers.js

// ============ RENDER: QC ============
// renderQC vive en ./components/renderQC.js

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

// setText es importado desde ./utils/domUtils.js

// ============ LOGÍSTICA MODULE ============
// loadLogistica vive en ./components/logistica.js

// loadLogisticaDetail vive en ./components/logistica.js

// copyLogisticaTable vive en ./components/logistica.js

// El subsistema BIM completo vive en ./modules/bimViewer.js


// ============================================================================
// PUENTE A window — obligatorio con <script type="module">
// ----------------------------------------------------------------------------
// Con módulos ESM nada es global. index.html usa handlers onclick inline y
// bim-ifc-export.js se carga como script clásico, así que ambos resuelven
// contra window. Este bloque debe seguir cubriendo todo lo que se invoque
// desde HTML: si una función se renombra aquí, el botón deja de responder.
// ============================================================================
// Cada módulo expone lo suyo; aquí solo va lo que app.js sigue definiendo.
if (typeof window !== 'undefined') {
    window.changeWeek               = changeWeek;
    window.goToCurrentWeek          = goToCurrentWeek;
    window.refreshData              = refreshData;
    window.renderCurrentSection     = renderCurrentSection;
    window.showSection              = showSection;
    window.toggleJuntaCol           = toggleJuntaCol;
    window.toggleWelderHistory      = toggleWelderHistory;
}
