// QA (M6a): the executor's edges with no key, the legacy key and an unknown key; the test type's texts; the restore note.
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHARED_MARIADB_IMAGE, type BackupsIpcRequest, type BackupTarget, type SftpAccessUser } from "@hosting-panel/contracts";
import { createApprovedServiceSpec } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  DockerEngineSocketAdapter,
  MANAGED_DOCKER_LABELS,
  SiteFilesHelpers,
  buildSiteFilesHelperPayload,
  buildSiteFilesProgram,
  reapTerminalShells,
  renderSftpUserFiles,
  startDockerTerminal,
  type DockerExecTarget,
} from "../src/index.js";
import { BackupRunner, type DockerRequest } from "../src/backup-runner.js";
import { buildRestoreFetchScript, buildRestoreFilesScript, readRestoreNote, writeRestoreNote } from "../src/restore-jobs.js";
import { InMemoryDockerSimulatorAdapter } from "../src/simulator-adapter.js";
import { makeDir } from "../src/simulator-files.js";
import type { SimulatorSiteType } from "../src/simulator-site-types.js";
import { WORDPRESS_SIMULATOR_SITE_TYPE } from "../src/simulator-wordpress-files.js";
import { WORDPRESS_EXECUTOR_SITE_TYPE, type ExecutorSiteType } from "../src/site-types/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";
import { TEST_EXECUTOR_SITE_TYPE } from "./support/test-site-type.js";

const T = TEST_EXECUTOR_SITE_TYPE;
const FIXTURES = fileURLToPath(new URL("./fixtures/site-type-pins/", import.meta.url));
// The boundary scan's words and WordPress's values (apps/api/test/site-type-boundary.test.ts), plus the program file.
const SCAN = /wordpress|wp-|wp_|\/var\/www\/html|33:33|"html"|_html\b|tpl_site_wordpress|"wp"|\.maintenance|mu-plugins|www-data|hp-files\.php/i;
const JOB = `op_${"f0".repeat(16)}`;
const ids = { jobId: JOB, siteId: "site_edge", serviceInstanceId: "svc_edge" };
const TARGET: BackupTarget = {
  endpoint: "https://s3.example.test:9000",
  region: "eu-central-1",
  bucket: "edge-backups",
  prefix: "",
  accessKeyId: "sentinel-access-key",
  secretAccessKey: "sentinel-secret-key",
};
const HASH = `$6$sentinelsalt$${"sentinelhashone".repeat(6).slice(0, 86)}`;
const UNKNOWN = "teststatic"; // a key this release's schemas do not know

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hp-edge-qa-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const code = (p: Promise<unknown>) => p.then(() => "resolved", (e: { code?: string }) => e.code);

/** Records every Docker call and answers from a table. */
function fakeTarget(answer: (method: string, urlPath: string) => { statusCode: number; body?: unknown }) {
  const calls: Call[] = [];
  const target: DockerExecTarget = {
    socketPath: "/nonexistent/edge-docker.sock",
    apiPrefix: "/v1.45",
    request: (method, urlPath, jsonBody) => {
      calls.push({ method, path: urlPath, body: jsonBody });
      const { statusCode, body } = answer(method, urlPath);
      return Promise.resolve({ statusCode, body: Buffer.from(body === undefined ? "" : JSON.stringify(body)) });
    },
  };
  return { target, calls };
}

/** Every Docker call of one files request through the helpers. */
async function filesCalls(siteType: string | undefined, resolveSiteType?: (k: string) => ExecutorSiteType): Promise<{ calls: Call[]; outcome: string | undefined }> {
  const { target, calls } = fakeTarget((method, urlPath) => {
    if (method === "GET" && urlPath.startsWith("/containers/hp_files_")) return { statusCode: 404 };
    if (method === "GET" && urlPath.startsWith("/volumes/")) return { statusCode: 200, body: { Labels: { "io.hostingpanel.site_id": "site_edge" } } };
    if (method === "GET" && urlPath.startsWith("/containers/json")) return { statusCode: 200, body: [] };
    if (method === "GET" && urlPath.startsWith("/images/")) return { statusCode: 200, body: {} };
    if (method === "POST" && urlPath.startsWith("/containers/create")) return { statusCode: 201, body: { Id: "ctr_edge_helper" } };
    if (method === "POST" && urlPath.endsWith("/start")) return { statusCode: 204 };
    return { statusCode: 500 };
  });
  const helpers = new SiteFilesHelpers({ target, programDir: "/srv/hp-files", ...(resolveSiteType ? { resolveSiteType } : {}) });
  const req = { serviceInstanceId: "svc_edge", op: "list", path: "", ...(siteType === undefined ? {} : { siteType }) } as never;
  try {
    return { outcome: await code(helpers.run(req)), calls };
  } finally {
    helpers.stop();
  }
}

