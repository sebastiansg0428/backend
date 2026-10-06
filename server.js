const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pool = require('./db');
const calcularSemaforoBackend = require('./semaforo');
const { obtenerTiempoRespuesta } = require('./plazos');

const app = express();
const PORT = 3000;

// Middlewares esenciales
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Asegurar carpeta uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// ⚠️ ¡ESTO ES LO QUE FALTABA! Exponer la carpeta uploads públicamente para ver los PDF
app.use('/uploads', express.static(uploadDir));

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

// Ruta POST principal para registrar el radicado
app.post('/api/radicados', upload.single('archivo'), async (req, res) => {
    try {
        console.log("📥 Datos recibidos del formulario:", req.body);

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'El archivo PDF adjunto es obligatorio.'
            });
        }

        // Extracción limpia de los campos del formulario
        const {
            tipo_comunicacion,
            tipo_recepcion,
            tipo_documento,
            remitente_nombre,
            remitente_documento,
            remitente_entidad,
            remitente_nit,
            remitente_telefono,
            remitente_email,
            numero_folios,
            dependencia_destino,
            asunto_documento,
            usuario_recibe
        } = req.body;

        // Validación obligatoria para evitar errores de base de datos
        if (!asunto_documento || !remitente_nombre || !remitente_documento) {
            return res.status(400).json({
                success: false,
                message: 'Faltan campos obligatorios (Asunto, Nombre o Documento del remitente).'
            });
        }

        // Generar número de radicado único (Ej: RAD-20260930-4821)
        const fechaHoy = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const numeroRadicado = `RAD-${fechaHoy}-${Math.floor(1000 + Math.random() * 9000)}`;

        const nombreArchivoOriginal = req.file.originalname;
        const rutaArchivo = req.file.filename;

        // Query SQL con valores protegidos (Sanitizados contra SQL Injection)
        const tiempoRespuesta = obtenerTiempoRespuesta(tipo_documento || 'Solicitud');
        const query = `
            INSERT INTO radicados 
            (numero_radicado, tipo_recepcion, tipo_comunicacion, tipo_documento, tiempo_de_respuesta, remitente_nombre, remitente_documento, remitente_entidad, remitente_nit, remitente_telefono, remitente_email, numero_folios, dependencia_destino, asunto_documento, usuario_recibe, nombre_archivo_original, ruta_archivo)
            VALUES (?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?)
        `;

        const values = [
            numeroRadicado,
            tipo_recepcion || 'Digital',
            tipo_comunicacion,
            tipo_documento || 'Solicitud',
            tiempoRespuesta,
            remitente_nombre,
            remitente_documento,
            remitente_entidad || null,
            remitente_nit || null,
            remitente_telefono || 'No especificado',
            remitente_email || null,
            numero_folios || 1,
            dependencia_destino || 'General',
            asunto_documento,
            usuario_recibe,
            nombreArchivoOriginal,
            rutaArchivo
        ];

        await pool.execute(query, values);

        console.log(`✅ Radicado ${numeroRadicado} guardado correctamente.`);

        return res.status(200).json({
            success: true,
            message: 'Radicado generado y guardado exitosamente.',
            radicado: numeroRadicado
        });

    } catch (error) {
        console.error('❌ Error crítico al procesar el radicado:', error);

        // Si falla la BD pero el archivo se subió, lo borramos para no acumular basura
        if (req.file) {
            try { fs.unlinkSync(req.file.path); } catch (e) { }
        }

        return res.status(500).json({
            success: false,
            message: 'Error interno del servidor al guardar el registro.'
        });
    }
});


// Ruta para obtener los radicados con el semáforo calculado
app.get('/api/radicados', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM radicados ORDER BY fecha_creacion DESC'
        );

        res.status(200).json({
            success: true,
            total: rows.length,
            radicados: rows.map(radicado => {
                const radicadoConPlazo = {
                    ...radicado,
                    tiempo_de_respuesta: obtenerTiempoRespuesta(radicado.tipo_documento)
                };

                return {
                    ...radicadoConPlazo,
                    semaforo: calcularSemaforoBackend(radicadoConPlazo)
                };
            })
        });
    } catch (error) {
        console.error("❌ Error al consultar radicados:", error);
        res.status(500).json({
            success: false,
            message: 'Error interno al obtener los radicados.'
        });
    }
});


// Ruta para actualizar el estado de un radicado
app.put('/api/radicados/:numero_radicado/estado', async (req, res) => {
    const { numero_radicado } = req.params;
    const { estado } = req.body;

    if (typeof estado !== 'string' || !estado.trim()) {
        return res.status(400).json({
            success: false,
            message: 'El estado es obligatorio.'
        });
    }

    try {
        const query = 'UPDATE radicados SET estado = ? WHERE numero_radicado = ?';
        await pool.execute(query, [estado.trim(), numero_radicado]);

        const [rows] = await pool.execute(
            'SELECT * FROM radicados WHERE numero_radicado = ? LIMIT 1',
            [numero_radicado]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No se encontró el radicado solicitado.'
            });
        }

        const radicadoActualizado = {
            ...rows[0],
            tiempo_de_respuesta: obtenerTiempoRespuesta(rows[0].tipo_documento)
        };

        res.json({
            success: true,
            message: 'Estado actualizado correctamente',
            tiempo_de_respuesta: radicadoActualizado.tiempo_de_respuesta,
            semaforo: calcularSemaforoBackend(radicadoActualizado)
        });
    } catch (error) {
        console.error('Error al actualizar el estado:', error);
        res.status(500).json({ success: false, message: 'Error en el servidor al actualizar' });
    }
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🚀 Servidor backend corriendo en http://localhost:${PORT}`);
});