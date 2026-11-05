const { migrarIntegridad } = require('./024_integridad_referencial');
const DDL = [
    `CREATE TABLE registros_entrega_respuesta (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        respuesta_id INT NOT NULL,
        canal ENUM('correo_electronico','presencial','mensajeria') NOT NULL,
        resultado ENUM('enviado','entrega_acreditada','intento_fallido') NOT NULL,
        destinatario VARCHAR(150) NOT NULL,
        destino VARCHAR(500) NOT NULL,
        fecha_actuacion_utc DATETIME(6) NOT NULL,
        observaciones VARCHAR(2000) NOT NULL,
        actor_id INT NOT NULL,
        actor_nombre VARCHAR(150) NOT NULL,
        clave CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        huella CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        creado_en_utc DATETIME(6) NOT NULL,
        anulado_en_utc DATETIME(6) NULL,
        anulador_id INT NULL,
        anulador_nombre VARCHAR(150) NULL,
        motivo_anulacion VARCHAR(2000) NULL,
        CONSTRAINT fk_entrega_respuesta FOREIGN KEY(respuesta_id) REFERENCES respuestas_radicado(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT fk_entrega_actor FOREIGN KEY(actor_id) REFERENCES usuarios(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        CONSTRAINT fk_entrega_anulador FOREIGN KEY(anulador_id) REFERENCES usuarios(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        UNIQUE KEY uq_entrega_intento(actor_id,clave),
        INDEX idx_entrega_respuesta(respuesta_id,id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    `CREATE TABLE evidencias_entrega (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        registro_id BIGINT UNSIGNED NOT NULL,
        nombre_archivo VARCHAR(255) NOT NULL,
        ruta_archivo VARCHAR(255) NOT NULL UNIQUE,
        tipo_mime VARCHAR(100) NOT NULL,
        tamano_bytes BIGINT UNSIGNED NOT NULL,
        sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        CONSTRAINT fk_evidencia_entrega FOREIGN KEY(registro_id) REFERENCES registros_entrega_respuesta(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
        INDEX idx_evidencia_registro(registro_id,id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];
async function verificar(connection) {
    const [[{ base }]] = await connection.query('SELECT DATABASE() AS base');
    const [tablas] = await connection.query(`SELECT TABLE_NAME, ENGINE, TABLE_COLLATION FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('registros_entrega_respuesta','evidencias_entrega')`);
    if (!tablas.length) return false;
    if (tablas.length !== 2 || tablas.some(t => t.ENGINE !== 'InnoDB' || t.TABLE_COLLATION !== 'utf8mb4_unicode_ci')) throw new Error('Migracion 025 parcial o incompatible.');
    for (let i = 0; i < DDL.length; i++) {
        const tabla = i === 0 ? 'registros_entrega_respuesta' : 'evidencias_entrega';
        const [columnas] = await connection.execute(`SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA,COLLATION_NAME
            FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [base, tabla]);
        const normalizar = sql => sql.replace(/\b(int|bigint)\(\d+\)/gi, '$1').replace(/\s+/g, '').toLowerCase();
        const partes = DDL[i].slice(DDL[i].indexOf('(') + 1, DDL[i].lastIndexOf(')')).split(/,\s*\n/);
        let ordinal = 0;
        for (const parte of partes) {
            const esperado = parte.trim().match(/^(\w+)\s+(ENUM\([^)]+\)|(?:BIGINT|INT)(?: UNSIGNED)?|(?:VARCHAR|CHAR|DATETIME)\(\d+\))/);
            if (!esperado) continue;
            const real = columnas[ordinal++];
            const nullable = /NOT NULL|PRIMARY KEY/.test(parte) ? 'NO' : 'YES';
            if (!real || real.COLUMN_NAME !== esperado[1] || normalizar(real.COLUMN_TYPE) !== normalizar(esperado[2]) ||
                real.IS_NULLABLE !== nullable || real.EXTRA !== (/AUTO_INCREMENT/.test(parte) ? 'auto_increment' : '') ||
                (/ascii_bin/.test(parte) && real.COLLATION_NAME !== 'ascii_bin')) {
                throw new Error(`Columna 025 incompatible: ${tabla}.${esperado[1]}.`);
            }
        }
        if (ordinal !== columnas.length) throw new Error(`Columnas inesperadas en ${tabla}.`);
        const [indices] = await connection.execute(`SELECT INDEX_NAME,NON_UNIQUE,COLUMN_NAME,SEQ_IN_INDEX
            FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX`, [base, tabla]);
        const requeridos = i === 0
            ? { PRIMARY: [0, ['id']], uq_entrega_intento: [0, ['actor_id', 'clave']], idx_entrega_respuesta: [1, ['respuesta_id', 'id']] }
            : { PRIMARY: [0, ['id']], ruta_archivo: [0, ['ruta_archivo']], idx_evidencia_registro: [1, ['registro_id', 'id']] };
        for (const [nombre, [noUnico, campos]] of Object.entries(requeridos)) {
            const filas = indices.filter(r => r.INDEX_NAME === nombre);
            if (filas.length !== campos.length || filas.some((r, n) => Number(r.NON_UNIQUE) !== noUnico || r.COLUMN_NAME !== campos[n])) {
                throw new Error(`Indice 025 incompatible: ${tabla}.${nombre}.`);
            }
        }
        const [claves] = await connection.execute(`SELECT k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,
            k.REFERENCED_COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,r.UPDATE_RULE,r.DELETE_RULE
            FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
            ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
            WHERE k.TABLE_SCHEMA=? AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL`, [base, tabla]);
        const esperadas = i === 0 ? [
            ['fk_entrega_respuesta', 'respuesta_id', 'respuestas_radicado'], ['fk_entrega_actor', 'actor_id', 'usuarios'],
            ['fk_entrega_anulador', 'anulador_id', 'usuarios'],
        ] : [['fk_evidencia_entrega', 'registro_id', 'registros_entrega_respuesta']];
        if (claves.length !== esperadas.length || esperadas.some(([nombre, campo, padre]) =>
            !claves.some(k => k.CONSTRAINT_NAME === nombre && k.COLUMN_NAME === campo && k.REFERENCED_TABLE_NAME === padre &&
                k.REFERENCED_COLUMN_NAME === 'id' && k.REFERENCED_TABLE_SCHEMA === base &&
                k.UPDATE_RULE === 'RESTRICT' && k.DELETE_RULE === 'RESTRICT'))) throw new Error(`FK 025 incompatibles: ${tabla}.`);
    }
    return true;
}
async function migrarEntregas(connection, { aplicar = false } = {}) {
    if (typeof aplicar !== 'boolean') throw new TypeError('aplicar debe ser booleano.');
    if ((await migrarIntegridad(connection)).estado !== 'aplicada') throw new Error('Aplicar/verificar 024 antes de 025.');
    const [padres] = await connection.query(`SELECT TABLE_NAME,COLUMN_TYPE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='id' AND TABLE_NAME IN ('usuarios','respuestas_radicado')`);
    if (padres.length !== 2 || padres.some(c => !/^int(\(\d+\))?$/i.test(c.COLUMN_TYPE))) throw new Error('Tipos de ID no compatibles con 025.');
    if (await verificar(connection)) return { estado: 'aplicada', cambios: 0 };
    if (!aplicar) return { estado: 'pendiente', cambios: 2 };
    let completados = 0;
    try {
        for (const sql of DDL) { await connection.query(sql); completados++; }
        await verificar(connection);
        return { estado: 'aplicada', cambios: completados };
    } catch (error) {
        throw new Error(`025 interrumpida tras ${completados} CREATE. DDL sin rollback; inspecciona y no reejecutes a ciegas. ${error.message}`, { cause: error });
    }
}
if (require.main === module) {
    const argumento = process.argv.slice(2);
    if (argumento.length !== 1 || !['--verificar', '--aplicar'].includes(argumento[0])) {
        console.error('Uso: node migrations\\025_seguimiento_entrega.js --verificar|--aplicar');
        process.exitCode = 1;
    } else {
        const pool = require('../db');
        (async () => {
            const c = await pool.getConnection();
            try { console.log(await migrarEntregas(c, { aplicar: argumento[0] === '--aplicar' })); }
            finally { c.release(); await pool.end(); }
        })().catch(error => { console.error(error.message, error.cause?.message || ''); process.exitCode = 1; });
    }
}
module.exports = { migrarEntregas, verificar };
