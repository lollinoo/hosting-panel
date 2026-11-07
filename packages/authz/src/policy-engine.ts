import {
  PERMISSION_KEYS,
  PRESET_ROLE_PERMISSIONS,
  isMutatingPermission,
  type PermissionKey,
  type PresetRoleName,
} from "@hosting-panel/contracts";
import type {
  AuthorizationCheckInput,
  AuthorizationDecision,
  AuthorizationResourceTarget,
  CanRemoveOrganizationMemberInput,
  CanRemoveOrganizationMemberResult,
  MembershipRoleBinding,
  PrincipalContext,
  ResourceGrantRecord,
  RoleScopeType,
} from "./types.js";

function isFutureTimestamp(isoTimestamp: string, nowMs: number): boolean {
  const parsedMs = Date.parse(isoTimestamp);
  return !Number.isNaN(parsedMs) && parsedMs > nowMs;
}

function isResourceGrantActive(grant: ResourceGrantRecord, nowMs: number): boolean {
  if (grant.expiresAt === null) {
    return true;
  }
  return isFutureTimestamp(grant.expiresAt, nowMs);
}

function doesRoleBindingMatchScope(
  binding: MembershipRoleBinding,
  resource: AuthorizationResourceTarget | undefined,
): boolean {
  if (binding.scopeType === "organization") {
    return true;
  }

  if (binding.scopeType === "resource") {
    return (
      typeof binding.scopeResourceId === "string" &&
      binding.scopeResourceId.length > 0 &&
      resource !== undefined &&
      resource.id === binding.scopeResourceId
    );
  }

  return false;
}

function doesResourceGrantMatchTarget(
  grant: ResourceGrantRecord,
  organizationId: string,
  principalUserId: string,
  permission: PermissionKey,
  resource: AuthorizationResourceTarget | undefined,
  nowMs: number,
): boolean {
  return (
    grant.organizationId === organizationId &&
    grant.principalUserId === principalUserId &&
    grant.permission === permission &&
    grant.resourceId.length > 0 &&
    resource !== undefined &&
    resource.id === grant.resourceId &&
    isResourceGrantActive(grant, nowMs)
  );
}

export function buildPresetRoleBinding(
  roleName: PresetRoleName,
  scopeType: RoleScopeType = "organization",
  scopeResourceId: string | null = null,
): MembershipRoleBinding {
  const presetPermissions = PRESET_ROLE_PERMISSIONS[roleName];
  if (!presetPermissions) {
    throw new Error(`Unknown preset role: ${String(roleName)}`);
  }

  return {
    roleName,
    permissions: presetPermissions.map((permission) => ({
      permission,
      effect: "allow",
    })),
    scopeType,
    scopeResourceId: scopeType === "resource" ? (scopeResourceId ?? null) : null,
  };
}

