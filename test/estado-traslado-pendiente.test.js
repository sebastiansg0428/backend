const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');
const { presentarRadicado } = require('../presentacion-radicado');
const { SELECT } = require('../consulta-radicados');

test('listado incluye pendiente sin duplicar filas ni depender de la pagina de traslados', () => {
    assert.match(SELECT, /EXISTS \([\s\S]*solicitudes_traslado st/);
    assert.match(SELECT, /st.numero_radicado = r.numero_radicado AND st.estado = 'pendiente'/);
    assert.match(SELECT, /destino_todas_dependencias = 0/);
    for (const [valor, esperado] of [[1, true], ['1', true], [0, false], [undefined, false]]) {
        assert.equal(presentarRadicado({ estado: 'Recibido', requiere_respuesta: 0,
            traslado_pendiente: valor }).traslado_pendiente, esperado);
    }
});

test('PUT protege funcionario pendiente pero permite administrador, global y cierre Enterado', async t => {
    const usuario = { id: 9871, nombre: 'Actor fixture', rol: 'funcionario',
        dependencia_id: 3, dependencia_nombre: 'Oficina fixture', activo: 1 };
    const token = crearSesion(usuario.id);
    t.after(() => revocarSesiones(usuario.id));
    t.mock.method(pool, 'execute', async () => [[usuario]]);
    let pendiente = true;
    let global = false;
    let requiere = 1;
    let estado = 'Recibido';
    let pasos = [];
    t.mock.method(pool, 'getConnection', async () => ({
        async beginTransaction() { pasos.push('inicio'); },
        async commit() { pasos.push('commit'); },
        async rollback() { pasos.push('rollback'); },
        release() {},
        async execute(sql, valores) {
            pasos.push(sql);
            if (sql.includes('SELECT estado, destino_todas_dependencias')) {
                assert.match(sql, /FOR UPDATE/);
                return [[{ estado, destino_todas_dependencias: global ? 1 : 0,
                    requiere_respuesta: requiere, dependencia_destino_id: 3, dependencia_destino: 'Oficina fixture' }]];
            }
            if (sql.includes('SELECT rd.id, rd.estado')) return [[{ id: 7, estado,
                dependencia_id: 3, dependencia_nombre: 'Oficina fixture' }]];
            if (sql.includes('SELECT id FROM solicitudes_traslado')) {
                assert.match(sql, /FOR UPDATE/);
                assert.deepEqual(valores, ['RAD-FIXTURE']);
                return [pendiente ? [{ id: 8 }] : []];
            }
            if (sql.includes('SELECT * FROM solicitudes_traslado')) return [pendiente ? [{
                id: 8, numero_radicado: 'RAD-FIXTURE', origen_id: 3, origen_nombre: 'Oficina fixture',
                destino_sugerido_nombre: 'Destino fixture',
            }] : []];
            if (sql.includes('UPDATE solicitudes_traslado')) { pendiente = false; return [{ affectedRows: 1 }]; }
            if (/UPDATE (radicados|radicado_dependencias) SET estado/.test(sql)) {
                estado = valores[0]; return [{ affectedRows: 1 }];
            }
            if (sql.includes('INSERT INTO historial_radicado')) return [{ affectedRows: 1 }];
            if (sql.includes('SELECT r.*')) return [[{ numero_radicado: 'RAD-FIXTURE', estado,
                requiere_respuesta: requiere, destino_todas_dependencias: global ? 1 : 0 }]];
            throw new Error(`Consulta no prevista: ${sql}`);
        }
    }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const pedir = nuevo => fetch(`http://127.0.0.1:${server.address().port}/api/radicados/RAD-FIXTURE/estado`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: nuevo }),
    });
    for (const nuevo of ['Recibido', 'En trámite', 'Pendiente']) {
        pasos = [];
        const r = await pedir(nuevo);
        assert.equal(r.status, 409);
        assert.match((await r.json()).message, /Traslado pendiente de decisión/);
        assert.equal(pasos.some(sql => /UPDATE|INSERT/.test(sql.replaceAll('FOR UPDATE', ''))), false);
        assert.ok(pasos.includes('rollback'));
        const lock = pasos.findIndex(sql => sql.includes('SELECT estado, destino_todas_dependencias'));
        const consulta = pasos.findIndex(sql => sql.includes('SELECT id FROM solicitudes_traslado'));
        assert.ok(consulta > lock);
    }
    pasos = [];
    assert.equal((await pedir('Enterado')).status, 409);
    assert.equal(pendiente, true);
    assert.equal(estado, 'Recibido');
    pendiente = false;
    assert.equal((await pedir('En trámite')).status, 200);
    pendiente = true; usuario.rol = 'administrador'; usuario.dependencia_id = null;
    pasos = [];
    assert.equal((await pedir('Pendiente')).status, 200);
    assert.equal(pasos.some(sql => sql.includes('SELECT id FROM solicitudes_traslado')), false);
    usuario.rol = 'ventanilla';
    assert.equal((await pedir('En trámite')).status, 403);
    usuario.rol = 'funcionario'; usuario.dependencia_id = 3; global = true;
    pasos = [];
    assert.equal((await pedir('En trámite')).status, 200);
    assert.equal(pasos.some(sql => sql.includes('SELECT id FROM solicitudes_traslado')), false);
    global = false; requiere = 0; pasos = [];
    assert.equal((await pedir('Enterado')).status, 200);
    assert.equal(pendiente, false);
    assert.equal(estado, 'Enterado');
    assert.ok(pasos.some(sql => sql.includes('UPDATE solicitudes_traslado')));
    assert.ok(pasos.includes('commit'));
});
