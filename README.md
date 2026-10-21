# Backend de Ventanilla Unica

## Instalacion nueva y actualizacion

Para una **base vacia**, el punto inicial versionado es
[000_base_radicados.sql](migrations/000_base_radicados.sql). Define la tabla
legada minima que necesitan las migraciones posteriores, incluidos los campos
de adjuntos que la 013 traslada y elimina. No es una copia del esquema de una
base en uso ni un esquema final para ejecutar solo y arrancar el servidor.

Requisitos de destino: Node.js 22.12 o posterior compatible con las dependencias,
MySQL 8.0.16+ o MariaDB 10.6+ con InnoDB, claves foraneas y restricciones CHECK
activas. Usa una base dedicada y vacia con charset `utf8mb4` y collation
`utf8mb4_unicode_ci`, tambien como valores predeterminados de la base para que
las columnas de texto de las distintas tablas sean compatibles al crear FKs.
La cuenta usada para instalar necesita permisos DDL/DML; la cuenta de ejecucion
debe tener solo los permisos que requiere la aplicacion.

En una terminal del backend configura `DB_HOST`, `DB_USER`, `DB_PASSWORD` y
`DB_NAME` para la base nueva antes de ejecutar los pasos JavaScript. No guardes
credenciales en archivos versionados. Por ejemplo, para una futura prueba aislada:

```powershell
$env:DB_NAME = 'ventanilla_unica_test'
```

Selecciona **esa misma base** en phpMyAdmin para importar los archivos SQL
individualmente. No inicies el backend hasta terminar. Ejecuta exactamente en
este orden, deteniendote si un paso falla:

| Paso | Archivo SQL que importar o comando Node que ejecutar |
| --- | --- |
| 000 | [000_base_radicados.sql](migrations/000_base_radicados.sql) |
| 001 | [001_control_terminos.sql](migrations/001_control_terminos.sql) |
| 002 | `node migrations\002_actualizar_tipos_tramite.js` |
| 003 | [003_rbac.sql](migrations/003_rbac.sql) |
| 004 | [004_respuestas_institucionales.sql](migrations/004_respuestas_institucionales.sql) |
| 005 | [005_documentos_respuesta.sql](migrations/005_documentos_respuesta.sql) |
| 006 | [006_usuarios_activos.sql](migrations/006_usuarios_activos.sql) |
| 007 | [007_dependencias_activas.sql](migrations/007_dependencias_activas.sql) |
| 008 | [008_secuencia_y_documentos_radicado.sql](migrations/008_secuencia_y_documentos_radicado.sql) |
| 009 | `node migrations\009_consolidar_dependencias.js` |
| 010 | [010_limites_login.sql](migrations/010_limites_login.sql) |
| 011 | [011_campos_recepcion_documental.sql](migrations/011_campos_recepcion_documental.sql) |
| 012 | [012_retirar_copias_y_declaracion_firma.sql](migrations/012_retirar_copias_y_declaracion_firma.sql) |
| 013 | [013_normalizar_adjuntos_radicado.sql](migrations/013_normalizar_adjuntos_radicado.sql) |
| 014 | [014_retirar_tipo_movimiento.sql](migrations/014_retirar_tipo_movimiento.sql) |
| 015 | [015_comunicaciones_internas_externas.sql](migrations/015_comunicaciones_internas_externas.sql) |
| 016 | [016_terminos_generales_peticion.sql](migrations/016_terminos_generales_peticion.sql) |
| 017 | [017_destino_todas_dependencias.sql](migrations/017_destino_todas_dependencias.sql) |
| 018 | [018_seguimiento_por_dependencia.sql](migrations/018_seguimiento_por_dependencia.sql) |
| 019 | [019_procedencia_radicados.sql](migrations/019_procedencia_radicados.sql) |

Las migraciones SQL no son todas idempotentes y los cambios DDL pueden quedar
confirmados aunque un paso posterior falle: no vuelvas a importar toda la
secuencia sobre una instalacion parcial. Revisa el error y el esquema antes de
continuar. Los pasos 002 y 009 deben ejecutarse en su posicion, no al final:
009 comprueba las referencias existentes antes de que 018 agregue seguimientos.
La secuencia conserva los catalogos y terminos actuales del proyecto; antes del
uso institucional revisa los plazos especiales con el responsable juridico.

Para una **base existente**, respalda estructura, datos y adjuntos, identifica
las migraciones ya aplicadas y ejecuta solo las pendientes en orden. **No
ejecutes 000** ni recrees `radicados`: no cambia ni reemplaza datos existentes.
Actualmente no hay un registro automatico de migraciones aplicadas.

### Alcance de la validacion del esquema

La prueba `node --test test\esquema-base.test.js` verifica por lectura de archivos
los campos base, las adiciones/retiros de columnas, las referencias a radicados
y el INSERT actual. No conecta a MySQL ni valida toda la sintaxis SQL, las
collations reales o los efectos de los scripts JS.
**La instalacion completa desde cero aun requiere una ejecucion de aceptacion
en una base aislada; no se ha ejecutado como parte de esta mejora.**

La migración 019 sí se aplicó y verificó en la base local existente, después
de respaldar estructura. Una conexión nueva confirmó columnas NULLables,
índice/FK y conservación de los cinco registros previos mediante comparación
de sus campos originales. No se crearon radicados reales de prueba.
Esta comprobación no sustituye una prueba de radicación de extremo a extremo.

