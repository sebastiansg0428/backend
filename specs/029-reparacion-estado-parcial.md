---
id: FEAT-029-REPARACION
title: Reparación segura del estado parcial de la migración 029
status: implemented
risk: high
repositories:
  - backend
---

# Contexto

La migración 029 crea la tabla `entregas_fecha_real` y el índice
`idx_entrega_fecha` sobre `registros_entrega_respuesta`. El DDL de MySQL/MariaDB
puede confirmar cada sentencia por separado, por lo que un fallo posterior a
la primera sentencia puede dejar un esquema parcialmente aplicado.

La spec base de la funcionalidad está en
[`029-fecha-real-entrega.md`](029-fecha-real-entrega.md). Esta spec define
únicamente una mejora operativa para inspeccionar y reparar estados parciales.

# Problema

Repetir `--aplicar` después de un fallo DDL puede intentar crear objetos que ya
existen o esconder una incompatibilidad del esquema. El operador necesita
conocer el estado exacto de los objetos antes de decidir si puede completar la
migración de forma segura.

# Objetivo

Agregar una inspección de solo lectura y una reparación conservadora que solo
complete componentes ausentes cuando los objetos existentes sean compatibles.

# Fuera de alcance

- No cambiar el comportamiento actual de `--verificar`.
- No reemplazar ni eliminar tablas, columnas, índices o claves foráneas.
- No corregir automáticamente estructuras incompatibles.
- No ejecutar reparación al iniciar el backend.
- No modificar datos de `registros_entrega_respuesta` ni
  `entregas_fecha_real`.
- No cambiar la colación esperada actualmente por 029.
- No desplegar ni ejecutar la reparación sobre una base productiva en esta
  etapa.

# Comportamiento esperado

La herramienta debe clasificar el esquema en uno de estos estados:

- `ausente`: no existe ningún objeto de 029.
- `aplicada`: tabla, columnas, PK, FK, motor, colación e índice coinciden con
  la definición esperada.
- `parcial_reparable`: falta un componente, pero los componentes existentes
  son compatibles y la acción restante es aditiva.
- `incompatible`: existe una definición distinta, ambigua o contradictoria.
- `indeterminada`: no fue posible inspeccionar el esquema por conexión,
  permisos o metadatos incompletos.

La política de reparación es conservadora:

- tabla correcta sin índice: se puede crear el índice;
- índice correcto sin tabla: se puede crear la tabla después de verificar 026;
- ambos objetos ausentes: se informa que corresponde usar `--aplicar`;
- cualquier definición incompatible: se detiene y se solicita intervención
  manual;
- ninguna acción puede ejecutar `DROP` ni reemplazar objetos existentes.

# Interfaz de CLI y API interna

La CLI debe conservar las opciones existentes y agregar:

```powershell
node migrations\029_fecha_real_entrega.js --inspeccionar
node migrations\029_fecha_real_entrega.js --reparar
node migrations\029_fecha_real_entrega.js --reparar --confirmar
```

## `--inspeccionar`

Es de solo lectura. Devuelve el diagnóstico y no ejecuta DDL.

## `--reparar`

Inspecciona, calcula las acciones compatibles y muestra el plan. Sin
`--confirmar` no ejecuta DDL.

## `--reparar --confirmar`

Repite la inspección en el mismo proceso y ejecuta únicamente las acciones
permitidas para el estado compatible detectado. La confirmación no autoriza
acciones destructivas.

Las funciones internas deben devolver resultados estructurados, por ejemplo:

```js
{
  estado: 'parcial_reparable',
  acciones: ['crear_indice'],
  cambios: 0,
  requiere_confirmacion: true
}
```

Los nombres de funciones pueden adaptarse a las convenciones existentes, pero
la clasificación y las acciones deben ser estables para que los tests y los
operadores puedan interpretarlas.

# Cambios de base de datos

La inspección debe verificar, sin modificar:

- existencia y definición de `entregas_fecha_real`;
- columnas `registro_id` y `justificacion_fecha_anterior`;
- PK de `registro_id`;
- FK `fk_fecha_real_entrega` hacia
  `registros_entrega_respuesta(id)` con `RESTRICT` en actualización y borrado;
- motor `InnoDB`;
- colación `utf8mb4_unicode_ci`;
- índice no único `idx_entrega_fecha(respuesta_id, fecha_actuacion_utc, id)`;
- dependencia de migración 026.

Cada DDL permitido debe seguir este ciclo:

1. Inspeccionar de nuevo el objeto objetivo.
2. Ejecutar únicamente la sentencia aditiva prevista.
3. Registrar el número de cambios confirmados.
4. Volver a verificar la estructura completa.
5. Detenerse ante cualquier error o diferencia.

