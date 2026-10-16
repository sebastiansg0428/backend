const express = require('express');
const multer = require('multer');
const crearMiddlewareCors = require('./cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const pool = require('./db');
const calcularSemaforoBackend = require('./semaforo');
const { agregarDias, obtenerFechaLocal } = require('./semaforo');
const { normalizarTexto, obtenerTiempoRespuesta } = require('./plazos');
const { obtenerEstadoEditable } = require('./estados');
const { clasificarTipoTramite } = require('./comunicaciones');
const {
    router: authRouter, autenticar, permitirRoles, filtroDependencia, autorizarRadicado
} = require('./auth');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Middlewares esenciales
app.use(crearMiddlewareCors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Asegurar carpeta uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
// Los archivos que salen con una respuesta tienen su propia carpeta.
const uploadRespuestasDir = path.join(uploadDir, 'respuestas');
if (!fs.existsSync(uploadRespuestasDir)) {
    fs.mkdirSync(uploadRespuestasDir, { recursive: true });
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
        // Se admiten subcarpetas controladas (por ejemplo, "respuestas/archivo.pdf"),
        // pero nunca rutas que intenten salir de uploads.
        const rutaNormalizada = path.posix.normalize(nombreArchivo.replace(/\\/g, '/'));
        const rutaFisica = path.resolve(uploadDir, ...rutaNormalizada.split('/'));
        const rutaRelativa = path.relative(uploadDir, rutaFisica);
        if (!nombreArchivo || nombreArchivo.includes('\\') || rutaNormalizada !== nombreArchivo ||
            rutaRelativa.startsWith('..') || path.isAbsolute(rutaRelativa)) {
            return responderError(res, 404, 'Archivo no encontrado.');
        }
        const filtro = filtroDependencia(req.usuario);
        const filtroRespuestaGlobal = req.usuario.rol === 'funcionario'
            ? `AND (r.destino_todas_dependencias = 0 OR rr.id IS NULL OR rr.radicado_dependencia_id IN (
                    SELECT rdx.id FROM radicado_dependencias rdx
                    WHERE rdx.numero_radicado = rr.numero_radicado
                      AND rdx.dependencia_id = ?
               ))`
            : '';
        const [rows] = await pool.execute(
            `SELECT r.id FROM radicados r
             LEFT JOIN documentos_radicado ddoc ON ddoc.numero_radicado = r.numero_radicado
             LEFT JOIN respuestas_radicado rr ON rr.numero_radicado = r.numero_radicado
             LEFT JOIN documentos_respuesta dr ON dr.respuesta_id = rr.id
             WHERE (ddoc.ruta_archivo = ? OR rr.ruta_archivo = ? OR dr.ruta_archivo = ?)
               AND ${filtro.sql} ${filtroRespuestaGlobal} LIMIT 1`,
            [nombreArchivo, nombreArchivo, nombreArchivo, ...filtro.valores,
                ...(req.usuario.rol === 'funcionario' ? [req.usuario.dependencia_id] : [])]
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
        cb(null, `${crypto.randomUUID()}.pdf`);
    }
});

// Multer define dónde y con qué nombre se guarda cada respuesta adjunta.
const storageRespuesta = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadRespuestasDir),
    filename: (req, file, cb) => {
        cb(null, `respuesta-${crypto.randomUUID()}.pdf`);
    }
});

function filtroPdf(req, file, cb) {
    const extensionPdf = path.extname(file.originalname).toLowerCase() === '.pdf';
    const mimeValido = !file.mimetype || file.mimetype === 'application/pdf';
    if (!extensionPdf || !mimeValido) {
        return cb(new Error('Cada documento adjunto debe ser un PDF.'));
    }
    return cb(null, true);
}

const opcionesCargaPdf = {
    limits: { fileSize: 10 * 1024 * 1024, files: 5 },
    fileFilter: filtroPdf
};
const upload = multer({ storage, ...opcionesCargaPdf });
const uploadRespuesta = multer({ storage: storageRespuesta, ...opcionesCargaPdf });

async function esArchivoPdfValido(archivo) {
    if (!archivo || archivo.size < 5) return false;
    const contenido = await fs.promises.readFile(archivo.path);
    if (!/^%PDF-\d\.\d[\r\n]/.test(contenido.subarray(0, 9).toString('ascii')) ||
        !/%%EOF[\x00\t\n\f\r ]*$/.test(contenido.subarray(-1024).toString('latin1'))) {
        return false;
    }
    try {
        const documento = await PDFDocument.load(contenido, {
            throwOnInvalidObject: true,
            updateMetadata: false
        });
        documento.getPages();
        return true;
    } catch (error) {
        console.warn('PDF rechazado durante la validacion de estructura:', error.message);
        return false;
    }
}

// Este intermediario traduce los errores de Multer a mensajes claros y evita
// dejar archivos sueltos si se excede el límite o un archivo no es PDF.
function recibirArchivosRespuesta(req, res, next) {
    uploadRespuesta.array('archivos', 5)(req, res, (error) => {
        if (!error) return next();
        (req.files || []).forEach(eliminarArchivoSubido);
        const mensaje = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_COUNT'
            ? 'Puedes adjuntar máximo 5 archivos PDF.'
            : error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
                ? 'Cada PDF debe pesar máximo 10 MB.'
                : error.message || 'No se pudieron procesar los archivos adjuntos.';
        return responderError(res, 400, mensaje);
    });
}