Cuando se autorice esa validacion, importa la secuencia completa en una base
de prueba vacia, comprueba las FKs y columnas con `SHOW CREATE TABLE`, las 24
dependencias activas, la ausencia de adjuntos en `radicados`, los contadores de
login y el seguimiento por dependencia. Crea solo cuentas ficticias mediante
el script de administrador descrito abajo y comprueba login, radicacion con
PDF, consulta/descarga por roles y respuesta individual/global. No pruebes
reinstalaciones sobre una base con ciudadanos ni presentes las pruebas con
MySQL simulado como verificacion de instalacion.

## Destino para todas las dependencias

Antes de iniciar esta versión, aplica una sola vez
[017_destino_todas_dependencias.sql](migrations/017_destino_todas_dependencias.sql)
en la base `ventanilla_unica`. La columna nueva queda en `0` para todos los
radicados existentes; no los convierte en globales. Al radicar y elegir
“Todas las dependencias”, el servidor guarda `dependencia_destino_id` como
`NULL`, el nombre legible en `dependencia_destino` y la marca como `1`.

Los radicados globales son visibles para funcionarios de cualquier dependencia.
Cada dependencia mantiene su propio estado y respuesta. El radicado original,
sus documentos y el término legal son compartidos. Aplica también, una sola vez,
[018_seguimiento_por_dependencia.sql](migrations/018_seguimiento_por_dependencia.sql)
después de la 017; esta migración asigna los radicados globales existentes a las
dependencias activas y atribuye respuestas históricas a la dependencia del autor
cuando puede determinarla. La migración no se ejecuta automáticamente; reinicia
el backend después de aplicarla. Las dependencias nuevas o reactivadas reciben
asignaciones para los radicados globales existentes.
La creación o reactivación y sus asignaciones se confirman en una misma
transacción: si falla la asignación de seguimientos, se revierte también la
creación o el cambio de estado. Solo se devuelve éxito después del `commit`.

## Términos legales generales

La migración [016_terminos_generales_peticion.sql](migrations/016_terminos_generales_peticion.sql)
registra, para tipos sin ningún término previo, 10 días hábiles para información
y documentos, 30 para consultas y 15 para peticiones generales. Los términos se
guardan con vigencia desde la fecha local de Bogotá en que se ejecute. La
migración es idempotente: no duplica ni reemplaza términos existentes y no
modifica los términos históricos aplicados a radicados.

Esta migración no agrega términos a las categorías `entre_autoridades` y
`especial`, porque requieren identificar el subtipo, la norma especial o la
competencia de la entidad. Si ya tienen términos, la migración los conserva;
si no, permanecen fuera del selector de radicación hasta que un administrador
registre un término validado en Gestión de catálogos.

Haz una copia de seguridad y ejecuta el contenido de la migración una sola vez
en phpMyAdmin, seleccionando la base `ventanilla_unica`. Requiere que ya existan
`tipos_tramite` y `terminos_legales` y que el catálogo esté cargado; si las
migraciones 001 y 002 ya se aplicaron, no las vuelvas a ejecutar. Esta migración
solo completa tipos sin ningún término previo: conserva cualquier término
existente, incluidos los que requieran revisión jurídica. No la ejecutes sobre
otra base.

## Campos de recepción documental

Antes de iniciar esta versión, respalda la base de datos y aplica una sola vez
[011_campos_recepcion_documental.sql](migrations/011_campos_recepcion_documental.sql).
La migración agrega a `radicados` el tipo de movimiento, el número de copias,
la declaración de firma y la fecha/hora de recepción. Rellena la fecha/hora de
los registros existentes a partir de `fecha_creacion`; no altera radicados,
adjuntos ni términos históricos. Revisa que las columnas no existan antes de
ejecutarla y reinicia el backend después de aplicarla.

La migración [012_retirar_copias_y_declaracion_firma.sql](migrations/012_retirar_copias_y_declaracion_firma.sql)
retira `numero_copias` y `declara_firma` de `radicados`; conserva `numero_folios`.
Aplica 012 una sola vez después de 011, con respaldo previo. Si una instalación
nueva aplica toda la secuencia, también debe ejecutar ambas migraciones en orden.

La migración [013_normalizar_adjuntos_radicado.sql](migrations/013_normalizar_adjuntos_radicado.sql)
consolida los PDFs de radicación en `documentos_radicado`. Copia primero los
adjuntos antiguos que falten (su tamaño queda `NULL` si no existe metadato) y
después elimina `nombre_archivo_original` y `ruta_archivo` de `radicados`.
Ejecuta 013 una sola vez, después de 012 y con respaldo previo. Para instalaciones
nuevas, aplica las migraciones en orden. Aplica ambas antes de iniciar el backend
con esta versión, porque la ruta y el nombre del archivo ya no se escriben en
`radicados`.

La migración [014_retirar_tipo_movimiento.sql](migrations/014_retirar_tipo_movimiento.sql)
elimina `tipo_movimiento`; `estado` conserva el seguimiento de recepción y trámite.
Ejecuta 014 una sola vez, después de 013 y con respaldo previo. Para instalaciones
nuevas, aplica toda la secuencia en orden.

## Ejecutar y probar

```powershell
npm start
npm test
```

Reinicia el proceso Node.js despues de modificar el backend; `npm start` no
recarga los archivos automaticamente.

### Manejo de fallos en ampliaciones

`POST /api/radicados/:numero_radicado/ampliaciones` adquiere la conexion dentro
del bloque de manejo de errores. Ante fallos de conexion o transaccion devuelve
HTTP 500 con un mensaje controlado y registra el detalle en el servidor. Si la
reversion falla, descarta la conexion en lugar de devolverla al pool; no
reintenta una reversion fallida de una salida de validacion. Conserva los
permisos administrativos y las validaciones de vencimiento y fechas.

