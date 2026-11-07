import "reflect-metadata";
import type { AddressInfo } from "node:net";
import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { findForbiddenPublicDtoKeys } from "@hosting-panel/contracts";
import {
  createDatabaseClient,
  seedPhase1Dataset,
  type DatabaseClient,
} from "@hosting-panel/database";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { Phase1DisabledDockerExecutor } from "@hosting-panel/executor-contracts";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import { Phase1DisabledHostAgent } from "@hosting-panel/host-agent-contracts";
import type { FastifyInstance } from "fastify";
import { AppModule } from "./app.module.js";
import { AuthzContextService } from "./auth/authz-context.service.js";
import { OidcService } from "./auth/oidc.service.js";
import {
  ControlPlaneError,
  resolveRequestId,
} from "./common/control-plane.error.js";
import type { ControlPlaneRuntimeConfig } from "./tokens.js";

export interface CreateControlPlaneAppOptions {
  readonly host?: string;
  readonly port?: number;
  readonly listen?: boolean;
  readonly databaseClient?: DatabaseClient;
  readonly seedPhase1?: boolean;
  readonly dockerExecutor?: DockerExecutorPort;
  readonly hostAgent?: HostAgentPort;
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
  readonly dbClient: DatabaseClient;
  readonly dockerExecutor: DockerExecutorPort;
  readonly hostAgent: HostAgentPort;
  readonly oidc: OidcService;
  readonly authz: AuthzContextService;
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

  const dockerExecutor = options?.dockerExecutor ?? new Phase1DisabledDockerExecutor();
  const hostAgent = options?.hostAgent ?? new Phase1DisabledHostAgent();

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

  if (options?.seedPhase1 ?? ownsDatabaseClient) {
    await seedPhase1Dataset(dbClient.db);
  }

  const enableDevOidc =
    options?.enableDevOidc ?? process.env["ENABLE_DEV_OIDC"] !== "false";

  const runtimeConfig: ControlPlaneRuntimeConfig = {
    oidcIssuer,
    oidcAudience,
    enableDevOidc,
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
    if (routeUrl === "/v1/dev/auth/token") {
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

  let isClosed = false;

  return {
    nestApp,
    fastify: fastifyInstance,
    baseUrl,
    port: boundPort,
    dbClient,
    dockerExecutor,
    hostAgent,
    oidc,
    authz,
    async close(): Promise<void> {
      if (isClosed) {
        return;
      }
      isClosed = true;

      await nestApp.close();
      if (ownsDatabaseClient) {
        await dbClient.close();
      }
    },
  };
}
