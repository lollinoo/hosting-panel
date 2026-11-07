import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CoolifyAdapterError,
  CoolifyV4Adapter,
  redactSensitiveString,
  redactSensitiveValue,
  type AuthorizedProviderContext,
  type CoolifyAdapterLogEntry,
} from "../src/index.js";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly requestId: string | undefined;
}

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

async function startMockHttpServer(
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ readonly server: Server; readonly baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(onRequest);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;

  return {
    server,
    baseUrl,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(payload);
}

describe("CoolifyV4Adapter §7.5 Contract & Security Suite", () => {
  let mockServer: { readonly server: Server; readonly baseUrl: string; close: () => Promise<void> };
  let recordedRequests: RecordedRequest[];
  let routeHandler: RouteHandler;

  const READ_TOKEN = "17|readSecretTokenValueAbcdef123456";
  const DEPLOY_TOKEN = "18|deploySecretTokenValueXyz987654";
  const WRITE_TOKEN = "19|writeSecretTokenValueQwe456789";

  beforeEach(async () => {
    recordedRequests = [];
    routeHandler = (_req, res) => {
      sendJson(res, 404, { message: "Not Found" });
    };

    mockServer = await startMockHttpServer((req, res) => {
      recordedRequests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        authorization: req.headers.authorization,
        requestId:
          typeof req.headers["x-request-id"] === "string"
            ? req.headers["x-request-id"]
            : undefined,
      });
      routeHandler(req, res);
    });
  });

  afterEach(async () => {
    await mockServer.close();
  });

  function createContext(
    overrides?: Partial<AuthorizedProviderContext>,
  ): AuthorizedProviderContext {
    return {
      connectionId: "conn_acme_prod",
      baseUrl: mockServer.baseUrl,
      teamId: "team_01",
      tokens: {
        read: READ_TOKEN,
        deploy: DEPLOY_TOKEN,
        write: WRITE_TOKEN,
      },
      requestId: "req_test_001",
      ...overrides,
    };
  }

  it("Scenario 1: normalizes 200 valid applications (running:healthy, running:unhealthy, exited) and version/deployments", async () => {
    routeHandler = (req, res) => {
      if (req.method === "GET" && req.url === "/api/v1/version") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("4.0.0-beta.390");
        return;
      }

      if (req.method === "GET" && req.url === "/api/v1/applications") {
        sendJson(res, 200, [
          {
            uuid: "app_healthy_01",
            name: "portale-clienti",
            fqdn: "https://portale.esempio.it,https://www.portale.esempio.it",
            status: "running:healthy",
            git_repository: "https://github.com/acme/portale.git",
            git_branch: "main",
            build_pack: "nixpacks",
            environment_name: "production",
          },
          {
            uuid: "app_unhealthy_02",
            name: "worker-fatture",
            fqdn: null,
            status: "running:unhealthy",
            git_repository: "https://github.com/acme/worker.git",
            git_branch: "release",
            build_pack: "dockerfile",
            environment: { name: "staging" },
          },
          {
            uuid: "app_exited_03",
            name: "batch-legacy",
            fqdn: "",
            status: "exited",
            build_pack: "dockercompose",
          },
        ]);
        return;
      }

      if (req.method === "GET" && req.url === "/api/v1/deployments/dep_001") {
        sendJson(res, 200, {
          deployment_uuid: "dep_001",
          status: "finished",
          commit: "a1b2c3d4",
          started_at: "2026-11-07T09:00:00Z",
          finished_at: "2026-11-07T09:02:00Z",
        });
        return;
      }

      sendJson(res, 404, { message: "Unexpected route" });
    };

    const adapter = new CoolifyV4Adapter({
      allowedHosts: ["127.0.0.1"],
      allowInsecureLocalhost: true,
      now: () => Date.parse("2026-11-07T10:00:00.000Z"),
    });

    const ctx = createContext();
    const versionInfo = await adapter.testConnection(ctx);
    expect(versionInfo).toEqual({
      version: "4.0.0-beta.390",
      status: "connected",
      capabilities: adapter.capabilities,
      observedAt: "2026-11-07T10:00:00.000Z",
      source: "coolify",
      stale: false,
    });

    const apps = await adapter.listApplications(ctx);
    expect(apps).toHaveLength(3);

    expect(apps[0]).toEqual({
      providerId: "app_healthy_01",
      name: "portale-clienti",
      fqdn: "https://portale.esempio.it",
      domains: ["https://portale.esempio.it", "https://www.portale.esempio.it"],
      repositoryUrl: "https://github.com/acme/portale.git",
      branch: "main",
      buildPack: "nixpacks",
      environment: "production",
      status: "running",
      health: "healthy",
      observedAt: "2026-11-07T10:00:00.000Z",
      source: "coolify",
      stale: false,
    });

    expect(apps[1]?.status).toBe("running");
    expect(apps[1]?.health).toBe("unhealthy");
    expect(apps[1]?.environment).toBe("staging");

    expect(apps[2]?.status).toBe("stopped");
    expect(apps[2]?.health).toBe("unknown");
    expect(apps[2]?.fqdn).toBeNull();
    expect(apps[2]?.domains).toEqual([]);

    const deployment = await adapter.getDeployment(ctx, "dep_001");
    expect(deployment).toEqual({
      providerId: "dep_001",
      state: "succeeded",
      commitSha: "a1b2c3d4",
      startedAt: "2026-11-07T09:00:00Z",
      finishedAt: "2026-11-07T09:02:00Z",
      status: "running",
      health: "healthy",
      observedAt: "2026-11-07T10:00:00.000Z",
      source: "coolify",
      stale: false,
    });

    expect(recordedRequests[0]?.authorization).toBe(`Bearer ${READ_TOKEN}`);
  });

  it("Scenario 2: tolerates extra undocumented Coolify JSON fields and strips secret fields (sentinel_token, environment_variables, private_key)", async () => {
    const leakedPem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----";

    routeHandler = (req, res) => {
      if (req.method === "GET" && req.url === "/api/v1/applications/app_sec_01") {
        sendJson(res, 200, {
          uuid: "app_sec_01",
          name: "secure-app",
          fqdn: "https://secure.esempio.it",
          status: "running:healthy",
          git_repository: "https://gituser:ghp_superSecretToken999@github.com/acme/sec.git",
          git_branch: "main",
          build_pack: "nixpacks",
          undocumented_coolify_beta_field: { nested: true, experimental: 42 },
          custom_docker_run_options: "--cap-drop=ALL",
          sentinel_token: "99|sentinelSuperSecretToken123456",
          environment_variables: [
            { key: "DATABASE_URL", value: "postgresql://app:topSecret@db:5432/prod" },
          ],
          env: { JWT_SECRET: "ultra-secret-jwt" },
          private_key: leakedPem,
        });
        return;
      }

      if (req.method === "GET" && req.url === "/api/v1/databases") {
        sendJson(res, 200, [
          {
            uuid: "db_pg_01",
            name: "primary-postgres",
            database_type: "standalone-postgresql",
            image: "postgres:16-alpine",
            status: "running:healthy",
            internal_db_url: "postgresql://postgres:mySuperDbPass123@coolify-pg:5432/appdb",
            postgres_password: "mySuperDbPass123",
            environment_variables: { POSTGRES_PASSWORD: "mySuperDbPass123" },
            private_key: leakedPem,
            undocumented_backup_meta: "extra-field",
          },
        ]);
        return;
      }

      sendJson(res, 404, { message: "Not Found" });
    };

    const adapter = new CoolifyV4Adapter({
      allowedHosts: ["127.0.0.1"],
      allowInsecureLocalhost: true,
    });

    const ctx = createContext();
    const app = await adapter.getApplication(ctx, "app_sec_01");
    const serializedApp = JSON.stringify(app);

    expect(app.providerId).toBe("app_sec_01");
    expect(app.repositoryUrl).toBe("https://[REDACTED]@github.com/acme/sec.git");
    expect("sentinel_token" in app).toBe(false);
    expect("environment_variables" in app).toBe(false);
    expect("private_key" in app).toBe(false);
    expect("env" in app).toBe(false);
    expect("undocumented_coolify_beta_field" in app).toBe(false);
    expect(serializedApp).not.toContain("sentinelSuperSecretToken123456");
    expect(serializedApp).not.toContain("topSecret");
    expect(serializedApp).not.toContain("ultra-secret-jwt");
    expect(serializedApp).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(serializedApp).not.toContain("ghp_superSecretToken999");

    const dbs = await adapter.listDatabases(ctx);
    expect(dbs).toHaveLength(1);
    expect(dbs[0]?.engine).toBe("postgresql");
    expect(dbs[0]?.engineVersion).toBe("16-alpine");
    expect(dbs[0]?.internalHostname).toBe("coolify-pg");
    expect(dbs[0]?.port).toBe(5432);
    expect(dbs[0]?.backupSupported).toBe(true);
    expect(dbs[0]?.restoreSupported).toBe(true);
    const serializedDbs = JSON.stringify(dbs);
    expect(serializedDbs).not.toContain("mySuperDbPass123");
    expect(serializedDbs).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("Scenario 3: maps 401 expired/revoked token to UNAUTHENTICATED with full secret redaction in error and logs (AC-009, AC-017)", async () => {
    const customRawToken = "customRawTokenWithoutPipe998877";
    const pipeToken = "44|coolifyRevokedPipeTokenAbcdef123456";
    const sshKey =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAtestKeyMaterial\n-----END RSA PRIVATE KEY-----";

    routeHandler = (_req, res) => {
      sendJson(res, 401, {
        message: `Token ${customRawToken} and Bearer ${pipeToken} for postgres://admin:dbPass99@10.0.0.5:5432/db failed (${sshKey})`,
      });
    };

    const capturedLogs: CoolifyAdapterLogEntry[] = [];
    const adapter = new CoolifyV4Adapter({
      allowedHosts: ["127.0.0.1"],
      allowInsecureLocalhost: true,
      logger: (entry) => {
        capturedLogs.push(entry);
      },
    });

    const ctx = createContext({
      tokens: { read: customRawToken },
    });

    let caughtError: unknown;
    try {
      await adapter.listApplications(ctx);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(CoolifyAdapterError);
    const adapterErr = caughtError as CoolifyAdapterError;
    expect(adapterErr.code).toBe("UNAUTHENTICATED");
    expect(adapterErr.httpStatus).toBe(401);
    expect(adapterErr.retryable).toBe(false);
    expect(adapterErr.ambiguousSideEffect).toBe(false);

    const errorInspectionSurface = [
      adapterErr.message,
      adapterErr.stack ?? "",
      JSON.stringify(adapterErr),
      JSON.stringify(capturedLogs),
    ].join("\n");

    expect(errorInspectionSurface).not.toContain(customRawToken);
    expect(errorInspectionSurface).not.toContain(pipeToken);
    expect(errorInspectionSurface).not.toContain("dbPass99");
    expect(errorInspectionSurface).not.toContain("MIIEpAIBAAKCAQEAtestKeyMaterial");
    expect(capturedLogs).toHaveLength(1);
    expect(capturedLogs[0]?.code).toBe("UNAUTHENTICATED");

    const redactedObj = redactSensitiveValue({
      authorization: `Bearer ${pipeToken}`,
      token: pipeToken,
      sentinel_token: "sentinel-123",
      api_token: "api-123",
      password: "pw",
      secret: "sec",
      private_key: sshKey,
      environment_variables: { SECRET_KEY: "abc" },
      env: { API_SECRET: "xyz" },
      note: redactSensitiveString(
        `Connect via redis://default:redisPass@cache.internal:6379 and Bearer ${pipeToken}`,
      ),
    });

    const serializedRedacted = JSON.stringify(redactedObj);
    expect(serializedRedacted).not.toContain(pipeToken);
    expect(serializedRedacted).not.toContain("sentinel-123");
    expect(serializedRedacted).not.toContain("redisPass");
    expect(serializedRedacted).not.toContain("MIIEpAIBAAKCAQEAtestKeyMaterial");
  });

  it("Scenario 4: maps 403 Team/permission denied to PERMISSION_DENIED and enforces deploy token least privilege", async () => {
    routeHandler = (_req, res) => {
      sendJson(res, 403, { message: "You do not have permission to access this team resource." });
    };

    const adapter = new CoolifyV4Adapter({
      allowedHosts: ["127.0.0.1"],
      allowInsecureLocalhost: true,
    });

    await expect(adapter.getApplication(createContext(), "app_team_other")).rejects.toMatchObject({
      name: "CoolifyAdapterError",
      code: "PERMISSION_DENIED",
      httpStatus: 403,
      retryable: false,
      ambiguousSideEffect: false,
    });

    expect(recordedRequests).toHaveLength(1);

    // Least privilege: missing deploy token fails BEFORE touching network
    const readOnlyCtx = createContext({
      tokens: { read: READ_TOKEN },
    });

    await expect(adapter.deployApplication(readOnlyCtx, "app_01")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      retryable: false,
      ambiguousSideEffect: false,
    });
    await expect(adapter.restartApplication(readOnlyCtx, "app_01")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      retryable: false,
      ambiguousSideEffect: false,
    });

    // Still 1 request because deploy/restart failed fast locally
    expect(recordedRequests).toHaveLength(1);
  });

  it("Scenario 5: maps 404 missing UUID to NOT_FOUND and rejects unsafe UUID path traversal locally", async () => {
    routeHandler = (_req, res) => {
      sendJson(res, 404, { message: "Application not found." });
    };

    const adapter = new CoolifyV4Adapter({
      allowedHosts: ["127.0.0.1"],
      allowInsecureLocalhost: true,
    });

    await expect(adapter.getApplication(createContext(), "app_missing_404")).rejects.toMatchObject(
      {
        code: "NOT_FOUND",
        httpStatus: 404,
        retryable: false,
        ambiguousSideEffect: false,
      },
    );
    expect(recordedRequests).toHaveLength(1);

    for (const maliciousId of ["../version", "app_1?force=true", "app/../../etc", ""]) {
      await expect(adapter.getApplication(createContext(), maliciousId)).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
      });
    }
    expect(recordedRequests).toHaveLength(1);
  });

  it("Scenario 6: maps 409 deployment busy to RESOURCE_LOCKED without blind retry", async () => {
    routeHandler = (_req, res) => {
      sendJson(res, 409, { message: "Deployment already in progress for this application." });
    };

    const adapter = new CoolifyV4Adapter({
      allowedHosts: ["127.0.0.1"],
      allowInsecureLocalhost: true,
    });

    await expect(adapter.deployApplication(createContext(), "app_busy_01")).rejects.toMatchObject({
      code: "RESOURCE_LOCKED",
      httpStatus: 409,
      retryable: true,
      ambiguousSideEffect: false,
    });

    expect(recordedRequests).toHaveLength(1);
    expect(recordedRequests[0]?.authorization).toBe(`Bearer ${DEPLOY_TOKEN}`);
  });

  it("Scenario 7: maps 422 validation error to VALIDATION_ERROR", async () => {
    routeHandler = (_req, res) => {
      sendJson(res, 422, { message: "The given data was invalid." });
    };

    const adapter = new CoolifyV4Adapter({
      allowedHosts: ["127.0.0.1"],
      allowInsecureLocalhost: true,
    });

    await expect(
      adapter.restartApplication(createContext(), "app_invalid_state"),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      httpStatus: 422,
      retryable: false,
      ambiguousSideEffect: false,
    });
    expect(recordedRequests).toHaveLength(1);
  });

  it("Scenario 8: handles 429 + Retry-After with PROVIDER_RATE_LIMIT and local per-connection cooldown preventing upstream flood (AC-008)", async () => {
    let currentNowMs = Date.parse("2026-11-07T10:00:00.000Z");

    routeHandler = (_req, res) => {
      if (recordedRequests.length === 1) {
        sendJson(
          res,
          429,
          { message: "Too Many Attempts." },
          { "Retry-After": "4" },
        );
        return;
      }
      sendJson(res, 200, []);
    };

    const adapter = new CoolifyV4Adapter({
      allowedHosts: ["127.0.0.1"],
      allowInsecureLocalhost: true,
      now: () => currentNowMs,
    });

    const ctx = createContext({ connectionId: "conn_rate_limited" });

    // 1st call hits upstream and triggers 4000ms cooldown
    await expect(adapter.listApplications(ctx)).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMIT",
      httpStatus: 429,
      retryable: true,
      retryAfterMs: 4_000,
    });
    expect(recordedRequests).toHaveLength(1);

    // Advance 1.5s (still within 4s cooldown) -> short-circuits locally without hitting upstream!
    currentNowMs += 1_500;
    await expect(adapter.listApplications(ctx)).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMIT",
      httpStatus: 429,
      retryable: true,
      retryAfterMs: 2_500,
    });
    await expect(adapter.deployApplication(ctx, "app_01")).rejects.toMatchObject({
      code: "PROVIDER_RATE_LIMIT",
      retryAfterMs: 2_500,
    });
    expect(recordedRequests).toHaveLength(1);

    // Different connectionId is NOT blocked by conn_rate_limited's cooldown
    const otherConnApps = await adapter.listApplications(
      createContext({ connectionId: "conn_independent" }),
    );
    expect(otherConnApps).toEqual([]);
    expect(recordedRequests).toHaveLength(2);

    // Advance past 4s cooldown -> conn_rate_limited resumes normal upstream traffic
    currentNowMs += 3_000;
    const recoveredApps = await adapter.listApplications(ctx);
    expect(recoveredApps).toEqual([]);
    expect(recordedRequests).toHaveLength(3);
  });

  it("Scenario 9: POST /deploy timeout produces OPERATION_AMBIGUOUS with single HTTP attempt (AC-007), while safe GET retries transient failure once", async () => {
    let getAttempts = 0;
    let postDeployAttempts = 0;

    routeHandler = (req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/api/v1/deploy")) {
        postDeployAttempts += 1;
        // Intentionally hang past adapter timeoutMs (120ms)
        const timer = setTimeout(() => {
          if (!res.writableEnded) {
            sendJson(res, 200, { deployment_uuid: "dep_late" });
          }
        }, 500);
        req.once("close", () => clearTimeout(timer));
        return;
      }

      if (req.method === "GET" && req.url === "/api/v1/applications") {
        getAttempts += 1;
        if (getAttempts === 1) {
          sendJson(res, 503, { message: "Service temporarily unavailable" });
          return;
        }
        sendJson(res, 200, [
          {
            uuid: "app_retry_ok",
            name: "recovered-app",
            status: "running:healthy",
          },
        ]);
        return;
      }

      sendJson(res, 404, { message: "Not Found" });
    };

    const adapter = new CoolifyV4Adapter({
      allowedHosts: ["127.0.0.1"],
      allowInsecureLocalhost: true,
      timeoutMs: 120,
      maxGetRetries: 1,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
    });

    const ctx = createContext();

    await expect(adapter.deployApplication(ctx, "app_mutating_01")).rejects.toMatchObject({
      code: "OPERATION_AMBIGUOUS",
      ambiguousSideEffect: true,
      retryable: false,
    });
    // CRITICAL AC-007 invariant: mutating POST MUST NOT auto-retry!
    expect(postDeployAttempts).toBe(1);

    // Safe GET retries once on 503 and succeeds on 2nd attempt
    const apps = await adapter.listApplications(ctx);
    expect(apps).toHaveLength(1);
    expect(apps[0]?.providerId).toBe("app_retry_ok");
    expect(getAttempts).toBe(2);
  });

  it("Scenario 10: rejects invalid JSON and oversized streamed body (> maxResponseBytes) safely", async () => {
    let mode: "invalid-json" | "oversized-stream" = "invalid-json";

    routeHandler = (_req, res) => {
      if (mode === "invalid-json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"uuid":"app_1","secret":"19|leakedSecretToken999999", broken_json');
        return;
      }

      // Chunked stream without Content-Length exceeding maxResponseBytes (1024 bytes)
      res.writeHead(200, { "content-type": "application/json" });
      res.write('[{"uuid":"app_big","data":"');
      res.write("A".repeat(900));
      res.write("B".repeat(900));
      res.end('"}]');
    };

    const adapter = new CoolifyV4Adapter({
      allowedHosts: ["127.0.0.1"],
      allowInsecureLocalhost: true,
      maxResponseBytes: 1_024,
      maxGetRetries: 0,
    });

    let invalidJsonError: unknown;
    try {
      await adapter.listApplications(createContext());
    } catch (error) {
      invalidJsonError = error;
    }
    expect(invalidJsonError).toBeInstanceOf(CoolifyAdapterError);
    expect((invalidJsonError as CoolifyAdapterError).code).toBe("COOLIFY_UNAVAILABLE");
    expect((invalidJsonError as CoolifyAdapterError).message).not.toContain(
      "leakedSecretToken999999",
    );

    mode = "oversized-stream";
    await expect(adapter.listApplications(createContext())).rejects.toMatchObject({
      code: "COOLIFY_UNAVAILABLE",
      retryable: false,
      ambiguousSideEffect: false,
    });
  });

  it("Scenario 11: blocks 302 redirects (redirect: 'manual') without following or leaking Authorization header", async () => {
    let attackerServerHits = 0;
    const attackerServer = await startMockHttpServer((_req, res) => {
      attackerServerHits += 1;
      sendJson(res, 200, []);
    });

    try {
      routeHandler = (_req, res) => {
        res.writeHead(302, {
          Location: `${attackerServer.baseUrl}/api/v1/applications`,
        });
        res.end();
      };

      const adapter = new CoolifyV4Adapter({
        allowedHosts: ["127.0.0.1"],
        allowInsecureLocalhost: true,
      });

      await expect(adapter.listApplications(createContext())).rejects.toMatchObject({
        code: "COOLIFY_UNAVAILABLE",
        httpStatus: 302,
        retryable: false,
        ambiguousSideEffect: false,
      });

      expect(recordedRequests).toHaveLength(1);
      expect(attackerServerHits).toBe(0);
    } finally {
      await attackerServer.close();
    }
  });

  it("Scenario 12: enforces host allowlist, HTTPS requirement, URL hygiene, and cloud metadata SSRF blocking", async () => {
    const adapter = new CoolifyV4Adapter({
      // Intentionally include metadata hosts in allowedHosts to verify unconditional SSRF block
      allowedHosts: [
        "coolify.trusted.internal",
        "127.0.0.1",
        "169.254.169.254",
        "fd00:ec2::254",
        "metadata.google.internal",
      ],
      allowInsecureLocalhost: true,
    });

    const disallowedBaseUrls = [
      "https://untrusted-host.example.com",
      "https://169.254.169.254",
      "http://169.254.169.254",
      "https://[fd00:ec2::254]",
      "https://metadata.google.internal",
      "http://coolify.trusted.internal", // non-localhost HTTP forbidden even with allowInsecureLocalhost
      "https://user:pass@coolify.trusted.internal",
      "https://coolify.trusted.internal?env=prod",
      "https://coolify.trusted.internal#frag",
      "https://coolify.trusted.internal/../secret",
    ];

    for (const badUrl of disallowedBaseUrls) {
      await expect(
        adapter.testConnection(createContext({ baseUrl: badUrl })),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    // Also verify localhost HTTP is rejected when allowInsecureLocalhost is false (default)
    const strictHttpsAdapter = new CoolifyV4Adapter({
      allowedHosts: ["127.0.0.1"],
    });
    await expect(
      strictHttpsAdapter.testConnection(createContext({ baseUrl: mockServer.baseUrl })),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });

    expect(recordedRequests).toHaveLength(0);
  });

  it("Scenario 13: accepts both deployments[] and deployment_uuid shapes for deployApplication and restartApplication", async () => {
    let shapeMode: "deployments-array" | "flat-uuid" = "deployments-array";

    routeHandler = (req, res) => {
      if (req.method === "POST" && req.url === "/api/v1/deploy?uuid=app_deploy_1&force=true") {
        if (shapeMode === "deployments-array") {
          sendJson(res, 200, {
            deployments: [
              {
                message: "Deployment request queued.",
                resource_uuid: "app_deploy_1",
                deployment_uuid: "dep_from_array_01",
              },
            ],
          });
          return;
        }
        sendJson(res, 200, {
          deployment_uuid: "dep_from_flat_02",
          message: "Queued flat deployment.",
        });
        return;
      }

      if (req.method === "POST" && req.url === "/api/v1/applications/app_deploy_1/restart") {
        if (shapeMode === "deployments-array") {
          sendJson(res, 200, {
            deployments: [{ deployment_uuid: "restart_from_array_01" }],
          });
          return;
        }
        sendJson(res, 200, {
          deployment_uuid: "restart_from_flat_02",
        });
        return;
      }

      sendJson(res, 404, { message: "Unexpected route" });
    };

    const adapter = new CoolifyV4Adapter({
      allowedHosts: ["127.0.0.1"],
      allowInsecureLocalhost: true,
    });
    const ctx = createContext();

    const deployArrayAccepted = await adapter.deployApplication(ctx, "app_deploy_1", {
      forceRebuild: true,
    });
    expect(deployArrayAccepted.providerId).toBe("dep_from_array_01");
    expect(deployArrayAccepted.status).toBe("deploying");
    expect(deployArrayAccepted.source).toBe("coolify");

    const restartArrayAccepted = await adapter.restartApplication(ctx, "app_deploy_1");
    expect(restartArrayAccepted.providerId).toBe("restart_from_array_01");

    shapeMode = "flat-uuid";

    const deployFlatAccepted = await adapter.deployApplication(ctx, "app_deploy_1", {
      forceRebuild: true,
    });
    expect(deployFlatAccepted.providerId).toBe("dep_from_flat_02");

    const restartFlatAccepted = await adapter.restartApplication(ctx, "app_deploy_1");
    expect(restartFlatAccepted.providerId).toBe("restart_from_flat_02");
  });

  it("Scenario 14: marks server status as unknown and stale: true when Sentinel heartbeat exceeds staleAfterMs (AC-011)", async () => {
    const fixedNow = Date.parse("2026-11-07T12:00:00.000Z");

    routeHandler = (req, res) => {
      if (req.method === "GET" && req.url === "/api/v1/servers/srv_stale_01") {
        sendJson(res, 200, {
          uuid: "srv_stale_01",
          name: "milano-node-01",
          ip: "10.20.30.40",
          port: 22,
          status: "running:healthy",
          is_reachable: true,
          is_usable: true,
          sentinel_updated_at: "2026-11-07T11:40:00.000Z", // 20m old > 5m staleAfterMs
          sentinel_token: "88|sentinelNodeSecretToken123456",
        });
        return;
      }

      if (req.method === "GET" && req.url === "/api/v1/servers/srv_fresh_02") {
        sendJson(res, 200, {
          uuid: "srv_fresh_02",
          name: "milano-node-02",
          ip: "10.20.30.41",
          port: 22,
          status: "running:healthy",
          is_reachable: true,
          is_usable: true,
          last_heartbeat_at: "2026-11-07T11:58:30.000Z", // 90s old <= 5m staleAfterMs
        });
        return;
      }

      sendJson(res, 404, { message: "Not Found" });
    };

    const adapter = new CoolifyV4Adapter({
      allowedHosts: ["127.0.0.1"],
      allowInsecureLocalhost: true,
      staleAfterMs: 5 * 60 * 1_000,
      now: () => fixedNow,
    });

    const staleServer = await adapter.getServer(createContext(), "srv_stale_01");
    expect(staleServer.providerId).toBe("srv_stale_01");
    expect(staleServer.stale).toBe(true);
    expect(staleServer.status).toBe("unknown");
    expect(staleServer.health).toBe("unknown");
    expect(JSON.stringify(staleServer)).not.toContain("sentinelNodeSecretToken123456");

    const freshServer = await adapter.getServer(createContext(), "srv_fresh_02");
    expect(freshServer.stale).toBe(false);
    expect(freshServer.status).toBe("running");
    expect(freshServer.health).toBe("healthy");
  });

  it("Scenario 15: rejects unsupported database engine (redis) restore immediately with NOT_SUPPORTED (AC-012)", async () => {
    const adapter = new CoolifyV4Adapter({
      allowedHosts: ["127.0.0.1"],
      allowInsecureLocalhost: true,
    });

    await expect(
      adapter.triggerDatabaseRestore(createContext(), {
        providerDatabaseUuid: "db_redis_01",
        engine: "redis",
      }),
    ).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      retryable: false,
      ambiguousSideEffect: false,
    });

    // Also test positional overload
    await expect(
      adapter.triggerDatabaseRestore(createContext(), "db_redis_01", "redis"),
    ).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      retryable: false,
      ambiguousSideEffect: false,
    });

    // Zero upstream network calls executed
    expect(recordedRequests).toHaveLength(0);
  });
});
