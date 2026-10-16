-- Seguimiento independiente por dependencia para radicados globales.
-- Ejecutar una sola vez después de 017_destino_todas_dependencias.sql.

CREATE TABLE radicado_dependencias (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    numero_radicado VARCHAR(100) NOT NULL,
    dependencia_id INT NOT NULL,
    estado VARCHAR(30) NOT NULL DEFAULT 'Recibido',
    fecha_respuesta DATETIME NULL,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    actualizado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT uq_radicado_dependencia UNIQUE (numero_radicado, dependencia_id),
    CONSTRAINT fk_radicado_dependencias_radicado FOREIGN KEY (numero_radicado)
        REFERENCES radicados(numero_radicado) ON DELETE CASCADE,
    CONSTRAINT fk_radicado_dependencias_dependencia FOREIGN KEY (dependencia_id)
        REFERENCES dependencias(id),
    INDEX idx_radicado_dependencias_estado (dependencia_id, estado)
) ENGINE=InnoDB;

-- Cada radicado global queda asignado a las dependencias que existen al migrar.
INSERT INTO radicado_dependencias (numero_radicado, dependencia_id)
SELECT r.numero_radicado, d.id
FROM radicados r
CROSS JOIN dependencias d
WHERE r.destino_todas_dependencias = 1 AND d.activo = 1;

-- Una respuesta histórica se atribuye solo a la dependencia del funcionario autor,
-- cuando esa relación existe. Las demás dependencias comienzan pendientes.
ALTER TABLE respuestas_radicado
    ADD COLUMN radicado_dependencia_id BIGINT UNSIGNED NULL AFTER numero_radicado,
    DROP FOREIGN KEY fk_respuesta_radicado,
    DROP INDEX numero_radicado,
    ADD INDEX idx_respuesta_numero_radicado (numero_radicado),
    ADD CONSTRAINT fk_respuesta_radicado_numero FOREIGN KEY (numero_radicado)
        REFERENCES radicados(numero_radicado) ON DELETE CASCADE,
    ADD UNIQUE INDEX uq_respuesta_dependencia (radicado_dependencia_id),
    ADD CONSTRAINT fk_respuesta_dependencia FOREIGN KEY (radicado_dependencia_id)
        REFERENCES radicado_dependencias(id) ON DELETE CASCADE;

UPDATE respuestas_radicado rr
JOIN usuarios u ON u.id = rr.usuario_id
JOIN radicado_dependencias rd
  ON rd.numero_radicado = rr.numero_radicado
 AND rd.dependencia_id = u.dependencia_id
JOIN radicados r ON r.numero_radicado = rr.numero_radicado
SET rr.radicado_dependencia_id = rd.id,
    rd.estado = 'Respondido',
    rd.fecha_respuesta = rr.fecha_envio
WHERE r.destino_todas_dependencias = 1;
