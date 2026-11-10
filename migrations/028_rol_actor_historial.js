async function migrarRolActor(c, { aplicar = false } = {}) {
    if (typeof aplicar !== 'boolean') throw new TypeError('aplicar debe ser booleano.');
    const [columnas] = await c.query(`SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='historial_radicado'`);
    if (!['event_type', 'actor_id', 'actor_name'].every(nombre =>
        columnas.some(columna => columna.COLUMN_NAME === nombre))) {
        throw new Error('028: verificar la migracion 021 antes de continuar.');
    }
    const rol = columnas.find(columna => columna.COLUMN_NAME === 'actor_role');
    if (rol) {
        const defaultNulo = rol.COLUMN_DEFAULT === null || rol.COLUMN_DEFAULT === 'NULL';
        if (rol.COLUMN_TYPE !== 'varchar(20)' || rol.IS_NULLABLE !== 'YES' || !defaultNulo) {
            throw new Error('028: actor_role incompatible; no se modifico el esquema.');
        }
        return { estado: 'aplicada' };
    }
    if (!aplicar) return { estado: 'pendiente' };
    await c.query('ALTER TABLE historial_radicado ADD COLUMN actor_role VARCHAR(20) NULL DEFAULT NULL AFTER actor_name');
    return migrarRolActor(c);
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--verificar', '--aplicar'].includes(args[0])) {
        console.error('Uso: node migrations\\028_rol_actor_historial.js --verificar|--aplicar');
        process.exitCode = 1;
    } else {
        const pool = require('../db');
        (async () => {
            let c;
            try {
                c = await pool.getConnection();
                console.log(await migrarRolActor(c, { aplicar: args[0] === '--aplicar' }));
            } finally {
                c?.release();
                await pool.end();
            }
        })().catch(error => { console.error(error.message); process.exitCode = 1; });
    }
}

module.exports = { migrarRolActor };
