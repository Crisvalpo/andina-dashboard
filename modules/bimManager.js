/**
 * BIM Viewer & 3D Layer Management Module (APS / Autodesk Viewer)
 * Andina Piping Dashboard
 */
import { state } from './state.js';
import { authObtener, authAsegurar, authHeaders } from './auth.js';

export const bimState = {
    viewer:        null,   // Instancia del Autodesk.Viewing.GuiViewer3D
    initialized:   false,  // true cuando el modelo ya cargó
    sdkLoaded:     false,  // true cuando el script del SDK ya está en el DOM
    currentGuids:  [],     // GUIDs del spool actualmente seleccionado
    dbIds:         [],     // dbIds correspondientes en el viewer
    token:         null,
    modelUrn:      null,
    statusesCache: null,   // Caché de { status: [guids] }
    selectedElement: null, // Elemento 3D clickeado actualmente
    selectedElements: [], // Múltiples elementos 3D clickeados
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

export const BIM_CAPA_UI = {
    spool:   { label: 'Spool',   buscar: 'Buscar Spool',   placeholder: 'TAG Gestión (ej: 217)' },
    valvula: { label: 'Válvula', buscar: 'Buscar Válvula', placeholder: 'ID Válvula (ej: VAL113)' },
    soporte: { label: 'Soporte', buscar: 'Buscar Soporte', placeholder: 'ID/ITEM Soporte (ej: 148)' }
};

export const BIM_STATUS_COLORS = {
    'EN FABRICACIÓN':  [0.91, 0.70, 0.03, 1], // #eab308 (amarillo)
    'QAQC':            [0.15, 0.78, 0.85, 1], // #26c6da (cyan / turquesa)
    'EN PINT/REVEST.': [0.55, 0.36, 0.96, 1], // #8b5cf6 (púrpura)
    'RETIRAR':         [0.94, 0.27, 0.27, 1], // #ef4444 (rojo)
    'POR MONTAR':      [0.22, 0.74, 0.97, 1], // #38bdf8 (celeste)
    'POSICIONADO':     [0.98, 0.55, 0.00, 1], // #fb8c00 (naranja brillante)
    'MONTADO':         [0.06, 0.73, 0.51, 1], // #10b981 (verde esmeralda)
    'ELIMINADO':       [0.39, 0.45, 0.55, 1], // #64748b (gris slate)
    'SIN REGISTRO':    [0.20, 0.25, 0.33, 1]  // #334155 (oscuro)
};

export const BIM_ORDEN_FLUJO = [
    'EN FABRICACIÓN', 'QAQC', 'EN PINT/REVEST.',
    'RETIRAR', 'POR MONTAR', 'POSICIONADO', 'MONTADO'
];

export async function bimSetCapa(capa) {
    if (!BIM_CAPA_UI[capa]) return;
    if (typeof bimLiveStop === 'function') bimLiveStop();
    bimState.capa = capa;

    document.querySelectorAll('.bim-capa-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`bim-capa-${capa}`);
    if (btn) btn.classList.add('active');

    const lbl = document.getElementById('bim-search-label');
    if (lbl) lbl.innerHTML = `<i class="fas fa-search"></i> ${BIM_CAPA_UI[capa].buscar}`;
    const inp = document.getElementById('bim-search-input');
    if (inp) { inp.placeholder = BIM_CAPA_UI[capa].placeholder; inp.value = ''; }

    if (bimState.viewer) { bimState.viewer.clearThemingColors(bimState.viewer.model); bimState.viewer.select([]); }
    const panel = document.getElementById('bim-link-panel');
    if (panel) panel.style.display = 'none';
    bimSetMeta(`<div class="bim-meta-placeholder"><i class="fas fa-cube bim-meta-icon"></i><p>Capa: <strong>${BIM_CAPA_UI[capa].label}s</strong>. Selecciona un elemento en el modelo o busca por su ID.</p></div>`);

    bimUpdateStatusFilterOptions(capa);

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

export async function bimUpdateStatusFilterOptions(capa) {
    bimState.filtroEstados.clear();
    if (capa === 'spool') {
        bimRenderStatusChips();
    } else {
        bimState.capaStatuses = null;
        bimRenderStatusChips();
        try {
            bimState.capaStatuses = await (await fetch(`/api/bim/${capa}/statuses`)).json();
        } catch (e) { bimState.capaStatuses = {}; }
        bimRenderStatusChips();
    }
}

export async function initBimViewer() {
    const urlParams   = new URLSearchParams(window.location.search);
    const spoolParam  = urlParams.get('spool');

    if (bimState.initialized) {
        if (spoolParam && typeof bimLoadSpool === 'function') bimLoadSpool(spoolParam);
        return;
    }

    bimSetLoader('Obteniendo token APS...');

    try {
        const resp = await fetch('/api/bim/token');
        if (!resp.ok) throw new Error(`Error ${resp.status} obteniendo token APS`);
        const data = await resp.json();
        bimState.token    = data.access_token;
        bimState.modelUrn = data.model_urn;

        if (!bimState.modelUrn || bimState.modelUrn === 'TU_URN_DEL_MODELO_EN_BASE64_AQUI') {
            document.getElementById('bim-loader').style.display    = 'none';
            document.getElementById('bim-urn-missing').style.display = 'flex';
            return;
        }

        if (!bimState.sdkLoaded) {
            bimSetLoader('Cargando SDK del visor 3D...');
            await bimLoadSdk();
            bimState.sdkLoaded = true;
        }

        bimSetLoader('Inicializando visor...');
        await bimStartViewer();

        if (spoolParam && typeof bimLoadSpool === 'function') {
            document.getElementById('bim-search-input').value = spoolParam;
            await bimLoadSpool(spoolParam);
        }

    } catch (err) {
        console.error('[BIM] Error inicializando visor:', err);
        bimSetLoader(`❌ Error: ${err.message}`, true);
    }
}

export function bimLoadSdk() {
    return new Promise((resolve, reject) => {
        if (window.Autodesk) { resolve(); return; }
        const script = document.createElement('script');
        script.src = 'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/viewer3D.min.js';
        script.onload  = resolve;
        script.onerror = () => reject(new Error('No se pudo cargar el SDK de Autodesk Viewer'));
        document.head.appendChild(script);
    });
}

export function bimStartViewer() {
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
            viewer.setGhosting(true);

            bimSetLoader('Cargando modelo 3D...');

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
                            if (bimState.filtroEstados.size > 0) {
                                bimAplicarFiltroEstados();
                            }
                        }).catch(err => console.error('[BIM] Error precargando datos iniciales:', err));

                        fetch('/api/bim/spool-index')
                            .then(r => r.json())
                            .then(data => { bimState.spoolIndex = data; })
                            .catch(err => console.error('[BIM] Error precargando índice de spools:', err));

                        if (typeof bimDividirInit === 'function') bimDividirInit();
                        if (typeof bimIsoColorInit === 'function') bimIsoColorInit();

                        viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, (event) => {
                            const dbIdArray = event.dbIdArray;
                            const panel = document.getElementById('bim-link-panel');
                            
                            if (dbIdArray && dbIdArray.length > 0) {
                                const skipAuto = bimState.isAutoSelecting;

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

                                            if (bimState.capa !== 'spool') {
                                                if (typeof bimRenderCapaSelection === 'function') bimRenderCapaSelection(bimState.capa, selectedList, uniqueLayers);
                                                if (panel) panel.style.display = authObtener('bim') ? 'flex' : 'none';
                                                return;
                                            }

                                            if (selectedList.length === 1 && bimState.mapeoSpools && !skipAuto) {
                                                const selectedGuid = selectedList[0].guid.toLowerCase();
                                                const spoolTag = bimState.mapeoSpools[selectedGuid];
                                                if (spoolTag) {
                                                    const guidsDelSpool = Object.entries(bimState.mapeoSpools)
                                                        .filter(([g, s]) => s.toLowerCase() === spoolTag.toLowerCase())
                                                        .map(([g, s]) => g);

                                                    if (guidsDelSpool.length > 1 && typeof bimGuidsToDbIds === 'function') {
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

                                            const linkTitle = document.querySelector('#bim-link-panel h4');
                                            if (linkTitle) {
                                                linkTitle.innerHTML = `<i class="fas fa-link"></i> Vincular (${selectedList.length} selec.)`;
                                            }

                                            const guidEl = document.getElementById('bim-link-guid');
                                            if (guidEl) guidEl.textContent = selectedList.length === 1
                                                ? selectedList[0].guid
                                                : `${selectedList.length} elementos seleccionados`;

                                            const layerEl = document.getElementById('bim-link-layer');
                                            if (layerEl) layerEl.textContent = uniqueLayers.size > 0
                                                ? Array.from(uniqueLayers).join(', ')
                                                : 'N/A';

                                            const gruposPorSpool = {};
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
                                                if (infoEl && typeof bimRenderSpoolInfo === 'function') infoEl.innerHTML = bimRenderSpoolInfo(spoolsDistintos);
                                                if (linkSpoolInput) linkSpoolInput.value = commonSpool !== 'Múltiples Spools' ? commonSpool : '';

                                                if (commonSpool !== 'Múltiples Spools') {
                                                    fetch(`/api/bim/spool/${encodeURIComponent(commonSpool)}`)
                                                        .then(r => r.json())
                                                        .then(spoolData => {
                                                            if (spoolData && spoolData.spool_id && typeof bimRenderMeta === 'function') {
                                                                bimRenderMeta(spoolData);
                                                            }
                                                        })
                                                        .catch(err => console.error('[BIM] Error cargando metadata:', err));
                                                } else {
                                                    if (typeof bimRenderMultiSpoolMeta === 'function') bimSetMeta(bimRenderMultiSpoolMeta(spoolsDistintos));
                                                    const listEl = document.getElementById('bim-elements-list');
                                                    if (listEl) listEl.style.display = 'none';
                                                }
                                            } else {
                                                if (statusContainer) statusContainer.style.display = 'none';
                                                if (linkSpoolInput) linkSpoolInput.value = '';

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

                                            const btn = document.getElementById('bim-link-btn');
                                            if (btn) {
                                                btn.innerHTML = `<i class="fas fa-save"></i> Guardar ${selectedList.length} elem.`;
                                                btn.disabled = false;
                                                btn.style.opacity = '1';
                                            }

                                            if (panel) panel.style.display = authObtener('bim') ? 'flex' : 'none';
                                            
                                            const sidebar = document.querySelector('.bim-sidebar');
                                            if (sidebar && window.innerWidth <= 1024 && !sidebar.classList.contains('open')) {
                                                if (typeof bimToggleSidebar === 'function') bimToggleSidebar();
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
                (code, message) => reject(new Error(`Error ${code} cargando modelo: ${message}`))
            );
        });
    });
}

export function bimSetLoader(msg, isError = false) {
    const loader = document.getElementById('bim-loader');
    const txt    = document.getElementById('bim-loader-text');
    if (loader) loader.style.display = 'flex';
    if (txt) {
        txt.textContent = msg;
        txt.style.color = isError ? '#f87171' : '';
    }
}

export function bimSetMeta(htmlContent) {
    const metaContainer = document.getElementById('bim-spool-meta');
    if (metaContainer) metaContainer.innerHTML = htmlContent;
}

export function bimColorDeEstado(st) {
    if (!st) return BIM_STATUS_COLORS['SIN REGISTRO'];
    const s = st.trim().toUpperCase();
    if (bimState.coloresEstados && bimState.coloresEstados[s]) return bimState.coloresEstados[s];
    if (BIM_STATUS_COLORS[s]) return BIM_STATUS_COLORS[s];
    for (const [k, v] of Object.entries(BIM_STATUS_COLORS)) {
        if (s.includes(k) || k.includes(s)) return v;
    }
    return bimColorAuto(s);
}

export function bimColorAuto(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
    const h = Math.abs(hash) % 360;
    return bimHslARgb(h, 75, 55);
}

export function bimHslARgb(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [parseFloat(f(0).toFixed(3)), parseFloat(f(8).toFixed(3)), parseFloat(f(4).toFixed(3)), 1];
}

export function bimRgbAHex(rgba) {
    const r = Math.round(rgba[0] * 255).toString(16).padStart(2, '0');
    const g = Math.round(rgba[1] * 255).toString(16).padStart(2, '0');
    const b = Math.round(rgba[2] * 255).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
}

export function bimHexARgb(hex) {
    const clean = hex.replace('#', '');
    const r = parseInt(clean.substring(0, 2), 16) / 255;
    const g = parseInt(clean.substring(2, 4), 16) / 255;
    const b = parseInt(clean.substring(4, 6), 16) / 255;
    return [parseFloat(r.toFixed(3)), parseFloat(g.toFixed(3)), parseFloat(b.toFixed(3)), 1];
}

export async function bimCargarColoresEstados() {
    try {
        const resp = await fetch('/api/bim/colores-estados');
        if (resp.ok) bimState.coloresEstados = await resp.json();
    } catch (e) {
        console.error('[BIM] Error cargando colores del servidor:', e);
    }
}

export async function bimGuardarColorEstado(estado, hexColor) {
    const tienePermiso = await authAsegurar('bim');
    if (!tienePermiso) return;
    const rgba = bimHexARgb(hexColor);
    bimState.coloresEstados[estado.toUpperCase()] = rgba;

    try {
        await fetch('/api/bim/colores-estados', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bim') },
            body: JSON.stringify({ estado: estado.toUpperCase(), color: rgba })
        });
    } catch (e) {
        console.error('[BIM] Error guardando color de estado:', e);
    }

    bimRenderStatusChips();
    if (bimState.filtroEstados.size > 0) bimAplicarFiltroEstados();
    if (typeof window.renderSpools === 'function' && state.currentSection === 'spools') {
        window.renderSpools();
    }
}

export function bimRenderStatusChips() {
    const container = document.getElementById('bim-status-chips');
    if (!container) return;

    if (bimState.capa !== 'spool') {
        const stObj = bimState.capaStatuses;
        if (!stObj) {
            container.innerHTML = '<span class="bim-chip-loading"><i class="fas fa-spinner fa-spin"></i> Cargando...</span>';
            return;
        }

        const keys = Object.keys(stObj);
        if (keys.length === 0) {
            container.innerHTML = '<span class="bim-chip-loading">Sin datos de vinculación</span>';
            return;
        }

        const labelMap = { vinculados: 'Vinculados', sin_vincular: 'Sin Vincular' };
        const colorMap = { vinculados: '#10b981', sin_vincular: '#64748b' };

        container.innerHTML = keys.map(k => {
            const sel = bimState.filtroEstados.has(k);
            const label = labelMap[k] || k;
            const cnt = stObj[k] || 0;
            const hex = colorMap[k] || '#64748b';

            return `
                <button class="bim-status-chip ${sel ? 'selected' : ''}"
                        onclick="bimToggleFiltroEstado('${k}')"
                        style="--chip-color:${hex};">
                    <span class="chip-dot" style="background:${hex};"></span>
                    <span class="chip-label">${label}</span>
                    <span class="chip-count">${cnt}</span>
                </button>`;
        }).join('');
        return;
    }

    const cache = bimState.estadoConteos || {};
    const todosEstados = BIM_ORDEN_FLUJO.concat(
        Object.keys(cache).filter(e => !BIM_ORDEN_FLUJO.includes(e) && e !== 'SIN REGISTRO')
    );

    const htmlChips = todosEstados.map(st => {
        const info = cache[st] || { total: 0, asociados: 0, sin_asociar: 0 };
        const sel  = bimState.filtroEstados.has(st);
        const rgba = bimColorDeEstado(st);
        const hex  = bimRgbAHex(rgba);

        return `
            <div class="bim-status-chip-wrapper" style="--chip-color:${hex};">
                <button class="bim-status-chip ${sel ? 'selected' : ''}"
                        onclick="bimToggleFiltroEstado('${st}')">
                    <span class="chip-dot" style="background:${hex};"></span>
                    <span class="chip-label">${st}</span>
                    <span class="chip-count" title="${info.asociados} asociados a 3D / ${info.total} total en Appsheet">
                        ${info.asociados}/${info.total}
                    </span>
                </button>
                <input type="color" class="chip-color-picker" value="${hex}"
                       title="Cambiar color del estado '${st}'"
                       onchange="bimGuardarColorEstado('${st}', this.value)">
            </div>`;
    }).join('');

    const sinRegInfo = cache['SIN REGISTRO'] || { total: 0, asociados: 0, sin_asociar: 0 };
    const selSinReg  = bimState.filtroEstados.has('SIN REGISTRO');
    const hexSinReg  = bimRgbAHex(BIM_STATUS_COLORS['SIN REGISTRO']);

    const htmlSinReg = `
        <div class="bim-status-chip-wrapper" style="--chip-color:${hexSinReg};">
            <button class="bim-status-chip ${selSinReg ? 'selected' : ''}"
                    onclick="bimToggleFiltroEstado('SIN REGISTRO')">
                <span class="chip-dot" style="background:${hexSinReg};"></span>
                <span class="chip-label">SIN REGISTRO</span>
                <span class="chip-count" title="${sinRegInfo.asociados} asociados a 3D / ${sinRegInfo.total} total sin registro">
                    ${sinRegInfo.asociados}/${sinRegInfo.total}
                </span>
            </button>
            <input type="color" class="chip-color-picker" value="${hexSinReg}"
                   title="Cambiar color de SIN REGISTRO"
                   onchange="bimGuardarColorEstado('SIN REGISTRO', this.value)">
        </div>`;

    container.innerHTML = htmlChips + htmlSinReg;
}

export function bimActualizarPermisosUI() {
    const tieneClave = !!authObtener('bim');

    const editBtn = document.getElementById('bim-edit-unlock-btn');
    if (editBtn) editBtn.style.display = tieneClave ? 'none' : 'flex';

    const panel = document.getElementById('bim-link-panel');
    if (panel) {
        if (!tieneClave) panel.style.display = 'none';
        else if (bimState.selectedElements && bimState.selectedElements.length > 0) {
            panel.style.display = 'flex';
        }
    }

    if (typeof bimActualizarToolbarPermisos === 'function') {
        bimActualizarToolbarPermisos(tieneClave);
    }
}

// Exponer en el objeto global window para asegurar compatibilidad total con HTML y scripts adjuntos
if (typeof window !== 'undefined') {
    window.bimState = bimState;
    window.BIM_CAPA_UI = BIM_CAPA_UI;
    window.BIM_STATUS_COLORS = BIM_STATUS_COLORS;
    window.BIM_ORDEN_FLUJO = BIM_ORDEN_FLUJO;
    window.bimSetCapa = bimSetCapa;
    window.bimUpdateStatusFilterOptions = bimUpdateStatusFilterOptions;
    window.initBimViewer = initBimViewer;
    window.bimLoadSdk = bimLoadSdk;
    window.bimStartViewer = bimStartViewer;
    window.bimSetLoader = bimSetLoader;
    window.bimSetMeta = bimSetMeta;
    window.bimColorDeEstado = bimColorDeEstado;
    window.bimColorAuto = bimColorAuto;
    window.bimHslARgb = bimHslARgb;
    window.bimRgbAHex = bimRgbAHex;
    window.bimHexARgb = bimHexARgb;
    window.bimCargarColoresEstados = bimCargarColoresEstados;
    window.bimGuardarColorEstado = bimGuardarColorEstado;
    window.bimRenderStatusChips = bimRenderStatusChips;
    window.bimActualizarPermisosUI = bimActualizarPermisosUI;
}
