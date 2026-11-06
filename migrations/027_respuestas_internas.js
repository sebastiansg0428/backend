const { migrarIntegridad } = require('./024_integridad_referencial');

const ELEGIBLES = `FROM respuestas_radicado rr JOIN radicados r ON r.numero_radicado=rr.numero_radicado
    WHERE LOWER(TRIM(r.tipo_comunicacion))='interna' AND r.destino_todas_dependencias=0
    AND COALESCE(r.requiere_respuesta,1)<>0 AND rr.radicado_dependencia_id IS NULL`;
const COLUMNAS = [
    ['id', /^bigint(?:\(\d+\))? unsigned$/, 'NO', 'auto_increment'],
    ['respuesta_id', /^int(?:\(\d+\))?$/, 'NO', ''],
    ['dependencia_origen_id', /^int(?:\(\d+\))?$/, 'NO', ''],
    ['historica', /^tinyint(?:\(1\))?$/, 'NO', ''],
    ['disponible_en_utc', /^datetime\(6\)$/, 'YES', ''],
    ['primera_apertura_utc', /^datetime\(6\)$/, 'YES', ''],
    ['actor_id', /^int(?:\(\d+\))?$/, 'YES', ''],
    ['actor_nombre', /^varchar\(150\)$/, 'YES', ''],
];
async function verificar(c) {
    const [tablas] = await c.query(`SELECT ENGINE,TABLE_COLLATION FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='recepciones_internas'`);
    if (!tablas.length) return false;
    if (tablas[0].ENGINE !== 'InnoDB' || tablas[0].TABLE_COLLATION !== 'utf8mb4_unicode_ci') throw new Error('027: tabla incompatible.');
    const [columnas] = await c.query(`SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='recepciones_internas' ORDER BY ORDINAL_POSITION`);
    if (columnas.length !== COLUMNAS.length || COLUMNAS.some(([nombre, tipo, nullable, extra], i) =>
        columnas[i].COLUMN_NAME !== nombre || !tipo.test(columnas[i].COLUMN_TYPE) ||
        columnas[i].IS_NULLABLE !== nullable || columnas[i].EXTRA !== extra)) throw new Error('027: columnas incompatibles.');
    const [indices] = await c.query(`SELECT INDEX_NAME,NON_UNIQUE,COLUMN_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='recepciones_internas' ORDER BY INDEX_NAME,SEQ_IN_INDEX`);
    for (const [nombre, unico, campos] of [
        ['PRIMARY', 0, ['id']], ['uq_recepcion_respuesta', 0, ['respuesta_id']],
        ['idx_recepcion_origen', 1, ['dependencia_origen_id', 'id']],
    ]) {
        const filas = indices.filter(i => i.INDEX_NAME === nombre);
        if (filas.length !== campos.length || filas.some((f, i) => Number(f.NON_UNIQUE) !== unico || f.COLUMN_NAME !== campos[i])) throw new Error('027: indice incompatible.');
    }
    const [fk] = await c.query(`SELECT k.COLUMN_NAME,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,
        k.REFERENCED_TABLE_SCHEMA,r.UPDATE_RULE,r.DELETE_RULE,DATABASE() AS base
        FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
        ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA=DATABASE() AND k.TABLE_NAME='recepciones_internas' AND k.REFERENCED_TABLE_NAME IS NOT NULL`);
    if (fk.length !== 3 || [['respuesta_id', 'respuestas_radicado'], ['dependencia_origen_id', 'dependencias'], ['actor_id', 'usuarios']]
        .some(([campo, padre]) => !fk.some(f => f.COLUMN_NAME === campo && f.REFERENCED_TABLE_NAME === padre &&
            f.REFERENCED_COLUMN_NAME === 'id' && f.REFERENCED_TABLE_SCHEMA === f.base &&
            f.UPDATE_RULE === 'RESTRICT' && f.DELETE_RULE === 'RESTRICT'))) throw new Error('027: FK incompatibles.');
    return true;
}
async function migrarRespuestasInternas(c, { aplicar = false } = {}) {
    if (typeof aplicar !== 'boolean') throw new TypeError('aplicar debe ser booleano.');
    if ((await migrarIntegridad(c)).estado !== 'aplicada') throw new Error('Verificar 024 antes de 027.');
    const [[invalidas]] = await c.query(`SELECT COUNT(*) AS n ${ELEGIBLES}
        AND NOT EXISTS (SELECT 1 FROM dependencias d WHERE d.id=r.dependencia_remitente_id)`);
    if (Number(invalidas.n)) throw new Error(`027: ${invalidas.n} respuestas internas sin origen valido; corregir antes de continuar.`);
    let existe = await verificar(c);
    if (!existe && aplicar) {
        await c.query(`CREATE TABLE recepciones_internas (
            id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            respuesta_id INT NOT NULL,
            dependencia_origen_id INT NOT NULL,
            historica TINYINT(1) NOT NULL,
            disponible_en_utc DATETIME(6) NULL,
            primera_apertura_utc DATETIME(6) NULL,
            actor_id INT NULL,
            actor_nombre VARCHAR(150) NULL,
            UNIQUE KEY uq_recepcion_respuesta(respuesta_id),
            INDEX idx_recepcion_origen(dependencia_origen_id,id),
            CONSTRAINT fk_recepcion_respuesta FOREIGN KEY(respuesta_id) REFERENCES respuestas_radicado(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            CONSTRAINT fk_recepcion_origen FOREIGN KEY(dependencia_origen_id) REFERENCES dependencias(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
            CONSTRAINT fk_recepcion_actor FOREIGN KEY(actor_id) REFERENCES usuarios(id) ON UPDATE RESTRICT ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        existe = true;
    }
    const [[faltantes]] = await c.query(`SELECT COUNT(*) AS n ${ELEGIBLES} ${existe
        ? 'AND NOT EXISTS (SELECT 1 FROM recepciones_internas ri WHERE ri.respuesta_id=rr.id)' : ''}`);
    if (existe) {
        const [[incompatibles]] = await c.query(`SELECT COUNT(*) AS n FROM recepciones_internas ri
            JOIN respuestas_radicado rr ON rr.id=ri.respuesta_id
            JOIN radicados r ON r.numero_radicado=rr.numero_radicado
            WHERE LOWER(TRIM(r.tipo_comunicacion))<>'interna' OR r.destino_todas_dependencias<>0
            OR COALESCE(r.requiere_respuesta,1)=0 OR rr.radicado_dependencia_id IS NOT NULL
            OR NOT (ri.dependencia_origen_id <=> r.dependencia_remitente_id)
            OR ri.historica NOT IN (0,1)
            OR (ri.historica=0 AND ri.disponible_en_utc IS NULL)
            OR (ri.historica=1 AND ri.disponible_en_utc IS NOT NULL)
            OR (ri.primera_apertura_utc IS NULL AND (ri.actor_id IS NOT NULL OR ri.actor_nombre IS NOT NULL))
            OR (ri.primera_apertura_utc IS NOT NULL AND (ri.actor_id IS NULL OR ri.actor_nombre IS NULL))`);
        if (Number(incompatibles.n)) throw new Error('027: recepciones existentes incompatibles; inspeccionar sin reescribir historicos.');
    }
    if (existe && aplicar) {
        await c.query(`INSERT INTO recepciones_internas(respuesta_id,dependencia_origen_id,historica)
            SELECT rr.id,r.dependencia_remitente_id,1 ${ELEGIBLES}
            AND NOT EXISTS (SELECT 1 FROM recepciones_internas ri WHERE ri.respuesta_id=rr.id)`);
        await verificar(c);
    }
    return { estado: existe && (aplicar || !Number(faltantes.n)) ? 'aplicada' : 'pendiente',
        historicas_pendientes: aplicar ? 0 : Number(faltantes.n) };
}
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--verificar', '--aplicar'].includes(args[0])) {
        console.error('Uso: node migrations\\027_respuestas_internas.js --verificar|--aplicar'); process.exitCode = 1;
    } else {
        const pool = require('../db');
        (async () => {
            const c = await pool.getConnection();
            try { console.log(await migrarRespuestasInternas(c, { aplicar: args[0] === '--aplicar' })); }
            finally { c.release(); await pool.end(); }
        })().catch(e => { console.error(e.message); process.exitCode = 1; });
    }
}
async function verificarCobertura(c, excluirRespuesta = null) {
    const [[faltantes]] = await c.query(`SELECT COUNT(*) AS n ${ELEGIBLES}
        AND (? IS NULL OR rr.id<>?)
        AND NOT EXISTS (SELECT 1 FROM recepciones_internas ri WHERE ri.respuesta_id=rr.id)`,
    [excluirRespuesta, excluirRespuesta]);
    if (Number(faltantes.n)) throw new Error('027 incompleta: faltan recepciones historicas; verificar y completar la migracion.');
}
module.exports = { verificar, verificarCobertura, migrarRespuestasInternas };
