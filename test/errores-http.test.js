const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const { Writable } = require('node:stream');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');

test('clasifica errores de cuerpo y carga sin exponer rutas ni contenido', async t => {
    const usuario = { id: 956, nombre: 'Prueba errores', activo: 1, rol: 'administrador', dependencia_id: null };
    const token = crearSesion(usuario.id);
    t.after(() => revocarSesiones(usuario.id));
    t.mock.method(pool, 'execute', async sql => {
        assert.match(sql, /FROM usuarios u/);
        return [[usuario]];
    });
    const logs = [];
    t.mock.method(console, 'error', (...args) => logs.push(args));
    t.mock.method(console, 'warn', (...args) => logs.push(args));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const [body, status] of [['{', 400], [JSON.stringify({ dato: 'x'.repeat(110 * 1024) }), 413]]) {
        const respuesta = await fetch(url + '/api/auth/login', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body
        });
        assert.equal(respuesta.status, status);
        const resultado = await respuesta.json();
        assert.equal(resultado.success, false);
        assert.doesNotMatch(resultado.message, /SyntaxError|node_modules|position|dato/);
    }
    for (const headers of [
        { 'Content-Type': 'application/json', 'Content-Encoding': 'unsupported' },
        { 'Content-Type': 'application/json; charset=iso-8859-1' }
    ]) {
        const respuesta = await fetch(url + '/api/auth/login', {
            method: 'POST', headers, body: '{}'
        });
        assert.equal(respuesta.status, 415);
        assert.equal((await respuesta.json()).success, false);
    }
    for (const ruta of ['/api/radicados', '/api/radicados/PRUEBA/respuesta']) {
        const incompleto = await fetch(url + ruta, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'multipart/form-data' },
            body: 'sin delimitador'
        });
        assert.equal(incompleto.status, 400);
        assert.equal((await incompleto.json()).success, false);
        const subir = async (nombre, tipo) => {
            const body = new FormData();
            body.append('archivos', new Blob(['%PDF-1.4\n%%EOF'], { type: tipo }), nombre);
            body.append('contenido', 'Contenido de respuesta de prueba');
            return fetch(url + ruta, { method: 'POST', body, headers: { Authorization: `Bearer ${token}` } });
        };
        const invalido = await subir('archivo.txt', 'text/plain');
        assert.equal(invalido.status, 400);
        assert.equal((await invalido.json()).message, 'Cada documento adjunto debe ser un PDF.');
        const grande = new FormData();
        grande.append('archivos', new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], {
            type: 'application/pdf'
        }), 'excedido.pdf');
        const excedido = await fetch(url + ruta, {
            method: 'POST', body: grande, headers: { Authorization: `Bearer ${token}` }
        });
        assert.equal(excedido.status, 400);
        assert.equal((await excedido.json()).message, 'Cada PDF debe pesar máximo 10 MB.');
        await t.test(`fallo de almacenamiento ${ruta}`, async caso => {
            const errorDisco = Object.assign(new Error('EACCES C:\\ruta-privada\\archivo.pdf'), { code: 'EACCES' });
            caso.mock.method(fs, 'createWriteStream', () => new Writable({
                write(chunk, encoding, callback) { callback(errorDisco); }
            }));
            const respuesta = await subir('archivo.pdf', 'application/pdf');
            assert.equal(respuesta.status, 500);
            assert.deepEqual(await respuesta.json(), {
                success: false, message: 'No se pudieron almacenar los archivos adjuntos. Intenta nuevamente.'
            });
            assert.ok(logs.some(args => args.includes(errorDisco)));
        });
    }
});
