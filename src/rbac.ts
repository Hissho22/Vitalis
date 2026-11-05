const toolRoleAccess: Readonly<Record<string, ReadonlySet<string>>> = {
  buscar_paciente_admision: new Set(["Admin", "Admision"]),
  registrar_admision: new Set(["Admin", "Admision"]),
  consultar_historico: new Set(["Admin", "Admision", "Medico"]),
  obtener_expediente_master: new Set(["Admin", "Admision", "Medico"]),
  validar_poliza: new Set(["Admin", "Seguros", "Finanzas"]),
  evaluar_consulta_medica: new Set(["Admin", "Medico"]),
  gestionar_farmacia: new Set(["Admin", "Farmacia"]),
  consultar_catalogo_medicamentos: new Set(["Admin", "Medico", "Farmacia"]),
  consultar_inventario_stock: new Set(["Admin", "Medico", "Farmacia"]),
  registrar_o_actualizar_historico: new Set(["Admin", "Historicos"]),
};

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export function authorizeTool(role: string, toolName: string): void {
  const allowedRoles = toolRoleAccess[toolName];
  if (!allowedRoles) {
    throw new AuthorizationError("La herramienta solicitada no está autorizada.");
  }
  if (!allowedRoles.has(role)) {
    throw new AuthorizationError(`El rol ${role} no está autorizado para ${toolName}.`);
  }
}
