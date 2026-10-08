const test = require('node:test');
const assert = require('node:assert/strict');
const calcularSemaforoBackend = require('../semaforo');
const { agregarDias, contarDias } = require('../semaforo');
const { obtenerTiempoRespuesta } = require('../plazos');

test('calcula vencimientos hábiles excluyendo fines de semana y festivos colombianos', () => {
    assert.equal(agregarDias('2026-10-07', 15, 'habiles'), '2026-10-29');
    assert.equal(contarDias('2026-10-07', '2026-10-29', 'habiles'), 15);
});

test('calcula vencimientos calendario sin excluir fines de semana', () => {
    assert.equal(agregarDias('2026-10-07', 10, 'calendario'), '2026-10-17');
    assert.equal(contarDias('2026-10-07', '2026-10-17', 'calendario'), 10);
});

test('rechaza términos y reglas de conteo no válidas', () => {
    assert.throws(() => agregarDias('2026-10-07', 0, 'habiles'), /entero mayor que cero/);
    assert.throws(() => agregarDias('2026-10-07', 3, 'desconocido'), /tipo de días/);
});

test('describe el término configurado usando su tipo de días', () => {
    assert.equal(obtenerTiempoRespuesta({ dias: 10, tipo_dias: 'calendario' }), '10 días calendario');
    assert.equal(obtenerTiempoRespuesta({ dias: 15, tipo_dias: 'habiles' }), '15 días hábiles');
    assert.equal(obtenerTiempoRespuesta(null), null);
});

test('calcula semáforo y días restantes con el término guardado en el radicado', () => {
    const semaforo = calcularSemaforoBackend({
        estado: 'En trámite',
        fecha_recepcion: '2026-10-07',
        termino_dias_aplicado: 15,
        tipo_dias_aplicado: 'habiles',
        fecha_limite_actual: '2026-10-29'
    }, '2026-10-07');

    assert.equal(semaforo.nivel, 'a_tiempo');
    assert.equal(semaforo.dias_restantes, 15);
    assert.equal(semaforo.fecha_limite, '2026-10-29');
});

test('marca como próximo a vencer al llegar al día límite', () => {
    const semaforo = calcularSemaforoBackend({
        fecha_recepcion: '2026-07-20',
        termino_dias_aplicado: 3,
        tipo_dias_aplicado: 'habiles'
    }, '2026-07-23');

    assert.equal(semaforo.nivel, 'alerta');
    assert.equal(semaforo.texto, 'Vence hoy');
});

test('marca como vencido después de superar el término', () => {
    const semaforo = calcularSemaforoBackend({
        fecha_recepcion: '2026-07-20',
        termino_dias_aplicado: 3,
        tipo_dias_aplicado: 'habiles'
    }, '2026-07-24');

    assert.equal(semaforo.nivel, 'vencido');
    assert.equal(semaforo.dias_restantes, -1);
});

test('no inventa un término si el radicado no tiene configuración', () => {
    const semaforo = calcularSemaforoBackend({
        tipo_documento: 'Trámite sin configurar',
        fecha_creacion: '2026-07-20'
    }, '2026-07-21');

    assert.equal(semaforo.nivel, 'sin_termino');
    assert.equal(semaforo.dias_restantes, null);
});

test('marca radicados respondidos como completados', () => {
    const semaforo = calcularSemaforoBackend({
        estado: '  RESPONDIDO ',
        fecha_recepcion: '2026-07-01',
        termino_dias_aplicado: 15,
        tipo_dias_aplicado: 'habiles'
    }, '2026-07-31');

    assert.equal(semaforo.nivel, 'completado');
});

test('falla explícitamente si la fecha del radicado no es válida', () => {
    assert.throws(
        () => calcularSemaforoBackend({
            fecha_recepcion: '2026-02-30',
            termino_dias_aplicado: 15,
            tipo_dias_aplicado: 'habiles'
        }, '2026-03-01'),
        /fecha_recepcion no contiene una fecha válida/
    );
});
