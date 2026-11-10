const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { agregarDias, obtenerFechaLocal } = require('../semaforo');
const { obtenerTiempoRespuesta } = require('../plazos');
const { registrarEventoRadicado } = require('../audit-log');
const { revertirTrasError } = require('../transacciones');

const CANTIDAD = 100;
const BASE = 'ventanilla_unica';
const DESTINO = 'Oficina de Planeaci\u00f3n';

function configuracion(args, env = process.env) {
    if (env.DB_NAME !== BASE) {
        throw new Error(`Selecciona explicitamente DB_NAME=${BASE}. No se admite otra base.`);
    }
    const permitidos = new Set(['--confirmar-desarrollo', '--inspeccionar']);
    for (const arg of args) {
        if (!permitidos.has(arg) && !arg.startsWith('--lote=')) {
            throw new Error(`Argumento desconocido: ${arg}`);
        }
    }
    const lotes = args.filter(arg => arg.startsWith('--lote='));
    if (lotes.length > 1) throw new Error('Indica un solo lote.');
    const lote = lotes[0]?.slice('--lote='.length) ||
        `SEED-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID()}`;
    if (!/^SEED-[A-Za-z0-9-]{1,70}$/.test(lote)) {
        throw new Error('El lote debe empezar por SEED- y contener solo letras, numeros y guiones (maximo 75 caracteres).');
    }
    const inspeccionar = args.includes('--inspeccionar');
    if (!inspeccionar && !args.includes('--confirmar-desarrollo')) {
        throw new Error('La escritura requiere --confirmar-desarrollo; usa --inspeccionar para solo lectura.');
    }
    return { base: BASE, lote, inspeccionar };
}

function numerosLote(lote) {
    return Array.from({ length: CANTIDAD }, (_, indice) =>
        `${lote}-${String(indice + 1).padStart(4, '0')}`);
}

async function inspeccionar(connection, opciones, hoy) {
    const [base] = await connection.execute('SELECT DATABASE() AS nombre');
    if (base[0]?.nombre !== BASE) throw new Error('La conexion no corresponde a la base de desarrollo confirmada.');
    const [dependencias] = await connection.execute(
        'SELECT id, nombre FROM dependencias WHERE nombre = ? AND activo = 1', [DESTINO]);
    if (dependencias.length !== 1) throw new Error('No existe una unica Oficina de Planeacion activa.');
    const [actores] = await connection.execute(
        "SELECT id, nombre, rol FROM usuarios WHERE rol = 'ventanilla' AND activo = 1 ORDER BY id LIMIT 1");
    if (!actores.length) throw new Error('Se requiere un usuario activo de Ventanilla para atribuir el seeding.');
    const [terminos] = await connection.execute(
        `SELECT t.id, t.nombre, l.id AS termino_legal_id, l.dias, l.tipo_dias, l.fundamento_legal
         FROM tipos_tramite t JOIN terminos_legales l ON l.tipo_tramite_id = t.id
         WHERE t.activo = 1 AND t.requiere_respuesta = 1
           AND l.vigente_desde <= ? AND (l.vigente_hasta IS NULL OR l.vigente_hasta >= ?)
         ORDER BY t.id, l.vigente_desde DESC, l.id DESC LIMIT 1`, [hoy, hoy]);
    if (!terminos.length) throw new Error('No hay un tramite activo con termino vigente que requiera respuesta.');
    const [existentes] = await connection.execute(
        `SELECT numero_radicado FROM radicados WHERE LOCATE(?, numero_radicado) = 1
         UNION ALL SELECT numero_radicado FROM radicado_terminos WHERE LOCATE(?, numero_radicado) = 1
         UNION ALL SELECT numero_radicado FROM historial_radicado WHERE LOCATE(?, numero_radicado) = 1
         LIMIT 1`, [`${opciones.lote}-`, `${opciones.lote}-`, `${opciones.lote}-`]);
    if (existentes.length) throw new Error('El lote ya existe. No se reintentara ni duplicara la siembra.');
    const [secuencia] = await connection.execute('SELECT ano, ultimo_numero FROM secuencias_radicado ORDER BY ano');
    const [total] = await connection.execute('SELECT COUNT(*) AS total FROM radicados');
    return { dependencia: dependencias[0], actor: actores[0], termino: terminos[0],
        secuencia, totalAnterior: Number(total[0].total) };
}

