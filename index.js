const express = require('express');
const path = require('path');
const app = express();
const PORT = 3005;

// Middleware para capturar TODAS las peticiones y servir index.html
app.use((req, res, next) => {
    // Si es una petición a un archivo (tiene extensión), dejar que express.static lo maneje
    if (path.extname(req.url)) return next();
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Servir archivos estáticos
app.use(express.static(__dirname));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Andina Dashboard running on http://localhost:${PORT}`);
});
