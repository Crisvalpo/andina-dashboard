# Piping Control Dashboard (Andina PRY-413)

Este es un dashboard web para la visualización en tiempo real del piping y spools. Se conecta a la API de AppSheet (V2) para extraer los datos de control de juntas y pre-fabricación del proyecto Andina.

## 🔄 Flujo de Automatización (Push-to-Deploy)

El proyecto cuenta con un flujo de **CI/CD totalmente automatizado**. Ya no es necesario usar `scp` para subir archivos manualmente al servidor.

Sigue estos pasos para aplicar cualquier nueva actualización en vivo:

1.  **Edita localmente**: Realiza tus cambios en esta carpeta (`D:\Github\Andina\Dashboard`).
2.  **Sincroniza con Git**:
    ```powershell
    git add .
    git commit -m "Descripción de los cambios"
    git push origin main
    ```
3.  **Despliegue Automático**: GitHub notificará al servidor (`lukeserver`), el cual ejecutará el script de despliegue, actualizará el código y reiniciará el servicio PM2 automáticamente.

---

## 🛠️ Arquitectura del Proyecto

### Servidor (Ubuntu `lukeserver`)
*   **Proceso PM2**: `andina-dashboard` (ID: 3).
*   **Ruta**: `/home/cristian/andina-dashboard`.
*   **Entry Point**: `index.js` (Express Server).
*   **Puerto**: `3005` (interno).

### Desarrollo Local
*   **Repositorio**: `https://github.com/Crisvalpo/andina-dashboard`
*   **Estructura**: Los archivos estáticos (`app.js`, `index.html`, `style.css`) viven ahora en el root de la carpeta `Dashboard`.

---

## 🔑 Gestión de Credenciales y Seguridad (AppSheet)
Las credenciales de AppSheet (`appId` y `accessKey`) se configuran y protegen de forma exclusiva en el backend del servidor (`index.js`). **Nunca** deben agregarse al archivo del frontend `app.js` para evitar la exposición pública de llaves en el navegador.

Para cambiar las credenciales o el proyecto:
1. Abre `index.js`.
2. Modifica los valores en `APPSHEET_CONFIG`.
3. Guarda y haz `git push` para desplegar el cambio de manera automática.

## ⚡ Capa de Caché y Proxy
El backend en `index.js` expone un proxy en `/api/data/:tableName` con una **caché en memoria de 30 segundos**.
- Las llamadas desde el cliente a `fetchTable('NOMBRE_TABLA')` se redirigen localmente a `/api/data/NOMBRE_TABLA`.
- Si el servidor Express tiene los datos cargados en el último intervalo de 30 segundos, los sirve directamente desde caché, acelerando las cargas de página subsecuentes a milisegundos y reduciendo el consumo de cuota de la API de AppSheet.

## 📊 Orígenes de Datos (AppSheet APIREST)
El dashboard se alimenta actualmente de los siguientes modelos de AppSheet:
*   `LIST_Lineas_MS` / `LIST_Iso_MS`: Catálogo maestro de líneas e isométricos.
*   `LIST_Juntas_MS` / `REG_EjecucionJuntas_MS`: Control del total de juntas y su avance físico (Corte, Emplantillado, Ejecución).
*   `LIST_Spools_MS` / `REG_DimensionalSpool_MS` / `REG_InspeccionVisual_MS`: Trazabilidad física de spools, control dimensional y calidad (VT/NDE).
*   `CAT_FluidoServicio_MS` / `CAT_TipoUnion_MS`: Catálogos dinámicos auxiliares de fluidos y uniones.
*   `CAT_Personal_MS`: Catálogo de personal del proyecto.
*   `LOG_SDI_MS` / `REL_SDIIso_MS`: Listado de consultas técnicas (RFI) e isométricos relacionados.

---

## 🎙️ LUKE REALTIME — Piloto Spool (OpenAI WebRTC)

`andina-dashboard` incluye una interfaz de voz continua basada en **GPT Realtime WebRTC** (`/realtime`), diseñada para que trabajadores en terreno puedan interactuar por voz con el asistente Luke para consultar la información en tiempo real de los spools.

### Configuración
1. En el archivo `.env`, añadir la API Key de OpenAI con permisos para la API Realtime:
   ```env
   OPENAI_API_KEY=sk-proj-...
   OPENAI_REALTIME_MODEL=gpt-4o-mini-realtime-preview
   OPENAI_REALTIME_VOICE=ash
   ```
2. Acceder desde un navegador móvil a `http://localhost:3005/realtime` (o el dominio público).
3. Presionar el botón 🎙️ **HABLA CON LUKE**, otorgar permiso de micrófono y comenzar a preguntar por voz (ejemplo: *"Luke, háblame del spool 245"*).

