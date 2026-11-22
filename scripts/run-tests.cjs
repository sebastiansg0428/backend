const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const mysql = process.argv.includes('--mysql');
const environment = { ...process.env };

function archivosDePrueba(directorio) {
    return fs.readdirSync(directorio, { withFileTypes: true }).flatMap(entrada => {
        const ruta = path.join(directorio, entrada.name);
        if (entrada.isDirectory()) return archivosDePrueba(ruta);
        return /\.test\.(?:cjs|js)$/.test(entrada.name) ? [ruta] : [];
    });
}

if (mysql) {
    for (const variable of [
        'TEST_CONSULTA_MYSQL',
        'TEST_INTEGRIDAD_MYSQL',
        'TEST_LOGIN_MYSQL',
        'TEST_RECEPCION_RENDIMIENTO_MYSQL',
        'TEST_TRASLADOS_MYSQL'
    ]) {
        environment[variable] = '1';
    }
}

const archivos = mysql
    ? [
        'test/consulta-mysql.test.js',
        'test/integridad-mysql.test.js',
        'test/limites-login-mysql.test.js',
        'test/recepcion-rendimiento-mysql.test.js',
        'test/traslados-mysql.test.js'
    ]
    : archivosDePrueba(path.join(process.cwd(), 'test'));

function ejecutarArchivo(archivo) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [
            '--experimental-test-isolation=none',
            '--test',
            archivo
        ], {
            cwd: process.cwd(),
            env: environment,
            stdio: ['inherit', 'pipe', 'pipe']
        });
        const salida = [];
        const reenviar = stream => stream.on('data', chunk => {
            process.stdout.write(chunk);
            salida.push(chunk.toString());
        });
        reenviar(child.stdout);
        reenviar(child.stderr);
        child.on('error', error => {
            console.error(`No se pudo iniciar ${archivo}:`, error.message);
            resolve({ code: 1, texto: salida.join('') });
        });
        child.on('close', code => resolve({ code: code ?? 1, texto: salida.join('') }));
    });
}

async function main() {
    const resultados = [];
    for (const archivo of archivos) resultados.push(await ejecutarArchivo(archivo));
    const texto = resultados.map(resultado => resultado.texto).join('\n');
    const codigo = resultados.find(resultado => resultado.code !== 0)?.code ?? 0;
    const obtener = etiqueta => {
        const coincidencias = [...texto.matchAll(new RegExp(`# ${etiqueta} (\\d+)`, 'g'))];
        if (coincidencias.length === 0) return 'no disponible';
        return coincidencias.reduce((total, coincidencia) => total + Number(coincidencia[1]), 0);
    };

    console.log('\nResumen de pruebas:');
    console.log(`- Exitosas: ${obtener('pass')}`);
    console.log(`- Omitidas: ${obtener('skipped')}`);
    console.log(`- Fallidas: ${obtener('fail')}`);
    console.log(`- Totales: ${obtener('tests')}`);

    const clasificaciones = [];
    if (/fetch failed/i.test(texto) && /(EACCES|EPERM|ECONNREFUSED|127\.0\.0\.1|localhost)/i.test(texto)) {
        clasificaciones.push('Infraestructura: fallo de conexión local o loopback.');
    }
    if (/(ER_ACCESS_DENIED_ERROR|ECONNREFUSED.*(?:3306|mysql)|Can't connect to MySQL|MariaDB.*(?:not available|unavailable|refused|access denied)|MySQL.*(?:not available|unavailable|refused|access denied))/i.test(texto)) {
        clasificaciones.push('Infraestructura: MariaDB no disponible o sin credenciales de prueba.');
    }
    if (/(ENOTFOUND|ETIMEDOUT|ECONNRESET)/i.test(texto)) {
        clasificaciones.push('Infraestructura: servicio externo inaccesible.');
    }
    if (/heap out of memory|Reached heap limit/i.test(texto)) {
        clasificaciones.push('Infraestructura: memoria insuficiente para ejecutar las suites simultáneamente.');
    }
    if (clasificaciones.length === 0 && Number(obtener('fail')) > 0) {
        clasificaciones.push('Funcional: existen pruebas fallidas que requieren investigación.');
    }
    if (clasificaciones.length > 0) {
        console.log('Clasificación:');
        for (const clasificacion of clasificaciones) console.log(`- ${clasificacion}`);
    }

    process.exitCode = codigo;
}

main().catch(error => {
    console.error('No se pudo ejecutar la suite:', error.message);
    process.exitCode = 1;
});
