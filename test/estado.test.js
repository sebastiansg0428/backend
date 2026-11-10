const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { obtenerEstadoEditable } = require('../estados');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');

test('normaliza los estados usados por el frontend y el ENUM de MySQL', () => {
    for (const [entrada, esperado] of [
        ['Recibido', 'Recibido'],
        [' pendiente ', 'Pendiente'],
        ['EN TRAMITE', 'En trámite'],
        ['En trámite', 'En trámite'],
        ['ENTERADO', 'Enterado']
    ]) {
        assert.equal(obtenerEstadoEditable(entrada), esperado);
    }
    for (const entrada of ['Respondido', 'Radicado', 'Cerrado', 'Entregado', 'Vencido', '', null, 3]) {
        assert.equal(obtenerEstadoEditable(entrada), null);
    }
});

test('PUT estado impide regresar a Recibido sin escrituras para ambos roles y seguimientos', async t => {
    const usuario = {
        id: 901, nombre: 'Prueba', rol: 'administrador',
        dependencia_id: null, dependencia_nombre: 'Prueba', activo: 1
    };
    const token = crearSesion(usuario.id);
    t.after(() => revocarSesiones(usuario.id));
    t.mock.method(pool, 'execute', async () => [[usuario]]);
    let estadoAnterior;
    let global;
    let rollbacks = 0;
    const connection = {
        async beginTransaction() {}, async commit() { assert.fail('No debe confirmar el retorno.'); },
        async rollback() { rollbacks++; }, release() {},
        async execute(sql) {
            assert.match(sql, /FOR UPDATE/);
            if (sql.includes('SELECT estado, destino_todas_dependencias')) {
                return [[{ estado: global ? 'Recibido' : estadoAnterior, destino_todas_dependencias: global ? 1 : 0 }]];
            }
            if (sql.includes('SELECT rd.id, rd.estado')) {
                return [[{ id: 501, estado: estadoAnterior, dependencia_id: 7, dependencia_nombre: 'Prueba' }]];
            }
            assert.fail(`No debe escribir ni consultar efectos secundarios: ${sql}`);
        }
    };
    t.mock.method(pool, 'getConnection', async () => connection);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())));
    for (const rol of ['administrador', 'funcionario']) {
        usuario.rol = rol;
        usuario.dependencia_id = rol === 'administrador' ? null : 7;
        for (global of [false, true]) {
            for (estadoAnterior of ['En trámite', 'Pendiente', ' EN TRAMITE ', ' pendiente ', 'Respondido', 'Enterado']) {
                const response = await fetch(`http://127.0.0.1:${server.address().port}/api/radicados/RAD-PRUEBA/estado`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ estado: ' recibido ', radicado_dependencia_id: 501 })
                });
                assert.equal(response.status, 409, `${rol}, global=${global}, anterior=${estadoAnterior}`);
                assert.match((await response.json()).message, /no puede reabrirse|No se puede volver a Recibido/);
            }
        }
    }
    assert.equal(rollbacks, 24);
});

