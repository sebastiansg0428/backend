const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { crearEntornoMysql } = require('../test-support/mysql-aislado.cjs');

test('MySQL comparte limites entre IPs y procesos, serializa concurrencia y conserva ventanas', {
    skip: process.env.TEST_LOGIN_MYSQL !== '1'
}, async t => {
    const entorno = await crearEntornoMysql(t, 'login');
    const pool = require('../db');
    entorno.registrarPool(pool);
    const { reservarIntento, clavesLogin } = require('../limites-login');
    const prefijo = randomUUID();
    const red = `2001:db8:${randomBytes(8).toString('hex').match(/.{4}/g).join(':')}:0`;
    const ip = `${red}:100`;
    const reservar = (cuenta, direccion) => {
        return reservarIntento(cuenta, direccion);
    };
    const cuenta = `${prefijo}@example.test`;
    const resultados = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        reservar(cuenta, `${red}:${i + 1}`)));
    assert.equal(resultados.filter(r => r.permitido).length, 10);
    assert.equal(resultados.filter(r => !r.permitido).length, 10);
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', `
        const pool = require('./db');
        require('./limites-login').reservarIntento(process.argv[1], process.argv[2])
            .then(r => console.log(JSON.stringify(r)))
            .catch(e => { console.error(e); process.exitCode = 1; })
            .finally(() => pool.end());
    `, cuenta, `${red}:1`], { cwd: path.join(__dirname, '..') });
    assert.match(stdout, /"permitido":false/);
    for (let i = 0; i < 100; i++) {
        assert.equal((await reservar(`${prefijo}-${i}@example.test`, ip)).permitido, true);
    }
    assert.equal((await reservar(`${prefijo}-100@example.test`, ip)).permitido, false);
    const cuentaClave = clavesLogin(cuenta, `${red}:1`)[0];
    await pool.execute('UPDATE limites_login SET expira = UNIX_TIMESTAMP() - 1 WHERE ambito = ? AND clave = ?',
        [cuentaClave.ambito, cuentaClave.clave]);
    assert.equal((await reservar(cuenta, `${red}:1`)).permitido, true);
    const [rows] = await pool.execute('SELECT cantidad FROM limites_login WHERE ambito = ? AND clave = ?',
        [cuentaClave.ambito, cuentaClave.clave]);
    assert.equal(rows[0].cantidad, 1);
});
