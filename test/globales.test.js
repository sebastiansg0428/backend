const test = require('node:test');
const assert = require('node:assert/strict');
const {
    esGlobalExterno, esGlobalInformativo, puedeVerContenidoGlobal, resumirAsignaciones
} = require('../globales');

test('global externo identifica responsable y conserva global informativo separado', () => {
    assert.equal(esGlobalExterno({ destino_todas_dependencias: 1, tipo_comunicacion: 'Externa', requiere_respuesta: 1, dependencia_responsable_id: 4 }), true);
    assert.equal(esGlobalExterno({ destino_todas_dependencias: 1, tipo_comunicacion: 'Externa', requiere_respuesta: 1 }), false);
    assert.equal(esGlobalInformativo({ destino_todas_dependencias: 1, tipo_comunicacion: 'Interna', requiere_respuesta: 0 }), true);
});

test('contenido global solo es visible para Ventanilla, Administrador y responsable', () => {
    assert.equal(puedeVerContenidoGlobal({ rol: 'ventanilla', dependenciaId: null, responsableId: 4 }), true);
    assert.equal(puedeVerContenidoGlobal({ rol: 'administrador', dependenciaId: null, responsableId: 4 }), true);
    assert.equal(puedeVerContenidoGlobal({ rol: 'funcionario', dependenciaId: 4, responsableId: 4 }), true);
    assert.equal(puedeVerContenidoGlobal({ rol: 'funcionario', dependenciaId: 5, responsableId: 4 }), false);
});

test('resumen global muestra Enteradas/24 y flujo externo único', () => {
    const asignaciones = Array.from({ length: 24 }, (_, indice) => ({
        dependencia_id: indice + 1,
        dependencia_nombre: `Dependencia ${indice + 1}`,
        estado: indice < 7 ? 'Enterado' : 'Recibido'
    }));
    const informativo = resumirAsignaciones(asignaciones, { destino_todas_dependencias: 1, requiere_respuesta: 0 });
    assert.equal(informativo.progreso, '7 / 24');
    assert.equal(informativo.estado_global, 'Pendiente');
    const externo = resumirAsignaciones(asignaciones, {
        destino_todas_dependencias: 1, tipo_comunicacion: 'Externa', requiere_respuesta: 1,
        dependencia_responsable_id: 4, respuesta_disponible: true
    });
    assert.equal(externo.estado_global, 'Respondido');
    assert.equal(externo.dependencia_responsable, 'Dependencia 4');
});

test('resumen externo separa respuesta, enteradas, recibidas y estados de gestion', () => {
    const asignaciones = [
        { dependencia_id: 1, estado: 'Respondido' },
        { dependencia_id: 2, estado: 'Enterado' },
        { dependencia_id: 3, estado: 'Recibido' },
        { dependencia_id: 4, estado: 'En trámite' },
        { dependencia_id: 5, estado: 'Pendiente' },
    ];
    const resumen = resumirAsignaciones(asignaciones, {
        destino_todas_dependencias: 1,
        tipo_comunicacion: 'Externa',
        requiere_respuesta: 1,
        dependencia_responsable_id: 1,
    });
    assert.deepEqual({
        respondidas: resumen.respondidas,
        enteradas: resumen.enteradas,
        recibidas: resumen.recibidas,
        en_tramite: resumen.en_tramite,
        pendientes: resumen.pendientes,
    }, {
        respondidas: 1,
        enteradas: 1,
        recibidas: 1,
        en_tramite: 1,
        pendientes: 1,
    });
});
