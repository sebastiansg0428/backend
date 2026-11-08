const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const fs = require('node:fs/promises');
const { crearEntornoMysql } = require('../test-support/mysql-aislado.cjs');

test('recepcion HTTP/MySQL: vigencia segura, medicion y recuperacion con fixtures', {
    skip: process.env.TEST_RECEPCION_RENDIMIENTO_MYSQL !== '1'
}, async t => {
    const entorno = await crearEntornoMysql(t, 'rendimiento');
    const pool = require('../db');
    entorno.registrarPool(pool);
    const [origen] = await pool.execute("INSERT INTO dependencias(nombre,activo) VALUES ('Origen ficticio',1)");
    const [destino] = await pool.execute("INSERT INTO dependencias(nombre,activo) VALUES ('Destino ficticio',1)");
    const usuarios = [];
    for (const [rol, dependencia] of [['ventanilla', null], ['funcionario', origen.insertId], ['funcionario', destino.insertId]]) {
        const [u] = await pool.execute(`INSERT INTO usuarios(nombre,email,password,rol,dependencia_id,activo)
            VALUES (?,?,?,?,?,1)`, [`Actor ficticio ${rol}`, `${usuarios.length}@example.test`,
        'no-utilizable', rol, dependencia]);
        usuarios.push(u.insertId);
    }
    async function registro(i, recepcion = true) {
        const numero = `RENDIMIENTO-FICTICIO-${i}`;
        await pool.execute(`INSERT INTO radicados(numero_radicado,tipo_documento,tipo_comunicacion,
            tiempo_de_respuesta,remitente_nombre,remitente_documento,remitente_telefono,
            dependencia_destino,dependencia_destino_id,dependencia_remitente,dependencia_remitente_id,
            asunto_documento,usuario_recibe,estado,fecha_hora_recepcion,destino_todas_dependencias,requiere_respuesta)
            VALUES (?,'Solicitud','Interna','15 dias habiles','Origen ficticio','00000','00000',
            'Destino ficticio',?,'Origen ficticio',?,'Asunto ficticio','Actor ficticio','Respondido',
            '2026-11-07 12:00:00',0,1)`, [numero, destino.insertId, origen.insertId]);
        const [r] = await pool.execute(`INSERT INTO respuestas_radicado(numero_radicado,contenido,usuario_id)
            VALUES (?,'Respuesta ficticia',?)`, [numero, usuarios[2]]);
        if (recepcion) await pool.execute(`INSERT INTO recepciones_internas(respuesta_id,dependencia_origen_id,historica,disponible_en_utc)
            VALUES (?,?,0,UTC_TIMESTAMP(6))`, [r.insertId, origen.insertId]);
        return numero;
    }
    for (let i = 1; i <= 30; i++) await registro(i);

    const modulo = require('../estructura-interna');
    const crear = modulo.crearGuardiaEstructura;
    let reloj = 0, baseline = false, verificaciones = 0, coberturas = 0;
    modulo.crearGuardiaEstructura = verificar => {
        const contar = async c => { verificaciones++; return verificar(c); };
        const guardia = crear(contar, () => reloj);
        return { ...guardia, exigir: c => baseline ? contar(c).then(valido => {
            assert.equal(valido, true);
        }) : guardia.exigir(c) };
    };
    t.after(() => { modulo.crearGuardiaEstructura = crear; });
    const migracion = require('../migrations/027_respuestas_internas');
    const cobertura = migracion.verificarCobertura;
    migracion.verificarCobertura = async (...args) => { coberturas++; return cobertura(...args); };
    t.after(() => { migracion.verificarCobertura = cobertura; });
    const app = require('../server');
    const { crearSesion, revocarSesiones } = require('../auth');
    const tokens = usuarios.map(id => crearSesion(id));
    t.after(() => usuarios.forEach(id => revocarSesiones(id)));
    const server = app.listen(0, '127.0.0.1');
    entorno.registrarServidor(server);
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    const ruta = '/api/radicados/RENDIMIENTO-FICTICIO-1/recepcion-interna';
    const pedir = (indice = 0, path = ruta, method = 'GET') => fetch(url + path, {
        method, headers: { Authorization: `Bearer ${tokens[indice]}` }, signal: AbortSignal.timeout(30000)
    });
    const leer = async () => {
        const inicio = performance.now();
        const r = await pedir();
        const ttfb = performance.now() - inicio;
        assert.equal(r.status, 200, await r.clone().text());
        const datos = await r.json();
        assert.equal(datos.recepcion.primera_apertura_utc, null);
        return { ttfb, total: performance.now() - inicio, timing: r.headers.get('Server-Timing') };
    };
    let primera, vencida, antes, despues;
    await t.test('lecturas reutilizan estructura, mantienen cobertura y revalidan al vencer', async () => {
        primera = await leer();
        assert.equal(verificaciones, 1);
        assert.match(primera.timing, /^estructura;dur=\d+\.\d+, cobertura;dur=/);
        await Promise.all(Array.from({ length: 8 }, () => leer()));
        assert.equal(verificaciones, 1);
        assert.equal(coberturas, 9);
        reloj = 29999;
        await leer();
        assert.equal(verificaciones, 1);
        reloj = 30000;
        vencida = await leer();
        assert.equal(verificaciones, 2);
        assert.equal(coberturas, 11);
    });
    await t.test('permisos y cobertura cambian sin esperar a la vigencia', async () => {
        await pool.execute('UPDATE dependencias SET activo=0 WHERE id=?', [destino.insertId]);
        try { assert.equal((await pedir(2)).status, 404); }
        finally { await pool.execute('UPDATE dependencias SET activo=1 WHERE id=?', [destino.insertId]); }
        const faltante = await registro(31, false);
        assert.equal((await pedir()).status, 500);
        await pool.execute('UPDATE radicados SET requiere_respuesta=0 WHERE numero_radicado=?', [faltante]);
        assert.equal((await pedir()).status, 200);
    });
    await t.test('fallo SQL estructural invalida lecturas y recupera tras corregir', async () => {
        await pool.query('ALTER TABLE respuestas_radicado RENAME COLUMN contenido TO fixture_contenido');
        try { assert.equal((await pedir()).status, 503); }
        finally { await pool.query('ALTER TABLE respuestas_radicado RENAME COLUMN fixture_contenido TO contenido'); }
        const previas = verificaciones;
        assert.equal((await pedir()).status, 200);
        assert.equal(verificaciones, previas + 1);
    });
    await t.test('escritura no usa vigencia, falla sin apertura y recupera sin reiniciar', async () => {
        await pool.query('ALTER TABLE recepciones_internas MODIFY actor_nombre VARCHAR(149) NULL');
        try {
            assert.equal((await pedir(1, '/api/respuestas-internas/1/apertura', 'POST')).status, 503);
            assert.equal((await pedir()).status, 503);
            const [[cuenta]] = await pool.query('SELECT COUNT(*) AS n FROM recepciones_internas WHERE primera_apertura_utc IS NOT NULL');
            assert.equal(Number(cuenta.n), 0);
        } finally { await pool.query('ALTER TABLE recepciones_internas MODIFY actor_nombre VARCHAR(150) NULL'); }
        assert.equal((await pedir()).status, 200);
    });
    await t.test('Server-Timing no aparece en produccion y preflight sigue separado', async () => {
        const anterior = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try { assert.equal((await pedir()).headers.get('Server-Timing'), null); }
        finally {
            if (anterior === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = anterior;
        }
        const preflight = await fetch(url + ruta, { method: 'OPTIONS', headers: {
            Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET',
            'Access-Control-Request-Headers': 'authorization'
        } });
        assert.equal(preflight.status, 204);
        assert.equal(preflight.headers.get('Server-Timing'), null);
    });
    await t.test('GET caliente reduce mediana al menos 50% contra baseline comparable', async () => {
        const medir = async modo => {
            baseline = modo;
            await leer();
            const muestras = [];
            for (let i = 0; i < 20; i++) muestras.push(await leer());
            return muestras;
        };
        antes = await medir(true);
        const contador = verificaciones;
        despues = await medir(false);
        assert.equal(verificaciones, contador);
        const mediana = m => {
            const ordenadas = m.map(x => x.total).sort((a, b) => a - b);
            return (ordenadas[9] + ordenadas[10]) / 2;
        };
        assert.ok(mediana(despues) <= mediana(antes) * 0.5,
            `Medianas baseline=${mediana(antes)} optimizada=${mediana(despues)}`);
        if (process.env.RECEPCION_PERF_REPORT) await fs.writeFile(process.env.RECEPCION_PERF_REPORT,
            JSON.stringify({ baseTemporal: entorno.nombre, primera, vencida, antes, despues,
                medianaAntes: mediana(antes), medianaDespues: mediana(despues),
                reduccion: 1 - mediana(despues) / mediana(antes), muestras: 20 }, null, 2));
    });
});
