# Piping Control Dashboard (Andina PRY-413)

Este es un dashboard web para la visualización en tiempo real del piping y spools. Se conecta a la API de AppSheet (V2) para extraer los datos de control de juntas y pre-fabricación del proyecto Andina.
El repositorio oficial del código fuente se encuentra en: [https://github.com/Crisvalpo/andina](https://github.com/Crisvalpo/andina).

Actualmente, el proyecto está servido directamente desde el servidor Ubuntu (`lukeserver`) bajo el subdominio `andina.lukeapp.me`.

## 🚀 Plan de Actualización (Despliegue Manual al Servidor)

Aunque mantengas el respaldo y el historial de versiones en GitHub, tu servidor Ubuntu (nodo Andina) **no tiene configurado un webhook de auto-despliegue** (como sí lo tiene el bot `jAIme`). Por ende, cualquier modificación (HTML, JS, CSS) debe respaldarse en GitHub (idealmente) y luego transferirse manualmente a producción.

Sigue estos pasos para aplicar cualquier nueva actualización en vivo:

**1. Abre una terminal (PowerShell) en tu equipo local.**

**2. Ejecuta el siguiente comando SCP para copiar tus archivos:**
Este comando enviará el contenido de tu carpeta local `Dashboard` y sobreescribirá la carpeta pública (estática) que lee Express (`~/andina-dashboard/public/`) en el servidor remoto.

```powershell
scp -pr D:\Github\Andina\Dashboard\* luke-ssh:~/andina-dashboard/public/
```
*(Es posible que te solicite tu contraseña de SSH).*

**3. Visualiza los cambios:**
No necesitas reiniciar NodeJS ni PM2. Cloudflare y Express leerán automáticamente los nuevos estáticos. Solo vuelve a cargar `andina.lukeapp.me` con F5 (vacía caché si es necesario) para ver los cambios de estilo o lógica que hayas subido.

## ⚙️ Configuración del Cliente
Para cambiar de proyecto o recuperar la vinculación de datos (si borras cachés del navegador):
1.  Haz clic en el icono de configuración (⚙️) en la esquina inferior.
2.  Ingresa tu `AppID` y tu llave `AccessKey` de AppSheet.
3.  Haz clic en **Vincular Datos**. (*Tus credenciales permanecerán seguras en el almacenamiento local del dispositivo*).

## 📊 Orígenes de Datos (AppSheet APIREST)
El dashboard se alimenta actualmente de:
*   `REG_EjecucionJuntas_MS` / `REG_InspeccionVisual_MS`: Conteos de juntas cortadas, emplantilladas, ejecutadas y liberadas por END.
*   `LIST_Spools_MS`: Seguimiento del KPI de Fabricación y Despacho.
*   `LOG_SDI_MS`: Consultas Técnicas.

## 🛠️ Infraestructura de Red
*   **Host**: Ubuntu Server (`lukeserver`).
*   **Servicio Web**: Node.js v20 (Express) corriendo vía **PM2** (`andina-dashboard`, puerto `localhost:3005`).
*   **Túnel**: Cloudflare Zero Trust (`luke-home`).
