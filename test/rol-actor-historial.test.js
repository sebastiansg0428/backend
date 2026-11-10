const test = require('node:test');
const assert = require('node:assert/strict');
const { migrarRolActor } = require('../migrations/028_rol_actor_historial');
const { registrarEventoRadicado } = require('../audit-log');

function esquema(rol) {
    const columnas = ['event_type', 'actor_id', 'actor_name'].map(COLUMN_NAME => ({ COLUMN_NAME }));
    if (rol) columnas.push(rol);
    const escrituras = [];
    return {
        escrituras,
        async query(sql) {
            if (sql.startsWith('SELECT')) return [columnas];
            assert.equal(sql, 'ALTER TABLE historial_radicado ADD COLUMN actor_role VARCHAR(20) NULL DEFAULT NULL AFTER actor_name');
            escrituras.push(sql);
            columnas.push({ COLUMN_NAME: 'actor_role', COLUMN_TYPE: 'varchar(20)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: null });
            return [{}];
        },
    };
}

test('028 verifica sin escribir y aplica una sola columna nullable sin reconstruir eventos', async () => {
    const c = esquema();
    assert.deepEqual(await migrarRolActor(c), { estado: 'pendiente' });
    assert.equal(c.escrituras.length, 0);
    assert.deepEqual(await migrarRolActor(c, { aplicar: true }), { estado: 'aplicada' });
    assert.deepEqual(await migrarRolActor(c, { aplicar: true }), { estado: 'aplicada' });
    assert.equal(c.escrituras.length, 1);
});

test('028 rechaza esquema base ausente, columna incompatible y opciones invalidas', async () => {
    await assert.rejects(migrarRolActor({ query: async () => [[]] }, { aplicar: true }), /021/);
    for (const cambio of [
        { COLUMN_TYPE: 'varchar(10)' }, { IS_NULLABLE: 'NO' }, { COLUMN_DEFAULT: 'administrador' },
    ]) {
        const c = esquema({ COLUMN_NAME: 'actor_role', COLUMN_TYPE: 'varchar(20)', IS_NULLABLE: 'YES',
            COLUMN_DEFAULT: null, ...cambio });
        await assert.rejects(migrarRolActor(c, { aplicar: true }), /incompatible/);
        assert.equal(c.escrituras.length, 0);
    }
    await assert.rejects(migrarRolActor({}, { aplicar: 'si' }), TypeError);
});

test('028 propaga fallo DDL sin intentar rellenar historicos', async () => {
    const c = esquema();
    const query = c.query.bind(c);
    const fallo = new Error('DDL denegado');
    c.query = async sql => {
        if (sql.startsWith('ALTER')) throw fallo;
        return query(sql);
    };
    await assert.rejects(migrarRolActor(c, { aplicar: true }), error => error === fallo);
    assert.equal(c.escrituras.length, 0);
});

test('028 reconoce DEFAULT NULL de MariaDB sin aceptar un literal de texto', async () => {
    const columna = { COLUMN_NAME: 'actor_role', COLUMN_TYPE: 'varchar(20)', IS_NULLABLE: 'YES', COLUMN_DEFAULT: 'NULL' };
    const c = esquema(columna);
    assert.deepEqual(await migrarRolActor(c), { estado: 'aplicada' });
    assert.equal(c.escrituras.length, 0);
    await assert.rejects(migrarRolActor(esquema({ ...columna, COLUMN_DEFAULT: "'NULL'" })), /incompatible/);
});

for (const rol of ['administrador', 'ventanilla', 'funcionario']) {
    test(`auditoria conserva snapshot autenticado ${rol} sin aceptar rol del evento`, async () => {
        const registros = [];
        const c = { execute: async (sql, valores) => {
            assert.match(sql, /actor_role/);
            registros.push([...valores]);
        } };
        const req = { usuario: { id: 1, nombre: 'Actor de prueba', rol } };
        for (const tipo of ['traslado_solicitado', 'traslado_aprobado', 'traslado_rechazado']) {
            await registrarEventoRadicado(c, req, { numeroRadicado: 'RAD-PRUEBA', tipo,
                motivo: 'Actuacion de prueba', actor_role: 'rol-no-confiable' });
        }
        req.usuario.rol = 'otro';
        assert.deepEqual(registros.map(valores => valores[15]), [rol, rol, rol]);
    });
}

test('auditoria rechaza roles ausentes o invalidos antes de escribir', async () => {
    for (const rol of [undefined, null, '', 'Administrador', 'otro']) {
        const c = { execute: async () => assert.fail('No debe escribir') };
        await assert.rejects(registrarEventoRadicado(c, { usuario: { id: 1, nombre: 'Actor', rol } },
            { numeroRadicado: 'RAD-PRUEBA', tipo: 'traslado_aprobado' }), /rol/);
    }
});