/** A BackupRunner over a fake Docker that records every call; containers exit 0 unless `exit` says otherwise. */
async function setupRunner(opts: { resolveSiteType?: (k: string) => ExecutorSiteType; exit?: (name: string) => number; onCall?: (method: string, urlPath: string, body: unknown) => Promise<{ statusCode: number; body: Buffer } | undefined> } = {}) {
  const tmp = await tempDir();
  const secretsRootDir = path.join(tmp, "secrets");
  await mkdir(secretsRootDir, { mode: 0o700 });
  await chmod(secretsRootDir, 0o700);
  const backupKeyFile = path.join(tmp, "backup.key");
  await writeFile(backupKeyFile, `${"5e".repeat(32)}\n`, { mode: 0o400 });
  const sharedDbRootKeyFile = path.join(tmp, "mariadb-root.key");
  await writeFile(sharedDbRootKeyFile, "sentinel-root-password\n", { mode: 0o400 });
  const calls: Call[] = [];
  const created: Array<{ name: string; body: Record<string, unknown> }> = [];
  const ensured: string[] = [];
  const asked: string[] = [];
  const request: DockerRequest = async (method, urlPath, body) => {
    calls.push(body === undefined ? { method, path: urlPath } : { method, path: urlPath, body });
    const url = new URL(`http://docker${urlPath}`);
    const json = (statusCode: number, value?: unknown) => ({ statusCode, body: Buffer.from(value === undefined ? "" : JSON.stringify(value)) });
    const forced = await opts.onCall?.(method, url.pathname, body);
    if (forced !== undefined) return forced;
    if (method === "POST" && url.pathname === "/containers/create") {
      const name = url.searchParams.get("name") ?? "";
      created.push({ name, body: body as Record<string, unknown> });
      return json(201, { Id: name });
    }
    const m = /^\/containers\/([^/]+)\/(start|wait|logs)$/.exec(url.pathname);
    if (m?.[2] === "start") return json(204);
    if (m?.[2] === "wait") return json(200, { StatusCode: opts.exit?.(m[1]!) ?? 0 });
    if (m?.[2] === "logs") return { statusCode: 200, body: Buffer.alloc(0) };
    if (method === "DELETE") return json(204);
    if (method === "POST" && url.pathname === "/volumes/create") return json(201, {});
    if (method === "GET" && url.pathname.startsWith("/volumes/")) return json(200, {});
    if (method === "GET" && url.pathname === "/volumes") return json(200, { Volumes: [] });
    if (method === "GET" && url.pathname === "/containers/json") return json(200, []);
    return json(500, { message: "refused by the edge fake" });
  };
  const runner = new BackupRunner({
    request,
    ensureImage: async (image) => {
      ensured.push(image);
    },
    ensureBackupNetwork: async () => undefined,
    listSiteDatabases: async () => [],
    secretsRootDir,
    backupKeyFile,
    sharedDbRootKeyFile,
    sharedDbNetworkName: "hp_db_net",
    backupNetworkName: "hp_backup_net",
    executorUser: "990:990",
    backupWorkDir: path.join(tmp, "work"),
    sharedDbDataDir: path.join(tmp, "db-data"),
    statfs: async () => ({ bavail: 1_000_000, bsize: 4096 }),
    now: () => Date.parse("2026-11-17T08:00:00.000Z"),
    fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") return new Response("<ListBucketResult/>", { status: 200 });
      return new Response(null, { status: method === "DELETE" ? 204 : 200 });
    }) as typeof globalThis.fetch,
    ...(opts.resolveSiteType
      ? {
          resolveSiteType: (k: string) => {
            asked.push(k);
            return opts.resolveSiteType!(k);
          },
        }
      : {}),
  });
  const restoresDir = path.join(tmp, "work", "restores");
  const norm = (v: unknown) => JSON.parse(JSON.stringify(v).split(tmp).join("<tmp>")) as unknown;
  return { runner, calls, created, ensured, asked, restoresDir, norm };
}

