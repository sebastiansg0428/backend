const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');
const { opcionesConsulta, construirFiltros, consultarPagina } = require('../consulta-radicados');
const { agregarDias, obtenerFechaLocal } = require('../semaforo');

test('consulta valida limites y filtros sin aceptar arreglos ni comodines implicitos', () => {
    assert.deepEqual(opcionesConsulta({ pagina: '1' }), {
        pagina: 1, limite: 25, busqueda: '', clase: '', hoy: false, criticos: false,
        vista: 'recibidos'
    });
    for (const query of [
        { pagina: '0' }, { pagina: ['1'] }, { pagina: '1', limite: '101' },
        { pagina: '1', criticos: 'true' }, { pagina: '1', hoy: ['1'] },
        { pagina: '1', busqueda: ['texto'] }, { pagina: '1', busqueda: 'x'.repeat(151) },
        { pagina: '1', tipo_comunicacion: 'inventado' }, { pagina: '1', vista: 'otra' }
    ]) assert.throws(() => opcionesConsulta(query), TypeError);
    const filtros = construirFiltros({ rol: 'funcionario', dependencia_id: 3 },
        opcionesConsulta({ pagina: '1', busqueda: "O'Neil_%", hoy: '1', tipo_comunicacion: 'sin-tipo' }), '2026-11-03');
    assert.match(filtros.base, /dependencia_destino_id = \?/);
    assert.match(filtros.filtro, /LOCATE/);
    assert.ok(!filtros.filtro.includes("O'Neil"));
    assert.deepEqual(filtros.valoresBase, [3, 3, 3, 3]);
    assert.deepEqual(filtros.valoresFiltro, ["O'Neil_%", "O'Neil_%", "O'Neil_%", "O'Neil_%", '2026-11-03', 'sin-tipo']);
    const enviados = construirFiltros({ rol: 'funcionario', dependencia_id: 3 },
        opcionesConsulta({ pagina: '1', vista: 'generados' }), '2026-11-03');
    assert.match(enviados.base, /tipo_comunicacion.*interna/);
    assert.match(enviados.base, /dependencia_remitente_id = \?/);
    assert.doesNotMatch(enviados.base, /dependencia_destino_id = \?/);
    assert.deepEqual(enviados.valoresBase, [3, 3, 3]);
    const enviadosSedam = construirFiltros({ rol: 'funcionario', dependencia_id: 4 },
        opcionesConsulta({ pagina: '1', vista: 'generados' }), '2026-11-03');
    assert.deepEqual(enviadosSedam.valoresBase, [4, 4, 4]);
});

test('pagina mantiene contadores globales, limita detalles y calcula alertas en lotes', async () => {
    const hoy = obtenerFechaLocal(new Date(), 'hoy');
    const rows = Array.from({ length: 501 }, (_, i) => ({
        numero_radicado: `RAD-${String(501 - i).padStart(4, '0')}`,
        radicado_dependencia_id: null, estado: 'Recibido', requiere_respuesta: 1,
        termino_fecha_recepcion: hoy, termino_dias: 10, termino_tipo_dias: 'habiles',
        termino_fecha_limite_actual: agregarDias(hoy, 3), coincide_filtros: 1
    }));
    const consultas = [];
    let commits = 0;
    let liberadas = 0;
    const connection = {
        async query() {},
        async execute(sql, valores) {
            consultas.push({ sql, valores });
            if (sql.includes('AS coincide_filtros')) {
                assert.match(sql, /LIMIT 250 OFFSET \?/);
                const offset = valores.at(-1);
                return [rows.slice(offset, offset + 250)];
            }
            if (sql.includes('COALESCE(SUM')) return [[{ total: 1000, hoy: 600 }]];
            if (sql.includes('COUNT(*)')) return [[{ total: 700 }]];
            if (sql.includes('LIMIT ? OFFSET ?')) return [rows.slice(valores.at(-1), valores.at(-1) + valores.at(-2))];
            return [rows.slice(25, 50)];
        },
        async commit() { commits++; },
        release() { liberadas++; }
    };
    const fakePool = { async getConnection() { return connection; } };
    const usuario = { rol: 'ventanilla', dependencia_id: null };
    const resultado = await consultarPagina(fakePool, usuario, opcionesConsulta({ pagina: '2' }));
    assert.equal(resultado.radicados.length, 25);
    assert.equal(resultado.vista, 'recibidos');
    assert.equal(resultado.total, 700);
    assert.deepEqual(resultado.resumen, { total: 1000, hoy: 600, criticos: 501 });
    assert.equal(resultado.paginas, 28);
    assert.equal(resultado.has_more, true);
    const alertas = await consultarPagina(fakePool, usuario, opcionesConsulta({ pagina: '2' }), 3, true);
    assert.equal(alertas.total, 501);
    assert.equal(alertas.por_vencer, 501);
    assert.equal(alertas.alertas.length, 25);
    assert.equal(commits, 2);
    assert.equal(liberadas, 2);
    assert.ok(consultas.filter(c => c.sql.includes('AS coincide_filtros')).every(c => !c.sql.includes('r.*')));
});

