const test = require('node:test');
const assert = require('node:assert/strict');
const {
    BASE, configuracion, resumen, inspeccionar, insertar, cargar
} = require('../scripts/medir-audit-log');

test('benchmark exige nombre exacto de base antes de conectar', () => {
    for (const nombre of [undefined, '', 'ventanilla_unica', 'ventanilla_unica_test_otro', ' ventanilla_unica_test']) {
        assert.throws(() => configuracion({ DB_NAME: nombre }), /exactamente/);
    }
    assert.equal(configuracion({ DB_NAME: BASE }).database, BASE);
});

test('metricas usan percentil de rango mas cercano y no mutan las muestras', () => {
    const tiempos = [5, 1, 4, 2, 3];
    assert.deepEqual(resumen(tiempos), {
        muestras: 5, promedio_ms: 3, p50_ms: 3, p95_ms: 5, max_ms: 5
    });
    assert.deepEqual(tiempos, [5, 1, 4, 2, 3]);
    for (const muestra of [[], [NaN], [-1], [Infinity]]) assert.throws(() => resumen(muestra));
});

test('inspeccion y carga bloquean base distinta antes de consultar tablas o escribir', async () => {
    let llamadas = 0;
    const connection = { async execute(sql) {
        llamadas++;
        assert.match(sql, /^SELECT DATABASE/);
        return [[{ base: 'ventanilla_unica' }]];
    } };
    await assert.rejects(inspeccionar(connection), /no apunta/);
    await assert.rejects(cargar(connection, { base: BASE, faltantes: [] }), /bloqueada/);
    assert.equal(llamadas, 2);
});

test('inspeccion detecta esquema incompleto sin DML y carga no lo migra', async () => {
    const connection = { async execute(sql) {
        assert.match(sql, /^SELECT/);
        if (sql.startsWith('SELECT DATABASE')) return [[{ base: BASE, version: 'test' }]];
        return [[]];
    } };
    const esquema = await inspeccionar(connection);
    assert.ok(esquema.faltantes.includes('historial_radicado.ocurrido_en_utc'));
    assert.ok(esquema.faltantes.includes('radicados.requiere_respuesta'));
    assert.ok(esquema.faltantes.includes('idx_historial_sesion'));
    await assert.rejects(cargar(connection, esquema), /Esquema incompatible/);
});

const columnas = [{
    TABLE_NAME: 'radicados', COLUMN_NAME: 'numero_radicado',
    IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: ''
}];

test('insercion confirma radicado y eventos en la misma transaccion y sesion sintetica', async () => {
    const pasos = [];
    const sesiones = [];
    const connection = {
        async beginTransaction() { pasos.push('inicio'); },
        async execute(sql, valores) {
            if (sql.includes('INSERT INTO historial_radicado')) {
                pasos.push('evento');
                sesiones.push(valores[12]);
            } else {
                assert.match(sql, /INSERT INTO radicados/);
                assert.deepEqual(valores, ['CARGA-PRUEBA-1']);
                pasos.push('radicado');
            }
            return [{ affectedRows: 1 }];
        },
        async commit() { pasos.push('commit'); }
    };
    const tiempo = await insertar(connection, columnas, 'CARGA-PRUEBA-1', 10);
    assert.ok(tiempo >= 0);
    assert.deepEqual(pasos, ['inicio', 'radicado', ...Array(10).fill('evento'), 'commit']);
    assert.equal(new Set(sesiones).size, 1);
});

test('fallos de evento revierten la transaccion; fallo de rollback destruye la conexion', async () => {
    for (const falloRollback of [false, true]) {
        const pasos = [];
        const original = new Error('Evento fallido');
        const connection = {
            async beginTransaction() {},
            async execute(sql) {
                if (sql.includes('historial_radicado')) throw original;
                return [{ affectedRows: 1 }];
            },
            async commit() { assert.fail('No debe confirmar'); },
            async rollback() { pasos.push('rollback'); if (falloRollback) throw new Error('Rollback fallido'); },
            destroy() { pasos.push('destroy'); }
        };
        await assert.rejects(insertar(connection, columnas, 'CARGA-PRUEBA-1', 10),
            error => falloRollback ? error instanceof AggregateError && error.errors[0] === original : error === original);
        assert.deepEqual(pasos, falloRollback ? ['rollback', 'destroy'] : ['rollback']);
    }
});

