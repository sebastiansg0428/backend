const pool = require('../db');

const DEPENDENCIAS = [
    'Comisaría',
    'Inspección Urbana',
    'Inspección Rural',
    'Talento Humano',
    'Secretaría de Desarrollo Social',
    'Secretaría de Gobierno',
    'Oficina de Planeación',
    'Oficina Asesora Jurídica y Control',
    'Secretaría Financiera',
    'SEDAM',
    'Secretaría de Salud',
    'Secretaría de Educación',
    'Secretaría de Infraestructura',
    'Secretaría de Tránsito',
    'Despacho del Alcalde',
    'Oficina de Control Interno',
    'SISBEN',
    'Gestión del Riesgo',
    'Equidad de Género',
    'Víctimas',
    'Almacén Municipal',
    'Promotoría',
    'Control Disciplinario',
    'Juventudes'
];

function normalizarNombre(nombre) {
    return nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .trim().replace(/\s+/g, ' ').toLowerCase();
}

async function consolidarDependencias(connection) {
    const [referencias] = await connection.execute(
        `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
         WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = ?`,
        ['dependencias']
    );
    const permitidas = new Set(['usuarios.dependencia_id', 'radicados.dependencia_destino_id']);
    if (referencias.some(r => !permitidas.has(`${r.TABLE_NAME}.${r.COLUMN_NAME}`))) {
        throw new Error('Existen referencias adicionales a dependencias; revisalas antes de consolidar.');
    }
    const [actuales] = await connection.execute('SELECT id, nombre, activo FROM dependencias ORDER BY id FOR UPDATE');
    const catalogo = new Set(DEPENDENCIAS.map(normalizarNombre));
    const aliasPlaneacion = 'secretaria de planeacion';
    const opcionGlobal = 'todas las dependencias';
    const desconocidas = actuales.filter(d =>
        !catalogo.has(normalizarNombre(d.nombre)) &&
        ![aliasPlaneacion, opcionGlobal].includes(normalizarNombre(d.nombre)));
    if (desconocidas.length) {
        throw new Error(`Dependencias fuera del catalogo sin equivalencia definida: ${desconocidas.map(d => d.nombre).join(', ')}`);
    }
    for (const dependencia of actuales.filter(d => normalizarNombre(d.nombre) === opcionGlobal)) {
        const [usuarios] = await connection.execute('SELECT id FROM usuarios WHERE dependencia_id = ? FOR UPDATE', [dependencia.id]);
        const [radicados] = await connection.execute('SELECT numero_radicado FROM radicados WHERE dependencia_destino_id = ? FOR UPDATE', [dependencia.id]);
        if (usuarios.length || radicados.length) {
            throw new Error('"Todas las dependencias" tiene referencias; asignales una oficina antes de retirarla.');
        }
        await connection.execute('DELETE FROM dependencias WHERE id = ?', [dependencia.id]);
    }
    for (const nombre of DEPENDENCIAS) {
        const clave = normalizarNombre(nombre);
        const candidatas = actuales.filter(d => normalizarNombre(d.nombre) === clave ||
            (clave === 'oficina de planeacion' && normalizarNombre(d.nombre) === aliasPlaneacion));
        const principal = candidatas.find(d => normalizarNombre(d.nombre) === clave) || candidatas[0];
        if (!principal) {
            await connection.execute('INSERT INTO dependencias (nombre, activo) VALUES (?, 1)', [nombre]);
            continue;
        }
        for (const duplicada of candidatas.filter(d => d.id !== principal.id)) {
            await connection.execute(
                `INSERT INTO historial_radicado
                    (numero_radicado, campo_modificado, valor_anterior, valor_nuevo, usuario, motivo)
                 SELECT numero_radicado, 'dependencia_destino_id', ?, ?, 'migracion_009',
                        'Consolidacion del catalogo de dependencias; se conserva el nombre historico'
                 FROM radicados WHERE dependencia_destino_id = ?`,
                [String(duplicada.id), String(principal.id), duplicada.id]
            );
            await connection.execute('UPDATE radicados SET dependencia_destino_id = ? WHERE dependencia_destino_id = ?', [principal.id, duplicada.id]);
            await connection.execute('UPDATE usuarios SET dependencia_id = ? WHERE dependencia_id = ?', [principal.id, duplicada.id]);
            await connection.execute('DELETE FROM dependencias WHERE id = ?', [duplicada.id]);
        }
        await connection.execute('UPDATE dependencias SET nombre = ?, activo = 1 WHERE id = ?', [nombre, principal.id]);
    }
    const [resultado] = await connection.execute('SELECT id, nombre, activo FROM dependencias ORDER BY nombre');
    if (resultado.length !== DEPENDENCIAS.length ||
        DEPENDENCIAS.some(nombre => resultado.filter(d => d.nombre === nombre && d.activo === 1).length !== 1)) {
        throw new Error('El catalogo resultante no coincide con las 24 dependencias aprobadas.');
    }
    return resultado;
}

async function actualizarDependencias() {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const resultado = await consolidarDependencias(connection);
        await connection.commit();
        console.log(`Catalogo consolidado: ${resultado.length} dependencias activas.`);
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

if (require.main === module) {
    actualizarDependencias()
        .catch(error => {
            console.error('No se pudo consolidar el catalogo:', error);
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}

module.exports = { consolidarDependencias, DEPENDENCIAS };
