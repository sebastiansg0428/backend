const test = require('node:test');
const assert = require('node:assert/strict');
const {
    inspeccionarFechaRealEntrega,
    repararFechaRealEntrega,
} = require('../migrations/029_fecha_real_entrega');

function crearConexion({
    tabla = 'ausente',
    indice = false,
    indiceIncompatible = false,
    columnaIncompatible = false,
    fkIncompatible = false,
    errorMetadata = false,
    errorDDL = false,
} = {}) {
    const estado = { tabla, indice };
    const consultas = [];
    const ddl = [];
    const tablas026 = [
        { TABLE_NAME: 'entregas_confirmacion', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_unicode_ci' },
        { TABLE_NAME: 'documentos_entrega_origen', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_unicode_ci' },
    ];

    return {
        estado,
        consultas,
        ddl,
        async query(sql, valores = []) {
            consultas.push({ sql, valores });
            if (errorMetadata && sql.includes('information_schema')) {
                throw Object.assign(new Error('Metadata fixture'), { code: 'ER_ACCESS_DENIED_ERROR' });
            }
            if (sql.startsWith('CREATE TABLE entregas_fecha_real')) {
                ddl.push(sql);
                if (errorDDL) throw new Error('DDL fixture');
                estado.tabla = 'correcta';
                return [];
            }
            if (sql.startsWith('ALTER TABLE registros_entrega_respuesta')) {
                ddl.push(sql);
                if (errorDDL) throw new Error('DDL fixture');
                estado.indice = true;
                return [];
            }
            if (sql.includes("TABLE_NAME IN ('entregas_confirmacion','documentos_entrega_origen')")) {
                return [tablas026];
            }
            if (sql.includes("TABLE_NAME='entregas_fecha_real'") && sql.includes('information_schema.TABLES')) {
                if (estado.tabla === 'ausente') return [[]];
                return [[{
                    ENGINE: estado.tabla === 'incompatible' ? 'MyISAM' : 'InnoDB',
                    TABLE_COLLATION: estado.tabla === 'incompatible' ? 'utf8mb4_general_ci' : 'utf8mb4_unicode_ci',
                }]];
            }
            if (sql.includes("INDEX_NAME='idx_entrega_fecha'")) {
                if (!estado.indice) return [[]];
                if (indiceIncompatible) return [[{ COLUMN_NAME: 'respuesta_id', NON_UNIQUE: 0 }]];
                return [[
                    { COLUMN_NAME: 'respuesta_id', NON_UNIQUE: 1 },
                    { COLUMN_NAME: 'fecha_actuacion_utc', NON_UNIQUE: 1 },
                    { COLUMN_NAME: 'id', NON_UNIQUE: 1 },
                ]];
            }
            if (sql.includes("TABLE_NAME='entregas_fecha_real'") && sql.includes('information_schema.COLUMNS')) {
                return [[
                    { COLUMN_NAME: 'registro_id', COLUMN_TYPE: 'bigint unsigned', IS_NULLABLE: 'NO', EXTRA: '' },
                    { COLUMN_NAME: 'justificacion_fecha_anterior', COLUMN_TYPE: columnaIncompatible ? 'varchar(255)' : 'varchar(2000)', IS_NULLABLE: 'YES', EXTRA: '' },
                ]];
            }
            if (sql.includes("TABLE_NAME='entregas_fecha_real'") && sql.includes("INDEX_NAME='PRIMARY'")) {
                return [[{ COLUMN_NAME: 'registro_id' }]];
            }
            if (sql.includes("TABLE_NAME='entregas_fecha_real'") && sql.includes('information_schema.KEY_COLUMN_USAGE')) {
                return [[{
                    CONSTRAINT_NAME: 'fk_fecha_real_entrega',
                    COLUMN_NAME: 'registro_id',
                    REFERENCED_TABLE_NAME: 'registros_entrega_respuesta',
                    REFERENCED_COLUMN_NAME: 'id',
                    REFERENCED_TABLE_SCHEMA: 'fixture',
                    base: 'fixture',
                    UPDATE_RULE: fkIncompatible ? 'CASCADE' : 'RESTRICT',
                    DELETE_RULE: 'RESTRICT',
                }]];
            }
            if (sql.includes('information_schema.COLUMNS') && sql.includes('TABLE_NAME=?')) {
                const tabla026 = valores[0];
                return [[
                    { COLUMN_NAME: tabla026 === 'entregas_confirmacion' ? 'registro_id' : 'evidencia_id',
                        COLUMN_TYPE: 'bigint unsigned', IS_NULLABLE: 'NO', EXTRA: '' },
                    ...(tabla026 === 'documentos_entrega_origen'
                        ? [{ COLUMN_NAME: 'origen', COLUMN_TYPE: "enum('documento_respuesta','evidencia_adicional')", IS_NULLABLE: 'NO', EXTRA: '' }]
                        : []),
                ]];
            }
            if (sql.includes('information_schema.STATISTICS') && sql.includes('TABLE_NAME=?')) {
                return [[{ COLUMN_NAME: valores[0] === 'entregas_confirmacion' ? 'registro_id' : 'evidencia_id' }]];
            }
            if (sql.includes('information_schema.KEY_COLUMN_USAGE') && sql.includes('TABLE_NAME=?')) {
                const tabla026 = valores[0];
                const campo = tabla026 === 'entregas_confirmacion' ? 'registro_id' : 'evidencia_id';
                return [[{
                    CONSTRAINT_NAME: tabla026 === 'entregas_confirmacion' ? 'fk_confirmacion_entrega' : 'fk_origen_evidencia',
                    COLUMN_NAME: campo,
                    REFERENCED_TABLE_NAME: tabla026 === 'entregas_confirmacion'
                        ? 'registros_entrega_respuesta' : 'evidencias_entrega',
                    REFERENCED_COLUMN_NAME: 'id',
                    REFERENCED_TABLE_SCHEMA: 'fixture',
                    base: 'fixture',
                    UPDATE_RULE: 'RESTRICT',
                    DELETE_RULE: 'RESTRICT',
                }]];
            }
            assert.fail(`Consulta inesperada: ${sql}`);
        },
    };
}

test('029 inspecciona un esquema ausente sin ejecutar DDL', async () => {
    const connection = crearConexion();

    assert.deepEqual(await inspeccionarFechaRealEntrega(connection), {
        estado: 'ausente',
        acciones: [],
        cambios: 0,
        requiere_confirmacion: false,
        siguiente: 'usar_aplicar',
    });
    assert.equal(connection.ddl.length, 0);
});

test('029 reconoce el esquema aplicado y no propone cambios', async () => {
    const connection = crearConexion({ tabla: 'correcta', indice: true });

    assert.deepEqual(await inspeccionarFechaRealEntrega(connection), {
        estado: 'aplicada',
        acciones: [],
        cambios: 0,
        requiere_confirmacion: false,
    });
});

test('029 clasifica tabla compatible sin indice como reparable', async () => {
    const connection = crearConexion({ tabla: 'correcta' });

    const resultado = await repararFechaRealEntrega(connection);

    assert.equal(resultado.estado, 'parcial_reparable');
    assert.deepEqual(resultado.acciones, ['crear_indice']);
    assert.equal(resultado.cambios, 0);
    assert.equal(resultado.requiere_confirmacion, true);
    assert.equal(connection.ddl.length, 0);
});

test('029 con confirmacion crea solo el indice faltante y verifica el resultado', async () => {
    const connection = crearConexion({ tabla: 'correcta' });

    const resultado = await repararFechaRealEntrega(connection, { confirmar: true });

    assert.deepEqual(resultado, {
        estado: 'aplicada',
        acciones: [],
        cambios: 1,
        requiere_confirmacion: false,
    });
    assert.equal(connection.ddl.length, 1);
    assert.match(connection.ddl[0], /ADD INDEX idx_entrega_fecha/);
});

test('029 puede completar la tabla cuando el indice compatible ya existe', async () => {
    const connection = crearConexion({ tabla: 'ausente', indice: true });

    const resultado = await repararFechaRealEntrega(connection, { confirmar: true });

    assert.equal(resultado.estado, 'aplicada');
    assert.equal(resultado.cambios, 1);
    assert.equal(connection.ddl.length, 1);
    assert.match(connection.ddl[0], /CREATE TABLE entregas_fecha_real/);
});

test('029 rechaza estructuras incompatibles sin ejecutar DDL', async () => {
    for (const opciones of [
        { tabla: 'incompatible' },
        { tabla: 'correcta', indice: true, indiceIncompatible: true },
        { tabla: 'correcta', columnaIncompatible: true },
        { tabla: 'correcta', fkIncompatible: true },
    ]) {
        const connection = crearConexion(opciones);
        const resultado = await repararFechaRealEntrega(connection, { confirmar: true });

        assert.equal(resultado.estado, 'incompatible');
        assert.equal(connection.ddl.length, 0);
    }
});

test('029 devuelve estado indeterminado ante error de metadatos', async () => {
    const connection = crearConexion({ errorMetadata: true });

    const resultado = await inspeccionarFechaRealEntrega(connection);

    assert.equal(resultado.estado, 'indeterminada');
    assert.equal(resultado.cambios, 0);
    assert.equal(connection.ddl.length, 0);
});

test('029 exige confirmacion booleana y reporta DDL interrumpido', async () => {
    const connection = crearConexion({ tabla: 'ausente', indice: true, errorDDL: true });

    await assert.rejects(
        repararFechaRealEntrega(connection, { confirmar: 'true' }),
        /confirmar debe ser booleano/
    );
    await assert.rejects(
        repararFechaRealEntrega(connection, { confirmar: true }),
        error => /029 reparacion interrumpida tras 0 DDL/.test(error.message) && error.cause.message === 'DDL fixture'
    );
    assert.equal(connection.ddl.length, 1);
});
