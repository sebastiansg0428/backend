const test = require('node:test');
const assert = require('node:assert/strict');
const { crearGuardiaEstructura, esErrorEstructural } = require('../estructura-interna');

test('estructura interna: comparte lecturas y vence exactamente 30 segundos despues de validar', async () => {
    let reloj = 0, llamadas = 0, resolver;
    const guardia = crearGuardiaEstructura(() => {
        llamadas++;
        return new Promise(resolve => { resolver = resolve; });
    }, () => reloj);
    const pool = {};
    const primero = guardia.exigir(pool);
    assert.equal(guardia.exigir(pool), primero);
    reloj = 100;
    resolver(true);
    await primero;
    reloj = 30099;
    await guardia.exigir(pool);
    assert.equal(llamadas, 1);
    reloj = 30100;
    const siguiente = guardia.exigir(pool);
    assert.equal(llamadas, 2);
    resolver(true);
    await siguiente;
});

test('estructura interna: ausencia, incompatibilidad y errores de conexion son 503 recuperables', async () => {
    for (const falla of [false, new Error('Columnas incompatibles'), new Error('Conexion rechazada')]) {
        let intentos = 0;
        const guardia = crearGuardiaEstructura(async () => {
            if (++intentos === 1) {
                if (falla instanceof Error) throw falla;
                return falla;
            }
            return true;
        });
        const pool = {};
        await assert.rejects(guardia.exigir(pool), e => e.status === 503 && Boolean(e.cause));
        await guardia.exigir(pool);
        assert.equal(intentos, 2);
    }
});

test('estructura interna: invalidacion descarta completado tardio sin pisar nueva verificacion', async () => {
    const resoluciones = [];
    const guardia = crearGuardiaEstructura(() => new Promise(resolve => resoluciones.push(resolve)));
    const pool = {};
    const viejo = guardia.exigir(pool);
    const rechazo = assert.rejects(viejo, e => e.status === 503);
    guardia.invalidar(pool);
    const nuevo = guardia.exigir(pool);
    resoluciones[0](true);
    await rechazo;
    assert.equal(guardia.exigir(pool), nuevo);
    resoluciones[1](true);
    await nuevo;
    await guardia.exigir(pool);
    assert.equal(resoluciones.length, 2);
});

test('estructura interna: escrituras verifican su conexion siempre y no publican vigencia de lectura', async () => {
    const conexiones = [];
    const guardia = crearGuardiaEstructura(async c => { conexiones.push(c); return true; });
    const pool = {}, connection = {};
    await guardia.exigir(pool);
    await guardia.exigirEscritura(pool, connection);
    await guardia.exigirEscritura(pool, connection);
    await guardia.exigir(pool);
    assert.deepEqual(conexiones, [pool, connection, connection, pool]);
});

test('estructura interna: pools independientes y errores SQL estructurales limitados', async () => {
    let consultas = 0;
    const guardia = crearGuardiaEstructura(async () => { consultas++; return true; });
    const uno = {}, dos = {};
    await guardia.exigir(uno);
    await guardia.exigir(dos);
    await guardia.exigir(uno);
    assert.equal(consultas, 2);
    assert.equal(esErrorEstructural({ code: 'ER_BAD_FIELD_ERROR' }), true);
    for (const code of ['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_ACCESS_DENIED_ERROR', undefined])
        assert.equal(esErrorEstructural({ code }), false);
});
