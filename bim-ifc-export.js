/**
 * =================================================================
 * EXPORTACIÓN IFC4 DE LOS TROZOS DE LA HERRAMIENTA "DIVIDIR TRAMO"
 * =================================================================
 * Los trozos son geometría virtual (overlay THREE.js sobre el modelo APS).
 * Este módulo los materializa como IfcPipeSegment reales en un archivo
 * IFC4 (STEP Physical File) que se puede federar en Revit / Navisworks /
 * BIMcollab / Solibri junto al modelo original.
 *
 * Todo ocurre en el navegador: no hay endpoint ni dependencias externas.
 *
 * Cada trozo se escribe como:
 *   IfcPipeSegment
 *     ├─ ObjectPlacement  → IfcLocalPlacement en el eje real del tubo (PCA)
 *     ├─ Representation   → IfcExtrudedAreaSolid de IfcCircleProfileDef
 *     └─ Pset_AndinaTrozo → spool, estado, ISO, fluido, capa, ejecución…
 *
 * Depende de globales de app.js: bimState, divState, state,
 * bimStatusPorGuid(), getVal(), formatDate().
 */

// ---------------------------------------------------------------
// 1. UTILIDADES STEP / IFC
// ---------------------------------------------------------------

const IFC_B64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

/** Codifica un número en `len` caracteres del alfabeto base64 de IFC. */
function ifcCv(num, len) {
    let s = '';
    for (let i = 0; i < len; i++) { s = IFC_B64[num % 64] + s; num = Math.floor(num / 64); }
    return s;
}

/**
 * GlobalId IFC: 128 bits comprimidos a 22 caracteres.
 * Grupos: 1 byte → 2 chars, luego 5 grupos de 3 bytes → 4 chars c/u.
 */
function ifcGuid() {
    const b = new Uint8Array(16);
    const c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    let s = ifcCv(b[0], 2);
    for (let i = 1; i < 16; i += 3) s += ifcCv((b[i] << 16) | (b[i + 1] << 8) | b[i + 2], 4);
    return s;
}

/** Cadena STEP: comillas dobladas y no-ASCII en \X2\…\X0\ (ISO 10303-21). */
function ifcStr(v) {
    if (v === null || v === undefined || v === '') return '$';
    let out = '', buf = '';
    const flush = () => { if (buf) { out += '\\X2\\' + buf + '\\X0\\'; buf = ''; } };
    for (const ch of String(v)) {
        const c = ch.codePointAt(0);
        if (c < 128) { flush(); out += (ch === "'" ? "''" : ch === '\\' ? '\\\\' : ch); }
        else buf += c.toString(16).toUpperCase().padStart(4, '0');
    }
    flush();
    return "'" + out + "'";
}

/** Número STEP: siempre con punto decimal, sin notación exponencial rara. */
function ifcNum(v) {
    if (v === null || v === undefined || !isFinite(v)) return '$';
    const n = Number(v);
    if (Number.isInteger(n)) return n.toFixed(1);
    return String(Number(n.toFixed(6)));
}

/** Acumulador de líneas del archivo IFC con contador de #id. */
class IfcWriter {
    constructor() { this.id = 0; this.lines = []; }
    /** Agrega una entidad y devuelve su referencia '#n'. */
    add(entity) {
        const ref = '#' + (++this.id);
        this.lines.push(`${ref}= ${entity};`);
        return ref;
    }
    list(refs) { return refs.length ? '(' + refs.join(',') + ')' : '()'; }
}

// ---------------------------------------------------------------
// 2. RECOLECCIÓN DE DATOS DEL TROZO
// ---------------------------------------------------------------

