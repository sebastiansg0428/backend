const express = require('express');
const crypto = require('crypto');
const pool = require('./db');
const { permitirRoles } = require('./auth');
const { esEstadoFinal } = require('./estados');
const { registrarEventoRadicado } = require('./audit-log');
const { revertirTrasError } = require('./transacciones');

const ESTADOS = ['pendiente', 'aprobada', 'rechazada', 'cancelada_por_finalizacion'];
// No incluir datos actuales del expediente: el origen conserva solo este comprobante.
const COLUMNAS = `id, numero_radicado, origen_id, origen_nombre,
    destino_sugerido_id, destino_sugerido_nombre, destino_aprobado_id, destino_aprobado_nombre,
    solicitante_nombre, decisor_nombre, motivo_solicitud, motivo_decision, estado,
    fecha_limite_conservada, creado_en_utc, resuelto_en_utc`;
const fallo = (status, message) => Object.assign(new Error(message), { status });
const huella = datos => crypto.createHash('sha256').update(JSON.stringify(datos)).digest('hex');
function entero(valor, nombre) {
    if (!['string', 'number'].includes(typeof valor) || !/^[1-9]\d*$/.test(String(valor)) ||
        !Number.isSafeInteger(Number(valor))) throw fallo(400, `${nombre} debe ser un entero positivo.`);
    return Number(valor);
}
function texto(valor, nombre) {
    if (typeof valor !== 'string' || valor.trim().length < 10 || valor.trim().length > 2000) {
        throw fallo(400, `${nombre} debe tener entre 10 y 2000 caracteres.`);
    }
    return valor.trim();
}
function campos(body, permitidos) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(campo => !permitidos.includes(campo))) {
        throw fallo(400, 'La solicitud contiene campos no permitidos.');
    }
}
async function bloquearRadicado(connection, numero) {
    const [rows] = await connection.execute(
        `SELECT numero_radicado, estado, destino_todas_dependencias, dependencia_destino_id,
                dependencia_destino FROM radicados WHERE numero_radicado = ? FOR UPDATE`, [numero]);
    if (!rows.length) throw fallo(404, 'Radicado no encontrado.');
    return rows[0];
}
function elegible(radicado) {
    if (radicado.destino_todas_dependencias || !radicado.dependencia_destino_id) {
        throw fallo(409, 'Solo se trasladan radicados individuales con una dependencia destino.');
    }
    if (esEstadoFinal(radicado.estado)) throw fallo(409, 'No se puede trasladar un radicado finalizado.');
}
async function destinoActivo(connection, id, origen) {
    if (id === Number(origen)) throw fallo(400, 'El destino debe ser distinto de la dependencia actual.');
    const [rows] = await connection.execute('SELECT id, nombre FROM dependencias WHERE id = ? AND activo = 1 FOR UPDATE', [id]);
    if (!rows.length) throw fallo(400, 'Selecciona una dependencia destino activa.');
    return rows[0];
}
async function comprobante(connection, id) {
    const [rows] = await connection.execute(`SELECT ${COLUMNAS} FROM solicitudes_traslado WHERE id = ?`, [id]);
    return rows[0];
}
async function evento(connection, req, solicitud, tipo, motivo, destinoNombre) {
    await registrarEventoRadicado(connection, req, {
        numeroRadicado: solicitud.numero_radicado, tipo,
        valorAnterior: solicitud.origen_nombre,
        valorNuevo: destinoNombre || solicitud.destino_sugerido_nombre,
        dependenciaId: solicitud.origen_id, dependenciaNombre: solicitud.origen_nombre,
        motivo: `Solicitud de traslado #${solicitud.id}: ${motivo}`
    });
}
async function transaccion(req, res, operacion) {
    let connection;
    try {
        connection = await pool.getConnection();
        // Las decisiones localizan primero su padre; el bloqueo debe leer la version
        // vigente tras esperar, no una instantanea anterior a otra decision.
        await connection.query(req.method === 'GET'
            ? 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'
            : 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.beginTransaction();
        const resultado = await operacion(connection);
        await connection.commit();
        return res.status(resultado.status || 200).json({ success: true, ...resultado.body });
    } catch (error) {
        ({ connection, error } = await revertirTrasError(connection, error));
        if (error.status) return res.status(error.status).json({ success: false, message: error.message });
        console.error('Error al procesar traslado:', error);
        return res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({
            success: false, message: error.code === 'ER_DUP_ENTRY'
                ? 'Ya existe una solicitud pendiente o la clave del intento fue utilizada. Consulta la bandeja.'
                : 'No se pudo confirmar el traslado. Consulta la bandeja o reintenta con los mismos datos.'
        });
    } finally {
        if (connection) connection.release();
    }
}

// El llamador ya tiene bloqueado el radicado. Mantener este orden en toda finalizacion.
async function cancelarTrasladoPendiente(connection, req, numero) {
    const [rows] = await connection.execute(
        "SELECT * FROM solicitudes_traslado WHERE numero_radicado = ? AND estado = 'pendiente' FOR UPDATE", [numero]);
    if (!rows.length) return;
    const solicitud = rows[0];
    await connection.execute(
        `UPDATE solicitudes_traslado SET estado = 'cancelada_por_finalizacion', decisor_id = ?,
         decisor_nombre = ?, motivo_decision = ?, resuelto_en_utc = UTC_TIMESTAMP(6) WHERE id = ?`,
        [req.usuario.id, req.usuario.nombre, 'El expediente finalizo antes de resolver el traslado.', solicitud.id]);
    await evento(connection, req, solicitud, 'traslado_cancelado', 'Cancelado por finalizacion del expediente.');
}

const router = express.Router();
router.post('/radicados/:numero_radicado/traslados', permitirRoles('funcionario'), async (req, res) =>
    transaccion(req, res, async connection => {
        campos(req.body, ['clave_solicitud', 'destino_sugerido_id', 'motivo']);
        const { clave_solicitud: clave } = req.body;
        if (typeof clave !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clave)) {
            throw fallo(400, 'Indica una clave_solicitud UUID v4 valida.');
        }
        const destino = entero(req.body.destino_sugerido_id, 'destino_sugerido_id');
        const motivo = texto(req.body.motivo, 'El motivo');
        const numero = req.params.numero_radicado;
        const firma = huella([numero, destino, motivo]);
        const radicado = await bloquearRadicado(connection, numero);
        const [previas] = await connection.execute(
            'SELECT * FROM solicitudes_traslado WHERE solicitante_id = ? AND clave_solicitud = ? FOR UPDATE',
            [req.usuario.id, clave.toLowerCase()]);
        if (previas.length) {
            if (previas[0].huella_solicitud !== firma ||
                Number(previas[0].origen_id) !== req.usuario.dependencia_id) {
                throw fallo(409, 'La clave del intento ya fue utilizada con otros datos u origen.');
            }
            return { body: { traslado: await comprobante(connection, previas[0].id), repetido: true } };
        }
        if (Number(radicado.dependencia_destino_id) !== req.usuario.dependencia_id) {
            throw fallo(404, 'Radicado no encontrado o fuera de tu dependencia.');
        }
        elegible(radicado);
        const [pendientes] = await connection.execute(
            "SELECT id FROM solicitudes_traslado WHERE numero_radicado = ? AND estado = 'pendiente' FOR UPDATE", [numero]);
        if (pendientes.length) throw fallo(409, 'Este radicado ya tiene una solicitud pendiente.');
        const dependencia = await destinoActivo(connection, destino, radicado.dependencia_destino_id);
        const [terminos] = await connection.execute(
            'SELECT fecha_limite_actual FROM radicado_terminos WHERE numero_radicado = ?', [numero]);
        const [resultado] = await connection.execute(
            `INSERT INTO solicitudes_traslado
             (numero_radicado, origen_id, origen_nombre, destino_sugerido_id, destino_sugerido_nombre,
              solicitante_id, solicitante_nombre, motivo_solicitud, clave_solicitud, huella_solicitud,
              fecha_limite_conservada, creado_en_utc)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))`,
            [numero, radicado.dependencia_destino_id, radicado.dependencia_destino,
                destino, dependencia.nombre, req.usuario.id, req.usuario.nombre, motivo,
                clave.toLowerCase(), firma, terminos[0]?.fecha_limite_actual || null]);
        const solicitud = await comprobante(connection, resultado.insertId);
        await evento(connection, req, solicitud, 'traslado_solicitado', motivo);
        return { status: 201, body: { traslado: solicitud } };
    }));

