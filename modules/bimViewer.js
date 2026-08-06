/**
 * BIM Viewer — Andina Piping Dashboard
 *
 * Subsistema completo del visor 3D sobre Autodesk Platform Services:
 * carga del modelo, búsqueda y aislamiento de spools, capas (spool/válvula/
 * soporte), filtro y coloreo por estado, modo EN VIVO, escáner QR, vinculación
 * de elementos 3D, y el sistema de división de tramos ("tijeras").
 *
 * Se extrae como una sola unidad a propósito: el núcleo del visor y el sistema
 * de tijeras se llaman mutuamente desde ~20 puntos y comparten bimState y
 * divState. Partirlo exigiría ciclos de import o indirección por window, que es
 * justo el patrón que hacía que los fallos pasaran desapercibidos.
 *
 * Globales que llegan de fuera (no son import): THREE y Autodesk los inyecta el
 * SDK de APS, jsQR viene del CDN en index.html, y bimIfcInit lo define
 * bim-ifc-export.js como script clásico (siempre invocado tras guarda typeof).
 */
import { bimState } from './bimState.js';
import { BIM_STATUS_COLORS, bimColorDeEstado, bimRgbAHex, bimCargarColoresEstados } from './bimColors.js';
import { authAsegurar, authHeaders, authObtener, authOlvidar } from './auth.js';

// =================================================================
// ============ BIM VIEWER MODULE (APS / Autodesk) =================
// =================================================================

// Estado del visor 3D. Vive aquí hasta que el subsistema BIM completo
// (~123 símbolos que comparten bimState y divState) se extraiga de una sola vez.

// Config de capas en el frontend (llave, etiqueta, endpoints)
// Todo el texto que cambia con la capa vive aquí. `vincularLabel` y
// `vincularPlaceholder` son los del panel de vinculación: antes los fijaba
// bimRenderCapaSelection, que solo corre en válvulas/soportes, así que al volver
// a Spools se quedaban con el texto de la capa anterior.
export const BIM_CAPA_UI = {
    spool: {
        label: 'Spool', buscar: 'Buscar Spool', placeholder: 'TAG Gestión (ej: 217)',
        vincularLabel: 'Código Spool (LUKEAPP):', vincularPlaceholder: 'Ej: 217'
    },
    valvula: {
        label: 'Válvula', buscar: 'Buscar Válvula', placeholder: 'ID Válvula (ej: VAL113)',
        vincularLabel: 'ID Válvula (ID_VALVULA):', vincularPlaceholder: 'ID Válvula (ej: VAL113)'
    },
    soporte: {
        label: 'Soporte', buscar: 'Buscar Soporte', placeholder: 'ID/ITEM Soporte (ej: 148)',
        vincularLabel: 'ITEM Soporte (ej: 148):', vincularPlaceholder: 'ID/ITEM Soporte (ej: 148)'
    },
    subsistema: {
        label: 'Sub-sistema', buscar: 'Buscar Sub-sistema', placeholder: 'Código o Nombre (ej: 03350-02-06)',
        vincularLabel: 'Código Sub-sistema:', vincularPlaceholder: 'Ej: 03350-02-06'
    }
};

/** Cambia la capa activa (Spools / Válvulas / Soportes) y recarga su mapeo+índice. */
export async function bimSetCapa(capa) {
    if (!BIM_CAPA_UI[capa]) return;
    bimLiveStop();
    bimState.capa = capa;

    // UI: botones activos
    document.querySelectorAll('.bim-capa-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById(`bim-capa-${capa}`);
    if (btn) {
        btn.classList.add('active');
        try { btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }); } catch (e) {}
    }

    // UI: color de la capa en toda la barra lateral. El CSS lee la clase y
    // redefine --capa-color, así que el tinte, el borde y el panel de
    // vinculación cambian juntos y se ve de un vistazo en qué sección estás.
    const aside = document.querySelector('.bim-sidebar');
    if (aside) {
        Object.keys(BIM_CAPA_UI).forEach(c => aside.classList.remove(`capa-${c}`));
        aside.classList.add(`capa-${capa}`);
    }

    // UI: etiqueta y placeholder de búsqueda
    const lbl = document.getElementById('bim-search-label');
    if (lbl) lbl.innerHTML = `<i class="fas fa-search"></i> ${BIM_CAPA_UI[capa].buscar}`;
    const inp = document.getElementById('bim-search-input');
    if (inp) { inp.placeholder = BIM_CAPA_UI[capa].placeholder; inp.value = ''; }

    // UI: panel de vinculación. Se fija aquí y no al pintar la selección porque
    // este es el único punto que conoce la capa activa en TODOS los casos; si no,
    // al volver a Spools quedaba pidiendo un "ID Válvula".
    const vLbl = document.querySelector('#bim-link-panel label[for="bim-link-spool"]');
    if (vLbl) vLbl.textContent = BIM_CAPA_UI[capa].vincularLabel;
    const vInp = document.getElementById('bim-link-spool');
    if (vInp) { vInp.placeholder = BIM_CAPA_UI[capa].vincularPlaceholder; vInp.value = ''; }
    const vTit = document.querySelector('#bim-link-panel h4');
    if (vTit) vTit.innerHTML = `<i class="fas fa-link"></i> Vincular ${BIM_CAPA_UI[capa].label}`;
    const unlinkBtn = document.getElementById('bim-unlink-btn');
    if (unlinkBtn) unlinkBtn.innerHTML = `<i class="fas fa-unlink"></i> Desvincular de ${BIM_CAPA_UI[capa].label}`;

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
            bimPopulateDatalist(capa);
        } catch (e) {
            console.error(`[BIM] Error cargando capa ${capa}:`, e);
        }
    } else {
        bimPopulateDatalist(capa);
    }
}

/** Puebla el elemento datalist con opciones para la vinculación. */
export function bimPopulateDatalist(capa) {
    const dl = document.getElementById('bim-link-datalist');
    if (!dl) return;
    if (capa === 'subsistema') {
        const index = bimState.capaIndex['subsistema'] || {};
        const items = [...new Set(Object.values(index).map(r => r._label || r.label || r.code).filter(Boolean))];
        dl.innerHTML = items.map(val => `<option value="${val}">`).join('');
    } else {
        dl.innerHTML = '';
    }
}

