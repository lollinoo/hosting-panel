import type { GrantEffect, OrganizationStatus, PermissionKey } from "@hosting-panel/contracts";

export type RoleScopeType = "organization" | "resource";

export type MembershipStatus = "active" | "invited" | "suspended" | "revoked";

export type UserStatus = "active" | "suspended";

export interface RolePermissionEntry {
  readonly permission: PermissionKey;
  readonly effect: GrantEffect;
}

export interface MembershipRoleBinding {
  readonly roleName: string;
  readonly permissions: readonly RolePermissionEntry[];
  readonly scopeType: RoleScopeType;
  readonly scopeResourceId?: string | null;
}

export interface ResourceGrantRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly principalUserId: string;
  readonly resourceId: string;
  readonly permission: PermissionKey;
  readonly effect: GrantEffect;
  readonly expiresAt: string | null;
}

export interface PolicyOverrideRecord {
  readonly organizationId: string;
  readonly permission: PermissionKey;
  readonly effect: GrantEffect;
  readonly reason: string;
}

export interface SupportAccessGrantRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly operatorUserId: string;
  readonly approvedByUserId: string;
  readonly permissions: readonly PermissionKey[];
  readonly expiresAt: string;
}

export interface TenantMembershipContext {
  readonly membershipId: string;
  readonly organizationId: string;
  readonly organizationStatus: OrganizationStatus;
  readonly membershipStatus: MembershipStatus;
  readonly roleBindings: readonly MembershipRoleBinding[];
  readonly resourceGrants: readonly ResourceGrantRecord[];
  readonly policyOverrides?: readonly PolicyOverrideRecord[];
}

export interface PrincipalContext {
  readonly userId: string;
  readonly email: string;
  readonly userStatus: UserStatus;
  readonly isPlatformAdmin: boolean;
  readonly memberships: readonly TenantMembershipContext[];
  readonly supportGrants?: readonly SupportAccessGrantRecord[];
}

export interface AuthorizationResourceTarget {
  readonly id: string;
  readonly organizationId: string;
}

export interface AuthorizationCheckInput {
  readonly principal: PrincipalContext;
  readonly permission: PermissionKey;
  readonly organizationId?: string;
  readonly resource?: AuthorizationResourceTarget;
  readonly now?: Date;
}

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly httpStatus: 200 | 403 | 404;
  readonly errorCode: "PERMISSION_DENIED" | "NOT_FOUND" | null;
  readonly reason: string;
  readonly viaSupportGrant?: boolean;
}

export interface CanRemoveOrganizationMemberInput {
  readonly targetRoleNames: readonly string[];
  readonly activeOwnerCount: number;
}

export type CanRemoveOrganizationMemberResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly errorCode: "LAST_OWNER_PROTECTED";
      readonly message: string;
    };
