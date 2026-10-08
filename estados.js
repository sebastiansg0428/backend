const { normalizarTexto } = require('./plazos');

const ESTADOS_EDITABLES = new Map([
    ['recibido', 'Recibido'],
    ['en tramite', 'En trámite'],
    ['pendiente', 'Pendiente'],
    ['respondido', 'Respondido']
]);

function obtenerEstadoEditable(estado) {
    if (typeof estado !== 'string') {
        return null;
    }
    return ESTADOS_EDITABLES.get(normalizarTexto(estado)) || null;
}

module.exports = { obtenerEstadoEditable };
