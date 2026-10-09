const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pool = require('./db');
const calcularSemaforoBackend = require('./semaforo');
const { agregarDias, obtenerFechaLocal } = require('./semaforo');
const { normalizarTexto, obtenerTiempoRespuesta } = require('./plazos');
const { obtenerEstadoEditable } = require('./estados');
const {
    router: authRouter, autenticar, permitirRoles, filtroDependencia, autorizarRadicado
} = require('./auth');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Middlewares esenciales
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Asegurar carpeta uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

app.use('/api', authRouter);
app.use('/api', autenticar);

app.use('/uploads', autenticar, async (req, res, next) => {
    try {
        let nombreArchivo;
        try {
            nombreArchivo = decodeURIComponent(req.path.slice(1));
        } catch (error) {
            if (!(error instanceof URIError)) throw error;
            return responderError(res, 400, 'La ruta del archivo no es valida.');
        }
        if (nombreArchivo.includes('/') || nombreArchivo.includes('\\')) {
            return responderError(res, 404, 'Archivo no encontrado.');
        }
        const filtro = filtroDependencia(req.usuario);
        const [rows] = await pool.execute(
            `SELECT r.id FROM radicados r WHERE r.ruta_archivo = ? AND ${filtro.sql} LIMIT 1`,
            [nombreArchivo, ...filtro.valores]
        );
        if (!rows.length) {
            return responderError(res, 404, 'Archivo no encontrado o fuera de tu dependencia.');
        }
        return next();
    } catch (error) {
        return next(error);
    }
}, express.static(uploadDir));

// Configuración de Multer para almacenar el PDF
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({ storage: storage });

const CATEGORIAS_TRAMITE = new Set([
    'peticion_general',
    'informacion_documentos',
    'consulta',
    'entre_autoridades',
    'especial'
]);

function responderError(res, status, message) {
    return res.status(status).json({ success: false, message });
}

function eliminarArchivoSubido(archivo) {
    if (!archivo) {
        return;
    }
    try {
        fs.unlinkSync(archivo.path);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error('No se pudo eliminar un archivo de una solicitud fallida:', error);
        }
    }
}

const protegerAdministracion = permitirRoles('administrador');

async function obtenerTerminoVigente({ tipoTramiteId, tipoDocumento, fecha }) {
    const esIdNumerico = tipoTramiteId && Number.isInteger(Number(tipoTramiteId)) && Number(tipoTramiteId) >= 1;
    const [tipos] = await pool.query(
        `SELECT t.id, t.nombre, t.categoria_general, l.id AS termino_legal_id,
                l.dias, l.tipo_dias, l.fundamento_legal
         FROM tipos_tramite AS t
         JOIN terminos_legales AS l ON l.tipo_tramite_id = t.id
         WHERE t.activo = TRUE
           AND l.vigente_desde <= ?
           AND (l.vigente_hasta IS NULL OR l.vigente_hasta >= ?)
           AND (? IS NULL OR t.id = ? OR t.codigo = ? OR t.nombre = ?)
         ORDER BY l.vigente_desde DESC, l.id DESC`,
        [
            fecha,
            fecha,
            tipoTramiteId ? (esIdNumerico ? Number(tipoTramiteId) : null) : null,
            tipoTramiteId ? (esIdNumerico ? Number(tipoTramiteId) : null) : null,
            String(tipoTramiteId || ''),
            String(tipoTramiteId || '')
        ]
    );

    const tipo = tipoTramiteId
        ? (tipos[0] || tipos.find(({ nombre }) => normalizarTexto(nombre) === normalizarTexto(tipoTramiteId)))
        : tipos.find(({ nombre }) => normalizarTexto(nombre) === normalizarTexto(tipoDocumento));
    return tipo || null;
}

function esFechaISO(fecha) {
    if (typeof fecha !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
        return false;
    }
    try {
        return obtenerFechaLocal(fecha, 'vigente_desde') === fecha;
    } catch {
        return false;
    }
}

