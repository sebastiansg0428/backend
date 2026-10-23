async function revertirTrasError(connection, error, reversionIntentada = false) {
    if (!connection) return { connection, error };
    if (reversionIntentada) {
        connection.destroy();
        return { connection: undefined, error };
    }
    try {
        await connection.rollback();
        return { connection, error };
    } catch (rollbackError) {
        connection.destroy();
        return {
            connection: undefined,
            error: new AggregateError([error, rollbackError], 'Fallo de la operacion y de la reversion de la transaccion.')
        };
    }
}

module.exports = { revertirTrasError };
