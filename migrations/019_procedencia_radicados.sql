ALTER TABLE radicados
    ADD COLUMN dependencia_remitente_id INT NULL,
    ADD COLUMN dependencia_remitente VARCHAR(150) NULL,
    ADD COLUMN remitente_tipo_persona VARCHAR(10) NULL,
    ADD INDEX idx_radicados_remitente (dependencia_remitente_id),
    ADD CONSTRAINT fk_radicados_remitente
        FOREIGN KEY (dependencia_remitente_id) REFERENCES dependencias(id);
