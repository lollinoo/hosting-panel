import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BackupsIpcRequest, BackupTarget } from "@hosting-panel/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppStackEngine, type AppStackDockerRequest } from "../src/app-stacks/index.js";
import {
  BACKUP_RESTORE_FETCH_TIMEOUT_MS,
  BackupRunner,
  DockerEngineSocketAdapter,
  type BackupRunnerDeps,
  type DockerRequest,
} from "../src/index.js";
import { createAppStackFakeEngine } from "./support/app-stack-fake-engine.js";
import { TEST_ALLOWLIST, appStackTestPlan } from "./support/app-stack-plans.js";

const BACKUP_KEY = "deadbeef".repeat(8);
const SNAPSHOT_ID = "a1b2c3d4".repeat(8);
const TARGET_ID = `bkt_${"ab".repeat(16)}`;
const LOCAL_TARGET = { kind: "local", targetId: TARGET_ID } as const;
const S3_TARGET: BackupTarget = {
  endpoint: "https://storage.example.com:9000",
  region: "eu-central-1",
  bucket: "panel-backups",
  prefix: "prod",
  accessKeyId: "AKIASENTINEL0000",
  secretAccessKey: "sentinel-s3-secret-value",
};
const STACK = "stk_0123456789abcdef01234567";
const OTHER_STACK = "stk_fedcba9876543210fedcba98";
const ORG = "org_1";
const OP = (n: number, suffix = ""): string => `op_${n.toString(16).padStart(32, "0")}${suffix}`;
const UID = process.getuid?.() ?? 1000;
const GID = process.getgid?.() ?? 1000;
const GIB = 1024 * 1024 * 1024;

const cleanups: Array<() => Promise<unknown>> = [];
// The unit runs with UMask=0007; under a 0022 umask (a GitHub runner) the guard's 0770 folders would lose group write.
let oldUmask: number | undefined;
beforeAll(() => {
  try {
    oldUmask = process.umask(0o007);
  } catch {
    // worker threads cannot change the umask
  }
});
afterAll(() => {
  if (oldUmask !== undefined) process.umask(oldUmask);
});
afterEach(async () => {
  for (const task of cleanups.splice(0).reverse()) await task();
});

const frame = (stream: 1 | 2, text: string): Buffer => {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

const summaryLine = (): string =>
  JSON.stringify({
    message_type: "summary",
    snapshot_id: SNAPSHOT_ID,
    data_added: 4096,
    total_bytes_processed: 65536,
    files_new: 4,
    files_changed: 0,
    files_unmodified: 0,
    total_duration: 1,
  });

interface Created {
  readonly name: string;
  readonly payload: {
    readonly User?: string;
    readonly Env?: readonly string[];
    readonly Cmd?: readonly string[];
    readonly Labels?: Readonly<Record<string, string>>;
    readonly HostConfig: {
      readonly NetworkMode: string;
      readonly CapDrop?: readonly string[];
      readonly CapAdd?: readonly string[];
      readonly Binds?: readonly string[];
      readonly Mounts?: readonly { Type: string; Source: string; Target: string; ReadOnly: boolean }[];
      readonly GroupAdd?: readonly string[];
    };
  };
  /** The files of the job's secret directory at create time. */
  readonly secrets: Record<string, string>;
}

interface StepBehavior {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly onStart?: () => Promise<void>;
}

const ownLabels = (stackId = STACK, organizationId = ORG): Record<string, string> => ({
  "io.hostingpanel.managed": "true",
  "io.hostingpanel.stack_id": stackId,
  "io.hostingpanel.organization_id": organizationId,
});
const containerView = (state: string, labels: Record<string, string> | null = ownLabels()) => ({
  Id: "c0ffee",
  Names: [`/hp_app_${STACK}_web`],
  State: state,
  Labels: labels === null ? null : { ...labels, "io.hostingpanel.role": "app_component" },
});
/** A job container an earlier restore of STACK left behind (its kill or its removal failed). */
const leftoverJob = (state: string) => ({
  Id: "b4c0ffee",
  Names: [`/hp_bk_${OP(70, "-apply")}_rs_data`],
  State: state,
  Labels: {
    "io.hostingpanel.managed": "true",
    "io.hostingpanel.role": "site_job",
    "io.hostingpanel.job_id": OP(70, "-apply"),
    "io.hostingpanel.app_backup_of": STACK,
  },
});
const volumeName = (key: string, stackId = STACK): string => `hp_appvol_${stackId}_${key}`;
const volumeView = (key: string, over: Record<string, unknown> = {}, stackId = STACK) => ({
  Name: volumeName(key, stackId),
  Driver: "local",
  Mountpoint: `/var/lib/docker/volumes/${volumeName(key, stackId)}/_data`,
  Labels: { ...ownLabels(stackId), "io.hostingpanel.app_volume_key": key },
  Options: null,
  ...over,
});

async function setup(opts?: { steps?: (name: string) => StepBehavior }) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-runner-stack-"));
  cleanups.push(() => rm(tmp, { recursive: true, force: true }));
  const secretsRootDir = path.join(tmp, "secrets");
  await mkdir(secretsRootDir, { mode: 0o700 });
  const root = path.join(tmp, "repos");
  // What bootstrap-dedicated.sh does: the root is 2770, so the guard's folders inherit setgid.
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o2770);
  const panelDumpDir = path.join(tmp, "panel-dump");
  await mkdir(panelDumpDir, { mode: 0o770 });
  const backupKeyFile = path.join(tmp, "backup.key");
  await writeFile(backupKeyFile, `${BACKUP_KEY}\n`, { mode: 0o400 });
  const sharedDbRootKeyFile = path.join(tmp, "db-root.key");
  await writeFile(sharedDbRootKeyFile, "db-root-pass", { mode: 0o400 });

  /** What the fake Docker holds of the application; a test changes it before it sends a request. */
  const docker = {
    containers: [containerView("exited")] as unknown[],
    listStatus: 200,
    /** Job containers labelled as working for STACK, left by earlier jobs. */
    jobs: [] as unknown[],
    jobListStatus: 200,
    /** What the kill and the forced delete of a job container answer. */
    jobRemovalStatus: 204,
    volumes: new Map<string, unknown>([
      [volumeName("data"), volumeView("data")],
      [volumeName("db"), volumeView("db")],
      [volumeName("data", OTHER_STACK), volumeView("data", {}, OTHER_STACK)],
    ]),
  };
  const created: Created[] = [];
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const behaviors = new Map<string, StepBehavior>();
  /** The first request whose "METHOD path" matches waits there until released. */
  const gates: Array<{ readonly match: RegExp; readonly arrive: () => void; readonly released: Promise<void> }> = [];
  const gate = (match: RegExp) => {
    let arrive!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => (arrive = resolve));
    gates.push({ match, arrive, released: new Promise<void>((resolve) => (release = resolve)) });
    return { reached, release };
  };
  const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "GET") return new Response("<ListBucketResult/>", { status: 200 });
    if (method === "PUT") return new Response(null, { status: 200 });
    return new Response(null, { status: method === "DELETE" ? 204 : 405 });
  });
  const networkSpy = vi.fn(async () => undefined);

  const json = (statusCode: number, body: unknown) => ({ statusCode, body: Buffer.from(JSON.stringify(body)) });
  const empty = (statusCode: number) => ({ statusCode, body: Buffer.alloc(0) });
  const request: DockerRequest = async (method, reqPath, body) => {
    requests.push({ method, path: reqPath, body });
    const held = gates.findIndex((g) => g.match.test(`${method} ${reqPath}`));
    if (held >= 0) {
      const [g] = gates.splice(held, 1);
      g?.arrive();
      await g?.released;
    }
    const url = new URL(`http://docker${reqPath}`);
    const p = url.pathname;
    if (method === "GET" && p === "/containers/json") {
      if (docker.listStatus !== 200) return json(docker.listStatus, { message: "boom" });
      // Docker applies the label filter: what a test holds is the list of STACK, another application has no container.
      const filters = JSON.parse(url.searchParams.get("filters") ?? "{}") as { label?: string[] };
      if (filters.label?.includes(`io.hostingpanel.app_backup_of=${STACK}`) === true) {
        return docker.jobListStatus === 200 ? json(200, docker.jobs) : json(docker.jobListStatus, { message: "boom" });
      }
      const asked = filters.label?.includes(`io.hostingpanel.stack_id=${STACK}`) === true;
      return json(200, asked ? docker.containers : []);
    }
    if (method === "POST" && p === "/containers/create") {
      const name = url.searchParams.get("name") ?? "";
      behaviors.set(name, opts?.steps?.(name) ?? {});
      const secrets: Record<string, string> = {};
      const m = /job_bk_[^/]+/.exec(JSON.stringify(body));
      if (m) {
        const dir = path.join(secretsRootDir, m[0]);
        for (const f of await readdir(dir).catch(() => [])) secrets[f] = await readFile(path.join(dir, f), "utf8");
      }
      created.push({ name, payload: body as Created["payload"], secrets });
      return json(201, { Id: `id_${name}` });
    }
    const op = /^\/containers\/id_([^/]+)\/(start|wait|logs|kill)$/.exec(p);
    if (op) {
      const b = behaviors.get(op[1]!) ?? {};
      if (op[2] === "start") {
        await b.onStart?.();
        return empty(204);
      }
      if (op[2] === "wait") return json(200, { StatusCode: b.exitCode ?? 0 });
      if (op[2] === "logs") {
        const wantOut = url.searchParams.get("stdout") === "1";
        const text = wantOut ? b.stdout : b.stderr;
        return { statusCode: 200, body: text ? frame(wantOut ? 1 : 2, text) : Buffer.alloc(0) };
      }
      return empty(docker.jobRemovalStatus);
    }
    if (method === "DELETE" && p.startsWith("/containers/")) return empty(docker.jobRemovalStatus);
    const vol = /^\/volumes\/([^/]+)$/.exec(p);
    if (vol && method === "GET") {
      const view = docker.volumes.get(decodeURIComponent(vol[1]!));
      return view === undefined ? json(404, { message: "no such volume" }) : json(200, view);
    }
    // Anything else (creating or removing a volume, starting or stopping a container of the application) is a bug.
    throw new Error(`Unexpected Docker call ${method} ${reqPath}`);
  };

  const deps: BackupRunnerDeps = {
    request,
    ensureImage: async () => undefined,
    ensureBackupNetwork: networkSpy,
    listSiteDatabases: async () => [],
    secretsRootDir,
    backupKeyFile,
    sharedDbRootKeyFile,
    sharedDbNetworkName: "hp_db_net",
    backupNetworkName: "hp_backup_net",
    executorUser: `${UID}:${GID}`,
    backupWorkDir: path.join(tmp, "backup-work"),
    panelDumpDir,
    sharedDbDataDir: path.join(tmp, "mariadb-data"),
    fetch: fetchSpy as unknown as typeof globalThis.fetch,
    localRepoRoot: root,
    localTargetStatfs: async () => ({
      bsize: 1n,
      blocks: 100n * BigInt(GIB),
      bavail: 50n * BigInt(GIB),
      files: 1000n,
      ffree: 1000n,
    }),
  };
  const runner = new BackupRunner(deps);
  const env = {
    runner,
    tmp,
    root,
    secretsRootDir,
    backupKeyFile,
    docker,
    created,
    requests,
    fetchSpy,
    networkSpy,
    gate,
    createdNames: () => created.map((c) => c.name),
    lists: () => requests.filter((r) => r.path.startsWith("/containers/json")).length,
    newRunner: () => new BackupRunner(deps),
  };
  // The local target exists as the panel creates it: marker, sites/ and panel/.
  await expect(runner.run({ action: "localInit", target: LOCAL_TARGET })).resolves.toMatchObject({ outcome: "ok" });
  created.length = 0;
  requests.length = 0;
  networkSpy.mockClear();
  fetchSpy.mockClear();
  return env;
}
type Env = Awaited<ReturnType<typeof setup>>;