function recibirArchivosRadicacion(req, res, next) {
    upload.fields([
        { name: 'archivos', maxCount: 5 },
        { name: 'archivo', maxCount: 1 }
    ])(req, res, (error) => {
        const archivosPorCampo = req.files && !Array.isArray(req.files) ? req.files : {};
        const archivos = Array.isArray(req.files)
            ? req.files
            : [...(archivosPorCampo.archivos || []), ...(archivosPorCampo.archivo || [])];
        if (error || archivos.length > 5) {
            archivos.forEach(eliminarArchivoSubido);
            const limiteSuperado = archivos.length > 5 || error?.code === 'LIMIT_FILE_COUNT';
            const limiteTamano = error?.code === 'LIMIT_FILE_SIZE';
            const mensaje = limiteSuperado
                ? 'Puedes adjuntar máximo 5 archivos PDF.'
                : limiteTamano
                    ? 'Cada PDF debe pesar máximo 10 MB.'
                    : error.message || 'No se pudieron procesar los archivos adjuntos.';
            return responderError(res, 400, mensaje);
        }
        req.files = archivos;
        return next();
    });
}

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

function fechaHoraBogota(fecha) {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(fecha).reduce((resultado, parte) => {
        resultado[parte.type] = parte.value;
        return resultado;
    }, {});
    return `${partes.year}-${partes.month}-${partes.day} ${partes.hour}:${partes.minute}:${partes.second}`;
}

