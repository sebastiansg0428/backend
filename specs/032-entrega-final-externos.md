---
id: FEAT-ENTREGA-FINAL-EXTERNA
title: Entrega final de radicados externos
status: implementing
risk: high
repositories:
  - backend
  - ventanilla
---

# Objetivo

Separar la respuesta institucional de la entrega final al ciudadano. La
dependencia registra la respuesta y el radicado queda en `Respondido`.
Ventanilla Única (o un administrador como contingencia auditada) confirma la
entrega acreditada y el radicado pasa a `Entregado`.

# Alcance

- Aplica a comunicaciones externas individuales y a globales externos con una
  única respuesta institucional.
- Los globales internos informativos no tienen respuesta: cada dependencia
  confirma únicamente su estado `Enterado`.
- `enviado` e `intento_fallido` no cierran el radicado.
- La entrega acreditada requiere la evidencia adicional ya exigida por el
  seguimiento de entregas.
- Los globales históricos que ya existían antes de esta regla conservan su
  seguimiento por dependencia y no reciben responsable ni respuesta única por
  migración automática.

# Comportamiento y estados

1. La dependencia registra la respuesta institucional y el backend conserva el
   estado `Respondido`.
   En un global externo solo puede responder la dependencia responsable
   seleccionada por Ventanilla o Administrador. La respuesta es única para el
   global y queda vinculada a su asignación responsable.
2. Ventanilla consulta el historial y puede registrar actuaciones de envío,
   intento fallido o entrega acreditada.
3. Al crear una entrega acreditada, la misma transacción bloquea el radicado,
   verifica que tenga respuesta y actualiza su estado a `Entregado`.
4. El estado `Entregado` es final y no se puede modificar mediante la ruta
   genérica de estados.
5. Al anular la única entrega acreditada vigente, el estado vuelve a
   `Respondido`; el historial y las evidencias se conservan.
6. Una nueva acreditación puede volver a cambiar el estado a `Entregado`.

# Globales y visibilidad

- Ventanilla y Administrador pueden seleccionar o corregir la dependencia
  responsable mientras no exista una respuesta.
- La corrección se rechaza después de responder y se audita con actor, fecha y
  valor anterior/nuevo.
- Ventanilla, Administrador y la dependencia responsable pueden consultar el
  contenido y los documentos de la respuesta.
- Las otras dependencias pueden consultar que existe respuesta y su estado,
  pero no reciben el contenido ni los documentos.
- En un global externo, una dependencia no responsable permanece en `Recibido`
  hasta abrir correctamente el documento original; después pasa a `Enterado`.
  No puede usar `En trámite`, `Pendiente` ni registrar la respuesta. La
  dependencia responsable conserva exclusivamente el flujo de respuesta.
- La apertura exitosa del documento original registra una única actuación
  `documento_original_abierto` por asignación de funcionario. Esta actuación
  no cambia el estado de la dependencia responsable ni se registra para
  documentos de respuesta o descargas fallidas.
- La presentación agrupada expone en `resumen_global` los contadores
  `respondidas`, `enteradas`, `recibidas`, `en_tramite` y `pendientes`,
  derivados de las asignaciones actuales sin alterar sus estados.
- Solo Ventanilla y Administrador pueden registrar la entrega final del global.

# Permisos

- `funcionario`: registra respuestas según su dependencia; no registra
  entregas finales.
- `ventanilla`: registra y anula actuaciones de entrega.
- `administrador`: conserva esas capacidades como contingencia auditada.
- La autorización final siempre se valida en backend.

# Compatibilidad y auditoría

Se conservan las rutas `/respuesta` y `/entregas`, la idempotencia, las fechas
reales, las evidencias PDF y los contratos de consulta. Se registran eventos
para la acreditación y la restauración posterior a una anulación.
La migración `030_estado_entregado.js` amplía de forma idempotente el dominio
de `radicados.estado` cuando es un `ENUM` compatible, conserva sus valores y no
actualiza datos históricos. Si la columna es un `VARCHAR` suficiente, solo se
verifica que pueda almacenar `Entregado`; cualquier definición incompatible
detiene la operación antes del DDL.

# Criterios de aceptación

- Una respuesta de dependencia deja el radicado en `Respondido`.
- Un envío o intento fallido mantiene `Respondido`.
- Una entrega acreditada cambia atómicamente el estado a `Entregado`.
- Un funcionario recibe `403` al intentar registrar una entrega.
- No se aceptan radicados internos o sin respuesta.
- Un global externo no admite dos respuestas, incluso si dos dependencias
  intentan responder concurrentemente.
- Una dependencia no responsable de un global externo solo puede pasar de
  `Recibido` a `Enterado`; la dependencia responsable no puede cerrar su
  asignación como `Enterado`.
- Planeación conserva el estado pendiente al abrir el documento, pero el
  historial muestra `Documento original abierto` con actor, dependencia y
  asignación. Repetir la descarga no duplica la actuación.
- No existen dos entregas acreditadas vigentes para una misma respuesta.
- Anular la acreditación restaura `Respondido` sin borrar evidencias.
- Los reintentos idempotentes no duplican actuaciones ni transiciones.
- La interfaz muestra el estado y los mensajes de entrega sin habilitar el
  selector genérico ni acciones incompatibles.

# Verificación

- Backend: `npm test`.
- Backend MySQL aislado: `npm run test:mysql`.
- Frontend: `npm run test:react -- tests/react/SeguimientoEntrega.test.jsx tests/react/ConsultaRadicados.test.jsx`.
- Build: `npm run build`.
- CSS y visual: `npm run lint:css` y `npm run test:visual`.
- Revisión manual de respuesta por dependencia, entrega por Ventanilla,
  acreditación, anulación y rechazo de operación por funcionario.

La spec permanecerá en `implementing` hasta completar la revisión humana.
