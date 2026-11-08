const { performance } = require('node:perf_hooks');

const errorEstructura = cause => Object.assign(new Error(
    'Recepcion interna no disponible: verificar/aplicar migracion 027 y reintentar.',
    { cause }
), { status: 503 });

function crearGuardiaEstructura(verificar, ahora = () => performance.now()) {
    const estados = new WeakMap();
    function estado(pool) {
        if (!estados.has(pool)) estados.set(pool, { hasta: 0, generacion: 0, pendiente: null });
        return estados.get(pool);
    }
    function invalidar(pool) {
        const actual = estado(pool);
        actual.hasta = 0;
        actual.generacion++;
        actual.pendiente = null;
    }
    async function comprobar(connection) {
        try {
            if (!await verificar(connection)) throw new Error('Falta la estructura de migracion 027.');
        } catch (error) {
            throw errorEstructura(error);
        }
    }
    function exigir(pool) {
        const actual = estado(pool);
        if (actual.hasta > ahora()) return Promise.resolve();
        if (actual.pendiente) return actual.pendiente;
        const generacion = actual.generacion;
        const intento = comprobar(pool).then(() => {
            if (actual.generacion !== generacion) throw errorEstructura(new Error('Verificacion invalidada durante la carga.'));
            actual.hasta = ahora() + 30000;
        }).catch(error => {
            if (actual.generacion === generacion) actual.hasta = 0;
            throw error;
        }).finally(() => {
            if (actual.pendiente === intento) actual.pendiente = null;
        });
        actual.pendiente = intento;
        return intento;
    }
    async function exigirEscritura(pool, connection) {
        invalidar(pool);
        try { await comprobar(connection); }
        finally { invalidar(pool); }
    }
    return { exigir, exigirEscritura, invalidar };
}

const esErrorEstructural = error => ['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_TABLE_DEF_CHANGED']
    .includes(error.code);

module.exports = { crearGuardiaEstructura, errorEstructura, esErrorEstructural };
