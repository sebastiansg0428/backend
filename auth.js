const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('./db');
const limitesLogin = require('./limites-login');

const scrypt = promisify(crypto.scrypt);
const ROLES = new Set(['administrador', 'ventanilla', 'funcionario']);
const sesiones = new Map();
const DURACION_SESION = 8 * 60 * 60 * 1000;
const COSTO_BCRYPT = 12;
const POLITICA_PASSWORD = 'Minimo 10 caracteres, una mayuscula, una minuscula, un numero y un simbolo; maximo 72 bytes UTF-8.';

function errorHTTP(res, status, message) {
    return res.status(status).json({ success: false, message });
}

function configuracionUsuarioValida(usuario) {
    return ROLES.has(usuario.rol) &&
        (usuario.rol === 'funcionario'
            ? Number.isInteger(usuario.dependencia_id) && usuario.dependencia_id > 0
            : usuario.dependencia_id === null);
}

async function hashPassword(password) {
    if (!passwordValido(password)) throw new Error(POLITICA_PASSWORD);
    return bcrypt.hash(password, COSTO_BCRYPT);
}

async function verificarPassword(password, guardado) {
    if (typeof password !== 'string' || typeof guardado !== 'string') return false;
    if (/^\$2[ab]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(guardado)) {
        if (Buffer.byteLength(password, 'utf8') > 72 || password.includes('\0')) return false;
        return bcrypt.compare(password, guardado);
    }
    if (typeof guardado !== 'string' ||
        !/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(guardado)) {
        return false;
    }
    const [, sal, hash] = guardado.split(':');
    const calculado = await scrypt(password, sal, 64);
    return crypto.timingSafeEqual(calculado, Buffer.from(hash, 'hex'));
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function crearSesion(usuarioId) {
    const ahora = Date.now();
    for (const [clave, sesion] of sesiones) {
        if (sesion.expira <= ahora) sesiones.delete(clave);
    }
    const token = crypto.randomBytes(32).toString('hex');
    sesiones.set(hashToken(token), { usuarioId, expira: ahora + DURACION_SESION });
    return token;
}

function revocarSesiones(usuarioId) {
    for (const [clave, sesion] of sesiones) {
        if (sesion.usuarioId === usuarioId) sesiones.delete(clave);
    }
}

async function autenticar(req, res, next) {
    const coincidencia = /^Bearer ([a-f0-9]{64})$/.exec(req.get('authorization') || '');
    const clave = coincidencia ? hashToken(coincidencia[1]) : null;
    const sesion = clave ? sesiones.get(clave) : null;
    if (!sesion || sesion.expira <= Date.now()) {
        if (clave) sesiones.delete(clave);
        return errorHTTP(res, 401, 'Inicia sesion nuevamente; el token falta, es invalido o expiro.');
    }
    try {
        const [rows] = await pool.execute(
            `SELECT u.id, u.nombre, u.email, u.rol, u.dependencia_id, u.activo,
                    d.nombre AS dependencia_nombre
             FROM usuarios u
             LEFT JOIN dependencias d ON d.id = u.dependencia_id
             WHERE u.id = ?`,
            [sesion.usuarioId]
        );
        if (rows[0] && rows[0].activo !== 1) {
            revocarSesiones(rows[0].id);
            return errorHTTP(res, 403, 'La cuenta esta inactiva. Contacta al administrador.');
        }
        if (!rows[0] || !configuracionUsuarioValida(rows[0]) ||
            (rows[0].rol === 'funcionario' && !rows[0].dependencia_nombre)) {
            sesiones.delete(clave);
            return errorHTTP(res, 403, 'El usuario no tiene una asignacion de rol y dependencia valida.');
        }
        req.usuario = rows[0];
        req.claveSesion = clave;
        return next();
    } catch (error) {
        return next(error);
    }
}

function permitirRoles(...roles) {
    return (req, res, next) => {
        if (!req.usuario || !roles.includes(req.usuario.rol)) {
            return errorHTTP(res, 403, 'Tu rol no permite realizar esta accion.');
        }
        return next();
    };
}

function filtroDependencia(usuario, alias = 'r') {
    if (!configuracionUsuarioValida(usuario)) {
        throw new Error('No se puede consultar sin un usuario y una dependencia validos.');
    }
    return usuario.rol === 'funcionario'
        ? {
            sql: `(${alias}.dependencia_destino_id = ? OR EXISTS (
                SELECT 1 FROM radicado_dependencias rdx
                WHERE rdx.numero_radicado = ${alias}.numero_radicado
                  AND rdx.dependencia_id = ?
            ))`,
            valores: [usuario.dependencia_id, usuario.dependencia_id]
        }
        : { sql: '1 = 1', valores: [] };
}

async function autorizarRadicado(req, res, next) {
    try {
        const filtro = filtroDependencia(req.usuario);
        const [rows] = await pool.execute(
            `SELECT r.id FROM radicados r WHERE r.numero_radicado = ? AND ${filtro.sql} LIMIT 1`,
            [req.params.numero_radicado, ...filtro.valores]
        );
        if (!rows.length) {
            return errorHTTP(res, 404, 'Radicado no encontrado o fuera de tu dependencia.');
        }
        return next();
    } catch (error) {
        return next(error);
    }
}

function datosUsuario(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (body.dependencia_id !== undefined && body.dependencia_id !== null &&
        typeof body.dependencia_id !== 'number' && typeof body.dependencia_id !== 'string') {
        return null;
    }
    const nombre = typeof body.nombre === 'string' ? body.nombre.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const dependenciaId = body.dependencia_id === null || body.dependencia_id === undefined
        ? null : Number(body.dependencia_id);
    const usuario = { nombre, email, rol: body.rol, dependencia_id: dependenciaId };
    if (!nombre || nombre.length > 150 || email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !configuracionUsuarioValida(usuario)) {
        return null;
    }
    return usuario;
}

function passwordValido(password) {
    return typeof password === 'string' && Array.from(password).length >= 10 &&
        Buffer.byteLength(password, 'utf8') <= 72 && !password.includes('\0') &&
        /\p{Lu}/u.test(password) && /\p{Ll}/u.test(password) &&
        /[0-9]/.test(password) && /[^\p{L}\p{N}\s]/u.test(password);
}

const router = express.Router();

router.post('/auth/login', async (req, res, next) => {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || !email.trim() || email.length > 254 ||
        typeof password !== 'string' || password.length > 128) {
        return errorHTTP(res, 400, 'Indica email y password validos.');
    }
    try {
        let reserva;
        try {
            reserva = await limitesLogin.reservarIntento(email, req.ip);
        } catch (error) {
            console.error('No se pudo aplicar el limite compartido de login:', error);
            return errorHTTP(res, 503, 'Inicio de sesion temporalmente no disponible. Intenta mas tarde.');
        }
        if (!reserva.permitido) {
            res.set('Retry-After', String(reserva.reintentarEn));
            return errorHTTP(res, 429, 'Demasiados intentos. Espera antes de reintentar.');
        }
        const [rows] = await pool.execute(
            `SELECT u.*, d.nombre AS dependencia_nombre
             FROM usuarios u LEFT JOIN dependencias d ON d.id = u.dependencia_id
             WHERE u.email = ? LIMIT 1`,
            [email.trim().toLowerCase()]
        );
        const usuario = rows[0];
        if (!usuario || !await verificarPassword(password, usuario.password)) {
            return errorHTTP(res, 401, 'Credenciales incorrectas.');
        }
        if (usuario.activo !== 1) {
            revocarSesiones(usuario.id);
            return errorHTTP(res, 403, 'La cuenta esta inactiva. Contacta al administrador.');
        }
        if (!configuracionUsuarioValida(usuario)) {
            return errorHTTP(res, 403, 'El usuario tiene una configuracion de rol o dependencia invalida.');
        }
        if (usuario.password.startsWith('scrypt:') &&
            Buffer.byteLength(password, 'utf8') <= 72 && !password.includes('\0')) {
            const nuevoHash = await bcrypt.hash(password, COSTO_BCRYPT);
            const [actualizacion] = await pool.execute(
                'UPDATE usuarios SET password = ? WHERE id = ? AND password = ? AND activo = 1',
                [nuevoHash, usuario.id, usuario.password]
            );
            if (!actualizacion.affectedRows) {
                return errorHTTP(res, 409, 'La cuenta cambio durante el login. Inicia sesion nuevamente.');
            }
        }
        const { password: hash, ...publico } = usuario;
        return res.json({ success: true, token: crearSesion(usuario.id), usuario: publico });
    } catch (error) {
        return next(error);
    }
});

