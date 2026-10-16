const CODIGOS_TRAMITE_INTERNOS = new Set([
    'derecho_peticion',
    'solicitud',
    'informativo',
    'notificacion',
    'notificacion_judicial'
]);

function clasificarTipoTramite(codigo) {
    return CODIGOS_TRAMITE_INTERNOS.has(String(codigo || '').trim().toLowerCase())
        ? 'Interna'
        : 'Externa';
}

module.exports = { clasificarTipoTramite, CODIGOS_TRAMITE_INTERNOS };