async function settled(runner: BackupRunner, jobId: string) {
  const until = performance.now() + 3_000;
  while (performance.now() < until) {
    const status = await runner.run({ action: "status", jobId });
    if (status.state !== "running") return status;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`job ${jobId} did not settle`);
}

type CopyRequest = Extract<BackupsIpcRequest, { action: "stackStart" }>;
type RestoreRequest = Extract<BackupsIpcRequest, { action: "stackRestore" }>;
type ForgetRequest = Extract<BackupsIpcRequest, { action: "stackForget" }>;

const copyReq = (jobId: string, extra: Partial<CopyRequest> = {}): CopyRequest => ({
  action: "stackStart",
  jobId,
  stackId: STACK,
  organizationId: ORG,
  volumeKeys: ["data", "db"],
  target: LOCAL_TARGET,
  ...extra,
});
const restoreReq = (jobId: string, extra: Partial<RestoreRequest> = {}): RestoreRequest => ({
  action: "stackRestore",
  jobId,
  stackId: STACK,
  organizationId: ORG,
  volumeKeys: ["data", "db"],
  target: LOCAL_TARGET,
  snapshotId: SNAPSHOT_ID,
  ...extra,
});
const forgetReq = (jobId: string, extra: Partial<ForgetRequest> = {}): ForgetRequest => ({
  action: "stackForget",
  jobId,
  stackId: STACK,
  target: LOCAL_TARGET,
  snapshotIds: [SNAPSHOT_ID],
  ...extra,
});

const upStep = (name: string): StepBehavior => (name.endsWith("_up") ? { stdout: summaryLine() } : {});
const repoDir = (env: Env, stackId = STACK): string => path.join(env.root, TARGET_ID, "stacks", stackId);

/**
 * A copy that succeeded, then a clean slate: the repository folder of the application exists (on a local destination).
 * Copy n is also the safety copy a write-back `OP(n, "-apply")` needs.
 */
async function copied(env: Env, n = 90, extra: Partial<CopyRequest> = {}, suffix = ""): Promise<void> {
  await env.runner.run(copyReq(OP(n, suffix), extra));
  await expect(settled(env.runner, OP(n, suffix))).resolves.toMatchObject({ state: "succeeded" });
  env.created.length = 0;
  env.requests.length = 0;
}

