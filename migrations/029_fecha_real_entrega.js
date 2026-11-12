const { verificar: verificar026 } = require('./026_documentos_entrega');

const NOMBRE_INDICE = 'idx_entrega_fecha';
const COLUMNAS_INDICE = ['respuesta_id', 'fecha_actuacion_utc', 'id'];

function estado029(estado, acciones = [], detalles = {}) {
    return {
        estado,
        acciones,
        cambios: 0,
        requiere_confirmacion: estado === 'parcial_reparable',
        ...detalles,
    };
}

function diagnostico(error) {
    return error?.code || error?.message || 'No fue posible inspeccionar el esquema.';
}

function indiceCompatible(indices) {
    return indices.length === COLUMNAS_INDICE.length && indices.every((indice, posicion) =>
        Number(indice.NON_UNIQUE) === 1 && indice.COLUMN_NAME === COLUMNAS_INDICE[posicion]);
}

function tablaCompatible(tablas) {
    return tablas.length === 1 && tablas[0].ENGINE === 'InnoDB' &&
        tablas[0].TABLE_COLLATION === 'utf8mb4_unicode_ci';
}

async function leerEstado(connection) {
    const [tablas] = await connection.query(`SELECT ENGINE,TABLE_COLLATION FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='entregas_fecha_real'`);
    const [indices] = await connection.query(`SELECT COLUMN_NAME,NON_UNIQUE FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='registros_entrega_respuesta'
        AND INDEX_NAME='${NOMBRE_INDICE}' ORDER BY SEQ_IN_INDEX`);
    const tablaExiste = tablas.length > 0;
    const indiceExiste = indices.length > 0;

    if (!tablaExiste && !indiceExiste) return estado029('ausente', [], { siguiente: 'usar_aplicar' });
    if (indiceExiste && !indiceCompatible(indices)) {
        return estado029('incompatible', [], { diagnostico: 'El indice 029 existe con una definicion incompatible.' });
    }
    if (!tablaExiste) {
        return estado029('parcial_reparable', ['crear_tabla'], {
            diagnostico: 'El indice 029 es compatible, pero falta la tabla entregas_fecha_real.',
        });
    }
    if (!tablaCompatible(tablas)) {
        return estado029('incompatible', [], { diagnostico: 'La tabla 029 tiene motor o colacion incompatible.' });
    }

    const [columnas] = await connection.query(`SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_NAME='entregas_fecha_real' ORDER BY ORDINAL_POSITION`);
    if (columnas.length !== 2 || columnas[0].COLUMN_NAME !== 'registro_id' ||
        !/^bigint(?:\(\d+\))? unsigned$/i.test(columnas[0].COLUMN_TYPE) || columnas[0].IS_NULLABLE !== 'NO' ||
        columnas[1].COLUMN_NAME !== 'justificacion_fecha_anterior' || columnas[1].COLUMN_TYPE !== 'varchar(2000)' ||
        columnas[1].IS_NULLABLE !== 'YES' || columnas.some(c => c.EXTRA !== '')) {
        return estado029('incompatible', [], { diagnostico: 'Las columnas 029 son incompatibles.' });
    }

    const [pk] = await connection.query(`SELECT COLUMN_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='entregas_fecha_real' AND INDEX_NAME='PRIMARY'`);
    if (pk.length !== 1 || pk[0].COLUMN_NAME !== 'registro_id') {
        return estado029('incompatible', [], { diagnostico: 'La clave primaria 029 es incompatible.' });
    }

    const [fk] = await connection.query(`SELECT k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,
        k.REFERENCED_COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,r.UPDATE_RULE,r.DELETE_RULE,DATABASE() AS base
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='entregas_fecha_real' AND k.REFERENCED_TABLE_NAME IS NOT NULL`);
    if (pk.length !== 1 || fk.length !== 1 ||
        fk[0].CONSTRAINT_NAME !== 'fk_fecha_real_entrega' || fk[0].COLUMN_NAME !== 'registro_id' ||
        fk[0].REFERENCED_TABLE_NAME !== 'registros_entrega_respuesta' || fk[0].REFERENCED_COLUMN_NAME !== 'id' ||
        fk[0].REFERENCED_TABLE_SCHEMA !== fk[0].base || fk[0].DELETE_RULE !== 'RESTRICT' ||
        fk[0].UPDATE_RULE !== 'RESTRICT') {
        return estado029('incompatible', [], { diagnostico: 'La clave foranea 029 es incompatible.' });
    }
    if (!indiceExiste) {
        return estado029('parcial_reparable', ['crear_indice'], {
            diagnostico: 'La tabla 029 es compatible, pero falta el indice idx_entrega_fecha.',
        });
    }
    return estado029('aplicada');
}