router.get('/auth/me', autenticar, (req, res) => {
    res.json({ success: true, usuario: req.usuario });
});

router.post('/auth/logout', autenticar, (req, res) => {
    sesiones.delete(req.claveSesion);
    res.json({ success: true, message: 'Sesion cerrada.' });
});

router.get('/dependencias', autenticar, async (req, res, next) => {
    const incluirInactivos = req.query.incluir_inactivos;
    if (incluirInactivos !== undefined && incluirInactivos !== '0' && incluirInactivos !== '1') {
        return errorHTTP(res, 400, 'incluir_inactivos debe ser 0 o 1.');
    }
    if (incluirInactivos === '1' && req.usuario.rol !== 'administrador') {
        return errorHTTP(res, 403, 'Solo el administrador puede consultar el catalogo completo.');
    }
    try {
        const [rows] = await pool.execute(
            `SELECT id, nombre, activo FROM dependencias
             WHERE (? IS NULL OR id = ?)
               AND (activo = 1 OR ? = 1) ORDER BY nombre`,
            req.usuario.rol === 'funcionario'
                ? [req.usuario.dependencia_id, req.usuario.dependencia_id, 1]
                : [null, null, incluirInactivos === '1' ? 1 : 0]
        );
        res.json({ success: true, dependencias: rows });
    } catch (error) { next(error); }
});

