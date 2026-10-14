-- Amplía la recepción sin reescribir los datos históricos del radicado.
ALTER TABLE radicados
    ADD COLUMN tipo_movimiento ENUM('Recibida', 'Despachada') NOT NULL DEFAULT 'Recibida',
    ADD COLUMN numero_copias INT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN declara_firma TINYINT(1) NOT NULL DEFAULT 0,
    ADD COLUMN fecha_hora_recepcion DATETIME NULL;

-- Conserva una fecha de referencia en radicados existentes. Los nuevos registros
-- reciben fecha_hora_recepcion explícitamente desde el backend en hora de Bogotá.
UPDATE radicados
SET fecha_hora_recepcion = COALESCE(fecha_creacion, CURRENT_TIMESTAMP)
WHERE fecha_hora_recepcion IS NULL;

ALTER TABLE radicados
    MODIFY COLUMN fecha_hora_recepcion DATETIME NOT NULL;
