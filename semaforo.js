const Holidays = require('date-holidays');

const calendarioFestivos = new Holidays('CO');
const festivosPorAno = new Map();
const fechaColombia = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
});
const MILISEGUNDOS_DIA = 86400000;

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

function esDiaHabil(fechaUtc) {
    const diaSemana = fechaUtc.getUTCDay();
    if (diaSemana === 0 || diaSemana === 6) {
        return false;
    }

    return !obtenerFestivos(fechaUtc.getUTCFullYear()).has(fechaUtc.toISOString().slice(0, 10));
}

function contarDias(fechaInicio, fechaFin, tipoDias = 'habiles') {
    const inicioUtc = fechaAUTC(fechaInicio);
    const finUtc = fechaAUTC(fechaFin);
    if (finUtc <= inicioUtc) {
        return 0;
    }

    let dias = 0;
    for (let fechaUtc = inicioUtc + MILISEGUNDOS_DIA; fechaUtc <= finUtc; fechaUtc += MILISEGUNDOS_DIA) {
        if (tipoDias === 'calendario' || esDiaHabil(new Date(fechaUtc))) {
            dias++;
        }
    }
    return dias;
}

function fechaAUTC(fecha) {
    const [ano, mes, dia] = fecha.split('-').map(Number);
    return Date.UTC(ano, mes - 1, dia);
}

function agregarDias(fechaInicio, dias, tipoDias = 'habiles') {
    if (!Number.isInteger(Number(dias)) || Number(dias) < 1) {
        throw new TypeError('El término debe ser un número entero mayor que cero.');
    }
    if (!['habiles', 'calendario'].includes(tipoDias)) {
        throw new TypeError('El tipo de días debe ser "habiles" o "calendario".');
    }

    const inicioUtc = fechaAUTC(fechaInicio);
    let fechaUtc = inicioUtc;
    let diasAgregados = 0;
    while (diasAgregados < Number(dias)) {
        fechaUtc += MILISEGUNDOS_DIA;
        if (tipoDias === 'calendario' || esDiaHabil(new Date(fechaUtc))) {
            diasAgregados++;
        }
    }

    return new Date(fechaUtc).toISOString().slice(0, 10);
}

function obtenerDatosTermino(radicado) {
    let dias = Number(radicado.termino_dias_aplicado);
    let tipoDias = radicado.tipo_dias_aplicado;

    if ((!Number.isInteger(dias) || dias < 1) && radicado.tiempo_de_respuesta) {
        const coincidencia = String(radicado.tiempo_de_respuesta)
            .match(/^\s*(\d+)\s+d[ií]as?\s*(h[aá]biles|calendario)?/i);
        if (coincidencia) {
            dias = Number(coincidencia[1]);
            tipoDias = /calendario/i.test(coincidencia[2] || '') ? 'calendario' : 'habiles';
        }
    }

    if (!Number.isInteger(dias) || dias < 1 || !['habiles', 'calendario'].includes(tipoDias)) {
        return null;
    }
    return { dias, tipoDias };
}

function crearResultado(nivel, texto, clase, punto, diasRestantes, fechaLimite) {
    return { nivel, texto, clase, punto, dias_restantes: diasRestantes, fecha_limite: fechaLimite };
}

function calcularSemaforoBackend(radicado, fechaActual = new Date()) {
    if (
        String(radicado.estado || '').trim().toLowerCase() === 'respondido' ||
        radicado.fecha_respuesta
    ) {
        return crearResultado(
            'completado',
            'Completado',
            'bg-emerald-100 text-emerald-800 border-emerald-300',
            'bg-emerald-500',
            0,
            radicado.fecha_limite_actual || radicado.fecha_limite_inicial || null
        );
    }

    const termino = obtenerDatosTermino(radicado);
    if (!termino) {
        return crearResultado(
            'sin_termino',
            'Sin término configurado',
            'bg-slate-100 text-slate-700 border-slate-300',
            'bg-slate-500',
            null,
            null
        );
    }

    const fechaInicio = obtenerFechaLocal(
        radicado.fecha_recepcion || radicado.fecha_creacion,
        'fecha_recepcion'
    );
    const hoy = obtenerFechaLocal(fechaActual, 'fecha actual');
    const fechaLimite = obtenerFechaLocal(
        radicado.fecha_limite_actual ||
            radicado.fecha_limite_inicial ||
            agregarDias(fechaInicio, termino.dias, termino.tipoDias),
        'fecha_limite'
    );
    const diasRestantes = hoy <= fechaLimite
        ? contarDias(hoy, fechaLimite, termino.tipoDias)
        : -Math.max(1, contarDias(fechaLimite, hoy, termino.tipoDias));
    const cantidadDias = `${Math.abs(diasRestantes)} ${Math.abs(diasRestantes) === 1 ? 'día' : 'días'}`;

    if (diasRestantes < 0) {
        return crearResultado(
            'vencido',
            `Vencido (${cantidadDias})`,
            'bg-red-100 text-red-800 border-red-300',
            'bg-red-500 animate-pulse',
            diasRestantes,
            fechaLimite
        );
    }

    if (diasRestantes <= 3) {
        return crearResultado(
            'alerta',
            diasRestantes === 0 ? 'Vence hoy' : `Por vencer (${cantidadDias})`,
            'bg-amber-100 text-amber-800 border-amber-300',
            'bg-amber-500',
            diasRestantes,
            fechaLimite
        );
    }

    return crearResultado(
        'a_tiempo',
        `A tiempo (${cantidadDias})`,
        'bg-emerald-100 text-emerald-800 border-emerald-300',
        'bg-emerald-500',
        diasRestantes,
        fechaLimite
    );
}

module.exports = calcularSemaforoBackend;
module.exports.agregarDias = agregarDias;
module.exports.contarDias = contarDias;
module.exports.obtenerFechaLocal = obtenerFechaLocal;
