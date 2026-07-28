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
import { fetchData } from './services/apiService.js';
import { setText } from './utils/domUtils.js';
import { resolveSpoolId, normalizeStatus, resolveSpoolStatuses } from './utils/statusHelpers.js';
import {
    currentISOWeek, parseDate, formatDate, getWeekOfDate,
    getVal, getEstado, getJuntaId, getEtapaBadge, getMaxEtapa
} from './utils/dataHelpers.js';
import { barLabelsPlugin, doughnutLabelsPlugin } from './components/chartPlugins.js';
import { renderOverview } from './components/renderOverview.js';
import { renderJuntas } from './components/renderJuntas.js';



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
    if (['spools', 'qc', 'sdi', 'logistica', 'bim', 'bot'].includes(name)) {
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
        case 'bot':       botInitPanel();    break;
    }
}

// ============ RENDER: WELDER PERFORMANCE (DI) ============
// renderWelderChart vive en ./components/charts.js

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
const SPOOL_STATUS_VISUAL = {
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
function getSpoolStatusVisual(normalizedStatus) {
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


function renderSpools() {
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

    // --- GENERAR TARJETAS DINÁMICAS ---
    const container = document.getElementById('spools-status-cards');
    if (container) {
        /** Convierte hex (#rrggbb) a rgba con alpha 0.15 para fondo del icono */
        function iconBg(hex) {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            return `rgba(${r}, ${g}, ${b}, 0.15)`;
        }

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

        // Tarjeta fija: Total Activos (siempre al final)
        cardsHtml += `<div class="kpi-card glass">
            <div class="kpi-icon" style="background:rgba(56, 189, 248, 0.15)"><i class="fas fa-industry" style="color:#38bdf8"></i></div>
            <div>
                <p class="kpi-label">Total Activos</p>
                <p class="kpi-value">${cTotalActivos}</p>
            </div>
        </div>`;

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
}

// resolveSpoolId y normalizeStatus son importados desde ./utils/statusHelpers.js

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

// setText es importado desde ./utils/domUtils.js

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

// Estado del visor 3D. Vive aquí hasta que el subsistema BIM completo
// (~123 símbolos que comparten bimState y divState) se extraiga de una sola vez.
const bimState = {
    viewer:        null,   // Instancia del Autodesk.Viewing.GuiViewer3D
    initialized:   false,  // true cuando el modelo ya cargó
    sdkLoaded:     false,  // true cuando el script del SDK ya está en el DOM
    currentGuids:  [],     // GUIDs del spool actualmente seleccionado
    dbIds:         [],     // dbIds correspondientes en el viewer
    token:         null,
    modelUrn:      null,
    statusesCache: null,   // Caché de { status: [guids] }
    selectedElement: null, // Elemento 3D clickeado actualmente
    selectedElements: [],  // Múltiples elementos 3D clickeados
    mapeoSpools:   null,   // Caché de { [guid]: spoolTag }
    spoolIndex:    null,   // Caché de { [tagLower]: { id_spool, tag_gestion, id_iso } }
    isAutoSelecting: false,// Bandera para evitar bucle de selección
    liveTimer:     null,   // Interval del modo EN VIVO (filtro por estado + polling)
    liveStatus:    null,   // (legado) estado único en vivo
    liveGuids:     null,   // (legado) set de guids mostrados
    liveEstados:   null,   // Estados seguidos EN VIVO (multi-selección)
    liveSets:      null,   // { estado: Set<guid> } ya mostrados
    filtroEstados: new Set(), // Estados seleccionados en el filtro (chips)
    coloresEstados: {},    // Overrides de color por estado (servidor)
    estadoConteos: null,   // { estado: {total, asociados, sin_asociar} } — conteo REAL de spools
    capaStatuses:  null,   // Estados de la capa válvula/soporte activa
    capa:          'spool',// Capa activa: 'spool' | 'valvula' | 'soporte'
    capaMapeo:     {},     // { valvula: {guidLower:id}, soporte: {...} }
    capaIndex:     {}      // { valvula: {idLower:row}, soporte: {...} }
};

// Config de capas en el frontend (llave, etiqueta, endpoints)
const BIM_CAPA_UI = {
    spool:   { label: 'Spool',   buscar: 'Buscar Spool',   placeholder: 'TAG Gestión (ej: 217)' },
    valvula: { label: 'Válvula', buscar: 'Buscar Válvula', placeholder: 'ID Válvula (ej: VAL113)' },
    soporte: { label: 'Soporte', buscar: 'Buscar Soporte', placeholder: 'ID/ITEM Soporte (ej: 148)' }
};

/** Cambia la capa activa (Spools / Válvulas / Soportes) y recarga su mapeo+índice. */
async function bimSetCapa(capa) {
    if (!BIM_CAPA_UI[capa]) return;
    bimLiveStop();
    bimState.capa = capa;

    // UI: botones activos
    document.querySelectorAll('.bim-capa-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`bim-capa-${capa}`);
    if (btn) btn.classList.add('active');

    // UI: etiqueta y placeholder de búsqueda
    const lbl = document.getElementById('bim-search-label');
    if (lbl) lbl.innerHTML = `<i class="fas fa-search"></i> ${BIM_CAPA_UI[capa].buscar}`;
    const inp = document.getElementById('bim-search-input');
    if (inp) { inp.placeholder = BIM_CAPA_UI[capa].placeholder; inp.value = ''; }

    // Limpiar selección/panel y colores
    if (bimState.viewer) { bimState.viewer.clearThemingColors(bimState.viewer.model); bimState.viewer.select([]); }
    const panel = document.getElementById('bim-link-panel');
    if (panel) panel.style.display = 'none';
    bimSetMeta(`<div class="bim-meta-placeholder"><i class="fas fa-cube bim-meta-icon"></i><p>Capa: <strong>${BIM_CAPA_UI[capa].label}s</strong>. Selecciona un elemento en el modelo o busca por su ID.</p></div>`);

    // Filtro por estado según capa
    bimUpdateStatusFilterOptions(capa);

    // Cargar mapeo + índice de la capa (spools ya se cargan en init)
    if (capa !== 'spool' && !bimState.capaIndex[capa]) {
        try {
            const [mapeo, index] = await Promise.all([
                fetch(`/api/bim/${capa}/mapeo`).then(r => r.json()),
                fetch(`/api/bim/${capa}/index`).then(r => r.json())
            ]);
            bimState.capaMapeo[capa] = mapeo || {};
            bimState.capaIndex[capa] = index || {};
        } catch (e) {
            console.error(`[BIM] Error cargando capa ${capa}:`, e);
        }
    }
}

/** Ajusta las opciones del filtro por estado según la capa (spools tienen flujo; válvulas/soportes binario). */
async function bimUpdateStatusFilterOptions(capa) {
    // Chips dinámicos por capa; limpiar la selección al cambiar de capa
    bimState.filtroEstados.clear();
    if (capa === 'spool') {
        bimRenderStatusChips();
    } else {
        bimState.capaStatuses = null;
        bimRenderStatusChips(); // "cargando…"
        try {
            bimState.capaStatuses = await (await fetch(`/api/bim/${capa}/statuses`)).json();
        } catch (e) { bimState.capaStatuses = {}; }
        bimRenderStatusChips();
    }
}

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

                        // Pre-cargar estados + colores + conteos reales + mapeo spools
                        Promise.all([
                            fetch('/api/bim/statuses').then(r => r.json()).catch(() => null),
                            bimCargarColoresEstados(),
                            fetch('/api/bim/estado-conteos').then(r => r.json()).catch(() => null),
                            fetch('/api/bim/mapeo').then(r => r.json()).catch(() => null)
                        ]).then(([data, , conteos, mapeo]) => {
                            if (data) bimState.statusesCache = data;
                            if (conteos) bimState.estadoConteos = conteos;
                            if (mapeo) bimState.mapeoSpools = mapeo;
                            bimRenderStatusChips();
                            // Si por algún motivo ya había un filtro activo, refrescar el panel
                            if (bimState.filtroEstados.size > 0) {
                                bimAplicarFiltroEstados();
                            }
                        }).catch(err => console.error('[BIM] Error precargando datos iniciales:', err));

                        // Pre-cargar el índice TAG -> { id_spool, tag_gestion } para mostrar el ID largo
                        fetch('/api/bim/spool-index')
                            .then(r => r.json())
                            .then(data => { bimState.spoolIndex = data; })
                            .catch(err => console.error('[BIM] Error precargando índice de spools:', err));

                        // Herramienta "Dividir tramo" en la toolbar APS + divisiones guardadas
                        bimDividirInit();

                        // Coloreo por estado al aislar líneas desde el árbol del modelo
                        bimIsoColorInit();

                        // Listener de selección: captura propiedades para vinculación en tiempo real (admite selección múltiple con CTRL)
                        viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, (event) => {
                            const dbIdArray = event.dbIdArray;
                            const panel = document.getElementById('bim-link-panel');
                            
                            if (dbIdArray && dbIdArray.length > 0) {
                                // Capturamos si esta es la re-entrada provocada por la auto-selección
                                // de grupo. En ese caso NO volvemos a auto-seleccionar, pero SÍ pintamos
                                // el panel con el grupo completo (antes se retornaba y quedaba sin info).
                                const skipAuto = bimState.isAutoSelecting;

                                // Obtener propiedades de todos los elementos seleccionados en un único bloque
                                viewer.model.getBulkProperties(
                                    dbIdArray,
                                    { propFilter: ['externalId', 'GUID', 'Element GUID', 'Revit GUID', 'Layer', 'PnPGuid', 'PnPGUID'] },
                                    (results) => {
                                        const selectedList = [];
                                        const uniqueLayers = new Set();

                                        results.forEach(pResult => {
                                            let guid = pResult.externalId || '';
                                            let layer = '';
                                            let sourceFile = '';
                                            
                                            if (pResult.properties) {
                                                pResult.properties.forEach(prop => {
                                                    const propName = String(prop.displayName || prop.attributeName || '').toLowerCase();
                                                    if (['guid', 'element guid', 'revit guid', 'pnpguid'].includes(propName)) {
                                                        guid = String(prop.displayValue || '').trim();
                                                    }
                                                    if (propName === 'layer') {
                                                        layer = String(prop.displayValue || '').trim();
                                                    }
                                                    if (propName === 'source file') {
                                                        sourceFile = String(prop.displayValue || '').trim();
                                                    }
                                                });
                                            }

                                            if (guid) {
                                                selectedList.push({
                                                    dbId: pResult.dbId,
                                                    guid: guid,
                                                    layer: layer,
                                                    sourceFile: sourceFile,
                                                    name: pResult.name || 'ACPPPIPE'
                                                });
                                                if (layer) uniqueLayers.add(layer);
                                            }
                                        });

                                        if (selectedList.length > 0) {
                                            bimState.selectedElements = selectedList;

                                             // Capa válvulas/soportes: flujo simple (1 elemento = 1 ítem, sin auto-grupo)
                                            if (bimState.capa !== 'spool') {
                                                bimRenderCapaSelection(bimState.capa, selectedList, uniqueLayers);
                                                if (panel) panel.style.display = authObtener('bim') ? 'flex' : 'none';
                                                return;
                                            }

                                            // --- AUTOSELECCIÓN POR SPOOL EXISTENTE ---
                                            if (selectedList.length === 1 && bimState.mapeoSpools && !skipAuto) {
                                                const selectedGuid = selectedList[0].guid.toLowerCase();
                                                const spoolTag = bimState.mapeoSpools[selectedGuid];
                                                if (spoolTag) {
                                                    console.log(`[BIM] Elemento seleccionado pertenece al spool: ${spoolTag}. Autoseleccionando grupo...`);
                                                    const guidsDelSpool = Object.entries(bimState.mapeoSpools)
                                                        .filter(([g, s]) => s.toLowerCase() === spoolTag.toLowerCase())
                                                        .map(([g, s]) => g);

                                                    if (guidsDelSpool.length > 1) {
                                                        bimGuidsToDbIds(guidsDelSpool, (targetDbIds) => {
                                                            if (targetDbIds.length > 0) {
                                                                bimState.isAutoSelecting = true;
                                                                viewer.select(targetDbIds);
                                                                setTimeout(() => {
                                                                    bimState.isAutoSelecting = false;
                                                                }, 100);
                                                            }
                                                        });
                                                        return;
                                                    }
                                                }
                                            }
                                            // ----------------------------------------

                                            // Actualizar título de panel en UI
                                            const linkTitle = document.querySelector('#bim-link-panel h4');
                                            if (linkTitle) {
                                                linkTitle.innerHTML = `<i class="fas fa-link"></i> Vincular (${selectedList.length} selec.)`;
                                            }

                                            // Mostrar resumen del GUID
                                            document.getElementById('bim-link-guid').textContent = selectedList.length === 1
                                                ? selectedList[0].guid
                                                : `${selectedList.length} elementos seleccionados`;

                                            // Mostrar capas / líneas únicas
                                            document.getElementById('bim-link-layer').textContent = uniqueLayers.size > 0
                                                ? Array.from(uniqueLayers).join(', ')
                                                : 'N/A';

                                            // --- ACTUALIZAR UI DE VINCULACIÓN EXISTENTE ---
                                            const gruposPorSpool = {}; // tagLower -> { tag, count }
                                            if (bimState.mapeoSpools) {
                                                selectedList.forEach(el => {
                                                    const tag = bimState.mapeoSpools[el.guid.toLowerCase()];
                                                    if (tag) {
                                                        const k = tag.toLowerCase();
                                                        if (!gruposPorSpool[k]) gruposPorSpool[k] = { tag, count: 0 };
                                                        gruposPorSpool[k].count++;
                                                    }
                                                });
                                            }
                                            const spoolsDistintos = Object.values(gruposPorSpool);
                                            const commonSpool = spoolsDistintos.length === 1 ? spoolsDistintos[0].tag
                                                : (spoolsDistintos.length > 1 ? 'Múltiples Spools' : null);

                                            const statusContainer = document.getElementById('bim-link-status-container');
                                            const infoEl = document.getElementById('bim-link-spool-info');
                                            const linkSpoolInput = document.getElementById('bim-link-spool');

                                            if (spoolsDistintos.length > 0) {
                                                if (statusContainer) statusContainer.style.display = 'flex';
                                                if (infoEl) infoEl.innerHTML = bimRenderSpoolInfo(spoolsDistintos);
                                                if (linkSpoolInput) linkSpoolInput.value = commonSpool !== 'Múltiples Spools' ? commonSpool : '';

                                                if (commonSpool !== 'Múltiples Spools') {
                                                    // Cargar metadatos del spool para detalles e isométricos (PDF)
                                                    fetch(`/api/bim/spool/${encodeURIComponent(commonSpool)}`)
                                                        .then(r => r.json())
                                                        .then(spoolData => {
                                                            if (spoolData && spoolData.spool_id) {
                                                                bimRenderMeta(spoolData);
                                                            }
                                                        })
                                                        .catch(err => console.error('[BIM] Error cargando metadata del spool seleccionado:', err));
                                                } else {
                                                    // Varios spools: el panel de metadata muestra el desglose
                                                    bimSetMeta(bimRenderMultiSpoolMeta(spoolsDistintos));
                                                    const listEl = document.getElementById('bim-elements-list');
                                                    if (listEl) listEl.style.display = 'none';
                                                }
                                            } else {
                                                if (statusContainer) statusContainer.style.display = 'none';
                                                if (linkSpoolInput) linkSpoolInput.value = '';

                                                // Sin spool asignado: elementos libres para vincular
                                                const tieneClave = !!authObtener('bim');
                                                if (!tieneClave) {
                                                    bimSetMeta(`
                                                        <div class="bim-meta-placeholder">
                                                            <i class="fas fa-cube bim-meta-icon" style="color:#a78bfa;"></i>
                                                            <p>${selectedList.length} elemento(s) sin spool asignado (Modo Solo Lectura).</p>
                                                            <button onclick="authAsegurar('bim').then(ok => { if(ok) bimActualizarPermisosUI(); })" class="bim-scan-btn" style="margin-top:10px; background:rgba(99,102,241,0.2); border-color:rgba(99,102,241,0.4); color:var(--primary-light);">
                                                                <i class="fas fa-cube"></i> Editar BIM (Ingresar Clave)
                                                            </button>
                                                        </div>`);
                                                } else {
                                                    bimSetMeta(`
                                                        <div class="bim-meta-placeholder">
                                                            <i class="fas fa-cube bim-meta-icon"></i>
                                                            <p>${selectedList.length} elemento(s) sin spool asignado. Ingresa un código de Spool abajo para vincularlos.</p>
                                                        </div>`);
                                                }
                                                const listEl = document.getElementById('bim-elements-list');
                                                if (listEl) listEl.style.display = 'none';
                                            }
                                            // ---------------------------------------------
                                            
                                            const btn = document.getElementById('bim-link-btn');
                                            if (btn) {
                                                btn.innerHTML = `<i class="fas fa-save"></i> Guardar ${selectedList.length} elem.`;
                                                btn.disabled = false;
                                                btn.style.opacity = '1';
                                            }

                                            if (panel) panel.style.display = authObtener('bim') ? 'flex' : 'none';
                                            
                                            // Abrir la barra lateral si está colapsada en móvil para que el usuario la vea
                                            const sidebar = document.querySelector('.bim-sidebar');
                                            if (sidebar && window.innerWidth <= 1024 && !sidebar.classList.contains('open')) {
                                                bimToggleSidebar();
                                            }
                                        } else {
                                            bimState.selectedElements = [];
                                            if (panel) panel.style.display = 'none';
                                        }
                                    },
                                    (err) => {
                                        console.error('[BIM] Error al obtener propiedades en lote:', err);
                                    }
                                );
                            } else {
                                bimState.selectedElements = [];
                                if (panel) panel.style.display = 'none';
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
    if (bimState.capa === 'spool') bimLoadSpool(val);
    else bimLoadCapaItem(bimState.capa, val);
}

/**
 * Resuelve el texto que escribe el usuario a la LLAVE canónica del ítem
 * (ID_VALVULA / ID_Soporte). Acepta: la llave exacta, la etiqueta (_label),
 * o el ITEM amigable (soportes) / prefijo (válvulas).
 */
function bimResolveCapaId(capa, typed) {
    const index = bimState.capaIndex[capa] || {};
    const keyCol = capa === 'valvula' ? 'ID_VALVULA' : 'ID_Soporte';
    const t = String(typed || '').trim().toLowerCase();
    if (!t) return typed;
    if (index[t]) return index[t][keyCol];                                  // llave exacta
    let hit = Object.values(index).find(r => (r._label || '').toLowerCase() === t); // etiqueta completa
    if (hit) return hit[keyCol];
    if (capa === 'soporte') {                                                // ITEM amigable (148)
        hit = Object.values(index).find(r => String(r.ITEM || '').toLowerCase() === t);
        if (hit) return hit.ID_Soporte;
    } else {                                                                 // prefijo antes del "_"
        hit = Object.values(index).find(r => String(r[keyCol] || '').toLowerCase() === t.split('_')[0]);
        if (hit) return hit[keyCol];
    }
    return typed; // fallback: enviar tal cual
}

/** Busca una válvula/soporte por ID/ITEM/etiqueta y resalta sus elementos vinculados en el modelo. */
async function bimLoadCapaItem(capa, termino) {
    if (!bimState.initialized) return;
    const ui = BIM_CAPA_UI[capa];
    const id = bimResolveCapaId(capa, termino);

    bimSetMeta('<div class="bim-loading-meta"><div class="bim-spinner-sm"></div> Buscando elementos...</div>');
    try {
        const resp = await fetch(`/api/bim/${capa}/item/${encodeURIComponent(id)}`);
        const data = await resp.json();
        if (!data.guids || data.guids.length === 0) {
            bimSetMeta(`<div class="bim-meta-empty"><i class="fas fa-search"></i><p>La ${ui.label.toLowerCase()} <strong>${data.label || id}</strong> no tiene elementos 3D vinculados aún.</p></div>`);
            bimRenderCapaMeta(capa, id);
            return;
        }
        bimState.currentGuids = data.guids;
        bimGuidsToDbIds(data.guids, (dbIds) => {
            bimState.dbIds = dbIds;
            if (dbIds.length > 0) {
                bimHighlightElements(dbIds);
                if (window.innerWidth <= 1024) bimCloseSidebar();
            }
        });
        bimRenderCapaMeta(capa, id);
    } catch (err) {
        bimSetMeta(`<div class="bim-meta-empty"><i class="fas fa-exclamation-triangle"></i><p>Error: ${err.message}</p></div>`);
    }
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

        // Separar elementos reales de TROZOS (guid#pN, que no resuelven a dbId).
        // Para que el modelo entre en x-ray aunque el spool sea SOLO trozos,
        // aislamos el elemento ORIGINAL que hay detrás de cada trozo del spool.
        const guidsParaAislar = [];
        data.guids.forEach(g => {
            if (String(g).includes('#p')) {
                const mesh = divState.trozoMeshes[String(g).toLowerCase()];
                if (mesh?.userData?.guid) guidsParaAislar.push(mesh.userData.guid);
            } else {
                guidsParaAislar.push(g);
            }
        });

        bimGuidsToDbIds(guidsParaAislar, (dbIds) => {
            bimState.dbIds = dbIds;
            if (dbIds.length > 0) {
                bimHighlightElements(dbIds);   // isolate → x-ray del resto
                bimDivReocultarOriginales();   // isolate re-mostró los divididos → re-ocultar
                if (window.innerWidth <= 1024) bimCloseSidebar();
            }
        });

        // Trozos: los del spool buscado quedan sólidos; el resto en x-ray (como el modelo)
        bimDivGhostPorSpool(data.guids);

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
    
    // Solicitamos externalId y propiedades comunes que almacenan el GUID de Revit/AutoCAD
    bimState.viewer.model.getBulkProperties(
        null, // todos los objetos
        { propFilter: ['externalId', 'GUID', 'Element GUID', 'Revit GUID', 'PnPGuid', 'PnPGUID'] },
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
                        if (['guid', 'element guid', 'revit guid', 'pnpguid'].includes(name)) {
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

// =================================================================
// COLOREO POR ESTADO AL AISLAR DESDE EL ÁRBOL DE APS
// Cuando el usuario aísla una línea/nodo desde el panel "Modelo" del
// visor, los elementos visibles se tiñen según el estado de su spool.
// Las isolaciones PROPIAS (filtros, búsqueda, EN VIVO) no se tocan.
// =================================================================

/** Índice GUID(lower) → dbId, construido una sola vez (getBulkProperties es caro). */
function bimIndiceGuidDbId() {
    if (bimState._guidIndex) return Promise.resolve(bimState._guidIndex);
    if (bimState._guidIndexPromise) return bimState._guidIndexPromise;
    bimState._guidIndexPromise = new Promise((resolve) => {
        bimState.viewer.model.getBulkProperties(
            null,
            { propFilter: ['externalId', 'GUID', 'Element GUID', 'Revit GUID', 'PnPGuid', 'PnPGUID'] },
            (results) => {
                const idx = {};
                results.forEach(r => {
                    if (r.externalId) idx[String(r.externalId).toLowerCase()] = r.dbId;
                    (r.properties || []).forEach(p => {
                        const n = String(p.displayName || p.attributeName || '').toLowerCase();
                        if (['guid', 'element guid', 'revit guid', 'pnpguid'].includes(n)) {
                            const v = String(p.displayValue || '').trim().toLowerCase();
                            if (v) idx[v] = r.dbId;
                        }
                    });
                });
                bimState._guidIndex = idx;
                console.log(`[BIM IsoColor] Índice GUID→dbId listo: ${Object.keys(idx).length} entradas`);
                resolve(idx);
            },
            () => resolve({})
        );
    });
    return bimState._guidIndexPromise;
}

/** Registra el listener de aislamiento (llamado tras cargar el modelo). */
function bimIsoColorInit() {
    const viewer = bimState.viewer;
    if (!viewer) return;
    viewer.addEventListener(Autodesk.Viewing.ISOLATE_EVENT, (ev) => {
        clearTimeout(bimState._isoColorTimer);
        const nodos = ev.nodeIdArray || [];
        bimState._isoColorTimer = setTimeout(() => bimIsoColorAplicar(nodos), 150);
    });
}

/** Pinta los elementos visibles de la isolación según el estado de su spool. */
async function bimIsoColorAplicar(nodos) {
    const viewer = bimState.viewer;
    if (!viewer || !viewer.model) return;

    // showAll → limpiar nuestro coloreo (si el filtro propio está activo, él manda)
    if (!nodos.length) {
        if (bimState._isoColoreado) {
            bimState._isoColoreado = false;
            if (!bimState.filtroEstados.size) viewer.clearThemingColors(viewer.model);
        }
        return;
    }

    // Isolación PROPIA (filtro por estado, búsqueda de spool, EN VIVO) → ya viene coloreada
    if (bimState.filtroEstados.size || bimState.liveEstados) return;
    const propios = new Set(bimState.dbIds || []);
    if (propios.size && nodos.length === propios.size && nodos.every(id => propios.has(id))) return;

    const statuses = bimState.capa === 'spool' ? bimState.statusesCache : bimState.capaStatuses;
    if (!statuses) return;

    try {
        const idx = await bimIndiceGuidDbId();
        viewer.clearThemingColors(viewer.model);
        let pintados = 0;
        // JERARQUÍA: SIN ESTADO / PENDIENTE primero → los estados reales pintan
        // ENCIMA si un GUID viniera repetido en más de un grupo.
        const orden = Object.entries(statuses).sort(([a], [b]) => {
            const peso = (st) => st === 'SIN ESTADO' ? -2 : st === 'PENDIENTE' ? -1
                : Math.max(BIM_ORDEN_FLUJO.indexOf(st), 0);
            return peso(a) - peso(b);
        });
        for (const [st, guids] of orden) {
            const [r, g, b, a] = bimColorDeEstado(st);
            const col = new THREE.Vector4(r, g, b, Math.max(a, 0.8));
            (guids || []).forEach(gd => {
                if (gd.includes('#p')) return; // trozos: se pintan como overlay
                const dbId = idx[String(gd).toLowerCase()];
                if (dbId === undefined || !viewer.isNodeVisible(dbId)) return;
                viewer.setThemingColor(dbId, col, viewer.model, true);
                pintados++;
            });
        }
        bimState._isoColoreado = pintados > 0;
        if (typeof bimDivColorearTrozos === 'function') bimDivColorearTrozos();
        if (pintados) console.log(`[BIM IsoColor] ${pintados} elementos teñidos por estado`);
    } catch (e) {
        console.error('[BIM IsoColor] Error:', e);
    }
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
    bimLiveStop();
    if (!bimState.viewer) return;
    bimState.viewer.showAll();
    // Los originales divididos permanecen ocultos PARA SIEMPRE (los reemplaza su clon)
    if (typeof divState !== 'undefined') {
        bimDivReocultarOriginales();
        bimDivFiltrarTrozos(null); // sin filtro: todos los trozos visibles
    }
    bimState.viewer.clearThemingColors(bimState.viewer.model);
    bimState.dbIds  = [];
    bimState.currentGuids = [];
    bimState.viewer.fitToView();
    
    // Limpiar la selección de estados en los chips
    if (bimState.filtroEstados && bimState.filtroEstados.size) {
        bimState.filtroEstados.clear();
        bimRenderStatusChips();
    }

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

/** Colores premium para cada estado del Spool en el visualizador 3D (definidos como arrays para evitar errores antes de cargar el SDK) */
const BIM_STATUS_COLORS = {
    'MONTADO':         [0.06, 0.75, 0.35, 1], // Verde brillante
    'POSICIONADO':     [0.95, 0.45, 0.10, 1], // Naranja
    'POR MONTAR':      [0.95, 0.85, 0.10, 1], // Amarillo
    'EN PINT/REVEST.': [0.65, 0.30, 0.95, 1], // Morado
    'QAQC':            [0.10, 0.65, 0.95, 1], // Azul
    'EN FABRICACIÓN':  [0.30, 0.80, 0.95, 1], // Celeste
    'RETIRAR':         [0.95, 0.15, 0.15, 1], // Rojo
    'ELIMINADO':       [0.40, 0.40, 0.40, 0.5], // Gris translúcido
    // Intensidad 1: la 4ª componente de setThemingColor es cuánto TIÑE, no
    // transparencia. Con 0.3 el gris casi no se veía y parecía "sin pintar".
    'SIN ESTADO':      [0.50, 0.50, 0.50, 1], // Gris
    // Válvulas / soportes (estado binario)
    'PENDIENTE':       [0.55, 0.55, 0.55, 0.4]  // Gris (pendiente de montaje)
};

// =================================================================
// ESTADOS DINÁMICOS + COLORES EDITABLES + FILTRO MULTI-SELECCIÓN
// Los estados salen de los DATOS: si los usuarios agregan un estado
// nuevo en AppSheet, aparece solo, con color auto-asignado y editable.
// =================================================================
const BIM_ORDEN_FLUJO = ['EN FABRICACIÓN', 'QAQC', 'EN PINT/REVEST.', 'RETIRAR',
    'POR MONTAR', 'POSICIONADO', 'MONTADO', 'ELIMINADO', 'PENDIENTE', 'SIN ESTADO'];

function bimHexARgb(hex) {
    const h = String(hex).replace('#', '');
    return [parseInt(h.substr(0, 2), 16) / 255, parseInt(h.substr(2, 2), 16) / 255, parseInt(h.substr(4, 2), 16) / 255, 1];
}
function bimRgbAHex(arr) {
    return '#' + arr.slice(0, 3).map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

/** Color automático y estable para estados nuevos (hash → tono HSL). */
function bimColorAuto(st) {
    let h = 0;
    for (let i = 0; i < st.length; i++) h = (h * 31 + st.charCodeAt(i)) >>> 0;
    const hue = h % 360, s = 0.72, l = 0.55;
    const k = n => (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4), 1];
}

/** Color efectivo de un estado: override guardado > paleta base > auto. */
function bimColorDeEstado(st) {
    const key = String(st || '').toUpperCase();
    if (bimState.coloresEstados && bimState.coloresEstados[key]) return bimHexARgb(bimState.coloresEstados[key]);
    if (BIM_STATUS_COLORS[key]) return BIM_STATUS_COLORS[key];
    return bimColorAuto(key);
}

async function bimCargarColoresEstados() {
    try { bimState.coloresEstados = await (await fetch('/api/bim/estado-colores')).json(); }
    catch (e) { bimState.coloresEstados = {}; }
}

/** Unidad de la capa activa (para etiquetas de conteo). */
function bimUnidadCapa() {
    return bimState.capa === 'spool' ? 'spools' : (bimState.capa === 'valvula' ? 'válvulas' : 'soportes');
}

/**
 * Cuenta ÍTEMS únicos (spools/válvulas/soportes) en una lista de GUIDs,
 * resolviendo GUID→TAG con el mapeo de la capa activa. Los trozos 'guid#pN'
 * cuentan por su ítem asignado. Si nada está vinculado, cae a nº de elementos.
 */
function bimContarSpools(guids) {
    const mapeo = bimState.capa === 'spool' ? (bimState.mapeoSpools || {}) : (bimState.capaMapeo[bimState.capa] || {});
    const tags = new Set();
    let sinTag = 0;
    (guids || []).forEach(g => {
        const t = mapeo[g.toLowerCase()];
        if (t) tags.add(String(t).toLowerCase()); else sinTag++;
    });
    return tags.size || sinTag;
}

/** Dibuja los chips de estado (dinámicos) según los datos de la capa activa. */
function bimRenderStatusChips() {
    const cont = document.getElementById('bim-status-chips');
    if (!cont) return;
    const statuses = bimState.capa === 'spool' ? bimState.statusesCache : bimState.capaStatuses;
    if (!statuses) { cont.innerHTML = '<span style="font-size:0.75rem;opacity:0.5;">Cargando estados…</span>'; return; }

    // Orden forzado: flujo conocido → estados nuevos (alfabético) → SIN ESTADO al final
    const rango = (st) => {
        if (st === 'SIN ESTADO') return 9999;
        const i = BIM_ORDEN_FLUJO.indexOf(st);
        return i !== -1 ? i : 500;
    };

    // Unificar keys de statuses y estadoConteos para mostrar todos los estados conocidos
    const keysStatuses = Object.keys(statuses);
    const keysConteos  = bimState.capa === 'spool' && bimState.estadoConteos ? Object.keys(bimState.estadoConteos) : [];
    const allKeys = [...new Set([...keysStatuses, ...keysConteos])];
    const nombres = allKeys.sort((a, b) => {
        const ra = rango(a), rb = rango(b);
        return ra !== rb ? ra - rb : a.localeCompare(b);
    });

    const unidad = bimUnidadCapa();

    cont.innerHTML = nombres.map(st => {
        const guids = statuses[st] || [];
        const sel   = bimState.filtroEstados.has(st);
        const hex   = bimRgbAHex(bimColorDeEstado(st));
        const esc   = st.replace(/'/g, "\\'");

        // Número a mostrar: total real (sección Spools) si está disponible; si no, GUIDs del modelo
        let nTotal, nSinAsociar;
        if (bimState.capa === 'spool' && bimState.estadoConteos && bimState.estadoConteos[st]) {
            nTotal      = bimState.estadoConteos[st].total;
            nSinAsociar = bimState.estadoConteos[st].sin_asociar || 0;
        } else {
            nTotal      = bimContarSpools(guids);
            nSinAsociar = 0;
        }

        const badgeHtml = nSinAsociar > 0
            ? `<span class="bim-chip-sin-asociar" title="${nSinAsociar} sin modelo 3D">-${nSinAsociar}</span>`
            : '';

        const tieneClave = !!authObtener('bim');
        const colorElHtml = tieneClave
            ? `<input type="color" value="${hex}" onclick="event.stopPropagation()" onchange="bimGuardarColorEstado('${esc}', this.value)" title="Editar color de ${st}">`
            : `<span class="bim-chip-dot" style="background:${hex}; width:12px; height:12px; border-radius:50%; display:inline-block; flex-shrink:0; margin-right:4px;" title="Color de ${st}"></span>`;

        return `<div class="bim-chip ${sel ? 'sel' : ''}" onclick="bimToggleEstado('${esc}')" title="${nTotal} ${unidad} (${nSinAsociar > 0 ? nSinAsociar + ' sin geometría 3D' : 'todos con modelo'})">
            ${colorElHtml}
            <span class="bim-chip-nombre">${st}</span>
            <span class="bim-chip-n">${nTotal}</span>
            ${badgeHtml}
        </div>`;
    }).join('');
}

function bimToggleEstado(st) {
    if (bimState.filtroEstados.has(st)) bimState.filtroEstados.delete(st);
    else bimState.filtroEstados.add(st);
    bimRenderStatusChips();
    bimAplicarFiltroEstados();
}

function bimLimpiarFiltroEstados() {
    bimState.filtroEstados.clear();
    bimRenderStatusChips();
    bimResetView();
}

/** Edita el color de un estado (persistido; requiere clave BIM). */
async function bimGuardarColorEstado(st, hex) {
    const ok = await authAsegurar('bim');
    if (!ok) { bimRenderStatusChips(); return; }
    try {
        const r = await fetch('/api/bim/estado-colores', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bim') },
            body: JSON.stringify({ estado: st, color: hex })
        });
        const d = await r.json();
        if (d.success) {
            bimState.coloresEstados = d.colores || {};
            bimRenderStatusChips();
            if (bimState.filtroEstados.size) bimAplicarFiltroEstados();
            if (typeof bimDivColorearTrozos === 'function') bimDivColorearTrozos();
        } else if (r.status === 401) {
            authOlvidar('bim');
            alert('🔒 Clave BIM incorrecta o expirada.');
        }
    } catch (e) { console.error('[BIM] Error guardando color:', e); }
}

/** Aplica el filtro MULTI-estado: unión de elementos, cada estado con su color. */
async function bimAplicarFiltroEstados() {
    bimLiveStop();
    const seleccion = [...bimState.filtroEstados];
    if (!seleccion.length) { bimResetView(); return; }
    if (!bimState.initialized) return;

    bimSetMeta('<div class="bim-loading-meta"><div class="bim-spinner-sm"></div> Aplicando filtro...</div>');
    try {
        let statuses;
        if (bimState.capa === 'spool') {
            statuses = await (await fetch('/api/bim/statuses')).json();
            bimState.statusesCache = statuses;
        } else {
            statuses = await (await fetch(`/api/bim/${bimState.capa}/statuses`)).json();
            bimState.capaStatuses = statuses;
        }
        bimRenderStatusChips();

        const viewer = bimState.viewer;
        viewer.clearThemingColors(viewer.model);

        let acumulados = [];
        let pendientes = seleccion.length;
        const finalizar = () => {
            // Excluir originales divididos del aislamiento (su clon los reemplaza)
            bimState.dbIds = [...new Set(acumulados)].filter(id => !divState.ocultos.includes(id));
            if (bimState.dbIds.length) {
                viewer.isolate(bimState.dbIds);
                viewer.fitToView(bimState.dbIds);
            } else {
                viewer.isolate([]);
            }
            bimDivReocultarOriginales();     // isolate re-muestra los hidden → volver a ocultar
            bimDivColorearTrozos();
            bimDivFiltrarTrozos(new Set(seleccion)); // trozos participan del filtro
            const actionsEl = document.getElementById('bim-actions');
            if (actionsEl) actionsEl.style.display = 'flex';
            if (window.innerWidth <= 1024) bimCloseSidebar();

            const unidad = bimUnidadCapa();
            const resumen = seleccion.map(st =>
                `<span style="display:inline-flex;align-items:center;gap:5px;margin:2px 8px 2px 0;font-size:0.78rem;">
                    <span style="width:10px;height:10px;border-radius:3px;background:${bimRgbAHex(bimColorDeEstado(st))}"></span>
                    ${st}</span>`).join('');
            bimSetMeta(`
                <div class="bim-meta-header" style="background: rgba(99,102,241,0.15); border-color: rgba(99,102,241,0.3);">
                    <i class="fas fa-filter"></i><span>Filtro activo: ${seleccion.length} estado(s)</span>
                </div>
                <div style="padding:8px 2px; display:flex; flex-wrap:wrap; gap:4px;">${resumen}</div>
                <p style="font-size:0.72rem;opacity:0.7;padding:0 2px;"><i class="fas fa-satellite-dish"></i> EN VIVO: los nuevos reportes se suman solos.</p>`);
            bimLiveStart(seleccion, statuses);
        };

        seleccion.forEach(st => {
            const gs = (statuses[st] || []).filter(g => !g.includes('#p'));
            if (!gs.length) { if (--pendientes === 0) finalizar(); return; }
            bimGuidsToDbIds(gs, (ids) => {
                acumulados = acumulados.concat(ids);
                const [r, g, b, a] = bimColorDeEstado(st);
                const col = new THREE.Vector4(r, g, b, a);
                ids.forEach(id => viewer.setThemingColor(id, col, viewer.model, true));
                if (--pendientes === 0) finalizar();
            });
        });
    } catch (err) {
        console.error('[BIM Filtro Estados]', err);
        bimSetMeta(`<div class="bim-meta-empty"><i class="fas fa-exclamation-triangle"></i><p>Error: ${err.message}</p></div>`);
    }
}

/** Filtra e aisla los elementos del modelo 3D según el estado de pre-fabricación seleccionado */
async function bimFilterByStatus() {
    const select = document.getElementById('bim-status-filter');
    const status = select ? select.value : '';

    bimLiveStop(); // reiniciar cualquier seguimiento en vivo anterior

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

    bimSetMeta(`<div class="bim-loading-meta"><div class="bim-spinner-sm"></div> Buscando elementos en estado ${status}...</div>`);

    try {
        // Fuente de estados según capa (spools cachean; válvulas/soportes se consultan directo)
        let statuses;
        if (bimState.capa === 'spool') {
            statuses = bimState.statusesCache;
            if (!statuses) {
                const resp = await fetch('/api/bim/statuses');
                if (!resp.ok) throw new Error(`Error ${resp.status}`);
                statuses = await resp.json();
                bimState.statusesCache = statuses;
            }
        } else {
            const resp = await fetch(`/api/bim/${bimState.capa}/statuses`);
            if (!resp.ok) throw new Error(`Error ${resp.status}`);
            statuses = await resp.json();
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

                // Colorear con el color correspondiente (instanciado dinámicamente)
                const rawColor = BIM_STATUS_COLORS[status] || [0.18, 0.84, 0.44, 1];
                const color = new THREE.Vector4(rawColor[0], rawColor[1], rawColor[2], rawColor[3]);
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
                        <p style="font-size:0.72rem;opacity:0.7;margin-top:6px;"><i class="fas fa-satellite-dish"></i> Modo EN VIVO: los nuevos reportes aparecerán automáticamente.</p>
                    </div>
                `);

                // Activar seguimiento EN VIVO: los reportes nuevos se suman solos
                bimLiveStart(status, guids);
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

// =================================================================
// MODO EN VIVO — el filtro por estado se actualiza solo:
// los spools reportados (por la app de terreno o por el bot, voz o texto)
// aparecen en el modelo con pulso de destaque, aviso y contador.
// =================================================================
const BIM_LIVE_INTERVALO_MS = 10000; // 10s (el backend consulta AppSheet fresco)

/** Arranca el seguimiento EN VIVO de uno o varios estados. */
function bimLiveStart(estados, statuses) {
    bimLiveStop();
    bimState.liveEstados = Array.isArray(estados) ? [...estados] : [estados];
    bimState.liveSets = {};
    bimState.liveEstados.forEach(st => {
        bimState.liveSets[st] = new Set((((statuses || {})[st]) || []).map(g => g.toLowerCase()));
    });
    bimLiveChipUpdate();
    bimState.liveTimer = setInterval(bimLiveTick, BIM_LIVE_INTERVALO_MS);
}

function bimLiveStop() {
    if (bimState.liveTimer) clearInterval(bimState.liveTimer);
    bimState.liveTimer = null;
    bimState.liveStatus = null;
    bimState.liveGuids = null;
    bimState.liveEstados = null;
    bimState.liveSets = null;
    const chip = document.getElementById('bim-live-chip');
    if (chip) chip.remove();
}

async function bimLiveTick() {
    // v2 multi-estado: los estados y colores son dinámicos
    const seccion = document.getElementById('bim-section');
    if (!seccion || seccion.style.display === 'none' || !bimState.liveEstados || !bimState.liveEstados.length) return;

    try {
        const endpoint = bimState.capa === 'spool' ? '/api/bim/statuses' : `/api/bim/${bimState.capa}/statuses`;
        const resp = await fetch(endpoint);
        if (!resp.ok) return;
        const statuses = await resp.json();
        if (bimState.capa === 'spool') bimState.statusesCache = statuses;
        else bimState.capaStatuses = statuses;

        const mapeo = bimState.capa === 'spool' ? (bimState.mapeoSpools || {}) : (bimState.capaMapeo[bimState.capa] || {});

        for (const st of bimState.liveEstados) {
            const setSt = bimState.liveSets[st] || (bimState.liveSets[st] = new Set());
            const actuales = (statuses[st] || []).map(g => g.toLowerCase());
            const nuevos = actuales.filter(g => !setSt.has(g));
            if (!nuevos.length) continue;
            nuevos.forEach(g => setSt.add(g));
            console.log(`[BIM Live] 🎉 ${nuevos.length} nuevo(s) en ${st}`);

            const [cr, cg, cb] = bimColorDeEstado(st);

            // Trozos de tramos divididos: recolorear su mesh con pulso
            const trozosNuevos = nuevos.filter(g => g.includes('#p'));
            trozosNuevos.forEach(g => {
                const mesh = divState.trozoMeshes[g];
                if (!mesh) return;
                mesh.visible = true; // su estado acaba de entrar al filtro seguido
                let p = 0;
                const pulsarT = () => {
                    if (p % 2 === 0) mesh.material.color.setRGB(1, 1, 1);
                    else mesh.material.color.setRGB(cr, cg, cb);
                    bimState.viewer.impl.invalidate(false, false, true);
                    p++;
                    if (p <= 7) setTimeout(pulsarT, 450);
                    else { mesh.material.color.setRGB(cr, cg, cb); bimState.viewer.impl.invalidate(false, false, true); }
                };
                pulsarT();
            });

            // Elementos del modelo: sumar al aislamiento + pulso + toast + foco B
            const nuevosModelo = nuevos.filter(g => !g.includes('#p'));
            if (nuevosModelo.length) {
                bimGuidsToDbIds(nuevosModelo, (dbIdsNuevos) => {
                    const viewer = bimState.viewer;
                    if (!viewer || !dbIdsNuevos.length) { bimLiveChipUpdate(); return; }
                    bimState.dbIds = [...new Set([...(bimState.dbIds || []), ...dbIdsNuevos])].filter(id => !divState.ocultos.includes(id));
                    viewer.isolate(bimState.dbIds);
                    bimDivReocultarOriginales();

                    bimState.liveFocusPend = [...new Set([...(bimState.liveFocusPend || []), ...dbIdsNuevos])];
                    clearTimeout(bimState.liveFocusTimer);
                    bimState.liveFocusTimer = setTimeout(() => {
                        if (bimState.viewer && bimState.liveFocusPend?.length) bimState.viewer.fitToView(bimState.liveFocusPend);
                        bimState.liveFocusPend = [];
                    }, 1200);

                    const colorFinal = new THREE.Vector4(cr, cg, cb, 1);
                    const colorFlash = new THREE.Vector4(1, 1, 1, 1);
                    let pulso = 0;
                    const pulsar = () => {
                        const c = (pulso % 2 === 0) ? colorFlash : colorFinal;
                        dbIdsNuevos.forEach(id => viewer.setThemingColor(id, c, viewer.model, true));
                        pulso++;
                        if (pulso <= 7) setTimeout(pulsar, 450);
                        else dbIdsNuevos.forEach(id => viewer.setThemingColor(id, colorFinal, viewer.model, true));
                    };
                    pulsar();
                    bimLiveChipUpdate();
                });
            }

            const tags = [...new Set(nuevos.map(g => mapeo[g]).filter(Boolean))];
            const etiqueta = tags.length ? tags.join(', ') : `${nuevos.length} elemento(s)`;
            bimLiveToast(`🎉 ${etiqueta} → ${st}`, []);
            bimBeep();
        }
        bimLiveChipUpdate();
    } catch (e) {
        console.error('[BIM Live] Error en tick:', e.message);
    }
    return; // (código legado de un solo estado, inalcanzable)
}

async function bimLiveTickLegacy() {
    const seccion = document.getElementById('bim-section');
    if (!seccion || seccion.style.display === 'none' || !bimState.liveStatus) return;

    try {
        const endpoint = bimState.capa === 'spool' ? '/api/bim/statuses' : `/api/bim/${bimState.capa}/statuses`;
        const resp = await fetch(endpoint);
        if (!resp.ok) return;
        const statuses = await resp.json();
        if (bimState.capa === 'spool') bimState.statusesCache = statuses;

        const actuales = (statuses[bimState.liveStatus] || []).map(g => g.toLowerCase());
        const nuevos = actuales.filter(g => !bimState.liveGuids.has(g));
        if (!nuevos.length) return;

        nuevos.forEach(g => bimState.liveGuids.add(g));
        console.log(`[BIM Live] 🎉 ${nuevos.length} elemento(s) nuevo(s) en ${bimState.liveStatus}`);

        // Trozos de tramos divididos (guid#pN): no existen en el modelo APS,
        // se recolorean con pulso directamente sobre sus meshes overlay.
        const trozosNuevos = nuevos.filter(g => g.includes('#p'));
        if (trozosNuevos.length && typeof divState !== 'undefined') {
            const raw = BIM_STATUS_COLORS[bimState.liveStatus] || [0.06, 0.75, 0.35, 1];
            trozosNuevos.forEach(g => {
                const mesh = divState.trozoMeshes[g];
                if (!mesh) return;
                mesh.visible = true; // su estado acaba de entrar al filtro seguido
                let p = 0;
                const pulsarT = () => {
                    if (p % 2 === 0) mesh.material.color.setRGB(1, 1, 1);
                    else mesh.material.color.setRGB(raw[0], raw[1], raw[2]);
                    bimState.viewer.impl.invalidate(false, false, true);
                    p++;
                    if (p <= 7) setTimeout(pulsarT, 450);
                    else { mesh.material.color.setRGB(raw[0], raw[1], raw[2]); bimState.viewer.impl.invalidate(false, false, true); }
                };
                pulsarT();
            });
            const mapeoT = bimState.mapeoSpools || {};
            const tagsT = [...new Set(trozosNuevos.map(g => mapeoT[g]).filter(Boolean))];
            if (tagsT.length) { bimLiveToast(`🎉 Spool ${tagsT.join(', ')} (trozo) → ${bimState.liveStatus}`, []); bimBeep(); }
            bimLiveChipUpdate();
        }

        bimGuidsToDbIds(nuevos, (dbIdsNuevos) => {
            const viewer = bimState.viewer;
            if (!viewer || !dbIdsNuevos.length) { bimLiveChipUpdate(); return; }

            // Sumar a lo aislado
            bimState.dbIds = [...new Set([...(bimState.dbIds || []), ...dbIdsNuevos])];
            viewer.isolate(bimState.dbIds);

            // Foco suave (opción B): UN solo encuadre que abarca todo lo nuevo de la
            // tanda, con anti-rebote de 1.2s por si llegan varios reportes seguidos.
            bimState.liveFocusPend = [...new Set([...(bimState.liveFocusPend || []), ...dbIdsNuevos])];
            clearTimeout(bimState.liveFocusTimer);
            bimState.liveFocusTimer = setTimeout(() => {
                if (bimState.viewer && bimState.liveFocusPend && bimState.liveFocusPend.length) {
                    bimState.viewer.fitToView(bimState.liveFocusPend);
                }
                bimState.liveFocusPend = [];
            }, 1200);

            // Pulso de destaque: alterna blanco brillante ↔ color del estado
            const raw = BIM_STATUS_COLORS[bimState.liveStatus] || [0.06, 0.75, 0.35, 1];
            const colorFinal = new THREE.Vector4(raw[0], raw[1], raw[2], raw[3]);
            const colorFlash = new THREE.Vector4(1, 1, 1, 1);
            let pulso = 0;
            const pulsar = () => {
                const c = (pulso % 2 === 0) ? colorFlash : colorFinal;
                dbIdsNuevos.forEach(id => viewer.setThemingColor(id, c, viewer.model, true));
                pulso++;
                if (pulso <= 7) setTimeout(pulsar, 450);
                else dbIdsNuevos.forEach(id => viewer.setThemingColor(id, colorFinal, viewer.model, true));
            };
            pulsar();

            // Aviso con los tags de los spools nuevos (clic → volar hacia ellos)
            const mapeo = bimState.capa === 'spool' ? (bimState.mapeoSpools || {}) : (bimState.capaMapeo[bimState.capa] || {});
            const tags = [...new Set(nuevos.map(g => mapeo[g]).filter(Boolean))];
            const etiqueta = tags.length ? tags.join(', ') : `${dbIdsNuevos.length} elemento(s)`;
            bimLiveToast(`🎉 ${bimState.capa === 'spool' ? 'Spool' : BIM_CAPA_UI[bimState.capa].label} ${etiqueta} → ${bimState.liveStatus}`, dbIdsNuevos);
            bimBeep();
            bimLiveChipUpdate();
        });
    } catch (e) {
        console.error('[BIM Live] Error en tick:', e.message);
    }
}

/** Chip flotante "EN VIVO · ..." sobre el visor (multi-estado). */
function bimLiveChipUpdate() {
    const wrapper = document.querySelector('.bim-viewer-wrapper');
    if (!wrapper || !bimState.liveEstados || !bimState.liveEstados.length) return;
    let chip = document.getElementById('bim-live-chip');
    if (!chip) {
        chip = document.createElement('div');
        chip.id = 'bim-live-chip';
        chip.className = 'bim-live-chip';
        wrapper.appendChild(chip);
    }
    // Contar SPOOLS únicos (no elementos BIM: un spool tiene varias piezas 3D)
    const mapeo = bimState.capa === 'spool' ? (bimState.mapeoSpools || {}) : (bimState.capaMapeo[bimState.capa] || {});
    const tags = new Set();
    let sinVinculo = 0;
    Object.values(bimState.liveSets || {}).forEach(set => {
        set.forEach(g => {
            const t = mapeo[g];
            if (t) tags.add(String(t).toLowerCase());
            else sinVinculo++;
        });
    });
    const unidad = bimState.capa === 'spool' ? 'spools' : (bimState.capa === 'valvula' ? 'válvulas' : 'soportes');
    const total = tags.size || 0;
    const etiqueta = bimState.liveEstados.length === 1
        ? bimState.liveEstados[0]
        : `${bimState.liveEstados.length} estados`;
    chip.innerHTML = `<span class="bim-live-dot"></span> EN VIVO · ${etiqueta}: <strong>${total}</strong> ${unidad}` +
        (total === 0 && sinVinculo ? ` <span style="opacity:0.6;font-size:0.75rem;">(${sinVinculo} elem.)</span>` : '');
}

/** Toast flotante; clic = volar a los elementos nuevos. */
function bimLiveToast(texto, dbIds) {
    const wrapper = document.querySelector('.bim-viewer-wrapper');
    if (!wrapper) return;
    let cont = document.getElementById('bim-live-toasts');
    if (!cont) {
        cont = document.createElement('div');
        cont.id = 'bim-live-toasts';
        cont.className = 'bim-live-toasts';
        wrapper.appendChild(cont);
    }
    const t = document.createElement('div');
    t.className = 'bim-live-toast';
    t.textContent = texto;
    t.title = 'Clic para acercar la cámara';
    t.onclick = () => { if (bimState.viewer && dbIds?.length) bimState.viewer.fitToView(dbIds); };
    cont.appendChild(t);
    setTimeout(() => { t.classList.add('saliendo'); setTimeout(() => t.remove(), 500); }, 8000);
}

/** Bip corto de notificación (WebAudio; silencioso si el navegador lo bloquea). */
function bimBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [880, 1320].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.value = freq;
            osc.type = 'sine';
            gain.gain.setValueAtTime(0.12, ctx.currentTime + i * 0.14);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.14 + 0.13);
            osc.connect(gain).connect(ctx.destination);
            osc.start(ctx.currentTime + i * 0.14);
            osc.stop(ctx.currentTime + i * 0.14 + 0.15);
        });
    } catch (e) { /* sin audio, sin drama */ }
}

// =================================================================
// HERRAMIENTA "DIVIDIR TRAMO DE CAÑERÍA" (toolbar APS)
// División VIRTUAL: los cortes son fracciones [0..1] sobre el eje dominante
// del elemento (bbox). No se toca el modelo — los cortes se persisten en
// el servidor y se dibujan como discos overlay sobre el tubo.
// =================================================================
const DIV_OVERLAY = 'andinaDivisiones';
const DIV_COLORES = [0x60a5fa, 0x34d399, 0xfbbf24, 0xa78bfa, 0xf87171, 0x38bdf8]; // trozos alternados
const divState = {
    activo: false,          // modo corte encendido
    dbId: null,             // elemento en edición
    guid: null,
    eje: null,              // { p0:Vector3, dir:Vector3 (unit), len, radio } — eje REAL (PCA)
    cortes: [],             // fracciones internas de la sesión
    ext0: 0, ext1: 1,       // extremos (alargar/acortar el clon más allá del original)
    piezas: [],             // meshes overlay del clon en edición
    guardadas: {},          // { guidLower: [[a,b],...] } persistidas
    piezasGuardadas: [],    // meshes de divisiones guardadas
    ocultos: [],            // dbIds de originales ocultos (para re-ocultar tras showAll)
    _down: null
};

/** Normaliza el formato guardado: [0.42] (cortes viejos) o [[a,b],...] (partes). */
function bimDivNormalizarPartes(raw) {
    if (!Array.isArray(raw) || !raw.length) return null;
    if (Array.isArray(raw[0])) return raw;
    const bordes = [0, ...raw, 1];
    return bordes.slice(0, -1).map((a, i) => [a, bordes[i + 1]]);
}

/** Partes actuales de la sesión de edición (extremos + cortes internos). */
function bimDivPartesSesion() {
    const bordes = [divState.ext0, ...divState.cortes.filter(c => c > divState.ext0 && c < divState.ext1), divState.ext1];
    return bordes.slice(0, -1).map((a, i) => [a, bordes[i + 1]]);
}

/** Actualiza los botones de la toolbar de APS según los permisos del usuario (CLAVE_BIM). */
function bimActualizarToolbarPermisos() {
    const viewer = bimState.viewer;
    if (!viewer || !viewer.toolbar) return;

    let grupo = viewer.toolbar.getControl('andina-tools');
    if (!grupo) {
        grupo = new Autodesk.Viewing.UI.ControlGroup('andina-tools');
        viewer.toolbar.addControl(grupo);
    }

    const tieneClave = !!authObtener('bim');

    if (!tieneClave) {
        // Usuario NO autenticado: remover herramientas de corte e IFC export
        if (grupo.getControl('btn-dividir-tramo')) {
            grupo.removeControl('btn-dividir-tramo');
        }
        if (grupo.getControl('btn-exportar-ifc')) {
            grupo.removeControl('btn-exportar-ifc');
        }
        // Mostrar botón de desbolqueo "Editar BIM" (cubo)
        if (!grupo.getControl('btn-editar-bim')) {
            const btnUnlock = new Autodesk.Viewing.UI.Button('btn-editar-bim');
            btnUnlock.setToolTip('Editar BIM (Ingresar Clave)');
            btnUnlock.icon.innerHTML = '<i class="fas fa-cube" style="font-size:16px;line-height:24px;color:#a78bfa;"></i>';
            btnUnlock.onClick = async () => {
                const ok = await authAsegurar('bim');
                if (ok) {
                    bimActualizarPermisosUI();
                }
            };
            grupo.addControl(btnUnlock);
        }
    } else {
        // Usuario AUTENTICADO con clave BIM: remover botón de desbloqueo
        if (grupo.getControl('btn-editar-bim')) {
            grupo.removeControl('btn-editar-bim');
        }
        // Agregar botón Dividir tramo de cañería si no existe
        if (!grupo.getControl('btn-dividir-tramo')) {
            const btn = new Autodesk.Viewing.UI.Button('btn-dividir-tramo');
            btn.setToolTip('Dividir tramo de cañería');
            btn.icon.innerHTML = '<i class="fas fa-scissors" style="font-size:16px;line-height:24px;"></i>';
            btn.onClick = () => bimDividirToggle();
            divState._btn = btn;
            grupo.addControl(btn);
        }
        // Agregar botón Exportar IFC si no existe
        if (typeof bimIfcInit === 'function') {
            bimIfcInit(grupo);
        }
    }
}

/** Refresca los elementos de UI según el permiso de edición (toolbar, sidebar link-panel, status chips). */
function bimActualizarPermisosUI() {
    bimActualizarToolbarPermisos();
    bimRenderStatusChips();

    const tieneClave = !!authObtener('bim');
    const panel = document.getElementById('bim-link-panel');
    if (panel) {
        if (!tieneClave) {
            panel.style.display = 'none';
        } else if (bimState.selectedElements && bimState.selectedElements.length > 0) {
            panel.style.display = 'flex';
        }
    }
}

/** Crea las herramientas en la toolbar de APS según permisos (junto a las herramientas nativas). */
function bimDividirInit() {
    const viewer = bimState.viewer;
    if (!viewer) return;
    const crear = () => {
        bimActualizarToolbarPermisos();
    };
    if (viewer.toolbar) crear();
    else viewer.addEventListener(Autodesk.Viewing.TOOLBAR_CREATED_EVENT, crear, { once: true });

    // Dibujar divisiones ya guardadas
    try { viewer.impl.createOverlayScene(DIV_OVERLAY); } catch (e) { /* ya existe */ }
    bimDividirCargarGuardadas();

    // Selección de TROZOS (los overlays no son seleccionables por APS → raycast propio).
    // Siempre activo salvo en modo dividir (ahí los clics cortan).
    viewer.canvas.addEventListener('pointerdown', (ev) => { divState._downSel = { x: ev.clientX, y: ev.clientY }; }, true);
    viewer.canvas.addEventListener('pointerup', bimTrozoPointerUp, true);
}

/** Detecta clic sobre un trozo persistido y abre su panel de asignación. */
/**
 * Trozo bajo el cursor por distancia RAYO↔EJE del segmento (tolerante, no exige
 * pegarle exacto al cilindro delgado). Devuelve { mesh, distCam } del más cercano.
 */
function bimTrozoBajoRayo(ev) {
    const viewer = bimState.viewer;
    const rect = viewer.canvas.getBoundingClientRect();
    const ray = viewer.impl.viewportToRay(viewer.impl.clientToViewport(ev.clientX - rect.left, ev.clientY - rect.top));
    if (!ray) return null;
    const o = ray.origin, d1 = ray.direction.clone().normalize();
    let best = null, bestS = Infinity;
    for (const mesh of Object.values(divState.trozoMeshes)) {
        if (mesh.visible === false) continue;
        const eje = mesh.userData.eje;
        if (!eje) continue;
        const d2 = eje.dir;
        const r = new THREE.Vector3().subVectors(o, eje.p0);
        const a = d1.dot(d1), b = d1.dot(d2), c = d2.dot(d2);
        const dd = d1.dot(r), e = d2.dot(r);
        const den = a * c - b * b;
        if (Math.abs(den) < 1e-9) continue;      // rayo paralelo al eje
        const s = (b * e - c * dd) / den;         // parámetro sobre el rayo (distancia a cámara)
        const u = (a * e - b * dd) / den;         // parámetro sobre el eje (unidades mundo)
        if (s < 0) continue;                       // detrás de la cámara
        const frac = u / eje.len;
        if (frac < mesh.userData.a - 0.03 || frac > mesh.userData.b + 0.03) continue; // fuera del segmento
        const pRay = o.clone().add(d1.clone().multiplyScalar(s));
        const pAxis = eje.p0.clone().add(d2.clone().multiplyScalar(u));
        if (pRay.distanceTo(pAxis) > eje.radio * 2.4) continue; // demasiado lejos del tubo
        if (s < bestS) { bestS = s; best = mesh; }
    }
    return best ? { mesh: best, distCam: bestS } : null;
}

function bimTrozoPointerUp(ev) {
    if (divState.activo || !divState._downSel) return;
    const dx = Math.abs(ev.clientX - divState._downSel.x);
    const dy = Math.abs(ev.clientY - divState._downSel.y);
    divState._downSel = null;
    if (dx > 6 || dy > 6) return; // drag de navegación
    if (!Object.keys(divState.trozoMeshes).length) return;

    const viewer = bimState.viewer;
    try {
        const hit = bimTrozoBajoRayo(ev);
        if (!hit) return; // ningún trozo bajo el cursor → clic normal de APS

        // ¿Hay un elemento del modelo CLARAMENTE delante del trozo? → dejar pasar.
        const rect = viewer.canvas.getBoundingClientRect();
        const ray = viewer.impl.viewportToRay(viewer.impl.clientToViewport(ev.clientX - rect.left, ev.clientY - rect.top));
        const hitAPS = viewer.impl.hitTest(ev.clientX - rect.left, ev.clientY - rect.top, true);
        if (hitAPS && hitAPS.intersectPoint && ray) {
            const dAPS = ray.origin.distanceTo(hitAPS.intersectPoint);
            if (dAPS < hit.distCam - eje_margen(hit)) return; // algo real tapa el trozo
        }

        ev.stopPropagation(); ev.preventDefault();
        divState._consume = true;
        viewer.select([]);
        bimTrozoSeleccionar(hit.mesh);
    } catch (e) { console.error('[Trozo] Error en selección:', e); }
}

// Margen de tolerancia (radio del tubo) para que el trozo gane sobre elementos casi coincidentes.
function eje_margen(hit) { return (hit.mesh.userData.eje?.radio || 0.05) * 1.5; }

function bimTrozoSeleccionar(mesh) {
    // Quitar highlight previo
    if (divState._trozoSel && divState._trozoSel.material && divState._trozoSel.material.emissive) {
        divState._trozoSel.material.emissive.setHex(0x000000);
    }
    divState._trozoSel = mesh;
    if (mesh.material && mesh.material.emissive) mesh.material.emissive.setHex(0x3b5bdb); // glow azul = seleccionado
    bimState.viewer.impl.invalidate(false, false, true);
    bimBeep();
    bimTrozoRenderPanel(mesh);
}

/** Panel del trozo: spool asignado, estado y asignación/desvinculación. */
function bimTrozoRenderPanel(mesh) {
    const { guid, idx, a, b, key } = mesh.userData;
    const pct = Math.round((b - a) * 100);
    const tagAsignado = bimState.mapeoSpools ? bimState.mapeoSpools[key] : null;
    const info = tagAsignado && bimState.spoolIndex ? bimState.spoolIndex[String(tagAsignado).toLowerCase()] : null;

    // Estado actual (desde el caché de estados, que ya incluye los trozos)
    let status = null;
    if (bimState.statusesCache) {
        for (const [st, guids] of Object.entries(bimState.statusesCache)) {
            if (guids.some(g => g.toLowerCase() === key)) { status = st; break; }
        }
    }

    bimSetMeta(`
        <div class="bim-meta-header" style="background:rgba(96,165,250,0.15);border-color:rgba(96,165,250,0.35);">
            <i class="fas fa-puzzle-piece"></i><span>Trozo ${idx + 1}</span>
            <span class="bim-badge">${pct}% del tramo</span>
        </div>
        ${tagAsignado ? `
        <div style="padding:10px;border-radius:8px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.25);margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;font-size:0.85rem;"><span style="opacity:0.7;">Spool:</span><strong style="color:#6ee7b7;">${tagAsignado}</strong></div>
            ${info ? `<div style="font-family:monospace;font-size:0.68rem;opacity:0.7;word-break:break-all;margin-top:3px;">${info.id_spool}</div>` : ''}
            ${status ? `<div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-top:4px;"><span style="opacity:0.7;">Estado:</span><strong>${status}</strong></div>` : ''}
        </div>
        <button class="bim-scan-btn" onclick="bimTrozoDesvincular('${key}')" style="background:rgba(239,68,68,0.12);border-color:rgba(239,68,68,0.3);color:#fca5a5;justify-content:center;width:100%;margin-bottom:8px;">
            <i class="fas fa-unlink"></i> Desvincular de ${tagAsignado}</button>`
        : `<p style="font-size:0.8rem;opacity:0.7;margin-bottom:10px;">Este trozo aún no tiene spool asignado.</p>`}
        <div class="bim-link-field" style="margin-bottom:8px;">
            <label style="font-size:0.75rem;opacity:0.8;">TAG del spool para este trozo:</label>
            <input type="text" id="trozo-spool-input" class="bim-search-input" placeholder="Ej: 511" value="" style="width:100%;margin-top:4px;">
        </div>
        <button id="trozo-vincular-btn" class="bim-scan-btn" onclick="bimTrozoVincular('${key}')" style="background:rgba(99,102,241,0.15);border-color:rgba(99,102,241,0.3);color:var(--primary-light);justify-content:center;width:100%;">
            <i class="fas fa-link"></i> Vincular trozo al spool</button>
        <div style="display:flex;gap:6px;margin-top:10px;">
            <button class="bim-scan-btn" onclick="bimTrozoEditarDivision('${key}')" style="flex:1;justify-content:center;background:rgba(245,158,11,0.12);border-color:rgba(245,158,11,0.3);color:#fcd34d;">
                <i class="fas fa-scissors"></i> Editar división</button>
            <button class="bim-scan-btn" onclick="bimTrozoEliminarDivision('${key}')" style="flex:1;justify-content:center;background:rgba(239,68,68,0.12);border-color:rgba(239,68,68,0.3);color:#fca5a5;">
                <i class="fas fa-trash-arrow-up"></i> Deshacer división</button>
        </div>
        <div style="font-size:0.68rem;opacity:0.5;margin-top:8px;word-break:break-all;">ID interno: ${key}</div>`);
}

/** Reabre la edición (manillas) de la división a la que pertenece este trozo. */
async function bimTrozoEditarDivision(key) {
    const mesh = divState.trozoMeshes[key];
    if (!mesh) return;
    const guid = mesh.userData.guid;
    const ok = await authAsegurar('bim');
    if (!ok) return;
    bimGuidsToDbIds([guid], (ids) => {
        if (!ids.length) { alert('No encontré el elemento original en el modelo.'); return; }
        bimDivActivarModo();
        bimDivIniciarEdicion(ids[0], guid); // retira los trozos fijos y monta las manillas
    });
}

/** DESHACE la división completa: restaura el original y limpia trozos + vínculos hijos. */
async function bimTrozoEliminarDivision(key) {
    const mesh = divState.trozoMeshes[key];
    if (!mesh) return;
    const guid = mesh.userData.guid;
    const gl = String(guid).toLowerCase();
    if (!confirm('¿Deshacer la división completa y volver a mostrar el elemento original?')) return;
    const ok = await authAsegurar('bim');
    if (!ok) return;
    try {
        // 1. Borrar la división persistida
        await fetch('/api/bim/divisiones', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bim') },
            body: JSON.stringify({ guid, partes: [] })
        });
        delete divState.guardadas[gl];

        // 2. Desvincular los trozos hijos que tuvieran spool (limpia LIST_Bim)
        const keysDelGuid = Object.keys(divState.trozoMeshes).filter(k => k.startsWith(gl + '#'));
        const conVinculo = keysDelGuid.filter(k => bimState.mapeoSpools && bimState.mapeoSpools[k]);
        if (conVinculo.length) {
            await fetch('/api/bim/desvincular', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders('bim') },
                body: JSON.stringify({ elements: conVinculo.map(g => ({ guid: g })) })
            }).catch(() => {});
            conVinculo.forEach(k => { if (bimState.mapeoSpools) delete bimState.mapeoSpools[k]; });
        }

        // 3. Quitar los meshes de los trozos y restaurar el original
        divState.piezasGuardadas = divState.piezasGuardadas.filter(m => {
            if (String(m.userData?.guid || '').toLowerCase() === gl) {
                try { bimState.viewer.impl.removeOverlay(DIV_OVERLAY, m); } catch (e) {}
                return false;
            }
            return true;
        });
        keysDelGuid.forEach(k => delete divState.trozoMeshes[k]);
        bimGuidsToDbIds([guid], (ids) => {
            if (ids.length) {
                bimState.viewer.show(ids[0]);
                divState.ocultos = divState.ocultos.filter(id => id !== ids[0]);
            }
            bimState.viewer.impl.invalidate(false, false, true);
        });
        divState._trozoSel = null;
        bimSetMeta('<div class="bim-meta-placeholder"><i class="fas fa-circle-check bim-meta-icon" style="color:var(--accent)"></i><p>División deshecha: el elemento original volvió al modelo.</p></div>');
    } catch (e) {
        alert('No se pudo deshacer la división: ' + e.message);
    }
}

async function bimTrozoVincular(key) {
    console.log('[Trozo] Vincular solicitado:', key);
    const mesh = divState.trozoMeshes[key];
    const input = document.getElementById('trozo-spool-input');
    const tag = input ? input.value.trim() : '';
    if (!mesh) { alert('No encontré el trozo en memoria. Recarga la página e intenta de nuevo.'); return; }
    if (!tag) { alert('Ingresa el TAG del spool.'); if (input) input.focus(); return; }

    // Feedback visible en el botón (para detectar dónde se detiene el flujo)
    const btn = document.getElementById('trozo-vincular-btn');
    const setBtn = (html, dis) => { if (btn) { btn.innerHTML = html; btn.disabled = dis; } };
    setBtn('<i class="fas fa-key"></i> Validando clave…', true);

    const desbloqueado = await authAsegurar('bim');
    if (!desbloqueado) { setBtn('<i class="fas fa-link"></i> Vincular trozo al spool', false); return; }
    setBtn('<i class="fas fa-spinner fa-spin"></i> Vinculando…', true);

    try {
        const resp = await fetch('/api/bim/vincular', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bim') },
            body: JSON.stringify({ spool: tag, elements: [{ guid: key, cwp: '', line_number: '', tag: '', autocad_size: '' }] })
        });
        if (resp.status === 401) { authOlvidar('bim'); setBtn('<i class="fas fa-link"></i> Vincular trozo al spool', false); alert('🔒 Clave BIM incorrecta o expirada.'); return; }
        const d = await resp.json();
        if (!d.success && !d.count) throw new Error(d.error || `HTTP ${resp.status}`);
        console.log('[Trozo] Vinculado OK:', key, '→', tag, d);
        if (bimState.mapeoSpools) bimState.mapeoSpools[key] = tag;

        // Estado del spool desde su ficha (AppSheet tiene consistencia eventual:
        // el Find inmediato aún no ve la fila hija) → caché local actualizado.
        let estadoSpool = null;
        try {
            const dSpool = await (await fetch(`/api/bim/spool/${encodeURIComponent(tag)}`)).json();
            estadoSpool = dSpool.estado_actual || null;
        } catch (e) { /* sin ficha, sin estado */ }
        const st = String(estadoSpool || 'SIN ESTADO').toUpperCase();
        if (bimState.statusesCache) {
            for (const arr of Object.values(bimState.statusesCache)) {
                const i = arr.findIndex(g => g.toLowerCase() === key);
                if (i !== -1) arr.splice(i, 1);
            }
            (bimState.statusesCache[st] = bimState.statusesCache[st] || []).push(key);
        }

        // Color/visibilidad: mismo comportamiento que el original
        // (sin filtro conserva su color; con filtro se tiñe u oculta según estado)
        bimDivColorearTrozos();
        bimTrozoRenderPanel(mesh);
    } catch (e) {
        console.error('[Trozo] Error al vincular:', e);
        setBtn('<i class="fas fa-link"></i> Vincular trozo al spool', false);
        alert('No se pudo vincular el trozo: ' + e.message);
    }
}

async function bimTrozoDesvincular(key) {
    const mesh = divState.trozoMeshes[key];
    if (!mesh) return;
    const desbloqueado = await authAsegurar('bim');
    if (!desbloqueado) return;
    try {
        const resp = await fetch('/api/bim/desvincular', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bim') },
            body: JSON.stringify({ elements: [{ guid: key }] })
        });
        if (resp.status === 401) { authOlvidar('bim'); alert('🔒 Clave BIM incorrecta o expirada.'); return; }
        if (bimState.mapeoSpools) delete bimState.mapeoSpools[key];
        // Sacarlo del caché de estados; el color/visibilidad lo maneja el filtro
        if (bimState.statusesCache) {
            for (const arr of Object.values(bimState.statusesCache)) {
                const i = arr.findIndex(g => g.toLowerCase() === key);
                if (i !== -1) arr.splice(i, 1);
            }
        }
        bimDivColorearTrozos(); // sin filtro → look original; con filtro → SIN ESTADO
        bimTrozoRenderPanel(mesh);
    } catch (e) {
        alert('No se pudo desvincular: ' + e.message);
    }
}

async function bimDividirCargarGuardadas() {
    try {
        const r = await fetch('/api/bim/divisiones');
        divState.guardadas = await r.json();
        const guids = Object.keys(divState.guardadas);
        if (!guids.length) return;
        // Por cada división guardada: ocultar el original PARA SIEMPRE y
        // dibujar sus trozos (el clon reemplaza al elemento).
        guids.forEach(g => {
            bimGuidsToDbIds([g], (ids) => {
                if (!ids.length) return;
                const eje = bimEjeDeElemento(ids[0]);
                if (!eje) return;
                bimState.viewer.hide(ids[0]);
                divState.ocultos.push(ids[0]);
                const partes = bimDivNormalizarPartes(divState.guardadas[g]) || [];
                partes.forEach(([a, b], i) => {
                    const m = bimCrearPieza(eje, a, b, eje.colorOrig);
                    if (m) {
                        m.userData = { guid: g, idx: i, a, b, eje };
                        bimDivRegistrarTrozo(m, g, i);
                        divState.piezasGuardadas.push(m);
                    }
                });
            });
        });
        // Cuando estados+mapeo estén listos, pintar los trozos por su estado
        setTimeout(bimDivColorearTrozos, 2500);
    } catch (e) { console.error('[Dividir] Error cargando divisiones:', e.message); }
}

function bimDividirToggle() {
    divState.activo ? bimDividirSalir() : bimDividirEntrar();
}

/** Activa el modo dividir (botón + listeners). Requiere clave ya validada. */
function bimDivActivarModo() {
    if (divState.activo) return;
    divState.activo = true;
    if (divState._btn) divState._btn.setState(Autodesk.Viewing.UI.Button.State.ACTIVE);
    const canvas = bimState.viewer.canvas;
    canvas.addEventListener('pointerdown', bimDivPointerDown, true);
    canvas.addEventListener('pointerup', bimDivPointerUp, true);
    canvas.addEventListener('click', bimDivClickBlock, true);
}

async function bimDividirEntrar() {
    // Clave BIM por adelantado: así el AUTO-GUARDADO es silencioso después
    const ok = await authAsegurar('bim');
    if (!ok) return;
    bimDivActivarModo();

    // Si ya había un elemento SELECCIONADO → dividirlo a la mitad DE UNA VEZ
    const sel = (bimState.selectedElements && bimState.selectedElements.length === 1) ? bimState.selectedElements[0] : null;
    if (sel && sel.dbId != null && sel.guid) {
        bimDivIniciarEdicion(sel.dbId, sel.guid);
        return;
    }
    bimSetMeta(`
        <div class="bim-meta-header" style="background:rgba(245,158,11,0.15);border-color:rgba(245,158,11,0.35);">
            <i class="fas fa-scissors"></i><span>Dividir tramo</span>
        </div>
        <div class="bim-meta-placeholder" style="padding:1.2rem 0.5rem;">
            <p style="font-size:0.8rem;">Haz clic sobre el tubo a dividir: se corta a la mitad al instante.<br>Luego arrastra las <strong>esferas naranjas</strong> para ajustar los tamaños — todo se guarda solo.</p>
        </div>`);
}

// Palabras que delatan elementos NO divisibles (válvulas, soportes, estructuras…)
const DIV_NO_TUBO = ['valv', 'soport', 'support', 'struct', 'estruct', 'steel', 'beam', 'perfil',
    'column', 'pilar', 'equip', 'bomba', 'pump', 'instr', 'brida', 'flange', 'clamp', 'abraz',
    'gusset', 'plate', 'placa', 'anclaje', 'anchor', 'grating', 'hormig', 'concre', 'fitting',
    'elbow', 'codo', 'tee', 'reduc', 'weldolet', 'olet', 'cap ', 'tapa'];

/**
 * ¿El elemento es un TRAMO RECTO de cañería? Combina nombre + geometría:
 * esbeltez (largo ≥ 2.5 diámetros) y cilindricidad (forma tubular real).
 * Codos, tees, válvulas, soportes y estructuras quedan bloqueados.
 */
function bimValidarTubo(dbId, eje) {
    let nombre = '';
    try { nombre = String(bimState.viewer.model.getInstanceTree().getNodeName(dbId) || '').toLowerCase(); } catch (e) {}
    const kw = DIV_NO_TUBO.find(k => nombre.includes(k));
    if (kw) return { ok: false, motivo: `este elemento (${nombre.substring(0, 40)}) no es un tramo de cañería` };
    const esbeltez = eje.len / (eje.radio * 2);
    if (esbeltez < 2.5) return { ok: false, motivo: 'la pieza es muy corta o compacta — no parece un tramo recto de tubería' };
    if ((eje.cilindricidad ?? 1) < 0.55) return { ok: false, motivo: 'la forma no es cilíndrica recta (codos, tees, válvulas, soportes y estructuras no se dividen)' };
    return { ok: true };
}

/** Arranca la edición de un elemento: mitad automática (o su división previa). */
function bimDivIniciarEdicion(dbId, guid) {
    const eje = bimEjeDeElemento(dbId);
    if (!eje) {
        bimSetMeta('<div class="bim-meta-empty"><i class="fas fa-exclamation-triangle"></i><p>No pude leer la geometría de ese elemento. Intenta con otro.</p></div>');
        return;
    }

    // Guardia: la herramienta SOLO divide tramos rectos de cañería
    const val = bimValidarTubo(dbId, eje);
    if (!val.ok) {
        bimSetMeta(`
            <div class="bim-meta-header" style="background:rgba(239,68,68,0.12);border-color:rgba(239,68,68,0.3);">
                <i class="fas fa-ban"></i><span>No divisible</span>
            </div>
            <div class="bim-meta-placeholder" style="padding:1.2rem 0.5rem;">
                <p style="font-size:0.82rem;">✂️ La herramienta es solo para <strong>tramos rectos de cañería</strong>.<br><br>
                Motivo: ${val.motivo}.</p>
            </div>`);
        return;
    }
    divState.dbId = dbId;
    divState.eje = eje;
    divState.guid = String(guid).trim();
    const gl = divState.guid.toLowerCase();

    // Si tenía división persistida: cargarla para editar (retirando sus trozos fijos)
    const previas = bimDivNormalizarPartes(divState.guardadas[gl]);
    if (previas) {
        divState.piezasGuardadas = divState.piezasGuardadas.filter(m => {
            if (String(m.userData?.guid || '').toLowerCase() === gl) {
                try { bimState.viewer.impl.removeOverlay(DIV_OVERLAY, m); } catch (e) {}
                if (m.userData.key) delete divState.trozoMeshes[m.userData.key];
                return false;
            }
            return true;
        });
        divState.ext0 = previas[0][0];
        divState.ext1 = previas[previas.length - 1][1];
        divState.cortes = previas.slice(0, -1).map(p => p[1]);
    } else {
        divState.ext0 = 0; divState.ext1 = 1;
        divState.cortes = [0.5]; // ← división a la MITAD de inmediato
    }
    bimState.viewer.hide(dbId);
    bimState.viewer.select([]);
    bimDivRedibujarClon();
    bimDivRenderPanel();
    bimDivAutoGuardar(); // persistir desde el primer momento
}

/** Variante desde un clic (sin selección previa): resuelve el guid primero. */
function bimDivIniciarEdicionDesdeDbId(dbId) {
    bimState.viewer.model.getProperties(dbId, (props) => {
        const p = (props.properties || []).find(x => ['GUID', 'Element GUID', 'Revit GUID', 'PnPGuid', 'PnPGUID'].includes(x.displayName));
        const guid = (p ? String(p.displayValue) : props.externalId || '').trim();
        if (guid) bimDivIniciarEdicion(dbId, guid);
    }, () => {});
}

/** AUTO-GUARDADO con debounce: cada cambio queda persistido solo. */
function bimDivAutoGuardar() {
    clearTimeout(divState._saveTimer);
    const st = document.getElementById('div-save-status');
    if (st) { st.textContent = 'Guardando…'; st.style.color = 'var(--warning)'; }
    divState._saveTimer = setTimeout(bimDivGuardarAhora, 1200);
}

async function bimDivGuardarAhora() {
    if (!divState.guid) return;
    const partes = bimDivPartesSesion();
    try {
        const resp = await fetch('/api/bim/divisiones', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bim') },
            body: JSON.stringify({ guid: divState.guid, partes })
        });
        const d = await resp.json();
        if (!d.success) throw new Error(d.error || 'Error');
        divState.guardadas[divState.guid.toLowerCase()] = partes;
        if (!divState.ocultos.includes(divState.dbId)) divState.ocultos.push(divState.dbId);
        const st = document.getElementById('div-save-status');
        if (st) { st.textContent = '✓ Guardado'; st.style.color = 'var(--accent)'; }
    } catch (e) {
        const st = document.getElementById('div-save-status');
        if (st) { st.textContent = '⚠ Error al guardar'; st.style.color = 'var(--danger)'; }
    }
}

function bimDividirSalir(conSesionAbierta = true) {
    // Con auto-guardado, salir a media edición = FINALIZAR (los cambios ya persisten)
    if (conSesionAbierta && divState.dbId !== null) {
        bimDividirFinalizar().then(() => bimDividirSalir(false));
        return;
    }
    divState.activo = false;
    if (divState._btn) divState._btn.setState(Autodesk.Viewing.UI.Button.State.INACTIVE);
    const canvas = bimState.viewer?.canvas;
    if (canvas) {
        canvas.removeEventListener('pointerdown', bimDivPointerDown, true);
        canvas.removeEventListener('pointerup', bimDivPointerUp, true);
        canvas.removeEventListener('click', bimDivClickBlock, true);
    }
    divState.dbId = null; divState.guid = null; divState.eje = null; divState.cortes = [];
    divState.ext0 = 0; divState.ext1 = 1;
}

function bimDivLimpiarSesion() {
    const viewer = bimState.viewer;
    divState.piezas.forEach(m => { try { viewer.impl.removeOverlay(DIV_OVERLAY, m); } catch (e) {} });
    (divState.handles || []).forEach(m => { try { viewer.impl.removeOverlay(DIV_OVERLAY, m); } catch (e) {} });
    divState.piezas = [];
    divState.handles = [];
    viewer?.impl.invalidate(false, false, true);
}

function bimDivPointerDown(ev) {
    if (!divState.activo) return;
    divState._down = { x: ev.clientX, y: ev.clientY };

    // ¿Agarró una manilla? → iniciar arrastre (y bloquear la órbita de APS)
    if (divState.handles && divState.handles.length) {
        try {
            const viewer = bimState.viewer;
            const rect = viewer.canvas.getBoundingClientRect();
            const ray = viewer.impl.viewportToRay(viewer.impl.clientToViewport(ev.clientX - rect.left, ev.clientY - rect.top));
            const rc = new THREE.Raycaster(ray.origin.clone(), ray.direction.clone().normalize());
            const hits = rc.intersectObjects(divState.handles, false);
            if (hits.length) {
                divState._drag = hits[0].object;
                ev.stopPropagation(); ev.preventDefault();
                window.addEventListener('pointermove', bimDivDragMove, true);
                window.addEventListener('pointerup', bimDivDragEnd, true);
            }
        } catch (e) { /* sin drag */ }
    }
}

/** Parámetro t sobre el eje a partir de un evento de puntero (sin límites). */
function bimDivTdeEvento(ev) {
    try {
        const viewer = bimState.viewer;
        const rect = viewer.canvas.getBoundingClientRect();
        const ray = viewer.impl.viewportToRay(viewer.impl.clientToViewport(ev.clientX - rect.left, ev.clientY - rect.top));
        const eje = divState.eje;
        const o = ray.origin, d1 = ray.direction.clone().normalize(), d2 = eje.dir;
        const r = new THREE.Vector3().subVectors(o, eje.p0);
        const a = d1.dot(d1), b = d1.dot(d2), c = d2.dot(d2);
        const den = a * c - b * b;
        if (Math.abs(den) < 1e-9) return null;
        const u = (a * d2.dot(r) - b * d1.dot(r)) / den;
        return u / eje.len;
    } catch (e) { return null; }
}

function bimDivDragMove(ev) {
    if (!divState._drag) return;
    ev.stopPropagation(); ev.preventDefault();
    let t = bimDivTdeEvento(ev);
    if (t === null) return;
    const h = divState._drag;
    const MARGEN = 0.04;

    if (h.userData.tipo === 'corte') {
        // Limitar entre sus vecinos (otros cortes o extremos)
        const otros = divState.cortes.filter((c, i) => i !== h.userData.idx);
        const izq = Math.max(divState.ext0, ...otros.filter(c => c < divState.cortes[h.userData.idx]));
        const der = Math.min(divState.ext1, ...otros.filter(c => c > divState.cortes[h.userData.idx]));
        t = Math.min(Math.max(t, izq + MARGEN), der - MARGEN);
        divState.cortes[h.userData.idx] = Math.round(t * 1000) / 1000;
    } else if (h.userData.tipo === 'ext0') {
        const tope = divState.cortes.length ? Math.min(...divState.cortes) : divState.ext1;
        t = Math.min(Math.max(t, -0.5), tope - MARGEN);
        divState.ext0 = Math.round(t * 1000) / 1000;
    } else if (h.userData.tipo === 'ext1') {
        const tope = divState.cortes.length ? Math.max(...divState.cortes) : divState.ext0;
        t = Math.max(Math.min(t, 1.5), tope + MARGEN);
        divState.ext1 = Math.round(t * 1000) / 1000;
    }

    // Redibujo fluido (throttle por frame)
    if (!divState._rafPend) {
        divState._rafPend = true;
        requestAnimationFrame(() => {
            divState._rafPend = false;
            bimDivRedibujarClon();
        });
    }
}

function bimDivDragEnd(ev) {
    if (!divState._drag) return;
    ev.stopPropagation(); ev.preventDefault();
    divState._drag = null;
    divState._consume = true; // que el click posterior no seleccione
    window.removeEventListener('pointermove', bimDivDragMove, true);
    window.removeEventListener('pointerup', bimDivDragEnd, true);
    divState.cortes.sort((a, b) => a - b);
    bimDivRedibujarClon();
    bimDivRenderPanel();
    bimDivAutoGuardar();
}

/** Consume el 'click' que sigue a un corte para que APS no seleccione. */
function bimDivClickBlock(ev) {
    if (divState._consume) {
        ev.stopPropagation(); ev.preventDefault();
        divState._consume = false;
    }
}

function bimDivPointerUp(ev) {
    if (!divState.activo || !divState._down) return;
    const dx = Math.abs(ev.clientX - divState._down.x);
    const dy = Math.abs(ev.clientY - divState._down.y);
    divState._down = null;
    if (dx > 6 || dy > 6) return; // fue un drag (órbita), no un clic

    const viewer = bimState.viewer;
    const rect = viewer.canvas.getBoundingClientRect();

    if (divState.dbId === null) {
        // Primer clic: elegir el tubo → mitad automática + manillas + auto-guardado.
        // Aquí SÍ se necesita hitTest (el original todavía es visible).
        const hit = viewer.impl.hitTest(ev.clientX - rect.left, ev.clientY - rect.top, true);
        if (!hit || !hit.dbId) return;
        ev.stopPropagation(); ev.preventDefault();
        divState._consume = true;
        bimDivIniciarEdicionDesdeDbId(hit.dbId);
        return;
    }

    // Ya en edición: el original está OCULTO y el clon es un overlay que
    // hitTest no ve → ir directo al raycast contra el eje conocido del clon.
    // (Antes se exigía hitTest aquí y los clics "al aire" detrás del tubo se
    // perdían: por eso no se podía pasar de 2 trozos.)
    const t = bimProyectarTDesdeRayo(ev, viewer);
    if (t === null) return; // clic lejos del tubo → dejar pasar (órbita/selección APS)

    // Bloquear la selección nativa sólo cuando el clic realmente corta
    ev.stopPropagation(); ev.preventDefault();
    divState._consume = true;
    if (divState.cortes.some(c => Math.abs(c - t) < 0.03)) return;
    divState.cortes.push(t);
    divState.cortes.sort((a, b) => a - b);
    bimBeep();
    bimDivRedibujarClon();
    bimDivRenderPanel();
    bimDivAutoGuardar();
}

/**
 * Con el original oculto, el hitTest ya no lo ve. Lanzamos el rayo de la
 * cámara y calculamos el punto más cercano entre el rayo y el eje del clon;
 * si pasa a menos de ~2.5 radios del eje, es un clic válido sobre el tubo.
 */
function bimProyectarTDesdeRayo(ev, viewer) {
    try {
        const rect = viewer.canvas.getBoundingClientRect();
        const ray = viewer.impl.viewportToRay(viewer.impl.clientToViewport(ev.clientX - rect.left, ev.clientY - rect.top));
        if (!ray) return null;
        const eje = divState.eje;
        // Punto más cercano entre recta del rayo (o, d1) y recta del eje (p0, d2)
        const o = ray.origin, d1 = ray.direction.clone().normalize(), d2 = eje.dir;
        const r = new THREE.Vector3().subVectors(o, eje.p0);
        const a = d1.dot(d1), b = d1.dot(d2), c = d2.dot(d2);
        const d = d1.dot(r), e = d2.dot(r);
        const den = a * c - b * b;
        if (Math.abs(den) < 1e-9) return null; // paralelos
        const s = (b * e - c * d) / den;   // sobre el rayo
        const u = (a * e - b * d) / den;   // sobre el eje (distancia absoluta)
        const pRayo = o.clone().add(d1.clone().multiplyScalar(s));
        const pEje = eje.p0.clone().add(d2.clone().multiplyScalar(u));
        if (pRayo.distanceTo(pEje) > eje.radio * 2.5) return null; // clic lejos del tubo
        let t = u / eje.len;
        if (t < divState.ext0 + 0.02 || t > divState.ext1 - 0.02) return null;
        return Math.round(t * 1000) / 1000;
    } catch (e) {
        return null;
    }
}

/**
 * Eje REAL del elemento por PCA sobre los vértices del mesh (funciona con
 * tubos diagonales, no solo ortogonales). Devuelve { p0, dir, len, radio }.
 */
function bimEjeDeElemento(dbId) {
    const viewer = bimState.viewer;
    try {
        const it = viewer.model.getInstanceTree();
        const frags = viewer.model.getFragmentList();
        const pts = [];
        const m4 = new THREE.Matrix4();
        let colorOrig = null; // color del material ORIGINAL (los trozos lo heredan)
        let matOrig = null;   // material ORIGINAL completo (para que el trozo se vea idéntico)

        it.enumNodeFragments(dbId, (fragId) => {
            if (matOrig === null) {
                try {
                    const mat = frags.getMaterial(fragId);
                    if (mat) {
                        matOrig = mat;
                        if (mat.color) colorOrig = mat.color.getHex();
                    }
                } catch (e) { /* sin material legible */ }
            }
            const geom = frags.getGeometry(fragId);
            if (!geom || !geom.vb) return;
            frags.getWorldMatrix(fragId, m4);
            const vb = geom.vb, stride = geom.vbstride || 3;
            const count = Math.floor(vb.length / stride);
            const paso = Math.max(1, Math.floor(count / 400));
            for (let i = 0; i < count; i += paso) {
                const v = new THREE.Vector3(vb[i * stride], vb[i * stride + 1], vb[i * stride + 2]);
                v.applyMatrix4(m4);
                pts.push(v);
            }
        }, true);

        if (pts.length < 8) return null;

        // Centroide
        const c = new THREE.Vector3();
        pts.forEach(p => c.add(p));
        c.divideScalar(pts.length);

        // Covarianza 3x3 + iteración de potencia → dirección principal
        let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
        pts.forEach(p => {
            const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
            xx += dx * dx; xy += dx * dy; xz += dx * dz;
            yy += dy * dy; yz += dy * dz; zz += dz * dz;
        });
        let dir = new THREE.Vector3(1, 1, 1).normalize();
        for (let i = 0; i < 25; i++) {
            dir = new THREE.Vector3(
                xx * dir.x + xy * dir.y + xz * dir.z,
                xy * dir.x + yy * dir.y + yz * dir.z,
                xz * dir.x + yz * dir.y + zz * dir.z
            );
            if (dir.length() < 1e-9) return null;
            dir.normalize();
        }

        // Extremos: proyección min/max sobre el eje. Distancias perpendiculares
        // de cada punto al eje → radio (mediana) y CILINDRICIDAD (qué fracción
        // de puntos está cerca del radio típico: 1.0 = cilindro perfecto).
        let tMin = Infinity, tMax = -Infinity;
        const dists = [];
        const tmp = new THREE.Vector3();
        pts.forEach(p => {
            tmp.subVectors(p, c);
            const t = tmp.dot(dir);
            if (t < tMin) tMin = t;
            if (t > tMax) tMax = t;
            dists.push(tmp.clone().sub(dir.clone().multiplyScalar(t)).length());
        });
        const len = tMax - tMin;
        if (len <= 0) return null;
        const ordenadas = [...dists].sort((a, b) => a - b);
        const radio = Math.max(ordenadas[Math.floor(ordenadas.length / 2)], 0.01); // mediana
        const cerca = dists.filter(d => Math.abs(d - radio) <= radio * 0.25).length;
        const cilindricidad = cerca / dists.length;
        const p0 = c.clone().add(dir.clone().multiplyScalar(tMin));
        return { p0, dir, len, radio, cilindricidad, colorOrig: colorOrig ?? 0x9aa4b2, matOrig };
    } catch (e) {
        console.error('[Dividir] Error calculando eje:', e.message);
        return null;
    }
}

/** Proyecta un punto 3D del hit al eje → fracción t (0..1). */
function bimProyectarT(eje, punto) {
    if (!eje || !punto || !eje.len) return null;
    const t = new THREE.Vector3().subVectors(punto, eje.p0).dot(eje.dir) / eje.len;
    if (t < 0.02 || t > 0.98) return null; // demasiado cerca de los extremos
    return Math.round(t * 1000) / 1000;
}

/** Crea el trozo de clon (cilindro sólido) entre las fracciones a..b del eje. */
function bimCrearPieza(eje, a, b, colorHex, opacidad = 1) {
    const viewer = bimState.viewer;
    try {
        const GAP = 0.004; // separación visual entre trozos (fracción del largo)
        const a2 = a + GAP / 2, b2 = b - GAP / 2;
        const largo = eje.len * Math.max(b2 - a2, 0.002);
        const geo = new THREE.CylinderGeometry(eje.radio, eje.radio, largo, 20, 1, false);
        // Gris neutro por defecto; el estado del spool le dará su color (o queda gris)
        const mat = new THREE.MeshPhongMaterial({
            color: 0x9aa4b2, transparent: opacidad < 1, opacity: opacidad,
            specular: 0x222222, shininess: 30
        });
        const mesh = new THREE.Mesh(geo, mat);
        // Cylinder nace alineado a +Y → orientarlo a la dirección real del tubo
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), eje.dir);
        const centro = eje.p0.clone().add(eje.dir.clone().multiplyScalar(eje.len * (a2 + b2) / 2));
        mesh.position.copy(centro);
        viewer.impl.addOverlay(DIV_OVERLAY, mesh);
        viewer.impl.invalidate(false, false, true);
        return mesh;
    } catch (e) {
        console.error('[Dividir] Error creando pieza:', e.message);
        return null;
    }
}

/** Redibuja el clon de la sesión (piezas + manillas de ajuste). */
function bimDivRedibujarClon() {
    const viewer = bimState.viewer;
    divState.piezas.forEach(m => { try { viewer.impl.removeOverlay(DIV_OVERLAY, m); } catch (e) {} });
    (divState.handles || []).forEach(m => { try { viewer.impl.removeOverlay(DIV_OVERLAY, m); } catch (e) {} });
    divState.piezas = [];
    divState.handles = [];

    bimDivPartesSesion().forEach(([a, b], i) => {
        const m = bimCrearPieza(divState.eje, a, b, divState.eje.colorOrig);
        if (m) {
            m.userData = { guid: divState.guid, idx: i, a, b, eje: divState.eje };
            divState.piezas.push(m);
        }
    });

    // Manillas: esferas naranjas en cada corte (ajustan tamaños arrastrando)
    // y celestes en los extremos (alargar/acortar el clon).
    divState.cortes.forEach((t, i) => {
        const h = bimCrearManilla(divState.eje, t, 0xf59e0b);
        if (h) { h.userData = { tipo: 'corte', idx: i }; divState.handles.push(h); }
    });
    [['ext0', divState.ext0], ['ext1', divState.ext1]].forEach(([tipo, t]) => {
        const h = bimCrearManilla(divState.eje, t, 0x38bdf8);
        if (h) { h.userData = { tipo }; divState.handles.push(h); }
    });
}

/**
 * Material del trozo que MEJOR imita al tubo original. Clona el material real,
 * pero se protege de dos fallas de APS: clon que renderiza NEGRO (materiales
 * Prism) o color BLANCO (color real en textura) → cae a un Phong con el hex
 * muestreado, y si ese también es blanco/negro usa un gris neutro visible.
 */
function bimMatTrozo(matOrig, colorHex, opacidad = 1) {
    const esExtremo = (h) => h === 0x000000 || h === 0xffffff || h == null;
    const colorFinal = esExtremo(colorHex) ? 0xb8c0cc : colorHex;
    // 1) Intentar clonar el material original
    try {
        if (matOrig && typeof matOrig.clone === 'function') {
            const c = matOrig.clone();
            c.needsUpdate = true;
            c.transparent = opacidad < 1;
            c.opacity = opacidad;
            // Si el clon quedó negro (Prism mal clonado) → forzar el color muestreado
            if (c.color && esExtremo(c.color.getHex())) c.color.setHex(colorFinal);
            return c;
        }
    } catch (e) { /* fallback abajo */ }
    // 2) Phong con el color muestreado (o gris neutro)
    return new THREE.MeshPhongMaterial({
        color: colorFinal, transparent: opacidad < 1, opacity: opacidad,
        specular: 0x222222, shininess: 40
    });
}

/** Esfera-manilla arrastrable sobre el eje en la fracción t. */
function bimCrearManilla(eje, t, colorHex) {
    const viewer = bimState.viewer;
    try {
        const geo = new THREE.SphereGeometry(eje.radio * 1.45, 18, 14);
        const mat = new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: 0.9, depthTest: false });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(eje.p0.clone().add(eje.dir.clone().multiplyScalar(eje.len * t)));
        viewer.impl.addOverlay(DIV_OVERLAY, mesh);
        viewer.impl.invalidate(false, false, true);
        return mesh;
    } catch (e) { return null; }
}

// ---- Registro de trozos persistidos: clave `${guidLower}#p${n}` → mesh ----
divState.trozoMeshes = {};

function bimDivRegistrarTrozo(mesh, guid, idx) {
    const key = `${String(guid).toLowerCase()}#p${idx + 1}`;
    mesh.userData.key = key;
    divState.trozoMeshes[key] = mesh;
    return key;
}

/**
 * Trozos = mismo comportamiento de color que los elementos del modelo:
 * SIN filtro → se ven con el color ORIGINAL del tubo (solo divididos).
 * CON filtro → visibles solo si su estado está seleccionado, teñidos con su color.
 */
// Mapa inverso guid→estado a partir del caché de estados del visor.
function bimStatusPorGuid() {
    const m = {};
    if (bimState.statusesCache) {
        for (const [st, gs] of Object.entries(bimState.statusesCache)) {
            gs.forEach(g => { m[g.toLowerCase()] = st; });
        }
    }
    return m;
}

/**
 * Apariencia de los trozos por ESTADO de su spool:
 * - sin filtro → GRIS si no tiene estado; color del estado si lo tiene.
 * - con filtro → visible solo si su estado está seleccionado, con su color.
 */
function bimDivFiltrarTrozos(seleccionSet) {
    const statusDe = bimStatusPorGuid();
    for (const [key, mesh] of Object.entries(divState.trozoMeshes)) {
        const st = statusDe[key] || 'SIN ESTADO';
        if (seleccionSet) {
            mesh.visible = seleccionSet.has(st);
            if (mesh.visible) bimTrozoPintarPorEstado(mesh, st);
        } else {
            mesh.visible = true;
            bimTrozoPintarPorEstado(mesh, st);
        }
    }
    bimState.viewer?.impl.invalidate(false, false, true);
}

/** Pinta el trozo con el color de su estado (GRIS neutro si es SIN ESTADO). */
function bimTrozoPintarPorEstado(mesh, st) {
    if (!st || st === 'SIN ESTADO') bimTrozoPintarGris(mesh);
    else bimTrozoPintarEstado(mesh, bimColorDeEstado(st));
}

/** Gris neutro opaco (trozo sin estado asociado). */
function bimTrozoPintarGris(mesh) {
    bimTrozoPintarEstado(mesh, [0.60, 0.64, 0.70]);
}

/** Modo x-ray para el trozo (translúcido, como los elementos no aislados de APS). */
function bimTrozoPintarGhost(mesh) {
    if (!mesh._matGhost) {
        mesh._matGhost = new THREE.MeshPhongMaterial({
            color: 0x9aa4b2, transparent: true, opacity: 0.10, depthWrite: false
        });
    }
    mesh.material = mesh._matGhost;
}

/**
 * Al aislar un spool (búsqueda): los trozos de ESE spool quedan sólidos y el
 * resto en x-ray, igual que el ghosting del modelo APS. guidsActivos incluye
 * las claves de los trozos hijos (guid#pN) del spool buscado.
 */
function bimDivGhostPorSpool(guidsActivos) {
    const activos = new Set((guidsActivos || []).map(g => String(g).toLowerCase()));
    const focos = [];
    for (const [key, mesh] of Object.entries(divState.trozoMeshes)) {
        if (activos.has(key)) {
            // MISMO verde del resaltado de búsqueda de un spool normal
            mesh.visible = true;
            bimTrozoPintarEstado(mesh, [0.18, 0.84, 0.44]);
            focos.push(mesh);
        } else {
            bimTrozoPintarGhost(mesh); // x-ray
        }
    }
    // Foco de cámara al trozo si el spool es SOLO trozos (no hubo dbIds reales que encuadrar)
    if (focos.length && (!bimState.dbIds || !bimState.dbIds.length)) {
        const box = new THREE.Box3();
        focos.forEach(m => box.expandByObject(m));
        if (!box.isEmpty()) {
            const c = box.getCenter(new THREE.Vector3());
            const r = box.getSize(new THREE.Vector3()).length() / 2 || 1;
            try { bimState.viewer.navigation.fitBounds(false, new THREE.Box3(
                c.clone().addScalar(-r - 2), c.clone().addScalar(r + 2))); } catch (e) {}
        }
    }
    bimState.viewer?.impl.invalidate(false, false, true);
}

/** Tiñe el trozo con un color de estado sólido (material temático dedicado). */
function bimTrozoPintarEstado(mesh, rgb) {
    if (!mesh._matTema) mesh._matTema = new THREE.MeshPhongMaterial({ specular: 0x222222, shininess: 40 });
    mesh._matTema.color.setRGB(rgb[0], rgb[1], rgb[2]);
    mesh.material = mesh._matTema;
}

/** Re-oculta los originales divididos (isolate los re-muestra aunque estén hidden). */
function bimDivReocultarOriginales() {
    if (divState.ocultos.length && bimState.viewer) {
        divState.ocultos.forEach(id => bimState.viewer.hide(id));
    }
}

/** Aplica color/visibilidad de trozos según el filtro activo (o los restaura). */
function bimDivColorearTrozos() {
    bimDivFiltrarTrozos(bimState.filtroEstados && bimState.filtroEstados.size ? new Set(bimState.filtroEstados) : null);
}

/** Panel lateral: trozos del clon + alargar/acortar + acciones. */
function bimDivRenderPanel() {
    const partes = bimDivPartesSesion();
    const filas = partes.map(([a, b], i) => {
        const pct = Math.round((b - a) * 100);
        const color = '#' + (divState.eje?.colorOrig ?? 0x9aa4b2).toString(16).padStart(6, '0');
        return `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid var(--border);font-size:0.82rem;">
            <span style="width:12px;height:12px;border-radius:3px;background:${color};flex-shrink:0;"></span>
            <span style="font-weight:700;">Trozo ${i + 1}</span><span style="opacity:0.7;margin-left:auto;">${pct}% del largo</span></div>`;
    });
    const tag = bimState.mapeoSpools ? bimState.mapeoSpools[String(divState.guid || '').toLowerCase()] : null;
    bimSetMeta(`
        <div class="bim-meta-header" style="background:rgba(245,158,11,0.15);border-color:rgba(245,158,11,0.35);">
            <i class="fas fa-scissors"></i><span>Editando división</span>
            <span class="bim-badge">${partes.length} trozo(s)</span>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.72rem;margin:6px 2px;">
            <span style="opacity:0.7;">${tag ? `Spool actual: <strong>${tag}</strong>` : 'El original está oculto'}</span>
            <span id="div-save-status" style="font-weight:700;color:var(--accent);">✓ Guardado</span>
        </div>
        <div style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:8px;">${filas.join('')}</div>
        <p style="font-size:0.74rem;opacity:0.65;margin-bottom:8px;">
            🟠 Arrastra las <strong>esferas naranjas</strong> para ajustar los tamaños.<br>
            🔵 Las <strong>celestes</strong> alargan/acortan los extremos.<br>
            Un clic sobre el tubo agrega otro corte. Todo se guarda solo.</p>
        <div style="display:flex;flex-direction:column;gap:6px;">
            <button class="bim-scan-btn" onclick="bimDividirFinalizar()" style="background:rgba(16,185,129,0.15);border-color:rgba(16,185,129,0.35);color:#6ee7b7;justify-content:center;">
                <i class="fas fa-check"></i> Listo (${partes.length} trozos)</button>
            <button class="bim-scan-btn" onclick="bimDividirDeshacer()" style="justify-content:center;"><i class="fas fa-rotate-left"></i> Quitar último corte</button>
            <button class="bim-scan-btn" onclick="bimDividirRestaurar()" style="background:rgba(239,68,68,0.12);border-color:rgba(239,68,68,0.3);color:#fca5a5;justify-content:center;"><i class="fas fa-trash-arrow-up"></i> Eliminar división (restaurar original)</button>
        </div>`);
}

/** Alarga/acorta el clon moviendo un extremo (paso en fracción del largo). */
function bimDividirExtender(cual, delta) {
    const v = divState[cual] + delta;
    if (cual === 'ext0' && v >= divState.ext1 - 0.05) return;
    if (cual === 'ext1' && v <= divState.ext0 + 0.05) return;
    if (v < -0.5 || v > 1.5) return; // máx. media longitud extra por lado
    divState[cual] = Math.round(v * 1000) / 1000;
    bimDivRedibujarClon();
    bimDivRenderPanel();
}

function bimDividirDeshacer() {
    if (!divState.cortes.length) return;
    divState.cortes.pop();
    bimDivRedibujarClon();
    bimDivRenderPanel();
    bimDivAutoGuardar();
}

/**
 * "Listo": los cambios YA están auto-guardados — aquí solo se fijan los
 * trozos como definitivos (quedan clicables/asignables) y se cierra la edición.
 */
async function bimDividirFinalizar() {
    if (!divState.guid) return;
    clearTimeout(divState._saveTimer);
    await bimDivGuardarAhora(); // flush final por si había un cambio en vuelo

    const partes = bimDivPartesSesion();
    // Quitar manillas; las piezas pasan a ser trozos persistidos clicables
    (divState.handles || []).forEach(m => { try { bimState.viewer.impl.removeOverlay(DIV_OVERLAY, m); } catch (e) {} });
    divState.handles = [];
    divState.piezas.forEach((m, i) => bimDivRegistrarTrozo(m, divState.guid, i));
    divState.piezasGuardadas.push(...divState.piezas);
    divState.piezas = [];
    bimDivColorearTrozos();

    bimSetMeta(`<div class="bim-meta-placeholder"><i class="fas fa-circle-check bim-meta-icon" style="color:var(--accent)"></i>
        <p>División lista: <strong>${partes.length} trozos</strong>.<br><small style="opacity:0.7">Sal del modo tijeras y haz clic en cada trozo para asignarle su spool. Puedes dividir otro tramo ahora.</small></p></div>`);
    divState.dbId = null; divState.guid = null; divState.eje = null; divState.cortes = [];
    divState.ext0 = 0; divState.ext1 = 1;
}

/** Elimina la división (persistida o no) y restaura el elemento original. */
async function bimDividirRestaurar() {
    if (!divState.guid) return;
    if (!confirm('¿Eliminar la división y volver a mostrar el elemento original?')) return;
    if (divState.guardadas[divState.guid.toLowerCase()]) {
        const desbloqueado = await authAsegurar('bim');
        if (!desbloqueado) return;
        await fetch('/api/bim/divisiones', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bim') },
            body: JSON.stringify({ guid: divState.guid, cortes: [] })
        }).catch(() => {});
        delete divState.guardadas[divState.guid.toLowerCase()];
    }
    bimDivLimpiarSesion();
    // Quitar también los trozos persistidos de este guid (mesh + registro)
    const gl = divState.guid.toLowerCase();
    divState.piezasGuardadas = divState.piezasGuardadas.filter(m => {
        if (String(m.userData?.guid || '').toLowerCase() === gl) {
            try { bimState.viewer.impl.removeOverlay(DIV_OVERLAY, m); } catch (e) {}
            if (m.userData.key) delete divState.trozoMeshes[m.userData.key];
            return false;
        }
        return true;
    });
    if (divState.dbId !== null) {
        bimState.viewer.show(divState.dbId);
        divState.ocultos = divState.ocultos.filter(id => id !== divState.dbId);
    }
    divState.dbId = null; divState.guid = null; divState.eje = null; divState.cortes = [];
    divState.ext0 = 0; divState.ext1 = 1;
    bimSetMeta('<div class="bim-meta-placeholder"><i class="fas fa-cube bim-meta-icon"></i><p>Original restaurado. Haz clic en otro tubo para dividirlo, o sal con las tijeras.</p></div>');
}