Prueba focalizada: `node --test test\ampliaciones.test.js`. Usa MySQL simulado y
cubre adquisicion, inicio, consultas, escrituras, confirmacion y reversion,
ademas del flujo exitoso y los rechazos de negocio.

## Validacion de integracion MySQL local

Haz la validacion en una base separada, por ejemplo `ventanilla_unica_test`, y
usa exclusivamente datos ficticios. Para prepararla desde cero, sigue la
secuencia 000-019 de la seccion de instalacion nueva. Tambien puedes importar
solo la estructura de una base compatible (sin filas), pero esa alternativa
no demuestra que la secuencia de instalacion limpia sea ejecutable.

Con la base aislada ya preparada, selecciona esa base antes de iniciar o probar
el backend:

```powershell
$env:DB_NAME = 'ventanilla_unica_test'
$env:PORT = '3001'
npm start
```

En otra terminal, configura el mismo `DB_NAME` y ejecuta `npm test`. La prueba
MySQL de límites de inicio de sesión es optativa; ejecútala solo contra la base
aislada:

```powershell
$env:DB_NAME = 'ventanilla_unica_test'
$env:TEST_LOGIN_MYSQL = '1'
node --test test\limites-login-mysql.test.js
Remove-Item Env:TEST_LOGIN_MYSQL
```

Las pruebas HTTP que adjuntan PDFs escriben los archivos en `uploads\` del
backend, aunque la base sea de prueba. Usa nombres/datos ficticios y elimina
solo los archivos creados por esa prueba. No ejecutes migraciones sobre la base
de uso actual para validar una instalación limpia.

## Origenes permitidos (CORS)

Fuera de produccion, si no defines `CORS_ALLOWED_ORIGINS`, solo se permiten
`http://localhost:5173` y `http://127.0.0.1:5173`. Una lista explicita sustituye
estos valores, no los agrega. Debe contener origenes HTTP/HTTPS exactos separados
por comas, incluyendo el puerto cuando corresponda, sin barra final, rutas,
credenciales ni comodines. Un cambio de protocolo, host o puerto es otro origen.

En produccion configura las variables antes de iniciar (sustituye los ejemplos
por los dominios reales del frontend):

```powershell
$env:NODE_ENV = 'production'
$env:CORS_ALLOWED_ORIGINS = 'https://ventanilla.example.com,https://admin.example.com'
npm start
```

En produccion el backend falla al iniciar si falta la lista; cualquier lista
vacia o invalida tambien impide el arranque. Los origenes no autorizados,
incluido `Origin: null`, reciben 403 antes de llegar a las rutas. Se permiten
preflight para origenes autorizados y se expone `Retry-After` al frontend para
el limitador de login. No se habilitan cookies entre origenes; se conserva
la autenticacion con token en `Authorization`.

Las solicitudes sin `Origin` (por ejemplo, clientes de consola o servicios)
siguen funcionando y requieren los mismos permisos y autenticacion. CORS no
sustituye estos controles ni impide que un cliente externo falsifique `Origin`.
Pruebas focalizadas: `node --test test\cors.test.js`.

## RBAC y autenticacion

Aplica una sola vez [003_rbac.sql](migrations/003_rbac.sql) despues de las
migraciones de terminos. Para instalaciones nuevas, aplica [004_respuestas_institucionales.sql](migrations/004_respuestas_institucionales.sql)
para crear `respuestas_radicado`. Si la tabla ya existe con las columnas
`numero_radicado`, `contenido`, `plantilla`, `nombre_archivo`, `ruta_archivo`,
`usuario_id` y `fecha_envio`, no necesitas ejecutar esa migración. El script 003 crea `dependencias` y `usuarios`, agrega
`radicados.dependencia_destino_id` con FK e indice y enlaza los nombres historicos
de dependencias. No repitas la migracion en una base que ya tenga esas tablas o
columna; primero revisa su esquema. Las claves nuevas se almacenan con bcrypt
(costo 12) en el campo
`password`, nunca en texto plano.

Para crear el primer administrador, configura variables en la misma terminal:

```powershell
$env:ADMIN_NOMBRE = Read-Host 'Nombre del administrador'
$env:ADMIN_EMAIL = Read-Host 'Email del administrador'
$clave = Read-Host 'Clave (minimo 10 caracteres, mayuscula, minuscula, numero y simbolo; maximo 72 bytes)' -AsSecureString
$env:ADMIN_PASSWORD = [System.Net.NetworkCredential]::new('', $clave).Password
try { node scripts\crear-administrador.js } finally {
    Remove-Item Env:ADMIN_PASSWORD
    Remove-Variable clave
}
npm start
```

El script no sustituye una cuenta existente. Despues del primer administrador,
crea cuentas mediante `POST /api/usuarios`, exclusivamente con sesion administrativa.
Los funcionarios necesitan `dependencia_id`; administrador y ventanilla usan NULL.

## Gestion y edicion de usuarios

Antes de iniciar esta version, aplica una sola vez
[006_usuarios_activos.sql](migrations/006_usuarios_activos.sql). Agrega `activo`
con valor inicial 1 a todas las cuentas existentes; no borra usuarios ni cambia
sus roles. Realiza un respaldo y revisa el esquema antes de aplicar la migracion.
No la repitas si la columna ya existe. Reinicia el backend despues de aplicarla.

Todas las operaciones de gestion requieren una sesion de administrador:

| Operacion | Metodo y ruta | Resultado |
| --- | --- | --- |
| Crear | `POST /api/usuarios` | 201, cuenta activa |
| Listar | `GET /api/usuarios` | 200, incluye cuentas activas e inactivas |
| Consultar para editar | `GET /api/usuarios/:id` | 200, datos de una cuenta |
| Editar | `PUT /api/usuarios/:id` | 200, revoca las sesiones del usuario editado |
| Inactivar (baja logica) | `PATCH /api/usuarios/:id/estado` con `{ "activo": 0 }` | 200, suspende el acceso |
| Reactivar | `PATCH /api/usuarios/:id/estado` con `{ "activo": 1 }` | 200, requiere nuevo login |

Ejemplo de creacion:

```json
{
  "nombre": "Ana Perez",
  "email": "ana@example.com",
  "password": "Una-clave-larga-123",
  "rol": "funcionario",
  "dependencia_id": 2
}
```

La dependencia debe existir. Para administrador y ventanilla usa
`dependencia_id: null`. El servidor recorta nombre y email, normaliza el email a
minusculas y almacena la clave con bcrypt. Las respuestas de gestion nunca
incluyen la clave ni su hash.

Para editar, envia nombre, email, rol y dependencia_id; omite `password` si
quieres conservarla. Si la envias, debe tener al menos 10 caracteres, una
mayuscula, una minuscula, un numero y un simbolo (no basta un espacio).
Se admiten letras Unicode, pero el limite es 72 bytes UTF-8, no 72 caracteres;
se rechaza el caracter nulo. El primer administrador usa la misma politica. La
edicion no cambia `activo`: utiliza la ruta de estado para activar o inactivar.
La creacion siempre produce una cuenta activa.

Los hashes scrypt existentes siguen permitiendo el login con la clave original.
Tras un login correcto de una cuenta activa con configuracion valida, se
actualizan a bcrypt sin cambiar la clave; la complejidad solo se exige al crear
o cambiar contrasenas, no retroactivamente. La actualizacion comprueba que el
hash no haya cambiado mientras se verificaba la clave; si cambio, responde 409
sin crear sesion. Las claves antiguas de mas de 72 bytes o con caracter nulo
conservan scrypt hasta que el administrador las cambie por una clave compatible.
Nunca se truncan claves. No hace falta migrar el esquema de `usuarios.password`.

No hay borrado fisico ni ruta `DELETE`: la baja logica conserva la identidad del
autor, los radicados y las respuestas institucionales. Activar o inactivar revoca
todas las sesiones de esa cuenta. Una cuenta inactiva no puede iniciar sesion y
su estado se comprueba en cada solicitud autenticada. La lista administrativa
incluye `activo`; el selector `GET /api/usuarios/ventanilla` solo incluye cuentas
activas. Un administrador no puede inactivarse ni quitarse su propio rol.

Errores: 400 para datos invalidos, 401 sin sesion valida, 403 para rol no permitido
o cuenta inactiva, 404 para usuario inexistente, 409 para email duplicado o
autoinactivacion y 422 para dependencia inexistente. Se usa
`{ "success": false, "message": "..." }`.

Prueba focalizada: `node --test test\usuarios.test.js`. Las pruebas HTTP usan
MySQL simulado; no sustituyen la aplicacion de la migracion en la base real.

## Gestion de catalogos: dependencias y tipos de tramite

La migracion `node migrations\009_consolidar_dependencias.js` establece las 24
dependencias institucionales aprobadas. Antes de ejecutarla, respalda
`dependencias`, las asignaciones de `usuarios` y `radicados`, y
`historial_radicado`; ejecutala sin escrituras concurrentes al catalogo.
Conserva los IDs existentes y prioriza Oficina de Planeacion al consolidarla
con Secretaria de Planeacion. Traslada las referencias de usuarios y radicados,
registra el cambio de ID en el historial y conserva los nombres historicos de
los radicados. Si encuentra una dependencia antigua llamada "Todas las
dependencias", la retira solo si no tiene referencias. La opcion actual de
destino global es una marca del radicado y no una dependencia del catalogo.
La operacion es transaccional y puede repetirse sin duplicar oficinas.
Si detecta otras dependencias sin equivalencia o referencias de otras tablas,
falla sin aplicar cambios. No cambia roles, claves, documentos ni terminos.

Aplica una sola vez [007_dependencias_activas.sql](migrations/007_dependencias_activas.sql)
antes de ejecutar esta version. Agrega `dependencias.activo` con valor inicial 1,
sin cambiar IDs ni referencias. Respalda y revisa el esquema antes de aplicarla;
no la repitas si la columna existe. `tipos_tramite.activo` ya existe en la
migracion 001 y no requiere otra modificacion. Reinicia el backend.

La gestion es exclusiva del administrador y requiere el token de sesion:

| Accion | Dependencias | Tipos de tramite |
| --- | --- | --- |
| Listar activos para selectores | `GET /api/dependencias` | `GET /api/tipos-tramite` |
| Listar todos para administrar | `GET /api/dependencias?incluir_inactivos=1` | `GET /api/tipos-tramite?incluir_inactivos=1` |
| Consultar uno, activo o inactivo | `GET /api/dependencias/:id` | `GET /api/tipos-tramite/:id` |
| Crear | `POST /api/dependencias` | `POST /api/tipos-tramite` |
| Editar datos del catalogo | `PUT /api/dependencias/:id` | `PUT /api/tipos-tramite/:id` |
| Inactivar o reactivar | `PATCH /api/dependencias/:id/estado` | `PATCH /api/tipos-tramite/:id/estado` |

