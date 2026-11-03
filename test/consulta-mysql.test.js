const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const habilitada = process.env.TEST_CONSULTA_MYSQL === '1';

test('HTTP y MySQL aislados: paginas, permisos, PDFs, respuesta, Enterado y globales', {
    skip: !habilitada
}, async t => {
    assert.equal(process.env.DB_NAME, 'ventanilla_unica_test', 'Nunca ejecutar sobre la base principal.');
    const pool = require('../db');
    const app = require('../server');
    const { crearSesion, revocarSesiones, hashPassword } = require('../auth');
    const { agregarDias, obtenerFechaLocal } = require('../semaforo');
    const { PDFDocument } = require('pdf-lib');
    const prefijo = `CONSULTA-${randomUUID()}`;
    const dependencias = [];
    const usuarios = [];
    const numeros = [];
    const archivos = [];
    let tipo;
    let termino;
    t.after(async () => {
        for (const id of usuarios) revocarSesiones(id);
        for (const numero of numeros) {
            const [documentos] = await pool.execute(
                `SELECT dr.ruta_archivo FROM documentos_respuesta dr
                 JOIN respuestas_radicado rr ON rr.id = dr.respuesta_id WHERE rr.numero_radicado = ?`, [numero]);
            for (const documento of documentos) {
                assert.match(documento.ruta_archivo, /^respuestas\/respuesta-[a-f0-9-]+\.pdf$/);
                archivos.push(path.join(__dirname, '..', 'uploads', documento.ruta_archivo));
            }
            await pool.execute('DELETE FROM historial_radicado WHERE numero_radicado = ?', [numero]);
            await pool.execute('DELETE FROM radicado_terminos WHERE numero_radicado = ?', [numero]);
            await pool.execute(
                `DELETE FROM documentos_respuesta WHERE respuesta_id IN
                 (SELECT id FROM respuestas_radicado WHERE numero_radicado = ?)`, [numero]);
            await pool.execute('DELETE FROM respuestas_radicado WHERE numero_radicado = ?', [numero]);
            await pool.execute('DELETE FROM documentos_radicado WHERE numero_radicado = ?', [numero]);
            await pool.execute('DELETE FROM radicado_dependencias WHERE numero_radicado = ?', [numero]);
            await pool.execute('DELETE FROM radicados WHERE numero_radicado = ?', [numero]);
        }
        for (const archivo of new Set(archivos)) await fs.unlink(archivo);
        for (const id of usuarios) await pool.execute('DELETE FROM usuarios WHERE id = ?', [id]);
        if (termino) await pool.execute('DELETE FROM terminos_legales WHERE id = ?', [termino]);
        if (tipo) await pool.execute('DELETE FROM tipos_tramite WHERE id = ?', [tipo]);
        for (const id of dependencias) await pool.execute('DELETE FROM dependencias WHERE id = ?', [id]);
        await pool.end();
    });
    for (const letra of ['A', 'B']) {
        const [resultado] = await pool.execute('INSERT INTO dependencias(nombre, activo) VALUES (?, 1)', [`${prefijo}-${letra}`]);
        dependencias.push(resultado.insertId);
    }
    const password = await hashPassword(`Fixture!9a-${randomUUID()}`);
    const tokens = [];
    for (const [rol, dependencia] of [
        ['administrador', null], ['ventanilla', null],
        ['funcionario', dependencias[0]], ['funcionario', dependencias[1]]
    ]) {
        const [resultado] = await pool.execute(
            'INSERT INTO usuarios(nombre, email, password, rol, dependencia_id, activo) VALUES (?, ?, ?, ?, ?, 1)',
            ['Usuario ficticio', `${randomUUID()}@example.test`, password, rol, dependencia]);
        usuarios.push(resultado.insertId);
        tokens.push(crearSesion(resultado.insertId));
    }
    const [tipoCreado] = await pool.execute(
        `INSERT INTO tipos_tramite(codigo, nombre, categoria_general, requiere_respuesta)
         VALUES (?, ?, 'peticion_general', 1)`, [randomUUID(), prefijo]);
    tipo = tipoCreado.insertId;
    const [terminoCreado] = await pool.execute(
        `INSERT INTO terminos_legales(tipo_tramite_id, dias, tipo_dias, fundamento_legal, vigente_desde)
         VALUES (?, 15, 'habiles', 'Regla ficticia de prueba', '2000-01-01')`, [tipo]);
    termino = terminoCreado.insertId;
    const hoy = obtenerFechaLocal(new Date(), 'hoy');
    const futuro = agregarDias(hoy, 50);
    async function insertar(numero, dependencia, global = false, sinRespuesta = false, limite = futuro, estado = 'Recibido', legacy = false) {
        await pool.execute(
            `INSERT INTO radicados(numero_radicado, tipo_documento, tipo_comunicacion, tiempo_de_respuesta,
                remitente_nombre, remitente_documento, remitente_telefono, dependencia_destino, dependencia_destino_id,
                asunto_documento, usuario_recibe, estado, fecha_creacion, fecha_hora_recepcion,
                destino_todas_dependencias, requiere_respuesta)
             VALUES (?, 'Solicitud', 'Externa', '1 dia calendario', 'Persona ficticia', '000000', '0000000000',
                'Oficina ficticia', ?, 'Asunto ficticio', 'Ventanilla ficticia', ?, '2000-01-01', ?, ?, ?)`,
            [numero, dependencia, estado, `${hoy} 08:00:00`, global ? 1 : 0, sinRespuesta ? 0 : 1]);
        numeros.push(numero);
        if (!legacy && !sinRespuesta) await pool.execute(
            `INSERT INTO radicado_terminos(numero_radicado, tipo_tramite_id, termino_legal_id,
                fecha_recepcion, termino_dias_aplicado, tipo_dias_aplicado, fundamento_legal_aplicado,
                fecha_limite_inicial, fecha_limite_actual, fecha_respuesta)
             VALUES (?, ?, ?, '2000-01-01', 15, 'habiles', 'Regla ficticia', '2000-01-20', ?, ?)`,
            [numero, tipo, termino, limite, estado === 'Respondido' ? `${hoy} 09:00:00` : null]);
    }
    for (let i = 0; i < 30; i++) {
        await insertar(`${prefijo}-${String(i).padStart(2, '0')}`, dependencias[0], false, i === 6,
            i === 1 ? '2000-01-20' : i === 2 ? agregarDias(hoy, 3) : futuro,
            i === 4 ? 'Respondido' : 'Recibido', i === 0);
    }
    await insertar(`${prefijo}-B`, dependencias[1]);
    const global = `${prefijo}-G`;
    await insertar(global, null, true, false, '2000-01-20');
    const asignaciones = [];
    for (const [indice, dependencia] of dependencias.entries()) {
        const [resultado] = await pool.execute(
            `INSERT INTO radicado_dependencias(numero_radicado, dependencia_id, estado, fecha_respuesta)
             VALUES (?, ?, ?, ?)`,
            [global, dependencia, indice === 0 ? 'Respondido' : 'Recibido', indice === 0 ? `${hoy} 09:00:00` : null]);
        asignaciones.push(resultado.insertId);
    }
    const pdf = await PDFDocument.create();
    pdf.addPage();
    const bytes = await pdf.save();
    const nombreArchivo = `${randomUUID()}.pdf`;
    const archivo = path.join(__dirname, '..', 'uploads', nombreArchivo);
    await fs.writeFile(archivo, bytes);
    archivos.push(archivo);
    await pool.execute(
        `INSERT INTO documentos_radicado(numero_radicado, nombre_archivo, ruta_archivo, tipo_mime, tamano_bytes)
         VALUES (?, 'fixture.pdf', ?, 'application/pdf', ?)`, [numeros[2], nombreArchivo, bytes.length]);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}`;
    const solicitar = (indice, ruta, opciones = {}) => fetch(url + ruta, {
        ...opciones, headers: { ...opciones.headers, Authorization: `Bearer ${tokens[indice]}` }
    });
    const consulta = async (indice, extra = '') => {
        const respuesta = await solicitar(indice, `/api/radicados?pagina=1&busqueda=${prefijo}${extra}`);
        assert.equal(respuesta.status, 200);
        return respuesta.json();
    };
    for (const indice of [0, 1, 2, 3]) {
        const resultado = await consulta(indice);
        assert.equal(resultado.total, indice < 2 ? 33 : indice === 2 ? 31 : 2);
        assert.equal(resultado.radicados.length, Math.min(25, resultado.total));
        if (indice === 2) assert.ok(resultado.radicados.every(r =>
            r.dependencia_destino_id === dependencias[0] || r.seguimiento_dependencia_id === dependencias[0]));
    }
    const primera = await consulta(0);
    const segundaRespuesta = await solicitar(0, `/api/radicados?pagina=2&busqueda=${prefijo}`);
    const segunda = await segundaRespuesta.json();
    const claves = rows => rows.map(r => `${r.numero_radicado}:${r.radicado_dependencia_id || 0}`);
    assert.equal(new Set([...claves(primera.radicados), ...claves(segunda.radicados)]).size, 33);
    assert.equal((await consulta(0, '&hoy=1')).total, 33);
    assert.equal((await consulta(0, '&tipo_comunicacion=interna')).total, 0);
    assert.equal((await consulta(2, '&criticos=1')).total, 3);
    assert.equal((await consulta(3, '&criticos=1')).total, 1);
    assert.equal((await solicitar(2, `/api/alertas?pagina=1&dependencia_id=${dependencias[1]}`)).status, 403);
    const alertas = await (await solicitar(2, `/api/alertas?pagina=1&dependencia_id=${dependencias[0]}`)).json();
    assert.equal(alertas.total, 3);
    assert.equal((await solicitar(2, `/uploads/${nombreArchivo}`)).status, 200);
    assert.equal((await solicitar(3, `/uploads/${nombreArchivo}`)).status, 404);
    const form = new FormData();
    form.append('contenido', 'Respuesta ficticia para validar la consulta.');
    form.append('archivos', new Blob([bytes], { type: 'application/pdf' }), 'respuesta-fixture.pdf');
    const respuesta = await solicitar(2, `/api/radicados/${numeros[2]}/respuesta`, { method: 'POST', body: form });
    assert.equal(respuesta.status, 201);
    const guardada = await (await solicitar(2, `/api/radicados/${numeros[2]}/respuesta`)).json();
    for (const documento of guardada.respuesta.documentos) {
        archivos.push(path.join(__dirname, '..', 'uploads', documento.ruta_archivo));
        assert.equal((await solicitar(2, `/uploads/${documento.ruta_archivo}`)).status, 200);
    }
    assert.equal((await consulta(2, '&criticos=1')).total, 2);
    const historial = await (await solicitar(2, `/api/radicados/${numeros[2]}/historial`)).json();
    assert.ok(historial.historial.some(e => e.event_type === 'respuesta_enviada'));
    const enterado = await solicitar(2, `/api/radicados/${numeros[6]}/estado`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ estado: 'Enterado' })
    });
    assert.equal(enterado.status, 200);
    assert.equal((await enterado.json()).estado, 'Enterado');
    const respuestaGlobal = new FormData();
    respuestaGlobal.append('contenido', 'Respuesta ficticia de la oficina B.');
    respuestaGlobal.append('radicado_dependencia_id', String(asignaciones[1]));
    assert.equal((await solicitar(3, `/api/radicados/${global}/respuesta`, {
        method: 'POST', body: respuestaGlobal
    })).status, 201);
    assert.equal((await consulta(3, '&criticos=1')).total, 0);
});
