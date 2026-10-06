const test = require('node:test');
const assert = require('node:assert/strict');
const calcularSemaforoBackend = require('../semaforo');
const { obtenerDiasPlazo, obtenerTiempoRespuesta } = require('../plazos');

test('asigna los plazos configurados por tipo de documento', () => {
    const casos = [
        ['Solicitud', 10],
        ['Solicitud SIMIT-RUT', 10],
        ['Derecho de Petición', 15],
        ['Queja', 15],
        ['Reclamo', 15],
        ['Acción de Tutela', 2],
        ['Desacato de Tutela', 2],
        ['Licencia de  construcción', 45],
        ['Licencia Urbanística', 45],
        ['Informativo', 15]
    ];

    for (const [tipoDocumento, dias] of casos) {
        assert.equal(obtenerDiasPlazo(tipoDocumento), dias, tipoDocumento);
        assert.equal(obtenerTiempoRespuesta(tipoDocumento), `${dias} días hábiles`);
    }
});

test('calcula el semáforo usando el plazo derivado del tipo documental', () => {
    const semaforo = calcularSemaforoBackend({
        tipo_documento: 'Acción de Tutela',
        tiempo_de_respuesta: '45 días hábiles',
        fecha_creacion: '2026-07-20'
    }, '2026-07-23');

    assert.equal(semaforo.nivel, 'vencido');
    assert.equal(semaforo.texto, 'Vencido (1 día)');
});

test('marca los radicados respondidos como completados', () => {
    const semaforo = calcularSemaforoBackend({
        estado: '  RESPONDIDO ',
        fecha_creacion: '2026-07-01'
    }, '2026-07-31');

    assert.equal(semaforo.nivel, 'completado');
});

test('cuenta solo días hábiles y excluye festivos colombianos', () => {
    const semaforo = calcularSemaforoBackend({
        estado: 'Pendiente',
        fecha_creacion: '2026-07-17',
        tiempo_de_respuesta: '15 días hábiles'
    }, '2026-07-22');

    assert.equal(semaforo.nivel, 'a_tiempo');
    assert.equal(semaforo.texto, 'A tiempo (13 días)');
});

test('excluye los festivos móviles de Semana Santa', () => {
    const semaforo = calcularSemaforoBackend({
        estado: 'Pendiente',
        fecha_creacion: '2026-04-01',
        tiempo_de_respuesta: '5 días hábiles'
    }, '2026-04-03');

    assert.equal(semaforo.nivel, 'a_tiempo');
    assert.equal(semaforo.texto, 'A tiempo (5 días)');
});

test('muestra alerta cuando faltan tres días hábiles', () => {
    const semaforo = calcularSemaforoBackend({
        estado: 'Pendiente',
        fecha_creacion: '2026-07-20',
        tiempo_de_respuesta: '7 días hábiles'
    }, '2026-07-24');

    assert.equal(semaforo.nivel, 'alerta');
    assert.equal(semaforo.texto, 'Por vencer (3 días)');
});

test('marca como vencido después de superar el plazo en días hábiles', () => {
    const semaforo = calcularSemaforoBackend({
        estado: 'Pendiente',
        fecha_creacion: '2026-07-20',
        tiempo_de_respuesta: '3 días hábiles'
    }, '2026-07-24');

    assert.equal(semaforo.nivel, 'vencido');
    assert.equal(semaforo.texto, 'Vencido (1 día)');
});

test('falla explícitamente si la fecha de creación no es válida', () => {
    assert.throws(
        () => calcularSemaforoBackend({ fecha_creacion: '2026-02-30' }, '2026-03-01'),
        /fecha_creacion no contiene una fecha válida/
    );
});
