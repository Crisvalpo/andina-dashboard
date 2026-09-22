/**
 * services/testPackService.js
 * Servicio de extracción, estructuración jerárquica y métricas de Test Packs
 * desde LIST_Juntas_MS_, LIST_Spools_MS_, LIST_Lineas_MS_ y REG_EjecucionJuntas_MS.
 */

const fs = require('fs');
const path = require('path');

// Archivo de respaldo para comentarios locales si la tabla de Supabase no está migrada aún
const LOCAL_COMMENTS_FILE = path.join(__dirname, '../scratch/testpack_comentarios.json');

let _testPacksCache = null;
let _testPacksCacheTime = 0;

function parseFechaLog(str) {
    const m = String(str || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\D+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return 0;
    const [, p1, p2, yyyy, hh, mi, ss] = m;
    let mm, dd;
    if (+p1 > 12) {
        dd = +p1;
        mm = +p2;
    } else if (+p2 > 12) {
        mm = +p1;
        dd = +p2;
    } else {
        mm = +p1;
        dd = +p2;
    }
    return new Date(+yyyy, mm - 1, dd, +(hh || 0), +(mi || 0), +(ss || 0)).getTime();
}

function estadosActualesDeLog(logs) {
    const out = {};
    (logs || []).forEach(r => {
        const id = String(r.ID_SPOOL || r['ID_SPOOL '] || r['TAG GESTION'] || r['SPOOL'] || '').trim();
        const st = String(r.STATUS || r['STATUS '] || r['ESTADO'] || '').trim();
        if (!id || !st) return;
        const fecha = parseFechaLog(r['FECHA_LEVANTAMIENTO']);
        const row = parseInt(r._RowNumber || '0', 10) || 0;
        const keys = new Set([
            id,
            id.toLowerCase(),
            String(r['TAG GESTION'] || '').trim(),
            String(r['TAG GESTION'] || '').trim().toLowerCase()
        ]);
        keys.forEach(k => {
            if (!k) return;
            const prev = out[k];
            if (!prev || fecha > prev.fecha || (fecha === prev.fecha && row > prev.row)) {
                out[k] = { status: String(st).trim().toUpperCase(), raw: st, fecha, row };
            }
        });
    });
    return out;
}

/**
 * Procesa la jerarquía de Test Packs y elementos no asociados
 */
async function procesarArbolTestPacks(fetchAppSheetCached, forceRefresh = false) {
    const ahora = Date.now();
    if (!forceRefresh && _testPacksCache && (ahora - _testPacksCacheTime < 60000)) {
        return _testPacksCache;
    }

    const [
        juntasRows,
        ejecucionJuntasRows,
        spoolsRows,
        logsSpoolRows,
        lineasRows,
        valvulasRows,
        montajeValvulasRows,
        soportesRows,
        montajeSoportesRows
    ] = await Promise.all([
        fetchAppSheetCached('LIST_Juntas_MS_').catch(() => []),
        fetchAppSheetCached('REG_EjecucionJuntas_MS').catch(() => []),
        fetchAppSheetCached('LIST_Spools_MS_').catch(() => []),
        fetchAppSheetCached('LOG_Spool_MS').catch(() => []),
        fetchAppSheetCached('LIST_Lineas_MS_').catch(() => []),
        fetchAppSheetCached('LIST_Valvulas_MS').catch(() => []),
        fetchAppSheetCached('REG_MontajeValvulas_MS').catch(() => []),
        fetchAppSheetCached('LIST_Soportes_MS').catch(() => []),
        fetchAppSheetCached('REG_MontajeSoportes_MS').catch(() => [])
    ]);

    // 1. Juntas ejecutadas
    const ejecutadasSet = new Set();
    (ejecucionJuntasRows || []).forEach(r => {
        const idJ = String(r['ID_JUNTA'] || r['ID JUNTA'] || r['ID_Junta'] || '').trim().toLowerCase();
        if (idJ) ejecutadasSet.add(idJ);
    });

    // 2. Estados de Spools
    const spoolStatuses = estadosActualesDeLog(logsSpoolRows);

    // 3. Montaje Válvulas
    const valvulasMontajeMap = new Map();
    (montajeValvulasRows || []).forEach(r => {
        const id = String(r['ID_VALVULA'] || '').trim().toLowerCase();
        if (!id) return;
        const st = String(r['Status'] || r['STATUS'] || 'MONTADA').trim().toUpperCase();
        valvulasMontajeMap.set(id, st);
    });

    // 4. Montaje Soportes
    const soportesMontajeSet = new Set();
    (montajeSoportesRows || []).forEach(r => {
        const id = String(r['ID_Soporte'] || r['ID_SOPORTE'] || '').trim().toLowerCase();
        if (id) soportesMontajeSet.add(id);
    });

    // Helper para limpiar identificador de línea
    const cleanLine = s => String(s || '').replace(/"/g, '_').replace(/-(HC_HOJA|HOJA|HC|N|R\d+|REV\d+).*$/i, '').toLowerCase().trim();

    // 5. Agrupar Válvulas por Línea
    const valvulasPorLinea = new Map();
    (valvulasRows || []).forEach(v => {
        const idValvula = String(v['ID_VALVULA'] || v['TAG'] || '').trim();
        const idLinea = String(v['ID_LINEA'] || v['LINEA'] || '').trim();
        if (!idValvula || !idLinea) return;

        const st = valvulasMontajeMap.get(idValvula.toLowerCase()) || 'PENDIENTE';
        const isMontada = (st === 'MONTADA' || st === 'MONTADO' || st === 'POSICIONADA' || st === 'POSICIONADO');
        const item = {
            id_valvula: idValvula,
            id_linea: idLinea,
            tag_piping: String(v['TAG PIPING'] || '').trim(),
            descripcion: String(v['DESCRIPCION'] || '').trim(),
            diametro: String(v['DIAM.'] || v['DIAM'] || '').trim(),
            clase: String(v['CLASE'] || '').trim(),
            status: st,
            montada: isMontada
        };

        const keys = [idLinea.toLowerCase(), cleanLine(idLinea)];
        keys.forEach(k => {
            if (!valvulasPorLinea.has(k)) valvulasPorLinea.set(k, []);
            valvulasPorLinea.get(k).push(item);
        });
    });

    // 6. Agrupar Soportes por Línea
    const soportesPorLinea = new Map();
    (soportesRows || []).forEach(s => {
        const idSoporte = String(s['ID_Soporte'] || s['ID_SOPORTE'] || '').trim();
        const idLinea = String(s['ID_LINEA'] || s['LINEA'] || '').trim();
        if (!idSoporte || !idLinea) return;

        const isMontado = soportesMontajeSet.has(idSoporte.toLowerCase());
        const item = {
            id_soporte: idSoporte,
            id_linea: idLinea,
            item: String(s['ITEM'] || '').trim(),
            tipo: String(s['ID_TipoSoporte'] || s['TIPO'] || '').trim(),
            diametro: String(s['DIAM.'] || '').trim(),
            peso: String(s['PESO_TOTAL'] || '').trim(),
            status: isMontado ? 'MONTADO' : 'PENDIENTE',
            montado: isMontado
        };

        const keys = [idLinea.toLowerCase(), cleanLine(idLinea)];
        keys.forEach(k => {
            if (!soportesPorLinea.has(k)) soportesPorLinea.set(k, []);
            soportesPorLinea.get(k).push(item);
        });
    });

    // 7. Catálogo de Spools
    const spoolsCatMap = new Map();
    (spoolsRows || []).forEach(s => {
        const idS = String(s['ID_SPOOL'] || s['TAG GESTION'] || s['SPOOL'] || '').trim();
        const tagG = String(s['TAG GESTION'] || '').trim();
        const line = String(s['ID_LINEA'] || s['LINEA'] || '').trim();
        const iso = String(s['ID_ISO'] || s['ISOMETRICO'] || '').trim();
        const entry = { id_spool: idS, tag_gestion: tagG, id_linea: line, id_iso: iso };
        if (idS) spoolsCatMap.set(idS.toLowerCase(), entry);
        if (tagG) spoolsCatMap.set(tagG.toLowerCase(), entry);
    });

    // 8. Catálogo de Líneas
    const lineasCatMap = new Map();
    (lineasRows || []).forEach(l => {
        const idL = String(l['ID_LINEA'] || l['TAG_LINEA'] || l['LINEA'] || '').trim();
        if (idL) {
            lineasCatMap.set(idL.toLowerCase(), {
                id_linea: idL,
                subsistema: String(l['SUBSISTEMA'] || l['SUB SISTEMA'] || l['DESCRIPCION_SISTEMA'] || '').trim(),
                cwp: String(l['CWP'] || '').trim(),
                fluido: String(l['FLUIDO'] || l['ID_FLUIDO'] || '').trim(),
                pid: String(l['ID_PID'] || l['PID'] || '').trim()
            });
        }
    });

    // 9. Agrupación por Test Pack
    const tpMap = {};
    const todasLasLineasConTp = new Set();
    const todosLosSpoolsConTp = new Set();
    const todasLasJuntasConTp = new Set();

    // Estructura de juntas sin Test Pack
    const juntasSinTp = [];

    (juntasRows || []).forEach(r => {
        // Ignorar juntas eliminadas
        const observ = String(r['[OBSERV.]'] || r['OBSERV.'] || r['OBSERV'] || r['[OBSERV]'] || r['OBSERVACIONES'] || '').trim().toUpperCase();
        if (observ === 'ELIMINADA' || observ === 'ELIMINADO') return;

        const idJunta = String(r['ID_JUNTA'] || r['ID JUNTA'] || r['ID_Junta'] || '').trim();
        if (!idJunta) return;

        const rawTp = String(r['TEST PACK'] || r['TEST_PACK'] || r['TEST PACK LUKEAPP'] || '').trim();
        const idLinea = String(r['ID_LINEA'] || r['LINEA'] || r['N_LINEA'] || '').trim() || 'Sin Línea';
        const idSpool = String(r['ID_SPOOL'] || r['SPOOL'] || '').trim() || 'Sin Spool';
        const idIso = String(r['ID_ISO'] || r['ID_ISOMETRICO'] || '').trim();
        const dn = parseFloat(r['DIAMETRO_NPS'] || r['DIAMETRO'] || r['DN'] || r['NPS'] || r['PULGADAS'] || 0) || 0;
        const tipoUnion = String(r['TIPO UNION'] || r['TIPO_UNION'] || '').trim() || 'N/A';
        const sistema = String(r['SISTEMA'] || '').trim();
        const subsistema = String(r['SUB SISTEMA'] || r['SUBSISTEMA'] || '').trim();
        const esEjecutada = ejecutadasSet.has(idJunta.toLowerCase());

        const juntaItem = {
            id_junta: idJunta,
            id_linea: idLinea,
            id_spool: idSpool,
            id_iso: idIso,
            dn: dn,
            tipo_union: tipoUnion,
            sistema: sistema,
            subsistema: subsistema,
            ejecutada: esEjecutada,
            soldador: String(r['soldador'] || r['SOLDADOR'] || '').trim(),
            fecha: String(r['fecha'] || r['FECHA'] || '').trim()
        };

        if (rawTp) {
            // Dividir si viene separado por comas o punto y coma
            const tps = rawTp.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
            tps.forEach(tpName => {
                todasLasJuntasConTp.add(idJunta.toLowerCase());
                todasLasLineasConTp.add(idLinea.toLowerCase());
                todosLosSpoolsConTp.add(idSpool.toLowerCase());

                if (!tpMap[tpName]) {
                    tpMap[tpName] = {
                        nombre: tpName,
                        lineasMap: {},
                        juntasCount: 0,
                        juntasEjecutadas: 0,
                        pulgadasTotal: 0,
                        pulgadasEjecutadas: 0,
                        spoolsSet: new Set(),
                        spoolsMontadosSet: new Set()
                    };
                }

                const tpEntry = tpMap[tpName];
                tpEntry.juntasCount++;
                tpEntry.pulgadasTotal += dn;
                if (esEjecutada) {
                    tpEntry.juntasEjecutadas++;
                    tpEntry.pulgadasEjecutadas += dn;
                }

                // Línea dentro del TP
                if (!tpEntry.lineasMap[idLinea]) {
                    const lMeta = lineasCatMap.get(idLinea.toLowerCase()) || {};
                    tpEntry.lineasMap[idLinea] = {
                        id_linea: idLinea,
                        subsistema: lMeta.subsistema || subsistema,
                        cwp: lMeta.cwp || '',
                        fluido: lMeta.fluido || '',
                        pid: lMeta.pid || '',
                        juntasCount: 0,
                        juntasEjecutadas: 0,
                        pulgadasTotal: 0,
                        pulgadasEjecutadas: 0,
                        spoolsMap: {}
                    };
                }

                const lineaEntry = tpEntry.lineasMap[idLinea];
                lineaEntry.juntasCount++;
                lineaEntry.pulgadasTotal += dn;
                if (esEjecutada) {
                    lineaEntry.juntasEjecutadas++;
                    lineaEntry.pulgadasEjecutadas += dn;
                }

                // Spool dentro de la Línea
                if (!lineaEntry.spoolsMap[idSpool]) {
                    const stEntry = spoolStatuses[idSpool] || spoolStatuses[idSpool.toLowerCase()];
                    const stName = stEntry ? stEntry.status : 'SIN ESTADO';
                    const isMontado = (stName === 'MONTADO' || stName === 'MONTADA');

                    lineaEntry.spoolsMap[idSpool] = {
                        id_spool: idSpool,
                        status: stName,
                        montado: isMontado,
                        juntas: []
                    };

                    tpEntry.spoolsSet.add(idSpool.toLowerCase());
                    if (isMontado) tpEntry.spoolsMontadosSet.add(idSpool.toLowerCase());
                }

                lineaEntry.spoolsMap[idSpool].juntas.push(juntaItem);
            });
        } else {
            juntasSinTp.push(juntaItem);
        }
    });

    // 6. Formatear la lista de Test Packs detectados
    const testPacksList = Object.values(tpMap).map(tp => {
        const pctJuntas = tp.juntasCount > 0 ? ((tp.juntasEjecutadas / tp.juntasCount) * 100) : 0;
        const pctPulgadas = tp.pulgadasTotal > 0 ? ((tp.pulgadasEjecutadas / tp.pulgadasTotal) * 100) : 0;
        const totalSpools = tp.spoolsSet.size;
        const montadosSpools = tp.spoolsMontadosSet.size;
        const pctSpools = totalSpools > 0 ? ((montadosSpools / totalSpools) * 100) : 0;

        let tpTotalValvulas = 0;
        let tpValvulasMontadas = 0;
        let tpTotalSoportes = 0;
        let tpSoportesMontados = 0;

        const lineas = Object.values(tp.lineasMap).map(l => {
            const lPctJuntas = l.juntasCount > 0 ? ((l.juntasEjecutadas / l.juntasCount) * 100) : 0;
            const spools = Object.values(l.spoolsMap);

            // Válvulas asociadas a esta línea
            const vList = valvulasPorLinea.get(l.id_linea.toLowerCase()) || valvulasPorLinea.get(cleanLine(l.id_linea)) || [];
            const vMont = vList.filter(v => v.montada).length;
            tpTotalValvulas += vList.length;
            tpValvulasMontadas += vMont;

            // Soportes asociados a esta línea
            const sList = soportesPorLinea.get(l.id_linea.toLowerCase()) || soportesPorLinea.get(cleanLine(l.id_linea)) || [];
            const sMont = sList.filter(s => s.montado).length;
            tpTotalSoportes += sList.length;
            tpSoportesMontados += sMont;

            return {
                id_linea: l.id_linea,
                subsistema: l.subsistema,
                cwp: l.cwp,
                fluido: l.fluido,
                pid: l.pid,
                metricas: {
                    juntas_total: l.juntasCount,
                    juntas_ejecutadas: l.juntasEjecutadas,
                    juntas_porcentaje: parseFloat(lPctJuntas.toFixed(1)),
                    pulgadas_total: parseFloat(l.pulgadasTotal.toFixed(1)),
                    pulgadas_ejecutadas: parseFloat(l.pulgadasEjecutadas.toFixed(1)),
                    total_spools: spools.length,
                    spools_montados: spools.filter(s => s.montado).length,
                    total_valvulas: vList.length,
                    valvulas_montadas: vMont,
                    valvulas_porcentaje: vList.length > 0 ? parseFloat(((vMont / vList.length) * 100).toFixed(1)) : 0,
                    total_soportes: sList.length,
                    soportes_montados: sMont,
                    soportes_porcentaje: sList.length > 0 ? parseFloat(((sMont / sList.length) * 100).toFixed(1)) : 0
                },
                spools: spools,
                valvulas: vList,
                soportes: sList
            };
        }).sort((a, b) => a.id_linea.localeCompare(b.id_linea));

        let estadoGeneral = 'PENDIENTE';
        if (pctJuntas >= 100) estadoGeneral = 'COMPLETO';
        else if (pctJuntas > 0) estadoGeneral = 'EN_PROCESO';

        return {
            nombre: tp.nombre,
            estado: estadoGeneral,
            metricas: {
                juntas_total: tp.juntasCount,
                juntas_ejecutadas: tp.juntasEjecutadas,
                juntas_porcentaje: parseFloat(pctJuntas.toFixed(1)),
                pulgadas_total: parseFloat(tp.pulgadasTotal.toFixed(1)),
                pulgadas_ejecutadas: parseFloat(tp.pulgadasEjecutadas.toFixed(1)),
                pulgadas_porcentaje: parseFloat(pctPulgadas.toFixed(1)),
                total_spools: totalSpools,
                spools_montados: montadosSpools,
                spools_porcentaje: parseFloat(pctSpools.toFixed(1)),
                total_valvulas: tpTotalValvulas,
                valvulas_montadas: tpValvulasMontadas,
                valvulas_porcentaje: tpTotalValvulas > 0 ? parseFloat(((tpValvulasMontadas / tpTotalValvulas) * 100).toFixed(1)) : 0,
                total_soportes: tpTotalSoportes,
                soportes_montados: tpSoportesMontados,
                soportes_porcentaje: tpTotalSoportes > 0 ? parseFloat(((tpSoportesMontados / tpTotalSoportes) * 100).toFixed(1)) : 0,
                total_lineas: lineas.length
            },
            lineas: lineas
        };
    }).sort((a, b) => a.nombre.localeCompare(b.nombre));

    // 7. Construir árbol y listas de elementos NO ASOCIADOS (Sin Test Pack)
    // Agrupar juntas huérfanas en árbol (Línea -> Spool -> Juntas)
    const huerfanosLineasMap = {};
    let huerfanasPulgTotal = 0;
    let huerfanasPulgEjec = 0;
    let huerfanasEjec = 0;

    juntasSinTp.forEach(j => {
        huerfanasPulgTotal += j.dn;
        if (j.ejecutada) {
            huerfanasEjec++;
            huerfanasPulgEjec += j.dn;
        }

        const lKey = j.id_linea;
        if (!huerfanosLineasMap[lKey]) {
            const lMeta = lineasCatMap.get(lKey.toLowerCase()) || {};
            huerfanosLineasMap[lKey] = {
                id_linea: lKey,
                subsistema: lMeta.subsistema || j.subsistema,
                cwp: lMeta.cwp || '',
                fluido: lMeta.fluido || '',
                pid: lMeta.pid || '',
                juntasCount: 0,
                juntasEjecutadas: 0,
                pulgadasTotal: 0,
                pulgadasEjecutadas: 0,
                spoolsMap: {}
            };
        }

        const lEntry = huerfanosLineasMap[lKey];
        lEntry.juntasCount++;
        lEntry.pulgadasTotal += j.dn;
        if (j.ejecutada) {
            lEntry.juntasEjecutadas++;
            lEntry.pulgadasEjecutadas += j.dn;
        }

        const spKey = j.id_spool;
        if (!lEntry.spoolsMap[spKey]) {
            const stEntry = spoolStatuses[spKey] || spoolStatuses[spKey.toLowerCase()];
            const stName = stEntry ? stEntry.status : 'SIN ESTADO';
            lEntry.spoolsMap[spKey] = {
                id_spool: spKey,
                status: stName,
                montado: (stName === 'MONTADO' || stName === 'MONTADA'),
                juntas: []
            };
        }
        lEntry.spoolsMap[spKey].juntas.push(j);
    });

    let huerfanasValvulasTotal = 0;
    let huerfanasValvulasMont = 0;
    let huerfanosSoportesTotal = 0;
    let huerfanosSoportesMont = 0;

    const arbolHuerfanos = Object.values(huerfanosLineasMap).map(l => {
        const pctJ = l.juntasCount > 0 ? ((l.juntasEjecutadas / l.juntasCount) * 100) : 0;
        const spools = Object.values(l.spoolsMap);

        const vList = valvulasPorLinea.get(l.id_linea.toLowerCase()) || valvulasPorLinea.get(cleanLine(l.id_linea)) || [];
        const vMont = vList.filter(v => v.montada).length;
        huerfanasValvulasTotal += vList.length;
        huerfanasValvulasMont += vMont;

        const sList = soportesPorLinea.get(l.id_linea.toLowerCase()) || soportesPorLinea.get(cleanLine(l.id_linea)) || [];
        const sMont = sList.filter(s => s.montado).length;
        huerfanosSoportesTotal += sList.length;
        huerfanosSoportesMont += sMont;

        return {
            id_linea: l.id_linea,
            subsistema: l.subsistema,
            cwp: l.cwp,
            fluido: l.fluido,
            pid: l.pid,
            metricas: {
                juntas_total: l.juntasCount,
                juntas_ejecutadas: l.juntasEjecutadas,
                juntas_porcentaje: parseFloat(pctJ.toFixed(1)),
                pulgadas_total: parseFloat(l.pulgadasTotal.toFixed(1)),
                pulgadas_ejecutadas: parseFloat(l.pulgadasEjecutadas.toFixed(1)),
                total_spools: spools.length,
                spools_montados: spools.filter(s => s.montado).length,
                total_valvulas: vList.length,
                valvulas_montadas: vMont,
                total_soportes: sList.length,
                soportes_montados: sMont
            },
            spools: spools,
            valvulas: vList,
            soportes: sList
        };
    }).sort((a, b) => a.id_linea.localeCompare(b.id_linea));

    // Válvulas y Soportes de catálogo sin Test Pack
    const valvulasSinTpCatalogo = [];
    (valvulasRows || []).forEach(v => {
        const idL = String(v['ID_LINEA'] || v['LINEA'] || '').trim();
        if (idL && !todasLasLineasConTp.has(idL.toLowerCase())) {
            valvulasSinTpCatalogo.push(v);
        }
    });

    const soportesSinTpCatalogo = [];
    (soportesRows || []).forEach(s => {
        const idL = String(s['ID_LINEA'] || s['LINEA'] || '').trim();
        if (idL && !todasLasLineasConTp.has(idL.toLowerCase())) {
            soportesSinTpCatalogo.push(s);
        }
    });

    // Identificar Spools de catálogo sin Test Pack
    const spoolsSinTpCatalogo = [];
    (spoolsRows || []).forEach(s => {
        const idS = String(s['ID_SPOOL'] || s['TAG GESTION'] || s['SPOOL'] || '').trim();
        const idL = String(s['ID_LINEA'] || s['LINEA'] || '').trim();
        if (idS && !todosLosSpoolsConTp.has(idS.toLowerCase())) {
            const stEntry = spoolStatuses[idS] || spoolStatuses[idS.toLowerCase()];
            spoolsSinTpCatalogo.push({
                id_spool: idS,
                id_linea: idL,
                tag_gestion: String(s['TAG GESTION'] || '').trim(),
                status: stEntry ? stEntry.status : 'SIN ESTADO',
                montado: stEntry ? (stEntry.status === 'MONTADO' || stEntry.status === 'MONTADA') : false
            });
        }
    });

    // Identificar Líneas de catálogo sin Test Pack
    const lineasSinTpCatalogo = [];
    (lineasRows || []).forEach(l => {
        const idL = String(l['ID_LINEA'] || l['TAG_LINEA'] || l['LINEA'] || '').trim();
        if (idL && !todasLasLineasConTp.has(idL.toLowerCase())) {
            lineasSinTpCatalogo.push({
                id_linea: idL,
                subsistema: String(l['SUBSISTEMA'] || l['SUB SISTEMA'] || l['DESCRIPCION_SISTEMA'] || '').trim(),
                cwp: String(l['CWP'] || '').trim(),
                fluido: String(l['FLUIDO'] || l['ID_FLUIDO'] || '').trim(),
                pid: String(l['ID_PID'] || l['PID'] || '').trim()
            });
        }
    });

    const totalJuntasGlobal = todasLasJuntasConTp.size + juntasSinTp.length;
    const coberturaJuntasPct = totalJuntasGlobal > 0 ? ((todasLasJuntasConTp.size / totalJuntasGlobal) * 100) : 0;

    const result = {
        kpis: {
            total_test_packs: testPacksList.length,
            total_juntas_asignadas: todasLasJuntasConTp.size,
            total_juntas_sin_asignar: juntasSinTp.length,
            total_juntas_global: totalJuntasGlobal,
            cobertura_porcentaje: parseFloat(coberturaJuntasPct.toFixed(1)),
            total_lineas_sin_tp: lineasSinTpCatalogo.length,
            total_spools_sin_tp: spoolsSinTpCatalogo.length,
            total_valvulas_asignadas: (valvulasRows || []).length - valvulasSinTpCatalogo.length,
            total_valvulas_sin_asignar: valvulasSinTpCatalogo.length,
            total_valvulas_global: (valvulasRows || []).length,
            total_soportes_asignados: (soportesRows || []).length - soportesSinTpCatalogo.length,
            total_soportes_sin_asignar: soportesSinTpCatalogo.length,
            total_soportes_global: (soportesRows || []).length
        },
        test_packs: testPacksList,
        sin_test_pack: {
            metricas: {
                total_juntas: juntasSinTp.length,
                juntas_ejecutadas: huerfanasEjec,
                juntas_porcentaje: juntasSinTp.length > 0 ? parseFloat(((huerfanasEjec / juntasSinTp.length) * 100).toFixed(1)) : 0,
                pulgadas_total: parseFloat(huerfanasPulgTotal.toFixed(1)),
                pulgadas_ejecutadas: parseFloat(huerfanasPulgEjec.toFixed(1)),
                total_lineas: arbolHuerfanos.length,
                total_spools_en_juntas: spoolsSinTpCatalogo.length,
                total_valvulas: huerfanasValvulasTotal,
                valvulas_montadas: huerfanasValvulasMont,
                total_soportes: huerfanosSoportesTotal,
                soportes_montados: huerfanosSoportesMont
            },
            arbol: arbolHuerfanos,
            juntas_list: juntasSinTp,
            spools_catalogo: spoolsSinTpCatalogo,
            lineas_catalogo: lineasSinTpCatalogo,
            valvulas_catalogo: valvulasSinTpCatalogo,
            soportes_catalogo: soportesSinTpCatalogo
        }
    };

    _testPacksCache = result;
    _testPacksCacheTime = ahora;
    return result;
}

/**
 * Persistencia de Comentarios (Supabase con fallback local en JSON)
 */
function getLocalComments() {
    try {
        if (!fs.existsSync(LOCAL_COMMENTS_FILE)) return [];
        const raw = fs.readFileSync(LOCAL_COMMENTS_FILE, 'utf-8');
        return JSON.parse(raw) || [];
    } catch (e) {
        return [];
    }
}

function saveLocalComments(comments) {
    try {
        const dir = path.dirname(LOCAL_COMMENTS_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(LOCAL_COMMENTS_FILE, JSON.stringify(comments, null, 2), 'utf-8');
    } catch (e) {
        console.error('[testPackService] Error guardando comentarios locales:', e.message);
    }
}

async function obtenerComentarios(supabase, query = {}) {
    // 1. Intentar con Supabase
    if (supabase) {
        try {
            let sbQuery = supabase.from('testpack_comentarios').select('*').order('created_at', { ascending: false });
            if (query.entidad_tipo) sbQuery = sbQuery.eq('entidad_tipo', query.entidad_tipo);
            if (query.entidad_id) sbQuery = sbQuery.eq('entidad_id', query.entidad_id);
            if (query.test_pack) sbQuery = sbQuery.eq('test_pack', query.test_pack);

            const { data, error } = await sbQuery;
            if (!error && data) return data;
        } catch (e) {
            // Silencioso, usar fallback
        }
    }

    // 2. Fallback a archivo local
    let list = getLocalComments();
    if (query.entidad_tipo) list = list.filter(c => c.entidad_tipo === query.entidad_tipo);
    if (query.entidad_id) list = list.filter(c => c.entidad_id === query.entidad_id);
    if (query.test_pack) list = list.filter(c => c.test_pack === query.test_pack);
    return list.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function guardarComentario(supabase, { entidad_tipo, entidad_id, test_pack, comentario, usuario }) {
    const nuevo = {
        id: require('crypto').randomUUID(),
        entidad_tipo: String(entidad_tipo || '').trim(),
        entidad_id: String(entidad_id || '').trim(),
        test_pack: String(test_pack || '').trim(),
        comentario: String(comentario || '').trim(),
        usuario: String(usuario || 'Supervisor').trim(),
        created_at: new Date().toISOString()
    };

    if (!nuevo.entidad_tipo || !nuevo.entidad_id || !nuevo.comentario) {
        throw new Error('entidad_tipo, entidad_id y comentario son obligatorios');
    }

    // 1. Guardar en Supabase si está disponible
    if (supabase) {
        try {
            const { data, error } = await supabase.from('testpack_comentarios').insert([nuevo]).select().single();
            if (!error && data) {
                // Sincronizar también en local como respaldo
                const local = getLocalComments();
                local.unshift(data);
                saveLocalComments(local);
                return data;
            }
        } catch (e) {
            // Silencioso, guardar en local
        }
    }

    // 2. Guardar en local
    const local = getLocalComments();
    local.unshift(nuevo);
    saveLocalComments(local);
    return nuevo;
}

async function eliminarComentario(supabase, id) {
    if (supabase) {
        try {
            await supabase.from('testpack_comentarios').delete().eq('id', id);
        } catch (e) { /* silencioso */ }
    }
    const local = getLocalComments().filter(c => c.id !== id);
    saveLocalComments(local);
    return { success: true, id };
}

module.exports = {
    procesarArbolTestPacks,
    obtenerComentarios,
    guardarComentario,
    eliminarComentario
};