test('consulta revierte y explicita fallos de lectura y rollback', async () => {
    let destruida = false;
    const connection = {
        async query() {},
        async execute() { throw new Error('lectura fallida'); },
        async rollback() { throw new Error('rollback fallido'); },
        destroy() { destruida = true; },
        release() { assert.fail('No liberar una conexion destruida.'); }
    };
    await assert.rejects(consultarPagina({ async getConnection() { return connection; } },
        { rol: 'administrador', dependencia_id: null }, opcionesConsulta({ pagina: '1' })), AggregateError);
    assert.equal(destruida, true);
});

test('HTTP paginado valida filtros y deriva la vista de origen de la sesion', async t => {
    let usuario = { id: 98761, nombre: 'Fixture consulta', rol: 'funcionario',
        dependencia_id: 3, dependencia_nombre: 'Oficina ficticia', activo: 1 };
    const token = crearSesion(usuario.id);
    t.after(() => revocarSesiones(usuario.id));
    t.mock.method(pool, 'execute', async () => [[usuario]]);
    const consultas = [];
    t.mock.method(pool, 'getConnection', async () => ({
        async query() {},
        async execute(sql, values) {
            consultas.push({ sql, values });
            if (sql.includes('COALESCE(SUM')) return [[{ total: 0, hoy: 0 }]];
            if (sql.includes('AS coincide_filtros')) return [[]];
            if (sql.includes('COUNT(*) AS total')) return [[{ total: 0 }]];
            if (sql.includes('LIMIT ? OFFSET ?')) return [[]];
            throw new Error(`Consulta inesperada: ${sql}`);
        },
        async commit() {},
        release() {}
    }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${token}` };
    for (const ruta of [
        '/api/radicados?pagina=0', '/api/radicados?pagina=1&limite=101',
        '/api/radicados?pagina=1&criticos=si', '/api/radicados?pagina=1&vista=otra',
        '/api/alertas?pagina=1',
        '/api/alertas?pagina=1&dependencia_id=3.5'
    ]) assert.equal((await fetch(url + ruta, { headers })).status, 400);
    assert.equal((await fetch(url + '/api/alertas?pagina=1&dependencia_id=4', { headers })).status, 403);
    const generados = await fetch(url + '/api/radicados?pagina=1&vista=generados', { headers });
    assert.equal(generados.status, 200);
    const resultadoGenerados = await generados.json();
    assert.equal(resultadoGenerados.vista, 'generados');
    assert.deepEqual(resultadoGenerados.radicados, []);
    assert.equal(consultas.length, 4);
    assert.ok(consultas.every(({ sql }) => /dependencia_remitente_id = \?/.test(sql)));
    assert.ok(consultas.every(({ sql }) => /tipo_comunicacion.*interna/.test(sql)));
    const adminToken = crearSesion(98762);
    t.after(() => revocarSesiones(98762));
    usuario = {
        id: 98762, nombre: 'Fixture admin', rol: 'administrador',
        dependencia_id: null, activo: 1
    };
    const respuestaAdmin = await fetch(url + '/api/radicados?pagina=1&vista=generados', {
        headers: { Authorization: 'Bearer ' + adminToken }
    });
    assert.equal(respuestaAdmin.status, 403);
});
