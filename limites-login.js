const crypto = require('crypto');
const { isIP } = require('net');
const pool = require('./db');
const { revertirTrasError } = require('./transacciones');

const VENTANA_SEGUNDOS = 15 * 60;

function clavesLogin(email, ip) {
    const cuenta = email.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (!cuenta || !isIP(ip)) throw new Error('Cuenta o IP invalida para limitar el login.');
    let direccion = isIP(ip) === 6 ? new URL(`http://[${ip}]`).hostname.slice(1, -1) : ip;
    const mapeada = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(direccion);
    if (mapeada) {
        const alto = parseInt(mapeada[1], 16);
        const bajo = parseInt(mapeada[2], 16);
        direccion = [alto >> 8, alto & 255, bajo >> 8, bajo & 255].join('.');
    }
    const hash = valor => crypto.createHash('sha256').update(valor).digest('hex');
    return [
        { ambito: 'cuenta', clave: hash(cuenta), limite: 10 },
        { ambito: 'ip', clave: hash(direccion), limite: 100 }
    ];
}

async function reservarIntento(email, ip) {
    const claves = clavesLogin(email, ip);
    let connection;
    let reversionIntentada = false;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        // Todas las instancias bloquean cuenta e IP en el mismo orden.
        for (const { ambito, clave } of claves) {
            await connection.execute(
                `INSERT INTO limites_login (ambito, clave, cantidad, expira)
                 VALUES (?, ?, 0, UNIX_TIMESTAMP() + ?)
                 ON DUPLICATE KEY UPDATE clave = VALUES(clave)`,
                [ambito, clave, VENTANA_SEGUNDOS]
            );
        }
        const [rows] = await connection.execute(
            `SELECT ambito, cantidad, expira, UNIX_TIMESTAMP() AS ahora
             FROM limites_login
             WHERE (ambito = ? AND clave = ?) OR (ambito = ? AND clave = ?)
             ORDER BY ambito FOR UPDATE`,
            claves.flatMap(({ ambito, clave }) => [ambito, clave])
        );
        if (rows.length !== 2) throw new Error('No se pudieron obtener ambos contadores de login.');
        let reintentarEn = 0;
        for (const { ambito, limite } of claves) {
            const fila = rows.find(row => row.ambito === ambito);
            if (!fila) throw new Error('Falta un contador de login.');
            if (Number(fila.expira) > Number(fila.ahora) && fila.cantidad >= limite) {
                reintentarEn = Math.max(reintentarEn, Number(fila.expira) - Number(fila.ahora));
            }
        }
        if (reintentarEn > 0) {
            reversionIntentada = true;
            await connection.rollback();
            return { permitido: false, reintentarEn };
        }
        for (const { ambito, clave } of claves) {
            const fila = rows.find(row => row.ambito === ambito);
            const vencida = Number(fila.expira) <= Number(fila.ahora);
            await connection.execute(
                'UPDATE limites_login SET cantidad = ?, expira = ? WHERE ambito = ? AND clave = ?',
                [vencida ? 1 : fila.cantidad + 1,
                    vencida ? Number(fila.ahora) + VENTANA_SEGUNDOS : Number(fila.expira), ambito, clave]
            );
        }
        await connection.commit();
        return { permitido: true, reintentarEn: 0 };
    } catch (error) {
        ({ connection, error } = await revertirTrasError(connection, error, reversionIntentada));
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

module.exports = { reservarIntento, clavesLogin };
