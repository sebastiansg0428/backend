# Guía de pruebas del backend

Esta guía explica cómo ejecutar y entender las pruebas del backend de
Ventanilla Única desde PowerShell.

## Requisitos

- Node.js 22.22.2 o una versión compatible con las herramientas actuales.
- Dependencias instaladas con `npm install`.
- MariaDB únicamente para las pruebas que la requieren.
- Una base de datos aislada para las pruebas MySQL.

No uses una base productiva ni una base con datos reales para ejecutar pruebas.
Las pruebas MySQL crean datos ficticios y deben ejecutarse contra una base
aislada configurada para pruebas.

Cada suite que cree una base temporal debe asignar `DB_NAME` y `UPLOAD_DIR`
antes de cargar `db.js` o `server.js`, comprobar con `SELECT DATABASE()` que el
pool apunta a la base temporal y eliminar esa base y sus archivos al finalizar.
No se permite reutilizar el pool de `ventanilla_unica` para escribir fixtures.

## Comprobación inicial

Desde la raíz del backend:

```powershell
cd C:\Users\sebas\OneDrive\Escritorio\ventanilla_app\backend
node --version
where.exe node
```

Estos comandos permiten confirmar qué versión de Node se está usando y desde
qué ubicación se está ejecutando. Si VS Code y PowerShell muestran ubicaciones
distintas, corrige primero el `PATH` de Windows.

## Comandos principales

### 1. Comprobar loopback

```powershell
npm run test:loopback
```

Esta prueba crea un servidor temporal en `127.0.0.1`, lo consulta con `fetch`
y lo cierra. Un resultado correcto se ve así:

```text
Loopback OK en 127.0.0.1:<puerto>
```

Ejecuta este comando cuando aparezca `fetch failed`, `EACCES`, `EPERM` o
`spawn EPERM`.

### 2. Suite general

```powershell
npm test
```

Esta es la validación diaria. Ejecuta las pruebas unitarias y HTTP que no
requieren activar MariaDB de forma explícita.

El resultado final tiene esta forma:

```text
Exitosas: 264
Omitidas: 5
Fallidas: 0
Totales: 269
```

La interpretación correcta es:

- `Exitosas`: pruebas que terminaron correctamente.
- `Omitidas`: pruebas opcionales que requieren MariaDB.
- `Fallidas`: pruebas con errores funcionales o de ejecución.
- `Totales`: suma de exitosas, omitidas y fallidas.

Una ejecución con `Fallidas: 0` es correcta aunque existan pruebas omitidas.

### 3. Suites MySQL

```powershell
npm run test:mysql
```

Este comando activa y ejecuta las cinco suites que requieren MariaDB aislada:

- `TEST_CONSULTA_MYSQL`;
- `TEST_INTEGRIDAD_MYSQL`;
- `TEST_LOGIN_MYSQL`;
- `TEST_RECEPCION_RENDIMIENTO_MYSQL`;
- `TEST_TRASLADOS_MYSQL`.

El comando ejecuta cada archivo de forma secuencial y muestra un resumen
independiente. No actives estas variables contra producción.

Para ejecutar una suite MySQL individual:

```powershell
$env:TEST_TRASLADOS_MYSQL = '1'
node --experimental-test-isolation=none --test test\traslados-mysql.test.js
```

Al cerrar la terminal, la variable temporal desaparece. También puedes
limpiarla manualmente:

```powershell
Remove-Item Env:TEST_TRASLADOS_MYSQL -ErrorAction SilentlyContinue
```

### 4. Verificar sintaxis

```powershell
node --check server.js
node --check auth.js
node --check entregas-respuesta.js
```

Estas comprobaciones detectan errores de sintaxis, pero no sustituyen las
pruebas funcionales.

### 5. Revisar el diff

```powershell
git diff --check
```

Detecta espacios problemáticos y errores básicos de formato en los cambios.

## Qué hacer si aparece un error

### `fetch failed` con `127.0.0.1` o `localhost`

Primero ejecuta:

```powershell
npm run test:loopback
```

Si aparece una causa como `EACCES 127.0.0.1:<puerto>`, es una restricción de
permisos del entorno, no un fallo del endpoint.

En ese caso:

1. Ejecuta PowerShell fuera del entorno restringido de Codex.
2. Solicita permisos ampliados para la prueba.
3. Comprueba que Windows Defender o el antivirus no bloquee `node.exe`.
4. Repite `npm test`.

No clasifiques como infraestructura un `fetch failed` sin revisar su causa.
Si contiene una aserción incorrecta, un código HTTP inesperado o una excepción
de negocio, es un fallo funcional.

### `spawn EPERM`

Significa que Windows no permitió crear un proceso secundario. Puede ocurrir
cuando el ejecutor de VS Code, Node, el antivirus o una política de permisos
bloquea la tarea.

Prueba desde una terminal PowerShell normal:

```powershell
npm run test:loopback
npm test
```

Si es necesario, reinicia VS Code y cierra procesos Node anteriores. No edites
el código para resolver un problema de permisos del sistema.

### MariaDB no disponible

Mensajes como `ECONNREFUSED 3306`, `ER_ACCESS_DENIED_ERROR` o errores de
conexión a MariaDB son de infraestructura cuando la base de pruebas no está
disponible.

Verifica que las variables de conexión apunten a una base aislada y que el
servicio MariaDB esté disponible. No inicies XAMPP ni cambies una base real si
no forma parte de tu entorno de pruebas autorizado.

### Fallo funcional

Trata como fallo funcional:

- `Expected ... but received ...`;
- código HTTP distinto al esperado;
- permisos incorrectos;
- respuesta JSON incompleta o incompatible;
- excepción de aplicación sin una causa de infraestructura comprobable.

En ese caso conserva el mensaje completo, identifica el archivo y la línea de
la prueba, y revisa primero la ruta, el controlador, el servicio y la spec
relacionada antes de editar.

## Mensajes de error esperados en las pruebas

Algunas pruebas provocan errores intencionalmente para comprobar rollback,
limpieza de archivos, rechazo de PDFs cifrados o fallos de auditoría. Por eso
pueden aparecer mensajes como:

```text
Fallo de consulta simulado
Fallo de lectura simulado
PDF cifrado
Fallo ficticio de auditoría
```

No son fallos de la suite si el subtest termina con `ok` y el resumen muestra
`Fallidas: 0`.

## Flujo recomendado

### Para cambios pequeños de backend

```powershell
npm run test:loopback
npm test
node --check server.js
git diff --check
```

### Para cambios de autenticación, permisos, traslados o MySQL

```powershell
npm run test:loopback
npm test
npm run test:mysql
node --check server.js
git diff --check
```

### Para cambios de entregas o documentos

Además de las pruebas generales y MySQL, revisa específicamente:

- permisos por rol y dependencia;
- límites de tamaño y cantidad;
- PDFs corruptos o cifrados;
- limpieza de archivos temporales;
- idempotencia y reintentos;
- rollback y auditoría.

## Reporte final recomendado

Al terminar una tarea, registra:

```text
Comandos:
- npm test
- npm run test:mysql
- node --check server.js
- git diff --check

Resultados:
- Exitosas: ___
- Omitidas: ___
- Fallidas: ___

Clasificación:
- Funcionales: ___
- Infraestructura: ___

Revisión manual pendiente:
- ___
```

No marques una spec como `completed` mientras haya fallos funcionales,
decisiones pendientes o revisión humana sin confirmar.
