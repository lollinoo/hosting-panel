import { PRESET_ROLE_PERMISSIONS } from "@hosting-panel/contracts";
import { describe, expect, it } from "vitest";
import {
  buildPresetRoleBinding,
  canRemoveOrganizationMember,
  evaluatePolicy,
  filterAuthorizedResources,
  resolveEffectiveOrgPermissions,
  type PrincipalContext,
  type TenantMembershipContext,
} from "../src/index.js";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const FUTURE_ISO = "2026-11-07T13:00:00.000Z";
const PAST_ISO = "2026-11-07T11:59:59.000Z";

function createMembership(
  overrides: Partial<TenantMembershipContext> & Pick<TenantMembershipContext, "organizationId">,
): TenantMembershipContext {
  return {
    membershipId: overrides.membershipId ?? `mem-${overrides.organizationId}`,
    organizationId: overrides.organizationId,
    organizationStatus: overrides.organizationStatus ?? "active",
    membershipStatus: overrides.membershipStatus ?? "active",
    roleBindings: overrides.roleBindings ?? [],
    resourceGrants: overrides.resourceGrants ?? [],
    policyOverrides: overrides.policyOverrides,
  };
}

function createPrincipal(overrides: Partial<PrincipalContext> = {}): PrincipalContext {
  return {
    userId: overrides.userId ?? "user-1",
    email: overrides.email ?? "user@example.it",
    userStatus: overrides.userStatus ?? "active",
    isPlatformAdmin: overrides.isPlatformAdmin ?? false,
    memberships: overrides.memberships ?? [],
    supportGrants: overrides.supportGrants,
  };
}

