import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  ExecutorIpcClientError,
  INGRESS_PROXY_CONTAINER_NAME,
  InMemoryDockerSimulatorAdapter,
  MANAGED_DOCKER_LABELS,
  SignedDockerExecutorIpcClient,
  bootstrapDockerExecutorDaemon,
  parsePanelIngressConfigFromEnv,
  buildIngressProxyContainerPayload,
  buildPanelDynamicYaml,
  buildTraefikStaticYaml,
  validateCertifiedCapabilities,
  type PanelIngressConfig,
} from "../src/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

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
      `${path.join(ingressRootDir, "acme")}:/etc/traefik/acme`,
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
      `${path.join(ingressRootDir, "acme")}:/etc/traefik/acme`,
    ]);
  });
});

describe("panel ingress", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      await cleanupTasks.pop()?.();
    }
  });

  const panel: PanelIngressConfig = {
    hostname: "srv12.example.it",
    ipv4: "203.0.113.10",
    acmeEmail: "ops@example.it",
    acmeStaging: false,
    upstreamPort: 3000,
  };

  it("static yaml has websecure and acme resolver only with email", () => {
    const withEmail = buildTraefikStaticYaml(panel);
    expect(withEmail).toContain("websecure:");
    expect(withEmail).toContain('address: ":443"');
    expect(withEmail).toContain("certificatesResolvers:");
    expect(withEmail).toContain("storage: /etc/traefik/acme/acme.json");
    expect(withEmail).toContain("entryPoint: web");
    expect(withEmail).not.toContain("acme-staging-v02");

    const noEmail = buildTraefikStaticYaml({ ...panel, acmeEmail: null });
    expect(noEmail).toContain("websecure:");
    expect(noEmail).not.toContain("certificatesResolvers");

    const disabled = buildTraefikStaticYaml(null);
    expect(disabled).toContain("websecure:");
    expect(disabled).not.toContain("certificatesResolvers");

    expect(buildTraefikStaticYaml({ ...panel, acmeStaging: true })).toContain("acme-staging-v02");
  });

  it("panel route matches hostname and server IP", () => {
    const yaml = buildPanelDynamicYaml(panel);
    expect(yaml).toContain("Host(`srv12.example.it`)");
    expect(yaml).toContain("Host(`203.0.113.10`)");
    expect(yaml).toContain("certResolver: le");
    expect(yaml).toContain("http://host.docker.internal:3000");
    expect(yaml).toContain("scheme: https");
    expect(buildPanelDynamicYaml({ ...panel, acmeEmail: null })).not.toContain("certResolver");
  });

  it("panel route rejects unsafe hostname or invalid ipv4", () => {
    expect(() => buildPanelDynamicYaml({ ...panel, hostname: "a`b" })).toThrow();
    expect(() => buildPanelDynamicYaml({ ...panel, hostname: "*.example.it" })).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    expect(() => buildPanelDynamicYaml({ ...panel, ipv4: "999.1.1.1" })).toThrow(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
  });

  it("parses panel env: empty hostname disables, invalid values disable, valid values parse", () => {
    expect(parsePanelIngressConfigFromEnv({ HP_PANEL_HOSTNAME: "" })).toBeNull();
    expect(
      parsePanelIngressConfigFromEnv({ HP_PANEL_HOSTNAME: "srv12.example.it", HP_PANEL_IPV4: "" }),
    ).toBeNull();
    expect(
      parsePanelIngressConfigFromEnv({
        HP_PANEL_HOSTNAME: "srv12.example.it",
        HP_PANEL_IPV4: "203.0.113.10",
        HP_ACME_EMAIL: "ops@example.it",
        HP_ACME_STAGING: "false",
        HP_PANEL_UPSTREAM_PORT: "3000",
      }),
    ).toEqual(panel);
  });

  it("proxy payload binds 443, acme dir rw, host-gateway", () => {
    const payload = buildIngressProxyContainerPayload({
      staticConfigHostPath: "/var/lib/hosting-panel/ingress/static/traefik.yml",
      dynamicDirHostPath: "/var/lib/hosting-panel/ingress/dynamic",
      acmeDirHostPath: "/var/lib/hosting-panel/ingress/acme",
    });
    expect(payload.HostConfig.PortBindings["443/tcp"]?.[0]?.HostPort).toBe("443");
    expect(payload.ExposedPorts["443/tcp"]).toEqual({});
    expect(payload.HostConfig.Binds).toContain(
      "/var/lib/hosting-panel/ingress/acme:/etc/traefik/acme",
    );
    expect(payload.HostConfig.ExtraHosts).toEqual(["host.docker.internal:host-gateway"]);
    expect(payload.HostConfig.Binds.some((b) => b.includes("docker.sock"))).toBe(false);
  });

  it("proxy keeps its default route on hp_ingress_net (GwPriority, O2)", () => {
    const payload = buildIngressProxyContainerPayload({
      staticConfigHostPath: "/s/traefik.yml",
      dynamicDirHostPath: "/s/dynamic",
      acmeDirHostPath: "/s/acme",
    });
    expect(payload.NetworkingConfig.EndpointsConfig.hp_ingress_net).toEqual({ GwPriority: 1 });
  });

  it("creates the proxy at API 1.48 and recreates one without the gateway priority", async () => {
    const { adapter, mockDaemon, proxy, recreateCalls } = await setupAdapter(panel);
    await adapter.ensureIngressProxy();
    expect(
      mockDaemon.requestedPaths.some((p) =>
        p.startsWith(`/v1.48/containers/create?name=${INGRESS_PROXY_CONTAINER_NAME}`),
      ),
    ).toBe(true);

    const first = proxy();
    if (first) {
      first.networks = { hp_ingress_net: { GwPriority: 0 } }; // proxy made by an older release
    }
    const mark = mockDaemon.requestedPaths.length;
    await adapter.ensureIngressProxy();
    expect(recreateCalls(mark).length).toBe(2);
    expect(proxy()?.networks).toEqual({ hp_ingress_net: { GwPriority: 1 } });
  });

  async function setupAdapter(panelConfig: PanelIngressConfig | null) {
    const tmpBaseDir = await mkdtemp(path.join(os.tmpdir(), "hp-panel-ingress-"));
    cleanupTasks.push(() => rm(tmpBaseDir, { recursive: true, force: true }));
    const mockDaemon = await startMockDockerDaemon();
    cleanupTasks.push(() => mockDaemon.close());
    const ingressRootDir = path.join(tmpBaseDir, "ingress");
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmpBaseDir, "secrets"),
      ingressRootDir,
      pullMissingImages: false,
      panel: panelConfig,
    });
    const proxy = () =>
      [...mockDaemon.containers.values()].find((c) => c.name === INGRESS_PROXY_CONTAINER_NAME);
    const recreateCalls = (from: number) =>
      mockDaemon.requestedPaths
        .slice(from)
        .filter((p) => p.includes("/containers/create") || /\/containers\/[^/]+\?force/.test(p));
    return { adapter, mockDaemon, ingressRootDir, proxy, recreateCalls };
  }

  it("ensureIngressProxy writes panel files and does not recreate an up-to-date proxy", async () => {
    const { adapter, mockDaemon, ingressRootDir, proxy, recreateCalls } =
      await setupAdapter(panel);
    await adapter.ensureIngressProxy();
    const first = proxy();
    expect(first).toBeDefined();

    expect(await readFile(path.join(ingressRootDir, "dynamic", "hp-panel.yml"), "utf8")).toContain(
      "Host(`srv12.example.it`)",
    );
    const acmeStat = await stat(path.join(ingressRootDir, "acme"));
    expect(acmeStat.mode & 0o777).toBe(0o700);
    const acmeJsonStat = await stat(path.join(ingressRootDir, "acme", "acme.json"));
    expect(acmeJsonStat.mode & 0o777).toBe(0o600);

    // Docker may report arrays in a different order: must not count as a change
    if (first) {
      first.hostConfig = {
        ...first.hostConfig,
        Binds: [...(first.hostConfig.Binds ?? [])].reverse(),
      };
    }
    const mark = mockDaemon.requestedPaths.length;
    await adapter.ensureIngressProxy();
    expect(recreateCalls(mark)).toEqual([]);
    expect(proxy()?.id).toBe(first?.id);
  });

  it("ensureIngressProxy recreates when only PortBindings differ", async () => {
    const { adapter, mockDaemon, proxy, recreateCalls } = await setupAdapter(panel);
    await adapter.ensureIngressProxy();
    const first = proxy();
    if (first) {
      first.hostConfig = {
        ...first.hostConfig,
        PortBindings: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "80" }] },
      };
    }
    const mark = mockDaemon.requestedPaths.length;
    await adapter.ensureIngressProxy();
    expect(recreateCalls(mark).length).toBe(2);
    expect(proxy()?.id).not.toBe(first?.id);
  });

  it("ensureIngressProxy recreates when the static config changes", async () => {
    const { adapter, mockDaemon, ingressRootDir, proxy, recreateCalls } =
      await setupAdapter(null);
    await adapter.ensureIngressProxy();
    const first = proxy();

    const panelAdapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(ingressRootDir, "..", "secrets"),
      ingressRootDir,
      pullMissingImages: false,
      panel,
    });
    const mark = mockDaemon.requestedPaths.length;
    await panelAdapter.ensureIngressProxy();
    expect(recreateCalls(mark).length).toBe(2);
    expect(proxy()?.id).not.toBe(first?.id);
    expect(proxy()?.labels["io.hostingpanel.static_sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reattaches site edge networks on every ensure (idempotent)", async () => {
    const { adapter, mockDaemon, proxy } = await setupAdapter(panel);
    for (const name of ["hp_edge_site_a_net", "hp_edge_site_b_net"]) {
      mockDaemon.createdNetworks.push({
        Name: name,
        Labels: { "io.hostingpanel.network_role": "site_edge" },
      });
    }
    mockDaemon.createdNetworks.push({
      Name: "hp_site_site_a_net",
      Labels: { "io.hostingpanel.network_role": "site_internal" },
    });
    const proxyConnects = () =>
      mockDaemon.networkConnectCalls
        .filter((c) => c.container === INGRESS_PROXY_CONTAINER_NAME)
        .map((c) => c.network)
        .sort();

    await adapter.ensureIngressProxy();
    expect(proxyConnects()).toEqual(["hp_edge_site_a_net", "hp_edge_site_b_net"]);

    mockDaemon.networkConnectCalls.length = 0;
    await adapter.ensureIngressProxy(); // up to date: no recreate, still reconnect (CP-01)
    expect(proxyConnects()).toEqual(["hp_edge_site_a_net", "hp_edge_site_b_net"]);

    mockDaemon.networkConnectCalls.length = 0;

    const current = proxy();
    if (current) {
      current.hostConfig = { ...current.hostConfig, ExtraHosts: [] };
    }
    await adapter.ensureIngressProxy(); // drift: recreate + reconnect
    expect(proxyConnects()).toEqual(["hp_edge_site_a_net", "hp_edge_site_b_net"]);
  });

  it("skips a site edge network that vanished (404) and still attaches the others", async () => {
    const { adapter, mockDaemon } = await setupAdapter(panel);
    for (const name of ["hp_edge_site_a_net", "hp_edge_site_b_net", "hp_edge_site_c_net"]) {
      mockDaemon.createdNetworks.push({
        Name: name,
        Labels: { "io.hostingpanel.network_role": "site_edge" },
      });
    }
    mockDaemon.vanishedNetworks.add("hp_edge_site_b_net");
    await expect(adapter.ensureIngressProxy()).resolves.toMatchObject({ status: "running" });
    expect(
      mockDaemon.networkConnectCalls
        .filter((c) => c.container === INGRESS_PROXY_CONTAINER_NAME)
        .map((c) => c.network)
        .sort(),
    ).toEqual(["hp_edge_site_a_net", "hp_edge_site_b_net", "hp_edge_site_c_net"]);
  });

  it("serialises concurrent ensureIngressProxy calls into a single create", async () => {
    const { adapter, mockDaemon } = await setupAdapter(panel);
    await Promise.all([adapter.ensureIngressProxy(), adapter.ensureIngressProxy()]);
    expect(mockDaemon.requestedPaths.filter((p) => p.includes("/containers/create"))).toHaveLength(
      1,
    );
  });

  it("rejects an invalid HP_INGRESS_HTTPS_PORT at startup", async () => {
    await expect(
      bootstrapDockerExecutorDaemon({
        HP_IPC_KEY: HMAC_SECRET,
        HP_IPC_TRANSPORT: "loopback-test",
        HP_INGRESS_HTTPS_PORT: "abc",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("removes the panel dynamic file when the panel is disabled", async () => {
    const { adapter, ingressRootDir } = await setupAdapter(null);
    const panelFile = path.join(ingressRootDir, "dynamic", "hp-panel.yml");
    await mkdir(path.dirname(panelFile), { recursive: true });
    await writeFile(panelFile, "stale");
    await adapter.ensureIngressProxy();
    await expect(stat(panelFile)).rejects.toThrow();
  });
});

describe("service logs", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      await cleanupTasks.pop()?.();
    }
  });

  async function setup(options?: Parameters<typeof startMockDockerDaemon>[0]) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-logs-"));
    cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));
    const mockDaemon = await startMockDockerDaemon(options);
    cleanupTasks.push(() => mockDaemon.close());
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmp, "secrets"),
      ingressRootDir: path.join(tmp, "ingress"),
    });
    return { adapter, mockDaemon };
  }

  const spec = () =>
    createApprovedServiceSpec({
      serviceInstanceId: "svc_logs",
      siteId: "site_logs",
      organizationId: "org_logs",
      image: "ghcr.io/example/webapp:1.0.0",
      containerName: "hp-site-logs",
      env: {},
      resourceLimits: { cpuMilli: 500, memoryBytes: "536870912" },
      pidsLimit: 128,
      revisionNumber: 1,
      specHash: "hash_logs",
      domains: [],
      exposeHttp: false,
      internalPort: 3000,
      volumeMounts: [],
      resolvedSecrets: {},
    });

  it("getServiceLogs clamps tail and returns demuxed lines", async () => {
    const frame = Buffer.alloc(8);
    const text = Buffer.from("2026-01-02T03:04:05.123456789Z hello\n");
    frame[0] = 1;
    frame.writeUInt32BE(text.length, 4);
    const { adapter, mockDaemon } = await setup({
      pullBody: "",
      logsBody: Buffer.concat([frame, text]),
    });
    await adapter.deployService(spec());
    const lines = await adapter.getServiceLogs("svc_logs", 9999);
    expect(lines).toEqual([
      { at: "2026-01-02T03:04:05.123456789Z", stream: "stdout", text: "hello" },
    ]);
    expect(mockDaemon.requestedPaths.some((p) => p.includes("/logs?") && p.includes("tail=500"))).toBe(
      true,
    );
    await expect(adapter.getServiceLogs("svc_missing", 5)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("a pull that streams an error is reported as a failure", async () => {
    const { adapter, mockDaemon } = await setup({
      pullBody: '{"status":"Pulling"}\n{"error":"manifest unknown"}\n',
    });
    await expect(adapter.deployService(spec())).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
      message: "Could not download the site software",
    });
    expect(mockDaemon.requestedPaths.some((p) => p.includes("/containers/create"))).toBe(false);
  });
});