function presentarRadicado(radicado) {
    const {
        termino_fecha_recepcion,
        termino_dias,
        termino_tipo_dias,
        termino_fundamento,
        termino_fecha_limite_inicial,
        termino_fecha_limite_actual,
        termino_fecha_respuesta,
        termino_nombre_tramite,
        termino_codigo_tramite,
        ...datos
    } = radicado;
    const radicadoConTermino = {
        ...datos,
        fecha_recepcion: termino_fecha_recepcion || datos.fecha_creacion,
        termino_dias_aplicado: termino_dias,
        tipo_dias_aplicado: termino_tipo_dias,
        fundamento_legal_aplicado: termino_fundamento,
        fecha_limite_inicial: termino_fecha_limite_inicial,
        fecha_limite_actual: termino_fecha_limite_actual,
        fecha_respuesta: termino_fecha_respuesta,
        tipo_tramite: termino_nombre_tramite || null,
        tipo_tramite_codigo: termino_codigo_tramite || null
    };
    if (termino_dias && termino_tipo_dias) {
        radicadoConTermino.tiempo_de_respuesta = obtenerTiempoRespuesta({
            dias: termino_dias,
            tipo_dias: termino_tipo_dias
        });
    }
    return {
        ...radicadoConTermino,
        semaforo: calcularSemaforoBackend(radicadoConTermino)
    };
}

