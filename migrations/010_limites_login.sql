CREATE TABLE IF NOT EXISTS limites_login (
    ambito ENUM('cuenta', 'ip') NOT NULL,
    clave CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    cantidad INT UNSIGNED NOT NULL DEFAULT 0,
    expira BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (ambito, clave),
    INDEX idx_limites_login_expira (expira)
) ENGINE=InnoDB;