/**
 * Global State Management — Andina Piping Dashboard
 */

export const PROJECT_START_DATE = new Date(2025, 8, 15); // Septiembre 15, 2025

export function getProjectWeek(d = new Date()) {
    if (!(d instanceof Date) || isNaN(d.getTime())) return null;
    const start = new Date(PROJECT_START_DATE);
    start.setHours(0, 0, 0, 0);
    const current = new Date(d);
    current.setHours(0, 0, 0, 0);
    const diff = current - start;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    return Math.floor(days / 7);
}

export const state = {
    lineas: [],
    isos: [],
    spools: [],
    juntas: [],
    ejecuciones: [],   // REG_EjecucionJuntas_MS
    logSpools: [],     // LOG_Spool_MS
    sdis: [],
    relSdiIso: [],     // REL_SDIIso_MS
    inspecciones: [],  // REG_InspeccionVisual_MS
    dimensional: [],   // REG_DimensionalSpool_MS
    personal: [],      // CAT_Personal_MS
    catUniones: [],    // CAT_TipoUnion_MS
    catFluidos: [],    // CAT_FluidoServicio_MS
    currentWeek: getProjectWeek(),
    currentSection: 'overview'
};

export const charts = {};

// Compatibilidad con código legado / consola
if (typeof window !== 'undefined') {
    window.state = state;
    window.charts = charts;
}
