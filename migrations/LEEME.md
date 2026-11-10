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

La secuencia completa para instalaciones nuevas es 000-029, incluyendo los
pasos JavaScript 002, 009, 020, 023, 024, 025, 026, 027, 028 y 029 en su posición; consulta el
[README principal](../README.md). No reapliques esa secuencia a una base existente.
La validación estática de migraciones no equivale a ejecutar toda la instalación
en una base aislada.

## Fecha real de envio/entrega (029)

[029_fecha_real_entrega.js](029_fecha_real_entrega.js) requiere 026 compatible.
Agrega `entregas_fecha_real` con PK/FK RESTRICT al registro y justificacion
nullable, e indice `idx_entrega_fecha(respuesta_id,fecha_actuacion_utc,id)`.
No altera fechas, registros historicos ni documentos. Los nuevos registros usan
fecha real declarada en UTC y conservan la fecha de creacion automatica separada.
El historial se ordena por actuacion e ID descendentes, con acreditacion vigente
prioritaria en el resumen.

**Aplicada y verificada en desarrollo local**, con autorizacion, backend detenido,
respaldo SQL y de adjuntos protegido, restauracion comprobada y ensayo aislado.
Las 23 tablas anteriores conservaron filas y hashes; los diez archivos adjuntos
quedaron intactos. La nueva tabla quedo vacia, sin backfill, y se verificaron
PK, FK e indice. Repetir en la copia aislada no introdujo cambios.
El respaldo y la copia aislada se conservan fuera de Git.
El usuario detiene y reinicia manualmente el backend.
En otras bases requiere autorizacion adicional, respaldo verificado y escrituras
detenidas. Ensayar primero en una copia aislada.
El DDL hace commit implicito: un fallo parcial requiere inspeccion antes de
continuar; no repetir a ciegas ni eliminar estructuras para reintentar.
La aplicacion repetida sobre esquema compatible no introduce cambios.

```powershell
node migrations\029_fecha_real_entrega.js --verificar
# Solo tras autorizacion y respaldo verificado:
node migrations\029_fecha_real_entrega.js --aplicar
node migrations\029_fecha_real_entrega.js --verificar
```

Sin 029 el nuevo formulario se deshabilita y el backend rechaza nuevos registros
con 503; el historial, descargas, anulaciones y replay existentes siguen disponibles.
Activar frontend/backend juntos y reiniciar el backend despues de verificar.

## Rol historico del actor (028)

[028_rol_actor_historial.js](028_rol_actor_historial.js) requiere las columnas
de auditoria de 021. `--verificar` consulta el esquema sin escribir; `--aplicar`
agrega `actor_role VARCHAR(20) NULL DEFAULT NULL` si falta y verifica el resultado.
Repetir sobre una columna compatible no la altera; una incompatible se rechaza.
El DDL tiene commit implicito: no puede revertirse con rollback de la aplicacion.
No actualiza eventos existentes ni deduce roles desde nombres o cuentas actuales.

**Aplicada y verificada en desarrollo local**, con backend detenido, respaldo
actualizado protegido y restaurado en una base aislada nueva. Se ensayaron los
tres roles y la repeticion; los 25 eventos previos quedaron con rol NULL,
conservando los datos de las 23 tablas y los cinco archivos adjuntos.
La copia aislada y el respaldo se conservan fuera de Git.
El verificador reconoce DEFAULT NULL de MySQL/MariaDB, no el literal `'NULL'`.
En otras bases requiere autorizacion, respaldo verificado y escrituras detenidas.
Aplicar antes de iniciar el backend
actualizado, que necesita la columna para escribir y consultar el historial.
Los nuevos eventos guardan el rol autenticado junto al ID/nombre; los antiguos
mantienen NULL y los titulos actuales de la interfaz permanecen intactos.
Consultar los comandos en el [README principal](../README.md).

## Recepcion digital interna (027)

[027_respuestas_internas.js](027_respuestas_internas.js) exige 024 compatible,
pero es independiente de 026. Crea `recepciones_internas`, UNIQUE por respuesta,
indice origen/id y FK RESTRICT a respuesta, dependencia y primer actor.
Solo internos individuales con respuesta; no agrega canales al esquema 025.
Incorpora historicas con origen valido sin inventar disponibilidad ni lectura.
Un origen ausente/incompatible aborta antes de crear/cargar; verifica columnas,
PK, UNIQUE, indice, FK y cobertura. Una carga incompleta se reporta pendiente.
Inspeccionar antes de reanudar con `--aplicar`: completa filas faltantes, nunca
sobrescribe primera apertura. CREATE tiene commit implicito, sin rollback global.
**Aplicada y verificada en desarrollo**, tras respaldo restaurado y ensayo local.
Cuatro respuestas historicas incorporadas sin disponibilidad ni apertura inventadas;
datos anteriores y archivos intactos. Copia temporal eliminada, respaldo conservado.
`--verificar` es de solo lectura. Aplicar requiere autorizacion separada,
respaldo restaurado/verificado y escrituras detenidas; no se ejecuta al arrancar.
Sin 027, nuevas respuestas internas individuales se rechazan explicitamente
sin persistencia parcial; externos y consulta historica anterior siguen disponibles.

## Fecha automatica y documentos de respuesta (026)

