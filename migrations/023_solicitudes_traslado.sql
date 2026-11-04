-- Plantilla de 023_solicitudes_traslado.js. NO importar directamente.
-- El ejecutor conserva tipo e intercalacion del numero de radicado historico.
-- No modifica radicados ni plazos existentes.
CREATE TABLE solicitudes_traslado (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    numero_radicado __NUMERO_RADICADO__ NOT NULL,
    origen_id INT NOT NULL,
    origen_nombre VARCHAR(150) NOT NULL,
    destino_sugerido_id INT NOT NULL,
    destino_sugerido_nombre VARCHAR(150) NOT NULL,
    destino_aprobado_id INT NULL,
    destino_aprobado_nombre VARCHAR(150) NULL,
    solicitante_id INT NOT NULL,
    solicitante_nombre VARCHAR(150) NOT NULL,
    decisor_id INT NULL,
    decisor_nombre VARCHAR(150) NULL,
    motivo_solicitud VARCHAR(2000) NOT NULL,
    motivo_decision VARCHAR(2000) NULL,
    estado ENUM('pendiente', 'aprobada', 'rechazada', 'cancelada_por_finalizacion') NOT NULL DEFAULT 'pendiente',
    clave_solicitud CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    huella_solicitud CHAR(64) CHARACTER SET ascii NOT NULL,
    huella_decision CHAR(64) CHARACTER SET ascii NULL,
    fecha_limite_conservada DATE NULL,
    creado_en_utc DATETIME(6) NOT NULL,
    resuelto_en_utc DATETIME(6) NULL,
    pendiente_radicado VARCHAR(100)
        GENERATED ALWAYS AS (CASE WHEN estado = 'pendiente' THEN numero_radicado ELSE NULL END) STORED,
    CONSTRAINT fk_traslado_radicado FOREIGN KEY (numero_radicado) REFERENCES radicados(numero_radicado),
    CONSTRAINT fk_traslado_origen FOREIGN KEY (origen_id) REFERENCES dependencias(id),
    CONSTRAINT fk_traslado_sugerido FOREIGN KEY (destino_sugerido_id) REFERENCES dependencias(id),
    CONSTRAINT fk_traslado_aprobado FOREIGN KEY (destino_aprobado_id) REFERENCES dependencias(id),
    CONSTRAINT fk_traslado_solicitante FOREIGN KEY (solicitante_id) REFERENCES usuarios(id),
    CONSTRAINT fk_traslado_decisor FOREIGN KEY (decisor_id) REFERENCES usuarios(id),
    UNIQUE KEY uq_traslado_pendiente (pendiente_radicado),
    UNIQUE KEY uq_traslado_intento (solicitante_id, clave_solicitud),
    INDEX idx_traslado_bandeja (estado, id),
    INDEX idx_traslado_origen (origen_id, estado, id),
    INDEX idx_traslado_radicado (numero_radicado, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
