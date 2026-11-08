const express = require('express');
const path = require('node:path');
const pool = require('./db');
const { verificar, verificarCobertura } = require('./migrations/027_respuestas_internas');
const { registrarEventoRadicado } = require('./audit-log');
const { revertirTrasError } = require('./transacciones');
const { performance } = require('node:perf_hooks');
const { crearGuardiaEstructura, errorEstructura, esErrorEstructural } = require('./estructura-interna');
const estructura = crearGuardiaEstructura(verificar);

const fallo = (status, message) => Object.assign(new Error(message), { status });
const internaIndividual = r => String(r.tipo_comunicacion).trim().toLowerCase() === 'interna' &&
    !Number(r.destino_todas_dependencias) && Number(r.requiere_respuesta ?? 1) !== 0;
const SELECT = `SELECT ri.*,rr.numero_radicado,rr.contenido,rr.fecha_envio,
    r.dependencia_destino_id,r.dependencia_destino,r.dependencia_remitente,
    r.asunto_documento,u.nombre AS funcionario_nombre,origen.activo AS origen_activo,
    destino.activo AS destino_activo
    FROM recepciones_internas ri JOIN respuestas_radicado rr ON rr.id=ri.respuesta_id
    JOIN radicados r ON r.numero_radicado=rr.numero_radicado
    LEFT JOIN usuarios u ON u.id=rr.usuario_id
    JOIN dependencias origen ON origen.id=ri.dependencia_origen_id
    LEFT JOIN dependencias destino ON destino.id=r.dependencia_destino_id`;
