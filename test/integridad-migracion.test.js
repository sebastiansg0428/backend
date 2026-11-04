const test = require('node:test');
const assert = require('node:assert/strict');
const { inspeccionar, migrarIntegridad, verificarDatos } = require('../migrations/024_integridad_referencial');

function esquema(longitud = 50) {
    const campos = {
        radicados: { numero_radicado: `varchar(${longitud})` },
        radicado_dependencias: { id: 'bigint(20) unsigned', numero_radicado: 'varchar(100)' },
        terminos_legales: { id: 'int(11)', tipo_tramite_id: 'int(11)' },
        usuarios: { id: 'int(11)' }, dependencias: { id: 'int(11)' },
        radicado_terminos: { numero_radicado: 'varchar(100)', termino_legal_id: 'int(11)', tipo_tramite_id: 'int(11)' },
        ampliaciones_termino: { numero_radicado: 'varchar(100)' },
        historial_radicado: { numero_radicado: 'varchar(100)', actor_id: 'int(11)', dependencia_id: 'int(11)', radicado_dependencia_id: 'bigint(20) unsigned' },
        intentos_radicacion: { numero_radicado: 'varchar(100)', actor_id: 'int(11)' },
        respuestas_radicado: { numero_radicado: 'varchar(100)', radicado_dependencia_id: 'bigint(20) unsigned' },
    };
    return {
        base: 'fixture', claves_activas: 1,
        tablas: Object.keys(campos).map(TABLE_NAME => ({ TABLE_NAME, ENGINE: 'InnoDB' })),
        columnas: Object.entries(campos).flatMap(([TABLE_NAME, columnas]) => Object.entries(columnas).map(([COLUMN_NAME, COLUMN_TYPE]) => ({
            TABLE_NAME, COLUMN_NAME, COLUMN_TYPE,
            IS_NULLABLE: COLUMN_NAME === 'numero_radicado' && TABLE_NAME !== 'intentos_radicacion' ? 'NO' : 'YES', EXTRA: '',
            CHARACTER_SET_NAME: COLUMN_TYPE.startsWith('varchar') ? 'utf8mb4' : null,
            COLLATION_NAME: COLUMN_TYPE.startsWith('varchar') ? 'utf8mb4_unicode_ci' : null,
        }))),
        indices: ['radicados', 'usuarios', 'dependencias', 'radicado_dependencias', 'terminos_legales'].map(TABLE_NAME => ({
            TABLE_NAME, INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, SEQ_IN_INDEX: 1,
            COLUMN_NAME: TABLE_NAME === 'radicados' ? 'numero_radicado' : 'id', SUB_PART: null,
        })), referencias: [],
    };
}

test('024 prevalidacion conserva VARCHAR50/100 y arma padres antes de hijas', () => {
    for (const longitud of [50, 100]) {
        const plan = inspeccionar(esquema(longitud));
        assert.equal(plan.estado, 'pendiente');
        assert.equal(plan.pasos.length, 7);
        assert.match(plan.pasos[0], /ALTER TABLE `radicado_dependencias`/);
        assert.match(plan.pasos[1], /ALTER TABLE `terminos_legales`/);
        const ddl = plan.pasos.join('\n');
        assert.equal((ddl.match(/FOREIGN KEY/g) || []).length, 11);
        assert.match(ddl, /CASE WHEN radicado_dependencia_id IS NULL THEN numero_radicado ELSE NULL END/);
        assert.doesNotMatch(ddl, /CASCADE|DROP |MODIFY |DELETE FROM|FOREIGN_KEY_CHECKS/);
        assert.equal((ddl.match(/ON UPDATE RESTRICT/g) || []).length, 11);
    }
});

