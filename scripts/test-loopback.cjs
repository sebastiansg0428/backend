const http = require('node:http');

function cerrarServidor(server) {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

async function main() {
    const server = http.createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('loopback OK');
    });

    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        const { port } = server.address();
        const response = await fetch(`http://127.0.0.1:${port}`);
        const body = await response.text();
        if (!response.ok || body !== 'loopback OK') {
            throw new Error(`Respuesta inesperada del loopback: HTTP ${response.status}`);
        }
        console.log(`Loopback OK en 127.0.0.1:${port}`);
    } finally {
        await cerrarServidor(server);
    }
}

main().catch(error => {
    console.error('No se pudo comprobar el loopback:', error.message);
    process.exitCode = 1;
});