export function evaluatePolicy(input: AuthorizationCheckInput): AuthorizationDecision {
  const { principal, permission, organizationId, resource } = input;
  const evaluationDate = input.now ?? new Date();
  const nowMs = evaluationDate.getTime();

  if (Number.isNaN(nowMs)) {
    return {
      allowed: false,
      httpStatus: 403,
      errorCode: "PERMISSION_DENIED",
      reason: "INVALID_EVALUATION_TIME",
    };
  }

  if (principal.userStatus !== "active") {
    return {
      allowed: false,
      httpStatus: 403,
      errorCode: "PERMISSION_DENIED",
      reason: "USER_INACTIVE",
    };
  }

  // Platform/Host checks (organizationId omitted)
  if (organizationId === undefined) {
    const globalRoles = principal.globalRoles ?? [];
    if (globalRoles.length === 0) {
      return {
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "PLATFORM_ROLE_REQUIRED",
      };
    }

    const platformPerms = new Set<PermissionKey>();
    for (const role of globalRoles) {
      const perms = PRESET_ROLE_PERMISSIONS[role] ?? [];
      for (const p of perms) {
        platformPerms.add(p);
      }
    }

    if (platformPerms.has(permission)) {
      return {
        allowed: true,
        httpStatus: 200,
        errorCode: null,
        reason: "PLATFORM_ROLE_ALLOWED",
      };
    }

    return {
      allowed: false,
      httpStatus: 403,
      errorCode: "PERMISSION_DENIED",
      reason: "PLATFORM_PERMISSION_DENIED",
    };
  }

  // Tenant checks (organizationId provided)
  if (organizationId.length === 0) {
    return {
      allowed: false,
      httpStatus: 404,
      errorCode: "NOT_FOUND",
      reason: "TENANT_OR_RESOURCE_NOT_FOUND",
    };
  }

  // Resource cross-tenant mismatch check (AC-F1-02 anti-BOLA)
  if (resource !== undefined && resource.organizationId !== organizationId) {
    return {
      allowed: false,
      httpStatus: 404,
      errorCode: "NOT_FOUND",
      reason: "TENANT_OR_RESOURCE_NOT_FOUND",
    };
  }

  const activeMemberships = principal.memberships.filter(
    (membership) =>
      membership.organizationId === organizationId &&
      membership.membershipStatus === "active",
  );

  const matchingSupportGrants = (principal.supportGrants ?? []).filter(
    (grant) =>
      grant.organizationId === organizationId &&
      grant.operatorUserId === principal.userId,
  );

  const activeSupportGrants = matchingSupportGrants.filter((grant) =>
    isFutureTimestamp(grant.expiresAt, nowMs),
  );

  // Check hosting_admin global role with organization scope
  const isHostingAdmin = (principal.globalRoles ?? []).includes("hosting_admin");
  const hasHostingAdminScope =
    isHostingAdmin &&
    (principal.hostingAdminOrgIds?.includes("*") ||
      principal.hostingAdminOrgIds?.includes(organizationId));

  if (hasHostingAdminScope) {
    const hostingAdminPerms = PRESET_ROLE_PERMISSIONS.hosting_admin;
    if (hostingAdminPerms.includes(permission)) {
      // Check for any explicit deny in resourceGrants/overrides for this principal
      let hasExplicitDeny = false;
      for (const membership of activeMemberships) {
        for (const override of membership.policyOverrides ?? []) {
          if (
            override.organizationId === organizationId &&
            override.permission === permission &&
            override.effect === "deny"
          ) {
            hasExplicitDeny = true;
          }
        }
        for (const grant of membership.resourceGrants) {
          if (
            doesResourceGrantMatchTarget(
              grant,
              organizationId,
              principal.userId,
              permission,
              resource,
              nowMs,
            ) &&
            grant.effect === "deny"
          ) {
            hasExplicitDeny = true;
          }
        }
      }

      if (hasExplicitDeny) {
        return {
          allowed: false,
          httpStatus: 403,
          errorCode: "PERMISSION_DENIED",
          reason: "EXPLICIT_DENY",
        };
      }

      return {
        allowed: true,
        httpStatus: 200,
        errorCode: null,
        reason: "ALLOWED_BY_HOSTING_ADMIN_SCOPE",
      };
    }
  }

  if (activeMemberships.length === 0 && activeSupportGrants.length === 0) {
    if (matchingSupportGrants.length > 0) {
      return {
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "SUPPORT_ACCESS_GRANT_EXPIRED",
      };
    }

    // Non-member without hosting_admin scope or active support grant -> 404 anti-BOLA
    return {
      allowed: false,
      httpStatus: 404,
      errorCode: "NOT_FOUND",
      reason: "TENANT_OR_RESOURCE_NOT_FOUND",
    };
  }

  if (activeMemberships.length > 0) {
    let hasExplicitDeny = false;
    let hasAllow = false;

    for (const membership of activeMemberships) {
      for (const override of membership.policyOverrides ?? []) {
        if (
          override.organizationId === organizationId &&
          override.permission === permission
        ) {
          if (override.effect === "deny") {
            hasExplicitDeny = true;
          } else if (override.effect === "allow") {
            hasAllow = true;
          }
        }
      }

      for (const binding of membership.roleBindings) {
        if (!doesRoleBindingMatchScope(binding, resource)) {
          continue;
        }

        for (const entry of binding.permissions) {
          if (entry.permission === permission) {
            if (entry.effect === "deny") {
              hasExplicitDeny = true;
            } else if (entry.effect === "allow") {
              hasAllow = true;
            }
          }
        }
      }

      for (const grant of membership.resourceGrants) {
        if (
          !doesResourceGrantMatchTarget(
            grant,
            organizationId,
            principal.userId,
            permission,
            resource,
            nowMs,
          )
        ) {
          continue;
        }

        if (grant.effect === "deny") {
          hasExplicitDeny = true;
        } else if (grant.effect === "allow") {
          hasAllow = true;
        }
      }
    }

    if (hasExplicitDeny) {
      return {
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "EXPLICIT_DENY",
      };
    }

    const isCommerciallySuspended = activeMemberships.some(
      (membership) =>
        membership.organizationStatus === "suspended" ||
        membership.organizationStatus === "archived",
    );

    if (isCommerciallySuspended && isMutatingPermission(permission)) {
      const coveredBySupportGrant = activeSupportGrants.some((grant) =>
        grant.permissions.includes(permission),
      );
      if (!coveredBySupportGrant) {
        return {
          allowed: false,
          httpStatus: 403,
          errorCode: "ORGANIZATION_SUSPENDED",
          reason: "ORGANIZATION_SUSPENDED",
        };
      }
    }

    if (hasAllow) {
      return {
        allowed: true,
        httpStatus: 200,
        errorCode: null,
        reason: "ALLOWED_BY_POLICY",
      };
    }
  }

  if (activeSupportGrants.length > 0) {
    const grantedBySupport = activeSupportGrants.some((grant) =>
      grant.permissions.includes(permission),
    );
    if (grantedBySupport) {
      return {
        allowed: true,
        httpStatus: 200,
        errorCode: null,
        reason: "ALLOWED_VIA_SUPPORT_GRANT",
        viaSupportGrant: true,
      };
    }

    return {
      allowed: false,
      httpStatus: 403,
      errorCode: "PERMISSION_DENIED",
      reason: "SUPPORT_ACCESS_PERMISSION_DENIED",
    };
  }

  return {
    allowed: false,
    httpStatus: 403,
    errorCode: "PERMISSION_DENIED",
    reason: "DEFAULT_DENY",
  };
}

