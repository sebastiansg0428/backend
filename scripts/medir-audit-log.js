const mysql = require('mysql2/promise');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { registrarEventoRadicado } = require('../audit-log');

const BASE = 'ventanilla_unica_test';
const SQL_HISTORIAL = `SELECT id, campo_modificado, valor_anterior, valor_nuevo, usuario, motivo,
    creado_en, event_type, actor_id, actor_name, dependencia_id,
    dependencia_nombre, radicado_dependencia_id, ocurrido_en_utc
    FROM historial_radicado
    WHERE numero_radicado = ? AND (? IS NULL OR id < ?)
    ORDER BY id DESC LIMIT ?`;

function configuracion(env) {
    if (env.DB_NAME !== BASE) throw new Error(`DB_NAME debe ser exactamente ${BASE}; no se abrira ninguna conexion.`);
    return {
        host: env.DB_HOST || 'localhost',
        user: env.DB_USER || 'root',
        password: env.DB_PASSWORD || '',
        database: BASE,
        dateStrings: true,
        connectTimeout: 10000
    };
}

function resumen(muestras) {
    if (!muestras.length || muestras.some(valor => !Number.isFinite(valor) || valor < 0)) {
        throw new Error('Las muestras deben contener tiempos finitos no negativos.');
    }
    const ordenadas = [...muestras].sort((a, b) => a - b);
    const percentil = valor => ordenadas[Math.ceil(valor * ordenadas.length) - 1];
    return {
        muestras: muestras.length,
        promedio_ms: muestras.reduce((a, b) => a + b, 0) / muestras.length,
        p50_ms: percentil(0.5),
        p95_ms: percentil(0.95),
        max_ms: ordenadas.at(-1)
    };
}

