# Mejora de interfaz del panel de dependencia

**Estado:** completed

## Objetivo

Mejorar la claridad visual y la facilidad de navegación de la pantalla de consulta de las dependencias, sin modificar el comportamiento funcional del sistema.

## Alcance

El cambio cubre las pestañas `Radicados`, `Respuestas internas` y `Traslados`, los indicadores de la bandeja, la búsqueda y filtros, la tabla de radicados y el panel `Alertas por dependencia`.

No se modifican rutas, payloads, consultas, estados, permisos, APIs, datos ni contratos existentes.

## Criterios de interfaz

- Los bloques de indicadores, búsqueda, resultados y alertas tienen encabezados y ayudas visuales diferenciadas.
- Las pestañas mantienen `role="tab"`, `aria-selected`, navegación por teclado, cursor interactivo y estados visibles de hover y foco.
- La tabla conserva sus encabezados accesibles, semáforos, estados, acciones y adaptación móvil.
- Las alertas conservan sus estados de carga, error, vacío, paginación y agrupación entre próximos a vencer y vencidos.
- Los controles mantienen tamaños táctiles adecuados, foco visible y no producen desbordamiento horizontal en móvil.
- Los estilos nuevos se limitan al ámbito `.consulta-dependencia` para no alterar otras páginas.

## Verificación

Se deben ejecutar las pruebas React de `ConsultaRadicados` y `RespuestasInternas`, el build de Vite y `git diff --check`.
