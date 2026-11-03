const { filtroDependencia } = require('./auth');
const { agregarDias, obtenerFechaLocal } = require('./semaforo');
const { revertirTrasError } = require('./transacciones');
const { presentarRadicadoEnFecha } = require('./presentacion-radicado');

const FROM = `FROM radicados AS r
    LEFT JOIN radicado_dependencias rd
      ON rd.numero_radicado = r.numero_radicado
     AND r.destino_todas_dependencias = 1
     AND (? IS NULL OR rd.dependencia_id = ?)
    LEFT JOIN dependencias d ON d.id = rd.dependencia_id
    LEFT JOIN radicado_terminos rt ON rt.numero_radicado = r.numero_radicado
    LEFT JOIN tipos_tramite t ON t.id = rt.tipo_tramite_id`;
const TERMINO = `rd.id AS radicado_dependencia_id,
    rd.estado AS seguimiento_estado, rd.fecha_respuesta AS seguimiento_fecha_respuesta,
    rd.fecha_enterado AS seguimiento_fecha_enterado,
    rt.fecha_recepcion AS termino_fecha_recepcion, rt.termino_dias_aplicado AS termino_dias,
    rt.tipo_dias_aplicado AS termino_tipo_dias, rt.fundamento_legal_aplicado AS termino_fundamento,
    rt.fecha_limite_inicial AS termino_fecha_limite_inicial,
    rt.fecha_limite_actual AS termino_fecha_limite_actual,
    rt.fecha_respuesta AS termino_fecha_respuesta,
    t.nombre AS termino_nombre_tramite, t.codigo AS termino_codigo_tramite`;
const SELECT = `r.*, ${TERMINO}, rd.dependencia_id AS seguimiento_dependencia_id,
    d.nombre AS seguimiento_dependencia_nombre`;
const ORDEN = `ORDER BY COALESCE(r.fecha_hora_recepcion, r.fecha_creacion) DESC,
    r.numero_radicado DESC, COALESCE(rd.id, 0) DESC`;
const FECHA = 'COALESCE(r.fecha_hora_recepcion, r.fecha_creacion)';
const CLASE = `CASE
    WHEN LOWER(COALESCE(NULLIF(r.tipo_comunicacion, ''), r.tipo_documento, '')) LIKE '%interna%' THEN 'interna'
    WHEN LOWER(COALESCE(NULLIF(r.tipo_comunicacion, ''), r.tipo_documento, '')) LIKE '%externa%' THEN 'externa'
    ELSE 'sin-tipo' END`;

function opcionesConsulta(query) {
    const entero = (campo, defecto, maximo) => {
        const valor = query[campo] ?? String(defecto);
        if (typeof valor !== 'string' || !/^[1-9]\d*$/.test(valor) ||
            !Number.isSafeInteger(Number(valor)) || Number(valor) > maximo) {
            throw new TypeError(`${campo} debe ser un entero entre 1 y ${maximo}.`);
        }
        return Number(valor);
    };
    const pagina = entero('pagina', 1, 1000000);
    const limite = entero('limite', 25, 100);
    const booleano = campo => {
        if (query[campo] === undefined) return false;
        if (!['0', '1'].includes(query[campo])) throw new TypeError(`${campo} debe ser 0 o 1.`);
        return query[campo] === '1';
    };
    const busqueda = query.busqueda ?? '';
    if (typeof busqueda !== 'string' || busqueda.length > 150) {
        throw new TypeError('busqueda debe ser texto de hasta 150 caracteres.');
    }
    const clase = query.tipo_comunicacion ?? '';
    if (!['', 'interna', 'externa', 'sin-tipo'].includes(clase)) {
        throw new TypeError('tipo_comunicacion debe ser interna, externa o sin-tipo.');
    }
    return { pagina, limite, busqueda: busqueda.trim(), clase,
        hoy: booleano('hoy'), criticos: booleano('criticos') };
}

function construirFiltros(usuario, opciones, fecha, dependenciaId = null) {
    const permiso = filtroDependencia(usuario);
    const seguimiento = usuario.rol === 'funcionario' ? usuario.dependencia_id : null;
    let base = permiso.sql;
    const valoresBase = [seguimiento, seguimiento, ...permiso.valores];
    if (dependenciaId !== null) {
        base += ` AND ((r.destino_todas_dependencias = 1 AND rd.dependencia_id = ?)
            OR (r.destino_todas_dependencias = 0 AND r.dependencia_destino_id = ?))`;
        valoresBase.push(dependenciaId, dependenciaId);
    }
    const condiciones = ['1 = 1'];
    const valoresFiltro = [];
    if (opciones.busqueda) {
        // LOCATE interpreta % y _ como texto, no como comodines de SQL.
        condiciones.push(`(${['numero_radicado', 'remitente_nombre', 'remitente_documento', 'remitente_nit']
            .map(campo => `LOCATE(? COLLATE utf8mb4_unicode_ci,
                CONVERT(COALESCE(r.${campo}, '') USING utf8mb4) COLLATE utf8mb4_unicode_ci) > 0`).join(' OR ')})`);
        valoresFiltro.push(...Array(4).fill(opciones.busqueda));
    }
    if (opciones.hoy) {
        condiciones.push(`DATE(${FECHA}) = ?`);
        valoresFiltro.push(fecha);
    }
    if (opciones.clase) {
        condiciones.push(`${CLASE} = ?`);
        valoresFiltro.push(opciones.clase);
    }
    return { base, valoresBase, filtro: condiciones.join(' AND '), valoresFiltro };
}

