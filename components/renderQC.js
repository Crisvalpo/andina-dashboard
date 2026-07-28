/**
 * Render Quality Control (QC) Component — Andina Piping Dashboard
 *
 * "Pendiente VT" = juntas ya ejecutadas que aún no tienen registro de
 * inspección visual, desglosadas en taller vs terreno. Incluye además la
 * métrica dimensional de spools (DCC emitidos sobre spools fabricados).
 */
import { state } from '../modules/state.js';
import { setText } from '../utils/domUtils.js';
import { getEstado, getJuntaId } from '../utils/dataHelpers.js';

export function renderQC() {
    const { inspecciones, ejecuciones, juntas } = state;

    // "Pendiente VT" = juntas EJECUTADA que NO tienen registro de inspección visual
    const inspeccionIds = new Set(
        inspecciones.map(i => (i.ID_JUNTA || i['ID_JUNTA '] || '').trim()).filter(Boolean)
    );
    
    // Obtener juntas ejecutadas únicas
    const ejecutadasIds = ejecuciones
        .filter(e => getEstado(e).toUpperCase().includes('EJECUTAD'))
        .map(e => getJuntaId(e))
        .filter((v, i, a) => v && a.indexOf(v) === i);

    const pendienteVT = ejecutadasIds.filter(id => !inspeccionIds.has(id));

    // Desglose Pendientes Taller vs Terreno
    let pendTaller = 0, pendTerreno = 0;
    const juntasMap = {};
    juntas.forEach(j => juntasMap[(j.ID_JUNTA || j['ID_JUNTA '] || '').trim()] = j);

    pendienteVT.forEach(id => {
        const j = juntasMap[id];
        if (j) {
            const cat = (j.CATEGORIA_JUNTA || j['CATEGORIA_JUNTA '] || '').toUpperCase().trim();
            const isShop = cat === 'S' || cat === 'SHOP' || cat === 'TALLER';
            if (isShop) pendTaller++; else pendTerreno++;
        } else {
            pendTerreno++; // Fallback a Terreno
        }
    });

    // "VT Aprobado" e Inspecciones
    const aprobadas = inspecciones.filter(i => (i.ESTADO || i['ESTADO '] || '').toUpperCase().includes('APROBADO'));
    const rechazadas = inspecciones.filter(i => (i.ESTADO || i['ESTADO '] || '').toUpperCase().includes('RECHAZA'));
    
    // El porcentaje se calcula sobre el total de inspecciones finalizadas (Aprobadas + Rechazadas)
    const totalVAFinalizado = aprobadas.length + rechazadas.length;
    const percAprobacion = totalVAFinalizado > 0 ? Math.round((aprobadas.length / totalVAFinalizado) * 100) : 100;

    // "NDE Solicitado"
    const ndeList = inspecciones.filter(i => (i.PROXIMA_ETAPA || i['PROXIMA_ETAPA '] || i.ESTADO || '').toUpperCase().includes('NDE'));

    setText('qc-aprobado', aprobadas.length);
    setText('qc-rechazado', rechazadas.length);
    setText('qc-nde', ndeList.length);

    // Actualizar Tarjetas de Detalle
    setText('qc-pend-taller', pendTaller);
    setText('qc-pend-terreno', pendTerreno);
    setText('qc-perc-vt', `${percAprobacion}%`);
    setText('qc-nde-sol', ndeList.length);

    // ============ Métrica Dimensional (Spools) ============
    const spoolsFabricados = state.spools.filter(s => (s.ESTADO_FABRICACION || '').toUpperCase().includes('FABRICADO')).length;

    const dccEmitidos = new Set();
    state.dimensional.forEach(d => {
        const id = (d.ID_SPOOL || d['ID_SPOOL '] || '').trim();
        if (id) dccEmitidos.add(id);
    });
    const dimCount = dccEmitidos.size;
    const pendDim = spoolsFabricados - dimCount;

    setText('qc-spool-fab', spoolsFabricados);
    setText('qc-spool-dim', dimCount);
    setText('qc-spool-pend', pendDim > 0 ? pendDim : 0);
}

if (typeof window !== 'undefined') {
    window.renderQC = renderQC;
}
