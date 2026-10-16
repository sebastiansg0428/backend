# Migraciones de seguimiento global

Para activar el seguimiento independiente de los radicados dirigidos a todas las dependencias:

1. Haz una copia de seguridad de la base de datos.
2. Ejecuta `017_destino_todas_dependencias.sql` si aún no se ha aplicado.
3. Ejecuta una sola vez `018_seguimiento_por_dependencia.sql` en la base `ventanilla_unica`.
4. Reinicia el backend para usar la nueva tabla.

La migración 018 crea una asignación por cada dependencia activa para cada radicado global existente. Si encuentra una respuesta histórica cuyo autor pertenece a una dependencia asignada, conserva la respuesta y marca respondida solo esa dependencia. Las otras comienzan en estado `Recibido`. Los términos y fechas límite permanecen compartidos.

Los funcionarios nuevos deben asociarse a una dependencia ya existente en el catálogo para recibir los radicados globales. Si se crea una dependencia después de un radicado global, ese radicado no se asigna automáticamente a la dependencia nueva.