[026_documentos_entrega.js](026_documentos_entrega.js) requiere 025 verificada.
Crea `entregas_confirmacion` y `documentos_entrega_origen`: marca contrato 2 y
origen de los adjuntos mediante PK/FK RESTRICT, sin alterar tablas de 025 ni
sus columnas, registros o huellas. Sin metadata se conserva el contrato historico
y el origen legado. La hora se genera en MySQL al confirmar, no al migrar.
**Aplicada y verificada en desarrollo**, tras respaldo restaurado y ensayo local;
las dos tablas nuevas quedaron vacias, sin alterar 025 ni archivos previos.
`--verificar` no escribe; `--aplicar` requiere autorizacion separada, respaldo
restaurado/verificado y escrituras detenidas. No se autoaplica.
Comprueba esquema completo y aborta ante DDL parcial/incompatible; CREATE
tiene commit implicito, sin rollback global. Sin 026 siguen consulta, descarga
y anulacion de 025, pero nuevos registros automaticos devuelven 503.
Conservar juntos SQL y `uploads\entregas`, incluidas copias y evidencias nuevas.

## Seguimiento manual de entrega (025)

Despues de 024, [025_seguimiento_entrega.js](025_seguimiento_entrega.js) crea
`registros_entrega_respuesta` y `evidencias_entrega`, con cuatro FK RESTRICT,
PK e indices de historial y unicidad actor/UUID y ruta PDF.
No modifica respuestas ni estados anteriores; no envia correos.
`--verificar` es solo lectura; `--aplicar` requiere autorizacion y respaldo
restaurable verificado, escrituras detenidas y configuracion de la base correcta.
No se aplica al iniciar el servidor. **Aplicada y verificada en desarrollo**
con respaldo restaurado y ensayo local previo; otras bases requieren su propia
verificacion y autorizacion. No reejecutar `--aplicar` por rutina.
Solo se reconoce como aplicada si ambas tablas, columnas, PK, UNIQUE e indices
y FK son compatibles. Ante DDL parcial o fallo, inspeccionar desde otra conexion;
no reejecutar a ciegas: CREATE tiene commit implicito, sin rollback global.
Sin 025 el modulo nuevo devuelve 503 y conserva la consulta/respuesta existente.
Respaldar tambien `uploads\entregas` y verificar hashes y descargas autenticadas.
Consulta el [procedimiento y contrato](../README.md#seguimiento-manual-de-envio-y-entrega-025).

## Integridad referencial y unicidad (024)

Despues de 023, [024_integridad_referencial.js](024_integridad_referencial.js)
permite verificar con `--verificar` (solo lectura) o aplicar explicitamente con
`--aplicar`. Preparar y probar el archivo no autoriza su aplicacion a desarrollo.
Consulta el [procedimiento completo](../README.md#integridad-referencial-y-unicidad-024)
antes de ejecutarlo: requiere respaldo restaurable y escrituras detenidas.

Agrega FK RESTRICT y relaciones compuestas sin borrar datos ni snapshots.
La unicidad de respuesta individual usa una columna generada para conservar
las respuestas por asignacion de globales y los NULL validos de informativos.
Reutiliza indices compatibles y no desactiva las FK.

La prevalidacion rechaza incompatibilidades antes del primer ALTER. Un fallo
posterior puede dejar DDL confirmado: inspeccionar desde otra conexion y
recuperar el respaldo si corresponde; no reejecutar a ciegas. Solo un estado
completo compatible se reconoce como ya aplicado. No hay rollback global.

## Informativos sin respuesta (020)

Despues de 019, respalda la base y conserva `SHOW CREATE TABLE` de `radicados`,
`tipos_tramite`, `radicado_terminos` y `radicado_dependencias`. Deten las escrituras
durante el despliegue. Ejecuta una sola vez:

```powershell
node migrations\020_informativos_sin_respuesta.js
```

Agrega la regla por catalogo y su copia por radicado (historicos = true),
`fecha_enterado` individual y por asignacion, y permite terminos/fechas NULL
para nuevos documentos sin respuesta. Amplia el ENUM de estado local con Enterado
sin quitar valores anteriores; si estado es VARCHAR lo conserva. Inicializa
solo el codigo exacto `informativo` del catalogo con regla false, sin cambiar
estados, respuestas ni vencimientos historicos.

El DDL implica commit. Ante error o estado parcial, no reejecutes a ciegas:
verifica el esquema con una conexion nueva y resuelve el paso incompleto.
Comprueba columnas, restricciones, nulabilidad y conservacion de registros.
La migracion aborta si detecta las nuevas columnas ya existentes. Reinicia el
backend y publica el frontend compatible antes de reabrir las escrituras.

## Reintentos de radicacion (022)

Despues de 021, ejecuta una sola vez
[022_idempotencia_radicacion.sql](022_idempotencia_radicacion.sql).
Agrega la tabla InnoDB `intentos_radicacion`, con clave unica por actor/UUID,
huella del formulario/PDFs y resultado JSON confirmado atomicamente.
No modifica expedientes anteriores. No se aplica al iniciar el backend.
Si la tabla ya existe, verifica su estructura; no reejecutes el DDL a ciegas.
Reinicia el backend y actualiza el frontend compatible.

Conserva esta tabla junto con radicados, secuencias y PDFs al respaldar:
los reintentos despues de un reinicio necesitan su resultado original.
No tiene purga automatica. El procedimiento de recuperacion ficticia aislada
esta en el [README principal](../README.md).