test('no inventa valores para columnas obligatorias desconocidas', async () => {
    await assert.rejects(insertar({}, [...columnas, {
        TABLE_NAME: 'radicados', COLUMN_NAME: 'campo_nuevo',
        IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: ''
    }], 'CARGA-PRUEBA', 10), /Campos obligatorios no cubiertos/);
});

test('carga verifica etapas acumuladas, conteos y cursor sin duplicados', async () => {
    let prefijo;
    let radicados = 0;
    let eventos = 0;
    let escrituras = 0;
    const connection = {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        async execute(sql, valores = []) {
            if (sql.startsWith('SELECT DATABASE')) return [[{ base: BASE }]];
            if (sql.includes('INSERT INTO radicados')) {
                radicados++;
                escrituras++;
                if (!prefijo) prefijo = valores[0].replace(/-CURSOR$/, '');
                return [{ affectedRows: 1 }];
            }
            if (sql.includes('INSERT INTO historial_radicado')) {
                eventos++;
                return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('SELECT MAX')) return [[{ id: 60 }]];
            if (sql.startsWith('EXPLAIN')) return [[{ key: 'idx_historial_evento_cursor' }]];
            if (sql.includes('COUNT(*) AS cantidad FROM radicados')) return [[{ cantidad: radicados }]];
            if (sql.includes('COUNT(*) AS cantidad FROM historial')) return [[{ cantidad: eventos }]];
            if (sql.includes('HAVING COUNT(*)')) return [[]];
            if (sql.includes('information_schema.TABLES')) return [[]];
            if (sql.includes('FROM historial_radicado')) {
                if (valores[0].endsWith('-CURSOR')) {
                    return [Array.from({ length: 60 }, (_, i) => ({ id: 60 - i }))
                        .filter(fila => valores[1] === null || fila.id < valores[1]).slice(0, valores[3])];
                }
                return [[]];
            }
            assert.fail(`SQL inesperado: ${sql}`);
        }
    };
    const resultado = await cargar(connection, { base: BASE, version: 'test', faltantes: [], columnas }, () => {});
    assert.equal(resultado.prefijo, prefijo);
    assert.deepEqual(resultado.etapas.map(etapa => [etapa.radicados, etapa.eventos]), [[1000, 10000], [10000, 100000]]);
    assert.deepEqual(resultado.etapas.map(etapa => etapa.escritura_radicado_y_10_eventos.muestras), [1000, 9000]);
    assert.equal(escrituras, 10001);
    assert.equal(eventos, 100060);
    assert.equal(resultado.etapas[1].pagina_cursor.muestras, 50);
});

test('paginacion sintetica rechaza eventos duplicados antes de cargar los escalones', async () => {
    let radicados = 0;
    const connection = {
        async beginTransaction() {}, async commit() {}, async rollback() {},
        async execute(sql) {
            if (sql.startsWith('SELECT DATABASE')) return [[{ base: BASE }]];
            if (sql.includes('INSERT INTO radicados')) { radicados++; return [{ affectedRows: 1 }]; }
            if (sql.includes('INSERT INTO historial_radicado')) return [{ affectedRows: 1 }];
            if (sql.includes('FROM historial_radicado')) return [[{ id: 1 }, { id: 1 }]];
            assert.fail(`SQL inesperado: ${sql}`);
        }
    };
    await assert.rejects(cargar(connection, { base: BASE, faltantes: [], columnas }, () => {}), /duplicado/);
    assert.equal(radicados, 1);
});
