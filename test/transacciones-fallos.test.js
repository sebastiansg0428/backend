const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const { PDFDocument } = require('pdf-lib');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');
const { revertirTrasError } = require('../transacciones');
const { reservarIntento } = require('../limites-login');

test('reversion compartida conserva errores y descarta conexiones inseguras', async () => {
    const original = new Error('Operacion');
    const rollback = new Error('Rollback');
    assert.deepEqual(await revertirTrasError(undefined, original), { connection: undefined, error: original });
    for (const yaIntentada of [false, true]) {
        const eventos = [];
        const connection = {
            async rollback() { eventos.push('rollback'); throw rollback; },
            destroy() { eventos.push('destroy'); }
        };
        const resultado = await revertirTrasError(connection, yaIntentada ? rollback : original, yaIntentada);
        assert.equal(resultado.connection, undefined);
        assert.deepEqual(eventos, yaIntentada ? ['destroy'] : ['rollback', 'destroy']);
        if (yaIntentada) assert.equal(resultado.error, rollback);
        else assert.deepEqual(resultado.error.errors, [original, rollback]);
    }
});

test('rutas activas preservan limpieza y conexiones ante fallos transaccionales', async t => {
    const usuario = { id: 957, nombre: 'Prueba transaccion', rol: 'administrador', activo: 1, dependencia_id: null };
    const token = crearSesion(usuario.id);
    t.after(() => revocarSesiones(usuario.id));
    const documento = await PDFDocument.create();
    documento.addPage();
    const pdf = await documento.save();
    const rutas = [
        { nombre: 'radicacion', ruta: '/api/radicados', archivo: true, exito: 200 },
        { nombre: 'radicacion ventanilla', ruta: '/api/radicados', archivo: true, exito: 200, rol: 'ventanilla' },
        { nombre: 'respuesta', ruta: '/api/radicados/PRUEBA/respuesta', archivo: true, negocio: true, exito: 201 },
        { nombre: 'estado', ruta: '/api/radicados/PRUEBA/estado', metodo: 'PUT', negocio: true, exito: 200 },
        { nombre: 'tipo', ruta: '/api/tipos-tramite', exito: 201 },
        { nombre: 'termino', ruta: '/api/terminos-legales', negocio: true, exito: 201 }
    ];
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
    const base = `http://127.0.0.1:${server.address().port}`;
    const leer = fs.readFile;
    for (const ruta of rutas) {
        usuario.rol = ruta.rol || 'administrador';
        const escenarios = ruta.rol ? ['exito'] : ['exito', 'conexion', 'inicio', 'sql', 'commit', 'rollback'];
        if (ruta.negocio) escenarios.push('negocio', 'negocio-rollback');
        for (const escenario of escenarios) {
            await t.test(`${ruta.nombre}: ${escenario}`, async caso => {
                const eventos = [];
                const logs = [];
                const archivos = new Set();
                const errorOriginal = new Error(`Fallo ${escenario}`);
                const errorRollback = new Error('Fallo rollback');
                caso.mock.method(console, 'error', (...args) => logs.push(args));
                caso.mock.method(fs, 'readFile', async (archivo, ...opciones) => {
                    archivos.add(archivo);
                    return leer(archivo, ...opciones);
                });
                caso.after(async () => {
                    for (const archivo of archivos) {
                        try { await fs.unlink(archivo); }
                        catch (error) { if (error.code !== 'ENOENT') throw error; }
                    }
                });
                const termino = {
                    id: 1, nombre: 'Solicitud', termino_legal_id: 1, dias: 1,
                    tipo_dias: 'calendario', fundamento_legal: 'Prueba'
                };
                caso.mock.method(pool, 'execute', async sql => {
                    if (sql.includes('FROM usuarios u')) return [[usuario]];
                    if (sql.includes('FROM dependencias')) return [[{ id: 2, nombre: 'Oficina' }]];
                    throw new Error(`SQL fuera de transaccion: ${sql}`);
                });
                caso.mock.method(pool, 'query', async () => [[termino]]);
                caso.mock.method(pool, 'getConnection', async () => {
                    eventos.push('conexion');
                    if (escenario === 'conexion') throw errorOriginal;
                    return {
                        async beginTransaction() {
                            eventos.push('inicio');
                            if (escenario === 'inicio') throw errorOriginal;
                        },
                        async execute(sql, valores) {
                            eventos.push('sql');
                            if (['sql', 'rollback'].includes(escenario)) throw errorOriginal;
                            if (sql.includes('INSERT INTO radicados')) {
                                assert.ok(valores.includes(usuario.nombre));
                                assert.equal(valores.includes('Responsable manipulado'), false);
                            }
                            if (escenario.startsWith('negocio')) return [[]];
                            if (sql.includes('SELECT ultimo_numero')) return [[{ ultimo_numero: 0 }]];
                            if (sql.includes('UNION ALL') || sql.includes('SELECT id FROM respuestas_radicado') ||
                                sql.includes('SELECT id FROM terminos_legales')) return [[]];
                            if (sql.includes('SELECT id FROM tipos_tramite')) return [[{ id: 1 }]];
                            if (sql.includes('SELECT r.estado') || sql.includes('SELECT estado,')) {
                                return [[{ estado: 'Recibido', requiere_respuesta: 1, destino_todas_dependencias: 0 }]];
                            }
                            if (sql.includes('SELECT r.*')) return [[{
                                estado: 'Pendiente', requiere_respuesta: 0, fecha_creacion: '2026-01-01'
                            }]];
                            return [{ insertId: 1, affectedRows: 1 }];
                        },
                        async commit() {
                            eventos.push('commit');
                            if (escenario === 'commit') throw errorOriginal;
                        },
                        async rollback() {
                            eventos.push('rollback');
                            if (escenario.endsWith('rollback')) throw errorRollback;
                        },
                        destroy() { eventos.push('destroy'); },
                        release() { eventos.push('release'); }
                    };
                });
                const datos = {
                    contenido: 'Respuesta institucional de prueba', estado: 'Pendiente',
                    codigo: 'prueba', nombre: 'Prueba', categoria_general: 'especial',
                    dias: 1, tipo_dias: 'calendario', fundamento_legal: 'Prueba',
                    vigente_desde: '2099-01-01', tipo_tramite_id: '1',
                    tipo_comunicacion: 'Externa', remitente_tipo_persona: 'natural',
                    remitente_email: 'prueba@example.test', remitente_nombre: 'Prueba',
                    remitente_documento: '123', asunto_documento: 'Prueba', dependencia_destino_id: '2',
                    usuario_recibe: 'Responsable manipulado'
                };
                let body;
                const headers = { Authorization: `Bearer ${token}` };
                if (ruta.archivo) {
                    body = new FormData();
                    for (const [clave, valor] of Object.entries(datos)) body.append(clave, String(valor));
                    body.append('archivos', new Blob([pdf], { type: 'application/pdf' }), 'prueba.pdf');
                } else {
                    headers['Content-Type'] = 'application/json';
                    body = JSON.stringify(datos);
                }
                const respuesta = await fetch(base + ruta.ruta, { method: ruta.metodo || 'POST', headers, body });
                const resultado = await respuesta.json();
                const status = escenario === 'exito' ? ruta.exito : escenario === 'negocio' ? 404 : 500;
                assert.equal(respuesta.status, status, JSON.stringify(resultado));
                assert.equal(resultado.success, escenario === 'exito');
                if (ruta.nombre.startsWith('radicacion') && escenario === 'exito')
                    assert.equal(resultado.usuario_recibe, usuario.nombre);
                if (escenario === 'conexion') assert.deepEqual(eventos, ['conexion']);
                else if (escenario.endsWith('rollback')) {
                    assert.equal(eventos.filter(e => e === 'rollback').length, 1);
                    assert.equal(eventos.at(-1), 'destroy');
                    assert.equal(eventos.includes('release'), false);
                    if (escenario === 'rollback') assert.ok(logs.some(args => args.some(e =>
                        e instanceof AggregateError && e.errors.includes(errorOriginal) && e.errors.includes(errorRollback))));
                    else assert.ok(logs.some(args => args.includes(errorRollback)));
                } else {
                    assert.equal(eventos.at(-1), 'release');
                    assert.equal(eventos.filter(e => e === 'release').length, 1);
                    assert.equal(eventos.filter(e => e === 'rollback').length, escenario === 'exito' ? 0 : 1);
                }
                if (escenario !== 'exito') {
                    for (const archivo of archivos) await assert.rejects(fs.access(archivo), { code: 'ENOENT' });
                }
            });
        }
    }
});

test('limitador destruye conexion si falla rollback y no reintenta una reversion fallida', async t => {
    for (const denegado of [false, true]) {
        await t.test(denegado ? 'limite alcanzado' : 'error SQL', async caso => {
            const eventos = [];
            const original = new Error('Error SQL');
            const rollback = new Error('Error rollback');
            caso.mock.method(pool, 'getConnection', async () => ({
                async beginTransaction() {},
                async execute(sql) {
                    if (!denegado) throw original;
                    return sql.includes('SELECT ambito') ? [[
                        { ambito: 'cuenta', cantidad: 10, expira: 2000, ahora: 1000 },
                        { ambito: 'ip', cantidad: 0, expira: 2000, ahora: 1000 }
                    ]] : [{}];
                },
                async rollback() { eventos.push('rollback'); throw rollback; },
                destroy() { eventos.push('destroy'); },
                release() { eventos.push('release'); }
            }));
            await assert.rejects(reservarIntento('prueba@example.test', '127.0.0.1'), error =>
                denegado ? error === rollback
                    : error instanceof AggregateError && error.errors[0] === original && error.errors[1] === rollback);
            assert.deepEqual(eventos, ['rollback', 'destroy']);
        });
    }
});
