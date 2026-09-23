/**
 * Componente renderLineas.js — Sección de Control de Líneas & Test Packs
 * 
 * Integra:
 * 1. 🌳 Árbol de Test Packs detectados desde LIST_Juntas_MS_ (Jerarquía Test Pack -> Líneas -> Spools -> Juntas).
 * 2. ⚠️ Vista de Elementos Huérfanos (Líneas, Spools y Juntas sin Test Pack asignado).
 * 3. 📋 Vista Consolidada clásica por Línea de cañería con desglose de isométricos y P&IDs.
 * 4. 💬 Sistema interactivo de notas y comentarios por nodo jerárquico.
 */

import { state } from '../modules/state.js';

let lineasCacheData = null;
let testPacksCacheData = null;
let comentariosCacheMap = new Map(); // "tipo:id" -> Array de comentarios
let activeSubTab = 'testpacks'; // 'testpacks' | 'huerfanos' | 'lineas'
let isFetchingData = false;

// Estado actual del modal de comentarios y custodia
let currentCommentEntity = null; // { tipo, id, tp }
let currentCustodiaTp = null; // nombre del Test Pack actual en modal de custodia

export async function loadLineasData(forceRefresh = false) {
    const container = document.getElementById('lineas-container');
    if (!container) return;

    tryPreFillInitialKPIs();

    if (!forceRefresh && lineasCacheData && testPacksCacheData) {
        actualizarBadgesSubTabs();
        actualizarKPIsGlobales();
        filterLineas();
        return;
    }

    if (isFetchingData) return;
    isFetchingData = true;

    container.innerHTML = `
        <div class="empty-msg" style="text-align:center; padding: 40px; opacity:0.8;">
            <i class="fas fa-spinner fa-spin" style="font-size:1.8rem; margin-bottom:10px; color:#818cf8;"></i>
            <p style="font-weight:600; color:#f8fafc;">Cargando árbol de Test Packs y consolidado de líneas...</p>
            <p style="font-size:0.8rem; color:#94a3b8;">Procesando LIST_Juntas_MS_, spools y estados de avance...</p>
        </div>
    `;

    try {
        const [resLineas, resTp, resComentarios] = await Promise.all([
            fetch(`/api/lineas/resumen${forceRefresh ? '?refresh=true' : ''}`),
            fetch(`/api/testpacks/tree${forceRefresh ? '?refresh=true' : ''}`),
            fetch('/api/testpacks/comentarios')
        ]);

        if (resLineas.ok) {
            const dLineas = await resLineas.json();
            lineasCacheData = dLineas.lineas || [];
        }

        if (resTp.ok) {
            testPacksCacheData = await resTp.json();
            if (testPacksCacheData?.test_packs) {
                const getTpNum = (name) => {
                    const m = String(name || '').match(/\d+/);
                    return m ? parseInt(m[0], 10) : 999999;
                };
                testPacksCacheData.test_packs.sort((a, b) => {
                    const numA = getTpNum(a.nombre);
                    const numB = getTpNum(b.nombre);
                    if (numA !== numB) return numA - numB;
                    return a.nombre.localeCompare(b.nombre);
                });
            }
        }

        if (resComentarios.ok) {
            const dComents = await resComentarios.json();
            indexarComentarios(dComents);
        }

        actualizarBadgesSubTabs();
        actualizarKPIsGlobales();
        filterLineas();
    } catch (e) {
        console.error('[renderLineas] Error cargando datos:', e.message);
        container.innerHTML = `
            <div class="empty-msg" style="text-align:center; padding: 40px; color:#ef4444;">
                <i class="fas fa-exclamation-triangle" style="font-size:1.8rem; margin-bottom:8px;"></i>
                <p>Error al cargar datos de líneas y Test Packs: ${escapeHtml(e.message)}</p>
                <button onclick="refrescarDatosLineas(true)" class="glass-btn" style="margin-top:10px;">Reintentar</button>
            </div>
        `;
    } finally {
        isFetchingData = false;
    }
}

function indexarComentarios(list) {
    comentariosCacheMap.clear();
    (list || []).forEach(c => {
        const key = `${c.entidad_tipo}:${c.entidad_id}`.toLowerCase();
        if (!comentariosCacheMap.has(key)) {
            comentariosCacheMap.set(key, []);
        }
        comentariosCacheMap.get(key).push(c);
    });
}

function getComentariosCount(tipo, id) {
    if (!tipo || !id) return 0;
    const key = `${tipo}:${id}`.toLowerCase();
    return comentariosCacheMap.get(key)?.length || 0;
}

function tryPreFillInitialKPIs() {
    try {
        const elTotal = document.getElementById('kpi-lineas-total');
        const elJuntas = document.getElementById('kpi-lineas-juntas');
        const elSpools = document.getElementById('kpi-lineas-spools');

        if (state.lineas && state.lineas.length > 0 && elTotal) {
            elTotal.textContent = state.lineas.length;
        }

        if (state.juntas && state.juntas.length > 0 && elJuntas) {
            const totalJ = state.juntas.length;
            const ejecJ = (state.ejecuciones || []).length;
            const pctJ = totalJ > 0 ? ((ejecJ / totalJ) * 100).toFixed(1) : '0';
            elJuntas.textContent = `${ejecJ} / ${totalJ} (${pctJ}%)`;
        }

        if (state.spools && state.spools.length > 0 && elSpools) {
            const totalS = state.spools.length;
            let montadosS = 0;
            if (state.spoolStatuses) {
                Object.values(state.spoolStatuses).forEach(s => {
                    const st = String(s.status || '').toUpperCase();
                    if (st === 'MONTADO' || st === 'MONTADA') montadosS++;
                });
            } else {
                state.spools.forEach(s => {
                    const cv = String(s.ESTADO_CICLO_VIDA || s.Montaje || '').toUpperCase();
                    if (cv === 'MONTADO' || cv === 'MONTADA' || cv === 'SI' || cv === '1') montadosS++;
                });
            }
            const pctS = totalS > 0 ? ((montadosS / totalS) * 100).toFixed(1) : '0';
            elSpools.textContent = `${montadosS} / ${totalS} (${pctS}%)`;
        }
    } catch (e) { /* silencioso */ }
}

function actualizarKPIsGlobales() {
    if (testPacksCacheData?.kpis) {
        const kpis = testPacksCacheData.kpis;
        const elTpTotal = document.getElementById('kpi-lineas-tp-total');
        const elTpCob = document.getElementById('kpi-lineas-tp-cobertura');

        if (elTpTotal) elTpTotal.textContent = `${kpis.total_test_packs} detectados`;
        if (elTpCob) {
            elTpCob.textContent = `${kpis.total_juntas_asignadas} / ${kpis.total_juntas_global} (${kpis.cobertura_porcentaje}%)`;
        }
    }

    if (lineasCacheData) {
        const totalLineas = lineasCacheData.length;
        let juntasTotal = 0, juntasEjec = 0;
        let spoolsTotal = 0, spoolsMontados = 0;
        let soportesTotal = 0, soportesMontados = 0;

        lineasCacheData.forEach(l => {
            juntasTotal += l.juntas.total || 0;
            juntasEjec += l.juntas.ejecutadas || 0;
            spoolsTotal += l.spools.total || 0;
            spoolsMontados += l.spools.montados || 0;
            soportesTotal += l.soportes.total || 0;
            soportesMontados += l.soportes.montados || 0;
        });

        const elTotal = document.getElementById('kpi-lineas-total');
        const elJuntas = document.getElementById('kpi-lineas-juntas');
        const elSpools = document.getElementById('kpi-lineas-spools');
        const elSoportes = document.getElementById('kpi-lineas-soportes');

        if (elTotal) elTotal.textContent = totalLineas;
        if (elJuntas) {
            const pct = juntasTotal > 0 ? ((juntasEjec / juntasTotal) * 100).toFixed(1) : '0';
            elJuntas.textContent = `${juntasEjec} / ${juntasTotal} (${pct}%)`;
        }
        if (elSpools) {
            const pct = spoolsTotal > 0 ? ((spoolsMontados / spoolsTotal) * 100).toFixed(1) : '0';
            elSpools.textContent = `${spoolsMontados} / ${spoolsTotal} (${pct}%)`;
        }
        if (elSoportes) {
            const pct = soportesTotal > 0 ? ((soportesMontados / soportesTotal) * 100).toFixed(1) : '0';
            elSoportes.textContent = `${soportesMontados} / ${soportesTotal} (${pct}%)`;
        }
    }
}

function actualizarBadgesSubTabs() {
    const badgeTp = document.getElementById('badge-subtab-tp');
    const badgeHuerf = document.getElementById('badge-subtab-huerfanos');
    const badgeLineas = document.getElementById('badge-subtab-lineas');

    if (testPacksCacheData) {
        if (badgeTp) badgeTp.textContent = testPacksCacheData.test_packs?.length || 0;
        if (badgeHuerf) badgeHuerf.textContent = testPacksCacheData.sin_test_pack?.metricas?.total_juntas || 0;
    }
    if (lineasCacheData && badgeLineas) {
        badgeLineas.textContent = lineasCacheData.length || 0;
    }
}

export function setLineasSubTab(subTab) {
    activeSubTab = subTab;

    // Actualizar botones activos
    const btnTp = document.getElementById('btn-subtab-tp');
    const btnHuerf = document.getElementById('btn-subtab-huerfanos');
    const btnLineas = document.getElementById('btn-subtab-lineas');
    const titleEl = document.getElementById('lineas-section-view-title');

    [btnTp, btnHuerf, btnLineas].forEach(b => b?.classList.remove('active'));

    if (subTab === 'testpacks') {
        btnTp?.classList.add('active');
        if (titleEl) titleEl.innerHTML = '<i class="fas fa-vial"></i> Árbol de Test Packs Detectados';
    } else if (subTab === 'huerfanos') {
        btnHuerf?.classList.add('active');
        if (titleEl) titleEl.innerHTML = '<i class="fas fa-exclamation-triangle" style="color:#fbbf24;"></i> Elementos Sin Test Pack Asignado';
    } else {
        btnLineas?.classList.add('active');
        if (titleEl) titleEl.innerHTML = '<i class="fas fa-project-diagram"></i> Listado Consolidado por Líneas';
    }

    filterLineas();
}

