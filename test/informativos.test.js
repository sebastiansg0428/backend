const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');

test('Enterado cierra solo informativos, por destino, con fecha y auditoría sin respuesta', async t => {
    const usuario = { id: 95, nombre: 'Funcionario', rol: 'funcionario',
        dependencia_id: 3, dependencia_nombre: 'Talento Humano', activo: 1 };
    const token = crearSesion(usuario.id);
    t.after(() => revocarSesiones(usuario.id));
    let regla = 0;
    let global = false;
    let estado = 'Recibido';
    let fechaEnterado = null;
    const escrituras = [];
    t.mock.method(pool, 'execute', async sql => {
        assert.match(sql, /FROM usuarios u/);
        return [[usuario]];
    });
    t.mock.method(pool, 'getConnection', async () => ({
        async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async execute(sql, valores) {
            if (sql.includes('SELECT estado, destino_todas_dependencias')) {
                assert.match(sql, /FOR UPDATE/);
                assert.match(sql, /dependencia_destino_id = \?/);
                return [[{ estado: global ? 'Recibido' : estado,
                    destino_todas_dependencias: Number(global), requiere_respuesta: regla }]];
            }
            if (sql.includes('SELECT id, estado FROM radicado_dependencias')) {
                assert.match(sql, /FOR UPDATE/);
                assert.deepEqual(valores, ['RAD-INFO', 3]);
                return [[{ id: 50, estado }]];
            }
            if (sql.includes('UPDATE radicados') || sql.includes('UPDATE radicado_dependencias')) {
                estado = valores[0];
                fechaEnterado = estado === 'Enterado' ? '2026-10-21 15:00:00' : null;
                escrituras.push({ sql, valores });
                return [{ affectedRows: 1 }];
            }
            if (sql.includes('INSERT INTO historial_radicado')) {
                escrituras.push({ sql, valores });
                return [{ affectedRows: 1 }];
            }
            if (sql.includes('SELECT r.*')) return [[{
                numero_radicado: 'RAD-INFO', requiere_respuesta: regla,
                destino_todas_dependencias: Number(global),
                estado: global ? 'Recibido' : estado, fecha_enterado: global ? null : fechaEnterado,
                seguimiento_estado: global ? estado : null,
                seguimiento_fecha_enterado: global ? fechaEnterado : null,
                fecha_creacion: '2026-10-21'
            }]];
            throw new Error(`Consulta inesperada: ${sql}`);
        }
    }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const pedir = nuevo => fetch(`http://127.0.0.1:${server.address().port}/api/radicados/RAD-INFO/estado`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ estado: nuevo })
    });
    for (const esGlobal of [false, true]) {
        global = esGlobal;
        estado = 'Recibido';
        escrituras.length = 0;
        assert.equal((await pedir('En trámite')).status, 200);
        const cierre = await pedir('Enterado');
        assert.equal(cierre.status, 200);
        const datos = await cierre.json();
        assert.equal(datos.estado, 'Enterado');
        assert.equal(datos.fecha_enterado, '2026-10-21 15:00:00');
        assert.equal(datos.fecha_respuesta, null);
        assert.equal(datos.semaforo.texto, 'Enterado');
        assert.ok(escrituras.some(e => e.sql.includes('historial_radicado') &&
            e.valores[2] === 'Enterado' && e.valores[3] === String(usuario.id)));
        if (global) assert.equal(escrituras.some(e => e.sql.includes('UPDATE radicados')), false);
        const antes = escrituras.length;
        assert.equal((await pedir('Recibido')).status, 409);
        assert.equal((await pedir('Enterado')).status, 409);
        assert.equal(escrituras.length, antes);
        assert.equal((await pedir('Respondido')).status, 400);
    }
    global = false;
    regla = 1;
    estado = 'Recibido';
    assert.equal((await pedir('Enterado')).status, 409);
    estado = 'Respondido';
    assert.equal((await pedir('Pendiente')).status, 409);
    assert.equal(escrituras.some(e => /fecha_respuesta|respuestas_radicado/.test(e.sql)), false);
});
