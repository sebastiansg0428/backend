const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');
const migrar = require('../migrations/023_solicitudes_traslado');

test('migracion 023 conserva tipo e intercalacion historicos sin alterar radicados', async () => {
    for (const [tipo, collation] of [['varchar(50)', 'utf8mb4_uca1400_ai_ci'], ['varchar(100)', 'utf8mb4_unicode_ci']]) {
        let sql;
        await migrar({
            async execute() { return [[{ COLUMN_TYPE: tipo, CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: collation }]]; },
            async query(valor) { sql = valor; },
        });
        assert.ok(sql.includes(`numero_radicado ${tipo} CHARACTER SET utf8mb4 COLLATE ${collation} NOT NULL`));
        assert.match(sql, /UNIQUE KEY uq_traslado_pendiente \(pendiente_radicado\)/);
        assert.match(sql, /UNIQUE KEY uq_traslado_intento \(solicitante_id, clave_solicitud\)/);
        assert.doesNotMatch(sql, /ALTER TABLE radicados|UPDATE radicados/);
    }
    await assert.rejects(migrar({
        async execute() { return [[{ COLUMN_TYPE: 'text', CHARACTER_SET_NAME: 'utf8mb4', COLLATION_NAME: 'utf8mb4_unicode_ci' }]]; },
    }), /no es compatible/);
});

