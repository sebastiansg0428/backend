const fs = require('node:fs/promises');
const path = require('node:path');

async function migrarTraslados(connection) {
    const [columnas] = await connection.execute(
        `SELECT COLUMN_TYPE, CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'radicados' AND COLUMN_NAME = 'numero_radicado'`);
    const columna = columnas[0];
    if (!columna || !/^varchar\((50|100)\)$/i.test(columna.COLUMN_TYPE) ||
        !/^[a-z0-9_]+$/i.test(columna.CHARACTER_SET_NAME) || !/^[a-z0-9_]+$/i.test(columna.COLLATION_NAME)) {
        throw new Error('El tipo o intercalacion de numero_radicado no es compatible. Revisa el esquema antes de migrar.');
    }
    const sql = await fs.readFile(path.join(__dirname, '023_solicitudes_traslado.sql'), 'utf8');
    const tipo = `${columna.COLUMN_TYPE} CHARACTER SET ${columna.CHARACTER_SET_NAME} COLLATE ${columna.COLLATION_NAME}`;
    await connection.query(sql.replace('__NUMERO_RADICADO__', tipo));
}

if (require.main === module) {
    const pool = require('../db');
    (async () => {
        let connection;
        try {
            connection = await pool.getConnection();
            await migrarTraslados(connection);
            console.log('Migracion 023 aplicada: solicitudes_traslado. Radicados y plazos existentes sin cambios.');
        } finally {
            if (connection) connection.release();
            await pool.end();
        }
    })().catch(error => {
        console.error('No se pudo aplicar la migracion 023:', error.message);
        process.exitCode = 1;
    });
}

module.exports = migrarTraslados;
