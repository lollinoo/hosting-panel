import {
  findForbiddenPublicDtoKeys,
  type ApiErrorEnvelope,
  type AuditEventDto,
  type DevPersonaDto,
  type HostAllocationDto,
  type HostDto,
  type MeDto,
  type MemberDto,
  type OrganizationCapabilitiesDto,
  type OrganizationSummaryDto,
  type QuotaReservationDto,
  type ServiceTemplateDto,
  type SiteDetailDto,
  type StackRevisionDto,
} from "@hosting-panel/contracts";
import { DEMO_IDS } from "@hosting-panel/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createControlPlaneApp,
  type ControlPlaneAppHandle,
} from "../src/index.js";

interface HttpJsonResult<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
  readonly rawText: string;
}

function assertZeroLeaks(
  payload: unknown,
  options?: { readonly allowAccessTokenKey?: boolean },
): void {
  if (!options?.allowAccessTokenKey) {
    const forbidden = findForbiddenPublicDtoKeys(payload);
    expect(forbidden).toEqual([]);
  }
}

describe("Control-Plane /v1 API Phase 1 Docker-Native Integration Suite (Unit B)", () => {
  let app: ControlPlaneAppHandle;
  let baseUrl: string;
  const tokens: Record<string, string> = {};

  async function requestJson<T = Record<string, unknown>>(
    path: string,
    init?: {
      readonly method?: string;
      readonly token?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: unknown;
      readonly allowAccessTokenKey?: boolean;
    },
  ): Promise<HttpJsonResult<T>> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    };
    if (init?.token) {
      headers["Authorization"] = `Bearer ${init.token}`;
    }
    if (init?.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(`${baseUrl}${path}`, {
      method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

    const rawText = await res.text();
    let body: unknown = null;
    if (rawText.length > 0) {
      try {
        body = JSON.parse(rawText);
      } catch {
        body = rawText;
      }
    }

    assertZeroLeaks(body, { allowAccessTokenKey: init?.allowAccessTokenKey });

    return {
      status: res.status,
      headers: res.headers,
      body: body as T,
      rawText,
    };
  }

  beforeAll(async () => {
    app = await createControlPlaneApp({
      host: "127.0.0.1",
      port: 0,
      listen: true,
      enableDevOidc: true,
    });
    expect(app.baseUrl).not.toBeNull();
    baseUrl = app.baseUrl!;

    // Obtain JWT Bearer tokens for all 5 seeded personas
    const personas = ["usr_infra", "usr_hosting", "usr_elena", "usr_marco", "usr_giulia"];
    for (const personaId of personas) {
      const res = await requestJson<{ data: { accessToken: string } }>(
        "/v1/dev/auth/token",
        {
          method: "POST",
          body: { userId: personaId },
          allowAccessTokenKey: true,
        },
      );
      expect(res.status).toBe(200);
      tokens[personaId] = res.body.data.accessToken;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  // 1. Health Probes
  describe("Health Probes", () => {
    it("GET /health/live returns ok with HCP-SPEC-002 phase-1 metadata", async () => {
      const res = await requestJson<{
        status: string;
        service: string;
        spec: string;
        phase: string;
        timestamp: string;
      }>("/health/live");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.service).toBe("hosting-panel-api");
      expect(res.body.spec).toBe("HCP-SPEC-002");
      expect(res.body.phase).toBe("phase-1");
      expect(res.body.timestamp).toBeDefined();
    });

    it("GET /health/ready verifies database connectivity", async () => {
      const res = await requestJson<{
        status: string;
        database: string;
        mode: string;
        timestamp: string;
      }>("/health/ready");

      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ready");
      expect(res.body.database).toBe("up");
      expect(res.body.mode).toBe("pglite");
    });
  });

  // 2. Auth & Dev OIDC
  describe("Auth & Dev OIDC", () => {
    it("GET /v1/dev/auth/personas returns the 5 seeded personas", async () => {
      const res = await requestJson<{ data: DevPersonaDto[] }>("/v1/dev/auth/personas");
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(5);
      const ids = res.body.data.map((p) => p.id);
      expect(ids).toContain(DEMO_IDS.users.infra);
      expect(ids).toContain(DEMO_IDS.users.hosting);
      expect(ids).toContain(DEMO_IDS.users.elena);
      expect(ids).toContain(DEMO_IDS.users.marco);
      expect(ids).toContain(DEMO_IDS.users.giulia);
    });

    it("POST /v1/auth/revoke immediately revokes active token jti", async () => {
      // Issue a disposable token
      const tokenRes = await requestJson<{ data: { accessToken: string } }>(
        "/v1/dev/auth/token",
        {
          method: "POST",
          body: { userId: DEMO_IDS.users.elena },
          allowAccessTokenKey: true,
        },
      );
      const disposableToken = tokenRes.body.data.accessToken;

      // Authenticated call succeeds before revocation
      const beforeRes = await requestJson<MeDto>("/v1/me", {
        token: disposableToken,
      });
      expect(beforeRes.status).toBe(200);

      // Revoke token
      const revokeRes = await requestJson<{ data: { revoked: boolean } }>(
        "/v1/auth/revoke",
        {
          method: "POST",
          token: disposableToken,
        },
      );
      expect(revokeRes.status).toBe(200);
      expect(revokeRes.body.data.revoked).toBe(true);

      // Subsequent call fails with 401 UNAUTHENTICATED
      const afterRes = await requestJson<ApiErrorEnvelope>("/v1/me", {
        token: disposableToken,
      });
      expect(afterRes.status).toBe(401);
      expect(afterRes.body.error.code).toBe("UNAUTHENTICATED");
    });
  });

  // 3. Identity (/v1/me)
  describe("Identity (/v1/me)", () => {
    it("GET /v1/me returns principal identity, globalRoles, memberships, and platform capabilities", async () => {
      const res = await requestJson<{ data: MeDto }>("/v1/me", {
        token: tokens[DEMO_IDS.users.elena],
      });
      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(DEMO_IDS.users.elena);
      expect(res.body.data.memberships.length).toBeGreaterThanOrEqual(1);

      // Platform capabilities all false in Phase 1 per AC-F1-10
      const caps = res.body.data.platformCapabilities;
      expect(caps.phase).toBe("phase-1");
      expect(caps.hostingMode).toBe("dedicated");
      expect(caps.sharedHostingEnabled).toBe(false);
      expect(caps.dockerExecutorRuntimeAvailable).toBe(false);
      expect(caps.hostAgentRuntimeAvailable).toBe(false);
      expect(caps.acmeTlsRuntimeAvailable).toBe(false);
      expect(caps.sftpAvailable).toBe(false);
      expect(caps.productionBackupRuntimeAvailable).toBe(false);
    });

    it("GET /v1/me/organizations returns paginated organization summaries", async () => {
      const res = await requestJson<{ data: OrganizationSummaryDto[] }>(
        "/v1/me/organizations",
        {
          token: tokens[DEMO_IDS.users.elena],
        },
      );
      expect(res.status).toBe(200);
      const slugs = res.body.data.map((o) => o.slug);
      expect(slugs).toContain("acme-srl");
    });
  });

  // 4. AC-F1-01: Dedicated Host Single-Customer Placement Invariant
  describe("AC-F1-01: Dedicated Host Placement Invariant", () => {
    it("rejects allocating an occupied dedicated host to a different customer org with 409 DEDICATED_HOST_OCCUPIED", async () => {
      // Host hst_ded_acme is already occupied by org_acme
      const res = await requestJson<ApiErrorEnvelope>(
        `/v1/hosts/${DEMO_IDS.hosts.acme}/allocations`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.infra],
          body: {
            organizationId: DEMO_IDS.organizations.beta,
            hostingMode: "dedicated",
          },
        },
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("DEDICATED_HOST_OCCUPIED");
    });

    it("allows allocating an unallocated dedicated host node to a customer org", async () => {
      // Host hst_ded_free is unallocated
      const res = await requestJson<{ data: HostAllocationDto }>(
        `/v1/hosts/${DEMO_IDS.hosts.free}/allocations`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.infra],
          body: {
            organizationId: DEMO_IDS.organizations.beta,
            hostingMode: "dedicated",
          },
        },
      );
      expect(res.status).toBe(201);
      expect(res.body.data.hostId).toBe(DEMO_IDS.hosts.free);
      expect(res.body.data.organizationId).toBe(DEMO_IDS.organizations.beta);
    });
  });

  // 5. AC-F1-02: Anti-BOLA Cross-Tenant Isolation & ABAC Resource Grants
  describe("AC-F1-02: Anti-BOLA Tenant Isolation & ABAC Resource Grants", () => {
    it("enforces that InfrastructureAdmin lacks implicit tenant read (returns 404 NOT_FOUND)", async () => {
      const res = await requestJson<ApiErrorEnvelope>(
        `/v1/organizations/${DEMO_IDS.organizations.acme}`,
        {
          token: tokens[DEMO_IDS.users.infra],
        },
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    });

    it("returns 404 NOT_FOUND when customer accesses resources of another tenant org (anti-BOLA)", async () => {
      // 1. Non-member access: Giulia (only member of org_gamma) tries to access Acme site -> 404 NOT_FOUND
      const nonMemberRes = await requestJson<ApiErrorEnvelope>(
        `/v1/organizations/${DEMO_IDS.organizations.acme}/sites/${DEMO_IDS.sites.acmeShop}`,
        {
          token: tokens[DEMO_IDS.users.giulia],
        },
      );
      expect(nonMemberRes.status).toBe(404);
      expect(nonMemberRes.body.error.code).toBe("NOT_FOUND");

      // 2. Cross-tenant resource mismatch: site_acme_shop requested under org_beta -> 404 NOT_FOUND
      const mismatchRes = await requestJson<ApiErrorEnvelope>(
        `/v1/organizations/${DEMO_IDS.organizations.beta}/sites/${DEMO_IDS.sites.acmeShop}`,
        {
          token: tokens[DEMO_IDS.users.elena],
        },
      );
      expect(mismatchRes.status).toBe(404);
      expect(mismatchRes.body.error.code).toBe("NOT_FOUND");
    });

    it("enforces granular ABAC resource grant: Marco can read site_acme_shop (allow) but denied on site_acme_blog (403)", async () => {
      // Marco has allow grant on site_acme_shop
      const shopRes = await requestJson<{ data: SiteDetailDto }>(
        `/v1/organizations/${DEMO_IDS.organizations.acme}/sites/${DEMO_IDS.sites.acmeShop}`,
        {
          token: tokens[DEMO_IDS.users.marco],
        },
      );
      expect(shopRes.status).toBe(200);
      expect(shopRes.body.data.id).toBe(DEMO_IDS.sites.acmeShop);

      // Marco has explicit deny grant on site_acme_blog
      const blogRes = await requestJson<ApiErrorEnvelope>(
        `/v1/organizations/${DEMO_IDS.organizations.acme}/sites/${DEMO_IDS.sites.acmeBlog}`,
        {
          token: tokens[DEMO_IDS.users.marco],
        },
      );
      expect(blogRes.status).toBe(403);
      expect(blogRes.body.error.code).toBe("PERMISSION_DENIED");
    });
  });

  // 6. AC-F1-03: HostingAdmin Authority Boundaries & Audit Logging
  describe("AC-F1-03: HostingAdmin Authority Boundaries", () => {
    it("allows HostingAdmin host.read, template management, and tenant administration", async () => {
      // HostingAdmin can read hosts
      const hostsRes = await requestJson<{ data: HostDto[] }>("/v1/hosts", {
        token: tokens[DEMO_IDS.users.hosting],
      });
      expect(hostsRes.status).toBe(200);

      // HostingAdmin can read templates
      const tplRes = await requestJson<{ data: ServiceTemplateDto[] }>("/v1/service-templates", {
        token: tokens[DEMO_IDS.users.hosting],
      });
      expect(tplRes.status).toBe(200);

      // HostingAdmin can create templates
      const createTplRes = await requestJson<{ data: ServiceTemplateDto }>(
        "/v1/service-templates",
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.hosting],
          body: {
            name: "PostgreSQL 17 Alpine",
            slug: `postgres-17-${Date.now()}`,
            category: "database",
            defaultImage: "postgres:17-alpine",
            defaultPort: 5432,
          },
        },
      );
      expect(createTplRes.status).toBe(201);
    });

    it("strictly denies HostingAdmin host mode modification with 403 and records audit event", async () => {
      const res = await requestJson<ApiErrorEnvelope>(
        `/v1/hosts/${DEMO_IDS.hosts.acme}/mode`,
        {
          method: "PATCH",
          token: tokens[DEMO_IDS.users.hosting],
          body: { hostingMode: "dedicated" },
        },
      );
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
    });

    it("strictly denies HostingAdmin host maintenance execution with 403 and records audit event", async () => {
      const res = await requestJson<ApiErrorEnvelope>(
        `/v1/hosts/${DEMO_IDS.hosts.acme}/maintenance`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.hosting],
          body: { action: "collect_diagnostics" },
        },
      );
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
    });

    it("strictly denies HostingAdmin host security posture management with 403", async () => {
      const res = await requestJson<ApiErrorEnvelope>(
        `/v1/hosts/${DEMO_IDS.hosts.acme}/security`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.hosting],
          body: { policyRef: "sec_policy_standard" },
        },
      );
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
    });

    it("verifies audit trail contains denied security events", async () => {
      const auditRes = await requestJson<{ data: AuditEventDto[] }>("/v1/admin/audit", {
        token: tokens[DEMO_IDS.users.infra],
      });
      expect(auditRes.status).toBe(200);
      const deniedEvents = auditRes.body.data.filter((e) => e.details?.outcome === "denied");
      expect(deniedEvents.length).toBeGreaterThan(0);
    });
  });

  // 7. AC-F1-04 & F1-012: Declarative Stack Security & Plaintext Secret Rejection
  describe("AC-F1-04 & F1-012: Declarative Stack Security & Secret Scrubber", () => {
    it("rejects forbidden Docker attributes (privileged, hostPath, dockerSocket, networkMode: host) with 403 HOST_POLICY_DENIED", async () => {
      const siteId = DEMO_IDS.sites.acmeShop;
      const orgId = DEMO_IDS.organizations.acme;

      // 1. privileged: true
      const privilegedRes = await requestJson<ApiErrorEnvelope>(
        `/v1/organizations/${orgId}/sites/${siteId}/services`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.elena],
          headers: { "Idempotency-Key": `idemp_priv_${Date.now()}` },
          body: {
            serviceTemplateId: DEMO_IDS.templates.nodejs,
            name: "Privileged Insecure App",
            configuration: { privileged: true },
          },
        },
      );
      expect(privilegedRes.status).toBe(403);
      expect(privilegedRes.body.error.code).toBe("HOST_POLICY_DENIED");

      // 2. /var/run/docker.sock mount
      const sockRes = await requestJson<ApiErrorEnvelope>(
        `/v1/organizations/${orgId}/sites/${siteId}/services`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.elena],
          headers: { "Idempotency-Key": `idemp_sock_${Date.now()}` },
          body: {
            serviceTemplateId: DEMO_IDS.templates.nodejs,
            name: "Docker Socket App",
            configuration: { socket: "/var/run/docker.sock" },
          },
        },
      );
      expect(sockRes.status).toBe(403);
      expect(sockRes.body.error.code).toBe("HOST_POLICY_DENIED");

      // 3. networkMode: host
      const netRes = await requestJson<ApiErrorEnvelope>(
        `/v1/organizations/${orgId}/sites/${siteId}/services`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.elena],
          headers: { "Idempotency-Key": `idemp_net_${Date.now()}` },
          body: {
            serviceTemplateId: DEMO_IDS.templates.nodejs,
            name: "Host Network App",
            configuration: { networkMode: "host" },
          },
        },
      );
      expect(netRes.status).toBe(403);
      expect(netRes.body.error.code).toBe("HOST_POLICY_DENIED");
    });

    it("rejects plaintext secrets in configuration with 400 VALIDATION_ERROR (F1-012)", async () => {
      const siteId = DEMO_IDS.sites.acmeShop;
      const orgId = DEMO_IDS.organizations.acme;

      const res = await requestJson<ApiErrorEnvelope>(
        `/v1/organizations/${orgId}/sites/${siteId}/services`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.elena],
          headers: { "Idempotency-Key": `idemp_sec_${Date.now()}` },
          body: {
            serviceTemplateId: DEMO_IDS.templates.mariadb,
            name: "Plaintext Secret DB",
            configuration: { password: "supersecretpassword123!" },
          },
        },
      );
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.message).toContain("Plaintext secret keys detected");
    });
  });

  // 8. AC-F1-05, F1-004 & F1-005: Multi-Service Aggregation & Drift Reporting
  describe("AC-F1-05, F1-004 & F1-005: Site Aggregation & Non-Destructive Drift", () => {
    it("aggregates multi-service site_acme_shop into composite detail with in_sync drift summary (F1-004)", async () => {
      const res = await requestJson<{ data: SiteDetailDto }>(
        `/v1/organizations/${DEMO_IDS.organizations.acme}/sites/${DEMO_IDS.sites.acmeShop}`,
        {
          token: tokens[DEMO_IDS.users.elena],
        },
      );
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(DEMO_IDS.sites.acmeShop);
      expect(res.body.data.services).toHaveLength(3); // WordPress + MariaDB + Redis
      expect(res.body.data.domains).toHaveLength(1);
      expect(res.body.data.status).toBe("ready");
      expect(res.body.data.driftSummary.overallDriftStatus).toBe("in_sync");
      expect(res.body.data.driftSummary.inSyncCount).toBe(3);
      expect(res.body.data.driftSummary.driftedCount).toBe(0);
    });

    it("reports drifted site_acme_blog as degraded with non-destructive drift summary (F1-005)", async () => {
      const res = await requestJson<{ data: SiteDetailDto }>(
        `/v1/organizations/${DEMO_IDS.organizations.acme}/sites/${DEMO_IDS.sites.acmeBlog}`,
        {
          token: tokens[DEMO_IDS.users.elena],
        },
      );
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(DEMO_IDS.sites.acmeBlog);
      expect(res.body.data.status).toBe("degraded");
      expect(res.body.data.driftSummary.overallDriftStatus).toBe("drifted");
      expect(res.body.data.driftSummary.driftedCount).toBe(1); // WordPress drifted out-of-band
      expect(res.body.data.driftSummary.inSyncCount).toBe(1); // MariaDB in sync
    });

    it("appends immutable StackRevision N+1 with specHash while preserving previous revisions", async () => {
      const orgId = DEMO_IDS.organizations.acme;
      const svcId = DEMO_IDS.services.acmeShopWp;

      // Get initial revision list
      const listBefore = await requestJson<{ data: StackRevisionDto[] }>(
        `/v1/organizations/${orgId}/services/${svcId}/revisions`,
        {
          token: tokens[DEMO_IDS.users.elena],
        },
      );
      expect(listBefore.status).toBe(200);
      const initialCount = listBefore.body.data.length;

      // Append revision #2
      const appendRes = await requestJson<{ data: StackRevisionDto }>(
        `/v1/organizations/${orgId}/services/${svcId}/revisions`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.elena],
          headers: { "Idempotency-Key": `idemp_rev_${Date.now()}` },
          body: {
            declarativeConfig: {
              WP_HOME: "https://negozio.acme.it",
              DB_NAME: "shop",
              WP_DEBUG: "false",
            },
            secretRefs: { DB_PASSWORD: "vault://acme/db/password" },
          },
        },
      );
      expect(appendRes.status).toBe(201);
      expect(appendRes.body.data.revisionNumber).toBe(initialCount + 1);
      expect(appendRes.body.data.specHash).toMatch(/^[a-f0-9]{64}$/);

      // Verify list now has N+1 revisions
      const listAfter = await requestJson<{ data: StackRevisionDto[] }>(
        `/v1/organizations/${orgId}/services/${svcId}/revisions`,
        {
          token: tokens[DEMO_IDS.users.elena],
        },
      );
      expect(listAfter.status).toBe(200);
      expect(listAfter.body.data.length).toBe(initialCount + 1);
    });
  });

  // 9. AC-F1-06: Direct dedicated -> shared Transition Gating
  describe("AC-F1-06: Host Mode Transition Gating", () => {
    it("rejects PATCH /v1/hosts/:hostId/mode to shared with 409 SHARED_MODE_GATED", async () => {
      const res = await requestJson<ApiErrorEnvelope>(
        `/v1/hosts/${DEMO_IDS.hosts.acme}/mode`,
        {
          method: "PATCH",
          token: tokens[DEMO_IDS.users.infra],
          body: { hostingMode: "shared" },
        },
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("SHARED_MODE_GATED");
    });

    it("permits keeping dedicated mode (noop) with 200 OK", async () => {
      const res = await requestJson<{ data: HostDto }>(
        `/v1/hosts/${DEMO_IDS.hosts.acme}/mode`,
        {
          method: "PATCH",
          token: tokens[DEMO_IDS.users.infra],
          body: { hostingMode: "dedicated" },
        },
      );
      expect(res.status).toBe(200);
      expect(res.body.data.hostingMode).toBe("dedicated");
    });

    it("rejects allocating with hostingMode: shared with 409 SHARED_MODE_GATED", async () => {
      const res = await requestJson<ApiErrorEnvelope>(
        `/v1/hosts/${DEMO_IDS.hosts.free}/allocations`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.infra],
          body: {
            organizationId: DEMO_IDS.organizations.acme,
            hostingMode: "shared",
          },
        },
      );
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("SHARED_MODE_GATED");
    });
  });

  // 10. AC-F1-07: Concurrent Quota Reservations
  describe("AC-F1-07: Concurrent Quota Reservations", () => {
    it("enforces transactional serializability under concurrency: only 1 succeeds, other gets 409 QUOTA_EXCEEDED", async () => {
      const orgId = DEMO_IDS.organizations.gamma;

      // org_gamma quota: maxServices: 4, usedServices: 1 (remaining: 3)
      // Send 2 concurrent reservations asking for 2 services each (2 + 2 = 4 > 3)
      const res1Promise = requestJson<{ data: QuotaReservationDto } | ApiErrorEnvelope>(
        `/v1/organizations/${orgId}/quotas/reservations`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.hosting],
          body: {
            services: 2,
            idempotencyKey: `race_1_${Date.now()}`,
          },
        },
      );

      const res2Promise = requestJson<{ data: QuotaReservationDto } | ApiErrorEnvelope>(
        `/v1/organizations/${orgId}/quotas/reservations`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.hosting],
          body: {
            services: 2,
            idempotencyKey: `race_2_${Date.now()}`,
          },
        },
      );

      const [res1, res2] = await Promise.all([res1Promise, res2Promise]);
      const statuses = [res1.status, res2.status].sort();

      expect(statuses).toEqual([201, 409]);
      const failed = res1.status === 409 ? (res1.body as ApiErrorEnvelope) : (res2.body as ApiErrorEnvelope);
      expect(failed.error.code).toBe("QUOTA_EXCEEDED");
    });
  });

  // 11. AC-F1-10: Phase 1 Disabled Runtime Boundaries
  describe("AC-F1-10: Phase 1 Runtime Execution Boundaries", () => {
    it("returns capabilities with all Phase 2 runtime flags set to false", async () => {
      const res = await requestJson<{ data: OrganizationCapabilitiesDto }>(
        `/v1/organizations/${DEMO_IDS.organizations.acme}/capabilities`,
        {
          token: tokens[DEMO_IDS.users.elena],
        },
      );
      expect(res.status).toBe(200);
      expect(res.body.data.sharedHostingEnabled).toBe(false);
      expect(res.body.data.dockerExecutorRuntimeAvailable).toBe(false);
      expect(res.body.data.hostAgentRuntimeAvailable).toBe(false);
      expect(res.body.data.acmeTlsRuntimeAvailable).toBe(false);
      expect(res.body.data.sftpAvailable).toBe(false);
      expect(res.body.data.productionBackupRuntimeAvailable).toBe(false);
    });

    it("returns 422 NOT_SUPPORTED on service lifecycle action (deploy/restart/stop)", async () => {
      const res = await requestJson<ApiErrorEnvelope>(
        `/v1/organizations/${DEMO_IDS.organizations.acme}/services/${DEMO_IDS.services.acmeShopWp}/lifecycle`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.elena],
          body: { action: "deploy" },
        },
      );
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("NOT_SUPPORTED");
      expect(res.body.error.message).toContain("Docker executor runtime is disabled in Phase 1");
    });

    it("returns 422 NOT_SUPPORTED on host maintenance execution", async () => {
      const res = await requestJson<ApiErrorEnvelope>(
        `/v1/hosts/${DEMO_IDS.hosts.acme}/maintenance`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.infra],
          body: { action: "collect_diagnostics" },
        },
      );
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("NOT_SUPPORTED");
      expect(res.body.error.message).toContain("Host agent runtime execution is disabled in Phase 1");
    });

    it("returns 422 NOT_SUPPORTED on host security posture execution", async () => {
      const res = await requestJson<ApiErrorEnvelope>(
        `/v1/hosts/${DEMO_IDS.hosts.acme}/security`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.infra],
          body: { policyRef: "audit_benchmark_v1" },
        },
      );
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("NOT_SUPPORTED");
      expect(res.body.error.message).toContain("Host agent runtime execution is disabled in Phase 1");
    });
  });

  // 12. Commercial Suspension & Last Owner Protection
  describe("Commercial Suspension & Last Owner Protection", () => {
    it("rejects mutating operation on suspended org (org_gamma) with 403 ORGANIZATION_SUSPENDED", async () => {
      // Giulia (owner of suspended org_gamma) attempts to create a site
      const res = await requestJson<ApiErrorEnvelope>(
        `/v1/organizations/${DEMO_IDS.organizations.gamma}/sites`,
        {
          method: "POST",
          token: tokens[DEMO_IDS.users.giulia],
          headers: { "Idempotency-Key": `idemp_susp_${Date.now()}` },
          body: {
            name: "New Gamma Site",
            slug: `gamma-new-${Date.now()}`,
            hostAllocationId: DEMO_IDS.allocations.gamma,
          },
        },
      );
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ORGANIZATION_SUSPENDED");
    });

    it("protects last active owner from removal with 409 LAST_OWNER_PROTECTED", async () => {
      const membersRes = await requestJson<{ data: MemberDto[] }>(
        `/v1/organizations/${DEMO_IDS.organizations.acme}/members`,
        {
          token: tokens[DEMO_IDS.users.elena],
        },
      );
      expect(membersRes.status).toBe(200);
      const elenaMember = membersRes.body.data.find((m) => m.userId === DEMO_IDS.users.elena);
      expect(elenaMember).toBeDefined();

      // Elena is the sole owner of Acme; attempting to delete her membership fails with 409
      const delRes = await requestJson<ApiErrorEnvelope>(
        `/v1/organizations/${DEMO_IDS.organizations.acme}/members/${elenaMember!.id}`,
        {
          method: "DELETE",
          token: tokens[DEMO_IDS.users.elena],
        },
      );
      expect(delRes.status).toBe(409);
      expect(delRes.body.error.code).toBe("LAST_OWNER_PROTECTED");
    });
  });
});
