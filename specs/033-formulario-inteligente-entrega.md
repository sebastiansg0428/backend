---
id: FEAT-FORMULARIO-INTELIGENTE-ENTREGA
title: Formulario inteligente de envío y entrega
status: completed
risk: medium
repositories:
  - backend
  - ventanilla
---

# Objetivo

Mejorar la asistencia al operador de Ventanilla durante el registro manual de
envíos, intentos fallidos y entregas acreditadas, sin convertir el formulario
en un servicio de notificación automática.

# Alcance

- Prellenar los datos disponibles del radicado.
- Conservar los destinos editados por el operador al cambiar de canal.
- Adaptar ayudas, campos destacados y validaciones visuales según el resultado.
- Mostrar un resumen de preparación antes de confirmar.
- Exigir una confirmación explícita para 'entrega_acreditada'.
- Mantener las rutas, payloads, permisos, evidencias, auditoría e idempotencia.

# Comportamiento esperado

1. El destinatario se prellena con el remitente del radicado.
2. El correo se prellena únicamente para el canal electrónico.
3. Los valores de destino se conservan por canal y no se sobrescriben cuando
   el operador cambia de canal.
4. 'enviado' destaca el destino y los documentos que serán incluidos.
5. 'intento_fallido' destaca las observaciones, que siguen siendo obligatorias
   con mínimo diez caracteres.
6. 'entrega_acreditada' destaca la evidencia adicional, exige un PDF distinto
   de los documentos de respuesta y requiere confirmación explícita del
   operador.
7. El resumen indica datos pendientes, fecha inválida, documentos no cargados,
   evidencia faltante u observaciones incompletas.
8. El botón 'Usar ahora' genera la fecha en la zona 'America/Bogota'.
9. El backend continúa siendo la autoridad final y puede rechazar cualquier
   solicitud inválida.

# Compatibilidad y límites

- No se agregan endpoints, tablas, proveedores ni envíos automáticos.
- No se cambia el FormData ni la ruta
  /api/radicados/:numero_radicado/entregas.
- No se cambia la validación real de PDFs, límites, permisos o idempotencia.
- La acreditación continúa siendo una decisión humana de Ventanilla.

# Accesibilidad y responsive

- El resumen usa aria-live='polite' y conserva mensajes status/alert.
- La confirmación de entrega se expone como un checkbox etiquetado.
- Se mantiene el foco visible y la navegación por teclado del diálogo.
- El resumen se convierte en una sola columna en pantallas estrechas.
- No se permite desbordamiento horizontal de nombres ni controles.

# Criterios de aceptación

- El formulario se abre con destinatario y correo disponibles prellenados.
- Cambiar de canal conserva el último destino escrito en cada canal.
- Cada resultado muestra su ayuda contextual correspondiente.
- El resumen comunica claramente qué elementos faltan.
- No se puede acreditar una entrega sin evidencia adicional y confirmación
  explícita.
- Se conserva el payload actual, incluida la idempotencia y los documentos
  seleccionados.
- Los errores de archivo, carga, backend y confirmación incierta conservan su
  manejo actual.
- El formulario mantiene accesibilidad básica y no desborda en móvil.

# Verificación

- npm run test:react -- tests/react/SeguimientoEntrega.test.jsx
- npm run build
- Revisión manual de envío, intento fallido, entrega acreditada, cambio de
  canal, archivo inválido y navegación con teclado.

La spec permanecerá en proposed hasta la revisión humana.
