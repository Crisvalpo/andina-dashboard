/**
 * Logística y Despacho — Andina Piping Dashboard
 *
 * Guías de despacho y los spools que viajan en cada una. A diferencia del
 * resto del dashboard, estos datos no salen de `state`: se piden al backend
 * bajo demanda al seleccionar una guía.
 */
import { setText } from '../utils/domUtils.js';
import { fetchData } from '../services/apiService.js';

export async function loadLogistica() {
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

export async function loadLogisticaDetail(guiaId) {
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

export function copyLogisticaTable() {
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

if (typeof window !== 'undefined') {
    window.loadLogistica       = loadLogistica;
    window.loadLogisticaDetail = loadLogisticaDetail;
    window.copyLogisticaTable  = copyLogisticaTable;
}
