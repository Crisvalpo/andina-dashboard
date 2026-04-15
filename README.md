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

## 🔑 Gestión de Credenciales (AppSheet)
Actualmente, el `AppID` y la `AccessKey` de AppSheet están configurados de forma estática en el objeto `API` al inicio de `app.js`.

Para cambiar de proyecto o actualizar las llaves:
1.  Abre `app.js`.
2.  Modifica los valores de `appId` y `appKey`.
3.  Guarda y haz `git push` para desplegar el cambio.

## 📊 Orígenes de Datos (AppSheet APIREST)
El dashboard se alimenta actualmente de:
*   `REG_EjecucionJuntas_MS` / `REG_InspeccionVisual_MS`: Conteos de juntas emplantilladas, ejecutadas y liberadas.
*   `LIST_Spools_MS`: Seguimiento del KPI de Fabricación y Despacho.
*   `CAT_FluidoServicio_MS`: Catálogo dinámico de fluidos.
*   `CAT_TipoUnion_MS`: Desglose de juntas Taller vs Terreno.
