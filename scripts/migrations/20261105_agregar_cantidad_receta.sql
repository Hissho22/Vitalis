IF COL_LENGTH(N'dbo.farmacia', N'cantidad') IS NULL
BEGIN
    ALTER TABLE dbo.farmacia
    ADD cantidad INT NULL;
END;
GO

IF NOT EXISTS (
    SELECT 1
    FROM sys.check_constraints
    WHERE name = N'CK_farmacia_cantidad_positiva'
      AND parent_object_id = OBJECT_ID(N'dbo.farmacia')
)
BEGIN
    ALTER TABLE dbo.farmacia WITH CHECK
    ADD CONSTRAINT CK_farmacia_cantidad_positiva
    CHECK (cantidad IS NULL OR cantidad > 0);
END;
GO