router.post('/traslados/:id/decision', permitirRoles('administrador', 'ventanilla'), async (req, res) =>
    transaccion(req, res, async connection => {
        const id = entero(req.params.id, 'id');
        campos(req.body, ['decision', 'motivo', 'destino_id']);
        const decision = req.body.decision;
        if (!['aprobada', 'rechazada'].includes(decision)) throw fallo(400, 'Selecciona aprobada o rechazada.');
        const motivo = texto(req.body.motivo, 'La justificacion');
        if (decision === 'rechazada' && req.body.destino_id != null) throw fallo(400, 'Un rechazo no tiene destino aprobado.');
        const destino = decision === 'aprobada' ? entero(req.body.destino_id, 'destino_id') : null;
        const firma = huella([decision, destino, motivo]);
        // Esta lectura solo localiza el padre; los datos se validan de nuevo tras bloquearlo.
        const [referencias] = await connection.execute('SELECT numero_radicado FROM solicitudes_traslado WHERE id = ?', [id]);
        if (!referencias.length) throw fallo(404, 'Solicitud no encontrada.');
        const radicado = await bloquearRadicado(connection, referencias[0].numero_radicado);
        const [rows] = await connection.execute('SELECT * FROM solicitudes_traslado WHERE id = ? FOR UPDATE', [id]);
        const solicitud = rows[0];
        if (solicitud.estado !== 'pendiente') {
            if (solicitud.huella_decision !== firma) throw fallo(409, 'La solicitud ya fue resuelta con otra decision o finalizacion.');
            return { body: { traslado: await comprobante(connection, id), repetido: true } };
        }
        elegible(radicado);
        if (Number(radicado.dependencia_destino_id) !== Number(solicitud.origen_id)) {
            throw fallo(409, 'La dependencia actual ya no coincide con el origen de la solicitud.');
        }
        const dependencia = destino ? await destinoActivo(connection, destino, solicitud.origen_id) : null;
        if (dependencia) await connection.execute(
            'UPDATE radicados SET dependencia_destino_id = ?, dependencia_destino = ? WHERE numero_radicado = ?',
            [destino, dependencia.nombre, solicitud.numero_radicado]);
        await connection.execute(
            `UPDATE solicitudes_traslado SET estado = ?, destino_aprobado_id = ?, destino_aprobado_nombre = ?,
             decisor_id = ?, decisor_nombre = ?, motivo_decision = ?, huella_decision = ?,
             resuelto_en_utc = UTC_TIMESTAMP(6) WHERE id = ?`,
            [decision, destino, dependencia?.nombre || null, req.usuario.id, req.usuario.nombre, motivo, firma, id]);
        await evento(connection, req, solicitud, decision === 'aprobada' ? 'traslado_aprobado' : 'traslado_rechazado',
            motivo, dependencia?.nombre);
        return { body: { traslado: await comprobante(connection, id) } };
    }));

