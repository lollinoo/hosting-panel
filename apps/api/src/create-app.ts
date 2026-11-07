import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { findForbiddenPublicDtoKeys } from "@hosting-panel/contracts";
import {
  CoolifyV4Adapter,
  type HostingProvider,
} from "@hosting-panel/coolify-adapter";
import {
  createDatabaseClient,
  DEFAULT_DEMO_OIDC_ISSUER,
  seedDemoDataset,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { FastifyInstance } from "fastify";
import { AppModule } from "./app.module.js";
import { OidcService } from "./auth/oidc.service.js";
import {
  ControlPlaneError,
  resolveRequestId,
} from "./common/control-plane.error.js";
import {
  createFakeCoolifyLabServer,
  type FakeCoolifyLabServer,
} from "./lab/fake-coolify-server.js";
import { EventsBusService } from "./operations/events-bus.service.js";
import { HealthProbeService } from "./operations/health-probe.service.js";
import { OutboxWorkerService } from "./operations/outbox-worker.service.js";
import type { ControlPlaneRuntimeConfig } from "./tokens.js";
import { SecretVaultService } from "./vault/secret-vault.service.js";

export interface CreateControlPlaneAppOptions {
  readonly host?: string;
  readonly port?: number;
  readonly listen?: boolean;
  readonly databaseClient?: DatabaseClient;
  readonly seedDemo?: boolean;
  readonly startFakeCoolifyLab?: boolean;
  readonly fakeCoolifyPort?: number;
  readonly fakeCoolifyTimeoutDelayMs?: number;
  readonly coolifyBaseUrl?: string;
  readonly coolifyAllowedHosts?: readonly string[];
  readonly allowInsecureLocalhostCoolify?: boolean;
  readonly coolifyTimeoutMs?: number;
  readonly coolifyDefaultCooldownMs?: number;
  readonly coolifyMaxCooldownMs?: number;
  readonly coolifyAdapter?: HostingProvider;
  readonly secretVault?: SecretVaultService;
  readonly healthProbeService?: HealthProbeService;
  readonly oidcIssuer?: string;
  readonly oidcAudience?: string;
  readonly enableDevOidc?: boolean;
  readonly enableBackgroundWorker?: boolean;
  readonly workerIntervalMs?: number;
  readonly corsOrigin?: string | boolean;
}

export interface ControlPlaneAppHandle {
  readonly nestApp: NestFastifyApplication;
  readonly fastify: FastifyInstance;
  readonly baseUrl: string | null;
  readonly port: number | null;
  readonly dbClient: DatabaseClient;
  readonly fakeCoolify: FakeCoolifyLabServer | null;
  readonly coolifyAdapter: HostingProvider;
  readonly secretVault: SecretVaultService;
  readonly healthProbe: HealthProbeService;
  readonly oidc: OidcService;
  readonly outboxWorker: OutboxWorkerService;
  readonly eventsBus: EventsBusService;
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

  const secretVault = options?.secretVault ?? new SecretVaultService();
  const healthProbe = options?.healthProbeService ?? new HealthProbeService();

  const externalCoolifyUrl =
    options?.coolifyBaseUrl ?? process.env["COOLIFY_BASE_URL"];
  const shouldStartLab =
    options?.startFakeCoolifyLab ?? (externalCoolifyUrl === undefined);

  let fakeCoolify: FakeCoolifyLabServer | null = null;
  if (shouldStartLab) {
    fakeCoolify = await createFakeCoolifyLabServer({
      host: "127.0.0.1",
      port: options?.fakeCoolifyPort ?? 0,
      secretVault,
      healthProbeService: healthProbe,
      timeoutDelayMs: options?.fakeCoolifyTimeoutDelayMs ?? 1_500,
    });
  }

  const resolvedCoolifyBaseUrl =
    fakeCoolify?.baseUrl ?? externalCoolifyUrl ?? "http://127.0.0.1:4101";

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
    options?.oidcIssuer ?? process.env["OIDC_ISSUER"] ?? DEFAULT_DEMO_OIDC_ISSUER;
  const oidcAudience = options?.oidcAudience ?? "hosting-panel-api";

  if (options?.seedDemo ?? ownsDatabaseClient) {
    await seedDemoDataset(dbClient.db, {
      coolifyBaseUrl: resolvedCoolifyBaseUrl,
      oidcIssuer,
    });
  }

  const parsedCoolifyHost = new URL(resolvedCoolifyBaseUrl).hostname;
  const allowedHosts = options?.coolifyAllowedHosts ?? [
    parsedCoolifyHost,
    "127.0.0.1",
    "localhost",
  ];

  const coolifyAdapter =
    options?.coolifyAdapter ??
    new CoolifyV4Adapter({
      allowedHosts,
      allowInsecureLocalhost: options?.allowInsecureLocalhostCoolify ?? true,
      timeoutMs: options?.coolifyTimeoutMs ?? 4_000,
      defaultCooldownMs: options?.coolifyDefaultCooldownMs ?? 2_000,
      ...(options?.coolifyMaxCooldownMs !== undefined
        ? { maxCooldownMs: options.coolifyMaxCooldownMs }
        : {}),
      maxGetRetries: 0,
    });

  const enableDevOidc =
    options?.enableDevOidc ?? process.env["ENABLE_DEV_OIDC"] !== "false";
  const enableBackgroundWorker = options?.enableBackgroundWorker ?? true;
  const workerIntervalMs = options?.workerIntervalMs ?? 500;

  const runtimeConfig: ControlPlaneRuntimeConfig = {
    oidcIssuer,
    oidcAudience,
    enableDevOidc,
    enableBackgroundWorker,
    workerIntervalMs,
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

  // Defense-in-depth AC-017: block accidental leakage of forbidden provider/secret keys on public endpoints
  fastifyInstance.addHook("preSerialization", async (request, _reply, payload) => {
    const routeUrl = request.url.split("?")[0] ?? "";
    if (routeUrl === "/v1/dev/auth/token") {
      return payload;
    }
    const forbidden = findForbiddenPublicDtoKeys(payload);
    if (forbidden.length > 0) {
      throw new ControlPlaneError(
        "INTERNAL_ERROR",
        "Response blocked by public DTO security boundary.",
      );
    }
    return payload;
  });

  const nestApp = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({
      config: runtimeConfig,
      dbClient,
      coolifyAdapter,
      secretVault,
      healthProbeService: healthProbe,
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
  const outboxWorker = nestApp.get(OutboxWorkerService);
  const eventsBus = nestApp.get(EventsBusService);

  let isClosed = false;

  return {
    nestApp,
    fastify: fastifyInstance,
    baseUrl,
    port: boundPort,
    dbClient,
    fakeCoolify,
    coolifyAdapter,
    secretVault,
    healthProbe,
    oidc,
    outboxWorker,
    eventsBus,
    async close(): Promise<void> {
      if (isClosed) {
        return;
      }
      isClosed = true;

      outboxWorker.stopBackgroundLoop();
      await nestApp.close();
      if (fakeCoolify) {
        await fakeCoolify.close();
      }
      if (ownsDatabaseClient) {
        await dbClient.close();
      }
    },
  };
}
