const pool = require('../db');

async function migrar(connection) {
    const columnas = {};
    for (const tabla of ['radicados', 'tipos_tramite', 'radicado_terminos', 'radicado_dependencias']) {
        const [rows] = await connection.query(`SHOW FULL COLUMNS FROM \`${tabla}\``);
        columnas[tabla] = rows;
    }
    for (const tabla of ['radicados', 'tipos_tramite']) {
        if (columnas[tabla].some(c => c.Field === 'requiere_respuesta')) {
            throw new Error('020 ya aplicada o parcial: revisa el esquema antes de continuar.');
        }
    }
    if (['radicados', 'radicado_dependencias'].some(tabla =>
        columnas[tabla].some(c => c.Field === 'fecha_enterado'))) {
        throw new Error('020 parcial: fecha_enterado ya existe.');
    }
    const estado = columnas.radicados.find(c => c.Field === 'estado');
    if (!estado || !/^(enum\(|varchar\()/i.test(estado.Type)) {
        throw new Error('Dominio de estado incompatible.');
    }
    if (estado.Type.startsWith('enum(') && !estado.Type.includes("'Enterado'")) {
        if (estado.Default !== 'Recibido' || estado.Null !== 'NO' ||
            !/^[a-zA-Z0-9_]+$/.test(estado.Collation)) {
            throw new Error('Definicion de estado no prevista; revisar manualmente.');
        }
        await connection.query(
            `ALTER TABLE radicados MODIFY COLUMN estado ${estado.Type.slice(0, -1)},'Enterado')
             COLLATE ${estado.Collation} NOT NULL DEFAULT 'Recibido'`
        );
    }
    await connection.query(`ALTER TABLE tipos_tramite
        ADD COLUMN requiere_respuesta TINYINT NOT NULL DEFAULT 1,
        ADD CONSTRAINT chk_tipo_requiere_respuesta CHECK (requiere_respuesta IN (0,1))`);
    await connection.query(`ALTER TABLE radicados
        ADD COLUMN requiere_respuesta TINYINT NOT NULL DEFAULT 1,
        ADD COLUMN fecha_enterado DATETIME NULL,
        ADD CONSTRAINT chk_radicado_requiere_respuesta CHECK (requiere_respuesta IN (0,1))`);
    await connection.query('ALTER TABLE radicado_dependencias ADD COLUMN fecha_enterado DATETIME NULL');
    await connection.query(`ALTER TABLE radicado_terminos
        MODIFY COLUMN termino_legal_id INT NULL,
        MODIFY COLUMN termino_dias_aplicado INT NULL,
        MODIFY COLUMN tipo_dias_aplicado ENUM('habiles','calendario') NULL,
        MODIFY COLUMN fundamento_legal_aplicado VARCHAR(500) NULL,
        MODIFY COLUMN fecha_limite_inicial DATE NULL,
        MODIFY COLUMN fecha_limite_actual DATE NULL`);
    await connection.execute(
        'UPDATE tipos_tramite SET requiere_respuesta = 0 WHERE codigo = ?',
        ['informativo']
    );
}

if (require.main === module) {
    pool.getConnection().then(async connection => {
        try { await migrar(connection); console.log('Migracion 020 aplicada.'); }
        finally { connection.release(); }
    }).catch(error => {
        console.error('Error en 020; el DDL puede haber quedado aplicado parcialmente:', error);
        process.exitCode = 1;
    }).finally(() => pool.end());
}

module.exports = { migrar };
