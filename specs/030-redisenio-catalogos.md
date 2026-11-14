---
id: FEAT-030
title: Rediseño de la interfaz de catálogos
status: implementing
risk: medium
repositories:
  - backend
  - ventanilla
---

# Contexto

La página `catalogos.html` permite a administradores gestionar dependencias,
tipos de trámite y términos legales. La implementación React existente ya
consume los contratos API requeridos, pero presenta el formulario, el listado y
la configuración de plazos como un bloque visual largo y con poca jerarquía.

# Problema

La densidad de la pantalla dificulta localizar el catálogo activo, entender el
estado general de los registros y encontrar rápidamente un registro concreto.
En pantallas pequeñas, las tablas y acciones también requieren más esfuerzo de
lectura.

# Objetivo

Mejorar la jerarquía visual y la usabilidad de la administración de catálogos,
manteniendo la navegación, los contratos API, las validaciones, los permisos y
las reglas de negocio actuales.

# Fuera de alcance

- No se agregan endpoints, migraciones, tablas ni cambios de backend.
- No se cambian los nombres de rutas, campos, payloads ni respuestas API.
- No se modifica la autorización ni la baja lógica.
- No se eliminan registros ni se cambian reglas de términos legales.
- No se migra el framework ni se rediseña la navegación global.

# Comportamiento esperado

- La pantalla conserva las pestañas de Dependencias y Tipos de trámite.
- Cada catálogo muestra tarjetas resumen con total, activos e inactivos.
- Las pestañas muestran el conteo del catálogo sin alterar su nombre accesible.
- La búsqueda filtra localmente por nombre, código y categoría, sin nuevas
  solicitudes al backend y conservando el orden recibido.
- El control “Mostrar inactivos” conserva su comportamiento actual.
- Editar, crear, activar, inactivar y configurar plazo conservan las rutas,
  payloads, confirmaciones y estados de proceso existentes.
- Al editar un registro, el panel completo de edición se desplaza suavemente al
  inicio visible de la pantalla, dejando su encabezado y la primera sección
  visibles; el primer campo recibe el foco sin provocar un desplazamiento
  adicional.
- El editor distingue visualmente entre creación y edición mediante un texto de
  estado, un título específico del catálogo y una descripción contextual.
- El formulario de tipos de trámite presenta las secciones `Datos básicos`,
  `Clasificación y respuesta` y `Plazo legal inicial`, con títulos semánticos y
  descripciones legibles en escritorio y móvil.
- Los estados de carga, error, vacío y ausencia de coincidencias son visibles y
  comprensibles.

# Contrato de API

Sin cambios. Se conservan las solicitudes existentes a:

- `GET /api/dependencias` y `GET /api/dependencias?incluir_inactivos=1`.
- `GET /api/tipos-tramite` y `GET /api/tipos-tramite?incluir_inactivos=1`.
- Edición, creación, cambio de estado y términos legales con sus métodos y
  payloads actuales.

# Cambios de base de datos

No aplica. No se modifica el esquema ni se transforman datos existentes.

# Reglas de seguridad

Se mantiene `ProteccionSesion soloAdministrador` y la autorización del backend
como autoridad final. La búsqueda y los conteos solo procesan los registros ya
recibidos; no exponen tokens, secretos ni datos adicionales.

# Comportamiento del frontend

- Se mantiene `solicitarApi` como único servicio de acceso.
- Los formularios conservan validación HTML, mensajes de estado y bloqueo de
  acciones mientras hay una operación en proceso.
- Las pestañas conservan roles ARIA y la navegación por teclado.
- La búsqueda tiene etiqueta accesible, permite limpiar el criterio y anuncia
  el número de resultados.
- Las tablas conservan el modo de desplazamiento intermedio y la presentación
  como tarjetas en móvil, sin desbordamiento horizontal de la página.
- El panel de términos legales conserva su historial, formulario y cierre.

# Criterios de aceptación

## Escenario 1: resumen y navegación de catálogos

**Dado que** el administrador carga la página de catálogos

**Cuando** cambia entre Dependencias y Tipos de trámite

**Entonces** cada pestaña muestra su conteo y las tarjetas resumen reflejan el
catálogo seleccionado sin nuevas solicitudes adicionales.

## Escenario 2: búsqueda local

**Dado que** el catálogo contiene varios registros

**Cuando** el administrador escribe un nombre, código o categoría

**Entonces** solo se muestran las coincidencias locales y se anuncia el número
de resultados, sin cambiar el contrato de API.

## Escenario 3: acciones existentes

**Dado que** el administrador ve un registro

**Cuando** edita, cambia su estado o configura un plazo

**Entonces** se conservan las rutas, payloads, confirmaciones y mensajes del
flujo actual.

## Escenario 3a: edición de una fila inferior

**Dado que** el administrador selecciona una dependencia ubicada al final de la
tabla, como `Víctimas`

**Cuando** pulsa `Editar`

**Entonces** el panel de edición queda alineado al inicio visible del viewport,
su encabezado y la sección `Datos básicos` quedan visibles, el primer campo
queda enfocado y la página no realiza un segundo salto.

## Escenario 3b: jerarquía del editor

**Dado que** el administrador abre el editor de dependencias o tipos de trámite

**Cuando** el formulario está en modo creación o edición

**Entonces** muestra un estado contextual (`Nuevo registro` o `Edición de
catálogo`), un título específico (`Nueva`, `Nuevo` o `Editar`) y secciones con
encabezados accesibles sin desbordamiento horizontal.

## Escenario 4: responsive y accesibilidad

**Dado que** la pantalla se usa con teclado o en un viewport móvil

**Cuando** se recorren pestañas, formularios, tablas y acciones

**Entonces** los focos son visibles, los controles tienen nombre accesible y la
interfaz no genera desplazamiento horizontal de la página.

# Plan de pruebas

- Tests frontend: `tests/react/GestionCatalogos.test.jsx`.
- Build: `npm run build`.
- Verificación manual: escritorio, móvil, teclado, foco visible, carga, error,
  vacío y ausencia de coincidencias.

# Migración, despliegue y rollback

No hay migración ni despliegue de backend. El rollback consiste en revertir los
cambios de `GestionCatalogos.jsx`, `css/style.css` y sus pruebas; los contratos
y datos permanecen intactos.

# Decisiones abiertas

La spec queda en `implementing` hasta la revisión humana del cambio visual y
los resultados de las pruebas.

# Trazabilidad

- Backend: sin cambios.
- Frontend: `src/paginas/GestionCatalogos.jsx`, `css/style.css`.
- Tests: `tests/react/GestionCatalogos.test.jsx`.
- Migraciones: no aplica.
- Documentación: esta spec.
