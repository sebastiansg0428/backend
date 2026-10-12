const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones, hashPassword, verificarPassword } = require('../auth');

test('gestion de usuarios crea, consulta, edita, inactiva y reactiva sin borrar el historial', async t => {
    const password = 'Password-de-prueba-123';
    const usuarios = new Map([
        [51, { id: 51, nombre: 'Admin', email: 'admin@example.test', rol: 'administrador', dependencia_id: null, activo: 1 }],
        [52, { id: 52, nombre: 'Ventanilla', email: 'ventanilla@example.test', rol: 'ventanilla', dependencia_id: null, activo: 1 }],
        [53, { id: 53, nombre: 'Funcionario', email: 'funcionario@example.test', rol: 'funcionario', dependencia_id: 2, activo: 1 }]
    ]);
    for (const usuario of usuarios.values()) usuario.password = await hashPassword(password);
    const tokens = new Map([...usuarios.keys()].map(id => [id, crearSesion(id)]));
    t.after(() => { for (const id of usuarios.keys()) revocarSesiones(id); });
    const respuestas = [{ numero_radicado: 'RAD-P', usuario_id: 53, contenido: 'Respuesta conservada' }];
    const copiaRespuestas = structuredClone(respuestas);
    const consultas = [];
    const publico = usuario => {
        const { password: hash, ...datos } = usuario;
        return datos;
    };
    const errorSQL = code => Object.assign(new Error(code), { code });
    const validarEscritura = (email, dependenciaId, id) => {
        if ([...usuarios.values()].some(u => u.email === email && u.id !== id)) {
            throw errorSQL('ER_DUP_ENTRY');
        }
        if (dependenciaId !== null && dependenciaId !== 2) {
            throw errorSQL('ER_NO_REFERENCED_ROW_2');
        }
    };
    t.mock.method(pool, 'query', async sql => {
        consultas.push({ sql });
        assert.equal(sql, 'SELECT id, nombre, email, rol, dependencia_id, activo FROM usuarios ORDER BY nombre');
        return [[...usuarios.values()].map(publico)];
    });
    t.mock.method(pool, 'execute', async (sql, valores = []) => {
        consultas.push({ sql, valores });
        if (sql.includes('FROM usuarios u')) {
            const usuario = sql.includes('WHERE u.email')
                ? [...usuarios.values()].find(u => u.email === valores[0])
                : usuarios.get(valores[0]);
            return [usuario ? [{
                ...(sql.includes('WHERE u.email') ? usuario : publico(usuario)),
                dependencia_nombre: usuario.dependencia_id === 2 ? 'Planeacion' : null
            }] : []];
        }
        if (sql.startsWith('SELECT id, nombre FROM usuarios')) {
            assert.match(sql, /rol = 'ventanilla' AND activo = 1/);
            return [[...usuarios.values()].filter(u => u.rol === 'ventanilla' && u.activo === 1)
                .map(({ id, nombre }) => ({ id, nombre }))];
        }
        if (sql.startsWith('SELECT id, nombre, email')) {
            assert.equal(sql, 'SELECT id, nombre, email, rol, dependencia_id, activo FROM usuarios WHERE id = ?');
            const usuario = usuarios.get(valores[0]);
            return [usuario ? [publico(usuario)] : []];
        }
        if (sql.startsWith('INSERT INTO usuarios')) {
            const [nombre, email, hash, rol, dependencia_id] = valores;
            validarEscritura(email, dependencia_id);
            const id = Math.max(...usuarios.keys()) + 1;
            usuarios.set(id, { id, nombre, email, password: hash, rol, dependencia_id, activo: 1 });
            return [{ insertId: id }];
        }
        if (sql.startsWith('UPDATE usuarios SET nombre')) {
            const [nombre, email, rol, dependencia_id, hash, id] = valores;
            const usuario = usuarios.get(id);
            if (!usuario) return [{ affectedRows: 0 }];
            validarEscritura(email, dependencia_id, id);
            assert.match(sql, /password = COALESCE\(\?, password\) WHERE id = \?/);
            Object.assign(usuario, { nombre, email, rol, dependencia_id, password: hash ?? usuario.password });
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE usuarios SET activo')) {
            assert.equal(sql, 'UPDATE usuarios SET activo = ? WHERE id = ?');
            const [activo, id] = valores;
            const usuario = usuarios.get(id);
            if (!usuario) return [{ affectedRows: 0 }];
            usuario.activo = activo;
            return [{ affectedRows: 1 }];
        }
        assert.fail(`Consulta inesperada: ${sql}`);
    });
    const errores = [];
    t.mock.method(console, 'error', (...args) => errores.push(args));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}/api`;
    const pedir = (ruta, id = 51, method = 'GET', body) => fetch(url + ruta, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(tokens.has(id) ? { Authorization: `Bearer ${tokens.get(id)}` } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const datos = {
        nombre: ' Nueva Persona ', email: ' NUEVA@EXAMPLE.TEST ',
        rol: 'funcionario', dependencia_id: 2, password
    };
    for (const id of [undefined, 52, 53]) {
        for (const [ruta, method, body] of [
            ['/usuarios', 'GET'],
            ['/usuarios/53', 'GET'],
            ['/usuarios', 'POST', datos],
            ['/usuarios/53', 'PUT', datos],
            ['/usuarios/53/estado', 'PATCH', { activo: 0 }]
        ]) {
            const respuesta = await pedir(ruta, id === undefined ? 0 : id, method, body);
            assert.equal(respuesta.status, id === undefined ? 401 : 403);
        }
    }
    const creada = await pedir('/usuarios', 51, 'POST', datos);
    assert.equal(creada.status, 201);
    const nuevo = (await creada.json()).usuario;
    assert.deepEqual(nuevo, {
        id: 54, nombre: 'Nueva Persona', email: 'nueva@example.test',
        rol: 'funcionario', dependencia_id: 2, activo: 1
    });
    assert.equal(await verificarPassword(password, usuarios.get(54).password), true);
    const lista = await pedir('/usuarios');
    assert.equal(lista.status, 200);
    const listado = (await lista.json()).usuarios;
    assert.equal(listado.length, 4);
    assert.equal(listado.some(u => 'password' in u), false);
    const detalle = await pedir('/usuarios/54');
    assert.equal(detalle.status, 200);
    assert.deepEqual((await detalle.json()).usuario, nuevo);
    const hashAnterior = usuarios.get(54).password;
    const editar = { nombre: 'Editada', email: 'editada@example.test', rol: 'ventanilla', dependencia_id: null };
    tokens.set(54, crearSesion(54));
    const editada = await pedir('/usuarios/54', 51, 'PUT', editar);
    assert.equal(editada.status, 200);
    assert.equal((await editada.json()).usuario.password, undefined);
    assert.equal(usuarios.get(54).password, hashAnterior);
    assert.equal((await pedir('/auth/me', 54)).status, 401);
    const passwordNueva = 'Password-nueva-456';
    assert.equal((await pedir('/usuarios/54', 51, 'PUT', { ...editar, password: passwordNueva })).status, 200);
    assert.equal(await verificarPassword(passwordNueva, usuarios.get(54).password), true);
    assert.equal(await verificarPassword(password, usuarios.get(54).password), false);

    const tokenAdicional = crearSesion(53);
    const inactiva = await pedir('/usuarios/53/estado', 51, 'PATCH', { activo: 0 });
    assert.equal(inactiva.status, 200);
    assert.deepEqual((await inactiva.json()).usuario, { id: 53, activo: 0 });
    assert.equal(usuarios.has(53), true);
    assert.deepEqual(respuestas, copiaRespuestas);
    assert.equal((await pedir('/auth/me', 53)).status, 401);
    assert.equal((await fetch(url + '/auth/me', {
        headers: { Authorization: `Bearer ${tokenAdicional}` }
    })).status, 401);
    const login = () => pedir('/auth/login', 0, 'POST', { email: usuarios.get(53).email, password });
    const bloqueada = await login();
    assert.equal(bloqueada.status, 403);
    assert.deepEqual(await bloqueada.json(), {
        success: false, message: 'La cuenta esta inactiva. Contacta al administrador.'
    });
    tokens.set(53, crearSesion(53));
    assert.equal((await pedir('/auth/me', 53)).status, 403);
    assert.equal((await pedir('/auth/me', 53)).status, 401);
    const detalleInactiva = await pedir('/usuarios/53');
    assert.equal((await detalleInactiva.json()).usuario.activo, 0);
    assert.equal((await pedir('/usuarios/53', 51, 'PUT', {
        nombre: 'Funcionario editado', email: 'funcionario@example.test',
        rol: 'funcionario', dependencia_id: 2, activo: 1
    })).status, 200);
    assert.equal(usuarios.get(53).activo, 0);
    assert.equal((await pedir('/usuarios/53/estado', 51, 'PATCH', { activo: 1 })).status, 200);
    const reactivada = await login();
    assert.equal(reactivada.status, 200);
    tokens.set(53, (await reactivada.json()).token);
    assert.equal((await pedir('/auth/me', 53)).status, 200);
    assert.deepEqual(respuestas, copiaRespuestas);

    assert.equal((await pedir('/usuarios/52/estado', 51, 'PATCH', { activo: 0 })).status, 200);
    const ventanilla = await pedir('/usuarios/ventanilla');
    assert.equal(ventanilla.status, 200);
    assert.deepEqual((await ventanilla.json()).usuarios.map(u => u.id), [54]);
    assert.equal((await pedir('/usuarios/52/estado', 51, 'PATCH', { activo: 1 })).status, 200);
    assert.equal((await pedir('/usuarios/51/estado', 51, 'PATCH', { activo: 0 })).status, 409);
    assert.equal((await pedir('/usuarios/51', 51, 'PUT', editar)).status, 409);
    assert.equal((await pedir('/auth/me')).status, 200);

    for (const id of ['0', '-1', 'abc', '1.5', '9007199254740992']) {
        assert.equal((await pedir(`/usuarios/${id}`)).status, 400);
        assert.equal((await pedir(`/usuarios/${id}`, 51, 'PUT', editar)).status, 400);
        assert.equal((await pedir(`/usuarios/${id}/estado`, 51, 'PATCH', { activo: 0 })).status, 400);
    }
    for (const activo of [null, true, '0', -1, 2, [], {}]) {
        assert.equal((await pedir('/usuarios/53/estado', 51, 'PATCH', { activo })).status, 400);
    }
    assert.equal((await pedir('/usuarios/53/estado', 51, 'PATCH', {})).status, 400);
    assert.equal((await pedir('/usuarios/53/estado', 51, 'PATCH')).status, 400);
    assert.equal((await pedir('/usuarios', 51, 'POST')).status, 400);
    assert.equal((await pedir('/usuarios/53', 51, 'PUT')).status, 400);
    for (const cambios of [
        { nombre: '' }, { email: 'invalido' }, { rol: 'inventado' },
        { dependencia_id: null }, { dependencia_id: true }, { dependencia_id: [2] },
        { password: 'corta' }
    ]) {
        assert.equal((await pedir('/usuarios', 51, 'POST', { ...datos, ...cambios })).status, 400);
        assert.equal((await pedir('/usuarios/53', 51, 'PUT', { ...datos, ...cambios })).status, 400);
    }
    assert.equal((await pedir('/usuarios', 51, 'POST', datos)).status, 201);
    assert.equal((await pedir('/usuarios', 51, 'POST', datos)).status, 409);
    assert.equal((await pedir('/usuarios/54', 51, 'PUT', { ...editar, email: 'admin@example.test' })).status, 409);
    assert.equal((await pedir('/usuarios', 51, 'POST', { ...datos, email: 'otra@example.test', dependencia_id: 999 })).status, 422);
    assert.equal((await pedir('/usuarios/53', 51, 'PUT', { ...datos, email: 'otra@example.test', dependencia_id: 999 })).status, 422);
    for (const [ruta, method, body] of [
        ['/usuarios/999', 'GET'],
        ['/usuarios/999', 'PUT', editar],
        ['/usuarios/999/estado', 'PATCH', { activo: 0 }]
    ]) {
        const respuesta = await pedir(ruta, 51, method, body);
        assert.equal(respuesta.status, 404);
        assert.deepEqual(await respuesta.json(), { success: false, message: 'Usuario no encontrado.' });
    }
    assert.equal(errores.length, 4);
    assert.equal(consultas.some(({ sql }) => sql.startsWith('DELETE')), false);
});