function fechaHoraLegibleBogota(fecha) {
    return new Intl.DateTimeFormat('es-CO', {
        timeZone: 'America/Bogota', dateStyle: 'medium', timeStyle: 'medium'
    }).format(fecha);
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
        `SELECT t.id, t.codigo, t.nombre, t.categoria_general, l.id AS termino_legal_id,
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
        seguimiento_estado,
        seguimiento_fecha_respuesta,
        ...datos
    } = radicado;
    const radicadoConTermino = {
        ...datos,
        estado: seguimiento_estado || datos.estado,
        fecha_recepcion: termino_fecha_recepcion || datos.fecha_creacion,
        termino_dias_aplicado: termino_dias,
        tipo_dias_aplicado: termino_tipo_dias,
        fundamento_legal_aplicado: termino_fundamento,
        fecha_limite_inicial: termino_fecha_limite_inicial,
        fecha_limite_actual: termino_fecha_limite_actual,
        fecha_respuesta: datos.destino_todas_dependencias
            ? seguimiento_fecha_respuesta
            : termino_fecha_respuesta,
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
app.post('/api/radicados', permitirRoles('administrador', 'ventanilla'), recibirArchivosRadicacion, async (req, res) => {
    try {
        const archivos = req.files || [];
        if (!archivos.length) {
            return responderError(res, 400, 'Adjunta al menos un archivo PDF.');
        }
        for (const archivo of archivos) {
            if (!await esArchivoPdfValido(archivo)) {
                archivos.forEach(eliminarArchivoSubido);
                return responderError(res, 400, 'Uno o más archivos no contienen un PDF válido.');
            }
        }

        // Extracción limpia de los campos del formulario
        const {
            tipo_recepcion,
            tipo_comunicacion,
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

        if (!['Interna', 'Externa'].includes(tipo_comunicacion)) {
            archivos.forEach(eliminarArchivoSubido);
            return responderError(res, 400, 'La clase de comunicación debe ser Interna o Externa.');
        }

        // Validación obligatoria para evitar errores de base de datos
        if (!asunto_documento || !remitente_nombre || !remitente_documento) {
            archivos.forEach(eliminarArchivoSubido);
            return responderError(res, 400, 'Faltan campos obligatorios (Asunto, Nombre o Documento del remitente).');
        }

        const validarCantidad = (valor, minimo, maximo, predeterminado) => {
            if (valor === undefined || valor === '') return predeterminado;
            if (!/^\d+$/.test(String(valor))) return null;
            const cantidad = Number(valor);
            return Number.isSafeInteger(cantidad) && cantidad >= minimo && cantidad <= maximo
                ? cantidad
                : null;
        };
        const folios = validarCantidad(numero_folios, 1, 2147483647, 1);
        if (folios === null) {
            archivos.forEach(eliminarArchivoSubido);
            return responderError(res, 400, 'El número de folios debe ser una cantidad entera positiva.');
        }
        const tipoRecepcion = tipo_recepcion === undefined || tipo_recepcion === ''
            ? 'Digital'
            : tipo_recepcion;
        if (!['Digital', 'Fisico'].includes(tipoRecepcion)) {
            archivos.forEach(eliminarArchivoSubido);
            return responderError(res, 400, 'El canal de recepción debe ser físico o digital.');
        }

        let dependencia;
        let destinoTodasDependencias = false;
        if (dependencia_destino_id === 'todas') {
            destinoTodasDependencias = true;
            dependencia = { id: null, nombre: 'Todas las dependencias' };
        } else if (dependencia_destino_id !== undefined) {
            const id = Number(dependencia_destino_id);
            if (!Number.isInteger(id) || id < 1) {
                archivos.forEach(eliminarArchivoSubido);
                return responderError(res, 400, 'dependencia_destino_id debe ser un entero positivo.');
            }
            const [rows] = await pool.execute('SELECT id, nombre FROM dependencias WHERE id = ? AND activo = 1', [id]);
            dependencia = rows[0];
        } else if (typeof dependencia_destino === 'string' && dependencia_destino.trim()) {
            const [rows] = await pool.execute(
                'SELECT id, nombre FROM dependencias WHERE nombre = ? AND activo = 1',
                [dependencia_destino.trim()]
            );
            dependencia = rows[0];
        }
        if (!dependencia) {
            archivos.forEach(eliminarArchivoSubido);
            return responderError(res, 422, 'Selecciona una dependencia activa del catalogo.');
        }

        if (
            tipo_tramite_id &&
            (!Number.isInteger(Number(tipo_tramite_id)) || Number(tipo_tramite_id) < 1)
        ) {
            archivos.forEach(eliminarArchivoSubido);
            return responderError(res, 400, 'tipo_tramite_id debe ser un entero positivo.');
        }

        const instanteRecepcion = new Date();
        const fechaRecepcion = obtenerFechaLocal(instanteRecepcion, 'fecha_recepcion');
        const fechaHoraRecepcion = fechaHoraBogota(instanteRecepcion);
        const termino = await obtenerTerminoVigente({
            tipoTramiteId: tipo_tramite_id ? Number(tipo_tramite_id) : null,
            tipoDocumento: tipo_documento,
            fecha: fechaRecepcion
        });
        if (!termino) {
            archivos.forEach(eliminarArchivoSubido);
            return responderError(
                res,
                422,
                'El tipo de trámite no tiene un término vigente configurado. Selecciona un tipo válido o solicita su configuración al administrador.'
            );
        }
        const tipoComunicacion = tipo_comunicacion;
        const fechaLimite = agregarDias(fechaRecepcion, termino.dias, termino.tipo_dias);
        const tiempoRespuesta = obtenerTiempoRespuesta(termino);
        const query = `
            INSERT INTO radicados 
            (numero_radicado, tipo_recepcion, tipo_comunicacion, tipo_documento, tiempo_de_respuesta, remitente_nombre, remitente_documento, remitente_entidad, remitente_nit, remitente_telefono, remitente_email, numero_folios, fecha_hora_recepcion, dependencia_destino, asunto_documento, usuario_recibe, dependencia_destino_id, destino_todas_dependencias)
            VALUES (?, ?, ?, ?, ?,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?)
        `;

        const connection = await pool.getConnection();
        let numeroRadicado;
        try {
            await connection.beginTransaction();
            const anoRadicacion = Number(fechaRecepcion.slice(0, 4));
            await connection.execute(
                `INSERT INTO secuencias_radicado (ano, ultimo_numero)
                 VALUES (?, 0) ON DUPLICATE KEY UPDATE ano = VALUES(ano)`,
                [anoRadicacion]
            );
            const [secuencias] = await connection.execute(
                'SELECT ultimo_numero FROM secuencias_radicado WHERE ano = ? FOR UPDATE',
                [anoRadicacion]
            );
            let consecutivo = Number(secuencias[0].ultimo_numero) + 1;
            const fechaNumeroRadicado = fechaRecepcion.replace(/-/g, '');
            while (true) {
                numeroRadicado = `RAD-${fechaNumeroRadicado}-${String(consecutivo).padStart(4, '0')}`;
                const [coincidencias] = await connection.execute(
                    `SELECT numero_radicado FROM radicados WHERE numero_radicado = ?
                     UNION ALL
                     SELECT numero_radicado FROM radicado_terminos WHERE numero_radicado = ?
                     LIMIT 1`,
                    [numeroRadicado, numeroRadicado]
                );
                if (!coincidencias.length) break;
                consecutivo++;
            }
            await connection.execute(
                'UPDATE secuencias_radicado SET ultimo_numero = ? WHERE ano = ?',
                [consecutivo, anoRadicacion]
            );

            const values = [
                numeroRadicado,
                tipoRecepcion,
                tipoComunicacion,
                termino.nombre,
                tiempoRespuesta,
                remitente_nombre,
                remitente_documento,
                remitente_entidad || null,
                remitente_nit || null,
                remitente_telefono || 'No especificado',
                remitente_email || null,
                folios,
                fechaHoraRecepcion,
                dependencia.nombre,
                asunto_documento,
                req.usuario.nombre,
                dependencia.id,
                destinoTodasDependencias ? 1 : 0
            ];
            await connection.execute(query, values);
            if (destinoTodasDependencias) {
                await connection.execute(
                    `INSERT INTO radicado_dependencias (numero_radicado, dependencia_id)
                     SELECT ?, id FROM dependencias WHERE activo = 1`,
                    [numeroRadicado]
                );
            }
            const tablaComunicacion = tipoComunicacion === 'Interna'
                ? 'comunicaciones_internas'
                : 'comunicaciones_externas';
            await connection.execute(
                `INSERT INTO ${tablaComunicacion} (numero_radicado) VALUES (?)`,
                [numeroRadicado]
            );
            for (const archivo of archivos) {
                await connection.execute(
                    `INSERT INTO documentos_radicado
                        (numero_radicado, nombre_archivo, ruta_archivo, tipo_mime, tamano_bytes)
                     VALUES (?, ?, ?, ?, ?)`,
                    [numeroRadicado, archivo.originalname, archivo.filename, archivo.mimetype, archivo.size]
                );
            }
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
            fecha_hora_recepcion: fechaHoraRecepcion,
            fecha_hora_recepcion_legible: fechaHoraLegibleBogota(instanteRecepcion),
            dependencia_destino: dependencia.nombre,
            destino_todas_dependencias: destinoTodasDependencias,
            termino: {
                dias: termino.dias,
                tipo_dias: termino.tipo_dias,
                fundamento_legal: termino.fundamento_legal,
                fecha_limite: fechaLimite
            },
            tipo_comunicacion: tipoComunicacion
        });

    } catch (error) {
        console.error('❌ Error crítico al procesar el radicado:', error);

        (req.files || []).forEach(eliminarArchivoSubido);

        return responderError(res, 500, 'Error interno del servidor al guardar el registro.');
    }
});

app.get('/api/tipos-tramite', async (req, res) => {
    const incluirInactivos = req.query.incluir_inactivos;
    if (incluirInactivos !== undefined && incluirInactivos !== '0' && incluirInactivos !== '1') {
        return responderError(res, 400, 'incluir_inactivos debe ser 0 o 1.');
    }
    if (incluirInactivos === '1' && req.usuario.rol !== 'administrador') {
        return responderError(res, 403, 'Solo el administrador puede consultar el catalogo completo.');
    }
    try {
        const hoy = obtenerFechaLocal(new Date(), 'fecha actual');
        const [rows] = await pool.query(
            `SELECT t.id, t.codigo, t.nombre, t.categoria_general, t.orden, t.activo,
                    l.id AS termino_legal_id, l.dias, l.tipo_dias, l.fundamento_legal
             FROM tipos_tramite AS t
             LEFT JOIN terminos_legales AS l
               ON l.tipo_tramite_id = t.id
              AND l.vigente_desde <= ?
              AND (l.vigente_hasta IS NULL OR l.vigente_hasta >= ?)
             WHERE (t.activo = TRUE OR ? = 1)
             ORDER BY COALESCE(NULLIF(t.orden, 0), 999) ASC, t.id ASC`,
            [hoy, hoy, incluirInactivos === '1' ? 1 : 0]
        );
        return res.json({
            success: true,
            tipos_tramite: rows.map((tipo) => ({
                ...tipo,
                tipo_comunicacion: clasificarTipoTramite(tipo.codigo)
            }))
        });
    } catch (error) {
        console.error('Error al consultar los tipos de trámite:', error);
        return responderError(res, 500, 'Error interno al consultar los tipos de trámite.');
    }
});

app.get('/api/tipos-tramite/:id', protegerAdministracion, async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
        return responderError(res, 400, 'ID de tipo de tramite invalido.');
    }
    try {
        const [rows] = await pool.execute(
            'SELECT id, codigo, nombre, categoria_general, orden, activo FROM tipos_tramite WHERE id = ?',
            [id]
        );
        if (!rows.length) return responderError(res, 404, 'Tipo de tramite no encontrado.');
        return res.json({
            success: true,
            tipo_tramite: {
                ...rows[0],
                tipo_comunicacion: clasificarTipoTramite(rows[0].codigo)
            }
        });
    } catch (error) { next(error); }
});

app.put('/api/tipos-tramite/:id', protegerAdministracion, async (req, res, next) => {
    const id = Number(req.params.id);
    const { codigo, nombre, categoria_general, orden } = req.body || {};
    if (!Number.isSafeInteger(id) || id < 1 ||
        typeof codigo !== 'string' || !/^[a-z0-9_]{2,60}$/.test(codigo) ||
        typeof nombre !== 'string' || !nombre.trim() || nombre.trim().length > 150 ||
        !CATEGORIAS_TRAMITE.has(categoria_general) ||
        (orden !== undefined && (!Number.isInteger(orden) || orden < 0 || orden > 2147483647)) ||
        ['dias', 'tipo_dias', 'fundamento_legal', 'vigente_desde', 'vigente_hasta', 'activo']
            .some(campo => req.body?.[campo] !== undefined)) {
        return responderError(res, 400, 'Datos de catalogo invalidos. Usa las rutas de terminos legales y estado para modificar vigencia o activacion.');
    }
    try {
        const [result] = await pool.execute(
            `UPDATE tipos_tramite SET codigo = ?, nombre = ?, categoria_general = ?,
                orden = COALESCE(?, orden) WHERE id = ?`,
            [codigo, nombre.trim(), categoria_general, orden ?? null, id]
        );
        if (!result.affectedRows) return responderError(res, 404, 'Tipo de tramite no encontrado.');
        return res.json({
            success: true, tipo_tramite: { id, codigo, nombre: nombre.trim(), categoria_general },
            message: 'Tipo de tramite actualizado sin alterar los terminos aplicados.'
        });
    } catch (error) { next(error); }
});

app.patch('/api/tipos-tramite/:id/estado', protegerAdministracion, async (req, res, next) => {
    const id = Number(req.params.id);
    const activo = req.body?.activo;
    if (!Number.isSafeInteger(id) || id < 1 || (activo !== 0 && activo !== 1)) {
        return responderError(res, 400, 'Indica un ID valido y activo como 0 o 1.');
    }
    try {
        const [result] = await pool.execute('UPDATE tipos_tramite SET activo = ? WHERE id = ?', [activo, id]);
        if (!result.affectedRows) return responderError(res, 404, 'Tipo de tramite no encontrado.');
        return res.json({
            success: true, tipo_tramite: { id, activo },
            message: activo === 1 ? 'Tipo de tramite activado.' : 'Tipo de tramite inactivado.'
        });
    } catch (error) { next(error); }
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
    } = req.body || {};
    const diasNumero = Number(dias);
    const inicio = vigente_desde || obtenerFechaLocal(new Date(), 'vigente_desde');
    if (
        typeof codigo !== 'string' || !/^[a-z0-9_]{2,60}$/.test(codigo) ||
        typeof nombre !== 'string' || !nombre.trim() || nombre.trim().length > 150 ||
        !CATEGORIAS_TRAMITE.has(categoria_general) ||
        !Number.isInteger(diasNumero) || diasNumero < 1 || diasNumero > 2147483647 ||
        !['habiles', 'calendario'].includes(tipo_dias) ||
        typeof fundamento_legal !== 'string' || !fundamento_legal.trim() || fundamento_legal.trim().length > 500 ||
        !esFechaISO(inicio)
    ) {
        return responderError(
            res,
            400,
            'Datos inválidos: revisa código, nombre, categoría, término, tipo de días, fundamento y vigencia.'
        );
    }

    let connection;
    try {
        connection = await pool.getConnection();
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
        if (connection) await connection.rollback();
        if (error.code === 'ER_DUP_ENTRY') {
            return responderError(res, 409, 'Ya existe un tipo de trámite con ese código o nombre.');
        }
        console.error('Error al crear tipo de trámite:', error);
        return responderError(res, 500, 'Error interno al crear el tipo de trámite.');
    } finally {
        if (connection) connection.release();
    }
});

app.post('/api/terminos-legales', protegerAdministracion, async (req, res) => {
    const { tipo_tramite_id, dias, tipo_dias, fundamento_legal, vigente_desde } = req.body || {};
    const tipoId = Number(tipo_tramite_id);
    const diasNumero = Number(dias);
    const inicio = vigente_desde || obtenerFechaLocal(new Date(), 'vigente_desde');
    const hoy = obtenerFechaLocal(new Date(), 'hoy');
    if (
        !Number.isSafeInteger(tipoId) || tipoId < 1 ||
        !Number.isInteger(diasNumero) || diasNumero < 1 || diasNumero > 2147483647 ||
        !['habiles', 'calendario'].includes(tipo_dias) ||
        typeof fundamento_legal !== 'string' || !fundamento_legal.trim() || fundamento_legal.trim().length > 500 ||
        !esFechaISO(inicio) || inicio < hoy
    ) {
        return responderError(
            res,
            400,
            'Datos inválidos. El término debe ser positivo, tener fundamento y una vigencia desde hoy o posterior.'
        );
    }

    let connection;
    try {
        connection = await pool.getConnection();
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
        if (connection) await connection.rollback();
        console.error('Error al crear versión del término legal:', error);
        return responderError(res, 500, 'Error interno al actualizar el término legal.');
    } finally {
        if (connection) connection.release();
    }
});

// Ruta para obtener los radicados con el semáforo calculado
app.get('/api/radicados', async (req, res) => {
    const claseSolicitada = req.query.tipo_comunicacion;
    if (claseSolicitada !== undefined &&
        (typeof claseSolicitada !== 'string' ||
            !['interna', 'externa'].includes(claseSolicitada.trim().toLowerCase()))) {
        return responderError(res, 400, 'tipo_comunicacion debe ser Interna o Externa.');
    }
    try {
        const filtro = filtroDependencia(req.usuario);
        const claseNormalizada = typeof claseSolicitada === 'string'
            ? claseSolicitada.trim().toLowerCase()
            : null;
        const filtroClase = claseNormalizada === 'interna'
            ? `AND EXISTS (
                   SELECT 1 FROM comunicaciones_internas AS ci
                   WHERE ci.numero_radicado = r.numero_radicado
               )`
            : claseNormalizada === 'externa'
                ? `AND EXISTS (
                       SELECT 1 FROM comunicaciones_externas AS ce
                       WHERE ce.numero_radicado = r.numero_radicado
                   )`
                : '';
        const dependenciaSeguimiento = req.usuario.rol === 'funcionario'
            ? req.usuario.dependencia_id : null;
        const [rows] = await pool.query(
            `SELECT r.*,
                    rd.id AS radicado_dependencia_id,
                    rd.dependencia_id AS seguimiento_dependencia_id,
                    d.nombre AS seguimiento_dependencia_nombre,
                    rd.estado AS seguimiento_estado,
                    rd.fecha_respuesta AS seguimiento_fecha_respuesta,
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
             LEFT JOIN radicado_dependencias rd
               ON rd.numero_radicado = r.numero_radicado
              AND r.destino_todas_dependencias = 1
              AND (? IS NULL OR rd.dependencia_id = ?)
             LEFT JOIN dependencias d ON d.id = rd.dependencia_id
             LEFT JOIN radicado_terminos AS rt ON rt.numero_radicado = r.numero_radicado
             LEFT JOIN tipos_tramite AS t ON t.id = rt.tipo_tramite_id
             WHERE ${filtro.sql}
               ${filtroClase}
             ORDER BY r.fecha_creacion DESC`,
            [dependenciaSeguimiento, dependenciaSeguimiento, ...filtro.valores]
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
        const esFuncionario = req.usuario.rol === 'funcionario';
        const dependenciaId = req.query.dependencia_id === undefined
            ? null : Number(req.query.dependencia_id);
        if (dependenciaId !== null && (!Number.isInteger(dependenciaId) || dependenciaId < 1)) {
            return responderError(res, 400, 'dependencia_id debe ser un entero positivo.');
        }
        if (esFuncionario &&
            ((dependenciaId !== null && dependenciaId !== req.usuario.dependencia_id) ||
                (req.query.dependencia !== undefined && req.query.dependencia !== req.usuario.dependencia_nombre))) {
            return responderError(res, 403, 'Solo puedes consultar alertas de tu dependencia.');
        }
        const dependenciaFiltroId = esFuncionario ? req.usuario.dependencia_id : dependenciaId;
        const dependenciaFiltroNombre = esFuncionario ? null : (req.query.dependencia || null);
        const [rows] = await pool.query(
            `SELECT r.*,
                    rd.id AS radicado_dependencia_id,
                    rd.dependencia_id AS seguimiento_dependencia_id,
                    d.nombre AS seguimiento_dependencia_nombre,
                    rd.estado AS seguimiento_estado,
                    rd.fecha_respuesta AS seguimiento_fecha_respuesta,
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
             LEFT JOIN radicado_dependencias rd
               ON rd.numero_radicado = r.numero_radicado
              AND r.destino_todas_dependencias = 1
              AND (? IS NULL OR rd.dependencia_id = ?)
             LEFT JOIN dependencias d ON d.id = rd.dependencia_id
             LEFT JOIN radicado_terminos AS rt ON rt.numero_radicado = r.numero_radicado
             LEFT JOIN tipos_tramite AS t ON t.id = rt.tipo_tramite_id
             WHERE ${filtro.sql}
               AND (? IS NULL OR (r.destino_todas_dependencias = 1 AND rd.dependencia_id = ?) OR
                    (r.destino_todas_dependencias = 0 AND r.dependencia_destino_id = ?))
               AND (? IS NULL OR (r.destino_todas_dependencias = 1 AND d.nombre = ?) OR
                    (r.destino_todas_dependencias = 0 AND r.dependencia_destino = ?))
             ORDER BY r.fecha_creacion DESC`,
            [
                dependenciaFiltroId, dependenciaFiltroId,
                ...filtro.valores,
                dependenciaFiltroId, dependenciaFiltroId, dependenciaFiltroId,
                dependenciaFiltroNombre, dependenciaFiltroNombre, dependenciaFiltroNombre
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

app.get('/api/radicados/:numero_radicado/documentos', autorizarRadicado, async (req, res) => {
    try {
        const [documentos] = await pool.execute(
            `SELECT id, nombre_archivo, ruta_archivo, tipo_mime, tamano_bytes
             FROM documentos_radicado WHERE numero_radicado = ? ORDER BY id`,
            [req.params.numero_radicado]
        );
        return res.json({ success: true, documentos });
    } catch (error) {
        console.error('Error al consultar documentos del radicado:', error);
        return responderError(res, 500, 'Error interno al consultar los documentos.');
    }
});

// Ventanilla puede consultar la respuesta para orientar al ciudadano;
// autorizarRadicado mantiene a los funcionarios limitados a su dependencia.
app.get('/api/radicados/:numero_radicado/respuesta', autorizarRadicado, async (req, res) => {
    try {
        const [radicados] = await pool.execute(
            'SELECT destino_todas_dependencias FROM radicados WHERE numero_radicado = ?',
            [req.params.numero_radicado]
        );
        let idAsignacion = null;
        if (radicados[0]?.destino_todas_dependencias) {
            if (req.usuario.rol === 'funcionario') {
                const [asignaciones] = await pool.execute(
                    `SELECT id FROM radicado_dependencias
                     WHERE numero_radicado = ? AND dependencia_id = ?`,
                    [req.params.numero_radicado, req.usuario.dependencia_id]
                );
                idAsignacion = asignaciones[0]?.id;
            } else {
                const solicitado = Number(req.query.radicado_dependencia_id);
                if (!Number.isSafeInteger(solicitado) || solicitado < 1) {
                    return responderError(res, 400, 'Selecciona la dependencia de seguimiento para consultar la respuesta.');
                }
                idAsignacion = solicitado;
            }
        }
        const [respuestas] = await pool.execute(
            `SELECT rr.id, rr.numero_radicado, rr.contenido, rr.plantilla,
                    rr.fecha_envio, u.nombre AS funcionario_nombre,
                    rd.dependencia_id AS seguimiento_dependencia_id
             FROM respuestas_radicado rr
             LEFT JOIN usuarios u ON u.id = rr.usuario_id
             LEFT JOIN radicado_dependencias rd ON rd.id = rr.radicado_dependencia_id
             WHERE rr.numero_radicado = ?
               AND ((? IS NOT NULL AND rr.radicado_dependencia_id = ?) OR
                    (? IS NULL AND rr.radicado_dependencia_id IS NULL))
             LIMIT 1`,
            [req.params.numero_radicado, idAsignacion, idAsignacion, idAsignacion]
        );
        if (!respuestas.length) {
            return responderError(res, 404, 'Este radicado todavía no tiene una respuesta institucional.');
        }
        const respuesta = respuestas[0];
        const [documentos] = await pool.execute(
            `SELECT id, nombre_archivo, ruta_archivo, tamano_bytes
             FROM documentos_respuesta WHERE respuesta_id = ? ORDER BY id`,
            [respuesta.id]
        );
        return res.json({ success: true, respuesta: { ...respuesta, documentos } });
    } catch (error) {
        console.error('Error al consultar respuesta institucional:', error);
        return responderError(res, 500, 'No se pudo consultar la respuesta institucional.');
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
app.post(
    '/api/radicados/:numero_radicado/respuesta',
    permitirRoles('administrador', 'funcionario'),
    recibirArchivosRespuesta,
    async (req, res) => {
        const numeroRadicado = req.params.numero_radicado;
        const contenido = typeof req.body.contenido === 'string' ? req.body.contenido.trim() : '';
        const plantilla = typeof req.body.plantilla === 'string' ? req.body.plantilla.trim() : '';
        if (contenido.length < 10 || contenido.length > 10000) {
            (req.files || []).forEach(eliminarArchivoSubido);
            return responderError(res, 400, 'La respuesta debe tener entre 10 y 10.000 caracteres.');
        }
        let connection;
        try {
            for (const archivo of req.files || []) {
                if (!await esArchivoPdfValido(archivo)) {
                    (req.files || []).forEach(eliminarArchivoSubido);
                    return responderError(res, 400, 'Uno o más archivos no contienen un PDF válido.');
                }
            }
            connection = await pool.getConnection();
            // Guardamos respuesta, PDFs, cambio de estado y fecha en una sola
            // transacción: si una parte falla, no queda una respuesta incompleta.
            await connection.beginTransaction();
            const filtro = filtroDependencia(req.usuario, 'r');
            const [radicados] = await connection.execute(
                `SELECT r.estado, r.destino_todas_dependencias FROM radicados r
                 WHERE r.numero_radicado = ? AND ${filtro.sql} FOR UPDATE`,
                [numeroRadicado, ...filtro.valores]
            );
            if (!radicados.length) {
                await connection.rollback(); (req.files || []).forEach(eliminarArchivoSubido);
                return responderError(res, 404, 'Radicado no encontrado o fuera de tu dependencia.');
            }
            let idAsignacion = null;
            let estadoActual = radicados[0].estado;
            if (radicados[0].destino_todas_dependencias) {
                let dependenciaObjetivo = req.usuario.dependencia_id;
                if (req.usuario.rol !== 'funcionario') {
                    const idSolicitado = Number(req.body.radicado_dependencia_id);
                    if (!Number.isSafeInteger(idSolicitado) || idSolicitado < 1) {
                        await connection.rollback(); (req.files || []).forEach(eliminarArchivoSubido);
                        return responderError(res, 400, 'Selecciona la dependencia de seguimiento para responder.');
                    }
                    const [objetivos] = await connection.execute(
                        `SELECT id, dependencia_id, estado FROM radicado_dependencias
                         WHERE id = ? AND numero_radicado = ? FOR UPDATE`,
                        [idSolicitado, numeroRadicado]
                    );
                    if (!objetivos.length) {
                        await connection.rollback(); (req.files || []).forEach(eliminarArchivoSubido);
                        return responderError(res, 404, 'La asignación de dependencia no existe.');
                    }
                    idAsignacion = objetivos[0].id;
                    dependenciaObjetivo = objetivos[0].dependencia_id;
                    estadoActual = objetivos[0].estado;
                } else {
                    const [objetivos] = await connection.execute(
                        `SELECT id, estado FROM radicado_dependencias
                         WHERE numero_radicado = ? AND dependencia_id = ? FOR UPDATE`,
                        [numeroRadicado, dependenciaObjetivo]
                    );
                    if (!objetivos.length) {
                        await connection.rollback(); (req.files || []).forEach(eliminarArchivoSubido);
                        return responderError(res, 404, 'El radicado no está asignado a tu dependencia.');
                    }
                    idAsignacion = objetivos[0].id;
                    estadoActual = objetivos[0].estado;
                }
            }
            if (String(estadoActual || '').toLowerCase() === 'respondido') {
                await connection.rollback(); (req.files || []).forEach(eliminarArchivoSubido);
                return responderError(res, 409, 'Este radicado ya fue respondido.');
            }
            const [existente] = await connection.execute(
                idAsignacion
                    ? 'SELECT id FROM respuestas_radicado WHERE radicado_dependencia_id = ? LIMIT 1'
                    : 'SELECT id FROM respuestas_radicado WHERE numero_radicado = ? AND radicado_dependencia_id IS NULL LIMIT 1',
                [idAsignacion || numeroRadicado]
            );
            if (existente.length) {
                await connection.rollback(); (req.files || []).forEach(eliminarArchivoSubido);
                return responderError(res, 409, 'Ya existe una respuesta registrada para este radicado.');
            }
            const [resultadoRespuesta] = await connection.execute(
                `INSERT INTO respuestas_radicado (numero_radicado, radicado_dependencia_id, contenido, plantilla, nombre_archivo, ruta_archivo, usuario_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [numeroRadicado, idAsignacion, contenido, plantilla || null, req.files?.[0]?.originalname || null,
                    req.files?.[0] ? `respuestas/${req.files[0].filename}` : null, req.usuario.id]
            );
            const idRespuesta = resultadoRespuesta.insertId;
            // Cada PDF queda en su propia fila y relacionado con la respuesta creada.
            for (const archivo of req.files || []) {
                await connection.execute(
                    `INSERT INTO documentos_respuesta (respuesta_id, nombre_archivo, ruta_archivo, tipo_mime, tamano_bytes)
                     VALUES (?, ?, ?, ?, ?)`,
                    [idRespuesta, archivo.originalname, `respuestas/${archivo.filename}`, archivo.mimetype, archivo.size]
                );
            }
            if (idAsignacion) {
                await connection.execute(
                    `UPDATE radicado_dependencias SET estado = 'Respondido',
                     fecha_respuesta = COALESCE(fecha_respuesta, CURRENT_TIMESTAMP) WHERE id = ?`,
                    [idAsignacion]
                );
            } else {
                await connection.execute("UPDATE radicados SET estado = 'Respondido' WHERE numero_radicado = ?", [numeroRadicado]);
                await connection.execute(
                    `UPDATE radicado_terminos SET fecha_respuesta = COALESCE(fecha_respuesta, CURRENT_TIMESTAMP) WHERE numero_radicado = ?`,
                    [numeroRadicado]
                );
            }
            await connection.execute(
                `INSERT INTO historial_radicado (numero_radicado, campo_modificado, valor_anterior, valor_nuevo, usuario, motivo)
                 VALUES (?, 'estado', ?, 'Respondido', ?, 'Respuesta institucional enviada')`,
                [numeroRadicado, estadoActual || 'Recibido', String(req.usuario.id)]
            );
            await connection.commit();
            const fechaRespuesta = new Date().toISOString();
            // La respuesta termina el trámite; devolvemos el semáforo ya recalculado
            // para que la tabla no conserve el valor anterior de React.
            const semaforo = calcularSemaforoBackend({ estado: 'Respondido', fecha_respuesta: fechaRespuesta });
            return res.status(201).json({
                success: true,
                estado: 'Respondido',
                fecha_respuesta: fechaRespuesta,
                semaforo
            });
        } catch (error) {
            if (connection) await connection.rollback();
            // MySQL no administra los archivos del disco; por eso los borramos
            // manualmente cuando la transacción no se pudo completar.
            (req.files || []).forEach(eliminarArchivoSubido);
            if (error instanceof multer.MulterError) return responderError(res, 400, 'El archivo supera el límite de 10 MB o no se pudo procesar.');
            console.error('Error al registrar respuesta institucional:', error);
            return responderError(res, 500, 'Error interno al guardar la respuesta.');
        } finally {
            if (connection) connection.release();
        }
    }
);

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
                `SELECT estado, destino_todas_dependencias FROM radicados
                 WHERE numero_radicado = ? AND ${filtro.sql} FOR UPDATE`,
                [numero_radicado, ...filtro.valores]
            );
            if (actuales.length === 0) {
                await connection.rollback();
                return responderError(res, 404, 'Radicado no encontrado o fuera de tu dependencia.');
            }

            let idAsignacion = null;
            let estadoAnterior = actuales[0].estado;
            if (actuales[0].destino_todas_dependencias) {
                if (req.usuario.rol === 'funcionario') {
                    const [asignaciones] = await connection.execute(
                        `SELECT id, estado FROM radicado_dependencias
                         WHERE numero_radicado = ? AND dependencia_id = ? FOR UPDATE`,
                        [numero_radicado, req.usuario.dependencia_id]
                    );
                    if (!asignaciones.length) {
                        await connection.rollback();
                        return responderError(res, 404, 'El radicado no está asignado a tu dependencia.');
                    }
                    idAsignacion = asignaciones[0].id;
                    estadoAnterior = asignaciones[0].estado;
                } else {
                    const idSolicitado = Number(req.body.radicado_dependencia_id);
                    if (!Number.isSafeInteger(idSolicitado) || idSolicitado < 1) {
                        await connection.rollback();
                        return responderError(res, 400, 'Selecciona la dependencia de seguimiento para cambiar el estado.');
                    }
                    const [asignaciones] = await connection.execute(
                        `SELECT id, estado FROM radicado_dependencias
                         WHERE id = ? AND numero_radicado = ? FOR UPDATE`,
                        [idSolicitado, numero_radicado]
                    );
                    if (!asignaciones.length) {
                        await connection.rollback();
                        return responderError(res, 404, 'La asignación de dependencia no existe.');
                    }
                    idAsignacion = asignaciones[0].id;
                    estadoAnterior = asignaciones[0].estado;
                }
                await connection.execute(
                    `UPDATE radicado_dependencias SET estado = ?,
                     fecha_respuesta = CASE WHEN LOWER(?) = 'respondido'
                         THEN COALESCE(fecha_respuesta, CURRENT_TIMESTAMP) ELSE NULL END
                     WHERE id = ?`,
                    [estadoNuevo, estadoNuevo, idAsignacion]
                );
            } else {
                await connection.execute(
                    `UPDATE radicados SET estado = ? WHERE numero_radicado = ?`,
                    [estadoNuevo, numero_radicado]
                );
                await connection.execute(
                    `UPDATE radicado_terminos SET fecha_respuesta = CASE
                     WHEN LOWER(?) = 'respondido' THEN COALESCE(fecha_respuesta, CURRENT_TIMESTAMP)
                     ELSE NULL END WHERE numero_radicado = ?`,
                    [estadoNuevo, numero_radicado]
                );
            }
            await connection.execute(
                `INSERT INTO historial_radicado
                (numero_radicado, campo_modificado, valor_anterior, valor_nuevo, usuario, motivo)
             VALUES (?, 'estado', ?, ?, ?, 'Cambio de estado del radicado')`,
                [numero_radicado, estadoAnterior || null, estadoNuevo, String(req.usuario.id)]
            );
            const [rows] = await connection.execute(
                `SELECT r.*,
                    rt.fecha_recepcion AS termino_fecha_recepcion,
                    rt.termino_dias_aplicado AS termino_dias,
                    rt.tipo_dias_aplicado AS termino_tipo_dias,
                    rt.fundamento_legal_aplicado AS termino_fundamento,
                    rt.fecha_limite_inicial AS termino_fecha_limite_inicial,
                    rt.fecha_limite_actual AS termino_fecha_limite_actual,
                    COALESCE(rd.fecha_respuesta, rt.fecha_respuesta) AS termino_fecha_respuesta,
                    rd.id AS radicado_dependencia_id,
                    rd.dependencia_id AS seguimiento_dependencia_id,
                    d.nombre AS seguimiento_dependencia_nombre,
                    rd.estado AS seguimiento_estado,
                    rd.fecha_respuesta AS seguimiento_fecha_respuesta,
                    t.nombre AS termino_nombre_tramite,
                    t.codigo AS termino_codigo_tramite
             FROM radicados AS r
             LEFT JOIN radicado_dependencias rd ON rd.id = ? AND rd.numero_radicado = r.numero_radicado
             LEFT JOIN dependencias d ON d.id = rd.dependencia_id
             LEFT JOIN radicado_terminos AS rt ON rt.numero_radicado = r.numero_radicado
             LEFT JOIN tipos_tramite AS t ON t.id = rt.tipo_tramite_id
             WHERE r.numero_radicado = ? LIMIT 1`,
                [idAsignacion, numero_radicado]
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

// Iniciar servidor
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
    });
}

module.exports = app;
