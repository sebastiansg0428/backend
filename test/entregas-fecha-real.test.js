const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { randomUUID, createHash } = require('node:crypto');
const pool = require('../db');
const { verificar, migrarFechaRealEntrega } = require('../migrations/029_fecha_real_entrega');
const { crearRouterEntregas, validarRegistro } = require('../entregas-respuesta');

function metadata(sql, valores = [], disponible = true) {
    if (sql.includes("TABLE_NAME IN ('registros_entrega_respuesta'")) return [[{ n: 2 }]];
    if (sql.includes("TABLE_NAME IN ('entregas_confirmacion'")) return [[
        { TABLE_NAME: 'entregas_confirmacion', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_unicode_ci' },
        { TABLE_NAME: 'documentos_entrega_origen', ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_unicode_ci' },
    ]];
    if (sql.includes("TABLE_NAME='entregas_fecha_real'")) {
        if (!disponible) return [[]];
        if (sql.includes('information_schema.TABLES')) return [[{ ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_unicode_ci' }]];
        if (sql.includes('information_schema.COLUMNS')) return [[
            { COLUMN_NAME: 'registro_id', COLUMN_TYPE: 'bigint unsigned', IS_NULLABLE: 'NO', EXTRA: '' },
            { COLUMN_NAME: 'justificacion_fecha_anterior', COLUMN_TYPE: 'varchar(2000)', IS_NULLABLE: 'YES', EXTRA: '' },
        ]];
        if (sql.includes('information_schema.STATISTICS')) return [[{ COLUMN_NAME: 'registro_id' }]];
        return [[{ CONSTRAINT_NAME: 'fk_fecha_real_entrega', COLUMN_NAME: 'registro_id',
            REFERENCED_TABLE_NAME: 'registros_entrega_respuesta', REFERENCED_COLUMN_NAME: 'id',
            REFERENCED_TABLE_SCHEMA: 'fixture', base: 'fixture', UPDATE_RULE: 'RESTRICT', DELETE_RULE: 'RESTRICT' }]];
    }
    if (sql.includes("INDEX_NAME='idx_entrega_fecha'")) return [disponible
        ? ['respuesta_id', 'fecha_actuacion_utc', 'id'].map(COLUMN_NAME => ({ COLUMN_NAME, NON_UNIQUE: 1 })) : []];
    const tabla = valores[0];
    const origen = tabla === 'documentos_entrega_origen';
    const campo = origen ? 'evidencia_id' : 'registro_id';
    if (sql.includes('information_schema.COLUMNS')) return [[
        { COLUMN_NAME: campo, COLUMN_TYPE: 'bigint unsigned', IS_NULLABLE: 'NO', EXTRA: '' },
        ...(origen ? [{ COLUMN_NAME: 'origen', COLUMN_TYPE: "enum('documento_respuesta','evidencia_adicional')", IS_NULLABLE: 'NO', EXTRA: '' }] : []),
    ]];
    if (sql.includes('information_schema.STATISTICS')) return [[{ COLUMN_NAME: campo }]];
    if (sql.includes('information_schema.KEY_COLUMN_USAGE')) return [[{
        CONSTRAINT_NAME: origen ? 'fk_origen_evidencia' : 'fk_confirmacion_entrega', COLUMN_NAME: campo,
        REFERENCED_TABLE_NAME: origen ? 'evidencias_entrega' : 'registros_entrega_respuesta',
        REFERENCED_COLUMN_NAME: 'id', REFERENCED_TABLE_SCHEMA: 'fixture', base: 'fixture',
        UPDATE_RULE: 'RESTRICT', DELETE_RULE: 'RESTRICT',
    }]];
    throw new Error(`Metadata inesperada: ${sql}`);
}

test('029 verifica, detecta parcial e incompatible; aplicar es explicito y repetible sin tocar historicos', async () => {
    let disponible = false;
    const ddl = [];
    const c = { async query(sql, valores) {
        if (/^(CREATE|ALTER)/.test(sql)) {
            ddl.push(sql);
            if (ddl.length === 2) disponible = true;
            return [];
        }
        return metadata(sql, valores, disponible);
    } };
    assert.equal(await verificar(c), false);
    assert.deepEqual(await migrarFechaRealEntrega(c), { estado: 'pendiente', cambios: 2 });
    assert.equal(ddl.length, 0);
    assert.deepEqual(await migrarFechaRealEntrega(c, { aplicar: true }), { estado: 'aplicada', cambios: 2 });
    assert.deepEqual(await migrarFechaRealEntrega(c, { aplicar: true }), { estado: 'aplicada', cambios: 0 });
    assert.equal(ddl.length, 2);
    assert.equal(ddl.some(sql => /\bUPDATE\b(?! RESTRICT)|\bDELETE FROM\b|\bDROP\b/.test(sql)), false);
    for (const fallo of ['tabla', 'indice', 'columnas', 'fk']) {
        const parcial = { async query(sql, valores) {
            if ((fallo === 'tabla' && sql.includes('information_schema.TABLES')) ||
                (fallo === 'indice' && sql.includes("INDEX_NAME='idx_entrega_fecha'")) ||
                (fallo === 'columnas' && sql.includes('information_schema.COLUMNS')) ||
                (fallo === 'fk' && sql.includes('KEY_COLUMN_USAGE'))) return [[]];
            return metadata(sql, valores, true);
        } };
        await assert.rejects(() => verificar(parcial), /029/);
    }
});

test('entregas HTTP: contrato3, fecha anterior, dos fechas, replay legado, orden, permisos y activacion029', async t => {
    let disponible = true;
    let rol = 'ventanilla';
    let romperAuditoria = false;
    let referenciaEpoch = 1767618000;
    let filas = [];
    let fechas = [];
    const sqlLeido = [];
    t.mock.method(pool, 'query', async (sql, valores) => metadata(sql, valores, disponible));
    t.mock.method(pool, 'execute', async sql => {
        assert.match(sql, /SELECT r.id FROM radicados/);
        return [[{ id: 1 }]];
    });
    t.mock.method(pool, 'getConnection', async () => {
        let anteriores;
        return {
            async query() {},
            async beginTransaction() { anteriores = [structuredClone(filas), structuredClone(fechas)]; },
            async commit() {},
            async rollback() { [filas, fechas] = anteriores; },
            release() {},
            async execute(sql, v = []) {
                sqlLeido.push(sql);
                if (sql.includes('SELECT numero_radicado,tipo_comunicacion')) return [[{
                    numero_radicado: 'RAD-FIXTURE', tipo_comunicacion: 'Externa', destino_todas_dependencias: 0,
                }]];
                if (sql.includes('UNIX_TIMESTAMP(fecha_envio)')) return [[{ fecha_respuesta_epoch: referenciaEpoch }]];
                if (sql.includes('SELECT id FROM respuestas_radicado')) return [[{ id: 10 }]];
                if (sql.includes('SELECT id,respuesta_id,huella')) return [filas.filter(f => f.clave === v[1])];
                if (sql.includes('SELECT registro_id FROM entregas_confirmacion')) return [
                    filas.some(f => f.id === v[0] && f.contrato !== 1) ? [{ registro_id: v[0] }] : [],
                ];
                if (sql.includes('FROM documentos_respuesta')) return [[]];
                if (sql.includes("resultado='entrega_acreditada'")) {
                    if (sql.includes('COUNT(*)')) return [[{ total: filas.length, acreditada: 0 }]];
                    return [[]];
                }
                if (sql.includes('INSERT INTO registros_entrega_respuesta')) {
                    const id = filas.length + 1;
                    assert.equal(v.length, 11);
                    filas.push({ id, respuesta_id: v[0], canal: v[1], resultado: v[2],
                        destinatario: v[3], destino: v[4], fecha_actuacion_utc: v[5], observaciones: v[6],
                        actor_nombre: v[8], clave: v[9], huella: v[10], creado_en_utc: '2026-11-10 20:00:00.000000',
                        anulado_en_utc: null, anulador_nombre: null, motivo_anulacion: null });
                    return [{ insertId: id }];
                }
                if (sql.includes('INSERT INTO entregas_confirmacion')) return [{ affectedRows: 1 }];
                if (sql.includes('INSERT INTO entregas_fecha_real')) {
                    fechas.push({ registro_id: v[0], justificacion_fecha_anterior: v[1] }); return [{ affectedRows: 1 }];
                }
                if (sql.includes('INSERT INTO historial_radicado')) {
                    if (romperAuditoria) throw new Error('Auditoria fixture');
                    return [{ affectedRows: 1 }];
                }
                if (sql.includes('FROM entregas_fecha_real')) return [fechas.filter(f => v.includes(f.registro_id))];
                if (sql.includes('FROM evidencias_entrega')) return [[]];
                if (sql.includes('SELECT resultado FROM registros_entrega_respuesta')) return [filas.slice().sort((a, b) =>
                    b.fecha_actuacion_utc.localeCompare(a.fecha_actuacion_utc) || b.id - a.id).slice(0, 1)];
                if (sql.includes('FROM registros_entrega_respuesta')) return [
                    sql.includes('WHERE id=?') ? filas.filter(f => f.id === v[0]) : filas,
                ];
                throw new Error(`Consulta inesperada: ${sql}`);
            },
        };
    });
    const app = express();
    app.use(express.json(), (req, res, next) => {
        req.usuario = { id: 1, rol, nombre: 'Actor fixture', dependencia_id: rol === 'funcionario' ? 3 : null };
        next();
    }, crearRouterEntregas(require('node:os').tmpdir()));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/radicados/RAD-FIXTURE/entregas`;
    const datos = cambios => ({ version: '3', clave: randomUUID(), canal: 'presencial', resultado: 'enviado',
        destinatario: 'Persona fixture', destino: 'Sede fixture', observaciones: '',
        fecha_actuacion: '2026-01-06T10:00:00', documentos_respuesta: '[]', justificacion_fecha_anterior: '', ...cambios });
    const post = body => {
        const form = new FormData();
        Object.entries(body).forEach(([k, v]) => form.append(k, v));
        return fetch(base, { method: 'POST', body: form });
    };
    const normal = datos();
    for (const invalida of [null, undefined, 'no-es-fecha', 0]) {
        referenciaEpoch = invalida;
        assert.equal((await fetch(`${base}/documentos-respuesta`)).status, 409);
        assert.equal((await post(datos())).status, 409);
        assert.equal(filas.length, 0);
    }
    referenciaEpoch = 1767618000;
    const catalogo = await (await fetch(`${base}/documentos-respuesta`)).json();
    assert.equal(catalogo.fecha_respuesta_epoch, referenciaEpoch);
    let response = await post(normal);
    assert.equal(response.status, 201, await response.clone().text());
    const registro = (await response.json()).registro;
    assert.equal(registro.fecha_actuacion_utc, '2026-01-06 15:00:00.000');
    assert.notEqual(registro.fecha_actuacion_utc, registro.creado_en_utc);
    assert.equal(registro.fecha_real_declarada, true);
    response = await post(normal);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).registro, registro);
    assert.equal((await post({ ...normal, fecha_actuacion: '2026-01-06T11:00:00' })).status, 409);
    const anterior = datos({ fecha_actuacion: '2026-01-01T10:00:00' });
    assert.equal((await post(anterior)).status, 400);
    assert.equal(filas.length, 1);
    anterior.justificacion_fecha_anterior = 'La respuesta se registro posteriormente.';
    response = await post(anterior);
    assert.equal(response.status, 201);
    assert.equal((await response.json()).registro.justificacion_fecha_anterior, anterior.justificacion_fecha_anterior);
    assert.equal((await post(datos({ resultado: 'entrega_acreditada' }))).status, 400);
    const legado2 = { ...datos({ version: '2' }) };
    delete legado2.fecha_actuacion; delete legado2.justificacion_fecha_anterior;
    assert.equal((await post(legado2)).status, 409);
    for (const legado of [legado2, { ...legado2, clave: randomUUID(), fecha_actuacion: '2026-01-05T10:00' }]) {
        if (legado.fecha_actuacion) { delete legado.version; delete legado.documentos_respuesta; }
        const validado = validarRegistro(legado);
        filas.push({ ...registro, id: filas.length + 1, clave: legado.clave, contrato: validado.version || 1,
            huella: createHash('sha256').update(JSON.stringify({ numero: 'RAD-FIXTURE', ...validado, archivos: [] })).digest('hex') });
        response = await post(legado);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).registro.fecha_real_declarada, false);
    }
    const historia = await (await fetch(base)).json();
    assert.equal(historia.fecha_real_disponible, true);
    assert.equal(historia.resumen, 'enviado');
    assert.ok(sqlLeido.filter(s => s.includes('ORDER BY fecha_actuacion_utc DESC,id DESC')).length >= 2);
    rol = 'funcionario';
    assert.equal((await post(datos())).status, 403);
    assert.equal((await fetch(base)).status, 200);
    rol = 'administrador'; romperAuditoria = true;
    const cantidad = filas.length;
    t.mock.method(console, 'error', () => {});
    assert.equal((await post(datos())).status, 500);
    assert.equal(filas.length, cantidad);
    romperAuditoria = false; disponible = false;
    assert.equal((await post(datos())).status, 503);
    response = await fetch(base);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).fecha_real_disponible, false);
});
