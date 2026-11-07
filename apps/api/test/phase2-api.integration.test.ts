import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findForbiddenPublicDtoKeys,
  type ApiErrorEnvelope,
  type AsyncAcceptedEnvelope,
  type AuditEventDto,
  type EncryptedSecretMetadataDto,
  type HostDaemonHeartbeatDto,
  type HostTelemetryDto,
  type IpcVerificationKeyring,
  type MeDto,
  type OperationDto,
  type OrganizationCapabilitiesDto,
  type OrganizationDetailDto,
  type ServiceInstanceDto,
  type SiteDetailDto,
  type StackRevisionDto,
} from "@hosting-panel/contracts";
import {
  DEMO_IDS,
  eq,
  operations,
  outboxEvents,
  stackRevisions,
} from "@hosting-panel/database";
import {
  DockerExecutorIpcServer,
  InMemoryDockerSimulatorAdapter,
  SignedDockerExecutorIpcClient,
} from "@hosting-panel/docker-executor";
import {
  HostAgentIpcServer,
  InMemoryHostSimulatorAdapter,
} from "@hosting-panel/host-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createControlPlaneApp,
  issueBreakGlassEmergencyToken,
  OidcService,
  parseBreakglassSigningKey,
  runBreakGlassUnlock,
  type ControlPlaneAppHandle,
} from "../src/index.js";

interface HttpJsonResult<T = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: T;
  readonly rawText: string;
}

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const API_SRC_DIR = path.resolve(CURRENT_DIR, "../src");
const OPENAPI_YAML_PATH = path.resolve(CURRENT_DIR, "../../../docs/api/openapi.yaml");

function assertZeroLeaks(
  payload: unknown,
  options?: { readonly allowAccessTokenKey?: boolean },
): void {
  if (!options?.allowAccessTokenKey) {
    const forbidden = findForbiddenPublicDtoKeys(payload);
    expect(forbidden).toEqual([]);
  }
}

async function listTypeScriptFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const collected: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      collected.push(...(await listTypeScriptFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      collected.push(fullPath);
    }
  }
  return collected;
}

