const calcularSemaforoBackend = require('./semaforo');
const { obtenerTiempoRespuesta } = require('./plazos');

function presentarRadicadoEnFecha(radicado, fechaActual) {
    const {
        termino_fecha_recepcion, termino_dias, termino_tipo_dias, termino_fundamento,
        termino_fecha_limite_inicial, termino_fecha_limite_actual, termino_fecha_respuesta,
        termino_nombre_tramite, termino_codigo_tramite,
        seguimiento_estado, seguimiento_fecha_respuesta, seguimiento_fecha_enterado,
        ...datos
    } = radicado;
    const radicadoConTermino = {
        ...datos,
        estado: seguimiento_estado || datos.estado,
        fecha_enterado: datos.destino_todas_dependencias
            ? seguimiento_fecha_enterado : datos.fecha_enterado,
        fecha_recepcion: termino_fecha_recepcion || datos.fecha_creacion,
        termino_dias_aplicado: termino_dias,
        tipo_dias_aplicado: termino_tipo_dias,
        fundamento_legal_aplicado: termino_fundamento,
        fecha_limite_inicial: termino_fecha_limite_inicial,
        fecha_limite_actual: termino_fecha_limite_actual,
        fecha_respuesta: datos.destino_todas_dependencias
            ? seguimiento_fecha_respuesta : termino_fecha_respuesta,
        tipo_tramite: termino_nombre_tramite || null,
        tipo_tramite_codigo: termino_codigo_tramite || null
    };
    if (termino_dias && termino_tipo_dias) {
        radicadoConTermino.tiempo_de_respuesta = obtenerTiempoRespuesta({
            dias: termino_dias, tipo_dias: termino_tipo_dias
        });
    }
    return { ...radicadoConTermino, semaforo: calcularSemaforoBackend(radicadoConTermino, fechaActual) };
}

function presentarRadicado(radicado) {
    return presentarRadicadoEnFecha(radicado, new Date());
}

module.exports = { presentarRadicado, presentarRadicadoEnFecha };
