# Política de contraseñas sin espacios

**Estado:** completed

## Alcance

Cambio mixto de backend y frontend para hacer explícita y consistente la
política de contraseñas al crear usuarios o cambiar una contraseña.

## Regla aprobada

Una contraseña nueva o modificada debe:

- tener al menos 10 caracteres Unicode;
- contener una mayúscula, una minúscula, un número y un símbolo;
- no contener espacios ni otros caracteres de espacio en blanco;
- ocupar como máximo 72 bytes en UTF-8;
- no contener el carácter NUL.

La interfaz y el backend mostrarán la misma explicación en lenguaje claro.

## Compatibilidad

- No cambian rutas, métodos, payloads ni códigos HTTP.
- El backend continúa siendo la autoridad final.
- Las contraseñas existentes no se revalidan con la nueva regla al iniciar
  sesión; seguirán funcionando si coinciden con su hash almacenado.
- La regla se aplica únicamente al crear usuarios o guardar una contraseña
  nueva.
- No se almacenan contraseñas ni se registran en logs.

## Verificación

- Pruebas backend de complejidad, límites UTF-8 y compatibilidad de hashes
  existentes.
- Pruebas frontend de validación previa y texto accesible de ayuda.
- `node --check auth.js`, `npm test`, pruebas React, build y suite legacy.
## Revisión humana aprobada

El formulario de gestión de usuarios fue revisado manualmente en el navegador
y quedó aprobado, incluyendo la explicación visible de la política de
contraseñas y los estados del formulario.

La revisión confirmó que las contraseñas nuevas o modificadas conservan la
regla de mínimo 10 caracteres Unicode, complejidad requerida, ausencia de
espacios y máximo de 72 bytes UTF-8. También se confirmó que las contraseñas
existentes compatibles con su hash pueden seguir utilizándose al iniciar
sesión.

No se modificaron rutas, payloads, códigos HTTP ni contratos públicos.
