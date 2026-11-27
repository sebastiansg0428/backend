function esGlobal(radicado) {
    return Number(radicado?.destino_todas_dependencias) === 1;
}

function esGlobalExterno(radicado) {
    return esGlobal(radicado) &&
        String(radicado?.tipo_comunicacion || '').trim().toLowerCase() === 'externa' &&
        Number(radicado?.requiere_respuesta) === 1 &&
        Number(radicado?.dependencia_responsable_id) > 0;
}

function esGlobalInformativo(radicado) {
    return esGlobal(radicado) && Number(radicado?.requiere_respuesta) !== 1;
}

function puedeVerContenidoGlobal({ rol, dependenciaId, responsableId }) {
    return ['administrador', 'ventanilla'].includes(rol) ||
        (rol === 'funcionario' && Number(dependenciaId) === Number(responsableId));
}

function resumirAsignaciones(asignaciones = [], radicado = {}) {
    const total = asignaciones.length;
    const contarEstado = estado => asignaciones.filter(item =>
        String(item.estado || '').trim().toLowerCase() === estado).length;
    const enteradas = contarEstado('enterado');
    const respondidas = contarEstado('respondido');
    const recibidas = contarEstado('recibido');
    const en_tramite = contarEstado('en trámite');
    const pendientes = contarEstado('pendiente');
    const responsable = asignaciones.find(item => Number(item.dependencia_id) === Number(radicado.dependencia_responsable_id));
    const esExterno = esGlobalExterno(radicado);
    return {
        total_dependencias: total,
        enteradas,
        respondidas,
        recibidas,
        en_tramite,
        pendientes,
        progreso: `${enteradas} / ${total}`,
        respuesta_disponible: Boolean(radicado.respuesta_disponible || respondidas),
        estado_global: esExterno
            ? (radicado.estado === 'Entregado' ? 'Entregado' : (radicado.respuesta_disponible || respondidas ? 'Respondido' : 'Pendiente'))
            : (total > 0 && enteradas === total ? 'Enterado' : 'Pendiente'),
        dependencia_responsable_id: radicado.dependencia_responsable_id || null,
        dependencia_responsable: responsable?.dependencia_nombre || radicado.dependencia_responsable || null
    };
}

module.exports = { esGlobal, esGlobalExterno, esGlobalInformativo, puedeVerContenidoGlobal, resumirAsignaciones };