Las listas por defecto mantienen los permisos de lectura existentes. Un
funcionario solo recibe su dependencia, incluso si esta inactiva, para poder
consultar su historial; nunca recibe otras. Ventanilla y administrador reciben
solo dependencias activas sin el parametro. `incluir_inactivos=1` es exclusivo del
administrador; acepta solo `0` o `1`. Las listas conservan las claves
`dependencias` y `tipos_tramite`, y agregan `activo` a cada elemento. Las consultas
individuales devuelven `{ success, dependencia }` o `{ success, tipo_tramite }`.

Antes de habilitar la radicación de varios archivos, aplica una sola vez
[008_secuencia_y_documentos_radicado.sql](migrations/008_secuencia_y_documentos_radicado.sql).
La migración crea el contador anual y la tabla de documentos asociados a cada
radicado. Conserva los adjuntos actuales y sincroniza el contador con radicados
que ya tengan el formato `RAD-AAAA-####` o `RAD-AAAAMMDD-####`. Respalda la base de datos y revisa el
esquema antes de aplicarla.

Para clasificar las comunicaciones, respalda la base de datos y aplica una sola
vez [015_comunicaciones_internas_externas.sql](migrations/015_comunicaciones_internas_externas.sql)
después de las migraciones anteriores (incluida la 014). La migración crea las tablas
`comunicaciones_internas` y `comunicaciones_externas`, conserva `radicados` como
tabla común y distribuye los registros existentes sin borrar ni renumerar datos.
La clasificación de históricos conserva `radicados.tipo_comunicacion` cuando ya
es Interna o Externa; para valores antiguos usa el tipo de trámite asociado.

En nuevas radicaciones el cliente elige `tipo_comunicacion` (`Interna` o
`Externa`), independientemente del trámite, y el servidor valida esa selección.
La clasificación sugerida por el catálogo no sustituye este campo obligatorio.
`GET /api/radicados?tipo_comunicacion=Interna` o `Externa` permite filtrar por
la tabla correspondiente. Esta versión no registra un sentido recibido o
despachado.

### Procedencia de las comunicaciones (019)

Aplica una sola vez [019_procedencia_radicados.sql](migrations/019_procedencia_radicados.sql)
después de 018, revisando antes `SHOW CREATE TABLE radicados` y
`SHOW CREATE TABLE dependencias` y respaldando la estructura fuera del repositorio.
El ID de origen es `INT`, igual al ID del catálogo. `ALTER TABLE` implica commit;
no se debe prometer rollback transaccional ni reejecutar sobre un estado parcial.
Esta migración agrega tres columnas NULLables, índice y FK sin cascadas. No
modifica ni deduce la procedencia de registros históricos.

En `POST /api/radicados` (multipart, con los adjuntos y campos habituales):

| Clase | Campos adicionales y reglas |
| --- | --- |
| Interna | `dependencia_remitente_id`: ID entero positivo de una oficina activa; sin opción `todas`. El servidor resuelve y guarda `dependencia_remitente` como nombre histórico, ignorando nombres enviados por el cliente. No enviar `remitente_tipo_persona`. |
| Externa | `remitente_tipo_persona`: `natural` o `juridica`; `remitente_email` válido, máximo 150 caracteres. No enviar origen institucional. |
| Externa jurídica | Además, `remitente_entidad` como razón social, máximo 150 caracteres, y `remitente_nit` de 1 a 12 dígitos. No se verifica el registro fiscal del NIT. |

En ambas clases siguen siendo obligatorios nombre (máximo 150), cédula/documento
(1 a 10 dígitos) y asunto (máximo 5000). Una jurídica también identifica a su
persona de contacto con nombre y cédula. El frontend conserva teléfono obligatorio;
entidad/razón social es obligatoria en externas y queda deshabilitada y no se
envía en internas. Su texto se conserva al alternar de clase hasta un guardado
exitoso. El NIT interno permanece habilitado y opcional. El servidor conserva
la opcionalidad previa de entidad para internas/naturales y valida longitudes.
No se agrega dirección física.
El correo solo es obligatorio para externas.

Datos ausentes, formatos incorrectos y combinaciones incompatibles retornan
400; origen inexistente/inactivo retorna 422. Se eliminan los adjuntos de
solicitudes rechazadas sin guardar el radicado. El origen puede coincidir con
el destino; nunca otorga visibilidad ni permisos adicionales al funcionario.

La respuesta de creación incluye `dependencia_remitente_id`,
`dependencia_remitente` y `remitente_tipo_persona`, también disponibles en los
listados. El detalle y los comprobantes muestran el nombre histórico de origen;
en internas antiguas sin ese dato muestran «No registrada».

Despliega frontend/backend coordinadamente y reinicia el backend tras aplicar
019. Los clientes antiguos que envíen internas sin origen o externas sin tipo
de persona/correo dejarán de poder crear radicados; las consultas históricas
no requieren completar esos campos.

Para crear o editar una dependencia:

```json
{ "nombre": "Planeacion" }
```

El nombre se recorta y debe tener de 1 a 150 caracteres. La edicion conserva el
ID: no reescribe el nombre historico guardado en los radicados ni cambia las
asignaciones de usuarios. Usa IDs para filtrar alertas de registros antiguos;
el filtro legado por nombre conserva su comparacion con el nombre historico.

Para crear un tipo y su termino legal inicial, ambos en una transaccion:

```json
{
  "codigo": "tramite_especial",
  "nombre": "Tramite especial",
  "categoria_general": "especial",
  "dias": 15,
  "tipo_dias": "habiles",
  "fundamento_legal": "Indica la norma aplicable verificada por la entidad",
  "vigente_desde": "2026-10-12"
}
```