async function inspeccionar(connection) {
    const [[identidad]] = await connection.execute('SELECT DATABASE() AS base, VERSION() AS version');
    if (identidad.base !== BASE) throw new Error('La conexion no apunta a la base test autorizada.');
    const [tablas] = await connection.execute(
        'SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [BASE]);
    const [columnas] = await connection.execute(
        'SELECT TABLE_NAME, COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?', [BASE]);
    const [indices] = await connection.execute(
        'SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX', [BASE]);
    const [triggers] = await connection.execute(
        'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?', [BASE]);
    const [referencias] = await connection.execute(
        `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`, [BASE]);
    const faltantes = [];
    for (const tabla of ['radicados', 'historial_radicado']) {
        if (!tablas.some(fila => fila.TABLE_NAME === tabla && fila.ENGINE === 'InnoDB')) faltantes.push(`${tabla}: requiere InnoDB`);
    }
    for (const columna of ['event_type', 'actor_id', 'actor_name', 'dependencia_id',
        'dependencia_nombre', 'radicado_dependencia_id', 'session_id', 'ip_address', 'ocurrido_en_utc']) {
        if (!columnas.some(fila => fila.TABLE_NAME === 'historial_radicado' && fila.COLUMN_NAME === columna)) {
            faltantes.push(`historial_radicado.${columna}`);
        }
    }
    for (const columna of ['fecha_hora_recepcion', 'requiere_respuesta', 'fecha_enterado']) {
        if (!columnas.some(fila => fila.TABLE_NAME === 'radicados' && fila.COLUMN_NAME === columna)) {
            faltantes.push(`radicados.${columna}`);
        }
    }
    const cursor = indices.filter(fila => fila.TABLE_NAME === 'historial_radicado' &&
        fila.INDEX_NAME === 'idx_historial_evento_cursor').map(fila => fila.COLUMN_NAME);
    if (cursor.join(',') !== 'numero_radicado,id') faltantes.push('idx_historial_evento_cursor(numero_radicado,id)');
    if (!indices.some(fila => fila.TABLE_NAME === 'historial_radicado' && fila.INDEX_NAME === 'idx_historial_sesion')) {
        faltantes.push('idx_historial_sesion');
    }
    if (triggers.length) faltantes.push('Hay triggers: requieren revision antes de permitir escrituras.');
    if (referencias.some(fila => fila.REFERENCED_TABLE_SCHEMA !== BASE)) faltantes.push('Hay referencias fuera de la base test.');
    return { ...identidad, tablas, columnas, indices, triggers, referencias, faltantes };
}

function valoresRadicado(numero) {
    return {
        numero_radicado: numero, tipo_recepcion: 'Digital', tipo_comunicacion: 'Externa',
        tipo_documento: 'Prueba sintetica', tiempo_de_respuesta: 'No requiere respuesta',
        remitente_nombre: 'Persona ficticia de carga', remitente_documento: 'TEST-SIN-IDENTIDAD',
        remitente_telefono: 'No especificado', numero_folios: 1,
        fecha_hora_recepcion: '2026-01-01 09:00:00', dependencia_destino: 'Dependencia ficticia',
        asunto_documento: 'Dato sintetico exclusivo de medicion; no es un tramite real.',
        usuario_recibe: 'Actor ficticio', destino_todas_dependencias: 0,
        requiere_respuesta: 0, estado: 'Recibido', remitente_tipo_persona: 'natural'
    };
}

async function insertar(connection, columnas, numero, cantidadEventos) {
    const valores = valoresRadicado(numero);
    const disponibles = columnas.filter(fila => fila.TABLE_NAME === 'radicados');
    const campos = Object.keys(valores).filter(nombre => disponibles.some(fila => fila.COLUMN_NAME === nombre));
    const requeridas = disponibles.filter(fila => fila.IS_NULLABLE === 'NO' &&
        fila.COLUMN_DEFAULT === null && !fila.EXTRA.includes('auto_increment') && !campos.includes(fila.COLUMN_NAME));
    if (requeridas.length) throw new Error(`Campos obligatorios no cubiertos: ${requeridas.map(fila => fila.COLUMN_NAME).join(', ')}`);
    const inicio = performance.now();
    const idSesion = randomUUID();
    await connection.beginTransaction();
    try {
        await connection.execute(
            `INSERT INTO radicados (${campos.map(campo => `\`${campo}\``).join(',')})
             VALUES (${campos.map(() => '?').join(',')})`, campos.map(campo => valores[campo]));
        for (let i = 0; i < cantidadEventos; i++) {
            await registrarEventoRadicado(connection, {
                usuario: { id: 1, nombre: 'Actor ficticio de carga' },
                idSesion, ip: '192.0.2.1'
            }, {
                numeroRadicado: numero, tipo: 'estado_cambiado',
                valorAnterior: 'Recibido', valorNuevo: 'Pendiente',
                motivo: `Evento sintetico ${i + 1}; no representa una actuacion real.`,
                dependenciaNombre: 'Dependencia ficticia'
            });
        }
        await connection.commit();
    } catch (error) {
        try { await connection.rollback(); } catch (rollbackError) {
            connection.destroy();
            throw new AggregateError([error, rollbackError], 'Fallo la carga y su rollback.');
        }
        throw error;
    }
    return performance.now() - inicio;
}

async function medirLectura(connection, valores) {
    for (let i = 0; i < 5; i++) await connection.execute(SQL_HISTORIAL, valores);
    const tiempos = [];
    for (let i = 0; i < 50; i++) {
        const inicio = performance.now();
        await connection.execute(SQL_HISTORIAL, valores);
        tiempos.push(performance.now() - inicio);
    }
    const [plan] = await connection.execute(`EXPLAIN ${SQL_HISTORIAL}`, valores);
    return { ...resumen(tiempos), calentamiento: 5, explain: plan };
}

async function cargar(connection, esquema, informar = console.log) {
    const [[identidad]] = await connection.execute('SELECT DATABASE() AS base');
    if (identidad.base !== BASE || esquema.base !== BASE) throw new Error('Carga bloqueada fuera de la base test autorizada.');
    if (esquema.faltantes.length) throw new Error(`Esquema incompatible: ${esquema.faltantes.join('; ')}`);
    const prefijo = `CARGA-${randomUUID()}`;
    const reporte = { prefijo, base: BASE, version: esquema.version, etapas: [] };
    informar(JSON.stringify({ inicio: true, prefijo, datos: 'Se conservaran; sin borrado automatico.' }));
    const fixture = `${prefijo}-CURSOR`;
    await insertar(connection, esquema.columnas, fixture, 60);
    let cursor = null;
    const vistos = new Set();
    do {
        const [filas] = await connection.execute(SQL_HISTORIAL, [fixture, cursor, cursor, 26]);
        const pagina = filas.slice(0, 25);
        for (const fila of pagina) {
            if (vistos.has(fila.id)) throw new Error('Evento duplicado al paginar.');
            if ('ip_address' in fila || 'session_id' in fila) throw new Error('Proyeccion publica con datos sensibles.');
            vistos.add(fila.id);
        }
        cursor = filas.length > 25 ? pagina.at(-1).id : null;
    } while (cursor !== null);
    if (vistos.size !== 60) throw new Error('Paginacion incompleta del fixture.');
    const [[filaCursor]] = await connection.execute(
        'SELECT MAX(id) AS id FROM historial_radicado WHERE numero_radicado = ?', [fixture]);
    let insertados = 0;
    for (const objetivo of [1000, 10000]) {
        const tiempos = [];
        while (insertados < objetivo) {
            tiempos.push(await insertar(connection, esquema.columnas, `${prefijo}-${insertados + 1}`, 10));
            insertados++;
            if (insertados % 1000 === 0) informar(JSON.stringify({ prefijo, confirmados: insertados }));
        }
        const [[conteo]] = await connection.execute(
            'SELECT COUNT(*) AS cantidad FROM radicados WHERE numero_radicado LIKE ?', [`${prefijo}-%`]);
        const [[eventos]] = await connection.execute(
            'SELECT COUNT(*) AS cantidad FROM historial_radicado WHERE numero_radicado LIKE ?', [`${prefijo}-%`]);
        const [incorrectos] = await connection.execute(
            `SELECT numero_radicado FROM historial_radicado
             WHERE numero_radicado LIKE ? AND numero_radicado <> ?
             GROUP BY numero_radicado HAVING COUNT(*) <> 10`, [`${prefijo}-%`, fixture]);
        if (Number(conteo.cantidad) !== objetivo + 1 || Number(eventos.cantidad) !== objetivo * 10 + 60 || incorrectos.length) {
            throw new Error('Los conteos de la carga no coinciden con lo esperado.');
        }
        const etapa = {
            radicados: objetivo, eventos: objetivo * 10, fixture_adicional: { radicados: 1, eventos: 60 },
            escritura_radicado_y_10_eventos: resumen(tiempos),
            primera_pagina: await medirLectura(connection, [`${prefijo}-1`, null, null, 26]),
            pagina_cursor: await medirLectura(connection, [fixture, filaCursor.id - 25, filaCursor.id - 25, 26]),
            sin_eventos: await medirLectura(connection, [`${prefijo}-INEXISTENTE`, null, null, 26])
        };
        reporte.etapas.push(etapa);
        informar(JSON.stringify({ etapa }));
    }
    const [tamano] = await connection.execute(
        `SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, INDEX_LENGTH
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('radicados','historial_radicado')`, [BASE]);
    reporte.tamano_estimado_tablas_completas = tamano;
    return reporte;
}

async function main() {
    const config = configuracion(process.env);
    const args = process.argv.slice(2);
    if (args.some(arg => !['--inspeccionar', '--ejecutar'].includes(arg)) || args.length !== 1) {
        throw new Error('Usa --inspeccionar (solo lectura) o --ejecutar (conserva datos ficticios).');
    }
    const connection = await mysql.createConnection(config);
    try {
        const esquema = await inspeccionar(connection);
        console.log(JSON.stringify({ inspeccion: esquema }, null, 2));
        if (args[0] === '--ejecutar') console.log(JSON.stringify({ resultado: await cargar(connection, esquema) }, null, 2));
        if (esquema.faltantes.length) throw new Error(`No se puede cargar: ${esquema.faltantes.join('; ')}`);
    } finally { await connection.end(); }
}

if (require.main === module) main().catch(error => {
    console.error('Medicion detenida:', error);
    process.exitCode = 1;
});

module.exports = { BASE, SQL_HISTORIAL, configuracion, resumen, inspeccionar, insertar, cargar };
