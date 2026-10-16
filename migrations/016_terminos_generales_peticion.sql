-- Registra términos supletorios nacionales para categorías cuyo término está
-- definido en la Ley 1755 de 2015 y no configura trámites especiales.
-- Ejecutar una vez después de 001_control_terminos.sql y 002_actualizar_tipos_tramite.js.
-- Es idempotente y no modifica términos existentes ni términos aplicados a radicados.

INSERT INTO terminos_legales
    (tipo_tramite_id, dias, tipo_dias, fundamento_legal, vigente_desde)
SELECT
    tipo.id,
    CASE tipo.categoria_general
        WHEN 'informacion_documentos' THEN 10
        WHEN 'consulta' THEN 30
        WHEN 'peticion_general' THEN 15
    END,
    'habiles',
    CASE tipo.categoria_general
        WHEN 'informacion_documentos' THEN
            'Ley 1755 de 2015, artículo 14 numeral 1 (10 días); Ley 4 de 1913, artículo 62 (cómputo hábil).'
        WHEN 'consulta' THEN
            'Ley 1755 de 2015, artículo 14 numeral 2 (30 días); Ley 4 de 1913, artículo 62 (cómputo hábil).'
        WHEN 'peticion_general' THEN
            'Ley 1755 de 2015, artículos 13 y 14 (15 días, salvo término especial); Ley 2052 de 2020, artículo 20 (regla supletoria); Ley 4 de 1913, artículo 62 (cómputo hábil).'
    END,
    DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '-05:00'))
FROM tipos_tramite AS tipo
WHERE tipo.categoria_general IN (
    'informacion_documentos',
    'consulta',
    'peticion_general'
)
AND NOT EXISTS (
    SELECT 1
    FROM terminos_legales AS existente
    WHERE existente.tipo_tramite_id = tipo.id
);