// Ruta POST principal para registrar el radicado
app.post('/api/radicados', permitirRoles('administrador', 'ventanilla'), upload.single('archivo'), async (req, res) => {
    try {
        if (!req.file) {
            return responderError(res, 400, 'El archivo PDF adjunto es obligatorio.');
        }

        // Extracción limpia de los campos del formulario
        const {
            tipo_comunicacion,
            tipo_recepcion,
            tipo_tramite_id,
            tipo_documento,
            remitente_nombre,
            remitente_documento,
            remitente_entidad,
            remitente_nit,
            remitente_telefono,
            remitente_email,
            numero_folios,
            dependencia_destino_id,
            dependencia_destino,
            asunto_documento,
            usuario_recibe
        } = req.body;

        // Validación obligatoria para evitar errores de base de datos
        if (!asunto_documento || !remitente_nombre || !remitente_documento) {
            eliminarArchivoSubido(req.file);
            return responderError(res, 400, 'Faltan campos obligatorios (Asunto, Nombre o Documento del remitente).');
        }

        let dependencia;
        if (dependencia_destino_id !== undefined) {
            const id = Number(dependencia_destino_id);
            if (!Number.isInteger(id) || id < 1) {
                eliminarArchivoSubido(req.file);
                return responderError(res, 400, 'dependencia_destino_id debe ser un entero positivo.');
            }
            const [rows] = await pool.execute('SELECT id, nombre FROM dependencias WHERE id = ?', [id]);
            dependencia = rows[0];
        } else if (typeof dependencia_destino === 'string' && dependencia_destino.trim()) {
            const [rows] = await pool.execute(
                'SELECT id, nombre FROM dependencias WHERE nombre = ?',
                [dependencia_destino.trim()]
            );
            dependencia = rows[0];
        }
        if (!dependencia) {
            eliminarArchivoSubido(req.file);
            return responderError(res, 422, 'Selecciona una dependencia existente del catalogo.');
        }

        if (
            tipo_tramite_id &&
            (!Number.isInteger(Number(tipo_tramite_id)) || Number(tipo_tramite_id) < 1)
        ) {
            eliminarArchivoSubido(req.file);
            return responderError(res, 400, 'tipo_tramite_id debe ser un entero positivo.');
        }

        const fechaRecepcion = obtenerFechaLocal(new Date(), 'fecha_recepcion');
        const termino = await obtenerTerminoVigente({
            tipoTramiteId: tipo_tramite_id ? Number(tipo_tramite_id) : null,
            tipoDocumento: tipo_documento,
            fecha: fechaRecepcion
        });
        if (!termino) {
            eliminarArchivoSubido(req.file);
            return responderError(
                res,
                422,
                'El tipo de trámite no tiene un término vigente configurado. Selecciona un tipo válido o solicita su configuración al administrador.'
            );
        }

        const fechaLimite = agregarDias(fechaRecepcion, termino.dias, termino.tipo_dias);
        // Generar número de radicado único (Ej: RAD-20260930-4821)
        const fechaHoy = fechaRecepcion.replace(/-/g, '');
        const numeroRadicado = `RAD-${fechaHoy}-${Math.floor(1000 + Math.random() * 9000)}`;

        const nombreArchivoOriginal = req.file.originalname;
        const rutaArchivo = req.file.filename;

        // Query SQL con valores protegidos (Sanitizados contra SQL Injection)
        const tiempoRespuesta = obtenerTiempoRespuesta(termino);
        const query = `
            INSERT INTO radicados 
            (numero_radicado, tipo_recepcion, tipo_comunicacion, tipo_documento, tiempo_de_respuesta, remitente_nombre, remitente_documento, remitente_entidad, remitente_nit, remitente_telefono, remitente_email, numero_folios, dependencia_destino, asunto_documento, usuario_recibe, nombre_archivo_original, ruta_archivo, dependencia_destino_id)
            VALUES (?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?, ?)
        `;

        const values = [
            numeroRadicado,
            tipo_recepcion || 'Digital',
            tipo_comunicacion,
            termino.nombre,
            tiempoRespuesta,
            remitente_nombre,
            remitente_documento,
            remitente_entidad || null,
            remitente_nit || null,
            remitente_telefono || 'No especificado',
            remitente_email || null,
            numero_folios || 1,
            dependencia.nombre,
            asunto_documento,
            req.usuario.nombre,
            nombreArchivoOriginal,
            rutaArchivo,
            dependencia.id
        ];

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.execute(query, values);
            await connection.execute(
                `INSERT INTO radicado_terminos
                    (numero_radicado, tipo_tramite_id, termino_legal_id, fecha_recepcion,
                     termino_dias_aplicado, tipo_dias_aplicado, fundamento_legal_aplicado,
                     fecha_limite_inicial, fecha_limite_actual)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    numeroRadicado,
                    termino.id,
                    termino.termino_legal_id,
                    fechaRecepcion,
                    termino.dias,
                    termino.tipo_dias,
                    termino.fundamento_legal,
                    fechaLimite,
                    fechaLimite
                ]
            );
            await connection.execute(
                `INSERT INTO historial_radicado
                    (numero_radicado, campo_modificado, valor_nuevo, usuario, motivo)
                 VALUES (?, 'termino_legal', ?, ?, 'Término aplicado al crear el radicado')`,
                [numeroRadicado, JSON.stringify({
                    tipo_tramite_id: termino.id,
                    termino_legal_id: termino.termino_legal_id,
                    dias: termino.dias,
                    tipo_dias: termino.tipo_dias,
                    fundamento_legal: termino.fundamento_legal,
                    fecha_limite: fechaLimite
                }), String(req.usuario.id)]
            );
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }

        console.log(`✅ Radicado ${numeroRadicado} guardado correctamente.`);

        return res.status(200).json({
            success: true,
            message: 'Radicado generado y guardado exitosamente.',
            radicado: numeroRadicado,
            usuario_recibe: req.usuario.nombre,
            termino: {
                dias: termino.dias,
                tipo_dias: termino.tipo_dias,
                fundamento_legal: termino.fundamento_legal,
                fecha_limite: fechaLimite
            }
        });

    } catch (error) {
        console.error('❌ Error crítico al procesar el radicado:', error);

        if (req.file) {
            eliminarArchivoSubido(req.file);
        }

        return responderError(res, 500, 'Error interno del servidor al guardar el registro.');
    }
});

app.get('/api/tipos-tramite', async (req, res) => {
    try {
        const hoy = obtenerFechaLocal(new Date(), 'fecha actual');
        const [rows] = await pool.query(
            `SELECT t.id, t.codigo, t.nombre, t.categoria_general, t.orden,
                    l.id AS termino_legal_id, l.dias, l.tipo_dias, l.fundamento_legal
             FROM tipos_tramite AS t
             LEFT JOIN terminos_legales AS l
               ON l.tipo_tramite_id = t.id
              AND l.vigente_desde <= ?
              AND (l.vigente_hasta IS NULL OR l.vigente_hasta >= ?)
             WHERE t.activo = TRUE
             ORDER BY COALESCE(NULLIF(t.orden, 0), 999) ASC, t.id ASC`,
            [hoy, hoy]
        );
        return res.json({ success: true, tipos_tramite: rows });
    } catch (error) {
        console.error('Error al consultar los tipos de trámite:', error);
        return responderError(res, 500, 'Error interno al consultar los tipos de trámite.');
    }
});

app.get('/api/terminos-legales', async (req, res) => {
    try {
        const tipoTramiteId = req.query.tipo_tramite_id
            ? Number(req.query.tipo_tramite_id)
            : null;
        if (tipoTramiteId !== null && (!Number.isInteger(tipoTramiteId) || tipoTramiteId < 1)) {
            return responderError(res, 400, 'tipo_tramite_id debe ser un entero positivo.');
        }

        const [rows] = await pool.execute(
            `SELECT l.*, t.codigo AS tipo_codigo, t.nombre AS tipo_nombre
             FROM terminos_legales AS l
             JOIN tipos_tramite AS t ON t.id = l.tipo_tramite_id
             WHERE (? IS NULL OR l.tipo_tramite_id = ?)
             ORDER BY l.tipo_tramite_id, l.vigente_desde DESC, l.id DESC`,
            [tipoTramiteId, tipoTramiteId]
        );
        return res.json({ success: true, terminos_legales: rows });
    } catch (error) {
        console.error('Error al consultar términos legales:', error);
        return responderError(res, 500, 'Error interno al consultar términos legales.');
    }
});

app.post('/api/tipos-tramite', protegerAdministracion, async (req, res) => {
    const {
        codigo,
        nombre,
        categoria_general,
        dias,
        tipo_dias,
        fundamento_legal,
        vigente_desde
    } = req.body;
    const diasNumero = Number(dias);
    const inicio = vigente_desde || obtenerFechaLocal(new Date(), 'vigente_desde');
    if (
        typeof codigo !== 'string' || !/^[a-z0-9_]{2,60}$/.test(codigo) ||
        typeof nombre !== 'string' || !nombre.trim() ||
        !CATEGORIAS_TRAMITE.has(categoria_general) ||
        !Number.isInteger(diasNumero) || diasNumero < 1 ||
        !['habiles', 'calendario'].includes(tipo_dias) ||
        typeof fundamento_legal !== 'string' || !fundamento_legal.trim() ||
        !esFechaISO(inicio)
    ) {
        return responderError(
            res,
            400,
            'Datos inválidos: revisa código, nombre, categoría, término, tipo de días, fundamento y vigencia.'
        );
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [result] = await connection.execute(
            `INSERT INTO tipos_tramite (codigo, nombre, categoria_general)
             VALUES (?, ?, ?)`,
            [codigo, nombre.trim(), categoria_general]
        );
        await connection.execute(
            `INSERT INTO terminos_legales
                (tipo_tramite_id, dias, tipo_dias, fundamento_legal, vigente_desde)
             VALUES (?, ?, ?, ?, ?)`,
            [result.insertId, diasNumero, tipo_dias, fundamento_legal.trim(), inicio]
        );
        await connection.commit();
        return res.status(201).json({
            success: true,
            tipo_tramite_id: result.insertId,
            message: 'Tipo de trámite y término inicial creados.'
        });
    } catch (error) {
        await connection.rollback();
        if (error.code === 'ER_DUP_ENTRY') {
            return responderError(res, 409, 'Ya existe un tipo de trámite con ese código o nombre.');
        }
        console.error('Error al crear tipo de trámite:', error);
        return responderError(res, 500, 'Error interno al crear el tipo de trámite.');
    } finally {
        connection.release();
    }
});

app.post('/api/terminos-legales', protegerAdministracion, async (req, res) => {
    const { tipo_tramite_id, dias, tipo_dias, fundamento_legal, vigente_desde } = req.body;
    const tipoId = Number(tipo_tramite_id);
    const diasNumero = Number(dias);
    const inicio = vigente_desde || obtenerFechaLocal(new Date(), 'vigente_desde');
    const hoy = obtenerFechaLocal(new Date(), 'hoy');
    if (
        !Number.isInteger(tipoId) || tipoId < 1 ||
        !Number.isInteger(diasNumero) || diasNumero < 1 ||
        !['habiles', 'calendario'].includes(tipo_dias) ||
        typeof fundamento_legal !== 'string' || !fundamento_legal.trim() ||
        !esFechaISO(inicio) || inicio < hoy
    ) {
        return responderError(
            res,
            400,
            'Datos inválidos. El término debe ser positivo, tener fundamento y una vigencia desde hoy o posterior.'
        );
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [tipos] = await connection.execute(
            'SELECT id FROM tipos_tramite WHERE id = ? AND activo = TRUE FOR UPDATE',
            [tipoId]
        );
        if (tipos.length === 0) {
            await connection.rollback();
            return responderError(res, 404, 'No existe un tipo de trámite activo con ese identificador.');
        }

        const [conflictos] = await connection.execute(
            `SELECT id FROM terminos_legales
             WHERE tipo_tramite_id = ? AND vigente_desde >= ? LIMIT 1`,
            [tipoId, inicio]
        );
        if (conflictos.length > 0) {
            await connection.rollback();
            return responderError(
                res,
                409,
                'Ya hay un término configurado desde esa fecha o una fecha posterior; revisa el historial de vigencias.'
            );
        }

        await connection.execute(
            `UPDATE terminos_legales
             SET vigente_hasta = DATE_SUB(?, INTERVAL 1 DAY)
             WHERE tipo_tramite_id = ?
               AND vigente_desde < ?
               AND (vigente_hasta IS NULL OR vigente_hasta >= ?)`,
            [inicio, tipoId, inicio, inicio]
        );
        const [result] = await connection.execute(
            `INSERT INTO terminos_legales
                (tipo_tramite_id, dias, tipo_dias, fundamento_legal, vigente_desde)
             VALUES (?, ?, ?, ?, ?)`,
            [tipoId, diasNumero, tipo_dias, fundamento_legal.trim(), inicio]
        );
        await connection.commit();
        return res.status(201).json({
            success: true,
            termino_legal_id: result.insertId,
            message: 'Nuevo término registrado sin alterar los términos ya aplicados a radicados.'
        });
    } catch (error) {
        await connection.rollback();
        console.error('Error al crear versión del término legal:', error);
        return responderError(res, 500, 'Error interno al actualizar el término legal.');
    } finally {
        connection.release();
    }
});

// Ruta para obtener los radicados con el semáforo calculado
app.get('/api/radicados', async (req, res) => {
    try {
        const filtro = filtroDependencia(req.usuario);
        const [rows] = await pool.query(
            `SELECT r.*,
                    rt.fecha_recepcion AS termino_fecha_recepcion,
                    rt.termino_dias_aplicado AS termino_dias,
                    rt.tipo_dias_aplicado AS termino_tipo_dias,
                    rt.fundamento_legal_aplicado AS termino_fundamento,
                    rt.fecha_limite_inicial AS termino_fecha_limite_inicial,
                    rt.fecha_limite_actual AS termino_fecha_limite_actual,
                    rt.fecha_respuesta AS termino_fecha_respuesta,
                    t.nombre AS termino_nombre_tramite,
                    t.codigo AS termino_codigo_tramite
             FROM radicados AS r
             LEFT JOIN radicado_terminos AS rt ON rt.numero_radicado = r.numero_radicado
             LEFT JOIN tipos_tramite AS t ON t.id = rt.tipo_tramite_id
             WHERE ${filtro.sql}
             ORDER BY r.fecha_creacion DESC`,
            filtro.valores
        );

        return res.status(200).json({
            success: true,
            total: rows.length,
            radicados: rows.map(presentarRadicado)
        });
    } catch (error) {
        console.error("❌ Error al consultar radicados:", error);
        return responderError(res, 500, 'Error interno al obtener los radicados.');
    }
});

app.get('/api/alertas', async (req, res) => {
    try {
        const filtro = filtroDependencia(req.usuario);
        const dependenciaId = req.query.dependencia_id === undefined
            ? null : Number(req.query.dependencia_id);
        if (dependenciaId !== null && (!Number.isInteger(dependenciaId) || dependenciaId < 1)) {
            return responderError(res, 400, 'dependencia_id debe ser un entero positivo.');
        }
        if (req.usuario.rol === 'funcionario' &&
            ((dependenciaId !== null && dependenciaId !== req.usuario.dependencia_id) ||
                (req.query.dependencia !== undefined && req.query.dependencia !== req.usuario.dependencia_nombre))) {
            return responderError(res, 403, 'Solo puedes consultar alertas de tu dependencia.');
        }
        const [rows] = await pool.query(
            `SELECT r.*,
                    rt.fecha_recepcion AS termino_fecha_recepcion,
                    rt.termino_dias_aplicado AS termino_dias,
                    rt.tipo_dias_aplicado AS termino_tipo_dias,
                    rt.fundamento_legal_aplicado AS termino_fundamento,
                    rt.fecha_limite_inicial AS termino_fecha_limite_inicial,
                    rt.fecha_limite_actual AS termino_fecha_limite_actual,
                    rt.fecha_respuesta AS termino_fecha_respuesta,
                    t.nombre AS termino_nombre_tramite,
                    t.codigo AS termino_codigo_tramite
             FROM radicados AS r
             LEFT JOIN radicado_terminos AS rt ON rt.numero_radicado = r.numero_radicado
             LEFT JOIN tipos_tramite AS t ON t.id = rt.tipo_tramite_id
             WHERE ${filtro.sql}
               AND (? IS NULL OR r.dependencia_destino_id = ?)
               AND (? IS NULL OR r.dependencia_destino = ?)
             ORDER BY r.fecha_creacion DESC`,
            [
                ...filtro.valores, dependenciaId, dependenciaId,
                req.query.dependencia || null, req.query.dependencia || null
            ]
        );
        const alertas = rows
            .map(presentarRadicado)
            .filter(({ semaforo }) => ['alerta', 'vencido'].includes(semaforo.nivel));
        return res.json({ success: true, total: alertas.length, alertas });
    } catch (error) {
        console.error('Error al consultar alertas de términos:', error);
        return responderError(res, 500, 'Error interno al consultar alertas.');
    }
});

app.get('/api/radicados/:numero_radicado/historial', autorizarRadicado, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT campo_modificado, valor_anterior, valor_nuevo, usuario, motivo, creado_en
             FROM historial_radicado
             WHERE numero_radicado = ?
             ORDER BY creado_en DESC, id DESC`,
            [req.params.numero_radicado]
        );
        return res.json({ success: true, historial: rows });
    } catch (error) {
        console.error('Error al consultar el historial del radicado:', error);
        return responderError(res, 500, 'Error interno al consultar el historial.');
    }
});

