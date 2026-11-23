# Notificación de respuesta interna por radicado

**Estado:** completed

## Objetivo

Mostrar la notificación de respuesta interna dentro del radicado enviado al
que pertenece, en lugar de mostrar un contador global encima de toda la
bandeja.

## Comportamiento

- Un radicado interno sin respuesta no muestra notificación.
- Un radicado interno respondido y aún no abierto muestra `respuesta_interna_pendiente: true`.
- Al registrar la primera apertura, la notificación desaparece y el radicado
  puede pasar a `Entregado` según el flujo existente.
- Después de confirmar la primera apertura, la tarjeta de «Radicados enviados»
  muestra `Entregado · respuesta abierta`; antes de esa confirmación conserva
  `Respondido · respuesta disponible`.
- Talento Humano conserva, antes y después de la respuesta, el acceso de
  lectura a la trazabilidad, documentos originales y archivos autenticados.
- Las rutas de gestión, cambios de estado y permisos de otros roles no cambian.

## Contrato

El listado de `/api/radicados` agrega el campo booleano informativo
`respuesta_interna_pendiente`. No se cambian rutas, métodos, payloads ni
autorizaciones.

## Verificación

- Radicado interno en `Recibido` sin respuesta.
- Radicado interno `Respondido` con respuesta pendiente.
- Apertura de respuesta y desaparición del aviso.
- Actualización de la etiqueta de la tarjeta enviada después de la apertura.
- Trazabilidad, documentos y descarga antes de responder.
- Comunicaciones externas, Administrador y Ventanilla sin regresiones.
- Pruebas React, backend, build, responsive, teclado y ausencia de llamadas
  por fila.

## Revisión visual aprobada

- La insignia aparece antes de abrir «Respuestas internas» cuando existe una
  respuesta pendiente.
- La insignia no aparece en radicados sin respuesta pendiente.
- Después de abrir la respuesta, la insignia desaparece y el estado permanece
  coherente.
- `scrollWidth <= clientWidth` con menús nativos cerrados:
  - 320 px: `true`;
  - 375 px: `true`;
  - 440 px: `true`;
  - escritorio: `true`.
- Resultado: revisión visual aprobada sin regresiones.
