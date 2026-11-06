const test = require('node:test');
const assert = require('node:assert/strict');
const { crearEntornoMysql } = require('../test-support/mysql-aislado.cjs');

test('aislamiento MySQL rechaza prefijos inseguros antes de abrir una conexion', async () => {
    for (const prefijo of ['', 'consulta`', '../desarrollo', 'ventanilla_unica']) {
        await assert.rejects(crearEntornoMysql({}, prefijo), { code: 'ERR_ASSERTION' });
    }
});

test('aislamiento MySQL rechaza pools precargados antes de crear recursos', async () => {
    const id = require.resolve('../db');
    const anterior = require.cache[id];
    require.cache[id] = { exports: {} };
    try {
        await assert.rejects(crearEntornoMysql({}, 'consulta'), /proceso separado/);
    } finally {
        if (anterior) require.cache[id] = anterior;
        else delete require.cache[id];
    }
});
