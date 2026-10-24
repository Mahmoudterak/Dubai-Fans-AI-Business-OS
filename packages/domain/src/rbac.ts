import { AppError } from "./errors";

export const ROLES = ["owner", "admin", "approver", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "org.read",
  "org.manage",
  "members.manage",
  "agents.read",
  "agents.manage",
  "tasks.read",
  "tasks.create",
  "tasks.cancel",
  "approvals.read",
  "approvals.decide",
  "content.read",
  "content.write",
  "content.publish",
  "audit.read",
  "integrations.read",
  "integrations.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const readAll: Permission[] = [
  "org.read",
  "agents.read",
  "tasks.read",
  "approvals.read",
  "content.read",
  "integrations.read",
];

const grants: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  admin: new Set(PERMISSIONS.filter((p) => p !== "org.manage")),
  approver: new Set<Permission>([
    ...readAll,
    "tasks.create",
    "tasks.cancel",
    "approvals.decide",
    "content.write",
    "content.publish",
    "audit.read",
  ]),
  member: new Set<Permission>([...readAll, "tasks.create", "tasks.cancel", "content.write"]),
  viewer: new Set<Permission>(readAll),
};

export function can(role: Role, permission: Permission): boolean {
  return grants[role].has(permission);
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new AppError("forbidden", `Role "${role}" is missing permission "${permission}"`);
  }
}