app.post(
    '/api/radicados/:numero_radicado/ampliaciones',
    protegerAdministracion,
    async (req, res) => {
        const { motivo, fundamento_legal, fecha_limite_nueva } = req.body;
        if (
            typeof motivo !== 'string' || !motivo.trim() ||
            typeof fundamento_legal !== 'string' || !fundamento_legal.trim() ||
            !esFechaISO(fecha_limite_nueva)
        ) {
            return responderError(
                res,
                400,
                'Indica un motivo, el fundamento legal y una fecha límite nueva válida.'
            );
        }

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const [radicados] = await connection.execute(
                `SELECT r.estado, rt.fecha_limite_actual
                 FROM radicados AS r
                 JOIN radicado_terminos AS rt ON rt.numero_radicado = r.numero_radicado
                 WHERE r.numero_radicado = ? FOR UPDATE`,
                [req.params.numero_radicado]
            );
            if (radicados.length === 0) {
                await connection.rollback();
                return responderError(res, 404, 'No se encontró el radicado o no tiene término aplicado.');
            }

            const radicado = radicados[0];
            const fechaLimiteAnterior = obtenerFechaLocal(
                radicado.fecha_limite_actual,
                'fecha_limite_actual'
            );
            const hoy = obtenerFechaLocal(new Date(), 'fecha actual');
            if (String(radicado.estado || '').trim().toLowerCase() === 'respondido') {
                await connection.rollback();
                return responderError(res, 409, 'No se puede ampliar un radicado que ya fue respondido.');
            }
            if (hoy > fechaLimiteAnterior) {
                await connection.rollback();
                return responderError(res, 409, 'La ampliación debe registrarse antes del vencimiento.');
            }
            if (fecha_limite_nueva <= fechaLimiteAnterior) {
                await connection.rollback();
                return responderError(res, 400, 'La nueva fecha límite debe ser posterior a la vigente.');
            }

            await connection.execute(
                `INSERT INTO ampliaciones_termino
                    (numero_radicado, fecha_limite_anterior, fecha_limite_nueva, motivo, fundamento_legal)
                 VALUES (?, ?, ?, ?, ?)`,
                [
                    req.params.numero_radicado,
                    fechaLimiteAnterior,
                    fecha_limite_nueva,
                    motivo.trim(),
                    fundamento_legal.trim()
                ]
            );
            await connection.execute(
                `UPDATE radicado_terminos
                 SET fecha_limite_actual = ?
                 WHERE numero_radicado = ?`,
                [fecha_limite_nueva, req.params.numero_radicado]
            );
            await connection.execute(
                `INSERT INTO historial_radicado
                    (numero_radicado, campo_modificado, valor_anterior, valor_nuevo, usuario, motivo)
                 VALUES (?, 'fecha_limite_actual', ?, ?, ?, ?)`,
                [
                    req.params.numero_radicado,
                    fechaLimiteAnterior,
                    fecha_limite_nueva,
                    String(req.usuario.id),
                    `${motivo.trim()} | ${fundamento_legal.trim()}`
                ]
            );
            await connection.commit();
            return res.json({
                success: true,
                fecha_limite_anterior: fechaLimiteAnterior,
                fecha_limite_actual: fecha_limite_nueva,
                message: 'Ampliación registrada. Verifica que se cumplan los requisitos legales aplicables.'
            });
        } catch (error) {
            await connection.rollback();
            console.error('Error al registrar ampliación de término:', error);
            return responderError(res, 500, 'Error interno al registrar la ampliación.');
        } finally {
            connection.release();
        }
    }
);

