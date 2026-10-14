-- El estado actual del radicado es suficiente para el flujo de recepción vigente.
ALTER TABLE radicados
    DROP COLUMN tipo_movimiento;
