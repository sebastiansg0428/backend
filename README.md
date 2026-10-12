# Backend de Ventanilla Unica

## Ejecutar y probar

```powershell
npm start
npm test
```

Reinicia el proceso Node.js despues de modificar el backend; `npm start` no
recarga los archivos automaticamente.

## RBAC y autenticacion

Aplica una sola vez [003_rbac.sql](migrations/003_rbac.sql) despues de las
migraciones de terminos. Para instalaciones nuevas, aplica [004_respuestas_institucionales.sql](migrations/004_respuestas_institucionales.sql)
para crear `respuestas_radicado`. Si la tabla ya existe con las columnas
`numero_radicado`, `contenido`, `plantilla`, `nombre_archivo`, `ruta_archivo`,
`usuario_id` y `fecha_envio`, no necesitas ejecutar esa migración. El script 003 crea `dependencias` y `usuarios`, agrega
`radicados.dependencia_destino_id` con FK e indice y enlaza los nombres historicos
de dependencias. No repitas la migracion en una base que ya tenga esas tablas o
columna; primero revisa su esquema. Las claves se almacenan con scrypt en el campo
`password`, nunca en texto plano.

Para crear el primer administrador, configura variables en la misma terminal:

```powershell
$env:ADMIN_NOMBRE = Read-Host 'Nombre del administrador'
$env:ADMIN_EMAIL = Read-Host 'Email del administrador'
$clave = Read-Host 'Clave (10 a 128 caracteres)' -AsSecureString
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
minusculas y almacena la clave con scrypt. Las respuestas de gestion nunca
incluyen la clave ni su hash.

Para editar, envia nombre, email, rol y dependencia_id; omite `password` si
quieres conservarla. Si la envias, debe tener entre 10 y 128 caracteres. La
edicion no cambia `activo`: utiliza la ruta de estado para activar o inactivar.
La creacion siempre produce una cuenta activa.

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
rol y dependencia de MySQL en cada solicitud. Login tiene limite de 10 intentos
por IP durante 15 minutos; un login correcto reinicia el contador.
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
- `GET /api/radicados/:numero_radicado/historial`, `GET`/`HEAD /uploads/:archivo`
  y `PUT /api/radicados/:numero_radicado/estado` comprueban la misma pertenencia.
  No existe una ruta independiente `GET /api/radicados/:numero_radicado` ni una
  ruta de adjuntos bajo `/api/radicados`; los PDFs se consultan en `/uploads`.
- `POST /api/radicados`: envia `dependencia_destino_id` en FormData.
  Temporalmente se admite `dependencia_destino` por nombre exacto de catalogo.
  El servidor guarda ID y nombre de la misma oficina y usa al usuario autenticado
  como receptor, ignorando un nombre de funcionario falsificado.

Los radicados antiguos sin dependencia asignada nunca aparecen a funcionarios.
Los eventos de creacion, estado y ampliacion identifican al actor con su ID en
`historial_radicado.usuario`. El historial anterior queda intacto.

### Integracion del frontend (sin cambios automaticos)

El login guarda `token` y `usuario` en localStorage solo para el prototipo; estos
datos no conceden permisos. Al cargar una pantalla, confirma el usuario con
`GET /api/auth/me`. Un 401 borra la sesion local y redirige a login.

El selector `#alertas-dependencia` usa los IDs de `GET /api/dependencias`.
Para funcionario, fija su ID y deshabilita el selector; no repuebles ni habilites
ese selector posteriormente desde la lista de radicados. Oculta acciones de
recepcion para funcionario y deshabilita `.select-estado` para ventanilla en cada
renderizado. Marca las acciones administrativas con `data-rol="administrador"`.
El backend aplica el mismo permiso incluso si se manipula el DOM.

Los PDFs ya no son publicos: tambien requieren Bearer en GET y HEAD. Usa fetch
autenticado y `URL.createObjectURL(blob)` para mostrar/descargar; revoca el object
URL al cerrar el visor. Un iframe/link directo a `/uploads` no puede enviar el
header y fallara con 401. No pongas el token en la URL.

## Cambio de estado

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
