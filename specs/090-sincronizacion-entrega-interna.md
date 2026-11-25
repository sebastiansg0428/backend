# Sincronización de entrega interna en bandejas

- Estado: completed
- Alcance: radicados internos individuales con respuesta institucional.

## Objetivo

Reflejar en la dependencia de origen y en la bandeja de Ventanilla el estado
`Entregado` después de que la dependencia de origen abra por primera vez una
respuesta interna registrada por cualquier dependencia destinataria.

## Comportamiento esperado

1. La dependencia destinataria registra la respuesta y el radicado permanece
   en `Respondido`.
2. La dependencia de origen abre la respuesta y sus adjuntos.
3. El backend confirma atómicamente la apertura, registra la auditoría y cambia
   el estado canónico a `Entregado`.
4. La bandeja de enviados de la dependencia de origen actualiza de inmediato
   la etiqueta a `Entregado · respuesta abierta`.
5. La tabla de `Radicados` vuelve a consultar el estado al regresar desde otra
   pestaña.
6. Ventanilla vuelve a consultar el estado al regresar a una ventana visible.

No se agregan WebSocket, polling continuo, endpoints, payloads, permisos ni
estados nuevos. La dependencia que elaboró la respuesta conserva su flujo
actual; la sincronización se aplica al radicado canónico y a sus vistas
autorizadas.

## Contrato y seguridad

- Se conserva `POST /api/respuestas-internas/:id/apertura` con payload vacío.
- Solo la dependencia de origen activa puede confirmar la primera apertura.
- La transición `Respondido → Entregado` ocurre dentro de la transacción
  existente y registra `respuesta_interna_abierta`.
- Los reintentos son idempotentes y no duplican la auditoría.
- Un error de apertura mantiene `Respondido` y no actualiza las bandejas.

## Criterios de aceptación

- La apertura exitosa actualiza la tarjeta enviada y la tabla visible.
- Al volver a `Radicados`, la vista refleja el estado confirmado por el
  backend sin requerir una recarga manual completa.
- Ventanilla refleja `Entregado` al volver a la ventana o bandeja.
- No hay polling ni llamadas HTTP adicionales mientras la vista permanece
  activa.
- La trazabilidad muestra `Respondido → Entregado`.
- Las vistas de Administrador, Ventanilla y funcionarios ajenos no obtienen
  permisos adicionales.
- No hay regresiones en adjuntos, comprobantes, traslados, teclado ni
  responsive.

## Verificación

- Pruebas backend existentes de apertura, autorización, idempotencia y
  reversión transaccional.
- Pruebas React de actualización inmediata, retorno a `Radicados`, regreso de
  Ventanilla a una ventana visible y fallo de apertura.
- Build, suite legacy, pruebas visuales y `git diff --check`.

## Revisión visual humana

- Se creó un nuevo radicado desde Talento Humano hacia Planeación.
- Se verificó el flujo de apertura de la respuesta y la sincronización del
  estado en las vistas autorizadas.
- El proyecto funcionó correctamente, sin fallas visuales ni funcionales
  observadas.
- La revisión se realizó con el flujo completo y confirmó la ausencia de
  regresiones.

La spec queda `completed`. La spec 031 permanece en `implementing` hasta
completar la prueba física con la impresora DigitalPOS DIG-2406T Pro.