El ejemplo no define un plazo legal para la entidad: verifica dias, fundamento y
vigencia antes de guardar. Codigo: de 2 a 60 caracteres, minusculas, digitos y
guion bajo. Nombre: hasta 150 caracteres. Categorias: `peticion_general`,
`informacion_documentos`, `consulta`, `entre_autoridades` o `especial`.
Tipo de dias: `habiles` o `calendario`; fundamento: hasta 500 caracteres.

Para editar solo los datos del catalogo:

```json
{
  "codigo": "tramite_especial",
  "nombre": "Tramite especial actualizado",
  "categoria_general": "especial",
  "orden": 5
}
```

`orden` es opcional; si se omite, se conserva. Debe ser un entero no negativo.
La edicion no modifica dias ni vencimientos: se rechazan campos de termino,
vigencia o `activo` enviados a este PUT para evitar confundir operaciones.
El nombre de catalogo consultado con joins refleja la nueva denominacion; los
datos historicos y terminos aplicados a radicados no se reescriben.

Para cambiar el plazo, utiliza la ruta existente `POST /api/terminos-legales` con
`tipo_tramite_id`, `dias`, `tipo_dias`, `fundamento_legal` y `vigente_desde`
(hoy o posterior). Crea una version y cierra la vigencia anterior en una
transaccion; nunca recalcula los terminos aplicados a radicados. No admite tipos
inactivos ni vigencias solapadas con una version de la misma fecha o posterior.
Consulta las versiones mediante `GET /api/terminos-legales?tipo_tramite_id=1`.

Ambas rutas PATCH reciben `{ "activo": 0 }` para inactivar y `{ "activo": 1 }`
para reactivar, con numeros, no cadenas ni booleanos. No hay DELETE ni borrado
fisico. Inactivar excluye de los selectores y bloquea su uso en nuevos radicados,
incluso si el cliente envia su ID o nombre manualmente. No suspende cuentas ni
impide consultar o gestionar radicados anteriores. Para suspender una cuenta
utiliza el estado de usuarios. Reactivar conserva el ID y las versiones legales;
para radicar con un tipo sigue siendo necesario un termino vigente.
Los nombres y codigos de elementos inactivos siguen reservados: reactiva el
elemento existente en lugar de crear un duplicado.

Creacion: 201; consultas y cambios: 200. Errores con `{ success: false, message }`:
400 para datos invalidos, 401 sin sesion, 403 sin permiso administrativo, 404 para
elemento inexistente, 409 para duplicados/conflictos y 422 al intentar radicar con
una dependencia inactiva o un tipo sin termino activo y vigente.

En el frontend agrega una pantalla administrativa con tabla, formulario de
creacion/edicion y accion Activar/Inactivar; usa las listas completas solo alli.
En los formularios de radicacion conserva las listas por defecto. Muestra
`message` ante errores y recarga la lista despues de un cambio confirmado.
Prueba focalizada: `node --test test\catalogos.test.js` (MySQL simulado).

### Sesion

- `POST /api/auth/login`: JSON `{ "email": "...", "password": "..." }`.
  Devuelve `{ success, token, usuario }`; el usuario incluye `id`, `nombre`,
  `email`, `rol`, `dependencia_id` y `dependencia_nombre`, sin password.
- `GET /api/auth/me`: devuelve el usuario actual verificado.
- `POST /api/auth/logout`: revoca la sesion.
- Envia `Authorization: Bearer <token>` en cada consulta protegida.

Los tokens aleatorios duran 8 horas y se mantienen en memoria (un solo proceso,
adecuado para ADSO). Reiniciar Node cierra todas las sesiones. No sirven roles
en cabeceras, parametros o localStorage para obtener permisos: el servidor lee
rol y dependencia de MySQL en cada solicitud.

Aplica una sola vez [010_limites_login.sql](migrations/010_limites_login.sql)
antes de desplegar esta version y reinicia todas las instancias del backend.
Login reserva atomicamente un intento en MySQL por cuenta (10) y por IP (100),
en ventanas de 15 minutos desde el primer intento de cada contador. Cuenta
tambien los intentos exitosos; ningun login reinicia los contadores. La cuenta
se normaliza en minusculas, sin espacios exteriores ni diferencias de acentos,
incluyendo emails inexistentes, para limitar ataques desde distintas IPs.
La IP usa `req.ip`, sin aceptar directamente `X-Forwarded-For`; IPv4 y su
representacion IPv6 mapeada comparten contador. Detras de un proxy, configura
`trust proxy` solo para proxies de confianza de tu despliegue: no lo habilites
globalmente. Sin esa configuracion se cuenta la IP del proxy.
Las claves se guardan como SHA-256 (no son cifrado de datos ni contrasenas).
Todas las instancias deben usar la misma base MySQL y esta version del login.
Los bloqueos sobreviven reinicios; se responde 429 con `Retry-After` en segundos.
Si falla el limitador, se responde 503 sin verificar credenciales ni crear sesion.
Los intentos bloqueados no prolongan la ventana.

Programa una limpieza periodica de contadores vencidos, en lotes, hasta vaciar
los vencidos: `DELETE FROM limites_login WHERE expira <= UNIX_TIMESTAMP() LIMIT 1000`.
Esta tabla no cambia usuarios ni sesiones. Las sesiones siguen en memoria:
compartir el limitador no hace que los tokens funcionen entre instancias.
Pruebas MySQL opcionales: configura `$env:TEST_LOGIN_MYSQL = '1'` y ejecuta
`node --test test\limites-login-mysql.test.js`; crean contadores propios y los
eliminan al terminar, sin modificar cuentas reales.

