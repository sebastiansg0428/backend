-- Separa las comunicaciones por clase sin reemplazar radicados ni sus relaciones.
CREATE TABLE IF NOT EXISTS comunicaciones_internas (
    numero_radicado VARCHAR(100) NOT NULL PRIMARY KEY,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_comunicaciones_internas_radicado
        FOREIGN KEY (numero_radicado) REFERENCES radicados(numero_radicado)
        ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS comunicaciones_externas (
    numero_radicado VARCHAR(100) NOT NULL PRIMARY KEY,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_comunicaciones_externas_radicado
        FOREIGN KEY (numero_radicado) REFERENCES radicados(numero_radicado)
        ON DELETE CASCADE
) ENGINE=InnoDB;

-- Los históricos conservan la clase que ya estaba registrada. Para valores
-- antiguos sin clase explícita, se deriva del tipo de trámite asociado.
INSERT INTO comunicaciones_internas (numero_radicado, creado_en)
SELECT r.numero_radicado, COALESCE(r.fecha_creacion, CURRENT_TIMESTAMP)
FROM radicados AS r
LEFT JOIN radicado_terminos AS rt ON rt.numero_radicado = r.numero_radicado
LEFT JOIN tipos_tramite AS t ON t.id = rt.tipo_tramite_id
WHERE CASE
    WHEN LOWER(TRIM(COALESCE(r.tipo_comunicacion, ''))) = 'interna' THEN 'Interna'
    WHEN LOWER(TRIM(COALESCE(r.tipo_comunicacion, ''))) = 'externa' THEN 'Externa'
    WHEN t.codigo IN (
        'derecho_peticion', 'solicitud', 'informativo',
        'notificacion', 'notificacion_judicial'
    ) THEN 'Interna'
    ELSE 'Externa'
END = 'Interna'
ON DUPLICATE KEY UPDATE numero_radicado = VALUES(numero_radicado);

INSERT INTO comunicaciones_externas (numero_radicado, creado_en)
SELECT r.numero_radicado, COALESCE(r.fecha_creacion, CURRENT_TIMESTAMP)
FROM radicados AS r
LEFT JOIN radicado_terminos AS rt ON rt.numero_radicado = r.numero_radicado
LEFT JOIN tipos_tramite AS t ON t.id = rt.tipo_tramite_id
WHERE CASE
    WHEN LOWER(TRIM(COALESCE(r.tipo_comunicacion, ''))) = 'interna' THEN 'Interna'
    WHEN LOWER(TRIM(COALESCE(r.tipo_comunicacion, ''))) = 'externa' THEN 'Externa'
    WHEN t.codigo IN (
        'derecho_peticion', 'solicitud', 'informativo',
        'notificacion', 'notificacion_judicial'
    ) THEN 'Interna'
    ELSE 'Externa'
END = 'Externa'
ON DUPLICATE KEY UPDATE numero_radicado = VALUES(numero_radicado);
