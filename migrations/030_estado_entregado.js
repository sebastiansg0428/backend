const pool = require('../db');

const ESTADOS_REQUERIDOS = ['Recibido', 'En trámite', 'Pendiente', 'Respondido', 'Vencido', 'Enterado'];
const ESTADO_NUEVO = 'Entregado';

function diagnostico(error) {
    return error?.code || error?.message || 'No fue posible inspeccionar el esquema.';
}

function parseEnum(type) {
    const match = /^enum\((.*)\)$/i.exec(String(type || ''));
    if (!match) return null;
    const valores = [];
    const expresion = match[1];
    let actual = '';
    let escapado = false;
    let entreComillas = false;
    for (const caracter of expresion) {
        if (escapado) { actual += caracter; escapado = false; continue; }
        if (caracter === '\\') { actual += caracter; escapado = true; continue; }
        if (caracter === "'") { entreComillas = !entreComillas; continue; }
        if (caracter === ',' && !entreComillas) {
            valores.push(actual.replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
            actual = '';
            continue;
        }
        actual += caracter;
    }
    if (actual || expresion.endsWith("'")) valores.push(actual.replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
    return valores;
}

function sqlLiteral(valor) {
    return `'${String(valor).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function estado030(estado, detalles = {}) {
    return { estado, cambios: 0, requiere_confirmacion: false, ...detalles };
}

async function leerEstado(connection) {
    const [columnas] = await connection.query("SHOW FULL COLUMNS FROM radicados LIKE 'estado'");
    if (columnas.length !== 1) return estado030('incompatible', { diagnostico: 'No existe una única columna radicados.estado.' });
    const columna = columnas[0];
    const tipo = String(columna.Type || columna.COLUMN_TYPE || '');
    const valores = parseEnum(tipo);
    if (valores) {
        const faltantes = ESTADOS_REQUERIDOS.filter(estado => !valores.includes(estado));
        if (faltantes.length) return estado030('incompatible', {
            diagnostico: `El ENUM no conserva estados requeridos: ${faltantes.join(', ')}.`
        });
        if (valores.includes(ESTADO_NUEVO)) return estado030('aplicada', { tipo, valores });
        if (columna.Null !== 'NO' || columna.Default !== 'Recibido' || !/^[a-zA-Z0-9_]+$/.test(columna.Collation || '')) {
            return estado030('incompatible', { diagnostico: 'La definición de radicados.estado no permite ampliación segura.', tipo, valores });
        }
        return estado030('pendiente', { tipo, valores, siguiente: 'ALTER TABLE ... MODIFY COLUMN' });
    }
    const varchar = /^varchar\((\d+)\)$/i.exec(tipo);
    if (varchar && Number(varchar[1]) >= ESTADO_NUEVO.length) {
        return estado030('aplicada', { tipo, valores: null, diagnostico: 'La columna es VARCHAR compatible; no requiere DDL.' });
    }
    return estado030('incompatible', { diagnostico: 'radicados.estado no es un ENUM compatible ni un VARCHAR suficiente.', tipo });
}

async function inspeccionarEstadoEntregado(connection) {
    try { return await leerEstado(connection); }
    catch (error) { return estado030('indeterminada', { diagnostico: diagnostico(error) }); }
}

async function verificar(connection) {
    const estado = await leerEstado(connection);
    if (estado.estado === 'aplicada') return true;
    if (estado.estado === 'pendiente') return false;
    throw new Error(`Migracion 030 incompatible o indeterminada: ${estado.diagnostico || estado.estado}`);
}

async function migrarEstadoEntregado(connection, { aplicar = false } = {}) {
    if (typeof aplicar !== 'boolean') throw new TypeError('aplicar debe ser booleano.');
    const estado = await leerEstado(connection);
    if (estado.estado === 'aplicada') return { estado: 'aplicada', cambios: 0 };
    if (estado.estado !== 'pendiente') throw new Error(`Migracion 030 no aplicable: ${estado.diagnostico || estado.estado}`);
    if (!aplicar) return { estado: 'pendiente', cambios: 1 };

    const valores = [...estado.valores, ESTADO_NUEVO];
    const tipoNuevo = `ENUM(${valores.map(sqlLiteral).join(',')})`;
    try {
        await connection.query(`ALTER TABLE radicados MODIFY COLUMN estado ${tipoNuevo}
            COLLATE ${estado.Collation || 'utf8mb4_unicode_ci'} NOT NULL DEFAULT 'Recibido'`);
        const despues = await leerEstado(connection);
        if (despues.estado !== 'aplicada') throw new Error(`La verificacion posterior no dejo 030 aplicada: ${despues.diagnostico || despues.estado}`);
        return { estado: 'aplicada', cambios: 1 };
    } catch (error) {
        throw new Error(`030 interrumpida; el DDL hace commit implicito. Inspecciona antes de reintentar. ${error.message}`, { cause: error });
    }
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--inspeccionar', '--verificar', '--aplicar'].includes(args[0])) {
        console.error('Uso: node migrations\\030_estado_entregado.js --inspeccionar|--verificar|--aplicar');
        process.exitCode = 1;
    } else {
        pool.getConnection().then(async connection => {
            try {
                if (args[0] === '--inspeccionar') console.log(await inspeccionarEstadoEntregado(connection));
                else if (args[0] === '--verificar') console.log(`Migracion 030 ${await verificar(connection) ? 'aplicada' : 'pendiente'}.`);
                else console.log(await migrarEstadoEntregado(connection, { aplicar: true }));
            } finally { connection.release(); }
        }).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
    }
}

module.exports = { ESTADOS_REQUERIDOS, parseEnum, inspeccionarEstadoEntregado, verificar, migrarEstadoEntregado };
