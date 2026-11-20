# Especificaciones del backend y contratos compartidos

Esta carpeta contiene las specs cuyo alcance principal sea backend y las
funcionalidades mixtas que definan contratos compartidos con el frontend
`ventanilla` o MySQL.

Las specs frontend-only —React, CSS, vistas, interacción, accesibilidad y
estados de UI— se mantienen en `../ventanilla/specs/`.

## Regla de ubicación

- Backend: endpoints, controladores, servicios, base de datos, migraciones,
  validaciones de servidor, permisos y reglas de negocio.
- Frontend: `../ventanilla/specs/` para componentes, estilos, vistas,
  interacción y estados de interfaz.
- Mixto: permanece aquí y debe indicar explícitamente el impacto en el
  frontend. Si necesita criterios separados, enlaza specs relacionadas por ID.
- No dupliques specs entre repositorios.

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

1. Copiar `_plantilla.md` y asignar un identificador estable. Para cambios
   frontend-only, usa `../ventanilla/specs/_plantilla.md`.
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
