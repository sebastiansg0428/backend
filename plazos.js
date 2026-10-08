function normalizarTexto(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function obtenerTiempoRespuesta(termino) {
    if (!termino || !Number.isInteger(Number(termino.dias))) {
        return null;
    }

    const unidad = termino.tipo_dias === 'calendario' ? 'días calendario' : 'días hábiles';
    return `${termino.dias} ${unidad}`;
}

module.exports = {
    normalizarTexto,
    obtenerTiempoRespuesta
};
