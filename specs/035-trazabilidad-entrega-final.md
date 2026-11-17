---
id: FEAT-TRAZABILIDAD-ENTREGA-FINAL
title: Trazabilidad clara de la entrega final
status: completed
risk: low
repositories:
  - ventanilla
---

# Objetivo

Presentar la entrega final acreditada de un radicado externo como una sola
actuación comprensible, sin eliminar los eventos técnicos de auditoría.

# Comportamiento

- `entrega_registrada` seguido de `entrega_acreditada`, con el mismo actor y
  minuto, se unifica visualmente como `Entrega final acreditada`.
- La tarjeta muestra responsable, rol, fecha, motivo de la actuación original
  y la transición `Respondido → Entregado`.
- `entrega_anulada` seguido de `entrega_estado_restaurado` se presenta de forma
  equivalente como `Entrega final anulada`, con `Entregado → Respondido`.
- Una pareja incompleta o que no coincida en actor/minuto permanece visible sin
  inventar ni ocultar información.
- El backend conserva ambos eventos y no cambia el contrato `/historial`.

# Aceptación

- La entrega acreditada aparece como una sola tarjeta, no como `Evento histórico`.
- No se muestra `No registrada en este evento` para la tarjeta de entrega final.
- Los demás eventos mantienen su contexto de dependencia.
- La interfaz mantiene accesibilidad, foco y comportamiento responsive.

La spec permanecerá en `proposed` hasta la revisión humana.
