const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
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
    await require('../migrations/025_seguimiento_entrega').migrarEntregas(admin, { aplicar: true });
    await require('../migrations/026_documentos_entrega').migrarDocumentosEntrega(admin, { aplicar: true });
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

    const entregaDatos = (cambios = {}) => ({ version: '2', documentos_respuesta: '[]', clave: randomUUID(), canal: 'correo_electronico', resultado: 'enviado',
        destinatario: 'Persona ficticia', destino: 'fixture@example.test',
        observaciones: '', ...cambios });
    const pdfEntrega = await PDFDocument.create();
    pdfEntrega.addPage();
    const bytesEntrega = Buffer.from(await pdfEntrega.save());
    const entregar = (actor, numero, datos = entregaDatos(), archivos = []) => {
        const form = new FormData();
        for (const [k, v] of Object.entries(datos)) form.append(k, v);
        for (const archivo of archivos) form.append('archivos',
            new Blob([archivo.bytes || bytesEntrega], { type: 'application/pdf' }), archivo.nombre || 'evidencia-ficticia.pdf');
        return fetch(`${url}/api/radicados/${numero}/entregas`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens[actor]}` }, body: form,
            signal: AbortSignal.timeout(30000),
        });
    };
    async function listo() {
        const numero = await radicar();
        assert.equal((await responder(0, numero)).status, 201);
        return numero;
    }
    const archivosEntrega = async () => {
        try { return (await fs.readdir(path.join(uploads, 'entregas'))).sort(); }
        catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    };
    await t.test('025 valida columnas, PK, unicidad y FK; no modifica si ya aplicada', async () => {
        const { verificar, migrarEntregas } = require('../migrations/025_seguimiento_entrega');
        assert.deepEqual(await migrarEntregas(admin), { estado: 'aplicada', cambios: 0 });
        await admin.query('ALTER TABLE evidencias_entrega DROP PRIMARY KEY, ADD PRIMARY KEY(id,registro_id)');
        try { await assert.rejects(verificar(admin), /Indice 025 incompatible/); }
        finally { await admin.query('ALTER TABLE evidencias_entrega DROP PRIMARY KEY, ADD PRIMARY KEY(id)'); }
        await admin.query('ALTER TABLE evidencias_entrega DROP INDEX ruta_archivo');
        try { await assert.rejects(verificar(admin), /Indice 025 incompatible/); }
        finally { await admin.query('ALTER TABLE evidencias_entrega ADD UNIQUE KEY ruta_archivo(ruta_archivo)'); }
        await admin.query('ALTER TABLE evidencias_entrega MODIFY nombre_archivo VARCHAR(255) NULL');
        try { await assert.rejects(verificar(admin), /Columna 025 incompatible/); }
        finally { await admin.query('ALTER TABLE evidencias_entrega MODIFY nombre_archivo VARCHAR(255) NOT NULL'); }
        await admin.query('ALTER TABLE evidencias_entrega DROP FOREIGN KEY fk_evidencia_entrega');
        try { await assert.rejects(verificar(admin), /FK 025 incompatibles/); }
        finally { await admin.query(`ALTER TABLE evidencias_entrega ADD CONSTRAINT fk_evidencia_entrega
            FOREIGN KEY(registro_id) REFERENCES registros_entrega_respuesta(id) ON DELETE RESTRICT ON UPDATE RESTRICT`); }
        assert.equal(await verificar(admin), true);
    });
    await t.test('entregas sin 025 dan 503 sin romper consulta/respuesta; roles y alcance', async () => {
        const numero = await listo();
        await pool.query('RENAME TABLE evidencias_entrega TO fixture_evidencias_ocultas');
        try {
            assert.equal((await pedir(2, `/api/radicados/${numero}/entregas`)).status, 503);
            assert.equal((await pedir(0, `/api/radicados/${numero}/respuesta`)).status, 200);
        } finally { await pool.query('RENAME TABLE fixture_evidencias_ocultas TO evidencias_entrega'); }
        assert.equal((await entregar(0, numero)).status, 403);
        assert.equal((await entregar(1, numero)).status, 404);
        assert.equal((await pedir(0, `/api/radicados/${numero}/entregas`)).status, 200);
        assert.equal((await entregar(2, await radicar())).status, 404);
        const global = await radicar({ global: true });
        assert.equal((await entregar(2, global)).status, 409);
        const interno = await radicar();
        await pool.execute("UPDATE radicados SET tipo_comunicacion='Interna' WHERE numero_radicado=?", [interno]);
        assert.equal((await entregar(2, interno)).status, 409);
    });
    await t.test('entregas rechazan PDF ausente/invalido, 6 archivos y archivo de mas de 10MB; limpian disco', async () => {
        const numero = await listo();
        const antes = await archivosEntrega();
        const acreditar = entregaDatos({ resultado: 'entrega_acreditada' });
        for (const archivos of [[], [{ bytes: Buffer.from('no PDF') }], Array.from({ length: 6 }, () => ({})),
            [{ bytes: Buffer.alloc(10 * 1024 * 1024 + 1) }]]) {
            assert.equal((await entregar(2, numero, acreditar, archivos)).status, 400);
            assert.deepEqual(await archivosEntrega(), antes);
        }
        assert.equal((await entregar(2, numero, entregaDatos({ resultado: 'intento_fallido' }))).status, 400);
        const h = await (await pedir(2, `/api/radicados/${numero}/entregas`)).json();
        assert.equal(h.total, 0); assert.equal(h.resumen, 'pendiente_de_envio');
    });
    await t.test('entregas reintentos concurrentes tienen un evento, PDF y auditoria; preservan respuesta/plazo', async () => {
        const numero = await listo();
        const [original] = await pool.execute('SELECT * FROM radicados WHERE numero_radicado=?', [numero]);
        const [terminos] = await pool.execute('SELECT * FROM radicado_terminos WHERE numero_radicado=?', [numero]);
        const [respuesta] = await pool.execute('SELECT * FROM respuestas_radicado WHERE numero_radicado=?', [numero]);
        const antes = await archivosEntrega();
        const datos = entregaDatos();
        const solicitudes = await Promise.all(Array.from({ length: 12 }, () => entregar(2, numero, datos, [{}])));
        assert.equal(solicitudes.filter(r => r.status === 201).length, 1);
        assert.equal(solicitudes.filter(r => r.status === 200).length, 11);
        const comprobantes = await Promise.all(solicitudes.map(r => r.json()));
        assert.equal(new Set(comprobantes.map(r => r.registro.id)).size, 1);
        assert.equal((await archivosEntrega()).length, antes.length + 1);
        assert.equal((await entregar(2, numero, { ...datos, destino: 'otro@example.test' }, [{}])).status, 409);
        assert.equal((await entregar(2, numero, datos, [{ bytes: Buffer.concat([bytesEntrega, Buffer.from('\n')]) }])).status, 409);
        assert.equal((await archivosEntrega()).length, antes.length + 1);
        const [[audit]] = await pool.execute(`SELECT COUNT(*) AS n FROM historial_radicado
            WHERE numero_radicado=? AND event_type='entrega_registrada'`, [numero]);
        assert.equal(Number(audit.n), 1);
        assert.deepEqual((await pool.execute('SELECT * FROM radicados WHERE numero_radicado=?', [numero]))[0], original);
        assert.deepEqual((await pool.execute('SELECT * FROM radicado_terminos WHERE numero_radicado=?', [numero]))[0], terminos);
        assert.deepEqual((await pool.execute('SELECT * FROM respuestas_radicado WHERE numero_radicado=?', [numero]))[0], respuesta);
    });
    await t.test('acreditacion directa unica, anulacion conservada e idempotente, historial paginado', async () => {
        const numero = await listo();
        const carrera = await Promise.all([2, 3].map(actor =>
            entregar(actor, numero, entregaDatos({ resultado: 'entrega_acreditada' }), [{}])));
        assert.deepEqual(carrera.map(r => r.status).sort(), [201, 409]);
        const { registro } = await carrera.find(r => r.status === 201).json();
        const ruta = `/api/radicados/${numero}/entregas`;
        assert.equal((await entregar(2, numero)).status, 409);
        assert.equal((await pedir(0, `${ruta}/${registro.id}/anulacion`, { motivo: 'Correccion ficticia documentada.' })).status, 403);
        const motivo = { motivo: 'Correccion ficticia documentada.' };
        const anulaciones = await Promise.all(Array.from({ length: 6 }, () => pedir(2, `${ruta}/${registro.id}/anulacion`, motivo)));
        assert.ok(anulaciones.every(r => r.status === 200));
        assert.equal((await pedir(2, `${ruta}/${registro.id}/anulacion`, { motivo: 'Otro motivo ficticio.' })).status, 409);
        const descarga = await pedir(0, `${ruta}/${registro.id}/evidencias/${registro.evidencias[0].id}`);
        assert.equal(descarga.status, 200);
        assert.deepEqual(Buffer.from(await descarga.arrayBuffer()), bytesEntrega);
        assert.equal((await (await pedir(2, ruta)).json()).resumen, 'pendiente_de_envio');
        for (let i = 0; i < 26; i++) assert.equal((await entregar(2, numero)).status, 201);
        const p1 = await (await pedir(0, ruta)).json();
        const p2 = await (await pedir(0, `${ruta}?pagina=2`)).json();
        assert.equal(p1.total, 27); assert.equal(p1.registros.length, 25); assert.equal(p2.registros.length, 2);
        assert.equal(p1.resumen, 'enviado'); assert.equal(p2.resumen, 'enviado');
        assert.equal(p1.paginas, 2); assert.equal(new Set([...p1.registros, ...p2.registros].map(r => r.id)).size, 27);
    });
    await t.test('fallo de auditoria revierte entrega/anulacion; limpia solo PDF del intento', async () => {
        const numero = await listo();
        const antes = await archivosEntrega();
        await pool.query(`CREATE TRIGGER fixture_fallo_entrega BEFORE INSERT ON historial_radicado FOR EACH ROW
            BEGIN IF NEW.event_type IN ('entrega_registrada','entrega_anulada') THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Fallo ficticio de entrega'; END IF; END`);
        try {
            assert.equal((await entregar(2, numero, entregaDatos(), [{}])).status, 500);
            assert.deepEqual(await archivosEntrega(), antes);
            assert.equal((await (await pedir(2, `/api/radicados/${numero}/entregas`)).json()).total, 0);
        } finally { await pool.query('DROP TRIGGER fixture_fallo_entrega'); }
        const { registro } = await (await entregar(2, numero)).json();
        await pool.query(`CREATE TRIGGER fixture_fallo_entrega BEFORE INSERT ON historial_radicado FOR EACH ROW
            BEGIN IF NEW.event_type='entrega_anulada' THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Fallo ficticio de anulacion'; END IF; END`);
        try {
            assert.equal((await pedir(2, `/api/radicados/${numero}/entregas/${registro.id}/anulacion`,
                { motivo: 'Correccion ficticia documentada.' })).status, 500);
            const h = await (await pedir(2, `/api/radicados/${numero}/entregas`)).json();
            assert.equal(h.registros[0].anulado_en_utc, null);
        } finally { await pool.query('DROP TRIGGER fixture_fallo_entrega'); }
    });
    await t.test('COMMIT incierto conserva evidencia persistida; reintento no duplica; fallo previo limpia', async () => {
        for (const persistir of [true, false]) {
            const numero = await listo();
            const datos = entregaDatos();
            const antes = await archivosEntrega();
            const obtener = pool.getConnection.bind(pool);
            const mock = t.mock.method(pool, 'getConnection', async () => {
                mock.mock.restore();
                const c = await obtener();
                const commit = c.commit.bind(c);
                c.commit = async () => {
                    if (persistir) await commit();
                    throw Object.assign(new Error('Conexion ficticia perdida durante COMMIT'), { code: 'FIXTURE_COMMIT' });
                };
                const release = c.release.bind(c);
                c.release = () => { c.commit = commit; c.release = release; release(); };
                return c;
            });
            try {
                assert.equal((await entregar(2, numero, datos, [{}])).status, 500);
                assert.equal((await archivosEntrega()).length, antes.length + Number(persistir));
                assert.equal((await (await pedir(2, `/api/radicados/${numero}/entregas`)).json()).total, Number(persistir));
                assert.equal((await entregar(2, numero, datos, [{}])).status, persistir ? 200 : 201);
                assert.equal((await archivosEntrega()).length, antes.length + 1);
            } finally { mock.mock.restore(); }
        }
    });
    await t.test('evidencia requiere acceso actual; origen trasladado y rutas ajenas no acceden', async () => {
        const numero = await radicar();
        const traslado = await solicitar(numero);
        assert.equal((await pedir(2, `/api/traslados/${traslado.id}/decision`, aprobar)).status, 200);
        assert.equal((await responder(1, numero)).status, 201);
        const { registro } = await (await entregar(2, numero, entregaDatos(), [{}])).json();
        const ruta = `/api/radicados/${numero}/entregas/${registro.id}/evidencias/${registro.evidencias[0].id}`;
        assert.equal((await pedir(0, ruta)).status, 404);
        assert.equal((await pedir(1, ruta)).status, 200);
        assert.equal((await pedir(2, ruta)).status, 200);
        assert.equal((await pedir(2, ruta.replace(numero, await listo()))).status, 404);
        const [[e]] = await pool.execute('SELECT ruta_archivo FROM evidencias_entrega WHERE id=?', [registro.evidencias[0].id]);
        assert.equal((await pedir(2, `/uploads/${e.ruta_archivo}`)).status, 404);
        const archivo = path.join(uploads, e.ruta_archivo);
        await fs.rename(archivo, `${archivo}.oculto`);
        try {
            const perdida = await pedir(2, ruta);
            assert.equal(perdida.status, 404); assert.ok(!(await perdida.text()).includes(uploads));
        } finally { await fs.rename(`${archivo}.oculto`, archivo); }
    });
    await t.test('COMMIT y verificacion inciertos no borran evidencia confirmada', async () => {
        const numero = await listo();
        const datos = entregaDatos();
        const antes = await archivosEntrega();
        const obtener = pool.getConnection.bind(pool);
        const ejecutar = pool.execute.bind(pool);
        const falloLectura = t.mock.method(pool, 'execute', async (sql, ...args) => {
            if (sql.startsWith('SELECT id,huella FROM registros_entrega_respuesta')) {
                falloLectura.mock.restore();
                throw Object.assign(new Error('Verificacion ficticia no disponible'), { code: 'FIXTURE_VERIFICACION' });
            }
            return ejecutar(sql, ...args);
        });
        const falloCommit = t.mock.method(pool, 'getConnection', async () => {
            falloCommit.mock.restore();
            const c = await obtener();
            const commit = c.commit.bind(c);
            const release = c.release.bind(c);
            c.commit = async () => { await commit(); throw new Error('Confirmacion ficticia perdida'); };
            c.release = () => { c.commit = commit; c.release = release; release(); };
            return c;
        });
        try {
            assert.equal((await entregar(2, numero, datos, [{}])).status, 500);
            assert.equal((await archivosEntrega()).length, antes.length + 1);
            assert.equal((await entregar(2, numero, datos, [{}])).status, 200);
            assert.equal((await archivosEntrega()).length, antes.length + 1);
        } finally { falloLectura.mock.restore(); falloCommit.mock.restore(); }
    });
    async function conDocumentos(cantidad = 1) {
        const numero = await radicar();
        const form = new FormData();
        form.append('contenido', 'Respuesta ficticia con documentos seleccionables.');
        for (let i = 0; i < cantidad; i++) form.append('archivos',
            new Blob([bytesEntrega], { type: 'application/pdf' }), `oficio-${i + 1}.pdf`);
        const respuesta = await fetch(`${url}/api/radicados/${numero}/respuesta`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens[0]}` }, body: form,
        });
        assert.equal(respuesta.status, 201);
        const catalogo = await pedir(2, `/api/radicados/${numero}/entregas/documentos-respuesta`);
        assert.equal(catalogo.status, 200, await catalogo.clone().text());
        const documentos = (await catalogo.json()).documentos;
        return { numero, documentos, seleccion: JSON.stringify(documentos.map(d => ({ id: d.id, sha256: d.sha256 }))) };
    }
    await t.test('026 compatible e idempotente; detecta parcial/tipo y preserva 025', async () => {
        const { migrarDocumentosEntrega, verificar } = require('../migrations/026_documentos_entrega');
        assert.deepEqual(await migrarDocumentosEntrega(admin), { estado: 'aplicada', cambios: 0 });
        assert.deepEqual(await require('../migrations/025_seguimiento_entrega').migrarEntregas(admin), { estado: 'aplicada', cambios: 0 });
        await admin.query('RENAME TABLE documentos_entrega_origen TO fixture_origen_oculto');
        try { await assert.rejects(verificar(admin), /parcial/); }
        finally { await admin.query('RENAME TABLE fixture_origen_oculto TO documentos_entrega_origen'); }
        await admin.query("ALTER TABLE documentos_entrega_origen MODIFY origen VARCHAR(40) NOT NULL");
        try { await assert.rejects(verificar(admin), /Columnas/); }
        finally { await admin.query("ALTER TABLE documentos_entrega_origen MODIFY origen ENUM('documento_respuesta','evidencia_adicional') NOT NULL"); }
        assert.equal(await verificar(admin), true);
    });
    await t.test('hora MySQL automatica y copias independientes; replay conserva fecha aun sin fuente', async () => {
        const { numero, documentos, seleccion } = await conDocumentos();
        const datos = entregaDatos({ documentos_respuesta: seleccion });
        const [[antes]] = await pool.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%d %H:%i:%s.%f') AS ahora");
        const respuestas = await Promise.all(Array.from({ length: 6 }, () => entregar(2, numero, datos)));
        assert.equal(respuestas.filter(r => r.status === 201).length, 1);
        assert.equal(respuestas.filter(r => r.status === 200).length, 5);
        const recibos = await Promise.all(respuestas.map(r => r.json()));
        for (const r of recibos) assert.deepEqual(r, recibos[0]);
        const r = recibos[0].registro;
        const [[despues]] = await pool.query("SELECT DATE_FORMAT(UTC_TIMESTAMP(6),'%Y-%m-%d %H:%i:%s.%f') AS ahora");
        assert.equal(r.fecha_actuacion_utc, r.creado_en_utc);
        assert.ok(r.fecha_actuacion_utc >= antes.ahora && r.fecha_actuacion_utc <= despues.ahora);
        assert.equal(r.evidencias.length, 1); assert.equal(r.evidencias[0].origen, 'documento_respuesta');
        assert.equal(r.evidencias[0].sha256, documentos[0].sha256);
        const [[original]] = await pool.execute('SELECT ruta_archivo FROM documentos_respuesta WHERE id=?', [documentos[0].id]);
        const [[copia]] = await pool.execute('SELECT ruta_archivo FROM evidencias_entrega WHERE id=?', [r.evidencias[0].id]);
        assert.notEqual(copia.ruta_archivo, original.ruta_archivo);
        const originalPath = path.join(uploads, original.ruta_archivo);
        const bytes = await fs.readFile(originalPath);
        assert.deepEqual(await fs.readFile(path.join(uploads, copia.ruta_archivo)), bytes);
        await fs.rename(originalPath, `${originalPath}.oculto`);
        try {
            assert.deepEqual((await (await entregar(2, numero, datos)).json()).registro, r);
            assert.equal((await entregar(2, numero, entregaDatos({ documentos_respuesta: seleccion }))).status, 409);
            const descarga = await pedir(0, `/api/radicados/${numero}/entregas/${r.id}/evidencias/${r.evidencias[0].id}`);
            assert.equal(descarga.status, 200); assert.deepEqual(Buffer.from(await descarga.arrayBuffer()), bytes);
        } finally { await fs.rename(`${originalPath}.oculto`, originalPath); }
        assert.equal((await entregar(2, numero, { ...datos, fecha_actuacion: '2000-01-01T10:00' })).status, 400);
        assert.equal((await entregar(2, numero, { ...datos, documentos_respuesta: '[]' })).status, 409);
    });
    await t.test('5 originales mas 5 evidencias; oficio solo o reupload identico no acredita', async () => {
        const { numero, seleccion } = await conDocumentos(5);
        const otros = await PDFDocument.create(); otros.addPage([310, 310]);
        const evidencia = Buffer.from(await otros.save());
        const datos = entregaDatos({ documentos_respuesta: seleccion, resultado: 'entrega_acreditada' });
        assert.equal((await entregar(2, numero, datos)).status, 400);
        assert.equal((await entregar(2, numero, datos, [{}])).status, 400);
        const respuesta = await entregar(2, numero, datos, Array.from({ length: 5 }, (_, i) =>
            ({ bytes: evidencia, nombre: `constancia-${i}.pdf` })));
        assert.equal(respuesta.status, 201, await respuesta.clone().text());
        const r = (await respuesta.json()).registro;
        assert.equal(r.evidencias.length, 10);
        assert.equal(r.evidencias.filter(e => e.origen === 'documento_respuesta').length, 5);
        assert.equal(r.evidencias.filter(e => e.origen === 'evidencia_adicional').length, 5);
    });
    await t.test('seleccion ajena, repetida, hash alterado y sexto documento no crean registro', async () => {
        const a = await conDocumentos(2); const b = await conDocumentos();
        for (const seleccion of [
            JSON.parse(b.seleccion), [...JSON.parse(a.seleccion), JSON.parse(a.seleccion)[0]],
            [{ id: a.documentos[0].id, sha256: '0'.repeat(64) }],
            Array.from({ length: 6 }, (_, i) => ({ id: i + 1, sha256: 'a'.repeat(64) })),
        ]) {
            const r = await entregar(2, a.numero, entregaDatos({ documentos_respuesta: JSON.stringify(seleccion) }));
            assert.ok([400, 409].includes(r.status));
        }
        assert.equal((await pedir(1, `/api/radicados/${a.numero}/entregas/documentos-respuesta`)).status, 404);
        const h = await (await pedir(2, `/api/radicados/${a.numero}/entregas`)).json();
        assert.equal(h.total, 0);
        const parcial = await entregar(2, a.numero, entregaDatos({ documentos_respuesta: JSON.stringify([JSON.parse(a.seleccion)[1]]) }));
        assert.equal(parcial.status, 201);
        assert.equal((await parcial.json()).registro.evidencias.length, 1);
    });
    await t.test('fuente alterada o invalida no se omite ni altera originales; fallo de copia limpia archivos', async () => {
        const { numero, documentos, seleccion } = await conDocumentos(2);
        const [[original]] = await pool.execute('SELECT ruta_archivo FROM documentos_respuesta WHERE id=?', [documentos[0].id]);
        const origen = path.join(uploads, original.ruta_archivo);
        const bytes = await fs.readFile(origen);
        const antes = await archivosEntrega();
        await fs.writeFile(origen, Buffer.alloc(bytes.length, 120));
        try {
            assert.equal((await entregar(2, numero, entregaDatos({ documentos_respuesta: seleccion }))).status, 409);
        } finally { await fs.writeFile(origen, bytes); }
        const abrir = fs.open.bind(fs);
        let intentos = 0;
        const mock = t.mock.method(fs, 'open', async (...args) => {
            if (args[1] === 'wx' && String(args[0]).includes(`${path.sep}entregas${path.sep}`) && ++intentos === 2) {
                throw Object.assign(new Error('Fallo ficticio de disco'), { code: 'FIXTURE_DISCO' });
            }
            return abrir(...args);
        });
        try {
            assert.equal((await entregar(2, numero, entregaDatos({ documentos_respuesta: seleccion }), [{}])).status, 500);
            assert.deepEqual(await archivosEntrega(), antes);
            assert.deepEqual(await fs.readFile(origen), bytes);
        } finally { mock.mock.restore(); }
        assert.equal((await (await pedir(2, `/api/radicados/${numero}/entregas`)).json()).total, 0);
    });
    await t.test('auditoria y COMMIT incierto preservan correctamente copias de fuente y evidencia nueva', async () => {
        const { numero, seleccion } = await conDocumentos();
        const datos = entregaDatos({ documentos_respuesta: seleccion });
        const antes = await archivosEntrega();
        await pool.query(`CREATE TRIGGER fixture_fallo_auto BEFORE INSERT ON historial_radicado FOR EACH ROW
            BEGIN IF NEW.event_type='entrega_registrada' THEN SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT='Fallo ficticio'; END IF; END`);
        try {
            assert.equal((await entregar(2, numero, datos, [{}])).status, 500);
            assert.deepEqual(await archivosEntrega(), antes);
        } finally { await pool.query('DROP TRIGGER fixture_fallo_auto'); }
        const obtener = pool.getConnection.bind(pool);
        const mock = t.mock.method(pool, 'getConnection', async () => {
            mock.mock.restore();
            const c = await obtener(); const commit = c.commit.bind(c), release = c.release.bind(c);
            c.commit = async () => { await commit(); throw new Error('COMMIT ficticio perdido'); };
            c.release = () => { c.commit = commit; c.release = release; release(); };
            return c;
        });
        try {
            assert.equal((await entregar(2, numero, datos, [{}])).status, 500);
            assert.equal((await archivosEntrega()).length, antes.length + 2);
            assert.equal((await entregar(2, numero, datos, [{}])).status, 200);
            assert.equal((await archivosEntrega()).length, antes.length + 2);
        } finally { mock.mock.restore(); }
    });
    await t.test('historico 025 y su replay sobreviven sin 026; registro nuevo queda bloqueado', async () => {
        const numero = await listo();
        const [[respuesta]] = await pool.execute('SELECT id FROM respuestas_radicado WHERE numero_radicado=?', [numero]);
        const body = { clave: randomUUID(), canal: 'presencial', resultado: 'enviado', destinatario: 'Persona ficticia',
            destino: 'Sede ficticia', fecha_actuacion: '2026-01-05T10:00', observaciones: '' };
        const datos = require('../entregas-respuesta').validarRegistro(body);
        const hash = createHash('sha256').update(bytesEntrega).digest('hex');
        const huella = createHash('sha256').update(JSON.stringify({ numero, ...datos,
            archivos: [{ nombre: 'legado-ficticio.pdf', bytes: bytesEntrega.length, sha256: hash }] })).digest('hex');
        const [[actor]] = await pool.execute('SELECT id,nombre FROM usuarios WHERE rol=? ORDER BY id LIMIT 1', ['ventanilla']);
        const [evento] = await pool.execute(`INSERT INTO registros_entrega_respuesta
            (respuesta_id,canal,resultado,destinatario,destino,fecha_actuacion_utc,observaciones,actor_id,actor_nombre,clave,huella,creado_en_utc)
            VALUES (?,'presencial','enviado',?,?,'2026-01-05 15:00:00','',?,?,?,?,'2026-01-05 15:00:00')`,
        [respuesta.id, datos.destinatario, datos.destino, actor.id, actor.nombre, datos.clave, huella]);
        const nombre = `entrega-${randomUUID()}.pdf`;
        await fs.mkdir(path.join(uploads, 'entregas'), { recursive: true });
        await fs.writeFile(path.join(uploads, 'entregas', nombre), bytesEntrega, { flag: 'wx' });
        const [adjunto] = await pool.execute(`INSERT INTO evidencias_entrega
            (registro_id,nombre_archivo,ruta_archivo,tipo_mime,tamano_bytes,sha256)
            VALUES (?,'legado-ficticio.pdf',?,'application/pdf',?,?)`,
        [evento.insertId, `entregas/${nombre}`, bytesEntrega.length, hash]);
        const con026 = await (await pedir(2, `/api/radicados/${numero}/entregas`)).json();
        assert.equal(con026.registros[0].evidencias[0].origen, 'legado');
        await pool.query('RENAME TABLE entregas_confirmacion TO fixture_confirmacion_oculta, documentos_entrega_origen TO fixture_origen_oculto');
        try {
            const h = await (await pedir(2, `/api/radicados/${numero}/entregas`)).json();
            assert.equal(h.automatico_disponible, false);
            assert.deepEqual(h.registros, con026.registros);
            assert.equal(h.registros[0].evidencias[0].sha256, hash);
            const descarga = await pedir(0, `/api/radicados/${numero}/entregas/${evento.insertId}/evidencias/${adjunto.insertId}`);
            assert.equal(descarga.status, 200);
            assert.deepEqual(Buffer.from(await descarga.arrayBuffer()), bytesEntrega);
            assert.equal((await entregar(2, numero, body, [{ nombre: 'legado-ficticio.pdf' }])).status, 200);
            assert.equal((await entregar(2, numero, entregaDatos())).status, 503);
            assert.equal((await pedir(2, `/api/radicados/${numero}/entregas/documentos-respuesta`)).status, 503);
            assert.equal((await pedir(2, `/api/radicados/${numero}/entregas/${evento.insertId}/anulacion`,
                { motivo: 'Correccion ficticia documentada.' })).status, 200);
        } finally {
            await pool.query('RENAME TABLE fixture_confirmacion_oculta TO entregas_confirmacion, fixture_origen_oculto TO documentos_entrega_origen');
        }
        const viejoNuevo = { ...body, clave: randomUUID() };
        assert.equal((await entregar(2, numero, viejoNuevo)).status, 409);
    });
    async function interno() {
        const numero = await radicar();
        await pool.execute(`UPDATE radicados SET tipo_comunicacion='Interna',dependencia_remitente_id=?,
            dependencia_remitente='Oficina ficticia B' WHERE numero_radicado=?`, [dependencias[1], numero]);
        return numero;
    }
    await t.test('027 pendiente no permite nuevas respuestas internas; externos siguen funcionando', async () => {
        const n = await interno();
        assert.equal((await responder(0, n)).status, 503);
        const [[r]] = await pool.execute('SELECT COUNT(*) AS n FROM respuestas_radicado WHERE numero_radicado=?', [n]);
        assert.equal(Number(r.n), 0);
        assert.equal((await pedir(1, '/api/respuestas-internas')).status, 503);
        assert.equal((await responder(0, await radicar())).status, 201);
    });
    await t.test('027 incorpora historico sin lectura, verifica cobertura y no necesita 026', async () => {
        const { migrarRespuestasInternas, verificar } = require('../migrations/027_respuestas_internas');
        const n = await interno();
        await pool.execute(`INSERT INTO respuestas_radicado(numero_radicado,contenido,usuario_id)
            SELECT ?,'Respuesta interna historica ficticia.',id FROM usuarios WHERE rol='funcionario' AND dependencia_id=? LIMIT 1`, [n, dependencias[0]]);
        assert.deepEqual(await migrarRespuestasInternas(admin), { estado: 'pendiente', historicas_pendientes: 1 });
        await pool.query('RENAME TABLE entregas_confirmacion TO fixture_confirmacion_oculta, documentos_entrega_origen TO fixture_origen_oculto');
        try {
            assert.equal((await migrarRespuestasInternas(admin, { aplicar: true })).estado, 'aplicada');
            assert.equal((await migrarRespuestasInternas(admin)).estado, 'aplicada');
        } finally {
            await pool.query('RENAME TABLE fixture_confirmacion_oculta TO entregas_confirmacion, fixture_origen_oculto TO documentos_entrega_origen');
        }
        const h = await (await pedir(1, '/api/respuestas-internas')).json();
        assert.equal(h.registros.length, 1);
        assert.equal(h.registros[0].historica, 1);
        assert.equal(h.registros[0].disponible_en_utc, null);
        assert.equal(h.registros[0].primera_apertura_utc, null);
        assert.equal(await verificar(admin), true);
        await pool.query('ALTER TABLE recepciones_internas MODIFY actor_nombre VARCHAR(149) NULL');
        try { await assert.rejects(verificar(admin), /columnas/); }
        finally { await pool.query('ALTER TABLE recepciones_internas MODIFY actor_nombre VARCHAR(150) NULL'); }
    });
    await t.test('interno solo destino responde; bandeja origen no concede permisos de gestion', async () => {
        const n = await interno();
        assert.equal((await responder(3, n)).status, 403);
        assert.equal((await responder(2, n)).status, 403);
        assert.equal((await responder(1, n)).status, 404);
        const respuestas = await Promise.all([responder(0, n), responder(0, n)]);
        assert.deepEqual(respuestas.map(r => r.status).sort(), [201, 409]);
        const origen = await (await pedir(1, '/api/respuestas-internas')).json();
        const r = origen.registros.find(r => r.numero_radicado === n);
        assert.ok(r); assert.equal(r.historica, 0); assert.ok(r.disponible_en_utc);
        assert.equal(r.primera_apertura_utc, null);
        for (const actor of [0, 1, 2, 3]) assert.equal((await pedir(actor, `/api/respuestas-internas/${r.id}`)).status, 200);
        assert.equal((await pedir(4, `/api/respuestas-internas/${r.id}`)).status, 404);
        assert.equal((await pedir(1, `/api/radicados/${n}/documentos`)).status, 404);
        assert.equal((await pedir(1, `/api/radicados/${n}/estado`, { estado: 'En trámite' })).status, 404);
        for (const actor of [0, 2, 3]) assert.equal((await pedir(actor, `/api/respuestas-internas/${r.id}/apertura`, {})).status, 403);
        const antes = await (await pedir(1, `/api/respuestas-internas/${r.id}`)).json();
        assert.equal(antes.recepcion.primera_apertura_utc, null);
        const carreras = await Promise.all(Array.from({ length: 8 }, () => pedir(1, `/api/respuestas-internas/${r.id}/apertura`, {})));
        const recibos = [];
        for (const resp of carreras) { assert.equal(resp.status, 200); recibos.push(await resp.json()); }
        for (const recibo of recibos) assert.deepEqual(recibo, recibos[0]);
        assert.ok(recibos[0].recepcion.primera_apertura_utc);
        const [[auditoria]] = await pool.execute(`SELECT COUNT(*) AS n FROM historial_radicado
            WHERE numero_radicado=? AND event_type='respuesta_interna_abierta'`, [n]);
        assert.equal(Number(auditoria.n), 1);
        assert.equal((await pedir(1, `/api/respuestas-internas/${r.id}/apertura`, { fecha: '2000-01-01' })).status, 400);
        assert.equal((await pedir(1, '/api/respuestas-internas?estado=leidas')).status, 200);
        assert.equal((await pedir(1, '/api/respuestas-internas?estado=invalido')).status, 400);
        assert.equal((await pedir(1, '/api/respuestas-internas?pagina=0')).status, 400);
        const destino = await (await pedir(0, `/api/radicados/${n}/recepcion-interna`)).json();
        assert.deepEqual(destino.recepcion, recibos[0].recepcion);
    });
    await t.test('internos: PDF autenticado no marca apertura; fallo de auditoria y respuesta son atomicos', async () => {
        const n = await interno();
        const form = new FormData();
        form.append('contenido', 'Respuesta interna con PDF ficticio.');
        form.append('archivos', new Blob([bytesEntrega], { type: 'application/pdf' }), 'interno.pdf');
        assert.equal((await fetch(`${url}/api/radicados/${n}/respuesta`, {
            method: 'POST', headers: { Authorization: `Bearer ${tokens[0]}` }, body: form,
        })).status, 201);
        const h = await (await pedir(1, '/api/respuestas-internas')).json();
        const r = h.registros.find(r => r.numero_radicado === n);
        const detalle = await (await pedir(1, `/api/respuestas-internas/${r.id}`)).json();
        const doc = detalle.documentos[0];
        const ruta = `/api/respuestas-internas/${r.id}/documentos/${doc.id}`;
        assert.equal((await pedir(4, ruta)).status, 404);
        const descarga = await pedir(1, ruta);
        assert.equal(descarga.status, 200);
        assert.deepEqual(Buffer.from(await descarga.arrayBuffer()), bytesEntrega);
        assert.equal((await (await pedir(1, `/api/respuestas-internas/${r.id}`)).json()).recepcion.primera_apertura_utc, null);
        await pool.query(`CREATE TRIGGER fixture_fallo_interno BEFORE INSERT ON historial_radicado FOR EACH ROW
            BEGIN IF NEW.event_type='respuesta_interna_abierta' OR NEW.event_type='respuesta_enviada'
            THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Fallo interno ficticio'; END IF; END`);
        const nuevo = await interno();
        try {
            assert.equal((await pedir(1, `/api/respuestas-internas/${r.id}/apertura`, {})).status, 500);
            assert.equal((await responder(0, nuevo)).status, 500);
            const [[cuenta]] = await pool.execute('SELECT COUNT(*) AS n FROM respuestas_radicado WHERE numero_radicado=?', [nuevo]);
            assert.equal(Number(cuenta.n), 0);
            assert.equal((await (await pedir(1, `/api/respuestas-internas/${r.id}`)).json()).recepcion.primera_apertura_utc, null);
        } finally { await pool.query('DROP TRIGGER fixture_fallo_interno'); }
        assert.equal((await pedir(1, `/api/respuestas-internas/${r.id}/apertura`, {})).status, 200);
        const [[cruzado]] = await pool.execute(`SELECT id FROM documentos_respuesta WHERE respuesta_id<>? LIMIT 1`, [r.respuesta_id]);
        assert.equal((await pedir(1, `/api/respuestas-internas/${r.id}/documentos/${cruzado.id}`)).status, 404);
    });
    await t.test('internos: permisos se revalidan tras cambios de dependencia y origen inactivo', async () => {
        const n = await interno();
        assert.equal((await responder(0, n)).status, 201);
        const h = await (await pedir(1, '/api/respuestas-internas')).json();
        const r = h.registros.find(r => r.numero_radicado === n);
        await pool.execute('UPDATE radicados SET dependencia_destino_id=? WHERE numero_radicado=?', [dependencias[2], n]);
        assert.equal((await pedir(0, `/api/respuestas-internas/${r.id}`)).status, 404);
        assert.equal((await pedir(4, `/api/respuestas-internas/${r.id}`)).status, 200);
        const [[actor]] = await pool.execute("SELECT id FROM usuarios WHERE rol='funcionario' AND dependencia_id=? LIMIT 1", [dependencias[1]]);
        await pool.execute('UPDATE usuarios SET dependencia_id=? WHERE id=?', [dependencias[0], actor.id]);
        try {
            assert.equal((await pedir(1, `/api/respuestas-internas/${r.id}`)).status, 404);
            assert.equal((await pedir(1, `/api/respuestas-internas/${r.id}/apertura`, {})).status, 404);
        } finally { await pool.execute('UPDATE usuarios SET dependencia_id=? WHERE id=?', [dependencias[1], actor.id]); }
        await pool.execute('UPDATE dependencias SET activo=0 WHERE id=?', [dependencias[1]]);
        try {
            assert.equal((await pedir(1, '/api/respuestas-internas')).status, 403);
            assert.equal((await pedir(1, `/api/respuestas-internas/${r.id}`)).status, 404);
            assert.equal((await pedir(2, `/api/respuestas-internas/${r.id}`)).status, 200);
            assert.equal((await responder(0, await interno())).status, 409);
        } finally { await pool.execute('UPDATE dependencias SET activo=1 WHERE id=?', [dependencias[1]]); }
        const mismo = await interno();
        await pool.execute('UPDATE radicados SET dependencia_remitente_id=? WHERE numero_radicado=?', [dependencias[0], mismo]);
        assert.equal((await responder(0, mismo)).status, 201);
        const recepcion = await (await pedir(0, `/api/radicados/${mismo}/recepcion-interna`)).json();
        assert.equal((await pedir(0, `/api/respuestas-internas/${recepcion.recepcion.id}/apertura`, {})).status, 200);
    });
    await t.test('internos: paginacion estable, indice por origen y cobertura historica incompleta explicita', async () => {
        for (let i = 0; i < 26; i++) {
            const n = await interno();
            assert.equal((await responder(0, n)).status, 201);
        }
        const primera = await (await pedir(1, '/api/respuestas-internas?estado=pendientes')).json();
        const segunda = await (await pedir(1, '/api/respuestas-internas?pagina=2&estado=pendientes')).json();
        assert.equal(primera.registros.length, 25);
        assert.ok(segunda.registros.length > 0);
        assert.equal(primera.total, segunda.total);
        assert.equal(new Set([...primera.registros, ...segunda.registros].map(r => r.id)).size,
            primera.registros.length + segunda.registros.length);
        const [plan] = await pool.execute(`EXPLAIN SELECT id FROM recepciones_internas
            WHERE dependencia_origen_id=? ORDER BY id DESC LIMIT 25`, [dependencias[1]]);
        assert.equal(plan[0].key, 'idx_recepcion_origen');
        const n = await interno();
        await pool.execute(`INSERT INTO respuestas_radicado(numero_radicado,contenido,usuario_id)
            SELECT ?,'Historico ficticio sin recepcion.',id FROM usuarios WHERE rol='funcionario' AND dependencia_id=? LIMIT 1`, [n, dependencias[0]]);
        const { migrarRespuestasInternas } = require('../migrations/027_respuestas_internas');
        assert.equal((await migrarRespuestasInternas(admin)).estado, 'pendiente');
        assert.equal((await pedir(1, '/api/respuestas-internas')).status, 500);
        await pool.execute('UPDATE radicados SET dependencia_remitente_id=NULL WHERE numero_radicado=?', [n]);
        await assert.rejects(migrarRespuestasInternas(admin, { aplicar: true }), /sin origen valido/);
        await pool.execute('UPDATE radicados SET dependencia_remitente_id=? WHERE numero_radicado=?', [dependencias[1], n]);
        await migrarRespuestasInternas(admin, { aplicar: true });
        assert.equal((await pedir(1, '/api/respuestas-internas')).status, 200);
        const global = await radicar({ global: true });
        await pool.execute("UPDATE radicados SET tipo_comunicacion='Interna',dependencia_remitente_id=? WHERE numero_radicado=?", [dependencias[1], global]);
        const [[antes]] = await pool.execute('SELECT COUNT(*) AS n FROM recepciones_internas');
        await pool.execute('INSERT INTO radicado_dependencias(numero_radicado,dependencia_id) VALUES (?,?)', [global, dependencias[0]]);
        assert.equal((await responder(0, global)).status, 201);
        const informativo = await radicar({ informativo: true });
        await pool.execute("UPDATE radicados SET tipo_comunicacion='Interna',dependencia_remitente_id=? WHERE numero_radicado=?", [dependencias[1], informativo]);
        assert.equal((await responder(0, informativo)).status, 409);
        const [[despues]] = await pool.execute('SELECT COUNT(*) AS n FROM recepciones_internas');
        assert.equal(antes.n, despues.n);
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
