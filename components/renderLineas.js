/**
 * Componente renderLineas.js — Sección de Control de Líneas & Test Packs
 * Muestra el consolidado a nivel de Línea de Cañería e Isométricos agrupados:
 * Juntas (totales vs ejecutadas), Spools (totales vs montados), Válvulas, Soportes y Test Packs.
 * Carga optimizada: Renderiza tarjetas a demanda mediante búsqueda del usuario.
 */

let lineasCacheData = null;

export async function loadLineasData() {
    const container = document.getElementById('lineas-container');
    if (!container) return;

    if (!lineasCacheData) {
        container.innerHTML = `
            <div class="empty-msg" style="text-align:center; padding: 40px; opacity:0.7;">
                <i class="fas fa-spinner fa-spin" style="font-size:1.8rem; margin-bottom:8px; color:var(--primary-light,#818cf8);"></i>
                <p style="font-size:0.95rem;">Cargando información consolidada de líneas...</p>
            </div>
        `;
    }

    try {
        const res = await fetch('/api/lineas/resumen');
        if (!res.ok) throw new Error(`HTTP error ${res.status}`);
        const data = await res.json();
        lineasCacheData = data.lineas || [];

        renderLineasKPIs(lineasCacheData);
        filterLineas();
    } catch (e) {
        console.error('[renderLineas] Error:', e.message);
        if (container) {
            container.innerHTML = `
                <div class="empty-msg" style="text-align:center; padding: 40px; color:#ef4444;">
                    <i class="fas fa-exclamation-triangle" style="font-size:1.8rem; margin-bottom:8px;"></i>
                    <p>Error cargando información de líneas: ${e.message}</p>
                </div>
            `;
        }
    }
}

function renderLineasKPIs(lineas) {
    const totalLineas = lineas.length;
    let juntasTotal = 0, juntasEjec = 0;
    let spoolsTotal = 0, spoolsMontados = 0;
    let valvulasTotal = 0, valvulasMontadas = 0;
    let soportesTotal = 0, soportesMontados = 0;
    const allTestPacks = new Set();

    lineas.forEach(l => {
        juntasTotal += l.juntas.total || 0;
        juntasEjec += l.juntas.ejecutadas || 0;

        spoolsTotal += l.spools.total || 0;
        spoolsMontados += l.spools.montados || 0;

        valvulasTotal += l.valvulas.total || 0;
        valvulasMontadas += l.valvulas.montadas || 0;

        soportesTotal += l.soportes.total || 0;
        soportesMontados += l.soportes.montados || 0;

        (l.test_packs || []).forEach(tp => allTestPacks.add(tp));
    });

    const elTotal = document.getElementById('kpi-lineas-total');
    const elJuntas = document.getElementById('kpi-lineas-juntas');
    const elSpools = document.getElementById('kpi-lineas-spools');
    const elValvulas = document.getElementById('kpi-lineas-valvulas');
    const elSoportes = document.getElementById('kpi-lineas-soportes');
    const elBadge = document.getElementById('badge-total-lineas');

    if (elTotal) elTotal.textContent = totalLineas;
    if (elJuntas) {
        const pct = juntasTotal > 0 ? ((juntasEjec / juntasTotal) * 100).toFixed(1) : '0';
        elJuntas.textContent = `${juntasEjec} / ${juntasTotal} (${pct}%)`;
    }
    if (elSpools) {
        const pct = spoolsTotal > 0 ? ((spoolsMontados / spoolsTotal) * 100).toFixed(1) : '0';
        elSpools.textContent = `${spoolsMontados} / ${spoolsTotal} (${pct}%)`;
    }
    if (elValvulas) {
        const pct = valvulasTotal > 0 ? ((valvulasMontadas / valvulasTotal) * 100).toFixed(1) : '0';
        elValvulas.textContent = `${valvulasMontadas} / ${valvulasTotal} (${pct}%)`;
    }
    if (elSoportes) {
        const pct = soportesTotal > 0 ? ((soportesMontados / soportesTotal) * 100).toFixed(1) : '0';
        elSoportes.textContent = `${soportesMontados} / ${soportesTotal} (${pct}%)`;
    }
    if (elBadge) {
        const tpCount = allTestPacks.size;
        elBadge.textContent = `${totalLineas} líneas ${tpCount > 0 ? `| 🧪 ${tpCount} Test Packs` : ''}`;
    }
}

