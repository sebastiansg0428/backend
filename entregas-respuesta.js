const express = require('express');
const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomUUID, createHash } = require('node:crypto');
const pool = require('./db');
const { autorizarRadicado, permitirRoles } = require('./auth');
const { opcionesCargaPdf, validarArchivoPdf, validarContenidoPdf } = require('./pdf-adjuntos');
const { registrarEventoRadicado } = require('./audit-log');
const { revertirTrasError } = require('./transacciones');
const { verificar: verificar026 } = require('./migrations/026_documentos_entrega');
const { verificar: verificar029 } = require('./migrations/029_fecha_real_entrega');

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
async function fechaRespuestaEpoch(c, respuesta) {
    const [[referencia]] = await c.execute('SELECT UNIX_TIMESTAMP(fecha_envio) AS fecha_respuesta_epoch FROM respuestas_radicado WHERE id=?', [respuesta]);
    const valor = referencia?.fecha_respuesta_epoch;
    if (valor === null || valor === undefined || !Number.isFinite(Number(valor)) || Number(valor) <= 0) {
        throw fallo(409, 'La fecha de la respuesta no esta disponible para validar la actuacion.');
    }
    return Number(valor);
}
function validarCampos(body) {
    if (typeof body.clave !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.clave)) throw fallo(400, 'Clave de intento UUID v4 invalida.');
    if (!['correo_electronico', 'presencial', 'mensajeria'].includes(body.canal) ||
        !['enviado', 'entrega_acreditada', 'intento_fallido'].includes(body.resultado)) throw fallo(400, 'Canal o resultado invalido.');
    const destino = texto(body.destino, 'Destino', 1, 500);
    if (body.canal === 'correo_electronico' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destino)) throw fallo(400, 'Correo de destino invalido.');
    return {
        clave: body.clave.toLowerCase(), canal: body.canal, resultado: body.resultado,
        destinatario: texto(body.destinatario, 'Destinatario', 1, 150), destino,
        observaciones: texto(body.observaciones ?? '', 'Observaciones', body.resultado === 'intento_fallido' ? 10 : 0, 2000),
    };
}
function fechaActuacion(valor, segundos = false) {
    const patron = segundos ? /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
    if (typeof valor !== 'string' || !patron.test(valor) || Number(valor.slice(0, 4)) < 1000) {
        throw fallo(400, 'Fecha de actuacion invalida; usa fecha y hora de Bogota.');
    }
    const civil = valor.length === 16 ? `${valor}:00` : valor;
    const fecha = new Date(`${civil}-05:00`);
    if (!Number.isFinite(fecha.getTime()) || fecha.getTime() > Date.now() ||
        new Date(fecha.getTime() - 5 * 3600000).toISOString().slice(0, 19) !== civil) {
        throw fallo(400, 'Fecha invalida o futura.');
    }
    return fecha.toISOString().replace('T', ' ').replace('Z', '');
}
function validarRegistro(body) {
    if (body?.version === '3') {
        const { fecha_actuacion, justificacion_fecha_anterior, ...base } = body;
        const datos = validarRegistro({ ...base, version: '2' });
        const fecha = fechaActuacion(fecha_actuacion, true);
        return { ...datos, version: 3, fecha,
            justificacion_fecha_anterior: texto(justificacion_fecha_anterior ?? '', 'Justificacion de fecha anterior', 0, 2000) };
    }
    if (body?.version === '2') {
        const permitidos = ['version', 'clave', 'canal', 'resultado', 'destinatario', 'destino', 'observaciones', 'documentos_respuesta'];
        if (Object.keys(body).some(k => !permitidos.includes(k))) throw fallo(400, 'Campos de entrega no permitidos; la fecha es automatica.');
        let documentos;
        try { documentos = JSON.parse(body.documentos_respuesta); }
        catch { throw fallo(400, 'Seleccion de documentos invalida.'); }
        if (!Array.isArray(documentos) || documentos.length > 5 || documentos.some(d =>
            !d || Object.keys(d).sort().join(',') !== 'id,sha256' || !Number.isSafeInteger(d.id) || d.id < 1 ||
            typeof d.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(d.sha256)) ||
            new Set(documentos.map(d => d.id)).size !== documentos.length) throw fallo(400, 'Seleccion de documentos invalida.');
        return { ...validarCampos(body), version: 2, documentos: documentos.sort((a, b) => a.id - b.id) };
    }
    const permitidos = ['clave', 'canal', 'resultado', 'destinatario', 'destino', 'fecha_actuacion', 'observaciones'];
    if (!body || Object.keys(body).some(c => !permitidos.includes(c))) throw fallo(400, 'Campos de entrega no permitidos.');
    const { observaciones, ...campos } = validarCampos(body);
    return {
        ...campos,
        fecha: fechaActuacion(body.fecha_actuacion),
        observaciones,
    };
}
function resumen(eventos) {
    const vigentes = eventos.filter(e => !e.anulado_en_utc).sort((a, b) =>
        String(b.fecha_actuacion_utc || '').localeCompare(String(a.fecha_actuacion_utc || '')) ||
        Number(b.id || 0) - Number(a.id || 0));
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
async function metadatosFecha(c, registros, disponible) {
    if (!disponible || !registros.length) return registros.map(r => ({
        ...r, fecha_real_declarada: false, justificacion_fecha_anterior: null,
    }));
    const [fechas] = await c.execute(`SELECT registro_id,justificacion_fecha_anterior FROM entregas_fecha_real
        WHERE registro_id IN (${registros.map(() => '?').join(',')})`, registros.map(r => r.id));
    return registros.map(r => {
        const fecha = fechas.find(f => f.registro_id === r.id);
        return { ...r, fecha_real_declarada: Boolean(fecha),
            justificacion_fecha_anterior: fecha?.justificacion_fecha_anterior ?? null };
    });
}
async function comprobante(c, id, automatico = false, fechaReal = false) {
    const [registros] = await c.execute(`SELECT ${COLUMNAS} FROM registros_entrega_respuesta WHERE id=?`, [id]);
    const [evidencias] = await c.execute(
        `SELECT e.id,e.nombre_archivo,e.tamano_bytes,e.sha256,${automatico ? "COALESCE(o.origen,'legado')" : "'legado'"} AS origen
         FROM evidencias_entrega e ${automatico ? 'LEFT JOIN documentos_entrega_origen o ON o.evidencia_id=e.id' : ''}
         WHERE e.registro_id=? ORDER BY e.id`, [id]);
    return { ...(await metadatosFecha(c, registros, fechaReal))[0], evidencias };
}
async function documentosRespuesta(c, respuesta, uploadDir) {
    const [rows] = await c.execute(`SELECT id,nombre_archivo,ruta_archivo,tamano_bytes
        FROM documentos_respuesta WHERE respuesta_id=? ORDER BY id`, [respuesta]);
    if (rows.length > 5) throw fallo(409, 'La respuesta tiene mas de cinco documentos; revisa su integridad.');
    const documentos = [];
    for (const row of rows) {
        if (!/^respuestas\/[a-zA-Z0-9._-]+\.pdf$/i.test(row.ruta_archivo)) throw fallo(409, 'Ruta de documento de respuesta incompatible.');
        const archivo = path.resolve(uploadDir, row.ruta_archivo);
        let contenido;
        try {
            const stat = await fs.lstat(archivo);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) throw fallo(409, 'Documento de respuesta incompatible.');
            contenido = await fs.readFile(archivo);
        } catch (error) {
            if (error.code === 'ENOENT') throw fallo(409, 'Un PDF de la respuesta no esta disponible; no se omitio el documento.');
            throw error;
        }
        if (contenido.length !== Number(row.tamano_bytes)) throw fallo(409, 'El PDF de respuesta no coincide con su tamano registrado.');
        const invalido = await validarContenidoPdf(contenido);
        if (invalido) throw fallo(409, invalido);
        documentos.push({ id: row.id, nombre_archivo: row.nombre_archivo, tamano_bytes: contenido.length,
            sha256: sha(contenido), contenido });
    }
    return documentos;
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
            req.entregaAutomatica = await verificar026(pool);
            req.entregaFechaReal = req.entregaAutomatica && await verificar029(pool);
            next();
        } catch (error) { next(error); }
    });
    router.get(`${base}/documentos-respuesta`, async (req, res, next) => {
        let c;
        try {
            if (!req.entregaAutomatica) throw fallo(503, 'Registro automatico no activado: falta aplicar/verificar migracion 026.');
            c = await pool.getConnection();
            const respuesta = await respuestaElegible(c, req.params.numero_radicado);
            const documentos = await documentosRespuesta(c, respuesta, uploadDir);
            const fechaRespuesta = await fechaRespuestaEpoch(c, respuesta);
            res.json({ success: true, fecha_respuesta_epoch: fechaRespuesta,
                documentos: documentos.map(({ contenido, ...d }) => d) });
        } catch (error) { next(error); }
        finally { if (c) c.release(); }
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
                WHERE respuesta_id=? AND anulado_en_utc IS NULL ORDER BY fecha_actuacion_utc DESC,id DESC LIMIT 1`, [respuesta]);
            const [rows] = await c.execute(`SELECT ${COLUMNAS} FROM registros_entrega_respuesta
                WHERE respuesta_id=? ORDER BY fecha_actuacion_utc DESC,id DESC LIMIT 25 OFFSET ?`, [respuesta, (pagina - 1) * 25]);
            const evidencias = rows.length ? (await c.execute(`SELECT e.id,e.registro_id,e.nombre_archivo,e.tamano_bytes,e.sha256,
                ${req.entregaAutomatica ? "COALESCE(o.origen,'legado')" : "'legado'"} AS origen
                FROM evidencias_entrega e ${req.entregaAutomatica ? 'LEFT JOIN documentos_entrega_origen o ON o.evidencia_id=e.id' : ''}
                WHERE e.registro_id IN (${rows.map(() => '?').join(',')}) ORDER BY e.id`,
            rows.map(row => row.id)))[0] : [];
            const registros = (await metadatosFecha(c, rows, req.entregaFechaReal)).map(row => ({ ...row, evidencias: evidencias.filter(e => e.registro_id === row.id)
                .map(({ registro_id, ...e }) => e) }));
            await c.commit();
            const total = Number(conteo.total);
            res.json({ success: true, automatico_disponible: req.entregaAutomatica,
                fecha_real_disponible: Boolean(req.entregaFechaReal), resumen: Number(conteo.acreditada) ? 'entrega_acreditada' : resumen(ultimo),
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
        const temporales = [];
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
            huella = sha(JSON.stringify({ numero: req.params.numero_radicado, ...datos,
                archivos: archivos.map(({ ruta, ...a }) => a) }));
            c = await pool.getConnection();
            await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            await c.beginTransaction();
            const respuesta = await respuestaElegible(c, req.params.numero_radicado, true);
            const [replay] = await c.execute('SELECT id,respuesta_id,huella FROM registros_entrega_respuesta WHERE actor_id=? AND clave=?', [req.usuario.id, datos.clave]);
            if (replay.length) {
                if (replay[0].huella !== huella || replay[0].respuesta_id !== respuesta) throw fallo(409, 'El intento ya corresponde a otros datos o evidencias.');
                if (req.entregaAutomatica) {
                    const [contrato] = await c.execute('SELECT registro_id FROM entregas_confirmacion WHERE registro_id=?', [replay[0].id]);
                    if (Boolean(contrato.length) !== [2, 3].includes(datos.version)) throw fallo(409, 'El intento corresponde a otra version del formulario.');
                }
                const registro = await comprobante(c, replay[0].id, req.entregaAutomatica, req.entregaFechaReal);
                await c.rollback();
                await limpiar(req.files);
                return res.json({ success: true, registro });
            }
            if (datos.version !== 3) throw fallo(409, 'Actualiza la interfaz: los nuevos registros requieren fecha real de la actuacion.');
            if (!req.entregaAutomatica) throw fallo(503, 'Registro automatico no activado: falta aplicar/verificar migracion 026.');
            if (!req.entregaFechaReal) throw fallo(503, 'Fecha real no activada: falta aplicar/verificar migracion 029.');
            const fechaRespuesta = await fechaRespuestaEpoch(c, respuesta);
            if (new Date(`${datos.fecha.replace(' ', 'T')}Z`).getTime() < fechaRespuesta * 1000 &&
                datos.justificacion_fecha_anterior.length < 10) {
                throw fallo(400, 'La actuacion anterior a la respuesta requiere justificacion de 10 a 2000 caracteres.');
            }
            if (datos.resultado === 'entrega_acreditada' && !archivos.length) throw fallo(400, 'Acreditar entrega requiere evidencia adicional de recepcion, no solo el PDF de respuesta.');
            const fuentes = await documentosRespuesta(c, respuesta, uploadDir);
            const seleccion = datos.documentos.map(d => {
                const fuente = fuentes.find(f => f.id === d.id);
                if (!fuente || fuente.sha256 !== d.sha256) throw fallo(409, 'El documento seleccionado no pertenece a esta respuesta o cambio; actualiza el catalogo.');
                return fuente;
            });
            if (datos.resultado === 'entrega_acreditada' &&
                archivos.every(a => fuentes.some(f => f.sha256 === a.sha256))) throw fallo(400, 'El PDF de respuesta no acredita recepcion. Adjunta una constancia adicional diferente.');
            const [acreditadas] = await c.execute(`SELECT id FROM registros_entrega_respuesta
                WHERE respuesta_id=? AND resultado='entrega_acreditada' AND anulado_en_utc IS NULL LIMIT 1`, [respuesta]);
            if (acreditadas.length) throw fallo(409, 'Ya existe una entrega acreditada vigente. Anulala con motivo antes de registrar otra actuacion.');
            for (const fuente of seleccion) {
                const nombre = `entrega-${randomUUID()}.pdf`;
                const destino = path.join(carpeta, nombre);
                await fs.mkdir(carpeta, { recursive: true });
                const handle = await fs.open(destino, 'wx');
                temporales.push({ path: destino });
                try { await handle.writeFile(fuente.contenido); }
                finally { await handle.close(); }
                archivos.push({ nombre: fuente.nombre_archivo, bytes: fuente.tamano_bytes, sha256: fuente.sha256,
                    ruta: `entregas/${nombre}`, origen: 'documento_respuesta' });
            }
            const [insertado] = await c.execute(`INSERT INTO registros_entrega_respuesta
                (respuesta_id,canal,resultado,destinatario,destino,fecha_actuacion_utc,observaciones,actor_id,actor_nombre,clave,huella,creado_en_utc)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(6))`,
            [respuesta, datos.canal, datos.resultado, datos.destinatario, datos.destino, datos.fecha, datos.observaciones,
                req.usuario.id, req.usuario.nombre, datos.clave, huella]);
            nuevoId = insertado.insertId;
            await c.execute('INSERT INTO entregas_confirmacion(registro_id) VALUES (?)', [nuevoId]);
            await c.execute('INSERT INTO entregas_fecha_real(registro_id,justificacion_fecha_anterior) VALUES (?,?)',
                [nuevoId, datos.justificacion_fecha_anterior || null]);
            for (const archivo of archivos) {
                const [evidencia] = await c.execute(`INSERT INTO evidencias_entrega
                (registro_id,nombre_archivo,ruta_archivo,tipo_mime,tamano_bytes,sha256) VALUES (?,?,?,'application/pdf',?,?)`,
                [nuevoId, archivo.nombre, archivo.ruta, archivo.bytes, archivo.sha256]);
                await c.execute('INSERT INTO documentos_entrega_origen(evidencia_id,origen) VALUES (?,?)',
                    [evidencia.insertId, archivo.origen || 'evidencia_adicional']);
            }
            await registrarEventoRadicado(c, req, { numeroRadicado: req.params.numero_radicado,
                tipo: 'entrega_registrada', valorNuevo: datos.resultado, motivo: `Registro de envio/entrega #${nuevoId} (${datos.canal}).` });
            const registro = await comprobante(c, nuevoId, true, true);
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
                    if (!persistido.length) await limpiar([...(req.files || []), ...temporales]);
                } catch (verificacion) {
                    console.error('Confirmacion de evidencia incierta; archivos conservados:', verificacion.code || verificacion.message);
                }
                error = fallo(500, 'Confirmacion incierta. Consulta el historial o reintenta con los mismos datos y PDF.');
            } else if (!confirmado) {
                try { await limpiar([...(req.files || []), ...temporales]); }
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
            const registro = await comprobante(c, registroId, req.entregaAutomatica, req.entregaFechaReal);
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