test('PUT estado admite estados intermedios sin fabricar respuestas', async t => {
    const usuario = {
        id: 1, nombre: 'Admin de prueba', rol: 'administrador', dependencia_id: null, activo: 1
    };
    const token = crearSesion(usuario.id);
    const funcionario = {
        id: 2, nombre: 'Funcionario de prueba', rol: 'funcionario',
        dependencia_id: 2, dependencia_nombre: 'Planeacion', activo: 1
    };
    const tokenFuncionario = crearSesion(funcionario.id);
    t.after(() => revocarSesiones(usuario.id));
    t.after(() => revocarSesiones(funcionario.id));
    t.mock.method(pool, 'execute', async (sql, values) => {
        assert.match(sql, /FROM usuarios u/);
        return [[values[0] === funcionario.id ? funcionario : usuario]];
    });
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
            if (sql.includes('SELECT estado, destino_todas_dependencias, requiere_respuesta')) {
                if (values.length > 1) {
                    assert.match(sql, /radicados\.dependencia_destino_id = \?/);
                    assert.match(sql, /EXISTS \(/);
                    assert.deepEqual(values, ['RAD-PRUEBA', 2, 2]);
                }
                return [[{ estado, destino_todas_dependencias: 0 }]];
            }
            if (sql.includes('UPDATE radicados')) {
                estado = values[0];
                return [{ affectedRows: 1 }];
            }
            if (sql.includes('SELECT id FROM solicitudes_traslado')) return [[]];
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
    for (const nuevoEstado of ['Recibido', 'En tramite', 'Pendiente']) {
        const response = await fetch(url, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ estado: 'Cerrado' })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /Recibido.*Pendiente.*Respondido/);
    assert.equal(commits, 3);
    assert.equal(rollbacks, 0);
    assert.equal(historial.length, 3);
    assert.equal(historial[0][1], 'estado_cambiado');
    assert.equal(historial[0][2], 'Recibido');
    assert.equal(historial[0][3], 'Recibido');
    const propia = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFuncionario}` },
        body: JSON.stringify({ estado: 'En trámite' })
    });
    assert.equal(propia.status, 200);
    assert.notEqual((await propia.json()).semaforo.nivel, 'completado');
    assert.equal(commits, 4);
    assert.equal(historial[3][4], String(funcionario.id));
    const manual = await fetch(url, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ estado: 'Respondido' })
    });
    assert.equal(manual.status, 400);
});

test('PUT de un radicado global solo actualiza la asignación de la dependencia del funcionario', async t => {
    const funcionario = {
        id: 72, nombre: 'Funcionaria', rol: 'funcionario', dependencia_id: 7,
        dependencia_nombre: 'Talento Humano', activo: 1
    };
    const token = crearSesion(funcionario.id);
    t.after(() => revocarSesiones(funcionario.id));
    t.mock.method(pool, 'execute', async (sql, values) => {
        if (sql.includes('FROM usuarios u')) return [[funcionario]];
        throw new Error(`Consulta inesperada en la prueba: ${sql}`);
    });
    let estadoDependencia = 'Recibido';
    const escrituras = [];
    const connection = {
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async execute(sql, values) {
            if (sql.includes('SELECT estado, destino_todas_dependencias, requiere_respuesta')) {
                assert.deepEqual(values, ['RAD-GLOBAL', 7, 7]);
                return [[{ estado: 'Respondido', destino_todas_dependencias: 1 }]];
            }
            if (sql.includes('SELECT rd.id, rd.estado, rd.dependencia_id')) {
                return [[{
                    id: 501, estado: estadoDependencia, dependencia_id: 7,
                    dependencia_nombre: 'Talento Humano'
                }]];
            }
            if (sql.includes('UPDATE radicado_dependencias')) {
                estadoDependencia = values[0];
                escrituras.push(sql);
                return [{ affectedRows: 1 }];
            }
            if (sql.includes('INSERT INTO historial_radicado')) return [{ affectedRows: 1 }];
            if (sql.includes('SELECT r.*')) return [[{
                numero_radicado: 'RAD-GLOBAL', estado: 'Respondido',
                destino_todas_dependencias: 1,
                radicado_dependencia_id: 501,
                seguimiento_estado: estadoDependencia,
                termino_fecha_recepcion: '2026-10-16',
                termino_dias: 15, termino_tipo_dias: 'habiles',
                termino_fecha_limite_actual: '2026-11-06'
            }]];
            throw new Error(`Consulta inesperada en la prueba: ${sql}`);
        }
    };
    t.mock.method(pool, 'getConnection', async () => connection);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())));
    for (const estado of ['En trámite', 'Pendiente', 'En trámite']) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/radicados/RAD-GLOBAL/estado`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ estado })
        });
        assert.equal(response.status, 200);
        const resultado = await response.json();
        assert.equal(resultado.estado, estado);
    }
    assert.equal(estadoDependencia, 'En trámite');
    assert.equal(escrituras.length, 3);
});