describe("Control-Plane /v1 API Phase 2 Runtime, Outbox, Signed UDS IPC, Secrets & Reconciler Suite (HCP-SPEC-003)", () => {
  let tmpDir: string;
  let secretsRootDir: string;
  let ingressRootDir: string;
  let executorSocketPath: string;
  let hostAgentSocketPath: string;
  let ipcSecret: string;
  let masterKeyHex: string;

  let dockerSim: InMemoryDockerSimulatorAdapter;
  let hostSim: InMemoryHostSimulatorAdapter;
  let executorIpcServer: DockerExecutorIpcServer;
  let hostAgentIpcServer: HostAgentIpcServer;

  let app: ControlPlaneAppHandle;
  let baseUrl: string;
  const tokens: Record<string, string> = {};

  const savedEnv: Record<string, string | undefined> = {};

  async function requestJson<T = Record<string, unknown>>(
    urlPath: string,
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

    const res = await fetch(`${baseUrl}${urlPath}`, {
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
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "hp-w3a-"));
    secretsRootDir = path.join(tmpDir, "secrets");
    ingressRootDir = path.join(tmpDir, "ingress");
    executorSocketPath = path.join(tmpDir, "executor.sock");
    hostAgentSocketPath = path.join(tmpDir, "host-agent.sock");

    ipcSecret = randomBytes(32).toString("hex");
    masterKeyHex = randomBytes(32).toString("hex");

    const keyring: IpcVerificationKeyring = {
      "ipc-v1": {
        keyId: "ipc-v1",
        algorithm: "hmac-sha256",
        secret: ipcSecret,
      },
    };

    dockerSim = new InMemoryDockerSimulatorAdapter({
      secretsRootDir,
      ingressRootDir,
    });
    hostSim = new InMemoryHostSimulatorAdapter();

    executorIpcServer = new DockerExecutorIpcServer({
      executor: dockerSim,
      keyring,
      transport: "uds",
      socketPath: executorSocketPath,
      runtimeBackend: "linux-systemd",
    });
    await executorIpcServer.start();

    hostAgentIpcServer = new HostAgentIpcServer({
      adapter: hostSim,
      keyring,
      runtimeBackend: "linux-systemd",
      transportConfig: {
        transport: "uds",
        socketPath: hostAgentSocketPath,
      },
    });
    await hostAgentIpcServer.start();

    for (const envKey of [
      "HP_EXECUTOR_SOCKET_PATH",
      "HP_HOST_AGENT_SOCKET_PATH",
      "HP_IPC_KEY",
      "HP_IPC_KEY_ID",
    ]) {
      savedEnv[envKey] = process.env[envKey];
    }

    process.env["HP_EXECUTOR_SOCKET_PATH"] = executorSocketPath;
    process.env["HP_HOST_AGENT_SOCKET_PATH"] = hostAgentSocketPath;
    process.env["HP_IPC_KEY"] = ipcSecret;
    process.env["HP_IPC_KEY_ID"] = "ipc-v1";

    app = await createControlPlaneApp({
      host: "127.0.0.1",
      port: 0,
      listen: true,
      enableDevOidc: true,
      runtimeBackend: "linux-systemd",
      secretsMasterKey: masterKeyHex,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
    });

    expect(app.baseUrl).not.toBeNull();
    baseUrl = app.baseUrl!;

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
    if (app) {
      await app.close();
    }
    if (executorIpcServer) {
      await executorIpcServer.stop();
    }
    if (hostAgentIpcServer) {
      await hostAgentIpcServer.stop();
    }
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("1. AC-F2-01 & OpenAPI alignment: apps/api has zero docker.sock or child_process usage and OpenAPI documents Phase 2 routes", async () => {
    const srcFiles = await listTypeScriptFiles(API_SRC_DIR);
    expect(srcFiles.length).toBeGreaterThan(5);

    for (const filePath of srcFiles) {
      const content = await readFile(filePath, "utf8");
      expect(content).not.toContain("/var/run/docker.sock");
      expect(content).not.toMatch(/from\s+["'](?:node:)?child_process["']/);
      expect(content).not.toContain("sh -c");
    }

    const openApiRaw = await readFile(OPENAPI_YAML_PATH, "utf8");
    expect(openApiRaw).toContain("/v1/hosts/{hostId}/telemetry:");
    expect(openApiRaw).toContain("/v1/hosts/{hostId}/operations:");
    expect(openApiRaw).toContain("/v1/hosts/{hostId}/operations/{opId}:");
    expect(openApiRaw).toContain("/v1/organizations/{orgId}/secrets:");
    expect(openApiRaw).toContain("/v1/organizations/{orgId}/secrets/{secretId}:");
    expect(openApiRaw).toContain("AsyncAcceptedEnvelope:");
    expect(openApiRaw).toContain("EncryptedSecretMetadataDto:");
    expect(openApiRaw).toContain("OPERATION_INTERRUPTED");
    expect(openApiRaw).toContain("host.security");
  });

  it("2. AC-F2-10: GET /health/live, GET /v1/me, and org capabilities enable Phase 2 runtimes while keeping shared/TLS/SFTP/backups strictly false", async () => {
    const liveRes = await requestJson<{
      status: string;
      spec: string;
      phase: string;
      runtimeBackend: string;
    }>("/health/live");
    expect(liveRes.status).toBe(200);
    expect(liveRes.body.spec).toBe("HCP-SPEC-003");
    expect(liveRes.body.phase).toBe("phase-2");
    expect(liveRes.body.runtimeBackend).toBe("linux-systemd");

    const meRes = await requestJson<{ data: MeDto }>("/v1/me", {
      token: tokens["usr_elena"],
    });
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.platformCapabilities).toEqual({
      phase: "phase-2",
      runtimeBackend: "linux-systemd",
      hostingMode: "dedicated",
      sharedHostingEnabled: false,
      dockerExecutorRuntimeAvailable: true,
      hostAgentRuntimeAvailable: true,
      acmeTlsRuntimeAvailable: false,
      sftpAvailable: false,
      productionBackupRuntimeAvailable: false,
    });

    const orgRes = await requestJson<{ data: OrganizationDetailDto }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}`,
      { token: tokens["usr_elena"] },
    );
    expect(orgRes.status).toBe(200);
    expect(orgRes.body.data.capabilities).toEqual({
      hostingMode: "dedicated",
      sharedHostingEnabled: false,
      dockerExecutorRuntimeAvailable: true,
      hostAgentRuntimeAvailable: true,
      acmeTlsRuntimeAvailable: false,
      sftpAvailable: false,
      productionBackupRuntimeAvailable: false,
    });

    const capRes = await requestJson<{ data: OrganizationCapabilitiesDto }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/capabilities`,
      { token: tokens["usr_elena"] },
    );
    expect(capRes.status).toBe(200);
    expect(capRes.body.data).toEqual(orgRes.body.data.capabilities);

    // Shared hosting transition remains strictly gated (409 SHARED_MODE_GATED)
    const sharedModeRes = await requestJson<ApiErrorEnvelope>(
      `/v1/hosts/${DEMO_IDS.hosts.acme}/mode`,
      {
        method: "PATCH",
        token: tokens["usr_infra"],
        body: { hostingMode: "shared", reason: "Attempt premature shared hosting" },
      },
    );
    expect(sharedModeRes.status).toBe(409);
    expect(sharedModeRes.body.error.code).toBe("SHARED_MODE_GATED");
  });

  it("3. AC-F2-04: Host telemetry, daemon heartbeats, RBAC separation, allowlists, and async 202 host operations over signed UDS IPC", async () => {
    const reconcileSummary = await app.driftReconciler.reconcileAllOnce();
    expect(reconcileSummary.heartbeatsUpdated).toBeGreaterThanOrEqual(2);

    const telemetryRes = await requestJson<{
      data: {
        hostId: string;
        runtimeBackend: string;
        telemetry: HostTelemetryDto | null;
        daemons: HostDaemonHeartbeatDto[];
      };
    }>(`/v1/hosts/${DEMO_IDS.hosts.acme}/telemetry`, {
      token: tokens["usr_infra"],
    });
    expect(telemetryRes.status).toBe(200);
    expect(telemetryRes.body.data.hostId).toBe(DEMO_IDS.hosts.acme);
    expect(telemetryRes.body.data.runtimeBackend).toBe("linux-systemd");
    expect(telemetryRes.body.data.telemetry).not.toBeNull();
    expect(telemetryRes.body.data.telemetry?.dockerEngineReachable).toBe(true);
    expect(telemetryRes.body.data.daemons.map((d) => d.component).sort()).toEqual([
      "docker_executor",
      "host_agent",
    ]);
    expect(telemetryRes.body.data.daemons.every((d) => d.status === "online")).toBe(true);

    // hosting_admin is strictly denied host.maintenance.execute and host.security.manage
    const hostingDeniedMaint = await requestJson<ApiErrorEnvelope>(
      `/v1/hosts/${DEMO_IDS.hosts.acme}/maintenance`,
      {
        method: "POST",
        token: tokens["usr_hosting"],
        headers: { "Idempotency-Key": "idem-hosting-maint-denied" },
        body: { action: "collect_diagnostics" },
      },
    );
    expect(hostingDeniedMaint.status).toBe(403);
    expect(hostingDeniedMaint.body.error.code).toBe("PERMISSION_DENIED");

    const hostingDeniedSec = await requestJson<ApiErrorEnvelope>(
      `/v1/hosts/${DEMO_IDS.hosts.acme}/security`,
      {
        method: "POST",
        token: tokens["usr_hosting"],
        headers: { "Idempotency-Key": "idem-hosting-sec-denied" },
        body: { policyRef: "verify_baseline_firewall" },
      },
    );
    expect(hostingDeniedSec.status).toBe(403);
    expect(hostingDeniedSec.body.error.code).toBe("PERMISSION_DENIED");

    // infrastructure_admin is denied non-allowlisted actions / policies (403 HOST_POLICY_DENIED)
    const badActionRes = await requestJson<ApiErrorEnvelope>(
      `/v1/hosts/${DEMO_IDS.hosts.acme}/maintenance`,
      {
        method: "POST",
        token: tokens["usr_infra"],
        headers: { "Idempotency-Key": "idem-bad-maint-action" },
        body: { action: "run_arbitrary_bash_script" },
      },
    );
    expect(badActionRes.status).toBe(403);
    expect(badActionRes.body.error.code).toBe("HOST_POLICY_DENIED");

    const badPolicyRes = await requestJson<ApiErrorEnvelope>(
      `/v1/hosts/${DEMO_IDS.hosts.acme}/security`,
      {
        method: "POST",
        token: tokens["usr_infra"],
        headers: { "Idempotency-Key": "idem-bad-sec-policy" },
        body: { policyRef: "flush_all_nftables_rules" },
      },
    );
    expect(badPolicyRes.status).toBe(403);
    expect(badPolicyRes.body.error.code).toBe("HOST_POLICY_DENIED");

    // Allowlisted maintenance on unallocated host (hst_ded_free) -> 202 Accepted + lock contention + UDS execution
    const maintRes = await requestJson<AsyncAcceptedEnvelope>(
      `/v1/hosts/${DEMO_IDS.hosts.free}/maintenance`,
      {
        method: "POST",
        token: tokens["usr_infra"],
        headers: { "Idempotency-Key": "idem-free-host-maint-1" },
        body: { action: "collect_diagnostics", reason: "Scheduled diagnostic sweep" },
      },
    );
    expect(maintRes.status).toBe(202);
    expect(maintRes.body.data.status).toBe("queued");
    expect(maintRes.body.links.self).toBe(
      `/v1/hosts/${DEMO_IDS.hosts.free}/operations/${maintRes.body.data.operationId}`,
    );

    // Concurrent maintenance on the same host with different Idempotency-Key -> 409 RESOURCE_LOCKED
    const lockedMaintRes = await requestJson<ApiErrorEnvelope>(
      `/v1/hosts/${DEMO_IDS.hosts.free}/maintenance`,
      {
        method: "POST",
        token: tokens["usr_infra"],
        headers: { "Idempotency-Key": "idem-free-host-maint-2" },
        body: { action: "verify_storage_posture" },
      },
    );
    expect(lockedMaintRes.status).toBe(409);
    expect(lockedMaintRes.body.error.code).toBe("RESOURCE_LOCKED");
    expect(lockedMaintRes.body.error.retryable).toBe(true);

    const processedMaint = await app.outboxWorker.processPendingOnce();
    expect(processedMaint.succeeded).toBe(1);

    const hostOpRes = await requestJson<{ data: OperationDto }>(maintRes.body.links.self, {
      token: tokens["usr_infra"],
    });
    expect(hostOpRes.status).toBe(200);
    expect(hostOpRes.body.data.status).toBe("succeeded");
    expect(hostOpRes.body.data.kind).toBe("host.maintenance");
    expect(hostOpRes.body.data.steps.every((s) => s.status === "succeeded")).toBe(true);

    const hostOpsListRes = await requestJson<{ data: OperationDto[] }>(
      `/v1/hosts/${DEMO_IDS.hosts.free}/operations`,
      { token: tokens["usr_infra"] },
    );
    expect(hostOpsListRes.status).toBe(200);
    expect(hostOpsListRes.body.data.map((o) => o.id)).toContain(maintRes.body.data.operationId);
    expect(hostSim.getExecutedMaintenanceHistory().length).toBe(1);

    // Allowlisted security policy on allocated host -> 202 Accepted -> succeeded over UDS
    const secRes = await requestJson<AsyncAcceptedEnvelope>(
      `/v1/hosts/${DEMO_IDS.hosts.acme}/security`,
      {
        method: "POST",
        token: tokens["usr_infra"],
        headers: { "Idempotency-Key": "idem-acme-host-sec-1" },
        body: {
          policyRef: "verify_baseline_firewall",
          reason: "Audit dedicated firewall posture",
        },
      },
    );
    expect(secRes.status).toBe(202);

    await app.outboxWorker.processPendingOnce();

    const secOpRes = await requestJson<{ data: OperationDto }>(secRes.body.links.self, {
      token: tokens["usr_infra"],
    });
    expect(secOpRes.status).toBe(200);
    expect(secOpRes.body.data.status).toBe("succeeded");
    expect(secOpRes.body.data.kind).toBe("host.security");
    expect(hostSim.getExecutedSecurityHistory().length).toBe(1);
  });

  it("4. AC-F2-05 & AC-F2-06: Write-only encrypted secrets, 202 lifecycle, idempotency, lock contention, 0400 secret files & Traefik ingress", async () => {
    const plaintextV1 = "Sup3rS3cret_DB_Pass_v1_998877!";
    const plaintextV2 = "Rotat3d_UltraSecret_DB_Pass_v2_445566!";

    // Collaborator without service.configuration.manage gets 403 PERMISSION_DENIED
    const collabSecretDenied = await requestJson<ApiErrorEnvelope>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/secrets`,
      {
        method: "POST",
        token: tokens["usr_marco"],
        headers: { "Idempotency-Key": "idem-collab-secret" },
        body: { secretKey: "DB_PASSWORD", value: plaintextV1 },
      },
    );
    expect(collabSecretDenied.status).toBe(403);
    expect(collabSecretDenied.body.error.code).toBe("PERMISSION_DENIED");

    // Cross-tenant owner gets 404 NOT_FOUND (anti-BOLA)
    const crossTenantSecret = await requestJson<ApiErrorEnvelope>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/secrets`,
      {
        method: "GET",
        token: tokens["usr_giulia"],
      },
    );
    expect(crossTenantSecret.status).toBe(404);
    expect(crossTenantSecret.body.error.code).toBe("NOT_FOUND");

    // Owner creates secret v1
    const createSecRes = await requestJson<{ data: EncryptedSecretMetadataDto }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/secrets`,
      {
        method: "POST",
        token: tokens["usr_elena"],
        headers: { "Idempotency-Key": "idem-create-db-pass-v1" },
        body: {
          secretKey: "DB_PASSWORD",
          value: plaintextV1,
          siteId: DEMO_IDS.sites.acmeShop,
        },
      },
    );
    expect(createSecRes.status).toBe(201);
    expect(createSecRes.body.data.secretKey).toBe("DB_PASSWORD");
    expect(createSecRes.body.data.version).toBe(1);
    expect(createSecRes.rawText).not.toContain(plaintextV1);

    // Owner rotates secret -> v2
    const rotateSecRes = await requestJson<{ data: EncryptedSecretMetadataDto }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/secrets`,
      {
        method: "POST",
        token: tokens["usr_elena"],
        headers: { "Idempotency-Key": "idem-rotate-db-pass-v2" },
        body: {
          secretKey: "DB_PASSWORD",
          value: plaintextV2,
          siteId: DEMO_IDS.sites.acmeShop,
        },
      },
    );
    expect(rotateSecRes.status).toBe(201);
    expect(rotateSecRes.body.data.id).toBe(createSecRes.body.data.id);
    expect(rotateSecRes.body.data.version).toBe(2);
    expect(rotateSecRes.rawText).not.toContain(plaintextV2);

    // List secrets returns metadata ONLY — never plaintext or ciphertext
    const listSecRes = await requestJson<{ data: EncryptedSecretMetadataDto[] }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/secrets?siteId=${DEMO_IDS.sites.acmeShop}`,
      { token: tokens["usr_elena"] },
    );
    expect(listSecRes.status).toBe(200);
    expect(listSecRes.body.data).toHaveLength(1);
    expect(listSecRes.body.data[0]?.version).toBe(2);
    expect(listSecRes.rawText).not.toContain(plaintextV1);
    expect(listSecRes.rawText).not.toContain(plaintextV2);
    expect(listSecRes.rawText).not.toContain("ciphertext");
    expect(listSecRes.rawText).not.toContain("ivBase64");
    expect(listSecRes.rawText).not.toContain("authTagBase64");

    // Instantiate a new service on site_acme_shop referencing DB_PASSWORD
    const createSvcRes = await requestJson<{
      data: { service: ServiceInstanceDto; revision: StackRevisionDto };
    }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/sites/${DEMO_IDS.sites.acmeShop}/services`,
      {
        method: "POST",
        token: tokens["usr_elena"],
        headers: { "Idempotency-Key": "idem-create-shop-app" },
        body: {
          serviceTemplateId: DEMO_IDS.templates.wordpress,
          name: "shop-web-phase2",
          configuration: {
            image: "wordpress:6.6-apache",
            exposeHttp: true,
            env: {
              WORDPRESS_DB_HOST: "shop-db:5432",
            },
          },
          secretRefs: {
            DB_PASSWORD: "DB_PASSWORD",
          },
          resourceLimits: {
            cpuMilli: 500,
            memoryBytes: "536870912",
          },
        },
      },
    );
    expect(createSvcRes.status).toBe(201);
    const serviceId = createSvcRes.body.data.service.id;

    // Trigger async deploy -> 202 Accepted
    const deployRes = await requestJson<AsyncAcceptedEnvelope>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/services/${serviceId}/lifecycle`,
      {
        method: "POST",
        token: tokens["usr_elena"],
        headers: { "Idempotency-Key": "idem-deploy-shop-1" },
        body: { action: "deploy", reason: "Initial Phase 2 rollout" },
      },
    );
    expect(deployRes.status).toBe(202);
    expect(deployRes.body.data.status).toBe("queued");
    expect(deployRes.body.data.resourceId).toBe(serviceId);
    expect(deployRes.body.links.self).toBe(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/operations/${deployRes.body.data.operationId}`,
    );

    // Idempotent replay with same Idempotency-Key returns same operationId
    const replayRes = await requestJson<AsyncAcceptedEnvelope>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/services/${serviceId}/lifecycle`,
      {
        method: "POST",
        token: tokens["usr_elena"],
        headers: { "Idempotency-Key": "idem-deploy-shop-1" },
        body: { action: "deploy", reason: "Initial Phase 2 rollout" },
      },
    );
    expect(replayRes.status).toBe(202);
    expect(replayRes.body.data.operationId).toBe(deployRes.body.data.operationId);

    // Concurrent lifecycle call with different Idempotency-Key while locked -> 409 RESOURCE_LOCKED
    const conflictRes = await requestJson<ApiErrorEnvelope>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/services/${serviceId}/lifecycle`,
      {
        method: "POST",
        token: tokens["usr_elena"],
        headers: { "Idempotency-Key": "idem-restart-while-locked" },
        body: { action: "restart" },
      },
    );
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error.code).toBe("RESOURCE_LOCKED");

    // Verify outbox_events and stack_revisions in DB contain ZERO plaintext secrets
    const allOutboxRows = await app.dbClient.db.select().from(outboxEvents);
    const allRevisions = await app.dbClient.db.select().from(stackRevisions);
    expect(JSON.stringify(allOutboxRows)).not.toContain(plaintextV2);
    expect(JSON.stringify(allRevisions)).not.toContain(plaintextV2);

    // Process outbox over signed Unix Domain Socket IPC
    const processed = await app.outboxWorker.processPendingOnce();
    expect(processed.succeeded).toBe(1);

    const opDetailRes = await requestJson<{ data: OperationDto }>(deployRes.body.links.self, {
      token: tokens["usr_elena"],
    });
    expect(opDetailRes.status).toBe(200);
    expect(opDetailRes.body.data.status).toBe("succeeded");
    expect(opDetailRes.body.data.steps.map((s) => s.key)).toEqual([
      "validate_spec",
      "dispatch_ipc",
      "reconcile_state",
    ]);
    expect(opDetailRes.body.data.steps.every((s) => s.status === "succeeded")).toBe(true);

    // Verify 0400 secret file written on disk & *_FILE env convention (never raw plaintext env!)
    const secretFilePath = path.join(secretsRootDir, serviceId, "DB_PASSWORD");
    const secretFileStat = await stat(secretFilePath);
    expect(secretFileStat.mode & 0o777).toBe(0o400);
    const secretFileContent = await readFile(secretFilePath, "utf8");
    expect(secretFileContent).toBe(plaintextV2);

    const inspect = dockerSim.getSimulatedContainerInspect(serviceId);
    expect(inspect).not.toBeNull();
    expect(inspect?.State?.Running).toBe(true);
    expect(inspect?.HostConfig?.Privileged).toBe(false);
    expect(inspect?.HostConfig?.CapDrop).toContain("ALL");
    expect(inspect?.Config?.Env).toContain("DB_PASSWORD_FILE=/run/secrets/DB_PASSWORD");
    expect((inspect?.Config?.Env ?? []).join("\n")).not.toContain(plaintextV2);

    // Verify dynamic Traefik ingress config routes negozio.acme.it
    const dynamicTraefikPath = path.join(
      ingressRootDir,
      "dynamic",
      `site_${DEMO_IDS.sites.acmeShop}.yml`,
    );
    const dynamicYaml = await readFile(dynamicTraefikPath, "utf8");
    expect(dynamicYaml).toContain("Host(`negozio.acme.it`)");

    // Restart -> 202 -> succeeded
    const restartRes = await requestJson<AsyncAcceptedEnvelope>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/services/${serviceId}/lifecycle`,
      {
        method: "POST",
        token: tokens["usr_elena"],
        headers: { "Idempotency-Key": "idem-restart-shop-1" },
        body: { action: "restart", reason: "Rolling config check" },
      },
    );
    expect(restartRes.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const restartOp = await requestJson<{ data: OperationDto }>(restartRes.body.links.self, {
      token: tokens["usr_elena"],
    });
    expect(restartOp.body.data.status).toBe("succeeded");

    // Stop -> 202 -> succeeded & purges secret file on disk
    const stopRes = await requestJson<AsyncAcceptedEnvelope>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/services/${serviceId}/lifecycle`,
      {
        method: "POST",
        token: tokens["usr_elena"],
        headers: { "Idempotency-Key": "idem-stop-shop-1" },
        body: { action: "stop", reason: "Maintenance window" },
      },
    );
    expect(stopRes.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    const stopOp = await requestJson<{ data: OperationDto }>(stopRes.body.links.self, {
      token: tokens["usr_elena"],
    });
    expect(stopOp.body.data.status).toBe("succeeded");
    await expect(stat(secretFilePath)).rejects.toThrow();

    // Delete encrypted secret
    const deleteSecRes = await requestJson<{ data: { deleted: boolean; secretId: string } }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/secrets/${createSecRes.body.data.id}`,
      {
        method: "DELETE",
        token: tokens["usr_elena"],
      },
    );
    expect(deleteSecRes.status).toBe(200);
    expect(deleteSecRes.body.data).toEqual({
      deleted: true,
      secretId: createSecRes.body.data.id,
    });
  });

  it("5. AC-F2-07: unknown crash recovery inspects read-only observed state and NEVER performs blind mutating replay", async () => {
    // Create and deploy a service cleanly first
    const svcRes = await requestJson<{
      data: { service: ServiceInstanceDto; revision: StackRevisionDto };
    }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/sites/${DEMO_IDS.sites.acmeShop}/services`,
      {
        method: "POST",
        token: tokens["usr_elena"],
        headers: { "Idempotency-Key": "idem-create-recovery-svc-a" },
        body: {
          serviceTemplateId: DEMO_IDS.templates.wordpress,
          name: "recovery-converged-svc",
          configuration: { image: "wordpress:6.6-apache", exposeHttp: false },
        },
      },
    );
    expect(svcRes.status).toBe(201);
    const convergedSvcId = svcRes.body.data.service.id;

    const initialDeploy = await requestJson<AsyncAcceptedEnvelope>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/services/${convergedSvcId}/lifecycle`,
      {
        method: "POST",
        token: tokens["usr_elena"],
        headers: { "Idempotency-Key": "idem-deploy-recovery-a-init" },
        body: { action: "deploy" },
      },
    );
    expect(initialDeploy.status).toBe(202);
    await app.outboxWorker.processPendingOnce();

    // Enqueue a second deploy and simulate API crash after IPC completed (in-flight lease expired)
    const crashedOpEnvelope = await requestJson<AsyncAcceptedEnvelope>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/services/${convergedSvcId}/lifecycle`,
      {
        method: "POST",
        token: tokens["usr_elena"],
        headers: { "Idempotency-Key": "idem-deploy-recovery-a-crashed" },
        body: { action: "deploy" },
      },
    );
    expect(crashedOpEnvelope.status).toBe(202);
    const crashedOpIdA = crashedOpEnvelope.body.data.operationId;

    await app.dbClient.db
      .update(operations)
      .set({
        status: "processing",
        startedAt: new Date(Date.now() - 60_000),
        leaseExpiresAt: new Date(Date.now() - 5_000),
      })
      .where(eq(operations.id, crashedOpIdA));
    await app.dbClient.db
      .update(outboxEvents)
      .set({ status: "published" })
      .where(eq(outboxEvents.aggregateId, convergedSvcId));

    // Also create an undeployed service B whose deploy crashed BEFORE reaching runtime
    const svcBRes = await requestJson<{
      data: { service: ServiceInstanceDto; revision: StackRevisionDto };
    }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/sites/${DEMO_IDS.sites.acmeShop}/services`,
      {
        method: "POST",
        token: tokens["usr_elena"],
        headers: { "Idempotency-Key": "idem-create-recovery-svc-b" },
        body: {
          serviceTemplateId: DEMO_IDS.templates.wordpress,
          name: "recovery-unconverged-svc",
          configuration: { image: "wordpress:6.6-apache", exposeHttp: false },
        },
      },
    );
    expect(svcBRes.status).toBe(201);
    const unconvergedSvcId = svcBRes.body.data.service.id;

    const crashedBEnvelope = await requestJson<AsyncAcceptedEnvelope>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/services/${unconvergedSvcId}/lifecycle`,
      {
        method: "POST",
        token: tokens["usr_elena"],
        headers: { "Idempotency-Key": "idem-deploy-recovery-b-crashed" },
        body: { action: "deploy" },
      },
    );
    expect(crashedBEnvelope.status).toBe(202);
    const crashedOpIdB = crashedBEnvelope.body.data.operationId;

    await app.dbClient.db
      .update(operations)
      .set({
        status: "processing",
        startedAt: new Date(Date.now() - 60_000),
        leaseExpiresAt: new Date(Date.now() - 5_000),
      })
      .where(eq(operations.id, crashedOpIdB));
    await app.dbClient.db
      .update(outboxEvents)
      .set({ status: "published" })
      .where(eq(outboxEvents.aggregateId, unconvergedSvcId));

    const deploySpy = vi.spyOn(dockerSim, "deployService");
    const restartSpy = vi.spyOn(dockerSim, "restartService");
    const stopSpy = vi.spyOn(dockerSim, "stopService");

    try {
      const recovery = await app.outboxWorker.recoverUnknownOperations();
      expect(recovery.markedUnknown).toBe(2);
      expect(recovery.convergedSucceeded).toBe(1);
      expect(recovery.convergedFailed).toBe(1);

      // CRITICAL (TH-08 / AC-F2-07): zero mutating executor calls during crash recovery!
      expect(deploySpy).not.toHaveBeenCalled();
      expect(restartSpy).not.toHaveBeenCalled();
      expect(stopSpy).not.toHaveBeenCalled();
    } finally {
      deploySpy.mockRestore();
      restartSpy.mockRestore();
      stopSpy.mockRestore();
    }

    const opARes = await requestJson<{ data: OperationDto }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/operations/${crashedOpIdA}`,
      { token: tokens["usr_elena"] },
    );
    expect(opARes.body.data.status).toBe("succeeded");

    const opBRes = await requestJson<{ data: OperationDto }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/operations/${crashedOpIdB}`,
      { token: tokens["usr_elena"] },
    );
    expect(opBRes.body.data.status).toBe("failed");
    expect(opBRes.body.data.errorCode).toBe("OPERATION_INTERRUPTED");

    // Verify lock on service B was cleanly released so fresh deploy succeeds
    const retryBDeploy = await requestJson<AsyncAcceptedEnvelope>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/services/${unconvergedSvcId}/lifecycle`,
      {
        method: "POST",
        token: tokens["usr_elena"],
        headers: { "Idempotency-Key": "idem-deploy-recovery-b-fresh" },
        body: { action: "deploy" },
      },
    );
    expect(retryBDeploy.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
  });

  it("6. AC-F2-08: Observe-only drift reconciler records out-of-band container tampering and emits audit event WITHOUT restarting or mutating container", async () => {
    const siteBefore = await requestJson<{ data: SiteDetailDto }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/sites/${DEMO_IDS.sites.acmeShop}`,
      { token: tokens["usr_elena"] },
    );
    expect(siteBefore.status).toBe(200);
    const runningSvc = siteBefore.body.data.services.find(
      (s) => s.name === "recovery-converged-svc",
    );
    expect(runningSvc).toBeDefined();
    const targetServiceId = runningSvc!.id;

    // Tamper with container image out-of-band
    dockerSim.simulateOutOfBandModification(targetServiceId, {
      image: "wordpress:tampered-out-of-band",
    });

    const deploySpy = vi.spyOn(dockerSim, "deployService");
    const restartSpy = vi.spyOn(dockerSim, "restartService");
    const stopSpy = vi.spyOn(dockerSim, "stopService");

    try {
      const summary = await app.driftReconciler.reconcileAllOnce();
      expect(summary.driftedServices).toBeGreaterThanOrEqual(1);

      // CRITICAL (TH-10 / AC-F2-08): zero auto-restarts or mutations!
      expect(deploySpy).not.toHaveBeenCalled();
      expect(restartSpy).not.toHaveBeenCalled();
      expect(stopSpy).not.toHaveBeenCalled();
    } finally {
      deploySpy.mockRestore();
      restartSpy.mockRestore();
      stopSpy.mockRestore();
    }

    // Container remains untouched (still running tampered image, RestartCount === 0)
    const inspectAfter = dockerSim.getSimulatedContainerInspect(targetServiceId);
    expect(inspectAfter?.Config?.Image).toBe("wordpress:tampered-out-of-band");
    expect(inspectAfter?.RestartCount).toBe(0);

    // Site aggregate reflects drifted + degraded state
    const siteAfter = await requestJson<{ data: SiteDetailDto }>(
      `/v1/organizations/${DEMO_IDS.organizations.acme}/sites/${DEMO_IDS.sites.acmeShop}`,
      { token: tokens["usr_elena"] },
    );
    expect(siteAfter.status).toBe(200);
    expect(siteAfter.body.data.driftSummary.overallDriftStatus).toBe("drifted");
    expect(siteAfter.body.data.driftSummary.driftedCount).toBeGreaterThanOrEqual(1);
    expect(siteAfter.body.data.status).toBe("degraded");

    // System audit event recorded for drift detection
    const auditRes = await requestJson<{ data: AuditEventDto[] }>(
      "/v1/admin/audit?action=service.drift.detected",
      { token: tokens["usr_infra"] },
    );
    expect(auditRes.status).toBe(200);
    expect(
      auditRes.body.data.some(
        (ev) => ev.actorType === "system" && ev.targetId === targetServiceId,
      ),
    ).toBe(true);
  });

  it("7. Break-glass procedures (HCP-SPEC-003 §9.1): unlock stuck unknown operation & mint <=300s audited emergency token", async () => {
    // Enqueue a host maintenance operation and place it in 'unknown' status
    const stuckRes = await requestJson<AsyncAcceptedEnvelope>(
      `/v1/hosts/${DEMO_IDS.hosts.free}/maintenance`,
      {
        method: "POST",
        token: tokens["usr_infra"],
        headers: { "Idempotency-Key": "idem-stuck-breakglass-op" },
        body: { action: "refresh_host_inventory" },
      },
    );
    expect(stuckRes.status).toBe(202);
    const stuckOpId = stuckRes.body.data.operationId;

    await app.dbClient.db
      .update(operations)
      .set({ status: "unknown" })
      .where(eq(operations.id, stuckOpId));
    await app.dbClient.db
      .update(outboxEvents)
      .set({ status: "published" })
      .where(eq(outboxEvents.aggregateId, DEMO_IDS.hosts.free));

    // Break-glass unlock requires non-empty reason
    await expect(
      runBreakGlassUnlock({
        dbClient: app.dbClient,
        operationId: stuckOpId,
        reason: "   ",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const unlocked = await runBreakGlassUnlock({
      dbClient: app.dbClient,
      operationId: stuckOpId,
      reason: "Operator manually verified host inventory state over console",
      actorId: DEMO_IDS.users.infra,
    });
    expect(unlocked.operation.status).toBe("failed");
    expect(unlocked.operation.errorCode).toBe("OPERATION_INTERRUPTED");
    expect(unlocked.auditEvent.actorType).toBe("system");
    expect(unlocked.auditEvent.action).toBe("breakglass.operation.unlock");

    // Break-glass emergency token clamps TTL to 300s (5 min) and writes mandatory system audit event
    const emergency = await issueBreakGlassEmergencyToken({
      dbClient: app.dbClient,
      oidcService: app.oidc,
      ttlSeconds: 7200,
      reason: "External OIDC provider outage during P1 incident",
    });
    expect(emergency.ttlSeconds).toBe(300);
    expect(emergency.token.expiresIn).toBe(300);
    expect(emergency.userId).toBe(DEMO_IDS.users.infra);

    const hostsWithEmergencyJwt = await requestJson<{ data: unknown[] }>("/v1/hosts", {
      token: emergency.token.accessToken,
    });
    expect(hostsWithEmergencyJwt.status).toBe(200);
    expect(hostsWithEmergencyJwt.body.data.length).toBeGreaterThanOrEqual(2);

    const tokenAuditRes = await requestJson<{ data: AuditEventDto[] }>(
      "/v1/admin/audit?action=breakglass.token.issued",
      { token: emergency.token.accessToken },
    );
    expect(tokenAuditRes.status).toBe(200);
    expect(
      tokenAuditRes.body.data.some(
        (ev) => ev.id === emergency.auditEventId && ev.actorType === "system",
      ),
    ).toBe(true);
  });

  it("8. Local-simulator runtimeBackend default wiring and auto-triggered background outbox dispatch work cleanly", async () => {
    const simApp = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      enableDevOidc: true,
      runtimeBackend: "local-simulator",
      autoProcessOutbox: true,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
    });

    try {
      expect(simApp.runtimeBackend).toBe("local-simulator");
      const tokenRes = await fetch(`${simApp.baseUrl}/v1/dev/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "usr_infra" }),
      });
      const tokenJson = (await tokenRes.json()) as { data: { accessToken: string } };

      const maintRes = await fetch(
        `${simApp.baseUrl}/v1/hosts/${DEMO_IDS.hosts.acme}/maintenance`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokenJson.data.accessToken}`,
            "Content-Type": "application/json",
            "Idempotency-Key": "idem-sim-auto-maint",
          },
          body: JSON.stringify({ action: "collect_diagnostics" }),
        },
      );
      expect(maintRes.status).toBe(202);
      const accepted = (await maintRes.json()) as AsyncAcceptedEnvelope;

      // Wait briefly for non-blocking triggerAsync() to complete
      let finalStatus = accepted.data.status;
      for (let attempt = 0; attempt < 20 && finalStatus !== "succeeded"; attempt += 1) {
        await new Promise((r) => setTimeout(r, 25));
        const pollRes = await fetch(`${simApp.baseUrl}${accepted.links.self}`, {
          headers: { Authorization: `Bearer ${tokenJson.data.accessToken}` },
        });
        const pollJson = (await pollRes.json()) as { data: OperationDto };
        finalStatus = pollJson.data.status;
      }
      expect(finalStatus).toBe("succeeded");
    } finally {
      await simApp.close();
    }
  });

  it("9. Cross-process break-glass token (F-01): standalone OidcService with shared breakglassSigningKey verifies on API and denies non-infrastructure_admin principals", async () => {
    const sharedBreakglassHex = randomBytes(32).toString("hex");
    const bgApp = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      enableDevOidc: false,
      runtimeBackend: "local-simulator",
      breakglassSigningKey: sharedBreakglassHex,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
    });

    try {
      // Simulate standalone CLI process instantiating its own OidcService (separate RSA keypair, shared HS256 break-glass key)
      const standaloneCliOidc = new OidcService({
        oidcIssuer: bgApp.oidc.issuer,
        oidcAudience: bgApp.oidc.audience,
        enableDevOidc: false,
        runtimeBackend: "disabled",
        secretsMasterKey: Buffer.alloc(32, 0),
        breakglassSigningKey: parseBreakglassSigningKey(sharedBreakglassHex),
        autoProcessOutbox: false,
      });
      await standaloneCliOidc.onModuleInit();

      // Non-infrastructure_admin principals MUST be denied
      await expect(
        issueBreakGlassEmergencyToken({
          dbClient: bgApp.dbClient,
          oidcService: standaloneCliOidc,
          userId: DEMO_IDS.users.elena,
          reason: "Attempted tenant escalation",
        }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

      await expect(
        issueBreakGlassEmergencyToken({
          dbClient: bgApp.dbClient,
          oidcService: standaloneCliOidc,
          userId: DEMO_IDS.users.hosting,
          reason: "Attempted hosting_admin escalation",
        }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

      // Active infrastructure_admin succeeds and works across distinct OidcService instances
      const issued = await issueBreakGlassEmergencyToken({
        dbClient: bgApp.dbClient,
        oidcService: standaloneCliOidc,
        userId: DEMO_IDS.users.infra,
        ttlSeconds: 180,
        reason: "External IdP unreachable — cross-process CLI verification",
      });
      expect(issued.ttlSeconds).toBe(180);

      const hostsRes = await fetch(`${bgApp.baseUrl}/v1/hosts`, {
        headers: { Authorization: `Bearer ${issued.token.accessToken}` },
      });
      expect(hostsRes.status).toBe(200);

      const deniedAuditRes = await fetch(
        `${bgApp.baseUrl}/v1/admin/audit?action=breakglass.token.denied`,
        {
          headers: { Authorization: `Bearer ${issued.token.accessToken}` },
        },
      );
      expect(deniedAuditRes.status).toBe(200);
      const deniedBody = (await deniedAuditRes.json()) as { data: AuditEventDto[] };
      expect(deniedBody.data.length).toBeGreaterThanOrEqual(2);
    } finally {
      await bgApp.close();
    }
  });

  it("10. In-flight IPC timeout (F-03 / TH-08): post-dispatch socket timeout marks operation 'unknown', preserves lockKey, prevents blind replay, and converges via read-only recovery", async () => {
    const netMod = await import("node:net");
    const httpMod = await import("node:http");
    const slowTmpDir = await mkdtemp(path.join(os.tmpdir(), "hp-f03-timeout-"));
    const slowSocketPath = path.join(slowTmpDir, "slow-executor.sock");
    const innerSim = new InMemoryDockerSimulatorAdapter();
    const signingKey = {
      keyId: "ipc-f03-key",
      algorithm: "hmac-sha256" as const,
      secret: randomBytes(32).toString("hex"),
    };

    let deployCalls = 0;
    let observedCalls = 0;
    let shouldHangDeployResponse = true;
    const openSockets = new Set<import("node:net").Socket>();

    const rawServer = httpMod.default.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void (async () => {
          const url = req.url ?? "/";
          if (req.method === "POST" && url === "/v1/services/deploy") {
            deployCalls += 1;
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              spec: Parameters<InMemoryDockerSimulatorAdapter["deployService"]>[0];
            };
            const result = await innerSim.deployService(parsed.spec);
            if (shouldHangDeployResponse) {
              // Intentionally withhold response past client timeoutMs to simulate post-execution socket stall
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ data: result }));
            return;
          }

          if (req.method === "GET" && url.endsWith("/observed-state")) {
            observedCalls += 1;
            const parts = url.split("/");
            const svcId = decodeURIComponent(parts[3] ?? "");
            const obs = await innerSim.getObservedState(svcId);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ data: obs }));
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              daemon: "hp-docker-executor",
              dockerReachable: true,
              timestamp: new Date().toISOString(),
            }),
          );
        })();
      });
    });

    rawServer.on("connection", (sock: import("node:net").Socket) => {
      openSockets.add(sock);
      sock.on("close", () => openSockets.delete(sock));
    });

    await new Promise<void>((resolve) => rawServer.listen(slowSocketPath, resolve));

    const ipcClient = new SignedDockerExecutorIpcClient({
      signingKey,
      transport: "uds",
      socketPath: slowSocketPath,
      timeoutMs: 120,
    });

    const f03App = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      enableDevOidc: true,
      runtimeBackend: "local-simulator",
      dockerExecutor: ipcClient,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });

    try {
      const tokRes = await fetch(`${f03App.baseUrl}/v1/dev/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "usr_elena" }),
      });
      const elenaJwt = ((await tokRes.json()) as { data: { accessToken: string } }).data
        .accessToken;

      const createSvcRes = await fetch(
        `${f03App.baseUrl}/v1/organizations/${DEMO_IDS.organizations.acme}/sites/${DEMO_IDS.sites.acmeShop}/services`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${elenaJwt}`,
            "Content-Type": "application/json",
            "Idempotency-Key": "idem-f03-svc-create",
          },
          body: JSON.stringify({
            serviceTemplateId: DEMO_IDS.templates.wordpress,
            name: "f03-ambiguous-timeout-svc",
            configuration: { image: "wordpress:6.6-apache", exposeHttp: false },
          }),
        },
      );
      expect(createSvcRes.status).toBe(201);
      const svcId = (
        (await createSvcRes.json()) as { data: { service: ServiceInstanceDto } }
      ).data.service.id;

      const deployRes = await fetch(
        `${f03App.baseUrl}/v1/organizations/${DEMO_IDS.organizations.acme}/services/${svcId}/lifecycle`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${elenaJwt}`,
            "Content-Type": "application/json",
            "Idempotency-Key": "idem-f03-svc-deploy",
          },
          body: JSON.stringify({ action: "deploy" }),
        },
      );
      expect(deployRes.status).toBe(202);
      const deployEnvelope = (await deployRes.json()) as AsyncAcceptedEnvelope;

      // 1. Outbox dispatches mutating POST; socket times out AFTER executor mutated state
      await f03App.outboxWorker.processPendingOnce();
      expect(deployCalls).toBe(1);

      const opAfterTimeoutRes = await fetch(
        `${f03App.baseUrl}${deployEnvelope.links.self}`,
        { headers: { Authorization: `Bearer ${elenaJwt}` } },
      );
      const opAfterTimeout = (
        (await opAfterTimeoutRes.json()) as { data: OperationDto }
      ).data;

      // MUST transition to 'unknown' (OPERATION_AMBIGUOUS), NOT 'failed'!
      expect(opAfterTimeout.status).toBe("unknown");
      expect(opAfterTimeout.errorCode).toBe("OPERATION_AMBIGUOUS");

      // 2. Resource lock MUST still be held while status is 'unknown'
      const conflictingRes = await fetch(
        `${f03App.baseUrl}/v1/organizations/${DEMO_IDS.organizations.acme}/services/${svcId}/lifecycle`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${elenaJwt}`,
            "Content-Type": "application/json",
            "Idempotency-Key": "idem-f03-conflict-while-unknown",
          },
          body: JSON.stringify({ action: "restart" }),
        },
      );
      expect(conflictingRes.status).toBe(409);
      const conflictErr = (await conflictingRes.json()) as ApiErrorEnvelope;
      expect(conflictErr.error.code).toBe("RESOURCE_LOCKED");

      // 3. Subsequent outbox poll MUST NOT re-dispatch the mutating deploy
      await f03App.outboxWorker.processPendingOnce();
      expect(deployCalls).toBe(1);

      // 4. Read-only crash recovery converges the operation to 'succeeded' with ZERO extra deploys
      shouldHangDeployResponse = false;
      const recovery = await f03App.outboxWorker.recoverUnknownOperations();
      expect(recovery.convergedSucceeded).toBe(1);
      expect(deployCalls).toBe(1);
      expect(observedCalls).toBeGreaterThanOrEqual(1);

      const opConvergedRes = await fetch(
        `${f03App.baseUrl}${deployEnvelope.links.self}`,
        { headers: { Authorization: `Bearer ${elenaJwt}` } },
      );
      const opConverged = ((await opConvergedRes.json()) as { data: OperationDto }).data;
      expect(opConverged.status).toBe("succeeded");
      void netMod;
    } finally {
      await f03App.close();
      for (const s of openSockets) {
        s.destroy();
      }
      await new Promise<void>((resolve) => rawServer.close(() => resolve()));
      await rm(slowTmpDir, { recursive: true, force: true });
    }
  });

  it("11. Host telemetry coalesces dockerEngineReachable from online docker_executor heartbeat when host-agent isolates docker.sock (F-05)", async () => {
    const isolatedHostSim = new InMemoryHostSimulatorAdapter();
    vi.spyOn(isolatedHostSim, "getHostTelemetry").mockResolvedValueOnce({
      hostId: DEMO_IDS.hosts.acme,
      cpuUsagePercent: 12.4,
      memoryUsedBytes: "2147483648",
      memoryTotalBytes: "17179869184",
      storageUsedBytes: "10737418240",
      storageTotalBytes: "107374182400",
      uptimeSeconds: 86_400,
      kernelVersion: "Linux 7.3.3-1-cachyos",
      dockerEngineReachable: false,
      collectedAt: new Date().toISOString(),
    });

    const f05App = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      enableDevOidc: true,
      runtimeBackend: "local-simulator",
      hostAgent: isolatedHostSim,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
    });

    try {
      await f05App.driftReconciler.reconcileAllOnce();

      const tokRes = await fetch(`${f05App.baseUrl}/v1/dev/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "usr_infra" }),
      });
      const infraJwt = ((await tokRes.json()) as { data: { accessToken: string } }).data
        .accessToken;

      const telRes = await fetch(
        `${f05App.baseUrl}/v1/hosts/${DEMO_IDS.hosts.acme}/telemetry`,
        { headers: { Authorization: `Bearer ${infraJwt}` } },
      );
      expect(telRes.status).toBe(200);
      const telBody = (await telRes.json()) as {
        data: { telemetry: HostTelemetryDto; daemons: HostDaemonHeartbeatDto[] };
      };
      expect(
        telBody.data.daemons.some(
          (d) => d.component === "docker_executor" && d.status === "online",
        ),
      ).toBe(true);
      expect(telBody.data.telemetry.dockerEngineReachable).toBe(true);
    } finally {
      await f05App.close();
    }
  });
});
