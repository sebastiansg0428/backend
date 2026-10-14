const cors = require('cors');

function crearMiddlewareCors(env = process.env) {
    const configurados = env.CORS_ALLOWED_ORIGINS;
    if (env.NODE_ENV === 'production' && !configurados?.trim()) {
        throw new Error('Configura CORS_ALLOWED_ORIGINS antes de iniciar en produccion.');
    }
    const origenes = configurados === undefined
        ? ['http://localhost:5173', 'http://127.0.0.1:5173']
        : configurados.split(',').map(origen => origen.trim());
    for (const origen of origenes) {
        let url;
        try {
            url = new URL(origen);
        } catch {
            throw new Error('CORS_ALLOWED_ORIGINS debe contener origenes HTTP/HTTPS validos separados por comas.');
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origen ||
            url.username || url.password) {
            throw new Error('CORS_ALLOWED_ORIGINS no admite comodines, rutas, credenciales ni origenes no canonicos.');
        }
    }
    const permitidos = new Set(origenes);
    const middleware = cors({
        origin: (origen, callback) => callback(null, origen ? permitidos.has(origen) : false),
        exposedHeaders: ['Retry-After']
    });
    return (req, res, next) => {
        const origen = req.get('Origin');
        if (origen !== undefined && !permitidos.has(origen)) {
            console.warn('Solicitud rechazada por origen CORS no autorizado:', JSON.stringify(origen));
            return res.status(403).json({ success: false, message: 'Origen no autorizado.' });
        }
        return middleware(req, res, next);
    };
}

module.exports = crearMiddlewareCors;
