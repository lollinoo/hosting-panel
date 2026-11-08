import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  findForbiddenPublicDtoKeys,
  generateEd25519IpcKeyPair,
  signIpcRequest,
  type IpcSigningKey,
  type IpcVerificationKeyring,
} from "@hosting-panel/contracts";
import {
  createApprovedHostMaintenanceCommand,
  createApprovedHostSecurityCommand,
  type ApprovedHostMaintenanceCommand,
  type ApprovedHostSecurityCommand,
} from "@hosting-panel/host-agent-contracts";
import {
  ALLOWED_LINUX_BINARIES,
  DEDICATED_NFTABLES_RULESET_SHA256,
  HostAgentIpcClientError,
  HostAgentIpcServer,
  HostPolicyDeniedError,
  InMemoryHostSimulatorAdapter,
  LinuxSystemHostAdapter,
  REPO_DEDICATED_NFTABLES_RULESET_PATH,
  SignedHostAgentIpcClient,
  createHostAgentDaemonFromEnv,
  parseProcMeminfoBytes,
  parseProcStatCpuLine,
  runAllowlistedBinary,
  type AllowedLinuxBinary,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const HOST_AGENT_SRC_DIR = resolve(TEST_DIR, "../src");
const REPO_ROOT = resolve(TEST_DIR, "../../..");
const SYSTEMD_DIR = resolve(REPO_ROOT, "infra/systemd");
const BOOTSTRAP_SCRIPT_PATH = resolve(REPO_ROOT, "infra/linux/bootstrap-dedicated.sh");

const TEST_HMAC_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_SIGNING_KEY: IpcSigningKey = {
  keyId: "ipc-test-v1",
  algorithm: "hmac-sha256",
  secret: TEST_HMAC_SECRET,
};
const TEST_KEYRING: IpcVerificationKeyring = {
  "ipc-test-v1": {
    keyId: "ipc-test-v1",
    algorithm: "hmac-sha256",
    secret: TEST_HMAC_SECRET,
  },
};

function sendRawSocketHttpRequest(options: {
  readonly socketPath: string;
  readonly method: string;
  readonly pathWithQuery: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}): Promise<{ readonly statusCode: number; readonly json: Record<string, unknown> }> {
  return new Promise((resolveReq, rejectReq) => {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(options.headers ?? {}),
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
      headers["content-length"] = String(Buffer.byteLength(options.body, "utf8"));
    }

    const req = http.request(
      {
        socketPath: options.socketPath,
        method: options.method,
        path: options.pathWithQuery,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer | Uint8Array) =>
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
        );
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolveReq({
            statusCode: res.statusCode ?? 500,
            json: JSON.parse(text) as Record<string, unknown>,
          });
        });
      },
    );
    req.on("error", rejectReq);
    if (options.body !== undefined) {
      req.write(options.body, "utf8");
    }
    req.end();
  });
}

function parseSystemdServiceDirectives(content: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  let currentSection = "";

  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      currentSection = trimmed.slice(1, -1);
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }
    const key = `${currentSection}.${trimmed.slice(0, eqIndex).trim()}`;
    const value = trimmed.slice(eqIndex + 1).trim();
    const existing = directives.get(key) ?? [];
    existing.push(value);
    directives.set(key, existing);
  }

  return directives;
}

