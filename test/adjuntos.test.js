const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PDFDocument } = require('pdf-lib');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');

test('valida la estructura PDF en radicacion y respuestas sin alterar el almacenamiento', async t => {
    const usuario = { id: 91, nombre: 'Admin PDF', rol: 'administrador', dependencia_id: null, activo: 1 };
    const token = crearSesion(usuario.id);
    t.after(() => revocarSesiones(usuario.id));
    const documento = await PDFDocument.create();
    documento.addPage();
    const pdfClasico = Buffer.from(await documento.save({ useObjectStreams: false }));
    const pdfComprimido = Buffer.from(await documento.save());
    const documentoCifrado = await PDFDocument.create();
    documentoCifrado.addPage();
    documentoCifrado.context.trailerInfo.Encrypt = documentoCifrado.context.obj({ Filter: 'Standard' });
    const pdfCifrado = Buffer.from(await documentoCifrado.save({ useObjectStreams: false }));
    const uploadDir = path.join(__dirname, '..', 'uploads');
    const archivosPropios = new Set();
    const leerArchivo = fs.readFile;
    let falloLectura = false;
    t.mock.method(fs, 'readFile', async (ruta, ...opciones) => {
        archivosPropios.add(ruta);
        if (falloLectura) {
            const error = new Error('Fallo de lectura simulado');
            error.code = 'EIO';
            throw error;
        }
        return leerArchivo(ruta, ...opciones);
    });
    t.after(async () => {
        for (const archivo of archivosPropios) {
            try {
                await fs.unlink(archivo);
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
    });
    let conexiones = 0;
    let commits = 0;
    const escrituras = [];
    const termino = {
        id: 1, nombre: 'Consulta', termino_legal_id: 1,
        dias: 1, tipo_dias: 'calendario', fundamento_legal: 'Prueba'
    };
    t.mock.method(pool, 'execute', async (sql, valores) => {
        if (sql.includes('FROM usuarios u')) return [[usuario]];
        if (sql.includes('FROM dependencias')) return [valores[0] === 99 ? [] : [{ id: 2, nombre: 'Planeacion' }]];
        throw new Error(`Consulta inesperada: ${sql}`);
    });
    t.mock.method(pool, 'query', async sql => {
        assert.match(sql, /FROM tipos_tramite AS t/);
        return [[termino]];
    });
    t.mock.method(pool, 'getConnection', async () => {
        conexiones++;
        return {
            async beginTransaction() {},
            async commit() { commits++; },
            async rollback() {},
            release() {},
            async execute(sql, valores) {
                if (sql.includes('SELECT ultimo_numero')) return [[{ ultimo_numero: 0 }]];
                if (sql.includes('SELECT 1 FROM radicados')) return [[]];
                if (sql.includes('SELECT r.estado')) return [[{ estado: 'Recibido' }]];
                if (sql.includes('SELECT id FROM respuestas_radicado')) return [[]];
                escrituras.push({ sql, valores });
                return [{ insertId: 7, affectedRows: 1 }];
            }
        };
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) =>
        server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}`;
    const subir = (ruta, contenidos, campo = 'archivos', tipoComunicacion = 'Externa', destino = '2', cambios = {}) => {
        const form = new FormData();
        form.append('contenido', 'Respuesta institucional de prueba');
        form.append('asunto_documento', 'Prueba PDF');
        form.append('remitente_nombre', 'Remitente');
        form.append('remitente_documento', '123');
        form.append('dependencia_destino_id', destino);
        form.append('tipo_tramite_id', '1');
        if (tipoComunicacion !== null) form.append('tipo_comunicacion', tipoComunicacion);
        if (tipoComunicacion === 'Interna') form.append('dependencia_remitente_id', '2');
        else {
            form.append('remitente_tipo_persona', 'natural');
            form.append('remitente_email', 'remitente@example.com');
        }
        for (const [nombre, valor] of Object.entries(cambios)) {
            form.delete(nombre);
            if (valor !== null) {
                for (const item of Array.isArray(valor) ? valor : [valor]) form.append(nombre, item);
            }
        }
        for (const contenido of contenidos) {
            form.append(campo, new Blob([contenido], { type: 'application/pdf' }), 'adjunto.pdf');
        }
        return fetch(url + ruta, {
            method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
        });
    };
    const rutas = ['/api/radicados', '/api/radicados/RAD-PRUEBA/respuesta'];
    for (const tipoComunicacion of [null, 'Entrada']) {
        const conexionesAntes = conexiones;
        const respuesta = await subir('/api/radicados', [pdfClasico], 'archivos', tipoComunicacion);
        assert.equal(respuesta.status, 400);
        assert.equal((await respuesta.json()).message, 'La clase de comunicación debe ser Interna o Externa.');
        assert.equal(conexiones, conexionesAntes);
    }
    await t.test('/api/radicados: rechaza asunto mayor a 5000 caracteres y limpia la carga', async () => {
        const conexionesAntes = conexiones;
        const anteriores = new Set(archivosPropios);
        const form = new FormData();
        form.append('asunto_documento', 'a'.repeat(5001));
        form.append('remitente_nombre', 'Remitente');
        form.append('remitente_documento', '123');
        form.append('dependencia_destino_id', '2');
        form.append('tipo_tramite_id', '1');
        form.append('tipo_comunicacion', 'Externa');
        form.append('archivos', new Blob([pdfClasico], { type: 'application/pdf' }), 'adjunto.pdf');
        const respuesta = await fetch(url + '/api/radicados', {
            method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
        });
        assert.equal(respuesta.status, 400);
        assert.deepEqual(await respuesta.json(), {
            success: false, message: 'El asunto no puede superar 5000 caracteres.'
        });
        assert.equal(conexiones, conexionesAntes);
        const nuevos = [...archivosPropios].filter(archivo => !anteriores.has(archivo));
        for (const archivo of nuevos) {
            await assert.rejects(fs.access(archivo), { code: 'ENOENT' });
        }
    });
    const invalidos = [
        ['texto con firma falsificada', Buffer.from('%PDF-1.4\nNo es un PDF\n%%EOF')],
        ['HTML con firma incrustada', Buffer.from('<html>%PDF-1.4\n%%EOF</html>')],
        ['archivo truncado', pdfClasico.subarray(0, pdfClasico.length - 20)],
        ['objeto interno corrupto', Buffer.from(pdfClasico.toString('latin1').replace('/Type /Catalog', '/Type (Catalog'))],
        ['arbol de paginas inexistente', Buffer.from(pdfClasico.toString('latin1').replace('/Pages 1 0 R', '/Pages 999 0 R'))],
        ['PDF cifrado no legible', pdfCifrado]
    ];
    for (const ruta of rutas) {
        for (const [nombre, contenido] of invalidos) {
            await t.test(`${ruta}: rechaza ${nombre} y limpia todos los adjuntos`, async () => {
                const conexionesAntes = conexiones;
                const anteriores = new Set(archivosPropios);
                const respuesta = await subir(ruta, [pdfComprimido, contenido]);
                assert.equal(respuesta.status, 400);
                assert.deepEqual(await respuesta.json(), {
                    success: false,
                    message: contenido === pdfCifrado
                        ? 'El archivo PDF está cifrado o protegido con contraseña y no se puede validar. Adjunta una copia sin protección, si tienes autorización para hacerlo.'
                        : 'Uno o más archivos no contienen un PDF válido.'
                });
                assert.equal(conexiones, conexionesAntes);
                const nuevos = [...archivosPropios].filter(archivo => !anteriores.has(archivo));
                assert.equal(nuevos.length, 2);
                for (const archivo of nuevos) {
                    await assert.rejects(fs.access(archivo), { code: 'ENOENT' });
                }
            });
        }
        await t.test(`${ruta}: error de disco devuelve 500 y limpia la carga`, async () => {
            const anteriores = new Set(archivosPropios);
            const conexionesAntes = conexiones;
            falloLectura = true;
            try {
                const respuesta = await subir(ruta, [pdfClasico]);
                assert.equal(respuesta.status, 500);
                assert.equal((await respuesta.json()).success, false);
            } finally {
                falloLectura = false;
            }
            assert.equal(conexiones, conexionesAntes);
            const nuevos = [...archivosPropios].filter(archivo => !anteriores.has(archivo));
            assert.equal(nuevos.length, 1);
            await assert.rejects(fs.access(nuevos[0]), { code: 'ENOENT' });
        });
        await t.test(`${ruta}: acepta PDFs clasicos y comprimidos conservando bytes y metadatos`, async () => {
            const escriturasAntes = escrituras.length;
            const commitsAntes = commits;
            const respuesta = await subir(ruta, [pdfClasico, pdfComprimido]);
            assert.equal(respuesta.status, ruta === '/api/radicados' ? 200 : 201);
            const resultado = await respuesta.json();
            assert.equal(resultado.success, true);
            if (ruta === '/api/radicados') {
                assert.equal(resultado.tipo_comunicacion, 'Externa');
                assert.ok(escrituras.slice(escriturasAntes).some(({ sql }) =>
                    sql.includes('INSERT INTO comunicaciones_externas')));
            }
            assert.equal(commits, commitsAntes + 1);
            const documentos = escrituras.slice(escriturasAntes).filter(({ sql }) =>
                /INSERT INTO documentos_(radicado|respuesta)/.test(sql));
            assert.equal(documentos.length, 2);
            for (const [indice, { valores }] of documentos.entries()) {
                assert.equal(valores[1], 'adjunto.pdf');
                assert.match(valores[2], ruta === '/api/radicados'
                    ? /^[a-f0-9-]{36}\.pdf$/
                    : /^respuestas\/respuesta-[a-f0-9-]{36}\.pdf$/);
                assert.equal(valores[3], 'application/pdf');
                const original = [pdfClasico, pdfComprimido][indice];
                assert.equal(valores[4], original.length);
                assert.deepEqual(await leerArchivo(path.join(uploadDir, valores[2])), original);
            }
        });
    }
    for (const tipoComunicacion of ['Interna', 'Externa']) {
        await t.test(`radicacion guarda la clase elegida: ${tipoComunicacion}`, async () => {
            const escriturasAntes = escrituras.length;
            const respuesta = await subir('/api/radicados', [pdfClasico], 'archivos', tipoComunicacion);
            assert.equal(respuesta.status, 200);
            const resultado = await respuesta.json();
            assert.equal(resultado.tipo_comunicacion, tipoComunicacion);
            const tabla = tipoComunicacion === 'Interna' ? 'comunicaciones_internas' : 'comunicaciones_externas';
            assert.ok(escrituras.slice(escriturasAntes).some(({ sql }) => sql.includes(`INSERT INTO ${tabla}`)));
            const insertRadicado = escrituras.slice(escriturasAntes).find(({ sql }) => sql.includes('INSERT INTO radicados'));
            assert.equal(insertRadicado.valores[2], tipoComunicacion);
            assert.equal(insertRadicado.valores.length, 21);
            assert.equal((insertRadicado.sql.match(/\?/g) || []).length, 21);
            assert.deepEqual(insertRadicado.valores.slice(18), tipoComunicacion === 'Interna'
                ? [2, 'Planeacion', null] : [null, null, 'natural']);
            assert.equal(resultado.dependencia_remitente, tipoComunicacion === 'Interna' ? 'Planeacion' : null);
        });
    }
    for (const [nombre, clase, cambios, estado] of [
        ['interna sin origen', 'Interna', { dependencia_remitente_id: null }, 400],
        ['interna origen global', 'Interna', { dependencia_remitente_id: 'todas' }, 400],
        ['interna origen decimal', 'Interna', { dependencia_remitente_id: '2.0' }, 400],
        ['interna origen repetido', 'Interna', { dependencia_remitente_id: ['2', '3'] }, 400],
        ['interna origen no seguro', 'Interna', { dependencia_remitente_id: '9007199254740992' }, 400],
        ['interna origen ausente o inactivo', 'Interna', { dependencia_remitente_id: '99' }, 422],
        ['interna con persona externa', 'Interna', { remitente_tipo_persona: 'natural' }, 400],
        ['externa con origen', 'Externa', { dependencia_remitente_id: '2' }, 400],
        ['externa con nombre de origen', 'Externa', { dependencia_remitente: 'Planeacion' }, 400],
        ['externa sin persona', 'Externa', { remitente_tipo_persona: null }, 400],
        ['externa persona inválida', 'Externa', { remitente_tipo_persona: 'otra' }, 400],
        ['externa sin correo', 'Externa', { remitente_email: null }, 400],
        ['externa correo inválido', 'Externa', { remitente_email: 'invalido' }, 400],
        ['externa correo largo', 'Externa', { remitente_email: 'a'.repeat(140) + '@example.com' }, 400],
        ['externa correo repetido', 'Externa', { remitente_email: ['a@example.com', 'b@example.com'] }, 400],
        ['jurídica sin razón', 'Externa', { remitente_tipo_persona: 'juridica', remitente_nit: '123' }, 400],
        ['jurídica sin NIT', 'Externa', { remitente_tipo_persona: 'juridica', remitente_entidad: 'Empresa' }, 400],
        ['jurídica NIT inválido', 'Externa', { remitente_tipo_persona: 'juridica', remitente_entidad: 'Empresa', remitente_nit: 'ABC' }, 400],
        ['nombre vacío', 'Externa', { remitente_nombre: '  ' }, 400],
        ['cédula inválida', 'Interna', { remitente_documento: 'abc' }, 400],
        ['jurídica sin cédula de contacto', 'Externa', { remitente_tipo_persona: 'juridica',
            remitente_entidad: 'Empresa', remitente_nit: '123', remitente_documento: null }, 400],
        ['entidad excedida', 'Externa', { remitente_entidad: 'a'.repeat(151) }, 400],
    ]) {
        await t.test(`procedencia: rechaza ${nombre} y limpia adjuntos`, async () => {
            const anteriores = new Set(archivosPropios);
            const conexionesAntes = conexiones;
            const respuesta = await subir('/api/radicados', [pdfClasico], 'archivos', clase, '2', cambios);
            assert.equal(respuesta.status, estado);
            assert.equal((await respuesta.json()).success, false);
            assert.equal(conexiones, conexionesAntes);
            const nuevos = [...archivosPropios].filter(archivo => !anteriores.has(archivo));
            assert.equal(nuevos.length, 1);
            await assert.rejects(fs.access(nuevos[0]), { code: 'ENOENT' });
        });
    }
    await t.test('interna ignora nombre falsificado y admite mismo origen y destino sin correo', async () => {
        const respuesta = await subir('/api/radicados', [pdfClasico], 'archivos', 'Interna', '2',
            { dependencia_remitente: 'Nombre falso' });
        assert.equal(respuesta.status, 200);
        const resultado = await respuesta.json();
        assert.equal(resultado.dependencia_remitente, 'Planeacion');
        assert.equal(resultado.dependencia_remitente_id, 2);
        assert.equal(resultado.remitente_tipo_persona, null);
    });
    await t.test('externa jurídica persiste clasificación y datos de contacto', async () => {
        const respuesta = await subir('/api/radicados', [pdfClasico], 'archivos', 'Externa', '2',
            { remitente_tipo_persona: 'juridica', remitente_entidad: 'Empresa', remitente_nit: '123456789012' });
        assert.equal(respuesta.status, 200);
        assert.equal((await respuesta.json()).remitente_tipo_persona, 'juridica');
        const registro = escrituras.filter(({ sql }) => sql.includes('INSERT INTO radicados')).at(-1);
        assert.equal(registro.valores[7], 'Empresa');
        assert.equal(registro.valores[8], '123456789012');
        assert.equal(registro.valores[10], 'remitente@example.com');
        assert.deepEqual(registro.valores.slice(18), [null, null, 'juridica']);
    });
    await t.test('radicacion global se guarda sin ID de dependencia y con marca compartida', async () => {
        const escriturasAntes = escrituras.length;
        const respuesta = await subir('/api/radicados', [pdfClasico], 'archivos', 'Externa', 'todas');
        assert.equal(respuesta.status, 200);
        const resultado = await respuesta.json();
        assert.equal(resultado.destino_todas_dependencias, true);
        assert.equal(resultado.dependencia_destino, 'Todas las dependencias');
        const insertRadicado = escrituras.slice(escriturasAntes).find(({ sql }) => sql.includes('INSERT INTO radicados'));
        assert.equal(insertRadicado.valores[13], 'Todas las dependencias');
        assert.equal(insertRadicado.valores[16], null);
        assert.equal(insertRadicado.valores[17], 1);
    });
    await t.test('el campo singular archivo mantiene compatibilidad con radicacion', async () => {
        const respuesta = await subir('/api/radicados', [pdfClasico], 'archivo');
        assert.equal(respuesta.status, 200);
        assert.equal((await respuesta.json()).success, true);
    });
});
