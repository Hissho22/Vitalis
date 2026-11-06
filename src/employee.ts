import type { EntraIdentity } from "./auth.js";
import { consultarEmpleadoPorEntraId, type Employee } from "./db.js";
import { resolveAdminDomain } from "./config.js";

export type EmployeeLookup = (
  objectId: string,
  includeInactive?: boolean,
) => Promise<Employee | null>;

export const UNAUTHORIZED_ACCOUNT_MESSAGE =
  "Tu cuenta no cuenta con un perfil asignado en Vitalis. Contacta a Administración.";

export function isAdminDomainEmail(
  email: string | undefined,
  domain: string,
): boolean {
  const normalized = email?.trim().toLowerCase() ?? "";
  const separator = normalized.lastIndexOf("@");
  return separator > 0 && normalized.slice(separator + 1) === domain;
}

// Resuelve el empleado activo; las cuentas del dominio corporativo sin alta en SQL operan como Admin.
export async function resolveEmployee(
  identity: Pick<EntraIdentity, "oid" | "name" | "email">,
  lookup: EmployeeLookup = consultarEmpleadoPorEntraId,
  adminDomain: string = resolveAdminDomain(process.env),
): Promise<Employee | null> {
  const stored = await lookup(identity.oid, true);
  if (stored) {
    const active = stored.estatus.trim().toLowerCase() === "activo";
    return active ? stored : null;
  }
  if (!isAdminDomainEmail(identity.email, adminDomain)) return null;
  const email = identity.email!.trim().toLowerCase();
  return {
    id_empleado: "dominio-corporativo",
    entra_object_id: identity.oid,
    nombre: identity.name.trim() || email,
    correo: email,
    rol: "Admin",
    estatus: "Activo",
  };
}
