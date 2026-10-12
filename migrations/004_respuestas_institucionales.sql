CREATE TABLE IF NOT EXISTS respuestas_radicado (
    id INT AUTO_INCREMENT PRIMARY KEY,
    numero_radicado VARCHAR(100) NOT NULL UNIQUE,
    contenido TEXT NOT NULL,
    plantilla VARCHAR(40) NULL,
    nombre_archivo VARCHAR(255) NULL,
    ruta_archivo VARCHAR(255) NULL,
    usuario_id INT NOT NULL,
    fecha_envio TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_respuesta_radicado FOREIGN KEY (numero_radicado)
        REFERENCES radicados(numero_radicado) ON DELETE CASCADE,
    CONSTRAINT fk_respuesta_usuario FOREIGN KEY (usuario_id)
        REFERENCES usuarios(id)
) ENGINE=InnoDB;
