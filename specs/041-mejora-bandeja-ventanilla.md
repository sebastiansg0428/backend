# Mejora de la bandeja de consulta para Ventanilla

**Estado:** completed

## Objetivo

Adaptar la rama operativa de consulta para Ventanilla y Administrador a la jerarquía visual clara de la bandeja de dependencias, conservando las funciones propias de revisión de traslados, filtros, indicadores, tabla, alertas y acciones.

## Alcance

La mejora aplica a la clase visual `consulta-ventanilla`, usada por Ventanilla y Administrador en `ConsultaRadicados`.

No se agregan pestañas nuevas ni se modifican APIs, permisos, consultas, estados, payloads, paginación o acciones existentes. La vista de dependencia y sus tres pestañas conservan su flujo actual.

## Comportamiento esperado

- La bandeja operativa muestra el contexto `Gestión documental · Ventanilla Única`, el título `Consultar radicados` y una descripción breve.
- Se conserva `Listado de documentos recibidos` y el bloque `Revisión de Ventanilla` antes de los indicadores.
- Se conservan los cuatro indicadores, incluido `Tipo de comunicación`.
- La búsqueda muestra una etiqueta visible y conserva sus identificadores, filtros y llamadas actuales.
- La tabla conserva estados, semáforos, acciones, carga, error, vacío y paginación.
- Las alertas y traslados mantienen sus estados, permisos y comportamiento responsive.
- El foco es visible, los controles tienen tamaño táctil adecuado y no hay desbordamiento horizontal en móvil.

## Verificación y aceptación

Se deben ejecutar las pruebas de `ConsultaRadicados`, `Traslados` y `RespuestasInternas`, el build de Vite y `git diff --check`. La revisión humana debe validar Ventanilla y Administrador en escritorio, móvil y teclado.
