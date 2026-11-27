let pool;

const NOMBRE_COLUMNA = 'dependencia_responsable_id';
const NOMBRE_INDICE = 'idx_radicados_dependencia_responsable';
const NOMBRE_FK = 'fk_radicados_dependencia_responsable';

function diagnostico(error) {
    return error?.code || error?.message || 'No fue posible inspeccionar el esquema.';
}

async function inspeccionar(connection) {
    try {
        const [columnas] = await connection.query(
            `SHOW FULL COLUMNS FROM radicados LIKE '${NOMBRE_COLUMNA}'`
        );
        if (!columnas.length) return { estado: 'pendiente', cambios: 1 };
        const columna = columnas[0];
        const tipo = String(columna.Type || columna.COLUMN_TYPE || '').toLowerCase();
        if (!/^int\(\d+\)( unsigned)?$/.test(tipo) || columna.Null !== 'YES' || columna.Default !== null) {
            return {
                estado: 'incompatible',
                diagnostico: 'radicados.dependencia_responsable_id debe ser INT NULL sin valor predeterminado.'
            };
        }
        const [indices] = await connection.query('SHOW INDEX FROM radicados');
        const [restricciones] = await connection.query(
            `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'radicados'
               AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME = 'dependencias'`,
            [NOMBRE_COLUMNA]
        );
        return {
            estado: indices.some(indice => indice.Key_name === NOMBRE_INDICE) && restricciones.length
                ? 'aplicada' : 'parcial',
            columna: tipo,
            indice: indices.some(indice => indice.Key_name === NOMBRE_INDICE),
            fk: restricciones.length > 0
        };
    } catch (error) {
        return { estado: 'indeterminada', diagnostico: diagnostico(error) };
    }
}

async function verificar(connection) {
    const estado = await inspeccionar(connection);
    if (estado.estado === 'aplicada') return true;
    if (estado.estado === 'pendiente') return false;
    throw new Error(`Migracion 031 incompatible o parcial: ${estado.diagnostico || 'inspecciona el esquema antes de continuar.'}`);
}

async function migrar(connection, { aplicar = false } = {}) {
    if (typeof aplicar !== 'boolean') throw new TypeError('aplicar debe ser booleano.');
    const estado = await inspeccionar(connection);
    if (estado.estado === 'aplicada') return { estado: 'aplicada', cambios: 0 };
    if (estado.estado === 'parcial' || estado.estado === 'incompatible' || estado.estado === 'indeterminada') {
        throw new Error(`Migracion 031 no aplicable: ${estado.diagnostico || 'la definición quedó parcial.'}`);
    }
    if (!aplicar) return { estado: 'pendiente', cambios: 1 };
    try {
        await connection.query(
            `ALTER TABLE radicados
             ADD COLUMN ${NOMBRE_COLUMNA} INT NULL AFTER destino_todas_dependencias,
             ADD INDEX ${NOMBRE_INDICE} (${NOMBRE_COLUMNA}),
             ADD CONSTRAINT ${NOMBRE_FK} FOREIGN KEY (${NOMBRE_COLUMNA}) REFERENCES dependencias(id)`
        );
        const despues = await inspeccionar(connection);
        if (despues.estado !== 'aplicada') {
            throw new Error(`La verificación posterior no dejó 031 aplicada: ${despues.diagnostico || despues.estado}`);
        }
        return { estado: 'aplicada', cambios: 1 };
    } catch (error) {
        throw new Error(`031 interrumpida; el DDL hace commit implícito. Inspecciona antes de reintentar. ${error.message}`, { cause: error });
    }
}

if (require.main === module) {
    pool = require('../db');
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--inspeccionar', '--verificar', '--aplicar'].includes(args[0])) {
        console.error('Uso: node migrations\\031_responsable_global_externo.js --inspeccionar|--verificar|--aplicar');
        process.exitCode = 1;
    } else {
        pool.getConnection().then(async connection => {
            try {
                if (args[0] === '--inspeccionar') console.log(await inspeccionar(connection));
                else if (args[0] === '--verificar') console.log(`Migracion 031 ${await verificar(connection) ? 'aplicada' : 'pendiente'}.`);
                else console.log(await migrar(connection, { aplicar: true }));
            } finally { connection.release(); }
        }).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
    }
}

module.exports = { inspeccionar, verificar, migrar, NOMBRE_COLUMNA, NOMBRE_INDICE, NOMBRE_FK };
