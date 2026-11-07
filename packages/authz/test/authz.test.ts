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
    globalRoles: overrides.globalRoles ?? [],
    hostingAdminOrgIds: overrides.hostingAdminOrgIds ?? [],
    memberships: overrides.memberships ?? [],
    supportGrants: overrides.supportGrants,
  };
}

describe("@hosting-panel/authz — Platform / Host Route Authorization", () => {
  it("allows infrastructure_admin full host and allocation authority on platform routes", () => {
    const infraAdmin = createPrincipal({
      globalRoles: ["infrastructure_admin"],
    });

    const hostRead = evaluatePolicy({
      principal: infraAdmin,
      permission: "host.read",
      now: NOW,
    });
    expect(hostRead.allowed).toBe(true);
    expect(hostRead.httpStatus).toBe(200);

    const maintExec = evaluatePolicy({
      principal: infraAdmin,
      permission: "host.maintenance.execute",
      now: NOW,
    });
    expect(maintExec.allowed).toBe(true);

    const secManage = evaluatePolicy({
      principal: infraAdmin,
      permission: "host.security.manage",
      now: NOW,
    });
    expect(secManage.allowed).toBe(true);

    const dockerManage = evaluatePolicy({
      principal: infraAdmin,
      permission: "host.docker.engine.manage",
      now: NOW,
    });
    expect(dockerManage.allowed).toBe(true);
  });

  it("strictly enforces AC-F1-03: hosting_admin CANNOT perform host maintenance, security, or docker engine manage", () => {
    const hostingAdmin = createPrincipal({
      globalRoles: ["hosting_admin"],
      hostingAdminOrgIds: ["*"],
    });

    // Allowed platform reading
    expect(
      evaluatePolicy({ principal: hostingAdmin, permission: "host.read", now: NOW }).allowed,
    ).toBe(true);
    expect(
      evaluatePolicy({ principal: hostingAdmin, permission: "host.metrics.read", now: NOW }).allowed,
    ).toBe(true);
    expect(
      evaluatePolicy({ principal: hostingAdmin, permission: "host.docker.read", now: NOW }).allowed,
    ).toBe(true);

    // Strictly DENIED per AC-F1-03
    const maintRead = evaluatePolicy({
      principal: hostingAdmin,
      permission: "host.maintenance.read",
      now: NOW,
    });
    expect(maintRead.allowed).toBe(false);
    expect(maintRead.httpStatus).toBe(403);
    expect(maintRead.errorCode).toBe("PERMISSION_DENIED");

    const maintExec = evaluatePolicy({
      principal: hostingAdmin,
      permission: "host.maintenance.execute",
      now: NOW,
    });
    expect(maintExec.allowed).toBe(false);
    expect(maintExec.httpStatus).toBe(403);

    const secManage = evaluatePolicy({
      principal: hostingAdmin,
      permission: "host.security.manage",
      now: NOW,
    });
    expect(secManage.allowed).toBe(false);
    expect(secManage.httpStatus).toBe(403);

    const dockerManage = evaluatePolicy({
      principal: hostingAdmin,
      permission: "host.docker.engine.manage",
      now: NOW,
    });
    expect(dockerManage.allowed).toBe(false);
    expect(dockerManage.httpStatus).toBe(403);
  });

  it("denies regular customers access to platform routes", () => {
    const customer = createPrincipal({
      globalRoles: [],
      memberships: [
        createMembership({
          organizationId: "org-1",
          roleBindings: [buildPresetRoleBinding("customer_owner")],
        }),
      ],
    });

    const res = evaluatePolicy({
      principal: customer,
      permission: "host.read",
      now: NOW,
    });
    expect(res.allowed).toBe(false);
    expect(res.httpStatus).toBe(403);
  });
});

