const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { createReadStream } = require('node:fs');
const mysql = require('mysql2/promise');

function nombreSeguro(nombre) {
    if (!/^ventanilla_recuperacion_[a-f0-9]{12}_(origen|destino)$/.test(nombre)) {
        throw new Error('La base debe ser exclusiva de la prueba de recuperacion.');
    }
    return nombre;
}

async function hashArchivo(archivo) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archivo)) hash.update(chunk);
    return hash.digest('hex');
}

async function archivosPdf(carpeta, relativa = '') {
    const resultado = [];
    for (const entrada of await fs.readdir(path.join(carpeta, relativa), { withFileTypes: true })) {
        if (entrada.isSymbolicLink()) throw new Error('No se respaldan enlaces simbolicos.');
        const rutaRelativa = path.join(relativa, entrada.name);
        if (entrada.isDirectory()) resultado.push(...await archivosPdf(carpeta, rutaRelativa));
        else {
            if (!entrada.isFile() || !/^[a-zA-Z0-9._-]+\.pdf$/.test(entrada.name)) {
                throw new Error('Archivo inesperado en los uploads ficticios.');
            }
            const archivo = path.join(carpeta, rutaRelativa);
            resultado.push({ ruta: rutaRelativa, bytes: (await fs.stat(archivo)).size, sha256: await hashArchivo(archivo) });
        }
    }
    return resultado.sort((a, b) => a.ruta.localeCompare(b.ruta));
}

async function ejecutarProceso(binario, args, { env = process.env, entrada } = {}) {
    const child = spawn(binario, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let salida = '';
    let errorSalida = '';
    child.stdout.on('data', chunk => { salida += chunk; });
    child.stderr.on('data', chunk => { errorSalida += chunk; });
    let errorEntrada;
    if (entrada) {
        const stream = createReadStream(entrada);
        stream.on('error', error => { errorEntrada = error; child.stdin.destroy(error); });
        child.stdin.on('error', error => { errorEntrada = error; });
        stream.pipe(child.stdin);
    } else child.stdin.end();
    await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 && !errorEntrada
            ? resolve() : reject(new Error(`Fallo de herramienta (${path.basename(binario)}, codigo ${code}): ${errorSalida}`, { cause: errorEntrada })));
    });
    return salida;
}

async function snapshot(connection, base) {
    nombreSeguro(base);
    const [tablas] = await connection.execute(
        `SELECT TABLE_NAME AS nombre, ENGINE AS motor, AUTO_INCREMENT AS siguiente, TABLE_COLLATION AS collation
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`, [base]);
    const datos = {};
    for (const { nombre, motor, siguiente, collation } of tablas) {
        assert.match(nombre, /^[a-zA-Z0-9_]+$/);
        assert.equal(motor, 'InnoDB', 'El respaldo consistente requiere tablas InnoDB.');
        const [rows] = await connection.query(`SELECT * FROM \`${base}\`.\`${nombre}\``);
        const contenido = rows.map(row => JSON.stringify(row)).sort().join('\n');
        datos[nombre] = { filas: rows.length, siguiente, collation, sha256: createHash('sha256').update(contenido).digest('hex') };
    }
    return datos;
}

async function verificarReferencias(connection, base) {
    nombreSeguro(base);
    const [claves] = await connection.execute(
        `SELECT TABLE_NAME AS tabla, COLUMN_NAME AS columna, CONSTRAINT_NAME AS restriccion,
                REFERENCED_TABLE_SCHEMA AS esquema, REFERENCED_TABLE_NAME AS referida,
                REFERENCED_COLUMN_NAME AS referidaColumna
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`, [base]);
    const grupos = new Map();
    for (const clave of claves) {
        assert.equal(clave.esquema, base, 'No se admiten referencias fuera de la base aislada.');
        for (const campo of ['tabla', 'columna', 'referida', 'referidaColumna']) assert.match(clave[campo], /^[a-zA-Z0-9_]+$/);
        const id = `${clave.tabla}:${clave.restriccion}`;
        if (!grupos.has(id)) grupos.set(id, []);
        grupos.get(id).push(clave);
    }
    for (const grupo of grupos.values()) {
        const clave = grupo[0];
        const igualdad = grupo.map(c => `a.\`${c.columna}\` = b.\`${c.referidaColumna}\``).join(' AND ');
        const noNulos = grupo.map(c => `a.\`${c.columna}\` IS NOT NULL`).join(' AND ');
        const [huerfanos] = await connection.query(
            `SELECT COUNT(*) AS total FROM \`${base}\`.\`${clave.tabla}\` a
             WHERE ${noNulos} AND NOT EXISTS (SELECT 1 FROM \`${base}\`.\`${clave.referida}\` b WHERE ${igualdad})`);
        assert.equal(Number(huerfanos[0].total), 0, `Referencias rotas: ${clave.restriccion}`);
    }
    return grupos.size;
}

