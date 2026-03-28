# Piping Control Dashboard (Andina)

Este es un sub-proyecto de visualización web diseñado para ejecutarse como una **GitHub Page**. Se conecta en tiempo real a la API de AppSheet (V2) para extraer los datos de control de juntas y fabricación de spools.

## 🚀 Despliegue Rápido
1.  Sube la carpeta `Dashboard/` a tu repositorio de GitHub.
2.  Activa **GitHub Pages** en la configuración del repo.
3.  Abre la URL generada.

## ⚙️ Configuración
Para visualizar tus datos reales:
1.  Haz clic en el icono de engranaje (configuración) en la esquina inferior derecha.
2.  Ingresa tu `AppID` y tu `AppSheet-App-Key`.
3.  Haz clic en **Vincular Datos**.

*Nota: Tus credenciales se guardan localmente en el `localStorage` de tu navegador por seguridad.*

## 📊 Orígenes de Datos
El dashboard consulta actualmente:
*   `LIST_Juntas_MS`: Conteos de ejecución y avance por sistema.
*   `LIST_Spools_MS`: Seguimiento de fabricación.
*   `LOG_SDI_MS`: Consultas técnicas de ingeniería.

## 🛠️ Tecnologías
*   **Frontend**: HTML5, CSS3 (Glassmorphism), Vanilla JS.
*   **Gráficos**: [Chart.js](https://www.chartjs.org/).
*   **API**: AppSheet V2 REST API.
