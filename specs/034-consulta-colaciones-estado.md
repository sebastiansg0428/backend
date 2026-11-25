---
id: BUG-CONSULTA-COLLATIONS-ESTADO
title: Compatibilidad de colaciones en consulta de radicados
status: implementing
risk: low
---

# Problema

La consulta paginada compara estados provenientes de `radicados` y
`radicado_dependencias`, cuyas columnas pueden tener colaciones distintas en
instalaciones MariaDB existentes. La expresión directa produce
`ER_CANT_AGGREGATE_2COLLATIONS` y la interfaz muestra error 500.

# Decisión

Normalizar a `utf8mb4_unicode_ci` únicamente la expresión derivada usada para
filtrar estados respondidos. No se modifican tablas, datos, migraciones,
contratos API ni la colación física de columnas históricas.

# Aceptación

- La consulta paginada de radicados no falla cuando las columnas tienen
  colaciones distintas.
- Los radicados respondidos siguen fuera del cálculo de pendientes y alertas.
- Las consultas de catálogos, entregas y estados conservan su comportamiento.
- Las pruebas de consulta y el build pasan.

La spec permanecerá en `implementing` hasta la revisión humana.
