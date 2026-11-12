# Especificaciones del sistema

Esta carpeta es la fuente central de especificaciones compartidas para el
backend, el frontend `ventanilla` y MySQL.

## Qué es una spec

Una spec describe qué problema se resuelve, qué comportamiento se espera y
cómo se comprobará. No reemplaza el código ni los tests: conecta la necesidad
del usuario con una implementación verificable.

## Cuándo crearla

Es obligatoria para migraciones, endpoints, autenticación, permisos,
documentos, entregas, traslados y reglas de negocio. Para cambios triviales de
texto o estilos basta con mantener la documentación existente.

## Ciclo de vida

- `draft`: en elaboración.
- `approved`: revisada y aprobada para implementación.
- `implementing`: en desarrollo.
- `implemented`: código y tests terminados, con revisión humana.
- `superseded`: reemplazada por otra spec.

Una spec no debe pasar directamente de `draft` a `implemented` sin criterios de
aceptación y evidencia de pruebas.

## Flujo de trabajo

1. Copiar `_plantilla.md` y asignar un identificador estable.
2. Documentar el estado actual antes de proponer cambios.
3. Definir objetivos, exclusiones, contratos y escenarios.
4. Revisar dependencias con migraciones, API, UI, archivos y permisos.
5. Obtener aprobación.
6. Implementar y enlazar cada criterio con tests.
7. Registrar resultados, riesgos pendientes y rollback.
8. Marcar `implemented` solo tras revisión humana.

## Convención de nombres

Usa nombres en minúsculas con guiones, por ejemplo:

```text
registro-entrega.md
contrato-consulta-radicados.md
```

El campo `id` del front matter debe permanecer estable aunque cambie el
nombre del archivo.
