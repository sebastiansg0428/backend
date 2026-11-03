const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

async function medir(operacion, muestras = 10) {
    const tiempos = [];
    let resultado;
    for (let i = 0; i < muestras; i++) {
        const inicio = performance.now();
        resultado = await operacion();
        tiempos.push(performance.now() - inicio);
    }
    tiempos.sort((a, b) => a - b);
    return { p50_ms: tiempos[Math.ceil(muestras * 0.5) - 1],
        p95_ms: tiempos[Math.ceil(muestras * 0.95) - 1],
        bytes: Buffer.byteLength(JSON.stringify(resultado)), resultado };
}

async function ejecutar() {
    if (process.env.DB_NAME !== 'ventanilla_unica_test') {
        throw new Error('Selecciona exclusivamente DB_NAME=ventanilla_unica_test.');
    }
    const pool = require('../db');
    const { consultarPagina, opcionesConsulta, construirFiltros, FROM, SELECT, ORDEN } = require('../consulta-radicados');
    const { presentarRadicado } = require('../presentacion-radicado');
    const { obtenerFechaLocal } = require('../semaforo');
    const opciones = opcionesConsulta({ pagina: '1' });
    const planes = [];
    const poolMedido = {
        async getConnection() {
            const connection = await pool.getConnection();
            return {
                query: (...args) => connection.query(...args),
                commit: () => connection.commit(),
                rollback: () => connection.rollback(),
                destroy: () => connection.destroy(),
                release: () => connection.release(),
                async execute(sql, valores) {
                    if (!planes.some(plan => plan.sql === sql)) {
                        const [explain] = await connection.execute(`EXPLAIN ${sql}`, valores);
                        planes.push({ sql, explain });
                    }
                    return connection.execute(sql, valores);
                }
            };
        }
    };
    try {
        const usuarios = [{ rol: 'administrador', dependencia_id: null }, { rol: 'ventanilla', dependencia_id: null }];
        const [dependencias] = await pool.execute('SELECT id FROM dependencias WHERE activo = 1 ORDER BY id LIMIT 2');
        usuarios.push(...dependencias.map(({ id }) => ({ rol: 'funcionario', dependencia_id: id })));
        const resultados = [];
        for (const usuario of usuarios) {
            const filtros = construirFiltros(usuario, opciones, obtenerFechaLocal(new Date(), 'hoy'));
            const sql = `SELECT ${SELECT} ${FROM} WHERE ${filtros.base} ${ORDEN}`;
            const anterior = await medir(async () => {
                const [rows] = await pool.execute(sql, filtros.valoresBase);
                return { success: true, total: rows.length, radicados: rows.map(presentarRadicado) };
            });
            await consultarPagina(poolMedido, usuario, opciones);
            const nueva = await medir(() => consultarPagina(pool, usuario, opciones));
            const claves = rows => rows.map(r => `${r.numero_radicado}:${r.radicado_dependencia_id || 0}`);
            assert.deepEqual(claves(nueva.resultado.radicados), claves(anterior.resultado.radicados.slice(0, 25)));
            assert.equal(nueva.resultado.resumen.total, anterior.resultado.total);
            const criticos = anterior.resultado.radicados.filter(r => ['alerta', 'vencido'].includes(r.semaforo.nivel));
            assert.equal(nueva.resultado.resumen.criticos, criticos.length);
            const segunda = await consultarPagina(pool, usuario, { ...opciones, pagina: 2 });
            assert.deepEqual(claves(segunda.radicados), claves(anterior.resultado.radicados.slice(25, 50)));
            const critica = await consultarPagina(pool, usuario, { ...opciones, criticos: true });
            assert.equal(critica.total, criticos.length);
            assert.deepEqual(claves(critica.radicados), claves(criticos.slice(0, 25)));
            if (usuario.dependencia_id) {
                const alertas = await consultarPagina(pool, usuario, opciones, usuario.dependencia_id, true);
                assert.equal(alertas.total, criticos.length);
                assert.deepEqual(claves(alertas.alertas), claves(criticos.slice(0, 25)));
            }
            const alertasAnteriores = await medir(async () => {
                const [rows] = await pool.execute(sql, filtros.valoresBase);
                const alertas = rows.map(presentarRadicado).filter(r => ['alerta', 'vencido'].includes(r.semaforo.nivel));
                return { success: true, total: alertas.length, alertas };
            });
            const alertasNuevas = await medir(() =>
                consultarPagina(pool, usuario, opciones, usuario.dependencia_id, true));
            assert.equal(alertasNuevas.resultado.total, alertasAnteriores.resultado.total);
            const { resultado: resultadoAnterior, ...medidaAnterior } = anterior;
            const { resultado: resultadoNuevo, ...medidaNueva } = nueva;
            const { resultado: resultadoAlertasAnterior, ...medidaAlertasAnterior } = alertasAnteriores;
            const { resultado: resultadoAlertasNuevo, ...medidaAlertasNueva } = alertasNuevas;
            resultados.push({ rol: usuario.rol, dependencia_id: usuario.dependencia_id,
                filas_antes: resultadoAnterior.total, filas_despues: resultadoNuevo.radicados.length,
                anterior: medidaAnterior, nueva: medidaNueva,
                alertas: { total: resultadoAlertasAnterior.total, filas: resultadoAlertasNuevo.alertas.length,
                    anterior: medidaAlertasAnterior, nueva: medidaAlertasNueva } });
        }
        console.log(JSON.stringify({ base: process.env.DB_NAME, muestras: 10, resultados, planes }, null, 2));
    } finally {
        await pool.end();
    }
}

if (require.main === module) ejecutar().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

module.exports = { medir, ejecutar };