/** Cancela la edición actual sin tocar lo persistido. */
function bimDividirCancelar() {
    bimDivLimpiarSesion();
    if (divState.dbId !== null) {
        const guardada = divState.guid && divState.guardadas[divState.guid.toLowerCase()];
        if (guardada) {
            // Tenía división persistida: re-dibujar la versión guardada
            const partes = bimDivNormalizarPartes(guardada) || [];
            partes.forEach(([a, b], i) => {
                const m = bimCrearPieza(divState.eje, a, b, divState.eje.colorOrig);
                if (m) {
                    m.userData = { guid: divState.guid, idx: i, a, b, eje: divState.eje };
                    bimDivRegistrarTrozo(m, divState.guid, i);
                    divState.piezasGuardadas.push(m);
                }
            });
            bimDivColorearTrozos();
        } else {
            bimState.viewer.show(divState.dbId); // sin persistencia: vuelve el original
        }
    }
    bimDividirSalir(false);
    bimSetMeta(`<div class="bim-meta-placeholder"><i class="fas fa-cube bim-meta-icon"></i><p>Escanea un QR o busca un spool para ver su información y resaltarlo en el modelo 3D</p></div>`);
}

/**
 * Devuelve el ID_SPOOL largo y demás datos de un tag corto (SPOOL LUKEAPP),
 * resolviéndolo contra el índice precargado.
 */