/** Ajusta las opciones del filtro por estado según la capa (spools tienen flujo; válvulas/soportes binario). */
export async function bimUpdateStatusFilterOptions(capa) {
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
export async function initBimViewer() {
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
        if (data.models && data.models.length > 0) {
            bimState.availableModels = data.models;
            const targetModel = data.models.find(m => m.id === bimState.selectedModelId) || data.models[0];
            bimState.selectedModelId = targetModel.id;
            bimState.modelUrn = targetModel.urn;

            const sel = document.getElementById('bim-model-select');
            if (sel) sel.value = targetModel.id;
        } else {
            bimState.modelUrn = data.model_urn;
        }

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

/** Inicializa Autodesk.Viewing y monta el GuiViewer3D */
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
                                    { propFilter: ['externalId', 'GUID', 'Element GUID', 'Revit GUID', 'Layer', 'PnPGuid', 'PnPGUID', 'Tag', 'TAG', 'Line Number', 'LineNumber', 'Item Code', 'Spool', 'SPOOL', 'CWP'] },
                                    (results) => {
                                        const selectedList = [];
                                        const uniqueLayers = new Set();

                                        results.forEach(pResult => {
                                            let guid = pResult.externalId || '';
                                            let layer = '';
                                            let sourceFile = '';
                                            let tag = '';
                                            let lineNo = '';
                                            let spool = '';
                                            let cwp = '';
                                            
                                            if (pResult.properties) {
                                                pResult.properties.forEach(prop => {
                                                    const propName = String(prop.displayName || prop.attributeName || '').toLowerCase();
                                                    const val = String(prop.displayValue || '').trim();
                                                    if (['guid', 'element guid', 'revit guid', 'pnpguid'].includes(propName)) {
                                                        guid = val;
                                                    }
                                                    if (propName === 'layer') {
                                                        layer = val;
                                                    }
                                                    if (propName === 'source file') {
                                                        sourceFile = val;
                                                    }
                                                    if (['tag', 'item tag'].includes(propName)) {
                                                        tag = val;
                                                    }
                                                    if (['line number', 'linenumber', 'line'].includes(propName)) {
                                                        lineNo = val;
                                                    }
                                                    if (['spool', 'spool lukeapp', 'tag gestion'].includes(propName)) {
                                                        spool = val;
                                                    }
                                                    if (propName === 'cwp') {
                                                        cwp = val;
                                                    }
                                                });
                                            }

                                            if (guid) {
                                                selectedList.push({
                                                    dbId: pResult.dbId,
                                                    guid: guid,
                                                    layer: layer,
                                                    sourceFile: sourceFile,
                                                    name: pResult.name || 'ACPPPIPE',
                                                    tag: tag,
                                                    lineNo: lineNo,
                                                    spool: spool,
                                                    cwp: cwp
                                                });
                                                if (layer) uniqueLayers.add(layer);
                                            }
                                        });

                                        if (selectedList.length > 0) {
                                            bimState.selectedElements = selectedList;

                                             // Capa válvulas/soportes/subsistemas: flujo simple (1 elemento = 1 ítem, sin auto-grupo)
                                            if (bimState.capa !== 'spool') {
                                                bimRenderCapaSelection(bimState.capa, selectedList, uniqueLayers);
                                                if (panel) panel.style.display = 'flex';
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
                                                // Nombrar la capa: "Vincular (1 selec.)" no decía a qué se vincula
                                                linkTitle.innerHTML = `<i class="fas fa-link"></i> Vincular ${BIM_CAPA_UI.spool.label} (${selectedList.length} selec.)`;
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
                                            
                                            const fieldContainer = document.querySelector('#bim-link-panel .bim-link-field');
                                            if (fieldContainer) fieldContainer.style.display = 'block';
                                            const btn = document.getElementById('bim-link-btn');
                                            if (btn) {
                                                btn.style.display = 'block';
                                                btn.innerHTML = `<i class="fas fa-save"></i> Guardar ${selectedList.length} elem.`;
                                                btn.disabled = false;
                                                btn.style.opacity = '1';
                                            }

                                            if (panel) panel.style.display = 'flex';
                                            
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

/** Cambia el modelo 3D cargado en el visor de Autodesk */
export async function bimCambiarModelo(modelKey) {
    if (!bimState.viewer) return;
    const models = bimState.availableModels || [];
    const modelObj = models.find(m => m.id === modelKey) || { id: modelKey, urn: bimState.modelUrn, label: modelKey };
    if (!modelObj.urn) return;

    bimSetLoader(`Cargando modelo ${modelObj.label || modelKey}...`);
    bimState.modelUrn = modelObj.urn;
    bimState.selectedModelId = modelKey;

    const urn = modelObj.urn.startsWith('urn:')
        ? btoa(modelObj.urn).replace(/=/g, '')
        : modelObj.urn;

    if (bimState.viewer.model) {
        bimState.viewer.unloadModel(bimState.viewer.model);
    }

    Autodesk.Viewing.Document.load(
        `urn:${urn}`,
        (doc) => {
            const viewables = doc.getRoot().getDefaultGeometry();
            bimState.viewer.loadDocumentNode(doc, viewables).then(() => {
                bimState.viewer.setGhosting(true);
                const loader = document.getElementById('bim-loader');
                if (loader) loader.style.display = 'none';

                // Re-inicializar herramientas de división y aislamiento
                bimDividirInit();
                bimIsoColorInit();

                // Refrescar capa activa y filtros por estado
                if (bimState.filtroEstados && bimState.filtroEstados.size > 0) {
                    bimAplicarFiltroEstados();
                } else {
                    bimSetCapa(bimState.capa || 'spool');
                }

                console.log(`[BIM] Modelo ${modelObj.label || modelKey} cargado y reconfigurado con éxito.`);
            });
        },
        (errCode, errMsg) => {
            console.error('[BIM] Error cargando modelo:', errCode, errMsg);
            bimSetLoader(`❌ Error cargando modelo: ${errMsg}`, true);
        }
    );
}

/** Busca un spool desde la caja de búsqueda manual */
export function bimSearchSpool() {
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
export function bimResolveCapaId(capa, typed) {
    const index = bimState.capaIndex[capa] || {};
    const keyCol = capa === 'valvula' ? 'ID_VALVULA' : (capa === 'soporte' ? 'ID_Soporte' : 'code');
    const t = String(typed || '').trim().toLowerCase();
    if (!t) return typed;
    if (index[t]) return index[t]._label || index[t].label || index[t][keyCol] || typed;
    let hit = Object.values(index).find(r => (r._label || r.label || '').toLowerCase() === t);
    if (hit) return hit._label || hit.label || hit[keyCol];
    if (capa === 'soporte') {
        hit = Object.values(index).find(r => String(r.ITEM || '').toLowerCase() === t);
        if (hit) return hit.ID_Soporte;
    } else if (capa === 'valvula') {
        hit = Object.values(index).find(r => String(r[keyCol] || '').toLowerCase() === t.split('_')[0]);
        if (hit) return hit[keyCol];
    }
    return typed;
}

/** Busca una válvula/soporte por ID/ITEM/etiqueta y resalta sus elementos vinculados en el modelo. */
export async function bimLoadCapaItem(capa, termino) {
    if (!bimState.initialized) return;
    const ui = BIM_CAPA_UI[capa];
    const id = bimResolveCapaId(capa, termino);

    bimSetMetaCargando('Buscando elementos...');
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
                // Estado real de la capa. Las válvulas tienen estados propios
                // ("Posicionada", "Montada"); los soportes son binarios porque su
                // tabla de montaje no lleva columna de estado.
                bimHighlightElements(dbIds, data.status || 'PENDIENTE');
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
export async function bimLoadSpool(spoolId) {
    if (!bimState.initialized) {
        console.warn('[BIM] Visor no listo todavía.');
        return;
    }

    bimSetMetaCargando('Buscando elementos...');

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
                bimHighlightElements(dbIds, data.estado_actual); // color = estado real del spool
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
export function bimGuidsToDbIds(guids, callback) {
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
export function bimIndiceGuidDbId() {
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
export function bimIsoColorInit() {
    const viewer = bimState.viewer;
    if (!viewer) return;
    viewer.addEventListener(Autodesk.Viewing.ISOLATE_EVENT, (ev) => {
        clearTimeout(bimState._isoColorTimer);
        const nodos = ev.nodeIdArray || [];
        bimState._isoColorTimer = setTimeout(() => bimIsoColorAplicar(nodos), 150);
    });
    bimDivVigilarMostrarTodo();
}

/**
 * Vigila que los originales ya divididos NO reaparezcan.
 *
 * No se puede borrar un elemento de un modelo APS ya cargado, solo ocultarlo, y
 * cualquier "mostrar todo" del navegador de Autodesk los resucita. Como esas
 * herramientas nativas son ciegas a las divisiones, se reacciona a su evento y
 * se vuelven a esconder.
 *
 * Se hace por evento y no sondeando: el sondeo periódico haría parpadear el
 * original entre que reaparece y se vuelve a ocultar.
 */
export function bimDivVigilarMostrarTodo() {
    const viewer = bimState.viewer;
    if (!viewer || bimState._vigilaOcultos) return;
    bimState._vigilaOcultos = true;

    const revisar = () => {
        if (!divState.ocultos.length) return;
        clearTimeout(divState._reocultarTimer);
        // Pequeño respiro: el visor emite varios eventos seguidos al mostrar todo
        divState._reocultarTimer = setTimeout(() => {
            if (divState._aislado) return;   // en modo corte manda el aislamiento
            bimDivReocultarOriginales();
        }, 120);
    };

    [Autodesk.Viewing.SHOW_EVENT, Autodesk.Viewing.ISOLATE_EVENT].forEach(evt => {
        if (evt) viewer.addEventListener(evt, revisar);
    });
}

/** Pinta los elementos visibles de la isolación según el estado de su spool. */
export async function bimIsoColorAplicar(nodos) {
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
/**
 * Resalta el resultado de una búsqueda: lo aísla, lo encuadra y lo tiñe con el
 * color de SU estado.
 *
 * Antes se pintaba siempre de verde brillante, que es el color de MONTADO en la
 * paleta: un spool en fabricación aparecía verde y se leía como montado. Si no
 * se conoce el estado no se tiñe nada — el aislamiento y el x-ray del resto ya
 * lo destacan, y así no se le atribuye un estado que no tiene.
 */
export function bimHighlightElements(dbIds, estado) {
    const viewer = bimState.viewer;
    if (!viewer) return;

    // El modo corte apaga el ghosting para aislar el tramo. Si se busca un spool
    // sin haber pulsado antes "Ver todo el modelo", seguiría apagado y el resto
    // del modelo desaparecería en vez de quedar en rayos X.
    if (divState._aislado) {
        try { viewer.setGhosting(true); } catch (e) {}
        divState._aislado = false;
    }

    viewer.isolate(dbIds);
    viewer.fitToView(dbIds);

    if (estado) {
        const [r, g, b] = bimColorDeEstado(String(estado).toUpperCase());
        const col = new THREE.Vector4(r, g, b, 1);
        dbIds.forEach(id => viewer.setThemingColor(id, col, viewer.model, true));
    } else {
        viewer.clearThemingColors(viewer.model);
    }

    // Mostrar botones de acción
    const actionsEl = document.getElementById('bim-actions');
    if (actionsEl) actionsEl.style.display = 'flex';
}

/** Aisla los elementos actuales (solo muestra esos) */
export function bimIsolateElements() {
    if (!bimState.viewer || bimState.dbIds.length === 0) return;
    bimState.viewer.isolate(bimState.dbIds);
    bimState.viewer.fitToView(bimState.dbIds);
}

/** Centra la cámara en los elementos seleccionados */
export function bimFitToView() {
    if (!bimState.viewer || bimState.dbIds.length === 0) return;
    bimState.viewer.fitToView(bimState.dbIds);
}

/** Restablece la vista del modelo completo */
export function bimResetView() {
    bimLiveStop();
    if (!bimState.viewer) return;
    // Levantar primero el aislamiento del modo corte: showAll() por sí solo no
    // deshace un isolate() ni devuelve el ghosting a su valor normal.
    if (divState._aislado) {
        try { bimState.viewer.isolate([]); bimState.viewer.setGhosting(true); } catch (e) {}
        divState._aislado = false;
    }
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

// =================================================================
// ESTADOS DINÁMICOS + COLORES EDITABLES + FILTRO MULTI-SELECCIÓN
// Los estados salen de los DATOS: si los usuarios agregan un estado
// nuevo en AppSheet, aparece solo, con color auto-asignado y editable.
// =================================================================
export const BIM_ORDEN_FLUJO = ['EN FABRICACIÓN', 'QAQC', 'EN PINT/REVEST.', 'RETIRAR',
    'POR MONTAR', 'POSICIONADO', 'MONTADO', 'ELIMINADO', 'PENDIENTE', 'SIN ESTADO'];


/** Color automático y estable para estados nuevos (hash → tono HSL). */

/** Color efectivo de un estado: override guardado > paleta base > auto. */


/** Unidad de la capa activa (para etiquetas de conteo). */
export function bimUnidadCapa() {
    if (bimState.capa === 'spool' || bimState.capa === 'subsistema') return 'spools';
    if (bimState.capa === 'valvula') return 'válvulas';
    return 'soportes';
}

/**
 * Cuenta ÍTEMS únicos (spools/válvulas/soportes) en una lista de GUIDs,
 * resolviendo GUID→TAG con el mapeo de la capa activa. Los trozos 'guid#pN'
 * cuentan por su ítem asignado. Si nada está vinculado, cae a nº de elementos.
 */
export function bimContarSpools(guids) {
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
export function bimRenderStatusChips() {
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

    const chipDataList = nombres.map(st => {
        const guids = statuses[st] || [];
        const sel   = bimState.filtroEstados.has(st);
        const hex   = bimRgbAHex(bimColorDeEstado(st));
        const esc   = st.replace(/'/g, "\\'");

        let nTotal, nSinAsociar;
        if (bimState.capa === 'spool' && bimState.estadoConteos && bimState.estadoConteos[st]) {
            nTotal      = bimState.estadoConteos[st].total;
            nSinAsociar = bimState.estadoConteos[st].sin_asociar || 0;
        } else {
            nTotal      = bimContarSpools(guids);
            nSinAsociar = 0;
        }

        return { st, guids, sel, hex, esc, nTotal, nSinAsociar };
    });

    // Si todos los badges calculados valen 1 o 0, u omitirlos para no saturar la vista
    const todosSonUno = chipDataList.length > 0 && chipDataList.every(d => d.nTotal <= 1);

    cont.innerHTML = chipDataList.map(d => {
        const { st, sel, hex, esc, nTotal, nSinAsociar } = d;

        const badgeHtml = nSinAsociar > 0
            ? `<span class="bim-chip-sin-asociar" title="${nSinAsociar} sin modelo 3D">-${nSinAsociar}</span>`
            : '';

        const countBadgeHtml = (todosSonUno || nTotal === 0)
            ? ''
            : `<span class="bim-chip-n">${nTotal}</span>`;

        const tieneClave = !!authObtener('bim');
        const colorElHtml = tieneClave
            ? `<input type="color" value="${hex}" onclick="event.stopPropagation()" onchange="bimGuardarColorEstado('${esc}', this.value)" title="Editar color de ${st}">`
            : `<span class="bim-chip-dot" style="background:${hex}; width:12px; height:12px; border-radius:50%; display:inline-block; flex-shrink:0; margin-right:4px;" title="Color de ${st}"></span>`;

        return `<div class="bim-chip ${sel ? 'sel' : ''}" onclick="bimToggleEstado('${esc}')" title="${nTotal} ${unidad} (${nSinAsociar > 0 ? nSinAsociar + ' sin geometría 3D' : 'todos con modelo'})">
            ${colorElHtml}
            <span class="bim-chip-nombre">${st}</span>
            ${countBadgeHtml}
            ${badgeHtml}
        </div>`;
    }).join('');
}

export function bimToggleEstado(st) {
    if (bimState.filtroEstados.has(st)) bimState.filtroEstados.delete(st);
    else bimState.filtroEstados.add(st);
    bimRenderStatusChips();
    bimAplicarFiltroEstados();
}

export function bimLimpiarFiltroEstados() {
    bimState.filtroEstados.clear();
    bimRenderStatusChips();
    bimResetView();
}

/** Edita el color de un estado (persistido; requiere clave BIM). */
export async function bimGuardarColorEstado(st, hex) {
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
export async function bimAplicarFiltroEstados() {
    bimLiveStop();
    const seleccion = [...bimState.filtroEstados];
    if (!seleccion.length) { bimResetView(); return; }
    if (!bimState.initialized) return;

    bimSetMetaCargando('Aplicando filtro...');
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
            const liveFooter = bimState.capa === 'subsistema'
                ? `<div style="padding:6px 2px;">
                     <button onclick="bimSubsistemaVerPorEstado()" style="
                        display:inline-flex;align-items:center;gap:6px;
                        padding:7px 14px;font-size:0.78rem;font-weight:600;
                        border:1px solid rgba(16,185,129,0.5);
                        background:linear-gradient(135deg,rgba(16,185,129,0.2),rgba(5,150,105,0.15));
                        color:#6ee7b7;border-radius:8px;cursor:pointer;
                        transition:all 0.2s ease;
                     " onmouseover="this.style.background='rgba(16,185,129,0.35)'" onmouseout="this.style.background='linear-gradient(135deg,rgba(16,185,129,0.2),rgba(5,150,105,0.15))'">
                        <i class="fas fa-palette"></i> Ver por Estado de Spool
                     </button>
                   </div>`
                : '<p style="font-size:0.72rem;opacity:0.7;padding:0 2px;"><i class="fas fa-satellite-dish"></i> EN VIVO: los nuevos reportes se suman solos.</p>';
            const headerLabel = bimState.capa === 'subsistema' ? 'Sub-sistema(s)' : 'estado(s)';
            bimSetMeta(`
                <div class="bim-meta-header" style="background: rgba(99,102,241,0.15); border-color: rgba(99,102,241,0.3);">
                    <i class="fas fa-filter"></i><span>Filtro activo: ${seleccion.length} ${headerLabel}</span>
                </div>
                <div style="padding:8px 2px; display:flex; flex-wrap:wrap; gap:4px;">${resumen}</div>
                ${liveFooter}`);
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

/**
 * Aísla los elementos de un subsistema seleccionado y los colorea según
 * el estado de fabricación de sus spools (EN FABRICACIÓN, QAQC, MONTADO, etc.)
 * Se activa con el botón "Ver por Estado" que aparece al filtrar un subsistema.
 */
export async function bimSubsistemaVerPorEstado() {
    if (!bimState.initialized) return;
    const seleccion = [...bimState.filtroEstados];
    if (!seleccion.length) return;

    // Soporta un solo subsistema o el primero seleccionado
    const subsistemaId = seleccion[0];
    bimSetMetaCargando(`Coloreando por estado: ${subsistemaId}...`);

    try {
        const resp = await fetch(`/api/bim/subsistema/${encodeURIComponent(subsistemaId)}/por-estado`);
        if (!resp.ok) throw new Error(`Error ${resp.status}`);
        const data = await resp.json();

        if (!data.statuses || !Object.keys(data.statuses).length) {
            bimSetMeta(`<div class="bim-meta-empty"><i class="fas fa-info-circle"></i><p>No se encontraron estados de spool para <strong>${subsistemaId}</strong></p></div>`);
            return;
        }

        const viewer = bimState.viewer;
        viewer.clearThemingColors(viewer.model);

        const estados = Object.keys(data.statuses);
        let acumulados = [];
        let pendientes = estados.length;

        const finalizar = () => {
            bimState.dbIds = [...new Set(acumulados)].filter(id => !divState.ocultos.includes(id));
            if (bimState.dbIds.length) {
                viewer.isolate(bimState.dbIds);
                viewer.fitToView(bimState.dbIds);
            } else {
                viewer.isolate([]);
            }
            bimDivReocultarOriginales();

            const actionsEl = document.getElementById('bim-actions');
            if (actionsEl) actionsEl.style.display = 'flex';
            if (window.innerWidth <= 1024) bimCloseSidebar();

            // Resumen visual con leyenda de colores en SPOOLS
            const resumenHtml = estados.map(st => {
                const guids = data.statuses[st] || [];
                const hex = bimRgbAHex(bimColorDeEstado(st));
                const nSpools = (data.spoolCounts && data.spoolCounts[st] !== undefined)
                    ? data.spoolCounts[st]
                    : bimContarSpools(guids);
                return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;font-size:0.78rem;">
                    <span style="width:12px;height:12px;border-radius:3px;background:${hex};flex-shrink:0;"></span>
                    <span style="flex:1;">${st}</span>
                    <span style="opacity:0.85;font-size:0.75rem;font-weight:600;">${nSpools} ${nSpools === 1 ? 'spool' : 'spools'}</span>
                </div>`;
            }).join('');

            const btnVolverHtml = `<button onclick="bimAplicarFiltroEstados()" style="margin-top:8px;padding:5px 12px;font-size:0.75rem;border:1px solid rgba(139,92,246,0.4);background:rgba(139,92,246,0.15);color:#c4b5fd;border-radius:6px;cursor:pointer;">
                <i class="fas fa-arrow-left"></i> Volver al filtro de subsistema
            </button>`;

            // Filtrar y colorear trozos divididos que pertenecen a este subsistema
            const statusDe = bimStatusPorGuid();
            const subMapeo = bimState.capaMapeo['subsistema'] || {};
            for (const [key, mesh] of Object.entries(divState.trozoMeshes || {})) {
                const parentGuid = String(mesh?.userData?.guid || '').toLowerCase();
                const keyLower = key.toLowerCase();
                const subLabel = subMapeo[keyLower] || subMapeo[parentGuid] || '';
                if (subLabel.toLowerCase() === subsistemaId.toLowerCase()) {
                    mesh.visible = true;
                    const st = statusDe[keyLower] || statusDe[parentGuid] || 'SIN ESTADO';
                    bimTrozoPintarPorEstado(mesh, st);
                } else {
                    mesh.visible = false;
                }
            }
            if (bimState.viewer?.impl) bimState.viewer.impl.invalidate(false, false, true);

            bimSetMeta(`
                <div class="bim-meta-header" style="background: rgba(16,185,129,0.15); border-color: rgba(16,185,129,0.3);">
                    <i class="fas fa-palette"></i><span>${subsistemaId} — por Estado</span>
                </div>
                <div style="padding:8px 4px;">${resumenHtml}</div>
                <div style="padding:4px; font-size:0.72rem; opacity:0.6;">
                    <i class="fas fa-cubes"></i> ${data.total} elementos 3D totales
                </div>
                ${btnVolverHtml}`);
        };

        estados.forEach(st => {
            const gs = (data.statuses[st] || []).filter(g => !g.includes('#p'));
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
        console.error('[BIM Subsistema por Estado]', err);
        bimSetMeta(`<div class="bim-meta-empty"><i class="fas fa-exclamation-triangle"></i><p>Error: ${err.message}</p></div>`);
    }
}

/** Filtra e aisla los elementos del modelo 3D según el estado de pre-fabricación seleccionado */
export async function bimFilterByStatus() {
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

    bimSetMetaCargando(`Buscando elementos en estado ${status}...`);

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

        bimSetMetaCargando(`Mapeando ${guids.length} elementos en modelo...`);

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

                // Color desde la fuente única (override del usuario > paleta > auto).
                // Antes un estado desconocido caía en verde, el color de MONTADO.
                const rawColor = bimColorDeEstado(status);
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
export const BIM_LIVE_INTERVALO_MS = 10000; // 10s (el backend consulta AppSheet fresco)

/** Arranca el seguimiento EN VIVO de uno o varios estados. */
export function bimLiveStart(estados, statuses) {
    bimLiveStop();
    if (bimState.capa === 'subsistema') return;
    bimState.liveEstados = Array.isArray(estados) ? [...estados] : [estados];
    bimState.liveSets = {};
    bimState.liveEstados.forEach(st => {
        bimState.liveSets[st] = new Set((((statuses || {})[st]) || []).map(g => g.toLowerCase()));
    });
    bimLiveChipUpdate();
    bimState.liveTimer = setInterval(bimLiveTick, BIM_LIVE_INTERVALO_MS);
}

export function bimLiveStop() {
    if (bimState.liveTimer) clearInterval(bimState.liveTimer);
    bimState.liveTimer = null;
    bimState.liveStatus = null;
    bimState.liveGuids = null;
    bimState.liveEstados = null;
    bimState.liveSets = null;
    const chip = document.getElementById('bim-live-chip');
    if (chip) chip.remove();
}

export async function bimLiveTick() {
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

export async function bimLiveTickLegacy() {
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
export function bimLiveChipUpdate() {
    if (bimState.capa === 'subsistema') {
        const existingChip = document.getElementById('bim-live-chip');
        if (existingChip) existingChip.remove();
        return;
    }
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
    const unidad = bimUnidadCapa();
    const total = tags.size || 0;
    const etiqueta = bimState.liveEstados.length === 1
        ? bimState.liveEstados[0]
        : `${bimState.liveEstados.length} estados`;
    chip.innerHTML = `<span class="bim-live-dot"></span> EN VIVO · ${etiqueta}: <strong>${total}</strong> ${unidad}` +
        (total === 0 && sinVinculo ? ` <span style="opacity:0.6;font-size:0.75rem;">(${sinVinculo} elem.)</span>` : '');
}

/** Toast flotante; clic = volar a los elementos nuevos. */
export function bimLiveToast(texto, dbIds) {
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
export function bimBeep() {
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
export const DIV_OVERLAY = 'andinaDivisiones';
export const DIV_COLORES = [0x60a5fa, 0x34d399, 0xfbbf24, 0xa78bfa, 0xf87171, 0x38bdf8]; // trozos alternados
export const divState = {
    activo: false,          // modo corte encendido
    dbId: null,             // elemento en edición
    guid: null,
    eje: null,              // { p0:Vector3, dir:Vector3 (unit), len, radio } — eje REAL (PCA)
    cortes: [],             // fracciones internas de la sesión (ordenadas)
    _aislado: false,        // true mientras el modelo está oculto salvo el tramo en edición
    _reocultarTimer: null,  // debounce del re-ocultado tras un "mostrar todo" nativo
    ids: [],                // id ESTABLE de cada parte; alineado con bimDivPartesSesion()
    _nextId: 1,             // contador de ids de la sesión
    _historial: [],         // cortes en orden de inserción, para deshacer el último
    ext0: 0, ext1: 1,       // extremos (alargar/acortar el clon más allá del original)
    piezas: [],             // meshes overlay del clon en edición
    guardadas: {},          // { guidLower: [[a,b],...] } persistidas
    piezasGuardadas: [],    // meshes de divisiones guardadas
    ocultos: [],            // dbIds de originales ocultos (para re-ocultar tras showAll)
    _down: null
};

/** Normaliza el formato guardado: [0.42] (cortes viejos) o [[a,b],...] (partes). */
export function bimDivNormalizarPartes(raw) {
    if (!Array.isArray(raw) || !raw.length) return null;
    if (raw[0] && typeof raw[0] === 'object' && !Array.isArray(raw[0])) {
        return raw.map(p => [p.a, p.b]);          // formato con id → solo geometría
    }
    if (Array.isArray(raw[0])) return raw;         // [[a,b],...]
    const bordes = [0, ...raw, 1];                 // legado: lista de cortes
    return bordes.slice(0, -1).map((a, i) => [a, bordes[i + 1]]);
}

/**
 * Ids estables de una división guardada. El formato antiguo no los lleva, así
 * que se derivan de la posición: es exactamente lo que `#pN` significaba, de
 * modo que las vinculaciones ya existentes siguen apuntando a su trozo.
 */
export function bimDivIdsGuardados(raw) {
    const partes = bimDivNormalizarPartes(raw);
    if (!partes) return [];
    if (raw[0] && typeof raw[0] === 'object' && !Array.isArray(raw[0])) {
        return raw.map((p, i) => Number(p.id) || i + 1);
    }
    return partes.map((_, i) => i + 1);
}

/** Partes de la sesión con su id estable: [{id, a, b}]. Es lo que se persiste. */
export function bimDivPartesConId() {
    return bimDivPartesSesion().map(([a, b], i) => ({ id: divState.ids[i], a, b }));
}

/** Partes actuales de la sesión de edición (extremos + cortes internos). */
export function bimDivPartesSesion() {
    const bordes = [divState.ext0, ...divState.cortes.filter(c => c > divState.ext0 && c < divState.ext1), divState.ext1];
    return bordes.slice(0, -1).map((a, i) => [a, bordes[i + 1]]);
}

/** Actualiza los botones de la toolbar de APS según los permisos del usuario (CLAVE_BIM). */
export function bimActualizarToolbarPermisos() {
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
export function bimActualizarPermisosUI() {
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
export function bimDividirInit() {
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
export function bimTrozoBajoRayo(ev) {
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

export function bimTrozoPointerUp(ev) {
    if (divState.activo || !divState._downSel) return;
    // Los trozos son SOLO de spool: la herramienta corta cañería, y ni válvulas
    // ni soportes se dividen. Fuera de esa capa el clic se deja pasar al visor,
    // porque el panel del trozo asigna a la columna SPOOL LUKEAPP y en otra capa
    // estaría escribiendo en un sitio distinto del que anuncia la interfaz.
    if (bimState.capa !== 'spool') { divState._downSel = null; return; }
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
export function eje_margen(hit) { return (hit.mesh.userData.eje?.radio || 0.05) * 1.5; }

export function bimTrozoSeleccionar(mesh) {
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
export function bimTrozoRenderPanel(mesh) {
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
export async function bimTrozoEditarDivision(key) {
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
export async function bimTrozoEliminarDivision(key) {
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

export async function bimTrozoVincular(key) {
    console.log('[Trozo] Vincular solicitado:', key);
    // Escribe en SPOOL LUKEAPP a propósito: un trozo solo puede ser de un spool.
    // La guarda es defensa en profundidad — bimTrozoPointerUp ya impide llegar
    // aquí desde otra capa, pero esta función también es global en window.
    if (bimState.capa !== 'spool') {
        alert('Los trozos solo se asignan a spools. Cambia a la capa Spools para vincularlo.');
        return;
    }
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

export async function bimTrozoDesvincular(key) {
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

export async function bimDividirCargarGuardadas() {
    try {
        const r = await fetch('/api/bim/divisiones');
        divState.guardadas = await r.json();
        const guids = Object.keys(divState.guardadas);
        if (!guids.length) return;
        // Por cada división guardada: ocultar el original PARA SIEMPRE y
        // dibujar sus trozos (el clon reemplaza al elemento).
        // Los fallos aquí eran silenciosos: si el original no resolvía a dbId o su
        // geometría no se podía leer, sus trozos no se dibujaban y no quedaba
        // rastro — el spool aparecía incompleto sin ningún aviso.
        guids.forEach(g => {
            bimGuidsToDbIds([g], (ids) => {
                if (!ids.length) {
                    console.warn(`[Dividir] El original ${g} no resuelve a ningún dbId: sus trozos no se dibujarán.`);
                    return;
                }
                const eje = bimEjeDeElemento(ids[0]);
                if (!eje) {
                    console.warn(`[Dividir] No pude leer la geometría de ${g} (dbId ${ids[0]}): sus trozos no se dibujarán.`);
                    return;
                }
                bimState.viewer.hide(ids[0]);
                divState.ocultos.push(ids[0]);
                const partes = bimDivNormalizarPartes(divState.guardadas[g]) || [];
                const idsG = bimDivIdsGuardados(divState.guardadas[g]);
                partes.forEach(([a, b], i) => {
                    const m = bimCrearPieza(eje, a, b, eje.colorOrig);
                    if (!m) {
                        console.warn(`[Dividir] No pude crear el trozo ${g}#p${idsG[i]}.`);
                        return;
                    }
                    m.userData = { guid: g, idx: i, idParte: idsG[i], a, b, eje };
                    bimDivRegistrarTrozo(m, g, idsG[i]);
                    divState.piezasGuardadas.push(m);
                });
                console.log(`[Dividir] ${g}: ${partes.length} trozo(s) dibujados`);
            });
        });
        // Cuando estados+mapeo estén listos, pintar los trozos por su estado
        setTimeout(() => {
            const enMemoria = Object.keys(divState.trozoMeshes).length;
            console.log(`[Dividir] ${guids.length} división(es) cargadas · ${enMemoria} trozos en memoria`);
            bimDivColorearTrozos();
        }, 2500);
    } catch (e) { console.error('[Dividir] Error cargando divisiones:', e.message); }
}

export function bimDividirToggle() {
    divState.activo ? bimDividirSalir() : bimDividirEntrar();
}

/** Activa el modo dividir (botón + listeners). Requiere clave ya validada. */
export function bimDivActivarModo() {
    if (divState.activo) return;
    divState.activo = true;
    if (divState._btn) divState._btn.setState(Autodesk.Viewing.UI.Button.State.ACTIVE);
    const canvas = bimState.viewer.canvas;
    canvas.addEventListener('pointerdown', bimDivPointerDown, true);
    canvas.addEventListener('pointerup', bimDivPointerUp, true);
    canvas.addEventListener('click', bimDivClickBlock, true);
}

export async function bimDividirEntrar() {
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
export const DIV_NO_TUBO = ['valv', 'soport', 'support', 'struct', 'estruct', 'steel', 'beam', 'perfil',
    'column', 'pilar', 'equip', 'bomba', 'pump', 'instr', 'brida', 'flange', 'clamp', 'abraz',
    'gusset', 'plate', 'placa', 'anclaje', 'anchor', 'grating', 'hormig', 'concre', 'fitting',
    'elbow', 'codo', 'tee', 'reduc', 'weldolet', 'olet', 'cap ', 'tapa'];

/**
 * ¿El elemento es un TRAMO RECTO de cañería? Combina nombre + geometría:
 * esbeltez (largo ≥ 2.5 diámetros) y cilindricidad (forma tubular real).
 * Codos, tees, válvulas, soportes y estructuras quedan bloqueados.
 */
export function bimValidarTubo(dbId, eje) {
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
export function bimDivIniciarEdicion(dbId, guid) {
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
        // Recuperar los ids con los que ya están vinculados los trozos
        divState.ids = bimDivIdsGuardados(divState.guardadas[gl]);
        divState._nextId = Math.max(0, ...divState.ids) + 1;
    } else {
        divState.ext0 = 0; divState.ext1 = 1;
        divState.cortes = [0.5]; // ← división a la MITAD de inmediato
        divState.ids = [1, 2];
        divState._nextId = 3;
    }
    divState._historial = []; // deshacer solo afecta a lo hecho en esta sesión
    bimDivAislarTramo(dbId);  // oculta el resto del modelo: sin esto no se puede trabajar
    bimState.viewer.select([]);
    bimDivRedibujarClon();
    bimDivRenderPanel();
    bimDivAutoGuardar(); // persistir desde el primer momento
}

/** Variante desde un clic (sin selección previa): resuelve el guid primero. */
export function bimDivIniciarEdicionDesdeDbId(dbId) {
    bimState.viewer.model.getProperties(dbId, (props) => {
        const p = (props.properties || []).find(x => ['GUID', 'Element GUID', 'Revit GUID', 'PnPGuid', 'PnPGUID'].includes(x.displayName));
        const guid = (p ? String(p.displayValue) : props.externalId || '').trim();
        if (guid) bimDivIniciarEdicion(dbId, guid);
    }, () => {});
}

/** AUTO-GUARDADO con debounce: cada cambio queda persistido solo. */
export function bimDivAutoGuardar() {
    clearTimeout(divState._saveTimer);
    const st = document.getElementById('div-save-status');
    if (st) { st.textContent = 'Guardando…'; st.style.color = 'var(--warning)'; }
    divState._saveTimer = setTimeout(bimDivGuardarAhora, 1200);
}

export async function bimDivGuardarAhora() {
    if (!divState.guid) return;
    const partes = bimDivPartesConId();
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

export function bimDividirSalir(conSesionAbierta = true) {
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
    divState.dbId = null; divState.guid = null; divState.eje = null; divState.cortes = []; divState.ids = []; divState._historial = []; divState._nextId = 1;
    divState.ext0 = 0; divState.ext1 = 1;
}

export function bimDivLimpiarSesion() {
    const viewer = bimState.viewer;
    divState.piezas.forEach(m => { try { viewer.impl.removeOverlay(DIV_OVERLAY, m); } catch (e) {} });
    (divState.handles || []).forEach(m => { try { viewer.impl.removeOverlay(DIV_OVERLAY, m); } catch (e) {} });
    divState.piezas = [];
    divState.handles = [];
    viewer?.impl.invalidate(false, false, true);
}

export function bimDivPointerDown(ev) {
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
export function bimDivTdeEvento(ev) {
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

export function bimDivDragMove(ev) {
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

export function bimDivDragEnd(ev) {
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
export function bimDivClickBlock(ev) {
    if (divState._consume) {
        ev.stopPropagation(); ev.preventDefault();
        divState._consume = false;
    }
}

export function bimDivPointerUp(ev) {
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

    // El clic divide EL TROZO PINCHADO por su mitad, no corta en el punto exacto
    // del clic. Así los demás trozos conservan su geometría y su vinculación al
    // spool, que es lo que permite reeditar sin rehacer el trabajo.
    const partes = bimDivPartesSesion();
    const k = partes.findIndex(([a, b]) => t >= a && t <= b);
    if (k === -1) return;

    const [a, b] = partes[k];
    const medio = (a + b) / 2;
    if (Math.abs(b - a) < 0.06) return;                       // trozo ya demasiado corto
    if (divState.cortes.some(c => Math.abs(c - medio) < 0.01)) return;

    divState.cortes.push(medio);
    divState.cortes.sort((x, y) => x - y);
    divState._historial.push(medio);                          // deshacer quita ESTE corte
    divState.ids.splice(k + 1, 0, divState._nextId++);         // el trozo k conserva su id
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
export function bimProyectarTDesdeRayo(ev, viewer) {
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
export function bimEjeDeElemento(dbId) {
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
export function bimProyectarT(eje, punto) {
    if (!eje || !punto || !eje.len) return null;
    const t = new THREE.Vector3().subVectors(punto, eje.p0).dot(eje.dir) / eje.len;
    if (t < 0.02 || t > 0.98) return null; // demasiado cerca de los extremos
    return Math.round(t * 1000) / 1000;
}

/** Crea el trozo de clon (cilindro sólido) entre las fracciones a..b del eje. */
export function bimCrearPieza(eje, a, b, colorHex, opacidad = 1) {
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
export function bimDivRedibujarClon() {
    const viewer = bimState.viewer;
    divState.piezas.forEach(m => { try { viewer.impl.removeOverlay(DIV_OVERLAY, m); } catch (e) {} });
    (divState.handles || []).forEach(m => { try { viewer.impl.removeOverlay(DIV_OVERLAY, m); } catch (e) {} });
    divState.piezas = [];
    divState.handles = [];

    bimDivPartesSesion().forEach(([a, b], i) => {
        const m = bimCrearPieza(divState.eje, a, b, divState.eje.colorOrig);
        if (m) {
            m.userData = { guid: divState.guid, idx: i, idParte: divState.ids[i], a, b, eje: divState.eje };
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
export function bimMatTrozo(matOrig, colorHex, opacidad = 1) {
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
export function bimCrearManilla(eje, t, colorHex) {
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

/**
 * Registra un trozo bajo su clave estable `guid#p<id>`.
 *
 * `id` es el id de la PARTE, no su posición. Con la clave posicional anterior,
 * insertar un corte reetiquetaba a los trozos siguientes y cada uno heredaba en
 * silencio la vinculación del vecino.
 */
export function bimDivRegistrarTrozo(mesh, guid, id) {
    const key = `${String(guid).toLowerCase()}#p${id}`;
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
export function bimStatusPorGuid() {
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
export function bimDivFiltrarTrozos(seleccionSet) {
    const statusDe = bimStatusPorGuid();
    const subMapeo = bimState.capaMapeo['subsistema'] || {};

    for (const [key, mesh] of Object.entries(divState.trozoMeshes)) {
        const parentGuid = String(mesh?.userData?.guid || '').toLowerCase();
        const keyLower = key.toLowerCase();
        const st = statusDe[keyLower] || statusDe[parentGuid] || 'SIN ESTADO';

        if (seleccionSet) {
            if (bimState.capa === 'subsistema') {
                const subLabel = subMapeo[keyLower] || subMapeo[parentGuid] || 'SIN SUBSISTEMA';
                mesh.visible = seleccionSet.has(subLabel);
            } else {
                mesh.visible = seleccionSet.has(st);
            }
            if (mesh.visible) bimTrozoPintarPorEstado(mesh, st);
        } else {
            mesh.visible = true;
            bimTrozoPintarPorEstado(mesh, st);
        }
    }
    bimState.viewer?.impl.invalidate(false, false, true);
}

/** Pinta el trozo con el color de su estado (GRIS neutro si es SIN ESTADO). */
export function bimTrozoPintarPorEstado(mesh, st) {
    if (!st || st === 'SIN ESTADO') bimTrozoPintarGris(mesh);
    else bimTrozoPintarEstado(mesh, bimColorDeEstado(st));
}

/** Gris neutro opaco (trozo sin estado asociado). */
export function bimTrozoPintarGris(mesh) {
    bimTrozoPintarEstado(mesh, [0.60, 0.64, 0.70]);
}

/** Modo x-ray para el trozo (translúcido, como los elementos no aislados de APS). */
export function bimTrozoPintarGhost(mesh) {
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
export function bimDivGhostPorSpool(guidsActivos) {
    const activos = new Set((guidsActivos || []).map(g => String(g).toLowerCase()));
    const statusDe = bimStatusPorGuid();
    const focos = [];
    for (const [key, mesh] of Object.entries(divState.trozoMeshes)) {
        if (activos.has(key)) {
            // Con el color de SU estado, igual que el resaltado de un spool normal.
            // Antes iban en verde fijo, que es el color de MONTADO y se leía como tal.
            mesh.visible = true;
            bimTrozoPintarPorEstado(mesh, statusDe[key]);
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
export function bimTrozoPintarEstado(mesh, rgb) {
    if (!mesh._matTema) mesh._matTema = new THREE.MeshPhongMaterial({ specular: 0x222222, shininess: 40 });
    mesh._matTema.color.setRGB(rgb[0], rgb[1], rgb[2]);
    mesh.material = mesh._matTema;
}

/** Re-oculta los originales divididos (isolate los re-muestra aunque estén hidden). */
/**
 * Aísla el tramo en edición: oculta TODO el modelo y deja solo sus trozos, que
 * al ser overlay se siguen dibujando.
 *
 * Sin esto el clon queda enterrado entre el resto de la geometría y no hay forma
 * cómoda ni de pinchar el trozo correcto ni de asignarle su spool. El
 * aislamiento se mantiene al salir de las tijeras a propósito: la asignación
 * ocurre DESPUÉS de cortar, y es justo cuando más se necesita ver solo el tramo.
 */
export function bimDivAislarTramo(dbId) {
    const viewer = bimState.viewer;
    if (!viewer) return;
    try {
        viewer.setGhosting(false);   // el resto desaparece, no queda en rayos X
        viewer.isolate([dbId]);      // del modelo, solo este elemento
        viewer.hide(dbId);           // y tampoco él: manda el clon de overlay
        divState._aislado = true;
        viewer.impl.invalidate(false, false, true);
    } catch (e) {
        console.error('[Dividir] No pude aislar el tramo:', e.message);
    }
}

/** Deshace el aislamiento y devuelve el modelo completo a la vista. */
export function bimDivMostrarModelo() {
    const viewer = bimState.viewer;
    if (!viewer) return;
    try {
        viewer.isolate([]);
        viewer.setGhosting(true);
        divState._aislado = false;
        bimDivReocultarOriginales();  // los originales ya divididos siguen ocultos
        bimDivColorearTrozos();
        viewer.impl.invalidate(false, false, true);
    } catch (e) {
        console.error('[Dividir] No pude restaurar la vista:', e.message);
    }
}

export function bimDivReocultarOriginales() {
    if (divState.ocultos.length && bimState.viewer) {
        divState.ocultos.forEach(id => bimState.viewer.hide(id));
    }
}

/** Aplica color/visibilidad de trozos según el filtro activo (o los restaura). */
export function bimDivColorearTrozos() {
    bimDivFiltrarTrozos(bimState.filtroEstados && bimState.filtroEstados.size ? new Set(bimState.filtroEstados) : null);
}

/** Panel lateral: trozos del clon + alargar/acortar + acciones. */
export function bimDivRenderPanel() {
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
export function bimDividirExtender(cual, delta) {
    const v = divState[cual] + delta;
    if (cual === 'ext0' && v >= divState.ext1 - 0.05) return;
    if (cual === 'ext1' && v <= divState.ext0 + 0.05) return;
    if (v < -0.5 || v > 1.5) return; // máx. media longitud extra por lado
    divState[cual] = Math.round(v * 1000) / 1000;
    bimDivRedibujarClon();
    bimDivRenderPanel();
}

/**
 * Deshace el ÚLTIMO corte hecho en esta sesión, no el último por posición.
 * Con "el clic divide el trozo pinchado", cortar en el medio y deshacer quitaba
 * el corte de más a la derecha, que no es lo que el usuario acaba de hacer.
 */
export function bimDividirDeshacer() {
    if (!divState._historial.length || divState.cortes.length <= 1) return;

    const corte = divState._historial.pop();
    const i = divState.cortes.findIndex(c => Math.abs(c - corte) < 1e-9);
    if (i === -1) return;

    divState.cortes.splice(i, 1);
    divState.ids.splice(i + 1, 1); // al fusionar, sobrevive el id del trozo izquierdo
    bimDivRedibujarClon();
    bimDivRenderPanel();
    bimDivAutoGuardar();
}

/**
 * "Listo": los cambios YA están auto-guardados — aquí solo se fijan los
 * trozos como definitivos (quedan clicables/asignables) y se cierra la edición.
 */
export async function bimDividirFinalizar() {
    if (!divState.guid) return;
    clearTimeout(divState._saveTimer);
    await bimDivGuardarAhora(); // flush final por si había un cambio en vuelo

    const partes = bimDivPartesSesion();
    // Quitar manillas; las piezas pasan a ser trozos persistidos clicables
    (divState.handles || []).forEach(m => { try { bimState.viewer.impl.removeOverlay(DIV_OVERLAY, m); } catch (e) {} });
    divState.handles = [];
    divState.piezas.forEach((m, i) => bimDivRegistrarTrozo(m, divState.guid, divState.ids[i]));
    divState.piezasGuardadas.push(...divState.piezas);
    divState.piezas = [];
    bimDivColorearTrozos();

    // El tramo sigue aislado a propósito: es cuando toca asignar cada trozo a su
    // spool, y con el modelo entero encima no hay forma de pinchar el correcto.
    bimSetMeta(`<div class="bim-meta-placeholder"><i class="fas fa-circle-check bim-meta-icon" style="color:var(--accent)"></i>
        <p>División lista: <strong>${partes.length} trozos</strong>.<br>
        <small style="opacity:0.7">Sal del modo tijeras (✂️) y haz clic en cada trozo para asignarle su spool.
        El resto del modelo sigue oculto para que puedas pincharlos.</small></p>
        <button class="bim-scan-btn" onclick="bimDivMostrarModelo()" style="margin-top:10px;justify-content:center;">
            <i class="fas fa-eye"></i> Ver todo el modelo
        </button></div>`);
    divState.dbId = null; divState.guid = null; divState.eje = null; divState.cortes = []; divState.ids = []; divState._historial = []; divState._nextId = 1;
    divState.ext0 = 0; divState.ext1 = 1;
}

/** Elimina la división (persistida o no) y restaura el elemento original. */
export async function bimDividirRestaurar() {
    if (!divState.guid) return;
    if (!confirm('¿Eliminar la división y volver a mostrar el elemento original?')) return;
    const gl = divState.guid.toLowerCase();
    if (divState.guardadas[gl]) {
        const desbloqueado = await authAsegurar('bim');
        if (!desbloqueado) return;

        // Desvincular los trozos ANTES de borrar la división: si no, sus filas
        // `guid#pN` quedan en LIST_Bim_MS apuntando a geometría inexistente y
        // siguen contando como elementos vinculados.
        const claves = Object.keys(divState.trozoMeshes).filter(k => k.startsWith(gl + '#p'));
        if (claves.length) {
            await fetch('/api/bim/desvincular', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders('bim') },
                body: JSON.stringify({ elements: claves.map(guid => ({ guid })) })
            }).catch(() => {});
            if (bimState.mapeoSpools) claves.forEach(k => { delete bimState.mapeoSpools[k]; });
        }

        await fetch('/api/bim/divisiones', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bim') },
            body: JSON.stringify({ guid: divState.guid, cortes: [] })
        }).catch(() => {});
        delete divState.guardadas[gl];
    }
    bimDivLimpiarSesion();
    // Quitar también los trozos persistidos de este guid (mesh + registro)
    divState.piezasGuardadas = divState.piezasGuardadas.filter(m => {
        if (String(m.userData?.guid || '').toLowerCase() === gl) {
            try { bimState.viewer.impl.removeOverlay(DIV_OVERLAY, m); } catch (e) {}
            if (m.userData.key) delete divState.trozoMeshes[m.userData.key];
            return false;
        }
        return true;
    });
    if (divState.dbId !== null) {
        // Sacarlo de `ocultos` ANTES de restaurar la vista: si no, el propio
        // bimDivMostrarModelo lo volvería a esconder junto al resto de divididos.
        divState.ocultos = divState.ocultos.filter(id => id !== divState.dbId);
        bimDivMostrarModelo();
        bimState.viewer.show(divState.dbId);
    }
    divState.dbId = null; divState.guid = null; divState.eje = null; divState.cortes = []; divState.ids = []; divState._historial = []; divState._nextId = 1;
    divState.ext0 = 0; divState.ext1 = 1;
    bimSetMeta('<div class="bim-meta-placeholder"><i class="fas fa-cube bim-meta-icon"></i><p>Original restaurado. Haz clic en otro tubo para dividirlo, o sal con las tijeras.</p></div>');
}

/** Cancela la edición actual sin tocar lo persistido. */
export function bimDividirCancelar() {
    bimDivLimpiarSesion();
    if (divState.dbId !== null) {
        const guardada = divState.guid && divState.guardadas[divState.guid.toLowerCase()];
        if (guardada) {
            // Tenía división persistida: re-dibujar la versión guardada
            const partes = bimDivNormalizarPartes(guardada) || [];
            const idsG = bimDivIdsGuardados(guardada);
            partes.forEach(([a, b], i) => {
                const m = bimCrearPieza(divState.eje, a, b, divState.eje.colorOrig);
                if (m) {
                    m.userData = { guid: divState.guid, idx: i, idParte: idsG[i], a, b, eje: divState.eje };
                    bimDivRegistrarTrozo(m, divState.guid, idsG[i]);
                    divState.piezasGuardadas.push(m);
                }
            });
            bimDivColorearTrozos();
        } else {
            divState.ocultos = divState.ocultos.filter(id => id !== divState.dbId);
            bimState.viewer.show(divState.dbId); // sin persistencia: vuelve el original
        }
    }
    // Cancelar deshace también el aislamiento: no se dejó nada a medio asignar.
    bimDivMostrarModelo();
    bimDividirSalir(false);
    bimSetMeta(`<div class="bim-meta-placeholder"><i class="fas fa-cube bim-meta-icon"></i><p>Escanea un QR o busca un spool para ver su información y resaltarlo en el modelo 3D</p></div>`);
}

/**
 * Devuelve el ID_SPOOL largo y demás datos de un tag corto (SPOOL LUKEAPP),
 * resolviéndolo contra el índice precargado.
 */
export function bimResolverSpool(tag) {
    if (!tag || !bimState.spoolIndex) return null;
    return bimState.spoolIndex[String(tag).toLowerCase()] || null;
}

/** Despliega/contrae las tarjetas de detalle adicionales del spool. */
export function bimToggleMetaExtra(btn) {
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
export function bimToggleUnlinkMenu(ev) {
    if (ev) ev.stopPropagation();
    const menu = document.getElementById('bim-unlink-menu');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

/** Cierra el menú ⋮ (se llama al re-renderizar la info del vínculo). */
export function bimResetUnlinkMenu() {
    const menu = document.getElementById('bim-unlink-menu');
    if (menu) menu.style.display = 'none';
}

/** HTML del recuadro de estado: muestra TAG GESTIÓN + ID_SPOOL de los agrupados. */
export function bimRenderSpoolInfo(spoolsDistintos) {
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
export function bimRenderMultiSpoolMeta(spoolsDistintos) {
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
export function bimRenderMeta(data) {
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


    // Lista de elementos. Se repuebla contraída en cada spool: un spool agrupa
    // decenas de GUIDs y dejarla abierta empuja el resto del panel fuera de vista.
    if (els.length > 0) {
        const ul = document.getElementById('bim-elements-ul');
        if (ul) {
            ul.innerHTML = els.map(el => `
                <li class="bim-element-item">
                    <i class="fas fa-cube" style="color:var(--accent);margin-right:6px"></i>
                    <span title="${el.guid}">${el.descripcion || el.guid.substring(0, 8) + '...'}</span>
                </li>`).join('');
            ul.style.display = 'none';
        }
        const countEl = document.getElementById('bim-elements-count');
        if (countEl) countEl.textContent = els.length;
        const toggle = document.getElementById('bim-elements-toggle');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
        const listEl = document.getElementById('bim-elements-list');
        if (listEl) listEl.style.display = 'block';
    }
}

/** Despliega/contrae la lista de elementos del modelo. */
export function bimToggleElementsList() {
    const ul = document.getElementById('bim-elements-ul');
    const toggle = document.getElementById('bim-elements-toggle');
    if (!ul) return;
    const abierto = ul.style.display !== 'none';
    ul.style.display = abierto ? 'none' : 'flex';
    if (toggle) toggle.setAttribute('aria-expanded', String(!abierto));
}

/** Helper: actualiza el contenido del panel de metadata */
export function bimSetMeta(html) {
    const el = document.getElementById('bim-meta-panel');
    if (el) el.innerHTML = html;
}

/**
 * Muestra el indicador de carga del panel de metadata y lo trae a la vista.
 * En la barra lateral el panel va por debajo de los chips de estado y del
 * panel de vinculación, así que al buscar un spool el spinner puede quedar
 * fuera de pantalla y la búsqueda parece no responder.
 */
export function bimSetMetaCargando(texto) {
    bimSetMeta(`<div class="bim-loading-meta"><div class="bim-spinner-sm"></div> ${texto}</div>`);
    const el = document.getElementById('bim-meta-panel');
    if (el && typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

/** Helper: actualiza el loader con mensaje opcional de error */
export function bimSetLoader(msg, isError = false) {
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
 * Pinta el panel de vinculación para capas válvula/soporte/subsistema.
 * A diferencia de spools, aquí 1 elemento = 1 ítem (sin auto-grupo).
 */
export function bimRenderCapaSelection(capa, selectedList, uniqueLayers) {
    bimResetUnlinkMenu();
    const ui = BIM_CAPA_UI[capa] || BIM_CAPA_UI['spool'];
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

    const statusContainer = document.getElementById('bim-link-status-container');
    const infoEl = document.getElementById('bim-link-spool-info');
    const inputEl = document.getElementById('bim-link-spool');
    const fieldContainer = document.querySelector('#bim-link-panel .bim-link-field');
    const btnSave = document.getElementById('bim-link-btn');
    const unlinkBtn = document.getElementById('bim-unlink-btn');

    if (fieldContainer) fieldContainer.style.display = 'block';
    if (btnSave) btnSave.style.display = 'block';
    if (unlinkBtn) unlinkBtn.innerHTML = `<i class="fas fa-unlink"></i> Desvincular de ${ui.label}`;

    // Manejo específico para capa subsistemas
    if (capa === 'subsistema') {
        bimPopulateDatalist('subsistema');

        if (selectedList.length === 1) {
            const elObj = selectedList[0];
            fetch(`/api/bim/elemento/${encodeURIComponent(elObj.guid)}`)
                .then(r => r.json())
                .then(info => {
                    if (info && info.guid) {
                        if (!info.tagLinea || info.tagLinea === 'N/A') info.tagLinea = elObj.tag || elObj.lineNo || info.tag;
                        if (!info.spool || info.spool === 'SIN SPOOL') info.spool = elObj.spool || info.spool;

                        const tieneSub = info.subsistema && info.subsistema !== 'SIN SUBSISTEMA';
                        if (statusContainer) statusContainer.style.display = tieneSub ? 'flex' : 'none';
                        if (infoEl && tieneSub) {
                            infoEl.innerHTML = `
                                <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
                                    <span style="opacity:0.75;">Sub-sistema actual:</span>
                                    <span style="font-weight:700;color:#c4b5fd;text-align:right;word-break:break-all;">${info.subsistema}</span>
                                </div>`;
                        }
                        if (inputEl) inputEl.value = tieneSub ? info.subsistema : '';
                        bimRenderElementoMeta(info);
                    }
                })
                .catch(err => console.error('[BIM Elemento Info Error]', err));
        } else {
            const guids = selectedList.map(x => x.guid);
            fetch('/api/bim/elementos-info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ guids })
            })
            .then(r => r.json())
            .then(res => {
                const elems = Object.values(res.elements || {});
                const tags = [...new Set(elems.map(e => e.tagLinea || e.tag).filter(Boolean))];
                const spools = [...new Set(elems.map(e => e.spool).filter(Boolean))];
                const subs = [...new Set(elems.map(e => e.subsistema).filter(Boolean))];

                const tieneSub = subs.length > 0;
                if (statusContainer) statusContainer.style.display = tieneSub ? 'flex' : 'none';
                if (infoEl && tieneSub) {
                    infoEl.innerHTML = `
                        <div style="font-size:0.85rem;font-weight:700;color:#c4b5fd;margin-bottom:2px;">
                            Sub-sistema(s) actual(es):
                        </div>
                        <div style="font-size:0.78rem;color:#e2e8f0;">${subs.join(', ')}</div>`;
                }
                if (inputEl) inputEl.value = subs.length === 1 ? subs[0] : '';
                bimRenderMultiElementoMeta(selectedList.length, tags, spools, subs, elems);
            })
            .catch(err => console.error('[BIM Multi Elemento Info Error]', err));
        }

        if (btnSave) {
            btnSave.innerHTML = `<i class="fas fa-save"></i> Guardar ${selectedList.length} elem.`;
            btnSave.disabled = false;
            btnSave.style.opacity = '1';
        }
        return;
    }

    if (fieldContainer) fieldContainer.style.display = 'block';
    if (btnSave) btnSave.style.display = 'block';

    // IDs ya vinculados en la selección
    const idsSel = [...new Set(selectedList.map(el => mapeo[el.guid.toLowerCase()]).filter(Boolean))];

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

/** Renderiza la tarjeta consolidada con el TAG del elemento, Spool, Sub-sistema y metadatos. */
export function bimRenderElementoMeta(data) {
    if (!data) return;
    const estado = String(data.status || 'SIN ESTADO').toUpperCase();
    const hexColor = (typeof bimRgbAHex === 'function' && typeof bimColorDeEstado === 'function')
        ? bimRgbAHex(bimColorDeEstado(estado))
        : '#8b5cf6';
    
    const tagVal = (data.tagLinea && data.tagLinea !== 'N/A') ? data.tagLinea : data.tag;

    const fields = [
        { label: 'TAG Elemento / Línea', value: tagVal, icon: 'fa-tag', highlight: true },
        { label: 'Spool (TAG Gestión)', value: data.spool, icon: 'fa-industry' },
        { label: 'Estado del Spool', value: estado, icon: 'fa-circle-dot', estado: true },
        { label: 'Sub-sistema', value: data.subsistema, icon: 'fa-sitemap' },
        { label: 'CWP', value: data.cwp, icon: 'fa-map-marker-alt' },
        { label: 'Descripción', value: data.descripcion, icon: 'fa-info-circle' },
        { label: 'Diámetro / Tamaño', value: data.size, icon: 'fa-ruler' },
        { label: 'GUID 3D', value: data.guid, icon: 'fa-barcode' }
    ].filter(f => f.value && f.value !== 'N/A');

    const renderCard = f => {
        const dot = f.estado
            ? `<span style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:${hexColor};"></span>`
            : '';
        const highlightStyle = f.highlight
            ? 'background: rgba(139,92,246,0.15); border: 1px solid rgba(139,92,246,0.4); border-left: 4px solid #8b5cf6;'
            : '';
        const valueStyle = f.highlight
            ? 'color: #c4b5fd; font-weight: 700; font-size: 0.92rem;'
            : '';

        return `
        <div class="bim-meta-card" style="${highlightStyle}">
            <span class="bim-meta-icon-sm" style="${f.highlight ? 'color:#a78bfa;' : ''}"><i class="fas ${f.icon}"></i></span>
            <div>
                <span class="bim-meta-label">${f.label}</span>
                <span class="bim-meta-value" style="${valueStyle}">${dot}${f.value}</span>
            </div>
        </div>`;
    };

    const mainCards = fields.map(renderCard).join('');

    bimSetMeta(`
        <div class="bim-meta-header" style="background: rgba(139,92,246,0.2); border-color: rgba(139,92,246,0.4);">
            <i class="fas fa-tag" style="color: #a78bfa;"></i>
            <span style="font-weight:700;">${tagVal}</span>
            <span class="bim-badge" style="background:#8b5cf6;">TAG</span>
        </div>
        <div class="bim-meta-cards">${mainCards}</div>`);
}

/** Renderiza la tarjeta resumen para múltiple selección de elementos 3D. */
export function bimRenderMultiElementoMeta(count, tags, spools, subs, elems) {
    const renderList = (arr) => arr.length ? arr.map(x => `<span class="status-pill" style="font-size:0.7rem;background:rgba(255,255,255,0.08);">${x}</span>`).join(' ') : '<span style="opacity:0.5;">N/A</span>';
    
    bimSetMeta(`
        <div class="bim-meta-header" style="background: rgba(139,92,246,0.2); border-color: rgba(139,92,246,0.4);">
            <i class="fas fa-layer-group" style="color: #a78bfa;"></i>
            <span>${count} Elementos Seleccionados</span>
        </div>
        <div style="padding:10px 4px; display:flex; flex-direction:column; gap:8px; font-size:0.8rem;">
            <div>
                <span style="display:block;font-size:0.72rem;opacity:0.6;margin-bottom:2px;">TAGs de Línea (${tags.length})</span>
                <div style="display:flex;flex-wrap:wrap;gap:4px;">${renderList(tags)}</div>
            </div>
            <div>
                <span style="display:block;font-size:0.72rem;opacity:0.6;margin-bottom:2px;">Spools (${spools.length})</span>
                <div style="display:flex;flex-wrap:wrap;gap:4px;">${renderList(spools)}</div>
            </div>
            <div>
                <span style="display:block;font-size:0.72rem;opacity:0.6;margin-bottom:2px;">Sub-sistemas (${subs.length})</span>
                <div style="display:flex;flex-wrap:wrap;gap:4px;">${renderList(subs)}</div>
            </div>
        </div>`);
}

/** Renderiza la ficha (metadata + estado montaje) de una válvula/soporte. */
export async function bimRenderCapaMeta(capa, id) {
    if (capa === 'subsistema') return;
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
export async function bimRemoveLink() {
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

export const scannerState = {
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
export async function bimOpenScanner() {
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
export async function bimStartCamera() {
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
export function bimScanLoop() {
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
export function bimOnQRDetected(value) {
    console.log('[QR Scanner] Detectado:', value);

    // Flash visual de confirmación
    const resultEl   = document.getElementById('bim-scanner-result');
    const resultText = document.getElementById('bim-scanner-result-text');
    if (resultEl && resultText) {
        resultText.textContent = value;
        resultEl.style.display = 'flex';
    }

    // El QR se interpreta según la capa activa: escanear en la sección de
    // válvulas busca una válvula, no un spool.
    const capa = bimState.capa;
    const etiqueta = (BIM_CAPA_UI[capa]?.label || 'spool').toLowerCase();
    bimScannerSetStatus(`<i class="fas fa-check-circle" style="color:var(--accent)"></i> ¡Detectado! Cargando ${etiqueta}...`);

    // Esperar 1.2s para que el usuario vea el resultado y luego cerrar
    setTimeout(() => {
        bimCloseScanner();

        const inputEl = document.getElementById('bim-search-input');
        if (inputEl) inputEl.value = value;

        const cargar = () => (capa === 'spool')
            ? bimLoadSpool(value)
            : bimLoadCapaItem(capa, value);

        if (bimState.initialized) {
            cargar();
        } else {
            // Si el viewer no está listo, inicializarlo primero
            initBimViewer().then(cargar).catch(console.error);
        }
    }, 1200);
}

/** Cierra el modal y detiene el stream de cámara */
export function bimCloseScanner() {
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
export function bimStopStream() {
    if (scannerState.stream) {
        scannerState.stream.getTracks().forEach(t => t.stop());
        scannerState.stream = null;
    }
    const video = document.getElementById('bim-qr-video');
    if (video) video.srcObject = null;
}

/** Alterna entre cámara frontal y trasera */
export async function bimFlipCamera() {
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
export function bimScannerSetStatus(html) {
    const el = document.getElementById('bim-scanner-status');
    if (el) el.innerHTML = html;
}

// =================================================================
// ============ MOBILE RESPONSIVE DRAWER TOGGLE ====================
// =================================================================

/** Alterna la barra lateral en versión móvil / tablet */
export function bimToggleSidebar() {
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
export function bimCloseSidebar() {
    const sidebar = document.querySelector('.bim-sidebar');
    const overlay = document.getElementById('bim-sidebar-overlay');
    const btn     = document.getElementById('bim-sidebar-toggle');
    if (sidebar) sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('active');
    if (btn) btn.innerHTML = '<i class="fas fa-info-circle"></i>';
}

/** Guarda la vinculación de los elementos 3D seleccionados en AppSheet */
export async function bimSaveLink() {
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












// ============================================================
// CONTROL DE ACCESO (escritura) — frontend
// Lectura abierta; escritura pide clave por área (bim / bot).
// El token se guarda en localStorage y se valida en el servidor.
// ============================================================





/** Garantiza que exista un token válido para el área; si no, pide la clave. */

/** Modal de clave. Devuelve la clave (string) o null si se cancela. */

// Botón dentro del panel Bot para reintentar el desbloqueo manualmente.


// ============================================================
// BOT — Catálogo de herramientas dinámicas (mapa del mundo)
// ============================================================


/**
 * Abre el visualizador de PDF.
 * En PC divide la pantalla (Split Screen), en móviles abre un modal emergente.
 * Usa el proxy del backend para evitar restricciones de X-Frame-Options.
 */

/**
 * Cierra la visualización en pantalla dividida (PC).
 */

/**
 * Cierra el visualizador de PDF (ambos modos).
 */

/**
 * Obtiene el valor seleccionado en el selector de hojas y lo abre en el visualizador.
 */

/**
 * Obtiene el valor seleccionado en el selector de PIDs y lo abre en el visualizador.
 */


/**
 * Inicializa el sistema de redimensionamiento de pantalla dividida (Splitter Bar).
 * Permite arrastrar el divisor en PC para redimensionar el visor 3D y el plano PDF.
 */

// ── Puente a window ──────────────────────────────────────────────────────────
// index.html y el HTML generado en template strings invocan estas funciones
// desde onclick; bim-ifc-export.js (script clásico) usa divState,
// bimStatusPorGuid y bimSetMeta.
if (typeof window !== 'undefined') {
    window.bimCambiarModelo         = bimCambiarModelo;
    window.bimCloseScanner          = bimCloseScanner;
    window.bimCloseSidebar          = bimCloseSidebar;
    window.bimDivMostrarModelo      = bimDivMostrarModelo;
    window.bimDivReocultarOriginales = bimDivReocultarOriginales;
    window.bimDividirDeshacer       = bimDividirDeshacer;
    window.bimDividirFinalizar      = bimDividirFinalizar;
    window.bimDividirRestaurar      = bimDividirRestaurar;
    window.bimFitToView             = bimFitToView;
    window.bimFlipCamera            = bimFlipCamera;
    window.bimGuardarColorEstado    = bimGuardarColorEstado;
    window.bimIsolateElements       = bimIsolateElements;
    window.bimLimpiarFiltroEstados  = bimLimpiarFiltroEstados;
    window.bimOpenScanner           = bimOpenScanner;
    window.bimRemoveLink            = bimRemoveLink;
    window.bimResetView             = bimResetView;
    window.bimSaveLink              = bimSaveLink;
    window.bimSearchSpool           = bimSearchSpool;
    window.bimSetCapa               = bimSetCapa;
    window.bimSetMeta               = bimSetMeta;
    window.bimStatusPorGuid         = bimStatusPorGuid;
    window.bimToggleEstado          = bimToggleEstado;
    window.bimSubsistemaVerPorEstado = bimSubsistemaVerPorEstado;
    window.bimAplicarFiltroEstados  = bimAplicarFiltroEstados;
    window.bimToggleElementsList    = bimToggleElementsList;
    window.bimToggleMetaExtra       = bimToggleMetaExtra;
    window.bimToggleSidebar         = bimToggleSidebar;
    window.bimToggleUnlinkMenu      = bimToggleUnlinkMenu;
    window.bimTrozoDesvincular      = bimTrozoDesvincular;
    window.bimTrozoEditarDivision   = bimTrozoEditarDivision;
    window.bimTrozoEliminarDivision = bimTrozoEliminarDivision;
    window.bimTrozoVincular         = bimTrozoVincular;
    window.bimRenderElementoMeta    = bimRenderElementoMeta;
    window.bimRenderMultiElementoMeta = bimRenderMultiElementoMeta;
    window.divState                 = divState;
}
