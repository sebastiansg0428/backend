const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
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

test('password se almacena con bcrypt y no admite claves en texto plano', async () => {
    const hash = await hashPassword('Password-de-prueba-123');
    assert.match(hash, /^\$2b\$12\$/);
    assert.notEqual(hash, 'Password-de-prueba-123');
    assert.equal(await verificarPassword('Password-de-prueba-123', hash), true);
    assert.equal(await verificarPassword('Password-distinta-123', hash), false);
    assert.equal(await verificarPassword('Password-de-prueba-123', 'Password-de-prueba-123'), false);
});

test('login obtiene rol de MySQL, me lo confirma y logout invalida el token', async t => {
    t.mock.method(require('../limites-login'), 'reservarIntento', async () => ({ permitido: true, reintentarEn: 0 }));
    const usuario = {
        id: 31, nombre: 'Login de prueba', email: 'login@example.test',
        password: await hashPassword('Password-de-prueba-123'),
        rol: 'funcionario', dependencia_id: 2, dependencia_nombre: 'Planeacion', activo: 1
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
        [11, { id: 11, nombre: 'Admin', rol: 'administrador', dependencia_id: null, activo: 1 }],
        [12, { id: 12, nombre: 'Ventanilla', rol: 'ventanilla', dependencia_id: null, activo: 1 }],
        [13, { id: 13, nombre: 'Funcionario', rol: 'funcionario', dependencia_id: 2, dependencia_nombre: 'Planeacion', activo: 1 }],
        [14, { id: 14, nombre: 'Sin oficina', rol: 'funcionario', dependencia_id: null, activo: 1 }]
    ]);
    const tokens = new Map([...usuarios.keys()].map(id => [id, crearSesion(id)]));
    t.after(() => { for (const id of usuarios.keys()) revocarSesiones(id); });
    const registros = [
        { id: 1, numero_radicado: 'RAD-P', dependencia_destino_id: 2, dependencia_destino: 'Nombre historico' },
        { id: 2, numero_radicado: 'RAD-H', dependencia_destino_id: 3, dependencia_destino: 'Hacienda' },
        { id: 3, numero_radicado: 'RAD-S', dependencia_destino_id: null, dependencia_destino: 'Planeacion' }
    ].map(r => ({
        ...r, estado: 'Recibido', termino_fecha_recepcion: '2000-01-01',
        termino_dias: 1, termino_tipo_dias: 'calendario',
        termino_fecha_limite_actual: '2000-01-02'
    }));
    const contenidoPDF = '%PDF-1.4\nPrueba RBAC\n%%EOF';
    const prefijoArchivo = `rbac-${randomUUID()}`;
    for (const r of registros) {
        r.ruta_archivo = `${prefijoArchivo}-${r.numero_radicado}.pdf`;
        const archivo = path.join(__dirname, '..', 'uploads', r.ruta_archivo);
        await fs.writeFile(archivo, contenidoPDF);
        t.after(() => fs.unlink(archivo));
    }
    const consultas = [];
    let conexiones = 0;
    t.mock.method(pool, 'query', async (sql, values = []) => {
        consultas.push({ sql, values });
        assert.match(sql, /FROM radicados AS r/);
        const restringida = sql.includes('WHERE r.dependencia_destino_id = ?');
        let resultados = restringida
            ? registros.filter(r => r.dependencia_destino_id === values[0]) : registros;
        if (sql.includes('AND (? IS NULL OR r.dependencia_destino_id = ?)')) {
            const [id, idRepetido, nombre, nombreRepetido] = values.slice(restringida ? 1 : 0);
            assert.equal(id, idRepetido);
            assert.equal(nombre, nombreRepetido);
            resultados = resultados.filter(r =>
                (id === null || r.dependencia_destino_id === id) &&
                (nombre === null || r.dependencia_destino === nombre));
        }
        return [resultados];
    });
    t.mock.method(pool, 'execute', async (sql, values) => {
        if (sql.includes('FROM usuarios u')) return [[usuarios.get(values[0])].filter(Boolean)];
        if (sql.includes('SELECT r.id FROM radicados r')) {
            const esArchivo = sql.includes('r.ruta_archivo');
            if (esArchivo) assert.deepEqual(values.slice(0, 3), [values[0], values[0], values[0]]);
            const dependenciaId = values[esArchivo ? 3 : 1];
            const encontrados = registros.filter(r =>
                (esArchivo ? r.ruta_archivo === values[0] : r.numero_radicado === values[0]) &&
                (!sql.includes('r.dependencia_destino_id = ?') || r.dependencia_destino_id === dependenciaId));
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
        assert.equal((await respuesta.json()).total, 3);
        assert.match(consultas.at(-1).sql, /WHERE 1 = 1/);
    }
    for (const parametros of [
        '', '?dependencia_id=3&rol=administrador', '?dependencia_destino_id=3',
        '?dependencia=Hacienda', '?dependencia_id=2&dependencia_id=3'
    ]) {
        const propias = await pedir(`/api/radicados${parametros}`, 13);
        assert.equal(propias.status, 200);
        assert.deepEqual((await propias.json()).radicados.map(r => r.numero_radicado), ['RAD-P']);
        assert.deepEqual(consultas.at(-1).values, [2]);
    }
    assert.equal((await pedir('/api/radicados', 14)).status, 403);
    const consultasAntes = consultas.length;
    assert.equal((await pedir('/api/alertas?dependencia_id=3', 13)).status, 403);
    assert.equal((await pedir('/api/alertas?dependencia=Hacienda', 13)).status, 403);
    assert.equal((await pedir('/api/alertas?dependencia_id=2&dependencia_id=3', 13)).status, 400);
    assert.equal(consultas.length, consultasAntes);
    for (const parametros of ['', '?dependencia_id=2', '?dependencia=Planeacion']) {
        const propias = await pedir(`/api/alertas${parametros}`, 13);
        assert.equal(propias.status, 200);
        assert.deepEqual((await propias.json()).alertas.map(r => r.numero_radicado), ['RAD-P']);
        assert.deepEqual(consultas.at(-1).values, [2, null, null, null, null]);
    }
    for (const id of [11, 12]) {
        for (const [parametros, esperados] of [
            ['', ['RAD-P', 'RAD-H', 'RAD-S']],
            ['?dependencia_id=3', ['RAD-H']],
            ['?dependencia=Hacienda', ['RAD-H']]
        ]) {
            const respuesta = await pedir(`/api/alertas${parametros}`, id);
            assert.equal(respuesta.status, 200);
            assert.deepEqual((await respuesta.json()).alertas.map(r => r.numero_radicado), esperados);
            assert.match(consultas.at(-1).sql, /WHERE 1 = 1/);
        }
        const crear = await pedir('/api/radicados', id, { method: 'POST', body: '{}' });
        assert.equal(crear.status, 400);
        assert.equal((await crear.json()).message, 'Adjunta al menos un archivo PDF.');
    }
    assert.equal((await pedir('/api/radicados/RAD-H/historial', 13)).status, 404);
    assert.equal((await pedir('/api/radicados/RAD-P/historial', 13)).status, 200);
    for (const id of [11, 12]) {
        assert.equal((await pedir('/api/radicados/RAD-H/historial', id)).status, 200);
    }
    for (const method of ['GET', 'HEAD']) {
        for (const r of registros) {
            const ruta = `/uploads/${r.ruta_archivo}`;
            assert.equal((await pedir(ruta, undefined, { method })).status, 401);
            const propia = await pedir(ruta, 13, { method });
            assert.equal(propia.status, r.dependencia_destino_id === 2 ? 200 : 404);
            if (method === 'GET') {
                if (propia.status === 200) {
                    assert.equal(await propia.text(), contenidoPDF);
                } else {
                    assert.deepEqual(await propia.json(), {
                        success: false, message: 'Archivo no encontrado o fuera de tu dependencia.'
                    });
                }
            }
            for (const id of [11, 12]) {
                const respuesta = await pedir(ruta, id, { method });
                assert.equal(respuesta.status, 200);
                if (method === 'GET') assert.equal(await respuesta.text(), contenidoPDF);
            }
        }
    }
    assert.equal((await pedir('/api/usuarios', 13)).status, 403);
    assert.equal((await pedir('/api/terminos-legales', 13, {
        method: 'POST', body: '{}', headers: { 'x-admin-key': 'una-clave' }
    })).status, 403);
    assert.equal((await pedir('/api/radicados', 13, { method: 'POST', body: '{}' })).status, 403);
    assert.equal((await pedir('/api/radicados/RAD-P/estado', 12, {
        method: 'PUT', body: JSON.stringify({ estado: 'Respondido' })
    })).status, 403);
    assert.equal(conexiones, 0);
    const ajeno = await pedir('/api/radicados/RAD-H/estado?dependencia_id=3', 13, {
        method: 'PUT', body: JSON.stringify({ estado: 'Respondido', dependencia_id: 3 })
    });
    assert.equal(ajeno.status, 404);
    assert.deepEqual(await ajeno.json(), {
        success: false, message: 'Radicado no encontrado o fuera de tu dependencia.'
    });
    assert.equal(conexiones, 1);
    assert.equal((await pedir('/api/auth/logout', 13, { method: 'POST', body: '{}' })).status, 200);
    assert.equal((await pedir('/api/auth/me', 13)).status, 401);
});

test('funcionario sin dependencia valida recibe 403 sin consultar radicados ni iniciar escrituras', async t => {
    let usuario;
    t.after(() => revocarSesiones(41));
    t.mock.method(pool, 'execute', async sql => {
        assert.match(sql, /FROM usuarios u/);
        return [[usuario]];
    });
    t.mock.method(pool, 'query', async () => {
        assert.fail('No debe consultar datos de radicados con una dependencia invalida.');
    });
    t.mock.method(pool, 'getConnection', async () => {
        assert.fail('No debe iniciar escrituras con una dependencia invalida.');
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}`;
    const rutas = [
        ['/api/radicados?dependencia_id=3', 'GET'],
        ['/api/alertas?dependencia_id=3', 'GET'],
        ['/api/radicados/RAD-H/historial', 'GET'],
        ['/uploads/ajeno.pdf', 'GET'],
        ['/uploads/ajeno.pdf', 'HEAD'],
        ['/api/radicados/RAD-H/estado', 'PUT'],
        ['/api/radicados', 'POST']
    ];
    for (const [dependencia_id, dependencia_nombre] of [
        [undefined, 'Planeacion'], [null, 'Planeacion'], [0, 'Planeacion'],
        [-1, 'Planeacion'], [1.5, 'Planeacion'], ['2', 'Planeacion'],
        [2, null], [2, ''], [999, null]
    ]) {
        usuario = { id: 41, nombre: 'Invalido', rol: 'funcionario', dependencia_id, dependencia_nombre, activo: 1 };
        for (const [ruta, method] of rutas) {
            const token = crearSesion(usuario.id);
            const respuesta = await fetch(url + ruta, {
                method,
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                ...(method === 'PUT' || method === 'POST'
                    ? { body: JSON.stringify({ estado: 'Respondido' }) } : {})
            });
            assert.equal(respuesta.status, 403, `${method} ${ruta}, dependencia ${dependencia_id}`);
            if (method !== 'HEAD') {
                assert.deepEqual(await respuesta.json(), {
                    success: false, message: 'El usuario no tiene una asignacion de rol y dependencia valida.'
                });
            } else {
                assert.equal(await respuesta.text(), '');
            }
        }
    }
});
