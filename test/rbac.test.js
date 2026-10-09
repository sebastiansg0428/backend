const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const pool = require('../db');
const app = require('../server');
const {
    crearSesion, revocarSesiones, hashPassword, verificarPassword, filtroDependencia, datosUsuario
} = require('../auth');

test('valida usuarios y nunca convierte una dependencia faltante en acceso global', () => {
    const base = { nombre: 'Prueba', email: 'prueba@example.test' };
    assert.equal(datosUsuario({ ...base, rol: 'funcionario' }), null);
    assert.equal(datosUsuario({ ...base, rol: 'administrador', dependencia_id: 1 }), null);
    assert.equal(datosUsuario({ ...base, rol: 'inventado', dependencia_id: null }), null);
    assert.throws(() => filtroDependencia({ rol: 'funcionario', dependencia_id: null }));
    assert.deepEqual(filtroDependencia({ rol: 'funcionario', dependencia_id: 2 }), {
        sql: 'r.dependencia_destino_id = ?', valores: [2]
    });
});

test('password se almacena con scrypt y no admite claves en texto plano', async () => {
    const hash = await hashPassword('Password-de-prueba-123');
    assert.notEqual(hash, 'Password-de-prueba-123');
    assert.equal(await verificarPassword('Password-de-prueba-123', hash), true);
    assert.equal(await verificarPassword('Password-distinta-123', hash), false);
    assert.equal(await verificarPassword('Password-de-prueba-123', 'Password-de-prueba-123'), false);
});

test('login obtiene rol de MySQL, me lo confirma y logout invalida el token', async t => {
    const usuario = {
        id: 31, nombre: 'Login de prueba', email: 'login@example.test',
        password: await hashPassword('Password-de-prueba-123'),
        rol: 'funcionario', dependencia_id: 2, dependencia_nombre: 'Planeacion'
    };
    t.after(() => revocarSesiones(usuario.id));
    t.mock.method(pool, 'execute', async (sql, values) => {
        if (sql.includes('WHERE u.email')) {
            return [values[0] === usuario.email ? [usuario] : []];
        }
        if (sql.includes('WHERE u.id')) return [[usuario]];
        throw new Error(`Consulta inesperada: ${sql}`);
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}/api/auth`;
    const login = async password => fetch(`${url}/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            email: usuario.email, password, rol: 'administrador', dependencia_id: 999
        })
    });
    assert.equal((await login('incorrecta')).status, 401);
    const respuesta = await login('Password-de-prueba-123');
    assert.equal(respuesta.status, 200);
    const resultado = await respuesta.json();
    assert.match(resultado.token, /^[a-f0-9]{64}$/);
    assert.equal(resultado.usuario.password, undefined);
    assert.equal(resultado.usuario.rol, 'funcionario');
    assert.equal(resultado.usuario.dependencia_id, 2);
    const headers = { Authorization: `Bearer ${resultado.token}` };
    assert.equal((await fetch(`${url}/me`, { headers })).status, 200);
    assert.equal((await fetch(`${url}/logout`, { method: 'POST', headers })).status, 200);
    assert.equal((await fetch(`${url}/me`, { headers })).status, 401);
});

