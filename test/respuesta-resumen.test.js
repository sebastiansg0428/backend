const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');

test('resumen identifica respuesta real y destino sin exponer contenido ni ampliar permisos', async t => {
    const usuarios = [
        { id: 81, rol: 'administrador', nombre: 'Admin', dependencia_id: null, activo: 1 },
        { id: 82, rol: 'ventanilla', nombre: 'Ventanilla', dependencia_id: null, activo: 1 },
        { id: 83, rol: 'funcionario', nombre: 'Funcionario', dependencia_id: 3,
            dependencia_nombre: 'Talento Humano', activo: 1 }
    ];
    const tokens = new Map(usuarios.map(u => [u.id, crearSesion(u.id)]));
    t.after(() => usuarios.forEach(u => revocarSesiones(u.id)));
    const consultas = [];
    let fallo = false;
    let asignacionFuncionario = 301;
    const respondidas = new Set([301]);
    const radicados = {
        IND: { destino_todas_dependencias: 0, dependencia_destino: 'Talento Humano' },
        VACIO: { destino_todas_dependencias: 0, dependencia_destino: 'Talento Humano', estado: 'Respondido' },
        GLOBAL: { destino_todas_dependencias: 1, dependencia_destino: 'Todas las dependencias' },
        AJENO: { destino_todas_dependencias: 0, dependencia_destino: 'Otra oficina', dependencia_id: 2 }
    };
    t.mock.method(pool, 'execute', async (sql, valores) => {
        consultas.push({ sql, valores });
        if (sql.includes('FROM usuarios u')) return [[usuarios.find(u => u.id === valores[0])].filter(Boolean)];
        if (sql.includes('SELECT r.id FROM radicados r')) {
            const radicado = radicados[valores[0]];
            return [radicado && !(valores.length > 1 && radicado.dependencia_id === 2) ? [{ id: 1 }] : []];
        }
        if (sql.includes('SELECT destino_todas_dependencias')) return [[radicados[valores[0]]]];
        if (sql.includes('FROM radicado_dependencias rd')) {
            assert.equal(valores[0], 'GLOBAL');
            const id = sql.includes('rd.dependencia_id = ?') ? asignacionFuncionario : valores[1];
            return [id === 301 ? [{ id: 301, nombre: 'Talento Humano' }]
                : id === 302 ? [{ id: 302, nombre: 'Planeacion' }] : []];
        }
        if (sql.includes('FROM respuestas_radicado rr')) {
            if (fallo) throw new Error('Fallo de consulta simulado');
            assert.deepEqual(valores.slice(1), [valores[1], valores[1], valores[1]]);
            assert.match(sql, /rr\.radicado_dependencia_id IS NULL/);
            assert.doesNotMatch(sql, /u\.activo|u\.dependencia_id/);
            if (valores[0] === 'VACIO' || (valores[1] && !respondidas.has(valores[1]))) return [[]];
            return [[{
                id: 10, funcionario_nombre: 'Autor administrador o inactivo',
                fecha_envio: '2026-10-21 11:30:00',
                contenido: 'No exponer en resumen', plantilla: null
            }]];
        }
        if (sql.includes('FROM documentos_respuesta')) return [[]];
        throw new Error(`Consulta inesperada: ${sql}`);
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}/api/radicados/`;
    const pedir = (radicado, id = 81, query = '', completo = false) => fetch(
        `${url}${radicado}/respuesta${completo ? '' : '/resumen'}${query}`,
        { headers: id ? { Authorization: `Bearer ${tokens.get(id)}` } : {} }
    );
    for (const id of [81, 82, 83]) {
        const respuesta = await pedir('IND', id);
        assert.equal(respuesta.status, 200);
        assert.deepEqual(await respuesta.json(), { success: true, respuesta: {
            funcionario_nombre: 'Autor administrador o inactivo',
            dependencia_responsable: 'Talento Humano',
            fecha_envio: '2026-10-21 11:30:00'
        } });
    }
    assert.equal(consultas.some(({ sql }) => sql.includes('FROM documentos_respuesta')), false);
    const resumenSql = consultas.filter(({ sql }) => sql.includes('FROM respuestas_radicado rr'));
    assert.ok(resumenSql.every(({ sql }) => !/rr\.contenido|rr\.plantilla|ruta_archivo/.test(sql)));
    const vacio = await pedir('VACIO');
    assert.deepEqual(await vacio.json(), { success: true, respuesta: null });
    assert.equal((await pedir('IND', null)).status, 401);
    assert.equal((await pedir('AJENO', 83)).status, 404);
    for (const id of [81, 82]) {
        assert.equal((await pedir('GLOBAL', id)).status, 400);
        const global = await pedir('GLOBAL', id, '?radicado_dependencia_id=301');
        assert.equal(global.status, 200);
        assert.equal((await global.json()).respuesta.dependencia_responsable, 'Talento Humano');
        const sinRespuesta = await pedir('GLOBAL', id, '?radicado_dependencia_id=302');
        assert.equal((await sinRespuesta.json()).respuesta, null);
        assert.equal((await pedir('GLOBAL', id, '?radicado_dependencia_id=999')).status, 404);
    }
    for (const query of ['?radicado_dependencia_id=0', '?radicado_dependencia_id=1.2',
        '?radicado_dependencia_id=x', '?radicado_dependencia_id=9007199254740992',
        '?radicado_dependencia_id=301&radicado_dependencia_id=302']) {
        assert.equal((await pedir('GLOBAL', 81, query)).status, 400);
    }
    assert.equal((await pedir('IND', 81, '?radicado_dependencia_id=301')).status, 400);
    assert.equal((await pedir('GLOBAL', 83)).status, 200);
    assert.equal((await pedir('GLOBAL', 83, '?radicado_dependencia_id=301')).status, 200);
    assert.equal((await pedir('GLOBAL', 83, '?radicado_dependencia_id=302')).status, 404);
    asignacionFuncionario = null;
    assert.equal((await pedir('GLOBAL', 83)).status, 404);
    asignacionFuncionario = 301;
    respondidas.add(302);
    const otraDependencia = await pedir('GLOBAL', 81, '?radicado_dependencia_id=302');
    assert.equal((await otraDependencia.json()).respuesta.dependencia_responsable, 'Planeacion');
    respondidas.delete(302);
    assert.equal((await pedir('VACIO', 81, '', true)).status, 404);
    const completa = await pedir('IND', 82, '', true);
    assert.equal(completa.status, 200);
    const datosCompletos = (await completa.json()).respuesta;
    assert.equal(datosCompletos.contenido, 'No exponer en resumen');
    assert.equal(datosCompletos.dependencia_responsable, 'Talento Humano');
    assert.equal(datosCompletos.funcionario_nombre, 'Autor administrador o inactivo');
    assert.equal(datosCompletos.fecha_envio, '2026-10-21 11:30:00');
    assert.deepEqual(datosCompletos.documentos, []);
    const completaGlobal = await pedir('GLOBAL', 81, '?radicado_dependencia_id=301', true);
    assert.equal(completaGlobal.status, 200);
    assert.equal((await completaGlobal.json()).respuesta.dependencia_responsable, 'Talento Humano');
    respondidas.add(302);
    const otraGlobal = await pedir('GLOBAL', 82, '?radicado_dependencia_id=302', true);
    assert.equal((await otraGlobal.json()).respuesta.dependencia_responsable, 'Planeacion');
    assert.equal((await pedir('GLOBAL', 83, '?radicado_dependencia_id=302', true)).status, 404);
    fallo = true;
    assert.equal((await pedir('IND')).status, 500);
});
