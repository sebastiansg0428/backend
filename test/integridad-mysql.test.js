const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { migrarIntegridad } = require('../migrations/024_integridad_referencial');

test('024 MySQL: integridad, unicidad, compatibilidad y DDL aislado', {
    skip: process.env.TEST_INTEGRIDAD_MYSQL !== '1',
}, async t => {
    const mysql = require('mysql2/promise');
    const admin = await mysql.createConnection({
        host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '', dateStrings: true,
    });
    t.after(() => admin.end());
    const source = process.env.INTEGRIDAD_SCHEMA_DB || 'ventanilla_unica';
    assert.ok(['ventanilla_unica', 'ventanilla_unica_test'].includes(source));
    const [tablas] = await admin.execute(
        "SELECT TABLE_NAME AS nombre FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [source]);
    const estructura = [];
    for (const { nombre } of tablas) {
        assert.match(nombre, /^[a-zA-Z0-9_]+$/);
        const [ddl] = await admin.query(`SHOW CREATE TABLE \`${source}\`.\`${nombre}\``);
        estructura.push(ddl[0]['Create Table']);
    }

    for (const variante of ['historica', 'varchar100']) {
        await t.test(variante, async caso => {
            const base = `ventanilla_integridad_${randomBytes(6).toString('hex')}`;
            assert.match(base, /^ventanilla_integridad_[a-f0-9]{12}$/);
            await admin.query(`CREATE DATABASE \`${base}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
            caso.after(() => admin.query(`DROP DATABASE \`${base}\``));
            await admin.query(`USE \`${base}\``);
            // Solo al copiar DDL vacio; la migracion nunca desactiva las FK.
            await admin.query('SET FOREIGN_KEY_CHECKS=0');
            try {
                for (const ddl of estructura) {
                    await admin.query(variante === 'varchar100'
                        ? ddl.replace(/(`numero_radicado`\s+)varchar\(50\)/gi, '$1varchar(100)') : ddl);
                }
            } finally { await admin.query('SET FOREIGN_KEY_CHECKS=1'); }
            const [columnas] = await admin.query(
                'SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION');
            const snapshot = async () => {
                const resultado = {};
                for (const { nombre } of tablas) {
                    const campos = columnas.filter(c => c.TABLE_NAME === nombre).map(c => `\`${c.COLUMN_NAME}\``).join(',');
                    const [rows] = await admin.query(`SELECT ${campos} FROM \`${nombre}\``);
                    resultado[nombre] = rows.map(r => JSON.stringify(r)).sort();
                }
                return resultado;
            };
            const ddlActual = async () => {
                const resultado = [];
                for (const { nombre } of tablas) {
                    const [rows] = await admin.query(`SHOW CREATE TABLE \`${nombre}\``);
                    resultado.push(rows[0]['Create Table']);
                }
                return resultado;
            };
            const [marcador] = await admin.query(
                "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='numero_individual_unico'");
            const yaAplicada = Number(marcador[0].n) > 0;
            await admin.query("INSERT INTO dependencias(id,nombre,activo) VALUES (9101,'Oficina ficticia A',1),(9102,'Oficina ficticia B',1)");
            await admin.query(`INSERT INTO usuarios(id,nombre,email,password,rol,dependencia_id,activo) VALUES
                (9101,'Actor ficticio','actor-integridad@example.test','no-utilizable','funcionario',9101,1)`);
            await admin.query(`INSERT INTO tipos_tramite(id,codigo,nombre,categoria_general,requiere_respuesta)
                VALUES (9101,'fixture024','Tramite ficticio','peticion_general',1),(9102,'fixture024b','Otro ficticio','consulta',1)`);
            await admin.query(`INSERT INTO terminos_legales(id,tipo_tramite_id,dias,tipo_dias,fundamento_legal,vigente_desde)
                VALUES (9101,9101,15,'habiles','Norma ficticia','2000-01-01')`);
            async function radicar(numero, global = false) {
                await admin.query(`INSERT INTO radicados(numero_radicado,tipo_comunicacion,remitente_nombre,
                    remitente_documento,remitente_telefono,dependencia_destino_id,asunto_documento,
                    fecha_hora_recepcion,destino_todas_dependencias)
                    VALUES (?,'Externa','Persona ficticia','000','000',9101,'Prueba ficticia','2026-01-01 09:00:00',?)`,
                [numero, Number(global)]);
            }
            for (const numero of ['FIX-024-A', 'FIX-024-B', 'FIX-024-GLOBAL', 'FIX-024-INFO', 'FIX-024-CARRERA']) {
                await radicar(numero, numero.includes('GLOBAL'));
            }
            await admin.query(`INSERT INTO radicado_dependencias(id,numero_radicado,dependencia_id)
                VALUES (9101,'FIX-024-GLOBAL',9101),(9102,'FIX-024-GLOBAL',9102)`);
            await admin.query(`INSERT INTO radicado_terminos(numero_radicado,tipo_tramite_id,termino_legal_id,fecha_recepcion,
                termino_dias_aplicado,tipo_dias_aplicado,fundamento_legal_aplicado,fecha_limite_inicial,fecha_limite_actual)
                VALUES ('FIX-024-A',9101,9101,'2026-01-01',15,'habiles','Norma ficticia','2026-01-23','2026-01-23'),
                ('FIX-024-INFO',9101,NULL,'2026-01-01',NULL,NULL,NULL,NULL,NULL)`);
            await admin.query(`INSERT INTO ampliaciones_termino(id,numero_radicado,fecha_limite_anterior,fecha_limite_nueva,motivo,fundamento_legal)
                VALUES (9101,'FIX-024-A','2026-01-23','2026-02-01','Motivo ficticio','Norma ficticia')`);
            await admin.query(`INSERT INTO historial_radicado(id,numero_radicado,campo_modificado,actor_id,actor_name,dependencia_id,dependencia_nombre,radicado_dependencia_id)
                VALUES (9101,'FIX-024-GLOBAL','fixture',9101,'Nombre historico',9101,'Oficina historica',9101),
                (9102,'FIX-024-A','legado',NULL,NULL,NULL,NULL,NULL)`);
            await admin.query(`INSERT INTO intentos_radicacion(actor_id,clave,huella,numero_radicado,respuesta_json)
                VALUES (9101,'00000000-0000-4000-8000-000000000001',REPEAT('a',64),'FIX-024-A','{"success":true,"radicado":"FIX-024-A"}'),
                (9101,'00000000-0000-4000-8000-000000000002',REPEAT('b',64),NULL,NULL)`);
            await admin.query(`INSERT INTO respuestas_radicado(id,numero_radicado,radicado_dependencia_id,contenido,usuario_id)
                VALUES (9101,'FIX-024-A',NULL,'Contenido ficticio',9101),
                (9102,'FIX-024-GLOBAL',9101,'Respuesta A',9101),(9103,'FIX-024-GLOBAL',9102,'Respuesta B',9101)`);
            const casosInvalidos = [
                ["UPDATE radicado_terminos SET numero_radicado='INEXISTENTE' WHERE numero_radicado='FIX-024-A'",
                    "UPDATE radicado_terminos SET numero_radicado='FIX-024-A' WHERE numero_radicado='INEXISTENTE'"],
                ["UPDATE ampliaciones_termino SET numero_radicado='INEXISTENTE' WHERE id=9101",
                    "UPDATE ampliaciones_termino SET numero_radicado='FIX-024-A' WHERE id=9101"],
                ["UPDATE historial_radicado SET numero_radicado='INEXISTENTE' WHERE id=9102",
                    "UPDATE historial_radicado SET numero_radicado='FIX-024-A' WHERE id=9102"],
                ["UPDATE historial_radicado SET actor_id=999999 WHERE id=9101", "UPDATE historial_radicado SET actor_id=9101 WHERE id=9101"],
                ["UPDATE historial_radicado SET dependencia_id=999999 WHERE id=9101", "UPDATE historial_radicado SET dependencia_id=9101 WHERE id=9101"],
                ["UPDATE historial_radicado SET radicado_dependencia_id=999999 WHERE id=9101", "UPDATE historial_radicado SET radicado_dependencia_id=9101 WHERE id=9101"],
                ["UPDATE historial_radicado SET numero_radicado='FIX-024-B' WHERE id=9101", "UPDATE historial_radicado SET numero_radicado='FIX-024-GLOBAL' WHERE id=9101"],
                ["UPDATE intentos_radicacion SET actor_id=999999 WHERE actor_id=9101", "UPDATE intentos_radicacion SET actor_id=9101 WHERE actor_id=999999"],
                ["UPDATE intentos_radicacion SET numero_radicado='INEXISTENTE' WHERE numero_radicado='FIX-024-A'",
                    "UPDATE intentos_radicacion SET numero_radicado='FIX-024-A' WHERE numero_radicado='INEXISTENTE'"],
                ["UPDATE respuestas_radicado SET numero_radicado='FIX-024-B' WHERE id=9102", "UPDATE respuestas_radicado SET numero_radicado='FIX-024-GLOBAL' WHERE id=9102"],
                ["UPDATE radicado_terminos SET tipo_tramite_id=9102 WHERE numero_radicado='FIX-024-A'",
                    "UPDATE radicado_terminos SET tipo_tramite_id=9101 WHERE numero_radicado='FIX-024-A'"],
                ["INSERT INTO respuestas_radicado(id,numero_radicado,contenido,usuario_id) VALUES (9199,'FIX-024-A','Duplicada',9101)",
                    'DELETE FROM respuestas_radicado WHERE id=9199'],
            ];
            if (!yaAplicada) {
                await caso.test('cada incompatibilidad aborta antes del primer DDL', async () => {
                    for (const [invalidar, restaurar] of casosInvalidos) {
                        await admin.query(invalidar);
                        const antes = await ddlActual();
                        await assert.rejects(migrarIntegridad(admin, { aplicar: true }), /Datos incompatibles/);
                        assert.deepEqual(await ddlActual(), antes);
                        await admin.query(restaurar);
                    }
                });
                await caso.test('fallo DDL parcial exige inspeccion y no se oculta', async () => {
                    let alters = 0;
                    const conexionConFallo = {
                        query(sql) {
                            if (sql.startsWith('ALTER') && ++alters === 2) throw new Error('Segundo ALTER interrumpido fixture');
                            return admin.query(sql);
                        },
                    };
                    await assert.rejects(migrarIntegridad(conexionConFallo, { aplicar: true }), error =>
                        /tras 1 ALTER/.test(error.message) && /Segundo ALTER/.test(error.cause.message));
                    const nueva = await mysql.createConnection({
                        host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root',
                        password: process.env.DB_PASSWORD || '', database: base,
                    });
                    try {
                        await assert.rejects(migrarIntegridad(nueva), /024 parcial/);
                    } finally { await nueva.end(); }
                    // Solo limpieza del indice creado por este fallo ficticio controlado.
                    await admin.query('ALTER TABLE radicado_dependencias DROP INDEX uq_024_asignacion_numero');
                });
            }
            await caso.test('verificacion de solo lectura y migracion conservan filas', async () => {
                const antes = await snapshot();
                const ddlAntes = await ddlActual();
                const verificacion = await migrarIntegridad(admin);
                assert.equal(verificacion.estado, yaAplicada ? 'aplicada' : 'pendiente');
                assert.deepEqual(await ddlActual(), ddlAntes);
                assert.deepEqual(await migrarIntegridad(admin, { aplicar: true }),
                    { estado: 'aplicada', cambios: yaAplicada ? 0 : 7, aplicada: true });
                assert.deepEqual(await snapshot(), antes);
                assert.deepEqual(await migrarIntegridad(admin, { aplicar: true }),
                    { estado: 'aplicada', cambios: 0, aplicada: true });
            });
            await caso.test('el motor rechaza todos los casos incompatibles', async () => {
                for (const [invalidar] of casosInvalidos) {
                    await assert.rejects(admin.query(invalidar), error =>
                        ['ER_NO_REFERENCED_ROW_2', 'ER_DUP_ENTRY'].includes(error.code));
                }
                for (const sql of [
                    'DELETE FROM usuarios WHERE id=9101', 'DELETE FROM dependencias WHERE id=9101',
                    "DELETE FROM radicados WHERE numero_radicado='FIX-024-A'",
                    'DELETE FROM radicado_dependencias WHERE id=9101', 'DELETE FROM terminos_legales WHERE id=9101',
                ]) await assert.rejects(admin.query(sql), { code: 'ER_ROW_IS_REFERENCED_2' });
                await admin.query('UPDATE usuarios SET activo=0 WHERE id=9101');
                await admin.query('UPDATE dependencias SET activo=0 WHERE id=9101');
                const [[historia]] = await admin.query('SELECT actor_name,dependencia_nombre FROM historial_radicado WHERE id=9101');
                assert.deepEqual(historia, { actor_name: 'Nombre historico', dependencia_nombre: 'Oficina historica' });
            });
            await caso.test('dos inserciones concurrentes individuales: una aceptada', async () => {
                const configuracion = { host: process.env.DB_HOST || 'localhost', user: process.env.DB_USER || 'root',
                    password: process.env.DB_PASSWORD || '', database: base };
                const a = await mysql.createConnection(configuracion);
                const b = await mysql.createConnection(configuracion);
                try {
                    const sql = "INSERT INTO respuestas_radicado(numero_radicado,contenido,usuario_id) VALUES ('FIX-024-CARRERA','Carrera ficticia',9101)";
                    const resultados = await Promise.allSettled([a.query(sql), b.query(sql)]);
                    assert.equal(resultados.filter(r => r.status === 'fulfilled').length, 1);
                    assert.equal(resultados.find(r => r.status === 'rejected').reason.code, 'ER_DUP_ENTRY');
                    assert.equal((await migrarIntegridad(a)).estado, 'aplicada');
                } finally { await a.end(); await b.end(); }
            });
        });
    }
});
