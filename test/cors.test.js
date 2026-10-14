const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const crearMiddlewareCors = require('../cors');
const app = require('../server');

test('CORS valida configuracion y exige lista explicita en produccion', () => {
    for (const env of [
        { NODE_ENV: 'production' },
        { CORS_ALLOWED_ORIGINS: '' },
        { CORS_ALLOWED_ORIGINS: '*' },
        { CORS_ALLOWED_ORIGINS: 'null' },
        { CORS_ALLOWED_ORIGINS: 'https://example.test/' },
        { CORS_ALLOWED_ORIGINS: 'https://example.test/ruta' },
        { CORS_ALLOWED_ORIGINS: 'https://usuario:clave@example.test' },
        { CORS_ALLOWED_ORIGINS: 'file:///example' },
        { CORS_ALLOWED_ORIGINS: 'https://example.test,' }
    ]) assert.throws(() => crearMiddlewareCors(env), /CORS_ALLOWED_ORIGINS/);
    assert.doesNotThrow(() => crearMiddlewareCors({
        NODE_ENV: 'production', CORS_ALLOWED_ORIGINS: 'https://example.test, https://admin.example.test'
    }));
});

test('CORS local permite ambos frontends, rechaza otros origenes y conserva autenticacion', async t => {
    t.mock.method(console, 'warn', () => {});
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}/api/radicados`;
    for (const origen of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
        const preflight = await fetch(url, {
            method: 'OPTIONS', headers: {
                Origin: origen, 'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'authorization,content-type'
            }
        });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('access-control-allow-origin'), origen);
        assert.match(preflight.headers.get('vary'), /Origin/);
        assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/);
        assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
        const consulta = await fetch(url, { headers: { Origin: origen } });
        assert.equal(consulta.status, 401);
        assert.equal(consulta.headers.get('access-control-allow-origin'), origen);
        assert.equal(consulta.headers.get('access-control-expose-headers'), 'Retry-After');
    }
    for (const origen of [
        'https://ajeno.example', 'http://localhost:5174',
        'https://localhost:5173', 'http://localhost:5173.ajeno.example', 'null'
    ]) {
        for (const method of ['GET', 'OPTIONS']) {
            const respuesta = await fetch(url, { method, headers: { Origin: origen } });
            assert.equal(respuesta.status, 403);
            assert.equal(respuesta.headers.get('access-control-allow-origin'), null);
            assert.deepEqual(await respuesta.json(), { success: false, message: 'Origen no autorizado.' });
        }
    }
    const sinOrigen = await fetch(url);
    assert.equal(sinOrigen.status, 401);
    assert.equal(sinOrigen.headers.get('access-control-allow-origin'), null);
});

test('la lista de produccion sustituye los origenes de desarrollo', async t => {
    t.mock.method(console, 'warn', () => {});
    const produccion = express();
    produccion.use(crearMiddlewareCors({
        NODE_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://frontend.example, https://admin.example'
    }));
    produccion.get('/', (req, res) => res.json({ success: true }));
    const server = produccion.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const origen of ['https://frontend.example', 'https://admin.example']) {
        const respuesta = await fetch(url, { headers: { Origin: origen } });
        assert.equal(respuesta.status, 200);
        assert.equal(respuesta.headers.get('access-control-allow-origin'), origen);
    }
    assert.equal((await fetch(url, { headers: { Origin: 'http://localhost:5173' } })).status, 403);
    assert.equal((await fetch(url)).status, 200);
});
