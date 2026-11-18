# Aviso de solicitudes de traslado en Ventanilla

**Estado:** completed

## Objetivo

Mostrar en la tarjeta `Revisión de Ventanilla` una notificación accesible cuando
existan solicitudes de traslado pendientes antes de abrir la bandeja detallada.

## Alcance

Aplica a las vistas operativas de Ventanilla y Administrador. La consulta usa
la ruta existente `GET /api/traslados?pagina=1&estado=pendiente` y reutiliza el
campo `pendientes` de la respuesta actual. La vista directa de dependencias no
modifica su comportamiento.

No se agregan endpoints, tablas, permisos, consultas de backend ni cambios al
contrato de la API.

## Comportamiento

- Al cargar la tarjeta operativa se consulta el resumen de pendientes.
- Si `pendientes` es mayor que cero, se anuncia la cantidad con `role="status"`
  y `aria-live="polite"`.
- Si no hay pendientes, no se muestra una alerta.
- Si el resumen falla, se muestra un aviso no bloqueante y `Gestionar traslados`
  continúa disponible para abrir y reintentar la bandeja completa.
- Al abrir la bandeja se conserva la consulta detallada, sus filtros,
  paginación y acciones; el contador se actualiza con la respuesta completa.
- Las lecturas obsoletas se descartan y no se generan consultas adicionales por
  cambios que no correspondan a una recarga o apertura real.

## Accesibilidad y compatibilidad

El aviso tiene texto comprensible, rol de estado y anuncio cortés. Se mantienen
los controles, permisos, tamaños táctiles y estilos responsive existentes.

## Verificación

La aceptación requiere pruebas de Ventanilla, Administrador y dependencia
funcionaria, incluyendo cero pendientes, error del resumen, apertura de la
bandeja y ausencia de llamadas duplicadas. También se ejecutan las suites
React relacionadas, el build y `git diff --check`.
