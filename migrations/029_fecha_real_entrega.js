const { verificar: verificar026 } = require('./026_documentos_entrega');

async function verificar(connection) {
    const [tablas] = await connection.query(`SELECT ENGINE,TABLE_COLLATION FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='entregas_fecha_real'`);
    const [indices] = await connection.query(`SELECT COLUMN_NAME,NON_UNIQUE FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='registros_entrega_respuesta'
        AND INDEX_NAME='idx_entrega_fecha' ORDER BY SEQ_IN_INDEX`);
    if (!tablas.length && !indices.length) return false;
    if (tablas.length !== 1 || tablas[0].ENGINE !== 'InnoDB' || tablas[0].TABLE_COLLATION !== 'utf8mb4_unicode_ci' ||
        indices.length !== 3 || indices.some((c, i) => Number(c.NON_UNIQUE) !== 1 ||
            c.COLUMN_NAME !== ['respuesta_id', 'fecha_actuacion_utc', 'id'][i])) {
        throw new Error('Migracion 029 parcial o incompatible.');
    }
    const [columnas] = await connection.query(`SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='entregas_fecha_real' ORDER BY ORDINAL_POSITION`);
    if (columnas.length !== 2 || columnas[0].COLUMN_NAME !== 'registro_id' ||
        !/^bigint(?:\(\d+\))? unsigned$/i.test(columnas[0].COLUMN_TYPE) || columnas[0].IS_NULLABLE !== 'NO' ||
        columnas[1].COLUMN_NAME !== 'justificacion_fecha_anterior' || columnas[1].COLUMN_TYPE !== 'varchar(2000)' ||
        columnas[1].IS_NULLABLE !== 'YES' || columnas.some(c => c.EXTRA !== '')) {
        throw new Error('Columnas 029 incompatibles.');
    }
    const [pk] = await connection.query(`SELECT COLUMN_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='entregas_fecha_real' AND INDEX_NAME='PRIMARY'`);
    const [fk] = await connection.query(`SELECT k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,
        k.REFERENCED_COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,r.UPDATE_RULE,r.DELETE_RULE,DATABASE() AS base
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='entregas_fecha_real' AND k.REFERENCED_TABLE_NAME IS NOT NULL`);
    if (pk.length !== 1 || pk[0].COLUMN_NAME !== 'registro_id' || fk.length !== 1 ||
        fk[0].CONSTRAINT_NAME !== 'fk_fecha_real_entrega' || fk[0].COLUMN_NAME !== 'registro_id' ||
        fk[0].REFERENCED_TABLE_NAME !== 'registros_entrega_respuesta' || fk[0].REFERENCED_COLUMN_NAME !== 'id' ||
        fk[0].REFERENCED_TABLE_SCHEMA !== fk[0].base || fk[0].DELETE_RULE !== 'RESTRICT' || fk[0].UPDATE_RULE !== 'RESTRICT') {
        throw new Error('Claves 029 incompatibles.');
    }
    return true;
}

async function migrarFechaRealEntrega(connection, { aplicar = false } = {}) {
    if (typeof aplicar !== 'boolean') throw new TypeError('aplicar debe ser booleano.');
    if (!await verificar026(connection)) throw new Error('Verificar/aplicar 026 antes de 029.');
    if (await verificar(connection)) return { estado: 'aplicada', cambios: 0 };
    if (!aplicar) return { estado: 'pendiente', cambios: 2 };
    let completados = 0;
    try {
        await connection.query(`CREATE TABLE entregas_fecha_real (
            registro_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
            justificacion_fecha_anterior VARCHAR(2000) NULL,
            CONSTRAINT fk_fecha_real_entrega FOREIGN KEY(registro_id) REFERENCES registros_entrega_respuesta(id)
            ON DELETE RESTRICT ON UPDATE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        completados++;
        await connection.query(`ALTER TABLE registros_entrega_respuesta
            ADD INDEX idx_entrega_fecha(respuesta_id,fecha_actuacion_utc,id)`);
        completados++;
        await verificar(connection);
        return { estado: 'aplicada', cambios: completados };
    } catch (error) {
        throw new Error(`029 interrumpida tras ${completados} DDL; commit implicito, inspecciona antes de reintentar. ${error.message}`, { cause: error });
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--verificar', '--aplicar'].includes(args[0])) {
        console.error('Uso: node migrations\\029_fecha_real_entrega.js --verificar|--aplicar');
        process.exitCode = 1;
    } else {
        const pool = require('../db');
        (async () => {
            const c = await pool.getConnection();
            try { console.log(await migrarFechaRealEntrega(c, { aplicar: args[0] === '--aplicar' })); }
            finally { c.release(); await pool.end(); }
        })().catch(error => { console.error(error.message); process.exitCode = 1; });
    }
}
module.exports = { migrarFechaRealEntrega, verificar };
