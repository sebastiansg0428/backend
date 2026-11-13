---
id: FEAT-ENTREGA
title: Registro de envío y entrega
status: baseline
risk: high
repositories:
  - backend
  - ventanilla
---

# Contexto

El sistema muestra el historial de actuaciones de entrega asociadas a una
respuesta institucional y permite registrar nuevas actuaciones desde el
seguimiento del radicado.

# Problema

El registro de entrega combina permisos, fechas de Bogotá, evidencias PDF,
idempotencia, migraciones habilitantes y estados de entrega. Una modificación
aislada puede dejar desalineados el modal, el API y el esquema.

# Objetivo

Documentar el contrato completo del flujo para que backend, frontend, base de
datos y tests evolucionen coordinadamente.

# Fuera de alcance

- Envío real de correos o mensajería.
- Notificación legal automática.
- Reconstrucción de fechas históricas.
- Sustitución del servicio centralizado de API.

# Comportamiento esperado

- Se consulta una respuesta elegible del radicado.
- El historial se pagina y se ordena por fecha de actuación e identificador.
- Los roles `ventanilla` y `administrador` pueden registrar actuaciones.
- Los registros nuevos usan fecha real de actuación y versión 3.
- La fecha no puede ser futura.
- Una fecha anterior a la respuesta requiere justificación de 10 a 2000
  caracteres.
- `entrega_acreditada` exige evidencia adicional de recepción.
- Una entrega acreditada vigente debe anularse antes de registrar otra.
- Un replay con la misma clave y huella devuelve la confirmación sin duplicar.
- Un replay con datos diferentes se rechaza con conflicto.

# Contrato de API

Ruta: `/api/radicados/:numero_radicado/entregas`.

El `POST` usa multipart/form-data y recibe, entre otros campos:

```text
version, clave, canal, resultado, destinatario, destino,
fecha_actuacion, justificacion_fecha_anterior, observaciones,
documentos_respuesta, archivos
```

Respuestas relevantes:

- `201`: registro creado y confirmado.
- `200`: replay válido devuelto sin duplicación.
- `400`: datos, fecha, justificación, archivos o selección inválida.
- `401/403`: sesión o permisos insuficientes.
- `409`: conflicto de idempotencia, documento cambiado o entrega vigente.
- `503`: migración habilitante no disponible.

# Cambios de base de datos

El flujo utiliza las tablas de seguimiento, confirmación, evidencias, origen
de documentos y fecha real definidas por las migraciones 025, 026 y 029.

Toda inserción debe permanecer transaccional. Los archivos temporales se deben
limpiar si la transacción no se confirma; ante una confirmación incierta se
debe verificar la base antes de eliminar evidencias.

# Reglas de seguridad

- La autorización se realiza en backend por radicado, rol y dependencia.
- Solo se aceptan PDF válidos, hasta cinco archivos de 10 MB.
- Las rutas de archivos no pueden escapar del directorio de uploads.
- No se exponen documentos ni datos sensibles a usuarios no autorizados.
- Las consultas son preparadas y los estados se validan en servidor.

# Comportamiento del frontend

`SeguimientoEntrega` debe:

- cargar historial y documentos antes de habilitar el registro;
- mostrar la disponibilidad de las migraciones 026 y 029;
- validar campos antes de enviar;
- deshabilitar el botón mientras se procesa la solicitud;
- mostrar estados de error y resultado incierto sin afirmar éxito falso;
- conservar foco y cierre correcto del diálogo;
- liberar `ObjectURL` al terminar una descarga o vista previa.

# Pulido UX conservador

La vista de registro conserva el flujo único dentro del diálogo de respuesta,
sin introducir pasos nuevos ni cambiar el contrato del API. La interfaz debe:

- diferenciar visualmente el estado actual, avisos informativos, errores y
  acciones principales sin depender solo del color;
- presentar las cuatro secciones del formulario con títulos y separadores
  claros, manteniendo dos columnas en escritorio y una en pantallas estrechas;
- conservar el pie de acciones visible mientras se desplaza el contenido del
  modal y mantener objetivos táctiles utilizables en móvil;
- mantener nombres largos de archivos legibles mediante ajuste de línea, sin
  desbordar el diálogo;
- conservar el foco al entrar al formulario, volver al historial y mostrar
  mensajes de éxito o error;
- asociar mensajes y controles a su contexto semántico, manteniendo la
  navegación por teclado y los estados `status`/`alert` existentes.

# Criterios de aceptación

## Escenario 1: registro válido

**Dado que** la sesión tiene permisos, las migraciones están disponibles y la
respuesta es elegible

**Cuando** se envía un formulario válido

**Entonces** la API crea una actuación, sus evidencias y auditoría dentro de
una transacción.

## Escenario 2: doble envío

**Dado que** el usuario pulsa dos veces o reintenta la misma operación

**Cuando** la clave y huella son iguales

**Entonces** se devuelve el mismo registro sin duplicarlo.

## Escenario 3: error incierto

**Dado que** la conexión se interrumpe después del commit

**Cuando** el frontend reintenta

**Entonces** el sistema consulta la confirmación y no crea una actuación
duplicada.

## Escenario 4: evidencia inválida

**Dado que** un archivo no es un PDF válido o supera los límites

**Cuando** se envía el formulario

**Entonces** se rechaza la operación y se limpian los temporales.

# Plan de pruebas

- Backend: `test/entregas.test.js`, `test/entregas-fecha-real.test.js`,
  `test/documentos-acceso.test.js`.
- Frontend: `tests/react/SeguimientoEntrega.test.jsx` y pruebas del modal en
  `ConsultaRadicados.test.jsx`.
- Integración: verificar permisos, transacción, idempotencia y archivos en una
  base aislada.

# Migración, despliegue y rollback

Verificar 025, 026 y 029 antes de iniciar el backend. No desplegar cambios de
API que requieran columnas aún no verificadas. Para rollback, detener el
despliegue, conservar evidencias de una confirmación incierta y resolver el
estado mediante inspección de base, no borrando archivos a ciegas.

# Decisiones abiertas

- Definir el procedimiento automatizado de reparación DDL parcial.
- Definir la política de sesiones para despliegues con más de un proceso.

# Trazabilidad

- Backend: `entregas-respuesta.js`
- Frontend: `src/componentes/SeguimientoEntrega.jsx`, `src/paginas/ConsultaRadicados.jsx`
- Tests: `test/entregas.test.js`, `tests/react/SeguimientoEntrega.test.jsx`
- Migraciones: 025, 026, 029
