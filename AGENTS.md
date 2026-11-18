# Guía de trabajo SDD para Ventanilla Única

Este repositorio contiene el backend Node.js/Express, las migraciones MySQL,
la autenticación, la gestión documental y los contratos de API compartidos con
el frontend `ventanilla`.

## Fuente de verdad y alcance

- `AGENTS.md` contiene reglas permanentes de ingeniería.
- `specs/` contiene las especificaciones funcionales y técnicas de los cambios.
- Las rutas, tablas, migraciones y tests existentes se deben inspeccionar antes
  de proponer o implementar cambios.
- El backend es la autoridad final para validación, autorización, fechas,
  transacciones y reglas de negocio.
- Las specs que afecten al frontend y a MySQL se mantienen en `backend/specs/`;
  el frontend debe enlazarlas en su documentación local.

## Comandos oficiales

Ejecuta los comandos desde la raíz de este repositorio:

```powershell
npm test
node --check server.js
```

Las pruebas HTTP levantan servidores temporales con puertos dinámicos en
`127.0.0.1`; necesitan permisos de loopback. Un error `fetch failed` que
contenga `connect EACCES 127.0.0.1:<puerto>` identifica una restricción del
entorno de ejecución, no un fallo funcional del endpoint. Las suites MySQL son
opcionales y deben ejecutarse por separado con la variable `TEST_*_MYSQL`
correspondiente, por ejemplo `TEST_INTEGRIDAD_MYSQL`, `TEST_CONSULTA_MYSQL`,
`TEST_TRASLADOS_MYSQL` o `TEST_LOGIN_MYSQL`, siempre sobre una base aislada.

## Flujo Spec-Driven Development

Para cambios de riesgo medio o alto —migraciones, API, autenticación,
permisos, documentos, entregas, traslados y reglas de negocio— se debe:

1. Crear o actualizar una spec antes de editar código.
2. Registrar contexto, objetivo, fuera de alcance y comportamiento esperado.
3. Definir contratos de API, datos, seguridad, errores y compatibilidad.
4. Escribir criterios de aceptación verificables y relacionarlos con tests.
5. Revisar y aprobar la spec antes de implementar.
6. Implementar en cambios pequeños y revisables.
7. Ejecutar las verificaciones pertinentes y documentar sus resultados.
8. Marcar la spec como `completed` solo después de la revisión humana.

Los cambios triviales de texto o estilos pueden omitir una spec formal, pero
no deben contradecir una spec existente.

## Checklist antes de editar

- Inspeccionar la ruta, tabla, migración, spec y prueba relacionada.
- Confirmar si el cambio afecta permisos, estados, documentos, auditoría o
  contratos públicos.
- Verificar el esquema real antes de preparar cualquier migración.
- Definir fuera de alcance, compatibilidad, rollback e idempotencia cuando
  correspondan.

## Decisiones y límites

- El backend es la autoridad para permisos, estados, fechas, transacciones y
  validaciones; el frontend nunca concede autorización.
- No modificar migraciones ya aplicadas: crear una nueva migración o un
  procedimiento explícito y reversible.
- No tocar bases reales, limpiar datos, borrar adjuntos ni publicar cambios sin
  respaldo y autorización explícita.
- No ejecutar acciones destructivas, despliegues o publicaciones como parte de
  una tarea técnica sin que el usuario las solicite expresamente.

## Resolución de ambigüedades y fallos

- La solicitud explícita del usuario tiene prioridad sobre este archivo.
- El `AGENTS.md` más cercano al archivo modificado tiene prioridad sobre uno
  más general.
- Si backend y frontend parecen contradecirse, prevalecen el contrato del
  backend y la spec compartida.
- Corregir los fallos funcionales; documentar por separado los fallos de
  infraestructura como `EACCES`, `fetch failed`, MariaDB no disponible o
  servicios externos inaccesibles.
- No marcar una tarea como terminada mientras la causa de un fallo permanezca
  sin clasificar.

## Reglas técnicas permanentes

- No rompas nombres de variables, rutas, tablas, columnas ni contratos públicos
  existentes sin documentar una decisión de compatibilidad.
- Usa consultas preparadas y valida entradas y permisos en el servidor.
- Respeta transacciones, claves foráneas, idempotencia y reglas de auditoría.
- No modifiques una migración ya aplicada; crea una nueva migración o un
  procedimiento explícito de reparación.
- Protege datos personales, credenciales, tokens y archivos adjuntos.
- No registres secretos ni contenido sensible en logs.
- Mantén las fechas de negocio en `America/Bogota` y conserva la secuencia
  transaccional de radicados.
- Conserva la validación real de PDF, límites de tamaño, nombres seguros,
  autorización de descarga y limpieza ante errores.
- Explica cada cambio y su riesgo en la spec o en el Pull Request.

## Migraciones y base de datos

- Verifica el esquema antes de aplicar una migración.
- Si una migración DDL falla parcialmente, no repitas `--aplicar` a ciegas:
  inspecciona tablas, columnas, índices, claves foráneas y colaciones.
- No limpies, trunques ni transformes datos reales sin autorización explícita,
  respaldo y procedimiento de reversión.
- Documenta dependencias entre migraciones y pruebas de instalación limpia.

## Verificación y entrega

- Ejecuta los tests existentes pertinentes al cambio y registra la orden y el
  resultado.
- Comprueba tanto la validación del navegador como la autoridad del backend.
- Verifica rollback, idempotencia y liberación de conexiones cuando el cambio
  incluya transacciones o reintentos.
- No marques una tarea como terminada si faltan tests, revisión humana o una
  decisión funcional necesaria.
- Conserva los cambios pequeños para facilitar revisión y rollback.

El reporte final debe indicar como mínimo:

- archivos modificados;
- comandos y pruebas ejecutados;
- resultados obtenidos;
- limitaciones o fallos de infraestructura;
- revisión manual pendiente, si existe.

Las instrucciones específicas de GitHub Copilot en
`.github/copilot-instructions.md` deben mantenerse alineadas con este archivo.