function id(valor) {
    if (!/^[1-9]\d*$/.test(String(valor)) || !Number.isSafeInteger(Number(valor))) throw fallo(400, 'Identificador invalido.');
    return Number(valor);
}
async function exigirActivacion(c, escritura = false, tiempos = null) {
    let inicio = performance.now();
    if (escritura) await estructura.exigirEscritura(pool, c);
    else await estructura.exigir(c);
    if (tiempos) tiempos.estructura = performance.now() - inicio;
    inicio = performance.now();
    await verificarCobertura(c);
    if (tiempos) tiempos.cobertura = performance.now() - inicio;
}
async function registrarRecepcionInterna(c, respuesta, r) {
    if (!internaIndividual(r)) return;
    try {
        await estructura.exigirEscritura(pool, c);
        await verificarCobertura(c, respuesta);
        const [origen] = await c.execute('SELECT id FROM dependencias WHERE id=? AND activo=1', [r.dependencia_remitente_id ?? null]);
        if (!origen.length) throw fallo(409, 'El radicado interno no tiene una dependencia de origen valida.');
        await c.execute(`INSERT INTO recepciones_internas(respuesta_id,dependencia_origen_id,historica,disponible_en_utc)
            VALUES (?,?,0,UTC_TIMESTAMP(6))`, [respuesta, origen[0].id]);
    } catch (error) {
        if (esErrorEstructural(error)) {
            estructura.invalidar(pool);
            throw errorEstructura(error);
        }
        throw error;
    }
}
function presentar(row) {
    const { dependencia_destino_id, origen_activo, destino_activo, ...datos } = row;
    return datos;
}
async function obtener(c, usuario, where, valores, bloquear = false) {
    const [rows] = await c.execute(`${SELECT} WHERE ${where}${bloquear ? ' FOR UPDATE' : ''}`, valores);
    if (!rows.length) throw fallo(404, 'Respuesta interna no encontrada.');
    const r = rows[0];
    if (usuario.rol === 'funcionario' &&
        !(usuario.dependencia_id === r.dependencia_origen_id && Number(r.origen_activo) === 1) &&
        !(usuario.dependencia_id === r.dependencia_destino_id && Number(r.destino_activo) === 1)) {
        throw fallo(404, 'Respuesta interna fuera de tu dependencia.');
    }
    return r;
}
function crearRouterInternas(uploadDir) {
    const router = express.Router();
    const base = '/respuestas-internas';
    const medirRecepcion = (req, res, next) => {
        if (process.env.NODE_ENV !== 'production') res.locals.tiemposInternos = { inicio: performance.now() };
        next();
    };
    const activacion = async (req, res, next) => {
        try { await exigirActivacion(pool, req.method !== 'GET', res.locals.tiemposInternos); next(); } catch (e) { next(e); }
    };
    router.get(base, activacion, async (req, res, next) => {
        let c;
        try {
            if (req.usuario.rol !== 'funcionario') throw fallo(403, 'La bandeja corresponde a la dependencia de origen.');
            const [dependencia] = await pool.execute('SELECT id FROM dependencias WHERE id=? AND activo=1', [req.usuario.dependencia_id]);
            if (!dependencia.length) throw fallo(403, 'La dependencia de origen esta inactiva.');
            const pagina = id(req.query.pagina ?? 1);
            if (pagina > 1000000) throw fallo(400, 'Pagina fuera de rango.');
            const estado = req.query.estado ?? 'todas';
            if (!['todas', 'pendientes', 'leidas'].includes(estado)) throw fallo(400, 'Filtro de lectura invalido.');
            c = await pool.getConnection();
            await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await c.beginTransaction();
            const [[cuenta]] = await c.execute(`SELECT COUNT(*) AS total,
                COALESCE(SUM(primera_apertura_utc IS NULL),0) AS pendientes
                FROM recepciones_internas WHERE dependencia_origen_id=?`, [req.usuario.dependencia_id]);
            const condicion = estado === 'todas' ? '' : ` AND ri.primera_apertura_utc IS ${estado === 'pendientes' ? '' : 'NOT '}NULL`;
            const [rows] = await c.execute(`${SELECT} WHERE ri.dependencia_origen_id=?${condicion}
                ORDER BY ri.id DESC LIMIT 25 OFFSET ?`, [req.usuario.dependencia_id, (pagina - 1) * 25]);
            await c.commit();
            const total = Number(cuenta.total), pendientes = Number(cuenta.pendientes);
            const filtrado = estado === 'todas' ? total : estado === 'pendientes' ? pendientes : total - pendientes;
            res.json({ success: true, registros: rows.map(presentar), total: filtrado, pagina,
                paginas: Math.ceil(filtrado / 25), resumen: { total, pendientes, leidas: total - pendientes } });
        } catch (e) { ({ connection: c, error: e } = await revertirTrasError(c, e)); next(e); }
        finally { if (c) c.release(); }
    });
    router.get('/radicados/:numero/recepcion-interna', medirRecepcion, activacion, async (req, res, next) => {
        try {
            const inicio = performance.now();
            const r = await obtener(pool, req.usuario, 'rr.numero_radicado=?', [req.params.numero]);
            const tiempos = res.locals.tiemposInternos;
            if (tiempos) {
                res.set('Server-Timing', [
                    `estructura;dur=${tiempos.estructura.toFixed(2)}`,
                    `cobertura;dur=${tiempos.cobertura.toFixed(2)}`,
                    `datos;dur=${(performance.now() - inicio).toFixed(2)}`,
                    `ruta;dur=${(performance.now() - tiempos.inicio).toFixed(2)}`
                ].join(', '));
            }
            res.json({ success: true, recepcion: presentar(r) });
        } catch (e) { next(e); }
    });
    router.get(`${base}/:id`, activacion, async (req, res, next) => {
        try {
            const r = await obtener(pool, req.usuario, 'ri.id=?', [id(req.params.id)]);
            const [documentos] = await pool.execute(`SELECT id,nombre_archivo,tamano_bytes
                FROM documentos_respuesta WHERE respuesta_id=? ORDER BY id`, [r.respuesta_id]);
            res.json({ success: true, recepcion: presentar(r), documentos });
        } catch (e) { next(e); }
    });
    router.get(`${base}/:id/documentos/:documento`, activacion, async (req, res, next) => {
        try {
            const r = await obtener(pool, req.usuario, 'ri.id=?', [id(req.params.id)]);
            const [docs] = await pool.execute('SELECT ruta_archivo FROM documentos_respuesta WHERE id=? AND respuesta_id=?',
                [id(req.params.documento), r.respuesta_id]);
            if (!docs.length || !/^respuestas\/[a-zA-Z0-9._-]+\.pdf$/i.test(docs[0].ruta_archivo)) throw fallo(404, 'Documento no encontrado.');
            res.sendFile(path.normalize(docs[0].ruta_archivo), { root: uploadDir }, e => {
                if (e) next(e.code === 'ENOENT' ? fallo(404, 'El PDF no esta disponible.') : e);
            });
        } catch (e) { next(e); }
    });
    router.post(`${base}/:id/apertura`, activacion, async (req, res, next) => {
        let c;
        try {
            if (req.usuario.rol !== 'funcionario') throw fallo(403, 'Solo la dependencia de origen registra apertura.');
            if (req.body && Object.keys(req.body).length) throw fallo(400, 'La apertura no acepta actor ni fecha del cliente.');
            c = await pool.getConnection();
            await c.beginTransaction();
            const r = await obtener(c, req.usuario, 'ri.id=?', [id(req.params.id)], true);
            if (req.usuario.dependencia_id !== r.dependencia_origen_id || Number(r.origen_activo) !== 1) throw fallo(403, 'Solo la dependencia de origen activa registra apertura.');
            if (!r.primera_apertura_utc) {
                await c.execute(`UPDATE recepciones_internas SET primera_apertura_utc=UTC_TIMESTAMP(6),
                    actor_id=?,actor_nombre=? WHERE id=?`, [req.usuario.id, req.usuario.nombre, r.id]);
                await registrarEventoRadicado(c, req, { numeroRadicado: r.numero_radicado, tipo: 'respuesta_interna_abierta',
                    dependenciaId: r.dependencia_origen_id, dependenciaNombre: r.dependencia_remitente,
                    valorNuevo: 'Primera apertura registrada', motivo: 'La dependencia de origen abrio la respuesta interna en el sistema.' });
            }
            const actualizado = await obtener(c, req.usuario, 'ri.id=?', [r.id]);
            await c.commit();
            res.json({ success: true, recepcion: presentar(actualizado) });
        } catch (e) { ({ connection: c, error: e } = await revertirTrasError(c, e)); next(e); }
        finally { if (c) c.release(); }
    });
    router.use((e, req, res, next) => {
        if (res.headersSent) return next(e);
        if (esErrorEstructural(e)) {
            estructura.invalidar(pool);
            e = errorEstructura(e);
        }
        if (!e.status || e.status >= 500) console.error('Error en respuesta interna:', e.cause?.code || e.cause?.message || e.code || e.message);
        res.status(e.status || 500).json({ success: false, message: e.status ? e.message : 'No se pudo confirmar la operacion interna; reintenta.' });
    });
    return router;
}
module.exports = { crearRouterInternas, registrarRecepcionInterna, internaIndividual };