router.post('/dependencias', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    const nombre = typeof req.body?.nombre === 'string' ? req.body.nombre.trim() : '';
    if (!nombre || nombre.length > 150) {
        return errorHTTP(res, 400, 'El nombre de la dependencia es obligatorio (maximo 150 caracteres).');
    }
    try {
        const [result] = await pool.execute('INSERT INTO dependencias (nombre) VALUES (?)', [nombre]);
        await pool.execute(
            `INSERT IGNORE INTO radicado_dependencias (numero_radicado, dependencia_id)
             SELECT numero_radicado, ? FROM radicados WHERE destino_todas_dependencias = 1`,
            [result.insertId]
        );
        res.status(201).json({ success: true, dependencia: { id: result.insertId, nombre, activo: 1 } });
    } catch (error) { next(error); }
});

router.get('/dependencias/:id', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
        return errorHTTP(res, 400, 'ID de dependencia invalido.');
    }
    try {
        const [rows] = await pool.execute('SELECT id, nombre, activo FROM dependencias WHERE id = ?', [id]);
        if (!rows.length) return errorHTTP(res, 404, 'Dependencia no encontrada.');
        res.json({ success: true, dependencia: rows[0] });
    } catch (error) { next(error); }
});

router.put('/dependencias/:id', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    const id = Number(req.params.id);
    const nombre = typeof req.body?.nombre === 'string' ? req.body.nombre.trim() : '';
    if (!Number.isSafeInteger(id) || id < 1 || !nombre || nombre.length > 150 ||
        req.body?.activo !== undefined) {
        return errorHTTP(res, 400, 'Indica un ID valido y un nombre de 1 a 150 caracteres.');
    }
    try {
        const [result] = await pool.execute('UPDATE dependencias SET nombre = ? WHERE id = ?', [nombre, id]);
        if (!result.affectedRows) return errorHTTP(res, 404, 'Dependencia no encontrada.');
        res.json({ success: true, dependencia: { id, nombre }, message: 'Dependencia actualizada.' });
    } catch (error) { next(error); }
});

router.patch('/dependencias/:id/estado', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    const id = Number(req.params.id);
    const activo = req.body?.activo;
    if (!Number.isSafeInteger(id) || id < 1 || (activo !== 0 && activo !== 1)) {
        return errorHTTP(res, 400, 'Indica un ID valido y activo como 0 o 1.');
    }
    try {
        const [result] = await pool.execute('UPDATE dependencias SET activo = ? WHERE id = ?', [activo, id]);
        if (!result.affectedRows) return errorHTTP(res, 404, 'Dependencia no encontrada.');
        if (activo === 1) {
            await pool.execute(
                `INSERT IGNORE INTO radicado_dependencias (numero_radicado, dependencia_id)
                 SELECT numero_radicado, ? FROM radicados WHERE destino_todas_dependencias = 1`,
                [id]
            );
        }
        res.json({
            success: true, dependencia: { id, activo },
            message: activo === 1 ? 'Dependencia activada.' : 'Dependencia inactivada.'
        });
    } catch (error) { next(error); }
});

