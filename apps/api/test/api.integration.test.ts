import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import {
  ApiErrorEnvelopeSchema,
  AsyncAcceptedEnvelopeSchema,
  findForbiddenPublicDtoKeys,
} from "@hosting-panel/contracts";
import { DEMO_IDS } from "@hosting-panel/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createControlPlaneApp,
  DEFAULT_LAB_VAULT_SECRETS,
  type ControlPlaneAppHandle,
} from "../src/index.js";

interface HttpJsonResult<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
  readonly rawText: string;
}

const KNOWN_RAW_SECRETS = Object.values(DEFAULT_LAB_VAULT_SECRETS);

function assertZeroLeaks(
  payload: unknown,
  rawText: string,
  options?: { readonly allowAccessTokenKey?: boolean },
): void {
  if (!options?.allowAccessTokenKey) {
    expect(findForbiddenPublicDtoKeys(payload)).toEqual([]);
  }
  for (const secret of KNOWN_RAW_SECRETS) {
    expect(rawText).not.toContain(secret);
  }
}

describe("Control-Plane /v1 API End-to-End Integration Suite (Unit 7)", () => {
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
    let serializedBody: string | undefined;
    if (init?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      serializedBody = JSON.stringify(init.body);
    }

    const res = await fetch(`${baseUrl}${path}`, {
      method: init?.method ?? "GET",
      headers,
      body: serializedBody,
    });

    const rawText = await res.text();
    const parsed = (rawText.length > 0 ? JSON.parse(rawText) : null) as T;

    expect(res.headers.get("x-request-id")).toBeTruthy();
    assertZeroLeaks(parsed, rawText, {
      allowAccessTokenKey: init?.allowAccessTokenKey,
    });

    return {
      status: res.status,
      headers: res.headers,
      body: parsed,
      rawText,
    };
  }

  async function issuePersonaToken(userId: string): Promise<string> {
    const res = await requestJson<{
      readonly data: {
        readonly accessToken: string;
        readonly tokenType: string;
        readonly user: { readonly id: string };
      };
    }>("/v1/dev/auth/token", {
      method: "POST",
      body: { userId },
      allowAccessTokenKey: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.tokenType).toBe("Bearer");
    expect(res.body.data.user.id).toBe(userId);
    return res.body.data.accessToken;
  }

  beforeAll(async () => {
    app = await createControlPlaneApp({
      listen: true,
      port: 0,
      enableBackgroundWorker: false,
      coolifyTimeoutMs: 120,
      fakeCoolifyTimeoutDelayMs: 600,
      coolifyDefaultCooldownMs: 100,
      coolifyMaxCooldownMs: 100,
    });

    expect(app.baseUrl).toBeTruthy();
    expect(app.fakeCoolify).not.toBeNull();
    baseUrl = app.baseUrl!;

    tokens["elena"] = await issuePersonaToken(DEMO_IDS.users.elena);
    tokens["marco"] = await issuePersonaToken(DEMO_IDS.users.marco);
    tokens["giulia"] = await issuePersonaToken(DEMO_IDS.users.giulia);
    tokens["luca"] = await issuePersonaToken(DEMO_IDS.users.luca);
    tokens["admin"] = await issuePersonaToken(DEMO_IDS.users.admin);
  });

  beforeEach(() => {
    app.fakeCoolify?.resetSimulations();
    app.fakeCoolify?.clearRequests();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("serves /health/live, /health/ready, Dev OIDC personas, X-Request-ID propagation, and ships OpenAPI 3.1.0", async () => {
    const live = await requestJson<{ readonly status: string }>("/health/live", {
      headers: { "X-Request-ID": "req_custom_health_check_01" },
    });
    expect(live.status).toBe(200);
    expect(live.body.status).toBe("ok");
    expect(live.headers.get("x-request-id")).toBe("req_custom_health_check_01");

    const ready = await requestJson<{
      readonly status: string;
      readonly database: string;
      readonly mode: string;
    }>("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe("ready");
    expect(ready.body.database).toBe("up");
    expect(ready.body.mode).toBe("pglite");

    const notFoundRoute = await requestJson("/v1/non-existent-endpoint");
    expect(notFoundRoute.status).toBe(404);
    expect(ApiErrorEnvelopeSchema.parse(notFoundRoute.body).error.code).toBe(
      "NOT_FOUND",
    );

    const personas = await requestJson<{
      readonly data: ReadonlyArray<{ readonly id: string }>;
    }>("/v1/dev/auth/personas");
    expect(personas.status).toBe(200);
    expect(personas.body.data.map((p) => p.id)).toEqual(
      expect.arrayContaining([
        DEMO_IDS.users.elena,
        DEMO_IDS.users.marco,
        DEMO_IDS.users.giulia,
        DEMO_IDS.users.luca,
        DEMO_IDS.users.admin,
      ]),
    );

    const unauth = await requestJson("/v1/me");
    expect(unauth.status).toBe(401);
    const parsedErr = ApiErrorEnvelopeSchema.parse(unauth.body);
    expect(parsedErr.error.code).toBe("UNAUTHENTICATED");

    const currentDir = fileURLToPath(new URL(".", import.meta.url));
    const openApiPath = resolve(currentDir, "../../../docs/api/openapi.yaml");
    const openApiContent = await readFile(openApiPath, "utf8");
    expect(openApiContent).toContain("openapi: 3.1.0");
    expect(openApiContent).toContain("/v1/organizations/{orgId}/applications/{appId}/deploy:");
    expect(openApiContent).toContain("AsyncAcceptedEnvelope:");
    expect(openApiContent).toContain("ApiErrorEnvelope:");
  });

  it("AC-001: enforces cross-tenant 404 isolation with zero upstream Coolify calls", async () => {
    app.fakeCoolify!.clearRequests();

    // User in org_acme attempting to read org_beta's application under org_acme URL
    const readUnderAcme = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.betaPortal}`,
      { token: tokens["elena"] },
    );
    expect(readUnderAcme.status).toBe(404);
    expect(ApiErrorEnvelopeSchema.parse(readUnderAcme.body).error.code).toBe("NOT_FOUND");

    // User in org_acme attempting to deploy org_beta's application under org_acme URL
    const deployUnderAcme = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.betaPortal}/deploy`,
      {
        method: "POST",
        token: tokens["elena"],
        headers: { "Idempotency-Key": "idem_ac001_cross_app" },
        body: { forceRebuild: false },
      },
    );
    expect(deployUnderAcme.status).toBe(404);
    expect(ApiErrorEnvelopeSchema.parse(deployUnderAcme.body).error.code).toBe("NOT_FOUND");

    // User with zero membership in org_beta (usr_marco) probing org_beta directly -> 404 (not 403!)
    const foreignOrgProbe = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.beta}/applications/${DEMO_IDS.applications.betaPortal}`,
      { token: tokens["marco"] },
    );
    expect(foreignOrgProbe.status).toBe(404);
    expect(ApiErrorEnvelopeSchema.parse(foreignOrgProbe.body).error.code).toBe("NOT_FOUND");

    // Zero requests hit Fake Coolify for coolify-app-beta-portal!
    const betaHits = app.fakeCoolify!
      .getRequests()
      .filter((r) => r.fullUrl.includes("coolify-app-beta-portal"));
    expect(betaHits).toHaveLength(0);
    expect(app.fakeCoolify!.getRequests()).toHaveLength(0);
  });

  it("AC-002: isolates multi-org context switching and per-org role capabilities for usr_elena", async () => {
    const me = await requestJson<{
      readonly data: {
        readonly user: { readonly id: string };
        readonly organizations: ReadonlyArray<{
          readonly id: string;
          readonly roles: readonly string[];
        }>;
      };
    }>("/v1/me", { token: tokens["elena"] });
    expect(me.status).toBe(200);
    expect(me.body.data.user.id).toBe(DEMO_IDS.users.elena);

    const orgList = await requestJson<{
      readonly data: ReadonlyArray<{ readonly id: string }>;
    }>("/v1/me/organizations", { token: tokens["elena"] });
    expect(orgList.status).toBe(200);
    expect(orgList.body.data.map((o) => o.id)).toEqual(
      expect.arrayContaining([
        DEMO_IDS.organizations.acme,
        DEMO_IDS.organizations.beta,
        DEMO_IDS.organizations.legacy,
      ]),
    );

    const acmeApps = await requestJson<{
      readonly data: ReadonlyArray<{ readonly id: string; readonly organizationId: string }>;
    }>(`/v1/organizations/${DEMO_IDS.organizations.acme}/applications`, {
      token: tokens["elena"],
    });
    expect(acmeApps.status).toBe(200);
    expect(acmeApps.body.data.map((a) => a.id)).toEqual([
      DEMO_IDS.applications.acmeApi,
      DEMO_IDS.applications.acmeStorefront,
    ]);

    const betaApps = await requestJson<{
      readonly data: ReadonlyArray<{ readonly id: string; readonly organizationId: string }>;
    }>(`/v1/organizations/${DEMO_IDS.organizations.beta}/applications`, {
      token: tokens["elena"],
    });
    expect(betaApps.status).toBe(200);
    expect(betaApps.body.data.map((a) => a.id)).toEqual([DEMO_IDS.applications.betaPortal]);

    const acmeCaps = await requestJson<{
      readonly data: { readonly permissions: readonly string[] };
    }>(`/v1/organizations/${DEMO_IDS.organizations.acme}/capabilities`, {
      token: tokens["elena"],
    });
    expect(acmeCaps.status).toBe(200);
    expect(acmeCaps.body.data.permissions).toContain("application.deploy");

    const betaCaps = await requestJson<{
      readonly data: { readonly permissions: readonly string[] };
    }>(`/v1/organizations/${DEMO_IDS.organizations.beta}/capabilities`, {
      token: tokens["elena"],
    });
    expect(betaCaps.status).toBe(200);
    expect(betaCaps.body.data.permissions).toContain("application.read");
    expect(betaCaps.body.data.permissions).not.toContain("application.deploy");

    // usr_elena is only viewer in org_beta -> deploy must be 403
    const deployInBeta = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.beta}/applications/${DEMO_IDS.applications.betaPortal}/deploy`,
      {
        method: "POST",
        token: tokens["elena"],
        headers: { "Idempotency-Key": "idem_ac002_beta_viewer_deploy" },
        body: { forceRebuild: false },
      },
    );
    expect(deployInBeta.status).toBe(403);
    expect(ApiErrorEnvelopeSchema.parse(deployInBeta.body).error.code).toBe(
      "PERMISSION_DENIED",
    );
  });

  it("AC-003: denies viewer restart mutation with 403 PERMISSION_DENIED and records audit denial", async () => {
    const restartRes = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeStorefront}/restart`,
      {
        method: "POST",
        token: tokens["giulia"],
        headers: {
          "Idempotency-Key": "idem_ac003_viewer_restart",
          "X-Request-ID": "req_ac003_giulia_denied",
        },
      },
    );

    expect(restartRes.status).toBe(403);
    const err = ApiErrorEnvelopeSchema.parse(restartRes.body);
    expect(err.error.code).toBe("PERMISSION_DENIED");
    expect(err.error.requestId).toBe("req_ac003_giulia_denied");

    const auditRes = await requestJson<{
      readonly data: ReadonlyArray<{
        readonly actorUserId: string | null;
        readonly action: string;
        readonly outcome: string;
        readonly requestId: string | null;
      }>;
    }>(
      `/v1/admin/audit?organizationId=${DEMO_IDS.organizations.acme}&outcome=denied`,
      { token: tokens["admin"] },
    );
    expect(auditRes.status).toBe(200);
    expect(
      auditRes.body.data.some(
        (ev) =>
          ev.actorUserId === DEMO_IDS.users.giulia &&
          ev.outcome === "denied" &&
          ev.requestId === "req_ac003_giulia_denied",
      ),
    ).toBe(true);
  });

  it("AC-004: enforces resource-scoped ABAC for developer usr_marco (allowed on storefront, 403 on core API)", async () => {
    const listRes = await requestJson<{
      readonly data: ReadonlyArray<{ readonly id: string }>;
    }>(`/v1/organizations/${DEMO_IDS.organizations.acme}/applications`, {
      token: tokens["marco"],
    });
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.map((a) => a.id)).toEqual([DEMO_IDS.applications.acmeStorefront]);

    const readApiRes = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeApi}`,
      { token: tokens["marco"] },
    );
    expect(readApiRes.status).toBe(403);
    expect(ApiErrorEnvelopeSchema.parse(readApiRes.body).error.code).toBe(
      "PERMISSION_DENIED",
    );

    const deployApiRes = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeApi}/deploy`,
      {
        method: "POST",
        token: tokens["marco"],
        headers: { "Idempotency-Key": "idem_ac004_marco_forbidden_api" },
        body: { forceRebuild: false },
      },
    );
    expect(deployApiRes.status).toBe(403);
    expect(ApiErrorEnvelopeSchema.parse(deployApiRes.body).error.code).toBe(
      "PERMISSION_DENIED",
    );

    const deployStorefrontRes = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeStorefront}/deploy`,
      {
        method: "POST",
        token: tokens["marco"],
        headers: { "Idempotency-Key": "idem_ac004_marco_storefront_ok" },
        body: { forceRebuild: false },
      },
    );
    expect(deployStorefrontRes.status).toBe(202);
    const accepted = AsyncAcceptedEnvelopeSchema.parse(deployStorefrontRes.body);
    expect(accepted.data.resourceId).toBe(DEMO_IDS.applications.acmeStorefront);

    await app.outboxWorker.processUntilIdle();

    const opRes = await requestJson<{
      readonly data: { readonly id: string; readonly status: string };
    }>(accepted.links.self, { token: tokens["marco"] });
    expect(opRes.status).toBe(200);
    expect(opRes.body.data.status).toBe("succeeded");
  });

  it("AC-005 & AC-006: enforces Idempotency-Key deduplication, payload conflict (409), and per-resource locking (409)", async () => {
    const missingKeyRes = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeApi}/deploy`,
      {
        method: "POST",
        token: tokens["elena"],
        body: { forceRebuild: true },
      },
    );
    expect(missingKeyRes.status).toBe(400);
    expect(ApiErrorEnvelopeSchema.parse(missingKeyRes.body).error.code).toBe(
      "VALIDATION_ERROR",
    );

    const firstRes = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeApi}/deploy`,
      {
        method: "POST",
        token: tokens["elena"],
        headers: { "Idempotency-Key": "idem_ac005_deploy_1" },
        body: { forceRebuild: true },
      },
    );
    expect(firstRes.status).toBe(202);
    const firstAccepted = AsyncAcceptedEnvelopeSchema.parse(firstRes.body);

    // Exact same key + same body -> deduplicated 202 with identical operationId
    const duplicateRes = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeApi}/deploy`,
      {
        method: "POST",
        token: tokens["elena"],
        headers: { "Idempotency-Key": "idem_ac005_deploy_1" },
        body: { forceRebuild: true },
      },
    );
    expect(duplicateRes.status).toBe(202);
    const duplicateAccepted = AsyncAcceptedEnvelopeSchema.parse(duplicateRes.body);
    expect(duplicateAccepted.data.operationId).toBe(firstAccepted.data.operationId);

    // Same key + different body -> 409 IDEMPOTENCY_CONFLICT
    const mismatchRes = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeApi}/deploy`,
      {
        method: "POST",
        token: tokens["elena"],
        headers: { "Idempotency-Key": "idem_ac005_deploy_1" },
        body: { forceRebuild: false },
      },
    );
    expect(mismatchRes.status).toBe(409);
    expect(ApiErrorEnvelopeSchema.parse(mismatchRes.body).error.code).toBe(
      "IDEMPOTENCY_CONFLICT",
    );

    // Different key while resource lock is held -> 409 RESOURCE_LOCKED (AC-006)
    const lockedRes = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeApi}/deploy`,
      {
        method: "POST",
        token: tokens["elena"],
        headers: { "Idempotency-Key": "idem_ac006_concurrent_deploy" },
        body: { forceRebuild: false },
      },
    );
    expect(lockedRes.status).toBe(409);
    expect(ApiErrorEnvelopeSchema.parse(lockedRes.body).error.code).toBe(
      "RESOURCE_LOCKED",
    );

    // Complete operation and verify lock is released + deployment listed
    await app.outboxWorker.processUntilIdle();

    const finalOp = await requestJson<{
      readonly data: { readonly status: string };
    }>(firstAccepted.links.self, { token: tokens["elena"] });
    expect(finalOp.status).toBe(200);
    expect(finalOp.body.data.status).toBe("succeeded");

    const deploymentsRes = await requestJson<{
      readonly data: ReadonlyArray<{ readonly operationId: string | null; readonly status: string }>;
    }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeApi}/deployments`,
      { token: tokens["elena"] },
    );
    expect(deploymentsRes.status).toBe(200);
    expect(
      deploymentsRes.body.data.some(
        (d) => d.operationId === firstAccepted.data.operationId && d.status === "succeeded",
      ),
    ).toBe(true);
  });

  it("AC-007: transitions timed-out POST deploy to unknown (keeping lock, zero blind POST replay) and reconciles cleanly to succeeded", async () => {
    app.fakeCoolify!.clearRequests();
    app.fakeCoolify!.setNextDeployBehavior("timeout");

    const enqueueRes = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeStorefront}/deploy`,
      {
        method: "POST",
        token: tokens["elena"],
        headers: { "Idempotency-Key": "idem_ac007_ambiguous_timeout" },
        body: { forceRebuild: false },
      },
    );
    expect(enqueueRes.status).toBe(202);
    const accepted = AsyncAcceptedEnvelopeSchema.parse(enqueueRes.body);

    // Dispatch batch: POST times out -> must transition to unknown (NOT failed, NOT retried!)
    const dispatched = await app.outboxWorker.processOutboxBatch();
    expect(dispatched).toBe(1);

    const unknownOp = await requestJson<{
      readonly data: {
        readonly status: string;
        readonly errorCode: string | null;
      };
    }>(accepted.links.self, { token: tokens["elena"] });
    expect(unknownOp.status).toBe(200);
    expect(unknownOp.body.data.status).toBe("unknown");
    expect(unknownOp.body.data.errorCode).toBe("OPERATION_AMBIGUOUS");

    // Resource lock MUST remain held while status is unknown
    const concurrentAttempt = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeStorefront}/restart`,
      {
        method: "POST",
        token: tokens["elena"],
        headers: { "Idempotency-Key": "idem_ac007_while_unknown_locked" },
      },
    );
    expect(concurrentAttempt.status).toBe(409);
    expect(ApiErrorEnvelopeSchema.parse(concurrentAttempt.body).error.code).toBe(
      "RESOURCE_LOCKED",
    );

    const deployPostsAfterTimeout = app.fakeCoolify!
      .getRequests()
      .filter((r) => r.method === "POST" && r.path === "/api/v1/deploy");
    expect(deployPostsAfterTimeout).toHaveLength(1);

    // Reconcile inspects Coolify state via GET and recovers unknown -> reconciling -> succeeded
    await app.outboxWorker.reconcileActiveOperations();

    const recoveredOp = await requestJson<{
      readonly data: {
        readonly status: string;
        readonly errorCode: string | null;
      };
    }>(accepted.links.self, { token: tokens["elena"] });
    expect(recoveredOp.status).toBe(200);
    expect(recoveredOp.body.data.status).toBe("succeeded");
    expect(recoveredOp.body.data.errorCode).toBeNull();

    // Still strictly 1 POST /api/v1/deploy (zero duplicate POSTs!)
    const deployPostsAfterReconcile = app.fakeCoolify!
      .getRequests()
      .filter((r) => r.method === "POST" && r.path === "/api/v1/deploy");
    expect(deployPostsAfterReconcile).toHaveLength(1);
  });

  it("AC-008, AC-009 & AC-017: redacts upstream 429 rate-limit and 401 revoked-token errors with zero secret/DTO leaks", async () => {
    // AC-008: 429 rate limit on org_beta connection (pconn_beta)
    app.fakeCoolify!.setNextRequestBehavior("rate_limit");

    const rateLimited = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.beta}/servers/${DEMO_IDS.servers.betaProd}`,
      { token: tokens["luca"] },
    );
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get("retry-after")).toBeTruthy();
    const rateLimitEnvelope = ApiErrorEnvelopeSchema.parse(rateLimited.body);
    expect(rateLimitEnvelope.error.code).toBe("PROVIDER_RATE_LIMIT");

    // Wait past the 100ms adapter cooldown window
    await new Promise((r) => setTimeout(r, 140));

    // AC-009: Upstream Coolify token rejected (401) during admin provider connection test
    app.fakeCoolify!.setNextRequestBehavior("unauthorized");
    const unauthorizedUpstream = await requestJson(
      `/v1/admin/provider-connections/${DEMO_IDS.providers.coolifyLab}/test`,
      {
        method: "POST",
        token: tokens["admin"],
      },
    );
    expect(unauthorizedUpstream.status).toBe(401);
    const unauthEnvelope = ApiErrorEnvelopeSchema.parse(unauthorizedUpstream.body);
    expect(unauthEnvelope.error.code).toBe("UNAUTHENTICATED");

    const adminConnections = await requestJson<{
      readonly data: ReadonlyArray<{ readonly id: string; readonly status: string }>;
    }>("/v1/admin/provider-connections", { token: tokens["admin"] });
    expect(adminConnections.status).toBe(200);
    const degradedInstance = adminConnections.body.data.find(
      (i) => i.id === DEMO_IDS.providers.coolifyLab,
    );
    expect(degradedInstance?.status).toBe("misconfigured");

    // Restore healthy connected status via fresh connection test
    const restored = await requestJson<{
      readonly data: { readonly status: string };
    }>(`/v1/admin/provider-connections/${DEMO_IDS.providers.coolifyLab}/test`, {
      method: "POST",
      token: tokens["admin"],
    });
    expect(restored.status).toBe(200);
    expect(restored.body.data.status).toBe("connected");
  });

  it("AC-010: fails operation and marks application degraded/unhealthy when HealthProbeService fails after Coolify deploy succeeds", async () => {
    app.fakeCoolify!.setHealthProbeOutcome(DEMO_IDS.applications.acmeStorefront, false);

    const deployRes = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeStorefront}/deploy`,
      {
        method: "POST",
        token: tokens["elena"],
        headers: { "Idempotency-Key": "idem_ac010_unhealthy_probe" },
        body: { forceRebuild: false },
      },
    );
    expect(deployRes.status).toBe(202);
    const accepted = AsyncAcceptedEnvelopeSchema.parse(deployRes.body);

    await app.outboxWorker.processUntilIdle();

    const opRes = await requestJson<{
      readonly data: { readonly status: string };
    }>(accepted.links.self, { token: tokens["elena"] });
    expect(opRes.status).toBe(200);
    expect(opRes.body.data.status).toBe("failed");
    expect(opRes.body.data.status).not.toBe("succeeded");

    const appDetail = await requestJson<{
      readonly data: { readonly status: string; readonly health: string };
      readonly meta?: { readonly source: string };
    }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeStorefront}`,
      { token: tokens["elena"] },
    );
    expect(appDetail.status).toBe(200);
    expect(appDetail.body.data.status).toBe("degraded");
    expect(appDetail.body.data.health).toBe("unhealthy");
    expect(appDetail.body.meta?.source).toBe("external_probe");

    app.fakeCoolify!.setHealthProbeOutcome(DEMO_IDS.applications.acmeStorefront, true);
  });

  it("AC-011: surfaces status=unknown and meta.stale=true when Sentinel server heartbeat is stale", async () => {
    app.fakeCoolify!.setServerHeartbeatTimestamp(
      "coolify-srv-acme-01",
      "2020-01-01T00:00:00.000Z",
    );

    const serverDetail = await requestJson<{
      readonly data: { readonly status: string; readonly health: string };
      readonly meta: { readonly stale: boolean };
    }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/servers/${DEMO_IDS.servers.acmeProd}`,
      { token: tokens["elena"] },
    );
    expect(serverDetail.status).toBe(200);
    expect(serverDetail.body.data.status).toBe("unknown");
    expect(serverDetail.body.data.health).toBe("unknown");
    expect(serverDetail.body.meta.stale).toBe(true);

    const metricsRes = await requestJson<{
      readonly data: {
        readonly cpuUsagePercent: number | null;
        readonly memoryUsedMb: number | null;
      };
      readonly meta: { readonly stale: boolean };
    }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/servers/${DEMO_IDS.servers.acmeProd}/metrics`,
      { token: tokens["elena"] },
    );
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.body.meta.stale).toBe(true);
    expect(metricsRes.body.data.cpuUsagePercent).toBeNull();
    expect(metricsRes.body.data.memoryUsedMb).toBeNull();

    app.fakeCoolify!.setServerHeartbeatTimestamp("coolify-srv-acme-01", null);

    const freshServers = await requestJson<{
      readonly data: ReadonlyArray<{ readonly id: string; readonly status: string }>;
      readonly meta: { readonly stale: boolean };
    }>(`/v1/organizations/${DEMO_IDS.organizations.acme}/servers`, {
      token: tokens["elena"],
    });
    expect(freshServers.status).toBe(200);
    expect(freshServers.body.meta.stale).toBe(false);
    expect(freshServers.body.data[0]?.status).toBe("running");
  });

  it("AC-012: reports restoreSupported=false on Redis and rejects restore with 422 NOT_SUPPORTED", async () => {
    const dbList = await requestJson<{
      readonly data: ReadonlyArray<{
        readonly id: string;
        readonly engine: string;
        readonly restoreSupported: boolean;
      }>;
    }>(`/v1/organizations/${DEMO_IDS.organizations.acme}/databases`, {
      token: tokens["elena"],
    });
    expect(dbList.status).toBe(200);
    expect(dbList.body.data).toHaveLength(2);

    const redisDetail = await requestJson<{
      readonly data: {
        readonly id: string;
        readonly engine: string;
        readonly backupSupported: boolean;
        readonly restoreSupported: boolean;
        readonly backupUnsupportedReason: string | null;
      };
    }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/databases/${DEMO_IDS.databases.acmeRedis}`,
      { token: tokens["elena"] },
    );
    expect(redisDetail.status).toBe(200);
    expect(redisDetail.body.data.engine).toBe("redis");
    expect(redisDetail.body.data.backupSupported).toBe(false);
    expect(redisDetail.body.data.restoreSupported).toBe(false);
    expect(redisDetail.body.data.backupUnsupportedReason).toBeTruthy();

    const restoreAttempt = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/databases/${DEMO_IDS.databases.acmeRedis}/restores`,
      {
        method: "POST",
        token: tokens["elena"],
        body: { backupId: "bkp_001" },
      },
    );
    expect(restoreAttempt.status).toBe(422);
    expect(ApiErrorEnvelopeSchema.parse(restoreAttempt.body).error.code).toBe(
      "NOT_SUPPORTED",
    );
  });

  it("AC-014: canonicalizes FQDNs, rejects cross-org duplicate domain with 409 DOMAIN_CONFLICT without leaking owner org, and supports domain recheck", async () => {
    const conflictRes = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/domains`,
      {
        method: "POST",
        token: tokens["elena"],
        body: {
          applicationId: DEMO_IDS.applications.acmeStorefront,
          hostname: "  PORTAL.BetaStudios.IT. ",
        },
      },
    );
    expect(conflictRes.status).toBe(409);
    const conflictErr = ApiErrorEnvelopeSchema.parse(conflictRes.body);
    expect(conflictErr.error.code).toBe("DOMAIN_CONFLICT");
    expect(conflictRes.rawText).not.toContain(DEMO_IDS.organizations.beta);
    expect(conflictRes.rawText).not.toContain("Beta Studios");

    const createRes = await requestJson<{
      readonly data: {
        readonly id: string;
        readonly hostname: string;
        readonly verificationStatus: string;
      };
    }>(`/v1/organizations/${DEMO_IDS.organizations.acme}/domains`, {
      method: "POST",
      token: tokens["elena"],
      body: {
        applicationId: DEMO_IDS.applications.acmeStorefront,
        hostname: "  Campaign-2026.Acme.IT. ",
      },
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.data.hostname).toBe("campaign-2026.acme.it");
    expect(createRes.body.data.verificationStatus).toBe("pending");

    const recheckRes = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/domains/${createRes.body.data.id}/recheck`,
      {
        method: "POST",
        token: tokens["elena"],
        headers: { "Idempotency-Key": "idem_domain_recheck_campaign" },
      },
    );
    expect(recheckRes.status).toBe(202);
    AsyncAcceptedEnvelopeSchema.parse(recheckRes.body);

    await app.outboxWorker.processUntilIdle();

    const domainsAfter = await requestJson<{
      readonly data: ReadonlyArray<{
        readonly id: string;
        readonly verificationStatus: string;
        readonly certificate: { readonly status: string } | null;
      }>;
    }>(`/v1/organizations/${DEMO_IDS.organizations.acme}/domains`, {
      token: tokens["elena"],
    });
    expect(domainsAfter.status).toBe(200);
    const updatedDomain = domainsAfter.body.data.find(
      (d) => d.id === createRes.body.data.id,
    );
    expect(updatedDomain?.verificationStatus).toBe("verified");
    expect(updatedDomain?.certificate?.status).toBe("valid");

    const certsRes = await requestJson<{
      readonly data: ReadonlyArray<{ readonly domainId: string; readonly status: string }>;
    }>(`/v1/organizations/${DEMO_IDS.organizations.acme}/certificates`, {
      token: tokens["elena"],
    });
    expect(certsRes.status).toBe(200);
    expect(
      certsRes.body.data.some(
        (c) => c.domainId === createRes.body.data.id && c.status === "valid",
      ),
    ).toBe(true);
  });

  it("AC-016: allows platform_admin on /v1/admin/*, but denies tenant resource reads without an active support grant and audits the denial", async () => {
    const fleetRes = await requestJson<{
      readonly data: ReadonlyArray<{ readonly resourceId: string }>;
    }>("/v1/admin/fleet", { token: tokens["admin"] });
    expect(fleetRes.status).toBe(200);
    expect(fleetRes.body.data.length).toBeGreaterThanOrEqual(4);

    // Non-platform-admin gets 403 on /v1/admin/fleet
    const customerOnFleet = await requestJson("/v1/admin/fleet", {
      token: tokens["elena"],
    });
    expect(customerOnFleet.status).toBe(403);

    // Platform admin without support_access_grants trying to read org_acme applications -> 403 + audit denial
    const adminTenantAccess = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications`,
      {
        token: tokens["admin"],
        headers: { "X-Request-ID": "req_ac016_admin_no_support_grant" },
      },
    );
    expect(adminTenantAccess.status).toBe(403);
    expect(ApiErrorEnvelopeSchema.parse(adminTenantAccess.body).error.code).toBe(
      "PERMISSION_DENIED",
    );

    const auditRes = await requestJson<{
      readonly data: ReadonlyArray<{
        readonly actorUserId: string | null;
        readonly outcome: string;
        readonly requestId: string | null;
      }>;
    }>(
      `/v1/admin/audit?organizationId=${DEMO_IDS.organizations.acme}&outcome=denied`,
      { token: tokens["admin"] },
    );
    expect(auditRes.status).toBe(200);
    expect(
      auditRes.body.data.some(
        (ev) =>
          ev.actorUserId === DEMO_IDS.users.admin &&
          ev.outcome === "denied" &&
          ev.requestId === "req_ac016_admin_no_support_grant",
      ),
    ).toBe(true);
  });

  it("AC-021: blocks mutating operations on suspended org_legacy with 403 while permitting read-only org and quota views", async () => {
    const orgRead = await requestJson<{
      readonly data: { readonly id: string; readonly status: string };
    }>(`/v1/organizations/${DEMO_IDS.organizations.legacy}`, {
      token: tokens["elena"],
    });
    expect(orgRead.status).toBe(200);
    expect(orgRead.body.data.status).toBe("suspended");

    const quotasRead = await requestJson<{
      readonly data: { readonly organizationId: string; readonly planCode: string };
    }>(`/v1/organizations/${DEMO_IDS.organizations.legacy}/quotas`, {
      token: tokens["elena"],
    });
    expect(quotasRead.status).toBe(200);
    expect(quotasRead.body.data.organizationId).toBe(DEMO_IDS.organizations.legacy);

    const blockedDeploy = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.legacy}/applications/${DEMO_IDS.applications.legacySite}/deploy`,
      {
        method: "POST",
        token: tokens["elena"],
        headers: { "Idempotency-Key": "idem_ac021_suspended_deploy" },
        body: { forceRebuild: false },
      },
    );
    expect(blockedDeploy.status).toBe(403);
    expect(ApiErrorEnvelopeSchema.parse(blockedDeploy.body).error.code).toBe(
      "PERMISSION_DENIED",
    );
  });

  it("AC-022: protects sole customer_owner from removal with 409 LAST_OWNER_PROTECTED while allowing invitations & non-last-member management", async () => {
    const soleOwnerDelete = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.beta}/members/${DEMO_IDS.memberships.lucaBeta}`,
      {
        method: "DELETE",
        token: tokens["luca"],
      },
    );
    expect(soleOwnerDelete.status).toBe(409);
    expect(ApiErrorEnvelopeSchema.parse(soleOwnerDelete.body).error.code).toBe(
      "LAST_OWNER_PROTECTED",
    );

    const inviteRes = await requestJson<{
      readonly data: { readonly membershipId: string; readonly email: string };
    }>(`/v1/organizations/${DEMO_IDS.organizations.acme}/invitations`, {
      method: "POST",
      token: tokens["elena"],
      body: {
        email: "nuovo.dev@acme.it",
        roles: ["viewer"],
      },
    });
    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body.data.email).toBe("nuovo.dev@acme.it");

    const membersRes = await requestJson<{
      readonly data: ReadonlyArray<{ readonly userId: string }>;
    }>(`/v1/organizations/${DEMO_IDS.organizations.acme}/members`, {
      token: tokens["elena"],
    });
    expect(membersRes.status).toBe(200);
    expect(membersRes.body.data.length).toBeGreaterThanOrEqual(3);
  });

  it("AC-024: immediately rejects requests bearing a revoked JWT jti after POST /v1/auth/revoke", async () => {
    const sessionToken = await issuePersonaToken(DEMO_IDS.users.giulia);

    const beforeRevoke = await requestJson("/v1/me", { token: sessionToken });
    expect(beforeRevoke.status).toBe(200);

    const revokeRes = await requestJson<{
      readonly data: { readonly revoked: boolean };
    }>("/v1/auth/revoke", {
      method: "POST",
      token: sessionToken,
    });
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.data.revoked).toBe(true);

    const afterRevoke = await requestJson("/v1/me", { token: sessionToken });
    expect(afterRevoke.status).toBe(401);
    expect(ApiErrorEnvelopeSchema.parse(afterRevoke.body).error.code).toBe(
      "UNAUTHENTICATED",
    );
  });

  it("streams real-time SSE events on GET /v1/organizations/:orgId/events and closes cleanly on disconnect", async () => {
    const abortController = new AbortController();
    const sseResponse = await fetch(
      `${baseUrl}/v1/organizations/${DEMO_IDS.organizations.acme}/events`,
      {
        headers: {
          Authorization: `Bearer ${tokens["elena"]}`,
          Accept: "text/event-stream",
        },
        signal: abortController.signal,
      },
    );

    expect(sseResponse.status).toBe(200);
    expect(sseResponse.headers.get("content-type")).toContain("text/event-stream");
    expect(sseResponse.body).not.toBeNull();

    const reader = sseResponse.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const firstChunk = await reader.read();
    buffer += decoder.decode(firstChunk.value, { stream: true });
    expect(buffer).toContain("event: connected");

    // Trigger an async restart operation and process it so SSE receives operation.updated frames
    const restartRes = await requestJson(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/applications/${DEMO_IDS.applications.acmeStorefront}/restart`,
      {
        method: "POST",
        token: tokens["elena"],
        headers: { "Idempotency-Key": "idem_sse_restart_event_test" },
      },
    );
    expect(restartRes.status).toBe(202);
    const accepted = AsyncAcceptedEnvelopeSchema.parse(restartRes.body);

    await app.outboxWorker.processUntilIdle();

    while (!buffer.includes(`"id":"${accepted.data.operationId}"`) || !buffer.includes('"status":"succeeded"')) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      buffer += decoder.decode(next.value, { stream: true });
    }

    expect(buffer).toContain("event: operation.updated");
    expect(buffer).toContain(`"id":"${accepted.data.operationId}"`);
    expect(buffer).toContain('"status":"succeeded"');
    for (const secret of KNOWN_RAW_SECRETS) {
      expect(buffer).not.toContain(secret);
    }

    abortController.abort();
    await reader.cancel().catch(() => undefined);

    // Also verify operations list endpoint returns sanitized OperationDto items
    const opsList = await requestJson<{
      readonly data: ReadonlyArray<{ readonly id: string }>;
    }>(`/v1/organizations/${DEMO_IDS.organizations.acme}/operations`, {
      token: tokens["elena"],
    });
    expect(opsList.status).toBe(200);
    expect(opsList.body.data.some((o) => o.id === accepted.data.operationId)).toBe(
      true,
    );
  });
});
