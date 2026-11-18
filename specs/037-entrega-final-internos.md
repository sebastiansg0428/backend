# Entrega final de radicados internos

- Estado: proposed
- Alcance: radicados internos individuales con respuesta institucional.

## Objetivo

Cerrar de forma trazable un radicado interno cuando la dependencia de origen
abre correctamente la respuesta que recibió de la dependencia destinataria.
La apertura equivale a la confirmación de entrega interna y cambia el estado
de `Respondido` a `Entregado`.

## Flujo

1. Ventanilla registra el radicado interno con recepción digital o física.
2. La dependencia destinataria registra la respuesta institucional; el radicado
   queda en `Respondido`.
3. La dependencia de origen consulta su bandeja de respuestas internas y puede
   ver el radicado, las dependencias participantes, el canal y los documentos.
4. Después de cargar correctamente la respuesta y sus documentos, la primera
   apertura autorizada registra fecha y actor y cambia el radicado a
   `Entregado`.
5. La trazabilidad conserva el evento de apertura y muestra la transición
   `Respondido → Entregado`.

Digital y física usan la misma transición; el canal se conserva como dato de
trazabilidad. Los radicados internos globales mantienen su flujo actual.

## Reglas de seguridad y consistencia

- Solo un funcionario de la dependencia de origen activa puede registrar la
  apertura final.
- La ruta existente `/api/respuestas-internas/:id/apertura` conserva su método,
  payload vacío, permisos y respuesta compatible.
- La transacción bloquea la recepción y el radicado, verifica que el estado sea
  `Respondido`, registra la apertura, actualiza `radicados.estado` y registra la
  auditoría.
- Reintentos sobre una apertura ya registrada son idempotentes: no cambian la
  fecha ni duplican auditoría.
- Cualquier error revierte apertura, estado y auditoría.
- El estado `Entregado` no se habilita mediante la ruta genérica de estados.

## Interfaz y trazabilidad

La bandeja diferencia `Respondido` como pendiente de apertura y `Entregado`
como respuesta abierta y cierre confirmado. El detalle muestra origen,
destino, canal, disponibilidad, primera apertura, actor y el mensaje
`Respuesta interna entregada` cuando corresponda.

## Criterios de aceptación

- Un flujo individual digital y uno físico terminan en `Entregado` después de
  la primera apertura válida.
- La dependencia de origen ve el radicado en su panel de internos/generados.
- Una dependencia ajena o la dependencia destinataria no puede confirmar la
  apertura final.
- La apertura repetida es idempotente.
- Un radicado global no cambia su comportamiento actual.
- La auditoría conserva actor, fecha, dependencia, canal y transición.
- Los fallos transaccionales no dejan cambios parciales.