function bimResolverSpool(tag) {
    if (!tag || !bimState.spoolIndex) return null;
    return bimState.spoolIndex[String(tag).toLowerCase()] || null;
}

/** Despliega/contrae las tarjetas de detalle adicionales del spool. */
function bimToggleMetaExtra(btn) {
    const extra = document.getElementById('bim-meta-extra');
    if (!extra) return;
    const abierto = extra.style.display !== 'none';
    extra.style.display = abierto ? 'none' : 'block';
    const n = extra.querySelectorAll('.bim-meta-card').length;
    btn.innerHTML = abierto
        ? `<i class="fas fa-chevron-down"></i> Ver ${n} detalles más`
        : `<i class="fas fa-chevron-up"></i> Ver menos`;
}

/** Muestra/oculta el menú del ⋮ (donde vive el Desvincular). */
function bimToggleUnlinkMenu(ev) {
    if (ev) ev.stopPropagation();
    const menu = document.getElementById('bim-unlink-menu');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

/** Cierra el menú ⋮ (se llama al re-renderizar la info del vínculo). */
function bimResetUnlinkMenu() {
    const menu = document.getElementById('bim-unlink-menu');
    if (menu) menu.style.display = 'none';
}

/** HTML del recuadro de estado: muestra TAG GESTIÓN + ID_SPOOL de los agrupados. */
function bimRenderSpoolInfo(spoolsDistintos) {
    bimResetUnlinkMenu();
    if (spoolsDistintos.length === 1) {
        const { tag, count } = spoolsDistintos[0];
        const info = bimResolverSpool(tag);
        const idSpool = info?.id_spool || '—';
        return `
            <div style="display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:6px;">
                <i class="fas fa-link"></i> Vinculado a Spool
            </div>
            <div style="display:flex;justify-content:space-between;gap:8px;">
                <span style="opacity:0.75;">TAG Gestión:</span>
                <span style="font-weight:700;color:#fde68a;">${tag}</span>
            </div>
            <div style="margin-top:6px;">
                <div style="opacity:0.7;font-size:0.7rem;letter-spacing:0.5px;">ID_SPOOL</div>
                <div style="font-family:monospace;font-size:0.74rem;word-break:break-all;color:#fde68a;">${idSpool}</div>
            </div>
            <div style="opacity:0.6;font-size:0.72rem;margin-top:6px;">${count} elemento(s) agrupado(s)</div>`;
    }

    // Varios spools en la selección: listar cada uno con su ID_SPOOL
    const filas = spoolsDistintos.map(({ tag, count }) => {
        const info = bimResolverSpool(tag);
        const idSpool = info?.id_spool || '—';
        return `
            <div style="padding:6px 0;border-top:1px solid rgba(245,158,11,0.2);">
                <div style="display:flex;justify-content:space-between;">
                    <span style="font-weight:700;color:#fde68a;">${tag}</span>
                    <span style="opacity:0.6;font-size:0.72rem;">${count} elem.</span>
                </div>
                <div style="font-family:monospace;font-size:0.68rem;opacity:0.8;word-break:break-all;">${idSpool}</div>
            </div>`;
    }).join('');

    return `
        <div style="display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:2px;">
            <i class="fas fa-exclamation-triangle"></i> ${spoolsDistintos.length} spools en la selección
        </div>
        ${filas}
        <div style="opacity:0.6;font-size:0.72rem;margin-top:4px;">Desvincular afectará a todos los agrupados.</div>`;
}

/** Panel de metadata cuando la selección abarca varios spools. */
function bimRenderMultiSpoolMeta(spoolsDistintos) {
    const cards = spoolsDistintos.map(({ tag, count }) => {
        const info = bimResolverSpool(tag);
        return `
            <div class="bim-meta-card">
                <span class="bim-meta-icon-sm"><i class="fas fa-tag"></i></span>
                <div>
                    <span class="bim-meta-label">TAG ${tag} · ${count} elem.</span>
                    <span class="bim-meta-value" style="font-family:monospace;font-size:0.72rem;word-break:break-all;">${info?.id_spool || '—'}</span>
                </div>
            </div>`;
    }).join('');
    return `
        <div class="bim-meta-header">
            <i class="fas fa-layer-group"></i>
            <span>Selección múltiple</span>
            <span class="bim-badge">${spoolsDistintos.length} spools</span>
        </div>
        <div class="bim-meta-cards">${cards}</div>`;
}

/** Renderiza las tarjetas de metadata en el panel lateral */
function bimRenderMeta(data) {
    const meta = data.metadata || {};
    const els  = data.elements || [];

    // Estado ACTUAL = último registro de LOG_Spool_MS (no el "Proceso" del maestro)
    const estado = data.estado_actual || null;

    // Tarjetas de metadata (TAG, ID_SPOOL y ESTADO quedan a la vista; el resto se contrae)
    const fields = [
        { label: 'TAG Gestión', value: meta['TAG GESTION'] || data.spool_id, icon: 'fa-tag' },
        { label: 'ID_SPOOL',    value: meta['ID_SPOOL'] || data.spool_id, icon: 'fa-barcode' },
        { label: 'Estado actual', value: estado, icon: 'fa-circle-dot', estado: true },
        { label: 'CWP',         value: els[0]?.cwp,                icon: 'fa-map-marker-alt' },
        { label: 'Línea',       value: els[0]?.numero_linea,        icon: 'fa-route' },
        { label: 'TAG',         value: els[0]?.tag,                 icon: 'fa-tag' },
        { label: 'Tamaño',      value: els[0]?.autocad_size,        icon: 'fa-ruler' },
        { label: 'Sistema',     value: meta['SISTEMA'],             icon: 'fa-layer-group' },
        { label: 'NPS',         value: meta['NPS'] ? `${meta['NPS']}"` : null, icon: 'fa-circle-notch' },
        { label: 'Material',    value: meta['MATERIAL'],            icon: 'fa-atom' },
        { label: 'Área',        value: meta['AREA'],                icon: 'fa-map' },
        { label: 'Responsable', value: meta['RESPONSABLE'],         icon: 'fa-user-hard-hat' }
    ].filter(f => f.value);

    const card = f => {
        // La tarjeta de "Estado actual" lleva un punto con el color del estado
        const dot = f.estado
            ? `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:${bimRgbAHex(bimColorDeEstado(String(f.value).toUpperCase()))};"></span>`
            : '';
        return `
        <div class="bim-meta-card">
            <span class="bim-meta-icon-sm"><i class="fas ${f.icon}"></i></span>
            <div>
                <span class="bim-meta-label">${f.label}</span>
                <span class="bim-meta-value">${dot}${f.value}</span>
            </div>
        </div>`;
    };

    // TAG Gestión, ID_SPOOL y Estado actual a la vista; el resto contraído
    const nVisibles = estado ? 3 : 2;
    const principales = fields.slice(0, nVisibles).map(card).join('');
    const extras = fields.slice(nVisibles);
    const extrasHtml = extras.length ? `
        <div id="bim-meta-extra" style="display:none;">${extras.map(card).join('')}</div>
        <button class="bim-meta-toggle" onclick="bimToggleMetaExtra(this)">
            <i class="fas fa-chevron-down"></i> Ver ${extras.length} detalles más</button>` : '';

    bimSetMeta(`
        <div class="bim-meta-header">
            <i class="fas fa-cube"></i>
            <span>${data.spool_id}</span>
            <span class="bim-badge">${data.guids.length} elemento${data.guids.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="bim-meta-cards">${principales}${extrasHtml}</div>`);

    // Carga asíncrona de hojas de isométricos PDF (multi-hoja)
    const isoId = meta['ID_ISO'];
    if (isoId) {
        fetch(`/api/iso/pdf/${encodeURIComponent(isoId)}`)
            .then(r => r.json())
            .then(res => {
                if (res.success && res.sheets && res.sheets.length > 0) {
                    const metaPanel = document.getElementById('bim-meta-panel');
                    if (metaPanel) {
                        let btnContainer = document.getElementById('bim-pdf-btn-container');
                        if (!btnContainer) {
                            btnContainer = document.createElement('div');
                            btnContainer.id = 'bim-pdf-btn-container';
                            btnContainer.style.marginTop = '15px';
                            btnContainer.style.width = '100%';
                            metaPanel.appendChild(btnContainer);
                        }

                        // Si hay más de 1 hoja, mostramos dropdown selector. Si hay 1, botón directo.
                        if (res.sheets.length > 1) {
                            btnContainer.innerHTML = `
                                <div style="display: flex; flex-direction: column; gap: 6px; width: 100%;">
                                    <label style="font-size: 0.75rem; font-weight: 600; color: rgba(255,255,255,0.4); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;">Isométrico Hojas (${res.sheets.length}):</label>
                                    <div style="display: flex; gap: 8px;">
                                        <select id="bim-pdf-sheets-select" style="flex: 1; min-width: 0; padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(15,23,42,0.6); color: #fff; font-family: inherit; font-size: 0.88rem; outline: none; box-sizing: border-box;">
                                            ${res.sheets.map(sh => `<option value="${sh.pdf_url}" ${sh.id_iso === res.current_sheet.id_iso ? 'selected' : ''}>${sh.hoja_label}</option>`).join('')}
                                        </select>
                                        <button onclick="bimOpenSelectedPdf()" style="padding: 10px 14px; border-radius: 8px; background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #fca5a5; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; outline: none;" title="Ver PDF de la hoja seleccionada">
                                            <i class="fas fa-file-pdf" style="font-size: 1.1rem; color: #ef4444;"></i>
                                        </button>
                                    </div>
                                </div>
                            `;
                        } else {
                            const sh = res.sheets[0];
                            btnContainer.innerHTML = `
                                <button onclick="bimOpenPdf('${sh.pdf_url}')" style="background:rgba(239,68,68,0.12); border-color:rgba(239,68,68,0.25); color:#fca5a5; display:flex; justify-content:center; align-items:center; gap:8px; width:100%; padding: 10px; border-radius: 8px; font-weight: 600; cursor: pointer; transition: all 0.2s; outline: none;">
                                    <i class="fas fa-file-pdf" style="font-size: 1.1rem; color: #ef4444;"></i>
                                    <span>Ver Isométrico PDF</span>
                                </button>
                            `;
                        }
                    }
                }
            })
            .catch(err => console.error('[BIM] Error al consultar hojas del isométrico:', err));
    }

    // Carga asíncrona de planos P&ID relacionados
    const spoolIdParam = data.spool_id;
    if (spoolIdParam) {
        fetch(`/api/pid/pdf/${encodeURIComponent(spoolIdParam)}`)
            .then(r => r.json())
            .then(res => {
                const metaPanel = document.getElementById('bim-meta-panel');
                if (metaPanel) {
                    // Limpiar contenedor previo si existe
                    let prev = document.getElementById('bim-pid-btn-container');
                    if (prev) prev.remove();

                    if (res.success && res.pids && res.pids.length > 0) {
                        let pidContainer = document.createElement('div');
                        pidContainer.id = 'bim-pid-btn-container';
                        pidContainer.style.marginTop = '12px';
                        pidContainer.style.width = '100%';
                        metaPanel.appendChild(pidContainer);

                        if (res.pids.length > 1) {
                            pidContainer.innerHTML = `
                                <div style="display: flex; flex-direction: column; gap: 6px; width: 100%;">
                                    <label style="font-size: 0.75rem; font-weight: 600; color: rgba(255,255,255,0.4); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px;">Diagrama P&ID (${res.pids.length}):</label>
                                    <div style="display: flex; gap: 8px;">
                                        <select id="bim-pdf-pids-select" style="flex: 1; min-width: 0; padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.1); background: rgba(15,23,42,0.6); color: #fff; font-family: inherit; font-size: 0.88rem; outline: none; box-sizing: border-box;">
                                            ${res.pids.map(p => `<option value="${p.pdf_url}">${p.id_pid}</option>`).join('')}
                                        </select>
                                        <button onclick="bimOpenSelectedPid()" style="padding: 10px 14px; border-radius: 8px; background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #fca5a5; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; justify-content: center; outline: none;" title="Ver PDF del P&ID seleccionado">
                                            <i class="fas fa-file-pdf" style="font-size: 1.1rem; color: #ef4444;"></i>
                                        </button>
                                    </div>
                                </div>
                            `;
                        } else {
                            const p = res.pids[0];
                            pidContainer.innerHTML = `
                                <button onclick="bimOpenPdf('${p.pdf_url}')" style="background:rgba(239,68,68,0.12); border-color:rgba(239,68,68,0.25); color:#fca5a5; display:flex; justify-content:center; align-items:center; gap:8px; width:100%; padding: 10px; border-radius: 8px; font-weight: 600; cursor: pointer; transition: all 0.2s; outline: none;">
                                    <i class="fas fa-file-pdf" style="font-size: 1.1rem; color: #ef4444;"></i>
                                    <span>Ver P&ID PDF</span>
                                </button>
                            `;
                        }
                    }
                }
            })
            .catch(err => console.error('[BIM] Error al consultar PIDs:', err));
    }


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

/**
 * Pinta el panel de vinculación para capas válvula/soporte.
 * A diferencia de spools, aquí 1 elemento = 1 ítem (sin auto-grupo).
 */
function bimRenderCapaSelection(capa, selectedList, uniqueLayers) {
    bimResetUnlinkMenu();
    const ui = BIM_CAPA_UI[capa];
    const mapeo = bimState.capaMapeo[capa] || {};
    const index = bimState.capaIndex[capa] || {};

    // GUID / capa
    const guidEl = document.getElementById('bim-link-guid');
    if (guidEl) guidEl.textContent = selectedList.length === 1 ? selectedList[0].guid : `${selectedList.length} elementos`;
    const layerEl = document.getElementById('bim-link-layer');
    if (layerEl) layerEl.textContent = uniqueLayers && uniqueLayers.size ? Array.from(uniqueLayers).join(', ') : 'N/A';

    // Título del panel
    const linkTitle = document.querySelector('#bim-link-panel h4');
    if (linkTitle) linkTitle.innerHTML = `<i class="fas fa-link"></i> Vincular ${ui.label} (${selectedList.length} selec.)`;

    // IDs ya vinculados en la selección
    const idsSel = [...new Set(selectedList.map(el => mapeo[el.guid.toLowerCase()]).filter(Boolean))];
    const statusContainer = document.getElementById('bim-link-status-container');
    const infoEl = document.getElementById('bim-link-spool-info');
    const inputEl = document.getElementById('bim-link-spool');

    // Etiqueta del campo de entrada
    const fieldLabel = document.querySelector('#bim-link-panel label[for="bim-link-spool"]');
    if (fieldLabel) fieldLabel.textContent = capa === 'valvula' ? 'ID Válvula (ID_VALVULA):' : 'ITEM Soporte (ej: 148):';
    if (inputEl) inputEl.placeholder = ui.placeholder;

    if (idsSel.length > 0) {
        if (statusContainer) statusContainer.style.display = 'flex';
        if (infoEl) {
            infoEl.innerHTML = idsSel.map(id => {
                const row = index[id.toLowerCase()];
                const label = row?._label || id;
                return `<div style="display:flex;justify-content:space-between;gap:8px;">
                    <span style="opacity:0.75;">Vinculado a:</span>
                    <span style="font-weight:700;color:#fde68a;text-align:right;word-break:break-all;">${label}</span>
                </div>`;
            }).join('');
        }
        if (inputEl) inputEl.value = idsSel.length === 1 ? idsSel[0] : '';
        // Metadata + estado de montaje del primer ítem
        if (idsSel.length === 1) bimRenderCapaMeta(capa, idsSel[0]);
    } else {
        if (statusContainer) statusContainer.style.display = 'none';
        if (inputEl) inputEl.value = '';
        const tieneClave = !!authObtener('bim');
        if (!tieneClave) {
            bimSetMeta(`
                <div class="bim-meta-placeholder">
                    <i class="fas fa-cube bim-meta-icon" style="color:#a78bfa;"></i>
                    <p>${selectedList.length} elemento(s) sin ${ui.label.toLowerCase()} asignada (Modo Solo Lectura).</p>
                    <button onclick="authAsegurar('bim').then(ok => { if(ok) bimActualizarPermisosUI(); })" class="bim-scan-btn" style="margin-top:10px; background:rgba(99,102,241,0.2); border-color:rgba(99,102,241,0.4); color:var(--primary-light);">
                        <i class="fas fa-cube"></i> Editar BIM (Ingresar Clave)
                    </button>
                </div>`);
        } else {
            bimSetMeta(`<div class="bim-meta-placeholder"><i class="fas fa-cube bim-meta-icon"></i><p>${selectedList.length} elemento(s) sin ${ui.label.toLowerCase()} asignada. Ingresa su ID abajo para vincular.</p></div>`);
        }
    }

    // Botón guardar
    const btn = document.getElementById('bim-link-btn');
    if (btn) { btn.innerHTML = `<i class="fas fa-save"></i> Guardar ${selectedList.length} elem.`; btn.disabled = false; btn.style.opacity = '1'; }
}

/** Renderiza la ficha (metadata + estado montaje) de una válvula/soporte. */
async function bimRenderCapaMeta(capa, id) {
    const index = bimState.capaIndex[capa] || {};
    const row = index[id.toLowerCase()];
    const label = row?._label || id;

    // Campos a mostrar según capa
    const fields = capa === 'valvula' ? [
        { label: 'ID Válvula',  value: row?.['ID_VALVULA'] },
        { label: 'Línea',       value: row?.['ID_LINEA'] },
        { label: 'Clase',       value: row?.['CLASE'] },
        { label: 'Diámetro',    value: row?.['DIAM.'] },
        { label: 'Descripción', value: row?.['DESCRIPCION'] }
    ] : [
        { label: 'ID Soporte',  value: row?.['ID_Soporte'] },
        { label: 'ITEM',        value: row?.['ITEM'] },
        { label: 'Tipo',        value: row?.['ID_TipoSoporte'] },
        { label: 'Línea',       value: row?.['ID_LINEA'] },
        { label: 'Diámetro',    value: row?.['DIAM.'] }
    ];

    const cards = fields.filter(f => f.value).map(f => `
        <div class="bim-meta-card">
            <span class="bim-meta-icon-sm"><i class="fas fa-tag"></i></span>
            <div><span class="bim-meta-label">${f.label}</span><span class="bim-meta-value">${f.value}</span></div>
        </div>`).join('');

    bimSetMeta(`
        <div class="bim-meta-header"><i class="fas fa-faucet"></i><span>${label}</span></div>
        <div class="bim-meta-cards">${cards}</div>
        <div id="bim-capa-montaje" style="margin-top:10px;font-size:0.82rem;opacity:0.7;">Consultando estado de montaje...</div>`);

    // Estado de montaje real (REG_Montaje*)
    try {
        const r = await fetch(`/api/bim/${capa}/item/${encodeURIComponent(id)}`);
        const d = await r.json();
        const el = document.getElementById('bim-capa-montaje');
        if (el) {
            const montado = d.montado;
            el.innerHTML = `<span class="status-pill ${montado ? 'pill-green' : 'pill-red'}">
                ${montado ? '✅ ' + (d.status || 'Montado') : '⏳ Pendiente de montaje'}</span>`;
        }
    } catch (e) { /* silencioso */ }
}

/**
 * Desvincula el o los elementos seleccionados de su spool actual en AppSheet.
 */
async function bimRemoveLink() {
    const elements = bimState.selectedElements;
    if (!elements || elements.length === 0) {
        alert('Selecciona al menos un elemento para desvincular.');
        return;
    }

    if (!confirm(`¿Estás seguro de que deseas desvincular estos ${elements.length} elementos de su ${BIM_CAPA_UI[bimState.capa].label.toLowerCase()} actual?`)) {
        return;
    }

    // Escritura protegida: exigir clave de edición BIM antes de guardar.
    const desbloqueado = await authAsegurar('bim');
    if (!desbloqueado) return;

    const unlinkBtn = document.getElementById('bim-unlink-btn');
    let originalText = '';
    if (unlinkBtn) {
        originalText = unlinkBtn.innerHTML;
        unlinkBtn.innerHTML = `<i class="fas fa-sync-alt fa-spin"></i> Desvinculando...`;
        unlinkBtn.disabled = true;
        unlinkBtn.style.opacity = '0.7';
    }

    try {
        const payload = {
            elements: elements.map(el => ({
                guid: el.guid
            }))
        };

        const endpoint = bimState.capa === 'spool' ? '/api/bim/desvincular' : `/api/bim/${bimState.capa}/desvincular`;
        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bim') },
            body: JSON.stringify(payload)
        });

        if (resp.status === 401) {
            authOlvidar('bim');
            alert('🔒 Clave de edición BIM incorrecta o expirada. Vuelve a intentar.');
            if (unlinkBtn) { unlinkBtn.innerHTML = originalText; unlinkBtn.disabled = false; unlinkBtn.style.opacity = '1'; }
            return;
        }

        if (!resp.ok) {
            let errMsg = `Error ${resp.status}`;
            try {
                const errData = await resp.json();
                errMsg = errData.error || errMsg;
            } catch (jsonErr) {
                try {
                    const textErr = await resp.text();
                    errMsg = textErr || errMsg;
                } catch (txtErr) {}
            }
            throw new Error(errMsg);
        }

        console.log(`[BIM] ${elements.length} elementos desvinculados con éxito en AppSheet.`);

        // Actualizar localmente la caché del mapeo (eliminar la asignación)
        if (bimState.capa === 'spool') {
            if (bimState.mapeoSpools) elements.forEach(el => { delete bimState.mapeoSpools[el.guid.toLowerCase()]; });
        } else if (bimState.capaMapeo[bimState.capa]) {
            elements.forEach(el => { delete bimState.capaMapeo[bimState.capa][el.guid.toLowerCase()]; });
        }

        // Feedback visual en el botón de desvincular
        if (unlinkBtn) {
            unlinkBtn.innerHTML = `<i class="fas fa-check"></i> Desvinculados`;
            unlinkBtn.style.background = '#059669';
            unlinkBtn.style.borderColor = '#059669';
            unlinkBtn.style.color = '#fff';
        }

        // Limpiar el color de theming del visor para los elementos desvinculados
        if (bimState.viewer) {
            bimState.viewer.clearThemingColors(bimState.viewer.model);
        }

        // Limpiar el formulario de vinculación en la UI
        const statusContainer = document.getElementById('bim-link-status-container');
        if (statusContainer) statusContainer.style.display = 'none';
        
        const linkSpoolInput = document.getElementById('bim-link-spool');
        if (linkSpoolInput) linkSpoolInput.value = '';

        // Forzar actualización de estados
        fetch('/api/bim/statuses')
            .then(r => r.json())
            .then(data => { bimState.statusesCache = data; })
            .catch(err => console.error('[BIM] Error actualizando estados:', err));

        // Limpiar la selección en el visor
        setTimeout(() => {
            if (unlinkBtn) {
                unlinkBtn.innerHTML = originalText;
                unlinkBtn.style.background = '';
                unlinkBtn.style.borderColor = '';
                unlinkBtn.style.color = '';
                unlinkBtn.disabled = false;
                unlinkBtn.style.opacity = '1';
            }
            const panel = document.getElementById('bim-link-panel');
            if (panel) panel.style.display = 'none';
            if (bimState.viewer) {
                bimState.viewer.select([]);
            }
        }, 1500);

    } catch (err) {
        console.error('[BIM Desvincular Error]', err);
        alert(`Error al desvincular elementos: ${err.message}`);
        if (unlinkBtn) { unlinkBtn.innerHTML = originalText; unlinkBtn.disabled = false; unlinkBtn.style.opacity = '1'; }
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

/** Guarda la vinculación de los elementos 3D seleccionados en AppSheet */
async function bimSaveLink() {
    const elements = bimState.selectedElements || [];
    if (elements.length === 0) {
        alert("Selecciona al menos un elemento en el visor 3D primero.");
        return;
    }

    const capa = bimState.capa;
    const input = document.getElementById('bim-link-spool');
    const spoolVal = input ? input.value.trim() : '';

    if (!spoolVal) {
        alert(capa === 'spool' ? "Ingresa un código de Spool (LUKEAPP)."
            : `Ingresa el ID de la ${BIM_CAPA_UI[capa].label}.`);
        if (input) input.focus();
        return;
    }

    // Escritura protegida: exigir clave de edición BIM antes de guardar.
    const desbloqueado = await authAsegurar('bim');
    if (!desbloqueado) return;

    const btn = document.getElementById('bim-link-btn');
    if (btn) {
        btn.innerHTML = `<i class="fas fa-sync-alt fa-spin"></i> Guardando ${elements.length}...`;
        btn.disabled = true;
        btn.style.opacity = '0.7';
    }

    try {
        const elementsPayload = elements.map(el => ({
            guid: el.guid,
            cwp: '',
            descripcion: el.name || 'ACPPPIPE',
            line_number: el.layer || '',
            tag: el.layer || '',
            autocad_size: ''
        }));

        // Spools usan /api/bim/vincular {spool}; válvulas/soportes /api/bim/:capa/vincular {item}
        // Para válvula/soporte resolvemos lo tecleado (ITEM/etiqueta) a la llave canónica.
        const endpoint = capa === 'spool' ? '/api/bim/vincular' : `/api/bim/${capa}/vincular`;
        const itemId = capa === 'spool' ? spoolVal : bimResolveCapaId(capa, spoolVal);
        const payload = capa === 'spool'
            ? { spool: spoolVal, elements: elementsPayload }
            : { item: itemId, elements: elementsPayload };

        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bim') },
            body: JSON.stringify(payload)
        });

        if (resp.status === 401) {
            authOlvidar('bim');
            alert('🔒 Clave de edición BIM incorrecta o expirada. Vuelve a intentar.');
            if (btn) { btn.innerHTML = `<i class="fas fa-save"></i> Guardar ${elements.length}`; btn.disabled = false; btn.style.opacity = '1'; }
            return;
        }

        if (!resp.ok) {
            let errMsg = `Error ${resp.status}`;
            try {
                const errData = await resp.json();
                errMsg = errData.error || errMsg;
            } catch (jsonErr) {
                try {
                    const textErr = await resp.text();
                    errMsg = textErr || errMsg;
                } catch (txtErr) {}
            }
            throw new Error(errMsg);
        }

        console.log(`[BIM] Mapeo de ${elements.length} elementos guardado con éxito en AppSheet.`);

        // Actualizar localmente el mapeo en memoria para reflejar la vinculación de inmediato
        if (capa === 'spool') {
            if (bimState.mapeoSpools) elements.forEach(el => { bimState.mapeoSpools[el.guid.toLowerCase()] = spoolVal; });
        } else {
            if (!bimState.capaMapeo[capa]) bimState.capaMapeo[capa] = {};
            elements.forEach(el => { bimState.capaMapeo[capa][el.guid.toLowerCase()] = itemId; });
        }
        
        // Feedback visual en el botón
        if (btn) {
            btn.innerHTML = `<i class="fas fa-check"></i> ¡${elements.length} Vinculados!`;
            btn.style.background = '#059669';
            btn.style.borderColor = '#059669';
            btn.style.color = '#fff';
        }

        // Colorear todos los elementos seleccionados en verde brillante como feedback visual
        if (bimState.viewer) {
            elements.forEach(el => {
                bimState.viewer.setThemingColor(el.dbId, new THREE.Vector4(0.18, 0.84, 0.44, 1), bimState.viewer.model, true);
            });
        }

        // Forzar actualización de la caché de estados en background
        fetch('/api/bim/statuses')
            .then(r => r.json())
            .then(data => { bimState.statusesCache = data; })
            .catch(err => console.error('[BIM] Error actualizando estados:', err));

        // Limpiar el input y la interfaz después de un momento
        setTimeout(() => {
            if (btn) {
                btn.innerHTML = '<i class="fas fa-save"></i> Guardar';
                btn.style.background = '';
                btn.style.borderColor = '';
                btn.style.color = '';
                btn.disabled = false;
                btn.style.opacity = '1';
            }
            // Ocultar panel de vinculación
            const panel = document.getElementById('bim-link-panel');
            if (panel) panel.style.display = 'none';
            // Limpiar selección del visor
            if (bimState.viewer) bimState.viewer.select([]);
        }, 2000);

    } catch (err) {
        console.error('[BIM] Error vinculando elementos:', err);
        alert(`No se pudo guardar la vinculación: ${err.message}`);
        if (btn) {
            btn.innerHTML = `<i class="fas fa-save"></i> Guardar ${elements.length}`;
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    }
}



// ============================================================
// BOT WHATSAPP — Panel de Configuración
// ============================================================
let botQrPollTimer = null;

async function botInitPanel() {
    const lock = document.getElementById('bot-lock');
    const content = document.getElementById('bot-content');

    // Exigir clave de administración del bot antes de mostrar QR/config/usuarios.
    const desbloqueado = await authAsegurar('bot');
    if (!desbloqueado) {
        if (lock) lock.style.display = 'flex';
        if (content) content.style.display = 'none';
        return;
    }
    if (lock) lock.style.display = 'none';
    if (content) content.style.display = '';

    botRefreshStatus();
    botRefreshQr();
    botCargarUsuarios();
    botCargarConfig();
    botCargarTools();

    // Poll suave del QR/estado mientras la sección esté visible
    if (botQrPollTimer) clearInterval(botQrPollTimer);
    botQrPollTimer = setInterval(() => {
        if (state.currentSection !== 'bot') {
            clearInterval(botQrPollTimer);
            botQrPollTimer = null;
            return;
        }
        botRefreshStatus(true);
        botRefreshQr(true);
    }, 15000);
}

async function botRefreshStatus(silencioso = false) {
    const badge = document.getElementById('bot-status-badge');
    if (!badge) return;
    if (!silencioso) badge.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Consultando...';

    try {
        const r = await fetch('/api/bot/status', { headers: authHeaders('bot') });
        const d = await r.json();

        const estados = {
            connected:      ['bot-ok',   'fa-check-circle',  'Conectado'],
            connecting:     ['bot-warn', 'fa-circle-notch fa-spin', 'Conectando...'],
            disconnected:   ['bot-warn', 'fa-exclamation-triangle', 'Desconectado'],
            bridge_offline: ['bot-err',  'fa-times-circle',  'Puente apagado (PM2)']
        };
        const [cls, icon, label] = estados[d.status] || estados.bridge_offline;
        badge.className = `bot-status-badge ${cls}`;
        badge.innerHTML = `<i class="fas ${icon}"></i> ${label}`;

        document.getElementById('bot-number').textContent =
            d.botNumber ? `+${d.botNumber}` : '— (sin vincular)';
        document.getElementById('bot-name').textContent = d.botName || '—';
        document.getElementById('bot-last-connected').textContent =
            d.lastConnectedAt ? new Date(d.lastConnectedAt).toLocaleString('es-CL') : '—';
    } catch (e) {
        badge.className = 'bot-status-badge bot-err';
        badge.innerHTML = '<i class="fas fa-times-circle"></i> Error consultando estado';
    }
}

async function botRefreshQr(silencioso = false) {
    const img = document.getElementById('bot-qr-img');
    const hint = document.getElementById('bot-qr-hint');
    if (!img || !hint) return;

    try {
        const r = await fetch('/api/bot/qr', { headers: authHeaders('bot') });
        const d = await r.json();

        if (d.qrDataUrl) {
            img.src = d.qrDataUrl;
            img.style.display = 'block';
            hint.textContent = '📲 Escanea este código desde WhatsApp > Dispositivos vinculados';
        } else {
            img.style.display = 'none';
            if (d.status === 'connected') {
                hint.textContent = `✅ Sesión vinculada${d.botNumber ? ' al +' + d.botNumber : ''}. No se necesita QR.`;
            } else if (d.status === 'bridge_offline') {
                hint.textContent = '🔌 El puente (wa-bridge) no responde. Revisa PM2 en el servidor.';
            } else {
                hint.textContent = '⏳ Generando QR... presiona "Refrescar QR" en unos segundos.';
            }
        }
    } catch (e) {
        if (!silencioso) hint.textContent = 'Error consultando el QR.';
    }
}

async function botRestart(logout) {
    const msg = logout
        ? '¿Desvincular la sesión de WhatsApp? Se borrarán las credenciales y deberás escanear un QR nuevo.'
        : '¿Reconectar el puente de WhatsApp?';
    if (!confirm(msg)) return;

    try {
        const r = await fetch('/api/bot/restart', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bot') },
            body: JSON.stringify({ logout })
        });
        const d = await r.json();
        alert(d.message || (d.success ? 'Listo' : 'Error: ' + (d.error || 'desconocido')));
        setTimeout(() => { botRefreshStatus(); botRefreshQr(); }, 3000);
    } catch (e) {
        alert('No se pudo contactar el puente: ' + e.message);
    }
}

