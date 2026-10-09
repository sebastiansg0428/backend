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
migraciones de terminos. El script crea `dependencias` y `usuarios`, agrega
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
| Configurar terminos y ampliar vencimientos | Si | No | No |
| Gestionar usuarios y crear dependencias | Si | No | No |

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