async function settle(runner: BackupRunner, jobId: string): Promise<unknown> {
  const until = performance.now() + 5_000;
  for (;;) {
    const status = await runner.run({ action: "status", jobId });
    if (status.state !== "running") return status;
    if (performance.now() > until) throw new Error(`job ${jobId} did not settle`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** One backup start through a fresh runner: the normalised calls, or the refusal. */
async function backupCalls(siteType: string | undefined): Promise<{ outcome: string | undefined; calls: unknown }> {
  const { runner, calls, norm } = await setupRunner();
  const req = { action: "start", ...ids, target: TARGET, ...(siteType === undefined ? {} : { siteType }) } as BackupsIpcRequest;
  const outcome = await code(runner.run(req));
  if (outcome === "resolved") await settle(runner, JOB);
  return { outcome, calls: norm(calls) };
}

/** One SFTP apply through the adapter over the mock daemon: the paths it asked and the files it wrote. */
async function sftpCalls(siteType: string | undefined): Promise<{ outcome: string | undefined; paths: string[]; written: unknown }> {
  const tmp = await tempDir();
  const daemon = await startMockDockerDaemon();
  cleanup.push(() => daemon.close());
  const sftpStateDir = path.join(tmp, "sftp");
  await mkdir(sftpStateDir, { mode: 0o700 });
  await chmod(sftpStateDir, 0o700);
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: daemon.socketPath,
    secretsRootDir: path.join(tmp, "secrets"),
    ingressRootDir: path.join(tmp, "ingress"),
    pullMissingImages: false,
    sftpStateDir,
  });
  const users = [
    { username: "edgea_web", passwordHash: HASH, siteId: "site_edge", serviceInstanceId: "svc_edge", ...(siteType === undefined ? {} : { siteType }) },
  ] as SftpAccessUser[];
  const outcome = await code(adapter.applySftpAccess({ users }));
  const read = async (f: string) => readFile(path.join(sftpStateDir, f), "utf8").catch(() => null);
  return { outcome, paths: [...daemon.requestedPaths], written: { passwd: await read("passwd"), group: await read("group"), shadow: await read("shadow") } };
}

/** One terminal open through the adapter over the mock daemon: the exec bodies and the paths asked. */
async function terminalCalls(siteType: string | undefined): Promise<{ outcome: string | undefined; paths: string[]; execs: unknown }> {
  const tmp = await tempDir();
  const daemon = await startMockDockerDaemon({ execUpgrade: true });
  cleanup.push(() => daemon.close());
  daemon.containers.set("hp_site_edge_id", {
    id: "hp_site_edge_id", name: "hp_site_edge", image: "hp-edge:1", env: [], running: true, status: "running",
    restartCount: 0, startedAt: "2026-11-17T08:00:00.000000001Z", hostConfig: {}, networks: {},
    labels: { [MANAGED_DOCKER_LABELS.siteId]: "site_edge", [MANAGED_DOCKER_LABELS.serviceInstanceId]: "svc_edge" },
  });
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: daemon.socketPath,
    secretsRootDir: path.join(tmp, "secrets"),
    ingressRootDir: path.join(tmp, "ingress"),
    terminalLimits: { readWaitMs: 2_000 },
  });
  const sessionId = `term_${"e4".repeat(16)}`;
  cleanup.push(() => adapter.closeTerminal({ sessionId }).catch(() => undefined));
  const req = { sessionId, siteId: "site_edge", serviceInstanceId: "svc_edge", ...(siteType === undefined ? {} : { siteType }) } as never;
  const outcome = await code(adapter.openTerminal(req));
  return { outcome, paths: [...daemon.requestedPaths], execs: [...daemon.execBodies] };
}

