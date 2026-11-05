const express = require('express');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');
const pool = require('./db');
const { autorizarRadicado, permitirRoles } = require('./auth');
const { opcionesCargaPdf, validarArchivoPdf } = require('./pdf-adjuntos');
const { registrarEventoRadicado } = require('./audit-log');
const { revertirTrasError } = require('./transacciones');

const fallo = (status, message) => Object.assign(new Error(message), { status });
const sha = contenido => createHash('sha256').update(contenido).digest('hex');
const COLUMNAS = `id,respuesta_id,canal,resultado,destinatario,destino,fecha_actuacion_utc,
    observaciones,actor_nombre,creado_en_utc,anulado_en_utc,anulador_nombre,motivo_anulacion`;
function entero(valor, nombre) {
    if (!/^[1-9]\d*$/.test(String(valor)) || !Number.isSafeInteger(Number(valor))) throw fallo(400, `${nombre} invalido.`);
    return Number(valor);
}
function texto(valor, nombre, min, max) {
    if (typeof valor !== 'string' || valor.trim().length < min || valor.trim().length > max) {
        throw fallo(400, `${nombre}: longitud requerida de ${min} a ${max} caracteres.`);
    }
    return valor.trim();
}
function validarRegistro(body) {
    const permitidos = ['clave', 'canal', 'resultado', 'destinatario', 'destino', 'fecha_actuacion', 'observaciones'];
    if (!body || Object.keys(body).some(c => !permitidos.includes(c))) throw fallo(400, 'Campos de entrega no permitidos.');
    if (typeof body.clave !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.clave)) throw fallo(400, 'Clave de intento UUID v4 invalida.');
    if (!['correo_electronico', 'presencial', 'mensajeria'].includes(body.canal) ||
        !['enviado', 'entrega_acreditada', 'intento_fallido'].includes(body.resultado)) throw fallo(400, 'Canal o resultado invalido.');
    const destino = texto(body.destino, 'Destino', 1, 500);
    if (body.canal === 'correo_electronico' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destino)) throw fallo(400, 'Correo de destino invalido.');
    if (typeof body.fecha_actuacion !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(body.fecha_actuacion) ||
        Number(body.fecha_actuacion.slice(0, 4)) < 1000) throw fallo(400, 'Fecha de actuacion invalida; usa fecha y hora de Bogota.');
    const fecha = new Date(`${body.fecha_actuacion}:00-05:00`);
    if (!Number.isFinite(fecha.getTime()) || fecha.getTime() > Date.now() ||
        new Date(fecha.getTime() - 5 * 3600000).toISOString().slice(0, 16) !== body.fecha_actuacion) throw fallo(400, 'Fecha invalida o futura.');
    return {
        clave: body.clave.toLowerCase(), canal: body.canal, resultado: body.resultado,
        destinatario: texto(body.destinatario, 'Destinatario', 1, 150), destino,
        fecha: fecha.toISOString().replace('T', ' ').replace('Z', ''),
        observaciones: texto(body.observaciones ?? '', 'Observaciones', body.resultado === 'intento_fallido' ? 10 : 0, 2000),
    };
}
function resumen(eventos) {
    const vigentes = eventos.filter(e => !e.anulado_en_utc);
    return vigentes.find(e => e.resultado === 'entrega_acreditada')?.resultado ||
        vigentes[0]?.resultado || 'pendiente_de_envio';
}
async function limpiar(archivos) {
    for (const archivo of archivos || []) {
        try { await fs.unlink(archivo.path); }
        catch (error) {
            if (error.code !== 'ENOENT') { console.error('No se pudo limpiar evidencia temporal:', error.code); throw error; }
        }
    }
}
async function respuestaElegible(c, numero, bloquear = false) {
    const [radicados] = await c.execute(
        `SELECT numero_radicado,tipo_comunicacion,destino_todas_dependencias FROM radicados
         WHERE numero_radicado=?${bloquear ? ' FOR UPDATE' : ''}`, [numero]);
    if (!radicados.length) throw fallo(404, 'Radicado no encontrado.');
    const r = radicados[0];
    if (Number(r.destino_todas_dependencias) || String(r.tipo_comunicacion).trim().toLowerCase() !== 'externa') {
        throw fallo(409, 'Solo se registra entrega para respuestas externas individuales.');
    }
    const [respuestas] = await c.execute(
        `SELECT id FROM respuestas_radicado WHERE numero_radicado=? AND radicado_dependencia_id IS NULL${bloquear ? ' FOR UPDATE' : ''}`, [numero]);
    if (!respuestas.length) throw fallo(404, 'No existe respuesta institucional para entregar.');
    return respuestas[0].id;
}
async function comprobante(c, id) {
    const [registros] = await c.execute(`SELECT ${COLUMNAS} FROM registros_entrega_respuesta WHERE id=?`, [id]);
    const [evidencias] = await c.execute(
        'SELECT id,nombre_archivo,tamano_bytes,sha256 FROM evidencias_entrega WHERE registro_id=? ORDER BY id', [id]);
    return { ...registros[0], evidencias };
}
function crearRouterEntregas(uploadDir) {
    const router = express.Router();
    const carpeta = path.join(uploadDir, 'entregas');
    const carga = multer({
        ...opcionesCargaPdf,
        storage: multer.diskStorage({
            destination: (req, file, cb) => fs.mkdir(carpeta, { recursive: true }).then(() => cb(null, carpeta), cb),
            filename: (req, file, cb) => cb(null, `entrega-${randomUUID()}.pdf`),
        }),
    }).array('archivos', 5);
    const base = '/radicados/:numero_radicado/entregas';
    router.use(base, autorizarRadicado, async (req, res, next) => {
        try {
            const [[estado]] = await pool.query(`SELECT COUNT(*) AS n FROM information_schema.TABLES
                WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('registros_entrega_respuesta','evidencias_entrega')`);
            if (Number(estado.n) !== 2) throw fallo(503, 'Seguimiento de entrega no activado: falta aplicar/verificar migracion 025.');
            next();
        } catch (error) { next(error); }
    });
    router.get(base, async (req, res, next) => {
        let c;
        try {
            const pagina = entero(req.query.pagina ?? 1, 'Pagina');
            if (pagina > 1000000) throw fallo(400, 'Pagina fuera de rango.');
            c = await pool.getConnection();
            await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await c.beginTransaction();
            const respuesta = await respuestaElegible(c, req.params.numero_radicado);
            const [[conteo]] = await c.execute(`SELECT COUNT(*) AS total,
                MAX(resultado='entrega_acreditada' AND anulado_en_utc IS NULL) AS acreditada
                FROM registros_entrega_respuesta WHERE respuesta_id=?`, [respuesta]);
            const [ultimo] = await c.execute(`SELECT resultado FROM registros_entrega_respuesta
                WHERE respuesta_id=? AND anulado_en_utc IS NULL ORDER BY id DESC LIMIT 1`, [respuesta]);
            const [rows] = await c.execute(`SELECT ${COLUMNAS} FROM registros_entrega_respuesta
                WHERE respuesta_id=? ORDER BY id DESC LIMIT 25 OFFSET ?`, [respuesta, (pagina - 1) * 25]);
            const evidencias = rows.length ? (await c.execute(`SELECT id,registro_id,nombre_archivo,tamano_bytes,sha256
                FROM evidencias_entrega WHERE registro_id IN (${rows.map(() => '?').join(',')}) ORDER BY id`,
            rows.map(row => row.id)))[0] : [];
            const registros = rows.map(row => ({ ...row, evidencias: evidencias.filter(e => e.registro_id === row.id)
                .map(({ registro_id, ...e }) => e) }));
            await c.commit();
            const total = Number(conteo.total);
            res.json({ success: true, resumen: Number(conteo.acreditada) ? 'entrega_acreditada' : resumen(ultimo),
                registros, total, pagina, paginas: Math.ceil(total / 25) });
        } catch (error) {
            ({ connection: c, error } = await revertirTrasError(c, error)); next(error);
        } finally { if (c) c.release(); }
    });
    router.post(base, permitirRoles('ventanilla', 'administrador'), (req, res, next) => {
        carga(req, res, async error => {
            if (!error) return next();
            try { await limpiar(req.files); }
            catch (falloLimpieza) { return next(falloLimpieza); }
            if (error instanceof multer.MulterError || error.code === 'PDF_TIPO_INVALIDO' ||
                ['Unexpected end of form', 'Unexpected end of file', 'Malformed part header', 'Multipart: Boundary not found'].includes(error.message)) {
                return next(fallo(400, 'Carga invalida: hasta 5 PDF de 10 MB cada uno.'));
            }
            next(error);
        });
    }, async (req, res, next) => {
        let c;
        let commitIniciado = false;
        let confirmado = false;
        let nuevoId;
        let datos;
        let huella;
        try {
            datos = validarRegistro(req.body);
            const archivos = [];
            for (const archivo of req.files || []) {
                const errorPdf = await validarArchivoPdf(archivo);
                if (errorPdf) throw fallo(400, errorPdf);
                texto(archivo.originalname, 'Nombre de archivo', 1, 255);
                archivos.push({ nombre: archivo.originalname, bytes: archivo.size,
                    sha256: sha(await fs.readFile(archivo.path)), ruta: `entregas/${archivo.filename}` });
            }
            if (datos.resultado === 'entrega_acreditada' && !archivos.length) throw fallo(400, 'Acreditar entrega requiere al menos un PDF de evidencia.');
            huella = sha(JSON.stringify({ numero: req.params.numero_radicado, ...datos,
                archivos: archivos.map(({ ruta, ...a }) => a) }));
            c = await pool.getConnection();
            await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            await c.beginTransaction();
            const respuesta = await respuestaElegible(c, req.params.numero_radicado, true);
            const [replay] = await c.execute('SELECT id,respuesta_id,huella FROM registros_entrega_respuesta WHERE actor_id=? AND clave=?', [req.usuario.id, datos.clave]);
            if (replay.length) {
                if (replay[0].huella !== huella || replay[0].respuesta_id !== respuesta) throw fallo(409, 'El intento ya corresponde a otros datos o evidencias.');
                const registro = await comprobante(c, replay[0].id);
                await c.rollback();
                await limpiar(req.files);
                return res.json({ success: true, registro });
            }
            const [acreditadas] = await c.execute(`SELECT id FROM registros_entrega_respuesta
                WHERE respuesta_id=? AND resultado='entrega_acreditada' AND anulado_en_utc IS NULL LIMIT 1`, [respuesta]);
            if (acreditadas.length) throw fallo(409, 'Ya existe una entrega acreditada vigente. Anulala con motivo antes de registrar otra actuacion.');
            const [insertado] = await c.execute(`INSERT INTO registros_entrega_respuesta
                (respuesta_id,canal,resultado,destinatario,destino,fecha_actuacion_utc,observaciones,actor_id,actor_nombre,clave,huella,creado_en_utc)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))`,
            [respuesta, datos.canal, datos.resultado, datos.destinatario, datos.destino, datos.fecha, datos.observaciones,
                req.usuario.id, req.usuario.nombre, datos.clave, huella]);
            nuevoId = insertado.insertId;
            for (const archivo of archivos) await c.execute(`INSERT INTO evidencias_entrega
                (registro_id,nombre_archivo,ruta_archivo,tipo_mime,tamano_bytes,sha256) VALUES (?,?,?,'application/pdf',?,?)`,
            [nuevoId, archivo.nombre, archivo.ruta, archivo.bytes, archivo.sha256]);
            await registrarEventoRadicado(c, req, { numeroRadicado: req.params.numero_radicado,
                tipo: 'entrega_registrada', valorNuevo: datos.resultado, motivo: `Registro de envio/entrega #${nuevoId} (${datos.canal}).` });
            const registro = await comprobante(c, nuevoId);
            commitIniciado = true;
            await c.commit();
            confirmado = true;
            return res.status(201).json({ success: true, registro });
        } catch (error) {
            ({ connection: c, error } = await revertirTrasError(c, error));
            if (commitIniciado && !confirmado) {
                if (c) { c.release(); c = undefined; }
                // No borrar PDF si el COMMIT puede haberse confirmado aunque se perdio su respuesta.
                try {
                    const [persistido] = await pool.execute('SELECT id,huella FROM registros_entrega_respuesta WHERE actor_id=? AND clave=?', [req.usuario.id, datos.clave]);
                    if (!persistido.length) await limpiar(req.files);
                } catch (verificacion) {
                    console.error('Confirmacion de evidencia incierta; archivos conservados:', verificacion.code || verificacion.message);
                }
                error = fallo(500, 'Confirmacion incierta. Consulta el historial o reintenta con los mismos datos y PDF.');
            } else if (!confirmado) {
                try { await limpiar(req.files); }
                catch (limpieza) { error = limpieza; }
            }
            next(error);
        } finally { if (c) c.release(); }
    });
    router.post(`${base}/:id/anulacion`, permitirRoles('ventanilla', 'administrador'), async (req, res, next) => {
        let c;
        try {
            if (!req.body || Object.keys(req.body).some(k => k !== 'motivo')) throw fallo(400, 'Campos de anulacion no permitidos.');
            const motivo = texto(req.body.motivo, 'Motivo de anulacion', 10, 2000);
            const registroId = entero(req.params.id, 'Registro');
            c = await pool.getConnection();
            await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            await c.beginTransaction();
            const respuesta = await respuestaElegible(c, req.params.numero_radicado, true);
            const [rows] = await c.execute('SELECT id,anulado_en_utc,motivo_anulacion FROM registros_entrega_respuesta WHERE id=? AND respuesta_id=? FOR UPDATE', [registroId, respuesta]);
            if (!rows.length) throw fallo(404, 'Registro de entrega no encontrado.');
            if (rows[0].anulado_en_utc) {
                if (rows[0].motivo_anulacion !== motivo) throw fallo(409, 'Registro ya anulado con otro motivo.');
            } else {
                await c.execute(`UPDATE registros_entrega_respuesta SET anulado_en_utc=UTC_TIMESTAMP(6),
                    anulador_id=?,anulador_nombre=?,motivo_anulacion=? WHERE id=?`,
                [req.usuario.id, req.usuario.nombre, motivo, registroId]);
                await registrarEventoRadicado(c, req, { numeroRadicado: req.params.numero_radicado,
                    tipo: 'entrega_anulada', motivo: `Anulacion del registro #${registroId}.`, valorNuevo: 'anulada' });
            }
            const registro = await comprobante(c, registroId);
            await c.commit();
            res.json({ success: true, registro });
        } catch (error) {
            ({ connection: c, error } = await revertirTrasError(c, error)); next(error);
        } finally { if (c) c.release(); }
    });
    router.get(`${base}/:id/evidencias/:evidencia`, async (req, res, next) => {
        try {
            const registro = entero(req.params.id, 'Registro');
            const evidencia = entero(req.params.evidencia, 'Evidencia');
            const [rows] = await pool.execute(`SELECT e.ruta_archivo FROM evidencias_entrega e
                JOIN registros_entrega_respuesta er ON er.id=e.registro_id
                JOIN respuestas_radicado rr ON rr.id=er.respuesta_id
                WHERE e.id=? AND er.id=? AND rr.numero_radicado=?`, [evidencia, registro, req.params.numero_radicado]);
            if (!rows.length || !/^entregas\/entrega-[a-f0-9-]+\.pdf$/.test(rows[0].ruta_archivo)) throw fallo(404, 'Evidencia no encontrada.');
            res.sendFile(rows[0].ruta_archivo, { root: uploadDir }, error => {
                if (!error) return;
                if (error.code === 'ENOENT') return next(fallo(404, 'El PDF de evidencia no esta disponible.'));
                next(error);
            });
        } catch (error) { next(error); }
    });
    router.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        if (!error.status || error.status >= 500) console.error('Error en seguimiento de entrega:', error.code || error.message);
        res.status(error.status || (error.code === 'ER_DUP_ENTRY' ? 409 : 500))
            .json({ success: false, message: error.status ? error.message : 'No se pudo confirmar la operacion de entrega. Consulta el historial o reintenta con los mismos datos.' });
    });
    return router;
}
module.exports = { crearRouterEntregas, validarRegistro, resumen };
