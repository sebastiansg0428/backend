ALTER TABLE usuarios
    ADD COLUMN activo TINYINT NOT NULL DEFAULT 1,
    ADD CONSTRAINT chk_usuarios_activo CHECK (activo IN (0, 1));
    