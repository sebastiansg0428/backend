# Migraciones de seguimiento global y procedencia

Para activar el seguimiento independiente de los radicados dirigidos a todas las dependencias:

1. Haz una copia de seguridad de la base de datos.
2. Ejecuta `017_destino_todas_dependencias.sql` si aún no se ha aplicado.
3. Ejecuta una sola vez `018_seguimiento_por_dependencia.sql` en la base `ventanilla_unica`.
4. Reinicia el backend para usar la nueva tabla.

La migración 018 crea una asignación por cada dependencia activa para cada radicado global existente. Si encuentra una respuesta histórica cuyo autor pertenece a una dependencia asignada, conserva la respuesta y marca respondida solo esa dependencia. Las otras comienzan en estado `Recibido`. Los términos y fechas límite permanecen compartidos.

Los funcionarios nuevos deben asociarse a una dependencia del catálogo. La creación o reactivación de oficinas mediante la API actual agrega sus asignaciones globales de forma transaccional.

## Procedencia de radicados (019)

Después de 018, revisa estructura, índices y referencias con `SHOW CREATE TABLE`
de `radicados` y `dependencias`, y conserva un respaldo de estructura fuera de Git.
Ejecuta una sola vez [019_procedencia_radicados.sql](019_procedencia_radicados.sql).
Agrega ID de origen `INT` nullable con índice/FK, nombre histórico y tipo de
persona externa. No borra ni rellena los registros anteriores.

El DDL implica commit y no puede deshacerse con un rollback de la aplicación.
Ante un estado parcial no reejecutes a ciegas. Verifica columnas, FK e índice
con una conexión nueva y despliega frontend/backend juntos; reinicia el backend.
Las nuevas internas exigen origen activo y las externas tipo de persona/correo;
las jurídicas exigen además razón social/NIT. No cambia el acceso por destino.

La secuencia completa para instalaciones nuevas es 000-019, incluyendo los
pasos JavaScript 002 y 009 en su posición; consulta el
[README principal](../README.md). No reapliques esa secuencia a una base existente.
La validación estática de migraciones no equivale a ejecutar toda la instalación
en una base aislada.
