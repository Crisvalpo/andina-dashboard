/**
 * Authentication & Access Control Module — Andina Piping Dashboard
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
        input.onkeydown = e => { if (e.key === 'Enter') cerrar(input.value); };
        setTimeout(() => input.focus(), 50);
    });
}

// Exponer en window para retrocompatibilidad
if (typeof window !== 'undefined') {
    window.authGuardar = authGuardar;
    window.authObtener = authObtener;
    window.authOlvidar = authOlvidar;
    window.authHeaders = authHeaders;
    window.authAsegurar = authAsegurar;
    window.authPedirClave = authPedirClave;
}
