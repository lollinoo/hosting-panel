import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  SftpAccessApplyIpcRequestSchema,
  type IpcSigningKey,
  type IpcVerificationKey,
  type SftpAccessUser,
} from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  SFTP_CONTAINER_NAME,
  SignedDockerExecutorIpcClient,
  parseSftpPortFromEnv,
} from "../src/index.js";
import { startMockDockerDaemon, type MockDockerContainerRecord } from "./mock-docker-daemon.js";

const HASH_NO_ROUNDS =
  "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1";
const HASH_WITH_ROUNDS =
  "$6$rounds=999999999$./09AZaz12345678$./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL";
const CANARY_HASH = `$6$canarysalt012345$${"Z".repeat(86)}`;

const HMAC_SECRET = "0123456789abcdef0123456789abcdef-sftp-qa-test-key";
const SIGNING_KEY: IpcSigningKey = {
  keyId: "hmac-v1",
  algorithm: "hmac-sha256",
  secret: HMAC_SECRET,
};
const VERIFICATION_KEY: IpcVerificationKey = {
  keyId: "hmac-v1",
  algorithm: "hmac-sha256",
  secret: HMAC_SECRET,
};

const cleanupTasks: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of cleanupTasks.splice(0).reverse()) {
    await task();
  }
});

function makeUser(overrides: Partial<SftpAccessUser> = {}): SftpAccessUser {
  return {
    username: "s1a2b3c4d_web",
    passwordHash: HASH_NO_ROUNDS,
    siteId: "site_a",
    serviceInstanceId: "svc_a",
    ...overrides,
  };
}

function seedRunningSiteContainer(
  containers: Map<string, MockDockerContainerRecord>,
  id = "site0000abcdef0123456789abcdef0123456789abcdef0123456789abcdef01",
  name = "hp-site-alpha",
): MockDockerContainerRecord {
  const record: MockDockerContainerRecord = {
    id,
    name,
    image: "wordpress:7.1.4-php8.4-apache",
    env: [],
    labels: {
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": "site",
      "io.hostingpanel.site_id": "site_alpha",
      "io.hostingpanel.service_instance_id": "svc_alpha",
    },
    running: true,
    status: "running",
    restartCount: 0,
    hostConfig: {
      Privileged: false,
      CapDrop: ["ALL"],
      Binds: [],
    },
    networks: {},
  };
  containers.set(id, record);
  return record;
}

/** Asserts CP-01: no stop, restart, remove, or exec targeted a non-SFTP container. */
function assertCp01OnlySftpTouched(
  requestedPaths: readonly string[],
  execCalls: readonly { container: string; Cmd: string[] }[],
  containers: ReadonlyMap<string, MockDockerContainerRecord>,
  siteContainer: MockDockerContainerRecord,
): void {
  expect(execCalls).toEqual([]);
  expect(siteContainer.running).toBe(true);
  expect(containers.has(siteContainer.id)).toBe(true);

  for (const rawUrl of requestedPaths) {
    const parsed = new URL(rawUrl, "http://docker");
    const stripped = parsed.pathname.replace(/^\/v1\.\d+/, "");
    if (stripped === "/containers/create") {
      expect(parsed.searchParams.get("name")).toBe(SFTP_CONTAINER_NAME);
      continue;
    }
    const lifecycleMatch = /^\/containers\/([^/]+)(?:\/(stop|restart|exec))?$/.exec(stripped);
    if (lifecycleMatch && lifecycleMatch[1]) {
      const ref = decodeURIComponent(lifecycleMatch[1]);
      if (lifecycleMatch[2] || (ref !== SFTP_CONTAINER_NAME && !stripped.endsWith("/json"))) {
        expect(ref).not.toBe(siteContainer.id);
        expect(ref).not.toBe(siteContainer.name);
        const existing = containers.get(ref);
        if (existing) {
          expect(existing.name).toBe(SFTP_CONTAINER_NAME);
        }
      }
    }
  }
}

