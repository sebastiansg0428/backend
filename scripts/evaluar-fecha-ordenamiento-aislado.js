/*
 * Evalúa una fecha efectiva indexada únicamente en una base temporal.
 * No modifica consulta-radicados.js, migraciones ni ninguna base persistente.
 *
 * Ejemplo:
 *   DB_HOST=127.0.0.1 BENCH_SAMPLES=3 BENCH_WARMUP=0 \
 *     node scripts/evaluar-fecha-ordenamiento-aislado.js > comparacion.json
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const mysql = require('mysql2/promise');
const { crearBaseTemporal, cargarDatos } = require('./benchmark-consultas-aislado');

const HOST = process.env.DB_HOST || '127.0.0.1';
const USER = process.env.DB_USER || 'root';
const PASSWORD = process.env.DB_PASSWORD || '';
const ROLES = [
    { nombre: 'administrador', rol: 'administrador', dependencia_id: null },
    { nombre: 'ventanilla', rol: 'ventanilla', dependencia_id: null },
    { nombre: 'funcionario-1', rol: 'funcionario', dependencia_id: 1 },
    { nombre: 'funcionario-5', rol: 'funcionario', dependencia_id: 5 }
].filter(usuario => (process.env.BENCH_ROLES ||
    'administrador,ventanilla,funcionario-1,funcionario-5')
    .split(',').map(valor => valor.trim()).includes(usuario.nombre));
const CONSULTAS = [
    ['pagina-1', { pagina: '1' }],
    ['pagina-intermedia', { pagina: '200' }],
    ['pagina-profunda', { pagina: '400' }],
    ['busqueda-numero', { pagina: '1', busqueda: 'BENCH-2026-00001' }],
    ['busqueda-remitente', { pagina: '1', busqueda: 'Remitente benchmark 42' }],
    ['busqueda-documento', { pagina: '1', busqueda: '00000042' }],
    ['filtro-hoy', { pagina: '1', hoy: '1' }],
    ['filtro-criticos', { pagina: '1', criticos: '1' }]
];

function cargarModuloConsulta(candidato) {
    const ruta = require.resolve('../consulta-radicados');
    let fuente = fs.readFileSync(ruta, 'utf8').replace(/\r\n/g, '\n');
    if (candidato) {
        const anterior = "const ORDEN = `ORDER BY COALESCE(r.fecha_hora_recepcion, r.fecha_creacion) DESC,\n    r.numero_radicado DESC, COALESCE(rd.id, 0) DESC`;";
        const reemplazo = "const ORDEN = `ORDER BY r.fecha_ordenamiento DESC,\n    r.numero_radicado DESC, COALESCE(rd.id, 0) DESC`;";
        if (!fuente.includes(anterior)) throw new Error('No se encontró el ORDER BY esperado.');
        fuente = fuente.replace(anterior, reemplazo);
    }
    const modulo = new Module(ruta, module);
    modulo.filename = ruta;
    modulo.paths = Module._nodeModulePaths(path.dirname(ruta));
    const logOriginal = console.log;
    try {
        console.log = () => {};
        modulo._compile(fuente, ruta);
    } finally {
        console.log = logOriginal;
    }
    return modulo.exports;
}

function instrumentarPool(pool, planes) {
    return {
        async getConnection() {
            const connection = await pool.getConnection();
            return {
                query: (...args) => connection.query(...args),
                commit: () => connection.commit(),
                rollback: () => connection.rollback(),
                destroy: () => connection.destroy(),
                release: () => connection.release(),
                async execute(sql, valores) {
                    if (!planes.has(sql)) {
                        const [plan] = await connection.execute(`EXPLAIN ${sql}`, valores);
                        planes.set(sql, resumirPlan(plan));
                    }
                    return connection.execute(sql, valores);
                }
            };
        }
    };
}

function resumirPlan(plan) {
    return plan.map(fila => ({
        table: fila.table, type: fila.type, possible_keys: fila.possible_keys,
        key: fila.key, rows: fila.rows, Extra: fila.Extra
    }));
}

function claves(resultado) {
    return resultado.radicados.map(row =>
        `${row.numero_radicado}:${row.radicado_dependencia_id || 0}`);
}

async function medirModulo(pool, modulo, usuario, opciones, planes) {
    const poolInstrumentado = instrumentarPool(pool, planes);
    const muestras = Number(process.env.BENCH_SAMPLES || 7);
    const calentamiento = Number(process.env.BENCH_WARMUP || 1);
    const operar = async () => {
        const resultado = await modulo.consultarPagina(poolInstrumentado, usuario, opciones);
        return { filas: resultado.radicados.length, resultado };
    };
    for (let i = 0; i < calentamiento; i++) await operar();
    const tiempos = [];
    let ultimo;
    for (let i = 0; i < muestras; i++) {
        const inicio = performance.now();
        ultimo = await operar();
        tiempos.push(performance.now() - inicio);
    }
    tiempos.sort((a, b) => a - b);
    const percentil = porcentaje => tiempos[Math.max(0, Math.ceil(tiempos.length * porcentaje) - 1)];
    return {
        muestras, p50_ms: Number(percentil(0.5).toFixed(3)),
        p95_ms: Number(percentil(0.95).toFixed(3)),
        max_ms: Number(Math.max(...tiempos).toFixed(3)),
        filas_devuelta: ultimo.filas,
        bytes_serializados: Buffer.byteLength(JSON.stringify(ultimo.resultado)),
        resultado: ultimo.resultado
    };
}

async function evaluar(pool) {
    const actual = cargarModuloConsulta(false);
    const candidato = cargarModuloConsulta(true);
    const escenarios = [];
    const planesActual = new Map();
    const planesCandidato = new Map();
    for (const usuario of ROLES) {
        for (const [nombre, query] of CONSULTAS) {
            console.error(`[fecha] ${usuario.nombre}/${nombre}`);
            const opcionesActual = actual.opcionesConsulta(query);
            const opcionesCandidato = candidato.opcionesConsulta(query);
            const baseline = await medirModulo(pool, actual, usuario, opcionesActual, planesActual);
            const optimizado = await medirModulo(pool, candidato, usuario, opcionesCandidato, planesCandidato);
            const resultadoActual = baseline.resultado;
            const resultadoCandidato = optimizado.resultado;
            const clavesActual = claves(resultadoActual);
            const clavesCandidato = claves(resultadoCandidato);
            const { resultado: _resultadoActual, ...resumenBaseline } = baseline;
            const { resultado: _resultadoCandidato, ...resumenOptimizado } = optimizado;
            escenarios.push({
                rol: usuario.nombre, escenario: nombre,
                mismos_resultados: JSON.stringify(clavesActual) === JSON.stringify(clavesCandidato) &&
                    resultadoActual.total === resultadoCandidato.total,
                baseline: resumenBaseline, optimizado: resumenOptimizado,
                diferencia_p50_ms: Number((optimizado.p50_ms - baseline.p50_ms).toFixed(3))
            });
        }
    }
    return {
        escenarios,
        planes_actual: [...planesActual.values()],
        planes_optimizado: [...planesCandidato.values()]
    };
}

async function ejecutar() {
    if (!ROLES.length) throw new Error('BENCH_ROLES no seleccionó ningún rol válido.');
    const admin = await mysql.createConnection({ host: HOST, user: USER, password: PASSWORD, dateStrings: true });
    let baseTemporal;
    let pool;
    try {
        baseTemporal = await crearBaseTemporal(admin);
        pool = mysql.createPool({ host: HOST, user: USER, password: PASSWORD,
            database: baseTemporal, waitForConnections: true, connectionLimit: 10,
            queueLimit: 10, dateStrings: true });
        const carga = await cargarDatos(pool);
        await pool.query(`ALTER TABLE radicados
            ADD COLUMN fecha_ordenamiento DATETIME
                AS (COALESCE(fecha_hora_recepcion, fecha_creacion)) PERSISTENT,
            ADD INDEX idx_bench_fecha_ordenamiento (fecha_ordenamiento, numero_radicado)`);
        const comparacion = await evaluar(pool);
        const [[conteos]] = await pool.query(`SELECT
            (SELECT COUNT(*) FROM radicados) AS radicados,
            (SELECT COUNT(*) FROM historial_radicado) AS historial`);
        console.log(JSON.stringify({
            benchmark: 'evaluacion-fecha-ordenamiento-aislado',
            base_temporal: baseTemporal, carga, conteos_finales: conteos,
            roles: ROLES.map(usuario => usuario.nombre),
            muestras: Number(process.env.BENCH_SAMPLES || 7),
            calentamiento: Number(process.env.BENCH_WARMUP || 1),
            columna_evaluada: 'fecha_ordenamiento',
            indice_evaluado: 'idx_bench_fecha_ordenamiento',
            ...comparacion,
            criterios: {
                resultados_compatibles: comparacion.escenarios.every(row => row.mismos_resultados),
                nota: 'La variante solo se ejecutó en la base temporal y no modifica producción.'
            }
        }, null, 2));
    } finally {
        if (pool) await pool.end();
        if (baseTemporal) await admin.query(`DROP DATABASE IF EXISTS \`${baseTemporal}\``);
        await admin.end();
    }
}

if (require.main === module) ejecutar().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});

module.exports = { ejecutar, cargarModuloConsulta };
