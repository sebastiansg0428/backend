const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');

function validarClave(req, res, next) {
    const clave = req.get('Idempotency-Key');
    if (clave === undefined) return next();
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(clave)) {
        return res.status(400).json({ success: false, message: 'Idempotency-Key debe ser un UUID v4 valido.' });
    }
    req.claveRadicacion = clave.toLowerCase();
    return next();
}

async function huellaSolicitud(req) {
    const campos = Object.keys(req.body).sort().map(campo => [campo, req.body[campo]]);
    const archivos = [];
    for (const archivo of req.files || []) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(archivo.path)) hash.update(chunk);
        archivos.push({ nombre: archivo.originalname, tipo: archivo.mimetype,
            tamano: archivo.size, hash: hash.digest('hex') });
    }
    return createHash('sha256').update(JSON.stringify({ campos, archivos })).digest('hex');
}

async function buscarIntento(connection, req, huella, bloquear = false) {
    const [rows] = await connection.execute(
        `SELECT huella, respuesta_json FROM intentos_radicacion
         WHERE actor_id = ? AND clave = ?${bloquear ? ' FOR UPDATE' : ''}`,
        [req.usuario.id, req.claveRadicacion]);
    if (!rows.length) return null;
    if (rows[0].huella !== huella) {
        const error = new Error('La clave del intento ya corresponde a otros datos o PDFs. Resuelve el intento original antes de crear otro.');
        error.status = 409;
        throw error;
    }
    if (rows[0].respuesta_json === null) return null;
    const respuesta = JSON.parse(rows[0].respuesta_json);
    if (respuesta.success !== true || typeof respuesta.radicado !== 'string') {
        throw new Error('El resultado persistente del intento no tiene un formato valido.');
    }
    return respuesta;
}

async function reservarIntento(connection, req, huella) {
    await connection.execute(
        `INSERT INTO intentos_radicacion(actor_id, clave, huella)
         VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE clave = VALUES(clave)`,
        [req.usuario.id, req.claveRadicacion, huella]);
    return buscarIntento(connection, req, huella, true);
}

async function confirmarIntento(connection, req, respuesta) {
    const [result] = await connection.execute(
        `UPDATE intentos_radicacion SET numero_radicado = ?, respuesta_json = ?
         WHERE actor_id = ? AND clave = ? AND respuesta_json IS NULL`,
        [respuesta.radicado, JSON.stringify(respuesta), req.usuario.id, req.claveRadicacion]);
    if (result.affectedRows !== 1) throw new Error('No se pudo confirmar atomicamente el intento de radicacion.');
}

module.exports = { validarClave, huellaSolicitud, buscarIntento, reservarIntento, confirmarIntento };
