import "reflect-metadata";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import {
  findForbiddenPublicDtoKeys,
  type IpcSigningKey,
  type RuntimeBackend,
} from "@hosting-panel/contracts";
import {
  createDatabaseClient,
  parseSecretsMasterKey,
  seedPhase1Dataset,
  type DatabaseClient,
} from "@hosting-panel/database";
import {
  InMemoryDockerSimulatorAdapter,
  SignedDockerExecutorIpcClient,
} from "@hosting-panel/docker-executor";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { Phase1DisabledDockerExecutor } from "@hosting-panel/executor-contracts";
import {
  InMemoryHostSimulatorAdapter,
  SignedHostAgentIpcClient,
} from "@hosting-panel/host-agent";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import { Phase1DisabledHostAgent } from "@hosting-panel/host-agent-contracts";
import type { FastifyInstance } from "fastify";
import { AppModule } from "./app.module.js";
import { AuthzContextService } from "./auth/authz-context.service.js";
import { OidcService } from "./auth/oidc.service.js";
import {
  DEFAULT_BREAKGLASS_KEY_FILE,
  parseBreakglassSigningKey,
} from "./cli/break-glass.js";
import {
  ControlPlaneError,
  resolveRequestId,
} from "./common/control-plane.error.js";
import { DriftReconcilerService } from "./runtime/drift-reconciler.service.js";
import { OutboxWorkerService } from "./runtime/outbox-worker.service.js";
import type { ControlPlaneRuntimeConfig } from "./tokens.js";

const DEFAULT_EXECUTOR_SOCKET = "/run/hosting-panel/executor.sock";
const DEFAULT_HOST_AGENT_SOCKET = "/run/hosting-panel/host-agent.sock";
const DEFAULT_IPC_KEY_FILE = "/etc/hosting-panel/ipc.key";
const DEFAULT_SECRETS_MASTER_KEY_FILE = "/etc/hosting-panel/secrets-master.key";
const DEFAULT_JWT_SIGNING_KEY_FILE = "/etc/hosting-panel/jwt-signing.pem";

const DEV_FALLBACK_MASTER_KEY = createHash("sha256")
  .update("hosting-panel-dev-simulator-secrets-master-key-v1")
  .digest();

function resolveRuntimeBackend(options?: CreateControlPlaneAppOptions): RuntimeBackend {
  if (
    options?.runtimeBackend === "disabled" ||
    options?.runtimeBackend === "local-simulator" ||
    options?.runtimeBackend === "linux-systemd"
  ) {
    return options.runtimeBackend;
  }

  const envBackend = process.env["HP_RUNTIME_BACKEND"]?.trim();
  if (
    envBackend === "disabled" ||
    envBackend === "local-simulator" ||
    envBackend === "linux-systemd"
  ) {
    return envBackend;
  }

  if (
    options?.dockerExecutor?.isRuntimeAvailable ||
    options?.hostAgent?.isRuntimeAvailable
  ) {
    return "local-simulator";
  }

  return "disabled";
}

async function resolveLinuxIpcSigningKey(): Promise<IpcSigningKey> {
  const keyId = process.env["HP_IPC_KEY_ID"]?.trim() || "ipc-v1";
  const inlineKey = (
    process.env["HP_IPC_KEY"] ??
    process.env["HP_IPC_HMAC_SECRET"] ??
    process.env["HP_IPC_SECRET"]
  )?.trim();

  let secretMaterial: string;
  if (inlineKey && inlineKey.length > 0) {
    secretMaterial = inlineKey;
  } else {
    const keyFile = process.env["HP_IPC_KEY_FILE"]?.trim() || DEFAULT_IPC_KEY_FILE;
    const content = await readFile(keyFile, "utf8");
    secretMaterial = content.trim();
  }

  if (!secretMaterial || Buffer.byteLength(secretMaterial, "utf8") < 32) {
    throw new Error(
      "Linux systemd runtime backend requires an IPC HMAC signing key of at least 32 bytes (HP_IPC_KEY or HP_IPC_KEY_FILE).",
    );
  }

  return {
    keyId,
    algorithm: "hmac-sha256",
    secret: secretMaterial,
  };
}

