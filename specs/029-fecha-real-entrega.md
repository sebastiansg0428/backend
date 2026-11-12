---
id: FEAT-029
title: Fecha real de entrega
status: baseline
risk: high
repositories:
  - backend
  - ventanilla
---

# Contexto

La migración 029 complementa el seguimiento de entregas activado por las
migraciones 025 y 026. Permite conservar una fecha real de actuación y una
justificación cuando esa actuación es anterior a la respuesta institucional.

# Problema

Una fecha registrada después de la respuesta no siempre representa el momento
real de la actuación. El sistema necesita conservar ese dato sin reescribir
historiales anteriores ni confiar en una fecha enviada sin validación.

# Objetivo

Permitir que los nuevos registros de entrega declaren una fecha real válida,
conservar una justificación cuando corresponda y mantener la integridad del
historial existente.

# Fuera de alcance

- No reconstruir fechas de registros históricos.
- No modificar respuestas ni radicados existentes.
- No ejecutar automáticamente una reparación de un estado DDL parcial.
- No convertir colaciones de tablas existentes como parte de esta migración.

# Comportamiento esperado

- 029 depende de 026.
- `--verificar` inspecciona tabla, columnas, PK, FK, índice, motor y colación.
- `--aplicar` crea `entregas_fecha_real` y el índice
  `idx_entrega_fecha` cuando la verificación aún no está satisfecha.
- La tabla tiene `registro_id` como PK y FK `RESTRICT` hacia
  `registros_entrega_respuesta(id)`.
- La fecha no puede ser futura.
- Una actuación anterior a la respuesta exige una justificación de 10 a 2000
  caracteres.
- Un fallo DDL puede dejar cambios confirmados por commit implícito; se debe
  inspeccionar el esquema antes de reintentar.

# Contrato de API

Ruta base: `/api/radicados/:numero_radicado/entregas`.

- `GET` informa `fecha_real_disponible`, historial y
  `fecha_real_declarada`.
- `POST` requiere la versión 3 para nuevos registros e incluye
  `fecha_actuacion` y, si aplica, `justificacion_fecha_anterior`.
- El servidor valida fecha, permisos, respuesta elegible, idempotencia,
  evidencias y estado de las migraciones.
- La respuesta exitosa devuelve el registro confirmado; un replay válido no
  duplica la actuación.

# Cambios de base de datos

La migración crea:

```text
entregas_fecha_real(
  registro_id BIGINT UNSIGNED PRIMARY KEY,
  justificacion_fecha_anterior VARCHAR(2000) NULL,
  FK RESTRICT -> registros_entrega_respuesta(id)
)
```

También crea el índice no único:

```text
registros_entrega_respuesta(respuesta_id, fecha_actuacion_utc, id)
```

La implementación actual exige `InnoDB` y `utf8mb4_unicode_ci` para la tabla
029. Cualquier cambio de colación requiere una spec y migración independiente.

# Reglas de seguridad

- Solo los roles autorizados pueden crear o anular registros.
- El backend es la autoridad para permisos y fechas.
- Los archivos PDF se validan por contenido, tamaño, cantidad y autorización.
- La clave de idempotencia y la huella impiden duplicados o replays con datos
  diferentes.
- No deben registrarse tokens, documentos ni datos personales innecesarios.

# Comportamiento del frontend

El componente de seguimiento:

- deshabilita el envío durante la operación;
- valida la fecha y solicita justificación cuando corresponde;
- informa si 029 no está disponible;
- muestra el resultado confirmado o un error accionable;
- permite reintentar sin duplicar una operación confirmada;
- conserva accesibilidad del diálogo y libera URLs de objetos de archivos.

# Criterios de aceptación

## Escenario 1: migración completa

**Dado que** 025 y 026 están verificadas y 029 no existe

**Cuando** se ejecuta `--aplicar`

**Entonces** la tabla, FK, PK e índice quedan creados y `--verificar` informa
que la migración está aplicada.

## Escenario 2: migración ya aplicada

**Dado que** la estructura 029 es compatible

**Cuando** se ejecuta `--verificar`

**Entonces** no se realizan cambios y se informa estado aplicada.

## Escenario 3: fecha anterior sin justificación

**Dado que** la actuación es anterior a la respuesta

**Cuando** se intenta registrar sin justificación de al menos 10 caracteres

**Entonces** la API rechaza la solicitud con HTTP 400.

## Escenario 4: actuación futura

**Dado que** la fecha enviada está en el futuro

**Cuando** se registra la entrega

**Entonces** la API rechaza la solicitud y no crea filas ni archivos.

## Escenario 5: estado parcial

**Dado que** solo una parte del DDL quedó confirmada

**Cuando** se ejecuta `--verificar`

**Entonces** se informa incompatibilidad y no se repite `--aplicar` sin
inspección o reparación explícita.

# Plan de pruebas

- `test/entregas-fecha-real.test.js`
- `test/entregas.test.js`
- `test/integridad-migracion.test.js`
- Verificación manual de `--verificar` sobre una base aislada.

# Migración, despliegue y rollback

Ejecutar primero `--verificar` sobre la base objetivo. Si informa estado
parcial, revisar metadatos de tabla, columnas, índices, PK, FK, motor y
colación antes de cualquier DDL. El rollback no debe eliminar datos sin un
respaldo y autorización explícita.

# Decisiones abiertas

- Definir una herramienta versionada de reparación para estados parciales.
- Definir la política global de colaciones sin perder compatibilidad con el
  motor de base de datos soportado.

# Trazabilidad

- Backend: `migrations/029_fecha_real_entrega.js`, `entregas-respuesta.js`
- Frontend: `src/componentes/SeguimientoEntrega.jsx`
- Tests: `test/entregas-fecha-real.test.js`, `tests/react/SeguimientoEntrega.test.jsx`
- Migraciones: 025, 026, 029
