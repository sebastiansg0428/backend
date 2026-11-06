const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function crearEntornoMysql(t, prefijo) {
    assert.match(prefijo, /^[a-z]+$/);
    assert.equal(require.cache[require.resolve('../db')], undefined,
        'Ejecutar cada integracion MySQL en un proceso separado, antes de cargar db/server.');
    const nombre = `ventanilla_${prefijo}_${randomBytes(6).toString('hex')}`;
    const source = process.env.TEST_SCHEMA_DB || 'ventanilla_unica';
    assert.ok(['ventanilla_unica', 'ventanilla_unica_test'].includes(source));
    const mysql = require('mysql2/promise');
    const admin = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '', dateStrings: true,
    });
    const entorno = { DB_NAME: process.env.DB_NAME, UPLOAD_DIR: process.env.UPLOAD_DIR };
    let creada = false;
    let uploads;
    let pool;
    let server;
    t.after(async () => {
        try {
            if (server) await new Promise((resolve, reject) =>
                server.close(error => error ? reject(error) : resolve()));
            if (pool) await pool.end();
            if (creada) await admin.query(`DROP DATABASE \`${nombre}\``);
        } finally {
            await admin.end();
            if (uploads) await fs.rm(uploads, { recursive: true });
            for (const [clave, valor] of Object.entries(entorno)) {
                if (valor === undefined) delete process.env[clave];
                else process.env[clave] = valor;
            }
        }
    });
    const [tablas] = await admin.execute(
        "SELECT TABLE_NAME AS nombre FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'",
        [source]);
    assert.ok(tablas.some(tabla => tabla.nombre === 'limites_login'), 'Falta esquema fuente actualizado.');
    const estructura = [];
    for (const tabla of tablas) {
        assert.match(tabla.nombre, /^\w+$/);
        const [ddl] = await admin.query(`SHOW CREATE TABLE \`${source}\`.\`${tabla.nombre}\``);
        estructura.push(ddl[0]['Create Table']);
    }
    await admin.query(`CREATE DATABASE \`${nombre}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    creada = true;
    await admin.query(`USE \`${nombre}\``);
    await admin.query('SET FOREIGN_KEY_CHECKS=0');
    try {
        for (const ddl of estructura) await admin.query(ddl);
    } finally { await admin.query('SET FOREIGN_KEY_CHECKS=1'); }
    const [referencias] = await admin.query(`SELECT DISTINCT REFERENCED_TABLE_SCHEMA AS esquema
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`);
    assert.ok(referencias.every(fk => fk.esquema === nombre), 'Una FK apunta fuera de la base temporal.');
    for (const tabla of tablas) {
        const [[fila]] = await admin.query(`SELECT COUNT(*) AS n FROM \`${tabla.nombre}\``);
        assert.equal(Number(fila.n), 0, 'La copia de prueba debe contener solo estructura.');
    }
    uploads = await fs.mkdtemp(path.join(os.tmpdir(), `ventanilla-${prefijo}-`));
    process.env.DB_NAME = nombre;
    process.env.UPLOAD_DIR = uploads;
    return {
        nombre, uploads,
        registrarPool(valor) { pool = valor; },
        registrarServidor(valor) { server = valor; },
    };
}

module.exports = { crearEntornoMysql };
