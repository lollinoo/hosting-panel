import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_SFTP_PORT,
  SFTP_IMAGE,
  type IpcSigningKey,
  type IpcVerificationKey,
  type SftpAccessUser,
} from "@hosting-panel/contracts";
import {
  Phase1DisabledDockerExecutor,
  createApprovedServiceSpec,
} from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  InMemoryDockerSimulatorAdapter,
  SFTP_CONTAINER_NAME,
  SFTP_NETWORK_NAME,
  SHARED_DB_CONFIG_SHA256_LABEL,
  SignedDockerExecutorIpcClient,
  bootstrapDockerExecutorDaemon,
  parseSftpPortFromEnv,
  sshFingerprint,
} from "../src/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const cleanupTasks: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of cleanupTasks.splice(0).reverse()) {
    await task();
  }
});

const HASH_1 =
  "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1";
const HASH_2 =
  "$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.";

const HMAC_SECRET = "0123456789abcdef0123456789abcdef-sftp-adapter-key";
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

function makeUser(over: Partial<SftpAccessUser> = {}): SftpAccessUser {
  return {
    username: "s1a2b3c4d_web",
    passwordHash: HASH_1,
    siteId: "site_a",
    serviceInstanceId: "svc_a",
    ...over,
  };
}

describe("DockerEngineSocketAdapter SFTP runtime", () => {
  async function setup(options?: {
    readonly createStateDir?: boolean;
    readonly executorUid?: number;
    readonly pullBody?: string;
    readonly pullMissingImages?: boolean;
    readonly sftpPort?: number;
    readonly sftpHostIp?: string;
    readonly sftpContainerName?: string;
    readonly sftpNetworkName?: string;
    readonly sftpVolumePrefix?: string;
    readonly onRequest?: (method: string, routePath: string) => void;
  }) {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-sftp-adapter-"));
    cleanupTasks.push(() => rm(tmp, { recursive: true, force: true }));
    const mockDaemon = await startMockDockerDaemon({
      ...(options?.pullBody !== undefined ? { pullBody: options.pullBody } : {}),
      ...(options?.onRequest ? { onRequest: options.onRequest } : {}),
    });
    cleanupTasks.push(() => mockDaemon.close());
    const sftpStateDir = path.join(tmp, "sftp");
    if (options?.createStateDir !== false) {
      await mkdir(sftpStateDir, { mode: 0o700 });
      await chmod(sftpStateDir, 0o700);
    }

    const containerName = options?.sftpContainerName ?? SFTP_CONTAINER_NAME;
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmp, "secrets"),
      ingressRootDir: path.join(tmp, "ingress"),
      pullMissingImages: options?.pullMissingImages ?? false,
      sftpStateDir,
      ...(options?.executorUid !== undefined ? { executorUid: options.executorUid } : {}),
      ...(options?.sftpPort !== undefined ? { sftpPort: options.sftpPort } : {}),
      ...(options?.sftpHostIp !== undefined ? { sftpHostIp: options.sftpHostIp } : {}),
      ...(options?.sftpContainerName !== undefined
        ? { sftpContainerName: options.sftpContainerName }
        : {}),
      ...(options?.sftpNetworkName !== undefined
        ? { sftpNetworkName: options.sftpNetworkName }
        : {}),
      ...(options?.sftpVolumePrefix !== undefined
        ? { sftpVolumePrefix: options.sftpVolumePrefix }
        : {}),
    });

    const sftpCtr = () =>
      [...mockDaemon.containers.values()].find((c) => c.name === containerName);

    const count = (from: number, re: RegExp) =>
      mockDaemon.requestedPaths.slice(from).filter((p) => re.test(p)).length;

    return { adapter, mockDaemon, sftpStateDir, sftpCtr, count, tmp };
  }

  it("creates network and container on first apply, keeps container when adding a user on same site, recreates on site changes, and removes on empty list", async () => {
    const { adapter, mockDaemon, sftpStateDir, sftpCtr, count } = await setup();
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });
    mockDaemon.volumeLabels.set("hp_vol_svc_b_html", { "io.hostingpanel.site_id": "site_b" });

    expect(await adapter.getSftpStatus()).toEqual({
      running: false,
      port: DEFAULT_SFTP_PORT,
      hostKeyFingerprint: null,
    });

    const u1 = makeUser({ username: "s1a2b3c4d_web", siteId: "site_a", serviceInstanceId: "svc_a" });
    expect(await adapter.applySftpAccess({ users: [u1] })).toEqual({ applied: 1 });

    const first = sftpCtr();
    expect(first?.running).toBe(true);
    expect(first?.image).toBe(SFTP_IMAGE);
    expect(first?.entrypoint).toEqual(["/usr/sbin/sshd.pam"]);
    expect(first?.cmd).toEqual(["-D", "-e", "-f", "/etc/hp-sftp/sshd_config"]);
    expect(first?.hostConfig.NetworkMode).toBe(SFTP_NETWORK_NAME);
    expect(first?.hostConfig.Binds).toContain("hp_vol_svc_a_html:/srv/sftp/site_a/files:rw");
    expect(mockDaemon.createdNetworks).toContainEqual(
      expect.objectContaining({ Name: SFTP_NETWORK_NAME, Internal: false }),
    );
    expect(mockDaemon.execCalls).toEqual([]);

    const pubLine = await readFile(
      path.join(sftpStateDir, "etc", "ssh_host_ed25519_key.pub"),
      "utf8",
    );
    const expectedFp = sshFingerprint(pubLine);
    expect(await adapter.getSftpStatus()).toEqual({
      running: true,
      port: DEFAULT_SFTP_PORT,
      hostKeyFingerprint: expectedFp,
    });
    expect(mockDaemon.execCalls).toEqual([]);

    // Adding a second user to the same already-mounted site appends in place without stopping/starting/creating.
    const passwdPath = path.join(sftpStateDir, "users", "passwd");
    const groupPath = path.join(sftpStateDir, "users", "group");
    const shadowPath = path.join(sftpStateDir, "users", "shadow");
    const passwdBefore = await readFile(passwdPath);
    const groupBefore = await readFile(groupPath);
    const shadowBefore = await readFile(shadowPath);
    const passwdInoBefore = (await lstat(passwdPath)).ino;
    const groupInoBefore = (await lstat(groupPath)).ino;
    const shadowInoBefore = (await lstat(shadowPath)).ino;
    const mark1 = mockDaemon.requestedPaths.length;
    const u2 = makeUser({
      username: "s1a2b3c4d_ci",
      passwordHash: HASH_2,
      siteId: "site_a",
      serviceInstanceId: "svc_a",
    });
    expect(await adapter.applySftpAccess({ users: [u1, u2] })).toEqual({ applied: 2 });
    expect(sftpCtr()?.id).toBe(first?.id);
    expect(count(mark1, /\/containers\/create|\/stop|\/start|\/restart|\?force=/)).toBe(0);
    const passwdAfter = await readFile(passwdPath);
    const groupAfter = await readFile(groupPath);
    const shadowAfter = await readFile(shadowPath);
    expect((await lstat(passwdPath)).ino).toBe(passwdInoBefore);
    expect((await lstat(groupPath)).ino).toBe(groupInoBefore);
    expect((await lstat(shadowPath)).ino).toBe(shadowInoBefore);
    expect(passwdAfter.subarray(0, passwdBefore.length).equals(passwdBefore)).toBe(true);
    expect(groupAfter.equals(groupBefore)).toBe(true);
    expect(shadowAfter.subarray(0, shadowBefore.length).equals(shadowBefore)).toBe(true);
    expect(passwdAfter.subarray(passwdBefore.length).toString("utf8")).toBe(
      `${u2.username}:x:33:33::/srv/sftp/${u2.siteId}:/bin/false\n`,
    );
    expect(shadowAfter.subarray(shadowBefore.length).toString("utf8")).toBe(
      `${u2.username}:${u2.passwordHash}:::::::\n`,
    );

    // Adding a user for a new site recreates the container with both site binds.
    const mark2 = mockDaemon.requestedPaths.length;
    const u3 = makeUser({
      username: "s9f8e7d6c_web",
      siteId: "site_b",
      serviceInstanceId: "svc_b",
    });
    expect(await adapter.applySftpAccess({ users: [u1, u2, u3] })).toEqual({ applied: 3 });
    expect(count(mark2, /\/containers\/create/)).toBe(1);
    const second = sftpCtr();
    expect(second?.id).not.toBe(first?.id);
    expect(second?.running).toBe(true);
    expect(second?.hostConfig.Binds).toContain("hp_vol_svc_a_html:/srv/sftp/site_a/files:rw");
    expect(second?.hostConfig.Binds).toContain("hp_vol_svc_b_html:/srv/sftp/site_b/files:rw");

    // Removing the second site recreates without its bind.
    expect(await adapter.applySftpAccess({ users: [u1] })).toEqual({ applied: 1 });
    const third = sftpCtr();
    expect(third?.id).not.toBe(second?.id);
    expect(third?.hostConfig.Binds).toContain("hp_vol_svc_a_html:/srv/sftp/site_a/files:rw");
    expect(third?.hostConfig.Binds).not.toContain("hp_vol_svc_b_html:/srv/sftp/site_b/files:rw");

    // Empty list removes the container and keeps the host key.
    expect(await adapter.applySftpAccess({ users: [] })).toEqual({ applied: 0 });
    expect(sftpCtr()).toBeUndefined();
    await expect(stat(path.join(sftpStateDir, "etc", "ssh_host_ed25519_key"))).resolves.toBeDefined();
    expect(await adapter.getSftpStatus()).toEqual({
      running: false,
      port: DEFAULT_SFTP_PORT,
      hostKeyFingerprint: expectedFp,
    });
    expect(mockDaemon.execCalls).toEqual([]);
  });

  it("skips users whose site volume is missing, never creates volumes, and counts only rendered users", async () => {
    const { adapter, mockDaemon, sftpStateDir, sftpCtr } = await setup();
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });

    const present = makeUser({ username: "s1a2b3c4d_ok", siteId: "site_a", serviceInstanceId: "svc_a" });
    const missing = makeUser({
      username: "s9f8e7d6c_missing",
      siteId: "site_missing",
      serviceInstanceId: "svc_missing",
    });

    expect(await adapter.applySftpAccess({ users: [present, missing] })).toEqual({ applied: 1 });
    expect(mockDaemon.createdVolumes).toEqual([]);
    expect(sftpCtr()?.hostConfig.Binds).toContain("hp_vol_svc_a_html:/srv/sftp/site_a/files:rw");
    expect(sftpCtr()?.hostConfig.Binds).not.toContain(
      "hp_vol_svc_missing_html:/srv/sftp/site_missing/files:rw",
    );
    const passwd = await readFile(path.join(sftpStateDir, "users", "passwd"), "utf8");
    expect(passwd).toContain("s1a2b3c4d_ok");
    expect(passwd).not.toContain("s9f8e7d6c_missing");

    // Volume disappearing drops its users and removes the container when none remain.
    mockDaemon.volumeLabels.delete("hp_vol_svc_a_html");
    expect(await adapter.applySftpAccess({ users: [present] })).toEqual({ applied: 0 });
    expect(mockDaemon.createdVolumes).toEqual([]);
    expect(sftpCtr()).toBeUndefined();
  });

  it("pulls SFTP_IMAGE only when missing and prewarmSiteImages includes SFTP_IMAGE", async () => {
    const { adapter, mockDaemon, count } = await setup({
      pullBody: '{"status":"Pulling"}\n',
      pullMissingImages: true,
    });
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });

    await adapter.applySftpAccess({ users: [makeUser()] });
    expect(count(0, /\/images\/create/)).toBe(1);

    const mark = mockDaemon.requestedPaths.length;
    await adapter.applySftpAccess({
      users: [makeUser({ username: "s1a2b3c4d_second" })],
    });
    expect(count(mark, /\/images\/create/)).toBe(0);

    // prewarmSiteImages pulls SFTP_IMAGE as well.
    const prewarm = await setup({
      pullBody: '{"status":"Pulling"}\n',
      pullMissingImages: true,
    });
    await prewarm.adapter.prewarmSiteImages();
    expect(
      prewarm.mockDaemon.requestedPaths.some(
        (p) => p.includes("/images/create") && p.includes(encodeURIComponent(SFTP_IMAGE)),
      ),
    ).toBe(true);
  });

  it("supports custom container, network, port, hostIp and volume prefix overrides", async () => {
    const { adapter, mockDaemon, sftpCtr } = await setup({
      sftpPort: 22223,
      sftpHostIp: "127.0.0.1",
      sftpContainerName: "hp_swarmtest_sftp",
      sftpNetworkName: "hp_swarmtest_net",
      sftpVolumePrefix: "hp_swarmtest_vol_",
    });
    mockDaemon.volumeLabels.set("hp_swarmtest_vol_svc_x_html", {
      "io.hostingpanel.site_id": "site_x",
    });

    await adapter.applySftpAccess({
      users: [makeUser({ siteId: "site_x", serviceInstanceId: "svc_x" })],
    });
    const ctr = sftpCtr();
    expect(ctr?.name).toBe("hp_swarmtest_sftp");
    expect(ctr?.hostConfig.NetworkMode).toBe("hp_swarmtest_net");
    expect(ctr?.hostConfig.PortBindings).toEqual({
      "2222/tcp": [{ HostIp: "127.0.0.1", HostPort: "22223" }],
    });
    expect(ctr?.hostConfig.Binds).toContain(
      "hp_swarmtest_vol_svc_x_html:/srv/sftp/site_x/files:rw",
    );
    expect(await adapter.getSftpStatus()).toMatchObject({
      running: true,
      port: 22223,
    });
  });

  it("refuses missing or foreign-owned sftpStateDir with HOST_POLICY_DENIED before touching Docker", async () => {
    const missing = await setup({ createStateDir: false });
    await expect(missing.adapter.applySftpAccess({ users: [makeUser()] })).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    expect(missing.mockDaemon.requestedPaths).toEqual([]);

    const foreign = await setup({ executorUid: (process.getuid?.() ?? 1000) + 1 });
    await expect(foreign.adapter.applySftpAccess({ users: [makeUser()] })).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    expect(foreign.mockDaemon.requestedPaths).toEqual([]);

    const wide = await setup();
    await chmod(wide.sftpStateDir, 0o755);
    await expect(wide.adapter.applySftpAccess({ users: [makeUser()] })).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    expect(wide.mockDaemon.requestedPaths).toEqual([]);
  });

  it("stops before changing user files and starts after on hash change or removal, starts stopped container, and sends no mutating request on identical retry", async () => {
    const reqLog: Array<{
      readonly method: string;
      readonly routePath: string;
      readonly shadow: string | null;
      readonly passwd: string | null;
      readonly group: string | null;
    }> = [];
    let trackedDir = "";
    const readSafe = (rel: string): string | null => {
      try {
        return readFileSync(path.join(trackedDir, rel), "utf8");
      } catch {
        return null;
      }
    };

    const { adapter, mockDaemon, sftpStateDir, sftpCtr } = await setup({
      onRequest: (method, routePath) => {
        reqLog.push({
          method,
          routePath,
          shadow: trackedDir ? readSafe("users/shadow") : null,
          passwd: trackedDir ? readSafe("users/passwd") : null,
          group: trackedDir ? readSafe("users/group") : null,
        });
      },
    });
    trackedDir = sftpStateDir;
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });
    mockDaemon.volumeLabels.set("hp_vol_svc_b_html", { "io.hostingpanel.site_id": "site_b" });

    const u1 = makeUser({ username: "s1a2b3c4d_one", passwordHash: HASH_1 });
    const u2 = makeUser({ username: "s1a2b3c4d_two", passwordHash: HASH_2 });
    await adapter.applySftpAccess({ users: [u1, u2] });

    const ctrId = sftpCtr()?.id;
    expect(ctrId).toBeTruthy();
    const shadowPath = path.join(sftpStateDir, "users", "shadow");
    const passwdPath = path.join(sftpStateDir, "users", "passwd");
    const groupPath = path.join(sftpStateDir, "users", "group");
    const shadowIno = (await lstat(shadowPath)).ino;
    const passwdIno = (await lstat(passwdPath)).ino;

    // (b) Same users with a new password hash: stop arrives BEFORE shadow changes, start arrives AFTER.
    const shadowBeforeHashChange = await readFile(shadowPath, "utf8");
    reqLog.length = 0;
    await adapter.applySftpAccess({ users: [{ ...u1, passwordHash: HASH_2 }, u2] });

    const hashLifecycle = reqLog.filter((r) => r.method !== "GET");
    expect(hashLifecycle.map((r) => `${r.method} ${r.routePath}`)).toEqual([
      `POST /containers/${String(ctrId)}/stop`,
      `POST /containers/${String(ctrId)}/start`,
    ]);
    expect(hashLifecycle[0]?.shadow).toBe(shadowBeforeHashChange);
    expect(hashLifecycle[0]?.shadow).toContain(`${u1.username}:${HASH_1}:`);
    expect(hashLifecycle[1]?.shadow).toContain(`${u1.username}:${HASH_2}:`);
    expect(hashLifecycle[1]?.shadow).not.toContain(`${u1.username}:${HASH_1}:`);
    expect((await lstat(shadowPath)).ino).toBe(shadowIno);
    expect(sftpCtr()?.id).toBe(ctrId);
    expect(sftpCtr()?.running).toBe(true);

    // (c) Removing u1 while u2 (same site) stays: stop arrives BEFORE shadow/passwd change, start AFTER; u1 is gone.
    const shadowBeforeRemoval = await readFile(shadowPath, "utf8");
    const passwdBeforeRemoval = await readFile(passwdPath, "utf8");
    reqLog.length = 0;
    await adapter.applySftpAccess({ users: [u2] });

    const removeLifecycle = reqLog.filter((r) => r.method !== "GET");
    expect(removeLifecycle.map((r) => `${r.method} ${r.routePath}`)).toEqual([
      `POST /containers/${String(ctrId)}/stop`,
      `POST /containers/${String(ctrId)}/start`,
    ]);
    expect(removeLifecycle[0]?.shadow).toBe(shadowBeforeRemoval);
    expect(removeLifecycle[0]?.passwd).toBe(passwdBeforeRemoval);
    expect(removeLifecycle[1]?.shadow).not.toContain(u1.username);
    expect(removeLifecycle[1]?.shadow).toContain(u2.username);
    expect(removeLifecycle[1]?.passwd).not.toContain(u1.username);
    expect(removeLifecycle[1]?.passwd).toContain(u2.username);
    expect((await lstat(passwdPath)).ino).toBe(passwdIno);
    expect(sftpCtr()?.running).toBe(true);

    // (d) A container found stopped is started.
    const currentCtr = sftpCtr()!;
    currentCtr.running = false;
    currentCtr.status = "exited";
    reqLog.length = 0;
    await adapter.applySftpAccess({ users: [u2] });
    expect(reqLog.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.routePath}`)).toEqual([
      `POST /containers/${String(ctrId)}/start`,
    ]);
    expect(sftpCtr()?.running).toBe(true);

    // (e) Repeating the exact same request sends zero mutating Docker requests and does not touch files.
    const oldTime = new Date(1_700_000_000_000);
    const sshdConfigPath = path.join(sftpStateDir, "etc", "sshd_config");
    const stateJsonPath = path.join(sftpStateDir, "state.json");
    for (const p of [passwdPath, groupPath, shadowPath, sshdConfigPath, stateJsonPath]) {
      await utimes(p, oldTime, oldTime);
    }
    reqLog.length = 0;
    await adapter.applySftpAccess({ users: [u2] });
    expect(reqLog.filter((r) => r.method !== "GET")).toEqual([]);
    for (const p of [passwdPath, groupPath, shadowPath, sshdConfigPath, stateJsonPath]) {
      expect((await stat(p)).mtimeMs).toBe(oldTime.getTime());
    }

    // (f) Removing a site while another stays (recreate): OLD files at stop/DELETE, NEW files at create/start.
    const uB = makeUser({
      username: "s9f8e7d6c_b",
      passwordHash: HASH_1,
      siteId: "site_b",
      serviceInstanceId: "svc_b",
    });
    await adapter.applySftpAccess({ users: [u2, uB] });
    const twoSiteCtrId = sftpCtr()?.id;
    expect(twoSiteCtrId).toBeTruthy();

    const shadowBeforeSiteRemoval = await readFile(shadowPath, "utf8");
    const passwdBeforeSiteRemoval = await readFile(passwdPath, "utf8");
    const groupBeforeSiteRemoval = await readFile(groupPath, "utf8");
    reqLog.length = 0;
    await adapter.applySftpAccess({ users: [u2] });

    const afterSiteRemoveCtrId = sftpCtr()?.id;
    expect(afterSiteRemoveCtrId).toBeTruthy();
    expect(afterSiteRemoveCtrId).not.toBe(twoSiteCtrId);
    const siteRemoveLifecycle = reqLog.filter((r) => r.method !== "GET");
    expect(siteRemoveLifecycle.map((r) => `${r.method} ${r.routePath}`)).toEqual([
      `POST /containers/${String(twoSiteCtrId)}/stop`,
      `DELETE /containers/${String(twoSiteCtrId)}`,
      "POST /containers/create",
      `POST /containers/${String(afterSiteRemoveCtrId)}/start`,
    ]);
    expect(siteRemoveLifecycle[0]?.shadow).toBe(shadowBeforeSiteRemoval);
    expect(siteRemoveLifecycle[0]?.passwd).toBe(passwdBeforeSiteRemoval);
    expect(siteRemoveLifecycle[0]?.group).toBe(groupBeforeSiteRemoval);
    expect(siteRemoveLifecycle[1]?.shadow).toBe(shadowBeforeSiteRemoval);
    expect(siteRemoveLifecycle[1]?.passwd).toBe(passwdBeforeSiteRemoval);
    expect(siteRemoveLifecycle[1]?.group).toBe(groupBeforeSiteRemoval);

    const shadowAfterSiteRemoval = await readFile(shadowPath, "utf8");
    const passwdAfterSiteRemoval = await readFile(passwdPath, "utf8");
    const groupAfterSiteRemoval = await readFile(groupPath, "utf8");
    expect(shadowAfterSiteRemoval).toContain(u2.username);
    expect(shadowAfterSiteRemoval).not.toContain(uB.username);
    expect(passwdAfterSiteRemoval).toContain(u2.username);
    expect(passwdAfterSiteRemoval).not.toContain(uB.username);
    expect(siteRemoveLifecycle[2]?.shadow).toBe(shadowAfterSiteRemoval);
    expect(siteRemoveLifecycle[2]?.passwd).toBe(passwdAfterSiteRemoval);
    expect(siteRemoveLifecycle[2]?.group).toBe(groupAfterSiteRemoval);

    // (g) Removing every user: OLD files still on disk when stop and DELETE arrive; files cleared after.
    const shadowBeforeEmpty = await readFile(shadowPath, "utf8");
    const passwdBeforeEmpty = await readFile(passwdPath, "utf8");
    const groupBeforeEmpty = await readFile(groupPath, "utf8");
    reqLog.length = 0;
    await adapter.applySftpAccess({ users: [] });

    const emptyLifecycle = reqLog.filter((r) => r.method !== "GET");
    expect(emptyLifecycle.map((r) => `${r.method} ${r.routePath}`)).toEqual([
      `POST /containers/${String(afterSiteRemoveCtrId)}/stop`,
      `DELETE /containers/${String(afterSiteRemoveCtrId)}`,
    ]);
    expect(emptyLifecycle[0]?.shadow).toBe(shadowBeforeEmpty);
    expect(emptyLifecycle[0]?.passwd).toBe(passwdBeforeEmpty);
    expect(emptyLifecycle[0]?.group).toBe(groupBeforeEmpty);
    expect(emptyLifecycle[1]?.shadow).toBe(shadowBeforeEmpty);
    expect(emptyLifecycle[1]?.passwd).toBe(passwdBeforeEmpty);
    expect(emptyLifecycle[1]?.group).toBe(groupBeforeEmpty);
    expect(sftpCtr()).toBeUndefined();
    expect(await readFile(passwdPath, "utf8")).not.toContain(u2.username);
    expect(await readFile(shadowPath, "utf8")).not.toContain(u2.username);
  });

  it("repairs a garbage .pub file from the existing private key during a password change without changing the fingerprint", async () => {
    const { adapter, mockDaemon, sftpStateDir, sftpCtr } = await setup();
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });

    const u1 = makeUser({ username: "s1a2b3c4d_one", passwordHash: HASH_1 });
    await adapter.applySftpAccess({ users: [u1] });

    const keyPath = path.join(sftpStateDir, "etc", "ssh_host_ed25519_key");
    const pubPath = path.join(sftpStateDir, "etc", "ssh_host_ed25519_key.pub");
    const keyBefore = await readFile(keyPath);
    const pubBefore = await readFile(pubPath, "utf8");
    const expectedFp = sshFingerprint(pubBefore);

    await chmod(pubPath, 0o644);
    await writeFile(pubPath, "garbage", "utf8");
    await chmod(pubPath, 0o444);

    expect(await adapter.applySftpAccess({ users: [{ ...u1, passwordHash: HASH_2 }] })).toEqual({
      applied: 1,
    });

    expect(await readFile(keyPath)).toEqual(keyBefore);
    expect(await readFile(pubPath, "utf8")).toBe(pubBefore);
    expect((await stat(pubPath)).mode & 0o777).toBe(0o444);
    expect(sftpCtr()?.running).toBe(true);
    expect(await adapter.getSftpStatus()).toMatchObject({
      running: true,
      hostKeyFingerprint: expectedFp,
    });
  });

  it("refuses a password change before stopping, removing or creating the container when the private host key is corrupt", async () => {
    const reqLog: Array<{ readonly method: string; readonly routePath: string }> = [];
    const { adapter, mockDaemon, sftpStateDir, sftpCtr } = await setup({
      onRequest: (method, routePath) => {
        reqLog.push({ method, routePath });
      },
    });
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });

    const u1 = makeUser({ username: "s1a2b3c4d_one", passwordHash: HASH_1 });
    await adapter.applySftpAccess({ users: [u1] });
    const ctrId = sftpCtr()?.id;

    const passwdBefore = await readFile(path.join(sftpStateDir, "users", "passwd"));
    const shadowBefore = await readFile(path.join(sftpStateDir, "users", "shadow"));
    const groupBefore = await readFile(path.join(sftpStateDir, "users", "group"));
    const stateBefore = await readFile(path.join(sftpStateDir, "state.json"));

    const keyPath = path.join(sftpStateDir, "etc", "ssh_host_ed25519_key");
    await chmod(keyPath, 0o644);
    await writeFile(keyPath, "corrupt-private-key\n", "utf8");
    await chmod(keyPath, 0o444);

    reqLog.length = 0;
    await expect(
      adapter.applySftpAccess({ users: [{ ...u1, passwordHash: HASH_2 }] }),
    ).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });

    expect(
      reqLog.filter(
        (r) =>
          (r.method === "POST" && /\/containers\/([^/]+\/stop|create|[^/]+\/start)$/.test(r.routePath)) ||
          (r.method === "DELETE" && r.routePath.startsWith("/containers/")),
      ),
    ).toEqual([]);
    expect(sftpCtr()?.id).toBe(ctrId);
    expect(sftpCtr()?.running).toBe(true);
    expect((await readFile(path.join(sftpStateDir, "users", "passwd"))).equals(passwdBefore)).toBe(true);
    expect((await readFile(path.join(sftpStateDir, "users", "shadow"))).equals(shadowBefore)).toBe(true);
    expect((await readFile(path.join(sftpStateDir, "users", "group"))).equals(groupBefore)).toBe(true);
    expect((await readFile(path.join(sftpStateDir, "state.json"))).equals(stateBefore)).toBe(true);
  });

  it("refuses an append-path user addition and leaves user files and state.json byte-for-byte unchanged when the private host key is corrupt", async () => {
    const reqLog: Array<{ readonly method: string; readonly routePath: string }> = [];
    const { adapter, mockDaemon, sftpStateDir, sftpCtr } = await setup({
      onRequest: (method, routePath) => {
        reqLog.push({ method, routePath });
      },
    });
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });

    const u1 = makeUser({ username: "s1a2b3c4d_one", passwordHash: HASH_1 });
    const u2 = makeUser({ username: "s1a2b3c4d_two", passwordHash: HASH_2 });
    await adapter.applySftpAccess({ users: [u1] });
    const ctrId = sftpCtr()?.id;

    const passwdBefore = await readFile(path.join(sftpStateDir, "users", "passwd"));
    const shadowBefore = await readFile(path.join(sftpStateDir, "users", "shadow"));
    const groupBefore = await readFile(path.join(sftpStateDir, "users", "group"));
    const stateBefore = await readFile(path.join(sftpStateDir, "state.json"));

    const keyPath = path.join(sftpStateDir, "etc", "ssh_host_ed25519_key");
    await chmod(keyPath, 0o644);
    await writeFile(keyPath, "corrupt-private-key\n", "utf8");
    await chmod(keyPath, 0o444);

    reqLog.length = 0;
    await expect(adapter.applySftpAccess({ users: [u1, u2] })).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });

    expect(
      reqLog.filter(
        (r) =>
          (r.method === "POST" && /\/containers\/([^/]+\/stop|create|[^/]+\/start)$/.test(r.routePath)) ||
          (r.method === "DELETE" && r.routePath.startsWith("/containers/")),
      ),
    ).toEqual([]);
    expect(sftpCtr()?.id).toBe(ctrId);
    expect(sftpCtr()?.running).toBe(true);
    expect((await readFile(path.join(sftpStateDir, "users", "passwd"))).equals(passwdBefore)).toBe(true);
    expect((await readFile(path.join(sftpStateDir, "users", "shadow"))).equals(shadowBefore)).toBe(true);
    expect((await readFile(path.join(sftpStateDir, "users", "group"))).equals(groupBefore)).toBe(true);
    expect((await readFile(path.join(sftpStateDir, "state.json"))).equals(stateBefore)).toBe(true);
  });

  it("reports DOCKER_ENGINE_UNAVAILABLE on create/start failures without leaking paths, hashes, keys or ids", async () => {
    const { adapter, mockDaemon, sftpStateDir } = await setup();
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });
    const captured: string[] = [];
    const grab = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    vi.spyOn(console, "log").mockImplementation(grab);
    vi.spyOn(console, "info").mockImplementation(grab);
    vi.spyOn(console, "warn").mockImplementation(grab);
    vi.spyOn(console, "error").mockImplementation(grab);

    mockDaemon.failCreates.remaining = 1;
    const createErr = await adapter.applySftpAccess({ users: [makeUser()] }).catch((e: unknown) => e);
    expect(createErr).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(String((createErr as Error).message)).not.toContain(sftpStateDir);
    expect(String((createErr as Error).message)).not.toContain("$6$");

    mockDaemon.failStarts.remaining = 1;
    const startErr = await adapter.applySftpAccess({ users: [makeUser()] }).catch((e: unknown) => e);
    expect(startErr).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });

    // Recovers on retry
    expect(await adapter.applySftpAccess({ users: [makeUser()] })).toEqual({ applied: 1 });
    expect(captured.join("\n")).not.toContain(HASH_1);
    expect(captured.join("\n")).not.toContain(sftpStateDir);
    expect(captured.join("\n")).not.toContain("OPENSSH PRIVATE KEY");
  });

  it("serializes concurrent applySftpAccess calls and lets the last one win", async () => {
    const { adapter, mockDaemon, sftpStateDir } = await setup();
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });

    const first = makeUser({ username: "s1a2b3c4d_first" });
    const second = makeUser({ username: "s1a2b3c4d_second", passwordHash: HASH_2 });

    await Promise.all([
      adapter.applySftpAccess({ users: [first] }),
      adapter.applySftpAccess({ users: [second] }),
    ]);

    const passwd = await readFile(path.join(sftpStateDir, "users", "passwd"), "utf8");
    expect(passwd).toContain("s1a2b3c4d_second");
    expect(passwd).not.toContain("s1a2b3c4d_first");
  });

  it("never connects hp_sftp to site or mariadb networks during deploy, purge or ensureSharedDatabase", async () => {
    const { adapter, mockDaemon } = await setup();
    mockDaemon.volumeLabels.set("hp_vol_svc_s1_html", { "io.hostingpanel.site_id": "site_s1" });
    await adapter.applySftpAccess({
      users: [makeUser({ siteId: "site_s1", serviceInstanceId: "svc_s1" })],
    });

    await adapter.deployService(
      createApprovedServiceSpec({
        serviceInstanceId: "svc_s1",
        siteId: "site_s1",
        organizationId: "org_1",
        image: "wordpress:7.1.4-php8.4-apache",
        containerName: "hp-site-s1",
        env: {},
        resourceLimits: { cpuMilli: 500, memoryBytes: "536870912" },
        pidsLimit: 128,
        revisionNumber: 1,
        specHash: "hash_s1",
      }),
    );

    expect(
      mockDaemon.networkConnectCalls.some((c) => c.container === SFTP_CONTAINER_NAME),
    ).toBe(false);
  });

  it("ensureSftpFromState does nothing without state.json and reconciles without touching site containers (CP-01)", async () => {
    const { adapter, mockDaemon, sftpCtr } = await setup();
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });

    // No state.json -> zero Docker calls
    expect(await adapter.ensureSftpFromState()).toBeNull();
    expect(mockDaemon.requestedPaths).toEqual([]);

    // Apply once to persist state.json
    await adapter.applySftpAccess({ users: [makeUser()] });
    const firstId = sftpCtr()?.id;
    expect(firstId).toBeDefined();

    // Unchanged hash -> zero recreate, zero site container calls
    const mark = mockDaemon.requestedPaths.length;
    expect(await adapter.ensureSftpFromState()).toEqual({ applied: 1 });
    expect(sftpCtr()?.id).toBe(firstId);
    expect(mockDaemon.requestedPaths.slice(mark).some((p) => p.includes("/containers/create"))).toBe(
      false,
    );

    // Label drift -> recreates only hp_sftp
    if (sftpCtr()) {
      sftpCtr()!.labels[SHARED_DB_CONFIG_SHA256_LABEL] = "stale";
    }
    await adapter.ensureSftpFromState();
    expect(sftpCtr()?.id).not.toBe(firstId);
    expect(sftpCtr()?.running).toBe(true);
  });

  it("validates HP_SFTP_PORT in main.ts and starts daemon cleanly", async () => {
    for (const bad of ["22", "80", "443", "0", "65536", "abc", "22.5"]) {
      expect(() => parseSftpPortFromEnv({ HP_SFTP_PORT: bad })).toThrow(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
      await expect(
        bootstrapDockerExecutorDaemon({
          HP_IPC_KEY: HMAC_SECRET,
          HP_IPC_TRANSPORT: "loopback-test",
          HP_SFTP_PORT: bad,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(parseSftpPortFromEnv({})).toBeUndefined();
    expect(parseSftpPortFromEnv({ HP_SFTP_PORT: "2222" })).toBe(2222);
    expect(parseSftpPortFromEnv({ HP_SFTP_PORT: "2223" })).toBe(2223);
  });

  it("round-trips SFTP apply and status over signed IPC against the real adapter and covers simulator and phase1 stubs", async () => {
    const { adapter, mockDaemon } = await setup({ sftpPort: 2224 });
    mockDaemon.volumeLabels.set("hp_vol_svc_a_html", { "io.hostingpanel.site_id": "site_a" });

    const socketPath = path.join(os.tmpdir(), `hp-sftp-real-ipc-${randomBytes(5).toString("hex")}.sock`);
    const server = new DockerExecutorIpcServer({
      executor: adapter,
      keyring: { "hmac-v1": VERIFICATION_KEY },
      transport: "uds",
      socketPath,
      runtimeBackend: "linux-systemd",
    });
    cleanupTasks.push(() => server.stop());
    await server.start();

    const client = new SignedDockerExecutorIpcClient({
      signingKey: SIGNING_KEY,
      transport: "uds",
      socketPath,
    });

    expect(await client.applySftpAccess({ users: [makeUser()] })).toEqual({ applied: 1 });
    expect(await client.getSftpStatus()).toMatchObject({
      running: true,
      port: 2224,
      hostKeyFingerprint: expect.stringMatching(/^SHA256:[A-Za-z0-9+/]{43}$/),
    });

    // Simulator stores request and reports running: false
    const simulator = new InMemoryDockerSimulatorAdapter();
    await simulator.applySftpAccess({ users: [makeUser()] });
    expect(simulator.sftpUsers).toHaveLength(1);
    expect(await simulator.getSftpStatus()).toEqual({
      running: false,
      port: DEFAULT_SFTP_PORT,
      hostKeyFingerprint: null,
    });

    // Phase-1 adapter throws NOT_SUPPORTED
    const phase1 = new Phase1DisabledDockerExecutor();
    await expect(phase1.applySftpAccess({ users: [] })).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
    });
    await expect(phase1.getSftpStatus()).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
    });
  });
});
