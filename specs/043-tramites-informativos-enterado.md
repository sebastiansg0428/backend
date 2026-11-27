# Cierre de trámites informativos al abrir el documento

**Estado:** completed

Relacionada con `032-entrega-final-externos.md`: un global interno informativo
se agrupa como un solo radicado en las bandejas administrativas, pero conserva
las 24 asignaciones y el cierre independiente `Recibido → Enterado`. Un global
externo no usa este cierre: tiene una respuesta institucional única y una
entrega final separada.

## Objetivo

Cerrar un radicado de trámite informativo cuando la dependencia destinataria
abre correctamente su primer documento PDF. Estos radicados no requieren una
respuesta institucional: pasan de `Recibido` a `Enterado` y finalizan su
seguimiento.

## Alcance

- Los funcionarios destinatarios gestionan informativos únicamente con los
  estados `Recibido` y `Enterado`.
- Ventanilla conserva sus permisos actuales y no recibe una autorización nueva
  para cerrar estados automáticamente.
- Los informativos globales actualizan únicamente la asignación de la
  dependencia que está consultando el expediente.
- Los registros históricos que ya estén en `En trámite` o `Pendiente` no se
  modifican; se muestran como estados históricos no seleccionables y pueden
  cerrarse como `Enterado`.

## Comportamiento

1. El funcionario abre el detalle del radicado.
2. El frontend carga el primer PDF desde `/uploads/...`.
3. Solo después de que la descarga del PDF termina correctamente se reutiliza
   `PUT /api/radicados/:numero_radicado/estado` con `estado: Enterado`.
4. El backend valida rol, dependencia, estado y `requiere_respuesta = 0` dentro
   de la transacción existente.
5. Se actualizan `estado` y `fecha_enterado`, y se registra `estado_cambiado`
   con actor, dependencia y transición.
6. El frontend actualiza la fila, el detalle y el historial sin repetir la
   petición para el mismo radicado o asignación.

Abrir solamente el detalle o cargar la lista de documentos no cierra el
radicado. Si el PDF falla, el estado permanece sin cambios.

## Trazabilidad

Un evento `estado_cambiado` de un informativo con `valor_nuevo = Enterado` se
presenta visualmente como:

- **Trámite informativo enterado**;
- `La dependencia destinataria abrió el documento y confirmó que quedó
enterada.`;
- `Estado del radicado: Recibido → Enterado` cuando el evento no contiene los
  valores históricos; si existen, se muestran los valores reales.

El evento técnico continúa almacenado como `estado_cambiado`. No se agregan
eventos, tablas, columnas, migraciones ni endpoints nuevos.

## Seguridad, idempotencia y errores

- La autorización final permanece en el backend y respeta la dependencia del
  funcionario.
- Una segunda apertura no duplica el evento; un estado final no se reabre.
- Las asignaciones globales usan `radicado_dependencia_id` y no modifican otras
  dependencias.
- Los fallos del `PUT` o de la transacción no muestran el cierre como
  confirmado y conservan la reversión existente.

## Aceptación

- Los funcionarios no pueden cambiar informativos a `En trámite` o `Pendiente`.
- Un PDF cargado correctamente produce `Recibido → Enterado` y trazabilidad
  verde.
- Una falla de PDF no produce cambios de estado ni auditoría.
- Radicados con respuesta requerida, entregas externas, respuestas internas y
  eventos ordinarios conservan su comportamiento actual.
- Las pruebas backend, React, build y revisión manual se ejecutan antes de
  cambiar esta spec a `completed`.
