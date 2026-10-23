const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');

test('originales globales no dependen de respuestas; cada oficina conserva privadas sus respuestas', async t => {
    const usuarios = [
        { id: 951, rol: 'administrador', dependencia_id: null },
        { id: 952, rol: 'ventanilla', dependencia_id: null },
        { id: 953, rol: 'funcionario', dependencia_id: 2 },
        { id: 954, rol: 'funcionario', dependencia_id: 3 },
        { id: 955, rol: 'funcionario', dependencia_id: 4 }
    ].map(u => ({ ...u, nombre: 'Prueba documental', activo: 1, dependencia_nombre: 'Oficina' }));
    const tokens = new Map(usuarios.map(u => [u.id, crearSesion(u.id)]));
    t.after(() => usuarios.forEach(u => revocarSesiones(u.id)));
    const prefijo = randomUUID();
    const archivos = ['original', 'respuesta-a', 'respuesta-b', 'legacy-a', 'individual']
        .map(nombre => `${prefijo}-${nombre}.pdf`);
    for (const archivo of archivos) {
        const ruta = path.join(__dirname, '..', 'uploads', archivo);
        await fs.writeFile(ruta, '%PDF-1.4\nPrueba documental\n%%EOF');
        t.after(() => fs.unlink(ruta));
    }
    let oficinasRespondidas = [];
    t.mock.method(pool, 'execute', async (sql, valores) => {
        if (sql.includes('FROM usuarios u')) return [[usuarios.find(u => u.id === valores[0])]];
        assert.match(sql, /SELECT r.id FROM radicados r/);
        assert.doesNotMatch(sql, /LEFT JOIN/);
        assert.match(sql, /EXISTS \(\s*SELECT 1 FROM documentos_radicado ddoc\s*WHERE ddoc.numero_radicado = r.numero_radicado AND ddoc.ruta_archivo = \?\s*\) OR EXISTS/);
        assert.match(sql, /WHERE rr.numero_radicado = r.numero_radicado/);
        assert.match(sql, /WHERE dr.respuesta_id = rr.id AND dr.ruta_archivo = \?/);
        const [archivo, repetido, tercero, ...permisos] = valores;
        assert.equal(archivo, repetido);
        assert.equal(archivo, tercero);
        const restringida = sql.includes('rdx.dependencia_id = ?');
        const oficina = restringida ? permisos[0] : null;
        assert.deepEqual(permisos, restringida ? [oficina, oficina, oficina] : []);
        if (restringida) {
            assert.match(sql, /\)\) AND \(r.destino_todas_dependencias = 0 OR rr.radicado_dependencia_id IN/);
            assert.match(sql, /rdx.numero_radicado = rr.numero_radicado/);
            assert.match(sql, /\) AND \(r.dependencia_destino_id = \? OR EXISTS/);
        }
        const indice = archivos.indexOf(archivo);
        if (indice < 0) return [[]];
        if (indice === 4) return [oficina === null || oficina === 2 ? [{ id: 2 }] : []];
        if (oficina !== null && ![2, 3].includes(oficina)) return [[]];
        if (indice === 0) return [[{ id: 1 }]];
        const oficinaRespuesta = indice === 2 ? 3 : 2;
        return [oficinasRespondidas.includes(oficinaRespuesta) &&
            (oficina === null || oficina === oficinaRespuesta) ? [{ id: 1 }] : []];
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}/uploads/`;
    for (const respondidas of [[], [2], [3], [2, 3]]) {
        oficinasRespondidas = respondidas;
        for (const usuario of usuarios) {
            for (const method of ['GET', 'HEAD']) {
                for (let indice = 0; indice < archivos.length; indice++) {
                    const oficina = usuario.dependencia_id;
                    const esRespuesta = indice > 0 && indice < 4;
                    const autor = indice === 2 ? 3 : 2;
                    const permitido = indice === 4
                        ? oficina === null || oficina === 2
                        : (oficina === null || [2, 3].includes(oficina)) &&
                          (!esRespuesta || (respondidas.includes(autor) && (oficina === null || oficina === autor)));
                    const respuesta = await fetch(url + archivos[indice], {
                        method, headers: { Authorization: `Bearer ${tokens.get(usuario.id)}` }
                    });
                    assert.equal(respuesta.status, permitido ? 200 : 404,
                        JSON.stringify({ respondidas, usuario: usuario.id, method, indice }));
                    await respuesta.arrayBuffer();
                }
            }
        }
    }
    assert.equal((await fetch(url + archivos[0])).status, 401);
    const inexistente = await fetch(url + `${prefijo}-ausente.pdf`, {
        headers: { Authorization: `Bearer ${tokens.get(951)}` }
    });
    assert.equal(inexistente.status, 404);
});
