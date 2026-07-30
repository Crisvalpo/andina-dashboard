/**
 * Bot WhatsApp — Panel de Configuración
 *
 * Estado del puente wa-bridge, QR de vinculación, usuarios autorizados,
 * configuración y catálogo de herramientas dinámicas del bot.
 *
 * Todo el panel exige clave de administración ('bot') antes de mostrarse.
 */
import { state } from './state.js';
import { authAsegurar, authHeaders } from './auth.js';

// Poll suave del QR/estado mientras la sección Bot esté visible.
let botQrPollTimer = null;

export async function botInitPanel() {
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

export async function botRefreshQr(silencioso = false) {
    const img = document.getElementById('bot-qr-img');
    const hint = document.getElementById('bot-qr-hint');
    if (!img || !hint) return;

    try {
        const r = await fetch('/api/bot/qr', { headers: authHeaders('bot') });
        const d = await r.json();

        const qrUrl = d.qrDataUrl || (d.qr ? `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(d.qr)}&margin=10` : null);

        if (qrUrl) {
            img.src = qrUrl;
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
            body.innerHTML = '<tr><td colspan="6" style="text-align:center;opacity:0.6;padding:20px;">Sin usuarios aún. Agrega el primero arriba.</td></tr>';
            return;
        }

        body.innerHTML = d.usuarios.map(u => {
            const tel = u.telefono;
            const pinVal = u.pin || '1234';
            const rolesOpts = ['Terreno','Supervisor','Admin','OT','QAQC'].map(r =>
                `<option value="${r}" ${(u.rol||'Terreno')===r?'selected':''}>${r}</option>`
            ).join('');
            return `
            <tr id="urow-${tel}">
                <td>+${tel}</td>
                <td class="ucell-nombre-${tel}">${u.nombre || '—'}</td>
                <td class="ucell-rol-${tel}">${u.rol || 'Terreno'}</td>
                <td class="ucell-pin-${tel}"><code style="background:rgba(0,242,254,0.1);color:#00f2fe;padding:2px 8px;border-radius:6px;font-weight:700;">🔑 ${pinVal}</code></td>
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
                        onclick="botEditarUsuario('${tel}')" title="Editar nombre / rol / PIN">
                        ✏️ Editar
                    </button>
                </td>
            </tr>
            <tr id="urow-edit-${tel}" style="display:none;background:rgba(99,102,241,0.07)">
                <td colspan="6" style="padding:10px 14px">
                    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                        <input id="uedit-nombre-${tel}" type="text" placeholder="Nombre y apellido"
                            value="${(u.nombre||'').replace(/"/g,'&quot;')}"
                            style="flex:1;min-width:150px;background:rgba(15,23,42,0.8);border:1px solid rgba(99,102,241,0.4);border-radius:8px;padding:7px 10px;color:#f1f5f9;font-family:inherit;font-size:0.85rem">
                        <select id="uedit-rol-${tel}"
                            style="background:rgba(15,23,42,0.8);border:1px solid rgba(99,102,241,0.4);border-radius:8px;padding:7px 10px;color:#f1f5f9;font-family:inherit;font-size:0.85rem">
                            ${rolesOpts}
                        </select>
                        <input id="uedit-pin-${tel}" type="text" placeholder="PIN"
                            value="${pinVal}"
                            style="width:90px;background:rgba(15,23,42,0.8);border:1px solid rgba(0,242,254,0.4);border-radius:8px;padding:7px 10px;color:#00f2fe;font-weight:bold;font-family:inherit;font-size:0.85rem">
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
        body.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#ef4444;padding:20px;">Error: ${e.message}</td></tr>`;
    }
}

export function botEditarUsuario(tel) {
    const nombreCelda = document.querySelector(`.ucell-nombre-${tel}`);
    const nombreVal = nombreCelda ? (nombreCelda.textContent || '').trim().replace(/^—$/, '') : '';
    
    const inp = document.getElementById('uedit-nombre-' + tel);
    if (inp) {
        inp.value = nombreVal;
    }

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
    const pin    = (document.getElementById('uedit-pin-' + tel)?.value || '').trim();
    if (!nombre) { alert('El nombre no puede estar vacío.'); return; }
    try {
        const r = await fetch('/api/bot/usuarios/' + tel, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bot') },
            body: JSON.stringify({ nombre, rol, pin })
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
    const pin = (document.getElementById('bot-user-pin')?.value || '').trim();

    if (!telefono || !nombre) {
        alert('Completa teléfono y nombre.');
        return;
    }

    try {
        const r = await fetch('/api/bot/usuarios', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders('bot') },
            body: JSON.stringify({ telefono, nombre, rol, pin: pin || '1234' })
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

export async function botDesbloquear() {
    const ok = await authAsegurar('bot');
    if (ok) botInitPanel();
}

export async function botCargarTools() {
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

export async function botBorrarTool(nombre) {
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

export function botSwitchTab(tab) {
    const secWa = document.getElementById('sub-sec-wa');
    const secRealtime = document.getElementById('sub-sec-realtime');
    const btnWa = document.getElementById('tab-btn-wa');
    const btnRealtime = document.getElementById('tab-btn-realtime');

    if (tab === 'realtime') {
        if (secWa) secWa.style.display = 'none';
        if (secRealtime) secRealtime.style.display = 'block';
        if (btnWa) {
            btnWa.style.opacity = '0.6';
            btnWa.style.background = 'rgba(255, 255, 255, 0.05)';
            btnWa.style.borderColor = 'rgba(255, 255, 255, 0.1)';
            btnWa.style.color = 'var(--text-muted)';
        }
        if (btnRealtime) {
            btnRealtime.style.opacity = '1';
            btnRealtime.style.background = 'rgba(0, 242, 254, 0.15)';
            btnRealtime.style.borderColor = 'rgba(0, 242, 254, 0.4)';
            btnRealtime.style.color = '#00f2fe';
        }
    } else {
        if (secWa) secWa.style.display = 'block';
        if (secRealtime) secRealtime.style.display = 'none';
        if (btnWa) {
            btnWa.style.opacity = '1';
            btnWa.style.background = 'rgba(37, 211, 102, 0.15)';
            btnWa.style.borderColor = 'rgba(37, 211, 102, 0.4)';
            btnWa.style.color = '#25d366';
        }
        if (btnRealtime) {
            btnRealtime.style.opacity = '0.6';
            btnRealtime.style.background = 'rgba(255, 255, 255, 0.05)';
            btnRealtime.style.borderColor = 'rgba(255, 255, 255, 0.1)';
            btnRealtime.style.color = 'var(--text-muted)';
        }
    }
}

if (typeof window !== 'undefined') {
    window.botInitPanel         = botInitPanel;
    window.botRefreshStatus     = botRefreshStatus;
    window.botRefreshQr         = botRefreshQr;
    window.botRestart           = botRestart;
    window.botCargarUsuarios    = botCargarUsuarios;
    window.botEditarUsuario     = botEditarUsuario;
    window.botCancelarEdicion   = botCancelarEdicion;
    window.botGuardarEdicion    = botGuardarEdicion;
    window.botToggleUsuario     = botToggleUsuario;
    window.botAgregarUsuario    = botAgregarUsuario;
    window.botCargarConfig      = botCargarConfig;
    window.botGuardarConfig     = botGuardarConfig;
    window.botDesbloquear       = botDesbloquear;
    window.botCargarTools       = botCargarTools;
    window.botBorrarTool        = botBorrarTool;
    window.botSwitchTab         = botSwitchTab;
}