export function filterLineas() {
    const query = (document.getElementById('lineas-search')?.value || '').toLowerCase().trim();
    const filterAvance = document.getElementById('lineas-filter-avance')?.value || 'TODOS';
    const filterCustodia = document.getElementById('lineas-filter-custodia')?.value || 'TODOS';
    const badgeTotal = document.getElementById('badge-total-lineas');

    if (activeSubTab === 'testpacks') {
        if (!testPacksCacheData || !testPacksCacheData.test_packs) return;

        const filteredTps = testPacksCacheData.test_packs.filter(tp => {
            const matchQuery = !query ||
                tp.nombre.toLowerCase().includes(query) ||
                (tp.custodia?.responsable && tp.custodia.responsable.toLowerCase().includes(query)) ||
                (tp.custodia?.departamento && tp.custodia.departamento.toLowerCase().includes(query)) ||
                tp.lineas.some(l => 
                    l.id_linea.toLowerCase().includes(query) ||
                    (l.subsistema && l.subsistema.toLowerCase().includes(query)) ||
                    l.spools.some(sp => 
                        sp.id_spool.toLowerCase().includes(query) ||
                        sp.juntas.some(j => j.id_junta.toLowerCase().includes(query))
                    )
                );

            if (!matchQuery) return false;

            const pct = tp.metricas.juntas_porcentaje;
            if (filterAvance === '100') {
                if (pct < 100) return false;
            } else if (filterAvance === 'EN_PROCESO') {
                if (pct <= 0 || pct >= 100) return false;
            } else if (filterAvance === 'PENDIENTE') {
                if (pct > 0) return false;
            }

            // Filtro por custodia de carpeta física
            if (filterCustodia !== 'TODOS') {
                if (filterCustodia === 'SIN_ASIGNAR') {
                    if (tp.custodia && tp.custodia.responsable) return false;
                } else {
                    if (!tp.custodia || !tp.custodia.responsable) return false;
                    const dep = tp.custodia.departamento || '';
                    if (dep.toLowerCase() !== filterCustodia.toLowerCase()) return false;
                }
            }

            return true;
        });

        const getTpNum = (name) => {
            const m = String(name || '').match(/\d+/);
            return m ? parseInt(m[0], 10) : 999999;
        };
        filteredTps.sort((a, b) => {
            const numA = getTpNum(a.nombre);
            const numB = getTpNum(b.nombre);
            if (numA !== numB) return numA - numB;
            return a.nombre.localeCompare(b.nombre);
        });

        if (badgeTotal) badgeTotal.textContent = `${filteredTps.length} Test Packs`;
        renderTestPackTree(filteredTps, query);
    } else if (activeSubTab === 'huerfanos') {
        if (!testPacksCacheData || !testPacksCacheData.sin_test_pack) return;

        const sinTp = testPacksCacheData.sin_test_pack;
        const filteredArbol = (sinTp.arbol || []).filter(l => {
            const matchQuery = !query ||
                l.id_linea.toLowerCase().includes(query) ||
                (l.subsistema && l.subsistema.toLowerCase().includes(query)) ||
                l.spools.some(sp => 
                    sp.id_spool.toLowerCase().includes(query) ||
                    sp.juntas.some(j => j.id_junta.toLowerCase().includes(query))
                );

            if (!matchQuery) return false;

            const pct = l.metricas.juntas_porcentaje;
            if (filterAvance === '100') return pct >= 100;
            if (filterAvance === 'EN_PROCESO') return pct > 0 && pct < 100;
            if (filterAvance === 'PENDIENTE') return pct === 0;

            return true;
        });

        if (badgeTotal) badgeTotal.textContent = `${filteredArbol.length} líneas huérfanas`;
        renderHuerfanosView(sinTp, filteredArbol, query);
    } else {
        // Vista Clásica por Líneas
        if (!lineasCacheData) return;

        const filteredLineas = lineasCacheData.filter(l => {
            const matchText = !query || 
                l.id_linea.toLowerCase().includes(query) ||
                (l.subsistema && l.subsistema.toLowerCase().includes(query)) ||
                (l.cwp && l.cwp.toLowerCase().includes(query)) ||
                (l.pid && l.pid.toLowerCase().includes(query)) ||
                (l.test_packs && l.test_packs.some(tp => tp.toLowerCase().includes(query))) ||
                (l.isometricos && l.isometricos.some(iso => 
                    iso.id_iso.toLowerCase().includes(query) || 
                    iso.hoja.toLowerCase().includes(query) ||
                    (iso.test_packs && iso.test_packs.some(tp => tp.toLowerCase().includes(query)))
                ));

            if (!matchText) return false;

            const pct = l.juntas.porcentaje;
            if (filterAvance === '100') return pct >= 100;
            if (filterAvance === 'EN_PROCESO') return pct > 0 && pct < 100;
            if (filterAvance === 'PENDIENTE') return pct === 0;

            return true;
        });

        if (badgeTotal) badgeTotal.textContent = `${filteredLineas.length} líneas`;
        renderLineasCards(filteredLineas);
    }
}

/**
 * 1. RENDER VISTA ÁRBOL DE TEST PACKS
 */
function renderTestPackTree(tps, query) {
    const container = document.getElementById('lineas-container');
    if (!container) return;

    if (!tps || tps.length === 0) {
        container.innerHTML = `
            <div class="empty-msg" style="text-align:center; padding: 40px; opacity:0.6;">
                <i class="fas fa-search-minus" style="font-size:1.6rem; margin-bottom:8px;"></i>
                <p>No se encontraron Test Packs que coincidan con la búsqueda o filtro.</p>
            </div>
        `;
        return;
    }

    let html = `<div class="tp-tree-list">`;

    tps.forEach((tp, tpIdx) => {
        const cleanTpId = tp.nombre.replace(/[^a-zA-Z0-9_-]/g, '_');
        const m = tp.metricas;
        const isComplete = m.juntas_porcentaje >= 100;
        const cardClass = isComplete ? 'tp-complete' : (m.juntas_porcentaje > 0 ? 'tp-in-progress' : '');
        const commentsCount = getComentariosCount('test_pack', tp.nombre);

        // Estado de custodia de carpeta física
        const c = tp.custodia;
        let custodiaClass = 'custodia-sin-asignar';
        let custodiaIcon = 'far fa-folder';
        let custodiaLabel = 'Carpeta: Sin asignar';
        let custodiaTooltip = 'Click para indicar responsable y departamento de la carpeta física';

        if (c && c.responsable) {
            const depto = c.departamento || 'Terreno';
            if (depto === 'Terreno') {
                custodiaClass = 'custodia-terreno';
                custodiaIcon = 'fas fa-hard-hat';
            } else if (depto === 'QAQC') {
                custodiaClass = 'custodia-qaqc';
                custodiaIcon = 'fas fa-clipboard-check';
            } else if (depto === 'Oficina Técnica') {
                custodiaClass = 'custodia-ot';
                custodiaIcon = 'fas fa-drafting-compass';
            }
            custodiaLabel = `${depto}: ${escapeHtml(c.responsable)}`;
            custodiaTooltip = `Carpeta física en posesión de ${escapeHtml(c.responsable)} (${depto})${c.ubicacion_detalle ? ' - ' + escapeHtml(c.ubicacion_detalle) : ''}. Click para ver historial o traspasar.`;
        }

        // Si hay una búsqueda activa, expandir automáticamente
        const autoExpand = Boolean(query && query.length > 1);

        html += `
            <div class="tp-card ${cardClass}" id="tp-card-${cleanTpId}">
                <div class="tp-card-header" onclick="toggleTpAccordion('${cleanTpId}')">
                    <div class="tp-header-left">
                        <div class="tp-icon-bubble">
                            <i class="fas fa-vial"></i>
                        </div>
                        <div class="tp-title-box">
                            <h4>
                                <span>${escapeHtml(tp.nombre)}</span>
                                <span class="status-badge ${isComplete ? 'badge-success' : (m.juntas_porcentaje > 0 ? 'badge-warning' : 'badge-secondary')}" style="font-size:0.7rem;">
                                    ${isComplete ? '100% LISTO' : (m.juntas_porcentaje > 0 ? `${m.juntas_porcentaje}% EN PROCESO` : 'PENDIENTE')}
                                </span>
                            </h4>
                            <div class="tp-subinfo">
                                <span><i class="fas fa-stream"></i> <strong>${m.total_lineas}</strong> Líneas</span>
                                <span><i class="fas fa-industry"></i> <strong>${m.spools_montados}/${m.total_spools}</strong> Spools (${m.spools_porcentaje}%)</span>
                                <span><i class="fas fa-link"></i> <strong>${m.juntas_ejecutadas}/${m.juntas_total}</strong> Juntas (${m.pulgadas_ejecutadas}"/${m.pulgadas_total}")</span>
                                ${m.total_valvulas > 0 ? `<span><i class="fas fa-faucet" style="color:#38bdf8;"></i> <strong>${m.valvulas_montadas}/${m.total_valvulas}</strong> Válvulas (${m.valvulas_porcentaje}%)</span>` : ''}
                                ${m.total_soportes > 0 ? `<span><i class="fas fa-border-all" style="color:#fbbf24;"></i> <strong>${m.soportes_montados}/${m.total_soportes}</strong> Soportes (${m.soportes_porcentaje}%)</span>` : ''}
                            </div>
                        </div>
                    </div>

                    <div class="tp-header-right">
                        <!-- Badge Custodia Carpeta Física -->
                        <div class="tp-custodia-badge ${custodiaClass}" 
                             title="${custodiaTooltip}" 
                             onclick="event.stopPropagation(); abrirModalCustodia('${escapeHtml(tp.nombre)}')">
                            <i class="${custodiaIcon}"></i>
                            <span>${custodiaLabel}</span>
                        </div>

                        <button class="btn-comentario-trigger ${commentsCount > 0 ? 'has-comments' : ''}" 
                                onclick="event.stopPropagation(); abrirModalComentarios('test_pack', '${escapeHtml(tp.nombre)}', '${escapeHtml(tp.nombre)}')">
                            <i class="fas fa-comment${commentsCount > 0 ? 's' : ''}"></i>
                            <span>${commentsCount > 0 ? `${commentsCount} notas` : 'Comentar'}</span>
                        </button>

                        <div class="tp-mini-progress">
                            <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:#cbd5e1;">
                                <span>Avance Juntas</span>
                                <strong>${m.juntas_porcentaje}%</strong>
                            </div>
                            <div class="tp-progress-track">
                                <div class="tp-progress-fill" style="width: ${m.juntas_porcentaje}%;"></div>
                            </div>
                        </div>

                        <i class="fas fa-chevron-down" id="arrow-tp-${cleanTpId}" style="transition: transform 0.2s; font-size:0.9rem; color:#94a3b8; ${autoExpand ? 'transform: rotate(180deg);' : ''}"></i>
                    </div>
                </div>

                <div class="tp-body" id="body-tp-${cleanTpId}" style="display:${autoExpand ? 'block' : 'none'};">
                    ${renderTpLineas(tp.lineas, cleanTpId, tp.nombre, autoExpand)}
                </div>
            </div>
        `;
    });

    html += `</div>`;
    container.innerHTML = html;
}

