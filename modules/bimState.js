/**
 * BIM Viewer State — Andina Piping Dashboard
 *
 * Estado compartido del visor 3D (APS/Autodesk). Es un objeto de datos puro,
 * sin dependencias, precisamente para que cualquier módulo pueda leerlo sin
 * arrastrar consigo el subsistema BIM completo.
 */
export const bimState = {
    viewer:        null,   // Instancia del Autodesk.Viewing.GuiViewer3D
    initialized:   false,  // true cuando el modelo ya cargó
    sdkLoaded:     false,  // true cuando el script del SDK ya está en el DOM
    currentGuids:  [],     // GUIDs del spool actualmente seleccionado
    dbIds:         [],     // dbIds correspondientes en el viewer
    token:         null,
    modelUrn:      null,
    statusesCache: null,   // Caché de { status: [guids] }
    selectedElement: null, // Elemento 3D clickeado actualmente
    selectedElements: [],  // Múltiples elementos 3D clickeados
    mapeoSpools:   null,   // Caché de { [guid]: spoolTag }
    spoolIndex:    null,   // Caché de { [tagLower]: { id_spool, tag_gestion, id_iso } }
    isAutoSelecting: false,// Bandera para evitar bucle de selección
    liveTimer:     null,   // Interval del modo EN VIVO (filtro por estado + polling)
    liveStatus:    null,   // (legado) estado único en vivo
    liveGuids:     null,   // (legado) set de guids mostrados
    liveEstados:   null,   // Estados seguidos EN VIVO (multi-selección)
    liveSets:      null,   // { estado: Set<guid> } ya mostrados
    filtroEstados: new Set(), // Estados seleccionados en el filtro (chips)
    coloresEstados: {},    // Overrides de color por estado (servidor)
    estadoConteos: null,   // { estado: {total, asociados, sin_asociar} } — conteo REAL de spools
    capaStatuses:  null,   // Estados de la capa válvula/soporte activa
    capa:          'spool',// Capa activa: 'spool' | 'valvula' | 'soporte'
    capaMapeo:     {},     // { valvula: {guidLower:id}, soporte: {...} }
    capaIndex:     {}      // { valvula: {idLower:row}, soporte: {...} }
};

if (typeof window !== 'undefined') {
    window.bimState = bimState;
}
