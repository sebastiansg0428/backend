const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pool = require('../db');
const app = require('../server');
const { crearSesion, revocarSesiones } = require('../auth');

test('administrador gestiona catalogos con baja logica y conserva permisos, referencias y terminos', async t => {
    const usuarios = [
        { id: 61, nombre: 'Admin', rol: 'administrador', dependencia_id: null, activo: 1 },
        { id: 62, nombre: 'Ventanilla', rol: 'ventanilla', dependencia_id: null, activo: 1 },
        { id: 63, nombre: 'Funcionario', rol: 'funcionario', dependencia_id: 2, activo: 1 }
    ];
    const tokens = usuarios.map(u => crearSesion(u.id));
    t.after(() => usuarios.forEach(u => revocarSesiones(u.id)));
    let dependencias = [{ id: 2, nombre: 'Planeacion', activo: 1 }, { id: 3, nombre: 'Hacienda', activo: 0 }];
    let tipos = [{ id: 1, codigo: 'consulta', nombre: 'Consulta', categoria_general: 'consulta', orden: 4, activo: 1 }];
    let terminos = [{
        id: 1, tipo_tramite_id: 1, dias: 30, tipo_dias: 'habiles',
        fundamento_legal: 'Fundamento anterior', vigente_desde: '2000-01-01', vigente_hasta: null
    }];
    const radicado = {
        id: 1, numero_radicado: 'RAD-HIST', dependencia_destino_id: 2, dependencia_destino: 'Planeacion',
        tipo_documento: 'Consulta', estado: 'Respondido', termino_dias: 30, termino_tipo_dias: 'habiles',
        termino_fundamento: 'Fundamento anterior', termino_fecha_limite_actual: '2000-02-15'
    };
    const copiaRadicado = structuredClone(radicado);
    const consultas = [];
    let commits = 0;
    let rollbacks = 0;
    let falloTermino = false;
    let falloConexion = false;
    const duplicado = () => { throw Object.assign(new Error('Duplicado'), { code: 'ER_DUP_ENTRY' }); };
    const ejecutar = async (sql, valores = []) => {
        consultas.push({ sql, valores });
        if (sql.includes('FROM usuarios u')) {
            const usuario = usuarios.find(u => u.id === valores[0]);
            return [usuario ? [{ ...usuario, dependencia_nombre: dependencias.find(d => d.id === usuario.dependencia_id)?.nombre }] : []];
        }
        if (sql.startsWith('SELECT id, nombre') && sql.includes('FROM dependencias')) {
            if (sql.includes('ORDER BY nombre')) {
                assert.match(sql, /activo = 1 OR \? = 1/);
                return [dependencias.filter(d => (valores[0] === null || d.id === valores[0]) &&
                    (d.activo === 1 || valores[2] === 1))];
            }
            const porNombre = sql.includes('nombre = ?');
            return [dependencias.filter(d => (porNombre ? d.nombre === valores[0] : d.id === valores[0]) &&
                (!sql.includes('AND activo = 1') || d.activo === 1))];
        }
        if (sql.startsWith('INSERT INTO dependencias')) {
            if (dependencias.some(d => d.nombre === valores[0])) duplicado();
            const id = Math.max(...dependencias.map(d => d.id)) + 1;
            dependencias.push({ id, nombre: valores[0], activo: 1 });
            return [{ insertId: id }];
        }
        if (sql.startsWith('UPDATE dependencias')) {
            const [valor, id] = valores;
            const dependencia = dependencias.find(d => d.id === id);
            if (!dependencia) return [{ affectedRows: 0 }];
            if (sql.includes('SET nombre')) {
                if (dependencias.some(d => d.id !== id && d.nombre === valor)) duplicado();
                dependencia.nombre = valor;
            } else {
                assert.equal(sql, 'UPDATE dependencias SET activo = ? WHERE id = ?');
                dependencia.activo = valor;
            }
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('SELECT id') && sql.includes('FROM tipos_tramite')) {
            return [tipos.filter(tipo => tipo.id === valores[0] &&
                (!sql.includes('activo = TRUE') || tipo.activo === 1))];
        }
        if (sql.startsWith('INSERT INTO tipos_tramite')) {
            const [codigo, nombre, categoria_general] = valores;
            if (tipos.some(tipo => tipo.codigo === codigo || tipo.nombre === nombre)) duplicado();
            const id = Math.max(...tipos.map(tipo => tipo.id)) + 1;
            tipos.push({ id, codigo, nombre, categoria_general, orden: 0, activo: 1 });
            return [{ insertId: id }];
        }
        if (sql.startsWith('UPDATE tipos_tramite')) {
            const tipo = tipos.find(tipo => tipo.id === valores.at(-1));
            if (!tipo) return [{ affectedRows: 0 }];
            if (sql.includes('SET activo')) {
                assert.equal(sql, 'UPDATE tipos_tramite SET activo = ? WHERE id = ?');
                tipo.activo = valores[0];
            } else {
                const [codigo, nombre, categoria_general, orden] = valores;
                if (tipos.some(otro => otro.id !== tipo.id && (otro.codigo === codigo || otro.nombre === nombre))) duplicado();
                Object.assign(tipo, { codigo, nombre, categoria_general, orden: orden ?? tipo.orden });
            }
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('SELECT id FROM terminos_legales')) {
            return [terminos.filter(l => l.tipo_tramite_id === valores[0] && l.vigente_desde >= valores[1])];
        }
        if (sql.startsWith('UPDATE terminos_legales')) {
            assert.match(sql, /vigente_hasta = DATE_SUB/);
            const [inicio, tipoId] = valores;
            for (const termino of terminos.filter(l => l.tipo_tramite_id === tipoId && l.vigente_desde < inicio)) {
                termino.vigente_hasta = new Date(Date.parse(inicio) - 86400000).toISOString().slice(0, 10);
            }
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('INSERT INTO terminos_legales')) {
            if (falloTermino) throw new Error('Fallo de prueba al insertar termino');
            const [tipo_tramite_id, dias, tipo_dias, fundamento_legal, vigente_desde] = valores;
            const id = Math.max(...terminos.map(l => l.id)) + 1;
            terminos.push({ id, tipo_tramite_id, dias, tipo_dias, fundamento_legal, vigente_desde, vigente_hasta: null });
            return [{ insertId: id }];
        }
        if (sql.includes('FROM terminos_legales AS l')) return [terminos.filter(l => valores[0] === null || l.tipo_tramite_id === valores[0])];
        assert.fail(`SQL inesperado: ${sql}`);
    };
    t.mock.method(pool, 'execute', ejecutar);
    t.mock.method(pool, 'query', async (sql, valores) => {
        consultas.push({ sql, valores });
        if (sql.includes('FROM tipos_tramite AS t')) {
            if (sql.includes('WHERE (t.activo')) {
                assert.match(sql, /t.activo = TRUE OR \? = 1/);
                return [tipos.filter(tipo => tipo.activo === 1 || valores[2] === 1)];
            }
            assert.match(sql, /WHERE t.activo = TRUE/);
            return [tipos.filter(tipo => tipo.activo === 1 && tipo.id === valores[3])];
        }
        if (sql.includes('FROM radicados AS r')) {
            assert.match(sql, /r.dependencia_destino_id = \?/);
            assert.deepEqual(valores, [2]);
            return [[radicado]];
        }
        assert.fail(`SQL inesperado: ${sql}`);
    });
    t.mock.method(pool, 'getConnection', async () => {
        if (falloConexion) throw new Error('Conexion no disponible');
        let copia;
        return {
            async beginTransaction() { copia = structuredClone({ dependencias, tipos, terminos }); },
            execute: ejecutar,
            async commit() { commits++; },
            async rollback() { rollbacks++; ({ dependencias, tipos, terminos } = copia); },
            release() {}
        };
    });
    const errores = [];
    t.mock.method(console, 'error', (...args) => errores.push(args));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const url = `http://127.0.0.1:${server.address().port}/api`;
    const pedir = (ruta, rol = 0, method = 'GET', body) => fetch(url + ruta, {
        method, headers: {
            'Content-Type': 'application/json',
            ...(tokens[rol] ? { Authorization: `Bearer ${tokens[rol]}` } : {})
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const datosTipo = {
        codigo: 'nuevo_tramite', nombre: ' Nuevo tramite ', categoria_general: 'especial',
        dias: 15, tipo_dias: 'habiles', fundamento_legal: 'Fundamento de prueba', vigente_desde: '2000-01-01'
    };
    const editarTipo = { codigo: 'consulta_editada', nombre: 'Consulta editada', categoria_general: 'consulta', orden: 8 };
    for (const rol of [1, 2, 3]) {
        const antes = consultas.length;
        for (const [ruta, method, body] of [
            ['/dependencias', 'POST', { nombre: 'Nueva' }],
            ['/dependencias/2', 'GET'],
            ['/dependencias/2', 'PUT', { nombre: 'Nueva' }],
            ['/dependencias/2/estado', 'PATCH', { activo: 0 }],
            ['/tipos-tramite', 'POST', datosTipo],
            ['/tipos-tramite/1', 'GET'],
            ['/tipos-tramite/1', 'PUT', editarTipo],
            ['/tipos-tramite/1/estado', 'PATCH', { activo: 0 }],
            ['/terminos-legales', 'POST', {}]
        ]) {
            assert.equal((await pedir(ruta, rol, method, body)).status, rol === 3 ? 401 : 403);
        }
        assert.equal(consultas.slice(antes).some(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql)), false);
    }
    for (const rol of [0, 1, 2]) {
        const lista = await pedir('/dependencias', rol);
        assert.equal(lista.status, 200);
        assert.deepEqual((await lista.json()).dependencias.map(d => d.id), [2]);
        assert.equal((await pedir('/tipos-tramite', rol)).status, 200);
    }
    for (const ruta of ['/dependencias', '/tipos-tramite']) {
        for (const rol of [1, 2]) assert.equal((await pedir(`${ruta}?incluir_inactivos=1`, rol)).status, 403);
        for (const valor of ['true', '2', '1&incluir_inactivos=0']) {
            assert.equal((await pedir(`${ruta}?incluir_inactivos=${valor}`)).status, 400);
        }
    }
    const creada = await pedir('/dependencias', 0, 'POST', { nombre: ' Nueva dependencia ' });
    assert.equal(creada.status, 201);
    assert.deepEqual((await creada.json()).dependencia, { id: 4, nombre: 'Nueva dependencia', activo: 1 });
    assert.equal((await pedir('/dependencias/2', 0, 'PUT', { nombre: 'Oficina renombrada' })).status, 200);
    assert.equal((await pedir('/dependencias/2/estado', 0, 'PATCH', { activo: 0 })).status, 200);
    assert.equal((await pedir('/dependencias/2')).status, 200);
    const completa = await pedir('/dependencias?incluir_inactivos=1');
    assert.deepEqual((await completa.json()).dependencias.map(d => d.id), [2, 3, 4]);
    const funcionario = await pedir('/dependencias', 2);
    assert.deepEqual((await funcionario.json()).dependencias.map(d => d.id), [2]);
    const radicados = await pedir('/radicados', 2);
    assert.equal(radicados.status, 200);
    assert.equal((await radicados.json()).radicados[0].numero_radicado, 'RAD-HIST');
    assert.equal((await pedir('/auth/me', 2)).status, 200);
    const selectActivas = await pedir('/dependencias', 1);
    assert.deepEqual((await selectActivas.json()).dependencias.map(d => d.id), [4]);

    const nombreArchivo = `catalogo-${randomUUID()}.pdf`;
    const archivoRadicado = async campos => {
        const form = new FormData();
        form.append('archivos', new Blob(['%PDF-1.4\n%%EOF'], { type: 'application/pdf' }), nombreArchivo);
        for (const [campo, valor] of Object.entries({
            asunto_documento: 'Prueba', remitente_nombre: 'Remitente', remitente_documento: '123', ...campos
        })) form.append(campo, String(valor));
        return fetch(url + '/radicados', {
            method: 'POST', headers: { Authorization: `Bearer ${tokens[1]}` }, body: form
        });
    };
    for (const campos of [{ dependencia_destino_id: 2 }, { dependencia_destino: 'Oficina renombrada' }]) {
        assert.equal((await archivoRadicado(campos)).status, 422);
    }
    assert.equal((await pedir('/tipos-tramite', 0, 'POST', datosTipo)).status, 201);
    assert.equal(commits, 1);
    assert.equal((await pedir('/tipos-tramite/1', 0, 'PUT', editarTipo)).status, 200);
    assert.equal((await pedir('/tipos-tramite/1/estado', 0, 'PATCH', { activo: 0 })).status, 200);
    assert.equal((await pedir('/tipos-tramite/1')).status, 200);
    const tiposActivos = await pedir('/tipos-tramite', 1);
    assert.deepEqual((await tiposActivos.json()).tipos_tramite.map(tipo => tipo.id), [2]);
    const tiposTodos = await pedir('/tipos-tramite?incluir_inactivos=1');
    assert.deepEqual((await tiposTodos.json()).tipos_tramite.map(tipo => tipo.id), [1, 2]);
    assert.equal((await archivoRadicado({ dependencia_destino_id: 4, tipo_tramite_id: 1 })).status, 422);
    assert.deepEqual((await fs.readdir(path.join(__dirname, '..', 'uploads')))
        .filter(archivo => archivo.endsWith(nombreArchivo)), []);
    assert.deepEqual(radicado, copiaRadicado);
    assert.equal(terminos[0].dias, 30);
    assert.equal((await pedir('/dependencias/2/estado', 0, 'PATCH', { activo: 1 })).status, 200);
    assert.equal((await pedir('/tipos-tramite/1/estado', 0, 'PATCH', { activo: 1 })).status, 200);
    const dependenciasReactivadas = await pedir('/dependencias', 1);
    assert.deepEqual((await dependenciasReactivadas.json()).dependencias.map(d => d.id), [2, 4]);
    const tiposReactivados = await pedir('/tipos-tramite', 1);
    assert.deepEqual((await tiposReactivados.json()).tipos_tramite.map(tipo => tipo.id), [1, 2]);
    const ordenAnterior = tipos[0].orden;
    const { orden, ...editarSinOrden } = editarTipo;
    assert.equal((await pedir('/tipos-tramite/1', 0, 'PUT', editarSinOrden)).status, 200);
    assert.equal(tipos[0].orden, ordenAnterior);

    const nuevoTermino = {
        tipo_tramite_id: 1, dias: 20, tipo_dias: 'calendario',
        fundamento_legal: 'Nueva regla', vigente_desde: '2099-01-01'
    };
    assert.equal((await pedir('/terminos-legales', 0, 'POST', nuevoTermino)).status, 201);
    assert.equal(commits, 2);
    assert.equal(terminos[0].vigente_hasta, '2098-12-31');
    assert.equal(terminos.at(-1).dias, 20);
    assert.deepEqual(radicado, copiaRadicado);
    assert.equal((await pedir('/terminos-legales?tipo_tramite_id=1')).status, 200);
    assert.equal((await pedir('/terminos-legales', 0, 'POST', nuevoTermino)).status, 409);
    assert.equal((await pedir('/tipos-tramite/1/estado', 0, 'PATCH', { activo: 0 })).status, 200);
    assert.equal((await pedir('/terminos-legales', 0, 'POST', { ...nuevoTermino, vigente_desde: '2099-02-01' })).status, 404);

    for (const ruta of ['/dependencias', '/tipos-tramite']) {
        for (const id of ['0', '-1', 'abc', '1.5', '9007199254740992']) {
            assert.equal((await pedir(`${ruta}/${id}`)).status, 400);
            assert.equal((await pedir(`${ruta}/${id}`, 0, 'PUT', ruta === '/dependencias' ? { nombre: 'Prueba' } : editarTipo)).status, 400);
            assert.equal((await pedir(`${ruta}/${id}/estado`, 0, 'PATCH', { activo: 0 })).status, 400);
        }
        for (const activo of [true, '1', null, 2, -1]) {
            assert.equal((await pedir(`${ruta}/1/estado`, 0, 'PATCH', { activo })).status, 400);
        }
        assert.equal((await pedir(`${ruta}/1/estado`, 0, 'PATCH')).status, 400);
        assert.equal((await pedir(`${ruta}/999`)).status, 404);
        assert.equal((await pedir(`${ruta}/999`, 0, 'PUT', ruta === '/dependencias' ? { nombre: 'Prueba' } : editarTipo)).status, 404);
        assert.equal((await pedir(`${ruta}/999/estado`, 0, 'PATCH', { activo: 0 })).status, 404);
    }
    for (const nombre of ['', ' ', 'x'.repeat(151), 1]) {
        assert.equal((await pedir('/dependencias', 0, 'POST', { nombre })).status, 400);
        assert.equal((await pedir('/dependencias/2', 0, 'PUT', { nombre })).status, 400);
    }
    assert.equal((await pedir('/dependencias/2', 0, 'PUT', { nombre: 'Prueba', activo: 1 })).status, 400);
    assert.equal((await pedir('/dependencias', 0, 'POST')).status, 400);
    assert.equal((await pedir('/dependencias/2', 0, 'PUT')).status, 400);
    for (const cambios of [
        { codigo: 'INVALIDO' }, { nombre: 'x'.repeat(151) }, { categoria_general: 'inventada' },
        { orden: -1 }, { orden: '2' }, { dias: 10 }, { activo: 0 }, { fundamento_legal: 'Cambiar' }
    ]) assert.equal((await pedir('/tipos-tramite/1', 0, 'PUT', { ...editarTipo, ...cambios })).status, 400);
    assert.equal((await pedir('/tipos-tramite', 0, 'POST', { ...datosTipo, fundamento_legal: 'x'.repeat(501) })).status, 400);
    assert.equal((await pedir('/tipos-tramite', 0, 'POST')).status, 400);
    assert.equal((await pedir('/terminos-legales', 0, 'POST')).status, 400);
    assert.equal((await pedir('/dependencias', 0, 'POST', { nombre: 'Oficina renombrada' })).status, 409);
    assert.equal((await pedir('/dependencias/4', 0, 'PUT', { nombre: 'Oficina renombrada' })).status, 409);
    assert.equal((await pedir('/tipos-tramite', 0, 'POST', datosTipo)).status, 409);
    assert.equal((await pedir('/tipos-tramite/1', 0, 'PUT', {
        ...editarTipo, codigo: datosTipo.codigo
    })).status, 409);
    assert.equal((await pedir('/tipos-tramite/1/estado', 0, 'PATCH', { activo: 1 })).status, 200);
    const tiposAntes = structuredClone(tipos);
    const terminosAntes = structuredClone(terminos);
    falloTermino = true;
    assert.equal((await pedir('/tipos-tramite', 0, 'POST', { ...datosTipo, codigo: 'fallo', nombre: 'Fallo' })).status, 500);
    assert.deepEqual(tipos, tiposAntes);
    assert.deepEqual(terminos, terminosAntes);
    assert.equal((await pedir('/terminos-legales', 0, 'POST', {
        ...nuevoTermino, vigente_desde: '2099-02-01'
    })).status, 500);
    assert.deepEqual(terminos, terminosAntes);
    assert.deepEqual(radicado, copiaRadicado);
    falloTermino = false;
    falloConexion = true;
    assert.equal((await pedir('/tipos-tramite', 0, 'POST', { ...datosTipo, codigo: 'fallo', nombre: 'Fallo' })).status, 500);
    assert.equal((await pedir('/terminos-legales', 0, 'POST', nuevoTermino)).status, 500);
    assert.ok(rollbacks >= 4);
    assert.ok(errores.length >= 3);
    assert.equal(consultas.some(c => /DELETE|UPDATE radicado_terminos|UPDATE radicados/.test(c.sql)), false);
});