describe("D.1 the edges: no key and the legacy key give the same bytes, an unknown key reaches no client", () => {
  it("files", async () => {
    const none = await filesCalls(undefined);
    expect(none.calls.length).toBeGreaterThan(0);
    expect(await filesCalls("wordpress")).toEqual(none);
    expect(await filesCalls(UNKNOWN)).toEqual({ outcome: "VALIDATION_ERROR", calls: [] });
  });

  it("backups", async () => {
    const none = await backupCalls(undefined);
    expect(none.outcome).toBe("resolved");
    expect(await backupCalls("wordpress")).toEqual(none);
    expect(await backupCalls(UNKNOWN)).toEqual({ outcome: "VALIDATION_ERROR", calls: [] });
  });

  it("SFTP users", async () => {
    const none = await sftpCalls(undefined);
    expect(none.paths.some((p) => p.includes("/volumes/"))).toBe(true);
    expect(await sftpCalls("wordpress")).toEqual(none);
    expect(await sftpCalls(UNKNOWN)).toEqual({ outcome: "VALIDATION_ERROR", paths: [], written: { passwd: null, group: null, shadow: null } });
  });

  it("terminal open", async () => {
    const none = await terminalCalls(undefined);
    expect(none.outcome).toBe("resolved");
    expect(await terminalCalls("wordpress")).toEqual(none);
    expect(await terminalCalls(UNKNOWN)).toEqual({ outcome: "VALIDATION_ERROR", paths: [], execs: [] });
  });
});

describe("D.2 every text the executor generates for the test type", () => {
  // Parts already covered one by one: site-type-seam-files.test.ts (program, helper create and exec, SFTP passwd and
  // volume, terminal execs) and site-type-seam-backups.test.ts (upload, restore builders, scripts). This joins them all.
  it("joined, holds none of the scan's words or WordPress's values", async () => {
    const texts: unknown[] = [];
    texts.push(buildSiteFilesProgram(T), buildRestoreFilesScript(T), buildRestoreFetchScript(T));
    texts.push(buildSiteFilesHelperPayload({ image: "hp-test-static-helper:1", serviceInstanceId: "svc_edge", siteId: "site_edge", programDir: "/srv/hp-files", siteType: T }));
    texts.push((await filesCalls(undefined, () => T)).calls.filter((c) => !c.path.startsWith("/containers/json")));
    texts.push(renderSftpUserFiles([{ username: "edgea_web", passwordHash: HASH, siteId: "site_edge", serviceInstanceId: "svc_edge" }], () => T));
    const { target, calls } = fakeTarget((method, urlPath) => {
      if (method === "GET" && urlPath.startsWith("/containers/json")) return { statusCode: 200, body: [{ Id: "ctr_edge_site" }] };
      return method === "GET"
        ? { statusCode: 200, body: { Name: "/hp_site_edge", State: { Running: true, StartedAt: "2026-11-17T08:00:00Z" }, ExecIDs: ["exec_edge"] } }
        : { statusCode: 500 };
    });
    await startDockerTerminal(target, "ctr_edge_site", `term_${"5f".repeat(16)}`, { data: () => undefined, exit: () => undefined }, T).catch(() => undefined);
    await reapTerminalShells(target, T).catch(() => undefined);
    texts.push(calls.filter((c) => c.path.endsWith("/exec")));

    const { runner, created, ensured, restoresDir } = await setupRunner({ resolveSiteType: () => T });
    await runner.run({ action: "start", ...ids, target: TARGET });
    await settle(runner, JOB);
    const restoreJob = `op_${"f1".repeat(16)}`;
    await runner.run({ action: "restore", ...ids, jobId: restoreJob, target: TARGET, snapshotId: "5a".repeat(32) });
    await settle(runner, restoreJob);
    const crashed = `op_${"f2".repeat(16)}`;
    await writeRestoreNote(restoresDir, { v: 1, ...ids, jobId: crashed, stage: "switch", siteType: "teststatic" });
    await runner.settleRestores();
    await settle(runner, crashed);
    expect(created.length).toBeGreaterThan(4);
    // R205 addendum 5: the panel's own restic repository container runs as 33:33 for every type; it mounts no site volume.
    const repo = created.filter((c) => c.name.endsWith("_repo"));
    expect(repo.every((c) => !JSON.stringify(c.body).includes("hp_vol_"))).toBe(true);
    texts.push(created.map((c) => (c.name.endsWith("_repo") ? { ...c, body: { ...c.body, User: null } } : c)), ensured);
    texts.push(await readFile(path.join(restoresDir, `${restoreJob}.json`), "utf8"));

    const joined = texts.map((t) => (typeof t === "string" ? t : JSON.stringify(t))).join("\n");
    expect(joined.match(new RegExp(SCAN.source, "gi"))).toBeNull();
  });
});

