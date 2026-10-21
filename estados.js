const { normalizarTexto } = require('./plazos');

const ESTADOS_EDITABLES = new Map([
    ['recibido', 'Recibido'],
    ['en tramite', 'En trámite'],
    ['pendiente', 'Pendiente'],
    ['enterado', 'Enterado']
]);

function obtenerEstadoEditable(estado) {
    if (typeof estado !== 'string') {
        return null;
    }
    return ESTADOS_EDITABLES.get(normalizarTexto(estado)) || null;
}

function requiereRespuesta(registro) {
    return registro.requiere_respuesta !== 0 && registro.requiere_respuesta !== false;
}

function esEstadoFinal(estado) {
    return ['respondido', 'enterado'].includes(normalizarTexto(estado));
}

module.exports = { obtenerEstadoEditable, requiereRespuesta, esEstadoFinal };