async function verificarLote(connection, numeros, dependenciaId) {
    const placeholders = numeros.map(() => '?').join(', ');
    for (const [tabla, esperado] of [
        ['radicados', CANTIDAD], ['radicado_terminos', CANTIDAD],
        ['comunicaciones_externas', CANTIDAD], ['historial_radicado', CANTIDAD * 3],
        ['documentos_radicado', 0], ['respuestas_radicado', 0]
    ]) {
        const [rows] = await connection.execute(
            `SELECT COUNT(*) AS total FROM ${tabla} WHERE numero_radicado IN (${placeholders})`, numeros);
        assert.equal(Number(rows[0].total), esperado, `Cantidad incorrecta en ${tabla}.`);
    }
    const [relaciones] = await connection.execute(
        `SELECT COUNT(*) AS total FROM radicados r
         JOIN radicado_terminos rt ON rt.numero_radicado = r.numero_radicado
         JOIN comunicaciones_externas ce ON ce.numero_radicado = r.numero_radicado
         WHERE r.numero_radicado IN (${placeholders}) AND r.dependencia_destino_id = ?
           AND r.estado = 'Recibido' AND r.destino_todas_dependencias = 0
           AND r.requiere_respuesta = 1 AND rt.fecha_respuesta IS NULL
           AND rt.fecha_limite_inicial = rt.fecha_limite_actual`, [...numeros, dependenciaId]);
    assert.equal(Number(relaciones[0].total), CANTIDAD, 'Las relaciones del lote no son coherentes.');
    const [eventos] = await connection.execute(
        `SELECT numero_radicado, COUNT(DISTINCT event_type) AS tipos, COUNT(*) AS total
         FROM historial_radicado WHERE numero_radicado IN (${placeholders})
         GROUP BY numero_radicado`, numeros);
    assert.equal(eventos.length, CANTIDAD);
    assert.ok(eventos.every(evento => Number(evento.tipos) === 3 && Number(evento.total) === 3));
}

