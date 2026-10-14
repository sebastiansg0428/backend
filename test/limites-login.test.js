const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const pool = require('../db');
const limites = require('../limites-login');
const app = require('../server');

test('normaliza cuenta e IPv4 mapeada y no guarda emails ni IPs en las claves', () => {
    assert.deepEqual(limites.clavesLogin(' ÁNA@example.test ', '::ffff:192.0.2.1'),
        limites.clavesLogin('ana@example.test', '192.0.2.1'));
    assert.deepEqual(limites.clavesLogin('ana@example.test', '::ffff:c000:201'),
        limites.clavesLogin('ana@example.test', '192.0.2.1'));
    assert.deepEqual(limites.clavesLogin('ana@example.test', '2001:db8::1'),
        limites.clavesLogin('ana@example.test', '2001:0db8:0:0:0:0:0:1'));
    for (const clave of limites.clavesLogin('ana@example.test', '192.0.2.1')) {
        assert.match(clave.clave, /^[a-f0-9]{64}$/);
    }
    assert.throws(() => limites.clavesLogin('ana@example.test', 'inventada'));
});

test('reserva ambos contadores, aplica los limites exactos y reinicia ventanas vencidas', async t => {
    for (const caso of [
        { cuenta: 9, ip: 99, expira: 1900, permitido: true, siguienteCuenta: 10, siguienteIp: 100 },
        { cuenta: 10, ip: 1, expira: 1900, permitido: false },
        { cuenta: 1, ip: 100, expira: 1900, permitido: false },
        { cuenta: 10, ip: 100, expira: 1000, permitido: true, siguienteCuenta: 1, siguienteIp: 1 }
    ]) {
        await t.test(JSON.stringify(caso), async t => {
            const escrituras = [];
            let commits = 0;
            let rollbacks = 0;
            let liberaciones = 0;
            t.mock.method(pool, 'getConnection', async () => ({
                async beginTransaction() {},
                async commit() { commits++; },
                async rollback() { rollbacks++; },
                release() { liberaciones++; },
                async execute(sql, valores) {
                    if (sql.includes('SELECT ambito')) {
                        return [[
                            { ambito: 'cuenta', cantidad: caso.cuenta, expira: caso.expira, ahora: 1000 },
                            { ambito: 'ip', cantidad: caso.ip, expira: caso.expira, ahora: 1000 }
                        ]];
                    }
                    escrituras.push({ sql, valores });
                    return [{ affectedRows: 1 }];
                }
            }));
            const resultado = await limites.reservarIntento('ana@example.test', '192.0.2.1');
            assert.deepEqual(resultado, { permitido: caso.permitido, reintentarEn: caso.permitido ? 0 : 900 });
            const updates = escrituras.filter(e => e.sql.startsWith('UPDATE'));
            assert.equal(updates.length, caso.permitido ? 2 : 0);
            if (caso.permitido) {
                assert.equal(updates[0].valores[0], caso.siguienteCuenta);
                assert.equal(updates[1].valores[0], caso.siguienteIp);
                assert.equal(updates[0].valores[1], 1900);
            }
            assert.equal(commits, caso.permitido ? 1 : 0);
            assert.equal(rollbacks, caso.permitido ? 0 : 1);
            assert.equal(liberaciones, 1);
        });
    }
});

test('un fallo SQL revierte la reserva y libera la conexion', async t => {
    let rollback = false;
    let liberada = false;
    t.mock.method(pool, 'getConnection', async () => ({
        async beginTransaction() {},
        async execute() { throw new Error('MySQL no disponible'); },
        async rollback() { rollback = true; },
        release() { liberada = true; }
    }));
    await assert.rejects(limites.reservarIntento('ana@example.test', '192.0.2.1'), /MySQL no disponible/);
    assert.equal(rollback, true);
    assert.equal(liberada, true);
});

test('HTTP devuelve 429 y Retry-After o 503 sin consultar credenciales', async t => {
    let fallo = false;
    t.mock.method(limites, 'reservarIntento', async (email, ip) => {
        assert.equal(email, 'ana@example.test');
        assert.equal(ip, '127.0.0.1');
        if (fallo) throw new Error('MySQL no disponible');
        return { permitido: false, reintentarEn: 73 };
    });
    t.mock.method(console, 'error', () => {});
    const consultas = t.mock.method(pool, 'execute', async () => assert.fail('No debe consultar credenciales'));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())));
    const login = () => fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'ana@example.test', password: 'incorrecta' })
    });
    const bloqueada = await login();
    assert.equal(bloqueada.status, 429);
    assert.equal(bloqueada.headers.get('retry-after'), '73');
    assert.equal((await bloqueada.json()).success, false);
    fallo = true;
    const indisponible = await login();
    assert.equal(indisponible.status, 503);
    assert.equal((await indisponible.json()).success, false);
    assert.equal(consultas.mock.callCount(), 0);
});
