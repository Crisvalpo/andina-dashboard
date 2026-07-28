/**
 * Chart.js Label Plugins — Andina Piping Dashboard
 *
 * Dibujan el valor de cada dato encima de su barra, porción o punto.
 * Son puros: solo usan la API de Chart.js que llega por argumento, así que
 * no importan nada y pueden usarse desde cualquier componente.
 */

// Plugins globales para mostrar etiquetas en los gráficos
export const barLabelsPlugin = {
    id: 'barLabels',
    afterDatasetsDraw(chart) {
        const { ctx } = chart;
        ctx.save();
        ctx.font = 'bold 10px Outfit, sans-serif';
        ctx.fillStyle = '#cbd5e1';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        const isStacked = chart.options.scales?.y?.stacked || chart.options.scales?.x?.stacked;

        if (isStacked) {
            // Para gráficos apilados, dibujamos una sola etiqueta en la parte superior de la pila
            const datasets = chart.data.datasets;
            if (datasets.length >= 2) {
                const metaLast = chart.getDatasetMeta(datasets.length - 1);
                metaLast.data.forEach((bar, index) => {
                    const montados = datasets[0].data[index] || 0;
                    const pendientes = datasets[1].data[index] || 0;
                    const total = montados + pendientes;

                    if (total === 0) return;

                    // Formato: "Montados/Total"
                    const displayVal = `${montados}/${total}`;
                    const xPos = bar.x;
                    const yPos = bar.y - 4; // 4px arriba de la barra total

                    ctx.fillText(displayVal, xPos, yPos);
                });
            }
        } else {
            // Comportamiento original para gráficos no apilados
            chart.data.datasets.forEach((dataset, datasetIndex) => {
                const meta = chart.getDatasetMeta(datasetIndex);
                meta.data.forEach((bar, index) => {
                    const val = dataset.data[index];
                    if (val === 0 || val === null || val === undefined) return;

                    const displayVal = typeof val === 'number' ? val.toLocaleString('es-CL', { maximumFractionDigits: 1 }) : val;
                    const xPos = bar.x;
                    const yPos = bar.y - 4; // 4px arriba de la barra

                    ctx.fillText(displayVal, xPos, yPos);
                });
            });
        }
        ctx.restore();
    }
};

export const doughnutLabelsPlugin = {
    id: 'doughnutLabels',
    afterDatasetsDraw(chart) {
        const { ctx, data } = chart;
        ctx.save();
        ctx.font = 'bold 11px Outfit, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        chart.getDatasetMeta(0).data.forEach((slice, index) => {
            const val = data.datasets[0].data[index];
            if (val === 0 || val === null || val === undefined) return;

            const pos = typeof slice.tooltipPosition === 'function' ? slice.tooltipPosition() : null;
            if (pos) {
                ctx.fillText(val, pos.x, pos.y);
            }
        });
        ctx.restore();
    }
};

export const lineLabelsPlugin = {
    id: 'lineLabels',
    afterDatasetsDraw(chart) {
        const { ctx, data } = chart;
        ctx.save();
        ctx.font = 'bold 10px Outfit, sans-serif';
        ctx.fillStyle = '#cbd5e1';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        chart.getDatasetMeta(0).data.forEach((point, index) => {
            const val = data.datasets[0].data[index];
            if (val === null || val === undefined) return;

            const xPos = point.x;
            const yPos = point.y - 6; // 6px arriba del punto
            ctx.fillText(val, xPos, yPos);
        });
        ctx.restore();
    }
};