describe("@hosting-panel/authz — Tenant Boundaries & Anti-BOLA (AC-F1-02)", () => {
  it("returns 404 NOT_FOUND when a customer requests access to an organization they do not belong to", () => {
    const customer = createPrincipal({
      userId: "usr_elena",
      memberships: [
        createMembership({
          organizationId: "org_acme",
          roleBindings: [buildPresetRoleBinding("customer_owner")],
        }),
      ],
    });

    const decision = evaluatePolicy({
      principal: customer,
      permission: "site.read",
      organizationId: "org_beta",
      now: NOW,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.httpStatus).toBe(404);
    expect(decision.errorCode).toBe("NOT_FOUND");
  });

  it("returns 404 NOT_FOUND when resource organizationId does not match request organizationId", () => {
    const customer = createPrincipal({
      userId: "usr_elena",
      memberships: [
        createMembership({
          organizationId: "org_acme",
          roleBindings: [buildPresetRoleBinding("customer_owner")],
        }),
      ],
    });

    const decision = evaluatePolicy({
      principal: customer,
      permission: "site.read",
      organizationId: "org_acme",
      resource: { id: "site_beta_01", organizationId: "org_beta" },
      now: NOW,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.httpStatus).toBe(404);
    expect(decision.errorCode).toBe("NOT_FOUND");
  });

  it("authorizes hosting_admin with scoped organization access", () => {
    const hostingAdmin = createPrincipal({
      userId: "usr_hosting",
      globalRoles: ["hosting_admin"],
      hostingAdminOrgIds: ["org_acme"],
    });

    const acmeDecision = evaluatePolicy({
      principal: hostingAdmin,
      permission: "site.read",
      organizationId: "org_acme",
      now: NOW,
    });
    expect(acmeDecision.allowed).toBe(true);

    const betaDecision = evaluatePolicy({
      principal: hostingAdmin,
      permission: "site.read",
      organizationId: "org_beta",
      now: NOW,
    });
    expect(betaDecision.allowed).toBe(false);
    expect(betaDecision.httpStatus).toBe(404);
  });

  it("does not implicitly grant infrastructure_admin customer site or service access without membership or support grant", () => {
    const infraAdmin = createPrincipal({
      userId: "usr_infra",
      globalRoles: ["infrastructure_admin"],
    });

    const decision = evaluatePolicy({
      principal: infraAdmin,
      permission: "site.read",
      organizationId: "org_acme",
      now: NOW,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.httpStatus).toBe(404);
  });
});

describe("@hosting-panel/authz — ABAC Grants, Overrides & Commercial Suspension", () => {
  it("enforces explicit deny precedence over allow", () => {
    const collaborator = createPrincipal({
      userId: "usr_marco",
      memberships: [
        createMembership({
          organizationId: "org_acme",
          roleBindings: [buildPresetRoleBinding("customer_collaborator")],
          resourceGrants: [
            {
              id: "grant_1",
              organizationId: "org_acme",
              principalUserId: "usr_marco",
              resourceId: "site_shop",
              permission: "site.read",
              effect: "allow",
              expiresAt: null,
            },
            {
              id: "grant_2",
              organizationId: "org_acme",
              principalUserId: "usr_marco",
              resourceId: "site_blog",
              permission: "site.read",
              effect: "deny",
              expiresAt: null,
            },
          ],
        }),
      ],
    });

    const allowDecision = evaluatePolicy({
      principal: collaborator,
      permission: "site.read",
      organizationId: "org_acme",
      resource: { id: "site_shop", organizationId: "org_acme" },
      now: NOW,
    });
    expect(allowDecision.allowed).toBe(true);

    const denyDecision = evaluatePolicy({
      principal: collaborator,
      permission: "site.read",
      organizationId: "org_acme",
      resource: { id: "site_blog", organizationId: "org_acme" },
      now: NOW,
    });
    expect(denyDecision.allowed).toBe(false);
    expect(denyDecision.httpStatus).toBe(403);
    expect(denyDecision.errorCode).toBe("PERMISSION_DENIED");
  });

  it("blocks mutating operations on commercially suspended organization with 403 ORGANIZATION_SUSPENDED (§3.5.5)", () => {
    const suspendedOwner = createPrincipal({
      userId: "usr_giulia",
      memberships: [
        createMembership({
          organizationId: "org_gamma",
          organizationStatus: "suspended",
          roleBindings: [buildPresetRoleBinding("customer_owner")],
        }),
      ],
    });

    // Read is allowed
    const readDecision = evaluatePolicy({
      principal: suspendedOwner,
      permission: "site.read",
      organizationId: "org_gamma",
      now: NOW,
    });
    expect(readDecision.allowed).toBe(true);

    // Mutating is blocked with 403 ORGANIZATION_SUSPENDED
    const mutateDecision = evaluatePolicy({
      principal: suspendedOwner,
      permission: "site.create",
      organizationId: "org_gamma",
      now: NOW,
    });
    expect(mutateDecision.allowed).toBe(false);
    expect(mutateDecision.httpStatus).toBe(403);
    expect(mutateDecision.errorCode).toBe("ORGANIZATION_SUSPENDED");
  });

  it("supports time-boxed support access grant override", () => {
    const operator = createPrincipal({
      userId: "usr_support",
      supportGrants: [
        {
          id: "sup_1",
          organizationId: "org_acme",
          operatorUserId: "usr_support",
          approvedByUserId: "usr_elena",
          permissions: ["site.read", "service.logs.read"],
          expiresAt: FUTURE_ISO,
        },
      ],
    });

    const activeDecision = evaluatePolicy({
      principal: operator,
      permission: "site.read",
      organizationId: "org_acme",
      now: NOW,
    });
    expect(activeDecision.allowed).toBe(true);
    expect(activeDecision.viaSupportGrant).toBe(true);

    const expiredOperator = createPrincipal({
      userId: "usr_support",
      supportGrants: [
        {
          id: "sup_1",
          organizationId: "org_acme",
          operatorUserId: "usr_support",
          approvedByUserId: "usr_elena",
          permissions: ["site.read"],
          expiresAt: PAST_ISO,
        },
      ],
    });

    const expiredDecision = evaluatePolicy({
      principal: expiredOperator,
      permission: "site.read",
      organizationId: "org_acme",
      now: NOW,
    });
    expect(expiredDecision.allowed).toBe(false);
    expect(expiredDecision.httpStatus).toBe(403);
  });
});

describe("@hosting-panel/authz — Utilities & Last Owner Protection", () => {
  it("protects last organization owner from deletion or demotion", () => {
    expect(
      canRemoveOrganizationMember({
        targetRoleNames: ["customer_owner"],
        activeOwnerCount: 1,
      }),
    ).toEqual({
      allowed: false,
      errorCode: "LAST_OWNER_PROTECTED",
      message: "Cannot remove or demote the last active owner of the organization.",
    });

    expect(
      canRemoveOrganizationMember({
        targetRoleNames: ["customer_owner"],
        activeOwnerCount: 2,
      }),
    ).toEqual({ allowed: true });

    expect(
      canRemoveOrganizationMember({
        targetRoleNames: ["customer_collaborator"],
        activeOwnerCount: 1,
      }),
    ).toEqual({ allowed: true });
  });

  it("resolves effective organization permissions and filters authorized resources", () => {
    const owner = createPrincipal({
      memberships: [
        createMembership({
          organizationId: "org_acme",
          roleBindings: [buildPresetRoleBinding("customer_owner")],
        }),
      ],
    });

    const perms = resolveEffectiveOrgPermissions(owner, "org_acme", NOW);
    expect(perms).toContain("organization.read");
    expect(perms).toContain("site.create");
    expect(perms).toContain("service.create");

    const resources = [
      { id: "site_1", organizationId: "org_acme" },
      { id: "site_2", organizationId: "org_beta" },
    ];

    const filtered = filterAuthorizedResources(owner, "org_acme", "site.read", resources, NOW);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe("site_1");
  });
});
