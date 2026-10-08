const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { obtenerEstadoEditable } = require('../estados');
const pool = require('../db');
const app = require('../server');

test('normaliza los estados usados por el frontend y el ENUM de MySQL', () => {
    for (const [entrada, esperado] of [
        ['Recibido', 'Recibido'],
        [' pendiente ', 'Pendiente'],
        ['EN TRAMITE', 'En trámite'],
        ['En trámite', 'En trámite'],
        ['RESPONDIDO', 'Respondido']
    ]) {
        assert.equal(obtenerEstadoEditable(entrada), esperado);
    }
    for (const entrada of ['Radicado', 'Cerrado', 'Entregado', 'Vencido', '', null, 3]) {
        assert.equal(obtenerEstadoEditable(entrada), null);
    }
});

test('PUT estado admite los cuatro estados y actualiza el semáforo sin cambiar términos', async t => {
    let estado = 'Recibido';
    let fechaRespuesta = null;
    let commits = 0;
    let rollbacks = 0;
    const historial = [];
    const connection = {
        async beginTransaction() {},
        async commit() { commits++; },
        async rollback() { rollbacks++; },
        release() {},
        async execute(sql, values) {
            if (sql.includes('SELECT estado FROM radicados')) {
                return [[{ estado }]];
            }
            if (sql.includes('UPDATE radicados')) {
                estado = values[0];
                return [{ affectedRows: 1 }];
            }
            if (sql.includes('UPDATE radicado_terminos')) {
                fechaRespuesta = values[0] === 'Respondido' ? '2026-10-07 11:53:00' : null;
                return [{ affectedRows: 1 }];
            }
            if (sql.includes('INSERT INTO historial_radicado')) {
                historial.push(values);
                return [{ affectedRows: 1 }];
            }
            if (sql.includes('SELECT r.*')) {
                return [[{
                    numero_radicado: 'RAD-PRUEBA',
                    estado,
                    termino_fecha_recepcion: '2026-10-07',
                    termino_dias: 15,
                    termino_tipo_dias: 'habiles',
                    termino_fundamento: 'Regla de prueba',
                    termino_fecha_limite_inicial: '2026-10-29',
                    termino_fecha_limite_actual: '2026-10-29',
                    termino_fecha_respuesta: fechaRespuesta
                }]];
            }
            throw new Error(`Consulta inesperada en la prueba: ${sql}`);
        }
    };
    t.mock.method(pool, 'getConnection', async () => connection);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    }));
    const url = `http://127.0.0.1:${server.address().port}/api/radicados/RAD-PRUEBA/estado`;
    for (const nuevoEstado of ['Respondido', 'Recibido', 'En tramite', 'Pendiente']) {
        const response = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ estado: nuevoEstado })
        });
        assert.equal(response.status, 200);
        const resultado = await response.json();
        assert.equal(resultado.success, true);
        assert.equal(resultado.estado, obtenerEstadoEditable(nuevoEstado));
        assert.equal(resultado.fecha_limite_actual, '2026-10-29');
        if (nuevoEstado === 'Respondido') {
            assert.equal(resultado.semaforo.nivel, 'completado');
            assert.equal(resultado.fecha_respuesta, '2026-10-07 11:53:00');
        } else {
            assert.notEqual(resultado.semaforo.nivel, 'completado');
            assert.equal(resultado.fecha_respuesta, null);
        }
    }
    const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: 'Cerrado' })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /Recibido.*Pendiente.*Respondido/);
    assert.equal(commits, 4);
    assert.equal(rollbacks, 0);
    assert.equal(historial.length, 4);
    assert.equal(historial[0][1], 'Recibido');
    assert.equal(historial[0][2], 'Respondido');
});