function renderTpLineas(lineas, parentCleanId, tpNombre, autoExpand = false) {
    if (!lineas || lineas.length === 0) {
        return `<p style="padding:12px; font-size:0.85rem; color:#94a3b8;">Sin líneas asociadas a este Test Pack.</p>`;
    }

    let html = ``;
    lineas.forEach((l, lIdx) => {
        const cleanLineaId = `${parentCleanId}-l-${lIdx}`;
        const lm = l.metricas;
        const commentsCount = getComentariosCount('linea', l.id_linea);

        html += `
            <div class="tree-level-linea" id="node-linea-${cleanLineaId}">
                <div class="tree-linea-header" onclick="toggleTpLineaAccordion('${cleanLineaId}')">
                    <div class="tree-linea-title">
                        <i class="fas fa-grip-lines" style="color:#818cf8;"></i>
                        <span>${escapeHtml(l.id_linea)}</span>
                        ${l.subsistema ? `<span class="subtag-pill subtag-sub" style="font-size:0.7rem; padding:1px 6px;">${escapeHtml(l.subsistema)}</span>` : ''}
                    </div>

                    <div class="tree-linea-stats">
                        <span><i class="fas fa-industry"></i> ${lm.spools_montados}/${lm.total_spools} spools ${lm.spools_eliminados > 0 ? `<small style="color:#ef4444; font-size:0.7rem;" title="${lm.spools_eliminados} spool(s) eliminado(s) no suman a meta">(${lm.spools_eliminados} elim.)</small>` : ''}</span>
                        <span><i class="fas fa-link"></i> ${lm.juntas_ejecutadas}/${lm.juntas_total} juntas</span>
                        ${lm.total_valvulas > 0 ? `<span title="Válvulas montadas / totales"><i class="fas fa-faucet" style="color:#38bdf8;"></i> ${lm.valvulas_montadas}/${lm.total_valvulas} válv.</span>` : ''}
                        ${lm.total_soportes > 0 ? `<span title="Soportes montados / totales"><i class="fas fa-border-all" style="color:#fbbf24;"></i> ${lm.soportes_montados}/${lm.total_soportes} sop.</span>` : ''}
                        
                        <button class="btn-comentario-trigger ${commentsCount > 0 ? 'has-comments' : ''}" 
                                onclick="event.stopPropagation(); abrirModalComentarios('linea', '${escapeHtml(l.id_linea)}', '${escapeHtml(tpNombre)}')">
                            <i class="fas fa-comment${commentsCount > 0 ? 's' : ''}"></i>
                            <span>${commentsCount > 0 ? commentsCount : ''}</span>
                        </button>

                        <i class="fas fa-chevron-down" id="arrow-linea-${cleanLineaId}" style="transition: transform 0.2s; font-size:0.8rem; ${autoExpand ? 'transform: rotate(180deg);' : ''}"></i>
                    </div>
                </div>

                <div class="tree-spools-wrapper" id="body-linea-${cleanLineaId}" style="display:${autoExpand ? 'flex' : 'none'};">
                    ${renderTpSpools(l.spools, cleanLineaId, tpNombre, autoExpand)}
                    ${renderTpValvulasSection(l.valvulas, cleanLineaId, tpNombre)}
                    ${renderTpSoportesSection(l.soportes, cleanLineaId, tpNombre)}
                </div>
            </div>
        `;
    });

    return html;
}

function renderTpSpools(spools, parentCleanId, tpNombre, autoExpand = false) {
    if (!spools || spools.length === 0) {
        return `<p style="font-size:0.8rem; color:#94a3b8; margin:0;">Sin spools asociados.</p>`;
    }

    let html = ``;
    spools.forEach((sp, spIdx) => {
        const cleanSpId = `${parentCleanId}-sp-${spIdx}`;
        const isEliminado = sp.eliminado || (sp.status === 'ELIMINADO' || sp.status === 'ELIMINADA' || sp.status === 'CANCELADO' || sp.status === 'CANCELADA');
        const isMontado = sp.montado && !isEliminado;
        const statusBadgeClass = isEliminado ? 'badge-danger' : (isMontado ? 'badge-success' : 'badge-secondary');
        const commentsCount = getComentariosCount('spool', sp.id_spool);
        const juntasEjec = sp.juntas.filter(j => j.ejecutada).length;

        html += `
            <div class="tree-spool-node ${isEliminado ? 'tree-spool-eliminado' : ''}" id="node-spool-${cleanSpId}" style="${isEliminado ? 'opacity: 0.65; border-color: rgba(239, 68, 68, 0.25);' : ''}">
                <div class="tree-spool-header" onclick="toggleTpSpoolAccordion('${cleanSpId}')">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <i class="fas ${isEliminado ? 'fa-ban' : 'fa-cube'}" style="color:${isEliminado ? '#ef4444' : (isMontado ? '#10b981' : '#38bdf8')}; font-size:0.85rem;"></i>
                        <strong style="${isEliminado ? 'text-decoration: line-through; color:#94a3b8;' : ''}">${escapeHtml(sp.id_spool)}</strong>
                        <span class="status-badge ${statusBadgeClass}" style="font-size:0.65rem; padding:1px 6px;">${escapeHtml(sp.status)}</span>
                        ${isEliminado ? '<span style="font-size:0.65rem; color:#ef4444; font-weight:600;">(No computable)</span>' : ''}
                    </div>

                    <div style="display:flex; align-items:center; gap:10px; font-size:0.75rem; color:#94a3b8;">
                        <span><i class="fas fa-link"></i> ${juntasEjec}/${sp.juntas.length} juntas</span>
                        
                        <button class="btn-comentario-trigger ${commentsCount > 0 ? 'has-comments' : ''}" 
                                onclick="event.stopPropagation(); abrirModalComentarios('spool', '${escapeHtml(sp.id_spool)}', '${escapeHtml(tpNombre)}')">
                            <i class="fas fa-comment${commentsCount > 0 ? 's' : ''}"></i>
                            <span>${commentsCount > 0 ? commentsCount : ''}</span>
                        </button>

                        <i class="fas fa-chevron-down" id="arrow-spool-${cleanSpId}" style="transition: transform 0.2s; font-size:0.75rem; ${autoExpand ? 'transform: rotate(180deg);' : ''}"></i>
                    </div>
                </div>

                <div class="tree-juntas-table-wrapper" id="body-spool-${cleanSpId}" style="display:${autoExpand ? 'block' : 'none'};">
                    ${renderTpJuntasTable(sp.juntas, tpNombre)}
                </div>
            </div>
        `;
    });

    return html;
}

