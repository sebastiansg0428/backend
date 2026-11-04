const INDICES = [
    ['radicado_dependencias', 'uq_024_asignacion_numero', ['id', 'numero_radicado'], true],
    ['terminos_legales', 'uq_024_termino_tipo', ['id', 'tipo_tramite_id'], true],
    ['respuestas_radicado', 'uq_024_respuesta_individual', ['numero_individual_unico'], true],
    ['respuestas_radicado', 'idx_024_respuesta_asignacion', ['radicado_dependencia_id', 'numero_radicado']],
    ['radicado_terminos', 'idx_024_radicado_termino_tipo', ['termino_legal_id', 'tipo_tramite_id']],
    ['historial_radicado', 'idx_024_historial_actor', ['actor_id']],
    ['historial_radicado', 'idx_024_historial_dependencia', ['dependencia_id']],
    ['historial_radicado', 'idx_024_historial_asignacion', ['radicado_dependencia_id', 'numero_radicado']],
    ['intentos_radicacion', 'idx_024_intento_numero', ['numero_radicado']],
];
const REFERENCIAS = [
    ['radicado_terminos', 'fk_024_radicado_terminos', ['numero_radicado'], 'radicados', ['numero_radicado']],
    ['ampliaciones_termino', 'fk_024_ampliacion_radicado', ['numero_radicado'], 'radicados', ['numero_radicado']],
    ['historial_radicado', 'fk_024_historial_radicado', ['numero_radicado'], 'radicados', ['numero_radicado']],
    ['historial_radicado', 'fk_024_historial_actor', ['actor_id'], 'usuarios', ['id']],
    ['historial_radicado', 'fk_024_historial_dependencia', ['dependencia_id'], 'dependencias', ['id']],
    ['historial_radicado', 'fk_024_historial_asignacion', ['radicado_dependencia_id'], 'radicado_dependencias', ['id']],
    ['historial_radicado', 'fk_024_historial_expediente', ['radicado_dependencia_id', 'numero_radicado'], 'radicado_dependencias', ['id', 'numero_radicado']],
    ['intentos_radicacion', 'fk_024_intento_actor', ['actor_id'], 'usuarios', ['id']],
    ['intentos_radicacion', 'fk_024_intento_radicado', ['numero_radicado'], 'radicados', ['numero_radicado']],
    ['respuestas_radicado', 'fk_024_respuesta_expediente', ['radicado_dependencia_id', 'numero_radicado'], 'radicado_dependencias', ['id', 'numero_radicado']],
    ['radicado_terminos', 'fk_024_termino_tipo', ['termino_legal_id', 'tipo_tramite_id'], 'terminos_legales', ['id', 'tipo_tramite_id']],
];
const TABLAS = [...new Set(REFERENCIAS.flatMap(([tabla, , , padre]) => [tabla, padre]))];
const GENERADA = 'numero_individual_unico';
const EXPRESION = 'CASE WHEN radicado_dependencia_id IS NULL THEN numero_radicado ELSE NULL END';
const identificador = valor => {
    if (!/^[a-zA-Z0-9_]+$/.test(valor)) throw new Error('Identificador de esquema no permitido.');
    return `\`${valor}\``;
};
const lista = columnas => columnas.map(identificador).join(', ');
const normalizarExpresion = valor => String(valor).replace(/[\s`()]/g, '').toLowerCase();

async function metadata(connection) {
    const [tablas] = await connection.query(
        'SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
    const [columnas] = await connection.query(
        `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, CHARACTER_SET_NAME,
                COLLATION_NAME, EXTRA, GENERATION_EXPRESSION
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()`);
    const [indices] = await connection.query(
        `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`);
    const [referencias] = await connection.query(
        `SELECT k.TABLE_NAME, k.CONSTRAINT_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION,
                k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA,
                r.DELETE_RULE, r.UPDATE_RULE
         FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
         WHERE k.CONSTRAINT_SCHEMA = DATABASE() ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`);
    const [[sesion]] = await connection.query('SELECT DATABASE() AS base, @@foreign_key_checks AS claves_activas');
    return { tablas, columnas, indices, referencias, ...sesion };
}

function grupos(filas, campo) {
    const resultado = new Map();
    for (const fila of filas) {
        const clave = `${fila.TABLE_NAME}.${fila[campo]}`;
        if (!resultado.has(clave)) resultado.set(clave, []);
        resultado.get(clave).push(fila);
    }
    return resultado;
}

function inspeccionar(meta) {
    if (!meta.base || Number(meta.claves_activas) !== 1) throw new Error('Selecciona una base con FOREIGN_KEY_CHECKS=1.');
    for (const tabla of TABLAS) {
        if (!meta.tablas.some(t => t.TABLE_NAME === tabla && t.ENGINE === 'InnoDB')) {
            throw new Error(`Esquema incompatible: falta tabla InnoDB ${tabla}.`);
        }
    }
    const columna = (tabla, nombre) => {
        const encontrada = meta.columnas.find(c => c.TABLE_NAME === tabla && c.COLUMN_NAME === nombre);
        if (!encontrada) throw new Error(`Esquema incompatible: falta ${tabla}.${nombre}.`);
        return encontrada;
    };
    for (const [tabla, , campos, padre, referidas] of REFERENCIAS) {
        campos.forEach((campo, i) => {
            const hija = columna(tabla, campo);
            const origen = columna(padre, referidas[i]);
            if (campo === 'numero_radicado') {
                if (![hija, origen].every(c => /^varchar\((50|100)\)$/i.test(c.COLUMN_TYPE)) ||
                    hija.CHARACTER_SET_NAME !== origen.CHARACTER_SET_NAME || hija.COLLATION_NAME !== origen.COLLATION_NAME) {
                    throw new Error(`Tipo o intercalacion incompatible: ${tabla}.${campo}.`);
                }
            } else {
                const tipo = c => c.COLUMN_TYPE.toLowerCase().replace(/\(\d+\)/g, '');
                if (!/^(int|bigint)( unsigned)?$/.test(tipo(hija)) || tipo(hija) !== tipo(origen)) {
                    throw new Error(`Tipo o signo incompatible: ${tabla}.${campo}.`);
                }
            }
        });
    }
    columna('respuestas_radicado', 'numero_radicado');
    const nullable = [
        ['respuestas_radicado', 'radicado_dependencia_id'],
        ['radicado_terminos', 'termino_legal_id'],
        ['historial_radicado', 'actor_id'], ['historial_radicado', 'dependencia_id'],
        ['historial_radicado', 'radicado_dependencia_id'], ['intentos_radicacion', 'numero_radicado'],
    ];
    for (const [tabla, nombre] of nullable) {
        if (columna(tabla, nombre).IS_NULLABLE !== 'YES') throw new Error(`Se requiere NULL permitido: ${tabla}.${nombre}.`);
    }
    const indices = grupos(meta.indices, 'INDEX_NAME');
    const referencias = grupos(meta.referencias, 'CONSTRAINT_NAME');
    const coincideIndice = ([tabla, , campos, unico], filas) => filas[0].TABLE_NAME === tabla &&
        (!unico || Number(filas[0].NON_UNIQUE) === 0) &&
        (!unico || filas.length === campos.length) && campos.every((c, i) =>
            filas[i]?.COLUMN_NAME === c && filas[i].SUB_PART === null);
    const tieneIndice = definicion => [...indices.values()].some(filas => coincideIndice(definicion, filas));
    for (const [tabla, campos] of [
        ['radicados', ['numero_radicado']], ['usuarios', ['id']], ['dependencias', ['id']],
        ['radicado_dependencias', ['id']], ['terminos_legales', ['id']],
    ]) {
        if (!tieneIndice([tabla, '', campos, true])) throw new Error(`Falta PK/UNIQUE compatible en ${tabla}.`);
    }
    for (const tabla of ['respuestas_radicado', 'radicado_terminos', 'ampliaciones_termino', 'historial_radicado']) {
        if (columna(tabla, 'numero_radicado').IS_NULLABLE !== 'NO') {
            throw new Error(`Se requiere numero_radicado NOT NULL en ${tabla}.`);
        }
    }
    for (const definicion of INDICES) {
        const existente = indices.get(`${definicion[0]}.${definicion[1]}`);
        if (existente && !coincideIndice(definicion, existente)) throw new Error(`Indice incompatible: ${definicion[1]}.`);
    }
    let presentes = 0;
    for (const [tabla, nombre, campos, padre, referidas] of REFERENCIAS) {
        const existente = referencias.get(`${tabla}.${nombre}`);
        if (!existente) continue;
        if (existente.length !== campos.length || existente.some((r, i) =>
            r.COLUMN_NAME !== campos[i] || r.REFERENCED_TABLE_NAME !== padre ||
            r.REFERENCED_COLUMN_NAME !== referidas[i] || r.REFERENCED_TABLE_SCHEMA !== meta.base ||
            r.DELETE_RULE !== 'RESTRICT' || r.UPDATE_RULE !== 'RESTRICT')) {
            throw new Error(`FK incompatible: ${nombre}.`);
        }
        presentes++;
    }
    const generada = meta.columnas.find(c => c.TABLE_NAME === 'respuestas_radicado' && c.COLUMN_NAME === GENERADA);
    if (generada && (!/STORED GENERATED/i.test(generada.EXTRA) ||
        normalizarExpresion(generada.GENERATION_EXPRESSION) !== normalizarExpresion(EXPRESION) ||
        generada.COLUMN_TYPE !== columna('respuestas_radicado', 'numero_radicado').COLUMN_TYPE ||
        generada.COLLATION_NAME !== columna('respuestas_radicado', 'numero_radicado').COLLATION_NAME)) {
        throw new Error('Columna generada de unicidad incompatible.');
    }
    const marcadores = presentes + Number(Boolean(generada)) +
        INDICES.filter(([tabla, nombre]) => indices.has(`${tabla}.${nombre}`)).length;
    if (presentes === REFERENCIAS.length && generada && INDICES.every(tieneIndice)) {
        return { estado: 'aplicada', pasos: [] };
    }
    if (marcadores) throw new Error('Migracion 024 parcial: inspecciona el esquema y recupera el respaldo; no reejecutes a ciegas.');
    const cambios = new Map();
    const agregar = (tabla, sql) => {
        if (!cambios.has(tabla)) cambios.set(tabla, []);
        cambios.get(tabla).push(sql);
    };
    const numero = columna('respuestas_radicado', 'numero_radicado');
    agregar('respuestas_radicado', `ADD COLUMN ${identificador(GENERADA)} ${numero.COLUMN_TYPE}
        CHARACTER SET ${identificador(numero.CHARACTER_SET_NAME)} COLLATE ${identificador(numero.COLLATION_NAME)}
        GENERATED ALWAYS AS (${EXPRESION}) STORED`);
    for (const definicion of INDICES) {
        const [tabla, nombre, campos, unico] = definicion;
        if (!tieneIndice(definicion)) agregar(tabla, `ADD ${unico ? 'UNIQUE ' : ''}INDEX ${identificador(nombre)} (${lista(campos)})`);
    }
    for (const [tabla, nombre, campos, padre, referidas] of REFERENCIAS) {
        agregar(tabla, `ADD CONSTRAINT ${identificador(nombre)} FOREIGN KEY (${lista(campos)})
            REFERENCES ${identificador(padre)} (${lista(referidas)}) ON DELETE RESTRICT ON UPDATE RESTRICT`);
    }
    // Los indices compuestos de los padres deben existir antes de agregar las FK.
    const orden = ['radicado_dependencias', 'terminos_legales', 'respuestas_radicado',
        'radicado_terminos', 'historial_radicado', 'ampliaciones_termino', 'intentos_radicacion'];
    return { estado: 'pendiente', pasos: orden.filter(t => cambios.has(t)).map(tabla =>
        `ALTER TABLE ${identificador(tabla)} ${cambios.get(tabla).join(',\n')}`) };
}

async function verificarDatos(connection) {
    const problemas = [];
    for (const [tabla, nombre, campos, padre, referidas] of REFERENCIAS) {
        const noNulos = campos.map(c => `h.${identificador(c)} IS NOT NULL`).join(' AND ');
        const igualdad = campos.map((c, i) => `p.${identificador(referidas[i])} = h.${identificador(c)}`).join(' AND ');
        const [[fila]] = await connection.query(`SELECT COUNT(*) AS cantidad FROM ${identificador(tabla)} h
            WHERE ${noNulos} AND NOT EXISTS (SELECT 1 FROM ${identificador(padre)} p WHERE ${igualdad})`);
        if (Number(fila.cantidad)) problemas.push(`${nombre}: ${fila.cantidad}`);
    }
    const [[duplicados]] = await connection.query(`SELECT COUNT(*) AS cantidad FROM (
        SELECT numero_radicado FROM respuestas_radicado WHERE radicado_dependencia_id IS NULL
        GROUP BY numero_radicado HAVING COUNT(*) > 1) duplicados`);
    if (Number(duplicados.cantidad)) problemas.push(`respuestas_individuales_duplicadas: ${duplicados.cantidad}`);
    if (problemas.length) throw new Error(`Datos incompatibles: ${problemas.join('; ')}`);
}

async function migrarIntegridad(connection, { aplicar = false } = {}) {
    if (typeof aplicar !== 'boolean') throw new TypeError('aplicar debe ser booleano; solo true autoriza DDL.');
    const plan = inspeccionar(await metadata(connection));
    await verificarDatos(connection);
    if (!aplicar || plan.estado === 'aplicada') return { estado: plan.estado, cambios: plan.pasos.length, aplicada: plan.estado === 'aplicada' };
    let completados = 0;
    try {
        for (const sql of plan.pasos) {
            await connection.query(sql);
            completados++;
        }
        const final = inspeccionar(await metadata(connection));
        if (final.estado !== 'aplicada') throw new Error('La verificacion posterior no confirmo la estructura esperada.');
        await verificarDatos(connection);
        return { estado: 'aplicada', cambios: completados, aplicada: true };
    } catch (error) {
        throw new Error(`Migracion 024 interrumpida tras ${completados} ALTER completados. El DDL no admite rollback:
inspecciona con una conexion nueva y recupera el respaldo si corresponde; no reejecutes a ciegas.`, { cause: error });
    }
}

if (require.main === module) {
    const argumentos = process.argv.slice(2);
    if (argumentos.length !== 1 || !['--verificar', '--aplicar'].includes(argumentos[0])) {
        console.error('Uso: node migrations\\024_integridad_referencial.js --verificar|--aplicar');
        process.exitCode = 1;
    } else {
        const pool = require('../db');
        (async () => {
            let connection;
            try {
                connection = await pool.getConnection();
                console.log(JSON.stringify(await migrarIntegridad(connection, { aplicar: argumentos[0] === '--aplicar' })));
            } finally {
                if (connection) connection.release();
                await pool.end();
            }
        })().catch(error => {
            console.error(error.message);
            if (error.cause) console.error('Causa:', error.cause.message);
            process.exitCode = 1;
        });
    }
}

module.exports = { migrarIntegridad, inspeccionar, verificarDatos };
