-- Extiende el historial existente sin reescribir sus eventos legados.
-- Ejecutar una sola vez despues de la migracion 020.
ALTER TABLE historial_radicado
    ADD COLUMN event_type VARCHAR(80) NULL AFTER motivo,
    ADD COLUMN actor_id INT NULL AFTER event_type,
    ADD COLUMN actor_name VARCHAR(150) NULL AFTER actor_id,
    ADD COLUMN dependencia_id INT NULL AFTER actor_name,
    ADD COLUMN dependencia_nombre VARCHAR(150) NULL AFTER dependencia_id,
    ADD COLUMN radicado_dependencia_id BIGINT UNSIGNED NULL AFTER dependencia_nombre,
    ADD COLUMN session_id CHAR(36) NULL AFTER radicado_dependencia_id,
    ADD COLUMN ip_address VARCHAR(45) NULL AFTER session_id,
    ADD COLUMN ocurrido_en_utc DATETIME(6) NULL AFTER ip_address,
    ADD INDEX idx_historial_evento_cursor (numero_radicado, id),
    ADD INDEX idx_historial_sesion (session_id);