async function sembrar(pool, opciones) {
    let connection = await pool.getConnection();
    let transaccion = false;
    let commitIntentado = false;
    const instante = new Date();
    const hoy = obtenerFechaLocal(instante, 'fecha de recepcion');
    try {
        if (!opciones.inspeccionar) {
            await connection.beginTransaction();
            transaccion = true;
        }
        const contexto = await inspeccionar(connection, opciones, hoy);
        const { dependencia, actor, termino } = contexto;
        const fechaLimite = agregarDias(hoy, termino.dias, termino.tipo_dias);
        const resumen = { base: BASE, lote: opciones.lote, cantidad: CANTIDAD,
            dependencia, tramite: termino.nombre, fecha_limite: fechaLimite,
            total_anterior: contexto.totalAnterior, secuencia_antes: contexto.secuencia };
        if (opciones.inspeccionar) return { ...resumen, escrito: false };
        const campos = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
        }).formatToParts(instante).map(parte => [parte.type, parte.value]));
        const recepcion = `${hoy} ${campos.hour}:${campos.minute}:${campos.second}`;
        const numeros = numerosLote(opciones.lote);
        for (const [indice, numero] of numeros.entries()) {
            const identificador = String(indice + 1).padStart(4, '0');
            await connection.execute(
                `INSERT INTO radicados
                    (numero_radicado, tipo_recepcion, tipo_comunicacion, tipo_documento, tiempo_de_respuesta,
                     remitente_nombre, remitente_documento, remitente_telefono, remitente_email,
                     remitente_tipo_persona, numero_folios, fecha_hora_recepcion, fecha_creacion,
                     dependencia_destino, dependencia_destino_id, asunto_documento, usuario_recibe,
                     estado, destino_todas_dependencias, requiere_respuesta)
                 VALUES (?, 'Digital', 'Externa', ?, ?, ?, ?, 'No especificado', ?,
                     'natural', 0, ?, ?, ?, ?, ?, ?, 'Recibido', 0, 1)`,
                [numero, termino.nombre, obtenerTiempoRespuesta(termino),
                    `Remitente ficticio SEED ${identificador}`, `SEED-${identificador}`,
                    `seed-${identificador}@example.test`, recepcion, recepcion, dependencia.nombre, dependencia.id,
                    `PRUEBA FICTICIA DE PAGINACION. Lote ${opciones.lote}. Registro ${identificador}. Sin PDF.`,
                    actor.nombre]);
            await connection.execute('INSERT INTO comunicaciones_externas(numero_radicado) VALUES (?)', [numero]);
            await connection.execute(
                `INSERT INTO radicado_terminos
                    (numero_radicado, tipo_tramite_id, termino_legal_id, fecha_recepcion,
                     termino_dias_aplicado, tipo_dias_aplicado, fundamento_legal_aplicado,
                     fecha_limite_inicial, fecha_limite_actual)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [numero, termino.id, termino.termino_legal_id, hoy, termino.dias,
                    termino.tipo_dias, termino.fundamento_legal, fechaLimite, fechaLimite]);
            for (const [tipo, valorNuevo] of [
                ['regla_respuesta_aplicada', JSON.stringify({
                    tipo_tramite_id: termino.id, requiere_respuesta: true,
                    termino_legal_id: termino.termino_legal_id, dias: termino.dias,
                    tipo_dias: termino.tipo_dias, fundamento_legal: termino.fundamento_legal, fecha_limite: fechaLimite
                })],
                ['radicado_creado', dependencia.nombre],
                ['radicado_asignado', dependencia.nombre]
            ]) {
                await registrarEventoRadicado(connection, { usuario: actor }, {
                    numeroRadicado: numero, tipo, valorNuevo,
                    dependenciaId: dependencia.id, dependenciaNombre: dependencia.nombre,
                    motivo: `SEED automatizado de datos ficticios para paginacion (${opciones.lote}); no es una radicacion humana ni tiene adjuntos.`
                });
            }
        }
        await verificarLote(connection, numeros, dependencia.id);
        const [secuencia] = await connection.execute('SELECT ano, ultimo_numero FROM secuencias_radicado ORDER BY ano');
        assert.deepEqual(secuencia, contexto.secuencia, 'La secuencia oficial cambio durante la siembra.');
        commitIntentado = true;
        await connection.commit();
        transaccion = false;
        return { ...resumen, escrito: true, numeros, eventos: CANTIDAD * 3, secuencia_despues: secuencia };
    } catch (error) {
        if (transaccion) {
            const reversion = await revertirTrasError(connection, error);
            connection = reversion.connection;
            error = reversion.error;
        }
        if (commitIntentado) {
            throw new Error(`No se pudo confirmar el commit del lote ${opciones.lote}; verifica su persistencia antes de reintentar.`, { cause: error });
        }
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

async function ejecutar() {
    const opciones = configuracion(process.argv.slice(2));
    const pool = require('../db');
    try {
        console.log(`Lote seleccionado: ${opciones.lote}`);
        console.log(JSON.stringify(await sembrar(pool, opciones), null, 2));
    } finally {
        await pool.end();
    }
}

if (require.main === module) ejecutar().catch(error => {
    console.error('Seeding no confirmado:', error);
    process.exitCode = 1;
});

module.exports = { CANTIDAD, configuracion, numerosLote, inspeccionar, verificarLote, sembrar };
