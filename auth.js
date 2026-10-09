const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const pool = require('./db');

const scrypt = promisify(crypto.scrypt);
const ROLES = new Set(['administrador', 'ventanilla', 'funcionario']);
const sesiones = new Map();
const intentosLogin = new Map();
const DURACION_SESION = 8 * 60 * 60 * 1000;

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
    const sal = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(password, sal, 64);
    return `scrypt:${sal}:${hash.toString('hex')}`;
}

async function verificarPassword(password, guardado) {
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
            `SELECT u.id, u.nombre, u.email, u.rol, u.dependencia_id,
                    d.nombre AS dependencia_nombre
             FROM usuarios u
             LEFT JOIN dependencias d ON d.id = u.dependencia_id
             WHERE u.id = ?`,
            [sesion.usuarioId]
        );
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
        ? { sql: `${alias}.dependencia_destino_id = ?`, valores: [usuario.dependencia_id] }
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
    return typeof password === 'string' && password.length >= 10 && password.length <= 128;
}

const router = express.Router();

router.post('/auth/login', async (req, res, next) => {
    const { email, password } = req.body;
    if (typeof email !== 'string' || email.length > 254 ||
        typeof password !== 'string' || password.length > 128) {
        return errorHTTP(res, 400, 'Indica email y password validos.');
    }
    const ahora = Date.now();
    for (const [ip, intento] of intentosLogin) {
        if (intento.expira <= ahora) intentosLogin.delete(ip);
    }
    const intento = intentosLogin.get(req.ip) || { cantidad: 0, expira: ahora + 15 * 60 * 1000 };
    if (intento.cantidad >= 10) {
        return errorHTTP(res, 429, 'Demasiados intentos. Espera 15 minutos antes de reintentar.');
    }
    intento.cantidad++;
    intentosLogin.set(req.ip, intento);
    try {
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
        if (!configuracionUsuarioValida(usuario)) {
            return errorHTTP(res, 403, 'El usuario tiene una configuracion de rol o dependencia invalida.');
        }
        intentosLogin.delete(req.ip);
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
    try {
        const [rows] = await pool.execute(
            `SELECT id, nombre FROM dependencias
             WHERE (? IS NULL OR id = ?) ORDER BY nombre`,
            req.usuario.rol === 'funcionario'
                ? [req.usuario.dependencia_id, req.usuario.dependencia_id] : [null, null]
        );
        res.json({ success: true, dependencias: rows });
    } catch (error) { next(error); }
});

router.post('/dependencias', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    const nombre = typeof req.body.nombre === 'string' ? req.body.nombre.trim() : '';
    if (!nombre || nombre.length > 150) {
        return errorHTTP(res, 400, 'El nombre de la dependencia es obligatorio (maximo 150 caracteres).');
    }
    try {
        const [result] = await pool.execute('INSERT INTO dependencias (nombre) VALUES (?)', [nombre]);
        res.status(201).json({ success: true, dependencia: { id: result.insertId, nombre } });
    } catch (error) { next(error); }
});

router.get('/usuarios/ventanilla', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    try {
        const [rows] = await pool.execute(
            "SELECT id, nombre FROM usuarios WHERE rol = 'ventanilla' ORDER BY nombre"
        );
        res.json({ success: true, usuarios: rows });
    } catch (error) { next(error); }
});

router.get('/usuarios', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    try {
        const [rows] = await pool.query('SELECT id, nombre, email, rol, dependencia_id FROM usuarios ORDER BY nombre');
        res.json({ success: true, usuarios: rows });
    } catch (error) { next(error); }
});

router.post('/usuarios', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    const usuario = datosUsuario(req.body);
    if (!usuario || !passwordValido(req.body.password)) {
        return errorHTTP(res, 400, 'Datos invalidos. Password: 10 a 128 caracteres; funcionario requiere dependencia; los otros roles, NULL.');
    }
    try {
        const password = await hashPassword(req.body.password);
        const [result] = await pool.execute(
            'INSERT INTO usuarios (nombre, email, password, rol, dependencia_id) VALUES (?, ?, ?, ?, ?)',
            [usuario.nombre, usuario.email, password, usuario.rol, usuario.dependencia_id]
        );
        res.status(201).json({ success: true, usuario: { id: result.insertId, ...usuario } });
    } catch (error) { next(error); }
});

router.put('/usuarios/:id', autenticar, permitirRoles('administrador'), async (req, res, next) => {
    const id = Number(req.params.id);
    const usuario = datosUsuario(req.body);
    if (!Number.isInteger(id) || id < 1 || !usuario ||
        (req.body.password !== undefined && !passwordValido(req.body.password))) {
        return errorHTTP(res, 400, 'Datos de usuario invalidos.');
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

module.exports = {
    router, autenticar, permitirRoles, filtroDependencia, autorizarRadicado,
    hashPassword, verificarPassword, crearSesion, revocarSesiones, datosUsuario
};