router.get('/usuarios/ventanilla', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    try {
        const [rows] = await pool.execute(
            "SELECT id, nombre FROM usuarios WHERE rol = 'ventanilla' AND activo = 1 ORDER BY nombre"
        );
        res.json({ success: true, usuarios: rows });
    } catch (error) { next(error); }
});

router.get('/usuarios', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    try {
        const [rows] = await pool.query('SELECT id, nombre, email, rol, dependencia_id, activo FROM usuarios ORDER BY nombre');
        res.json({ success: true, usuarios: rows });
    } catch (error) { next(error); }
});

router.get('/usuarios/:id', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
        return errorHTTP(res, 400, 'ID de usuario invalido.');
    }
    try {
        const [rows] = await pool.execute(
            'SELECT id, nombre, email, rol, dependencia_id, activo FROM usuarios WHERE id = ?',
            [id]
        );
        if (!rows.length) return errorHTTP(res, 404, 'Usuario no encontrado.');
        res.json({ success: true, usuario: rows[0] });
    } catch (error) { next(error); }
});

router.post('/usuarios', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    const usuario = datosUsuario(req.body);
    if (!usuario || !passwordValido(req.body.password)) {
        return errorHTTP(res, 400, `Datos invalidos. ${POLITICA_PASSWORD} Funcionario requiere dependencia; los otros roles, NULL.`);
    }
    try {
        const password = await hashPassword(req.body.password);
        const [result] = await pool.execute(
            'INSERT INTO usuarios (nombre, email, password, rol, dependencia_id) VALUES (?, ?, ?, ?, ?)',
            [usuario.nombre, usuario.email, password, usuario.rol, usuario.dependencia_id]
        );
        res.status(201).json({ success: true, usuario: { id: result.insertId, ...usuario, activo: 1 } });
    } catch (error) { next(error); }
});

router.put('/usuarios/:id', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    const id = Number(req.params.id);
    const usuario = datosUsuario(req.body);
    if (!Number.isSafeInteger(id) || id < 1 || !usuario ||
        (req.body.password !== undefined && !passwordValido(req.body.password))) {
        return errorHTTP(res, 400, `Datos de usuario invalidos. ${POLITICA_PASSWORD}`);
    }
    if (id === req.usuario.id && usuario.rol !== 'administrador') {
        return errorHTTP(res, 409, 'No puedes quitarte tu propio rol de administrador.');
    }
    try {
        const password = req.body.password === undefined ? null : await hashPassword(req.body.password);
        const [result] = await pool.execute(
            `UPDATE usuarios SET nombre = ?, email = ?, rol = ?, dependencia_id = ?,
                password = COALESCE(?, password) WHERE id = ?`,
            [usuario.nombre, usuario.email, usuario.rol, usuario.dependencia_id, password, id]
        );
        if (!result.affectedRows) return errorHTTP(res, 404, 'Usuario no encontrado.');
        revocarSesiones(id);
        res.json({ success: true, usuario: { id, ...usuario }, message: 'Usuario actualizado; sus sesiones se revocaron.' });
    } catch (error) { next(error); }
});

router.patch('/usuarios/:id/estado', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    const id = Number(req.params.id);
    const activo = req.body?.activo;
    if (!Number.isSafeInteger(id) || id < 1 || (activo !== 0 && activo !== 1)) {
        return errorHTTP(res, 400, 'Indica un ID valido y activo como 0 o 1.');
    }
    if (id === req.usuario.id && activo === 0) {
        return errorHTTP(res, 409, 'No puedes inactivar tu propia cuenta de administrador.');
    }
    try {
        const [result] = await pool.execute('UPDATE usuarios SET activo = ? WHERE id = ?', [activo, id]);
        if (!result.affectedRows) return errorHTTP(res, 404, 'Usuario no encontrado.');
        revocarSesiones(id);
        res.json({
            success: true, usuario: { id, activo },
            message: activo === 1
                ? 'Usuario activado; debe iniciar sesion nuevamente.'
                : 'Usuario inactivado; sus sesiones se revocaron.'
        });
    } catch (error) { next(error); }
});

module.exports = {
    router, autenticar, permitirRoles, filtroDependencia, autorizarRadicado,
    hashPassword, verificarPassword, passwordValido, POLITICA_PASSWORD,
    crearSesion, revocarSesiones, datosUsuario
};
