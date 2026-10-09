const pool = require('../db');
const { hashPassword, datosUsuario } = require('../auth');

async function crearAdministrador() {
    const usuario = datosUsuario({
        nombre: process.env.ADMIN_NOMBRE,
        email: process.env.ADMIN_EMAIL,
        rol: 'administrador',
        dependencia_id: null
    });
    const password = process.env.ADMIN_PASSWORD;
    if (!usuario || typeof password !== 'string' || password.length < 10 || password.length > 128) {
        throw new Error('Configura ADMIN_NOMBRE, ADMIN_EMAIL y ADMIN_PASSWORD (10 a 128 caracteres).');
    }
    const [existentes] = await pool.query("SELECT id FROM usuarios WHERE rol = 'administrador' LIMIT 1");
    if (existentes.length) {
        throw new Error('Ya existe un administrador. Usa la gestion de usuarios autenticada.');
    }
    await pool.execute(
        'INSERT INTO usuarios (nombre, email, password, rol, dependencia_id) VALUES (?, ?, ?, ?, NULL)',
        [usuario.nombre, usuario.email, await hashPassword(password), 'administrador']
    );
    console.log('Primer administrador creado. No se muestra ni se guarda la clave en texto plano.');
}

if (require.main === module) {
    crearAdministrador()
        .catch(error => {
            console.error('No se pudo crear el administrador:', error.message);
            process.exitCode = 1;
        })
        .finally(() => pool.end());
}

module.exports = crearAdministrador;
