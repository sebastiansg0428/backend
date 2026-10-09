CREATE TABLE dependencias (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL UNIQUE
) ENGINE=InnoDB;

CREATE TABLE usuarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL,
    email VARCHAR(254) NOT NULL UNIQUE,
    password VARCHAR(255) NOT NULL,
    rol ENUM('administrador', 'ventanilla', 'funcionario') NOT NULL,
    dependencia_id INT NULL,
    CONSTRAINT fk_usuarios_dependencia
        FOREIGN KEY (dependencia_id) REFERENCES dependencias(id),
    CONSTRAINT chk_usuarios_dependencia CHECK (
        (rol = 'funcionario' AND dependencia_id IS NOT NULL) OR
        (rol IN ('administrador', 'ventanilla') AND dependencia_id IS NULL)
    )
) ENGINE=InnoDB;

ALTER TABLE radicados
    ADD COLUMN dependencia_destino_id INT NULL,
    ADD CONSTRAINT fk_radicados_dependencia
        FOREIGN KEY (dependencia_destino_id) REFERENCES dependencias(id),
    ADD INDEX idx_radicados_dependencia (dependencia_destino_id);

-- Conserva las denominaciones existentes y enlaza los registros historicos.
INSERT INTO dependencias (nombre)
SELECT DISTINCT TRIM(dependencia_destino)
FROM radicados
WHERE dependencia_destino IS NOT NULL AND TRIM(dependencia_destino) <> '';

UPDATE radicados AS r
JOIN dependencias AS d ON d.nombre = TRIM(r.dependencia_destino)
SET r.dependencia_destino_id = d.id;
