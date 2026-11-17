---
status: completed
---

# Optimización del cálculo de alertas en la bandeja

## Contexto

La consulta de radicados calcula el semáforo en JavaScript para conservar las
reglas de días hábiles, calendario y festivos. Actualmente obtiene candidatos
en bloques de 250 filas usando `LIMIT 250 OFFSET`, aunque termina recorriendo
el conjunto completo para contar críticos y seleccionar la página solicitada.

## Objetivo

Reducir viajes a MariaDB y ordenamientos repetidos ejecutando una sola consulta
de candidatos por operación, sin mover el cálculo del semáforo a SQL ni cambiar
los contratos públicos.

## Comportamiento esperado

- La consulta única conservará filtros, joins, parámetros preparados y orden
  actuales.
- JavaScript seguirá calculando `alerta`, `vencido`, `por_vencer` y `vencidos`.
- La paginación lógica seguirá usando `inicio`, `limite` y las claves de los
  radicados encontrados.
- Se conservarán los permisos de administrador, Ventanilla y funcionario.
- Los radicados individuales y globales mantendrán sus reglas de seguimiento.
- La transacción seguirá siendo `REPEATABLE READ READ ONLY`.

## Fuera de alcance

- No se modifican rutas, payloads, estados ni tablas.
- No se agregan índices ni migraciones.
- No se reemplazan los cálculos de días hábiles o festivos por SQL.
- No se cambia el frontend ni la representación del semáforo.

## Riesgo controlado

La consulta única puede mantener más filas candidatas en memoria que una consulta
de 250 filas. La aceptación exige medir memoria y latencia con la base aislada
de 10.000 radicados. Si el consumo resulta excesivo, se revertirá este enfoque
y se evaluará paginación por cursor/keyset.

## Criterios de aceptación

- Los resultados, totales, orden, páginas y contadores coinciden con la versión
  anterior para todos los roles y filtros.
- `/api/radicados` y `/api/alertas` conservan sus contratos y permisos.
- Se reducen las consultas repetidas de candidatos a una por operación.
- El benchmark aislado registra p50, p95, máximo, filas, bytes y consultas.
- No se modifican `ventanilla_unica` ni `ventanilla_unica_test`.

## Verificación y rollback

Se ejecutarán las pruebas backend, frontend y el benchmark antes/después. El
rollback consiste en restaurar el bloque anterior de consultas por lotes, sin
migración ni intervención sobre datos.

## Evidencia inicial

- La prueba unitaria de paginación pasó con una sola consulta de candidatos por
  operación.
- La integración MySQL aislada pasó con permisos, filtros, globales y alertas.
- El frontend `ConsultaRadicados` pasó 101/101 pruebas y el build fue correcto.
- El benchmark posterior con 10.000 radicados mantuvo los resultados y redujo
  el recorrido repetido de candidatos; la consulta optimizada usó una consulta
  de candidatos por operación.
- La suite backend completa conserva fallos `fetch failed` del entorno en
  pruebas HTTP locales no relacionadas con esta optimización.

La revisión humana del consumo de memoria y del benchmark antes/después fue
aprobada. La suite backend completa conserva fallos `fetch failed` del entorno
HTTP local, ajenos a esta optimización y documentados como limitación de
infraestructura.