describe("purge site", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanupTasks.length > 0) {
      await cleanupTasks.pop()?.();
    }
  });

  async function setup() {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-purge-"));
    cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));
    const mockDaemon = await startMockDockerDaemon();
    cleanupTasks.push(() => mockDaemon.close());
    const ingressRootDir = path.join(tmp, "ingress");
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmp, "secrets"),
      ingressRootDir,
    });
    const dynamic = path.join(ingressRootDir, "dynamic");
    await mkdir(dynamic, { recursive: true });
    for (const id of ["A", "B"]) {
      await writeFile(path.join(dynamic, `site_${id}.yml`), "x");
      mockDaemon.volumeLabels.set(`hp_vol_${id}`, { "io.hostingpanel.site_id": id });
      for (const net of [`hp_site_${id}_net`, `hp_edge_${id}_net`]) {
        await fetchNetwork(mockDaemon.socketPath, net);
      }
    }
    return { adapter, mockDaemon, dynamic };
  }

  function fetchNetwork(socketPath: string, Name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath, path: "/networks/create", method: "POST" },
        (res) => {
          res.resume();
          res.on("end", resolve);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ Name }));
    });
  }

  it("purgeSite removes only volumes and networks labelled with that site", async () => {
    const { adapter, mockDaemon, dynamic } = await setup();
    await adapter.purgeSite("A");
    expect(mockDaemon.deletedVolumes).toEqual(["hp_vol_A"]);
    expect([...mockDaemon.deletedNetworks].sort()).toEqual(["hp_edge_A_net", "hp_site_A_net"]);
    await expect(stat(path.join(dynamic, "site_A.yml"))).rejects.toThrow();
    await expect(stat(path.join(dynamic, "site_B.yml"))).resolves.toBeTruthy();
  });

  it("purgeSite refuses while a site container exists", async () => {
    const { adapter, mockDaemon } = await setup();
    mockDaemon.containers.set("c1", {
      id: "c1",
      name: "hp-site-a",
      image: "x",
      env: [],
      labels: { "io.hostingpanel.site_id": "A" },
      running: true,
      status: "running",
      restartCount: 0,
      hostConfig: {},
      networks: {},
    });
    await expect(adapter.purgeSite("A")).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    expect(mockDaemon.deletedVolumes).toEqual([]);
  });

  it("purgeSite removes leftover job containers and is idempotent", async () => {
    const { adapter, mockDaemon } = await setup();
    mockDaemon.containers.set("j1", {
      id: "j1",
      name: "job",
      image: "x",
      env: [],
      labels: { "io.hostingpanel.site_id": "A", "io.hostingpanel.role": "site_job" },
      running: false,
      status: "exited",
      restartCount: 0,
      hostConfig: {},
      networks: {},
    });
    await adapter.purgeSite("A");
    await adapter.purgeSite("A");
    expect(mockDaemon.containers.size).toBe(0);
    expect(mockDaemon.deletedVolumes).toEqual(["hp_vol_A"]);
  });
});