async function botCargarUsuarios() {
    const body = document.getElementById('bot-users-body');
    if (!body) return;
    try {
        const r = await fetch('/api/bot/usuarios', { headers: authHeaders('bot') });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || 'Error');

        if (!d.usuarios.length) {
            body.innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:0.6;padding:20px;">Sin usuarios aún. Agrega el primero arriba.</td></tr>';
            return;
        }

        body.innerHTML = d.usuarios.map(u => {
            const tel = u.telefono;
            const rolesOpts = ['Terreno','Supervisor','Admin','OT','QAQC'].map(r =>
                `<option value="${r}" ${(u.rol||'Terreno')===r?'selected':''}>${r}</option>`
            ).join('');
            return `
            <tr id="urow-${tel}">
                <td>+${tel}</td>
                <td class="ucell-nombre-${tel}">${u.nombre || '—'}</td>
                <td class="ucell-rol-${tel}">${u.rol || 'Terreno'}</td>
                <td>
                    <span class="status-pill ${u.activo ? 'pill-green' : 'pill-red'}">
                        ${u.activo ? 'Activo' : 'Pendiente'}
                    </span>
                </td>
                <td style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
                    <button class="refresh-btn" style="padding:4px 10px;font-size:0.75rem"
                        onclick="botToggleUsuario('${tel}', ${!u.activo})">
                        ${u.activo ? 'Desactivar' : 'Autorizar'}
                    </button>
                    <button class="refresh-btn" style="padding:4px 10px;font-size:0.75rem;background:rgba(99,102,241,0.2);border-color:rgba(99,102,241,0.5)"
                        onclick="botEditarUsuario('${tel}')" title="Editar nombre / rol">
                        ✏️ Editar
                    </button>
                </td>
            </tr>
            <tr id="urow-edit-${tel}" style="display:none;background:rgba(99,102,241,0.07)">
                <td colspan="5" style="padding:10px 14px">
                    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                        <input id="uedit-nombre-${tel}" type="text" placeholder="Nombre y apellido"
                            value="${(u.nombre||'').replace(/"/g,'&quot;')}"
                            style="flex:1;min-width:150px;background:rgba(15,23,42,0.8);border:1px solid rgba(99,102,241,0.4);border-radius:8px;padding:7px 10px;color:#f1f5f9;font-family:inherit;font-size:0.85rem">
                        <select id="uedit-rol-${tel}"
                            style="background:rgba(15,23,42,0.8);border:1px solid rgba(99,102,241,0.4);border-radius:8px;padding:7px 10px;color:#f1f5f9;font-family:inherit;font-size:0.85rem">
                            ${rolesOpts}
                        </select>
                        <button class="refresh-btn" style="padding:5px 14px;font-size:0.8rem;background:rgba(16,185,129,0.2);border-color:rgba(16,185,129,0.5);color:#6ee7b7"
                            onclick="botGuardarEdicion('${tel}')">
                            ✓ Guardar
                        </button>
                        <button class="refresh-btn" style="padding:5px 14px;font-size:0.8rem"
                            onclick="botCancelarEdicion('${tel}')">
                            Cancelar
                        </button>
                    </div>
                </td>
            </tr>`;
        }).join('');
    } catch (e) {
        body.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#ef4444;padding:20px;">Error: ${e.message}</td></tr>`;
    }
}