export function resolveEffectiveOrgPermissions(
  principal: PrincipalContext,
  organizationId: string,
  now?: Date,
): PermissionKey[] {
  const evaluationDate = now ?? new Date();
  return PERMISSION_KEYS.filter(
    (permission) =>
      evaluatePolicy({
        principal,
        permission,
        organizationId,
        now: evaluationDate,
      }).allowed,
  );
}

export function filterAuthorizedResources<
  T extends { readonly id: string; readonly organizationId: string },
>(
  principal: PrincipalContext,
  organizationId: string,
  permission: PermissionKey,
  resources: readonly T[],
  now?: Date,
): T[] {
  const evaluationDate = now ?? new Date();
  return resources.filter(
    (resource) =>
      evaluatePolicy({
        principal,
        permission,
        organizationId,
        resource: { id: resource.id, organizationId: resource.organizationId },
        now: evaluationDate,
      }).allowed,
  );
}

export function canRemoveOrganizationMember(
  input: CanRemoveOrganizationMemberInput,
): CanRemoveOrganizationMemberResult {
  const isTargetOwner = input.targetRoleNames.includes("customer_owner");
  if (isTargetOwner && !(input.activeOwnerCount > 1)) {
    return {
      allowed: false,
      errorCode: "LAST_OWNER_PROTECTED",
      message: "Cannot remove or demote the last active owner of the organization.",
    };
  }

  return { allowed: true };
}