describe("D.3 the restore note", () => {
  it("the legacy type's note is the pin fixture's bytes, field for field", async () => {
    const { runner } = await setupRunner();
    // The ended note the runner builds, for the legacy key and for no key.
    const ended = (siteType?: string) =>
      (runner as unknown as { endedRestoreNote: (m: object, s: string, f: string) => object }).endedRestoreNote(
        { jobId: `op_${"c0".repeat(16)}`, siteId: "site_pin_a", serviceInstanceId: "svc_pin_a", ...(siteType ? { siteType } : {}) },
        "failed",
        "restore_prepare_failed",
      );
    expect(ended("wordpress")).toEqual(ended());
    expect(ended("wordpress")).not.toHaveProperty("siteType");
    const dir = path.join(await tempDir(), "restores");
    await writeRestoreNote(dir, { ...ended("wordpress"), createdVolume: true } as never);
    expect(await readFile(path.join(dir, `op_${"c0".repeat(16)}.json`), "utf8")).toBe(await readFile(path.join(FIXTURES, "restore-note.json"), "utf8"));
  });

  it("the test type's note carries its key, from a real restore", async () => {
    const { runner, restoresDir } = await setupRunner({ resolveSiteType: () => T });
    await runner.run({ action: "restore", ...ids, target: TARGET, snapshotId: "5a".repeat(32) });
    await settle(runner, JOB);
    const note = JSON.parse(await readFile(path.join(restoresDir, `${JOB}.json`), "utf8")) as Record<string, unknown>;
    expect(note.siteType).toBe("teststatic");
    expect(Object.keys(note).slice(0, 5)).toEqual(["v", "jobId", "siteId", "serviceInstanceId", "siteType"]);
  });

  it("a note without the field is read as the legacy type when it is settled", async () => {
    const { runner, asked, created, restoresDir } = await setupRunner({ resolveSiteType: () => WORDPRESS_EXECUTOR_SITE_TYPE });
    await writeRestoreNote(restoresDir, { v: 1, ...ids, stage: "prepare" });
    await runner.settleRestores();
    await settle(runner, JOB);
    expect(asked).toEqual(["wordpress"]);
    expect(created.length).toBeGreaterThan(0);
    expect(await readRestoreNote(restoresDir, JOB)).not.toHaveProperty("siteType");
  });

  it("a note with a key this release does not know runs no container and keeps the volume", async () => {
    const { runner, created, restoresDir } = await setupRunner();
    await writeRestoreNote(restoresDir, { v: 1, ...ids, stage: "switch", siteType: "zzunknown" });
    await runner.settleRestores();
    expect(await settle(runner, JOB)).toMatchObject({ state: "failed", failure: "undo_incomplete" });
    expect(created).toEqual([]);
    expect(await readRestoreNote(restoresDir, JOB)).toMatchObject({ stage: "ended", siteType: "zzunknown" });
  });
});

describe("B5 the notes in the middle of a restore", () => {
  /** Every distinct note on disk at each Docker call of one restore, the site volume missing when createVolume is set. */
  async function stageNotes(siteType: string | undefined, resolveSiteType: (k: string) => ExecutorSiteType, createVolume: boolean) {
    const notes = new Map<string, Record<string, unknown>>();
    let restoresDir = "";
    let volumeMade = false;
    const run = await setupRunner({
      resolveSiteType,
      onCall: async (method, urlPath, body) => {
        const text = await readFile(path.join(restoresDir, `${JOB}.json`), "utf8").catch(() => null);
        if (text !== null) notes.set(text, JSON.parse(text) as Record<string, unknown>);
        if (method === "POST" && urlPath === "/volumes/create" && (body as { Name?: string }).Name?.startsWith("hp_vol_")) volumeMade = true;
        if (createVolume && !volumeMade && method === "GET" && urlPath.startsWith("/volumes/hp_vol_")) return { statusCode: 404, body: Buffer.alloc(0) };
        // The fetch step prints the dump's size in KiB, one stdout frame.
        if (urlPath.endsWith("_rs_fetch/logs")) return { statusCode: 200, body: Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 0, 0, 5]), Buffer.from("4096\n")]) };
        return undefined;
      },
    });
    restoresDir = run.restoresDir;
    await run.runner.run({ action: "restore", ...ids, target: TARGET, snapshotId: "5a".repeat(32), ...(siteType ? { siteType } : {}), ...(createVolume ? { createVolume: true } : {}) } as BackupsIpcRequest);
    expect(await settle(run.runner, JOB)).toMatchObject({ state: "succeeded" });
    return [...notes.values()].filter((n) => n.stage !== "ended");
  }

  for (const [label, siteType, resolve, hasKey] of [
    ["no key", undefined, () => WORDPRESS_EXECUTOR_SITE_TYPE, false],
    ["the key wordpress", "wordpress", () => WORDPRESS_EXECUTOR_SITE_TYPE, false],
    ["the test type", undefined, () => T, true],
  ] as const) {
    it(`a restore with ${label} writes the four stage notes ${hasKey ? "with" : "without"} an own key siteType`, async () => {
      const notes = [...(await stageNotes(siteType, resolve, false)), ...(await stageNotes(siteType, resolve, true))];
      // The four writes: prepare, prepare with createdVolume, switch, switched.
      expect(new Set(notes.map((n) => `${String(n.stage)}${n.createdVolume === true ? "+created" : ""}`))).toEqual(
        new Set(["prepare", "prepare+created", "switch", "switch+created", "switched", "switched+created"]),
      );
      for (const n of notes) {
        expect(Object.hasOwn(n, "siteType"), JSON.stringify(n)).toBe(hasKey);
        if (hasKey) expect(n.siteType).toBe("teststatic");
      }
    });
  }
});

