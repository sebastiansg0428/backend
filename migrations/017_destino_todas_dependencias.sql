-- Permite identificar radicados compartidos con todas las dependencias.
-- Ejecutar una sola vez después de las migraciones anteriores.
-- El valor inicial 0 conserva la visibilidad actual de todos los radicados.

ALTER TABLE radicados
    ADD COLUMN destino_todas_dependencias TINYINT(1) NOT NULL DEFAULT 0
    AFTER dependencia_destino_id;
