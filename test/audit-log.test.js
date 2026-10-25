const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');
const { EVENTOS_RADICADO, registrarEventoRadicado } = require('../audit-log');

test('el evento guarda actor, snapshot, correlacion segura e instante UTC', async () => {
    const llamadas = [];
    const connection = {
        async execute(sql, values) {
            llamadas.push({ sql, values });
            return [{ affectedRows: 1 }];
        }
    };
    const req = {
        usuario: { id: 71, nombre: 'Funcionario Prueba' },
        idSesion: 'e31cbbe5-71d1-46f2-9800-2ed430fca710',
        ip: '198.51.100.12',
        headers: { authorization: 'Bearer no-debe-persistirse', 'x-forwarded-for': '203.0.113.8' }
    };
    await registrarEventoRadicado(connection, req, {
        numeroRadicado: 'RAD-PRUEBA',
        tipo: 'estado_cambiado',
        valorAnterior: 'Recibido',
        valorNuevo: 'En trámite',
        dependenciaId: 4,
        dependenciaNombre: 'Planeación',
        radicadoDependenciaId: 99,
        motivo: 'Estado cambiado a En trámite.'
    });
    assert.equal(EVENTOS_RADICADO.has('radicado_archivado'), false);
    assert.equal(llamadas.length, 1);
    assert.match(llamadas[0].sql, /ocurrido_en_utc/);
    assert.doesNotMatch(llamadas[0].sql, /authorization|x-forwarded-for|token/i);
    const values = llamadas[0].values;
    assert.deepEqual(values.slice(0, 14), [
        'RAD-PRUEBA', 'estado_cambiado', 'Recibido', 'En trámite', '71',
        'Estado cambiado a En trámite.', 'estado_cambiado', 71, 'Funcionario Prueba',
        4, 'Planeación', 99, req.idSesion, req.ip
    ]);
    assert.match(values[14], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    assert.equal(values.includes('Bearer no-debe-persistirse'), false);
    assert.equal(values.includes(req.headers['x-forwarded-for']), false);
});

test('rechaza eventos fuera del catalogo y actores sin identidad autenticada', async () => {
    const connection = { execute: async () => { throw new Error('No debe escribir'); } };
    await assert.rejects(registrarEventoRadicado(connection, {
        usuario: { id: 1, nombre: 'Admin' }
    }, { tipo: 'radicado_archivado', numeroRadicado: 'RAD-1' }), TypeError);
    await assert.rejects(registrarEventoRadicado(connection, {}, {
        tipo: 'radicado_creado', numeroRadicado: 'RAD-1'
    }), TypeError);
});

test('historial pagina con cursor y omite IP y sesion de la API', async t => {
    const usuario = {
        id: 72, nombre: 'Auditoría de prueba', rol: 'funcionario',
        dependencia_id: 4, dependencia_nombre: 'Planeación', activo: 1
    };
    const token = crearSesion(usuario.id);
    t.after(() => revocarSesiones(usuario.id));
    const filas = [
        { id: 30, event_type: 'estado_cambiado', actor_name: 'Ana', dependencia_nombre: 'Planeación',
            ocurrido_en_utc: '2026-10-25 16:00:00.123000', ip_address: '192.0.2.1', session_id: 'secreto-1' },
        { id: 29, event_type: 'radicado_asignado', actor_name: 'Luis', dependencia_nombre: 'Hacienda',
            ocurrido_en_utc: '2026-10-25 15:00:00.000000', ip_address: '192.0.2.2', session_id: 'secreto-2' },
        { id: 28, event_type: null, campo_modificado: 'regla_respuesta', usuario: '7',
            creado_en: '2024-01-01 08:00:00', ip_address: null, session_id: null }
    ];
    const consultas = [];
    t.mock.method(pool, 'execute', async (sql, values = []) => {
        if (sql.includes('FROM usuarios u')) return [[usuario]];
        if (sql.includes('SELECT r.id FROM radicados r')) return [[{ id: 1 }]];
        assert.match(sql, /FROM historial_radicado/);
        assert.doesNotMatch(sql, /ip_address|session_id/);
        assert.match(sql, /ORDER BY id DESC\s+LIMIT \?/);
        consultas.push(values);
        const pagina = values[1] === null ? filas : filas.filter(fila => fila.id < values[1]);
        return [pagina.map(({ ip_address, session_id, ...publico }) => publico)];
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}/api/radicados/RAD-PRUEBA/historial`;
    const headers = { Authorization: `Bearer ${token}` };
    const primera = await fetch(`${url}?limite=2`, { headers });
    assert.equal(primera.status, 200);
    const paginaUno = await primera.json();
    assert.deepEqual(paginaUno.historial.map(fila => fila.id), [30, 29]);
    assert.equal(paginaUno.next_cursor, 29);
    assert.equal(paginaUno.has_more, true);
    assert.equal(JSON.stringify(paginaUno).includes('192.0.2.'), false);
    assert.equal(JSON.stringify(paginaUno).includes('secreto-'), false);
    const segunda = await fetch(`${url}?limite=2&cursor=29`, { headers });
    const paginaDos = await segunda.json();
    assert.deepEqual(paginaDos.historial.map(fila => fila.id), [28]);
    assert.equal(paginaDos.next_cursor, null);
    assert.equal(paginaDos.has_more, false);
    assert.deepEqual(consultas, [
        ['RAD-PRUEBA', null, null, 3],
        ['RAD-PRUEBA', 29, 29, 3]
    ]);
    for (const query of ['?limite=0', '?limite=101', '?cursor=0', '?cursor=no']) {
        const respuesta = await fetch(`${url}${query}`, { headers });
        assert.equal(respuesta.status, 400);
    }
});