Cambiar un usuario revoca sus sesiones. Para produccion: HTTPS, cookies HttpOnly,
almacen persistente de sesiones y configuracion de origenes CORS/proxy.

### Permisos

| Accion | administrador | ventanilla | funcionario |
| --- | --- | --- | --- |
| Consultar radicados, alertas, historial y PDFs | Todos | Todos | Solo propia dependencia |
| Crear radicados | Si | Si | No |
| Gestionar estado | Si | No | Solo propia dependencia |
| Enviar respuesta institucional | Si | No | Solo propia dependencia |
| Configurar terminos y ampliar vencimientos | Si | No | No |
| Gestionar usuarios, dependencias y tipos de tramite | Si | No | No |

Todos los endpoints existentes `/api` requieren sesion, excepto login. La antigua
clave `x-admin-key` ya no autoriza operaciones. Usuarios sin dependencia valida no
pueden entrar como funcionarios. Un radicado ajeno devuelve 404 para no revelar
su existencia; una accion de rol no permitido devuelve 403; sin sesion, 401.

- `GET /api/dependencias`: para funcionario devuelve solo su oficina.
- `POST /api/dependencias`: administrador, JSON `{ "nombre": "Planeacion" }`.
- `GET /api/usuarios`: solo administrador, nunca expone hashes.
- `POST /api/usuarios`: nombre, email, password, rol, dependencia_id.
- `PUT /api/usuarios/:id`: los mismos campos; password es opcional. Un
  administrador no puede quitarse su propio rol.
- `GET /api/alertas?dependencia_id=2`: el funcionario solo puede indicar su ID.
  Se conserva `?dependencia=nombre` por compatibilidad, con igual restriccion.
  Un filtro de otra dependencia devuelve 403. Una vez validado, para funcionarios
  el SQL usa exclusivamente el ID de la identidad autenticada, no el nombre
  historico del radicado ni los filtros del cliente. Administrador y ventanilla
  conservan ambos filtros opcionales y la consulta global sin filtros.
- `GET /api/radicados`: para funcionarios filtra por
  `radicados.dependencia_destino_id = req.usuario.dependencia_id`, ignorando
  parametros de dependencia o rol del cliente. Sin una asignacion valida, las
  rutas protegidas devuelven 403 con `{ success: false, message }`, sin datos.
- `GET /api/radicados/:numero_radicado/historial`,
  `GET /api/radicados/:numero_radicado/documentos`, `GET`/`HEAD /uploads/:archivo`
  y `PUT /api/radicados/:numero_radicado/estado` comprueban la misma pertenencia.
  No existe una ruta independiente `GET /api/radicados/:numero_radicado`.
  `GET /api/radicados/:numero_radicado/documentos` lista los metadatos; el PDF
  se descarga desde `/uploads` con autenticación.
- `POST /api/radicados`: envia `dependencia_destino_id` en FormData.
  Temporalmente se admite `dependencia_destino` por nombre exacto de catalogo.
  El servidor guarda ID y nombre de la misma oficina y usa al usuario autenticado
  como receptor, ignorando un nombre de funcionario falsificado.

La radicación acepta de 1 a 5 partes `archivos` (también conserva el campo
singular `archivo` para la interfaz anterior), con un máximo de 10 MB por PDF.
Tanto la radicacion como las respuestas institucionales validan el contenido
con `pdf-lib`: cabecera y cierre PDF, objetos internos y arbol de paginas.
La extension y el MIME siguen siendo filtros preliminares, no la validacion
definitiva. Los archivos corruptos, truncados o cifrados que la biblioteca no
puede leer se rechazan con 400; se eliminan todos los adjuntos de esa solicitud
sin guardar registros. Los errores de lectura del disco devuelven 500 y tambien
activan la limpieza. No se reescriben los bytes del documento ni se modifican
las carpetas, nombres UUID o limites existentes. Los PDFs cifrados detectados
por `pdf-lib` reciben un mensaje especifico indicando que no se pueden validar
y solicitando una copia sin proteccion solo si el usuario tiene autorizacion.
No se solicitan ni almacenan contrasenas, ni se omite la validacion de cifrado.
Los demas PDFs invalidos conservan el mensaje generico y HTTP 400.
Esta validacion estructural
no sustituye un analisis antimalware ni elimina contenido activo de un PDF.

Los radicados nuevos usan el formato `RAD-AAAAMMDD-####`, por ejemplo
`RAD-20261013-0001`. El contador vuelve a `0001` en cada año y se incrementa
dentro de la transacción MySQL para evitar números duplicados en solicitudes
simultáneas. Si un número coincide con un radicado histórico, el sistema avanza
al siguiente consecutivo disponible.

Los radicados antiguos sin dependencia asignada nunca aparecen a funcionarios.
Los eventos de creacion, estado y ampliacion identifican al actor con su ID en
`historial_radicado.usuario`. El historial anterior queda intacto.

### Integracion del frontend (sin cambios automaticos)

El frontend React guarda `token` y `usuario` en sessionStorage; estos
datos no conceden permisos. Al cargar una pantalla, confirma el usuario con
`GET /api/auth/me`. Un 401 borra la sesion local y redirige a login.

