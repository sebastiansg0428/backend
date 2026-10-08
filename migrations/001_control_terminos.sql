CREATE TABLE IF NOT EXISTS tipos_tramite (
    id INT AUTO_INCREMENT PRIMARY KEY,
    codigo VARCHAR(60) NOT NULL UNIQUE,
    nombre VARCHAR(150) NOT NULL UNIQUE,
    categoria_general ENUM(
        'peticion_general',
        'informacion_documentos',
        'consulta',
        'entre_autoridades',
        'especial'
    ) NOT NULL,
    orden INT NOT NULL DEFAULT 0,
    activo BOOLEAN NOT NULL DEFAULT TRUE,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS terminos_legales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tipo_tramite_id INT NOT NULL,
    dias INT NOT NULL,
    tipo_dias ENUM('habiles', 'calendario') NOT NULL,
    fundamento_legal VARCHAR(500) NOT NULL,
    vigente_desde DATE NOT NULL,
    vigente_hasta DATE NULL,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_terminos_dias_positivos CHECK (dias > 0),
    CONSTRAINT fk_terminos_tipo
        FOREIGN KEY (tipo_tramite_id) REFERENCES tipos_tramite(id),
    INDEX idx_terminos_vigencia (tipo_tramite_id, vigente_desde, vigente_hasta)
);

CREATE TABLE IF NOT EXISTS radicado_terminos (
    numero_radicado VARCHAR(100) PRIMARY KEY,
    tipo_tramite_id INT NOT NULL,
    termino_legal_id INT NOT NULL,
    fecha_recepcion DATE NOT NULL,
    termino_dias_aplicado INT NOT NULL,
    tipo_dias_aplicado ENUM('habiles', 'calendario') NOT NULL,
    fundamento_legal_aplicado VARCHAR(500) NOT NULL,
    fecha_limite_inicial DATE NOT NULL,
    fecha_limite_actual DATE NOT NULL,
    fecha_respuesta DATETIME NULL,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_radicado_terminos_tipo
        FOREIGN KEY (tipo_tramite_id) REFERENCES tipos_tramite(id),
    CONSTRAINT fk_radicado_terminos_termino
        FOREIGN KEY (termino_legal_id) REFERENCES terminos_legales(id),
    INDEX idx_radicado_terminos_vencimiento (fecha_limite_actual)
);

CREATE TABLE IF NOT EXISTS historial_radicado (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    numero_radicado VARCHAR(100) NOT NULL,
    campo_modificado VARCHAR(100) NOT NULL,
    valor_anterior TEXT NULL,
    valor_nuevo TEXT NULL,
    usuario VARCHAR(150) NULL,
    motivo TEXT NULL,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_historial_numero_fecha (numero_radicado, creado_en)
);

CREATE TABLE IF NOT EXISTS ampliaciones_termino (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    numero_radicado VARCHAR(100) NOT NULL,
    fecha_limite_anterior DATE NOT NULL,
    fecha_limite_nueva DATE NOT NULL,
    motivo TEXT NOT NULL,
    fundamento_legal VARCHAR(500) NOT NULL,
    creado_en DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ampliaciones_numero_fecha (numero_radicado, creado_en)
);

INSERT INTO tipos_tramite (codigo, nombre, categoria_general, orden, activo) VALUES
    ('informativo', 'Informativo', 'peticion_general', 1, TRUE),
    ('solicitud', 'Solicitud', 'peticion_general', 2, TRUE),
    ('derecho_peticion', 'Derecho de petición', 'peticion_general', 3, TRUE),
    ('denuncia', 'Denuncia', 'peticion_general', 4, TRUE),
    ('queja', 'Queja', 'peticion_general', 5, TRUE),
    ('reclamo', 'Reclamo', 'peticion_general', 6, TRUE),
    ('notificacion_judicial', 'Notificación Judicial', 'especial', 7, TRUE),
    ('restablecimiento_derecho', 'Restablecimiento de derecho', 'especial', 8, TRUE),
    ('cuotas_partes', 'Cuotas partes', 'especial', 9, TRUE),
    ('accion_tutela', 'Acción de tutela', 'especial', 10, TRUE),
    ('desacato_tutela', 'Desacato de Tutela', 'especial', 11, TRUE),
    ('licencia_construccion', 'Licencia de construcción', 'especial', 12, TRUE),
    ('notificacion', 'Notificación', 'especial', 13, TRUE),
    ('invitacion', 'Invitación', 'peticion_general', 14, TRUE),
    ('licencia_urbanistica', 'Licencia Urbanística', 'especial', 15, TRUE),
    ('solicitud_simit_rut', 'Solicitud SIMIT-RUT', 'informacion_documentos', 16, TRUE)
