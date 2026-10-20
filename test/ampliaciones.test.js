const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');

test('ampliaciones preservan respuestas y limpian conexiones ante fallos', async t => {
    const usuario = { id: 902, nombre: 'Admin', rol: 'administrador', dependencia_id: null, activo: 1 };
    const token = crearSesion(usuario.id);
    t.after(() => revocarSesiones(usuario.id));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}/api/radicados/RAD-PRUEBA/ampliaciones`;
    const escenarios = [
        'exito', 'permiso', 'invalido', 'conexion', 'inicio', 'consulta',
        'ampliacion', 'actualizacion', 'historial', 'commit', 'rollback',
        'inexistente', 'respondido', 'vencido', 'fecha',
        'inexistente-rollback', 'respondido-rollback', 'vencido-rollback', 'fecha-rollback'
    ];
    for (const escenario of escenarios) {
        await t.test(escenario, async caso => {
            const eventos = [];
            const errores = [];
            const errorOriginal = new Error(`Fallo ${escenario}`);
            const errorRollback = new Error('Fallo al revertir');
            const negocio = escenario.replace('-rollback', '');
            const estado = negocio === 'respondido' ? 'Respondido' : 'Recibido';
            const fecha = negocio === 'vencido' ? '2000-01-01' : '2099-01-01';
            caso.mock.method(console, 'error', (...args) => errores.push(args));
            caso.mock.method(pool, 'execute', async sql => {
                assert.match(sql, /FROM usuarios u/);
                return [[{ ...usuario, rol: escenario === 'permiso' ? 'ventanilla' : 'administrador' }]];
            });
            caso.mock.method(pool, 'getConnection', async () => {
                eventos.push('conexion');
                if (escenario === 'conexion') throw errorOriginal;
                return {
                    async beginTransaction() {
                        eventos.push('inicio');
                        if (escenario === 'inicio') throw errorOriginal;
                    },
                    async execute(sql, valores) {
                        assert.ok(sql.includes('?'));
                        if (/SELECT r.estado/.test(sql)) {
                            eventos.push('consulta');
                            assert.deepEqual(valores, ['RAD-PRUEBA']);
                            if (escenario === 'consulta') throw errorOriginal;
                            return [negocio === 'inexistente' ? [] : [{ estado, fecha_limite_actual: fecha }]];
                        }
                        const paso = /INSERT INTO ampliaciones_termino/.test(sql) ? 'ampliacion'
                            : /UPDATE radicado_terminos/.test(sql) ? 'actualizacion'
                                : /INSERT INTO historial_radicado/.test(sql) ? 'historial' : null;
                        assert.ok(paso, `Consulta inesperada: ${sql}`);
                        eventos.push(paso);
                        if (escenario === paso) throw errorOriginal;
                        return [{ affectedRows: 1 }];
                    },
                    async commit() {
                        eventos.push('commit');
                        if (escenario === 'commit' || escenario === 'rollback') throw errorOriginal;
                    },
                    async rollback() {
                        eventos.push('rollback');
                        if (escenario === 'rollback' || escenario.endsWith('-rollback')) throw errorRollback;
                    },
                    release() { eventos.push('release'); },
                    destroy() { eventos.push('destroy'); }
                };
            });
            const respuesta = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({
                    motivo: escenario === 'invalido' ? '' : 'Motivo de prueba',
                    fundamento_legal: 'Fundamento de prueba',
                    fecha_limite_nueva: negocio === 'fecha' ? '2098-01-01' : '2099-02-01'
                })
            });
            const resultado = await respuesta.json();
            const status = escenario === 'exito' ? 200 : escenario === 'permiso' ? 403
                : escenario === 'invalido' || escenario === 'fecha' ? 400
                    : escenario === 'inexistente' ? 404
                        : ['respondido', 'vencido'].includes(escenario) ? 409 : 500;
            assert.equal(respuesta.status, status);
            assert.equal(resultado.success, status === 200);
            if (status === 500) {
                assert.equal(resultado.message, 'Error interno al registrar la ampliación.');
                assert.ok(errores.length);
            }
            if (escenario === 'exito') {
                assert.equal(resultado.fecha_limite_anterior, '2099-01-01');
                assert.equal(resultado.fecha_limite_actual, '2099-02-01');
                assert.deepEqual(eventos, ['conexion', 'inicio', 'consulta', 'ampliacion', 'actualizacion', 'historial', 'commit', 'release']);
            } else if (['permiso', 'invalido'].includes(escenario)) {
                assert.deepEqual(eventos, []);
            } else if (escenario === 'conexion') {
                assert.deepEqual(eventos, ['conexion']);
                assert.ok(errores.some(args => args.includes(errorOriginal)));
            } else {
                assert.equal(eventos.filter(e => e === 'rollback').length, 1);
                const falloRollback = escenario === 'rollback' || escenario.endsWith('-rollback');
                assert.equal(eventos.filter(e => e === 'release').length, falloRollback ? 0 : 1);
                assert.equal(eventos.filter(e => e === 'destroy').length, falloRollback ? 1 : 0);
                assert.equal(eventos.at(-1), falloRollback ? 'destroy' : 'release');
                if (escenario === 'rollback') {
                    assert.ok(errores.some(args => args.some(error =>
                        error instanceof AggregateError &&
                        error.errors.includes(errorOriginal) && error.errors.includes(errorRollback))));
                }
                if (escenario.endsWith('-rollback')) {
                    assert.ok(errores.some(args => args.includes(errorRollback)));
                    assert.equal(eventos.includes('ampliacion'), false);
                }
            }
        });
    }
});