async function consultarPagina(pool, usuario, opciones, dependenciaId = null, soloAlertas = false) {
    const ahora = new Date();
    const presentar = row => presentarRadicadoEnFecha(row, ahora);
    const hoy = obtenerFechaLocal(ahora, 'fecha actual');
    const filtros = construirFiltros(usuario, opciones, hoy, dependenciaId);
    const { base, valoresBase, filtro, valoresFiltro } = filtros;
    let connection = await pool.getConnection();
    let enTransaccion = false;
    try {
        await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await connection.query('START TRANSACTION READ ONLY');
        enTransaccion = true;
        let resumen = { total: 0, hoy: 0, criticos: 0 };
        if (!soloAlertas) {
            const [totales] = await connection.execute(
                `SELECT COUNT(*) AS total,
                    COALESCE(SUM(DATE(${FECHA}) = ?), 0) AS hoy
                 ${FROM} WHERE ${base}`, [hoy, ...valoresBase]);
            resumen = { ...resumen, total: Number(totales[0].total), hoy: Number(totales[0].hoy) };
        }
        // El cuarto dia habil delimita tambien fines de semana/festivos tras el tercero.
        const cuartoHabil = agregarDias(hoy, 4, 'habiles');
        const cuartoCalendario = agregarDias(hoy, 4, 'calendario');
        const candidatos = `COALESCE(r.requiere_respuesta, 1) <> 0
            AND LOWER(TRIM(COALESCE(NULLIF(rd.estado, ''), r.estado, ''))) <> 'respondido'
            AND (CASE WHEN r.destino_todas_dependencias = 1
                 THEN rd.fecha_respuesta ELSE rt.fecha_respuesta END) IS NULL
            AND (COALESCE(rt.fecha_limite_actual, rt.fecha_limite_inicial) IS NULL
                 OR rt.termino_dias_aplicado IS NULL OR rt.termino_dias_aplicado < 1
                 OR rt.tipo_dias_aplicado IS NULL OR rt.tipo_dias_aplicado NOT IN ('habiles', 'calendario')
                 OR (rt.tipo_dias_aplicado = 'habiles'
                     AND COALESCE(rt.fecha_limite_actual, rt.fecha_limite_inicial) < ?)
                 OR (rt.tipo_dias_aplicado = 'calendario'
                     AND COALESCE(rt.fecha_limite_actual, rt.fecha_limite_inicial) < ?))`;
        let total = 0;
        let porVencer = 0;
        let vencidos = 0;
        const claves = [];
        const inicio = (opciones.pagina - 1) * opciones.limite;
        let offset = 0;
        while (true) {
            const [rows] = await connection.execute(
                `SELECT r.numero_radicado, r.estado, r.requiere_respuesta,
                    r.destino_todas_dependencias, r.fecha_creacion, r.tiempo_de_respuesta,
                    ${TERMINO}, (${filtro}) AS coincide_filtros
                 ${FROM} WHERE ${base} AND ${candidatos}
                 ${ORDEN} LIMIT 250 OFFSET ?`,
                [...valoresFiltro, ...valoresBase, cuartoHabil, cuartoCalendario, offset]);
            for (const row of rows) {
                const nivel = presentar(row).semaforo.nivel;
                if (!['alerta', 'vencido'].includes(nivel)) continue;
                resumen.criticos++;
                if (!Number(row.coincide_filtros)) continue;
                if (total >= inicio && claves.length < opciones.limite) {
                    claves.push([row.numero_radicado, row.radicado_dependencia_id || 0]);
                }
                total++;
                if (nivel === 'alerta') porVencer++;
                else vencidos++;
            }
            if (rows.length < 250) break;
            offset += rows.length;
        }
        let rows = [];
        if (opciones.criticos || soloAlertas) {
            if (claves.length) {
                [rows] = await connection.execute(
                    `SELECT ${SELECT} ${FROM} WHERE ${base} AND (${claves.map(() =>
                        '(r.numero_radicado = ? AND COALESCE(rd.id, 0) = ?)').join(' OR ')}) ${ORDEN}`,
                    [...valoresBase, ...claves.flat()]);
            }
        } else {
            const [totales] = await connection.execute(
                `SELECT COUNT(*) AS total ${FROM} WHERE ${base} AND ${filtro}`,
                [...valoresBase, ...valoresFiltro]);
            total = Number(totales[0].total);
            [rows] = await connection.execute(
                `SELECT ${SELECT} ${FROM} WHERE ${base} AND ${filtro} ${ORDEN} LIMIT ? OFFSET ?`,
                [...valoresBase, ...valoresFiltro, opciones.limite, inicio]);
        }
        const datos = rows.map(presentar);
        await connection.commit();
        enTransaccion = false;
        return { success: true, total, ...(!soloAlertas ? { resumen } : {}),
            pagina: opciones.pagina, limite: opciones.limite,
            paginas: Math.ceil(total / opciones.limite),
            has_more: inicio + rows.length < total,
            ...(soloAlertas ? { alertas: datos, por_vencer: porVencer, vencidos }
                : { radicados: datos }) };
    } catch (error) {
        if (enTransaccion) {
            const reversion = await revertirTrasError(connection, error);
            connection = reversion.connection;
            throw reversion.error;
        }
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

module.exports = { opcionesConsulta, construirFiltros, consultarPagina, FROM, SELECT, ORDEN };