describe("@hosting-panel/host-agent & Linux/systemd infrastructure (HCP-SPEC-003 Wave 2B)", () => {
  const tempDirs: string[] = [];
  const activeServers: HostAgentIpcServer[] = [];

  async function createShortTempDir(): Promise<string> {
    const dir = await mkdtemp(join(os.tmpdir(), "hp-ha-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (activeServers.length > 0) {
      const srv = activeServers.pop();
      if (srv) {
        await srv.stop();
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  describe("AC-F2-02: Signed UDS IPC authentication, clock-skew & anti-replay", () => {
    it("binds Unix Domain Socket with 0660 mode and serves authenticated client requests", async () => {
      const dir = await createShortTempDir();
      const socketPath = join(dir, "host-agent.sock");
      const simulator = new InMemoryHostSimulatorAdapter();

      const server = new HostAgentIpcServer({
        adapter: simulator,
        keyring: TEST_KEYRING,
        runtimeBackend: "local-simulator",
        transportConfig: {
          transport: "uds",
          socketPath,
          socketMode: 0o660,
        },
      });
      activeServers.push(server);

      const endpoint = await server.start();
      expect(endpoint).toEqual({ transport: "uds", socketPath });

      const sockStat = await stat(socketPath);
      expect(sockStat.isSocket()).toBe(true);
      expect(sockStat.mode & 0o777).toBe(0o660);

      const client = new SignedHostAgentIpcClient({
        signingKey: TEST_SIGNING_KEY,
        socketPath,
      });

      const health = await client.checkHealth();
      expect(health.component).toBe("host_agent");
      expect(health.status).toBe("online");
      expect(health.runtimeBackend).toBe("local-simulator");

      const telemetry = await client.getHostTelemetry("host_dedicated_01");
      expect(telemetry).not.toBeNull();
      expect(telemetry?.hostId).toBe("host_dedicated_01");
      expect(findForbiddenPublicDtoKeys(telemetry)).toEqual([]);

      const maintCmd = createApprovedHostMaintenanceCommand({
        hostId: "host_dedicated_01",
        action: "collect_diagnostics",
        reason: "scheduled check",
      });
      const maintRes = await client.executeMaintenance(maintCmd, "op_custom_1");
      expect(maintRes.operationId).toBe("op_custom_1");
      expect(maintRes.status).toBe("succeeded");

      const secCmd = createApprovedHostSecurityCommand({
        hostId: "host_dedicated_01",
        policyRef: "verify_baseline_firewall",
      });
      const secRes = await client.executeSecurityPolicy(secCmd, "op_sec_custom_1");
      expect(secRes.operationId).toBe("op_sec_custom_1");
      expect(secRes.status).toBe("succeeded");
    });

    it("supports Ed25519 asymmetric IPC signing and loopback-test ephemeral transport", async () => {
      const edKey = generateEd25519IpcKeyPair("ed25519-agent-v1");
      const simulator = new InMemoryHostSimulatorAdapter();
      const server = new HostAgentIpcServer({
        adapter: simulator,
        keyring: { [edKey.keyId]: edKey.verificationKey },
        runtimeBackend: "local-simulator",
        transportConfig: {
          transport: "loopback-test",
          host: "127.0.0.1",
          port: 0,
        },
      });
      activeServers.push(server);

      const endpoint = await server.start();
      expect(endpoint.transport).toBe("loopback-test");
      if (endpoint.transport === "loopback-test") {
        expect(endpoint.host).toBe("127.0.0.1");
        expect(endpoint.port).toBeGreaterThan(0);
      }

      const client = new SignedHostAgentIpcClient({
        signingKey: edKey.signingKey,
        endpoint,
      });

      const health = await client.checkHealth();
      expect(health.status).toBe("online");
    });

    it("rejects missing headers (401), tampered signature/body (401), clock skew > 30s (401), and replayed nonces (409)", async () => {
      const dir = await createShortTempDir();
      const socketPath = join(dir, "host-agent.sock");
      const fixedNowMs = 1_762_550_000_000;

      const server = new HostAgentIpcServer({
        adapter: new InMemoryHostSimulatorAdapter(),
        keyring: TEST_KEYRING,
        nowProvider: () => fixedNowMs,
        transportConfig: { transport: "uds", socketPath },
      });
      activeServers.push(server);
      await server.start();

      // 1. Missing headers -> 401
      const missingRes = await sendRawSocketHttpRequest({
        socketPath,
        method: "GET",
        pathWithQuery: "/v1/health",
      });
      expect(missingRes.statusCode).toBe(401);
      expect((missingRes.json.error as { code: string }).code).toBe("UNAUTHENTICATED");

      // 2. Tampered signature -> 401
      const validHeaders = signIpcRequest({
        method: "GET",
        pathWithQuery: "/v1/health",
        key: TEST_SIGNING_KEY,
        timestampMs: fixedNowMs,
        nonce: "nonce-tamper-check",
      });
      const tamperedSig =
        (validHeaders["x-hp-signature"].startsWith("0") ? "1" : "0") +
        validHeaders["x-hp-signature"].slice(1);
      const badSigRes = await sendRawSocketHttpRequest({
        socketPath,
        method: "GET",
        pathWithQuery: "/v1/health",
        headers: {
          ...validHeaders,
          "x-hp-signature": tamperedSig,
        },
      });
      expect(badSigRes.statusCode).toBe(401);

      // 3. Body tampering after signing -> 401
      const signedPostBody = JSON.stringify({
        hostId: "host_1",
        action: "collect_diagnostics",
      });
      const postHeaders = signIpcRequest({
        method: "POST",
        pathWithQuery: "/v1/maintenance",
        body: signedPostBody,
        key: TEST_SIGNING_KEY,
        timestampMs: fixedNowMs,
        nonce: "nonce-body-tamper",
      });
      const bodyMismatchRes = await sendRawSocketHttpRequest({
        socketPath,
        method: "POST",
        pathWithQuery: "/v1/maintenance",
        headers: postHeaders,
        body: JSON.stringify({
          hostId: "host_1",
          action: "refresh_host_inventory",
        }),
      });
      expect(bodyMismatchRes.statusCode).toBe(401);

      // 4. Clock skew > 30s (stale and future) -> 401
      const staleHeaders = signIpcRequest({
        method: "GET",
        pathWithQuery: "/v1/health",
        key: TEST_SIGNING_KEY,
        timestampMs: fixedNowMs - 31_000,
        nonce: "nonce-stale-ts",
      });
      const staleRes = await sendRawSocketHttpRequest({
        socketPath,
        method: "GET",
        pathWithQuery: "/v1/health",
        headers: staleHeaders,
      });
      expect(staleRes.statusCode).toBe(401);

      const futureHeaders = signIpcRequest({
        method: "GET",
        pathWithQuery: "/v1/health",
        key: TEST_SIGNING_KEY,
        timestampMs: fixedNowMs + 31_000,
        nonce: "nonce-future-ts",
      });
      const futureRes = await sendRawSocketHttpRequest({
        socketPath,
        method: "GET",
        pathWithQuery: "/v1/health",
        headers: futureHeaders,
      });
      expect(futureRes.statusCode).toBe(401);

      // 5. Nonce replay -> first succeeds (200), replay rejected (409 IDEMPOTENCY_CONFLICT)
      const replayHeaders = signIpcRequest({
        method: "GET",
        pathWithQuery: "/v1/health",
        key: TEST_SIGNING_KEY,
        timestampMs: fixedNowMs,
        nonce: "nonce-replay-001",
      });
      const firstOk = await sendRawSocketHttpRequest({
        socketPath,
        method: "GET",
        pathWithQuery: "/v1/health",
        headers: replayHeaders,
      });
      expect(firstOk.statusCode).toBe(200);

      const secondReplay = await sendRawSocketHttpRequest({
        socketPath,
        method: "GET",
        pathWithQuery: "/v1/health",
        headers: replayHeaders,
      });
      expect(secondReplay.statusCode).toBe(409);
      expect((secondReplay.json.error as { code: string }).code).toBe("IDEMPOTENCY_CONFLICT");
    });

    it("refuses 0.0.0.0 bind addresses, arbitrary fixed TCP ports, and path traversal sockets", () => {
      const simulator = new InMemoryHostSimulatorAdapter();

      expect(
        () =>
          new HostAgentIpcServer({
            adapter: simulator,
            keyring: TEST_KEYRING,
            transportConfig: {
              transport: "loopback-test",
              host: "0.0.0.0" as "127.0.0.1",
              port: 0,
            },
          }),
      ).toThrow(HostPolicyDeniedError);

      expect(
        () =>
          new HostAgentIpcServer({
            adapter: simulator,
            keyring: TEST_KEYRING,
            transportConfig: {
              transport: "loopback-test",
              host: "127.0.0.1",
              port: 8080 as 0,
            },
          }),
      ).toThrow(HostPolicyDeniedError);

      expect(
        () =>
          new HostAgentIpcServer({
            adapter: simulator,
            keyring: TEST_KEYRING,
            transportConfig: {
              transport: "uds",
              socketPath: "/run/hosting-panel/../escaped.sock",
            },
          }),
      ).toThrow(HostPolicyDeniedError);
    });

    it("refuses to clobber a non-socket file at UDS path, maps missing host telemetry to null, and maps offline socket to 503 HOST_AGENT_UNAVAILABLE", async () => {
      const dir = await createShortTempDir();
      const regularFilePath = join(dir, "not-a-socket.sock");
      await writeFile(regularFilePath, "keep-me", "utf8");

      const simulator = new InMemoryHostSimulatorAdapter();
      simulator.setTelemetryOverride("host_missing", null);

      const blockedServer = new HostAgentIpcServer({
        adapter: simulator,
        keyring: TEST_KEYRING,
        transportConfig: { transport: "uds", socketPath: regularFilePath },
      });
      await expect(blockedServer.start()).rejects.toThrow(HostPolicyDeniedError);

      const validSocketPath = join(dir, "live.sock");
      const liveServer = new HostAgentIpcServer({
        adapter: simulator,
        keyring: TEST_KEYRING,
        transportConfig: { transport: "uds", socketPath: validSocketPath },
      });
      activeServers.push(liveServer);
      await liveServer.start();

      const client = new SignedHostAgentIpcClient({
        signingKey: TEST_SIGNING_KEY,
        socketPath: validSocketPath,
      });

      const missingTelemetry = await client.getHostTelemetry("host_missing");
      expect(missingTelemetry).toBeNull();

      await liveServer.stop();
      await expect(client.checkHealth()).rejects.toMatchObject({
        code: "HOST_AGENT_UNAVAILABLE",
        statusCode: 503,
        retryable: true,
      });
    });
  });

  describe("AC-F2-04: Strict allowlist enforcement & mechanical zero-shell verification", () => {
    it("rejects non-allowlisted maintenance actions and policyRef values with 403 HOST_POLICY_DENIED", async () => {
      const dir = await createShortTempDir();
      const socketPath = join(dir, "host-agent.sock");
      const adapter = new LinuxSystemHostAdapter();

      const server = new HostAgentIpcServer({
        adapter,
        keyring: TEST_KEYRING,
        transportConfig: { transport: "uds", socketPath },
      });
      activeServers.push(server);
      await server.start();

      const forbiddenActions = ["rm -rf /", "reboot", "sh -c id", "collect_diagnostics && whoami"];
      for (const forbiddenAction of forbiddenActions) {
        const body = JSON.stringify({
          hostId: "host_1",
          action: forbiddenAction,
        });
        const headers = signIpcRequest({
          method: "POST",
          pathWithQuery: "/v1/maintenance",
          body,
          key: TEST_SIGNING_KEY,
        });
        const res = await sendRawSocketHttpRequest({
          socketPath,
          method: "POST",
          pathWithQuery: "/v1/maintenance",
          headers,
          body,
        });
        expect(res.statusCode).toBe(403);
        expect((res.json.error as { code: string }).code).toBe("HOST_POLICY_DENIED");

        await expect(
          adapter.executeMaintenance({
            __brand: "ApprovedHostMaintenanceCommand",
            hostId: "host_1",
            action: forbiddenAction as ApprovedHostMaintenanceCommand["action"],
            approvedAt: new Date().toISOString(),
          }),
        ).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
      }

      const forbiddenPolicies = [
        "disable_firewall",
        "nft flush ruleset",
        "sh -c id",
        "apply_custom_rules",
      ];
      for (const forbiddenPolicy of forbiddenPolicies) {
        const body = JSON.stringify({
          hostId: "host_1",
          policyRef: forbiddenPolicy,
        });
        const headers = signIpcRequest({
          method: "POST",
          pathWithQuery: "/v1/security",
          body,
          key: TEST_SIGNING_KEY,
        });
        const res = await sendRawSocketHttpRequest({
          socketPath,
          method: "POST",
          pathWithQuery: "/v1/security",
          headers,
          body,
        });
        expect(res.statusCode).toBe(403);
        expect((res.json.error as { code: string }).code).toBe("HOST_POLICY_DENIED");

        await expect(
          adapter.executeSecurityPolicy({
            __brand: "ApprovedHostSecurityCommand",
            hostId: "host_1",
            policyRef: forbiddenPolicy as ApprovedHostSecurityCommand["policyRef"],
            approvedAt: new Date().toISOString(),
          }),
        ).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
      }
    });

    it("rejects non-allowlisted binaries and control-character arguments in runAllowlistedBinary", async () => {
      await expect(
        runAllowlistedBinary("/bin/sh" as AllowedLinuxBinary, ["-c", "id"]),
      ).rejects.toThrow(HostPolicyDeniedError);

      await expect(
        runAllowlistedBinary("/usr/bin/uname", ["-r\nid"]),
      ).rejects.toThrow(HostPolicyDeniedError);
    });

    it("mechanically verifies zero shell invocation primitives across all apps/host-agent/src files", async () => {
      const files = (await readdir(HOST_AGENT_SRC_DIR))
        .filter((f) => f.endsWith(".ts"))
        .sort();
      expect(files.length).toBeGreaterThanOrEqual(6);

      let foundShellFalse = false;
      for (const fileName of files) {
        const source = await readFile(join(HOST_AGENT_SRC_DIR, fileName), "utf8");
        expect(source, `${fileName} must not call exec()`).not.toMatch(/\bexec\s*\(/);
        expect(source, `${fileName} must not reference execSync`).not.toMatch(/\bexecSync\b/);
        expect(source, `${fileName} must not call spawn()`).not.toMatch(/\bspawn\s*\(/);
        expect(source, `${fileName} must not reference spawnSync`).not.toMatch(/\bspawnSync\b/);
        expect(source, `${fileName} must not enable shell mode`).not.toMatch(/shell\s*:\s*true/);
        expect(source, `${fileName} must not invoke sh -c`).not.toMatch(/\bsh\s+-c\b/);
        expect(source, `${fileName} must not reference /bin/sh or /bin/bash`).not.toMatch(
          /\/bin\/(ba)?sh/,
        );

        if (source.includes("shell: false")) {
          foundShellFalse = true;
        }
      }
      expect(foundShellFalse).toBe(true);
      expect(ALLOWED_LINUX_BINARIES).toEqual([
        "/usr/sbin/nft",
        "/usr/bin/nft",
        "/usr/bin/uname",
        "/usr/bin/df",
      ]);
    });
  });

  describe("Real Linux telemetry & allowlisted maintenance actions", () => {
    it("reads real /proc/stat, /proc/meminfo, and fs.statfs telemetry on this Linux host", async () => {
      const adapter = new LinuxSystemHostAdapter({
        cpuSampleDelayMs: 15,
      });

      const telemetry = await adapter.getHostTelemetry("host_linux_live");
      expect(telemetry).not.toBeNull();
      expect(telemetry!.hostId).toBe("host_linux_live");
      expect(telemetry!.cpuUsagePercent).toBeGreaterThanOrEqual(0);
      expect(telemetry!.cpuUsagePercent).toBeLessThanOrEqual(100);
      expect(BigInt(telemetry!.memoryTotalBytes!)).toBeGreaterThan(0n);
      expect(BigInt(telemetry!.memoryUsedBytes)).toBeGreaterThanOrEqual(0n);
      expect(BigInt(telemetry!.memoryUsedBytes)).toBeLessThanOrEqual(
        BigInt(telemetry!.memoryTotalBytes!),
      );
      expect(BigInt(telemetry!.storageTotalBytes!)).toBeGreaterThan(0n);
      expect(BigInt(telemetry!.storageUsedBytes)).toBeGreaterThanOrEqual(0n);
      expect(telemetry!.uptimeSeconds).toBeGreaterThan(0);
      expect(telemetry!.kernelVersion?.length).toBeGreaterThan(0);
      expect(typeof telemetry!.dockerEngineReachable).toBe("boolean");
      expect(findForbiddenPublicDtoKeys(telemetry)).toEqual([]);
    });

    it("executes all 3 allowlisted maintenance actions against real Linux kernel/filesystem without leaking host paths", async () => {
      const dir = await createShortTempDir();
      const dataDir = join(dir, "data");
      const runtimeDir = join(dir, "runtime");
      await mkdir(dataDir, { mode: 0o750 });
      await chmod(dataDir, 0o750);
      await mkdir(runtimeDir, { mode: 0o700 });
      await chmod(runtimeDir, 0o700);

      const adapter = new LinuxSystemHostAdapter({
        storagePath: dataDir,
        runtimeDirPath: runtimeDir,
        requireProvisionedDirectories: true,
      });

      const diagRes = await adapter.executeMaintenance(
        createApprovedHostMaintenanceCommand({
          hostId: "host_linux_live",
          action: "collect_diagnostics",
        }),
      );
      expect(diagRes.status).toBe("succeeded");
      const diagJson = JSON.parse(diagRes.output!) as Record<string, unknown>;
      expect(diagJson.cgroupV2Unified).toBe(true);
      expect(typeof diagJson.kernelRelease).toBe("string");
      expect(findForbiddenPublicDtoKeys(diagJson)).toEqual([]);
      expect(diagRes.output).not.toContain(dataDir);

      const postureRes = await adapter.executeMaintenance(
        createApprovedHostMaintenanceCommand({
          hostId: "host_linux_live",
          action: "verify_storage_posture",
        }),
      );
      expect(postureRes.status).toBe("succeeded");
      const postureJson = JSON.parse(postureRes.output!) as {
        allProvisionedAndCompliant: boolean;
      };
      expect(postureJson.allProvisionedAndCompliant).toBe(true);
      expect(findForbiddenPublicDtoKeys(postureJson)).toEqual([]);
      expect(postureRes.output).not.toContain(dataDir);
      expect(postureRes.output).not.toContain(runtimeDir);

      const invRes = await adapter.executeMaintenance(
        createApprovedHostMaintenanceCommand({
          hostId: "host_linux_live",
          action: "refresh_host_inventory",
        }),
      );
      expect(invRes.status).toBe("succeeded");
      const invJson = JSON.parse(invRes.output!) as {
        logicalCpus: number;
        totalCpuMilli: number;
        totalMemoryBytes: string;
        totalStorageBytes: string;
      };
      expect(invJson.logicalCpus).toBeGreaterThanOrEqual(1);
      expect(invJson.totalCpuMilli).toBe(invJson.logicalCpus * 1000);
      expect(BigInt(invJson.totalMemoryBytes)).toBeGreaterThan(0n);
      expect(BigInt(invJson.totalStorageBytes)).toBeGreaterThan(0n);
      expect(findForbiddenPublicDtoKeys(invJson)).toEqual([]);

      // The deployed runtime dir is group-writable for the hp-ipc daemons (2770).
      await chmod(runtimeDir, 0o2770);
      const groupWritableRes = await adapter.executeMaintenance(
        createApprovedHostMaintenanceCommand({
          hostId: "host_linux_live",
          action: "verify_storage_posture",
        }),
      );
      expect(groupWritableRes.status).toBe("succeeded");

      // World-writable directory fails strict storage posture verification
      await chmod(runtimeDir, 0o777);
      const insecurePostureRes = await adapter.executeMaintenance(
        createApprovedHostMaintenanceCommand({
          hostId: "host_linux_live",
          action: "verify_storage_posture",
        }),
      );
      expect(insecurePostureRes.status).toBe("failed");
    });

    it("parses /proc/stat and /proc/meminfo edge cases deterministically", () => {
      const sample = parseProcStatCpuLine("cpu  1000 20 300 8000 100 10 5 0 0 0\ncpu0 500 10 150 4000\n");
      expect(sample).toEqual({ total: 9435n, idleAll: 8100n });
      expect(parseProcStatCpuLine("invalid content")).toBeNull();

      const mem = parseProcMeminfoBytes(
        "MemTotal:       16384000 kB\nMemFree:         2048000 kB\nMemAvailable:    8192000 kB\n",
      );
      expect(mem).toEqual({
        totalBytes: 16384000n * 1024n,
        availableBytes: 8192000n * 1024n,
        usedBytes: 8192000n * 1024n,
      });
    });
  });

  describe("Static nftables ruleset SHA-256 verification & tamper rejection", () => {
    it("pins infra/linux/nftables-dedicated.conf to DEDICATED_NFTABLES_RULESET_SHA256 and enforces 22/80/443 baseline", async () => {
      const rawBytes = await readFile(REPO_DEDICATED_NFTABLES_RULESET_PATH);
      const actualHash = createHash("sha256").update(rawBytes).digest("hex");
      expect(actualHash).toBe(DEDICATED_NFTABLES_RULESET_SHA256);

      const text = rawBytes.toString("utf8");
      expect(text).toContain('iifname "lo" accept');
      expect(text).toContain("ct state established,related accept");
      expect(text).toContain("ip protocol icmp accept");
      expect(text).toContain("ip6 nexthdr ipv6-icmp accept");
      expect(text).toContain("tcp dport { 22, 80, 443 }");
      expect(text).toContain("policy drop;");
    });

    it("baseline allows 3000 only from docker bridges", async () => {
      const text = await readFile(REPO_DEDICATED_NFTABLES_RULESET_PATH, "utf8");
      const lines = text.split("\n").filter((l) => l.includes("3000")).map((l) => l.trim());
      expect(lines).toEqual([
        'iifname "docker0" tcp dport 3000 ct state new accept',
        'iifname "br-*" tcp dport 3000 ct state new accept',
      ]);
    });

    it("rejects tampered nftables rulesets BEFORE invoking nft (both direct adapter and UDS IPC)", async () => {
      const dir = await createShortTempDir();
      const tamperedPath = join(dir, "nftables-tampered.conf");
      const original = await readFile(REPO_DEDICATED_NFTABLES_RULESET_PATH, "utf8");
      await writeFile(
        tamperedPath,
        original.replace("{ 22, 80, 443 }", "{ 22, 80, 443, 31337 }"),
        "utf8",
      );

      const invocations: Array<{ binary: string; args: readonly string[] }> = [];
      const adapter = new LinuxSystemHostAdapter({
        nftablesRulesetPath: tamperedPath,
        execFileRunner: async (binary, args) => {
          invocations.push({ binary, args });
          return { stdout: "", stderr: "" };
        },
      });

      await expect(
        adapter.executeSecurityPolicy(
          createApprovedHostSecurityCommand({
            hostId: "host_1",
            policyRef: "verify_baseline_firewall",
          }),
        ),
      ).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });

      await expect(
        adapter.executeSecurityPolicy(
          createApprovedHostSecurityCommand({
            hostId: "host_1",
            policyRef: "apply_dedicated_nftables_22_80_443",
          }),
        ),
      ).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });

      expect(invocations).toHaveLength(0);

      // Verify HTTP 403 HOST_POLICY_DENIED over UDS IPC
      const socketPath = join(dir, "tamper.sock");
      const server = new HostAgentIpcServer({
        adapter,
        keyring: TEST_KEYRING,
        transportConfig: { transport: "uds", socketPath },
      });
      activeServers.push(server);
      await server.start();

      const client = new SignedHostAgentIpcClient({
        signingKey: TEST_SIGNING_KEY,
        socketPath,
      });

      await expect(
        client.executeSecurityPolicy(
          createApprovedHostSecurityCommand({
            hostId: "host_1",
            policyRef: "apply_dedicated_nftables_22_80_443",
          }),
        ),
      ).rejects.toMatchObject({
        name: "HostAgentIpcClientError",
        code: "HOST_POLICY_DENIED",
        statusCode: 403,
      } satisfies Partial<HostAgentIpcClientError>);
    });

    it("invokes nft with static argument arrays once SHA-256 verification succeeds and handles unprivileged verify gracefully", async () => {
      const invocations: Array<{ binary: string; args: readonly string[] }> = [];
      const mockedAdapter = new LinuxSystemHostAdapter({
        nftablesRulesetPath: REPO_DEDICATED_NFTABLES_RULESET_PATH,
        execFileRunner: async (binary, args) => {
          invocations.push({ binary, args });
          return { stdout: "", stderr: "" };
        },
      });

      const verifyRes = await mockedAdapter.executeSecurityPolicy(
        createApprovedHostSecurityCommand({
          hostId: "host_1",
          policyRef: "verify_baseline_firewall",
        }),
      );
      expect(verifyRes.status).toBe("succeeded");

      const applyRes = await mockedAdapter.executeSecurityPolicy(
        createApprovedHostSecurityCommand({
          hostId: "host_1",
          policyRef: "apply_dedicated_nftables_22_80_443",
        }),
      );
      expect(applyRes.status).toBe("succeeded");

      expect(invocations).toHaveLength(2);
      expect(invocations[0]?.args).toEqual(["-c", "-f", REPO_DEDICATED_NFTABLES_RULESET_PATH]);
      expect(invocations[1]?.args).toEqual(["-f", REPO_DEDICATED_NFTABLES_RULESET_PATH]);

      // Real unprivileged host verification
      const realAdapter = new LinuxSystemHostAdapter({
        nftablesRulesetPath: REPO_DEDICATED_NFTABLES_RULESET_PATH,
      });
      const liveVerify = await realAdapter.executeSecurityPolicy(
        createApprovedHostSecurityCommand({
          hostId: "host_live",
          policyRef: "verify_baseline_firewall",
        }),
      );
      expect(liveVerify.status).toBe("succeeded");
      const liveJson = JSON.parse(liveVerify.output!) as { rulesetSha256Verified: boolean };
      expect(liveJson.rulesetSha256Verified).toBe(true);
    });
  });

  describe("AC-F2-01: Mechanical systemd unit hardening verification (HCP-SPEC-003 §5.2)", () => {
    it("verifies all 4 systemd units implement every mandatory hardening directive in HCP-SPEC-003 §5.2", async () => {
      const expectedMatrix = [
        {
          file: "hp-web.service",
          user: "hp-web",
          supplementaryGroups: undefined,
          capBoundingSet: "",
          ambientCaps: "",
          inaccessibleDockerSock: true,
        },
        {
          file: "hp-api.service",
          user: "hp-api",
          supplementaryGroups: "hp-ipc",
          capBoundingSet: "",
          ambientCaps: "",
          inaccessibleDockerSock: true,
        },
        {
          file: "hp-docker-executor.service",
          user: "hp-executor",
          supplementaryGroups: "docker hp-ipc",
          capBoundingSet: "",
          ambientCaps: "",
          inaccessibleDockerSock: false,
        },
        {
          file: "hp-host-agent.service",
          user: "hp-agent",
          supplementaryGroups: "hp-ipc",
          capBoundingSet: "CAP_NET_ADMIN CAP_DAC_READ_SEARCH",
          ambientCaps: "CAP_NET_ADMIN CAP_DAC_READ_SEARCH",
          inaccessibleDockerSock: true,
        },
      ] as const;

      for (const spec of expectedMatrix) {
        const content = await readFile(join(SYSTEMD_DIR, spec.file), "utf8");
        const map = parseSystemdServiceDirectives(content);

        expect(map.get("Service.User"), `${spec.file} User=`).toEqual([spec.user]);
        if (spec.supplementaryGroups === undefined) {
          expect(map.get("Service.SupplementaryGroups"), `${spec.file} SupplementaryGroups`).toBeUndefined();
        } else {
          expect(map.get("Service.SupplementaryGroups"), `${spec.file} SupplementaryGroups=`).toEqual([
            spec.supplementaryGroups,
          ]);
        }

        expect(map.get("Service.NoNewPrivileges"), `${spec.file} NoNewPrivileges=`).toEqual(["yes"]);
        expect(map.get("Service.CapabilityBoundingSet"), `${spec.file} CapabilityBoundingSet=`).toEqual([
          spec.capBoundingSet,
        ]);
        expect(map.get("Service.AmbientCapabilities"), `${spec.file} AmbientCapabilities=`).toEqual([
          spec.ambientCaps,
        ]);
        expect(map.get("Service.ProtectSystem"), `${spec.file} ProtectSystem=`).toEqual(["strict"]);
        expect(map.get("Service.ProtectHome"), `${spec.file} ProtectHome=`).toEqual(["yes"]);
        expect(map.get("Service.PrivateTmp"), `${spec.file} PrivateTmp=`).toEqual(["yes"]);

        if (spec.inaccessibleDockerSock) {
          const inaccessible = map.get("Service.InaccessiblePaths")?.[0] ?? "";
          expect(
            inaccessible.split(/\s+/),
            `${spec.file} InaccessiblePaths= must block /var/run/docker.sock`,
          ).toContain("/var/run/docker.sock");
          if (spec.file === "hp-web.service") {
            expect(
              inaccessible.split(/\s+/),
              "hp-web.service must also isolate /run/hosting-panel",
            ).toContain("/run/hosting-panel");
          }
        } else {
          expect(map.get("Service.InaccessiblePaths"), `${spec.file} must access docker.sock`).toBeUndefined();
        }

        expect(map.get("Service.ProtectKernelModules"), `${spec.file} ProtectKernelModules=`).toEqual(["yes"]);
        expect(map.get("Service.ProtectKernelTunables"), `${spec.file} ProtectKernelTunables=`).toEqual(["yes"]);
        expect(map.get("Service.RestrictSUIDSGID"), `${spec.file} RestrictSUIDSGID=`).toEqual(["yes"]);
        expect(map.get("Service.LockPersonality"), `${spec.file} LockPersonality=`).toEqual(["yes"]);
        expect(map.get("Service.SystemCallArchitectures"), `${spec.file} SystemCallArchitectures=`).toEqual([
          "native",
        ]);
        expect(map.get("Service.SystemCallFilter"), `${spec.file} SystemCallFilter=`).toEqual([
          "@system-service",
        ]);

        // Prevent multi-user RuntimeDirectory=hosting-panel chown clobber (F-02)
        expect(
          map.get("Service.RuntimeDirectory"),
          `${spec.file} must not clobber shared /run/hosting-panel via RuntimeDirectory=hosting-panel`,
        ).not.toEqual(["hosting-panel"]);
      }

      const tmpfilesContent = await readFile(
        join(SYSTEMD_DIR, "hosting-panel-tmpfiles.conf"),
        "utf8",
      );
      expect(tmpfilesContent).toContain("d /run/hosting-panel 2770 root hp-ipc -");
      expect(tmpfilesContent).toContain(
        "d /run/hosting-panel/secrets 0700 hp-executor hp-executor -",
      );

      const executorContent = await readFile(
        join(SYSTEMD_DIR, "hp-docker-executor.service"),
        "utf8",
      );
      expect(executorContent).toContain("/run/hosting-panel/secrets");
      expect(executorContent).toContain("HP_EXECUTOR_SOCKET_PATH=/run/hosting-panel/executor.sock");
    });
  });

  describe("Linux bootstrap script & daemon env bootstrap", () => {
    it("executes infra/linux/bootstrap-dedicated.sh --dry-run --allow-other-linux cleanly with exit code 0", async () => {
      const scriptStat = await stat(BOOTSTRAP_SCRIPT_PATH);
      expect(scriptStat.mode & 0o111).toBeGreaterThan(0);

      const { stdout, stderr } = await execFileAsync(
        BOOTSTRAP_SCRIPT_PATH,
        ["--dry-run", "--allow-other-linux"],
        {
          shell: false,
          timeout: 10_000,
        },
      );

      expect(stderr).toBe("");
      expect(stdout).toContain("Verified Linux kernel release:");
      expect(stdout).toContain("Verified cgroups v2 unified hierarchy");
      expect(stdout).toContain("ipc.key (0440 root:hp-ipc)");
      expect(stdout).toContain("secrets-master.key (0400 hp-api:root)");
      expect(stdout).toContain("Bootstrap dry-run completed successfully.");

      const osRelease = await readFile("/etc/os-release", "utf8");
      const isUbuntu2404OrDebian12 =
        (/\bID=ubuntu\b/.test(osRelease) && /\bVERSION_ID="24\.04"/.test(osRelease)) ||
        (/\bID=debian\b/.test(osRelease) && /\bVERSION_ID="12"/.test(osRelease));
      if (!isUbuntu2404OrDebian12) {
        await expect(
          execFileAsync(BOOTSTRAP_SCRIPT_PATH, ["--dry-run"], {
            shell: false,
            timeout: 10_000,
          }),
        ).rejects.toThrow();
      }
    });

    it("creates daemon from environment variables using key file and starts/stops cleanly", async () => {
      const dir = await createShortTempDir();
      const keyFile = join(dir, "ipc.key");
      const socketPath = join(dir, "daemon.sock");
      await writeFile(keyFile, TEST_HMAC_SECRET, { encoding: "utf8", mode: 0o400 });

      const daemon = await createHostAgentDaemonFromEnv({
        HP_RUNTIME_BACKEND: "local-simulator",
        HP_IPC_TRANSPORT: "uds",
        HP_HOST_AGENT_SOCKET: socketPath,
        HP_IPC_KEY_ID: "ipc-test-v1",
        HP_IPC_KEY_FILE: keyFile,
      });
      activeServers.push(daemon);

      await daemon.start();
      const client = new SignedHostAgentIpcClient({
        signingKey: TEST_SIGNING_KEY,
        socketPath,
      });
      const health = await client.checkHealth();
      expect(health.status).toBe("online");

      const inlineSocketPath = join(dir, "daemon-inline.sock");
      const inlineDaemon = await createHostAgentDaemonFromEnv({
        HP_RUNTIME_BACKEND: "local-simulator",
        HP_IPC_TRANSPORT: "uds",
        HP_HOST_AGENT_SOCKET_PATH: inlineSocketPath,
        HP_IPC_KEY_ID: "ipc-test-v1",
        HP_IPC_KEY: TEST_HMAC_SECRET,
      });
      activeServers.push(inlineDaemon);
      await inlineDaemon.start();
      const inlineClient = new SignedHostAgentIpcClient({
        signingKey: TEST_SIGNING_KEY,
        socketPath: inlineSocketPath,
      });
      expect((await inlineClient.checkHealth()).status).toBe("online");
    });
  });
});
