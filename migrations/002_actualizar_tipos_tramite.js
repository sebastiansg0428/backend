const pool = require('../db');

async function actualizarTiposTramite() {
    try {
        const [cols] = await pool.query("SHOW COLUMNS FROM tipos_tramite LIKE 'orden'");
        if (cols.length === 0) {
            await pool.query("ALTER TABLE tipos_tramite ADD COLUMN orden INT NOT NULL DEFAULT 0");
            console.log("Columna 'orden' añadida a tipos_tramite.");
        }

        // Desactivar trámites anteriores que no están en la nueva lista
        await pool.query(
            "UPDATE tipos_tramite SET activo = FALSE WHERE codigo IN ('peticion_general', 'informacion_documentos', 'consulta', 'entre_autoridades')"
        );

        // Actualizar trámites existentes que sí están en la nueva lista
        await pool.query("UPDATE tipos_tramite SET orden = 3, activo = TRUE WHERE codigo = 'derecho_peticion'");
        await pool.query("UPDATE tipos_tramite SET orden = 5, activo = TRUE WHERE codigo = 'queja'");
        await pool.query("UPDATE tipos_tramite SET orden = 6, activo = TRUE WHERE codigo = 'reclamo'");

        // 13 nuevos tipos de trámite con sus términos legales
        const nuevos = [
            {
                codigo: 'informativo',
                nombre: 'Informativo',
                categoria: 'peticion_general',
                orden: 1,
                dias: 15,
                fundamento: 'Ley 1755 de 2015, artículo 14. Trámite de carácter informativo.'
            },
            {
                codigo: 'solicitud',
                nombre: 'Solicitud',
                categoria: 'peticion_general',
                orden: 2,
                dias: 15,
                fundamento: 'Ley 1755 de 2015, artículo 14. Solicitud o petición de interés general o particular.'
            },
            {
                codigo: 'denuncia',
                nombre: 'Denuncia',
                categoria: 'peticion_general',
                orden: 4,
                dias: 15,
                fundamento: 'Ley 1755 de 2015, artículo 14 / CPACA. Denuncia ciudadana.'
            },
            {
                codigo: 'notificacion_judicial',
                nombre: 'Notificación Judicial',
                categoria: 'especial',
                orden: 7,
                dias: 10,
                fundamento: 'Ley 1437 de 2011 (CPACA), artículo 197 / Ley 2080 de 2021. Notificaciones judiciales.'
            },
            {
                codigo: 'restablecimiento_derecho',
                nombre: 'Restablecimiento de derecho',
                categoria: 'especial',
                orden: 8,
                dias: 15,
                fundamento: 'Ley 1437 de 2011 (CPACA), artículo 138 / Ley 1755 de 2015.'
            },
            {
                codigo: 'cuotas_partes',
                nombre: 'Cuotas partes',
                categoria: 'especial',
                orden: 9,
                dias: 15,
                fundamento: 'Ley 1066 de 2006 / Decreto 1068 de 2015 / Ley 1755 de 2015. Cuotas partes pensionales.'
            },
            {
                codigo: 'accion_tutela',
                nombre: 'Acción de tutela',
                categoria: 'especial',
                orden: 10,
                dias: 10,
                fundamento: 'Decreto 2591 de 1991, artículo 29. Término preferente y sumario de acción de tutela.'
            },
            {
                codigo: 'desacato_tutela',
                nombre: 'Desacato de Tutela',
                categoria: 'especial',
                orden: 11,
                dias: 3,
                fundamento: 'Decreto 2591 de 1991, artículo 52. Trámite incidental de desacato de tutela.'
            },
            {
                codigo: 'licencia_construccion',
                nombre: 'Licencia de construcción',
                categoria: 'especial',
                orden: 12,
                dias: 45,
                fundamento: 'Decreto 1077 de 2015, artículo 2.2.6.1.2.2.1. Trámite y resolución de licencias de construcción.'
            },
            {
                codigo: 'notificacion',
                nombre: 'Notificación',
                categoria: 'especial',
                orden: 13,
                dias: 10,
                fundamento: 'Ley 1437 de 2011 (CPACA), artículos 67 a 69. Actos de notificación administrativa.'
            },
            {
                codigo: 'invitacion',
                nombre: 'Invitación',
                categoria: 'peticion_general',
                orden: 14,
                dias: 15,
                fundamento: 'Ley 1755 de 2015, artículo 14. Comunicaciones oficiales e invitaciones.'
            },
            {
                codigo: 'licencia_urbanistica',
                nombre: 'Licencia Urbanística',
                categoria: 'especial',
                orden: 15,
                dias: 45,
                fundamento: 'Decreto 1077 de 2015, artículo 2.2.6.1.2.2.1. Licencias urbanísticas.'
            },
            {
                codigo: 'solicitud_simit_rut',
                nombre: 'Solicitud SIMIT-RUT',
                categoria: 'informacion_documentos',
                orden: 16,
                dias: 10,
                fundamento: 'Ley 1755 de 2015, artículo 14 numeral 1. Solicitud de documentos e información SIMIT - RUT.'
            }
        ];

        for (const item of nuevos) {
            await pool.query(
                `INSERT INTO tipos_tramite (codigo, nombre, categoria_general, orden, activo)
                 VALUES (?, ?, ?, ?, TRUE)
                 ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), categoria_general = VALUES(categoria_general), orden = VALUES(orden), activo = TRUE`,
                [item.codigo, item.nombre, item.categoria, item.orden]
            );

            const [[tipo]] = await pool.query('SELECT id FROM tipos_tramite WHERE codigo = ?', [item.codigo]);
            const [terminos] = await pool.query('SELECT id FROM terminos_legales WHERE tipo_tramite_id = ?', [tipo.id]);
            if (terminos.length === 0) {
                await pool.query(
                    `INSERT INTO terminos_legales (tipo_tramite_id, dias, tipo_dias, fundamento_legal, vigente_desde)
                     VALUES (?, ?, 'habiles', ?, '2026-01-01')`,
                    [tipo.id, item.dias, item.fundamento]
                );
            }
        }

        console.log('✅ Migración de tipos de trámite ejecutada exitosamente.');
    } catch (error) {
        console.error('❌ Error al actualizar tipos de trámite:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    actualizarTiposTramite()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

module.exports = { actualizarTiposTramite };
