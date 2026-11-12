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
8. Marcar la spec como `implemented` solo después de la revisión humana.

Los cambios triviales de texto o estilos pueden omitir una spec formal, pero
no deben contradecir una spec existente.

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
- No marques una tarea como terminada si faltan tests, revisión humana o una
  decisión funcional necesaria.
- Conserva los cambios pequeños para facilitar revisión y rollback.

Las instrucciones específicas de GitHub Copilot en
`.github/copilot-instructions.md` deben mantenerse alineadas con este archivo.
