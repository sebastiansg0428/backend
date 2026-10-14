const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { scrypt: scryptCallback, randomBytes } = require('node:crypto');
const { promisify } = require('node:util');
const pool = require('../db');
const app = require('../server');
const { hashPassword, verificarPassword, passwordValido, revocarSesiones } = require('../auth');

async function hashAnterior(password) {
    const sal = randomBytes(16).toString('hex');
    const hash = await promisify(scryptCallback)(password, sal, 64);
    return `scrypt:${sal}:${hash.toString('hex')}`;
}

test('politica de complejidad y limites UTF-8 sin truncamiento', async () => {
    for (const password of [
        undefined, '', 'Aa1!corta', 'abcdefghij1!', 'ABCDEFGHIJ1!',
        'Abcdefghij!!', 'Abcdefghij12', 'Abcdefghij12 ',
        'Abcdefghij1!\0', `Aa1!${'x'.repeat(69)}`, `Aa1!${'é'.repeat(35)}`
    ]) {
        assert.equal(passwordValido(password), false);
        await assert.rejects(hashPassword(password), /Minimo 10/);
    }
    assert.equal(passwordValido('Árbol-largo-123'), true);
    const maxima = `Aa1!${'é'.repeat(34)}`;
    assert.equal(Buffer.byteLength(maxima), 72);
    assert.equal(passwordValido(maxima), true);
    const hash = await hashPassword(maxima);
    assert.match(hash, /^\$2b\$12\$/);
    assert.equal(await verificarPassword(maxima, hash), true);
    assert.equal(await verificarPassword(`${maxima}x`, hash), false);
    assert.equal(await verificarPassword('distinta', hash), false);
    assert.equal(await verificarPassword(maxima, maxima), false);
    const legacy = 'a'.repeat(80);
    assert.equal(await verificarPassword(legacy, await hashAnterior(legacy)), true);
});

test('login migra scrypt a bcrypt, conserva claves antiguas largas y evita carreras', async t => {
    t.mock.method(require('../limites-login'), 'reservarIntento', async () => ({ permitido: true, reintentarEn: 0 }));
    const usuario = {
        id: 101, nombre: 'Usuario prueba', email: 'legacy@example.test',
        rol: 'administrador', dependencia_id: null, activo: 1
    };
    let password = 'claveantigua';
    let guardado = await hashAnterior(password);
    let actualizaciones = 0;
    let carrera = false;
    t.after(() => revocarSesiones(usuario.id));
    t.mock.method(pool, 'execute', async (sql, valores) => {
        if (sql.includes('WHERE u.email')) return [[{ ...usuario, password: guardado }]];
        if (sql.startsWith('UPDATE usuarios SET password')) {
            actualizaciones++;
            assert.match(sql, /WHERE id = \? AND password = \? AND activo = 1/);
            assert.equal(valores[1], usuario.id);
            assert.equal(valores[2], guardado);
            if (carrera) return [{ affectedRows: 0 }];
            guardado = valores[0];
            return [{ affectedRows: 1 }];
        }
        throw new Error(`Consulta inesperada: ${sql}`);
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())));
    const login = clave => fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: usuario.email, password: clave })
    });
    assert.equal((await login('incorrecta')).status, 401);
    assert.equal(actualizaciones, 0);
    const respuesta = await login(password);
    assert.equal(respuesta.status, 200);
    assert.equal((await respuesta.json()).usuario.password, undefined);
    assert.match(guardado, /^\$2b\$12\$/);
    assert.equal(await verificarPassword(password, guardado), true);
    assert.equal((await login(password)).status, 200);
    assert.equal(actualizaciones, 1);
    password = 'a'.repeat(80);
    guardado = await hashAnterior(password);
    assert.equal((await login(password)).status, 200);
    assert.match(guardado, /^scrypt:/);
    assert.equal(actualizaciones, 1);
    password = 'claveantigua';
    guardado = await hashAnterior(password);
    usuario.activo = 0;
    assert.equal((await login(password)).status, 403);
    assert.equal(actualizaciones, 1);
    usuario.activo = 1;
    carrera = true;
    const conflicto = await login(password);
    assert.equal(conflicto.status, 409);
    assert.equal((await conflicto.json()).token, undefined);
});