test('024 no agrega indices cubiertos por claves existentes', () => {
    const meta = esquema();
    meta.indices.push({ TABLE_NAME: 'historial_radicado', INDEX_NAME: 'actor_existente',
        NON_UNIQUE: 1, SEQ_IN_INDEX: 1, COLUMN_NAME: 'actor_id', SUB_PART: null });
    assert.doesNotMatch(inspeccionar(meta).pasos.join('\n'), /ADD INDEX `idx_024_historial_actor`/);
});

test('024 rechaza tipos, collation, nulabilidad, motor y esquemas parciales', () => {
    const casos = [
        m => { m.claves_activas = 0; },
        m => { m.tablas[0].ENGINE = 'MyISAM'; },
        m => { m.columnas.find(c => c.TABLE_NAME === 'historial_radicado' && c.COLUMN_NAME === 'actor_id').COLUMN_TYPE = 'int unsigned'; },
        m => { m.columnas.find(c => c.TABLE_NAME === 'radicado_terminos' && c.COLUMN_NAME === 'numero_radicado').COLLATION_NAME = 'otra'; },
        m => { m.columnas.find(c => c.TABLE_NAME === 'radicado_terminos' && c.COLUMN_NAME === 'termino_legal_id').IS_NULLABLE = 'NO'; },
        m => { m.indices.push({ TABLE_NAME: 'historial_radicado', INDEX_NAME: 'idx_024_historial_actor', COLUMN_NAME: 'actor_id', NON_UNIQUE: 1, SUB_PART: null }); },
    ];
    for (const cambiar of casos) {
        const meta = esquema(); cambiar(meta);
        assert.throws(() => inspeccionar(meta));
    }
});

test('024 acumula conteos de incompatibilidades sin mostrar filas ni hacer DDL', async () => {
    let llamadas = 0;
    await assert.rejects(verificarDatos({
        async query(sql) {
            assert.match(sql, /^SELECT COUNT/);
            return [[{ cantidad: ++llamadas === 1 || llamadas === 12 ? 2 : 0 }]];
        },
    }), /fk_024_radicado_terminos: 2.*respuestas_individuales_duplicadas: 2/);
    assert.equal(llamadas, 12);
});

function conexion(meta, { invalido = false, fallaDDL = false } = {}) {
    const consultas = [];
    return {
        consultas,
        async query(sql) {
            consultas.push(sql);
            if (sql.includes('information_schema.TABLES')) return [meta.tablas];
            if (sql.includes('information_schema.COLUMNS')) return [meta.columnas];
            if (sql.includes('information_schema.STATISTICS')) return [meta.indices];
            if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [meta.referencias];
            if (sql.includes('SELECT DATABASE()')) return [[{ base: meta.base, claves_activas: 1 }]];
            if (sql.startsWith('SELECT COUNT')) return [[{ cantidad: invalido ? 1 : 0 }]];
            if (fallaDDL && sql.startsWith('ALTER')) throw new Error('DDL fixture');
            assert.fail(`Consulta inesperada: ${sql}`);
        },
    };
}

test('024 verificar es solo lectura y datos invalidos impiden el primer ALTER', async () => {
    const c = conexion(esquema());
    await assert.rejects(migrarIntegridad(c, { aplicar: 'false' }), /aplicar debe ser booleano/);
    assert.equal(c.consultas.length, 0);
    assert.deepEqual(await migrarIntegridad(c), { estado: 'pendiente', cambios: 7, aplicada: false });
    assert.ok(c.consultas.every(sql => sql.startsWith('SELECT')));
    const incompatible = conexion(esquema(), { invalido: true });
    await assert.rejects(migrarIntegridad(incompatible, { aplicar: true }), /Datos incompatibles/);
    assert.ok(incompatible.consultas.every(sql => sql.startsWith('SELECT')));
});

test('024 explicita que un fallo DDL no se puede revertir con rollback', async () => {
    const c = conexion(esquema(), { fallaDDL: true });
    await assert.rejects(migrarIntegridad(c, { aplicar: true }), error =>
        /tras 0 ALTER.*no admite rollback/s.test(error.message) && error.cause.message === 'DDL fixture');
});
