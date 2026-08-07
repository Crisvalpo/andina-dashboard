/**
 * Visor de PDF (isométricos y P&ID) — Andina Piping Dashboard
 *
 * En pantallas anchas abre el plano en pantalla dividida junto al visor 3D,
 * con un divisor arrastrable; en móvil usa un modal. Los PDF se sirven por el
 * proxy del backend para esquivar X-Frame-Options del origen.
 *
 * Cada cambio de ancho obliga a llamar viewer.resize(): el visor de APS no
 * detecta por sí solo que su contenedor cambió de tamaño.
 */
import { bimState } from '../modules/bimState.js';

export function bimOpenPdf(url) {
    // Si no estamos en la sección BIM, cambiar automáticamente a la sección BIM
    if (window.showSection) {
        window.showSection('bim');
    }

    const proxyUrl = `/api/iso/proxy-pdf?url=${encodeURIComponent(url)}`;

    if (window.innerWidth > 1024) {
        // En PC: Pantalla dividida (Split Screen)
        const splitPanel = document.getElementById('bim-pdf-split-panel');
        const splitIframe = document.getElementById('bim-pdf-split-iframe');
        const resizeBar = document.getElementById('bim-pdf-resize-bar');
        if (splitPanel && splitIframe) {
            splitIframe.src = proxyUrl;
            splitPanel.style.display = 'flex';
            if (resizeBar) resizeBar.style.display = 'flex';
            
            // Forzar resize del visor 3D para ajustarse al nuevo ancho
            if (bimState.viewer) {
                setTimeout(() => {
                    bimState.viewer.resize();
                }, 150);
            }
        }
    } else {
        // En Móvil: Modal flotante
        const modal = document.getElementById('pdf-viewer-modal');
        const iframe = document.getElementById('pdf-viewer-iframe');
        if (modal && iframe) {
            iframe.src = proxyUrl;
            modal.style.display = 'flex';
        }
    }
}

export function closePdfSplit() {
    const splitPanel = document.getElementById('bim-pdf-split-panel');
    const splitIframe = document.getElementById('bim-pdf-split-iframe');
    const resizeBar = document.getElementById('bim-pdf-resize-bar');
    if (splitPanel && splitIframe) {
        splitPanel.style.display = 'none';
        if (resizeBar) resizeBar.style.display = 'none';
        splitIframe.src = '';
        
        // Restablecer el ancho del panel por defecto al cerrar
        splitPanel.style.width = '48%';
        splitPanel.style.flex = '';

        // Forzar resize del visor 3D para ocupar el 100% de nuevo
        if (bimState.viewer) {
            setTimeout(() => {
                bimState.viewer.resize();
            }, 150);
        }
    }
}

export function closePdfModal() {
    const modal = document.getElementById('pdf-viewer-modal');
    const iframe = document.getElementById('pdf-viewer-iframe');
    if (modal && iframe) {
        modal.style.display = 'none';
        iframe.src = '';
    }
    closePdfSplit();
}

export function bimOpenSelectedPdf() {
    const select = document.getElementById('bim-pdf-sheets-select');
    if (select && select.value) {
        bimOpenPdf(select.value);
    }
}

export function bimOpenSelectedPid() {
    const select = document.getElementById('bim-pdf-pids-select');
    if (select && select.value) {
        bimOpenPdf(select.value);
    }
}

export function initBimSplitResizer() {
    const resizeBar = document.getElementById('bim-pdf-resize-bar');
    const splitPanel = document.getElementById('bim-pdf-split-panel');
    const bimLayout = document.querySelector('.bim-layout');
    const bimSidebar = document.querySelector('.bim-sidebar');
    const splitIframe = document.getElementById('bim-pdf-split-iframe');

    if (!resizeBar || !splitPanel || !bimLayout) return;

    let isDragging = false;

    resizeBar.addEventListener('mousedown', function (e) {
        e.preventDefault();
        isDragging = true;
        resizeBar.classList.add('dragging');
        
        // Evitar que el iframe capture eventos del mouse durante el arrastre
        if (splitIframe) {
            splitIframe.style.pointerEvents = 'none';
        }
        
        document.body.style.cursor = 'col-resize';
    });

    document.addEventListener('mousemove', function (e) {
        if (!isDragging) return;

        // Calcular anchos dinámicos
        const layoutRect = bimLayout.getBoundingClientRect();
        const sidebarWidth = bimSidebar ? bimSidebar.clientWidth : 0;
        
        // Ancho total divisible restante (Visor 3D + Divisor + PDF)
        const totalDivisibleWidth = layoutRect.width - sidebarWidth - resizeBar.clientWidth;
        
        // Posición del cursor respecto a la sección divisible
        const mouseX = e.clientX - layoutRect.left - sidebarWidth;
        
        // El ancho asignado al PDF (derecha)
        const pdfWidth = totalDivisibleWidth - mouseX;

        // Límites de seguridad (mínimo 300px para cada lado)
        const minWidth = 300;
        const maxWidth = totalDivisibleWidth - 300;
        const finalWidth = Math.max(minWidth, Math.min(maxWidth, pdfWidth));

        // Aplicar ancho exacto al panel de PDF
        splitPanel.style.width = finalWidth + 'px';
        splitPanel.style.flex = 'none';

        // Redimensionar el visor 3D de Autodesk al vuelo
        if (bimState.viewer) {
            bimState.viewer.resize();
        }
    });

    document.addEventListener('mouseup', function () {
        if (isDragging) {
            isDragging = false;
            resizeBar.classList.remove('dragging');
            
            // Reactivar eventos del mouse en el iframe
            if (splitIframe) {
                splitIframe.style.pointerEvents = 'auto';
            }
            
            document.body.style.cursor = '';
            
            // Redimensionar una vez más al final
            if (bimState.viewer) {
                bimState.viewer.resize();
            }
        }
    });
}

if (typeof window !== 'undefined') {
    window.bimOpenPdf           = bimOpenPdf;
    window.closePdfSplit        = closePdfSplit;
    window.closePdfModal        = closePdfModal;
    window.bimOpenSelectedPdf   = bimOpenSelectedPdf;
    window.bimOpenSelectedPid   = bimOpenSelectedPid;
    window.initBimSplitResizer  = initBimSplitResizer;
}