function botEditarUsuario(tel) {
    // Obtener valores actuales directamente de las celdas
    const nombreCelda = document.querySelector(`.ucell-nombre-${tel}`);
    const nombreVal = nombreCelda ? (nombreCelda.textContent || '').trim().replace(/^—$/, '') : '';
    
    // Asignar al input de edicion por si el usuario lo cambio antes
    const inp = document.getElementById('uedit-nombre-' + tel);
    if (inp) {
        inp.value = nombreVal;
    }

    // Mostrar fila de edicion
    const editRow = document.getElementById('urow-edit-' + tel);
    if (editRow) editRow.style.display = '';
    if (inp) { inp.focus(); inp.select(); }
}
function botCancelarEdicion(tel) {
    const editRow = document.getElementById('urow-edit-' + tel);
    if (editRow) editRow.style.display = 'none';
}
async function botGuardarEdicion(tel) {
    const nombre = (document.getElementById('uedit-nombre-' + tel)?.value || '').trim();
    const rol    = document.getElementById('uedit-rol-' + tel)?.value || 'Terreno';
    if (!nombre) { alert('El nombre no puede estar vacío.'); return; }
    try {
        const r = await fetch('/api/bot/usuarios/' + tel, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bot') },
            body: JSON.stringify({ nombre, rol })
        });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || 'Error');
        botCargarUsuarios(); // recarga la tabla completa
    } catch (e) {
        alert('Error guardando: ' + e.message);
    }
}