describe("@hosting-panel/authz policy engine", () => {
  describe("Default-deny, user status, and global platform.admin checks", () => {
    it("denies inactive/suspended principals with 403 PERMISSION_DENIED even if owner or platform admin", () => {
      const suspendedAdminOwner = createPrincipal({
        userStatus: "suspended",
        isPlatformAdmin: true,
        memberships: [
          createMembership({
            organizationId: "org-1",
            roleBindings: [buildPresetRoleBinding("customer_owner")],
          }),
        ],
      });

      const globalDecision = evaluatePolicy({
        principal: suspendedAdminOwner,
        permission: "platform.admin",
        now: NOW,
      });
      expect(globalDecision).toEqual({
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "USER_INACTIVE",
      });

      const tenantDecision = evaluatePolicy({
        principal: suspendedAdminOwner,
        permission: "organization.read",
        organizationId: "org-1",
        now: NOW,
      });
      expect(tenantDecision).toEqual({
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "USER_INACTIVE",
      });
    });

    it("allows global platform.admin check (no organizationId) ONLY when isPlatformAdmin === true", () => {
      const admin = createPrincipal({ isPlatformAdmin: true });
      const owner = createPrincipal({
        isPlatformAdmin: false,
        memberships: [
          createMembership({
            organizationId: "org-1",
            roleBindings: [buildPresetRoleBinding("customer_owner")],
          }),
        ],
      });

      expect(
        evaluatePolicy({
          principal: admin,
          permission: "platform.admin",
          now: NOW,
        }),
      ).toEqual({
        allowed: true,
        httpStatus: 200,
        errorCode: null,
        reason: "PLATFORM_ADMIN_ALLOWED",
      });

      expect(
        evaluatePolicy({
          principal: owner,
          permission: "platform.admin",
          now: NOW,
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "PLATFORM_ADMIN_REQUIRED",
      });

      // Tenant permissions without organizationId must fail closed even for platform admins
      expect(
        evaluatePolicy({
          principal: admin,
          permission: "application.read",
          now: NOW,
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "ORGANIZATION_CONTEXT_REQUIRED",
      });
    });

    it("fails closed when evaluation timestamp is invalid or role binding has no matching allow", () => {
      const emptyMember = createPrincipal({
        memberships: [createMembership({ organizationId: "org-1", roleBindings: [] })],
      });

      expect(
        evaluatePolicy({
          principal: emptyMember,
          permission: "organization.read",
          organizationId: "org-1",
          now: NOW,
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "DEFAULT_DENY",
      });

      expect(
        evaluatePolicy({
          principal: emptyMember,
          permission: "organization.read",
          organizationId: "org-1",
          now: new Date("invalid-date"),
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "INVALID_EVALUATION_TIME",
      });
    });
  });

  describe("AC-001: Cross-tenant anti-BOLA isolation (404 NOT_FOUND)", () => {
    it("returns 404 NOT_FOUND when a customer member of org-alpha requests org-beta", () => {
      const alphaOwner = createPrincipal({
        userId: "user-alpha",
        memberships: [
          createMembership({
            organizationId: "org-alpha",
            roleBindings: [buildPresetRoleBinding("customer_owner")],
          }),
        ],
      });

      expect(
        evaluatePolicy({
          principal: alphaOwner,
          permission: "organization.read",
          organizationId: "org-beta",
          now: NOW,
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 404,
        errorCode: "NOT_FOUND",
        reason: "TENANT_OR_RESOURCE_NOT_FOUND",
      });
    });

    it("returns 404 NOT_FOUND when resource.organizationId does not match requested organizationId", () => {
      const alphaOwner = createPrincipal({
        userId: "user-alpha",
        memberships: [
          createMembership({
            organizationId: "org-alpha",
            roleBindings: [buildPresetRoleBinding("customer_owner")],
          }),
        ],
      });

      expect(
        evaluatePolicy({
          principal: alphaOwner,
          permission: "application.deploy",
          organizationId: "org-alpha",
          resource: { id: "app-beta-1", organizationId: "org-beta" },
          now: NOW,
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 404,
        errorCode: "NOT_FOUND",
        reason: "TENANT_OR_RESOURCE_NOT_FOUND",
      });
    });

    it("returns 404 NOT_FOUND when membershipStatus is invited, suspended, or revoked", () => {
      for (const membershipStatus of ["invited", "suspended", "revoked"] as const) {
        const nonActiveMember = createPrincipal({
          memberships: [
            createMembership({
              organizationId: "org-alpha",
              membershipStatus,
              roleBindings: [buildPresetRoleBinding("customer_owner")],
            }),
          ],
        });

        expect(
          evaluatePolicy({
            principal: nonActiveMember,
            permission: "organization.read",
            organizationId: "org-alpha",
            now: NOW,
          }),
        ).toEqual({
          allowed: false,
          httpStatus: 404,
          errorCode: "NOT_FOUND",
          reason: "TENANT_OR_RESOURCE_NOT_FOUND",
        });
      }
    });
  });

  describe("AC-002: Multi-organization context switch isolation", () => {
    it("strictly isolates permissions and resources per active organization context", () => {
      const multiOrgUser = createPrincipal({
        userId: "user-multi",
        memberships: [
          createMembership({
            organizationId: "org-owner",
            roleBindings: [buildPresetRoleBinding("customer_owner")],
          }),
          createMembership({
            organizationId: "org-viewer",
            roleBindings: [buildPresetRoleBinding("viewer")],
          }),
        ],
      });

      // Allowed to deploy in org-owner
      expect(
        evaluatePolicy({
          principal: multiOrgUser,
          permission: "application.deploy",
          organizationId: "org-owner",
          resource: { id: "app-owner-1", organizationId: "org-owner" },
          now: NOW,
        }).allowed,
      ).toBe(true);

      // Denied deploy in org-viewer (owner privileges from org-owner do not bleed across orgs)
      expect(
        evaluatePolicy({
          principal: multiOrgUser,
          permission: "application.deploy",
          organizationId: "org-viewer",
          resource: { id: "app-viewer-1", organizationId: "org-viewer" },
          now: NOW,
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "DEFAULT_DENY",
      });

      // Cross-org resource lookup using org-owner path on org-viewer resource returns 404
      expect(
        evaluatePolicy({
          principal: multiOrgUser,
          permission: "application.deploy",
          organizationId: "org-owner",
          resource: { id: "app-viewer-1", organizationId: "org-viewer" },
          now: NOW,
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 404,
        errorCode: "NOT_FOUND",
        reason: "TENANT_OR_RESOURCE_NOT_FOUND",
      });

      expect(resolveEffectiveOrgPermissions(multiOrgUser, "org-owner", NOW)).toEqual(
        expect.arrayContaining([...PRESET_ROLE_PERMISSIONS.customer_owner]),
      );
      expect(resolveEffectiveOrgPermissions(multiOrgUser, "org-viewer", NOW)).toEqual([
        ...PRESET_ROLE_PERMISSIONS.viewer,
      ]);
    });
  });

  describe("AC-003: Viewer least-privilege enforcement (403 on deploy/restart)", () => {
    it("allows viewer read-only inspection while blocking application.deploy and application.restart with 403", () => {
      const viewer = createPrincipal({
        memberships: [
          createMembership({
            organizationId: "org-1",
            roleBindings: [buildPresetRoleBinding("viewer")],
          }),
        ],
      });

      const appResource = { id: "app-1", organizationId: "org-1" };

      expect(
        evaluatePolicy({
          principal: viewer,
          permission: "application.read",
          organizationId: "org-1",
          resource: appResource,
          now: NOW,
        }).allowed,
      ).toBe(true);

      for (const forbiddenPermission of [
        "application.deploy",
        "application.restart",
        "application.stop",
        "application.logs.read",
        "secrets.read",
        "secrets.write",
        "billing.manage",
      ] as const) {
        expect(
          evaluatePolicy({
            principal: viewer,
            permission: forbiddenPermission,
            organizationId: "org-1",
            resource: appResource,
            now: NOW,
          }),
        ).toEqual({
          allowed: false,
          httpStatus: 403,
          errorCode: "PERMISSION_DENIED",
          reason: "DEFAULT_DENY",
        });
      }
    });
  });

  describe("AC-004: Resource-level ABAC scoping and filterAuthorizedResources", () => {
    it("allows a developer scoped to app1 to read/deploy app1 while denying app2 and filtering list results", () => {
      const scopedDeveloper = createPrincipal({
        userId: "dev-1",
        memberships: [
          createMembership({
            organizationId: "org-1",
            roleBindings: [
              {
                roleName: "org_member_base",
                permissions: [{ permission: "organization.read", effect: "allow" }],
                scopeType: "organization",
                scopeResourceId: null,
              },
              buildPresetRoleBinding("developer", "resource", "app-1"),
            ],
          }),
        ],
      });

      const app1 = { id: "app-1", organizationId: "org-1", name: "Portal Web" };
      const app2 = { id: "app-2", organizationId: "org-1", name: "Billing Worker" };
      const foreignApp = { id: "app-3", organizationId: "org-2", name: "Foreign App" };

      // Allowed on app1
      expect(
        evaluatePolicy({
          principal: scopedDeveloper,
          permission: "application.deploy",
          organizationId: "org-1",
          resource: app1,
          now: NOW,
        }),
      ).toEqual({
        allowed: true,
        httpStatus: 200,
        errorCode: null,
        reason: "ALLOWED_BY_POLICY",
      });

      // Denied on app2 within the same organization
      expect(
        evaluatePolicy({
          principal: scopedDeveloper,
          permission: "application.deploy",
          organizationId: "org-1",
          resource: app2,
          now: NOW,
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "DEFAULT_DENY",
      });

      // Org-wide capabilities only include organization.read, NOT application.deploy
      expect(resolveEffectiveOrgPermissions(scopedDeveloper, "org-1", NOW)).toEqual([
        "organization.read",
      ]);

      // List filtering returns only app1
      expect(
        filterAuthorizedResources(
          scopedDeveloper,
          "org-1",
          "application.read",
          [app1, app2, foreignApp],
          NOW,
        ),
      ).toEqual([app1]);
    });

    it("honors non-expired ResourceGrantRecord grants and ignores expired grants", () => {
      const grantee = createPrincipal({
        userId: "dev-grant",
        memberships: [
          createMembership({
            organizationId: "org-1",
            roleBindings: [
              {
                roleName: "org_base",
                permissions: [{ permission: "organization.read", effect: "allow" }],
                scopeType: "organization",
              },
            ],
            resourceGrants: [
              {
                id: "rg-active",
                organizationId: "org-1",
                principalUserId: "dev-grant",
                resourceId: "app-1",
                permission: "application.restart",
                effect: "allow",
                expiresAt: FUTURE_ISO,
              },
              {
                id: "rg-expired",
                organizationId: "org-1",
                principalUserId: "dev-grant",
                resourceId: "app-2",
                permission: "application.restart",
                effect: "allow",
                expiresAt: PAST_ISO,
              },
            ],
          }),
        ],
      });

      expect(
        evaluatePolicy({
          principal: grantee,
          permission: "application.restart",
          organizationId: "org-1",
          resource: { id: "app-1", organizationId: "org-1" },
          now: NOW,
        }).allowed,
      ).toBe(true);

      expect(
        evaluatePolicy({
          principal: grantee,
          permission: "application.restart",
          organizationId: "org-1",
          resource: { id: "app-2", organizationId: "org-1" },
          now: NOW,
        }).allowed,
      ).toBe(false);
    });
  });

  describe("AC-016: Platform admin & time-boxed support access grants", () => {
    it("denies platform admin implicit access to customer tenant without an active SupportAccessGrantRecord", () => {
      const platformAdmin = createPrincipal({
        userId: "admin-1",
        isPlatformAdmin: true,
        memberships: [],
      });

      expect(
        evaluatePolicy({
          principal: platformAdmin,
          permission: "application.read",
          organizationId: "org-customer",
          resource: { id: "app-1", organizationId: "org-customer" },
          now: NOW,
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "SUPPORT_ACCESS_GRANT_REQUIRED",
      });
    });

    it("allows platform admin / support operator ONLY for granted permissions within TTL, never secrets without explicit inclusion, and denies once TTL expires", () => {
      const supportOperator = createPrincipal({
        userId: "admin-1",
        isPlatformAdmin: true,
        memberships: [],
        supportGrants: [
          {
            id: "sg-1",
            organizationId: "org-customer",
            operatorUserId: "admin-1",
            approvedByUserId: "owner-customer",
            permissions: ["organization.read", "application.read", "application.logs.read"],
            expiresAt: FUTURE_ISO,
          },
        ],
      });

      // Allowed for explicitly included read permission within TTL
      expect(
        evaluatePolicy({
          principal: supportOperator,
          permission: "application.read",
          organizationId: "org-customer",
          resource: { id: "app-1", organizationId: "org-customer" },
          now: NOW,
        }),
      ).toEqual({
        allowed: true,
        httpStatus: 200,
        errorCode: null,
        reason: "ALLOWED_VIA_SUPPORT_GRANT",
        viaSupportGrant: true,
      });

      // Never allows secrets.read or secrets.write without explicit inclusion
      for (const secretPerm of ["secrets.read", "secrets.write"] as const) {
        expect(
          evaluatePolicy({
            principal: supportOperator,
            permission: secretPerm,
            organizationId: "org-customer",
            now: NOW,
          }),
        ).toEqual({
          allowed: false,
          httpStatus: 403,
          errorCode: "PERMISSION_DENIED",
          reason: "SUPPORT_ACCESS_PERMISSION_DENIED",
        });
      }

      // Cross-tenant resource mismatch still yields 404 NOT_FOUND
      expect(
        evaluatePolicy({
          principal: supportOperator,
          permission: "application.read",
          organizationId: "org-customer",
          resource: { id: "app-other", organizationId: "org-other" },
          now: NOW,
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 404,
        errorCode: "NOT_FOUND",
        reason: "TENANT_OR_RESOURCE_NOT_FOUND",
      });

      // Effective permissions during valid support window match exact support grant
      expect(resolveEffectiveOrgPermissions(supportOperator, "org-customer", NOW)).toEqual([
        "organization.read",
        "application.read",
        "application.logs.read",
      ]);

      // Once TTL expires (exact boundary and after), access is revoked immediately
      const atExpiry = new Date(FUTURE_ISO);
      expect(
        evaluatePolicy({
          principal: supportOperator,
          permission: "application.read",
          organizationId: "org-customer",
          now: atExpiry,
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "SUPPORT_ACCESS_GRANT_EXPIRED",
      });

      expect(resolveEffectiveOrgPermissions(supportOperator, "org-customer", atExpiry)).toEqual([]);
    });
  });

  describe("AC-021: Commercial suspension enforcement", () => {
    it("blocks mutating permissions except billing.manage on suspended/cancelled organizations while allowing read permissions", () => {
      for (const organizationStatus of ["suspended", "cancelled"] as const) {
        const suspendedOwner = createPrincipal({
          memberships: [
            createMembership({
              organizationId: "org-suspended",
              organizationStatus,
              roleBindings: [buildPresetRoleBinding("customer_owner")],
            }),
          ],
        });

        // Read permissions remain allowed
        for (const readPermission of [
          "billing.read",
          "organization.read",
          "application.read",
          "database.read",
          "operation.read",
          "quota.read",
          "audit.read",
        ] as const) {
          expect(
            evaluatePolicy({
              principal: suspendedOwner,
              permission: readPermission,
              organizationId: "org-suspended",
              now: NOW,
            }).allowed,
          ).toBe(true);
        }

        // billing.manage remains allowed so owner/billing_manager can resolve suspension
        expect(
          evaluatePolicy({
            principal: suspendedOwner,
            permission: "billing.manage",
            organizationId: "org-suspended",
            now: NOW,
          }),
        ).toEqual({
          allowed: true,
          httpStatus: 200,
          errorCode: null,
          reason: "ALLOWED_BY_POLICY",
        });

        // Mutating operational permissions are blocked with ORGANIZATION_SUSPENDED
        for (const mutatingPermission of [
          "application.deploy",
          "application.restart",
          "server.provision",
          "database.create",
          "domain.manage",
          "secrets.write",
        ] as const) {
          expect(
            evaluatePolicy({
              principal: suspendedOwner,
              permission: mutatingPermission,
              organizationId: "org-suspended",
              now: NOW,
            }),
          ).toEqual({
            allowed: false,
            httpStatus: 403,
            errorCode: "PERMISSION_DENIED",
            reason: "ORGANIZATION_SUSPENDED",
          });
        }

        const effective = resolveEffectiveOrgPermissions(suspendedOwner, "org-suspended", NOW);
        expect(effective).toContain("billing.manage");
        expect(effective).toContain("billing.read");
        expect(effective).toContain("organization.read");
        expect(effective).not.toContain("application.deploy");
        expect(effective).not.toContain("application.restart");
      }
    });

    it("continues allowing mutating permissions when organizationStatus is past_due", () => {
      const pastDueOwner = createPrincipal({
        memberships: [
          createMembership({
            organizationId: "org-past-due",
            organizationStatus: "past_due",
            roleBindings: [buildPresetRoleBinding("customer_owner")],
          }),
        ],
      });

      expect(
        evaluatePolicy({
          principal: pastDueOwner,
          permission: "application.deploy",
          organizationId: "org-past-due",
          now: NOW,
        }).allowed,
      ).toBe(true);
    });
  });

  describe("AC-022: Last owner removal protection (canRemoveOrganizationMember)", () => {
    it("blocks removing the last active customer_owner with LAST_OWNER_PROTECTED", () => {
      const singleOwnerRemoval = canRemoveOrganizationMember({
        targetRoleNames: ["customer_owner"],
        activeOwnerCount: 1,
      });
      expect(singleOwnerRemoval).toEqual({
        allowed: false,
        errorCode: "LAST_OWNER_PROTECTED",
        message: expect.any(String),
      });

      const multiRoleLastOwnerRemoval = canRemoveOrganizationMember({
        targetRoleNames: ["developer", "customer_owner"],
        activeOwnerCount: 1,
      });
      expect(multiRoleLastOwnerRemoval.allowed).toBe(false);
    });

    it("allows removing a customer_owner when at least 2 active owners exist, or removing non-owners", () => {
      expect(
        canRemoveOrganizationMember({
          targetRoleNames: ["customer_owner"],
          activeOwnerCount: 2,
        }),
      ).toEqual({ allowed: true });

      expect(
        canRemoveOrganizationMember({
          targetRoleNames: ["hosting_manager", "developer"],
          activeOwnerCount: 1,
        }),
      ).toEqual({ allowed: true });
    });
  });

  describe("HCP-SPEC-001 §1.3: Explicit deny precedence over allow", () => {
    it("enforces explicit deny in policyOverrides over customer_owner allow and resourceGrants allow", () => {
      const ownerWithOverrideDeny = createPrincipal({
        userId: "owner-1",
        memberships: [
          createMembership({
            organizationId: "org-1",
            roleBindings: [buildPresetRoleBinding("customer_owner")],
            resourceGrants: [
              {
                id: "rg-allow",
                organizationId: "org-1",
                principalUserId: "owner-1",
                resourceId: "app-1",
                permission: "application.delete",
                effect: "allow",
                expiresAt: null,
              },
            ],
            policyOverrides: [
              {
                organizationId: "org-1",
                permission: "application.delete",
                effect: "deny",
                reason: "Deletion locked by compliance hold",
              },
            ],
          }),
        ],
      });

      expect(
        evaluatePolicy({
          principal: ownerWithOverrideDeny,
          permission: "application.delete",
          organizationId: "org-1",
          resource: { id: "app-1", organizationId: "org-1" },
          now: NOW,
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "EXPLICIT_DENY",
      });
    });

    it("enforces explicit deny in matching roleBindings and active resourceGrants over allow", () => {
      const managerWithResourceDeny = createPrincipal({
        userId: "mgr-1",
        memberships: [
          createMembership({
            organizationId: "org-1",
            roleBindings: [
              buildPresetRoleBinding("hosting_manager"),
              {
                roleName: "no_secrets_write",
                permissions: [{ permission: "secrets.write", effect: "deny" }],
                scopeType: "organization",
              },
            ],
            resourceGrants: [
              {
                id: "rg-deny-app1",
                organizationId: "org-1",
                principalUserId: "mgr-1",
                resourceId: "app-1",
                permission: "application.deploy",
                effect: "deny",
                expiresAt: FUTURE_ISO,
              },
            ],
          }),
        ],
      });

      // Org-level roleBinding explicit deny wins over hosting_manager allow
      expect(
        evaluatePolicy({
          principal: managerWithResourceDeny,
          permission: "secrets.write",
          organizationId: "org-1",
          now: NOW,
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "EXPLICIT_DENY",
      });

      // Resource-level explicit deny on app-1 wins over hosting_manager allow while active
      expect(
        evaluatePolicy({
          principal: managerWithResourceDeny,
          permission: "application.deploy",
          organizationId: "org-1",
          resource: { id: "app-1", organizationId: "org-1" },
          now: NOW,
        }),
      ).toEqual({
        allowed: false,
        httpStatus: 403,
        errorCode: "PERMISSION_DENIED",
        reason: "EXPLICIT_DENY",
      });

      // app-2 is unaffected by app-1's resource deny
      expect(
        evaluatePolicy({
          principal: managerWithResourceDeny,
          permission: "application.deploy",
          organizationId: "org-1",
          resource: { id: "app-2", organizationId: "org-1" },
          now: NOW,
        }).allowed,
      ).toBe(true);

      // Once app-1's temporary deny resourceGrant expires, hosting_manager allow applies again
      expect(
        evaluatePolicy({
          principal: managerWithResourceDeny,
          permission: "application.deploy",
          organizationId: "org-1",
          resource: { id: "app-1", organizationId: "org-1" },
          now: new Date(FUTURE_ISO),
        }).allowed,
      ).toBe(true);
    });
  });
});
