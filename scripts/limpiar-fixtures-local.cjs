const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const mysqlPromise = require('mysql2/promise');

const BASE_ESPERADA = 'ventanilla_unica';
const PREFIJO_RADICADO = 'TRASLADO-FICTICIO-%';
const DEPENDENCIAS_FICTICIAS = [30, 31, 32, 33];
const USUARIOS_FICTICIOS = [9, 10, 11, 12, 13];

function ident(valor) {
    if (!/^[A-Za-z0-9_]+$/.test(valor)) throw new Error(`Identificador no permitido: ${valor}`);
    return `\`${valor}\``;
}

function marcas(valores) { return valores.map(() => '?').join(', '); }

async function tablasDisponibles(connection) {
    const [filas] = await connection.query(
        "SELECT TABLE_NAME AS nombre FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'"
    );
    return new Set(filas.map(fila => fila.nombre));
}

async function comprobarBase(connection) {
    const [[base]] = await connection.query('SELECT DATABASE() AS nombre');
    if (base.nombre !== BASE_ESPERADA) {
        throw new Error(`Limpieza bloqueada: la base actual es ${base.nombre || 'ninguna'}, no ${BASE_ESPERADA}.`);
    }
    const [[conteo]] = await connection.query(
        'SELECT COUNT(*) AS total, SUM(id BETWEEN 1 AND 24) AS reales FROM dependencias'
    );
    if (Number(conteo.reales) !== 24 || Number(conteo.total) !== 28) {
        throw new Error(`Limpieza bloqueada: se esperaban 24 dependencias reales y 28 totales; hay ${conteo.total}.`);
    }
    const [dependencias] = await connection.query(
        `SELECT id,nombre,activo FROM dependencias WHERE id IN (${marcas(DEPENDENCIAS_FICTICIAS)}) ORDER BY id`,
        DEPENDENCIAS_FICTICIAS
    );
    const nombres = ['Oficina ficticia A', 'Oficina ficticia B', 'Oficina ficticia C', 'Oficina ficticia Inactiva'];
    if (dependencias.length !== 4 || dependencias.some((fila, i) => fila.nombre !== nombres[i])) {
        throw new Error('Limpieza bloqueada: las dependencias ficticias no coinciden con el inventario aprobado.');
    }
    return { base: base.nombre, dependenciasReales: Number(conteo.reales), dependencias };
}

async function inventario(connection) {
    const meta = await comprobarBase(connection);
    const tablas = await tablasDisponibles(connection);
    const [radicados] = await connection.execute(
        'SELECT numero_radicado FROM radicados WHERE numero_radicado LIKE ? ORDER BY numero_radicado',
        [PREFIJO_RADICADO]
    );
    const numeros = radicados.map(fila => fila.numero_radicado);
    if (numeros.length !== 60 || numeros.some(numero => !/^TRASLADO-FICTICIO-\d+$/.test(numero))) {
        throw new Error(`Limpieza bloqueada: se esperaban 60 radicados TRASLADO-FICTICIO; hay ${numeros.length}.`);
    }
    const [usuarios] = await connection.query(
        `SELECT id,nombre,email,rol,dependencia_id FROM usuarios WHERE id IN (${marcas(USUARIOS_FICTICIOS)}) ORDER BY id`,
        USUARIOS_FICTICIOS
    );
    if (usuarios.length !== USUARIOS_FICTICIOS.length || usuarios.some(fila => !fila.email.endsWith('@example.test'))) {
        throw new Error('Limpieza bloqueada: los usuarios ficticios no coinciden con el inventario aprobado.');
    }
    const [tipos] = await connection.query("SELECT id,codigo,nombre FROM tipos_tramite WHERE codigo='fixture_traslado'");
    if (tipos.length !== 1) throw new Error('Limpieza bloqueada: falta o se duplicó fixture_traslado.');
    const tipoIds = tipos.map(fila => fila.id);
    const asociados = {};
    for (const tabla of ['documentos_radicado', 'historial_radicado', 'radicado_terminos',
        'respuestas_radicado', 'solicitudes_traslado', 'radicado_dependencias',
        'ampliaciones_termino', 'intentos_radicacion', 'comunicaciones_externas', 'comunicaciones_internas']) {
        if (!tablas.has(tabla)) continue;
        const [[fila]] = await connection.query(
            `SELECT COUNT(*) AS n FROM ${ident(tabla)} WHERE numero_radicado IN (${marcas(numeros)})`, numeros
        );
        if (Number(fila.n)) asociados[tabla] = Number(fila.n);
    }
    const [respuestas] = tablas.has('respuestas_radicado')
        ? await connection.query(`SELECT id FROM respuestas_radicado WHERE numero_radicado IN (${marcas(numeros)})`, numeros)
        : [[]];
    const [asignaciones] = tablas.has('radicado_dependencias')
        ? await connection.query(`SELECT id FROM radicado_dependencias WHERE numero_radicado IN (${marcas(numeros)})`, numeros)
        : [[]];
    const respuestaIds = respuestas.map(fila => fila.id);
    const asignacionIds = asignaciones.map(fila => fila.id);
    const hijosRespuesta = {};
    for (const tabla of ['documentos_respuesta', 'recepciones_internas', 'registros_entrega_respuesta']) {
        if (!tablas.has(tabla) || !respuestaIds.length) continue;
        const [[fila]] = await connection.query(
            `SELECT COUNT(*) AS n FROM ${ident(tabla)} WHERE respuesta_id IN (${marcas(respuestaIds)})`, respuestaIds
        );
        if (Number(fila.n)) hijosRespuesta[tabla] = Number(fila.n);
    }
    return {
        ...meta, radicados: numeros.length, numeros, usuarios: usuarios.length,
        tipos: tipos.length, tipoIds, asociados, respuestas: respuestaIds.length,
        respuestaIds, asignacionIds, hijosRespuesta, traslados: asociados.solicitudes_traslado || 0,
    };
}

