const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');

async function ejecutar() {
    assert.match(process.env.DB_NAME || '', /^ventanilla_recuperacion_[a-f0-9]{12}_(origen|destino)$/);
    assert.ok(process.env.UPLOAD_DIR && path.isAbsolute(process.env.UPLOAD_DIR));
    const pool = require('../db');
    const app = require('../server');
    const { crearSesion, revocarSesiones, hashPassword } = require('../auth');
    const { PDFDocument } = require('pdf-lib');
    const [modo, archivoFixture] = process.argv.slice(2);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    const sesiones = [];
    try {
        let fixture;
        if (modo === 'crear') {
            const dependenciaIds = [];
            for (const nombre of ['Oficina ficticia A', 'Oficina ficticia B']) {
                const [result] = await pool.execute('INSERT INTO dependencias(nombre, activo) VALUES (?, 1)', [nombre]);
                dependenciaIds.push(result.insertId);
            }
            const password = await hashPassword(`Fixture!9-${randomUUID()}`);
            const usuarios = [];
            for (const [rol, dependenciaId] of [
                ['administrador', null], ['administrador', null],
                ['funcionario', dependenciaIds[0]], ['funcionario', dependenciaIds[1]]
            ]) {
                const [result] = await pool.execute(
                    'INSERT INTO usuarios(nombre,email,password,rol,dependencia_id,activo) VALUES (?,?,?,?,?,1)',
                    ['Actor ficticio de recuperacion', `${randomUUID()}@example.test`, password, rol, dependenciaId]);
                usuarios.push(result.insertId);
            }
            const [tipo] = await pool.execute(
                `INSERT INTO tipos_tramite(codigo,nombre,categoria_general,requiere_respuesta)
                 VALUES ('recuperacion_fixture','Tramite ficticio','peticion_general',1)`);
            await pool.execute(
                `INSERT INTO terminos_legales(tipo_tramite_id,dias,tipo_dias,fundamento_legal,vigente_desde)
                 VALUES (?,10,'habiles','Regla ficticia de recuperacion','2000-01-01')`, [tipo.insertId]);
            fixture = { usuarios, dependenciaIds, tipoId: tipo.insertId, clave: randomUUID() };
        } else {
            assert.equal(modo, 'verificar');
            fixture = JSON.parse(await fs.readFile(archivoFixture, 'utf8'));
        }
        const tokens = fixture.usuarios.map(id => {
            sesiones.push(id);
            return crearSesion(id);
        });
        const pdf = await PDFDocument.create();
        pdf.addPage();
        // El mismo PDF se reutiliza literalmente para que la huella sea estable tras reiniciar.
        const rutaPdf = path.join(path.dirname(archivoFixture), 'fixture-original.pdf');
        const bytes = modo === 'crear' ? Buffer.from(await pdf.save()) : await fs.readFile(rutaPdf);
        if (modo === 'crear') await fs.writeFile(rutaPdf, bytes, { flag: 'wx' });
        const solicitar = (actor, ruta, opciones = {}) => fetch(url + ruta, {
            signal: AbortSignal.timeout(30_000),
            ...opciones, headers: { ...opciones.headers, Authorization: `Bearer ${tokens[actor]}` }
        });
        const enviar = (actor, clave, cambios = {}, contenido = bytes) => {
            const form = new FormData();
            const datos = {
                tipo_recepcion: 'Digital', tipo_comunicacion: 'Externa',
                tipo_tramite_id: String(fixture.tipoId), dependencia_destino_id: String(fixture.dependenciaIds[0]),
                remitente_nombre: 'Remitente ficticio', remitente_documento: '0000000001',
                remitente_email: 'fixture@example.test', remitente_tipo_persona: 'natural',
                asunto_documento: 'PRUEBA FICTICIA DE REINTENTOS Y RECUPERACION', ...cambios
            };
            for (const [campo, valor] of Object.entries(datos)) form.append(campo, valor);
            form.append('archivos', new Blob([contenido], { type: 'application/pdf' }), 'original-ficticio.pdf');
            return solicitar(actor, '/api/radicados', {
                method: 'POST', headers: { 'Idempotency-Key': clave }, body: form
            });
        };
        if (modo === 'crear') {
            // Superar el pool de 10 conexiones detecta esperas circulares por adquirir otra conexion.
            const concurrentes = await Promise.all(Array.from({ length: 12 }, () => enviar(0, fixture.clave)));
            const resultados = [];
            for (const respuesta of concurrentes) {
                assert.equal(respuesta.status, 200, await respuesta.clone().text());
                resultados.push(await respuesta.json());
            }
            for (const resultado of resultados) assert.deepEqual(resultado, resultados[0]);
            const [[creados]] = await pool.execute('SELECT COUNT(*) AS total FROM radicados');
            const [[consecutivo]] = await pool.execute('SELECT SUM(ultimo_numero) AS total FROM secuencias_radicado');
            assert.equal(Number(creados.total), 1);
            assert.equal(Number(consecutivo.total), 1);
            fixture.concurrencia = { envios: concurrentes.length, radicados: 1, consecutivos: 1 };
            fixture.respuesta = resultados[0];
            const segunda = await enviar(1, fixture.clave);
            assert.equal(segunda.status, 200);
            fixture.segundo = (await segunda.json()).radicado;
            assert.notEqual(fixture.segundo, fixture.respuesta.radicado);
            const global = await enviar(0, randomUUID(), { dependencia_destino_id: 'todas' });
            assert.equal(global.status, 200);
            fixture.global = (await global.json()).radicado;
            const respuestaForm = new FormData();
            respuestaForm.append('contenido', 'Respuesta sintetica para verificar restauracion de PDFs.');
            respuestaForm.append('archivos', new Blob([bytes], { type: 'application/pdf' }), 'respuesta-ficticia.pdf');
            assert.equal((await solicitar(2, `/api/radicados/${fixture.respuesta.radicado}/respuesta`, {
                method: 'POST', body: respuestaForm
            })).status, 201);
            fixture.claveEntrega = randomUUID();
            const formEntrega = new FormData();
            for (const [k, v] of Object.entries({ clave: fixture.claveEntrega, canal: 'correo_electronico',
                resultado: 'entrega_acreditada', destinatario: 'Persona ficticia', destino: 'fixture@example.test',
                fecha_actuacion: '2026-01-05T10:00', observaciones: 'Constancia exclusivamente ficticia.' })) formEntrega.append(k, v);
            formEntrega.append('archivos', new Blob([bytes], { type: 'application/pdf' }), 'evidencia-ficticia.pdf');
            const entrega = await solicitar(0, `/api/radicados/${fixture.respuesta.radicado}/entregas`, { method: 'POST', body: formEntrega });
            assert.equal(entrega.status, 201, await entrega.clone().text());
            fixture.entrega = (await entrega.json()).registro;
            const [conteos] = await pool.execute('SELECT COUNT(*) AS total FROM radicados');
            assert.equal(Number(conteos[0].total), 3);
            const [secuencia] = await pool.execute('SELECT SUM(ultimo_numero) AS total FROM secuencias_radicado');
            assert.equal(Number(secuencia[0].total), 3);
            // Probar replay sin depender de la vigencia posterior del catalogo.
            await pool.execute('UPDATE tipos_tramite SET activo = 0 WHERE id = ?', [fixture.tipoId]);
            await fs.writeFile(archivoFixture, JSON.stringify(fixture, null, 2), { flag: 'wx' });
        }
        const [antes] = await pool.execute('SELECT COUNT(*) AS total FROM radicados');
        const repetida = await enviar(0, fixture.clave);
        assert.equal(repetida.status, 200);
        assert.deepEqual(await repetida.json(), fixture.respuesta);
        assert.equal((await enviar(0, fixture.clave, { asunto_documento: 'Otro asunto' })).status, 409);
        const otroPdf = await PDFDocument.create();
        otroPdf.addPage([200, 200]);
        assert.equal((await enviar(0, fixture.clave, {}, await otroPdf.save())).status, 409);
        const [despues] = await pool.execute('SELECT COUNT(*) AS total FROM radicados');
        assert.deepEqual(antes, despues);
        const [originales] = await pool.execute('SELECT ruta_archivo FROM documentos_radicado ORDER BY id');
        const [respuestas] = await pool.execute('SELECT ruta_archivo FROM documentos_respuesta ORDER BY id');
        assert.equal(originales.length, 3);
        assert.equal(respuestas.length, 1);
        const original = originales[0].ruta_archivo;
        assert.equal((await solicitar(2, `/uploads/${original}`)).status, 200);
        assert.equal((await solicitar(3, `/uploads/${original}`)).status, 404);
        const descargada = await solicitar(2, `/uploads/${respuestas[0].ruta_archivo}`);
        assert.equal(descargada.status, 200);
        assert.deepEqual(Buffer.from(await descargada.arrayBuffer()), bytes);
        const rutaEntregas = `/api/radicados/${fixture.respuesta.radicado}/entregas`;
        const h = await (await solicitar(2, rutaEntregas)).json();
        assert.equal(h.resumen, 'entrega_acreditada'); assert.equal(h.total, 1);
        assert.deepEqual(h.registros[0], fixture.entrega);
        const evidenciaRuta = `${rutaEntregas}/${fixture.entrega.id}/evidencias/${fixture.entrega.evidencias[0].id}`;
        const evidencia = await solicitar(2, evidenciaRuta);
        assert.equal(evidencia.status, 200);
        assert.deepEqual(Buffer.from(await evidencia.arrayBuffer()), bytes);
        assert.equal((await solicitar(3, evidenciaRuta)).status, 404);
        const repetirEntrega = new FormData();
        for (const [k, v] of Object.entries({ clave: fixture.claveEntrega, canal: 'correo_electronico',
            resultado: 'entrega_acreditada', destinatario: 'Persona ficticia', destino: 'fixture@example.test',
            fecha_actuacion: '2026-01-05T10:00', observaciones: 'Constancia exclusivamente ficticia.' })) repetirEntrega.append(k, v);
        repetirEntrega.append('archivos', new Blob([bytes], { type: 'application/pdf' }), 'evidencia-ficticia.pdf');
        const replayEntrega = await solicitar(0, rutaEntregas, { method: 'POST', body: repetirEntrega });
        assert.equal(replayEntrega.status, 200);
        assert.deepEqual((await replayEntrega.json()).registro, fixture.entrega);
        const [[entregas]] = await pool.execute('SELECT COUNT(*) AS n FROM registros_entrega_respuesta');
        const [[evidencias]] = await pool.execute('SELECT COUNT(*) AS n FROM evidencias_entrega');
        assert.equal(Number(entregas.n), 1); assert.equal(Number(evidencias.n), 1);
        const [historial] = await pool.execute(
            "SELECT COUNT(*) AS total FROM historial_radicado WHERE event_type = 'radicado_creado'");
        assert.equal(Number(historial[0].total), 3);
        const [intentos] = await pool.execute('SELECT COUNT(*) AS total FROM intentos_radicacion');
        assert.equal(Number(intentos[0].total), 3);
        console.log(JSON.stringify({ modo, validado: true, radicados: 3, intentos: 3, originales: 3, respuestas: 1, evidencias: 1 }));
    } finally {
        for (const id of sesiones) revocarSesiones(id);
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await pool.end();
    }
}

if (require.main === module) ejecutar().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
