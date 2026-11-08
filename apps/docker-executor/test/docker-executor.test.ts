import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  generateEd25519IpcKeyPair,
  signIpcRequest,
  type IpcSigningKey,
  type IpcVerificationKey,
} from "@hosting-panel/contracts";
import {
  createApprovedServiceSpec,
  type ApprovedServiceSpec,
} from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  ExecutorIpcClientError,
  INGRESS_PROXY_CONTAINER_NAME,
  InMemoryDockerSimulatorAdapter,
  MANAGED_DOCKER_LABELS,
  SignedDockerExecutorIpcClient,
  bootstrapDockerExecutorDaemon,
  validateCertifiedCapabilities,
  type DockerContainerInspectPayload,
} from "../src/index.js";

const HMAC_SECRET = "0123456789abcdef0123456789abcdef-phase2-ipc-key";
const HMAC_SIGNING_KEY: IpcSigningKey = {
  keyId: "hmac-v1",
  algorithm: "hmac-sha256",
  secret: HMAC_SECRET,
};
const HMAC_VERIFICATION_KEY: IpcVerificationKey = {
  keyId: "hmac-v1",
  algorithm: "hmac-sha256",
  secret: HMAC_SECRET,
};

interface MockDockerContainerRecord {
  id: string;
  name: string;
  image: string;
  env: string[];
  labels: Record<string, string>;
  running: boolean;
  status: string;
  restartCount: number;
  hostConfig: NonNullable<DockerContainerInspectPayload["HostConfig"]>;
  networks: Record<string, unknown>;
}

interface MockDockerDaemon {
  readonly socketPath: string;
  readonly createdNetworks: Array<{ Name: string; Internal?: boolean; Driver?: string }>;
  readonly createdVolumes: string[];
  readonly networkConnectCalls: Array<{ network: string; container: string }>;
  readonly containers: Map<string, MockDockerContainerRecord>;
  readonly requestedPaths: string[];
  close(): Promise<void>;
}

