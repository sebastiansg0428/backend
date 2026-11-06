const { migrarEntregas } = require('./025_seguimiento_entrega');
const TABLAS = [
    ['entregas_confirmacion', 'registro_id', 'registros_entrega_respuesta', 'fk_confirmacion_entrega'],
    ['documentos_entrega_origen', 'evidencia_id', 'evidencias_entrega', 'fk_origen_evidencia'],
];
async function verificar(connection) {
    const [tablas] = await connection.query(`SELECT TABLE_NAME,ENGINE,TABLE_COLLATION FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('entregas_confirmacion','documentos_entrega_origen')`);
    if (!tablas.length) return false;
    if (tablas.length !== 2 || tablas.some(t => t.ENGINE !== 'InnoDB' || t.TABLE_COLLATION !== 'utf8mb4_unicode_ci')) {
        throw new Error('Migracion 026 parcial o incompatible.');
    }
    for (const [tabla, campo, padre, nombre] of TABLAS) {
        const [columnas] = await connection.query(`SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA
            FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION`, [tabla]);
        if (columnas.length !== (tabla === 'entregas_confirmacion' ? 1 : 2) ||
            columnas[0].COLUMN_NAME !== campo || !/^bigint(?:\(\d+\))? unsigned$/i.test(columnas[0].COLUMN_TYPE) ||
            columnas.some(c => c.IS_NULLABLE !== 'NO' || c.EXTRA !== '') ||
            (columnas[1] && (columnas[1].COLUMN_NAME !== 'origen' ||
                columnas[1].COLUMN_TYPE !== "enum('documento_respuesta','evidencia_adicional')"))) throw new Error(`Columnas 026 incompatibles: ${tabla}.`);
        const [pk] = await connection.query(`SELECT COLUMN_NAME FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX`, [tabla]);
        if (pk.length !== 1 || pk[0].COLUMN_NAME !== campo) throw new Error(`PK 026 incompatible: ${tabla}.`);
        const [fk] = await connection.query(`SELECT k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,
            k.REFERENCED_COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,r.UPDATE_RULE,r.DELETE_RULE,DATABASE() AS base
            FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
            ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
            WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME=? AND k.REFERENCED_TABLE_NAME IS NOT NULL`, [tabla]);
        if (fk.length !== 1 || fk[0].CONSTRAINT_NAME !== nombre || fk[0].COLUMN_NAME !== campo ||
            fk[0].REFERENCED_TABLE_NAME !== padre || fk[0].REFERENCED_COLUMN_NAME !== 'id' ||
            fk[0].REFERENCED_TABLE_SCHEMA !== fk[0].base || fk[0].UPDATE_RULE !== 'RESTRICT' ||
            fk[0].DELETE_RULE !== 'RESTRICT') throw new Error(`FK 026 incompatible: ${tabla}.`);
    }
    return true;
}
async function migrarDocumentosEntrega(connection, { aplicar = false } = {}) {
    if (typeof aplicar !== 'boolean') throw new TypeError('aplicar debe ser booleano.');
    if ((await migrarEntregas(connection)).estado !== 'aplicada') throw new Error('Verificar/aplicar 025 antes de 026.');
    if (await verificar(connection)) return { estado: 'aplicada', cambios: 0 };
    if (!aplicar) return { estado: 'pendiente', cambios: 2 };
    let completados = 0;
    try {
        for (const [tabla, campo, padre, nombre] of TABLAS) {
            await connection.query(`CREATE TABLE \`${tabla}\` (
                \`${campo}\` BIGINT UNSIGNED NOT NULL PRIMARY KEY,
                ${tabla === 'documentos_entrega_origen' ? "origen ENUM('documento_respuesta','evidencia_adicional') NOT NULL," : ''}
                CONSTRAINT \`${nombre}\` FOREIGN KEY(\`${campo}\`) REFERENCES \`${padre}\`(id)
                ON DELETE RESTRICT ON UPDATE RESTRICT
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
            completados++;
        }
        await verificar(connection);
        return { estado: 'aplicada', cambios: completados };
    } catch (error) {
        throw new Error(`026 interrumpida tras ${completados} CREATE; DDL sin rollback global. ${error.message}`, { cause: error });
    }
}
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--verificar', '--aplicar'].includes(args[0])) {
        console.error('Uso: node migrations\\026_documentos_entrega.js --verificar|--aplicar');
        process.exitCode = 1;
    } else {
        const pool = require('../db');
        (async () => {
            const c = await pool.getConnection();
            try { console.log(await migrarDocumentosEntrega(c, { aplicar: args[0] === '--aplicar' })); }
            finally { c.release(); await pool.end(); }
        })().catch(error => { console.error(error.message); process.exitCode = 1; });
    }
}
module.exports = { migrarDocumentosEntrega, verificar };