async function columnas(connection, tabla) {
    const [filas] = await connection.execute(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND EXTRA NOT LIKE '%GENERATED%'
         ORDER BY ORDINAL_POSITION`, [tabla]
    );
    return filas.map(fila => fila.COLUMN_NAME);
}

async function filas(connection, tabla, condicion, valores) {
    const campos = await columnas(connection, tabla);
    if (!campos.length) return [];
    const [resultado] = await connection.query(
        `SELECT ${campos.map(ident).join(',')} FROM ${ident(tabla)} WHERE ${condicion}`, valores
    );
    return resultado;
}

async function respaldo(connection, estado) {
    const tablas = await tablasDisponibles(connection);
    const datos = [];
    const porNumero = ['radicados', 'documentos_radicado', 'historial_radicado', 'radicado_terminos',
        'respuestas_radicado', 'solicitudes_traslado', 'radicado_dependencias', 'ampliaciones_termino',
        'intentos_radicacion', 'comunicaciones_externas', 'comunicaciones_internas'];
    for (const tabla of porNumero) if (tablas.has(tabla)) datos.push({ tabla,
        filas: await filas(connection, tabla, `numero_radicado IN (${marcas(estado.numeros)})`, estado.numeros) });
    datos.push({ tabla: 'dependencias', filas: await filas(connection, 'dependencias',
        `id IN (${marcas(DEPENDENCIAS_FICTICIAS)})`, DEPENDENCIAS_FICTICIAS) });
    datos.push({ tabla: 'usuarios', filas: await filas(connection, 'usuarios',
        `id IN (${marcas(USUARIOS_FICTICIOS)})`, USUARIOS_FICTICIOS) });
    datos.push({ tabla: 'tipos_tramite', filas: await filas(connection, 'tipos_tramite', "codigo='fixture_traslado'", []) });
    if (tablas.has('terminos_legales')) datos.push({ tabla: 'terminos_legales', filas: await filas(connection,
        `tipo_tramite_id IN (${marcas(estado.tipoIds)})`, estado.tipoIds) });
    for (const tabla of ['documentos_respuesta', 'recepciones_internas', 'registros_entrega_respuesta']) {
        if (tablas.has(tabla) && estado.respuestaIds.length) datos.push({ tabla, filas: await filas(connection, tabla,
            `respuesta_id IN (${marcas(estado.respuestaIds)})`, estado.respuestaIds) });
    }
    const destino = path.join(os.tmpdir(), `ventanilla-fixtures-${new Date().toISOString().replace(/[-:.]/g, '')}.json`);
    await fs.writeFile(destino, JSON.stringify({ creado_en: new Date().toISOString(), base: BASE_ESPERADA, inventario: estado, tablas: datos }, null, 2), 'utf8');
    return destino;
}

async function borrar(connection, tablas, tabla, condicion, valores) {
    if (!tablas.has(tabla)) return;
    await connection.execute(`DELETE FROM ${ident(tabla)} WHERE ${condicion}`, valores);
}

async function aplicar(connection, estado) {
    const tablas = await tablasDisponibles(connection);
    await connection.beginTransaction();
    try {
        const ids = estado.respuestaIds;
        if (ids.length && tablas.has('registros_entrega_respuesta')) {
            const [entregas] = await connection.query(`SELECT id FROM registros_entrega_respuesta WHERE respuesta_id IN (${marcas(ids)})`, ids);
            const entregaIds = entregas.map(fila => fila.id);
            if (entregaIds.length) {
                for (const tabla of ['entregas_fecha_real', 'entregas_confirmacion']) {
                    await borrar(connection, tablas, tabla, `registro_id IN (${marcas(entregaIds)})`, entregaIds);
                }
                if (tablas.has('evidencias_entrega')) {
                    const [evidencias] = await connection.query(`SELECT id FROM evidencias_entrega WHERE registro_id IN (${marcas(entregaIds)})`, entregaIds);
                    const evidenciaIds = evidencias.map(fila => fila.id);
                    if (evidenciaIds.length) await borrar(connection, tablas, 'documentos_entrega_origen', `evidencia_id IN (${marcas(evidenciaIds)})`, evidenciaIds);
                    if (evidenciaIds.length) await borrar(connection, tablas, 'evidencias_entrega', `id IN (${marcas(evidenciaIds)})`, evidenciaIds);
                }
                await borrar(connection, tablas, 'registros_entrega_respuesta', `id IN (${marcas(entregaIds)})`, entregaIds);
            }
        }
        if (ids.length) {
            await borrar(connection, tablas, 'documentos_respuesta', `respuesta_id IN (${marcas(ids)})`, ids);
            await borrar(connection, tablas, 'recepciones_internas', `respuesta_id IN (${marcas(ids)})`, ids);
        }
        await borrar(connection, tablas, 'solicitudes_traslado', `numero_radicado IN (${marcas(estado.numeros)})`, estado.numeros);
        for (const tabla of ['documentos_radicado', 'comunicaciones_externas', 'comunicaciones_internas',
            'historial_radicado', 'ampliaciones_termino', 'intentos_radicacion', 'radicado_terminos']) {
            await borrar(connection, tablas, tabla, `numero_radicado IN (${marcas(estado.numeros)})`, estado.numeros);
        }
        await borrar(connection, tablas, 'respuestas_radicado', `numero_radicado IN (${marcas(estado.numeros)})`, estado.numeros);
        await borrar(connection, tablas, 'radicado_dependencias', `numero_radicado IN (${marcas(estado.numeros)})`, estado.numeros);
        await borrar(connection, tablas, 'radicados', `numero_radicado IN (${marcas(estado.numeros)})`, estado.numeros);
        await borrar(connection, tablas, 'terminos_legales', `tipo_tramite_id IN (${marcas(estado.tipoIds)})`, estado.tipoIds);
        await borrar(connection, tablas, 'tipos_tramite', "codigo='fixture_traslado'", []);
        await borrar(connection, tablas, 'usuarios', `id IN (${marcas(USUARIOS_FICTICIOS)})`, USUARIOS_FICTICIOS);
        await borrar(connection, tablas, 'dependencias', `id IN (${marcas(DEPENDENCIAS_FICTICIAS)})`, DEPENDENCIAS_FICTICIAS);
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw new Error(`Limpieza revertida; no se pudo eliminar un vínculo: ${error.message}`, { cause: error });
    }
}

async function rutasObjetivo(connection, estado) {
    const tablas = await tablasDisponibles(connection);
    const rutas = [];
    if (tablas.has('documentos_radicado')) {
        const [filas] = await connection.query(`SELECT ruta_archivo FROM documentos_radicado WHERE numero_radicado IN (${marcas(estado.numeros)})`, estado.numeros);
        rutas.push(...filas.map(fila => fila.ruta_archivo));
    }
    if (estado.respuestaIds.length && tablas.has('respuestas_radicado')) {
        const [respuestas] = await connection.query(`SELECT ruta_archivo FROM respuestas_radicado WHERE id IN (${marcas(estado.respuestaIds)})`, estado.respuestaIds);
        rutas.push(...respuestas.map(fila => fila.ruta_archivo));
    }
    if (estado.respuestaIds.length && tablas.has('documentos_respuesta')) {
        const [documentos] = await connection.query(`SELECT ruta_archivo FROM documentos_respuesta WHERE respuesta_id IN (${marcas(estado.respuestaIds)})`, estado.respuestaIds);
        rutas.push(...documentos.map(fila => fila.ruta_archivo));
    }
    return [...new Set(rutas.filter(Boolean))];
}

async function eliminarArchivos(rutas) {
    const raiz = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
    const resultado = { eliminados: [], inexistentes: [], omitidosFueraDeUploads: [] };
    for (const ruta of rutas) {
        const destino = path.resolve(raiz, ruta);
        const relativa = path.relative(raiz, destino);
        if (relativa.startsWith('..') || path.isAbsolute(relativa)) {
            resultado.omitidosFueraDeUploads.push(ruta);
            continue;
        }
        try {
            await fs.access(destino);
            await fs.rm(destino, { force: true });
            resultado.eliminados.push(ruta);
        } catch (error) {
            if (error.code === 'ENOENT') resultado.inexistentes.push(ruta);
            else throw error;
        }
    }
    return resultado;
}

async function verificacionFinal(connection) {
    const [[deps]] = await connection.query('SELECT COUNT(*) AS total, SUM(id BETWEEN 1 AND 24) AS reales FROM dependencias');
    const [[radicados]] = await connection.query('SELECT COUNT(*) AS n FROM radicados WHERE numero_radicado LIKE ?', [PREFIJO_RADICADO]);
    const [[traslados]] = await connection.query('SELECT COUNT(*) AS n FROM solicitudes_traslado WHERE numero_radicado LIKE ?', [PREFIJO_RADICADO]);
    const [[usuarios]] = await connection.query(`SELECT COUNT(*) AS n FROM usuarios WHERE id IN (${marcas(USUARIOS_FICTICIOS)})`, USUARIOS_FICTICIOS);
    const [[tipos]] = await connection.query("SELECT COUNT(*) AS n FROM tipos_tramite WHERE codigo='fixture_traslado'");
    const [[dependenciasFicticias]] = await connection.query(`SELECT COUNT(*) AS n FROM dependencias WHERE id IN (${marcas(DEPENDENCIAS_FICTICIAS)})`, DEPENDENCIAS_FICTICIAS);
    if (Number(deps.reales) !== 24 || Number(deps.total) !== 24 || Number(radicados.n) || Number(traslados.n) || Number(usuarios.n) || Number(tipos.n) || Number(dependenciasFicticias.n)) {
        throw new Error(`La verificación final no pasó: ${JSON.stringify({ deps, radicados, traslados, usuarios, tipos, dependenciasFicticias })}`);
    }
    return { dependenciasReales: Number(deps.reales), dependenciasTotales: Number(deps.total), radicadosFicticios: 0, trasladosFicticios: 0 };
}

async function main() {
    const [modo] = process.argv.slice(2);
    if (!['--inspeccionar', '--respaldo', '--aplicar'].includes(modo)) throw new Error('Uso: node scripts\\limpiar-fixtures-local.cjs --inspeccionar|--respaldo|--aplicar');
    const connection = await mysqlPromise.createConnection({ host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '', database: process.env.DB_NAME || BASE_ESPERADA, dateStrings: true });
    try {
        const estado = await inventario(connection);
        if (modo === '--inspeccionar') return console.log(JSON.stringify(estado, null, 2));
        const archivoRespaldo = await respaldo(connection, estado);
        console.log(`Respaldo creado: ${archivoRespaldo}`);
        if (modo === '--respaldo') return;
        const rutas = await rutasObjetivo(connection, estado);
        await aplicar(connection, estado);
        console.log(JSON.stringify({ estado: 'limpieza_aplicada', respaldo: archivoRespaldo,
            archivos: await eliminarArchivos(rutas), ...await verificacionFinal(connection) }, null, 2));
    } finally { await connection.end(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
