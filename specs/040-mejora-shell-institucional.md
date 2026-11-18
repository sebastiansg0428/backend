# Mejora del shell institucional del frontend

**Estado:** completed

## Objetivo

Mejorar el encabezado y la navegación común de las pantallas autenticadas para que el usuario identifique su ubicación, los módulos disponibles, la sesión activa y el acceso al contenido principal.

## Alcance

La mejora aplica a radicación, consulta de radicados, gestión de usuarios y gestión de catálogos, que reutilizan `EncabezadoAplicacion`.

No se modifican APIs, permisos, rutas de backend, datos, formularios, estados de radicados ni contratos de navegación.

## Comportamiento esperado

- El encabezado conserva el escudo, la identidad institucional y el nombre actual de la sesión.
- La navegación mantiene los enlaces disponibles según el rol y conserva `aria-current="page"`.
- El enlace `Saltar al contenido principal` dirige a `#contenido-principal` en cada pantalla autenticada.
- El menú móvil conserva `aria-expanded`, `aria-controls`, cierre con `Escape` y retorno del foco al botón.
- El estado activo, hover y foco de los enlaces son claramente visibles.
- El shell se adapta a escritorio y móvil sin desbordamiento horizontal y conserva tamaños táctiles adecuados.
- Los estilos respetan `prefers-reduced-motion` y no alteran otras pantallas fuera del shell compartido.

## Verificación y aceptación

Se deben ejecutar las pruebas de `Compartidos`, `ConsultaRadicados` y `RespuestasInternas`, el build de Vite y `git diff --check`. La revisión humana debe validar las cuatro pantallas autenticadas, navegación con teclado, menú móvil, foco visible y correspondencia de enlaces con cada rol. 
