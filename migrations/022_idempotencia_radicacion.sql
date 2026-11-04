-- Ejecutar una vez despues de 021. No modifica radicados existentes.
CREATE TABLE intentos_radicacion (
    actor_id INT NOT NULL,
    clave CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    huella CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    numero_radicado VARCHAR(100) NULL,
    respuesta_json LONGTEXT NULL,
    creado_en DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (actor_id, clave),
    CONSTRAINT chk_intento_respuesta CHECK (
        (numero_radicado IS NULL AND respuesta_json IS NULL) OR
        (numero_radicado IS NOT NULL AND respuesta_json IS NOT NULL AND JSON_VALID(respuesta_json))
    )
) ENGINE=InnoDB;
