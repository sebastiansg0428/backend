# Backend de Ventanilla Unica

## Ejecutar y probar

```powershell
npm start
npm test
```

Reinicia el proceso Node.js despues de modificar el backend; `npm start` no
recarga los archivos automaticamente.

## Cambio de estado

`PUT /api/radicados/:numero_radicado/estado` recibe JSON:

```json
{ "estado": "Respondido" }
```

Los estados editables coinciden con el formulario y la base de datos:
`Recibido`, `En trámite`, `Pendiente` y `Respondido`. El backend normaliza
mayusculas, espacios y acentos antes de guardar. `Vencido` es una condicion
calculada por el semaforo, no un estado editable desde esta ruta.

La respuesta incluye `success`, `estado`, `fecha_respuesta`,
`tiempo_de_respuesta`, `fecha_limite_actual` y `semaforo`. Un estado no valido
devuelve HTTP 400 con `success: false` y `message`; un radicado inexistente
devuelve HTTP 404.

El cambio de estado, la fecha de respuesta del modulo de terminos y el historial
se guardan dentro de una transaccion. Marcar como `Respondido` conserva la fecha
de respuesta si ya existia; volver a un estado pendiente la elimina y reactiva
el semaforo sin cambiar el termino ni la fecha limite. Esto permite corregir una
marcacion accidental; el historial conserva los cambios.

El frontend debe actualizar su modelo con el `estado` devuelto por la API y
restaurar el selector al estado anterior si la solicitud falla. Debe mostrar
`message`, no solo un error generico.