// Ruta para actualizar el estado de un radicado
app.put(
    '/api/radicados/:numero_radicado/estado',
    permitirRoles('administrador', 'funcionario'),
    async (req, res) => {
        const { numero_radicado } = req.params;
        const { estado } = req.body;

        const estadoNuevo = obtenerEstadoEditable(estado);
        if (!estadoNuevo) {
            return responderError(
                res,
                400,
                'Estado inválido. Los estados editables son: Recibido, En trámite, Pendiente y Respondido.'
            );
        }

        let connection;
        try {
            connection = await pool.getConnection();
            await connection.beginTransaction();
            const filtro = filtroDependencia(req.usuario, 'radicados');
            const [actuales] = await connection.execute(
                `SELECT estado FROM radicados WHERE numero_radicado = ? AND ${filtro.sql} FOR UPDATE`,
                [numero_radicado, ...filtro.valores]
            );
            if (actuales.length === 0) {
                await connection.rollback();
                return responderError(res, 404, 'Radicado no encontrado o fuera de tu dependencia.');
            }

            await connection.execute(
                `UPDATE radicados
             SET estado = ?
             WHERE numero_radicado = ?`,
                [estadoNuevo, numero_radicado]
            );
            await connection.execute(
                `UPDATE radicado_terminos
             SET fecha_respuesta = CASE
                 WHEN LOWER(?) = 'respondido' THEN COALESCE(fecha_respuesta, CURRENT_TIMESTAMP)
                 ELSE NULL
             END
             WHERE numero_radicado = ?`,
                [estadoNuevo, numero_radicado]
            );
            await connection.execute(
                `INSERT INTO historial_radicado
                (numero_radicado, campo_modificado, valor_anterior, valor_nuevo, usuario, motivo)
             VALUES (?, 'estado', ?, ?, ?, 'Cambio de estado del radicado')`,
                [numero_radicado, actuales[0].estado || null, estadoNuevo, String(req.usuario.id)]
            );
            const [rows] = await connection.execute(
                `SELECT r.*,
                    rt.fecha_recepcion AS termino_fecha_recepcion,
                    rt.termino_dias_aplicado AS termino_dias,
                    rt.tipo_dias_aplicado AS termino_tipo_dias,
                    rt.fundamento_legal_aplicado AS termino_fundamento,
                    rt.fecha_limite_inicial AS termino_fecha_limite_inicial,
                    rt.fecha_limite_actual AS termino_fecha_limite_actual,
                    rt.fecha_respuesta AS termino_fecha_respuesta,
                    t.nombre AS termino_nombre_tramite,
                    t.codigo AS termino_codigo_tramite
             FROM radicados AS r
             LEFT JOIN radicado_terminos AS rt ON rt.numero_radicado = r.numero_radicado
             LEFT JOIN tipos_tramite AS t ON t.id = rt.tipo_tramite_id
             WHERE r.numero_radicado = ? LIMIT 1`,
                [numero_radicado]
            );
            const radicadoActualizado = presentarRadicado(rows[0]);
            await connection.commit();
            return res.json({
                success: true,
                message: 'Estado actualizado correctamente',
                estado: radicadoActualizado.estado,
                fecha_respuesta: radicadoActualizado.fecha_respuesta || null,
                tiempo_de_respuesta: radicadoActualizado.tiempo_de_respuesta || null,
                fecha_limite_actual: radicadoActualizado.fecha_limite_actual || null,
                semaforo: radicadoActualizado.semaforo
            });
        } catch (error) {
            if (connection) {
                await connection.rollback();
            }
            console.error('Error al actualizar el estado:', error);
            return responderError(res, 500, 'Error en el servidor al actualizar.');
        } finally {
            if (connection) {
                connection.release();
            }
        }
    });

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error('Error procesando la solicitud:', error);
    if (error.code === 'ER_DUP_ENTRY') {
        return responderError(res, 409, 'El email o nombre ya esta registrado.');
    }
    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
        return responderError(res, 422, 'La dependencia indicada no existe.');
    }
    return responderError(res, 500, 'Error interno del servidor.');
});

// Endpoint para obtener los usuarios filtrados por rol (ej: ?rol=ventanilla)
app.get('/api/usuarios', async (req, res) => {
    try {
        const { rol } = req.query; // Captura el parámetro enviado desde el frontend (?rol=ventanilla)

        let query = 'SELECT id, nombre, email, rol, dependencia_id FROM usuarios';
        let params = [];

        // Si el frontend solicita un rol específico, filtramos en la base de datos MySQL
        if (rol) {
            query += ' WHERE rol = ?';
            params.push(rol);
        }

        const [filas] = await pool.execute(query, params);

        // Devolvemos la lista limpia en formato JSON
        res.json(filas);

    } catch (error) {
        console.error('Error al consultar los usuarios:', error);
        res.status(500).json({ success: false, error: 'Error interno en el servidor' });
    }
});


// Iniciar servidor
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
    });
}

module.exports = app;