/** Fluido de servicio inferido del ID_ISO (patrón "-FLUIDO-"), vía CAT_FluidoServicio_MS. */
function bimIfcFluidoDeIso(iso) {
    if (!iso || !window.state || !Array.isArray(state.catFluidos)) return '';
    const s = String(iso).toUpperCase();
    for (const f of state.catFluidos) {
        const id = String(f.ID_FLUIDO || f['ID_FLUIDO '] || '').trim().toUpperCase();
        if (id && s.includes(`-${id}-`)) return id;
    }
    return '';
}

/** Última ejecución registrada del spool → { fecha, soldador }. */
function bimIfcEjecucionDeSpool(tag, idSpool) {
    if (!tag || !window.state || !Array.isArray(state.ejecuciones)) return {};
    const objetivos = [tag, idSpool].filter(Boolean).map(v => String(v).trim().toUpperCase());
    const filas = state.ejecuciones.filter(e => {
        const s = String(getVal(e, 'ID_SPOOL') || '').trim().toUpperCase();
        return s && objetivos.includes(s);
    });
    if (!filas.length) return {};
    filas.sort((a, b) => parseDate(getVal(b, 'FECHA_EJECUCION')) - parseDate(getVal(a, 'FECHA_EJECUCION')));
    const ult = filas[0];
    const estampa = getVal(ult, 'ESTAMPA_EJECUTOR') || getVal(ult, 'RESPONSABLE') || '';

    // ESTAMPA → nombre completo (LIST_Personal)
    let nombre = estampa;
    (state.personal || []).forEach(p => {
        const est = getVal(p, 'ESTAMPA') || getVal(p, 'ID_PERSONAL');
        if (est && String(est).trim() === String(estampa).trim()) {
            nombre = getVal(p, 'NOMBRES APELLIDOS') ||
                `${getVal(p, 'NOMBRES')} ${getVal(p, 'APELLIDOS')}`.trim() || estampa;
        }
    });
    return {
        fecha: getVal(ult, 'FECHA_EJECUCION') || '',
        soldador: nombre ? `${nombre}${estampa && nombre !== estampa ? ' (' + estampa + ')' : ''}` : ''
    };
}

/**
 * Reúne geometría + metadatos de cada trozo a exportar.
 * @param {'todos'|'visibles'|'spool'} alcance
 */
function bimIfcRecolectar(alcance = 'todos') {
    const viewer = bimState.viewer;
    if (!viewer || !divState || !divState.trozoMeshes) return [];

    const estadoDe = typeof bimStatusPorGuid === 'function' ? bimStatusPorGuid() : {};
    const mapeo = bimState.mapeoSpools || {};
    const index = bimState.spoolIndex || {};
    const spoolBuscado = new Set((bimState.currentGuids || []).map(g => String(g).toLowerCase()));

    const escala = (typeof viewer.model.getUnitScale === 'function' ? viewer.model.getUnitScale() : 1) || 1;
    // Los fragmentos vienen desplazados por globalOffset → se devuelve a coordenadas del modelo.
    const off = (viewer.model.getData && viewer.model.getData().globalOffset) || { x: 0, y: 0, z: 0 };

    const out = [];
    for (const [key, mesh] of Object.entries(divState.trozoMeshes)) {
        if (alcance === 'visibles' && mesh.visible === false) continue;
        if (alcance === 'spool' && !spoolBuscado.has(key)) continue;

        const ud = mesh.userData || {};
        const eje = ud.eje;
        if (!eje || !eje.p0 || !eje.dir) continue;

        const a = typeof ud.a === 'number' ? ud.a : 0;
        const b = typeof ud.b === 'number' ? ud.b : 1;
        const largoU = eje.len * (b - a);
        if (!(largoU > 0)) continue;

        const ini = eje.p0.clone().add(eje.dir.clone().multiplyScalar(eje.len * a));

        const tag = mapeo[key] || '';
        const ficha = tag ? (index[String(tag).toLowerCase()] || {}) : {};
        const iso = ficha.id_iso || '';
        const ejec = bimIfcEjecucionDeSpool(tag, ficha.id_spool);

        out.push({
            key,
            guidPadre: ud.guid || String(key).split('#')[0],
            idx: (ud.idx || 0) + 1,
            // Geometría en METROS y coordenadas del modelo
            p: { x: (ini.x + off.x) * escala, y: (ini.y + off.y) * escala, z: (ini.z + off.z) * escala },
            d: { x: eje.dir.x, y: eje.dir.y, z: eje.dir.z },
            largo: largoU * escala,
            radio: (eje.radio || 0.05) * escala,
            a, b,
            spool: tag,
            idSpool: ficha.id_spool || '',
            estado: estadoDe[key] || 'SIN ESTADO',
            iso,
            fluido: bimIfcFluidoDeIso(iso),
            capa: bimState.capa || 'spool',
            fechaEjecucion: ejec.fecha || '',
            soldador: ejec.soldador || ''
        });
    }
    out.sort((x, y) => x.key.localeCompare(y.key));
    return out;
}

