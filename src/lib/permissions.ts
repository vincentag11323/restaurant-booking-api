import type { Role } from "../generated/prisma/enums.js";

/** Everything a signed-in caller can be allowed to do. Public routes (availability, menu) need none. */
export type Permission =
  | "profile:own"
  | "reservations:own"
  | "menu:recommendations"
  | "admin:read"
  | "reservation:create_on_behalf"
  | "guest:read_one";

/** The single source of truth for RBAC (security_spec.md §1, agent_spec.md §5.5). */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  USER: ["profile:own", "reservations:own", "menu:recommendations"],
  ADMIN: ["profile:own", "admin:read"],
  // The assistant can book for one guest and read one guest by exact email. Nothing else.
  AGENT: ["reservation:create_on_behalf", "guest:read_one"],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