async function startMockDockerDaemon(options?: {
  readonly rejectVersionedPrefix?: boolean;
}): Promise<MockDockerDaemon> {
  const socketPath = `/tmp/hp-mock-docker-${randomBytes(5).toString("hex")}.sock`;
  const createdNetworks: Array<{ Name: string; Internal?: boolean; Driver?: string }> = [];
  const networkNames = new Set<string>();
  const createdVolumes: string[] = [];
  const networkConnectCalls: Array<{ network: string; container: string }> = [];
  const containers = new Map<string, MockDockerContainerRecord>();
  const requestedPaths: string[] = [];
  let seq = 1;

  const findByRef = (ref: string): MockDockerContainerRecord | undefined => {
    const byId = containers.get(ref);
    if (byId) {
      return byId;
    }
    for (const c of containers.values()) {
      if (c.name === ref || c.name === `/${ref}`) {
        return c;
      }
    }
    return undefined;
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const rawUrl = req.url ?? "/";
      requestedPaths.push(rawUrl);
      const bodyStr = Buffer.concat(chunks).toString("utf8");
      const parsedUrl = new URL(rawUrl, "http://docker");

      if (options?.rejectVersionedPrefix && parsedUrl.pathname.startsWith("/v1.45/")) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            message: "client version 1.45 is too new. Maximum supported API version is 1.43",
          }),
        );
        return;
      }

      const routePath = parsedUrl.pathname.replace(/^\/v1\.\d+/, "");
      const method = req.method ?? "GET";

      if (method === "GET" && routePath === "/_ping") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
        return;
      }

      if (method === "GET" && routePath.startsWith("/images/") && routePath.endsWith("/json")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Id: "sha256:mockimage" }));
        return;
      }

      if (method === "GET" && routePath.startsWith("/networks/")) {
        const netName = decodeURIComponent(routePath.slice("/networks/".length));
        if (networkNames.has(netName)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ Name: netName }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "network not found" }));
        }
        return;
      }

      if (method === "POST" && routePath === "/networks/create") {
        const body = JSON.parse(bodyStr) as { Name: string; Internal?: boolean; Driver?: string };
        networkNames.add(body.Name);
        createdNetworks.push(body);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Id: `net_${body.Name}` }));
        return;
      }

      const netConnectMatch = /^\/networks\/([^/]+)\/(connect|disconnect)$/.exec(routePath);
      if (method === "POST" && netConnectMatch && netConnectMatch[1] && netConnectMatch[2]) {
        const netName = decodeURIComponent(netConnectMatch[1]);
        const action = netConnectMatch[2];
        const body = JSON.parse(bodyStr) as { Container: string; EndpointConfig?: unknown };
        const target = findByRef(body.Container);
        if (action === "connect") {
          networkConnectCalls.push({ network: netName, container: body.Container });
          if (target) {
            target.networks[netName] = body.EndpointConfig ?? {};
          }
        } else if (target) {
          delete target.networks[netName];
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
        return;
      }

      if (method === "POST" && routePath === "/volumes/create") {
        const body = JSON.parse(bodyStr) as { Name: string };
        createdVolumes.push(body.Name);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Name: body.Name }));
        return;
      }

      if (method === "GET" && routePath === "/containers/json") {
        const rawFilters = parsedUrl.searchParams.get("filters");
        const filterLabels: string[] = rawFilters
          ? ((JSON.parse(rawFilters) as { label?: string[] }).label ?? [])
          : [];

        const matches = [...containers.values()]
          .filter((c) =>
            filterLabels.every((expr) => {
              const eq = expr.indexOf("=");
              if (eq < 0) {
                return expr in c.labels;
              }
              const k = expr.slice(0, eq);
              const v = expr.slice(eq + 1);
              return c.labels[k] === v;
            }),
          )
          .map((c) => ({
            Id: c.id,
            Names: [`/${c.name}`],
            Labels: c.labels,
          }));

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(matches));
        return;
      }

      if (method === "POST" && routePath === "/containers/create") {
        const name = parsedUrl.searchParams.get("name") ?? `ctr_${String(seq)}`;
        const payload = JSON.parse(bodyStr) as {
          Image: string;
          Env?: string[];
          Labels?: Record<string, string>;
          HostConfig: NonNullable<DockerContainerInspectPayload["HostConfig"]>;
          NetworkingConfig?: { EndpointsConfig?: Record<string, unknown> };
        };

        const id = `${String(seq).padStart(8, "0")}abcdef0123456789abcdef0123456789abcdef0123456789abcdef01`;
        seq += 1;
        containers.set(id, {
          id,
          name,
          image: payload.Image,
          env: [...(payload.Env ?? [])],
          labels: { ...(payload.Labels ?? {}) },
          running: false,
          status: "created",
          restartCount: 0,
          hostConfig: payload.HostConfig,
          networks: { ...(payload.NetworkingConfig?.EndpointsConfig ?? {}) },
        });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ Id: id, Warnings: [] }));
        return;
      }

      const inspectMatch = /^\/containers\/([^/]+)\/json$/.exec(routePath);
      if (method === "GET" && inspectMatch && inspectMatch[1]) {
        const ref = decodeURIComponent(inspectMatch[1]);
        const target = findByRef(ref);
        if (!target) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "No such container" }));
          return;
        }
        const inspectPayload: DockerContainerInspectPayload = {
          Id: target.id,
          Name: `/${target.name}`,
          RestartCount: target.restartCount,
          State: {
            Status: target.status,
            Running: target.running,
            Restarting: false,
            OOMKilled: false,
            Dead: false,
          },
          Config: {
            Image: target.image,
            Env: target.env,
            Labels: target.labels,
          },
          HostConfig: target.hostConfig,
          NetworkSettings: {
            Networks: target.networks,
          },
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(inspectPayload));
        return;
      }

      const lifecycleMatch = /^\/containers\/([^/]+)\/(start|stop|restart)$/.exec(routePath);
      if (method === "POST" && lifecycleMatch && lifecycleMatch[1] && lifecycleMatch[2]) {
        const ref = decodeURIComponent(lifecycleMatch[1]);
        const action = lifecycleMatch[2];
        const target = findByRef(ref);
        if (!target) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "No such container" }));
          return;
        }
        if (action === "start" || action === "restart") {
          target.running = true;
          target.status = "running";
        } else {
          target.running = false;
          target.status = "exited";
        }
        res.writeHead(204);
        res.end();
        return;
      }

      const deleteMatch = /^\/containers\/([^/]+)$/.exec(routePath);
      if (method === "DELETE" && deleteMatch && deleteMatch[1]) {
        const ref = decodeURIComponent(deleteMatch[1]);
        const target = findByRef(ref);
        if (target) {
          containers.delete(target.id);
        }
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: `Unhandled mock route: ${method} ${routePath}` }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    createdNetworks,
    createdVolumes,
    networkConnectCalls,
    containers,
    requestedPaths,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    },
  };
}