test('RBAC HTTP aplica permisos en listas, alertas, archivos, historial y escrituras', async t => {
    const usuarios = new Map([
        [11, { id: 11, nombre: 'Admin', rol: 'administrador', dependencia_id: null }],
        [12, { id: 12, nombre: 'Ventanilla', rol: 'ventanilla', dependencia_id: null }],
        [13, { id: 13, nombre: 'Funcionario', rol: 'funcionario', dependencia_id: 2, dependencia_nombre: 'Planeacion' }],
        [14, { id: 14, nombre: 'Sin oficina', rol: 'funcionario', dependencia_id: null }]
    ]);
    const tokens = new Map([...usuarios.keys()].map(id => [id, crearSesion(id)]));
    t.after(() => { for (const id of usuarios.keys()) revocarSesiones(id); });
    const registros = [
        { id: 1, numero_radicado: 'RAD-P', dependencia_destino_id: 2, estado: 'Respondido' },
        { id: 2, numero_radicado: 'RAD-H', dependencia_destino_id: 3, estado: 'Respondido' }
    ];
    const consultas = [];
    let conexiones = 0;
    t.mock.method(pool, 'query', async (sql, values = []) => {
        consultas.push({ sql, values });
        assert.match(sql, /FROM radicados AS r/);
        return [sql.includes('r.dependencia_destino_id = ?')
            ? registros.filter(r => r.dependencia_destino_id === values[0]) : registros];
    });
    t.mock.method(pool, 'execute', async (sql, values) => {
        if (sql.includes('FROM usuarios u')) return [[usuarios.get(values[0])].filter(Boolean)];
        if (sql.includes('SELECT r.id FROM radicados r')) {
            const esArchivo = sql.includes('r.ruta_archivo');
            const numero = esArchivo ? 'RAD-H' : values[0];
            const encontrados = registros.filter(r => r.numero_radicado === numero &&
                (!sql.includes('r.dependencia_destino_id = ?') || r.dependencia_destino_id === values[1]));
            return [encontrados];
        }
        if (sql.includes('FROM historial_radicado')) return [[{ campo_modificado: 'estado' }]];
        if (sql.includes('FROM dependencias')) return [[{ id: 2, nombre: 'Planeacion' }]];
        throw new Error(`Consulta inesperada: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => {
        conexiones++;
        return {
            async beginTransaction() {},
            async rollback() {},
            release() {},
            async execute(sql, values) {
                assert.match(sql, /radicados\.dependencia_destino_id = \?/);
                assert.deepEqual(values, ['RAD-H', 2]);
                return [[]];
            }
        };
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}`;
    const pedir = (path, id, options = {}) => fetch(url + path, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(id ? { Authorization: `Bearer ${tokens.get(id)}` } : {}),
            ...options.headers
        }
    });

    assert.equal((await pedir('/api/radicados')).status, 401);
    assert.equal((await pedir('/api/radicados', null, {
        headers: { 'x-rol': 'administrador', 'x-dependencia-id': '2' }
    })).status, 401);
    for (const id of [11, 12]) {
        const respuesta = await pedir('/api/radicados', id);
        assert.equal(respuesta.status, 200);
        assert.equal((await respuesta.json()).total, 2);
        assert.match(consultas.at(-1).sql, /WHERE 1 = 1/);
    }
    const propias = await pedir('/api/radicados?dependencia_id=3&rol=administrador', 13);
    assert.equal(propias.status, 200);
    assert.deepEqual((await propias.json()).radicados.map(r => r.numero_radicado), ['RAD-P']);
    assert.deepEqual(consultas.at(-1).values, [2]);
    assert.equal((await pedir('/api/radicados', 14)).status, 403);
    assert.equal((await pedir('/api/alertas?dependencia_id=3', 13)).status, 403);
    assert.equal((await pedir('/api/alertas?dependencia=Hacienda', 13)).status, 403);
    assert.equal((await pedir('/api/alertas?dependencia_id=2', 13)).status, 200);
    assert.equal((await pedir('/api/radicados/RAD-H/historial', 13)).status, 404);
    assert.equal((await pedir('/api/radicados/RAD-P/historial', 13)).status, 200);
    assert.equal((await pedir('/api/radicados/RAD-H/historial', 11)).status, 200);
    assert.equal((await pedir('/uploads/ajeno.pdf', 13)).status, 404);
    assert.equal((await pedir('/uploads/ajeno.pdf')).status, 401);
    assert.equal((await pedir('/api/usuarios', 13)).status, 403);
    assert.equal((await pedir('/api/terminos-legales', 13, {
        method: 'POST', body: '{}', headers: { 'x-admin-key': 'una-clave' }
    })).status, 403);
    assert.equal((await pedir('/api/radicados', 13, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await pedir('/api/radicados/RAD-P/estado', 12, {
        method: 'PUT', body: JSON.stringify({ estado: 'Respondido' })
    })).status, 403);
    assert.equal(conexiones, 0);
    assert.equal((await pedir('/api/radicados/RAD-H/estado', 13, {
        method: 'PUT', body: JSON.stringify({ estado: 'Respondido' })
    })).status, 404);
    assert.equal(conexiones, 1);
    assert.equal((await pedir('/api/auth/logout', 13, { method: 'POST', body: '{}' })).status, 200);
    assert.equal((await pedir('/api/auth/me', 13)).status, 401);
});