/** Nothing of a job is left behind, no secret went to Docker and no container of the application was touched. */
async function expectClean(env: Env): Promise<void> {
  expect(await readdir(env.secretsRootDir)).toEqual([]);
  const wire = JSON.stringify(env.requests);
  expect(wire).not.toContain(BACKUP_KEY);
  expect(wire).not.toContain(S3_TARGET.secretAccessKey);
  expect(wire).not.toContain(S3_TARGET.accessKeyId);
  for (const { method, path: reqPath } of env.requests) {
    expect(reqPath).not.toMatch(/\/(stop|pause|unpause|restart|exec|rename|update)(\?|$)/);
    if (method !== "GET") expect(reqPath).toMatch(/^\/containers\/(create\?name=hp_bk_|id_hp_bk_)/);
  }
  for (const c of env.created) {
    expect(c.name).toMatch(/^hp_bk_op_[0-9a-f]{32}/);
    expect(c.payload.User).toBe("0:0");
    expect(c.payload.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(Object.keys(c.payload.Labels ?? {})).not.toContain("io.hostingpanel.stack_id");
    expect(c.payload.Labels).toMatchObject({
      "io.hostingpanel.role": "site_job",
      "io.hostingpanel.app_backup_of": STACK,
    });
    expect(JSON.stringify(c.payload)).not.toContain("docker.sock");
    expect(env.requests).toContainEqual(expect.objectContaining({ method: "DELETE", path: expect.stringContaining(`id_${c.name}`) }));
  }
}

describe("the check before a copy or a restore of an application (ADR-0038 K4)", () => {
  async function expectRefused(env: Env, req: CopyRequest | RestoreRequest, code: string): Promise<void> {
    await expect(env.runner.run(req)).rejects.toMatchObject({ code });
    expect(env.created).toEqual([]);
    await expect(env.runner.run({ action: "status", jobId: req.jobId })).resolves.toMatchObject({ state: "unknown" });
    expect(await readdir(env.secretsRootDir)).toEqual([]);
    // Refused before the destination is touched: no folder for the application appears.
    await expect(stat(repoDir(env))).rejects.toMatchObject({ code: "ENOENT" });
  }
  const requestsOf = (n: number): Array<CopyRequest | RestoreRequest> => [copyReq(OP(n)), restoreReq(OP(n + 1, "-apply"))];

  it.each(["running", "restarting", "paused", "removing"])("refuses while a container of the application is %s", async (state) => {
    const env = await setup({ steps: upStep });
    env.docker.containers = [containerView("exited"), containerView(state)];
    for (const req of requestsOf(1)) await expectRefused(env, req, "RESOURCE_LOCKED");
  });

  it("lists every container carrying the id of the application, stopped ones included", async () => {
    const env = await setup({ steps: upStep });
    await env.runner.run(copyReq(OP(1)));
    await settled(env.runner, OP(1));
    const list = env.requests.find((r) => r.path.startsWith("/containers/json"));
    const url = new URL(`http://docker${list?.path ?? ""}`);
    expect(url.searchParams.get("all")).toBe("true");
    expect(JSON.parse(url.searchParams.get("filters") ?? "null")).toEqual({
      label: [`io.hostingpanel.stack_id=${STACK}`],
    });
  });

  it("accepts an application whose containers are created, exited or dead, or that has none", async () => {
    for (const containers of [[], [containerView("created"), containerView("exited"), containerView("dead")]]) {
      const env = await setup({ steps: upStep });
      env.docker.containers = containers;
      await expect(env.runner.run(copyReq(OP(1)))).resolves.toMatchObject({ state: "running" });
      await expect(settled(env.runner, OP(1))).resolves.toMatchObject({ state: "succeeded" });
    }
  });

  it.each(["running", "restarting", "paused", "removing"])(
    "refuses while a job container an earlier job of the application left behind is %s",
    async (state) => {
      const env = await setup({ steps: upStep });
      env.docker.jobs = [leftoverJob("exited"), leftoverJob(state)];
      for (const req of requestsOf(1)) await expectRefused(env, req, "RESOURCE_LOCKED");
    },
  );

  it("lists the job containers of the application by their own label and lets the stopped ones be", async () => {
    const env = await setup({ steps: upStep });
    // Stopped leftovers write nothing; the clean-up at the next executor start removes them.
    env.docker.jobs = [leftoverJob("exited"), leftoverJob("dead"), leftoverJob("created")];
    await expect(env.runner.run(copyReq(OP(1)))).resolves.toMatchObject({ state: "running" });
    await expect(settled(env.runner, OP(1))).resolves.toMatchObject({ state: "succeeded" });
    const lists = env.requests
      .filter((r) => r.path.startsWith("/containers/json"))
      .map((r) => new URL(`http://docker${r.path}`).searchParams);
    expect(lists.map((q) => [q.get("all"), JSON.parse(q.get("filters") ?? "null")])).toEqual([
      ["true", { label: [`io.hostingpanel.stack_id=${STACK}`] }],
      ["true", { label: [`io.hostingpanel.app_backup_of=${STACK}`] }],
    ]);
  });

  it("refuses when Docker cannot list the job containers of the application", async () => {
    const env = await setup({ steps: upStep });
    env.docker.jobListStatus = 500;
    for (const req of requestsOf(1)) await expectRefused(env, req, "DOCKER_ENGINE_UNAVAILABLE");
    env.docker.jobListStatus = 200;
    env.docker.jobs = { not: "a list" } as unknown as unknown[];
    for (const req of requestsOf(3)) await expectRefused(env, req, "DOCKER_ENGINE_UNAVAILABLE");
  });

  it("refuses when a container carries the id of the application without being its own", async () => {
    const foreign: Array<Record<string, string> | null> = [
      ownLabels(STACK, "org_2"),
      { "io.hostingpanel.stack_id": STACK, "io.hostingpanel.organization_id": ORG },
      { ...ownLabels(), "io.hostingpanel.managed": "false" },
      null,
    ];
    for (const labels of foreign) {
      const env = await setup({ steps: upStep });
      env.docker.containers = [containerView("exited", labels)];
      for (const req of requestsOf(1)) await expectRefused(env, req, "HOST_POLICY_DENIED");
    }
  });

  it("refuses when Docker cannot list the containers", async () => {
    const env = await setup({ steps: upStep });
    env.docker.listStatus = 500;
    for (const req of requestsOf(1)) await expectRefused(env, req, "DOCKER_ENGINE_UNAVAILABLE");
    env.docker.listStatus = 200;
    env.docker.containers = { not: "a list" } as unknown as unknown[];
    for (const req of requestsOf(3)) await expectRefused(env, req, "DOCKER_ENGINE_UNAVAILABLE");
  });

  it("refuses a volume that does not exist", async () => {
    const env = await setup({ steps: upStep });
    env.docker.volumes.delete(volumeName("db"));
    for (const req of requestsOf(1)) await expectRefused(env, req, "NOT_FOUND");
  });

  it.each<[string, Record<string, unknown>]>([
    ["of another customer", { Labels: { ...ownLabels(STACK, "org_2"), "io.hostingpanel.app_volume_key": "db" } }],
    ["of another application", { Labels: { ...ownLabels(OTHER_STACK), "io.hostingpanel.app_volume_key": "db" } }],
    ["labelled with another key", { Labels: { ...ownLabels(), "io.hostingpanel.app_volume_key": "data" } }],
    ["without the key label", { Labels: ownLabels() }],
    ["without labels", { Labels: null }],
    ["not managed by the panel", { Labels: { ...ownLabels(), "io.hostingpanel.managed": "no", "io.hostingpanel.app_volume_key": "db" } }],
    ["under another name", { Name: `hp_appvol_${OTHER_STACK}_db` }],
    ["on another driver", { Driver: "nfs" }],
    ["with driver options", { Options: { type: "none", o: "bind", device: "/etc" } }],
  ])("refuses a volume %s", async (_label, over) => {
    const env = await setup({ steps: upStep });
    env.docker.volumes.set(volumeName("db"), volumeView("db", over));
    for (const req of requestsOf(1)) await expectRefused(env, req, "HOST_POLICY_DENIED");
  });

  it("refuses a request it could not have been sent by the panel", async () => {
    const env = await setup({ steps: upStep });
    const bad: unknown[] = [
      copyReq(OP(1, "-apply")),
      copyReq(OP(1, "-forget")),
      restoreReq(OP(1)),
      restoreReq(OP(1, "-t2")),
      copyReq(OP(1), { volumeKeys: [] }),
      copyReq(OP(1), { volumeKeys: ["data", "data"] }),
      copyReq(OP(1), { volumeKeys: ["../etc"] }),
      copyReq(OP(1), { stackId: "../x" }),
      restoreReq(OP(1, "-apply"), { snapshotId: "latest" }),
      { ...copyReq(OP(1)), hostPath: "/etc" },
      { ...forgetReq(OP(1, "-forget")), organizationId: ORG },
      forgetReq(OP(1, "-forget"), { snapshotIds: [] }),
    ];
    for (const req of bad) {
      await expect(env.runner.run(req as BackupsIpcRequest)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    expect(env.requests).toEqual([]);
  });
});

describe("the copy of an application's volumes", () => {
  it("writes one snapshot of every volume to the application's own folder of a local destination", async () => {
    const env = await setup({ steps: upStep });
    await expect(env.runner.run(copyReq(OP(1)))).resolves.toEqual({
      jobId: OP(1),
      state: "running",
      failure: null,
      snapshot: null,
    });
    const done = await settled(env.runner, OP(1));
    expect(done).toMatchObject({
      jobId: OP(1),
      state: "succeeded",
      failure: null,
      snapshot: { snapshotId: SNAPSHOT_ID, bytesAdded: 4096, totalBytes: 65536 },
    });

    expect(env.createdNames()).toEqual([`hp_bk_${OP(1)}_repo`, `hp_bk_${OP(1)}_up`]);
    for (const c of env.created) {
      expect(c.payload.HostConfig.NetworkMode).toBe("none");
      expect(c.payload.HostConfig.Mounts).toEqual([
        { Type: "bind", Source: repoDir(env), Target: `/backup/repository/stacks/${STACK}`, ReadOnly: false },
      ]);
      expect(c.payload.HostConfig.GroupAdd).toEqual([String(GID)]);
      expect(Object.keys(c.secrets)).toEqual(["RESTIC_PASSWORD"]);
      expect(c.secrets.RESTIC_PASSWORD).toBe(BACKUP_KEY);
      expect(JSON.stringify(c.payload)).not.toMatch(/AWS_|HP_REGION|s3\./);
      expect(c.payload.Env).toContain(`RESTIC_REPOSITORY=/backup/repository/stacks/${STACK}`);
    }
    const [repo, up] = env.created;
    expect(repo?.payload.Env).toContain("HP_INIT=1");
    expect(repo?.payload.HostConfig.CapAdd).toBeUndefined();
    expect(repo?.payload.HostConfig.Binds?.filter((b) => b.startsWith("hp_appvol_"))).toEqual([]);
    expect(up?.payload.HostConfig.CapAdd).toEqual(["DAC_READ_SEARCH"]);
    expect(up?.payload.HostConfig.Binds?.filter((b) => b.startsWith("hp_appvol_"))).toEqual([
      `hp_appvol_${STACK}_data:/data/data:ro`,
      `hp_appvol_${STACK}_db:/data/db:ro`,
    ]);
    expect(up?.payload.Cmd).toEqual(["backup", "-q", "--json", "--host", "hosting-panel", "--tag", OP(1), "/data/data", "/data/db"]);

    expect(((await stat(repoDir(env))).mode & 0o7777).toString(8)).toBe("2770");
    expect((await readdir(path.join(env.root, TARGET_ID))).sort()).toEqual([".hp-local-target", "panel", "sites", "stacks"]);
    expect(await readdir(path.join(env.root, TARGET_ID, "sites"))).toEqual([]);
    expect(env.fetchSpy).not.toHaveBeenCalled();
    expect(env.networkSpy).not.toHaveBeenCalled();
    await expectClean(env);
  });

  it("copies only the volumes asked, in the order asked", async () => {
    const env = await setup({ steps: upStep });
    await env.runner.run(copyReq(OP(1), { volumeKeys: ["db"] }));
    await expect(settled(env.runner, OP(1))).resolves.toMatchObject({ state: "succeeded" });
    expect(env.created[1]?.payload.HostConfig.Binds?.filter((b) => b.startsWith("hp_appvol_"))).toEqual([
      `hp_appvol_${STACK}_db:/data/db:ro`,
    ]);
    // Only the asked volume is checked: the other one is not this job's business.
    expect(env.requests.filter((r) => r.path.startsWith("/volumes/")).map((r) => r.path)).toEqual([
      `/volumes/${volumeName("db")}`,
    ]);
  });

  it("goes to an S3 destination on the backup network, under stacks/<stackId>, with the keys as files", async () => {
    const env = await setup({ steps: upStep });
    await env.runner.run(copyReq(OP(1), { target: S3_TARGET }));
    await expect(settled(env.runner, OP(1))).resolves.toMatchObject({
      state: "succeeded",
      snapshot: { snapshotId: SNAPSHOT_ID },
    });
    expect(env.createdNames()).toEqual([`hp_bk_${OP(1)}_repo`, `hp_bk_${OP(1)}_up`]);
    for (const c of env.created) {
      expect(c.payload.HostConfig.NetworkMode).toBe("hp_backup_net");
      expect(c.payload.HostConfig.Mounts).toBeUndefined();
      expect(c.payload.HostConfig.GroupAdd).toBeUndefined();
      expect(Object.keys(c.secrets).sort()).toEqual(["AWS_SHARED_CREDENTIALS", "RESTIC_PASSWORD"]);
      expect(c.payload.Env).toContain(
        `RESTIC_REPOSITORY=s3:https://storage.example.com:9000/panel-backups/prod/stacks/${STACK}`,
      );
    }
    expect(env.created[1]?.payload.HostConfig.CapAdd).toEqual(["DAC_READ_SEARCH"]);
    expect(env.created[1]?.payload.Cmd?.slice(0, 5)).toEqual(["-o", "s3.bucket-lookup=path", "-o", "s3.region=eu-central-1", "backup"]);
    expect(env.networkSpy).toHaveBeenCalledTimes(1);
    expect(env.fetchSpy).toHaveBeenCalled();
    // Nothing local is created for an S3 destination.
    await expect(stat(repoDir(env))).rejects.toMatchObject({ code: "ENOENT" });
    await expectClean(env);
  });

  it("fails with files_unreadable and drops the incomplete snapshot when a file could not be read", async () => {
    const env = await setup({
      steps: (name) => (name.endsWith("_up") ? { exitCode: 3, stdout: summaryLine() } : {}),
    });
    await env.runner.run(copyReq(OP(1)));
    await expect(settled(env.runner, OP(1))).resolves.toEqual({
      jobId: OP(1),
      state: "failed",
      failure: "files_unreadable",
      snapshot: null,
    });
    expect(env.createdNames()).toEqual([`hp_bk_${OP(1)}_repo`, `hp_bk_${OP(1)}_up`, `hp_bk_${OP(1)}_drop`]);
    expect(env.created[2]?.payload.Cmd).toEqual(["forget", SNAPSHOT_ID]);
    expect(env.created[2]?.payload.HostConfig.CapAdd).toBeUndefined();
    await expectClean(env);
  });

  it("drops nothing when the unreadable copy left no snapshot", async () => {
    const env = await setup({ steps: (name) => (name.endsWith("_up") ? { exitCode: 3 } : {}) });
    await env.runner.run(copyReq(OP(1)));
    await expect(settled(env.runner, OP(1))).resolves.toMatchObject({ state: "failed", failure: "files_unreadable" });
    expect(env.createdNames()).toEqual([`hp_bk_${OP(1)}_repo`, `hp_bk_${OP(1)}_up`]);
    await expectClean(env);
  });

  it.each<[string, StepBehavior, string, string[]]>([
    ["the key does not open the repository", { exitCode: 12 }, "wrong_key", ["repo"]],
    ["the repository is locked", { exitCode: 11 }, "repository_locked", ["repo"]],
    ["the repository step times out", { exitCode: 124 }, "timeout", ["repo"]],
  ])("copies nothing when %s", async (_label, repoStep, failure, steps) => {
    const env = await setup({ steps: (name) => (name.endsWith("_repo") ? repoStep : upStep(name)) });
    await env.runner.run(copyReq(OP(1)));
    await expect(settled(env.runner, OP(1))).resolves.toMatchObject({ state: "failed", failure, snapshot: null });
    expect(env.createdNames()).toEqual(steps.map((s) => `hp_bk_${OP(1)}_${s}`));
    await expectClean(env);
  });

  it("fails when the copy ends without a summary or with an error", async () => {
    const quiet = await setup();
    await quiet.runner.run(copyReq(OP(1)));
    await expect(settled(quiet.runner, OP(1))).resolves.toMatchObject({ state: "failed", failure: "other", snapshot: null });

    const locked = await setup({ steps: (name) => (name.endsWith("_up") ? { exitCode: 11 } : {}) });
    await locked.runner.run(copyReq(OP(1)));
    await expect(settled(locked.runner, OP(1))).resolves.toMatchObject({ state: "failed", failure: "repository_locked" });
    await expectClean(locked);
  });

  it("fails without a container when the backup key or the destination is missing", async () => {
    const noKey = await setup({ steps: upStep });
    await unlink(noKey.backupKeyFile);
    await noKey.runner.run(copyReq(OP(1)));
    await expect(settled(noKey.runner, OP(1))).resolves.toMatchObject({ state: "failed", failure: "key_file_missing" });
    expect(noKey.created).toEqual([]);

    const noTarget = await setup({ steps: upStep });
    const elsewhere = { kind: "local", targetId: `bkt_${"cd".repeat(16)}` } as const;
    await noTarget.runner.run(copyReq(OP(1), { target: elsewhere }));
    await expect(settled(noTarget.runner, OP(1))).resolves.toMatchObject({ state: "failed", failure: "local_target_unmounted" });
    expect(noTarget.created).toEqual([]);
    expect(await readdir(noTarget.root)).toEqual([TARGET_ID]);
  });
});

describe("the restore of an application's volumes (ADR-0038 K5)", () => {
  it("writes each volume back in its own container, reading the repository only", async () => {
    const env = await setup({ steps: upStep });
    await copied(env, 2);
    await expect(env.runner.run(restoreReq(OP(2, "-apply"), { volumeKeys: ["db", "data"] }))).resolves.toMatchObject({
      state: "running",
    });
    await expect(settled(env.runner, OP(2, "-apply"))).resolves.toEqual({
      jobId: OP(2, "-apply"),
      state: "succeeded",
      failure: null,
      snapshot: null,
    });

    expect(env.createdNames()).toEqual([`hp_bk_${OP(2, "-apply")}_rs_db`, `hp_bk_${OP(2, "-apply")}_rs_data`]);
    for (const [i, key] of ["db", "data"].entries()) {
      const c = env.created[i];
      // One volume per container, writable; never the other volume of the application.
      expect(c?.payload.HostConfig.Binds?.filter((b) => b.startsWith("hp_appvol_"))).toEqual([
        `hp_appvol_${STACK}_${key}:/data/${key}`,
      ]);
      expect(c?.payload.HostConfig.Mounts).toEqual([
        { Type: "bind", Source: repoDir(env), Target: `/backup/repository/stacks/${STACK}`, ReadOnly: true },
      ]);
      expect(c?.payload.HostConfig.NetworkMode).toBe("none");
      expect(c?.payload.HostConfig.CapAdd).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID"]);
      expect(c?.payload.Cmd).toEqual([
        "restore",
        `${SNAPSHOT_ID}:/data`,
        "--target",
        "/data",
        "--include",
        `/${key}`,
        "--delete",
        "--no-lock",
        "--json",
      ]);
      expect(Object.keys(c?.secrets ?? {})).toEqual(["RESTIC_PASSWORD"]);
    }
    await expectClean(env);
  });

  it("stops at the first volume that fails", async () => {
    const env = await setup({ steps: (name) => (name.endsWith("_rs_data") ? { exitCode: 12 } : upStep(name)) });
    await copied(env, 2);
    await env.runner.run(restoreReq(OP(2, "-apply")));
    await expect(settled(env.runner, OP(2, "-apply"))).resolves.toMatchObject({ state: "failed", failure: "wrong_key" });
    expect(env.createdNames()).toEqual([`hp_bk_${OP(2, "-apply")}_rs_data`]);
    await expectClean(env);
  });

  it("reports a later volume's failure after the earlier ones were written", async () => {
    const env = await setup({ steps: (name) => (name.endsWith("_rs_db") ? { exitCode: 1, stderr: "Fatal: boom" } : upStep(name)) });
    await copied(env, 2);
    await env.runner.run(restoreReq(OP(2, "-apply")));
    await expect(settled(env.runner, OP(2, "-apply"))).resolves.toMatchObject({ state: "failed", snapshot: null });
    expect(env.createdNames()).toEqual([`hp_bk_${OP(2, "-apply")}_rs_data`, `hp_bk_${OP(2, "-apply")}_rs_db`]);
  });

  it("never creates the repository folder: an application with no copy on this destination fails untouched", async () => {
    const env = await setup({ steps: upStep });
    // The safety copy went to the other destination.
    await copied(env, 2, { target: S3_TARGET });
    await env.runner.run(restoreReq(OP(2, "-apply")));
    await expect(settled(env.runner, OP(2, "-apply"))).resolves.toMatchObject({ state: "failed", failure: "other" });
    expect(env.created).toEqual([]);
    expect((await readdir(path.join(env.root, TARGET_ID))).sort()).toEqual([".hp-local-target", "panel", "sites"]);
  });

  it("reads an S3 repository on the backup network", async () => {
    const env = await setup({ steps: upStep });
    await copied(env, 2, { target: S3_TARGET });
    await env.runner.run(restoreReq(OP(2, "-apply"), { target: S3_TARGET, volumeKeys: ["data"] }));
    await expect(settled(env.runner, OP(2, "-apply"))).resolves.toMatchObject({ state: "succeeded" });
    expect(env.createdNames()).toEqual([`hp_bk_${OP(2, "-apply")}_rs_data`]);
    const c = env.created[0];
    expect(c?.payload.HostConfig.NetworkMode).toBe("hp_backup_net");
    expect(c?.payload.HostConfig.Mounts).toBeUndefined();
    expect(c?.payload.Cmd).toEqual([
      "-o",
      "s3.bucket-lookup=path",
      "-o",
      "s3.region=eu-central-1",
      "restore",
      `${SNAPSHOT_ID}:/data`,
      "--target",
      "/data",
      "--include",
      "/data",
      "--delete",
      "--no-lock",
      "--json",
    ]);
    expect(Object.keys(c?.secrets ?? {}).sort()).toEqual(["AWS_SHARED_CREDENTIALS", "RESTIC_PASSWORD"]);
    await expectClean(env);
  });
});

describe("the safety copy a write-back needs (HARNESS.md, ADR-0038 K5)", () => {
  async function expectNoWriteBack(runner: BackupRunner, env: Env, req: RestoreRequest): Promise<void> {
    await expect(runner.run(req)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(env.created).toEqual([]);
    await expect(runner.run({ action: "status", jobId: req.jobId })).resolves.toMatchObject({ state: "unknown" });
  }

  it("refuses a write-back without a good copy of the same application under the same operation, before any container", async () => {
    const env = await setup({ steps: (name) => (name === `hp_bk_${OP(3)}_up` ? { exitCode: 12 } : upStep(name)) });
    await expectNoWriteBack(env.runner, env, restoreReq(OP(2, "-apply")));
    // A good copy of another operation (the backup being restored, say) is not the safety copy.
    await copied(env, 90);
    await expectNoWriteBack(env.runner, env, restoreReq(OP(2, "-apply")));
    // The copy of the operation failed.
    await env.runner.run(copyReq(OP(3)));
    await expect(settled(env.runner, OP(3))).resolves.toMatchObject({ state: "failed" });
    env.created.length = 0;
    await expectNoWriteBack(env.runner, env, restoreReq(OP(3, "-apply")));
    // The copy under that operation id is another application's.
    await copied(env, 4, { stackId: OTHER_STACK, volumeKeys: ["data"] });
    await expectNoWriteBack(env.runner, env, restoreReq(OP(4, "-apply")));
    // The lane and the job slot are free again.
    await copied(env, 5);
  });

  it("refuses a write-back of a volume its safety copy did not save", async () => {
    const env = await setup({ steps: upStep });
    await copied(env, 2, { volumeKeys: ["data"] });
    await expectNoWriteBack(env.runner, env, restoreReq(OP(2, "-apply"), { volumeKeys: ["data", "db"] }));
    await expect(env.runner.run(restoreReq(OP(2, "-apply"), { volumeKeys: ["data"] }))).resolves.toMatchObject({ state: "running" });
    await expect(settled(env.runner, OP(2, "-apply"))).resolves.toMatchObject({ state: "succeeded" });
  });

  it("refuses a write-back after an executor restart: the safety copy it saw went with the process", async () => {
    const env = await setup({ steps: upStep });
    await copied(env, 2);
    await expectNoWriteBack(env.newRunner(), env, restoreReq(OP(2, "-apply")));
  });

  it.each([
    ["the first", ""],
    ["the second", "-t2"],
  ])("writes back when only %s of the two safety copies is good", async (_label, good) => {
    const bad = good === "" ? "-t2" : "";
    const env = await setup({ steps: (name) => (name === `hp_bk_${OP(2, bad)}_up` ? { exitCode: 12 } : upStep(name)) });
    // The backup being restored, on the local destination the write-back reads.
    await copied(env, 90);
    await env.runner.run(copyReq(OP(2, bad), { target: S3_TARGET }));
    await expect(settled(env.runner, OP(2, bad))).resolves.toMatchObject({ state: "failed", failure: "wrong_key" });
    await copied(env, 2, good === "" ? {} : { target: S3_TARGET }, good);
    await expect(env.runner.run(restoreReq(OP(2, "-apply")))).resolves.toMatchObject({ state: "running" });
    await expect(settled(env.runner, OP(2, "-apply"))).resolves.toMatchObject({ state: "succeeded" });
  });

  it("answers a write-back sent twice with the job it started, never with a second run", async () => {
    const env = await setup({ steps: upStep });
    await copied(env, 2);
    const first = await env.runner.run(restoreReq(OP(2, "-apply")));
    await expect(env.runner.run(restoreReq(OP(2, "-apply")))).resolves.toEqual(first);
    const done = await settled(env.runner, OP(2, "-apply"));
    expect(done).toMatchObject({ state: "succeeded" });
    await expect(env.runner.run(restoreReq(OP(2, "-apply")))).resolves.toEqual(done);
    expect(env.createdNames()).toEqual([`hp_bk_${OP(2, "-apply")}_rs_data`, `hp_bk_${OP(2, "-apply")}_rs_db`]);
  });
});

describe("the removal of an application's snapshots", () => {
  it("unlocks the repository without creating it, then forgets and prunes the listed snapshots", async () => {
    const env = await setup({ steps: upStep });
    await copied(env);
    const second = "0f".repeat(32);
    await env.runner.run(forgetReq(OP(3, "-forget"), { snapshotIds: [SNAPSHOT_ID, second] }));
    await expect(settled(env.runner, OP(3, "-forget"))).resolves.toEqual({
      jobId: OP(3, "-forget"),
      state: "succeeded",
      failure: null,
      snapshot: null,
    });
    expect(env.createdNames()).toEqual([`hp_bk_${OP(3, "-forget")}_repo`, `hp_bk_${OP(3, "-forget")}_forget`]);
    const [repo, forget] = env.created;
    expect(repo?.payload.Env).toContain("HP_INIT=0");
    expect(forget?.payload.Cmd).toEqual(["forget", "--prune", SNAPSHOT_ID, second]);
    for (const c of env.created) {
      expect(c.payload.HostConfig.CapAdd).toBeUndefined();
      expect(c.payload.HostConfig.Binds?.filter((b) => b.startsWith("hp_appvol_"))).toEqual([]);
      expect(c.payload.HostConfig.Mounts).toEqual([
        { Type: "bind", Source: repoDir(env), Target: `/backup/repository/stacks/${STACK}`, ReadOnly: false },
      ]);
    }
    await expectClean(env);
  });

  it("has nothing to remove when the repository does not exist", async () => {
    const env = await setup({ steps: (name) => (name.endsWith("_repo") ? { exitCode: 10 } : {}) });
    await env.runner.run(forgetReq(OP(3, "-forget")));
    await expect(settled(env.runner, OP(3, "-forget"))).resolves.toMatchObject({ state: "succeeded", failure: null });
    expect(env.createdNames()).toEqual([`hp_bk_${OP(3, "-forget")}_repo`]);
    await expectClean(env);
  });

  it("fails when the repository cannot be opened or the removal fails", async () => {
    const wrongKey = await setup({ steps: (name) => (name.endsWith("_repo") ? { exitCode: 12 } : {}) });
    await wrongKey.runner.run(forgetReq(OP(3, "-forget")));
    await expect(settled(wrongKey.runner, OP(3, "-forget"))).resolves.toMatchObject({ state: "failed", failure: "wrong_key" });
    expect(wrongKey.createdNames()).toEqual([`hp_bk_${OP(3, "-forget")}_repo`]);

    const locked = await setup({ steps: (name) => (name.endsWith("_forget") ? { exitCode: 11 } : {}) });
    await locked.runner.run(forgetReq(OP(3, "-forget")));
    await expect(settled(locked.runner, OP(3, "-forget"))).resolves.toMatchObject({ state: "failed", failure: "repository_locked" });
    await expectClean(locked);
  });

  it("does not look at the application: a deleted or running one can still lose its old snapshots", async () => {
    const env = await setup();
    env.docker.containers = [containerView("running")];
    env.docker.volumes.clear();
    await env.runner.run(forgetReq(OP(3, "-forget")));
    await expect(settled(env.runner, OP(3, "-forget"))).resolves.toMatchObject({ state: "succeeded" });
    expect(env.lists()).toBe(0);
    expect(env.requests.filter((r) => r.path.startsWith("/volumes/"))).toEqual([]);
  });
});

describe("the job lane of an application", () => {
  /** A copy held inside its upload container until `release()` is called. */
  async function held() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = await setup({
      steps: (name) => (name === `hp_bk_${OP(1)}_up` ? { stdout: summaryLine(), onStart: () => gate } : upStep(name)),
    });
    await expect(env.runner.run(copyReq(OP(1)))).resolves.toMatchObject({ state: "running" });
    return { env, release };
  }

  it("runs one job at a time for an application", async () => {
    const { env, release } = await held();
    await expect(env.runner.run(copyReq(OP(2)))).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    await expect(env.runner.run(restoreReq(OP(2, "-apply")))).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    await expect(env.runner.run(forgetReq(OP(2, "-forget")))).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    // Another application is another lane.
    await expect(env.runner.run(copyReq(OP(3), { stackId: OTHER_STACK, volumeKeys: ["data"] }))).resolves.toMatchObject({
      state: "running",
    });
    release();
    await expect(settled(env.runner, OP(1))).resolves.toMatchObject({ state: "succeeded" });
    await expect(settled(env.runner, OP(3))).resolves.toMatchObject({ state: "succeeded" });
    await expect(env.runner.run(copyReq(OP(2)))).resolves.toMatchObject({ state: "running" });
    await expect(settled(env.runner, OP(2))).resolves.toMatchObject({ state: "succeeded" });
  });

  it("answers a request sent twice with the job it already started, without checking the application again", async () => {
    const { env, release } = await held();
    // One check: the application's containers, then its job containers.
    expect(env.lists()).toBe(2);
    // By now the application could be running again: the job that was accepted is not judged a second time.
    env.docker.containers = [containerView("running")];
    await expect(env.runner.run(copyReq(OP(1)))).resolves.toMatchObject({ jobId: OP(1), state: "running" });
    expect(env.lists()).toBe(2);
    release();
    const done = await settled(env.runner, OP(1));
    expect(done).toMatchObject({ state: "succeeded", snapshot: { snapshotId: SNAPSHOT_ID } });
    await expect(env.runner.run(copyReq(OP(1)))).resolves.toEqual(done);
    expect(env.lists()).toBe(2);
    expect(env.createdNames()).toEqual([`hp_bk_${OP(1)}_repo`, `hp_bk_${OP(1)}_up`]);
  });

  it("keeps a site with the same id in a lane of its own", async () => {
    const { env, release } = await held();
    // A site job on the id of the application is not blocked by the application's lane (it fails later for its own reasons).
    await expect(
      env.runner.run({ action: "forget", jobId: OP(4, "-forget"), siteId: STACK, target: LOCAL_TARGET, snapshotIds: [SNAPSHOT_ID] }),
    ).resolves.toMatchObject({ state: "running" });
    release();
    await settled(env.runner, OP(1));
    await settled(env.runner, OP(4, "-forget"));
  });

  it("forgets its jobs with the process: after a restart the answer is unknown", async () => {
    const env = await setup({ steps: upStep });
    await env.runner.run(copyReq(OP(1)));
    await settled(env.runner, OP(1));
    await expect(env.newRunner().run({ action: "status", jobId: OP(1) })).resolves.toMatchObject({
      jobId: OP(1),
      state: "unknown",
    });
  });
});

describe("the stack engine and a job of the same application (ADR-0038 K4)", () => {
  const REF = { stackId: STACK, organizationId: ORG };
  const BACKUP_RUNNING = {
    code: "RESOURCE_LOCKED",
    reason: "STACK_BUSY",
    message: "A backup or a restore of this application is running",
  };

  /**
   * The stack engine of the same executor on a Docker of its own, sharing the runner's lanes as the production adapter
   * does. Its list of the application's job containers reads the runner's Docker, where the jobs run.
   */
  async function stackEngine(env: Env) {
    const fake = createAppStackFakeEngine();
    const plan = appStackTestPlan(REF);
    const request: AppStackDockerRequest = async (method, endpointPath, body, options) =>
      method === "GET" && endpointPath.includes(encodeURIComponent(`io.hostingpanel.app_backup_of=${STACK}`))
        ? { statusCode: 200, body: Buffer.from(JSON.stringify(env.docker.jobs)) }
        : fake.request(method, endpointPath, body, options);
    const engine = new AppStackEngine({
      request,
      secretsRootDir: await mkdtemp(path.join(env.tmp, "app-secrets-")),
      pullMissingImages: false,
      allowlist: TEST_ALLOWLIST,
      routes: { write: async () => ({ changed: false, hostnames: [] }), remove: async () => false, read: async () => [] },
      proxy: { containerName: "hp_ingress_proxy_test", ensure: async () => undefined },
      readLogs: async () => [],
      backupLanes: env.runner,
    });
    for (const { image } of plan.components) fake.images.set(image, { repoDigests: [image] });
    await engine.prepareAppStack({ plan });
    await engine.createAppStackComponents({ plan });
    fake.log.length = 0;
    const web = { plan, componentKey: "web", secretFileContents: [] };
    return {
      engine,
      fake,
      plan,
      /** The calls that would make the application run, or change what it is made of, under a job. */
      guarded: [
        () => engine.startAppStackComponent(web),
        () => engine.restartAppStackComponent(web),
        () => engine.removeAppStackComponents({ plan, componentKeys: ["worker"] }),
        () => engine.createAppStackComponents({ plan }),
        () => engine.removeAppStack({ ...REF, removeVolumes: true }),
      ],
    };
  }
  type StackEngine = Awaited<ReturnType<typeof stackEngine>>;

  async function expectEngineRefused(s: StackEngine): Promise<void> {
    for (const call of s.guarded) await expect(call()).rejects.toMatchObject(BACKUP_RUNNING);
    expect(s.fake.log).toEqual([]);
  }

  async function expectEngineFree(s: StackEngine): Promise<void> {
    for (const call of s.guarded) await expect(call()).resolves.toBeDefined();
  }

  /** Bounded by time, not by turns of the event loop: what it waits for may follow file work, slow on a loaded runner. */
  async function until(done: () => boolean): Promise<void> {
    const deadline = performance.now() + 5_000;
    while (!done() && performance.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(done()).toBe(true);
  }

  it("refuses start, restart, create and remove while a restore writes, before any Engine request; stop passes", async () => {
    const env = await setup({ steps: upStep });
    await copied(env, 2);
    const s = await stackEngine(env);
    const apply = OP(2, "-apply");
    const writing = env.gate(new RegExp(`^POST /containers/id_hp_bk_${apply}_rs_data/start$`));
    await expect(env.runner.run(restoreReq(apply))).resolves.toMatchObject({ state: "running" });
    await writing.reached;
    await expectEngineRefused(s);
    // Stopping never harms a copy or a restore.
    await expect(s.engine.stopAppStack(REF)).resolves.toMatchObject({ components: expect.any(Array) });
    writing.release();
    await expect(settled(env.runner, apply)).resolves.toMatchObject({ state: "succeeded" });
    await expectEngineFree(s);
  });

  it("holds the lane from the acceptance of a job, before its first container, to the end of its clean-up after a kill", async () => {
    const env = await setup({ steps: upStep });
    await copied(env, 2);
    const s = await stackEngine(env);
    const apply = OP(2, "-apply");
    const creating = env.gate(new RegExp(`^POST /containers/create\\?name=hp_bk_${apply}_rs_data$`));
    const hung = env.gate(new RegExp(`^POST /containers/id_hp_bk_${apply}_rs_data/wait$`));
    const removing = env.gate(new RegExp(`^DELETE /containers/id_hp_bk_${apply}_rs_data\\?`));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanups.push(async () => vi.useRealTimers());

    await env.runner.run(restoreReq(apply));
    await creating.reached;
    await expectEngineRefused(s);
    creating.release();
    await hung.reached;
    await vi.advanceTimersByTimeAsync(BACKUP_RESTORE_FETCH_TIMEOUT_MS);
    await removing.reached;
    expect(env.requests).toContainEqual(expect.objectContaining({ method: "POST", path: `/containers/id_hp_bk_${apply}_rs_data/kill` }));
    await expectEngineRefused(s);
    removing.release();
    hung.release();
    await expect(settled(env.runner, apply)).resolves.toMatchObject({ state: "failed", failure: "timeout" });
    await expectEngineFree(s);
  });

  it("refuses start, restart, create and remove while a job container whose kill and removal failed still runs, after the lane is free", async () => {
    const env = await setup({ steps: upStep });
    await copied(env, 2);
    const s = await stackEngine(env);
    const apply = OP(2, "-apply");
    const hung = env.gate(new RegExp(`^POST /containers/id_hp_bk_${apply}_rs_data/wait$`));
    env.docker.jobRemovalStatus = 500;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    cleanups.push(async () => vi.useRealTimers());

    await env.runner.run(restoreReq(apply));
    await hung.reached;
    await vi.advanceTimersByTimeAsync(BACKUP_RESTORE_FETCH_TIMEOUT_MS);
    hung.release();
    await expect(settled(env.runner, apply)).resolves.toMatchObject({ state: "failed", failure: "timeout" });
    expect(env.requests).toContainEqual(expect.objectContaining({ method: "POST", path: `/containers/id_hp_bk_${apply}_rs_data/kill` }));
    expect(env.requests).toContainEqual(
      expect.objectContaining({ method: "DELETE", path: `/containers/id_hp_bk_${apply}_rs_data?force=true&v=true` }),
    );
    const lane = env.runner.holdAppStackLane(STACK);
    expect(lane).not.toBeNull();
    lane?.();

    // Both answered 500: Docker still runs the job container, which may go on writing the volumes.
    env.docker.jobs = [leftoverJob("running")];
    for (const call of s.guarded) await expect(call()).rejects.toMatchObject({ code: "RESOURCE_LOCKED", reason: "STACK_BUSY" });
    expect(s.fake.log).toEqual([]);
    // Once it reads as exited it writes nothing: the application starts again.
    env.docker.jobs = [leftoverJob("exited")];
    await expectEngineFree(s);
  });

  it("refuses a change of the engine that arrives while a job's check reads Docker", async () => {
    const env = await setup({ steps: upStep });
    const s = await stackEngine(env);
    const checking = env.gate(/^GET \/containers\/json/);
    const accepted = env.runner.run(copyReq(OP(1)));
    await checking.reached;
    await expectEngineRefused(s);
    checking.release();
    await expect(accepted).resolves.toMatchObject({ state: "running" });
    await expect(settled(env.runner, OP(1))).resolves.toMatchObject({ state: "succeeded" });
    await expectEngineFree(s);
  });

  it("refuses a copy or a restore while the engine starts the application, before the application is looked at", async () => {
    const env = await setup({ steps: upStep });
    await copied(env, 2);
    const s = await stackEngine(env);
    const held = s.fake.hold(/^POST \/containers\/[^/]+\/start$/);
    const starting = s.engine.startAppStackComponent({ plan: s.plan, componentKey: "web", secretFileContents: [] });
    await until(() => s.fake.log.some((line) => line.endsWith("/start")));
    for (const req of [copyReq(OP(3)), restoreReq(OP(2, "-apply"))]) {
      await expect(env.runner.run(req)).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    }
    expect(env.requests).toEqual([]);
    held.release();
    await expect(starting).resolves.toMatchObject({ outcome: "started" });
    await expect(env.runner.run(copyReq(OP(3)))).resolves.toMatchObject({ state: "running" });
    await expect(settled(env.runner, OP(3))).resolves.toMatchObject({ state: "succeeded" });
  });

  it("gives the lane and the job slot back when the check refuses", async () => {
    const env = await setup({ steps: upStep });
    const s = await stackEngine(env);
    env.docker.containers = [containerView("running")];
    for (const n of [1, 2, 3]) await expect(env.runner.run(copyReq(OP(n)))).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    await expect(s.guarded[0]!()).resolves.toMatchObject({ outcome: "started" });
    env.docker.containers = [containerView("exited")];
    await expect(env.runner.run(copyReq(OP(4)))).resolves.toMatchObject({ state: "running" });
    await expect(env.runner.run(copyReq(OP(5), { stackId: OTHER_STACK, volumeKeys: ["data"] }))).resolves.toMatchObject({
      state: "running",
    });
    await settled(env.runner, OP(4));
    await settled(env.runner, OP(5));
  });

  it("is shared by the runner and the engine of the production adapter", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-runner-lane-"));
    cleanups.push(() => rm(tmp, { recursive: true, force: true }));
    const adapter = new DockerEngineSocketAdapter({
      // No Docker answers here: a request that reached it would fail with DOCKER_ENGINE_UNAVAILABLE.
      dockerSocketPath: path.join(tmp, "docker.sock"),
      secretsRootDir: path.join(tmp, "secrets"),
      ingressRootDir: path.join(tmp, "ingress"),
      pullMissingImages: false,
      appImageAllowlist: TEST_ALLOWLIST,
    });
    const runner = (adapter as unknown as { readonly backupRunner: BackupRunner }).backupRunner;
    const web = { plan: appStackTestPlan(REF), componentKey: "web", secretFileContents: [] };
    const release = runner.holdAppStackLane(STACK);
    expect(release).not.toBeNull();
    await expect(adapter.startAppStackComponent(web)).rejects.toMatchObject(BACKUP_RUNNING);
    release?.();
    await expect(adapter.startAppStackComponent(web)).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
  });
});
