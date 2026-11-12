---
id: FEAT-CONSULTA
title: Consulta de radicados
status: baseline
risk: high
repositories:
  - backend
  - ventanilla
---

# Contexto

La consulta permite buscar radicados con filtros, paginación, permisos por rol
o dependencia, historial y acceso autorizado a documentos.

# Problema

La pantalla depende de contratos de filtros, paginación, estados, fechas,
permisos y archivos. Los nombres o tipos de campos no pueden cambiarse de
forma independiente en frontend y backend.

# Objetivo

Mantener un contrato documentado y verificable entre la consulta React, el API
y las reglas de autorización del backend.

# Fuera de alcance

- Cambiar el modelo de permisos.
- Exponer radicados fuera del alcance del usuario.
- Rediseñar las páginas HTML de entrada.
- Cambiar el formato histórico de radicación.

# Comportamiento esperado

- El backend valida filtros, límites y paginación.
- La consulta devuelve datos presentados para el rol autorizado.
- El frontend muestra carga, vacío, error y resultados sin reemplazar un error
  por resultados filtrados antiguos.
- Las descargas pasan por la autorización del backend.

# Contrato de API

Las rutas, nombres de filtros, campos de respuesta y códigos HTTP deben
extraerse del handler actual antes de modificar la funcionalidad. Toda nueva
spec debe actualizar esta sección si cambia el contrato.

La respuesta debe distinguir éxito, error de validación, sesión expirada,
falta de permisos y error de servidor.

# Cambios de base de datos

Las consultas deben conservar parámetros preparados, índices apropiados y
filtros de alcance por rol/dependencia. Cualquier cambio de consulta debe
incluir una revisión `EXPLAIN` si afecta rendimiento.

# Reglas de seguridad

- No confiar en filtros enviados por el navegador para autorizar datos.
- No construir SQL concatenando valores del usuario.
- No exponer rutas de archivos sin comprobación de pertenencia y autorización.
- No insertar información externa como HTML sin sanitización.

# Comportamiento del frontend

- Mostrar indicador de carga durante la petición.
- Desactivar acciones duplicadas.
- Mostrar claramente errores HTTP y de red.
- Mantener filtros y paginación coherentes con la respuesta recibida.
- Limpiar recursos temporales de documentos.

# Criterios de aceptación

## Escenario 1: consulta autorizada

**Dado que** el usuario tiene acceso al radicado

**Cuando** aplica filtros válidos

**Entonces** recibe resultados paginados y presentados según su rol.

## Escenario 2: consulta inválida

**Dado que** un filtro o página no cumple los límites

**Cuando** se solicita la consulta

**Entonces** el backend devuelve un error de validación sin ejecutar una
consulta peligrosa.

## Escenario 3: sesión expirada

**Dado que** el token ya no es válido

**Cuando** se solicita la consulta

**Entonces** la API devuelve 401 y el frontend limpia la sesión y redirige al
inicio de sesión.

# Plan de pruebas

- Backend: `test/consulta-paginada.test.js`, `test/consulta-mysql.test.js`,
  `test/documentos-acceso.test.js`.
- Frontend: `tests/react/ConsultaRadicados.test.jsx`, `tests/react/Api.test.js`.
- Verificación: filtros, paginación, roles, dependencia, errores y archivos.

# Migración, despliegue y rollback

No requiere migración para el comportamiento actual. Si se agregan filtros o
columnas, actualizar primero la spec y crear una migración compatible.

# Decisiones abiertas

- Documentar los campos de respuesta completos después de una revisión formal
  del contrato público.

# Trazabilidad

- Backend: `consulta-radicados.js`, `server.js`
- Frontend: `src/paginas/ConsultaRadicados.jsx`, `src/servicios/api.js`
- Tests: `test/consulta-paginada.test.js`, `tests/react/ConsultaRadicados.test.jsx`
