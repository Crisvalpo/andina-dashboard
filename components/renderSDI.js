/**
 * Render SDI (Solicitudes de Información) — Andina Piping Dashboard
 *
 * Consultas técnicas y su respuesta, con los isométricos vinculados a cada
 * una. La relación SDI↔ISO viene de REL_SDIIso_MS, donde ISOS_VINCULADOS es
 * una lista que AppSheet separa por comas (se acepta también punto y coma).
 */
import { state } from '../modules/state.js';
import { setText } from '../utils/domUtils.js';
import { getVal, formatDate } from '../utils/dataHelpers.js';

export function renderSDI() {
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

export function filterSDI() {
    const q = document.getElementById('sdi-search').value.toLowerCase();
    const rows = document.querySelectorAll('#sdi-tbody tr');
    rows.forEach(row => {
        const text = row.innerText.toLowerCase();
        row.style.display = text.includes(q) ? '' : 'none';
    });
}

if (typeof window !== 'undefined') {
    window.renderSDI = renderSDI;
    window.filterSDI = filterSDI;
}
