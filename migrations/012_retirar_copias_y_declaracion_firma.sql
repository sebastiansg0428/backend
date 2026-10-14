-- Elimina los campos de copias y declaración de firma solicitados para recepción.
-- El número de folios se conserva.
ALTER TABLE radicados
    DROP COLUMN numero_copias,
    DROP COLUMN declara_firma;
