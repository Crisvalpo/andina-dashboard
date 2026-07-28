/**
 * DOM Utilities — Andina Piping Dashboard
 */

export function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

export function iconBg(hex) {
    if (!hex || typeof hex !== 'string') return 'rgba(100, 116, 139, 0.15)';
    if (hex.startsWith('hsl')) {
        return hex.replace('hsl(', 'hsla(').replace(')', ', 0.15)');
    }
    if (hex.startsWith('#')) {
        const r = parseInt(hex.slice(1, 3), 16) || 0;
        const g = parseInt(hex.slice(3, 5), 16) || 0;
        const b = parseInt(hex.slice(5, 7), 16) || 0;
        return `rgba(${r}, ${g}, ${b}, 0.15)`;
    }
    return 'rgba(100, 116, 139, 0.15)';
}

// Exponer en window para retrocompatibilidad
if (typeof window !== 'undefined') {
    window.setText = setText;
    window.iconBg = iconBg;
}