async function botToggleUsuario(telefono, activo) {
    try {
        await fetch(`/api/bot/usuarios/${telefono}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bot') },
            body: JSON.stringify({ activo })
        });
        botCargarUsuarios();
    } catch (e) {
        alert('Error actualizando usuario: ' + e.message);
    }
}

async function botAgregarUsuario() {
    const telefono = document.getElementById('bot-user-telefono').value.trim();
    const nombre = document.getElementById('bot-user-nombre').value.trim();
    const rol = document.getElementById('bot-user-rol').value;

    if (!telefono || !nombre) {
        alert('Completa teléfono y nombre.');
        return;
    }

    try {
        const r = await fetch('/api/bot/usuarios', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bot') },
            body: JSON.stringify({ telefono, nombre, rol })
        });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || 'Error');
        document.getElementById('bot-user-telefono').value = '';
        document.getElementById('bot-user-nombre').value = '';
        botCargarUsuarios();
    } catch (e) {
        alert('Error agregando usuario: ' + e.message);
    }
}

async function botCargarConfig() {
    const runtimeEl = document.getElementById('bot-config-list');
    const envEl = document.getElementById('bot-env-list');
    if (!runtimeEl || !envEl) return;

    try {
        const r = await fetch('/api/config', { headers: authHeaders('bot') });
        const d = await r.json();

        // --- Config runtime (editable) ---
        if (d.runtimeError) {
            runtimeEl.innerHTML = `<p style="color:#f59e0b;font-size:0.85rem">⚠️ Supabase no disponible: ${d.runtimeError}</p>`;
        } else {
            runtimeEl.innerHTML = d.runtime.map(c => `
                <div class="bot-config-item">
                    <div class="bot-config-meta">
                        <span class="bot-config-key">${c.clave}</span>
                        <span class="bot-config-desc">${c.descripcion || ''}</span>
                    </div>
                    <div class="bot-config-edit">
                        <input type="text" id="conf-${c.clave}" value="${String(c.valor).replace(/"/g, '&quot;')}">
                        <button class="refresh-btn" style="padding:4px 10px;font-size:0.75rem"
                            onclick="botGuardarConfig('${c.clave}')">💾</button>
                    </div>
                </div>
            `).join('');
        }

        // --- Entorno (solo lectura, secretos enmascarados) ---
        envEl.innerHTML = Object.entries(d.env).map(([k, v]) => {
            if (v.secreto) {
                const ok = v.configurada;
                return `<div class="bot-config-item">
                    <span class="bot-config-key">${k}</span>
                    <span class="status-pill ${ok ? 'pill-green' : 'pill-red'}">
                        ${ok ? '🔒 Configurada' : '✗ Falta'}
                    </span>
                </div>`;
            }
            return `<div class="bot-config-item">
                <span class="bot-config-key">${k}</span>
                <span class="bot-config-desc">${v.valor === '' ? '—' : v.valor}</span>
            </div>`;
        }).join('');
    } catch (e) {
        runtimeEl.innerHTML = `<p style="color:#ef4444">Error: ${e.message}</p>`;
    }
}

async function botGuardarConfig(clave) {
    const input = document.getElementById(`conf-${clave}`);
    if (!input) return;
    try {
        const r = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bot') },
            body: JSON.stringify({ clave, valor: input.value })
        });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || 'Error');
        input.style.borderColor = '#10b981';
        setTimeout(() => { input.style.borderColor = ''; }, 1500);
    } catch (e) {
        alert('Error guardando: ' + e.message);
    }
}


// ============================================================
// CONTROL DE ACCESO (escritura) — frontend
// Lectura abierta; escritura pide clave por área (bim / bot).
// El token se guarda en localStorage y se valida en el servidor.
// ============================================================
const AUTH_LABELS = {
    bim: { titulo: 'Edición BIM', desc: 'Ingresa la clave para vincular elementos 3D a spools.' },
    bot: { titulo: 'Administración del Bot', desc: 'Ingresa la clave para administrar el bot de WhatsApp.' }
};

function authGuardar(area, token, expiraEnHoras) {
    const exp = Date.now() + (expiraEnHoras || 12) * 3600 * 1000;
    localStorage.setItem(`andina_tok_${area}`, JSON.stringify({ token, exp }));
}

function authObtener(area) {
    try {
        const raw = localStorage.getItem(`andina_tok_${area}`);
        if (!raw) return null;
        const { token, exp } = JSON.parse(raw);
        if (!exp || Date.now() > exp) { authOlvidar(area); return null; }
        return token;
    } catch (e) { return null; }
}

function authOlvidar(area) {
    localStorage.removeItem(`andina_tok_${area}`);
}

function authHeaders(area) {
    const t = authObtener(area);
    return t ? { 'x-edit-token': t } : {};
}

/** Garantiza que exista un token válido para el área; si no, pide la clave. */
async function authAsegurar(area) {
    if (authObtener(area)) return true;
    const clave = await authPedirClave(area);
    if (clave === null) return false; // cancelado
    try {
        const r = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clave })
        });
        const d = await r.json();
        if (!d.success) {
            alert('🔒 Clave incorrecta.');
            return false;
        }
        // Una clave puede otorgar varios permisos: guardar el token para cada uno.
        (d.permisos || []).forEach(p => authGuardar(p, d.token, d.expiraEnHoras));
        return (d.permisos || []).includes(area);
    } catch (e) {
        alert('Error validando la clave: ' + e.message);
        return false;
    }
}

/** Modal de clave. Devuelve la clave (string) o null si se cancela. */
function authPedirClave(area) {
    const info = AUTH_LABELS[area] || { titulo: 'Acceso', desc: 'Ingresa la clave.' };
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'auth-modal-overlay';
        overlay.innerHTML = `
            <div class="auth-modal">
                <div class="auth-modal-icon"><i class="fas fa-lock"></i></div>
                <h3>${info.titulo}</h3>
                <p>${info.desc}</p>
                <input type="password" id="auth-modal-input" placeholder="Clave" autocomplete="off">
                <div class="auth-modal-error" id="auth-modal-error"></div>
                <div class="auth-modal-actions">
                    <button class="auth-btn-cancel" id="auth-modal-cancel">Cancelar</button>
                    <button class="auth-btn-ok" id="auth-modal-ok">Desbloquear</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);

        const input = overlay.querySelector('#auth-modal-input');
        const cerrar = (val) => { overlay.remove(); resolve(val); };

        overlay.querySelector('#auth-modal-cancel').onclick = () => cerrar(null);
        overlay.querySelector('#auth-modal-ok').onclick = () => cerrar(input.value);
        overlay.addEventListener('click', e => { if (e.target === overlay) cerrar(null); });
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') cerrar(input.value);
            if (e.key === 'Escape') cerrar(null);
        });
        setTimeout(() => input.focus(), 50);
    });
}