async function ejecutar() {
    const [carpetaRaiz] = process.argv.slice(2);
    if (!carpetaRaiz || !path.isAbsolute(carpetaRaiz)) {
        throw new Error('Indica una carpeta absoluta fuera del repositorio para la prueba ficticia.');
    }
    const repo = path.resolve(__dirname, '..');
    const destinoRelativo = path.relative(repo, path.resolve(carpetaRaiz));
    if (!destinoRelativo.startsWith(`..${path.sep}`) && !path.isAbsolute(destinoRelativo)) {
        throw new Error('La carpeta de recuperacion debe estar fuera del repositorio.');
    }
    const bin = process.env.MARIADB_BIN;
    if (!bin || !path.isAbsolute(bin)) throw new Error('Configura MARIADB_BIN con la carpeta de las herramientas nativas.');
    const dump = path.join(bin, process.platform === 'win32' ? 'mariadb-dump.exe' : 'mariadb-dump');
    const cliente = path.join(bin, process.platform === 'win32' ? 'mariadb.exe' : 'mariadb');
    await fs.access(dump);
    await fs.access(cliente);
    const identificador = randomBytes(6).toString('hex');
    const origen = nombreSeguro(`ventanilla_recuperacion_${identificador}_origen`);
    const destino = nombreSeguro(`ventanilla_recuperacion_${identificador}_destino`);
    const carpeta = path.join(carpetaRaiz, `recuperacion-${identificador}`);
    await fs.mkdir(carpetaRaiz, { recursive: true });
    await fs.mkdir(carpeta);
    const privada = path.join(carpeta, 'credenciales-temporales');
    await fs.mkdir(privada, { mode: 0o700 });
    const opciones = path.join(privada, 'cliente.cnf');
    const configuracion = {
        host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '', port: 3306,
        dateStrings: true
    };
    let connection;
    try {
        if (process.platform === 'win32') {
            const cuenta = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
            const acl = spawnSync('icacls.exe', [privada, '/inheritance:r', '/grant:r', `${cuenta}:(OI)(CI)F`], {
                windowsHide: true, encoding: 'utf8'
            });
            if (acl.error || acl.status !== 0) throw new Error('No se pudo proteger la carpeta temporal de credenciales.');
        }
        const escapar = valor => `"${String(valor).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
            .replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
        await fs.writeFile(opciones, `[client]\nhost=${escapar(configuracion.host)}\nuser=${escapar(configuracion.user)}\npassword=${escapar(configuracion.password)}\nport=${configuracion.port}\n`, { mode: 0o600, flag: 'wx' });
        const defaults = `--defaults-extra-file=${opciones}`;
        connection = await mysql.createConnection(configuracion);
        const baseEstructura = process.env.RECOVERY_SCHEMA_DB || 'ventanilla_unica';
        if (!['ventanilla_unica', 'ventanilla_unica_test'].includes(baseEstructura)) {
            throw new Error('RECOVERY_SCHEMA_DB debe ser una base local compatible conocida.');
        }
        // Solo estructura: ninguna fila ni PDF de la base de desarrollo se copia.
        const [existentes] = await connection.execute(
            'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?, ?)', [origen, destino]);
        assert.equal(existentes.length, 0, 'No sobrescribir bases existentes.');
        const esquema = path.join(carpeta, 'estructura.sql');
        await ejecutarProceso(dump, [defaults, '--no-data', '--skip-comments', '--skip-add-drop-table',
            `--result-file=${esquema}`, baseEstructura]);
        await connection.query(`CREATE DATABASE \`${origen}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await connection.query(`CREATE DATABASE \`${destino}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        await ejecutarProceso(cliente, [defaults, origen], { entrada: esquema });
        for (const [tabla, archivo] of [
            ['intentos_radicacion', '022_idempotencia_radicacion.sql'],
            ['solicitudes_traslado', '023_solicitudes_traslado.sql']
        ]) {
            const [migrada] = await connection.execute(
                'SELECT COUNT(*) AS total FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [origen, tabla]);
            if (Number(migrada[0].total) === 0) {
                await connection.query(`USE \`${origen}\``);
                if (tabla === 'solicitudes_traslado') {
                    await require('../migrations/023_solicitudes_traslado')(connection);
                } else {
                    const sql = await fs.readFile(path.join(repo, 'migrations', archivo), 'utf8');
                    await connection.query(sql);
                }
            }
        }
        const uploads = path.join(carpeta, 'origen-uploads');
        const fixture = path.join(carpeta, 'fixture.json');
        const envOrigen = { ...process.env, DB_NAME: origen, UPLOAD_DIR: uploads };
        const worker = path.join(__dirname, 'recuperacion-worker.js');
        await ejecutarProceso(process.execPath, [worker, 'crear', fixture], { env: envOrigen });
        const { concurrencia } = JSON.parse(await fs.readFile(fixture, 'utf8'));
        // Reinicio real: proceso anterior termina antes de confirmar el mismo intento.
        await ejecutarProceso(process.execPath, [worker, 'verificar', fixture], { env: envOrigen });
        const datosAntes = await snapshot(connection, origen);
        const referencias = await verificarReferencias(connection, origen);
        const pdfsAntes = await archivosPdf(uploads);
        assert.equal(pdfsAntes.length, 4);
        const respaldo = path.join(carpeta, 'respaldo.sql');
        // Ningun escritor de fixtures sigue activo al copiar SQL y PDFs.
        await ejecutarProceso(dump, [defaults, '--single-transaction', '--skip-comments',
            '--skip-add-drop-table', `--result-file=${respaldo}`, origen]);
        const copiaPdfs = path.join(carpeta, 'respaldo-pdfs');
        await fs.mkdir(copiaPdfs);
        for (const archivo of pdfsAntes) {
            const copia = path.join(copiaPdfs, archivo.ruta);
            await fs.mkdir(path.dirname(copia), { recursive: true });
            await fs.copyFile(path.join(uploads, archivo.ruta), copia);
        }
        const manifest = { origen, datos: datosAntes, pdfs: pdfsAntes, sql_sha256: await hashArchivo(respaldo) };
        await fs.writeFile(path.join(carpeta, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
        assert.equal(await hashArchivo(respaldo), manifest.sql_sha256);
        await ejecutarProceso(cliente, [defaults, destino], { entrada: respaldo });
        const restaurados = path.join(carpeta, 'destino-uploads');
        await fs.mkdir(restaurados);
        for (const archivo of pdfsAntes) {
            const copia = path.join(restaurados, archivo.ruta);
            await fs.mkdir(path.dirname(copia), { recursive: true });
            await fs.copyFile(path.join(copiaPdfs, archivo.ruta), copia);
        }
        assert.deepEqual(await snapshot(connection, destino), datosAntes);
        assert.equal(await verificarReferencias(connection, destino), referencias);
        assert.deepEqual(await archivosPdf(restaurados), pdfsAntes);
        await ejecutarProceso(process.execPath, [worker, 'verificar', fixture], {
            env: { ...process.env, DB_NAME: destino, UPLOAD_DIR: restaurados }
        });
        assert.deepEqual(await snapshot(connection, destino), datosAntes);
        assert.deepEqual(await archivosPdf(restaurados), pdfsAntes);
        const reporte = { validado: true, datos_exclusivamente_ficticios: true,
            concurrencia,
            origen, destino, carpeta, tablas: Object.keys(datosAntes).length,
            radicados: datosAntes.radicados.filas, intentos: datosAntes.intentos_radicacion.filas,
            pdfs: pdfsAntes.length, hashes_identicos: true,
            referencias_verificadas: referencias, base_solo_estructura: baseEstructura,
            reintento_tras_reinicio_y_restauracion: true, descargas_autorizadas_verificadas: true };
        await fs.writeFile(path.join(carpeta, 'reporte.json'), JSON.stringify(reporte, null, 2), { flag: 'wx' });
        console.log(JSON.stringify(reporte, null, 2));
    } finally {
        if (connection) await connection.end();
        // Solo los dos paths exactos creados para credenciales; no borrar los respaldos.
        try { await fs.unlink(opciones); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rmdir(privada);
    }
}

if (require.main === module) ejecutar().catch(error => {
    console.error('Prueba de recuperacion no confirmada:', error);
    process.exitCode = 1;
});

module.exports = { nombreSeguro, hashArchivo, archivosPdf, snapshot, verificarReferencias };
