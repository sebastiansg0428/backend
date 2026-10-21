const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const directorio = path.join(__dirname, '..', 'migrations');

test('el esquema base y los ALTER de radicados cubren el contrato actual sin conectar a MySQL', async () => {
    const base = await fs.readFile(path.join(directorio, '000_base_radicados.sql'), 'utf8');
    assert.match(base, /CREATE TABLE radicados\s*\(/);
    assert.doesNotMatch(base, /\b(?:DROP|TRUNCATE|INSERT|CREATE DATABASE)\b/i);
    assert.match(base, /numero_radicado VARCHAR\(100\) NOT NULL UNIQUE/);
    assert.match(base, /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci/);
    assert.match(base, /estado VARCHAR\(30\) NOT NULL DEFAULT 'Recibido'/);
    assert.match(base, /fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    const columnas = new Set([...base.matchAll(/^\s+(\w+)\s+(?:INT|VARCHAR|TEXT|DATETIME)\b/gm)]
        .map(([, columna]) => columna));
    for (const archivo of (await fs.readdir(directorio)).filter(nombre => /^\d{3}_.*\.sql$/.test(nombre)).sort()) {
        if (archivo.startsWith('000_')) continue;
        const sql = await fs.readFile(path.join(directorio, archivo), 'utf8');
        for (const [, cambios] of sql.matchAll(/ALTER TABLE radicados\b([\s\S]*?);/gi)) {
            for (const [, operacion, columna] of cambios.matchAll(/\b(ADD|DROP|MODIFY) COLUMN\s+(\w+)/gi)) {
                if (operacion.toUpperCase() === 'ADD') {
                    assert.equal(columnas.has(columna), false, `${archivo}: columna duplicada ${columna}`);
                    columnas.add(columna);
                } else {
                    assert.equal(columnas.has(columna), true, `${archivo}: falta columna ${columna}`);
                    if (operacion.toUpperCase() === 'DROP') columnas.delete(columna);
                }
            }
        }
        for (const [, columna] of sql.matchAll(/REFERENCES radicados\s*\((\w+)\)/gi)) {
            assert.equal(columnas.has(columna), true, `${archivo}: referencia a ${columna} inexistente`);
        }
    }
    const migracion020 = await fs.readFile(path.join(directorio, '020_informativos_sin_respuesta.js'), 'utf8');
    assert.match(migracion020, /ADD COLUMN requiere_respuesta TINYINT NOT NULL DEFAULT 1/);
    assert.match(migracion020, /ADD COLUMN fecha_enterado DATETIME NULL/);
    columnas.add('requiere_respuesta');
    columnas.add('fecha_enterado');
    const server = await fs.readFile(path.join(__dirname, '..', 'server.js'), 'utf8');
    const inserciones = [...server.matchAll(/INSERT INTO radicados\s*\(([^)]+)\)/g)];
    assert.ok(inserciones.length > 0);
    for (const [, campos] of inserciones) {
        for (const campo of campos.split(',').map(valor => valor.trim())) {
            assert.equal(columnas.has(campo), true, `INSERT actual usa columna inexistente: ${campo}`);
        }
    }
    for (const retirada of ['nombre_archivo_original', 'ruta_archivo', 'numero_copias', 'declara_firma', 'tipo_movimiento']) {
        assert.equal(columnas.has(retirada), false, `La columna retirada ${retirada} sigue presente`);
    }
    for (const actual of ['dependencia_destino_id', 'fecha_hora_recepcion', 'destino_todas_dependencias',
        'dependencia_remitente_id', 'dependencia_remitente', 'remitente_tipo_persona']) {
        assert.equal(columnas.has(actual), true);
    }
    const procedencia = await fs.readFile(path.join(directorio, '019_procedencia_radicados.sql'), 'utf8');
    assert.match(procedencia, /dependencia_remitente_id INT NULL/);
    assert.match(procedencia, /dependencia_remitente VARCHAR\(150\) NULL/);
    assert.match(procedencia, /remitente_tipo_persona VARCHAR\(10\) NULL/);
    assert.match(procedencia, /FOREIGN KEY \(dependencia_remitente_id\) REFERENCES dependencias\(id\)/);
    assert.doesNotMatch(procedencia, /\b(?:UPDATE|DELETE|INSERT|CASCADE)\b/i);
});