Los DDL tienen commit implícito. Si falla una etapa, el resultado debe indicar
cuántas acciones fueron confirmadas y exigir una nueva inspección antes de
reintentar.

# Reglas de seguridad y operación

- Nunca reparar automáticamente al arrancar el servidor.
- No aceptar `--confirmar` sin `--reparar`.
- No usar el nombre de la base o credenciales en logs innecesarios.
- Ejecutar primero en una base aislada.
- Exigir respaldo verificable antes de una ejecución productiva.
- Ante incompatibilidad, entregar diagnóstico y no alterar la base.
- Mantener rollback manual documentado; no borrar objetos para recuperarse de
  un error.

# Criterios de aceptación

## Escenario 1: inspección sin objetos

**Dado que** no existen la tabla ni el índice de 029

**Cuando** se ejecuta `--inspeccionar`

**Entonces** devuelve `ausente` y no modifica la base.

## Escenario 2: migración completa

**Dado que** todos los objetos tienen la definición esperada

**Cuando** se ejecuta `--inspeccionar`

**Entonces** devuelve `aplicada`, con `acciones: []` y `cambios: 0`.

## Escenario 3: tabla correcta sin índice

**Dado que** la tabla 029 es compatible y el índice está ausente

**Cuando** se ejecuta `--reparar`

**Entonces** devuelve `parcial_reparable`, propone `crear_indice` y no ejecuta
DDL.

## Escenario 4: reparación confirmada

**Dado que** la inspección detecta únicamente un índice ausente compatible

**Cuando** se ejecuta `--reparar --confirmar`

**Entonces** crea el índice, vuelve a verificar la estructura y devuelve
`aplicada`.

## Escenario 5: esquema incompatible

**Dado que** una columna, FK, motor, colación o definición de índice no coincide

**Cuando** se ejecuta cualquier opción de reparación

**Entonces** devuelve `incompatible` y no ejecuta DDL destructivo ni correctivo.

## Escenario 6: ambos objetos ausentes

**Dado que** 029 no tiene ningún objeto creado

**Cuando** se solicita `--reparar`

**Entonces** informa que corresponde `--aplicar` y no ejecuta la reparación.

## Escenario 7: error durante DDL

**Dado que** una sentencia DDL falla después de confirmar una etapa anterior

**Cuando** termina el comando

**Entonces** informa el número de acciones confirmadas y exige inspeccionar
antes de reintentar.

## Escenario 8: permisos insuficientes

**Dado que** la cuenta no puede consultar metadatos o ejecutar DDL

**Cuando** se solicita inspección o reparación

**Entonces** devuelve `indeterminada` con un error operativo sin modificar la
base.

# Plan de pruebas

## Unitarias

- Clasificación de cada estado del inspector.
- Construcción de acciones permitidas.
- Rechazo de `--confirmar` sin `--reparar`.
- Garantía de que estados incompatibles no producen DDL.
- Conteo de cambios confirmados ante errores.

## Integración MySQL/MariaDB aislada

Probar con una base y esquema temporales:

- esquema ausente;
- tabla completa sin índice;
- índice correcto sin tabla;
- columna incorrecta;
- colación incorrecta;
- FK incorrecta;
- motor incorrecto;
- permisos insuficientes.

## Regresión

- `test/integridad-migracion.test.js`;
- `test/entregas-fecha-real.test.js`;
- comportamiento existente de `--verificar`;
- comportamiento existente de `--aplicar` con una instalación ausente.

# Migración, despliegue y rollback

La primera implementación se probó mediante tests con conexiones simuladas.
Antes de una ejecución productiva se debe disponer de un respaldo verificable
y una ventana operativa definida.

La reparación solo agrega objetos ausentes. Si la verificación posterior falla,
se conserva el esquema para inspección y se detiene el proceso; no se ejecutan
operaciones de borrado o sustitución como rollback automático.

# Decisiones abiertas

No quedan decisiones funcionales abiertas para esta spec. La implementación
deberá respetar la política conservadora, la confirmación explícita y la
compatibilidad con las opciones actuales.

# Evidencia de implementación

La inspección fue ejecutada por el usuario sobre la base de datos local:

```text
Comando: node migrations/029_fecha_real_entrega.js --inspeccionar
Resultado: estado: 'aplicada'
Cambios pendientes: 0
```

Este resultado confirma que la estructura esperada de 029 está completa y que
no hay componentes pendientes de reparación en esa base. No se ejecutó
`--reparar`.

# Trazabilidad

- Spec base: `specs/029-fecha-real-entrega.md`
- Implementación: `migrations/029_fecha_real_entrega.js`
- Tests ejecutados: `test/migracion-029-reparacion.test.js`,
  `test/integridad-migracion.test.js`,
  `test/entregas-fecha-real.test.js`
- Dependencia: migración 026
