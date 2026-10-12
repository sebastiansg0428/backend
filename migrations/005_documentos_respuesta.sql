-- Una respuesta puede tener varios archivos. Se crea una fila por cada PDF.
CREATE TABLE IF NOT EXISTS documentos_respuesta (
    id INT AUTO_INCREMENT PRIMARY KEY,
    respuesta_id INT NOT NULL,
    nombre_archivo VARCHAR(255) NOT NULL,
    ruta_archivo VARCHAR(255) NOT NULL UNIQUE,
    tipo_mime VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
    tamano_bytes BIGINT UNSIGNED NOT NULL,
    fecha_registro TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_documento_respuesta
        FOREIGN KEY (respuesta_id) REFERENCES respuestas_radicado(id)
        ON DELETE CASCADE,
    INDEX idx_documentos_respuesta (respuesta_id)
) ENGINE=InnoDB;
