const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');

test('creacion y cambios de estado de dependencias son atomicos', async t => {
    const usuario = { id: 901, nombre: 'Admin', rol: 'administrador', dependencia_id: null, activo: 1 };
    const token = crearSesion(usuario.id);
    t.after(() => revocarSesiones(usuario.id));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}/api/dependencias`;

    for (const operacion of ['crear', 'activar', 'inactivar']) {
        const escenarios = ['exito', 'conexion', 'inicio', 'commit', 'rollback'];
        if (operacion !== 'inactivar') escenarios.push('asignacion');
        if (operacion === 'crear') escenarios.push('duplicado');
        else escenarios.push('inexistente');

        for (const escenario of escenarios) {
            await t.test(`${operacion}: ${escenario}`, async caso => {
                let dependencias = [{ id: 2, nombre: 'Planeacion', activo: operacion === 'inactivar' ? 1 : 0 }];
                let seguimientos = [{ numero_radicado: 'RAD-GLOBAL', dependencia_id: 1 }];
                const anterior = structuredClone({ dependencias, seguimientos });
                const eventos = [];
                const errores = [];
                let copia;
                let abierta = false;
                caso.mock.method(console, 'error', (...args) => errores.push(args));
                caso.mock.method(pool, 'execute', async sql => {
                    assert.match(sql, /FROM usuarios u/);
                    return [[usuario]];
                });
                caso.mock.method(pool, 'getConnection', async () => {
                    eventos.push('conexion');
                    if (escenario === 'conexion') throw new Error('Conexion no disponible');
                    return {
                        async beginTransaction() {
                            eventos.push('inicio');
                            if (escenario === 'inicio') throw new Error('No se pudo iniciar la transaccion');
                            copia = structuredClone({ dependencias, seguimientos });
                            abierta = true;
                        },
                        async execute(sql, valores) {
                            assert.equal(abierta, true);
                            if (sql.startsWith('INSERT INTO dependencias')) {
                                eventos.push('dependencia');
                                if (escenario === 'duplicado') {
                                    throw Object.assign(new Error('Duplicado'), { code: 'ER_DUP_ENTRY' });
                                }
                                dependencias.push({ id: 3, nombre: valores[0], activo: 1 });
                                return [{ insertId: 3 }];
                            }
                            if (sql.startsWith('UPDATE dependencias')) {
                                eventos.push('dependencia');
                                if (escenario === 'inexistente') return [{ affectedRows: 0 }];
                                assert.deepEqual(valores, [operacion === 'activar' ? 1 : 0, 2]);
                                dependencias[0].activo = valores[0];
                                return [{ affectedRows: 1 }];
                            }
                            assert.match(sql, /^INSERT IGNORE INTO radicado_dependencias/);
                            assert.match(sql, /WHERE destino_todas_dependencias = 1/);
                            eventos.push('asignacion');
                            assert.deepEqual(valores, [operacion === 'crear' ? 3 : 2]);
                            seguimientos.push({ numero_radicado: 'RAD-GLOBAL', dependencia_id: valores[0] });
                            if (['asignacion', 'rollback'].includes(escenario)) {
                                throw new Error('Fallo al asignar seguimientos');
                            }
                            return [{ affectedRows: 1 }];
                        },
                        async commit() {
                            eventos.push('commit');
                            if (['commit', 'rollback'].includes(escenario)) throw new Error('Fallo al confirmar');
                            abierta = false;
                        },
                        async rollback() {
                            eventos.push('rollback');
                            if (escenario === 'rollback') throw new Error('Fallo al revertir');
                            if (copia) ({ dependencias, seguimientos } = copia);
                            abierta = false;
                        },
                        release() {
                            eventos.push('release');
                        },
                        destroy() {
                            eventos.push('destroy');
                        }
                    };
                });
                const respuesta = await fetch(operacion === 'crear' ? url : `${url}/2/estado`, {
                    method: operacion === 'crear' ? 'POST' : 'PATCH',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify(operacion === 'crear'
                        ? { nombre: ' Nueva dependencia ' }
                        : { activo: operacion === 'activar' ? 1 : 0 })
                });
                const resultado = await respuesta.json();
                if (escenario === 'exito') {
                    assert.equal(respuesta.status, operacion === 'crear' ? 201 : 200);
                    assert.equal(resultado.success, true);
                    assert.deepEqual(eventos, [
                        'conexion', 'inicio', 'dependencia',
                        ...(operacion === 'inactivar' ? [] : ['asignacion']), 'commit', 'release'
                    ]);
                    if (operacion === 'crear') {
                        assert.deepEqual(resultado.dependencia, { id: 3, nombre: 'Nueva dependencia', activo: 1 });
                    } else {
                        assert.equal(dependencias[0].activo, operacion === 'activar' ? 1 : 0);
                    }
                    assert.equal(seguimientos.length, operacion === 'inactivar' ? 1 : 2);
                } else {
                    assert.equal(respuesta.status, escenario === 'duplicado' ? 409 : escenario === 'inexistente' ? 404 : 500);
                    assert.equal(resultado.success, false);
                    if (escenario !== 'rollback') assert.deepEqual({ dependencias, seguimientos }, anterior);
                    if (escenario === 'conexion') {
                        assert.deepEqual(eventos, ['conexion']);
                    } else if (escenario === 'rollback') {
                        assert.equal(eventos.at(-1), 'destroy');
                        assert.equal(eventos.includes('release'), false);
                    } else {
                        assert.equal(eventos.at(-1), 'release');
                        assert.equal(eventos.filter(evento => evento === 'release').length, 1);
                        assert.ok(eventos.includes('rollback'));
                    }
                    if (escenario === 'rollback') {
                        assert.ok(errores.some(args => args.some(error =>
                            error instanceof AggregateError && error.errors.length === 2)));
                    }
                }
            });
        }
    }
});
