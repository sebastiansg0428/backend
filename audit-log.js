const EVENTOS_RADICADO = new Set([
    'radicado_creado',
    'radicado_asignado',
    'documentos_radicado_adjuntados',
    'estado_cambiado',
    'respuesta_enviada',
    'documentos_respuesta_adjuntados',
    'termino_ampliado',
    'regla_respuesta_aplicada'
]);

function fechaUTC(fecha = new Date()) {
    return fecha.toISOString().replace('T', ' ').replace('Z', '');
}

async function registrarEventoRadicado(connection, req, evento) {
    if (!connection || !req?.usuario || !EVENTOS_RADICADO.has(evento.tipo)) {
        throw new TypeError('La conexion, el actor autenticado y un tipo de evento permitido son obligatorios.');
    }
    const actorId = Number(req.usuario.id);
    if (!Number.isSafeInteger(actorId) || actorId < 1) {
        throw new TypeError('El identificador del actor autenticado no es valido.');
    }
    await connection.execute(
        `INSERT INTO historial_radicado
            (numero_radicado, campo_modificado, valor_anterior, valor_nuevo, usuario, motivo,
             event_type, actor_id, actor_name, dependencia_id, dependencia_nombre,
             radicado_dependencia_id, session_id, ip_address, ocurrido_en_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            evento.numeroRadicado,
            evento.tipo,
            evento.valorAnterior ?? null,
            evento.valorNuevo ?? null,
            String(actorId),
            evento.motivo,
            evento.tipo,
            actorId,
            req.usuario.nombre,
            evento.dependenciaId ?? null,
            evento.dependenciaNombre ?? null,
            evento.radicadoDependenciaId ?? null,
            req.idSesion ?? null,
            typeof req.ip === 'string' && req.ip.length <= 45 ? req.ip : null,
            fechaUTC()
        ]
    );
}

module.exports = { EVENTOS_RADICADO, fechaUTC, registrarEventoRadicado };
