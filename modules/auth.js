/**
 * Auth por área — Andina Piping Dashboard
 *
 * Tokens de edición guardados en localStorage con caducidad. Una misma clave
 * puede otorgar varios permisos ('bim', 'bot'), así que el login guarda el
 * token para cada uno de los permisos que devuelve el servidor.
 *
 * Sin dependencias: solo localStorage, fetch y DOM.
 */
export const AUTH_LABELS = {
    bim: { titulo: 'Edición BIM', desc: 'Ingresa la clave para vincular elementos 3D a spools.' },
    bot: { titulo: 'Administración del Bot', desc: 'Ingresa la clave para administrar el bot de WhatsApp.' }
};

export function authGuardar(area, token, expiraEnHoras) {
    const exp = Date.now() + (expiraEnHoras || 12) * 3600 * 1000;
    localStorage.setItem(`andina_tok_${area}`, JSON.stringify({ token, exp }));
}

export function authObtener(area) {
    try {
        const raw = localStorage.getItem(`andina_tok_${area}`);
        if (!raw) return null;
        const { token, exp } = JSON.parse(raw);
        if (!exp || Date.now() > exp) { authOlvidar(area); return null; }
        return token;
    } catch (e) { return null; }
}

export function authOlvidar(area) {
    localStorage.removeItem(`andina_tok_${area}`);
}

export function authHeaders(area) {
    const t = authObtener(area);
    return t ? { 'x-edit-token': t } : {};
}

/** Garantiza que exista un token válido para el área; si no, pide la clave. */
export async function authAsegurar(area) {
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
export function authPedirClave(area) {
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

// =================================================================
// SESIÓN GENERAL DEL DASHBOARD (Cliente vs Interno)
// =================================================================
export function authObtenerSesionDashboard() {
    try {
        const raw = localStorage.getItem('andina_dashboard_auth');
        if (!raw) return null;
        const data = JSON.parse(raw);
        if (data && data.rol) return data;
        return null;
    } catch (e) { return null; }
}

export function authGuardarSesionDashboard(token, permisos) {
    const rol = permisos.includes('cliente_reemplazos') ? 'cliente_reemplazos'
        : (permisos.includes('acceso_total') ? 'acceso_total' : 'acceso_parcial');
    const sesion = { token, permisos, rol, timestamp: Date.now() };
    localStorage.setItem('andina_dashboard_auth', JSON.stringify(sesion));
    return sesion;
}

export function authCerrarSesionDashboard() {
    localStorage.removeItem('andina_dashboard_auth');
    window.location.reload();
}

export async function authLoginDashboard(clave) {
    if (!clave) return { success: false, error: 'Ingresa una clave' };
    try {
        const r = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clave: String(clave).trim() })
        });
        const d = await r.json();
        if (!d.success) {
            return { success: false, error: d.error || 'Clave incorrecta' };
        }
        const sesion = authGuardarSesionDashboard(d.token, d.permisos || []);
        return { success: true, sesion };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/** Despliega la pantalla de bienvenida / login general si no hay sesión guardada */
export function authMostrarModalAccesoDashboard(onSuccess) {
    const existing = document.getElementById('dashboard-auth-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'dashboard-auth-overlay';
    overlay.className = 'dashboard-auth-overlay';
    overlay.innerHTML = `
        <div class="dashboard-auth-card glass">
            <div class="dashboard-auth-header">
                <img src="https://www.appsheet.com/fsimage.png?appid=eb4713b6-0828-4993-b5e1-935eec83cf4e&datasource=office365&filename=SHAREPOINT_SITE_ID_echeverriaizquierdo.sharepoint.com_858d3f02-6ce3-4132-892a-f39da71611a2_447c3764-ba28-4616-a44e-cc91939d7e35%2F8-Prototipos%20en%20Terreno%2F2%20-%20Espesador%20de%20Concentrado%20Colectivo%20PMFC%20-%20CODELCO%20-%202025%2F1%20-%20APP%2F0_UX%2FArchivos%2FImagenes%2FLogo%2FLogoLukeAPP2.png&signature=b8291a12acee8418894e8d777dc1905485a1f000714ed47e63a525b6772c1a7b&tableprovider=microsoft&userid=526211656"
                     alt="LukeAPP" class="dashboard-auth-logo" onerror="this.style.display='none'">
                <h2>Andina PRY-413</h2>
                <p>Piping Control & Modelo 3D</p>
            </div>
            <form id="dashboard-auth-form" onsubmit="return false;">
                <label for="dashboard-auth-input">Clave de Acceso</label>
                <div class="dashboard-auth-input-wrap">
                    <i class="fas fa-key"></i>
                    <input type="password" id="dashboard-auth-input" placeholder="Ingresa tu clave" required autocomplete="current-password" autofocus>
                </div>
                <div class="dashboard-auth-error" id="dashboard-auth-error" style="display:none;"></div>
                <button type="submit" id="dashboard-auth-btn" class="dashboard-auth-btn">
                    <span>Ingresar</span> <i class="fas fa-arrow-right"></i>
                </button>
            </form>
            <div class="dashboard-auth-footer">
                <span>Sesión permanente: ingresa una sola vez</span>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#dashboard-auth-input');
    const btn = overlay.querySelector('#dashboard-auth-btn');
    const errEl = overlay.querySelector('#dashboard-auth-error');
    const form = overlay.querySelector('#dashboard-auth-form');

    form.onsubmit = async (e) => {
        e.preventDefault();
        const clave = input.value.trim();
        if (!clave) return;

        btn.disabled = true;
        btn.innerHTML = '<div class="redline-spinner" style="border-top-color:#fff; width:16px; height:16px; display:inline-block;"></div> Validando...';
        if (errEl) errEl.style.display = 'none';

        const res = await authLoginDashboard(clave);
        if (res.success) {
            overlay.remove();
            if (onSuccess) onSuccess(res.sesion);
        } else {
            btn.disabled = false;
            btn.innerHTML = '<span>Ingresar</span> <i class="fas fa-arrow-right"></i>';
            if (errEl) {
                errEl.textContent = res.error || 'Clave incorrecta';
                errEl.style.display = 'block';
            }
            input.focus();
            input.select();
        }
    };

    setTimeout(() => input?.focus(), 80);
}

if (typeof window !== 'undefined') {
    window.authGuardar      = authGuardar;
    window.authObtener      = authObtener;
    window.authOlvidar      = authOlvidar;
    window.authHeaders      = authHeaders;
    window.authAsegurar     = authAsegurar;
    window.authPedirClave   = authPedirClave;
    window.AUTH_LABELS     = AUTH_LABELS;
    window.authObtenerSesionDashboard = authObtenerSesionDashboard;
    window.authGuardarSesionDashboard = authGuardarSesionDashboard;
    window.authCerrarSesionDashboard  = authCerrarSesionDashboard;
    window.authLoginDashboard         = authLoginDashboard;
    window.authMostrarModalAccesoDashboard = authMostrarModalAccesoDashboard;
}
