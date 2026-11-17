const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEnum, inspeccionarEstadoEntregado, migrarEstadoEntregado } = require('../migrations/030_estado_entregado');

const tipoBase = "enum('Recibido','En trámite','Pendiente','Respondido','Vencido','Enterado')";
function conexion(tipo = tipoBase) {
    const llamadas = [];
    let tipoActual = tipo;
    return {
        llamadas,
        query: async sql => {
            llamadas.push(sql);
            if (sql.startsWith('SHOW FULL COLUMNS')) return [[{ Type: tipoActual, Null: 'NO', Default: 'Recibido', Collation: 'utf8mb4_unicode_ci' }]];
            if (sql.startsWith('ALTER TABLE')) tipoActual = "enum('Recibido','En trámite','Pendiente','Respondido','Vencido','Enterado','Entregado')";
            return [[]];
        }
    };
}

test('030 analiza y amplía solo el ENUM de estados sin perder valores', async () => {
    assert.deepEqual(parseEnum(tipoBase), ['Recibido', 'En trámite', 'Pendiente', 'Respondido', 'Vencido', 'Enterado']);
    const c = conexion();
    assert.equal((await inspeccionarEstadoEntregado(c)).estado, 'pendiente');
    const resultado = await migrarEstadoEntregado(c, { aplicar: true });
    assert.deepEqual(resultado, { estado: 'aplicada', cambios: 1 });
    const ddl = c.llamadas.find(sql => sql.startsWith('ALTER TABLE'));
    assert.match(ddl, /'Enterado','Entregado'/);
    assert.doesNotMatch(ddl, /UPDATE|DELETE/i);
});

test('030 reconoce ENUM ya aplicado y VARCHAR suficiente', async () => {
    assert.equal((await inspeccionarEstadoEntregado(conexion("enum('Recibido','En trámite','Pendiente','Respondido','Vencido','Enterado','Entregado')"))).estado, 'aplicada');
    assert.equal((await inspeccionarEstadoEntregado(conexion('varchar(30)'))).estado, 'aplicada');
});

test('030 rechaza esquemas incompatibles antes de ejecutar DDL', async () => {
    const c = conexion("enum('Recibido','Respondido')");
    await assert.rejects(migrarEstadoEntregado(c, { aplicar: true }), /no aplicable/i);
    assert.equal(c.llamadas.length, 1);
});
