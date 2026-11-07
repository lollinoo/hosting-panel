import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { HealthProbeService } from "../operations/health-probe.service.js";
import { SecretVaultService } from "../vault/secret-vault.service.js";

export type FakeDeployBehavior = "normal" | "timeout" | "rate_limit" | "unauthorized";
export type FakeRequestBehavior = "normal" | "rate_limit" | "unauthorized" | "unavailable";

export interface FakeCoolifyRequestRecord {
  readonly method: string;
  readonly path: string;
  readonly fullUrl: string;
  readonly teamId: string | null;
  readonly requestId: string | null;
  readonly timestamp: string;
}

interface FakeTeamTokenGrant {
  readonly teamId: string;
  readonly scopes: ReadonlySet<"read" | "write" | "deploy">;
}

interface MutableFakeServer {
  readonly uuid: string;
  readonly teamId: string;
  name: string;
  ip: string;
  port: number;
  region: string;
  status: string;
  health: string;
  isReachable: boolean;
  isUsable: boolean;
  sentinelEnabled: boolean;
  pinnedHeartbeatIso: string | null;
}

interface MutableFakeApplication {
  readonly uuid: string;
  readonly teamId: string;
  name: string;
  fqdn: string;
  status: string;
  healthStatus: string;
  gitRepository: string;
  gitBranch: string;
  buildPack: string;
  environmentName: string;
}

interface MutableFakeDatabase {
  readonly uuid: string;
  readonly teamId: string;
  readonly name: string;
  readonly databaseType: string;
  readonly engine: string;
  readonly version: string;
  status: string;
  health: string;
  readonly internalDbUrl: string;
  readonly port: number;
}

interface MutableFakeDeployment {
  readonly deploymentUuid: string;
  readonly applicationUuid: string;
  readonly teamId: string;
  status: "queued" | "in_progress" | "finished" | "failed" | "cancelled";
  commitSha: string;
  startedAt: string;
  finishedAt: string | null;
}

export interface CreateFakeCoolifyLabServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly secretVault?: SecretVaultService;
  readonly healthProbeService?: HealthProbeService;
  readonly timeoutDelayMs?: number;
}

export interface FakeCoolifyLabServer {
  readonly server: Server;
  readonly baseUrl: string;
  readonly port: number;
  getRequests(): readonly FakeCoolifyRequestRecord[];
  clearRequests(): void;
  setHealthProbeOutcome(appResourceId: string, healthy: boolean): void;
  setNextDeployBehavior(behavior: FakeDeployBehavior): void;
  setNextRequestBehavior(behavior: FakeRequestBehavior): void;
  setTeamTokenRevoked(teamId: string, revoked: boolean): void;
  setServerHeartbeatTimestamp(providerServerId: string, iso: string | null): void;
  setDeploymentStatus(
    deploymentUuid: string,
    status: "queued" | "in_progress" | "finished" | "failed" | "cancelled",
  ): void;
  resetSimulations(): void;
  close(): Promise<void>;
}

const TEAM_VAULT_REFS = [
  {
    teamId: "team_acme",
    readRef: "vault://coolify/acme/read",
    writeRef: "vault://coolify/acme/write",
    deployRef: "vault://coolify/acme/deploy",
  },
  {
    teamId: "team_beta",
    readRef: "vault://coolify/beta/read",
    writeRef: "vault://coolify/beta/write",
    deployRef: "vault://coolify/beta/deploy",
  },
  {
    teamId: "team_legacy",
    readRef: "vault://coolify/legacy/read",
    writeRef: null,
    deployRef: "vault://coolify/legacy/deploy",
  },
] as const;

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders?: Readonly<Record<string, string>>,
): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  const serialized = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(serialized, "utf8")),
    ...extraHeaders,
  });
  res.end(serialized);
}

