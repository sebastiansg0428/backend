const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');

test('traslados HTTP/MySQL: permisos, concurrencia, reintentos y plazos en base exclusivamente ficticia', {
    skip: process.env.TEST_TRASLADOS_MYSQL !== '1'
}, async t => {
    const mysql = require('mysql2/promise');
    const nombre = `ventanilla_traslados_${randomBytes(6).toString('hex')}`;
    assert.match(nombre, /^ventanilla_traslados_[a-f0-9]{12}$/);
    const source = process.env.TRASLADOS_SCHEMA_DB || 'ventanilla_unica';
    assert.ok(['ventanilla_unica', 'ventanilla_unica_test'].includes(source));
    const admin = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '', dateStrings: true,
    });
    const uploads = await fs.mkdtemp(path.join(os.tmpdir(), 'ventanilla-traslados-'));
    let creada = false;
    let pool;
    let server;
    const entorno = { DB_NAME: process.env.DB_NAME, UPLOAD_DIR: process.env.UPLOAD_DIR };
    t.after(async () => {
        try {
            if (server) await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
            if (pool) await pool.end();
            if (creada) await admin.query(`DROP DATABASE \`${nombre}\``);
        } finally {
            await admin.end();
            await fs.rm(uploads, { recursive: true, force: true });
            for (const [clave, valor] of Object.entries(entorno)) {
                if (valor === undefined) delete process.env[clave]; else process.env[clave] = valor;
            }
        }
    });
    const [tablas] = await admin.execute(
        "SELECT TABLE_NAME AS nombre FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [source]);
    assert.ok(tablas.some(tabla => tabla.nombre === 'intentos_radicacion'), 'El esquema fuente debe tener aplicada 022.');
    // Solo DDL: nunca se leen ni copian filas de desarrollo.
    const estructura = [];
    for (const tabla of tablas) {
        assert.match(tabla.nombre, /^[a-zA-Z0-9_]+$/);
        const [ddl] = await admin.query(`SHOW CREATE TABLE \`${source}\`.\`${tabla.nombre}\``);
        estructura.push(ddl[0]['Create Table']);
    }
    await admin.query(`CREATE DATABASE \`${nombre}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    creada = true;
    await admin.query(`USE \`${nombre}\``);
    await admin.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const ddl of estructura) await admin.query(ddl);
    await admin.query('SET FOREIGN_KEY_CHECKS = 1');
    if (!tablas.some(tabla => tabla.nombre === 'solicitudes_traslado')) {
        await require('../migrations/023_solicitudes_traslado')(admin);
    }
    await require('../migrations/024_integridad_referencial').migrarIntegridad(admin, { aplicar: true });
    process.env.DB_NAME = nombre;
    process.env.UPLOAD_DIR = uploads;
    pool = require('../db');
    const app = require('../server');
    const { crearSesion, revocarSesiones } = require('../auth');
    const { PDFDocument } = require('pdf-lib');
    const dependencias = [];
    for (const letra of ['A', 'B', 'C', 'Inactiva']) {
        const [resultado] = await pool.execute('INSERT INTO dependencias(nombre, activo) VALUES (?, ?)',
            [`Oficina ficticia ${letra}`, letra === 'Inactiva' ? 0 : 1]);
        dependencias.push(resultado.insertId);
    }
    const tokens = [];
    for (const [rol, dependencia] of [
        ['funcionario', dependencias[0]], ['funcionario', dependencias[1]],
        ['ventanilla', null], ['administrador', null], ['funcionario', dependencias[2]],
    ]) {
        const [resultado] = await pool.execute(
            'INSERT INTO usuarios(nombre,email,password,rol,dependencia_id,activo) VALUES (?,?,?,?,?,1)',
            [`Actor ficticio ${rol}`, `${randomUUID()}@example.test`, 'no-es-una-clave-utilizable', rol, dependencia]);
        tokens.push(crearSesion(resultado.insertId));
        t.after(() => revocarSesiones(resultado.insertId));
    }
    const [tipo] = await pool.execute(
        `INSERT INTO tipos_tramite(codigo,nombre,categoria_general,requiere_respuesta)
         VALUES ('fixture_traslado','Fixture traslado','peticion_general',1)`);
    const [termino] = await pool.execute(
        `INSERT INTO terminos_legales(tipo_tramite_id,dias,tipo_dias,fundamento_legal,vigente_desde)
         VALUES (?,15,'habiles','Regla ficticia','2000-01-01')`, [tipo.insertId]);
    let secuencia = 0;
    async function radicar({ final = false, global = false, informativo = false } = {}) {
        const numero = `TRASLADO-FICTICIO-${++secuencia}`;
        await pool.execute(
            `INSERT INTO radicados(numero_radicado,tipo_documento,tipo_comunicacion,tiempo_de_respuesta,
             remitente_nombre,remitente_documento,remitente_telefono,dependencia_destino,dependencia_destino_id,
             asunto_documento,usuario_recibe,estado,fecha_hora_recepcion,destino_todas_dependencias,requiere_respuesta)
             VALUES (?,'Solicitud','Externa','15 dias habiles','Persona ficticia','00000','0000000000',
             'Oficina ficticia A',?,'Asunto ficticio','Ventanilla ficticia',?,'2026-01-05 08:00:00',?,?)`,
            [numero, dependencias[0], final ? 'Respondido' : 'En trámite', Number(global), informativo ? 0 : 1]);
        if (!informativo) await pool.execute(
            `INSERT INTO radicado_terminos(numero_radicado,tipo_tramite_id,termino_legal_id,fecha_recepcion,
             termino_dias_aplicado,tipo_dias_aplicado,fundamento_legal_aplicado,fecha_limite_inicial,fecha_limite_actual)
             VALUES (?,?,?,'2026-01-05',15,'habiles','Regla ficticia','2026-01-27','2026-01-27')`,
            [numero, tipo.insertId, termino.insertId]);
        return numero;
    }
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    const pedir = (actor, ruta, body, method = 'POST') => fetch(url + ruta, {
        method: body === undefined ? 'GET' : method, signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${tokens[actor]}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    const datosSolicitud = () => ({ clave_solicitud: randomUUID(), destino_sugerido_id: dependencias[1], motivo: 'Revisar competencia de esta oficina.' });
    const aprobar = { decision: 'aprobada', destino_id: dependencias[1], motivo: 'Esta oficina tiene la competencia.' };
    const rechazar = { decision: 'rechazada', motivo: 'La oficina actual debe continuar.' };
    async function solicitar(numero, datos = datosSolicitud()) {
        const respuesta = await pedir(0, `/api/radicados/${numero}/traslados`, datos);
        assert.equal(respuesta.status, 201, await respuesta.clone().text());
        return (await respuesta.json()).traslado;
    }
    const responder = async (actor, numero) => {
        const form = new FormData();
        form.append('contenido', 'Respuesta institucional exclusivamente ficticia.');
        return fetch(`${url}/api/radicados/${numero}/respuesta`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens[actor]}` }, body: form,
        });
    };

    await t.test('valida roles, elegibilidad, claves y destinos', async () => {
        const numero = await radicar();
        const ruta = `/api/radicados/${numero}/traslados`;
        for (const rol of [1, 2, 3]) assert.equal((await pedir(rol, ruta, datosSolicitud())).status, rol === 1 ? 404 : 403);
        for (const cambios of [
            { clave_solicitud: 'invalida' }, { motivo: 'corto' }, { destino_sugerido_id: dependencias[0] },
            { destino_sugerido_id: dependencias[3] }, { destino_sugerido_id: 999999 }, { origen_id: dependencias[1] },
        ]) assert.equal((await pedir(0, ruta, { ...datosSolicitud(), ...cambios })).status, 400);
        for (const opciones of [{ final: true }, { global: true }]) {
            assert.equal((await pedir(0, `/api/radicados/${await radicar(opciones)}/traslados`, datosSolicitud())).status, 409);
        }
        assert.equal((await pedir(0, '/api/traslados?pagina=0')).status, 400);
        assert.equal((await pedir(0, '/api/traslados?estado=otro')).status, 400);
    });

    await t.test('aprueba una sola vez, preserva todo el expediente y limita al origen en cada superficie', async () => {
        const numero = await radicar();
        const datos = datosSolicitud();
        const pdf = await PDFDocument.create(); pdf.addPage();
        const bytes = await pdf.save();
        const archivo = `${randomUUID()}.pdf`;
        await fs.writeFile(path.join(uploads, archivo), bytes);
        await pool.execute(
            `INSERT INTO documentos_radicado(numero_radicado,nombre_archivo,ruta_archivo,tipo_mime,tamano_bytes)
             VALUES (?,'fixture.pdf',?,'application/pdf',?)`, [numero, archivo, bytes.length]);
        const [antes] = await pool.execute('SELECT r.*, rt.* FROM radicados r JOIN radicado_terminos rt USING(numero_radicado) WHERE numero_radicado = ?', [numero]);
        const solicitud = await solicitar(numero, datos);
        const ruta = `/api/traslados/${solicitud.id}/decision`;
        assert.equal((await pedir(0, ruta, aprobar)).status, 403);
        assert.equal((await pedir(0, `/api/radicados/${numero}/traslados`, datosSolicitud())).status, 409);
        assert.equal((await pedir(0, `/api/radicados/${numero}/traslados`, { ...datos, motivo: 'Otro motivo diferente de traslado.' })).status, 409);
        assert.equal((await pedir(2, ruta, aprobar)).status, 200);
        assert.equal((await pedir(3, ruta, aprobar)).status, 200);
        assert.equal((await pedir(3, ruta, rechazar)).status, 409);
        assert.equal((await pedir(0, `/api/radicados/${numero}/traslados`, datos)).status, 200);
        const [despues] = await pool.execute('SELECT r.*, rt.* FROM radicados r JOIN radicado_terminos rt USING(numero_radicado) WHERE numero_radicado = ?', [numero]);
        const { dependencia_destino_id: ignoradoId, dependencia_destino: ignoradoNombre, ...conservado } = antes[0];
        assert.deepEqual(despues[0], { ...conservado, dependencia_destino_id: dependencias[1], dependencia_destino: 'Oficina ficticia B' });
        for (const sufijo of ['/documentos', '/historial', '/respuesta', '/respuesta/resumen']) {
            assert.equal((await pedir(0, `/api/radicados/${numero}${sufijo}`)).status, 404, sufijo);
        }
        assert.equal((await pedir(0, `/uploads/${archivo}`)).status, 404);
        assert.equal((await pedir(1, `/uploads/${archivo}`)).status, 200);
        assert.equal((await responder(0, numero)).status, 404);
        assert.equal((await pedir(0, `/api/radicados/${numero}/estado`, { estado: 'Pendiente' }, 'PUT')).status, 404);
        for (const actor of [0, 1]) {
            const resultado = await (await pedir(actor, `/api/radicados?pagina=1&busqueda=${numero}`)).json();
            assert.equal(resultado.total, actor === 0 ? 0 : 1);
        }
        const legado = await (await pedir(0, '/api/radicados')).json();
        assert.equal(legado.radicados.some(r => r.numero_radicado === numero), false);
        const alertas = await (await pedir(0, `/api/alertas?pagina=1&dependencia_id=${dependencias[0]}`)).json();
        assert.equal(JSON.stringify(alertas).includes(numero), false);
        const recibo = await (await pedir(0, `/api/traslados/${solicitud.id}`)).json();
        assert.equal(recibo.traslado.estado, 'aprobada');
        assert.equal(Object.keys(recibo.traslado).some(k => /email|documento|contenido|huella|clave|session|ip_address/.test(k)), false);
        assert.equal((await pedir(1, `/api/traslados/${solicitud.id}`)).status, 404);
        assert.equal((await responder(1, numero)).status, 201);
        assert.equal((await pedir(0, `/api/radicados/${numero}/respuesta`)).status, 404);
        assert.equal((await pedir(1, `/api/radicados/${numero}/respuesta`)).status, 200);
        const [eventos] = await pool.execute("SELECT COUNT(*) AS total FROM historial_radicado WHERE numero_radicado = ? AND event_type = 'traslado_aprobado'", [numero]);
        assert.equal(Number(eventos[0].total), 1);
    });

    await t.test('rechazo mantiene destino, permite nueva solicitud y cambio de destino aprobado', async () => {
        const numero = await radicar();
        const primera = await solicitar(numero);
        assert.equal((await pedir(3, `/api/traslados/${primera.id}/decision`, rechazar)).status, 200);
        const segunda = await solicitar(numero);
        assert.equal((await pedir(2, `/api/traslados/${segunda.id}/decision`,
            { ...aprobar, destino_id: dependencias[2], motivo: 'Se cambia el destino por competencia tecnica.' })).status, 200);
        const [rows] = await pool.execute('SELECT dependencia_destino_id FROM radicados WHERE numero_radicado = ?', [numero]);
        assert.equal(rows[0].dependencia_destino_id, dependencias[2]);
    });

    await t.test('respuesta y Enterado cancelan pendiente sin trasladar ni fabricar respuestas', async () => {
        for (const informativo of [false, true]) {
            const numero = await radicar({ informativo });
            const solicitud = await solicitar(numero);
            const respuesta = informativo
                ? await pedir(0, `/api/radicados/${numero}/estado`, { estado: 'Enterado' }, 'PUT')
                : await responder(0, numero);
            assert.equal(respuesta.status, informativo ? 200 : 201, await respuesta.clone().text());
            const resultado = await (await pedir(0, `/api/traslados/${solicitud.id}`)).json();
            assert.equal(resultado.traslado.estado, 'cancelada_por_finalizacion');
            assert.equal((await pedir(2, `/api/traslados/${solicitud.id}/decision`, aprobar)).status, 409);
        }
    });

    await t.test('unicidad real de pendientes y de decisiones concurrentes', async () => {
        const numero = await radicar();
        const solicitudes = await Promise.all([datosSolicitud(), datosSolicitud()].map(datos =>
            pedir(0, `/api/radicados/${numero}/traslados`, datos)));
        assert.deepEqual(solicitudes.map(r => r.status).sort(), [201, 409]);
        const solicitud = (await solicitudes.find(r => r.status === 201).json()).traslado;
        const decisiones = await Promise.all([aprobar, rechazar].map(datos => pedir(2, `/api/traslados/${solicitud.id}/decision`, datos)));
        assert.deepEqual(decisiones.map(r => r.status).sort(), [200, 409]);
        // La restriccion de MySQL tambien rechaza escrituras fuera del servicio.
        const otro = await radicar();
        const pendiente = await solicitar(otro);
        await assert.rejects(pool.execute(
            `INSERT INTO solicitudes_traslado(numero_radicado,origen_id,origen_nombre,destino_sugerido_id,
             destino_sugerido_nombre,solicitante_id,solicitante_nombre,motivo_solicitud,clave_solicitud,
             huella_solicitud,creado_en_utc) SELECT numero_radicado,origen_id,origen_nombre,destino_sugerido_id,
             destino_sugerido_nombre,solicitante_id,solicitante_nombre,motivo_solicitud,?,huella_solicitud,
             UTC_TIMESTAMP(6) FROM solicitudes_traslado WHERE id = ?`, [randomUUID(), pendiente.id]),
        { code: 'ER_DUP_ENTRY' });
    });

    await t.test('carreras de aprobacion frente a respuesta/Enterado tienen un solo responsable', async () => {
        for (const informativo of [false, true]) {
            for (let i = 0; i < 4; i++) {
                const numero = await radicar({ informativo });
                const solicitud = await solicitar(numero);
                const [decision, finalizacion] = await Promise.all([
                    pedir(2, `/api/traslados/${solicitud.id}/decision`, aprobar),
                    informativo ? pedir(0, `/api/radicados/${numero}/estado`, { estado: 'Enterado' }, 'PUT') : responder(0, numero),
                ]);
                const [rows] = await pool.execute(
                    `SELECT r.estado, r.dependencia_destino_id, s.estado AS traslado_estado
                     FROM radicados r JOIN solicitudes_traslado s USING(numero_radicado) WHERE s.id = ?`, [solicitud.id]);
                if (decision.status === 200) {
                    assert.equal(finalizacion.status, 404);
                    assert.equal(rows[0].dependencia_destino_id, dependencias[1]);
                    assert.equal(rows[0].estado, 'En trámite');
                    assert.equal(rows[0].traslado_estado, 'aprobada');
                } else {
                    assert.equal(decision.status, 409, await decision.clone().text());
                    assert.equal(finalizacion.status, informativo ? 200 : 201);
                    assert.equal(rows[0].dependencia_destino_id, dependencias[0]);
                    assert.equal(rows[0].traslado_estado, 'cancelada_por_finalizacion');
                }
            }
        }
    });

    await t.test('reintentos simultaneos conservan una solicitud y una decision', async () => {
        const numero = await radicar();
        const datos = datosSolicitud();
        const respuestas = await Promise.all(Array.from({ length: 12 }, () =>
            pedir(0, `/api/radicados/${numero}/traslados`, datos)));
        assert.equal(respuestas.filter(r => r.status === 201).length, 1);
        assert.equal(respuestas.filter(r => r.status === 200).length, 11);
        const solicitudes = await Promise.all(respuestas.map(r => r.json()));
        assert.equal(new Set(solicitudes.map(r => r.traslado.id)).size, 1);
        const solicitud = solicitudes[0].traslado;
        const decisiones = await Promise.all(Array.from({ length: 12 }, () =>
            pedir(2, `/api/traslados/${solicitud.id}/decision`, aprobar)));
        assert.ok(decisiones.every(r => r.status === 200));
        const [[conteo]] = await pool.execute(
            "SELECT COUNT(*) AS total FROM historial_radicado WHERE numero_radicado = ? AND event_type IN ('traslado_solicitado','traslado_aprobado')", [numero]);
        assert.equal(Number(conteo.total), 2);
    });

    await t.test('destino inactivado y fallo de auditoria no dejan reasignacion parcial', async () => {
        const numero = await radicar();
        const solicitud = await solicitar(numero);
        await pool.execute('UPDATE dependencias SET activo = 0 WHERE id = ?', [dependencias[1]]);
        assert.equal((await pedir(2, `/api/traslados/${solicitud.id}/decision`, aprobar)).status, 400);
        await pool.execute('UPDATE dependencias SET activo = 1 WHERE id = ?', [dependencias[1]]);
        await pool.query(`CREATE TRIGGER fixture_fallo_audit BEFORE INSERT ON historial_radicado FOR EACH ROW
            BEGIN IF NEW.event_type = 'traslado_aprobado' THEN
                SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Fallo ficticio de auditoria';
            END IF; END`);
        try {
            assert.equal((await pedir(2, `/api/traslados/${solicitud.id}/decision`, aprobar)).status, 500);
            const [[actual]] = await pool.execute('SELECT dependencia_destino_id FROM radicados WHERE numero_radicado = ?', [numero]);
            assert.equal(actual.dependencia_destino_id, dependencias[0]);
            const recibo = await (await pedir(0, `/api/traslados/${solicitud.id}`)).json();
            assert.equal(recibo.traslado.estado, 'pendiente');
        } finally {
            await pool.query('DROP TRIGGER fixture_fallo_audit');
        }
        assert.equal((await pedir(2, `/api/traslados/${solicitud.id}/decision`, aprobar)).status, 200);
    });

    await t.test('024 mantiene 409 concurrente individual y respuestas independientes globales', async () => {
        const individual = await radicar();
        const concurrentes = await Promise.all([responder(0, individual), responder(0, individual)]);
        assert.deepEqual(concurrentes.map(r => r.status).sort(), [201, 409]);
        const global = await radicar({ global: true });
        for (const dependencia of dependencias.slice(0, 2)) {
            await pool.execute('INSERT INTO radicado_dependencias(numero_radicado,dependencia_id) VALUES (?,?)', [global, dependencia]);
        }
        for (const actor of [0, 1]) {
            const respuesta = await responder(actor, global);
            assert.equal(respuesta.status, 201, await respuesta.clone().text());
            assert.equal((await responder(actor, global)).status, 409);
        }
        const [[conteo]] = await pool.execute('SELECT COUNT(*) AS n FROM respuestas_radicado WHERE numero_radicado=?', [global]);
        assert.equal(Number(conteo.n), 2);
    });

    await t.test('bandejas de 25 y contador por origen sin acceso por destino historico', async () => {
        for (let i = 0; i < 27; i++) await solicitar(await radicar());
        const pagina1 = await (await pedir(0, '/api/traslados?estado=pendiente')).json();
        const pagina2 = await (await pedir(0, '/api/traslados?estado=pendiente&pagina=2')).json();
        assert.equal(pagina1.traslados.length, 25);
        assert.ok(pagina2.traslados.length > 0);
        assert.equal(new Set([...pagina1.traslados, ...pagina2.traslados].map(s => s.id)).size, pagina1.total);
        const ajenas = await (await pedir(1, '/api/traslados')).json();
        assert.equal(ajenas.total, 0);
        assert.equal(ajenas.pendientes, 0);
        const [[version]] = await pool.query('SELECT VERSION() AS motor');
        console.log(JSON.stringify({ motor: version.motor, baseFicticia: nombre, migracion023: true, migracion024: true, carreras: 8, pagina: 25, limpieza: 'base y PDFs se eliminan al terminar' }));
    });
});
