const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validarRegistro, resumen } = require('../entregas-respuesta');
const datos = () => ({ clave: randomUUID(), canal: 'correo_electronico', resultado: 'enviado',
    destinatario: ' Persona ficticia ', destino: 'fixture@example.test', fecha_actuacion: '2026-01-05T10:00', observaciones: '' });
test('entregas valida contratos y convierte hora Bogota a UTC', () => {
    const r = validarRegistro(datos());
    assert.equal(r.fecha, '2026-01-05 15:00:00.000');
    assert.equal(r.destinatario, 'Persona ficticia');
    for (const cambio of [
        { clave: 'no' }, { canal: 'automatico' }, { resultado: 'respondido' }, { destinatario: '' },
        { destino: 'no es correo' }, { fecha_actuacion: '2026-02-30T10:00' }, { fecha_actuacion: '2999-01-01T10:00' },
        { fecha_actuacion: '0001-01-01T10:00' },
        { resultado: 'intento_fallido', observaciones: 'corto' }, { desconocido: 'x' },
    ]) assert.throws(() => validarRegistro({ ...datos(), ...cambio }), { status: 400 });
    assert.equal(validarRegistro({ ...datos(), canal: 'presencial', destino: 'Sede ficticia' }).destino, 'Sede ficticia');
});
test('resumen preserva acreditacion y recalcula tras anulacion', () => {
    assert.equal(resumen([]), 'pendiente_de_envio');
    assert.equal(resumen([{ resultado: 'intento_fallido' }, { resultado: 'enviado' }]), 'intento_fallido');
    assert.equal(resumen([{ resultado: 'enviado' }, { resultado: 'entrega_acreditada' }]), 'entrega_acreditada');
    assert.equal(resumen([{ resultado: 'entrega_acreditada', anulado_en_utc: 'fecha' }, { resultado: 'enviado' }]), 'enviado');
});
test('contrato 2 rechaza fecha cliente, valida y canoniza IDs/hash sin generar timestamp en la huella', () => {
    const { fecha_actuacion, ...base } = datos();
    const body = { ...base, version: '2', documentos_respuesta: JSON.stringify([{ id: 2, sha256: 'b'.repeat(64) }, { id: 1, sha256: 'a'.repeat(64) }]) };
    const r = validarRegistro(body);
    assert.equal(r.fecha, undefined); assert.equal(r.version, 2);
    assert.deepEqual(r.documentos.map(d => d.id), [1, 2]);
    for (const cambios of [
        { fecha_actuacion }, { documentos_respuesta: 'no json' }, { documentos_respuesta: '[{}]' },
        { documentos_respuesta: JSON.stringify([{ id: 1, sha256: 'a'.repeat(64) }, { id: 1, sha256: 'a'.repeat(64) }]) },
        { documentos_respuesta: JSON.stringify(Array.from({ length: 6 }, (_, i) => ({ id: i + 1, sha256: 'a'.repeat(64) }))) },
    ]) assert.throws(() => validarRegistro({ ...body, ...cambios }), { status: 400 });
});
