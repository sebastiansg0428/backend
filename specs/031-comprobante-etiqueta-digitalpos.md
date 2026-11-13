---
id: FEAT-031
title: Comprobante PDF para etiqueta DigitalPOS DIG-2406T Pro
status: implementing
risk: medium
repositories:
  - backend
  - ventanilla
---

# Contexto

El frontend genera un comprobante de recepción con jsPDF y lo descarga desde
Radicación o lo muestra en Consulta de radicados. La implementación actual usa
el formato A4 por defecto, aunque el comprobante se imprimirá en una
DigitalPOS DIG-2406T Pro con etiquetas de 100 x 150 mm.

# Problema

Un PDF A4 obliga al controlador de la impresora de etiquetas a escalar o
recortar el contenido. Esto produce una salida desproporcionada y no incluye un
código escaneable para el número de radicado.

# Objetivo

Generar un comprobante de alto contraste en formato 100 x 150 mm, con todos los
datos actuales y un código de barras Code 128-B para el número completo del
radicado.

# Fuera de alcance

- No se modifica el contrato de `/api/radicados` ni el backend.
- No se cambia la información construida por `Radicacion.jsx` o
  `ConsultaRadicados.jsx`.
- No se implementa impresión directa desde el navegador.
- No se instala una dependencia externa de códigos de barras.
- No se modifica la configuración del driver de Windows.

# Comportamiento esperado

- `crearPdfComprobante` crea páginas de 100 x 150 mm en orientación vertical.
- El contenido usa márgenes horizontales de 6 mm y contraste suficiente para
  impresión térmica.
- El número de radicado se muestra como texto y como Code 128-B, incluyendo las
  zonas silenciosas requeridas. En la primera página aparece como texto solo en
  el bloque superior; no se repite debajo del código ni como fila de detalles.
- El código de barras ocupa 70 x 9 mm y queda centrado en la etiqueta; conserva
  sus zonas silenciosas internas.
- El escudo institucional se conserva como imagen pequeña y sin marca de agua
  dominante.
- Los campos actuales del comprobante se conservan y se ajustan con saltos de
  línea dentro del ancho disponible. Las etiquetas de los campos se dibujan en
  negrita y sus valores en peso normal.
- Si el contenido excede la altura de una etiqueta, se agrega otra página del
  mismo tamaño sin cortar texto.
- `pdf.save(...)` y `pdf.output("blob")` continúan funcionando sin cambios.

# Contrato de API

Sin cambios. El generador recibe el mismo objeto `datos` que ya construyen las
pantallas de radicación y consulta.

# Cambios de base de datos

No aplica. No se modifica el esquema ni se transforman datos.

# Reglas de seguridad

El código de barras solo representa el número de radicado ya autorizado para
mostrarse en el comprobante. No se agregan tokens, credenciales ni datos
secretos. El generador no realiza solicitudes nuevas salvo la carga existente
del escudo institucional.

# Comportamiento del frontend

- Se mantiene la carga local de jsPDF mediante `cargarJsPdf`.
- Code 128-B se calcula en memoria y se dibuja como barras vectoriales en el
  PDF.
- El texto y las barras se dibujan dentro de un área útil de 88 mm.
- La función de escritura envuelve texto y crea páginas adicionales cuando el
  cursor supera el área útil inferior.
- El resultado conserva compatibilidad con descarga y vista previa Blob.

# Criterios de aceptación

## Escenario 1: tamaño de etiqueta

**Dado que** se genera un comprobante

**Cuando** se crea el documento PDF

**Entonces** cada página mide 100 x 150 mm y está en orientación vertical.

## Escenario 2: código escaneable

**Dado que** el radicado es `RAD-20261113-0008`

**Cuando** se genera el comprobante

**Entonces** el PDF contiene el texto completo una vez en el bloque superior y
un Code 128-B centrado de 70 x 9 mm con barras, checksum y zonas silenciosas.

## Escenario 2a: ausencia de repeticiones

**Dado que** el radicado ya aparece en el bloque superior

**Cuando** se genera la etiqueta

**Entonces** no se imprime texto legible debajo del código ni una fila
`Número de radicado` dentro de los detalles.

## Escenario 2b: jerarquía de campos

**Dado que** el comprobante contiene datos internos o externos

**Cuando** se dibujan sus detalles

**Entonces** cada etiqueta de campo se muestra en negrita y cada valor en
tipografía normal, conservando el ajuste de línea.

## Escenario 3: contenido extenso

**Dado que** el asunto supera el espacio de una etiqueta

**Cuando** se genera el comprobante

**Entonces** se agrega una página adicional de 100 x 150 mm y no se corta el
texto.

## Escenario 4: integración existente

**Dado que** Radicación o Consulta solicitan un comprobante

**Cuando** reciben el objeto PDF

**Entonces** siguen funcionando sus llamadas actuales a `save` y `output` sin
cambiar rutas ni payloads.

# Plan de pruebas

- Tests frontend: `tests/react/Comprobante.test.jsx`.
- Build: `npm run build`.
- Dimensiones: validar una muestra con `pdfinfo`.
- Renderizado: convertir la muestra con `pdftoppm` y revisar texto, barras,
  márgenes y páginas.
- Verificación manual: imprimir con escala 100% y medio configurado como
  100 x 150 mm en el driver de la DIG-2406T Pro.

# Migración, despliegue y rollback

No hay migración ni cambio de backend. El rollback consiste en revertir el
generador y sus pruebas; las pantallas consumidoras permanecen compatibles.

# Decisiones abiertas

La spec queda en `implementing` hasta la revisión humana del PDF renderizado y
la comprobación con la etiqueta física instalada.

# Trazabilidad

- Backend: sin cambios.
- Frontend: `src/servicios/comprobante.js`.
- Tests: `tests/react/Comprobante.test.jsx`.
- Migraciones: no aplica.
- Documentación: esta spec.