// Botón dentro del panel Bot para reintentar el desbloqueo manualmente.
async function botDesbloquear() {
    const ok = await authAsegurar('bot');
    if (ok) botInitPanel();
}


// ============================================================
// BOT — Catálogo de herramientas dinámicas (mapa del mundo)
// ============================================================
async function botCargarTools() {
    const body = document.getElementById('bot-tools-body');
    if (!body) return;
    try {
        const r = await fetch('/api/bot/tools', { headers: authHeaders('bot') });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || 'Error');

        if (!d.tools.length) {
            body.innerHTML = '<tr><td colspan="5" style="text-align:center;opacity:0.6;padding:20px;">Aún no hay herramientas. Se crearán solas cuando un supervisor haga consultas de datos al bot.</td></tr>';
            return;
        }

        body.innerHTML = d.tools.map(t => `
            <tr>
                <td style="font-family:monospace;font-size:0.78rem;color:#818cf8">${t.nombre_funcion}</td>
                <td style="font-size:0.8rem;opacity:0.8">${t.descripcion || ''}</td>
                <td style="text-align:center">${t.usos || 0}</td>
                <td style="font-size:0.8rem">${t.creada_por || '—'}</td>
                <td>
                    <button class="refresh-btn bot-btn-danger" style="padding:4px 10px;font-size:0.72rem"
                        onclick="botBorrarTool('${t.nombre_funcion}')" title="Eliminar herramienta">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (e) {
        body.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#ef4444;padding:20px;">Error: ${e.message}</td></tr>`;
    }
}