El selector `#alertas-dependencia` usa los IDs de `GET /api/dependencias`.
Para funcionario, fija su ID y deshabilita el selector; no repuebles ni habilites
ese selector posteriormente desde la lista de radicados. Oculta acciones de
recepcion para funcionario y deshabilita `.select-estado` para ventanilla en cada
renderizado. Marca las acciones administrativas con `data-rol="administrador"`.
El backend aplica el mismo permiso incluso si se manipula el DOM.
Las referencias a selectores HTML en esta seccion corresponden a la interfaz
legada. Las entradas actuales montan React y usan su servicio centralizado de API.

Los PDFs ya no son publicos: tambien requieren Bearer en GET y HEAD. Usa fetch
autenticado y `URL.createObjectURL(blob)` para mostrar/descargar; revoca el object
URL al cerrar el visor. Un iframe/link directo a `/uploads` no puede enviar el
header y fallara con 401. No pongas el token en la URL.

## Cambio de estado

### Responsable en el modal de respuesta institucional

`GET /api/radicados/:numero_radicado/respuesta` incluye
`dependencia_responsable` junto al autor, fecha, contenido y documentos
existentes. «Ver respuesta» muestra esos datos en el modal **Respuesta
institucional**, con campos separados «Respondida por», «Dependencia
responsable» y «Fecha de envío». El detalle del radicado conserva su estado,
pero no muestra ese bloque ni realiza consultas de respuesta.

`GET /api/radicados/:numero_radicado/respuesta/resumen` permite consultar solo
`funcionario_nombre`, `dependencia_responsable` y `fecha_envio`, dentro de
`{ success: true, respuesta: { ... } }`. Si no existe una respuesta institucional
guardada devuelve HTTP 200 con `respuesta: null`, aunque el estado se haya
cambiado manualmente a Respondido. Los errores reales devuelven 500, no ausencia.
No devuelve contenido ni documentos y no descarga PDFs. Se conserva por
compatibilidad, pero el frontend ya no lo consulta al abrir el detalle.

Conserva la autorización por destino del detalle y de la respuesta completa.
Para globales, administrador/ventanilla deben enviar `radicado_dependencia_id`
de una asignación del radicado; el funcionario solo puede consultar la suya.
IDs malformados se rechazan con 400 y asignaciones ajenas/inexistentes con 404.
En individuales no se admite una asignación global. Estas comprobaciones se
comparten con el endpoint de respuesta completa, que conserva su 404 cuando
todavía no hay respuesta.

La dependencia es el destino atendido, no la
oficina actual del usuario autor; en globales corresponde a la asignación
seleccionada. El nombre proviene del usuario relacionado (incluidos autores
inactivos), no de una instantánea histórica inmutable. Datos ausentes se
identifican expresamente, sin atribuir una respuesta al remitente.

No cambia la radicación en ventanilla ni habilita bandejas Enviados o permisos
por origen. No requiere migración. Despliega backend/frontend coordinadamente
y reinicia el backend para incluir la dependencia en la respuesta completa.

`POST /api/radicados/:numero_radicado/respuesta` acepta `multipart/form-data`
con `contenido` (10 a 10.000 caracteres), `plantilla` opcional y hasta 5 PDFs
en el campo repetido `archivos` (máximo 10 MB por archivo). La tabla existente
`respuestas_radicado` guarda la respuesta y `documentos_respuesta` conserva una
fila por cada PDF; aplica [005_documentos_respuesta.sql](migrations/005_documentos_respuesta.sql)
una sola vez para crear esta tabla hija. Los documentos nuevos se guardan en
`uploads/respuestas/`; los documentos recibidos continúan en `uploads/`. Solo administración y funcionarios autorizados
pueden enviar. La respuesta se registra con el usuario y la fecha, y en una
transacción actualiza el radicado a `Respondido`, marca la fecha de respuesta y
agrega el evento al historial. Cada radicado admite una respuesta. Los PDF de
respuesta usan el mismo control de acceso por dependencia que los adjuntos
recibidos.

`GET /api/radicados/:numero_radicado/respuesta` devuelve el texto, funcionario,
fecha, plantilla y listado de PDFs. `GET /uploads/:archivo` descarga cada PDF
con la misma sesión y validación de dependencia. La vista de ventanilla usa esta
consulta para mostrar la respuesta sin habilitar la edición del radicado.

La estructura de Tablas de Retención Documental queda pendiente hasta contar
con la TRD aprobada de la entidad. No se deben inventar series, plazos ni
disposiciones finales; esos valores definen el calendario y el destino documental.

`PUT /api/radicados/:numero_radicado/estado` recibe JSON:

```json
{ "estado": "Respondido" }
```

Los estados editables coinciden con el formulario y la base de datos:
`Recibido`, `En trámite`, `Pendiente` y `Respondido`. El backend normaliza
mayusculas, espacios y acentos antes de guardar. `Vencido` es una condicion
calculada por el semaforo, no un estado editable desde esta ruta.

La respuesta incluye `success`, `estado`, `fecha_respuesta`,
`tiempo_de_respuesta`, `fecha_limite_actual` y `semaforo`. Un estado no valido
devuelve HTTP 400 con `success: false` y `message`; un radicado inexistente
devuelve HTTP 404.

El cambio de estado, la fecha de respuesta del modulo de terminos y el historial
se guardan dentro de una transaccion. Marcar como `Respondido` conserva la fecha
de respuesta si ya existia; volver a un estado pendiente la elimina y reactiva
el semaforo sin cambiar el termino ni la fecha limite. Esto permite corregir una
marcacion accidental; el historial conserva los cambios.

El frontend debe actualizar su modelo con el `estado` devuelto por la API y
restaurar el selector al estado anterior si la solicitud falla. Debe mostrar
`message`, no solo un error generico.