async function inspeccionarFechaRealEntrega(connection) {
    try {
        return await leerEstado(connection);
    } catch (error) {
        return estado029('indeterminada', [], { diagnostico: diagnostico(error) });
    }
}

async function verificar(connection) {
    const estado = await leerEstado(connection);
    if (estado.estado === 'aplicada') return true;
    if (estado.estado === 'ausente') return false;
    throw new Error('Migracion 029 parcial o incompatible.');
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

async function repararFechaRealEntrega(connection, { confirmar = false } = {}) {
    if (typeof confirmar !== 'boolean') throw new TypeError('confirmar debe ser booleano.');
    const plan = await inspeccionarFechaRealEntrega(connection);
    if (plan.estado !== 'parcial_reparable') return plan;

    let compatible026;
    try {
        compatible026 = await verificar026(connection);
    } catch (error) {
        return estado029('indeterminada', [], { diagnostico: diagnostico(error) });
    }
    if (!compatible026) {
        return estado029('incompatible', [], { diagnostico: 'Verificar/aplicar 026 antes de reparar 029.' });
    }
    if (!confirmar) return plan;

    let completados = 0;
    try {
        for (const accion of plan.acciones) {
            const actual = await leerEstado(connection);
            if (actual.estado !== 'parcial_reparable' || !actual.acciones.includes(accion)) {
                throw new Error('El esquema cambio despues de la inspeccion; vuelve a inspeccionar antes de reparar.');
            }
            if (accion === 'crear_tabla') {
                await connection.query(`CREATE TABLE entregas_fecha_real (
                    registro_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
                    justificacion_fecha_anterior VARCHAR(2000) NULL,
                    CONSTRAINT fk_fecha_real_entrega FOREIGN KEY(registro_id) REFERENCES registros_entrega_respuesta(id)
                    ON DELETE RESTRICT ON UPDATE RESTRICT
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
            } else if (accion === 'crear_indice') {
                await connection.query(`ALTER TABLE registros_entrega_respuesta
                    ADD INDEX idx_entrega_fecha(respuesta_id,fecha_actuacion_utc,id)`);
            } else {
                throw new Error(`Accion de reparacion no permitida: ${accion}.`);
            }
            completados++;
            const despues = await leerEstado(connection);
            if (despues.estado !== 'aplicada') {
                throw new Error(`La verificacion posterior a ${accion} no dejo 029 aplicada.`);
            }
        }
        return { estado: 'aplicada', acciones: [], cambios: completados, requiere_confirmacion: false };
    } catch (error) {
        throw new Error(`029 reparacion interrumpida tras ${completados} DDL; commit implicito, inspecciona antes de reintentar. ${error.message}`, { cause: error });
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const valido = args.length === 1 && ['--verificar', '--aplicar', '--inspeccionar', '--reparar'].includes(args[0]) ||
        args.length === 2 && args[0] === '--reparar' && args[1] === '--confirmar';
    if (!valido) {
        console.error('Uso: node migrations\\029_fecha_real_entrega.js --verificar|--aplicar|--inspeccionar|--reparar [--confirmar]');
        process.exitCode = 1;
    } else {
        const pool = require('../db');
        (async () => {
            const c = await pool.getConnection();
            try {
                let resultado;
                if (args[0] === '--inspeccionar') resultado = await inspeccionarFechaRealEntrega(c);
                else if (args[0] === '--reparar') resultado = await repararFechaRealEntrega(c, { confirmar: args[1] === '--confirmar' });
                else resultado = await migrarFechaRealEntrega(c, { aplicar: args[0] === '--aplicar' });
                console.log(resultado);
            }
            finally { c.release(); await pool.end(); }
        })().catch(error => { console.error(error.message); process.exitCode = 1; });
    }
}
module.exports = { migrarFechaRealEntrega, verificar, inspeccionarFechaRealEntrega, repararFechaRealEntrega };
