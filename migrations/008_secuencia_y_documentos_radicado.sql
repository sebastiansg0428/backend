CREATE TABLE IF NOT EXISTS secuencias_radicado (
    ano SMALLINT UNSIGNED NOT NULL PRIMARY KEY,
    ultimo_numero INT UNSIGNED NOT NULL DEFAULT 0,
    actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT chk_secuencia_radicado_no_negativa CHECK (ultimo_numero >= 0)
) ENGINE=InnoDB;

-- Recupera el consecutivo si la migración se vuelve a aplicar tras iniciar su uso.
INSERT INTO secuencias_radicado (ano, ultimo_numero)
SELECT CAST(SUBSTRING(numero_radicado, 5, 4) AS UNSIGNED),
       MAX(CAST(SUBSTRING_INDEX(numero_radicado, '-', -1) AS UNSIGNED))
FROM radicados
WHERE numero_radicado REGEXP '^RAD-([0-9]{4}|[0-9]{8})-[0-9]+$'
GROUP BY CAST(SUBSTRING(numero_radicado, 5, 4) AS UNSIGNED)
ON DUPLICATE KEY UPDATE ultimo_numero = GREATEST(ultimo_numero, VALUES(ultimo_numero));

CREATE TABLE IF NOT EXISTS documentos_radicado (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    numero_radicado VARCHAR(100) NOT NULL,
    nombre_archivo VARCHAR(255) NOT NULL,
    ruta_archivo VARCHAR(255) NOT NULL UNIQUE,
    tipo_mime VARCHAR(100) NOT NULL DEFAULT 'application/pdf',
    tamano_bytes BIGINT UNSIGNED NOT NULL,
    fecha_registro TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_documento_radicado
        FOREIGN KEY (numero_radicado) REFERENCES radicados(numero_radicado)
        ON DELETE CASCADE,
    INDEX idx_documentos_radicado (numero_radicado)
) ENGINE=InnoDB;

