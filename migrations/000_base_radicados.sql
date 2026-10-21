-- Solo para una instalacion nueva en una base vacia.
-- Ejecutar antes de 001 y continuar con toda la secuencia documentada.
-- No representa un volcado del esquema de una base existente.
CREATE TABLE radicados (
    id INT AUTO_INCREMENT PRIMARY KEY,
    numero_radicado VARCHAR(100) NOT NULL UNIQUE,
    tipo_recepcion VARCHAR(50) NOT NULL DEFAULT 'Digital',
    tipo_comunicacion VARCHAR(50) NOT NULL,
    tipo_documento VARCHAR(150) NOT NULL,
    tiempo_de_respuesta VARCHAR(100) NOT NULL,
    remitente_nombre VARCHAR(150) NOT NULL,
    remitente_documento VARCHAR(50) NOT NULL,
    remitente_entidad VARCHAR(180) NULL,
    remitente_nit VARCHAR(30) NULL,
    remitente_telefono VARCHAR(50) NOT NULL DEFAULT 'No especificado',
    remitente_email VARCHAR(254) NULL,
    numero_folios INT NOT NULL DEFAULT 1,
    dependencia_destino VARCHAR(150) NOT NULL,
    asunto_documento TEXT NOT NULL,
    usuario_recibe VARCHAR(150) NOT NULL,
    nombre_archivo_original VARCHAR(255) NULL,
    ruta_archivo VARCHAR(255) NULL,
    estado VARCHAR(30) NOT NULL DEFAULT 'Recibido',
    fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_radicados_fecha_creacion (fecha_creacion)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