async function resolveSecretsMasterKey(
  runtimeBackend: RuntimeBackend,
  explicitKey?: string | Buffer | Uint8Array,
): Promise<Buffer> {
  if (explicitKey !== undefined) {
    return parseSecretsMasterKey(explicitKey);
  }

  const envKey = process.env["HP_SECRETS_MASTER_KEY"]?.trim();
  if (envKey && envKey.length > 0) {
    return parseSecretsMasterKey(envKey);
  }

  const envKeyFile = process.env["HP_SECRETS_MASTER_KEY_FILE"]?.trim();
  if (envKeyFile && envKeyFile.length > 0) {
    const raw = (await readFile(envKeyFile, "utf8")).trim();
    return parseSecretsMasterKey(raw);
  }

  if (runtimeBackend === "linux-systemd") {
    const raw = (await readFile(DEFAULT_SECRETS_MASTER_KEY_FILE, "utf8")).trim();
    return parseSecretsMasterKey(raw);
  }

  return Buffer.from(DEV_FALLBACK_MASTER_KEY);
}

async function resolveBreakglassSigningKey(
  runtimeBackend: RuntimeBackend,
  explicitKey?: string | Buffer | Uint8Array,
): Promise<Uint8Array | undefined> {
  if (explicitKey !== undefined) {
    return parseBreakglassSigningKey(explicitKey);
  }

  const envKey = process.env["HP_BREAKGLASS_KEY"]?.trim();
  if (envKey && envKey.length > 0) {
    return parseBreakglassSigningKey(envKey);
  }

  const envKeyFile = process.env["HP_BREAKGLASS_KEY_FILE"]?.trim();
  if (envKeyFile && envKeyFile.length > 0) {
    const raw = await readFile(envKeyFile, "utf8");
    return parseBreakglassSigningKey(raw);
  }

  if (runtimeBackend === "linux-systemd") {
    try {
      const raw = await readFile(DEFAULT_BREAKGLASS_KEY_FILE, "utf8");
      return parseBreakglassSigningKey(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "EACCES") {
        return undefined;
      }
      throw err;
    }
  }

  return undefined;
}

async function resolveJwtSigningKeyPem(
  runtimeBackend: RuntimeBackend,
  explicitPem?: string,
): Promise<string | null> {
  if (explicitPem !== undefined) {
    return explicitPem;
  }
  if (runtimeBackend !== "linux-systemd") {
    return null;
  }
  const keyFile =
    process.env["HP_JWT_SIGNING_KEY_FILE"]?.trim() || DEFAULT_JWT_SIGNING_KEY_FILE;
  // Missing/unreadable file throws: production must not fall back to an ephemeral key.
  return readFile(keyFile, "utf8");
}

export interface CreateControlPlaneAppOptions {
  readonly host?: string;
  readonly port?: number;
  readonly listen?: boolean;
  readonly databaseClient?: DatabaseClient;
  readonly seedPhase1?: boolean;
  readonly runtimeBackend?: RuntimeBackend;
  readonly dockerExecutor?: DockerExecutorPort;
  readonly hostAgent?: HostAgentPort;
  readonly secretsMasterKey?: string | Buffer | Uint8Array;
  readonly breakglassSigningKey?: string | Buffer | Uint8Array;
  readonly jwtSigningKeyPem?: string;
  readonly autoProcessOutbox?: boolean;
  readonly outboxPollIntervalMs?: number | null;
  readonly driftReconcileIntervalMs?: number | null;
  readonly recoverUnknownOnStart?: boolean;
  readonly oidcIssuer?: string;
  readonly oidcAudience?: string;
  readonly enableDevOidc?: boolean;
  readonly corsOrigin?: string | boolean;
}

export interface ControlPlaneAppHandle {
  readonly nestApp: NestFastifyApplication;
  readonly fastify: FastifyInstance;
  readonly baseUrl: string | null;
  readonly port: number | null;
  readonly runtimeBackend: RuntimeBackend;
  readonly dbClient: DatabaseClient;
  readonly dockerExecutor: DockerExecutorPort;
  readonly hostAgent: HostAgentPort;
  readonly oidc: OidcService;
  readonly authz: AuthzContextService;
  readonly outboxWorker: OutboxWorkerService;
  readonly driftReconciler: DriftReconcilerService;
  close(): Promise<void>;
}

