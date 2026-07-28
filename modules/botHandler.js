/**
 * WhatsApp Bot Administration Handler Module — Andina Piping Dashboard
 */
import { state } from './state.js';
import { authAsegurar, authHeaders } from './auth.js';

let botQrPollTimer = null;

export async function botInitPanel() {
    const lock = document.getElementById('bot-lock');
    const content = document.getElementById('bot-content');

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
    if (typeof window.botCargarTools === 'function') window.botCargarTools();

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

export async function botRefreshStatus(silencioso = false) {
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

        const numEl = document.getElementById('bot-number');
        if (numEl) numEl.textContent = d.botNumber ? `+${d.botNumber}` : '— (sin vincular)';
        const nameEl = document.getElementById('bot-name');
        if (nameEl) nameEl.textContent = d.botName || '—';
        const lastEl = document.getElementById('bot-last-connected');
        if (lastEl) lastEl.textContent = d.lastConnectedAt ? new Date(d.lastConnectedAt).toLocaleString('es-CL') : '—';
    } catch (e) {
        badge.className = 'bot-status-badge bot-err';
        badge.innerHTML = '<i class="fas fa-times-circle"></i> Error consultando estado';
    }
}

export async function botRefreshQr(silencioso = false) {
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

export async function botRestart(logout) {
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

export async function botCargarUsuarios() {
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

export function botEditarUsuario(tel) {
    const nombreCelda = document.querySelector(`.ucell-nombre-${tel}`);
    const nombreVal = nombreCelda ? (nombreCelda.textContent || '').trim().replace(/^—$/, '') : '';
    const inp = document.getElementById('uedit-nombre-' + tel);
    if (inp) inp.value = nombreVal;
    const editRow = document.getElementById('urow-edit-' + tel);
    if (editRow) editRow.style.display = '';
    if (inp) { inp.focus(); inp.select(); }
}

export function botCancelarEdicion(tel) {
    const editRow = document.getElementById('urow-edit-' + tel);
    if (editRow) editRow.style.display = 'none';
}

export async function botGuardarEdicion(tel) {
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
        botCargarUsuarios();
    } catch (e) {
        alert('Error guardando: ' + e.message);
    }
}

export async function botToggleUsuario(telefono, activo) {
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

export async function botAgregarUsuario() {
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

export async function botCargarConfig() {
    const runtimeEl = document.getElementById('bot-config-list');
    const envEl = document.getElementById('bot-env-list');
    if (!runtimeEl || !envEl) return;

    try {
        const r = await fetch('/api/config', { headers: authHeaders('bot') });
        const d = await r.json();

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

export async function botGuardarConfig(clave) {
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

if (typeof window !== 'undefined') {
    window.botInitPanel = botInitPanel;
    window.botRefreshStatus = botRefreshStatus;
    window.botRefreshQr = botRefreshQr;
    window.botRestart = botRestart;
    window.botCargarUsuarios = botCargarUsuarios;
    window.botEditarUsuario = botEditarUsuario;
    window.botCancelarEdicion = botCancelarEdicion;
    window.botGuardarEdicion = botGuardarEdicion;
    window.botToggleUsuario = botToggleUsuario;
    window.botAgregarUsuario = botAgregarUsuario;
    window.botCargarConfig = botCargarConfig;
    window.botGuardarConfig = botGuardarConfig;
}
