# Lectura de documentos para el origen interno

**Estado:** completed

## Objetivo

Permitir que el funcionario de la dependencia remitente de una comunicación
interna consulte y descargue los documentos originales del radicado, sin
concederle permisos de gestión del expediente.

## Alcance

- La lectura de `/api/radicados/:numero_radicado/documentos` reutiliza la
  autorización de lectura del radicado.
- La descarga autenticada de los archivos conserva esa misma autorización.
- El origen interno puede continuar consultando la respuesta interna y la
  trazabilidad que le correspondan.
- Las rutas de cambio de estado, edición y demás acciones administrativas
  continúan usando autorización de gestión.
- No se amplía el acceso a comunicaciones externas, radicados de otras
  dependencias ni usuarios sin relación válida.

## Experiencia frontend

Si la consulta de documentos falla de forma parcial, el detalle permanece
abierto y muestra el estado dentro de «Documentos adjuntos». El resumen, la
respuesta interna y la trazabilidad no se ocultan por ese fallo. El mensaje
global de sesión sin acceso se reserva para errores de autorización del
expediente completo.

## Verificación

- Pruebas backend para origen interno, destino, Administrador, Ventanilla,
  comunicaciones externas y cambio de estado.
- Pruebas React para mantener abierto el detalle y mostrar el error local de
  documentos sin `window.alert`.
- `node --check`, `npm test`, `npm run test:mysql`, pruebas React, build,
  suite legacy y `git diff --check`.

## Revisión visual y funcional aprobada

- Talento Humano, como origen, visualiza el radicado interno enviado, sus
  documentos originales y el seguimiento.
- Planeación, como destino, conserva su flujo, estados y respuesta.
- La lectura y descarga de documentos originales funcionan sin errores.
- La trazabilidad muestra eventos y estados completos y claros.
- Los permisos se mantienen restringidos al alcance esperado del origen
  interno, sin escalamiento de acciones.
- `scrollWidth <= clientWidth` con menús nativos cerrados:
  - 320 px: `true`;
  - 375 px: `true`;
  - 440 px: `true`;
  - escritorio: `true`.
- Resultado: evidencia registrada y funcionalidad validada sin regresiones.