async function botBorrarTool(nombre) {
    if (!confirm(`¿Eliminar la herramienta "${nombre}"? El bot la volverá a crear si alguien repite la consulta.`)) return;
    try {
        await fetch(`/api/bot/tools/${encodeURIComponent(nombre)}`, {
            method: 'DELETE',
            headers: authHeaders('bot')
        });
        botCargarTools();
    } catch (e) {
        alert('Error eliminando herramienta: ' + e.message);
    }
}

/**
 * Abre el visualizador de PDF.
 * En PC divide la pantalla (Split Screen), en móviles abre un modal emergente.
 * Usa el proxy del backend para evitar restricciones de X-Frame-Options.
 */
function bimOpenPdf(url) {
    const proxyUrl = `/api/iso/proxy-pdf?url=${encodeURIComponent(url)}`;

    if (window.innerWidth > 1024) {
        // En PC: Pantalla dividida (Split Screen)
        const splitPanel = document.getElementById('bim-pdf-split-panel');
        const splitIframe = document.getElementById('bim-pdf-split-iframe');
        const resizeBar = document.getElementById('bim-pdf-resize-bar');
        if (splitPanel && splitIframe) {
            splitIframe.src = proxyUrl;
            splitPanel.style.display = 'flex';
            if (resizeBar) resizeBar.style.display = 'flex';
            
            // Forzar resize del visor 3D para ajustarse al nuevo ancho
            if (bimState.viewer) {
                setTimeout(() => {
                    bimState.viewer.resize();
                }, 150);
            }
        }
    } else {
        // En Móvil: Modal flotante
        const modal = document.getElementById('pdf-viewer-modal');
        const iframe = document.getElementById('pdf-viewer-iframe');
        if (modal && iframe) {
            iframe.src = proxyUrl;
            modal.style.display = 'flex';
        }
    }
}

/**
 * Cierra la visualización en pantalla dividida (PC).
 */
function closePdfSplit() {
    const splitPanel = document.getElementById('bim-pdf-split-panel');
    const splitIframe = document.getElementById('bim-pdf-split-iframe');
    const resizeBar = document.getElementById('bim-pdf-resize-bar');
    if (splitPanel && splitIframe) {
        splitPanel.style.display = 'none';
        if (resizeBar) resizeBar.style.display = 'none';
        splitIframe.src = '';
        
        // Restablecer el ancho del panel por defecto al cerrar
        splitPanel.style.width = '48%';
        splitPanel.style.flex = '';

        // Forzar resize del visor 3D para ocupar el 100% de nuevo
        if (bimState.viewer) {
            setTimeout(() => {
                bimState.viewer.resize();
            }, 150);
        }
    }
}

/**
 * Cierra el visualizador de PDF (ambos modos).
 */
function closePdfModal() {
    const modal = document.getElementById('pdf-viewer-modal');
    const iframe = document.getElementById('pdf-viewer-iframe');
    if (modal && iframe) {
        modal.style.display = 'none';
        iframe.src = '';
    }
    closePdfSplit();
}

/**
 * Obtiene el valor seleccionado en el selector de hojas y lo abre en el visualizador.
 */
function bimOpenSelectedPdf() {
    const select = document.getElementById('bim-pdf-sheets-select');
    if (select && select.value) {
        bimOpenPdf(select.value);
    }
}

/**
 * Obtiene el valor seleccionado en el selector de PIDs y lo abre en el visualizador.
 */
function bimOpenSelectedPid() {
    const select = document.getElementById('bim-pdf-pids-select');
    if (select && select.value) {
        bimOpenPdf(select.value);
    }
}


/**
 * Inicializa el sistema de redimensionamiento de pantalla dividida (Splitter Bar).
 * Permite arrastrar el divisor en PC para redimensionar el visor 3D y el plano PDF.
 */
function initBimSplitResizer() {
    const resizeBar = document.getElementById('bim-pdf-resize-bar');
    const splitPanel = document.getElementById('bim-pdf-split-panel');
    const bimLayout = document.querySelector('.bim-layout');
    const bimSidebar = document.querySelector('.bim-sidebar');
    const splitIframe = document.getElementById('bim-pdf-split-iframe');

    if (!resizeBar || !splitPanel || !bimLayout) return;

    let isDragging = false;

    resizeBar.addEventListener('mousedown', function (e) {
        e.preventDefault();
        isDragging = true;
        resizeBar.classList.add('dragging');
        
        // Evitar que el iframe capture eventos del mouse durante el arrastre
        if (splitIframe) {
            splitIframe.style.pointerEvents = 'none';
        }
        
        document.body.style.cursor = 'col-resize';
    });

    document.addEventListener('mousemove', function (e) {
        if (!isDragging) return;

        // Calcular anchos dinámicos
        const layoutRect = bimLayout.getBoundingClientRect();
        const sidebarWidth = bimSidebar ? bimSidebar.clientWidth : 0;
        
        // Ancho total divisible restante (Visor 3D + Divisor + PDF)
        const totalDivisibleWidth = layoutRect.width - sidebarWidth - resizeBar.clientWidth;
        
        // Posición del cursor respecto a la sección divisible
        const mouseX = e.clientX - layoutRect.left - sidebarWidth;
        
        // El ancho asignado al PDF (derecha)
        const pdfWidth = totalDivisibleWidth - mouseX;

        // Límites de seguridad (mínimo 300px para cada lado)
        const minWidth = 300;
        const maxWidth = totalDivisibleWidth - 300;
        const finalWidth = Math.max(minWidth, Math.min(maxWidth, pdfWidth));

        // Aplicar ancho exacto al panel de PDF
        splitPanel.style.width = finalWidth + 'px';
        splitPanel.style.flex = 'none';

        // Redimensionar el visor 3D de Autodesk al vuelo
        if (bimState.viewer) {
            bimState.viewer.resize();
        }
    });

    document.addEventListener('mouseup', function () {
        if (isDragging) {
            isDragging = false;
            resizeBar.classList.remove('dragging');
            
            // Reactivar eventos del mouse en el iframe
            if (splitIframe) {
                splitIframe.style.pointerEvents = 'auto';
            }
            
            document.body.style.cursor = '';
            
            // Redimensionar una vez más al final
            if (bimState.viewer) {
                bimState.viewer.resize();
            }
        }
    });
}


// ============================================================================
// PUENTE A window — obligatorio con <script type="module">
// ----------------------------------------------------------------------------
// Con módulos ESM nada es global. index.html usa handlers onclick inline y
// bim-ifc-export.js se carga como script clásico, así que ambos resuelven
// contra window. Este bloque debe seguir cubriendo todo lo que se invoque
// desde HTML: si una función se renombra aquí, el botón deja de responder.
// ============================================================================
if (typeof window !== 'undefined') {
    window.authAsegurar             = authAsegurar;
    window.authHeaders              = authHeaders;
    window.authObtener              = authObtener;
    window.authOlvidar              = authOlvidar;
    window.bimCloseScanner          = bimCloseScanner;
    window.bimCloseSidebar          = bimCloseSidebar;
    window.bimDividirDeshacer       = bimDividirDeshacer;
    window.bimDividirFinalizar      = bimDividirFinalizar;
    window.bimDividirRestaurar      = bimDividirRestaurar;
    window.bimFitToView             = bimFitToView;
    window.bimFlipCamera            = bimFlipCamera;
    window.bimGuardarColorEstado    = bimGuardarColorEstado;
    window.bimIsolateElements       = bimIsolateElements;
    window.bimLimpiarFiltroEstados  = bimLimpiarFiltroEstados;
    window.bimOpenPdf               = bimOpenPdf;
    window.bimOpenScanner           = bimOpenScanner;
    window.bimOpenSelectedPdf       = bimOpenSelectedPdf;
    window.bimOpenSelectedPid       = bimOpenSelectedPid;
    window.bimRemoveLink            = bimRemoveLink;
    window.bimResetView             = bimResetView;
    window.bimSaveLink              = bimSaveLink;
    window.bimSearchSpool           = bimSearchSpool;
    window.bimSetCapa               = bimSetCapa;
    window.bimSetMeta               = bimSetMeta;
    window.bimState                 = bimState;
    window.bimStatusPorGuid         = bimStatusPorGuid;
    window.bimToggleEstado          = bimToggleEstado;
    window.bimToggleMetaExtra       = bimToggleMetaExtra;
    window.bimToggleSidebar         = bimToggleSidebar;
    window.bimToggleUnlinkMenu      = bimToggleUnlinkMenu;
    window.bimTrozoDesvincular      = bimTrozoDesvincular;
    window.bimTrozoEditarDivision   = bimTrozoEditarDivision;
    window.bimTrozoEliminarDivision = bimTrozoEliminarDivision;
    window.bimTrozoVincular         = bimTrozoVincular;
    window.botAgregarUsuario        = botAgregarUsuario;
    window.botBorrarTool            = botBorrarTool;
    window.botCancelarEdicion       = botCancelarEdicion;
    window.botDesbloquear           = botDesbloquear;
    window.botEditarUsuario         = botEditarUsuario;
    window.botGuardarConfig         = botGuardarConfig;
    window.botGuardarEdicion        = botGuardarEdicion;
    window.botRefreshQr             = botRefreshQr;
    window.botRefreshStatus         = botRefreshStatus;
    window.botRestart               = botRestart;
    window.botToggleUsuario         = botToggleUsuario;
    window.changeWeek               = changeWeek;
    window.closePdfModal            = closePdfModal;
    window.closePdfSplit            = closePdfSplit;
    window.copyLogisticaTable       = copyLogisticaTable;
    window.divState                 = divState;
    window.filterSDI                = filterSDI;
    // formatDate, getEstado, getEtapaBadge, getJuntaId, getMaxEtapa, getVal,
    // getWeekOfDate y parseDate los expone ./utils/dataHelpers.js
    window.initBimViewer            = initBimViewer;
    window.loadLogistica            = loadLogistica;
    window.loadLogisticaDetail      = loadLogisticaDetail;
    window.refreshData              = refreshData;
    window.renderCurrentSection     = renderCurrentSection;
    window.renderQC                 = renderQC;
    window.renderSDI                = renderSDI;
    window.renderSpools             = renderSpools;
    // renderOverview y renderJuntas los exponen sus propios componentes;
    // renderBarChart, renderJuntasBreakdown, renderLogTable, renderSCurve y
    // renderWelderChart los expone ./components/charts.js
    window.showSection              = showSection;
    window.toggleJuntaCol           = toggleJuntaCol;
    window.toggleWelderHistory      = toggleWelderHistory;
}