export async function createControlPlaneApp(
  options?: CreateControlPlaneAppOptions,
): Promise<ControlPlaneAppHandle> {
  const host = options?.host ?? process.env["API_HOST"] ?? "127.0.0.1";
  const shouldListen = options?.listen ?? true;
  const requestedPort =
    options?.port ??
    (process.env["API_PORT"] ? Number.parseInt(process.env["API_PORT"], 10) : 0);

  const runtimeBackend = resolveRuntimeBackend(options);
  const secretsMasterKey = await resolveSecretsMasterKey(
    runtimeBackend,
    options?.secretsMasterKey,
  );
  const breakglassSigningKey = await resolveBreakglassSigningKey(
    runtimeBackend,
    options?.breakglassSigningKey,
  );
  const jwtSigningKeyPem = await resolveJwtSigningKeyPem(
    runtimeBackend,
    options?.jwtSigningKeyPem,
  );

  let dockerExecutor = options?.dockerExecutor;
  let hostAgent = options?.hostAgent;

  if (!dockerExecutor || !hostAgent) {
    if (runtimeBackend === "disabled") {
      dockerExecutor = dockerExecutor ?? new Phase1DisabledDockerExecutor();
      hostAgent = hostAgent ?? new Phase1DisabledHostAgent();
    } else if (runtimeBackend === "local-simulator") {
      dockerExecutor = dockerExecutor ?? new InMemoryDockerSimulatorAdapter();
      hostAgent = hostAgent ?? new InMemoryHostSimulatorAdapter();
    } else {
      const signingKey = await resolveLinuxIpcSigningKey();
      const executorSocketPath =
        process.env["HP_EXECUTOR_SOCKET_PATH"]?.trim() ||
        process.env["HP_EXECUTOR_SOCKET"]?.trim() ||
        DEFAULT_EXECUTOR_SOCKET;
      const hostAgentSocketPath =
        process.env["HP_HOST_AGENT_SOCKET_PATH"]?.trim() ||
        process.env["HP_HOST_AGENT_SOCKET"]?.trim() ||
        DEFAULT_HOST_AGENT_SOCKET;

      dockerExecutor =
        dockerExecutor ??
        new SignedDockerExecutorIpcClient({
          signingKey,
          transport: "uds",
          socketPath: executorSocketPath,
        });
      hostAgent =
        hostAgent ??
        new SignedHostAgentIpcClient({
          signingKey,
          socketPath: hostAgentSocketPath,
        });
    }
  }

  const ownsDatabaseClient = options?.databaseClient === undefined;
  const databaseUrl = process.env["DATABASE_URL"];
  const dbClient =
    options?.databaseClient ??
    (databaseUrl && databaseUrl.trim().length > 0
      ? createDatabaseClient({
          mode: "postgres",
          connectionString: databaseUrl.trim(),
        })
      : createDatabaseClient({ mode: "pglite" }));

  if (ownsDatabaseClient) {
    await dbClient.migrate();
  }

  const oidcIssuer =
    options?.oidcIssuer ?? process.env["OIDC_ISSUER"] ?? "https://auth.hcp.local";
  const oidcAudience = options?.oidcAudience ?? "hosting-panel-api";

  if (options?.seedPhase1 ?? process.env["HP_SEED_DEMO"] === "true") {
    await seedPhase1Dataset(dbClient.db);
  }

  const enableDevOidc =
    options?.enableDevOidc ?? process.env["ENABLE_DEV_OIDC"] === "true";

  const autoProcessOutbox = options?.autoProcessOutbox ?? true;
  const defaultBackgroundInterval =
    shouldListen && runtimeBackend !== "disabled" ? 5_000 : null;
  const outboxPollIntervalMs =
    options?.outboxPollIntervalMs !== undefined
      ? options.outboxPollIntervalMs
      : defaultBackgroundInterval;
  const envDriftIntervalRaw = process.env["HP_DRIFT_RECONCILE_INTERVAL_MS"]?.trim();
  const parsedEnvDriftInterval =
    envDriftIntervalRaw && /^\d+$/.test(envDriftIntervalRaw)
      ? Number.parseInt(envDriftIntervalRaw, 10)
      : undefined;
  const driftReconcileIntervalMs =
    options?.driftReconcileIntervalMs !== undefined
      ? options.driftReconcileIntervalMs
      : shouldListen && runtimeBackend !== "disabled"
        ? (parsedEnvDriftInterval ?? 15_000)
        : null;

  const runtimeConfig: ControlPlaneRuntimeConfig = {
    oidcIssuer,
    oidcAudience,
    enableDevOidc,
    runtimeBackend,
    secretsMasterKey,
    ...(breakglassSigningKey !== undefined ? { breakglassSigningKey } : {}),
    jwtSigningKeyPem,
    autoProcessOutbox,
    outboxPollIntervalMs,
    driftReconcileIntervalMs,
  };

  const fastifyAdapter = new FastifyAdapter({
    logger: false,
    trustProxy: false,
  });

  const fastifyInstance = fastifyAdapter.getInstance();

  // Tolerate empty bodies when Content-Type: application/json is sent on POST endpoints
  if (fastifyInstance.hasContentTypeParser("application/json")) {
    fastifyInstance.removeContentTypeParser("application/json");
  }
  fastifyInstance.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_req, body, done) => {
      const text = typeof body === "string" ? body.trim() : "";
      if (text.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch {
        const err = new ControlPlaneError(
          "VALIDATION_ERROR",
          "Malformed JSON request body.",
        );
        done(err, undefined);
      }
    },
  );

  fastifyInstance.addHook("onRequest", async (request, reply) => {
    const requestId = resolveRequestId(request);
    reply.header("X-Request-ID", requestId);
  });

  // Public DTO security boundary: block accidental leakage of internal/forbidden keys
  fastifyInstance.addHook("preSerialization", async (request, _reply, payload) => {
    const routeUrl = request.url.split("?")[0] ?? "";
    // Token-issuing endpoints legitimately return an accessToken.
    if (routeUrl === "/v1/dev/auth/token" || routeUrl === "/v1/auth/login") {
      return payload;
    }
    const forbidden = findForbiddenPublicDtoKeys(payload);
    if (forbidden.length > 0) {
      throw new ControlPlaneError(
        "INTERNAL_ERROR",
        `Response blocked by public DTO security boundary: ${forbidden.join(", ")}`,
      );
    }
    return payload;
  });

  const nestApp = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: runtimeConfig,
      dbClient,
      dockerExecutor,
      hostAgent,
    }),
    fastifyAdapter,
    { logger: false, bodyParser: false },
  );

  if (options?.corsOrigin !== undefined) {
    nestApp.enableCors({
      origin: options.corsOrigin,
      credentials: true,
    });
  }

  let baseUrl: string | null = null;
  let boundPort: number | null = null;

  if (shouldListen) {
    await nestApp.listen(requestedPort, host);
    const addr = fastifyInstance.server.address() as AddressInfo | null;
    if (addr && typeof addr === "object") {
      boundPort = addr.port;
      baseUrl = `http://${host}:${String(boundPort)}`;
    }
  } else {
    await nestApp.init();
    await fastifyInstance.ready();
  }

  const oidc = nestApp.get(OidcService);
  const authz = nestApp.get(AuthzContextService);
  const outboxWorker = nestApp.get(OutboxWorkerService);
  const driftReconciler = nestApp.get(DriftReconcilerService);

  if (options?.recoverUnknownOnStart ?? runtimeBackend !== "disabled") {
    await outboxWorker.recoverUnknownOperations().catch(() => undefined);
  }

  outboxWorker.startBackgroundLoop();
  if (driftReconcileIntervalMs !== null && driftReconcileIntervalMs > 0) {
    void driftReconciler.reconcileAllOnce().catch(() => undefined);
  }
  driftReconciler.startBackgroundLoop();

  let isClosed = false;

  return {
    nestApp,
    fastify: fastifyInstance,
    baseUrl,
    port: boundPort,
    runtimeBackend,
    dbClient,
    dockerExecutor,
    hostAgent,
    oidc,
    authz,
    outboxWorker,
    driftReconciler,
    async close(): Promise<void> {
      if (isClosed) {
        return;
      }
      isClosed = true;

      await outboxWorker.stop();
      await driftReconciler.stop();
      await nestApp.close();
      if (ownsDatabaseClient) {
        await dbClient.close();
      }
    },
  };
}
