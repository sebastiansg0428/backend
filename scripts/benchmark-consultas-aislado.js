/*
 * Benchmark aislado de consultas MariaDB.
 *
 * Uso:
 *   DB_HOST=127.0.0.1 DB_NAME=ventanilla_unica node scripts/benchmark-consultas-aislado.js > benchmark.json
 *
 * El script nunca escribe en la base fuente. Crea una base con nombre aleatorio,
 * copia su DDL, la puebla y la elimina en finally.
 */
const { randomUUID, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const mysql = require('mysql2/promise');

const FUENTE = process.env.BENCH_SOURCE_DB || 'ventanilla_unica';
const HOST = process.env.DB_HOST || '127.0.0.1';
const USER = process.env.DB_USER || 'root';
const PASSWORD = process.env.DB_PASSWORD || '';
const MUESTRAS = Number(process.env.BENCH_SAMPLES || 7);
const CALENTAMIENTO = Number(process.env.BENCH_WARMUP || 1);
const ROLES_SOLICITADOS = (process.env.BENCH_ROLES || 'administrador,ventanilla,funcionario-1,funcionario-5')
    .split(',').map(valor => valor.trim()).filter(Boolean);
const TAMANO_LOTE = 500;
const ESTADOS = ['Recibido', 'Pendiente', 'Respondido', 'Vencido', 'Entregado'];
const FECHA_BASE = '2026-11-17';

function identificador(valor) {
    if (!/^[a-zA-Z0-9_]+$/.test(valor)) throw new Error(`Identificador inválido: ${valor}`);
    return `\`${valor}\``;
}

async function insertarLotes(connection, tabla, columnas, filas) {
    if (!filas.length) return;
    const columnasSql = columnas.map(identificador).join(', ');
    for (let inicio = 0; inicio < filas.length; inicio += TAMANO_LOTE) {
        const lote = filas.slice(inicio, inicio + TAMANO_LOTE);
        const placeholders = lote.map(fila => `(${fila.map(() => '?').join(', ')})`).join(', ');
        await connection.execute(
            `INSERT INTO ${identificador(tabla)} (${columnasSql}) VALUES ${placeholders}`,
            lote.flat());
    }
}

async function crearBaseTemporal(admin) {
    const base = `ventanilla_consulta_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${identificador(base)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    try {
        const [tablas] = await admin.execute(
            `SELECT TABLE_NAME AS nombre
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
             ORDER BY TABLE_NAME`, [FUENTE]);
        if (!tablas.length) throw new Error(`La base fuente ${FUENTE} no tiene tablas.`);
        await admin.query(`USE ${identificador(base)}`);
        await admin.query('SET FOREIGN_KEY_CHECKS=0');
        try {
            for (const { nombre } of tablas) {
                if (!/^\w+$/.test(nombre)) throw new Error(`Nombre de tabla no permitido: ${nombre}`);
                const [ddl] = await admin.query(
                    `SHOW CREATE TABLE ${identificador(FUENTE)}.${identificador(nombre)}`);
                await admin.query(ddl[0]['Create Table']);
            }
        } finally {
            await admin.query('SET FOREIGN_KEY_CHECKS=1');
        }
        const [referencias] = await admin.execute(
            `SELECT DISTINCT REFERENCED_TABLE_SCHEMA AS esquema
             FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`);
        if (referencias.some(({ esquema }) => esquema !== base)) {
            throw new Error('La copia contiene una clave foránea fuera de la base temporal.');
        }
        return base;
    } catch (error) {
        await admin.query(`DROP DATABASE IF EXISTS ${identificador(base)}`);
        throw error;
    }
}

async function cargarDatos(pool) {
    const dependencias = Array.from({ length: 10 }, (_, i) => [`Benchmark ${String(i + 1).padStart(2, '0')}`, 1]);
    await insertarLotes(pool, 'dependencias', ['nombre', 'activo'], dependencias);
    const [dependenciaRows] = await pool.execute('SELECT id FROM dependencias ORDER BY id');
    const dependenciaIds = dependenciaRows.map(row => row.id);

    const tipos = Array.from({ length: 5 }, (_, i) => [
        `benchmark_tipo_${i + 1}`, `Solicitud benchmark ${i + 1}`, 'peticion_general', 1, i + 1, 1]);
    await insertarLotes(pool, 'tipos_tramite',
        ['codigo', 'nombre', 'categoria_general', 'activo', 'orden', 'requiere_respuesta'], tipos);
    const [tipoRows] = await pool.execute('SELECT id FROM tipos_tramite ORDER BY id');
    const tipoIds = tipoRows.map(row => row.id);
    const terminos = tipoIds.map((id, i) => [id, 15 + i, i % 2 ? 'calendario' : 'habiles',
        'Regla legal sintética del benchmark', '2020-01-01']);
    await insertarLotes(pool, 'terminos_legales',
        ['tipo_tramite_id', 'dias', 'tipo_dias', 'fundamento_legal', 'vigente_desde'], terminos);
    const [terminoRows] = await pool.execute('SELECT id, tipo_tramite_id FROM terminos_legales ORDER BY id');
    const terminoPorTipo = new Map(terminoRows.map(row => [row.tipo_tramite_id, row.id]));

    const usuarios = [
        ['Usuario benchmark administrador', 'admin@benchmark.test', 'benchmark-password', 'administrador', null, 1],
        ['Usuario benchmark ventanilla', 'ventanilla@benchmark.test', 'benchmark-password', 'ventanilla', null, 1],
        ...dependenciaIds.map((id, i) => [
            `Funcionario benchmark ${i + 1}`, `funcionario${i + 1}@benchmark.test`,
            'benchmark-password', 'funcionario', id, 1])
    ];
    await insertarLotes(pool, 'usuarios',
        ['nombre', 'email', 'password', 'rol', 'dependencia_id', 'activo'], usuarios);
    const [usuarioRows] = await pool.execute('SELECT id, rol, dependencia_id FROM usuarios ORDER BY id');
    const usuarioAdmin = usuarioRows.find(row => row.rol === 'administrador').id;
    const usuarioVentanilla = usuarioRows.find(row => row.rol === 'ventanilla').id;
    const usuarioFuncionario = usuarioRows.filter(row => row.rol === 'funcionario');

    const radicados = [];
    const terminosRadicado = [];
    const asignaciones = [];
    for (let i = 1; i <= 10000; i++) {
        const numero = `BENCH-2026-${String(i).padStart(5, '0')}`;
        const dependencia = dependenciaIds[(i - 1) % dependenciaIds.length];
        const global = i % 10 === 0;
        const interno = i % 20 === 0;
        const estado = ESTADOS[(i - 1) % ESTADOS.length];
        const tipoId = tipoIds[(i - 1) % tipoIds.length];
        const dia = String(((i - 1) % 28) + 1).padStart(2, '0');
        const fecha = `2026-10-${dia}`;
        radicados.push([
            interno ? 'Interna' : 'Externa', numero, 'Presencial', 'Solicitud',
            `Remitente benchmark ${i % 200}`, `DOC-${String(i).padStart(8, '0')}`,
            `300${String(i % 10000000).padStart(7, '0')}`, dependencia,
            `Asunto sintético ${i}`, `Funcionario recepción ${i % 10}`,
            estado, fecha, '15 días hábiles', dependencia, global ? 1 : 0,
            `${fecha} 08:00:00`, null, null, interno ? 0 : 1
        ]);
        const limite = i % 5 === 0 ? '2026-11-10' : i % 5 === 1 ? '2026-11-19' : '2026-12-30';
        terminosRadicado.push([
            numero, tipoId, terminoPorTipo.get(tipoId), fecha, 15, 'habiles',
            'Regla legal sintética del benchmark', limite, limite,
            estado === 'Respondido' || estado === 'Entregado' ? `${fecha} 09:00:00` : null
        ]);
        if (global) {
            for (const id of dependenciaIds) {
                asignaciones.push([numero, id, id === dependencia ? estado : 'Recibido',
                    id === dependencia && ['Respondido', 'Entregado'].includes(estado) ? `${fecha} 09:00:00` : null]);
            }
        }
    }
    await insertarLotes(pool, 'radicados', [
        'tipo_comunicacion', 'numero_radicado', 'tipo_recepcion', 'tipo_documento',
        'remitente_nombre', 'remitente_documento', 'remitente_telefono', 'dependencia_destino',
        'asunto_documento', 'usuario_recibe', 'estado', 'fecha_hora_recepcion',
        'tiempo_de_respuesta', 'dependencia_destino_id', 'destino_todas_dependencias',
        'fecha_creacion', 'dependencia_remitente_id', 'dependencia_remitente', 'requiere_respuesta'
    ], radicados);
    await insertarLotes(pool, 'radicado_terminos', [
        'numero_radicado', 'tipo_tramite_id', 'termino_legal_id', 'fecha_recepcion',
        'termino_dias_aplicado', 'tipo_dias_aplicado', 'fundamento_legal_aplicado',
        'fecha_limite_inicial', 'fecha_limite_actual', 'fecha_respuesta'
    ], terminosRadicado);
    await insertarLotes(pool, 'radicado_dependencias',
        ['numero_radicado', 'dependencia_id', 'estado', 'fecha_respuesta'], asignaciones);

    const [asignacionRows] = await pool.execute(
        `SELECT id, numero_radicado FROM radicado_dependencias ORDER BY id`);
    const asignacionPorNumero = new Map();
    for (const row of asignacionRows) if (!asignacionPorNumero.has(row.numero_radicado)) {
        asignacionPorNumero.set(row.numero_radicado, row.id);
    }
    const respuestas = [];
    for (let i = 1; i <= 2000; i++) {
        const numero = `BENCH-2026-${String(i).padStart(5, '0')}`;
        const global = i % 10 === 0;
        respuestas.push([
            numero, global ? asignacionPorNumero.get(numero) : null,
            `Respuesta institucional sintética ${i}`, null, null, null,
            global ? usuarioFuncionario[(i - 1) % usuarioFuncionario.length].id : usuarioFuncionario[(i - 1) % usuarioFuncionario.length].id
        ]);
    }
    await insertarLotes(pool, 'respuestas_radicado',
        ['numero_radicado', 'radicado_dependencia_id', 'contenido', 'plantilla',
            'nombre_archivo', 'ruta_archivo', 'usuario_id'], respuestas);
    const [respuestaRows] = await pool.execute('SELECT id, numero_radicado FROM respuestas_radicado ORDER BY id');
    const respuestasPorNumero = new Map(respuestaRows.map(row => [row.numero_radicado, row.id]));

    const historial = [];
    for (let i = 1; i <= 10000; i++) {
        const numero = `BENCH-2026-${String(i).padStart(5, '0')}`;
        historial.push([
            numero, 'estado', 'Recibido', ESTADOS[(i - 1) % ESTADOS.length],
            'Usuario benchmark', 'Evento sintético del benchmark', 'estado_cambiado',
            usuarioVentanilla, 'Usuario benchmark ventanilla', 'ventanilla', null, null,
            null, null, null, '2026-11-17 12:00:00'
        ]);
    }
    await insertarLotes(pool, 'historial_radicado', [
        'numero_radicado', 'campo_modificado', 'valor_anterior', 'valor_nuevo', 'usuario',
        'motivo', 'event_type', 'actor_id', 'actor_name', 'actor_role', 'dependencia_id',
        'dependencia_nombre', 'radicado_dependencia_id', 'session_id', 'ip_address', 'ocurrido_en_utc'
    ], historial);

    const traslados = [];
    for (let i = 1; i <= 200; i++) {
        const numero = `BENCH-2026-${String(i).padStart(5, '0')}`;
        const origen = dependenciaIds[(i - 1) % dependenciaIds.length];
        const destino = dependenciaIds[i % dependenciaIds.length];
        const pendiente = i <= 100;
        const clave = randomUUID();
        traslados.push([
            numero, origen, `Benchmark ${origen}`, destino, `Benchmark ${destino}`,
            pendiente ? null : destino, pendiente ? null : `Benchmark ${destino}`,
            usuarioFuncionario[(i - 1) % usuarioFuncionario.length].id,
            'Funcionario benchmark', pendiente ? null : usuarioVentanilla,
            pendiente ? null : 'Usuario benchmark ventanilla', 'Motivo sintético',
            pendiente ? null : 'Decisión sintética', pendiente ? 'pendiente' : 'aprobada', clave,
            createHash('sha256').update(clave).digest('hex'), null,
            '2026-11-17 12:00:00', pendiente ? null : '2026-11-17 12:01:00'
        ]);
    }
    await insertarLotes(pool, 'solicitudes_traslado', [
        'numero_radicado', 'origen_id', 'origen_nombre', 'destino_sugerido_id',
        'destino_sugerido_nombre', 'destino_aprobado_id', 'destino_aprobado_nombre',
        'solicitante_id', 'solicitante_nombre', 'decisor_id', 'decisor_nombre',
        'motivo_solicitud', 'motivo_decision', 'estado', 'clave_solicitud',
        'huella_solicitud', 'fecha_limite_conservada', 'creado_en_utc', 'resuelto_en_utc'
    ], traslados);

    const entregas = [];
    for (let i = 1; i <= 100; i++) {
        const numero = `BENCH-2026-${String(i).padStart(5, '0')}`;
        entregas.push([
            respuestasPorNumero.get(numero), 'presencial', i % 3 === 0 ? 'entrega_acreditada' : 'enviado',
            `Remitente benchmark ${i}`, 'Ventanilla única', '2026-11-17 12:00:00',
            'Registro sintético del benchmark', usuarioVentanilla, 'Usuario benchmark ventanilla',
            randomUUID(), createHash('sha256').update(`entrega-${i}`).digest('hex'), '2026-11-17 12:00:01'
        ]);
    }
    await insertarLotes(pool, 'registros_entrega_respuesta', [
        'respuesta_id', 'canal', 'resultado', 'destinatario', 'destino', 'fecha_actuacion_utc',
        'observaciones', 'actor_id', 'actor_nombre', 'clave', 'huella', 'creado_en_utc'
    ], entregas);
    const [entregaRows] = await pool.execute(
        `SELECT id FROM registros_entrega_respuesta WHERE resultado = 'entrega_acreditada' ORDER BY id`);
    await insertarLotes(pool, 'entregas_confirmacion', ['registro_id'], entregaRows.map(row => [row.id]));
    await insertarLotes(pool, 'evidencias_entrega', [
        'registro_id', 'nombre_archivo', 'ruta_archivo', 'tipo_mime', 'tamano_bytes', 'sha256'
    ], entregaRows.map((row, i) => [row.id, `evidencia-${i + 1}.pdf`, `bench-evidencia-${i + 1}.pdf`,
        'application/pdf', 1024, createHash('sha256').update(`evidencia-${i}`).digest('hex')]));

    return { radicados: radicados.length, dependencias: dependenciaIds.length,
        respuestas: respuestas.length, historial: historial.length,
        traslados: traslados.length, entregas: entregas.length };
}

function percentil(valores, porcentaje) {
    const ordenados = [...valores].sort((a, b) => a - b);
    return ordenados[Math.max(0, Math.ceil(ordenados.length * porcentaje) - 1)];
}

async function medir(operacion, muestras = MUESTRAS) {
    for (let i = 0; i < CALENTAMIENTO; i++) await operacion();
    const tiempos = [];
    let ultimo;
    for (let i = 0; i < muestras; i++) {
        const inicio = performance.now();
        ultimo = await operacion();
        tiempos.push(performance.now() - inicio);
    }
    return {
        muestras, p50_ms: Number(percentil(tiempos, 0.5).toFixed(3)),
        p95_ms: Number(percentil(tiempos, 0.95).toFixed(3)),
        max_ms: Number(Math.max(...tiempos).toFixed(3)),
        filas_devuelta: ultimo.filas,
        bytes_serializados: Buffer.byteLength(JSON.stringify(ultimo.resultado))
    };
}

function resumirPlan(plan) {
    const filas = Array.isArray(plan) ? plan : [];
    return filas.map(fila => ({
        select_id: fila.select_id, table: fila.table, type: fila.type,
        possible_keys: fila.possible_keys, key: fila.key, rows: fila.rows,
        Extra: fila.Extra
    }));
}

async function medirSql(connection, nombre, sql, valores = []) {
    const [plan] = await connection.execute(`EXPLAIN ${sql}`, valores);
    const medicion = await medir(async () => {
        const [rows] = await connection.execute(sql, valores);
        return { filas: rows.length, resultado: rows };
    });
    return { nombre, ...medicion, explain: resumirPlan(plan) };
}

async function benchmarkConsultas(pool) {
    // db.js informa su inicialización por stdout; se silencia solo durante el
    // require para que la salida del benchmark sea JSON válido.
    const logOriginal = console.log;
    let consultarPagina;
    let opcionesConsulta;
    try {
        console.log = () => {};
        ({ consultarPagina, opcionesConsulta } = require('../consulta-radicados'));
    } finally {
        console.log = logOriginal;
    }
    const escenarios = [];
    const planes = new Map();
    let consultasEjecutadas = 0;
    const poolInstrumentado = {
        async getConnection() {
            const connection = await pool.getConnection();
            return {
                query: (...args) => connection.query(...args),
                commit: () => connection.commit(), rollback: () => connection.rollback(),
                destroy: () => connection.destroy(), release: () => connection.release(),
                async execute(sql, valores) {
                    consultasEjecutadas++;
                    if (!planes.has(sql)) {
                        const [plan] = await connection.execute(`EXPLAIN ${sql}`, valores);
                        planes.set(sql, resumirPlan(plan));
                    }
                    return connection.execute(sql, valores);
                }
            };
        }
    };
    const roles = [
        { nombre: 'administrador', rol: 'administrador', dependencia_id: null },
        { nombre: 'ventanilla', rol: 'ventanilla', dependencia_id: null },
        { nombre: 'funcionario-1', rol: 'funcionario', dependencia_id: 1 },
        { nombre: 'funcionario-5', rol: 'funcionario', dependencia_id: 5 }
    ].filter(usuario => ROLES_SOLICITADOS.includes(usuario.nombre));
    if (!roles.length) throw new Error('BENCH_ROLES no seleccionó ningún rol válido.');
    const consultas = [
        ['pagina-1', { pagina: '1' }], ['pagina-intermedia', { pagina: '200' }],
        ['pagina-profunda', { pagina: '400' }],
        ['busqueda-numero', { pagina: '1', busqueda: 'BENCH-2026-00001' }],
        ['busqueda-remitente', { pagina: '1', busqueda: 'Remitente benchmark 42' }],
        ['busqueda-documento', { pagina: '1', busqueda: '00000042' }],
        ['filtro-hoy', { pagina: '1', hoy: '1' }],
        ['filtro-criticos', { pagina: '1', criticos: '1' }]
    ];
    for (const usuario of roles) for (const [nombre, query] of consultas) {
        console.error(`[benchmark] bandeja ${usuario.nombre}/${nombre}`);
        const opciones = opcionesConsulta(query);
        const consultasAntes = consultasEjecutadas;
        const medida = await medir(async () => {
            const resultado = await consultarPagina(poolInstrumentado, usuario, opciones);
            return { filas: resultado.radicados.length, resultado };
        });
        escenarios.push({ categoria: 'bandeja', rol: usuario.nombre, escenario: nombre,
            consultas_sql: consultasEjecutadas - consultasAntes, ...medida });
    }
    for (const usuario of roles.filter(row => row.rol !== 'ventanilla')) {
        console.error(`[benchmark] alertas ${usuario.nombre}`);
        const opciones = opcionesConsulta({ pagina: '1' });
        const consultasAntes = consultasEjecutadas;
        const medida = await medir(async () => {
            const resultado = await consultarPagina(poolInstrumentado, usuario, opciones,
                usuario.dependencia_id, true);
            return { filas: resultado.alertas.length, resultado };
        });
        escenarios.push({ categoria: 'alertas', rol: usuario.nombre, escenario: 'alertas-dependencia',
            consultas_sql: consultasEjecutadas - consultasAntes, ...medida });
    }
    const connection = await pool.getConnection();
    try {
        const sqls = [
            ['historial-cursor', `SELECT * FROM historial_radicado
                WHERE numero_radicado = ? AND id < ? ORDER BY id DESC LIMIT 25`,
                ['BENCH-2026-00001', 100000000]],
            ['entregas', `SELECT * FROM registros_entrega_respuesta er
                JOIN respuestas_radicado rr ON rr.id = er.respuesta_id
                WHERE rr.numero_radicado = ? ORDER BY er.id DESC LIMIT 25`, ['BENCH-2026-00001']],
            ['respuestas-internas', `SELECT rr.* FROM respuestas_radicado rr
                JOIN radicados r ON r.numero_radicado = rr.numero_radicado
                WHERE r.tipo_comunicacion = 'Interna' ORDER BY rr.id DESC LIMIT 25`, []],
            ['traslados', `SELECT * FROM solicitudes_traslado
                WHERE estado = 'pendiente' ORDER BY id DESC LIMIT 25`, []]
        ];
        for (const [nombre, sql, valores] of sqls) {
            console.error(`[benchmark] relacionada ${nombre}`);
            escenarios.push({
            categoria: 'relacionadas', ...(await medirSql(connection, nombre, sql, valores))
            });
        }
    } finally { connection.release(); }
    return { escenarios, planes_consulta_radicados: [...planes.values()] };
}

async function ejecutar() {
    if (FUENTE === 'ventanilla_consulta_test' || FUENTE.startsWith('ventanilla_consulta_')) {
        throw new Error('La base fuente no puede ser una base temporal del benchmark.');
    }
    if (!Number.isInteger(MUESTRAS) || MUESTRAS < 3 || MUESTRAS > 100) {
        throw new Error('BENCH_SAMPLES debe ser un entero entre 3 y 100.');
    }
    if (!Number.isInteger(CALENTAMIENTO) || CALENTAMIENTO < 0 || CALENTAMIENTO > 5) {
        throw new Error('BENCH_WARMUP debe ser un entero entre 0 y 5.');
    }
    const admin = await mysql.createConnection({ host: HOST, user: USER, password: PASSWORD, dateStrings: true });
    let baseTemporal;
    let pool;
    try {
        baseTemporal = await crearBaseTemporal(admin);
        pool = mysql.createPool({ host: HOST, user: USER, password: PASSWORD, database: baseTemporal,
            waitForConnections: true, connectionLimit: 10, queueLimit: 10, dateStrings: true });
        const carga = await cargarDatos(pool);
        const mediciones = await benchmarkConsultas(pool);
        const [conteos] = await pool.query(`SELECT
            (SELECT COUNT(*) FROM radicados) AS radicados,
            (SELECT COUNT(*) FROM dependencias) AS dependencias,
            (SELECT COUNT(*) FROM historial_radicado) AS historial`);
        console.log(JSON.stringify({
            benchmark: 'consultas-mariadb-aislado', fuente: FUENTE, base_temporal: baseTemporal,
            muestras: MUESTRAS, calentamiento: CALENTAMIENTO, roles: ROLES_SOLICITADOS,
            carga, conteos_finales: conteos[0], ...mediciones,
            notas: [
                'La base fuente no se modificó.',
                'ventanilla_unica_test no se reparó ni se eliminó.',
                'La base temporal se elimina al finalizar el proceso.'
            ]
        }, null, 2));
    } finally {
        if (pool) await pool.end();
        if (baseTemporal) await admin.query(`DROP DATABASE IF EXISTS ${identificador(baseTemporal)}`);
        await admin.end();
    }
}

if (require.main === module) ejecutar().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
});

module.exports = { ejecutar, cargarDatos, crearBaseTemporal, medir };
