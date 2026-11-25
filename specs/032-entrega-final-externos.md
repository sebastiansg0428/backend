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

- Solo aplica a comunicaciones externas individuales con respuesta institucional.
- `enviado` e `intento_fallido` no cierran el radicado.
- La entrega acreditada requiere la evidencia adicional ya exigida por el
  seguimiento de entregas.
- No aplica a radicados internos ni a radicados globales.
- No se agregan endpoints ni se cambian los payloads existentes.

# Comportamiento y estados

1. La dependencia registra la respuesta institucional y el backend conserva el
   estado `Respondido`.
2. Ventanilla consulta el historial y puede registrar actuaciones de envío,
   intento fallido o entrega acreditada.
3. Al crear una entrega acreditada, la misma transacción bloquea el radicado,
   verifica que tenga respuesta y actualiza su estado a `Entregado`.
4. El estado `Entregado` es final y no se puede modificar mediante la ruta
   genérica de estados.
5. Al anular la única entrega acreditada vigente, el estado vuelve a
   `Respondido`; el historial y las evidencias se conservan.
6. Una nueva acreditación puede volver a cambiar el estado a `Entregado`.

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
- No se aceptan radicados internos, globales o sin respuesta.
- No existen dos entregas acreditadas vigentes para una misma respuesta.
- Anular la acreditación restaura `Respondido` sin borrar evidencias.
- Los reintentos idempotentes no duplican actuaciones ni transiciones.
- La interfaz muestra el estado y los mensajes de entrega sin habilitar el
  selector genérico ni acciones incompatibles.

# Verificación

- Backend: `npm test`.
- Frontend: `npm run test:react -- tests/react/SeguimientoEntrega.test.jsx tests/react/ConsultaRadicados.test.jsx`.
- Build: `npm run build`.
- Revisión manual de respuesta por dependencia, entrega por Ventanilla,
  acreditación, anulación y rechazo de operación por funcionario.

La spec permanecerá en `implementing` hasta completar la revisión humana.