describe("site IPC", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupTasks.length > 0) {
      await cleanupTasks.pop()?.();
    }
  });

  async function setup() {
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
    return { simulator, client };
  }

  // db.provision only accepts a 64-char hex password, so the canary must be one.
  const CANARY = "ca7a".repeat(16);
  const provisionJob = {
    jobId: "job_site_ipc_1",
    kind: "db.provision" as const,
    siteId: "site_1",
    organizationId: "org_1",
    params: { dbName: "wp_site_1", dbUser: "wp_site_1" },
    resolvedSecrets: { HP_DB_PASSWORD: CANARY },
  };

  it("round-trips a job and never logs the secret", async () => {
    const { client } = await setup();
    const captured: string[] = [];
    const grab = (chunk: unknown): boolean => {
      captured.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(grab);
    vi.spyOn(process.stderr, "write").mockImplementation(grab);

    const result = await client.runSiteJob(provisionJob);
    expect(result).toMatchObject({ jobId: "job_site_ipc_1", exitCode: 0 });
    expect(captured.join("")).not.toContain(CANARY);
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("rejects an unknown job kind with VALIDATION_ERROR", async () => {
    const { client } = await setup();
    await expect(
      client.runSiteJob({ ...provisionJob, kind: "rm.rf" as never }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("serves purge and logs", async () => {
    const { client, simulator } = await setup();
    simulator.setServiceLogs("svc_1", [{ at: null, stream: "stdout", text: "hi" }]);
    expect(await client.getServiceLogs("svc_1", 10)).toEqual([
      { at: null, stream: "stdout", text: "hi" },
    ]);
    await expect(client.purgeSite("site_1")).resolves.toBeUndefined();
  });

  it("client uses 300 s for deploy and 510 s for job requests", async () => {
    const { client } = await setup();
    const timeouts: Array<number | undefined> = [];
    vi.spyOn(http, "request").mockImplementation(((opts: http.RequestOptions) => {
      timeouts.push(opts.timeout);
      throw new Error("stop");
    }) as never);
    const spec = createApprovedServiceSpec({
      serviceInstanceId: "svc_t",
      siteId: "site_t",
      organizationId: "org_t",
      image: "nginx:1.27-alpine",
      containerName: "hp-t",
    });
    await client.deployService(spec).catch(() => undefined);
    await client.runSiteJob(provisionJob).catch(() => undefined);
    await client.purgeSite("site_t").catch(() => undefined);
    await client.getServiceLogs("svc_t", 5).catch(() => undefined);
    expect(timeouts).toEqual([300_000, 510_000, 120_000, 35_000]);
  });
});