router.get('/traslados', async (req, res) => transaccion(req, res, async connection => {
    if (!['administrador', 'ventanilla', 'funcionario'].includes(req.usuario.rol)) throw fallo(403, 'Rol no autorizado.');
    const pagina = entero(req.query.pagina ?? '1', 'pagina');
    if (pagina > 1000000) throw fallo(400, 'Pagina fuera de rango.');
    const estado = req.query.estado ?? '';
    if (typeof estado !== 'string' || (estado && !ESTADOS.includes(estado))) throw fallo(400, 'Estado de traslado invalido.');
    const numero = req.query.numero_radicado ?? '';
    if (typeof numero !== 'string' || numero.length > 100) throw fallo(400, 'Numero de radicado invalido.');
    const condiciones = [];
    const valores = [];
    if (req.usuario.rol === 'funcionario') {
        condiciones.push('origen_id = ?');
        valores.push(req.usuario.dependencia_id);
    }
    const base = condiciones.length ? condiciones.join(' AND ') : '1 = 1';
    const [contadores] = await connection.execute(
        `SELECT COUNT(*) AS pendientes FROM solicitudes_traslado WHERE ${base} AND estado = 'pendiente'`, valores);
    if (estado) { condiciones.push('estado = ?'); valores.push(estado); }
    if (numero) { condiciones.push('numero_radicado = ?'); valores.push(numero); }
    const where = condiciones.length ? condiciones.join(' AND ') : '1 = 1';
    const [totales] = await connection.execute(`SELECT COUNT(*) AS total FROM solicitudes_traslado WHERE ${where}`, valores);
    const total = Number(totales[0].total);
    const [traslados] = await connection.execute(
        `SELECT ${COLUMNAS} FROM solicitudes_traslado WHERE ${where} ORDER BY id DESC LIMIT 25 OFFSET ?`,
        [...valores, (pagina - 1) * 25]);
    return { body: { traslados, total, pagina, paginas: Math.ceil(total / 25), pendientes: Number(contadores[0].pendientes) } };
}));
router.get('/traslados/dependencias', permitirRoles('administrador', 'ventanilla', 'funcionario'), async (req, res, next) => {
    try {
        const [dependencias] = await pool.execute(
            'SELECT id, nombre, activo FROM dependencias WHERE activo = 1 ORDER BY nombre');
        res.json({ success: true, dependencias });
    } catch (error) { next(error); }
});

router.get('/traslados/:id', async (req, res) => transaccion(req, res, async connection => {
    const id = entero(req.params.id, 'id');
    const [rows] = await connection.execute(
        `SELECT ${COLUMNAS} FROM solicitudes_traslado WHERE id = ?${req.usuario.rol === 'funcionario' ? ' AND origen_id = ?' : ''}`,
        req.usuario.rol === 'funcionario' ? [id, req.usuario.dependencia_id] : [id]);
    if (!rows.length) throw fallo(404, 'Solicitud no encontrada o fuera de tu dependencia de origen.');
    return { body: { traslado: rows[0] } };
}));

module.exports = { router, cancelarTrasladoPendiente };
