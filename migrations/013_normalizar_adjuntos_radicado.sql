-- Convierte los campos de archivo únicos de radicados en documentos relacionados.
-- Primero conserva cualquier adjunto legado que todavía no esté en la tabla hija.
ALTER TABLE documentos_radicado
    MODIFY COLUMN tamano_bytes BIGINT UNSIGNED NULL;

INSERT INTO documentos_radicado
    (numero_radicado, nombre_archivo, ruta_archivo, tipo_mime, tamano_bytes)
SELECT r.numero_radicado,
       COALESCE(NULLIF(TRIM(r.nombre_archivo_original), ''), SUBSTRING_INDEX(r.ruta_archivo, '/', -1)),
       r.ruta_archivo,
       'application/pdf',
       NULL
FROM radicados AS r
WHERE r.ruta_archivo IS NOT NULL
  AND TRIM(r.ruta_archivo) <> ''
  AND NOT EXISTS (
      SELECT 1
      FROM documentos_radicado AS d
      WHERE d.ruta_archivo = r.ruta_archivo
  );

-- A partir de aquí, documentos_radicado es la fuente única para todos los PDFs.
ALTER TABLE radicados
    DROP COLUMN nombre_archivo_original,
    DROP COLUMN ruta_archivo;
