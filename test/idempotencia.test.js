const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validarClave, huellaSolicitud, buscarIntento, reservarIntento, confirmarIntento } = require('../idempotencia');
const { nombreSeguro } = require('../scripts/probar-recuperacion');

const clave = 'd2776230-9bfc-4679-a50e-96fc2f80b432';
const req = { usuario: { id: 7 }, claveRadicacion: clave };

test('clave opcional legacy y UUID v4 canonico sin aceptar otros formatos', () => {
    for (const header of [undefined, clave.toUpperCase()]) {
        const peticion = { get: () => header };
        let llamadas = 0;
        validarClave(peticion, { status: () => assert.fail('No debe rechazar') }, () => llamadas++);
        assert.equal(llamadas, 1);
        assert.equal(peticion.claveRadicacion, header ? clave : undefined);
    }
    for (const header of ['', 'clave-arbitraria', clave.replace('-4679-', '-1679-'), `${clave},${clave}`]) {
        let status;
        const res = { status: codigo => { status = codigo; return res; }, json: resultado => {
            assert.equal(resultado.success, false);
        } };
        validarClave({ get: () => header }, res, () => assert.fail('No debe continuar'));
        assert.equal(status, 400);
    }
});

test('huella conserva campos, bytes, nombres y orden PDF sin depender de ruta temporal', async t => {
    const carpeta = await fs.mkdtemp(path.join(os.tmpdir(), 'ventanilla-huella-'));
    const uno = path.join(carpeta, 'uno.pdf');
    const dos = path.join(carpeta, 'dos.pdf');
    const tres = path.join(carpeta, 'tres.pdf');
    t.after(async () => {
        for (const archivo of [uno, dos, tres]) await fs.unlink(archivo);
        await fs.rmdir(carpeta);
    });
    await fs.writeFile(uno, 'PDF A');
    await fs.writeFile(dos, 'PDF A');
    await fs.writeFile(tres, 'PDF B');
    const documento = { path: uno, originalname: 'original.pdf', mimetype: 'application/pdf', size: 5 };
    const peticion = { body: { asunto: 'Ficticio', tipo: '10' }, files: [documento] };
    const huella = await huellaSolicitud(peticion);
    assert.equal(huella.length, 64);
    assert.equal(await huellaSolicitud({ body: { tipo: '10', asunto: 'Ficticio' },
        files: [{ ...documento, path: dos }] }), huella);
    for (const cambio of [
        { body: { ...peticion.body, asunto: 'Otro' }, files: peticion.files },
        { body: peticion.body, files: [{ ...documento, originalname: 'otro.pdf' }] },
        { body: peticion.body, files: [{ ...documento, path: tres }] }
    ]) assert.notEqual(await huellaSolicitud(cambio), huella);
    const distinto = { ...documento, path: tres };
    assert.notEqual(await huellaSolicitud({ body: {}, files: [documento, distinto] }),
        await huellaSolicitud({ body: {}, files: [distinto, documento] }));
});

test('reserva usa actor, clave y bloqueo; replay original y conflicto no mutan resultado', async () => {
    const respuesta = { success: true, radicado: 'RAD-FICTICIO', termino: { dias: 10 } };
    const llamadas = [];
    const connection = { execute: async (sql, parametros) => {
        llamadas.push({ sql, parametros });
        return sql.startsWith('INSERT') ? [{ affectedRows: 0 }] :
            [[{ huella: 'huella', respuesta_json: JSON.stringify(respuesta) }]];
    } };
    assert.deepEqual(await reservarIntento(connection, req, 'huella'), respuesta);
    assert.deepEqual(llamadas[0].parametros, [7, clave, 'huella']);
    assert.match(llamadas[1].sql, /FOR UPDATE$/);
    assert.deepEqual(llamadas[1].parametros, [7, clave]);
    await assert.rejects(buscarIntento(connection, req, 'otra'), error => error.status === 409);
    assert.deepEqual(llamadas[2].parametros, [7, clave]);
    assert.deepEqual(await buscarIntento(connection, { ...req, usuario: { id: 8 } }, 'huella'), respuesta);
    assert.equal(llamadas[3].parametros[0], 8);
});

test('intento ausente o reservado no inventa confirmacion; resultado corrupto se rechaza', async () => {
    for (const rows of [[], [{ huella: 'h', respuesta_json: null }]]) {
        assert.equal(await buscarIntento({ execute: async () => [rows] }, req, 'h'), null);
    }
    for (const respuesta_json of ['no-json', '{"success":false}', '{"success":true,"radicado":42}']) {
        await assert.rejects(buscarIntento({ execute: async () =>
            [[{ huella: 'h', respuesta_json }]] }, req, 'h'));
    }
});

test('confirmacion actualiza exactamente una reserva con respuesta original', async () => {
    const respuesta = { success: true, radicado: 'RAD-FICTICIO', fecha: '2026-01-01' };
    const connection = { execute: async (sql, parametros) => {
        assert.match(sql, /respuesta_json IS NULL/);
        assert.deepEqual(parametros, [respuesta.radicado, JSON.stringify(respuesta), 7, clave]);
        return [{ affectedRows: 1 }];
    } };
    await confirmarIntento(connection, req, respuesta);
    for (const affectedRows of [0, 2]) {
        await assert.rejects(confirmarIntento({ execute: async () => [{ affectedRows }] }, req, respuesta),
            /atomicamente/);
    }
});

test('herramienta de recuperacion rechaza bases normales y nombres no exclusivos', () => {
    assert.equal(nombreSeguro('ventanilla_recuperacion_d27762309bfc_origen'),
        'ventanilla_recuperacion_d27762309bfc_origen');
    for (const nombre of ['ventanilla_unica', 'ventanilla_unica_test', 'mysql', 'ventanilla_recuperacion_origen']) {
        assert.throws(() => nombreSeguro(nombre), /exclusiva/);
    }
});