function renderTpJuntasTable(juntas, tpNombre) {
    if (!juntas || juntas.length === 0) {
        return `<p style="font-size:0.75rem; color:#94a3b8; margin:0;">Sin juntas registradas.</p>`;
    }

    let rowsHtml = juntas.map(j => {
        const isEjec = j.ejecutada;
        const commentsCount = getComentariosCount('junta', j.id_junta);

        return `
            <tr>
                <td>
                    <strong style="color:#f8fafc;"><i class="fas fa-circle" style="font-size:0.45rem; color:${isEjec ? '#10b981' : '#f59e0b'}; margin-right:5px;"></i>${escapeHtml(j.id_junta)}</strong>
                    ${j.id_iso ? `<div style="font-size:0.7rem; color:#94a3b8;"><i class="fas fa-file-alt"></i> ${escapeHtml(j.id_iso)}</div>` : ''}
                </td>
                <td><span class="subtag-pill" style="font-size:0.7rem; padding:1px 5px;">${escapeHtml(j.tipo_union)}</span></td>
                <td><strong>${j.dn}"</strong></td>
                <td>
                    <span class="status-badge ${isEjec ? 'badge-success' : 'badge-warning'}" style="font-size:0.65rem; padding:1px 6px;">
                        ${isEjec ? 'EJECUTADA' : 'PENDIENTE'}
                    </span>
                    ${j.soldador ? `<div style="font-size:0.68rem; color:#94a3b8;">👨‍🏭 ${escapeHtml(j.soldador)}</div>` : ''}
                </td>
                <td style="text-align:right;">
                    <button class="btn-comentario-trigger ${commentsCount > 0 ? 'has-comments' : ''}" 
                            onclick="event.stopPropagation(); abrirModalComentarios('junta', '${escapeHtml(j.id_junta)}', '${escapeHtml(tpNombre)}')">
                        <i class="fas fa-comment${commentsCount > 0 ? 's' : ''}"></i>
                        <span>${commentsCount > 0 ? commentsCount : ''}</span>
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    return `
        <table class="tree-juntas-table">
            <thead>
                <tr>
                    <th>Unión / Junta</th>
                    <th>Tipo</th>
                    <th>NPS</th>
                    <th>Estado</th>
                    <th style="text-align:right;">Comentarios</th>
                </tr>
            </thead>
            <tbody>
                ${rowsHtml}
            </tbody>
        </table>
    `;
}

function renderTpValvulasSection(valvulas, parentCleanId, tpNombre) {
    if (!valvulas || valvulas.length === 0) return '';
    const cleanVId = `${parentCleanId}-valvulas`;
    const montadas = valvulas.filter(v => v.montada).length;
    const pct = ((montadas / valvulas.length) * 100).toFixed(0);

    const rowsHtml = valvulas.map(v => {
        const commentsCount = getComentariosCount('valvula', v.id_valvula);
        return `
            <tr>
                <td>
                    <strong style="color:#f8fafc;"><i class="fas fa-faucet" style="color:#38bdf8; margin-right:5px; font-size:0.8rem;"></i>${escapeHtml(v.id_valvula)}</strong>
                    ${v.tag_piping ? `<span class="subtag-pill" style="font-size:0.65rem; padding:1px 5px; margin-left:4px;">${escapeHtml(v.tag_piping)}</span>` : ''}
                </td>
                <td style="color:#cbd5e1; font-size:0.75rem;">${escapeHtml(v.descripcion || '-')}</td>
                <td><strong>${escapeHtml(v.diametro || '-')}</strong> ${v.clase ? `<span style="opacity:0.6; font-size:0.75rem;">(${escapeHtml(v.clase)})</span>` : ''}</td>
                <td>
                    <span class="status-badge ${v.montada ? 'badge-success' : 'badge-secondary'}" style="font-size:0.65rem; padding:1px 6px;">
                        ${escapeHtml(v.status || 'PENDIENTE')}
                    </span>
                </td>
                <td style="text-align:right;">
                    <button class="btn-comentario-trigger ${commentsCount > 0 ? 'has-comments' : ''}" 
                            onclick="event.stopPropagation(); abrirModalComentarios('valvula', '${escapeHtml(v.id_valvula)}', '${escapeHtml(tpNombre)}')">
                        <i class="fas fa-comment${commentsCount > 0 ? 's' : ''}"></i>
                        <span>${commentsCount > 0 ? commentsCount : ''}</span>
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    return `
        <div class="tree-spool-node" id="node-valvula-${cleanVId}" style="margin-top:6px; border-color:rgba(56, 189, 248, 0.25);">
            <div class="tree-spool-header" onclick="toggleTpValvulasAccordion('${cleanVId}')" style="background:rgba(56, 189, 248, 0.08);">
                <div style="display:flex; align-items:center; gap:8px;">
                    <i class="fas fa-faucet" style="color:#38bdf8;"></i>
                    <strong style="color:#e2e8f0;">Válvulas de la Línea (${valvulas.length})</strong>
                    <span class="status-badge ${montadas === valvulas.length ? 'badge-success' : (montadas > 0 ? 'badge-warning' : 'badge-secondary')}" style="font-size:0.65rem; padding:1px 6px;">
                        ${montadas} / ${valvulas.length} Montadas (${pct}%)
                    </span>
                </div>
                <div style="display:flex; align-items:center; gap:10px; font-size:0.75rem; color:#94a3b8;">
                    <i class="fas fa-chevron-down" id="arrow-valvula-${cleanVId}" style="transition: transform 0.2s; font-size:0.75rem;"></i>
                </div>
            </div>
            <div class="tree-juntas-table-wrapper" id="body-valvula-${cleanVId}" style="display:none;">
                <table class="tree-juntas-table">
                    <thead>
                        <tr>
                            <th>Válvula / TAG</th>
                            <th>Descripción</th>
                            <th>Diám / Clase</th>
                            <th>Estado Montaje</th>
                            <th style="text-align:right;">Comentarios</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        </div>
    `;
}

function renderTpSoportesSection(soportes, parentCleanId, tpNombre) {
    if (!soportes || soportes.length === 0) return '';
    const cleanSId = `${parentCleanId}-soportes`;
    const montados = soportes.filter(s => s.montado).length;
    const pct = ((montados / soportes.length) * 100).toFixed(0);

    const rowsHtml = soportes.map(s => {
        const commentsCount = getComentariosCount('soporte', s.id_soporte);
        return `
            <tr>
                <td>
                    <strong style="color:#f8fafc;"><i class="fas fa-border-all" style="color:#fbbf24; margin-right:5px; font-size:0.8rem;"></i>${escapeHtml(s.id_soporte)}</strong>
                </td>
                <td style="color:#cbd5e1; font-size:0.75rem;">${escapeHtml(s.item || s.tipo || '-')}</td>
                <td><strong>${escapeHtml(s.diametro || '-')}</strong> ${s.peso ? `<span style="opacity:0.6; font-size:0.75rem;">(${escapeHtml(s.peso)} kg)</span>` : ''}</td>
                <td>
                    <span class="status-badge ${s.montado ? 'badge-success' : 'badge-secondary'}" style="font-size:0.65rem; padding:1px 6px;">
                        ${s.montado ? 'MONTADO' : 'PENDIENTE'}
                    </span>
                </td>
                <td style="text-align:right;">
                    <button class="btn-comentario-trigger ${commentsCount > 0 ? 'has-comments' : ''}" 
                            onclick="event.stopPropagation(); abrirModalComentarios('soporte', '${escapeHtml(s.id_soporte)}', '${escapeHtml(tpNombre)}')">
                        <i class="fas fa-comment${commentsCount > 0 ? 's' : ''}"></i>
                        <span>${commentsCount > 0 ? commentsCount : ''}</span>
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    return `
        <div class="tree-spool-node" id="node-soporte-${cleanSId}" style="margin-top:6px; border-color:rgba(251, 191, 36, 0.25);">
            <div class="tree-spool-header" onclick="toggleTpSoportesAccordion('${cleanSId}')" style="background:rgba(251, 191, 36, 0.08);">
                <div style="display:flex; align-items:center; gap:8px;">
                    <i class="fas fa-border-all" style="color:#fbbf24;"></i>
                    <strong style="color:#e2e8f0;">Soportes de la Línea (${soportes.length})</strong>
                    <span class="status-badge ${montados === soportes.length ? 'badge-success' : (montados > 0 ? 'badge-warning' : 'badge-secondary')}" style="font-size:0.65rem; padding:1px 6px;">
                        ${montados} / ${soportes.length} Montados (${pct}%)
                    </span>
                </div>
                <div style="display:flex; align-items:center; gap:10px; font-size:0.75rem; color:#94a3b8;">
                    <i class="fas fa-chevron-down" id="arrow-soporte-${cleanSId}" style="transition: transform 0.2s; font-size:0.75rem;"></i>
                </div>
            </div>
            <div class="tree-juntas-table-wrapper" id="body-soporte-${cleanSId}" style="display:none;">
                <table class="tree-juntas-table">
                    <thead>
                        <tr>
                            <th>Soporte</th>
                            <th>Item / Tipo</th>
                            <th>Diám / Peso</th>
                            <th>Estado Montaje</th>
                            <th style="text-align:right;">Comentarios</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
            </div>
        </div>
    `;
}

/**
 * 2. RENDER VISTA ELEMENTOS HUÉRFANOS (SIN TEST PACK)
 */
function renderHuerfanosView(sinTp, arbolFiltrado, query) {
    const container = document.getElementById('lineas-container');
    if (!container) return;

    const m = sinTp.metricas || {};
    const autoExpand = Boolean(query && query.length > 1);

    let html = `
        <div style="margin-bottom:16px; padding:16px 20px; border-radius:12px; background:rgba(245, 158, 11, 0.1); border:1px solid rgba(245, 158, 11, 0.3); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
            <div>
                <h4 style="margin:0; color:#fbbf24; display:flex; align-items:center; gap:8px;">
                    <i class="fas fa-exclamation-triangle"></i> Auditoría de Elementos Sin Test Pack
                </h4>
                <p style="margin:4px 0 0 0; font-size:0.82rem; color:#cbd5e1;">
                    Estos elementos provienen de <strong>LIST_Juntas_MS_</strong>, spools, válvulas y soportes sin <strong>TEST PACK</strong> asignado.
                </p>
            </div>
            <div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap;">
                <div style="text-align:right;">
                    <div style="font-size:0.75rem; color:#94a3b8;">Juntas Sin TP</div>
                    <strong style="color:#f8fafc; font-size:1.1rem;">${m.total_juntas || 0}</strong> (${m.pulgadas_total || 0}")
                </div>
                <div style="text-align:right;">
                    <div style="font-size:0.75rem; color:#94a3b8;">Líneas Sin TP</div>
                    <strong style="color:#f8fafc; font-size:1.1rem;">${sinTp.lineas_catalogo?.length || m.total_lineas || 0}</strong>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:0.75rem; color:#94a3b8;">Spools Sin TP</div>
                    <strong style="color:#f8fafc; font-size:1.1rem;">${sinTp.spools_catalogo?.length || 0}</strong>
                </div>
                <div style="text-align:right;">
                    <div style="font-size:0.75rem; color:#94a3b8;">Válvulas Sin TP</div>
                    <strong style="color:#38bdf8; font-size:1.1rem;">${m.total_valvulas || 0}</strong> (${m.valvulas_montadas || 0} mont.)
                </div>
                <div style="text-align:right;">
                    <div style="font-size:0.75rem; color:#94a3b8;">Soportes Sin TP</div>
                    <strong style="color:#fbbf24; font-size:1.1rem;">${m.total_soportes || 0}</strong> (${m.soportes_montados || 0} mont.)
                </div>
            </div>
        </div>

        <div class="tp-tree-list">
    `;

    if (!arbolFiltrado || arbolFiltrado.length === 0) {
        html += `
            <div class="empty-msg" style="text-align:center; padding: 40px; opacity:0.6;">
                <i class="fas fa-check-circle" style="font-size:1.6rem; color:#10b981; margin-bottom:8px;"></i>
                <p>No se encontraron elementos huérfanos con el filtro actual.</p>
            </div>
        `;
    } else {
        arbolFiltrado.forEach((l, lIdx) => {
            const cleanLineaId = `huerfano-l-${lIdx}`;
            const lm = l.metricas;
            const commentsCount = getComentariosCount('linea', l.id_linea);

            html += `
                <div class="tp-card tp-orphan" id="tp-card-${cleanLineaId}">
                    <div class="tp-card-header" onclick="toggleTpAccordion('${cleanLineaId}')">
                        <div class="tp-header-left">
                            <div class="tp-icon-bubble">
                                <i class="fas fa-unlink"></i>
                            </div>
                            <div class="tp-title-box">
                                <h4>
                                    <span>${escapeHtml(l.id_linea)}</span>
                                    <span class="status-badge badge-warning" style="font-size:0.68rem;">SIN TEST PACK</span>
                                    ${l.subsistema ? `<span class="subtag-pill subtag-sub" style="font-size:0.68rem;">${escapeHtml(l.subsistema)}</span>` : ''}
                                </h4>
                                <div class="tp-subinfo">
                                    <span><i class="fas fa-industry"></i> <strong>${lm.spools_montados}/${lm.total_spools}</strong> Spools</span>
                                    <span><i class="fas fa-link"></i> <strong>${lm.juntas_ejecutadas}/${lm.juntas_total}</strong> Juntas (${lm.juntas_porcentaje}%)</span>
                                    ${lm.total_valvulas > 0 ? `<span><i class="fas fa-faucet" style="color:#38bdf8;"></i> ${lm.valvulas_montadas}/${lm.total_valvulas} Válv.</span>` : ''}
                                    ${lm.total_soportes > 0 ? `<span><i class="fas fa-border-all" style="color:#fbbf24;"></i> ${lm.soportes_montados}/${lm.total_soportes} Sop.</span>` : ''}
                                </div>
                            </div>
                        </div>

                        <div class="tp-header-right">
                            <button class="btn-comentario-trigger ${commentsCount > 0 ? 'has-comments' : ''}" 
                                    onclick="event.stopPropagation(); abrirModalComentarios('linea', '${escapeHtml(l.id_linea)}', 'SIN_ASIGNAR')">
                                <i class="fas fa-comment${commentsCount > 0 ? 's' : ''}"></i>
                                <span>${commentsCount > 0 ? `${commentsCount} notas` : 'Comentar'}</span>
                            </button>

                            <i class="fas fa-chevron-down" id="arrow-tp-${cleanLineaId}" style="transition: transform 0.2s; font-size:0.9rem; color:#94a3b8; ${autoExpand ? 'transform: rotate(180deg);' : ''}"></i>
                        </div>
                    </div>

                    <div class="tp-body" id="body-tp-${cleanLineaId}" style="display:${autoExpand ? 'block' : 'none'};">
                        <div class="tree-spools-wrapper" style="margin-top:12px; border-radius:10px;">
                            ${renderTpSpools(l.spools, cleanLineaId, 'SIN_ASIGNAR', autoExpand)}
                            ${renderTpValvulasSection(l.valvulas, cleanLineaId, 'SIN_ASIGNAR')}
                            ${renderTpSoportesSection(l.soportes, cleanLineaId, 'SIN_ASIGNAR')}
                        </div>
                    </div>
                </div>
            `;
        });
    }

    html += `</div>`;
    container.innerHTML = html;
}

/**
 * 3. RENDER VISTA CLÁSICA POR LÍNEAS CON ACCORDIONES
 */
function renderLineasCards(lineas) {
    const container = document.getElementById('lineas-container');
    if (!container) return;

    if (!lineas || lineas.length === 0) {
        container.innerHTML = `
            <div class="empty-msg" style="text-align:center; padding: 40px; opacity:0.6;">
                <i class="fas fa-search-minus" style="font-size:1.6rem; margin-bottom:8px;"></i>
                <p>No se encontraron líneas que coincidan con la búsqueda.</p>
            </div>
        `;
        return;
    }

    let html = '<div class="lineas-grid">';

    lineas.forEach((l, index) => {
        const pctJuntas = l.juntas.porcentaje || 0;
        const pctSpools = l.spools.porcentaje || 0;
        const cleanKey = l.clean_key || `linea-${index}`;

        const isComplete = pctJuntas >= 100;
        const statusBadgeClass = isComplete ? 'badge-success' : (pctJuntas > 0 ? 'badge-warning' : 'badge-secondary');
        const statusText = isComplete ? '100% EJECUTADA' : (pctJuntas > 0 ? `${pctJuntas}% EN PROCESO` : 'PENDIENTE');
        const commentsCount = getComentariosCount('linea', l.id_linea);

        const tpBadges = (l.test_packs || []).map(tp => 
            `<span class="subtag-pill subtag-tp" title="Test Pack"><i class="fas fa-vial"></i> ${escapeHtml(tp)}</span>`
        ).join(' ');

        const spoolEstadosBadges = Object.entries(l.spools.estados || {})
            .map(([st, cant]) => `<span class="spool-mini-tag">${st}: <strong>${cant}</strong></span>`)
            .join(' ');

        html += `
            <div class="linea-card glass ${isComplete ? 'linea-complete' : ''}" id="card-${cleanKey}">
                <div class="linea-card-header">
                    <div class="linea-title-group">
                        <div class="linea-title">
                            <i class="fas fa-grip-lines" style="color:var(--primary-light,#818cf8);"></i>
                            <strong>${escapeHtml(l.id_linea)}</strong>
                            <button class="btn-comentario-trigger ${commentsCount > 0 ? 'has-comments' : ''}" 
                                    style="margin-left:8px;"
                                    onclick="event.stopPropagation(); abrirModalComentarios('linea', '${escapeHtml(l.id_linea)}', '${escapeHtml((l.test_packs || [])[0] || '')}')">
                                <i class="fas fa-comment${commentsCount > 0 ? 's' : ''}"></i>
                                <span>${commentsCount > 0 ? `${commentsCount} notas` : 'Comentar'}</span>
                            </button>
                        </div>
                        <div class="linea-subtags">
                            ${tpBadges || '<span class="subtag-pill subtag-cwp" style="background:rgba(245,158,11,0.15); color:#fbbf24; border-color:rgba(245,158,11,0.3);"><i class="fas fa-unlink"></i> Sin Test Pack</span>'}
                            ${l.subsistema ? `<span class="subtag-pill subtag-sub"><i class="fas fa-layer-group"></i> ${escapeHtml(l.subsistema)}</span>` : ''}
                            ${l.cwp ? `<span class="subtag-pill subtag-cwp">CWP: ${escapeHtml(l.cwp)}</span>` : ''}
                            ${l.fluido ? `<span class="subtag-pill subtag-fluido">${escapeHtml(l.fluido)}</span>` : ''}
                            ${l.pid ? `<span class="subtag-pill subtag-pid"><i class="fas fa-file-pdf"></i> P&ID: ${escapeHtml(l.pid)}</span>` : ''}
                        </div>
                    </div>
                    <div class="linea-header-badge">
                        <span class="status-badge ${statusBadgeClass}">${statusText}</span>
                    </div>
                </div>

                <div class="linea-progress-row">
                    <div class="progress-box">
                        <div class="progress-labels">
                            <span><i class="fas fa-link"></i> Juntas: <strong>${l.juntas.ejecutadas} / ${l.juntas.total}</strong> (${(l.juntas.pulg_ejecutadas || 0).toFixed(0)}" / ${(l.juntas.pulg_total || 0).toFixed(0)}")</span>
                            <span class="pct-text">${pctJuntas}%</span>
                        </div>
                        <div class="progress-bar-bg">
                            <div class="progress-bar-fill fill-juntas" style="width: ${pctJuntas}%;"></div>
                        </div>
                    </div>
                    <div class="progress-box">
                        <div class="progress-labels">
                            <span><i class="fas fa-industry"></i> Spools Montados: <strong>${l.spools.montados} / ${l.spools.total}</strong></span>
                            <span class="pct-text">${pctSpools}%</span>
                        </div>
                        <div class="progress-bar-bg">
                            <div class="progress-bar-fill fill-spools" style="width: ${pctSpools}%;"></div>
                        </div>
                    </div>
                </div>

                <div class="linea-metrics-strip">
                    <div class="metric-chip" title="Válvulas asociadas">
                        <i class="fas fa-faucet" style="color:#38bdf8;"></i>
                        <span>Válvulas: <strong>${l.valvulas.montadas} / ${l.valvulas.total}</strong></span>
                    </div>
                    <div class="metric-chip" title="Soportes asociados">
                        <i class="fas fa-border-all" style="color:#fbbf24;"></i>
                        <span>Soportes: <strong>${l.soportes.montados} / ${l.soportes.total}</strong></span>
                    </div>
                    <div class="metric-chip" title="Isométricos">
                        <i class="fas fa-file-image" style="color:#a78bfa;"></i>
                        <span>Isométricos: <strong>${l.isometricos.length}</strong></span>
                    </div>
                    ${spoolEstadosBadges ? `<div class="spool-estados-container">${spoolEstadosBadges}</div>` : ''}
                </div>

                <div class="linea-card-footer">
                    ${l.pid ? `<button class="linea-action-btn btn-pid" onclick="verPidPdf('${escapeHtml(l.pid)}')"><i class="fas fa-file-pdf"></i> Ver P&ID</button>` : ''}
                    <button class="linea-action-btn btn-accordion" onclick="toggleLineaAccordion('${cleanKey}')">
                        <i class="fas fa-chevron-down" id="arrow-${cleanKey}" style="transition: transform 0.2s;"></i> Desglose Isométricos (${l.isometricos.length})
                    </button>
                </div>

                <div class="linea-accordion-body" id="accordion-${cleanKey}" style="display:none;">
                    ${renderIsometricosTable(l.isometricos, l.id_linea)}
                </div>
            </div>
        `;
    });

    html += '</div>';
    container.innerHTML = html;
}

function renderIsometricosTable(isometricos, idLinea) {
    if (!isometricos || isometricos.length === 0) {
        return '<p class="empty-iso-msg">Sin hojas de isométrico registradas.</p>';
    }

    let rowsHtml = isometricos.map(iso => {
        const pctJ = iso.juntas.total > 0 ? ((iso.juntas.ejecutadas / iso.juntas.total) * 100).toFixed(0) : 0;
        const pctS = iso.spools.total > 0 ? ((iso.spools.montados / iso.spools.total) * 100).toFixed(0) : 0;
        const pctV = iso.valvulas.total > 0 ? ((iso.valvulas.montadas / iso.valvulas.total) * 100).toFixed(0) : 0;
        const pctSop = iso.soportes.total > 0 ? ((iso.soportes.montados / iso.soportes.total) * 100).toFixed(0) : 0;
        const isoTpBadges = (iso.test_packs || []).map(tp => `<span class="subtag-pill subtag-tp" style="font-size:0.65rem; padding:1px 5px;"><i class="fas fa-vial"></i> ${escapeHtml(tp)}</span>`).join(' ');

        return `
            <tr>
                <td>
                    <strong><i class="fas fa-file-alt" style="color:#a78bfa; margin-right:6px;"></i>${escapeHtml(iso.hoja || iso.id_iso)}</strong>
                    <div style="font-size:0.75rem; opacity:0.6;">${escapeHtml(iso.id_iso)}</div>
                    ${isoTpBadges ? `<div style="margin-top:2px;">${isoTpBadges}</div>` : ''}
                </td>
                <td style="text-align:center;">
                    ${iso.pdf_url ? `<button class="btn-iso-pdf" onclick="verIsoPdf('${escapeHtml(iso.id_iso)}', '${escapeHtml(iso.pdf_url)}')"><i class="fas fa-file-pdf"></i> PDF</button>` : '<span style="opacity:0.4;">-</span>'}
                </td>
                <td>
                    <div class="table-mini-stat">
                        <span><strong>${iso.juntas.ejecutadas}</strong> / ${iso.juntas.total}</span>
                        <span class="badge-mini-pct">${pctJ}%</span>
                    </div>
                </td>
                <td>
                    <div class="table-mini-stat">
                        <span><strong>${iso.spools.montados}</strong> / ${iso.spools.total}</span>
                        <span class="badge-mini-pct">${pctS}%</span>
                    </div>
                </td>
                <td>
                    <div class="table-mini-stat">
                        <span><strong>${iso.valvulas.montadas}</strong> / ${iso.valvulas.total}</span>
                        ${iso.valvulas.total > 0 ? `<span class="badge-mini-pct">${pctV}%</span>` : ''}
                    </div>
                </td>
                <td>
                    <div class="table-mini-stat">
                        <span><strong>${iso.soportes.montados}</strong> / ${iso.soportes.total}</span>
                        ${iso.soportes.total > 0 ? `<span class="badge-mini-pct">${pctSop}%</span>` : ''}
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    return `
        <div class="iso-table-wrapper">
            <table class="iso-table">
                <thead>
                    <tr>
                        <th>Hoja / Isométrico</th>
                        <th style="text-align:center;">PDF</th>
                        <th>Juntas Ejec.</th>
                        <th>Spools Mont.</th>
                        <th>Válvulas Mont.</th>
                        <th>Soportes Mont.</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        </div>
    `;
}

/**
 * CONTROL DE ACORDEONES
 */
export function toggleTpAccordion(cleanTpId) {
    const body = document.getElementById(`body-tp-${cleanTpId}`);
    const arrow = document.getElementById(`arrow-tp-${cleanTpId}`);
    if (!body) return;

    if (body.style.display === 'none' || !body.style.display) {
        body.style.display = 'block';
        if (arrow) arrow.style.transform = 'rotate(180deg)';
    } else {
        body.style.display = 'none';
        if (arrow) arrow.style.transform = 'rotate(0deg)';
    }
}

export function toggleTpLineaAccordion(cleanLineaId) {
    const body = document.getElementById(`body-linea-${cleanLineaId}`);
    const arrow = document.getElementById(`arrow-linea-${cleanLineaId}`);
    if (!body) return;

    if (body.style.display === 'none' || !body.style.display) {
        body.style.display = 'flex';
        if (arrow) arrow.style.transform = 'rotate(180deg)';
    } else {
        body.style.display = 'none';
        if (arrow) arrow.style.transform = 'rotate(0deg)';
    }
}

export function toggleTpSpoolAccordion(cleanSpId) {
    const body = document.getElementById(`body-spool-${cleanSpId}`);
    const arrow = document.getElementById(`arrow-spool-${cleanSpId}`);
    if (!body) return;

    if (body.style.display === 'none' || !body.style.display) {
        body.style.display = 'block';
        if (arrow) arrow.style.transform = 'rotate(180deg)';
    } else {
        body.style.display = 'none';
        if (arrow) arrow.style.transform = 'rotate(0deg)';
    }
}

export function toggleTpValvulasAccordion(cleanVId) {
    const body = document.getElementById(`body-valvula-${cleanVId}`);
    const arrow = document.getElementById(`arrow-valvula-${cleanVId}`);
    if (!body) return;

    if (body.style.display === 'none' || !body.style.display) {
        body.style.display = 'block';
        if (arrow) arrow.style.transform = 'rotate(180deg)';
    } else {
        body.style.display = 'none';
        if (arrow) arrow.style.transform = 'rotate(0deg)';
    }
}

export function toggleTpSoportesAccordion(cleanSId) {
    const body = document.getElementById(`body-soporte-${cleanSId}`);
    const arrow = document.getElementById(`arrow-soporte-${cleanSId}`);
    if (!body) return;

    if (body.style.display === 'none' || !body.style.display) {
        body.style.display = 'block';
        if (arrow) arrow.style.transform = 'rotate(180deg)';
    } else {
        body.style.display = 'none';
        if (arrow) arrow.style.transform = 'rotate(0deg)';
    }
}

export function toggleLineaAccordion(cleanKey) {
    const acc = document.getElementById(`accordion-${cleanKey}`);
    const arrow = document.getElementById(`arrow-${cleanKey}`);
    if (!acc) return;

    if (acc.style.display === 'none' || !acc.style.display) {
        acc.style.display = 'block';
        if (arrow) arrow.style.transform = 'rotate(180deg)';
    } else {
        acc.style.display = 'none';
        if (arrow) arrow.style.transform = 'rotate(0deg)';
    }
}

export function toggleAllTreeNodes(expand) {
    const bodies = document.querySelectorAll('.tp-body, .tree-spools-wrapper, .tree-juntas-table-wrapper, .linea-accordion-body, [id^="body-valvula-"], [id^="body-soporte-"]');
    const arrows = document.querySelectorAll('[id^="arrow-tp-"], [id^="arrow-linea-"], [id^="arrow-spool-"], [id^="arrow-valvula-"], [id^="arrow-soporte-"], [id^="arrow-"]');

    bodies.forEach(b => {
        if (b.classList.contains('tree-spools-wrapper')) {
            b.style.display = expand ? 'flex' : 'none';
        } else {
            b.style.display = expand ? 'block' : 'none';
        }
    });

    arrows.forEach(a => {
        a.style.transform = expand ? 'rotate(180deg)' : 'rotate(0deg)';
    });
}

export function refrescarDatosLineas() {
    loadLineasData(true);
}

/**
 * 4. SISTEMA DE COMENTARIOS / OBSERVACIONES
 */
export async function abrirModalComentarios(tipo, id, tp = '') {
    currentCommentEntity = { tipo, id, tp };
    const modal = document.getElementById('testpack-comentarios-modal');
    const tituloEl = document.getElementById('modal-comentarios-titulo');
    const listaEl = document.getElementById('modal-comentarios-lista');
    const textarea = document.getElementById('modal-comentario-texto');

    if (!modal || !tituloEl || !listaEl) return;

    const tipoLabels = {
        test_pack: 'Test Pack',
        linea: 'Línea',
        spool: 'Spool',
        junta: 'Unión / Junta',
        valvula: 'Válvula',
        soporte: 'Soporte'
    };

    tituloEl.textContent = `Notas: ${tipoLabels[tipo] || tipo} [${id}]`;
    if (textarea) textarea.value = '';
    modal.style.display = 'flex';

    // Cargar comentarios
    listaEl.innerHTML = `<div class="empty-msg" style="text-align:center; padding:20px; opacity:0.7;"><i class="fas fa-spinner fa-spin"></i> Cargando historial...</div>`;

    try {
        const res = await fetch(`/api/testpacks/comentarios?entidad_tipo=${encodeURIComponent(tipo)}&entidad_id=${encodeURIComponent(id)}`);
        const data = await res.json();
        renderListaComentarios(data);
    } catch (e) {
        listaEl.innerHTML = `<p style="color:#ef4444; font-size:0.85rem;">Error al cargar comentarios: ${escapeHtml(e.message)}</p>`;
    }
}

function renderListaComentarios(comentarios) {
    const listaEl = document.getElementById('modal-comentarios-lista');
    if (!listaEl) return;

    if (!comentarios || comentarios.length === 0) {
        listaEl.innerHTML = `
            <div style="text-align:center; padding:30px 10px; color:#94a3b8; font-size:0.88rem;">
                <i class="fas fa-comment-slash" style="font-size:1.8rem; margin-bottom:8px; opacity:0.6;"></i>
                <p>No hay notas registradas para este elemento todavía.</p>
                <p style="font-size:0.78rem; opacity:0.7;">Sé el primero en agregar una observación o avance técnico abajo.</p>
            </div>
        `;
        return;
    }

    let html = ``;
    comentarios.forEach(c => {
        const fechaStr = formatearFecha(c.created_at);
        const isResuelto = Boolean(c.resuelto);
        const fechaResueltoStr = c.resuelto_at ? formatearFecha(c.resuelto_at) : '';

        html += `
            <div class="comentario-bubble ${isResuelto ? 'comentario-resuelto' : 'comentario-pendiente'}" id="comentario-item-${c.id}">
                <div class="comentario-bubble-header">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span class="comentario-autor"><i class="fas fa-user-circle"></i> ${escapeHtml(c.usuario || 'Supervisor')}</span>
                        ${isResuelto ? `
                            <span class="badge-comentario-resuelto" title="Resuelto el ${fechaResueltoStr} por ${escapeHtml(c.resuelto_por || 'Supervisor')}">
                                <i class="fas fa-check-circle"></i> Resuelto
                            </span>
                        ` : `
                            <span class="badge-comentario-pendiente">
                                <i class="fas fa-clock"></i> Pendiente
                            </span>
                        `}
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="font-size:0.75rem; color:#94a3b8;">${fechaStr}</span>
                        <button class="comentario-delete-btn" onclick="eliminarComentarioUI('${c.id}')" title="Eliminar nota permanentemente">
                            <i class="fas fa-trash-alt"></i>
                        </button>
                    </div>
                </div>

                <div class="comentario-texto ${isResuelto ? 'texto-resuelto' : ''}">${escapeHtml(c.comentario)}</div>

                <div class="comentario-bubble-footer">
                    <div class="comentario-resolve-info">
                        ${isResuelto ? `
                            <small style="color:#10b981; font-size:0.72rem; display:inline-flex; align-items:center; gap:4px;">
                                <i class="fas fa-check-double"></i> Atendido el ${fechaResueltoStr} por <strong>${escapeHtml(c.resuelto_por || 'Supervisor')}</strong>
                            </small>
                        ` : `
                            <small style="color:#94a3b8; font-size:0.72rem;">Observación abierta sin resolver</small>
                        `}
                    </div>
                    <div>
                        ${isResuelto ? `
                            <button class="btn-resolver-comentario btn-reabrir" onclick="toggleResolverComentario('${c.id}', false)" title="Reabrir esta observación">
                                <i class="fas fa-undo"></i> Reabrir
                            </button>
                        ` : `
                            <button class="btn-resolver-comentario btn-resolver" onclick="toggleResolverComentario('${c.id}', true)" title="Marcar como resuelto y guardar fecha">
                                <i class="fas fa-check"></i> Resolver
                            </button>
                        `}
                    </div>
                </div>
            </div>
        `;
    });

    listaEl.innerHTML = html;
}

export async function toggleResolverComentario(id, nuevoEstado) {
    const autorSelect = document.getElementById('modal-comentario-autor');
    const usuario = autorSelect?.value || 'Supervisor Piping';

    try {
        const res = await fetch(`/api/testpacks/comentarios/${id}/resolver`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                resuelto: nuevoEstado,
                resuelto_por: usuario
            })
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Error ${res.status}`);
        }

        const data = await res.json();

        // Actualizar en caché en memoria
        if (currentCommentEntity) {
            const key = `${currentCommentEntity.tipo}:${currentCommentEntity.id}`.toLowerCase();
            const list = comentariosCacheMap.get(key) || [];
            const idx = list.findIndex(c => c.id === id);
            if (idx !== -1) {
                list[idx] = { ...list[idx], ...data };
            }
        }

        // Recargar listado en el modal
        const resList = await fetch(`/api/testpacks/comentarios?entidad_tipo=${encodeURIComponent(currentCommentEntity.tipo)}&entidad_id=${encodeURIComponent(currentCommentEntity.id)}`);
        if (resList.ok) {
            const d = await resList.json();
            renderListaComentarios(d);
        }

        filterLineas();
    } catch (e) {
        alert(`Error al actualizar estado del comentario: ${e.message}`);
    }
}

export function cerrarModalComentarios() {
    const modal = document.getElementById('testpack-comentarios-modal');
    if (modal) modal.style.display = 'none';
    currentCommentEntity = null;
}

export async function enviarNuevoComentario() {
    if (!currentCommentEntity) return;

    const textarea = document.getElementById('modal-comentario-texto');
    const autorSelect = document.getElementById('modal-comentario-autor');
    const texto = (textarea?.value || '').trim();
    const usuario = autorSelect?.value || 'Supervisor Piping';

    if (!texto) {
        alert('Por favor escribe un comentario antes de enviar.');
        return;
    }

    try {
        const res = await fetch('/api/testpacks/comentarios', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                entidad_tipo: currentCommentEntity.tipo,
                entidad_id: currentCommentEntity.id,
                test_pack: currentCommentEntity.tp,
                comentario: texto,
                usuario: usuario
            })
        });

        if (!res.ok) throw new Error(`Error ${res.status}`);
        const nuevo = await res.json();

        // Actualizar caché de comentarios en memoria
        const key = `${currentCommentEntity.tipo}:${currentCommentEntity.id}`.toLowerCase();
        if (!comentariosCacheMap.has(key)) comentariosCacheMap.set(key, []);
        comentariosCacheMap.get(key).unshift(nuevo);

        if (textarea) textarea.value = '';

        // Recargar lista en el modal
        const resList = await fetch(`/api/testpacks/comentarios?entidad_tipo=${encodeURIComponent(currentCommentEntity.tipo)}&entidad_id=${encodeURIComponent(currentCommentEntity.id)}`);
        const data = await resList.json();
        renderListaComentarios(data);

        // Actualizar vistas para reflejar el badge
        filterLineas();
    } catch (e) {
        alert(`Error al guardar comentario: ${e.message}`);
    }
}

export async function eliminarComentarioUI(id) {
    if (!confirm('¿Deseas eliminar esta nota?')) return;

    try {
        const res = await fetch(`/api/testpacks/comentarios/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`Error ${res.status}`);

        // Eliminar del mapa en memoria
        if (currentCommentEntity) {
            const key = `${currentCommentEntity.tipo}:${currentCommentEntity.id}`.toLowerCase();
            const list = comentariosCacheMap.get(key) || [];
            comentariosCacheMap.set(key, list.filter(c => c.id !== id));
        }

        // Eliminar del DOM del modal
        const el = document.getElementById(`comentario-item-${id}`);
        if (el) el.remove();

        filterLineas();
    } catch (e) {
        alert(`Error al eliminar comentario: ${e.message}`);
    }
}

export function handleComentarioKeydown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        enviarNuevoComentario();
    }
}

/**
 * 5. SISTEMA DE CUSTODIA DE CARPETA FÍSICA
 */
export async function abrirModalCustodia(tpNombre) {
    currentCustodiaTp = tpNombre;
    const modal = document.getElementById('testpack-custodia-modal');
    const tituloEl = document.getElementById('modal-custodia-titulo');
    const actualBox = document.getElementById('modal-custodia-actual-box');
    const historialLista = document.getElementById('modal-custodia-historial-lista');
    const inputResp = document.getElementById('modal-custodia-responsable');
    const inputUbic = document.getElementById('modal-custodia-ubicacion');

    if (!modal) return;

    if (tituloEl) tituloEl.textContent = `Custodia Carpeta Física — ${tpNombre}`;
    if (inputResp) inputResp.value = '';
    if (inputUbic) inputUbic.value = '';

    modal.style.display = 'flex';

    // Obtener datos del TP desde la caché en memoria si existe
    const tpObj = testPacksCacheData?.test_packs?.find(t => t.nombre.toLowerCase() === tpNombre.toLowerCase());
    renderCustodiaActualBox(tpObj?.custodia);

    // Cargar historial desde el servidor
    if (historialLista) {
        historialLista.innerHTML = `<div class="empty-msg" style="padding:15px; font-size:0.8rem; text-align:center;"><i class="fas fa-spinner fa-spin"></i> Cargando historial de traspasos...</div>`;
    }

    try {
        const res = await fetch(`/api/testpacks/custodia?test_pack=${encodeURIComponent(tpNombre)}`);
        if (res.ok) {
            const data = await res.json();
            renderCustodiaHistorial(data);
            if (data && data.length > 0) {
                renderCustodiaActualBox(data[0]);
                if (tpObj) tpObj.custodia = data[0];
            }
        }
    } catch (e) {
        if (historialLista) {
            historialLista.innerHTML = `<p style="color:#ef4444; font-size:0.8rem; margin:0;">Error cargando historial: ${escapeHtml(e.message)}</p>`;
        }
    }
}

function renderCustodiaActualBox(custodia) {
    const box = document.getElementById('modal-custodia-actual-box');
    if (!box) return;

    if (!custodia || !custodia.responsable) {
        box.innerHTML = `
            <div class="custodia-current-left">
                <div class="custodia-current-icon" style="background:rgba(148, 163, 184, 0.15); color:#94a3b8;">
                    <i class="far fa-folder-open"></i>
                </div>
                <div>
                    <div style="font-size:0.75rem; color:#94a3b8; text-transform:uppercase; font-weight:600;">Estado de Carpeta Física</div>
                    <div style="font-size:1rem; font-weight:600; color:#e2e8f0;">Sin custodio asignado actualmente</div>
                    <div style="font-size:0.75rem; color:#64748b;">Indica abajo quién tiene la carpeta y a qué departamento pertenece.</div>
                </div>
            </div>
            <span class="status-badge badge-secondary" style="font-size:0.75rem;">SIN ASIGNAR</span>
        `;
        return;
    }

    const depto = custodia.departamento || 'Terreno';
    let icon = 'fas fa-hard-hat';
    let color = '#fbbf24';
    let bg = 'rgba(245, 158, 11, 0.2)';
    let badgeClass = 'badge-warning';

    if (depto === 'QAQC') {
        icon = 'fas fa-clipboard-check';
        color = '#c084fc';
        bg = 'rgba(168, 85, 247, 0.2)';
        badgeClass = 'badge-primary';
    } else if (depto === 'Oficina Técnica') {
        icon = 'fas fa-drafting-compass';
        color = '#38bdf8';
        bg = 'rgba(6, 182, 212, 0.2)';
        badgeClass = 'badge-info';
    }

    const fechaStr = formatearFecha(custodia.fecha_entrega || custodia.created_at);

    box.innerHTML = `
        <div class="custodia-current-left">
            <div class="custodia-current-icon" style="background:${bg}; color:${color};">
                <i class="${icon}"></i>
            </div>
            <div>
                <div style="font-size:0.75rem; color:#94a3b8; text-transform:uppercase; font-weight:600;">Poseedor Físico Actual</div>
                <div style="font-size:1.05rem; font-weight:700; color:#f8fafc;">
                    ${escapeHtml(custodia.responsable)} 
                    <span style="font-size:0.8rem; font-weight:600; color:${color}; margin-left:6px;">(${escapeHtml(depto)})</span>
                </div>
                <div style="font-size:0.75rem; color:#94a3b8; display:flex; gap:12px; margin-top:2px; flex-wrap:wrap;">
                    ${custodia.ubicacion_detalle ? `<span><i class="fas fa-map-marker-alt"></i> ${escapeHtml(custodia.ubicacion_detalle)}</span>` : ''}
                    <span><i class="far fa-clock"></i> Desde: ${fechaStr}</span>
                    ${custodia.usuario_registro ? `<span><i class="far fa-user"></i> Por: ${escapeHtml(custodia.usuario_registro)}</span>` : ''}
                </div>
            </div>
        </div>
        <span class="status-badge ${badgeClass}" style="font-size:0.75rem;">EN ${depto.toUpperCase()}</span>
    `;
}

function renderCustodiaHistorial(historial) {
    const lista = document.getElementById('modal-custodia-historial-lista');
    if (!lista) return;

    if (!historial || historial.length === 0) {
        lista.innerHTML = `<p style="color:#64748b; font-size:0.78rem; margin:0; text-align:center;">Sin registros de movimientos previos para esta carpeta.</p>`;
        return;
    }

    let html = ``;
    historial.forEach((item, idx) => {
        const isCurrent = idx === 0;
        const depto = item.departamento || 'Terreno';
        let icon = 'fas fa-hard-hat';
        let color = '#fbbf24';
        if (depto === 'QAQC') { icon = 'fas fa-clipboard-check'; color = '#c084fc'; }
        else if (depto === 'Oficina Técnica') { icon = 'fas fa-drafting-compass'; color = '#38bdf8'; }

        const fechaStr = formatearFecha(item.fecha_entrega || item.created_at);

        html += `
            <div class="custodia-history-item" style="${isCurrent ? 'border-left: 3px solid ' + color + '; background: rgba(30, 41, 59, 0.7);' : ''}">
                <div class="custodia-history-left">
                    <i class="${icon}" style="color:${color}; font-size:0.9rem;"></i>
                    <div>
                        <strong style="color:#f8fafc;">${escapeHtml(item.responsable)}</strong>
                        <span style="color:${color}; font-size:0.75rem; font-weight:600; margin-left:4px;">${escapeHtml(depto)}</span>
                        ${isCurrent ? '<span style="font-size:0.65rem; padding:1px 5px; background:rgba(255,255,255,0.1); border-radius:4px; margin-left:4px;">Actual</span>' : ''}
                        ${item.ubicacion_detalle ? `<div style="color:#94a3b8; font-size:0.72rem; margin-top:1px;"><i class="fas fa-map-marker-alt"></i> ${escapeHtml(item.ubicacion_detalle)}</div>` : ''}
                    </div>
                </div>
                <div class="custodia-history-right">
                    <div>${fechaStr}</div>
                    <div style="opacity:0.8;">Registró: ${escapeHtml(item.usuario_registro || 'Supervisor')}</div>
                </div>
            </div>
        `;
    });

    lista.innerHTML = html;
}

export async function guardarCustodiaCarpeta() {
    if (!currentCustodiaTp) return;

    const deptoRadio = document.querySelector('input[name="custodia-depto"]:checked');
    const depto = deptoRadio ? deptoRadio.value : 'Terreno';
    const inputResp = document.getElementById('modal-custodia-responsable');
    const inputUbic = document.getElementById('modal-custodia-ubicacion');
    const selectRegistrador = document.getElementById('modal-custodia-registrador');

    const responsable = (inputResp?.value || '').trim();
    const ubicacion = (inputUbic?.value || '').trim();
    const registrador = selectRegistrador?.value || 'Oficina Técnica';

    if (!responsable) {
        alert('Por favor ingresa el nombre de la persona que tiene actualmente la carpeta física.');
        inputResp?.focus();
        return;
    }

    try {
        const res = await fetch('/api/testpacks/custodia', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                test_pack: currentCustodiaTp,
                responsable: responsable,
                departamento: depto,
                ubicacion_detalle: ubicacion,
                usuario_registro: registrador
            })
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Error ${res.status}`);
        }

        const nuevo = await res.json();

        // Actualizar en la caché en memoria de testPacksCacheData
        if (testPacksCacheData?.test_packs) {
            const tp = testPacksCacheData.test_packs.find(t => t.nombre.toLowerCase() === currentCustodiaTp.toLowerCase());
            if (tp) {
                tp.custodia = nuevo;
            }
        }

        // Limpiar inputs
        if (inputResp) inputResp.value = '';
        if (inputUbic) inputUbic.value = '';

        // Actualizar caja actual en el modal
        renderCustodiaActualBox(nuevo);

        // Recargar historial en el modal
        const resH = await fetch(`/api/testpacks/custodia?test_pack=${encodeURIComponent(currentCustodiaTp)}`);
        if (resH.ok) {
            const histData = await resH.json();
            renderCustodiaHistorial(histData);
        }

        // Refrescar el árbol de Test Packs en pantalla para ver el nuevo badge
        filterLineas();
    } catch (e) {
        alert(`Error al registrar custodia: ${e.message}`);
    }
}

export function cerrarModalCustodia() {
    const modal = document.getElementById('testpack-custodia-modal');
    if (modal) modal.style.display = 'none';
    currentCustodiaTp = null;
}

function formatearFecha(iso) {
    if (!iso) return '';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString('es-CL', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return String(iso);
    }
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Registro en el objeto global window para invocación desde eventos DOM
window.loadLineasData           = loadLineasData;
window.setLineasSubTab          = setLineasSubTab;
window.filterLineas             = filterLineas;
window.toggleAllTreeNodes       = toggleAllTreeNodes;
window.refrescarDatosLineas     = refrescarDatosLineas;
window.toggleTpAccordion        = toggleTpAccordion;
window.toggleTpLineaAccordion   = toggleTpLineaAccordion;
window.toggleTpSpoolAccordion   = toggleTpSpoolAccordion;
window.toggleTpValvulasAccordion = toggleTpValvulasAccordion;
window.toggleTpSoportesAccordion = toggleTpSoportesAccordion;
window.toggleLineaAccordion     = toggleLineaAccordion;
window.abrirModalComentarios    = abrirModalComentarios;
window.cerrarModalComentarios   = cerrarModalComentarios;
window.enviarNuevoComentario    = enviarNuevoComentario;
window.eliminarComentarioUI     = eliminarComentarioUI;
window.handleComentarioKeydown  = handleComentarioKeydown;
window.abrirModalCustodia       = abrirModalCustodia;
window.cerrarModalCustodia      = cerrarModalCustodia;
window.guardarCustodiaCarpeta   = guardarCustodiaCarpeta;
window.toggleResolverComentario = toggleResolverComentario;

window.verIsoPdf = function(idIso, directUrl) {
    if (window.showSection) window.showSection('bim');
    if (directUrl && directUrl.length > 5 && window.bimOpenPdf) {
        window.bimOpenPdf(directUrl);
        return;
    }
    fetch(`/api/iso/pdf/${encodeURIComponent(idIso)}`)
        .then(r => r.json())
        .then(data => {
            const url = data.current_sheet?.pdf_url || (data.sheets && data.sheets[0]?.pdf_url) || data.pdf_url || null;
            if (url && window.bimOpenPdf) {
                window.bimOpenPdf(url);
            } else if (window.bimOpenPdf) {
                alert(`No se encontró un PDF adjunto para el isométrico ${idIso}`);
            }
        })
        .catch(e => console.error('[verIsoPdf Error]', e.message));
};

window.verPidPdf = function(pidId) {
    fetch(`/api/pid/pdf/${encodeURIComponent(pidId)}`)
        .then(r => r.json())
        .then(data => {
            const p = (data.pids && data.pids[0]) || null;
            if (p && p.pdf_url && window.bimOpenPdf) {
                window.bimOpenPdf(p.pdf_url);
            }
        })
        .catch(e => console.error('[verPidPdf Error]', e.message));
};