export async function createFakeCoolifyLabServer(
  options?: CreateFakeCoolifyLabServerOptions,
): Promise<FakeCoolifyLabServer> {
  const host = options?.host ?? "127.0.0.1";
  const requestedPort = options?.port ?? 0;
  const secretVault = options?.secretVault ?? new SecretVaultService();
  const healthProbeService = options?.healthProbeService;
  const timeoutDelayMs = options?.timeoutDelayMs ?? 2_500;

  const requests: FakeCoolifyRequestRecord[] = [];
  const revokedTeams = new Set<string>();
  const activeTimeoutTimers = new Set< ReturnType<typeof setTimeout> >();
  let nextDeployBehavior: FakeDeployBehavior = "normal";
  let nextRequestBehavior: FakeRequestBehavior = "normal";
  let deploymentCounter = 100;

  const servers = new Map<string, MutableFakeServer>();
  const applications = new Map<string, MutableFakeApplication>();
  const databases = new Map<string, MutableFakeDatabase>();
  const deployments = new Map<string, MutableFakeDeployment>();

  function seedState(): void {
    servers.clear();
    applications.clear();
    databases.clear();
    deployments.clear();

    servers.set("coolify-srv-acme-01", {
      uuid: "coolify-srv-acme-01",
      teamId: "team_acme",
      name: "milano-prod-01",
      ip: "198.51.100.10",
      port: 22,
      region: "eu-south-1",
      status: "running",
      health: "healthy",
      isReachable: true,
      isUsable: true,
      sentinelEnabled: true,
      pinnedHeartbeatIso: null,
    });
    servers.set("coolify-srv-beta-01", {
      uuid: "coolify-srv-beta-01",
      teamId: "team_beta",
      name: "torino-prod-01",
      ip: "198.51.100.20",
      port: 22,
      region: "eu-south-1",
      status: "running",
      health: "healthy",
      isReachable: true,
      isUsable: true,
      sentinelEnabled: true,
      pinnedHeartbeatIso: null,
    });
    servers.set("coolify-srv-legacy-01", {
      uuid: "coolify-srv-legacy-01",
      teamId: "team_legacy",
      name: "roma-legacy-01",
      ip: "198.51.100.30",
      port: 22,
      region: "eu-south-1",
      status: "stopped",
      health: "unknown",
      isReachable: true,
      isUsable: true,
      sentinelEnabled: false,
      pinnedHeartbeatIso: null,
    });

    applications.set("coolify-app-acme-storefront", {
      uuid: "coolify-app-acme-storefront",
      teamId: "team_acme",
      name: "Acme Storefront",
      fqdn: "store.acme.it",
      status: "running:healthy",
      healthStatus: "healthy",
      gitRepository: "https://git.acme.it/acme/storefront",
      gitBranch: "main",
      buildPack: "nixpacks",
      environmentName: "production",
    });
    applications.set("coolify-app-acme-api", {
      uuid: "coolify-app-acme-api",
      teamId: "team_acme",
      name: "Acme Core API",
      fqdn: "api.acme.it",
      status: "running:healthy",
      healthStatus: "healthy",
      gitRepository: "https://git.acme.it/acme/core-api",
      gitBranch: "main",
      buildPack: "dockerfile",
      environmentName: "production",
    });
    applications.set("coolify-app-beta-portal", {
      uuid: "coolify-app-beta-portal",
      teamId: "team_beta",
      name: "Beta Client Portal",
      fqdn: "portal.betastudios.it",
      status: "running:healthy",
      healthStatus: "healthy",
      gitRepository: "https://git.betastudios.it/beta/portal",
      gitBranch: "main",
      buildPack: "nixpacks",
      environmentName: "production",
    });
    applications.set("coolify-app-legacy-site", {
      uuid: "coolify-app-legacy-site",
      teamId: "team_legacy",
      name: "Legacy Corporate Site",
      fqdn: "www.legacycorp.it",
      status: "stopped",
      healthStatus: "unknown",
      gitRepository: "https://git.legacycorp.it/web/site",
      gitBranch: "master",
      buildPack: "static",
      environmentName: "production",
    });

    databases.set("coolify-db-acme-pg", {
      uuid: "coolify-db-acme-pg",
      teamId: "team_acme",
      name: "Acme Primary PostgreSQL",
      databaseType: "coolify-postgresql",
      engine: "postgresql",
      version: "18.1",
      status: "running:healthy",
      health: "healthy",
      internalDbUrl: "postgresql://acme_admin:lab_db_secret_pg@acme-postgres.internal:5432/acme",
      port: 5432,
    });
    databases.set("coolify-db-acme-redis", {
      uuid: "coolify-db-acme-redis",
      teamId: "team_acme",
      name: "Acme Session Redis",
      databaseType: "coolify-redis",
      engine: "redis",
      version: "7.4",
      status: "running:healthy",
      health: "healthy",
      internalDbUrl: "redis://default:lab_db_secret_redis@acme-redis.internal:6379/0",
      port: 6379,
    });

    const initialStarted = "2026-11-07T06:58:30.000Z";
    const initialFinished = "2026-11-07T07:00:00.000Z";
    deployments.set("coolify-dep-storefront-01", {
      deploymentUuid: "coolify-dep-storefront-01",
      applicationUuid: "coolify-app-acme-storefront",
      teamId: "team_acme",
      status: "finished",
      commitSha: "a1b2c3d4e5f6",
      startedAt: initialStarted,
      finishedAt: initialFinished,
    });
    deployments.set("coolify-dep-api-01", {
      deploymentUuid: "coolify-dep-api-01",
      applicationUuid: "coolify-app-acme-api",
      teamId: "team_acme",
      status: "finished",
      commitSha: "f6e5d4c3b2a1",
      startedAt: initialStarted,
      finishedAt: initialFinished,
    });
    deployments.set("coolify-dep-beta-01", {
      deploymentUuid: "coolify-dep-beta-01",
      applicationUuid: "coolify-app-beta-portal",
      teamId: "team_beta",
      status: "finished",
      commitSha: "9876543210ab",
      startedAt: initialStarted,
      finishedAt: initialFinished,
    });
  }

  seedState();

  function buildTokenDirectory(): Map<string, FakeTeamTokenGrant> {
    const directory = new Map<string, FakeTeamTokenGrant>();

    function registerToken(
      rawToken: string | undefined,
      teamId: string,
      scope: "read" | "write" | "deploy",
    ): void {
      if (!rawToken) {
        return;
      }
      const existing = directory.get(rawToken);
      if (existing && existing.teamId === teamId) {
        const merged = new Set(existing.scopes);
        merged.add(scope);
        directory.set(rawToken, { teamId, scopes: merged });
      } else {
        directory.set(rawToken, { teamId, scopes: new Set([scope]) });
      }
    }

    for (const entry of TEAM_VAULT_REFS) {
      registerToken(secretVault.resolveOptionalSecret(entry.readRef), entry.teamId, "read");
      registerToken(secretVault.resolveOptionalSecret(entry.writeRef), entry.teamId, "write");
      registerToken(secretVault.resolveOptionalSecret(entry.deployRef), entry.teamId, "deploy");
    }

    return directory;
  }

  function authenticateBearer(
    req: IncomingMessage,
    requiredScope: "read" | "write" | "deploy",
  ): { readonly ok: true; readonly teamId: string; readonly rawToken: string } | {
    readonly ok: false;
    readonly status: 401 | 403;
    readonly message: string;
  } {
    const authHeader = req.headers.authorization;
    if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
      return {
        ok: false,
        status: 401,
        message: "Unauthenticated: missing Bearer token.",
      };
    }

    const rawToken = authHeader.slice("Bearer ".length).trim();
    if (rawToken.length === 0) {
      return {
        ok: false,
        status: 401,
        message: "Unauthenticated: empty Bearer token.",
      };
    }

    const tokenDirectory = buildTokenDirectory();
    const grant = tokenDirectory.get(rawToken);
    if (!grant || revokedTeams.has(grant.teamId)) {
      // Deliberately include the raw token in upstream error text to verify adapter/API redaction (AC-009 / AC-017)
      return {
        ok: false,
        status: 401,
        message: `Invalid or revoked Coolify API token Bearer ${rawToken}.`,
      };
    }

    if (requiredScope === "read") {
      return { ok: true, teamId: grant.teamId, rawToken };
    }

    if (!grant.scopes.has(requiredScope)) {
      return {
        ok: false,
        status: 403,
        message: `Token for ${grant.teamId} lacks required '${requiredScope}' ability.`,
      };
    }

    return { ok: true, teamId: grant.teamId, rawToken };
  }

  function serializeApplication(app: MutableFakeApplication): Record<string, unknown> {
    return {
      uuid: app.uuid,
      name: app.name,
      fqdn: app.fqdn,
      status: app.status,
      health_status: app.healthStatus,
      git_repository: app.gitRepository,
      git_branch: app.gitBranch,
      build_pack: app.buildPack,
      environment_name: app.environmentName,
    };
  }

  function serializeServer(srv: MutableFakeServer): Record<string, unknown> {
    const heartbeatIso = srv.sentinelEnabled
      ? (srv.pinnedHeartbeatIso ?? new Date().toISOString())
      : srv.pinnedHeartbeatIso;
    return {
      uuid: srv.uuid,
      name: srv.name,
      ip: srv.ip,
      port: srv.port,
      region: srv.region,
      status: srv.status,
      health: srv.health,
      is_reachable: srv.isReachable,
      is_usable: srv.isUsable,
      sentinel_enabled: srv.sentinelEnabled,
      sentinel_updated_at: heartbeatIso,
      settings: {
        is_reachable: srv.isReachable,
        is_usable: srv.isUsable,
        is_sentinel_enabled: srv.sentinelEnabled,
        sentinel_updated_at: heartbeatIso,
      },
    };
  }

  function createDeploymentForApp(app: MutableFakeApplication): MutableFakeDeployment {
    deploymentCounter += 1;
    const deploymentUuid = `coolify-dep-auto-${String(deploymentCounter)}`;
    const nowIso = new Date().toISOString();
    const record: MutableFakeDeployment = {
      deploymentUuid,
      applicationUuid: app.uuid,
      teamId: app.teamId,
      status: "finished",
      commitSha: `commit${String(deploymentCounter)}abcdef`,
      startedAt: nowIso,
      finishedAt: nowIso,
    };
    deployments.set(deploymentUuid, record);
    app.status = "running:healthy";
    app.healthStatus = "healthy";
    return record;
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = (req.method ?? "GET").toUpperCase();
    const parsedUrl = new URL(req.url ?? "/", `http://${host}`);
    const pathname = parsedUrl.pathname;
    const rawRequestId = req.headers["x-request-id"];
    const requestId = Array.isArray(rawRequestId)
      ? (rawRequestId[0] ?? null)
      : (rawRequestId ?? null);

    // Peek teamId for request log without mutating behavior
    const authPeek = authenticateBearer(req, "read");
    const loggedTeamId = authPeek.ok ? authPeek.teamId : null;

    requests.push({
      method,
      path: pathname,
      fullUrl: `${pathname}${parsedUrl.search}`,
      teamId: loggedTeamId,
      requestId,
      timestamp: new Date().toISOString(),
    });

    if (nextRequestBehavior !== "normal") {
      const currentBehavior = nextRequestBehavior;
      nextRequestBehavior = "normal";
      const rawAuth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";

      if (currentBehavior === "rate_limit") {
        sendJson(
          res,
          429,
          { message: `Too Many Requests for credential ${rawAuth}. Please slow down.` },
          { "retry-after": "2" },
        );
        return;
      }

      if (currentBehavior === "unauthorized") {
        sendJson(res, 401, {
          message: `Revoked upstream Coolify token ${rawAuth}.`,
        });
        return;
      }

      if (currentBehavior === "unavailable") {
        sendJson(res, 503, {
          message: "Coolify upstream worker temporarily unavailable.",
        });
        return;
      }
    }

    if (method === "GET" && pathname === "/api/v1/version") {
      const auth = authenticateBearer(req, "read");
      if (!auth.ok) {
        sendJson(res, auth.status, { message: auth.message });
        return;
      }
      sendJson(res, 200, { version: "4.0.0-beta.380" });
      return;
    }

    if (method === "GET" && pathname === "/api/v1/applications") {
      const auth = authenticateBearer(req, "read");
      if (!auth.ok) {
        sendJson(res, auth.status, { message: auth.message });
        return;
      }
      const list = [...applications.values()]
        .filter((app) => app.teamId === auth.teamId)
        .map((app) => serializeApplication(app));
      sendJson(res, 200, list);
      return;
    }

    const appGetMatch = /^\/api\/v1\/applications\/([^/]+)$/.exec(pathname);
    if (method === "GET" && appGetMatch?.[1]) {
      const auth = authenticateBearer(req, "read");
      if (!auth.ok) {
        sendJson(res, auth.status, { message: auth.message });
        return;
      }
      const uuid = decodeURIComponent(appGetMatch[1]);
      const app = applications.get(uuid);
      if (!app || app.teamId !== auth.teamId) {
        sendJson(res, 404, { message: "Application not found." });
        return;
      }
      sendJson(res, 200, serializeApplication(app));
      return;
    }

    if (method === "POST" && pathname === "/api/v1/deploy") {
      const deployBehavior = nextDeployBehavior;
      nextDeployBehavior = "normal";

      if (deployBehavior === "unauthorized") {
        const rawAuth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
        sendJson(res, 401, {
          message: `Coolify deploy token rejected: ${rawAuth}`,
        });
        return;
      }

      if (deployBehavior === "rate_limit") {
        const rawAuth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
        sendJson(
          res,
          429,
          {
            message: `Coolify deploy rate limit exceeded for ${rawAuth}`,
          },
          { "retry-after": "2" },
        );
        return;
      }

      const auth = authenticateBearer(req, "deploy");
      if (!auth.ok) {
        sendJson(res, auth.status, { message: auth.message });
        return;
      }

      const uuid = parsedUrl.searchParams.get("uuid") ?? "";
      const app = applications.get(uuid);
      if (!app || app.teamId !== auth.teamId) {
        sendJson(res, 404, { message: "Application not found." });
        return;
      }

      const createdDeployment = createDeploymentForApp(app);

      if (deployBehavior === "timeout") {
        // Side effect DID happen on Coolify, but HTTP response stalls until client aborts or timeout elapses (AC-007)
        const timer = setTimeout(() => {
          activeTimeoutTimers.delete(timer);
          sendJson(res, 200, {
            deployments: [
              {
                message: "Deployment queued.",
                resource_uuid: app.uuid,
                deployment_uuid: createdDeployment.deploymentUuid,
              },
            ],
          });
        }, timeoutDelayMs);
        activeTimeoutTimers.add(timer);

        req.on("close", () => {
          clearTimeout(timer);
          activeTimeoutTimers.delete(timer);
        });
        return;
      }

      sendJson(res, 200, {
        deployments: [
          {
            message: "Deployment queued.",
            resource_uuid: app.uuid,
            deployment_uuid: createdDeployment.deploymentUuid,
          },
        ],
      });
      return;
    }

    const appRestartMatch = /^\/api\/v1\/applications\/([^/]+)\/restart$/.exec(pathname);
    if (method === "POST" && appRestartMatch?.[1]) {
      const deployBehavior = nextDeployBehavior;
      nextDeployBehavior = "normal";

      if (deployBehavior === "unauthorized") {
        const rawAuth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
        sendJson(res, 401, { message: `Coolify restart token rejected: ${rawAuth}` });
        return;
      }

      if (deployBehavior === "rate_limit") {
        const rawAuth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
        sendJson(
          res,
          429,
          { message: `Coolify restart rate limit exceeded for ${rawAuth}` },
          { "retry-after": "2" },
        );
        return;
      }

      const auth = authenticateBearer(req, "deploy");
      if (!auth.ok) {
        sendJson(res, auth.status, { message: auth.message });
        return;
      }

      const uuid = decodeURIComponent(appRestartMatch[1]);
      const app = applications.get(uuid);
      if (!app || app.teamId !== auth.teamId) {
        sendJson(res, 404, { message: "Application not found." });
        return;
      }

      const createdDeployment = createDeploymentForApp(app);

      if (deployBehavior === "timeout") {
        const timer = setTimeout(() => {
          activeTimeoutTimers.delete(timer);
          sendJson(res, 200, {
            deployment_uuid: createdDeployment.deploymentUuid,
            message: "Restart queued.",
          });
        }, timeoutDelayMs);
        activeTimeoutTimers.add(timer);

        req.on("close", () => {
          clearTimeout(timer);
          activeTimeoutTimers.delete(timer);
        });
        return;
      }

      sendJson(res, 200, {
        deployment_uuid: createdDeployment.deploymentUuid,
        message: "Restart queued.",
      });
      return;
    }

    const deploymentGetMatch = /^\/api\/v1\/deployments\/([^/]+)$/.exec(pathname);
    if (method === "GET" && deploymentGetMatch?.[1]) {
      const auth = authenticateBearer(req, "read");
      if (!auth.ok) {
        sendJson(res, auth.status, { message: auth.message });
        return;
      }
      const depUuid = decodeURIComponent(deploymentGetMatch[1]);
      const dep = deployments.get(depUuid);
      if (!dep || dep.teamId !== auth.teamId) {
        sendJson(res, 404, { message: "Deployment not found." });
        return;
      }
      sendJson(res, 200, {
        deployment_uuid: dep.deploymentUuid,
        status: dep.status,
        commit_sha: dep.commitSha,
        started_at: dep.startedAt,
        finished_at: dep.finishedAt,
      });
      return;
    }

    if (method === "GET" && pathname === "/api/v1/databases") {
      const auth = authenticateBearer(req, "read");
      if (!auth.ok) {
        sendJson(res, auth.status, { message: auth.message });
        return;
      }
      const list = [...databases.values()]
        .filter((dbItem) => dbItem.teamId === auth.teamId)
        .map((dbItem) => ({
          uuid: dbItem.uuid,
          name: dbItem.name,
          database_type: dbItem.databaseType,
          engine: dbItem.engine,
          version: dbItem.version,
          status: dbItem.status,
          health: dbItem.health,
          internal_db_url: dbItem.internalDbUrl,
          port: dbItem.port,
        }));
      sendJson(res, 200, list);
      return;
    }

    if (method === "GET" && pathname === "/api/v1/servers") {
      const auth = authenticateBearer(req, "read");
      if (!auth.ok) {
        sendJson(res, auth.status, { message: auth.message });
        return;
      }
      const list = [...servers.values()]
        .filter((srv) => srv.teamId === auth.teamId)
        .map((srv) => serializeServer(srv));
      sendJson(res, 200, list);
      return;
    }

    const serverGetMatch = /^\/api\/v1\/servers\/([^/]+)$/.exec(pathname);
    if (method === "GET" && serverGetMatch?.[1]) {
      const auth = authenticateBearer(req, "read");
      if (!auth.ok) {
        sendJson(res, auth.status, { message: auth.message });
        return;
      }
      const srvUuid = decodeURIComponent(serverGetMatch[1]);
      const srv = servers.get(srvUuid);
      if (!srv || srv.teamId !== auth.teamId) {
        sendJson(res, 404, { message: "Server not found." });
        return;
      }
      sendJson(res, 200, serializeServer(srv));
      return;
    }

    sendJson(res, 404, { message: "Coolify API endpoint not found." });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const boundPort = address.port;
  const baseUrl = `http://${host}:${String(boundPort)}`;
  let closed = false;

  return {
    server,
    baseUrl,
    port: boundPort,
    getRequests(): readonly FakeCoolifyRequestRecord[] {
      return [...requests];
    },
    clearRequests(): void {
      requests.length = 0;
    },
    setHealthProbeOutcome(appResourceId: string, healthy: boolean): void {
      healthProbeService?.setHealthProbeOutcome(appResourceId, healthy);
    },
    setNextDeployBehavior(behavior: FakeDeployBehavior): void {
      nextDeployBehavior = behavior;
    },
    setNextRequestBehavior(behavior: FakeRequestBehavior): void {
      nextRequestBehavior = behavior;
    },
    setTeamTokenRevoked(teamId: string, revoked: boolean): void {
      if (revoked) {
        revokedTeams.add(teamId);
      } else {
        revokedTeams.delete(teamId);
      }
    },
    setServerHeartbeatTimestamp(providerServerId: string, iso: string | null): void {
      const target = servers.get(providerServerId);
      if (target) {
        target.sentinelEnabled = true;
        target.pinnedHeartbeatIso = iso;
      }
    },
    setDeploymentStatus(
      deploymentUuid: string,
      status: "queued" | "in_progress" | "finished" | "failed" | "cancelled",
    ): void {
      const target = deployments.get(deploymentUuid);
      if (target) {
        target.status = status;
        target.finishedAt =
          status === "finished" || status === "failed" || status === "cancelled"
            ? new Date().toISOString()
            : null;
      }
    },
    resetSimulations(): void {
      nextDeployBehavior = "normal";
      nextRequestBehavior = "normal";
      revokedTeams.clear();
      requests.length = 0;
      healthProbeService?.resetOutcomes();
      seedState();
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      for (const timer of activeTimeoutTimers) {
        clearTimeout(timer);
      }
      activeTimeoutTimers.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
