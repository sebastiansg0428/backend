const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { resumenTraslados } = require('../traslados');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');

for (const cantidad of [0, 1, 2, 3, 35]) {
    test(`resumen cuenta ${cantidad} aprobaciones completas sin limitar nuevos traslados`, async () => {
        let consultas = 0;
        const resumen = await resumenTraslados({
            async execute(sql, valores) {
                consultas++;
                if (sql.includes("estado = 'aprobada'")) {
                    assert.deepEqual(valores, ['RAD-PRUEBA']);
                    assert.doesNotMatch(sql, /LIMIT|OFFSET/);
                    return [Array.from({ length: cantidad }, () => ({ origen_id: 3, destino_aprobado_id: 4 }))];
                }
                assert.match(sql, /event_type IN \('radicado_asignado', 'radicado_creado'\)/);
                assert.match(sql, /ORDER BY id LIMIT 1/);
                assert.deepEqual(valores, ['RAD-PRUEBA', 'RAD-PRUEBA', 'RAD-PRUEBA']);
                return [[{ dependencia_id: 3 }, { dependencia_id: 9 }, { dependencia_id: null }]];
            }
        }, 'RAD-PRUEBA');
        assert.deepEqual(resumen, {
            total_aprobados: cantidad, umbral_reiteracion: 3,
            dependencias_visitadas_ids: cantidad ? [3, 4, 9] : [3, 9],
        });
        assert.equal(consultas, 2);
    });
}

test('resumen no incluye destinos sugeridos ni inventa oficinas sin evidencia', async () => {
    const resumen = await resumenTraslados({
        async execute(sql) {
            assert.doesNotMatch(sql, /destino_sugerido|dependencia_origen|nombre/);
            return [[]];
        }
    }, 'RAD-ANTIGUO');
    assert.deepEqual(resumen, { total_aprobados: 0, umbral_reiteracion: 3, dependencias_visitadas_ids: [] });
    const fallo = new Error('Consulta fallida');
    await assert.rejects(resumenTraslados({ execute: async () => { throw fallo; } }, 'RAD-PRUEBA'), e => e === fallo);
});

test('API resumen exige acceso actual, no amplia comprobantes historicos ni expone actores', async t => {
    const usuarios = [
        { id: 9121, nombre: 'Fixture', rol: 'funcionario', dependencia_id: 3, dependencia_nombre: 'Origen fixture', activo: 1 },
        { id: 9122, nombre: 'Fixture', rol: 'administrador', dependencia_id: null, activo: 1 },
        { id: 9123, nombre: 'Fixture', rol: 'ventanilla', dependencia_id: null, activo: 1 },
    ];
    const tokens = usuarios.map(u => crearSesion(u.id));
    t.after(() => usuarios.forEach(u => revocarSesiones(u.id)));
    let acceso = true;
    let fallo = false;
    let lecturas = 0;
    const logs = [];
    t.mock.method(console, 'error', (...args) => logs.push(args));
    t.mock.method(pool, 'execute', async (sql, valores) => {
        if (sql.includes('FROM usuarios u')) return [[usuarios.find(u => u.id === valores[0])]];
        assert.match(sql, /SELECT r.id FROM radicados r/);
        return [acceso ? [{ id: 1 }] : []];
    });
    t.mock.method(pool, 'getConnection', async () => ({
        async query() {}, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
        async execute(sql) {
            lecturas++;
            if (fallo) throw new Error('Resumen no disponible');
            if (sql.includes("estado = 'aprobada'")) return [[{ origen_id: 3, destino_aprobado_id: 4 }]];
            return [[{ dependencia_id: 3 }]];
        }
    }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api/radicados/RAD-PRUEBA/traslados/resumen`;
    assert.equal((await fetch(url)).status, 401);
    for (const token of tokens) {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { success: true, resumen: {
            total_aprobados: 1, umbral_reiteracion: 3, dependencias_visitadas_ids: [3, 4],
        } });
    }
    const headers = { Authorization: `Bearer ${tokens[0]}` };
    acceso = false;
    const anteriores = lecturas;
    assert.equal((await fetch(url, { headers })).status, 404);
    assert.equal(lecturas, anteriores);
    acceso = true; fallo = true;
    assert.equal((await fetch(url, { headers })).status, 500);
    assert.ok(logs.length);
});