describe("F.1 an executor crash at stage switch for a type without a database", () => {
  it("settle reads the type from the note, undoes the files, runs the finish and starts no database container", async () => {
    const { runner, created, ensured, asked, restoresDir } = await setupRunner({ resolveSiteType: () => T });
    await writeRestoreNote(restoresDir, { v: 1, ...ids, stage: "switch", siteType: "teststatic" });
    await runner.settleRestores();
    const status = await settle(runner, JOB);
    expect(asked).toEqual(["teststatic"]);
    const steps = created.map((c) => [c.name.slice(JOB.length + 7), c.body.Image, (c.body.Env as string[] | undefined)?.find((e) => e.startsWith("HP_STEP="))]);
    expect(steps).toEqual([
      ["rs_undo_files", "hp-test-static-files:1", "HP_STEP=undo"],
      ["rs_finish", "hp-test-static-files:1", "HP_STEP=finish"],
    ]);
    expect(ensured).not.toContain(SHARED_MARIADB_IMAGE);
    expect(created.every((c) => c.body.Image !== SHARED_MARIADB_IMAGE)).toBe(true);
    expect(status).toMatchObject({ state: "failed" });
    expect(await readRestoreNote(restoresDir, JOB)).toMatchObject({ stage: "ended", state: "failed", siteType: "teststatic" });
  });
});

describe("F.3 the simulator: a type registered from outside, and two types side by side", () => {
  const TEST_SIM: SimulatorSiteType = {
    def: T.def,
    protectedPaths: [],
    shellId: "uid=1000 gid=1000 groups=1000",
    seed: () => makeDir(),
    ops: [],
    createOps: null,
  };
  const list = (sim: InMemoryDockerSimulatorAdapter, svc: string, siteType?: string) =>
    sim.siteFiles({ serviceInstanceId: svc, op: "list" as const, path: "", ...(siteType ? { siteType } : {}) } as never as { serviceInstanceId: string; op: "list"; path: string });

  it("a request of the legacy type never sees the test type's tree", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    await sim.deployService(
      createApprovedServiceSpec({
        serviceInstanceId: "svc_wp", siteId: "site_wp", organizationId: "org_1", image: "hp-edge:1", containerName: "hp_svc_svc_wp",
        volumeMounts: [{ volumeSuffix: "html", containerPath: "/var/www/html" }],
      }),
    );
    sim.files.create("svc_static", TEST_SIM);
    expect((await list(sim, "svc_wp")).entries.length).toBeGreaterThan(0);
    expect(await code(list(sim, "svc_static"))).toBe("NOT_FOUND");
    expect(await code(list(sim, "svc_static", "wordpress"))).toBe("NOT_FOUND");
  });

  it("a request of the test type never sees WordPress's tree", async () => {
    const sim = new InMemoryDockerSimulatorAdapter({ resolveSiteType: () => TEST_SIM });
    sim.files.create("svc_wp", WORDPRESS_SIMULATOR_SITE_TYPE);
    sim.files.create("svc_static", TEST_SIM);
    expect((await list(sim, "svc_static")).entries).toEqual([]);
    expect(await code(list(sim, "svc_wp"))).toBe("NOT_FOUND");
  });
});