async function startDockerProxy(
  targetSocketPath: string,
  interceptor: (
    method: string,
    routePath: string,
  ) => { statusCode: number; body: string } | null,
): Promise<{ socketPath: string; close: () => Promise<void> }> {
  const proxySocket = `/tmp/hp-qa-proxy-${randomBytes(5).toString("hex")}.sock`;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const rawUrl = req.url ?? "/";
      const pathname = new URL(rawUrl, "http://docker").pathname.replace(/^\/v1\.\d+/, "");
      const method = req.method ?? "GET";
      const override = interceptor(method, pathname);
      if (override) {
        res.writeHead(override.statusCode, { "Content-Type": "application/json" });
        res.end(override.body);
        return;
      }

      const upstream = http.request(
        {
          socketPath: targetSocketPath,
          method,
          path: rawUrl,
          headers: req.headers,
        },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 500, upRes.headers);
          upRes.pipe(res);
        },
      );
      upstream.on("error", (err) => {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: err.message }));
      });
      upstream.end(Buffer.concat(chunks));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(proxySocket, () => resolve());
  });

  return {
    socketPath: proxySocket,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(proxySocket, { force: true });
    },
  };
}

describe("SFTP QA runtime suite", () => {
  async function setup(options?: {
    readonly pullBody?: string;
    readonly pullMissingImages?: boolean;
    readonly sftpPort?: number;
    readonly sftpHostIp?: string;
    readonly socketOverride?: string;
  }) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-sftp-qa-"));
    cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));

    const mockDaemon = await startMockDockerDaemon(
      options?.pullBody !== undefined ? { pullBody: options.pullBody } : undefined,
    );
    cleanupTasks.push(() => mockDaemon.close());

    const sftpStateDir = path.join(tmp, "sftp-state");
    await mkdir(sftpStateDir, { mode: 0o700 });
    await chmod(sftpStateDir, 0o700);

    const siteContainer = seedRunningSiteContainer(mockDaemon.containers);

    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: options?.socketOverride ?? mockDaemon.socketPath,
      secretsRootDir: path.join(tmp, "secrets"),
      ingressRootDir: path.join(tmp, "ingress"),
      pullMissingImages: options?.pullMissingImages ?? false,
      sftpStateDir,
      ...(options?.sftpPort !== undefined ? { sftpPort: options.sftpPort } : {}),
      ...(options?.sftpHostIp !== undefined ? { sftpHostIp: options.sftpHostIp } : {}),
    });

    const knownSftpIds = new Set<string>();
    const trackSftpContainer = () => {
      const ctr = [...mockDaemon.containers.values()].find((c) => c.name === SFTP_CONTAINER_NAME);
      if (ctr) {
        knownSftpIds.add(ctr.id);
      }
      return ctr;
    };

    return { adapter, mockDaemon, sftpStateDir, siteContainer, knownSftpIds, trackSftpContainer };
  }

  it("renders passwd, group, and shadow with attacker-proof field structure, uid/gid 33, /bin/false, chroot home, and locked root/sshd", async () => {
    const { adapter, mockDaemon, sftpStateDir, siteContainer, trackSftpContainer } =
      await setup();

    const maxSiteId64 = `s${"-_a".repeat(20)}abc`;
    expect(maxSiteId64).toHaveLength(64);

    const adversarialUsers: SftpAccessUser[] = [
      // Username min length, siteId="root" (valid identifier, tests no collision with system root)
      makeUser({
        username: "ab_c",
        passwordHash: HASH_NO_ROUNDS,
        siteId: "root",
        serviceInstanceId: "svc_root_site",
      }),
      // Username max length (15 + '_' + 16), 64-char siteId, rounds=999999999 hash
      makeUser({
        username: `${"a".repeat(15)}_${"z".repeat(16)}`,
        passwordHash: HASH_WITH_ROUNDS,
        siteId: maxSiteId64,
        serviceInstanceId: "svc_long_site_a",
      }),
      // Second user on same site as previous
      makeUser({
        username: "s1a2b3c4d_ci",
        passwordHash: CANARY_HASH,
        siteId: maxSiteId64,
        serviceInstanceId: "svc_long_site_a",
      }),
    ];

    for (const u of adversarialUsers) {
      mockDaemon.volumeLabels.set(`hp_vol_${u.serviceInstanceId}_html`, {
        "io.hostingpanel.site_id": u.siteId,
      });
    }

    const res = await adapter.applySftpAccess({ users: adversarialUsers });
    expect(res).toEqual({ applied: adversarialUsers.length });
    trackSftpContainer();

    const passwdRaw = await readFile(path.join(sftpStateDir, "users", "passwd"), "utf8");
    const groupRaw = await readFile(path.join(sftpStateDir, "users", "group"), "utf8");
    const shadowRaw = await readFile(path.join(sftpStateDir, "users", "shadow"), "utf8");

    expect(passwdRaw.endsWith("\n")).toBe(true);
    expect(groupRaw.endsWith("\n")).toBe(true);
    expect(shadowRaw.endsWith("\n")).toBe(true);

    const passwdLines = passwdRaw.slice(0, -1).split("\n");
    const groupLines = groupRaw.slice(0, -1).split("\n");
    const shadowLines = shadowRaw.slice(0, -1).split("\n");

    // Exact line counts: 2 system entries + 1 per user.
    expect(passwdLines).toHaveLength(2 + adversarialUsers.length);
    expect(shadowLines).toHaveLength(2 + adversarialUsers.length);
    expect(groupLines).toEqual(["root:x:0:", "sshd:x:22:", "hpsftp:x:33:"]);
    for (const gl of groupLines) {
      expect(gl.split(":")).toHaveLength(4);
    }

    expect(passwdLines[0]).toBe("root:x:0:0:root:/root:/bin/false");
    expect(passwdLines[1]).toBe("sshd:x:22:22:sshd:/var/empty:/bin/false");
    expect(shadowLines[0]).toBe("root:*:::::::");
    expect(shadowLines[1]).toBe("sshd:*:::::::");

    for (let i = 0; i < adversarialUsers.length; i += 1) {
      const u = adversarialUsers[i]!;
      const pFields = passwdLines[2 + i]!.split(":");
      expect(pFields).toEqual([
        u.username,
        "x",
        "33",
        "33",
        "",
        `/srv/sftp/${u.siteId}`,
        "/bin/false",
      ]);

      const sFields = shadowLines[2 + i]!.split(":");
      expect(sFields).toEqual([u.username, u.passwordHash, "", "", "", "", "", "", ""]);
    }

    // Injection payloads attempting extra lines or extra ':' fields are refused before touching files.
    const injectionAttempts: SftpAccessUser[] = [
      makeUser({ username: "s1a2b3c4d_a:0" }),
      makeUser({ username: "s1a2b3c4d_a\nbackdoor" }),
      makeUser({ passwordHash: `${HASH_NO_ROUNDS}:0:0` }),
      makeUser({ passwordHash: `${HASH_NO_ROUNDS}\nroot::0:0` }),
      makeUser({ siteId: "site_a\n/etc" }),
      makeUser({ siteId: "site_a:extra" }),
      makeUser({ siteId: "../etc" }),
      makeUser({ serviceInstanceId: "svc_a\0x" }),
    ];
    for (const badUser of injectionAttempts) {
      await expect(adapter.applySftpAccess({ users: [badUser] })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
    expect(await readFile(path.join(sftpStateDir, "users", "passwd"), "utf8")).toBe(passwdRaw);
    expect(await readFile(path.join(sftpStateDir, "users", "shadow"), "utf8")).toBe(shadowRaw);

    assertCp01OnlySftpTouched(
      mockDaemon.requestedPaths,
      mockDaemon.execCalls,
      mockDaemon.containers,
      siteContainer,
    );
  });

  it("refuses 65-char and '_'- or '-'-prefixed ids in schema and accepts 64-char siteId and serviceInstanceId through applySftpAccess", async () => {
    const { adapter, mockDaemon } = await setup();
    const maxId64 = `s${"-_a".repeat(20)}abc`;
    expect(maxId64).toHaveLength(64);
    const tooLong65 = `${maxId64}z`;
    expect(tooLong65).toHaveLength(65);

    expect(
      SftpAccessApplyIpcRequestSchema.safeParse({
        users: [makeUser({ serviceInstanceId: tooLong65 })],
      }).success,
    ).toBe(false);
    expect(
      SftpAccessApplyIpcRequestSchema.safeParse({
        users: [makeUser({ siteId: tooLong65 })],
      }).success,
    ).toBe(false);
    expect(
      SftpAccessApplyIpcRequestSchema.safeParse({
        users: [makeUser({ siteId: "_site_lead" })],
      }).success,
    ).toBe(false);
    expect(
      SftpAccessApplyIpcRequestSchema.safeParse({
        users: [makeUser({ serviceInstanceId: "-svc_lead" })],
      }).success,
    ).toBe(false);

    mockDaemon.volumeLabels.set(`hp_vol_${maxId64}_html`, {
      "io.hostingpanel.site_id": maxId64,
    });

    const result = await adapter.applySftpAccess({
      users: [makeUser({ siteId: maxId64, serviceInstanceId: maxId64 })],
    });
    expect(result).toEqual({ applied: 1 });
  });

  it("hardens container payload, binds only stateDir (:ro) and one :rw volume per site, binds only configured port, and enforces design file modes", async () => {
    const { adapter, mockDaemon, sftpStateDir, trackSftpContainer } = await setup({
      sftpPort: 22220,
      sftpHostIp: "127.0.0.1",
    });

    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });
    mockDaemon.volumeLabels.set("hp_vol_svc_b_html", { "io.hostingpanel.site_id": "site_b" });

    // Two users on site_a + one user on site_b => exactly 2 :rw site binds.
    await adapter.applySftpAccess({
      users: [
        makeUser({ username: "s1a2b3c4d_u1", siteId: "site_a", serviceInstanceId: "svc_a" }),
        makeUser({ username: "s1a2b3c4d_u2", siteId: "site_a", serviceInstanceId: "svc_a" }),
        makeUser({ username: "s9f8e7d6c_u1", siteId: "site_b", serviceInstanceId: "svc_b" }),
      ],
    });

    const ctr = trackSftpContainer();
    expect(ctr).toBeDefined();
    expect(ctr!.hostConfig.Privileged).toBe(false);
    expect(ctr!.hostConfig.CapDrop).toEqual(["ALL"]);
    expect([...(ctr!.hostConfig.CapAdd ?? [])].sort()).toEqual(["SETGID", "SETUID", "SYS_CHROOT"]);
    expect(ctr!.hostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect((ctr!.hostConfig as { ReadonlyRootfs?: boolean }).ReadonlyRootfs).toBe(true);

    const binds = ctr!.hostConfig.Binds ?? [];
    for (const bind of binds) {
      expect(bind).not.toContain("docker.sock");
    }

    const hostPathBinds = binds.filter((b) => b.startsWith("/"));
    expect(hostPathBinds).toHaveLength(4);
    for (const hb of hostPathBinds) {
      const [source, , mode] = hb.split(":");
      expect(source?.startsWith(`${sftpStateDir}/`)).toBe(true);
      expect(mode).toBe("ro");
    }

    const rwBinds = binds.filter((b) => b.endsWith(":rw"));
    expect(rwBinds).toHaveLength(2);
    expect([...rwBinds].sort()).toEqual([
      "hp_vol_svc_a_html:/srv/sftp/site_a/files:rw",
      "hp_vol_svc_b_html:/srv/sftp/site_b/files:rw",
    ]);

    expect(ctr!.hostConfig.PortBindings).toEqual({
      "2222/tcp": [{ HostIp: "127.0.0.1", HostPort: "22220" }],
    });

    // Persisted file modes per design (sftp-infra.md §4).
    expect((await stat(path.join(sftpStateDir, "state.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(sftpStateDir, "etc"))).mode & 0o777).toBe(0o755);
    expect((await stat(path.join(sftpStateDir, "etc", "sshd_config"))).mode & 0o777).toBe(0o444);
    expect((await stat(path.join(sftpStateDir, "etc", "ssh_host_ed25519_key"))).mode & 0o777).toBe(
      0o444,
    );
    expect(
      (await stat(path.join(sftpStateDir, "etc", "ssh_host_ed25519_key.pub"))).mode & 0o777,
    ).toBe(0o444);
    expect((await stat(path.join(sftpStateDir, "users", "passwd"))).mode & 0o777).toBe(0o644);
    expect((await stat(path.join(sftpStateDir, "users", "group"))).mode & 0o777).toBe(0o644);
    expect((await stat(path.join(sftpStateDir, "users", "shadow"))).mode & 0o777).toBe(0o644);
  });

  it("returns DOCKER_ENGINE_UNAVAILABLE on create, start, and pull failures and recovers on the next apply", async () => {
    // 1. Create and Start failures + recovery
    const basic = await setup();
    basic.mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });

    basic.mockDaemon.failCreates.remaining = 1;
    await expect(basic.adapter.applySftpAccess({ users: [makeUser()] })).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
    expect(basic.trackSftpContainer()).toBeUndefined();
    expect(await basic.adapter.applySftpAccess({ users: [makeUser()] })).toEqual({ applied: 1 });
    expect(basic.trackSftpContainer()?.running).toBe(true);

    // Trigger recreate so start fails once, then retry starts existing stopped container.
    basic.mockDaemon.volumeLabels.set("hp_vol_svc_b_html", { "io.hostingpanel.site_id": "site_b" });
    const twoUsers = [
      makeUser({ username: "s1a2b3c4d_a", siteId: "site_a", serviceInstanceId: "svc_a" }),
      makeUser({ username: "s9f8e7d6c_b", siteId: "site_b", serviceInstanceId: "svc_b" }),
    ];
    basic.mockDaemon.failStarts.remaining = 1;
    await expect(basic.adapter.applySftpAccess({ users: twoUsers })).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
    const stoppedAfterStartFail = basic.trackSftpContainer();
    expect(stoppedAfterStartFail?.running).toBe(false);

    expect(await basic.adapter.applySftpAccess({ users: twoUsers })).toEqual({ applied: 2 });
    const startedOnRetry = basic.trackSftpContainer();
    expect(startedOnRetry?.id).toBe(stoppedAfterStartFail?.id);
    expect(startedOnRetry?.running).toBe(true);

    assertCp01OnlySftpTouched(
      basic.mockDaemon.requestedPaths,
      basic.mockDaemon.execCalls,
      basic.mockDaemon.containers,
      basic.siteContainer,
    );

    // 2. Pull failure + recovery via proxy over mockDaemon
    const pullMock = await startMockDockerDaemon({ pullBody: '{"status":"Pulling"}\n' });
    cleanupTasks.push(() => pullMock.close());
    pullMock.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });

    let failNextPull = true;
    const proxy = await startDockerProxy(pullMock.socketPath, (method, routePath) => {
      if (method === "POST" && routePath === "/images/create" && failNextPull) {
        failNextPull = false;
        return { statusCode: 200, body: '{"error":"pull failed"}\n' };
      }
      return null;
    });
    cleanupTasks.push(() => proxy.close());

    const pullTmp = await mkdtemp(path.join(os.tmpdir(), "hp-sftp-pull-qa-"));
    cleanupTasks.push(() => rm(pullTmp, { recursive: true, force: true }));
    const pullStateDir = path.join(pullTmp, "sftp");
    await mkdir(pullStateDir, { mode: 0o700 });
    await chmod(pullStateDir, 0o700);

    const pullAdapter = new DockerEngineSocketAdapter({
      dockerSocketPath: proxy.socketPath,
      secretsRootDir: path.join(pullTmp, "secrets"),
      ingressRootDir: path.join(pullTmp, "ingress"),
      pullMissingImages: true,
      sftpStateDir: pullStateDir,
    });

    await expect(pullAdapter.applySftpAccess({ users: [makeUser()] })).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
    expect(await pullAdapter.applySftpAccess({ users: [makeUser()] })).toEqual({ applied: 1 });
    const pullCtr = [...pullMock.containers.values()].find((c) => c.name === SFTP_CONTAINER_NAME);
    expect(pullCtr?.running).toBe(true);
  });

  it("serializes concurrent applies so the last wins even after an earlier queued failure", async () => {
    const { adapter, mockDaemon, sftpStateDir, siteContainer, trackSftpContainer } =
      await setup();
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });
    mockDaemon.volumeLabels.set("hp_vol_svc_b_html", { "io.hostingpanel.site_id": "site_b" });

    const u1 = makeUser({ username: "s1a2b3c4d_one", siteId: "site_a", serviceInstanceId: "svc_a" });
    const u2 = makeUser({ username: "s1a2b3c4d_two", siteId: "site_a", serviceInstanceId: "svc_a" });
    const u3 = makeUser({
      username: "s9f8e7d6c_last",
      passwordHash: HASH_WITH_ROUNDS,
      siteId: "site_b",
      serviceInstanceId: "svc_b",
    });

    mockDaemon.failCreates.remaining = 1;
    const settled = await Promise.allSettled([
      adapter.applySftpAccess({ users: [u1] }),
      adapter.applySftpAccess({ users: [u1, u2] }),
      adapter.applySftpAccess({ users: [u3] }),
    ]);
    trackSftpContainer();

    expect(settled[0]?.status).toBe("rejected");
    expect(settled[1]?.status).toBe("fulfilled");
    expect(settled[2]?.status).toBe("fulfilled");

    const passwd = await readFile(path.join(sftpStateDir, "users", "passwd"), "utf8");
    const shadow = await readFile(path.join(sftpStateDir, "users", "shadow"), "utf8");
    expect(passwd).toContain("s9f8e7d6c_last");
    expect(passwd).not.toContain("s1a2b3c4d_one");
    expect(passwd).not.toContain("s1a2b3c4d_two");
    expect(shadow).toContain(HASH_WITH_ROUNDS);
    expect(trackSftpContainer()?.hostConfig.Binds).toContain(
      "hp_vol_svc_b_html:/srv/sftp/site_b/files:rw",
    );
    expect(trackSftpContainer()?.hostConfig.Binds).not.toContain(
      "hp_vol_svc_a_html:/srv/sftp/site_a/files:rw",
    );

    assertCp01OnlySftpTouched(
      mockDaemon.requestedPaths,
      mockDaemon.execCalls,
      mockDaemon.containers,
      siteContainer,
    );
  });

  it("recreates without the removed site when all users of one site are removed while another keeps users", async () => {
    const { adapter, mockDaemon, sftpStateDir, siteContainer, trackSftpContainer } =
      await setup();
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });
    mockDaemon.volumeLabels.set("hp_vol_svc_b_html", { "io.hostingpanel.site_id": "site_b" });

    const a1 = makeUser({ username: "s1a2b3c4d_a1", siteId: "site_a", serviceInstanceId: "svc_a" });
    const a2 = makeUser({ username: "s1a2b3c4d_a2", siteId: "site_a", serviceInstanceId: "svc_a" });
    const b1 = makeUser({ username: "s9f8e7d6c_b1", siteId: "site_b", serviceInstanceId: "svc_b" });

    await adapter.applySftpAccess({ users: [a1, a2, b1] });
    const first = trackSftpContainer();
    expect(first?.hostConfig.Binds).toContain("hp_vol_svc_a_html:/srv/sftp/site_a/files:rw");
    expect(first?.hostConfig.Binds).toContain("hp_vol_svc_b_html:/srv/sftp/site_b/files:rw");

    const res = await adapter.applySftpAccess({ users: [b1] });
    expect(res).toEqual({ applied: 1 });
    const recreated = trackSftpContainer();
    expect(recreated?.id).not.toBe(first?.id);
    expect(recreated?.running).toBe(true);
    expect(recreated?.hostConfig.Binds).not.toContain("hp_vol_svc_a_html:/srv/sftp/site_a/files:rw");
    expect(recreated?.hostConfig.Binds).toContain("hp_vol_svc_b_html:/srv/sftp/site_b/files:rw");

    const passwd = await readFile(path.join(sftpStateDir, "users", "passwd"), "utf8");
    expect(passwd).not.toContain("s1a2b3c4d_a1");
    expect(passwd).not.toContain("s1a2b3c4d_a2");
    expect(passwd).toContain("s9f8e7d6c_b1");

    assertCp01OnlySftpTouched(
      mockDaemon.requestedPaths,
      mockDaemon.execCalls,
      mockDaemon.containers,
      siteContainer,
    );
  });

  it("drops users of a volume that disappears between applies, never creates volumes, and applied counts only rendered users", async () => {
    const { adapter, mockDaemon, sftpStateDir, siteContainer, trackSftpContainer } =
      await setup();
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });
    mockDaemon.volumeLabels.set("hp_vol_svc_b_html", { "io.hostingpanel.site_id": "site_b" });

    const a1 = makeUser({ username: "s1a2b3c4d_a1", siteId: "site_a", serviceInstanceId: "svc_a" });
    const b1 = makeUser({ username: "s9f8e7d6c_b1", siteId: "site_b", serviceInstanceId: "svc_b" });
    const missing1 = makeUser({
      username: "s77777777_m1",
      siteId: "site_missing",
      serviceInstanceId: "svc_missing",
    });
    const missing2 = makeUser({
      username: "s77777777_m2",
      siteId: "site_missing",
      serviceInstanceId: "svc_missing",
    });

    // Only 2 of 4 users have an existing volume -> applied = 2.
    expect(await adapter.applySftpAccess({ users: [a1, b1, missing1, missing2] })).toEqual({
      applied: 2,
    });
    const first = trackSftpContainer();
    expect(mockDaemon.createdVolumes).toEqual([]);

    // Volume for site_a disappears between applies while site_b remains.
    mockDaemon.volumeLabels.delete("hp_vol_svc_a_html");
    expect(await adapter.applySftpAccess({ users: [a1, b1] })).toEqual({ applied: 1 });
    expect(mockDaemon.createdVolumes).toEqual([]);

    const second = trackSftpContainer();
    expect(second?.id).not.toBe(first?.id);
    expect(second?.hostConfig.Binds).not.toContain("hp_vol_svc_a_html:/srv/sftp/site_a/files:rw");
    expect(second?.hostConfig.Binds).toContain("hp_vol_svc_b_html:/srv/sftp/site_b/files:rw");

    const passwd = await readFile(path.join(sftpStateDir, "users", "passwd"), "utf8");
    const shadow = await readFile(path.join(sftpStateDir, "users", "shadow"), "utf8");
    expect(passwd).not.toContain("s1a2b3c4d_a1");
    expect(shadow).not.toContain("s1a2b3c4d_a1");
    expect(passwd).toContain("s9f8e7d6c_b1");

    assertCp01OnlySftpTouched(
      mockDaemon.requestedPaths,
      mockDaemon.execCalls,
      mockDaemon.containers,
      siteContainer,
    );
  });

  it("startup ensure with no state makes zero Docker calls, and with unchanged state creates or removes nothing", async () => {
    const { adapter, mockDaemon, siteContainer, trackSftpContainer } = await setup();
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });

    // 1. No state.json -> zero Docker Engine requests.
    expect(await adapter.ensureSftpFromState()).toBeNull();
    expect(mockDaemon.requestedPaths).toEqual([]);

    // 2. Apply and then run startup ensure with unchanged configuration.
    await adapter.applySftpAccess({ users: [makeUser()] });
    const ctr = trackSftpContainer();
    expect(ctr?.running).toBe(true);

    const mark = mockDaemon.requestedPaths.length;
    expect(await adapter.ensureSftpFromState()).toEqual({ applied: 1 });
    const ensurePaths = mockDaemon.requestedPaths.slice(mark);

    expect(
      ensurePaths.some(
        (p) =>
          p.includes("/containers/create") ||
          p.includes("/networks/create") ||
          p.includes("/volumes/create") ||
          p.includes("/images/create") ||
          /\/containers\/[^/]+\/(stop|start|restart)/.test(p),
      ),
    ).toBe(false);
    expect(
      ensurePaths.some((p) => p.includes(`/containers/${ctr!.id}`)),
    ).toBe(false);
    expect(trackSftpContainer()?.id).toBe(ctr?.id);

    assertCp01OnlySftpTouched(
      mockDaemon.requestedPaths,
      mockDaemon.execCalls,
      mockDaemon.containers,
      siteContainer,
    );
  });

  it("never leaks password hashes, stateDir path, or container IDs in error messages or console output", async () => {
    const capturedConsole: string[] = [];
    const grab = (...args: unknown[]) => {
      capturedConsole.push(args.map((a) => String(a)).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(grab);
    vi.spyOn(console, "info").mockImplementation(grab);
    vi.spyOn(console, "warn").mockImplementation(grab);
    vi.spyOn(console, "error").mockImplementation(grab);

    const { adapter, mockDaemon, sftpStateDir, siteContainer, trackSftpContainer } =
      await setup();
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });

    const observedSftpIds = new Set<string>();
    const errors: Error[] = [];
    const recordErr = (err: unknown) => {
      if (err instanceof Error) {
        errors.push(err);
      }
    };

    // Successful apply to create container ID and write host key + state.
    await adapter.applySftpAccess({
      users: [makeUser({ passwordHash: CANARY_HASH })],
    });
    const ctr = trackSftpContainer();
    expect(ctr).toBeDefined();
    if (ctr) {
      observedSftpIds.add(ctr.id);
    }

    // 1. Create failure
    mockDaemon.volumeLabels.set("hp_vol_svc_b_html", { "io.hostingpanel.site_id": "site_b" });
    mockDaemon.failCreates.remaining = 1;
    await adapter
      .applySftpAccess({
        users: [
          makeUser({ passwordHash: CANARY_HASH }),
          makeUser({
            username: "s9f8e7d6c_b",
            passwordHash: HASH_WITH_ROUNDS,
            siteId: "site_b",
            serviceInstanceId: "svc_b",
          }),
        ],
      })
      .catch(recordErr);

    // 2. Start failure (container was removed on recreate above, so create succeeds again then start fails)
    mockDaemon.failStarts.remaining = 1;
    await adapter
      .applySftpAccess({
        users: [makeUser({ passwordHash: CANARY_HASH })],
      })
      .catch(recordErr);
    const secondCtr = trackSftpContainer();
    if (secondCtr) {
      observedSftpIds.add(secondCtr.id);
    }

    // 3. Invalid user payload (adapter + signed IPC server)
    await adapter
      .applySftpAccess({
        users: [makeUser({ username: "BAD_USER", passwordHash: CANARY_HASH })],
      })
      .catch(recordErr);

    const ipcSock = path.join(os.tmpdir(), `hp-sftp-qa-ipc-${randomBytes(5).toString("hex")}.sock`);
    const server = new DockerExecutorIpcServer({
      executor: adapter,
      keyring: { "hmac-v1": VERIFICATION_KEY },
      transport: "uds",
      socketPath: ipcSock,
      runtimeBackend: "linux-systemd",
    });
    cleanupTasks.push(() => server.stop());
    await server.start();
    const client = new SignedDockerExecutorIpcClient({
      signingKey: SIGNING_KEY,
      transport: "uds",
      socketPath: ipcSock,
    });
    await client
      .applySftpAccess({
        users: [makeUser({ passwordHash: `$1$bad$${CANARY_HASH}` })],
      })
      .catch(recordErr);

    // 4. Missing stateDir
    const missingDir = path.join(sftpStateDir, "missing-subdir");
    const missingAdapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      sftpStateDir: missingDir,
    });
    await missingAdapter.applySftpAccess({ users: [makeUser({ passwordHash: CANARY_HASH })] }).catch(recordErr);

    expect(errors.length).toBeGreaterThanOrEqual(5);

    const sensitiveTokens = [
      CANARY_HASH,
      HASH_WITH_ROUNDS,
      "$6$",
      sftpStateDir,
      missingDir,
      siteContainer.id,
      ...observedSftpIds,
    ];
    for (const err of errors) {
      for (const secret of sensitiveTokens) {
        expect(err.message).not.toContain(secret);
      }
    }
    const allConsole = capturedConsole.join("\n");
    for (const secret of sensitiveTokens) {
      expect(allConsole).not.toContain(secret);
    }
  });

  it("refuses HP_SFTP_PORT values 22, 80, 443, 0, 65536, and abc in main.ts parseSftpPortFromEnv", () => {
    for (const badPort of ["22", "80", "443", "0", "65536", "abc"]) {
      expect(
        () => parseSftpPortFromEnv({ HP_SFTP_PORT: badPort }),
        `expected HP_SFTP_PORT=${badPort} to throw`,
      ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    }

    expect(parseSftpPortFromEnv({})).toBeUndefined();
    expect(parseSftpPortFromEnv({ HP_SFTP_PORT: "   " })).toBeUndefined();
    expect(parseSftpPortFromEnv({ HP_SFTP_PORT: "1" })).toBe(1);
    expect(parseSftpPortFromEnv({ HP_SFTP_PORT: "2222" })).toBe(2222);
    expect(parseSftpPortFromEnv({ HP_SFTP_PORT: "65535" })).toBe(65535);
  });
});
