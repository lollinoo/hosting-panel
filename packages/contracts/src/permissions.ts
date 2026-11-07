import { z } from "zod";

export const PERMISSION_KEYS = [
  "host.read",
  "host.metrics.read",
  "host.maintenance.read",
  "host.maintenance.execute",
  "host.security.read",
  "host.security.manage",
  "host.docker.read",
  "host.docker.engine.manage",
  "allocation.read",
  "allocation.create",
  "allocation.update",
  "allocation.release",
  "template.read",
  "template.manage",
  "organization.read",
  "organization.members.manage",
  "site.read",
  "site.create",
  "site.update",
  "site.delete",
  "service.read",
  "service.create",
  "service.deploy",
  "service.restart",
  "service.stop",
  "service.delete",
  "service.logs.read",
  "service.configuration.manage",
  "quota.read",
  "quota.manage",
  "operation.read",
  "audit.read",
] as const;

export const PermissionKeySchema = z.enum(PERMISSION_KEYS);
export type PermissionKey = z.infer<typeof PermissionKeySchema>;

export const READ_ONLY_PERMISSION_KEYS = [
  "host.read",
  "host.metrics.read",
  "host.maintenance.read",
  "host.security.read",
  "host.docker.read",
  "allocation.read",
  "template.read",
  "organization.read",
  "site.read",
  "service.read",
  "service.logs.read",
  "quota.read",
  "operation.read",
  "audit.read",
] as const satisfies readonly PermissionKey[];

const READ_ONLY_PERMISSION_SET: ReadonlySet<PermissionKey> = new Set(READ_ONLY_PERMISSION_KEYS);

export function isMutatingPermission(permission: PermissionKey): boolean {
  return !READ_ONLY_PERMISSION_SET.has(permission);
}

export const PRESET_ROLE_NAMES = [
  "infrastructure_admin",
  "hosting_admin",
  "customer_owner",
  "customer_collaborator",
] as const;

export const PresetRoleNameSchema = z.enum(PRESET_ROLE_NAMES);
export type PresetRoleName = z.infer<typeof PresetRoleNameSchema>;

export const PRESET_ROLE_PERMISSIONS: Readonly<Record<PresetRoleName, readonly PermissionKey[]>> =
  Object.freeze({
    infrastructure_admin: Object.freeze<readonly PermissionKey[]>([
      "host.read",
      "host.metrics.read",
      "host.maintenance.read",
      "host.maintenance.execute",
      "host.security.read",
      "host.security.manage",
      "host.docker.read",
      "host.docker.engine.manage",
      "allocation.read",
      "allocation.create",
      "allocation.update",
      "allocation.release",
      "template.read",
      "quota.read",
      "operation.read",
      "audit.read",
    ]),
    hosting_admin: Object.freeze<readonly PermissionKey[]>([
      "host.read",
      "host.metrics.read",
      "host.docker.read",
      "allocation.read",
      "allocation.create",
      "allocation.update",
      "allocation.release",
      "template.read",
      "template.manage",
      "organization.read",
      "site.read",
      "site.create",
      "site.update",
      "site.delete",
      "service.read",
      "service.create",
      "service.deploy",
      "service.restart",
      "service.stop",
      "service.delete",
      "service.logs.read",
      "service.configuration.manage",
      "quota.read",
      "quota.manage",
      "operation.read",
      "audit.read",
    ]),
    customer_owner: Object.freeze<readonly PermissionKey[]>([
      "organization.read",
      "organization.members.manage",
      "template.read",
      "allocation.read",
      "site.read",
      "site.create",
      "site.update",
      "site.delete",
      "service.read",
      "service.create",
      "service.deploy",
      "service.restart",
      "service.stop",
      "service.delete",
      "service.logs.read",
      "service.configuration.manage",
      "quota.read",
      "operation.read",
    ]),
    customer_collaborator: Object.freeze<readonly PermissionKey[]>([
      "organization.read",
      "template.read",
      "quota.read",
      "operation.read",
    ]),
  });

export const GRANT_EFFECTS = ["allow", "deny"] as const;
export const GrantEffectSchema = z.enum(GRANT_EFFECTS);
export type GrantEffect = z.infer<typeof GrantEffectSchema>;