// ---------------------------------------------------------------
// 3. GENERACIÓN DEL ARCHIVO IFC4
// ---------------------------------------------------------------

/**
 * Construye el SPF completo.
 * @param {Array} trozos  salida de bimIfcRecolectar()
 * @param {Object} opts   { nombreProyecto, autor, archivo }
 * @returns {string} contenido del .ifc
 */
function bimIfcGenerar(trozos, opts = {}) {
    const w = new IfcWriter();
    const P = (x, y, z) => w.add(`IFCCARTESIANPOINT((${ifcNum(x)},${ifcNum(y)},${ifcNum(z)}))`);
    const D = (x, y, z) => w.add(`IFCDIRECTION((${ifcNum(x)},${ifcNum(y)},${ifcNum(z)}))`);

    const nombreProyecto = opts.nombreProyecto || 'Andina — Trozos de cañería';
    const autor = opts.autor || 'LukeAPP';

    // --- Cabecera ------------------------------------------------
    const ahora = new Date();
    const iso = ahora.toISOString().replace(/\.\d{3}Z$/, '');
    const header =
        `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME(${ifcStr(opts.archivo || 'trozos.ifc')},'${iso}',(${ifcStr(autor)}),(${ifcStr('Andina')}),${ifcStr('LukeAPP Dashboard - Dividir tramo')},${ifcStr('LukeAPP')},'');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;`;

    // --- Contexto, unidades y propietario -------------------------
    const origen = P(0, 0, 0);
    const dirZ = D(0, 0, 1);
    const dirX = D(1, 0, 0);
    const ejeMundo = w.add(`IFCAXIS2PLACEMENT3D(${origen},$,$)`);
    const norte = D(0, 1, 0);

    const ctx = w.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${ejeMundo},${norte})`);
    const subCtx = w.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);

    const uLen = w.add(`IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)`);
    const uArea = w.add(`IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)`);
    const uVol = w.add(`IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)`);
    const uAng = w.add(`IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)`);
    const unidades = w.add(`IFCUNITASSIGNMENT((${uLen},${uArea},${uVol},${uAng}))`);

    const persona = w.add(`IFCPERSON($,${ifcStr(autor)},$,$,$,$,$,$)`);
    const organiz = w.add(`IFCORGANIZATION($,${ifcStr('Andina')},$,$,$)`);
    const persOrg = w.add(`IFCPERSONANDORGANIZATION(${persona},${organiz},$)`);
    const app = w.add(`IFCAPPLICATION(${organiz},${ifcStr('1.0')},${ifcStr('LukeAPP Dashboard')},${ifcStr('LUKEAPP')})`);
    const owner = w.add(`IFCOWNERHISTORY(${persOrg},${app},$,.ADDED.,$,$,$,${Math.floor(ahora.getTime() / 1000)})`);

    // --- Jerarquía espacial ---------------------------------------
    const plProj = w.add(`IFCLOCALPLACEMENT($,${ejeMundo})`);
    const proyecto = w.add(`IFCPROJECT(${ifcStr(ifcGuid())},${owner},${ifcStr(nombreProyecto)},$,$,$,$,(${ctx}),${unidades})`);
    const sitio = w.add(`IFCSITE(${ifcStr(ifcGuid())},${owner},${ifcStr('Sitio')},$,$,${plProj},$,$,.ELEMENT.,$,$,$,$,$)`);
    const plSitio = w.add(`IFCLOCALPLACEMENT(${plProj},${ejeMundo})`);
    const edificio = w.add(`IFCBUILDING(${ifcStr(ifcGuid())},${owner},${ifcStr('Planta')},$,$,${plSitio},$,$,.ELEMENT.,$,$,$)`);
    const plEdif = w.add(`IFCLOCALPLACEMENT(${plSitio},${ejeMundo})`);
    const piso = w.add(`IFCBUILDINGSTOREY(${ifcStr(ifcGuid())},${owner},${ifcStr('Trozos de cañería')},$,$,${plEdif},$,$,.ELEMENT.,${ifcNum(0)})`);
    const plPiso = w.add(`IFCLOCALPLACEMENT(${plEdif},${ejeMundo})`);

    w.add(`IFCRELAGGREGATES(${ifcStr(ifcGuid())},${owner},$,$,${proyecto},(${sitio}))`);
    w.add(`IFCRELAGGREGATES(${ifcStr(ifcGuid())},${owner},$,$,${sitio},(${edificio}))`);
    w.add(`IFCRELAGGREGATES(${ifcStr(ifcGuid())},${owner},$,$,${edificio},(${piso}))`);

    // --- Un IfcPipeSegment por trozo ------------------------------
    const elementos = [];
    trozos.forEach(t => {
        // Colocación: origen en el inicio del trozo, eje Z local sobre la dirección del tubo
        const loc = P(t.p.x, t.p.y, t.p.z);
        const axis = D(t.d.x, t.d.y, t.d.z);
        // RefDirection: cualquier vector unitario perpendicular al eje
        const ref = bimIfcPerpendicular(t.d);
        const refDir = D(ref.x, ref.y, ref.z);
        const colocacion = w.add(`IFCAXIS2PLACEMENT3D(${loc},${axis},${refDir})`);
        const placement = w.add(`IFCLOCALPLACEMENT(${plPiso},${colocacion})`);

        // Perfil circular extruido a lo largo del eje local Z
        const o2d = w.add(`IFCCARTESIANPOINT((${ifcNum(0)},${ifcNum(0)}))`);
        const ejePerfil = w.add(`IFCAXIS2PLACEMENT2D(${o2d},$)`);
        const perfil = w.add(`IFCCIRCLEPROFILEDEF(.AREA.,${ifcStr('D' + (t.radio * 2000).toFixed(0))},${ejePerfil},${ifcNum(t.radio)})`);
        const posSolido = w.add(`IFCAXIS2PLACEMENT3D(${origen},${dirZ},${dirX})`);
        const solido = w.add(`IFCEXTRUDEDAREASOLID(${perfil},${posSolido},${dirZ},${ifcNum(t.largo)})`);
        const shape = w.add(`IFCSHAPEREPRESENTATION(${subCtx},'Body','SweptSolid',(${solido}))`);
        const forma = w.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${shape}))`);

        const nombre = `${t.spool ? 'Spool ' + t.spool : 'Sin spool'} · Trozo ${t.idx}`;
        const desc = `Trozo virtual ${t.a.toFixed(3)}–${t.b.toFixed(3)} del elemento ${t.guidPadre}`;
        const el = w.add(`IFCPIPESEGMENT(${ifcStr(ifcGuid())},${owner},${ifcStr(nombre)},${ifcStr(desc)},$,${placement},${forma},${ifcStr(t.key)},$)`);
        elementos.push(el);

        // --- Property set ----------------------------------------
        const props = [
            ['Spool_TAG', t.spool, 'IFCLABEL'],
            ['Spool_ID', t.idSpool, 'IFCLABEL'],
            ['Estado', t.estado, 'IFCLABEL'],
            ['ISO', t.iso, 'IFCLABEL'],
            ['Fluido_Servicio', t.fluido, 'IFCLABEL'],
            ['Capa', t.capa, 'IFCLABEL'],
            ['Fecha_Ejecucion', t.fechaEjecucion, 'IFCLABEL'],
            ['Soldador', t.soldador, 'IFCLABEL'],
            ['GUID_Padre', t.guidPadre, 'IFCIDENTIFIER'],
            ['Trozo_Indice', t.idx, 'IFCINTEGER'],
            ['Largo_m', t.largo, 'IFCLENGTHMEASURE'],
            ['Diametro_mm', t.radio * 2000, 'IFCREAL'],
            ['Fraccion_Inicio', t.a, 'IFCREAL'],
            ['Fraccion_Fin', t.b, 'IFCREAL']
        ];
        const refsProp = props
            .filter(([, v]) => v !== '' && v !== null && v !== undefined)
            .map(([n, v, tipo]) => {
                const val = (tipo === 'IFCLABEL' || tipo === 'IFCIDENTIFIER' || tipo === 'IFCTEXT')
                    ? `${tipo}(${ifcStr(v)})`
                    : tipo === 'IFCINTEGER' ? `${tipo}(${Math.round(v)})` : `${tipo}(${ifcNum(v)})`;
                return w.add(`IFCPROPERTYSINGLEVALUE(${ifcStr(n)},$,${val},$)`);
            });
        const pset = w.add(`IFCPROPERTYSET(${ifcStr(ifcGuid())},${owner},${ifcStr('Pset_AndinaTrozo')},${ifcStr('Datos de gestión LukeAPP')},(${refsProp.join(',')}))`);
        w.add(`IFCRELDEFINESBYPROPERTIES(${ifcStr(ifcGuid())},${owner},$,$,(${el}),${pset})`);
    });

    if (elementos.length) {
        w.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${ifcStr(ifcGuid())},${owner},${ifcStr('Trozos')},$,(${elementos.join(',')}),${piso})`);
    }

    return `${header}\n${w.lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;\n`;
}

/** Vector unitario perpendicular a d (para el RefDirection del placement). */
function bimIfcPerpendicular(d) {
    const ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
    // Se elige el eje global menos alineado con d para evitar productos cruzados nulos
    let a = (ax <= ay && ax <= az) ? { x: 1, y: 0, z: 0 }
        : (ay <= az) ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
    const c = { x: a.y * d.z - a.z * d.y, y: a.z * d.x - a.x * d.z, z: a.x * d.y - a.y * d.x };
    const n = Math.hypot(c.x, c.y, c.z) || 1;
    return { x: c.x / n, y: c.y / n, z: c.z / n };
}

// ---------------------------------------------------------------
// 4. INTERFAZ: BOTÓN EN LA TOOLBAR + PANEL DE ALCANCE
// ---------------------------------------------------------------

/** Registra el botón de exportación en el grupo 'andina-tools' de la toolbar APS. */
function bimIfcInit(grupo) {
    try {
        if (!grupo || grupo.getControl('btn-exportar-ifc')) return;
        const btn = new Autodesk.Viewing.UI.Button('btn-exportar-ifc');
        btn.setToolTip('Exportar trozos a IFC');
        btn.icon.innerHTML = '<i class="fas fa-file-export" style="font-size:15px;line-height:24px;"></i>';
        btn.onClick = () => bimIfcAbrirPanel();
        grupo.addControl(btn);
    } catch (e) {
        console.error('[IFC] No se pudo crear el botón:', e.message);
    }
}

/** Panel lateral para elegir el alcance de la exportación. */
function bimIfcAbrirPanel() {
    const total = Object.keys(divState.trozoMeshes || {}).length;
    if (!total) {
        bimSetMeta('<div class="bim-meta-placeholder"><i class="fas fa-file-export bim-meta-icon"></i><p>Todavía no hay trozos guardados. Divide un tramo primero.</p></div>');
        return;
    }
    const visibles = Object.values(divState.trozoMeshes).filter(m => m.visible !== false).length;
    const spoolSet = new Set((bimState.currentGuids || []).map(g => String(g).toLowerCase()));
    const delSpool = Object.keys(divState.trozoMeshes).filter(k => spoolSet.has(k)).length;

    const boton = (alcance, icono, titulo, n, extra = '') => `
        <button class="bim-scan-btn" onclick="bimIfcExportar('${alcance}')" ${n ? '' : 'disabled'}
            style="justify-content:space-between;width:100%;${n ? '' : 'opacity:0.45;cursor:not-allowed;'}${extra}">
            <span><i class="fas ${icono}"></i> ${titulo}</span>
            <span class="bim-badge">${n}</span>
        </button>`;

    bimSetMeta(`
        <div class="bim-meta-header" style="background:rgba(99,102,241,0.15);border-color:rgba(99,102,241,0.35);">
            <i class="fas fa-file-export"></i><span>Exportar a IFC</span>
        </div>
        <p style="font-size:0.76rem;opacity:0.7;margin:8px 2px;">
            Cada trozo sale como <strong>IfcPipeSegment</strong> con su spool, estado, ISO, fluido,
            capa, largo, diámetro y datos de ejecución. Esquema IFC4, unidades en metros.</p>
        <div style="display:flex;flex-direction:column;gap:6px;">
            ${boton('todos', 'fa-layer-group', 'Todos los trozos', total, 'background:rgba(99,102,241,0.15);border-color:rgba(99,102,241,0.3);color:var(--primary-light);')}
            ${boton('visibles', 'fa-filter', 'Sólo los visibles (filtro)', visibles)}
            ${boton('spool', 'fa-crosshairs', 'Sólo el spool buscado', delSpool)}
        </div>
        <p id="ifc-status" style="font-size:0.76rem;opacity:0.75;margin-top:10px;"></p>`);
}

/** Genera y descarga el archivo. */
function bimIfcExportar(alcance) {
    const status = document.getElementById('ifc-status');
    const msg = (html) => { if (status) status.innerHTML = html; };
    msg('<i class="fas fa-spinner fa-spin"></i> Generando IFC…');

    // setTimeout: deja pintar el spinner antes del trabajo síncrono
    setTimeout(() => {
        try {
            const trozos = bimIfcRecolectar(alcance);
            if (!trozos.length) { msg('⚠️ No hay trozos en ese alcance.'); return; }

            const sello = new Date().toISOString().slice(0, 10);
            const archivo = `Trozos_Andina_${alcance}_${sello}.ifc`;
            const ifc = bimIfcGenerar(trozos, { archivo });

            const url = URL.createObjectURL(new Blob([ifc], { type: 'application/x-step' }));
            const a = document.createElement('a');
            a.href = url; a.download = archivo;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);

            const conSpool = trozos.filter(t => t.spool).length;
            msg(`✅ <strong>${trozos.length}</strong> trozos exportados (${conSpool} con spool asignado).<br>
                 <span style="opacity:0.7;">${archivo} · ${(ifc.length / 1024).toFixed(0)} KB</span>`);
            console.log('[IFC] Exportados', trozos.length, 'trozos →', archivo);
        } catch (e) {
            console.error('[IFC] Error exportando:', e);
            msg('❌ Error generando el IFC: ' + e.message);
        }
    }, 30);
}

// Exponer para Node (pruebas) sin romper el navegador
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { bimIfcGenerar, bimIfcPerpendicular, ifcGuid, ifcStr, ifcNum, IfcWriter };
}
