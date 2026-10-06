const Holidays = require('date-holidays');
const { obtenerTiempoRespuesta } = require('./plazos');

const calendarioFestivos = new Holidays('CO');
const festivosPorAno = new Map();
const fechaColombia = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
});

function obtenerFechaLocal(fecha, nombreCampo) {
    if (typeof fecha === 'string') {
        const coincidencia = /^(\d{4})-(\d{2})-(\d{2})/.exec(fecha.trim());
        if (coincidencia) {
            const [, ano, mes, dia] = coincidencia;
            const fechaUtc = new Date(Date.UTC(Number(ano), Number(mes) - 1, Number(dia)));

            if (
                fechaUtc.getUTCFullYear() !== Number(ano) ||
                fechaUtc.getUTCMonth() !== Number(mes) - 1 ||
                fechaUtc.getUTCDate() !== Number(dia)
            ) {
                throw new TypeError(`${nombreCampo} no contiene una fecha válida.`);
            }

            return `${ano}-${mes}-${dia}`;
        }
    }

    const fechaDate = fecha instanceof Date ? fecha : new Date(fecha);
    if (Number.isNaN(fechaDate.getTime())) {
        throw new TypeError(`${nombreCampo} no contiene una fecha válida.`);
    }

    const partes = fechaColombia.formatToParts(fechaDate);
    const valores = Object.fromEntries(partes.map(({ type, value }) => [type, value]));
    return `${valores.year}-${valores.month}-${valores.day}`;
}

function obtenerFestivos(ano) {
    if (!festivosPorAno.has(ano)) {
        const fechas = new Set(
            calendarioFestivos
                .getHolidays(ano)
                .filter(({ type }) => type === 'public')
                .map(({ date }) => date.slice(0, 10))
        );
        festivosPorAno.set(ano, fechas);
    }

    return festivosPorAno.get(ano);
}

function contarDiasHabiles(fechaInicio, fechaFin) {
    const [anoInicio, mesInicio, diaInicio] = fechaInicio.split('-').map(Number);
    const [anoFin, mesFin, diaFin] = fechaFin.split('-').map(Number);
    const inicioUtc = Date.UTC(anoInicio, mesInicio - 1, diaInicio);
    const finUtc = Date.UTC(anoFin, mesFin - 1, diaFin);

    let diasHabiles = 0;
    for (let fechaUtc = inicioUtc + 86400000; fechaUtc <= finUtc; fechaUtc += 86400000) {
        const fecha = new Date(fechaUtc);
        const diaSemana = fecha.getUTCDay();

        if (diaSemana === 0 || diaSemana === 6) {
            continue;
        }

        const fechaTexto = fecha.toISOString().slice(0, 10);
        if (!obtenerFestivos(fecha.getUTCFullYear()).has(fechaTexto)) {
            diasHabiles++;
        }
    }

    return diasHabiles;
}

function calcularSemaforoBackend(radicado, fechaActual = new Date()) {
    if (String(radicado.estado || '').trim().toLowerCase() === 'respondido') {
        return {
            nivel: 'completado',
            texto: 'Completado',
            clase: 'bg-emerald-100 text-emerald-800 border-emerald-300',
            punto: 'bg-emerald-500'
        };
    }

    const tiempoRespuesta = radicado.tipo_documento
        ? obtenerTiempoRespuesta(radicado.tipo_documento)
        : radicado.tiempo_de_respuesta;
    let diasLimite = 15;
    if (tiempoRespuesta) {
        const coincidencia = String(tiempoRespuesta).match(/\d+/);
        if (coincidencia) {
            diasLimite = parseInt(coincidencia[0], 10);
        }
    }

    const fechaCreacion = obtenerFechaLocal(radicado.fecha_creacion, 'fecha_creacion');
    const hoy = obtenerFechaLocal(fechaActual, 'fecha actual');
    const diasTranscurridos = contarDiasHabiles(fechaCreacion, hoy);
    const diasRestantes = diasLimite - diasTranscurridos;
    const cantidadDiasRestantes = `${diasRestantes} ${diasRestantes === 1 ? 'día' : 'días'}`;

    if (diasRestantes < 0) {
        const diasVencido = Math.abs(diasRestantes);
        return {
            nivel: 'vencido',
            texto: `Vencido (${diasVencido} ${diasVencido === 1 ? 'día' : 'días'})`,
            clase: 'bg-red-100 text-red-800 border-red-300',
            punto: 'bg-red-500 animate-pulse'
        };
    }

    if (diasRestantes <= 3) {
        return {
            nivel: 'alerta',
            texto: diasRestantes === 0 ? 'Vence hoy' : `Por vencer (${cantidadDiasRestantes})`,
            clase: 'bg-amber-100 text-amber-800 border-amber-300',
            punto: 'bg-amber-500'
        };
    }

    return {
        nivel: 'a_tiempo',
        texto: `A tiempo (${cantidadDiasRestantes})`,
        clase: 'bg-emerald-100 text-emerald-800 border-emerald-300',
        punto: 'bg-emerald-500'
    };
}

module.exports = calcularSemaforoBackend;
