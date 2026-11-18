# Bandeja de radicados internos enviados

**Estado:** completed

## Objetivo

Permitir que la dependencia que originó un radicado interno consulte, desde
`Respuestas internas`, tanto las respuestas recibidas como los radicados que
Ventanilla registró a su nombre. Así Talento Humano puede seguir un envío a
Planeación antes de que exista respuesta y consultar la respuesta cuando esté
disponible.

## Alcance

- Agregar una sub-bandeja visual de `Radicados enviados` junto a `Respuestas recibidas`.
- Consultar los radicados enviados mediante el contrato existente de
  `GET /api/radicados` con `vista=generados` y `tipo_comunicacion=interna`.
- Mostrar dependencia destinataria, canal de recepción, fecha de radicación y
  estado: pendiente de respuesta, respuesta disponible o entregado.
- Reutilizar `GET /api/radicados/:numero_radicado/recepcion-interna` y las rutas
  existentes de respuestas para abrir los documentos y conservar la apertura
  automática `Respondido → Entregado`.
- Permitir abrir la trazabilidad usando el detalle existente del radicado.
- Al abrir una respuesta enviada, mostrar estado de carga mientras se consultan
  la recepción, la respuesta y sus documentos.
- Cuando la carga termina correctamente, desplazar el detalle a una posición
  visible y enfocar su encabezado sin provocar un segundo salto.
- Registrar la apertura únicamente después de cargar correctamente la respuesta
  y sus documentos.

## Reglas y permisos

- Solo el funcionario de la dependencia de origen puede consultar sus radicados
  generados; la autorización existente del backend continúa siendo la autoridad.
- La dependencia destinataria conserva el flujo actual de respuestas recibidas.
- Los radicados internos globales mantienen su comportamiento vigente; esta
  mejora no cambia el cierre por dependencia.
- No se agregan endpoints, tablas, payloads ni permisos nuevos.

## Compatibilidad y accesibilidad

- La bandeja recibida conserva sus filtros, paginación, apertura, idempotencia y
  mensajes actuales.
- Las sub-bandejas usan pestañas accesibles con `role=tab`, `aria-selected` y
  botones navegables por teclado.
- En móvil las tarjetas y acciones se ajustan sin desbordamiento horizontal.

## Criterios de aceptación

- Talento Humano ve un radicado interno enviado a Planeación aunque todavía esté
  en `Recibido`.
- Cuando Planeación responde, el radicado aparece como `Respondido · respuesta
  disponible` y permite consultar contenido y adjuntos.
- Al abrir correctamente la respuesta se conserva el flujo existente y el
  estado se refleja como `Entregado`.
- La tarjeta permite abrir la trazabilidad completa del radicado.
- La bandeja de respuestas recibidas y sus contratos no cambian.
- Los errores de carga muestran estado accesible y permiten reintentar.

## Verificación y rollback

Verificar las pruebas React de `ConsultaRadicados` y `RespuestasInternas`, y el
build de Vite. Si la vista enviada presenta problemas, se puede retirar la
sub-bandeja y conservar intacta la bandeja recibida, porque no hay cambios de
esquema ni de API.
