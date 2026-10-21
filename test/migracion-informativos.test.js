const test = require('node:test');
const assert = require('node:assert/strict');
const { migrar } = require('../migrations/020_informativos_sin_respuesta');

test('020 preserva ENUM existente o VARCHAR y no altera radicados históricos', async () => {
    for (const Type of ["enum('Recibido','En trámite','Pendiente','Respondido','Vencido')", 'varchar(30)']) {
        const sentencias = [];
        const conexion = {
            async query(sql) {
                sentencias.push(sql);
                if (sql.startsWith('SHOW FULL')) {
                    return [[{ Field: 'estado', Type, Default: 'Recibido', Null: 'NO',
                        Collation: 'utf8mb4_unicode_ci' }]];
                }
                return [{}];
            },
            async execute(sql, valores) {
                sentencias.push(sql);
                assert.deepEqual(valores, ['informativo']);
                return [{}];
            }
        };
        await migrar(conexion);
        assert.equal(sentencias.some(s => /UPDATE radicados|DELETE|DROP COLUMN/.test(s)), false);
        assert.ok(sentencias.some(s => /MODIFY COLUMN termino_legal_id INT NULL/.test(s)));
        const cambioEstado = sentencias.find(s => /MODIFY COLUMN estado/.test(s));
        if (Type.startsWith('enum')) {
            assert.ok(cambioEstado.includes("'Vencido','Enterado'"));
        } else assert.equal(cambioEstado, undefined);
    }
});

test('020 se detiene antes de escrituras si detecta esquema parcial', async () => {
    const escrituras = [];
    await assert.rejects(migrar({
        async query(sql) {
            if (!sql.startsWith('SHOW FULL')) escrituras.push(sql);
            return [[{ Field: 'requiere_respuesta' }]];
        }
    }), /parcial/);
    assert.deepEqual(escrituras, []);
});
