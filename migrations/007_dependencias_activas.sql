ALTER TABLE dependencias
    ADD COLUMN activo TINYINT NOT NULL DEFAULT 1,
    ADD CONSTRAINT chk_dependencias_activo CHECK (activo IN (0, 1));
