const express = require('express');
const path = require('path');
const app = express();
const PORT = 3005;

// Configuración API AppSheet
const APPSHEET_CONFIG = {
    appId: 'eb4713b6-0828-4993-b5e1-935eec83cf4e',
    accessKey: 'V2-b9qXt-SY9es-eDDQb-L2lXN-NIInJ-U0DvZ-5fa2N-4huez'
};

app.use(express.static(__dirname));

/**
 * Función genérica para consultar AppSheet
 */
async function fetchAppSheet(tableName, action = "Find", rows = []) {
    const url = `https://api.appsheet.com/api/v2/apps/${APPSHEET_CONFIG.appId}/tables/${tableName}/Action`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'ApplicationAccessKey': APPSHEET_CONFIG.accessKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            Action: action,
            Properties: { Locale: "es-ES" },
            Rows: rows
        })
    });
    if (!response.ok) throw new Error(`AppSheet Error: ${response.status}`);
    return await response.json();
}

// API Proxy para datos de la Guía
app.get('/api/guia/:id', async (req, res) => {
    const guiaId = req.params.id;
    try {
        // 1. Obtener datos de la guía
        const guias = await fetchAppSheet('LOG_Guia_MS');
        const guia = guias.find(g => String(g.ID_GUIA) === guiaId || String(g.NUM_GUIA) === guiaId);

        if (!guia) return res.status(404).json({ error: "Guía no encontrada" });

        // 2. Obtener spools vinculados (de la tabla logística)
        const eventos = await fetchAppSheet('REG_Logistica_Spool_MS');
        const spoolsEnGuia = eventos.filter(e => String(e.ID_GUIA) === String(guia.ID_GUIA));

        // 3. Obtener detalles técnicos de los spools (NPS, Peso)
        const maestroSpools = await fetchAppSheet('LIST_Spools_MS');

        const spoolsDetallados = spoolsEnGuia.map(e => {
            const master = maestroSpools.find(m => m.ID_SPOOL === e.ID_SPOOL) || {};
            return {
                ...e,
                TAG_SPOOL: master.TAG_SPOOL || e.TAG_SPOOL,
                DIAMETRO: master.DIAMETRO || master.MAX_NPS_SPOOL,
                PESO_KG: master.PESO_KG
            };
        });

        res.json({ guia, spools: spoolsDetallados });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Ruta visual de la Guía
app.get('/guia/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'guia.html'));
});

// SPA fallback (Dashboard principal)
app.get('*', (req, res) => {
    if (path.extname(req.url)) return res.sendStatus(404);
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Andina Dashboard running on http://localhost:${PORT}`);
});