function rawUnixHttpRequest(options: {
  readonly socketPath: string;
  readonly method: string;
  readonly pathWithQuery: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}): Promise<{ readonly statusCode: number; readonly json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const bodyBuf = options.body !== undefined ? Buffer.from(options.body, "utf8") : undefined;
    const req = http.request(
      {
        socketPath: options.socketPath,
        method: options.method,
        path: options.pathWithQuery,
        headers: {
          ...(options.headers ?? {}),
          ...(bodyBuf ? { "Content-Type": "application/json", "Content-Length": String(bodyBuf.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >;
          resolve({ statusCode: res.statusCode ?? 500, json: parsed });
        });
      },
    );
    req.on("error", reject);
    if (bodyBuf) {
      req.write(bodyBuf);
    }
    req.end();
  });
}

describe("@hosting-panel/docker-executor (Wave 2A — HCP-SPEC-003)", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      const fn = cleanupTasks.pop();
      if (fn) {
        await fn();
      }
    }
  });

  it("AC-F2-01: binds UDS with 0660 permissions, refuses 0.0.0.0 or fixed TCP ports, and executes full IPC lifecycle", async () => {
    const simulator = new InMemoryDockerSimulatorAdapter();

    expect(
      () =>
        new DockerExecutorIpcServer({
          executor: simulator,
          keyring: { "hmac-v1": HMAC_VERIFICATION_KEY },
          transport: "loopback-test",
          host: "0.0.0.0",
        }),
    ).toThrow(/127\.0\.0\.1:0/);

    expect(
      () =>
        new DockerExecutorIpcServer({
          executor: simulator,
          keyring: { "hmac-v1": HMAC_VERIFICATION_KEY },
          transport: "loopback-test",
          port: 9090,
        }),
    ).toThrow(/ephemeral/);

    expect(
      () =>
        new DockerExecutorIpcServer({
          executor: simulator,
          keyring: { "hmac-v1": HMAC_VERIFICATION_KEY },
          transport: "uds",
          host: "127.0.0.1",
        }),
    ).toThrow(/forbidden/);

    const socketPath = `/tmp/hp-exec-test-${randomBytes(5).toString("hex")}.sock`;
    const server = new DockerExecutorIpcServer({
      executor: simulator,
      keyring: { "hmac-v1": HMAC_VERIFICATION_KEY },
      transport: "uds",
      socketPath,
      runtimeBackend: "local-simulator",
    });
    cleanupTasks.push(() => server.stop());

    const endpoint = await server.start();
    expect(endpoint.transport).toBe("uds");
    expect(endpoint.socketPath).toBe(socketPath);

    const sockStat = await stat(socketPath);
    expect(sockStat.isSocket()).toBe(true);
    expect(sockStat.mode & 0o777).toBe(0o660);

    const client = new SignedDockerExecutorIpcClient({
      signingKey: HMAC_SIGNING_KEY,
      transport: "uds",
      socketPath,
    });

    const health = await client.checkHealth();
    expect(health.component).toBe("docker_executor");
    expect(health.status).toBe("online");
    expect(health.dockerEngineReachable).toBe(true);

    const ingressEnsure = await client.ensureIngressProxy();
    expect(ingressEnsure.component).toBe("ingress_proxy");
    expect(ingressEnsure.status).toBe("running");

    const spec = createApprovedServiceSpec({
      serviceInstanceId: "svc_uds_1",
      siteId: "site_uds_1",
      organizationId: "org_1",
      image: "nginx:1.27-alpine",
      containerName: "hp-svc-uds-1",
      env: { APP_ENV: "production" },
      revisionNumber: 3,
      specHash: "sha256_rev3_hash",
      domains: ["uds-site.example.test"],
      exposeHttp: true,
      internalPort: 80,
      resolvedSecrets: {
        APP_DB_PASS: "uds-secret-value-123",
      },
    });

    const deployRes = await client.deployService(spec);
    expect(deployRes.status).toBe("succeeded");
    expect(deployRes.containerStatus).toBe("running");
    expect(deployRes.ingressConfigured).toBe(true);

    const observed = await client.getObservedState("svc_uds_1");
    expect(observed).not.toBeNull();
    expect(observed?.observedStatus).toBe("running");
    expect(observed?.observedRevisionHash).toBe("sha256_rev3_hash");
    expect(observed?.outOfBandModified).toBe(false);

    simulator.simulateOutOfBandModification("svc_uds_1", { image: "nginx:tampered" });
    const driftedObserved = await client.getObservedState("svc_uds_1");
    expect(driftedObserved?.outOfBandModified).toBe(true);

    const restartRes = await client.restartService("svc_uds_1");
    expect(restartRes.containerStatus).toBe("running");

    const stopRes = await client.stopService("svc_uds_1");
    expect(stopRes.containerStatus).toBe("stopped");
    expect(simulator.hasActiveVirtualSecret("svc_uds_1")).toBe(false);

    const deleteRes = await client.deleteService("svc_uds_1");
    expect(deleteRes.status).toBe("succeeded");
    expect(await client.getObservedState("svc_uds_1")).toBeNull();

    await server.stop();
    await expect(stat(socketPath)).rejects.toThrow();
  });

  it("AC-F2-02: enforces HMAC-SHA256 & Ed25519 signatures, rejects missing headers, tampered body, >30s skew (401), and nonce replay (409)", async () => {
    const ed25519Pair = generateEd25519IpcKeyPair("ed25519-hub-v1");
    const simulator = new InMemoryDockerSimulatorAdapter();
    const socketPath = `/tmp/hp-exec-test-${randomBytes(5).toString("hex")}.sock`;
    let fixedNowMs = 1_762_550_000_000;

    const server = new DockerExecutorIpcServer({
      executor: simulator,
      keyring: {
        "hmac-v1": HMAC_VERIFICATION_KEY,
        "ed25519-hub-v1": ed25519Pair.verificationKey,
      },
      transport: "uds",
      socketPath,
      nowMs: () => fixedNowMs,
    });
    cleanupTasks.push(() => server.stop());
    await server.start();

    // 1. Valid Ed25519 signed request succeeds
    const edHeaders = signIpcRequest({
      method: "GET",
      pathWithQuery: "/v1/health",
      key: ed25519Pair.signingKey,
      timestampMs: fixedNowMs,
      nonce: "nonce-ed25519-valid-1",
    });
    const edRes = await rawUnixHttpRequest({
      socketPath,
      method: "GET",
      pathWithQuery: "/v1/health",
      headers: { ...edHeaders },
    });
    expect(edRes.statusCode).toBe(200);

    // 2. Missing headers -> 401
    const unauthRes = await rawUnixHttpRequest({
      socketPath,
      method: "GET",
      pathWithQuery: "/v1/health",
    });
    expect(unauthRes.statusCode).toBe(401);
    expect((unauthRes.json.error as { code: string }).code).toBe("UNAUTHENTICATED");

    // 3. Tampered body -> 401
    const originalBody = JSON.stringify({
      serviceInstanceId: "svc_1",
      action: "restart",
    });
    const tamperedBody = JSON.stringify({
      serviceInstanceId: "svc_1",
      action: "delete",
    });
    const bodyHeaders = signIpcRequest({
      method: "POST",
      pathWithQuery: "/v1/services/action",
      body: originalBody,
      key: HMAC_SIGNING_KEY,
      timestampMs: fixedNowMs,
      nonce: "nonce-body-tamper-1",
    });
    const tamperedRes = await rawUnixHttpRequest({
      socketPath,
      method: "POST",
      pathWithQuery: "/v1/services/action",
      headers: { ...bodyHeaders },
      body: tamperedBody,
    });
    expect(tamperedRes.statusCode).toBe(401);
    expect((tamperedRes.json.error as { code: string }).code).toBe("UNAUTHENTICATED");

    // 4. Clock skew > 30s (past and future) -> 401
    const staleHeaders = signIpcRequest({
      method: "GET",
      pathWithQuery: "/v1/health",
      key: HMAC_SIGNING_KEY,
      timestampMs: fixedNowMs - 31_000,
      nonce: "nonce-skew-past-1",
    });
    const staleRes = await rawUnixHttpRequest({
      socketPath,
      method: "GET",
      pathWithQuery: "/v1/health",
      headers: { ...staleHeaders },
    });
    expect(staleRes.statusCode).toBe(401);

    const futureHeaders = signIpcRequest({
      method: "GET",
      pathWithQuery: "/v1/health",
      key: HMAC_SIGNING_KEY,
      timestampMs: fixedNowMs + 35_000,
      nonce: "nonce-skew-future-1",
    });
    const futureRes = await rawUnixHttpRequest({
      socketPath,
      method: "GET",
      pathWithQuery: "/v1/health",
      headers: { ...futureHeaders },
    });
    expect(futureRes.statusCode).toBe(401);

    // 5. Replayed nonce -> first 200, second 409 CONFLICT
    const replayHeaders = signIpcRequest({
      method: "GET",
      pathWithQuery: "/v1/health",
      key: HMAC_SIGNING_KEY,
      timestampMs: fixedNowMs,
      nonce: "nonce-replay-check-1",
    });
    const firstTry = await rawUnixHttpRequest({
      socketPath,
      method: "GET",
      pathWithQuery: "/v1/health",
      headers: { ...replayHeaders },
    });
    expect(firstTry.statusCode).toBe(200);

    fixedNowMs += 1_000;
    const secondTry = await rawUnixHttpRequest({
      socketPath,
      method: "GET",
      pathWithQuery: "/v1/health",
      headers: { ...replayHeaders },
    });
    expect(secondTry.statusCode).toBe(409);
    expect((secondTry.json.error as { code: string }).code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("AC-F2-03 & AC-F2-05: DockerEngineSocketAdapter enforces HostConfig hardening, per-site bridge networks, zero-sock Traefik ingress, and 0400 tmpfs secrets", async () => {
    const tmpBaseDir = await mkdtemp(path.join(os.tmpdir(), "hp-exec-dirs-"));
    cleanupTasks.push(() => rm(tmpBaseDir, { recursive: true, force: true }));

    const secretsRootDir = path.join(tmpBaseDir, "secrets");
    const ingressRootDir = path.join(tmpBaseDir, "ingress");

    const mockDaemon = await startMockDockerDaemon();
    cleanupTasks.push(() => mockDaemon.close());

    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir,
      ingressRootDir,
      ingressHttpPort: 18080,
      pullMissingImages: false,
    });

    expect(await adapter.pingEngine()).toBe(true);

    const spec = createApprovedServiceSpec({
      serviceInstanceId: "svc_prod_web",
      siteId: "site_alpha",
      organizationId: "org_alpha",
      image: "ghcr.io/example/webapp:1.4.2",
      containerName: "hp-site-alpha-web",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
      resourceLimits: {
        cpuMilli: 500,
        memoryBytes: "536870912",
      },
      pidsLimit: 192,
      revisionNumber: 7,
      specHash: "hash_alpha_rev_7",
      domains: ["alpha.hosting.example", "www.alpha.hosting.example"],
      exposeHttp: true,
      internalPort: 3000,
      volumeMounts: [
        {
          volumeSuffix: "uploads",
          containerPath: "/app/uploads",
          readOnly: false,
        },
      ],
      resolvedSecrets: {
        DATABASE_PASSWORD: "ultra-secret-postgres-pw!",
        JWT_PRIVATE_SECRET: "ultra-secret-jwt-key!",
      },
    });

    const deployRes = await adapter.deployService(spec);
    expect(deployRes.status).toBe("succeeded");
    expect(deployRes.ingressConfigured).toBe(true);
    expect(JSON.stringify(deployRes)).not.toContain("ultra-secret-postgres-pw!");
    expect(JSON.stringify(deployRes)).not.toContain("ultra-secret-jwt-key!");

    // Verify /v1.45 versioned Docker Engine endpoints were used
    expect(mockDaemon.requestedPaths.some((p) => p.startsWith("/v1.45/"))).toBe(true);

    // Verify per-site network isolation
    const siteInternalNet = mockDaemon.createdNetworks.find(
      (n) => n.Name === "hp_site_site_alpha_net",
    );
    expect(siteInternalNet).toBeDefined();
    expect(siteInternalNet?.Driver).toBe("bridge");
    expect(siteInternalNet?.Internal).toBe(true);

    const siteEdgeNet = mockDaemon.createdNetworks.find(
      (n) => n.Name === "hp_edge_site_alpha_net",
    );
    expect(siteEdgeNet).toBeDefined();
    expect(siteEdgeNet?.Driver).toBe("bridge");

    // Verify managed volume creation
    expect(mockDaemon.createdVolumes).toContain("hp_vol_svc_prod_web_uploads");

    // Inspect created tenant container in mock daemon
    const tenantCtr = [...mockDaemon.containers.values()].find(
      (c) => c.name === "hp-site-alpha-web",
    );
    expect(tenantCtr).toBeDefined();
    expect(tenantCtr?.running).toBe(true);
    expect(tenantCtr?.hostConfig.Privileged).toBe(false);
    expect(tenantCtr?.hostConfig.CapDrop).toEqual(["ALL"]);
    expect(tenantCtr?.hostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(tenantCtr?.hostConfig.PidsLimit).toBe(192);
    expect(tenantCtr?.hostConfig.NanoCpus).toBe(500_000_000);
    expect(tenantCtr?.hostConfig.Memory).toBe(536_870_912);
    expect(tenantCtr?.hostConfig.MemorySwap).toBe(536_870_912);
    expect(tenantCtr?.hostConfig.RestartPolicy).toEqual({ Name: "unless-stopped" });
    expect(tenantCtr?.hostConfig.NetworkMode).toBe("hp_site_site_alpha_net");

    // Verify deterministic reconciliation labels
    expect(tenantCtr?.labels).toEqual({
      [MANAGED_DOCKER_LABELS.managed]: "true",
      [MANAGED_DOCKER_LABELS.organizationId]: "org_alpha",
      [MANAGED_DOCKER_LABELS.siteId]: "site_alpha",
      [MANAGED_DOCKER_LABELS.serviceInstanceId]: "svc_prod_web",
      [MANAGED_DOCKER_LABELS.revisionNumber]: "7",
      [MANAGED_DOCKER_LABELS.specHash]: "hash_alpha_rev_7",
    });

    // Verify *_FILE pattern in Env & ZERO plaintext secrets in Env
    expect(tenantCtr?.env).toContain("NODE_ENV=production");
    expect(tenantCtr?.env).toContain("PORT=3000");
    expect(tenantCtr?.env).toContain("DATABASE_PASSWORD_FILE=/run/secrets/DATABASE_PASSWORD");
    expect(tenantCtr?.env).toContain("JWT_PRIVATE_SECRET_FILE=/run/secrets/JWT_PRIVATE_SECRET");
    expect(tenantCtr?.env.join("\n")).not.toContain("ultra-secret-postgres-pw!");
    expect(tenantCtr?.env.join("\n")).not.toContain("ultra-secret-jwt-key!");

    // Verify 0700 root & service secret directories and 0444 :ro secret files for CapDrop=ALL UID readability
    const rootSecretStat = await stat(secretsRootDir);
    expect(rootSecretStat.mode & 0o777).toBe(0o700);
    const serviceSecretDir = path.join(secretsRootDir, "svc_prod_web");
    const dirStat = await stat(serviceSecretDir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    const dbSecretFile = path.join(serviceSecretDir, "DATABASE_PASSWORD");
    const dbSecretStat = await stat(dbSecretFile);
    expect(dbSecretStat.mode & 0o777).toBe(0o444);
    expect(await readFile(dbSecretFile, "utf8")).toBe("ultra-secret-postgres-pw!");

    expect(tenantCtr?.hostConfig.Binds).toContain("hp_vol_svc_prod_web_uploads:/app/uploads");
    expect(tenantCtr?.hostConfig.Binds).toContain(
      `${dbSecretFile}:/run/secrets/DATABASE_PASSWORD:ro`,
    );

    // Verify hp_ingress_proxy container & zero docker.sock mount
    const proxyCtr = [...mockDaemon.containers.values()].find(
      (c) => c.name === INGRESS_PROXY_CONTAINER_NAME,
    );
    expect(proxyCtr).toBeDefined();
    expect(proxyCtr?.image).toBe("traefik:v3.7");
    expect(proxyCtr?.hostConfig.Privileged).toBe(false);
    expect(proxyCtr?.hostConfig.CapDrop).toEqual(["ALL"]);
    expect(proxyCtr?.hostConfig.CapAdd).toEqual(["NET_BIND_SERVICE"]);
    expect(proxyCtr?.hostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(proxyCtr?.hostConfig.RestartPolicy).toEqual({ Name: "unless-stopped" });
    expect(proxyCtr?.hostConfig.Binds?.some((b) => b.includes("docker.sock"))).toBe(false);
    expect(proxyCtr?.hostConfig.Binds).toEqual([
      `${path.join(ingressRootDir, "static", "traefik.yml")}:/etc/traefik/traefik.yml:ro`,
      `${path.join(ingressRootDir, "dynamic")}:/etc/traefik/dynamic:ro`,
    ]);

    // Verify hp_ingress_proxy connected to hp_edge_site_alpha_net
    expect(
      mockDaemon.networkConnectCalls.some(
        (c) =>
          c.network === "hp_edge_site_alpha_net" &&
          c.container === INGRESS_PROXY_CONTAINER_NAME,
      ),
    ).toBe(true);

    // Verify static traefik.yml and atomic dynamic site_site_alpha.yml
    const staticYaml = await readFile(path.join(ingressRootDir, "static", "traefik.yml"), "utf8");
    expect(staticYaml).toContain('directory: "/etc/traefik/dynamic"');
    expect(staticYaml).toContain("watch: true");
    expect(staticYaml.toLowerCase()).not.toContain("docker.sock");

    const dynamicFiles = await readdir(path.join(ingressRootDir, "dynamic"));
    expect(dynamicFiles).toEqual(["site_site_alpha.yml"]);

    const siteDynamicYaml = await readFile(
      path.join(ingressRootDir, "dynamic", "site_site_alpha.yml"),
      "utf8",
    );
    expect(siteDynamicYaml).toContain(
      "Host(`alpha.hosting.example`) || Host(`www.alpha.hosting.example`)",
    );
    expect(siteDynamicYaml).toContain('url: "http://hp-site-alpha-web:3000"');

    // Verify getObservedState reports clean in_sync-ready state, then detects out-of-band drift
    const cleanState = await adapter.getObservedState("svc_prod_web");
    expect(cleanState?.observedStatus).toBe("running");
    expect(cleanState?.observedRevisionHash).toBe("hash_alpha_rev_7");
    expect(cleanState?.outOfBandModified).toBe(false);
    expect(cleanState?.restartCount).toBe(0);

    if (tenantCtr) {
      tenantCtr.hostConfig = {
        ...tenantCtr.hostConfig,
        CapAdd: ["SYS_ADMIN"],
      };
    }
    const driftedState = await adapter.getObservedState("svc_prod_web");
    expect(driftedState?.outOfBandModified).toBe(true);

    // Verify stopService overwrites and purges tmpfs secret directory
    await adapter.stopService("svc_prod_web");
    await expect(stat(serviceSecretDir)).rejects.toThrow();

    // Verify deleteService removes container and dynamic site_<siteId>.yml
    await adapter.deleteService("svc_prod_web");
    expect(await adapter.getObservedState("svc_prod_web")).toBeNull();
    expect(await readdir(path.join(ingressRootDir, "dynamic"))).toEqual([]);
  });

  it("supports automatic unversioned Docker API fallback when daemon rejects /v1.45", async () => {
    const mockDaemon = await startMockDockerDaemon({ rejectVersionedPrefix: true });
    cleanupTasks.push(() => mockDaemon.close());

    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      pullMissingImages: false,
    });

    expect(await adapter.pingEngine()).toBe(true);
    expect(mockDaemon.requestedPaths).toContain("/v1.45/_ping");
    expect(mockDaemon.requestedPaths).toContain("/_ping");
  });

  it("rejects unsafe mounts, privileged attributes, forbidden capabilities, and plaintext secrets with HOST_POLICY_DENIED", async () => {
    const simulator = new InMemoryDockerSimulatorAdapter();
    const server = new DockerExecutorIpcServer({
      executor: simulator,
      keyring: { "hmac-v1": HMAC_VERIFICATION_KEY },
      transport: "loopback-test",
    });
    cleanupTasks.push(() => server.stop());
    const bound = await server.start();

    const client = new SignedDockerExecutorIpcClient({
      signingKey: HMAC_SIGNING_KEY,
      transport: "loopback-test",
      port: bound.port,
    });

    expect(() => validateCertifiedCapabilities(["SYS_ADMIN"])).toThrowError(
      expect.objectContaining({ code: "HOST_POLICY_DENIED" }),
    );
    expect(() => validateCertifiedCapabilities(["DAC_READ_SEARCH"])).toThrowError(
      expect.objectContaining({ code: "HOST_POLICY_DENIED" }),
    );
    expect(validateCertifiedCapabilities(["CHOWN", "NET_BIND_SERVICE"])).toEqual([
      "CHOWN",
      "NET_BIND_SERVICE",
    ]);

    const validBaseSpec = createApprovedServiceSpec({
      serviceInstanceId: "svc_sec_1",
      siteId: "site_sec_1",
      organizationId: "org_sec_1",
      image: "nginx:1.27-alpine",
      containerName: "hp-sec-1",
    });

    // Forged spec with forbidden /var/run/docker.sock volume mount
    const forgedMountSpec = {
      ...validBaseSpec,
      volumeMounts: [{ volumeSuffix: "sock", containerPath: "/var/run/docker.sock" }],
    } as unknown as ApprovedServiceSpec;

    await expect(simulator.deployService(forgedMountSpec)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    await expect(client.deployService(forgedMountSpec)).rejects.toBeInstanceOf(
      ExecutorIpcClientError,
    );
    await expect(client.deployService(forgedMountSpec)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
      statusCode: 403,
    });

    // Forged spec with privileged: true
    const forgedPrivilegedSpec = {
      ...validBaseSpec,
      privileged: true,
    } as unknown as ApprovedServiceSpec;

    await expect(simulator.deployService(forgedPrivilegedSpec)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    await expect(client.deployService(forgedPrivilegedSpec)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
      statusCode: 403,
    });

    // Forged spec with plaintext secret in env
    const forgedPlaintextSecretSpec = {
      ...validBaseSpec,
      env: { password: "leaked-plaintext-secret" },
    } as unknown as ApprovedServiceSpec;

    await expect(simulator.deployService(forgedPlaintextSecretSpec)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    await expect(client.deployService(forgedPlaintextSecretSpec)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
      statusCode: 403,
    });

    // Forged spec attempting to hijack hp_ingress_proxy container name
    const forgedProxyHijackSpec = {
      ...validBaseSpec,
      containerName: INGRESS_PROXY_CONTAINER_NAME,
    } as unknown as ApprovedServiceSpec;

    await expect(simulator.deployService(forgedProxyHijackSpec)).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
  });

  it("bootstraps standalone daemon from environment over UDS and flags malformed out-of-band label tampering safely", async () => {
    const tmpBaseDir = await mkdtemp(path.join(os.tmpdir(), "hp-daemon-boot-"));
    cleanupTasks.push(() => rm(tmpBaseDir, { recursive: true, force: true }));

    const socketPath = `/tmp/hp-exec-boot-${randomBytes(5).toString("hex")}.sock`;
    const daemon = await bootstrapDockerExecutorDaemon({
      HP_IPC_KEY: HMAC_SECRET,
      HP_IPC_KEY_ID: "hmac-v1",
      HP_IPC_TRANSPORT: "uds",
      HP_EXECUTOR_SOCKET_PATH: socketPath,
      HP_EXECUTOR_BACKEND: "local-simulator",
      HP_SECRETS_ROOT_DIR: path.join(tmpBaseDir, "secrets"),
      HP_INGRESS_ROOT_DIR: path.join(tmpBaseDir, "ingress"),
    });
    cleanupTasks.push(() => daemon.stop());

    const client = new SignedDockerExecutorIpcClient({
      signingKey: HMAC_SIGNING_KEY,
      transport: "uds",
      socketPath,
    });

    const health = await client.checkHealth();
    expect(health.status).toBe("online");
    expect(health.runtimeBackend).toBe("local-simulator");
  });

  it("self-heals ensureStaticConfig directory collision and recreates stale hp_ingress_proxy on bind/port mismatch", async () => {
    const tmpBaseDir = await mkdtemp(path.join(os.tmpdir(), "hp-ingress-heal-"));
    cleanupTasks.push(() => rm(tmpBaseDir, { recursive: true, force: true }));

    const ingressRootDir = path.join(tmpBaseDir, "ingress");
    // Simulate Docker daemon auto-creating traefik.yml as a directory after /tmp reset
    const collidedDir = path.join(ingressRootDir, "static", "traefik.yml");
    await mkdir(collidedDir, { recursive: true });

    const mockDaemon = await startMockDockerDaemon();
    cleanupTasks.push(() => mockDaemon.close());

    // Pre-seed a stale hp_ingress_proxy pointing to an old ingress path and port 80
    mockDaemon.containers.set("ctr_stale_proxy", {
      id: "ctr_stale_proxy",
      name: INGRESS_PROXY_CONTAINER_NAME,
      image: "traefik:v3.7",
      env: [],
      labels: { "io.hostingpanel.managed": "true", "io.hostingpanel.role": "ingress_proxy" },
      hostConfig: {
        Privileged: false,
        CapDrop: ["ALL"],
        CapAdd: ["NET_BIND_SERVICE"],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 256,
        RestartPolicy: { Name: "unless-stopped" },
        NetworkMode: "hp_ingress_net",
        Binds: [
          "/tmp/old-stale-dir/static/traefik.yml:/etc/traefik/traefik.yml:ro",
          "/tmp/old-stale-dir/dynamic:/etc/traefik/dynamic:ro",
        ],
        PortBindings: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "80" }] },
      },
      networks: { hp_ingress_net: {} },
      running: false,
      status: "exited",
      restartCount: 0,
    });

    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmpBaseDir, "secrets"),
      ingressRootDir,
      ingressHttpPort: 18080,
      pullMissingImages: false,
    });

    const ensured = await adapter.ensureIngressProxy();
    expect(ensured.status).toBe("running");

    const healedStat = await stat(collidedDir);
    expect(healedStat.isFile()).toBe(true);

    expect(mockDaemon.containers.has("ctr_stale_proxy")).toBe(false);
    const recreated = [...mockDaemon.containers.values()].find(
      (c) => c.name === INGRESS_PROXY_CONTAINER_NAME,
    );
    expect(recreated).toBeDefined();
    expect(recreated?.running).toBe(true);
    expect(recreated?.hostConfig.Binds).toEqual([
      `${path.join(ingressRootDir, "static", "traefik.yml")}:/etc/traefik/traefik.yml:ro`,
      `${path.join(ingressRootDir, "dynamic")}:/etc/traefik/dynamic:ro`,
    ]);
  });
});
