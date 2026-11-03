const test = require('node:test');
const assert = require('node:assert/strict');
const { CANTIDAD, configuracion, numerosLote, sembrar } = require('../scripts/sembrar-radicados');

function fixture({ falloInsercion = false, duplicado = false, falloRollback = false, base = 'ventanilla_unica' } = {}) {
    const escrituras = [];
    let commits = 0;
    let rollbacks = 0;
    let liberaciones = 0;
    let destrucciones = 0;
    let transacciones = 0;
    const numeros = numerosLote('SEED-prueba');
    const secuencia = [{ ano: 2026, ultimo_numero: 29 }];
    const connection = {
        async beginTransaction() { transacciones++; },
        async execute(sql, valores = []) {
            if (/^\s*INSERT/.test(sql)) {
                escrituras.push({ sql, valores });
                if (falloInsercion && escrituras.length === 50) throw new Error('Escritura fallida');
                return [{ affectedRows: 1 }];
            }
            if (sql.includes('DATABASE()')) return [[{ nombre: base }]];
            if (sql.includes('FROM dependencias')) return [[{ id: 6, nombre: 'Oficina de Planeacion' }]];
            if (sql.includes('FROM usuarios')) return [[{ id: 2, nombre: 'Actor ficticio' }]];
            if (sql.includes('FROM tipos_tramite')) return [[{
                id: 1, nombre: 'Solicitud ficticia', termino_legal_id: 1,
                dias: 10, tipo_dias: 'habiles', fundamento_legal: 'Regla de prueba'
            }]];
            if (sql.includes('UNION ALL')) return [duplicado ? [{ numero_radicado: numeros[0] }] : []];
            if (sql.includes('FROM secuencias_radicado')) return [secuencia];
            if (sql.includes('GROUP BY numero_radicado')) {
                return [numeros.map(numero_radicado => ({ numero_radicado, tipos: 3, total: 3 }))];
            }
            if (sql.includes('JOIN radicado_terminos')) return [[{ total: 100 }]];
            if (sql.includes('COUNT(*)')) {
                if (!sql.includes('WHERE')) return [[{ total: 3 }]];
                const total = sql.includes('FROM historial_radicado') ? 300 :
                    /FROM (documentos_radicado|respuestas_radicado)/.test(sql) ? 0 : 100;
                return [[{ total }]];
            }
            throw new Error(`SQL inesperado: ${sql}`);
        },
        async commit() { commits++; },
        async rollback() {
            rollbacks++;
            if (falloRollback) throw new Error('Rollback fallido');
        },
        release() { liberaciones++; },
        destroy() { destrucciones++; }
    };
    return { pool: { async getConnection() { return connection; } }, escrituras,
        estado: () => ({ commits, rollbacks, liberaciones, destrucciones, transacciones }) };
}

test('seeding requiere base explicita, confirmacion y prefijo seguro', () => {
    assert.throws(() => configuracion(['--confirmar-desarrollo'], {}), /DB_NAME/);
    assert.throws(() => configuracion(['--confirmar-desarrollo'], { DB_NAME: 'ventanilla_unica_test' }), /otra base/);
    assert.throws(() => configuracion([], { DB_NAME: 'ventanilla_unica' }), /confirmar-desarrollo/);
    for (const args of [['--desconocido'], ['--lote=RAD-001'], ['--lote=SEED-x_y'],
        ['--lote=SEED-a', '--lote=SEED-b']]) {
        assert.throws(() => configuracion([...args, '--inspeccionar'], { DB_NAME: 'ventanilla_unica' }));
    }
    assert.equal(configuracion(['--inspeccionar'], { DB_NAME: 'ventanilla_unica' }).inspeccionar, true);
    const numeros = numerosLote('SEED-prueba');
    assert.equal(numeros.length, CANTIDAD);
    assert.equal(new Set(numeros).size, 100);
    assert.equal(numeros[0], 'SEED-prueba-0001');
    assert.equal(numeros.at(-1), 'SEED-prueba-0100');
});

test('seeding inspecciona sin escrituras y rechaza conexion equivocada', async () => {
    const f = fixture();
    const resultado = await sembrar(f.pool, { lote: 'SEED-prueba', inspeccionar: true });
    assert.equal(resultado.escrito, false);
    assert.equal(f.escrituras.length, 0);
    assert.equal(f.estado().transacciones, 0);
    assert.equal(f.estado().liberaciones, 1);
    const equivocada = fixture({ base: 'otra_base' });
    await assert.rejects(sembrar(equivocada.pool, { lote: 'SEED-prueba', inspeccionar: false }), /conexion/);
    assert.equal(equivocada.escrituras.length, 0);
    assert.equal(equivocada.estado().rollbacks, 1);
});

test('seeding confirma exactamente 100 radicados, snapshots y 300 eventos sin PDFs ni secuencia', async () => {
    const f = fixture();
    const resultado = await sembrar(f.pool, { lote: 'SEED-prueba', inspeccionar: false });
    const radicados = f.escrituras.filter(({ sql }) => sql.includes('INSERT INTO radicados'));
    assert.equal(radicados.length, 100);
    assert.equal(f.escrituras.filter(({ sql }) => sql.includes('INSERT INTO radicado_terminos')).length, 100);
    assert.equal(f.escrituras.filter(({ sql }) => sql.includes('INSERT INTO comunicaciones_externas')).length, 100);
    const eventos = f.escrituras.filter(({ sql }) => sql.includes('INSERT INTO historial_radicado'));
    assert.equal(eventos.length, 300);
    assert.ok(eventos.every(({ valores }) => valores[12] === null && valores[13] === null));
    assert.ok(eventos.every(({ valores }) => valores[5].includes('SEED automatizado')));
    assert.ok(f.escrituras.every(({ sql }) => !/secuencias_radicado|documentos_|respuestas_/.test(sql)));
    assert.equal(new Set(radicados.map(({ valores }) => valores[0])).size, 100);
    assert.deepEqual(resultado.secuencia_antes, resultado.secuencia_despues);
    assert.equal(resultado.escrito, true);
    assert.deepEqual(f.estado(), { commits: 1, rollbacks: 0, liberaciones: 1, destrucciones: 0, transacciones: 1 });
});

test('seeding rechaza lote repetido y revierte escrituras incompletas', async () => {
    const duplicada = fixture({ duplicado: true });
    await assert.rejects(sembrar(duplicada.pool, { lote: 'SEED-prueba' }), /ya existe/);
    assert.equal(duplicada.escrituras.length, 0);
    assert.equal(duplicada.estado().rollbacks, 1);
    const fallida = fixture({ falloInsercion: true });
    await assert.rejects(sembrar(fallida.pool, { lote: 'SEED-prueba' }), /Escritura fallida/);
    assert.equal(fallida.estado().commits, 0);
    assert.equal(fallida.estado().rollbacks, 1);
    assert.equal(fallida.estado().liberaciones, 1);
    const rota = fixture({ falloInsercion: true, falloRollback: true });
    await assert.rejects(sembrar(rota.pool, { lote: 'SEED-prueba' }), AggregateError);
    assert.equal(rota.estado().destrucciones, 1);
    assert.equal(rota.estado().liberaciones, 0);
});
