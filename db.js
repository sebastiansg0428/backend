const mysql = require('mysql2/promise');

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',      // Cambia esto si tu usuario de MySQL es diferente
    password: '',      // Pon tu contraseña de MySQL si tienes una
    database: 'ventanilla_unica',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

console.log('📦 Conectado exitosamente a la base de datos MySQL');

module.exports = pool;