test('catalogo de destinos de traslado: roles, activas y errores sin ampliar catalogo general', async t => {
    const usuarios = [
        { id: 8811, nombre: 'Funcionario fixture', rol: 'funcionario', dependencia_id: 3, dependencia_nombre: 'Planeacion', activo: 1 },
        { id: 8812, nombre: 'Ventanilla fixture', rol: 'ventanilla', dependencia_id: null, activo: 1 },
        { id: 8813, nombre: 'Admin fixture', rol: 'administrador', dependencia_id: null, activo: 1 },
    ];
    const dependencias = [{ id: 3, nombre: 'Planeacion', activo: 1 }, { id: 4, nombre: 'SEDAM', activo: 1 },
        { id: 5, nombre: 'Inactiva', activo: 0 }];
    const tokens = usuarios.map(u => crearSesion(u.id));
    t.after(() => usuarios.forEach(u => revocarSesiones(u.id)));
    let falloCatalogo = false;
    const logs = [];
    t.mock.method(console, 'error', (...args) => logs.push(args));
    t.mock.method(pool, 'execute', async (sql, valores) => {
        if (sql.includes('FROM usuarios u')) return [[usuarios.find(u => u.id === valores[0])]];
        if (sql === 'SELECT id, nombre, activo FROM dependencias WHERE activo = 1 ORDER BY nombre') {
            if (falloCatalogo) throw new Error('Catalogo fixture no disponible');
            return [dependencias.filter(d => d.activo === 1)];
        }
        assert.match(sql, /WHERE \(\? IS NULL OR id = \?\)/);
        assert.deepEqual(valores, [3, 3, 1]);
        return [[dependencias[0]]];
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api`;
    assert.equal((await fetch(`${url}/traslados/dependencias`)).status, 401);
    for (const token of tokens) {
        const respuesta = await fetch(`${url}/traslados/dependencias`, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(respuesta.status, 200);
        assert.deepEqual(await respuesta.json(), { success: true, dependencias: dependencias.slice(0, 2) });
    }
    const headers = { Authorization: `Bearer ${tokens[0]}` };
    const general = await fetch(`${url}/dependencias`, { headers });
    assert.deepEqual((await general.json()).dependencias, [dependencias[0]]);
    falloCatalogo = true;
    assert.equal((await fetch(`${url}/traslados/dependencias`, { headers })).status, 500);
    assert.ok(logs.length);
});

test('traslados: contratos HTTP, replay y rollback sin MySQL', async t => {
    const usuario = { id: 8801, nombre: 'Actor fixture', rol: 'funcionario', dependencia_id: 3, dependencia_nombre: 'Origen', activo: 1 };
    const token = crearSesion(usuario.id);
    t.after(() => revocarSesiones(usuario.id));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const pedir = (ruta, body) => fetch(`http://127.0.0.1:${server.address().port}/api${ruta}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const escenario of ['flujo', 'rechazo', 'conexion', 'inicio', 'insert', 'audit', 'commit', 'rollback']) {
        await t.test(escenario, async caso => {
            usuario.rol = 'funcionario'; usuario.dependencia_id = 3;
            let radicado = { numero_radicado: 'RAD-FIXTURE', estado: 'En trámite', destino_todas_dependencias: 0, dependencia_destino_id: 3, dependencia_destino: 'Origen' };
            let solicitudes = [];
            let eventos = [];
            const pasos = [];
            const logs = [];
            let copia;
            caso.mock.method(console, 'error', (...args) => logs.push(args));
            caso.mock.method(pool, 'execute', async sql => {
                assert.match(sql, /FROM usuarios u/);
                return [[usuario]];
            });
            caso.mock.method(pool, 'getConnection', async () => {
                if (escenario === 'conexion') throw new Error('Conexion fixture');
                return {
                    async query(sql) { pasos.push(sql); },
                    async beginTransaction() {
                        if (escenario === 'inicio') throw new Error('Inicio fixture');
                        copia = structuredClone({ radicado, solicitudes, eventos });
                    },
                    async execute(sql, valores = []) {
                        pasos.push(sql);
                        if (sql.includes('FROM radicados WHERE')) return [[{ ...radicado }]];
                        if (sql.includes('SELECT id, nombre FROM dependencias')) return [valores[0] === 4 ? [{ id: 4, nombre: 'Destino' }] : []];
                        if (sql.includes('FROM radicado_terminos')) return [[{ fecha_limite_actual: '2026-01-27' }]];
                        if (sql.startsWith('INSERT INTO solicitudes_traslado')) {
                            if (escenario === 'insert') throw new Error('Insert fixture');
                            const [numero, origen, origenNombre, destino, destinoNombre, actor, actorNombre, motivo, clave, huella] = valores;
                            solicitudes.push({ id: 1, numero_radicado: numero, origen_id: origen, origen_nombre: origenNombre,
                                destino_sugerido_id: destino, destino_sugerido_nombre: destinoNombre, solicitante_id: actor,
                                solicitante_nombre: actorNombre, motivo_solicitud: motivo, clave_solicitud: clave, huella_solicitud: huella, estado: 'pendiente' });
                            return [{ insertId: 1 }];
                        }
                        if (sql.includes('FROM solicitudes_traslado')) {
                            let filas = solicitudes;
                            if (sql.includes('solicitante_id = ?')) filas = filas.filter(s => s.solicitante_id === valores[0] && s.clave_solicitud === valores[1]);
                            else if (sql.includes('numero_radicado = ?')) filas = filas.filter(s => s.numero_radicado === valores[0] && s.estado === 'pendiente');
                            else if (sql.includes('WHERE id = ?')) filas = filas.filter(s => s.id === valores[0]);
                            if (sql.includes('AND origen_id = ?')) filas = filas.filter(s => s.origen_id === valores[1]);
                            const columnas = sql.slice(7, sql.indexOf(' FROM')).split(',').map(s => s.trim());
                            return [filas.map(s => columnas.includes('*') ? { ...s } : Object.fromEntries(columnas.map(k => [k, s[k]])))];
                        }
                        if (sql.startsWith('UPDATE radicados')) {
                            radicado.dependencia_destino_id = valores[0]; radicado.dependencia_destino = valores[1];
                            return [{ affectedRows: 1 }];
                        }
                        if (sql.startsWith('UPDATE solicitudes_traslado')) {
                            const [estado, destino, nombreDestino, decisor, nombreDecisor, motivo, huella] = valores;
                            Object.assign(solicitudes[0], { estado, destino_aprobado_id: destino, destino_aprobado_nombre: nombreDestino,
                                decisor_id: decisor, decisor_nombre: nombreDecisor, motivo_decision: motivo, huella_decision: huella });
                            return [{ affectedRows: 1 }];
                        }
                        if (sql.includes('INSERT INTO historial_radicado')) {
                            if (['audit', 'rollback'].includes(escenario)) throw new Error('Auditoria fixture');
                            eventos.push(valores[6]);
                            return [{ affectedRows: 1 }];
                        }
                        throw new Error(`Consulta no prevista: ${sql}`);
                    },
                    async commit() { if (escenario === 'commit') throw new Error('Commit fixture'); },
                    async rollback() {
                        pasos.push('rollback');
                        if (escenario === 'rollback') throw new Error('Rollback fixture');
                        if (copia) ({ radicado, solicitudes, eventos } = structuredClone(copia));
                    },
                    release() { pasos.push('release'); },
                    destroy() { pasos.push('destroy'); },
                };
            });
            const datos = { clave_solicitud: randomUUID(), destino_sugerido_id: 4, motivo: 'Revisar competencia de prueba.' };
            const respuesta = await pedir('/radicados/RAD-FIXTURE/traslados', datos);
            if (!['flujo', 'rechazo'].includes(escenario)) {
                assert.equal(respuesta.status, 500);
                assert.ok(logs.length);
                if (escenario === 'rollback') {
                    assert.ok(pasos.includes('destroy'));
                    assert.equal(pasos.includes('release'), false);
                } else {
                    assert.equal(solicitudes.length, 0);
                    assert.equal(eventos.length, 0);
                }
                return;
            }
            assert.equal(respuesta.status, 201);
            assert.deepEqual(eventos, ['traslado_solicitado']);
            assert.equal((await pedir('/radicados/RAD-FIXTURE/traslados', datos)).status, 200);
            assert.equal((await pedir('/radicados/RAD-FIXTURE/traslados', { ...datos, motivo: 'Un motivo distinto al anterior.' })).status, 409);
            assert.equal((await pedir('/radicados/RAD-FIXTURE/traslados', { ...datos, clave_solicitud: randomUUID() })).status, 409);
            const decision = { decision: escenario === 'rechazo' ? 'rechazada' : 'aprobada', motivo: 'Decision central justificada.',
                ...(escenario === 'rechazo' ? {} : { destino_id: 4 }) };
            assert.equal((await pedir('/traslados/1/decision', decision)).status, 403);
            usuario.rol = 'ventanilla'; usuario.dependencia_id = null;
            assert.equal((await pedir('/traslados/1/decision', decision)).status, 200);
            assert.equal((await pedir('/traslados/1/decision', decision)).status, 200);
            assert.equal((await pedir('/traslados/1/decision', { ...decision, motivo: 'Otra decision incompatible.' })).status, 409);
            assert.equal(radicado.dependencia_destino_id, escenario === 'rechazo' ? 3 : 4);
            assert.equal(eventos.length, 2);
            usuario.rol = 'funcionario'; usuario.dependencia_id = 3;
            const recibo = (await (await pedir('/traslados/1')).json()).traslado;
            assert.equal('huella_solicitud' in recibo, false);
            assert.equal('solicitante_id' in recibo, false);
            usuario.dependencia_id = 4;
            assert.equal((await pedir('/traslados/1')).status, 404);
            assert.equal(pasos.filter(sql => sql.includes('INSERT INTO solicitudes_traslado')).length, 1);
        });
    }
});