ON DUPLICATE KEY UPDATE
    nombre = VALUES(nombre),
    categoria_general = VALUES(categoria_general),
    orden = VALUES(orden),
    activo = VALUES(activo);

INSERT INTO terminos_legales
    (tipo_tramite_id, dias, tipo_dias, fundamento_legal, vigente_desde)
SELECT tipos.id, reglas.dias, 'habiles', reglas.fundamento,
       DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '-05:00'))
FROM (
    SELECT 'informativo' AS codigo, 15 AS dias, 'Ley 1755 de 2015, artículo 14. Trámite de carácter informativo.' AS fundamento
    UNION ALL SELECT 'solicitud', 15, 'Ley 1755 de 2015, artículo 14. Solicitud o petición de interés general o particular.'
    UNION ALL SELECT 'derecho_peticion', 15, 'Ley 1755 de 2015, artículo 14. Constitución Política, artículo 23.'
    UNION ALL SELECT 'denuncia', 15, 'Ley 1755 de 2015, artículo 14 / CPACA. Denuncia ciudadana.'
    UNION ALL SELECT 'queja', 15, 'Ley 1755 de 2015, artículo 14. Queja sobre la conducta de servidores o servicios.'
    UNION ALL SELECT 'reclamo', 15, 'Ley 1755 de 2015, artículo 14. Reclamo por deficiencia en la prestación del servicio.'
    UNION ALL SELECT 'notificacion_judicial', 10, 'Ley 1437 de 2011 (CPACA), artículo 197 / Ley 2080 de 2021. Notificaciones judiciales.'
    UNION ALL SELECT 'restablecimiento_derecho', 15, 'Ley 1437 de 2011 (CPACA), artículo 138 / Ley 1755 de 2015.'
    UNION ALL SELECT 'cuotas_partes', 15, 'Ley 1066 de 2006 / Decreto 1068 de 2015 / Ley 1755 de 2015. Cuotas partes pensionales.'
    UNION ALL SELECT 'accion_tutela', 10, 'Decreto 2591 de 1991, artículo 29. Término preferente y sumario de acción de tutela.'
    UNION ALL SELECT 'desacato_tutela', 3, 'Decreto 2591 de 1991, artículo 52. Trámite incidental de desacato de tutela.'
    UNION ALL SELECT 'licencia_construccion', 45, 'Decreto 1077 de 2015, artículo 2.2.6.1.2.2.1. Trámite y resolución de licencias de construcción.'
    UNION ALL SELECT 'notificacion', 10, 'Ley 1437 de 2011 (CPACA), artículos 67 a 69. Actos de notificación administrativa.'
    UNION ALL SELECT 'invitacion', 15, 'Ley 1755 de 2015, artículo 14. Comunicaciones oficiales e invitaciones.'
    UNION ALL SELECT 'licencia_urbanistica', 45, 'Decreto 1077 de 2015, artículo 2.2.6.1.2.2.1. Licencias urbanísticas.'
    UNION ALL SELECT 'solicitud_simit_rut', 10, 'Ley 1755 de 2015, artículo 14 numeral 1. Solicitud de documentos e información SIMIT - RUT.'
) AS reglas
JOIN tipos_tramite AS tipos ON tipos.codigo = reglas.codigo
WHERE NOT EXISTS (
    SELECT 1
    FROM terminos_legales AS existentes
    WHERE existentes.tipo_tramite_id = tipos.id
);
