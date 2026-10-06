const DIAS_POR_TIPO_DOCUMENTO = new Map([
    ['solicitud', 10],
    ['solicitud simit-rut', 10],
    ['derecho de peticion', 15],
    ['queja', 15],
    ['reclamo', 15],
    ['accion de tutela', 2],
    ['desacato de tutela', 2],
    ['licencia de construccion', 45],
    ['licencia urbanistica', 45]
]);

function normalizarTipoDocumento(tipoDocumento) {
    return String(tipoDocumento || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function obtenerDiasPlazo(tipoDocumento) {
    return DIAS_POR_TIPO_DOCUMENTO.get(normalizarTipoDocumento(tipoDocumento)) || 15;
}

function obtenerTiempoRespuesta(tipoDocumento) {
    return `${obtenerDiasPlazo(tipoDocumento)} días hábiles`;
}

module.exports = {
    obtenerDiasPlazo,
    obtenerTiempoRespuesta
};