export function filterLineas() {
    if (!lineasCacheData) return;

    const container = document.getElementById('lineas-container');
    const query = (document.getElementById('lineas-search')?.value || '').toLowerCase().trim();
    const filterAvance = document.getElementById('lineas-filter-avance')?.value || 'TODOS';

    // Si la búsqueda está vacía y el filtro es TODOS, no renderizamos todo de golpe para mantener el dashboard ultra rápido.
    if (!query && filterAvance === 'TODOS') {
        if (container) {
            container.innerHTML = `
                <div class="empty-msg" style="text-align:center; padding: 50px 20px; opacity:0.85;">
                    <i class="fas fa-search" style="font-size:2.2rem; margin-bottom:12px; color:var(--primary-light,#818cf8);"></i>
                    <p style="font-size:1.1rem; font-weight:600; margin-bottom:4px; color:#f8fafc;">Busca una línea o Test Pack</p>
                    <p style="font-size:0.88rem; opacity:0.75; max-width:480px; margin:0 auto;">
                        Ingresa el número o indicio de la línea (ej. <strong>0094</strong>, <strong>PW</strong>, <strong>C1</strong>, <strong>TP-01</strong>) en la barra superior para desplegar su información detallada.
                    </p>
                </div>
            `;
        }
        return;
    }

    const filtered = lineasCacheData.filter(l => {
        const matchText = !query || 
            l.id_linea.toLowerCase().includes(query) ||
            l.subsistema.toLowerCase().includes(query) ||
            l.cwp.toLowerCase().includes(query) ||
            l.pid.toLowerCase().includes(query) ||
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

    renderLineasCards(filtered);
}

function renderLineasCards(lineas) {
    const container = document.getElementById('lineas-container');
    if (!container) return;

    if (!lineas || lineas.length === 0) {
        container.innerHTML = `
            <div class="empty-msg" style="text-align:center; padding: 40px; opacity:0.6;">
                <i class="fas fa-search-minus" style="font-size:1.6rem; margin-bottom:8px;"></i>
                <p>No se encontraron líneas o Test Packs que coincidan con la búsqueda.</p>
            </div>
        `;
        return;
    }

    let html = `<div style="margin-bottom:10px; font-size:0.85rem; color:#94a3b8;"><i class="fas fa-filter"></i> Mostrando <strong>${lineas.length}</strong> resultado(s)</div>`;
    html += '<div class="lineas-grid">';

    lineas.forEach((l, index) => {
        const pctJuntas = l.juntas.porcentaje || 0;
        const pctSpools = l.spools.porcentaje || 0;
        const cleanKey = l.clean_key || `linea-${index}`;

        const isComplete = pctJuntas >= 100;
        const statusBadgeClass = isComplete ? 'badge-success' : (pctJuntas > 0 ? 'badge-warning' : 'badge-secondary');
        const statusText = isComplete ? '100% EJECUTADA' : (pctJuntas > 0 ? `${pctJuntas}% EN PROCESO` : 'PENDIENTE');

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
                        </div>
                        <div class="linea-subtags">
                            ${tpBadges}
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
                            <span><i class="fas fa-link"></i> Juntas: <strong>${l.juntas.ejecutadas} / ${l.juntas.total}</strong> (${l.juntas.pulg_ejecutadas.toFixed(0)}" / ${l.juntas.pulg_total.toFixed(0)}")</span>
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
        const isoTpBadges = (iso.test_packs || []).map(tp => `<span class="subtag-pill subtag-tp" style="font-size:0.65rem; padding:1px 5px;"><i class="fas fa-vial"></i> ${escapeHtml(tp)}</span>`).join(' ');

        return `
            <tr>
                <td>
                    <strong><i class="fas fa-file-alt" style="color:#a78bfa; margin-right:6px;"></i>${escapeHtml(iso.hoja || iso.id_iso)}</strong>
                    <div style="font-size:0.75rem; opacity:0.6;">${escapeHtml(iso.id_iso)}</div>
                    ${isoTpBadges ? `<div style="margin-top:2px;">${isoTpBadges}</div>` : ''}
                </td>
                <td style="text-align:center;">
                    ${iso.pdf_url ? `<button class="btn-iso-pdf" onclick="window.bimOpenPdf('${escapeHtml(iso.pdf_url)}')"><i class="fas fa-file-pdf"></i> PDF</button>` : '<span style="opacity:0.4;">-</span>'}
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
                <td style="text-align:center;">
                    ${iso.valvulas.total > 0 ? `<strong>${iso.valvulas.montadas}</strong> / ${iso.valvulas.total}` : '<span style="opacity:0.4;">0</span>'}
                </td>
                <td style="text-align:center;">
                    ${iso.soportes.total > 0 ? `<strong>${iso.soportes.montados}</strong> / ${iso.soportes.total}` : '<span style="opacity:0.4;">0</span>'}
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
                        <th style="text-align:center;">Válvulas</th>
                        <th style="text-align:center;">Soportes</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
        </div>
    `;
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

window.toggleLineaAccordion = toggleLineaAccordion;
window.filterLineas = filterLineas;
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

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
