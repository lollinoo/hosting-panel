// QA (cycle 8): independent tests of the import job kinds; the engineers' own tests live in site-jobs.test.ts.
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SHARED_MARIADB_IMAGE, WORDPRESS_RESULT_MAX_BYTES, resolveWordpressCliImage, siteDatabasePrefix } from "@hosting-panel/contracts";
import type { SiteJobRequest } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerEngineSocketAdapter, SHARED_DB_CONTAINER_NAME, SHARED_DB_NETWORK_NAME } from "../src/index.js";
import { SIMULATED_WORDPRESS_STATE } from "../src/simulator-adapter.js";
import {
  DB_IMPORT_LOAD_SCRIPT,
  DB_IMPORT_SCRIPT,
  WORDPRESS_IMPORT_FINALIZE_SCRIPT,
  WORDPRESS_SET_URL_SCRIPT,
  buildSiteJobContainerPayload,
  parseWordpressJobResult,
  type SiteJobCreatePayload,
} from "../src/site-jobs.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const cleanupTasks: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const task of cleanupTasks.splice(0).reverse()) await task();
});

const IMPORT_ID = "0123456789abcdef0123456789abcdef";
// Sentinels, never real secrets.
const IMPORT_PW = "c0ffee".repeat(10) + "c0de";
const JOB_MEMORY = 536_870_912;
type ImportKind = "db.import" | "db.import-load" | "wordpress.import-finalize";

function req(kind: ImportKind, overrides?: Partial<SiteJobRequest>): SiteJobRequest {
  const params: Record<ImportKind, Record<string, string>> = {
    "db.import": { step: "switch", importId: IMPORT_ID },
    "db.import-load": { importId: IMPORT_ID },
    "wordpress.import-finalize": {
      phpVersion: "8.4",
      tablePrefix: "wp_",
      siteUrl: "http://wp-a.example.test",
      previousUrl: "http://old.example.test",
    },
  };
  return {
    jobId: "job_qa_import_1",
    kind,
    siteId: "site_qa",
    organizationId: "org_qa",
    ...(kind === "db.import" ? {} : { serviceInstanceId: "svc_qa" }),
    params: params[kind],
    ...(kind === "db.import-load" ? { resolvedSecrets: { HP_IMPORT_DB_PASSWORD: IMPORT_PW } } : {}),
    ...overrides,
  };
}

async function harness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hp-qa-import-"));
  cleanupTasks.push(() => rm(dir, { recursive: true, force: true }));
  const daemon = await startMockDockerDaemon({ waitStatusCode: 0 });
  cleanupTasks.push(() => daemon.close());
  const rootKey = path.join(dir, "mariadb-root.key");
  const secretsRootDir = path.join(dir, "secrets");
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: daemon.socketPath,
    secretsRootDir,
    ingressRootDir: path.join(dir, "ingress"),
    pullMissingImages: false,
    sharedDbRootKeyFile: rootKey,
  });
  daemon.containers.set("mariadb-id", {
    id: "mariadb-id",
    name: SHARED_DB_CONTAINER_NAME,
    image: SHARED_MARIADB_IMAGE,
    env: [],
    labels: {},
    running: true,
    status: "running",
    restartCount: 0,
    hostConfig: {},
    networks: {},
  });
  // The body the adapter really sends to POST /containers/create.
  const created: SiteJobCreatePayload[] = [];
  const client = (adapter as unknown as { dockerClient: { request: (m: string, p: string, b?: unknown) => Promise<unknown> } }).dockerClient;
  const original = client.request.bind(client);
  vi.spyOn(client, "request").mockImplementation((m: string, p: string, b?: unknown) => {
    if (m === "POST" && p.startsWith("/containers/create")) created.push(structuredClone(b) as SiteJobCreatePayload);
    return original(m, p, b);
  });
  return { adapter, daemon, rootKey, secretsRootDir, created };
}

const commandOf = (p: SiteJobCreatePayload) => p.Cmd ?? p.Entrypoint;

/** Every place of the payload, outside the script itself, that holds one of the values. */
function leaks(payload: SiteJobCreatePayload, values: readonly string[]): string[] {
  const out: string[] = [];
  const cmd = JSON.stringify(commandOf(payload));
  for (const v of values) {
    if (cmd.includes(v)) out.push(`command:${v}`);
    if (payload.Env.some((e) => e.includes(v))) out.push(`env:${v}`);
    if (JSON.stringify(payload.Labels).includes(v)) out.push(`label:${v}`);
    if (JSON.stringify(payload.HostConfig).includes(v)) out.push(`hostconfig:${v}`);
  }
  return out;
}

describe("import job payloads, as the adapter sends them", () => {
  it("image, user, networks, binds, command, limits and no socket for each kind and each step", async () => {
    const { adapter, daemon, rootKey, secretsRootDir, created } = await harness();
    const uidGid = `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`;
    const steps = ["prepare", "switch", "undo", "finish"];
    for (const step of steps) {
      await adapter.runSiteJob(
        req("db.import", {
          jobId: `job_qa_${step}`,
          params: { step, importId: IMPORT_ID },
          ...(step === "prepare" ? { resolvedSecrets: { HP_IMPORT_DB_PASSWORD: IMPORT_PW } } : {}),
        }),
      );
    }
    await adapter.runSiteJob(req("db.import-load"));
    await adapter.runSiteJob(req("wordpress.import-finalize"));
    expect(created).toHaveLength(6);
    const secretBind = (jobId: string) => `${path.join(secretsRootDir, jobId, "HP_IMPORT_DB_PASSWORD")}:/run/secrets/HP_IMPORT_DB_PASSWORD:ro`;

    for (const [i, step] of steps.entries()) {
      const p = created[i]!;
      expect(p.Image, step).toBe(SHARED_MARIADB_IMAGE);
      expect(p.User, step).toBe(uidGid);
      expect(p.HostConfig.NetworkMode, step).toBe(SHARED_DB_NETWORK_NAME);
      expect(p.HostConfig.Binds, step).toEqual([
        `${rootKey}:/run/secrets/mariadb-root:ro`,
        ...(step === "prepare" ? [secretBind("job_qa_prepare")] : []),
      ]);
      expect(p.Cmd, step).toEqual(["timeout", "-s", "KILL", "305", "sh", "-c", DB_IMPORT_SCRIPT]);
      expect(p, step).not.toHaveProperty("Entrypoint");
      expect(p, step).not.toHaveProperty("WorkingDir");
      expect(p.HostConfig, step).not.toHaveProperty("Init");
      expect(p.Env.filter((e) => e.startsWith("HP_PREFIX=")), step).toEqual([`HP_PREFIX=${siteDatabasePrefix("site_qa")}`]);
      expect(p.Env.filter((e) => e.startsWith("HP_LOCK_S=")), step).toEqual(["HP_LOCK_S=5"]);
    }

    const load = created[4]!;
    expect(load).toMatchObject({ Image: SHARED_MARIADB_IMAGE, User: "33:33" });
    expect(load.HostConfig.NetworkMode).toBe(SHARED_DB_NETWORK_NAME);
    expect(load.HostConfig.Binds).toEqual(["hp_vol_svc_qa_html:/var/www/html:ro", secretBind("job_qa_import_1")]);
    expect(load.Cmd).toEqual(["timeout", "-s", "KILL", "1505", "sh", "-c", DB_IMPORT_LOAD_SCRIPT]);
    expect(load).not.toHaveProperty("Entrypoint");
    expect(load.HostConfig).not.toHaveProperty("Init");
    expect(JSON.stringify(load)).not.toContain(rootKey);
    expect(load.Env.some((e) => /^HP_(PREFIX|LOCK_S)=/.test(e))).toBe(false);

    const fin = created[5]!;
    expect(fin).toMatchObject({ Image: resolveWordpressCliImage("8.4"), User: "33:33", WorkingDir: "/var/www/html" });
    expect(fin.HostConfig).toMatchObject({ Init: true, NetworkMode: "hp_site_site_qa_net", Binds: ["hp_vol_svc_qa_html:/var/www/html"] });
    // R139: own entrypoint, no Cmd, so the image's start-up script never runs.
    expect(fin.Entrypoint).toEqual(["timeout", "-s", "KILL", "1205", "sh", "-c", WORDPRESS_IMPORT_FINALIZE_SCRIPT]);
    expect(fin).not.toHaveProperty("Cmd");
    expect(JSON.stringify(fin)).not.toContain(rootKey);

    for (const p of created) {
      expect(p.HostConfig).toMatchObject({
        Privileged: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        PidsLimit: 128,
        NanoCpus: 1e9,
        Memory: JOB_MEMORY,
        MemorySwap: JOB_MEMORY,
        RestartPolicy: { Name: "no" },
        LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
      });
      for (const key of ["PortBindings", "CapAdd", "Devices", "Mounts", "NetworkingConfig"]) {
        expect(p.HostConfig).not.toHaveProperty(key);
      }
      expect(p).not.toHaveProperty("ExposedPorts");
      expect(p).not.toHaveProperty("NetworkingConfig");
      expect(JSON.stringify(p)).not.toMatch(/docker\.sock/);
      expect(JSON.stringify(p)).not.toContain(IMPORT_PW);
    }
    // The only network of each job is its NetworkMode: no edge or other connect.
    expect(daemon.networkConnectCalls).toEqual([]);
  });

  it("db.import's HP_PREFIX comes from the site id alone; the load and the finalize carry neither HP_PREFIX nor HP_LOCK_S", () => {
    const ctx = { executorUser: "990:990", secretBinds: [], secretFileEnv: [], rootKeyHostPath: "/k" };
    const a = buildSiteJobContainerPayload(req("db.import", { siteId: "site_a" }), ctx);
    const b = buildSiteJobContainerPayload(req("db.import", { siteId: "site_b" }), ctx);
    expect(a.Env).toContain(`HP_PREFIX=${siteDatabasePrefix("site_a")}`);
    expect(b.Env).toContain(`HP_PREFIX=${siteDatabasePrefix("site_b")}`);
    expect(siteDatabasePrefix("site_a")).toMatch(/^wp_[0-9a-f]{12}$/);
    expect(siteDatabasePrefix("site_a")).not.toBe(siteDatabasePrefix("site_b"));
    for (const kind of ["db.import-load", "wordpress.import-finalize"] as const) {
      const p = buildSiteJobContainerPayload(req(kind), ctx);
      expect(p.Env.some((e) => /^HP_(PREFIX|LOCK_S)=/.test(e)), kind).toBe(false);
    }
  });
});

describe("refused before any container is made", () => {
  const fin = req("wordpress.import-finalize").params;
  const bad: Array<[string, SiteJobRequest]> = [
    ["param prefix on db.import", req("db.import", { params: { step: "switch", importId: IMPORT_ID, prefix: "wp_0123456789ab" } })],
    ["param prefix on finalize", req("wordpress.import-finalize", { params: { ...fin, prefix: "wp_" } })],
    ["unknown param on db.import", req("db.import", { params: { step: "switch", importId: IMPORT_ID, image: "alpine:3" } })],
    ["unknown param on load", req("db.import-load", { params: { importId: IMPORT_ID, step: "prepare" } })],
    ["unknown param on finalize", req("wordpress.import-finalize", { params: { ...fin, dbName: "wp_a" } })],
    ["__proto__ param", req("db.import-load", { params: JSON.parse(`{"importId":"${IMPORT_ID}","__proto__":"x"}`) as Record<string, string> })],
    ["importId upper case", req("db.import", { params: { step: "undo", importId: IMPORT_ID.toUpperCase() } })],
    ["importId 31", req("db.import-load", { params: { importId: IMPORT_ID.slice(1) } })],
    ["importId 33", req("db.import-load", { params: { importId: `${IMPORT_ID}0` } })],
    ["importId non-hex", req("db.import", { params: { step: "undo", importId: `${IMPORT_ID.slice(1)}z` } })],
    ["importId with newline", req("db.import", { params: { step: "undo", importId: `${IMPORT_ID}\n` } })],
    ["importId not a string", req("db.import-load", { params: { importId: 123 as unknown as string } })],
    ["step rollback", req("db.import", { params: { step: "rollback", importId: IMPORT_ID } })],
    ["step padded", req("db.import", { params: { step: " prepare", importId: IMPORT_ID } })],
    ["step missing", req("db.import", { params: { importId: IMPORT_ID } })],
    ["tablePrefix ;", req("wordpress.import-finalize", { params: { ...fin, tablePrefix: "wp;" } })],
    ["tablePrefix quote", req("wordpress.import-finalize", { params: { ...fin, tablePrefix: "wp'" } })],
    ["tablePrefix space", req("wordpress.import-finalize", { params: { ...fin, tablePrefix: "wp _" } })],
    ["tablePrefix 33", req("wordpress.import-finalize", { params: { ...fin, tablePrefix: "a".repeat(33) } })],
    ["tablePrefix empty", req("wordpress.import-finalize", { params: { ...fin, tablePrefix: "" } })],
    ["previousUrl path", req("wordpress.import-finalize", { params: { ...fin, previousUrl: "http://old.example.test/wp" } })],
    ["previousUrl upper", req("wordpress.import-finalize", { params: { ...fin, previousUrl: "http://OLD.example.test" } })],
    ["previousUrl user", req("wordpress.import-finalize", { params: { ...fin, previousUrl: "http://u@old.example.test" } })],
    ["previousUrl user:pw", req("wordpress.import-finalize", { params: { ...fin, previousUrl: "http://u:p@old.example.test" } })],
    ["siteUrl port", req("wordpress.import-finalize", { params: { ...fin, siteUrl: "http://wp-a.example.test:8080" } })],
    ["load without secret", req("db.import-load", { resolvedSecrets: {} })],
    ["secret 63 hex", req("db.import-load", { resolvedSecrets: { HP_IMPORT_DB_PASSWORD: IMPORT_PW.slice(1) } })],
    ["secret upper hex", req("db.import-load", { resolvedSecrets: { HP_IMPORT_DB_PASSWORD: IMPORT_PW.toUpperCase() } })],
    ["secret with quote", req("db.import", { params: { step: "prepare", importId: IMPORT_ID }, resolvedSecrets: { HP_IMPORT_DB_PASSWORD: `${IMPORT_PW.slice(1)}'` } })],
    ["foreign secret on load", req("db.import-load", { resolvedSecrets: { HP_IMPORT_DB_PASSWORD: IMPORT_PW, HP_DB_PASSWORD: "a".repeat(64) } })],
    ["secret on finalize", req("wordpress.import-finalize", { resolvedSecrets: { HP_IMPORT_DB_PASSWORD: IMPORT_PW } })],
    ["load without service", req("db.import-load", { serviceInstanceId: undefined })],
    ["kind outside the list", { ...req("db.import"), kind: "db.import-cleanup" as SiteJobRequest["kind"] }],
    ["kind toString", { ...req("db.import"), kind: "toString" as SiteJobRequest["kind"] }],
  ];

  it("each bad request answers VALIDATION_ERROR and the engine is never called", async () => {
    for (const [name, r] of bad) {
      const { adapter, daemon } = await harness();
      await expect(adapter.runSiteJob(r), name).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(daemon.requestedPaths, name).toEqual([]);
    }
    // Control: the same harness does reach the engine for a good request.
    const { adapter, daemon } = await harness();
    await adapter.runSiteJob(req("db.import-load"));
    expect(daemon.requestedPaths.some((p) => p.startsWith("/v1") || p.includes("/containers/create"))).toBe(true);
  });

  it("a site id that is no safe identifier is refused for each new kind, with the shipped code, before the engine", async () => {
    for (const kind of ["db.import", "db.import-load", "wordpress.import-finalize"] as const) {
      for (const siteId of ["../site_a", "site a", "site;a", "", "-site"]) {
        const { adapter, daemon } = await harness();
        // The shipped assertSafeIdentifier answers HOST_POLICY_DENIED for every kind (not VALIDATION_ERROR).
        await expect(adapter.runSiteJob(req(kind, { siteId })), `${kind} ${siteId}`).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
        expect(daemon.requestedPaths).toEqual([]);
      }
    }
  });
});

describe("no value of a request in the command", () => {
  const ctx = (r: SiteJobRequest) => ({
    executorUser: "990:990",
    secretBinds: Object.keys(r.resolvedSecrets ?? {}).map((n) => `/run/hp/job/${n}:/run/secrets/${n}:ro`),
    secretFileEnv: Object.keys(r.resolvedSecrets ?? {}).map((n) => `${n}_FILE=/run/secrets/${n}`),
    rootKeyHostPath: "/etc/hp/mariadb-root.key",
  });
  // Valid, but as odd as the checks allow.
  const id = "ffffffffffffffffffffffffffff0000";
  const hostile: SiteJobRequest[] = [
    ...["prepare", "switch", "undo", "finish"].map((step) =>
      req("db.import", { siteId: "s-1.x_Y", jobId: "job_q.-_1", params: { step, importId: id }, resolvedSecrets: { HP_IMPORT_DB_PASSWORD: IMPORT_PW } }),
    ),
    req("db.import-load", { siteId: "s-1.x_Y", params: { importId: id } }),
    req("wordpress.import-finalize", {
      params: { phpVersion: "8.3", tablePrefix: "Z9_".repeat(10) + "__", siteUrl: "https://wp-a.example.test", previousUrl: "https://old.example.test:65535" },
    }),
    req("wordpress.import-finalize", { params: { phpVersion: "8.4", tablePrefix: "_", siteUrl: "http://wp-a.example.test", previousUrl: "http://wp-a.example.test" } }),
  ];
  const scriptOf: Record<ImportKind, string> = {
    "db.import": DB_IMPORT_SCRIPT,
    "db.import-load": DB_IMPORT_LOAD_SCRIPT,
    "wordpress.import-finalize": WORDPRESS_IMPORT_FINALIZE_SCRIPT,
  };

  it("the script is byte for byte the exported constant and each value travels only as its own HP_ variable", () => {
    for (const r of hostile) {
      const p = buildSiteJobContainerPayload(r, ctx(r));
      const command = commandOf(p)!;
      expect(command.slice(0, 6), r.kind).toEqual(["timeout", "-s", "KILL", command[3], "sh", "-c"]);
      expect(command).toHaveLength(7);
      expect(command[6] === scriptOf[r.kind as ImportKind], r.kind).toBe(true);
      // step is a closed word the script itself names; every free value must be absent from it.
      const values = [...Object.entries(r.params).filter(([k]) => k !== "step" && k !== "phpVersion").map(([, v]) => v), r.siteId, r.jobId, ...Object.values(r.resolvedSecrets ?? {})];
      for (const v of values.filter((x) => x.length > 1)) expect(scriptOf[r.kind as ImportKind].includes(v), v).toBe(false);
      // Values may sit in their own Env entry only; secrets nowhere at all.
      const paramEnv = Object.entries(r.params).map(([k, v]) => `HP_${k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}=${v}`);
      expect(p.Env.filter((e) => !paramEnv.includes(e) && !/^HP_(PREFIX|LOCK_S)=/.test(e) && !/^HP_IMPORT_DB_PASSWORD_FILE=/.test(e)), r.kind).toEqual([]);
      expect(leaks(p, Object.values(r.resolvedSecrets ?? {})), r.kind).toEqual([]);
      expect(JSON.stringify(command)).not.toMatch(new RegExp(values.filter((x) => x.length > 1).map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")));
      expect(JSON.stringify(p.Labels)).not.toContain(IMPORT_PW);
    }
  });

  it("the leak check catches a secret planted in Env, Cmd or a label", () => {
    const r = req("db.import-load");
    const p = buildSiteJobContainerPayload(r, ctx(r));
    expect(leaks(p, [IMPORT_PW])).toEqual([]);
    const planted: SiteJobCreatePayload = {
      ...p,
      Env: [...p.Env, `HP_IMPORT_DB_PASSWORD=${IMPORT_PW}`],
      Cmd: ["sh", "-c", `${DB_IMPORT_LOAD_SCRIPT}#${IMPORT_PW}`],
      Labels: { ...p.Labels, x: IMPORT_PW },
    };
    expect(leaks(planted, [IMPORT_PW])).toEqual([`command:${IMPORT_PW}`, `env:${IMPORT_PW}`, `label:${IMPORT_PW}`]);
  });
});

describe("the load's answer through the product's parser", () => {
  const good = { prefix: "wp_", oldUrl: "http://old.example.test", tables: 12 };
  const line = (v: unknown) => `${JSON.stringify(v)}\n`;

  it("accepts the bounds and refuses what the engineers' test does not cover", () => {
    expect(parseWordpressJobResult("db.import-load", line({ line: 7, errorNumber: 99999 }))).toEqual({ line: 7, errorNumber: 99999 });
    expect(parseWordpressJobResult("db.import-load", line({ line: 7, errorNumber: 1 }))).toEqual({ line: 7, errorNumber: 1 });
    expect(parseWordpressJobResult("db.import-load", line({ ...good, tables: 1000, prefix: "a".repeat(32), oldUrl: "https://old.example.test:8443" }))).toBeDefined();
    for (const [name, bad] of [
      ["errorNumber 100000", line({ line: 7, errorNumber: 100000 })],
      ["errorNumber string", line({ line: 7, errorNumber: "1044" })],
      ["line 1.5", line({ line: 1.5, errorNumber: 1044 })],
      ["line missing", line({ errorNumber: 1044 })],
      ["both shapes", line({ ...good, line: 1, errorNumber: 1044 })],
      ["prefix 33", line({ ...good, prefix: "a".repeat(33) })],
      ["prefix empty", line({ ...good, prefix: "" })],
      ["tables 0", line({ ...good, tables: 0 })],
      ["oldUrl upper", line({ ...good, oldUrl: "http://OLD.example.test" })],
      ["oldUrl user", line({ ...good, oldUrl: "http://u@old.example.test" })],
      ["oldUrl 301", line({ ...good, oldUrl: `http://${"a.".repeat(141)}example.test` })],
      ["inspect's answer", line(SIMULATED_WORDPRESS_STATE)],
      ["array", line([good])],
      ["null", "null\n"],
      ["not JSON", "prefix=wp_\n"],
    ] as const) {
      expect(parseWordpressJobResult("db.import-load", bad), name).toBeUndefined();
    }
    expect(line({ ...good, oldUrl: `http://${"a.".repeat(141)}example.test` }).length).toBeGreaterThan(300);
    // A load answer never passes as another kind's answer.
    expect(parseWordpressJobResult("wordpress.inspect", line(good))).toBeUndefined();
    expect(parseWordpressJobResult("wordpress.update", line({ line: 1, errorNumber: 1044 }))).toBeUndefined();
  });

  it("an answer longer than the ceiling is dropped even when it is valid JSON once trimmed", () => {
    const pad = (n: number) => `${JSON.stringify(good)}${" ".repeat(n)}\n`;
    expect(parseWordpressJobResult("db.import-load", pad(10))).toEqual(good);
    const over = pad(WORDPRESS_RESULT_MAX_BYTES);
    expect(Buffer.byteLength(over)).toBeGreaterThan(WORDPRESS_RESULT_MAX_BYTES);
    expect(parseWordpressJobResult("db.import-load", over)).toBeUndefined();
  });

  it("through the adapter: exit 61 carries its line, a forged answer is dropped, the secret never reaches the tail", async () => {
    const frame = (stream: 1 | 2, text: string) => {
      const body = Buffer.from(text);
      const h = Buffer.alloc(8);
      h[0] = stream;
      h.writeUInt32BE(body.length, 4);
      return Buffer.concat([h, body]);
    };
    const run = async (exit: number, stdout: string, stderr: string) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "hp-qa-load-"));
      cleanupTasks.push(() => rm(dir, { recursive: true, force: true }));
      const box: { paths: string[] } = { paths: [] };
      const daemon = await startMockDockerDaemon({
        waitStatusCode: exit,
        logsBodyFn: () => {
          const q = new URL(box.paths.at(-1) ?? "/", "http://docker").searchParams;
          return Buffer.concat([...(q.get("stdout") === "1" ? [frame(1, stdout)] : []), ...(q.get("stderr") === "1" ? [frame(2, stderr)] : [])]);
        },
      });
      cleanupTasks.push(() => daemon.close());
      box.paths = daemon.requestedPaths;
      daemon.containers.set("mariadb-id", { id: "mariadb-id", name: SHARED_DB_CONTAINER_NAME, image: SHARED_MARIADB_IMAGE, env: [], labels: {}, running: true, status: "running", restartCount: 0, hostConfig: {}, networks: {} });
      const adapter = new DockerEngineSocketAdapter({
        dockerSocketPath: daemon.socketPath,
        secretsRootDir: path.join(dir, "s"),
        ingressRootDir: path.join(dir, "i"),
        pullMissingImages: false,
        sharedDbRootKeyFile: path.join(dir, "k"),
      });
      return adapter.runSiteJob(req("db.import-load"));
    };
    expect(await run(0, line(good), "")).toMatchObject({ exitCode: 0, result: good });
    const failed = await run(61, '{"line":631,"errorNumber":1044}\n', `ERROR 1044 (42000) at line 631: denied password=${IMPORT_PW}\n`);
    expect(failed).toMatchObject({ exitCode: 61, result: { line: 631, errorNumber: 1044 } });
    expect(failed.outputTail).not.toContain(IMPORT_PW);
    expect(failed.outputTail).not.toContain("errorNumber");
    for (const forged of [line({ ...good, extra: 1 }), "not json\n", line(SIMULATED_WORDPRESS_STATE), line(good) + line(good), line({ line: -1, errorNumber: 1044 })]) {
      const res = await run(0, forged, "");
      expect(res, forged.slice(0, 40)).not.toHaveProperty("result");
    }
  });
});

/** Unquoted $HP_ reads (assignment values excepted) and unescaped backticks; follows nested $( ) and quotes. */
function shellRisks(script: string): string[] {
  const out: string[] = [];
  const stack: Array<{ q: "none" | "double"; depth: number }> = [{ q: "none", depth: 0 }];
  for (let i = 0; i < script.length; i += 1) {
    const top = stack.at(-1)!;
    const c = script[i]!;
    if (c === "\\") {
      i += 1;
    } else if (top.q === "none" && c === "'") {
      const end = script.indexOf("'", i + 1);
      i = end < 0 ? script.length : end;
    } else if (c === "`") {
      out.push(`backtick:${script.slice(Math.max(0, i - 12), i + 12)}`);
    } else if (c === "$" && script[i + 1] === "(") {
      stack.push({ q: "none", depth: 0 });
      i += 1;
    } else if (c === '"') {
      top.q = top.q === "double" ? "none" : "double";
    } else if (top.q === "none") {
      if (c === "(") top.depth += 1;
      else if (c === ")" && stack.length > 1) {
        if (top.depth === 0) stack.pop();
        else top.depth -= 1;
      } else if (c === "$" && /^\{?HP_/.test(script.slice(i + 1, i + 5)) && !/(^|[\s;])[A-Za-z_][A-Za-z0-9_]*=$/.test(script.slice(Math.max(0, i - 40), i))) {
        out.push(script.slice(i, i + 24));
      }
    }
  }
  return out;
}

describe("static checks of the four scripts", () => {
  const SCRIPTS = { DB_IMPORT_SCRIPT, DB_IMPORT_LOAD_SCRIPT, WORDPRESS_IMPORT_FINALIZE_SCRIPT, WORDPRESS_SET_URL_SCRIPT };

  it("the host's sh -n accepts each script read from standard input, and refuses a broken one", () => {
    for (const [name, script] of Object.entries(SCRIPTS)) {
      expect(() => execFileSync("sh", ["-n"], { input: script, stdio: ["pipe", "pipe", "pipe"] }), name).not.toThrow();
    }
    expect(() => execFileSync("sh", ["-n"], { input: `${DB_IMPORT_SCRIPT}\nif then\n`, stdio: ["pipe", "pipe", "pipe"] })).toThrow();
  });

  it("no eval, no unescaped backtick and no $HP_ read where the shell would split it", () => {
    // The scanner finds what it must find.
    expect(shellRisks("a=$HP_X; echo $HP_Y \"$HP_Z\" '$HP_W'")).toEqual(["$HP_Y \"$HP_Z\" '$HP_W'"]);
    expect(shellRisks('x="$(f "$HP_A")"; y=$(f $HP_B)').map((r) => r.slice(0, 5))).toEqual(["$HP_B"]);
    expect(shellRisks("i=$((i+1)); echo ${HP_C}").map((r) => r.slice(0, 6))).toEqual(["${HP_C"]);
    expect(shellRisks('echo "\\`$I\\`"')).toEqual([]);
    expect(shellRisks("echo `id`")).toHaveLength(2);
    expect(shellRisks("q \"SELECT '`$S`'\"")).toHaveLength(2);
    for (const [name, script] of Object.entries(SCRIPTS)) {
      expect(script, name).not.toMatch(/(^|[;&|(]\s*)eval\b/m);
      expect(shellRisks(script), name).toEqual([]);
    }
  });

  it("each request value is checked by the script before its first use", () => {
    const before = (s: string, a: string, b: string) => {
      expect(s.indexOf(a), a).toBeGreaterThanOrEqual(0);
      expect(s.indexOf(b), b).toBeGreaterThan(s.indexOf(a));
    };
    before(DB_IMPORT_SCRIPT, 'case "$HP_IMPORT_ID" in *[!0-9a-f]*) exit 64;; esac', "I=$HP_IMPORT_ID");
    before(DB_IMPORT_SCRIPT, '[ "${#HP_IMPORT_ID}" -eq 32 ] || exit 64', "I=$HP_IMPORT_ID");
    before(DB_IMPORT_SCRIPT, "grep -Eqx 'wp_[0-9a-f]{12}' || exit 64", "D=$HP_PREFIX");
    before(DB_IMPORT_LOAD_SCRIPT, '[ "${#HP_IMPORT_ID}" -eq 32 ] || exit 64', "user=hp_iu_%s");
    before(DB_IMPORT_LOAD_SCRIPT, '[ "${#pw}" -eq 64 ] || exit 64', "password=%s");
    before(WORDPRESS_IMPORT_FINALIZE_SCRIPT, "grep -Eqx '[A-Za-z0-9_]{1,32}' || exit 64", "wp config set table_prefix");
    // The import password is read only by prepare, after its own check.
    const prepare = DB_IMPORT_SCRIPT.slice(DB_IMPORT_SCRIPT.indexOf("\nprepare)"), DB_IMPORT_SCRIPT.indexOf("\nswitch)"));
    expect(DB_IMPORT_SCRIPT.split("HP_IMPORT_DB_PASSWORD")).toHaveLength(2);
    before(prepare, "cat /run/secrets/HP_IMPORT_DB_PASSWORD", "IDENTIFIED BY '$pw'");
    before(prepare, '[ "${#pw}" -eq 64 ] || exit 64', "IDENTIFIED BY '$pw'");
  });

  it("the load runs sandboxed, never with --force, and never names the root key; db.import never names the site's files", () => {
    for (const flag of ["--sandbox", "--local-infile=0", "--binary-mode"]) expect(DB_IMPORT_LOAD_SCRIPT).toContain(flag);
    // Every client call of the load goes through m(), which carries the sandbox flags.
    expect(DB_IMPORT_LOAD_SCRIPT.match(/(^|[\s;{(])mariadb\s/gm)).toHaveLength(1);
    expect(DB_IMPORT_LOAD_SCRIPT).toMatch(/m\(\) \{ mariadb [^}]*--sandbox --local-infile=0 "\$@" -- "hp_is_\$HP_IMPORT_ID"; \}/);
    for (const name of ["--force", "mariadb-root", "user=root", "/tmp/c.cnf", "HP_PREFIX", "/run/secrets/mariadb"]) {
      expect(DB_IMPORT_LOAD_SCRIPT, name).not.toContain(name);
    }
    for (const name of ["/var/www/html", ".htpanel-import", "--force"]) expect(DB_IMPORT_SCRIPT, name).not.toContain(name);
    // Every root client call of db.import is sandboxed too.
    expect(DB_IMPORT_SCRIPT.match(/\bmariadb --defaults-extra-file=\/tmp\/c\.cnf --default-character-set/g)).toHaveLength(2);
    expect(DB_IMPORT_SCRIPT.match(/--sandbox/g)).toHaveLength(2);
  });
});

describe("R153 as far as the script text shows it", () => {
  const branch = (from: string, to: string) => DB_IMPORT_SCRIPT.slice(DB_IMPORT_SCRIPT.indexOf(from), DB_IMPORT_SCRIPT.indexOf(to));
  const PREDICATE = "REGEXP CONCAT('[', CHAR(1), '-', CHAR(31), CHAR(127), ']') OR LOCATE(CHAR(0), TABLE_NAME) > 0 OR LOCATE(CHAR(92), TABLE_NAME) > 0";

  it("84, 85 and 92 each have one place, and both checks use the restore's name predicate", () => {
    expect(DB_IMPORT_SCRIPT.match(/exit 84\b/g)).toHaveLength(1);
    expect(DB_IMPORT_SCRIPT.match(/exit 85\b/g)).toHaveLength(1);
    expect(DB_IMPORT_SCRIPT).toContain('live_ok() { o=$(objs "$D"); [ "$o" = 0 ] || exit 85; }');
    expect(branch("\nswitch)", "\nundo)")).toContain('o=$(objs "$S"); [ "$o" = 0 ] || exit 84');
    expect(DB_IMPORT_SCRIPT.match(/exit 92\b/g)).toHaveLength(2);
    expect(branch("\nundo)", "\nfinish)").match(/exit 92\b/g)).toHaveLength(2);
    const fn = (name: string) => DB_IMPORT_SCRIPT.split("\n").find((l) => l.startsWith(`${name}() {`))!;
    expect(fn("objs")).toContain(PREDICATE.replaceAll("TABLE_NAME", "TABLE_NAME"));
    // objs also counts any view, sequence, trigger, routine and event: the staging must hold base tables only.
    for (const part of ["TABLE_TYPE<>'BASE TABLE'", "information_schema.TRIGGERS", "information_schema.ROUTINES", "information_schema.EVENTS"]) {
      expect(fn("objs"), part).toContain(part);
    }
    // Same predicate text as the shipped restore's check_obj_names, with its column name.
    expect(PREDICATE.replaceAll("TABLE_NAME", "n")).toBe("REGEXP CONCAT('[', CHAR(1), '-', CHAR(31), CHAR(127), ']') OR LOCATE(CHAR(0), n) > 0 OR LOCATE(CHAR(92), n) > 0");
  });

  it("switch checks live (85) and staging (84) before it creates the aside schema or renames anything", () => {
    const sw = branch("\nswitch)", "\nundo)");
    const at = (s: string) => sw.indexOf(s);
    for (const later of ["CREATE DATABASE IF NOT EXISTS", "renames ", "RENAME TABLE", "swap"]) {
      expect(at(later), later).toBeGreaterThan(0);
      expect(at("live_ok"), later).toBeLessThan(at(later));
      expect(at("|| exit 84"), later).toBeLessThan(at(later));
    }
    // The throw-away account is gone before the staging is checked, so it cannot change it afterwards.
    expect(at("drop_account")).toBeLessThan(at("|| exit 84"));
  });

  it("undo checks live and aside (92) before it creates the staging again or moves anything", () => {
    const undo = branch("\nundo)", "\nfinish)");
    // R164.2: the same objs as the switch, on live and on aside.
    const check = undo.indexOf('d=$(objs "$D"); a=$(objs "$A"); [ "$d" = 0 ] && [ "$a" = 0 ] || exit 92');
    expect(check).toBeGreaterThan(0);
    for (const later of ["CREATE DATABASE IF NOT EXISTS", "renames ", "RENAME TABLE", "swap"]) {
      expect(undo.indexOf(later), later).toBeGreaterThan(check);
    }
    // The second 92: tables still aside after the reverse move means nothing is dropped.
    expect(undo.indexOf('a=$(tables "$A"); [ "$a" = 0 ] || exit 92')).toBeLessThan(undo.indexOf("DROP DATABASE"));
  });
});

// R164.3/R164.2: the two database scripts run in the host's sh against a stand-in mariadb that answers by query.
describe("the database scripts against a stand-in mariadb", () => {
  // Each call is logged as "<class> <query>"; FAIL=<class> makes that query fail like a passing server error.
  const SHIM = String.raw`#!/bin/sh
q=""; while [ $# -gt 0 ]; do if [ "$1" = -e ]; then q=$2; break; fi; shift; done
[ -n "$q" ] || q="STDIN $(cat)"
case "$q" in
  "SELECT 1") c=ping;;
  *SCHEMATA*) c=schemata;;
  "SELECT COUNT(*), SUM("*) c=counts;;
  *"TRIGGER_SCHEMA=DATABASE()"*) c=objects;;
  *"blogs'"*) c=multisite;;
  "SELECT EXISTS"*) c=users;;
  *"option_name = 'home'"*) c=home;;
  *"option_name = 'siteurl'"*) c=siteurl;;
  "SELECT LEFT(TABLE_NAME"*) c=prefix;;
  "SELECT (SELECT COUNT(*)"*) c=objs;;
  *"TABLE_SCHEMA='hp_im_"*) c=marker;;
  "SELECT CONCAT("*) c=renames;;
  *"TABLE_TYPE='BASE TABLE' AND (TABLE_NAME REGEXP"*) c=names;;
  "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='"*"'") c=tables;;
  "STDIN RENAME"*) c=rename;;
  STDIN*) c=load; q=STDIN;;
  *) c=other;;
esac
case "$q" in *"'hp_ia_"*) s=ASIDE;; *"'hp_is_"*) s=STAGE;; *) s=LIVE;; esac
printf '%s %s\n' "$c" "$(printf '%s' "$q" | tr '\n' ' ')" >> "$HP_SHIM_DIR/calls.log"
if [ "$c" = "$FAIL" ]; then echo "ERROR 1040 (HY000): Too many connections" >&2; exit 1; fi
case "$c" in
  marker) printf '%s\n' "$MARKER";;
  objs) eval "printf '%s\n' \"\$OBJS_$s\"";;
  tables) if [ "$s" = ASIDE ] && [ -f "$HP_SHIM_DIR/swapped" ]; then echo 0; else eval "printf '%s\n' \"\$TABLES_$s\""; fi;;
  renames) printf '%s\n' 'x.t TO y.t,';;
  rename) : > "$HP_SHIM_DIR/swapped";;
  counts) printf '12\t0\t0\n';;
  objects|multisite|names) echo 0;;
  users) echo 1;;
  prefix) echo wp_;;
  home|siteurl) echo http://old.example.test;;
esac
exit 0
`;
  type Run = { code: number; calls: string[]; out: string };

  async function harness() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hp-db-shim-"));
    cleanupTasks.push(() => rm(dir, { recursive: true, force: true }));
    await mkdir(path.join(dir, "bin"));
    await mkdir(path.join(dir, "secrets"));
    await writeFile(path.join(dir, "bin", "mariadb"), SHIM, { mode: 0o755 });
    await writeFile(path.join(dir, "secrets", "mariadb-root"), "root-sentinel");
    await writeFile(path.join(dir, "secrets", "HP_IMPORT_DB_PASSWORD"), IMPORT_PW);
    await writeFile(path.join(dir, "dump"), "CREATE TABLE wp_options (a INT);\n");
    // Only the fixed paths of the scripts move into the test's folder; nothing else of the text changes.
    const paths: Array<[string, string]> = [["/tmp/c.cnf", `${dir}/c.cnf`], ["/tmp/r.sql", `${dir}/r.sql`], ["/run/secrets/", `${dir}/secrets/`], ["/var/www/html/.htpanel-import/dump", `${dir}/dump`]];
    const relocate = (script: string) =>
      paths.reduce((s, [from, to]) => (script.includes(from) ? s.replaceAll(from, to) : s), script);
    return async (script: string, env: Record<string, string>): Promise<Run> => {
      await writeFile(path.join(dir, "calls.log"), "");
      await rm(path.join(dir, "swapped"), { force: true });
      const text = relocate(script);
      expect(text).not.toMatch(/\/tmp\/c\.cnf|\/tmp\/r\.sql|\/run\/secrets\/|\/var\/www\/html\/\.htpanel-import\/dump/);
      const { code, out } = await new Promise<{ code: number; out: string }>((resolve) => {
        execFile(
          "sh",
          ["-c", text],
          {
            env: {
              PATH: `${dir}/bin:/usr/bin:/bin`, TMPDIR: dir, HP_SHIM_DIR: dir, HP_IMPORT_ID: IMPORT_ID, HP_PREFIX: "wp_0123456789ab", HP_LOCK_S: "5",
              MARKER: "", FAIL: "", OBJS_LIVE: "0", OBJS_ASIDE: "0", OBJS_STAGE: "0", TABLES_LIVE: "12", TABLES_ASIDE: "0", TABLES_STAGE: "0", ...env,
            },
            timeout: 30_000,
          },
          (err, stdout) => resolve({ code: err ? Number((err as { code?: unknown }).code) : 0, out: stdout }),
        );
      });
      const calls = (await readFile(path.join(dir, "calls.log"), "utf8")).split("\n").filter(Boolean);
      return { code, calls, out };
    };
  }
  const sent = (r: Run, c: string) => r.calls.some((x) => x.startsWith(`${c} `));

  it("every query is read into a variable first, never inside a test or a word list", () => {
    for (const script of [DB_IMPORT_SCRIPT, DB_IMPORT_LOAD_SCRIPT]) {
      expect(script.match(/(?<![a-z]=)\$\((q|objs|tables|marker)\b/g)).toBeNull();
      // R165.3: no command substitution inside a [ ] test, no query helper whose failure an if, !, || or && would hide.
      expect(script).not.toMatch(/\[ [^\]]*\$\((?!\()/);
      expect(script).not.toMatch(/(if|!|\|\||&&) +(live_ok|objs|tables|marker|q)\b/);
      expect(script).not.toMatch(/(^|[;{&|]) *(live_ok|objs|tables|marker|q)\b(?!\(\))[^;\n]*(\|\||&&)/m);
    }
    expect(DB_IMPORT_SCRIPT.match(/[a-z]=\$\(marker\)/g)).toHaveLength(3);
  });

  it("undo: a failed query is exit 1 (try again), an object in live or aside is 92 before any rename, a clean state is undone", async () => {
    const run = await harness();
    const undo = (env: Record<string, string>) => run(DB_IMPORT_SCRIPT, { HP_STEP: "undo", ...env });

    const markerFails = await undo({ MARKER: "after", TABLES_ASIDE: "5", FAIL: "marker" });
    expect(markerFails.code).toBe(1);
    expect(sent(markerFails, "rename")).toBe(false);

    const countFails = await undo({ MARKER: "after", TABLES_ASIDE: "5", FAIL: "tables" });
    expect(countFails.code).toBe(1);
    expect(sent(countFails, "rename")).toBe(true);

    for (const where of ["OBJS_LIVE", "OBJS_ASIDE"]) {
      const trigger = await undo({ MARKER: "after", TABLES_ASIDE: "5", [where]: "1" });
      expect(trigger.code, where).toBe(92);
      expect(sent(trigger, "rename"), where).toBe(false);
      expect(sent(trigger, "renames"), where).toBe(false);
    }

    const clean = await undo({ MARKER: "after", TABLES_ASIDE: "5" });
    expect(clean.code).toBe(0);
    expect(sent(clean, "rename")).toBe(true);
    expect(clean.calls.at(-1)).toMatch(/^other DROP DATABASE IF EXISTS/);
  });

  it("prepare, switch and finish: a failed query is exit 1, never 86, 85 or 97", async () => {
    const run = await harness();
    const prepare = await run(DB_IMPORT_SCRIPT, { HP_STEP: "prepare", FAIL: "schemata" });
    expect(prepare.code).toBe(1);
    expect((await run(DB_IMPORT_SCRIPT, { HP_STEP: "prepare" })).code).toBe(0);

    const sw = await run(DB_IMPORT_SCRIPT, { HP_STEP: "switch", TABLES_STAGE: "12", FAIL: "objs" });
    expect(sw.code).toBe(1);
    expect(sent(sw, "rename")).toBe(false);
    for (const fail of ["marker", "tables"]) expect((await run(DB_IMPORT_SCRIPT, { HP_STEP: "switch", TABLES_STAGE: "12", FAIL: fail })).code, fail).toBe(1);
    const swOk = await run(DB_IMPORT_SCRIPT, { HP_STEP: "switch", TABLES_STAGE: "12" });
    expect(swOk.code).toBe(0);
    expect(sent(swOk, "rename")).toBe(true);
    expect((await run(DB_IMPORT_SCRIPT, { HP_STEP: "switch", TABLES_STAGE: "12", OBJS_LIVE: "1" })).code).toBe(85);

    const finish = await run(DB_IMPORT_SCRIPT, { HP_STEP: "finish", TABLES_ASIDE: "5", FAIL: "marker" });
    expect(finish.code).toBe(1);
    expect(finish.calls.some((c) => c.includes("DROP DATABASE"))).toBe(false);
    expect((await run(DB_IMPORT_SCRIPT, { HP_STEP: "finish", TABLES_ASIDE: "5" })).code).toBe(97);
    expect((await run(DB_IMPORT_SCRIPT, { HP_STEP: "finish", MARKER: "after", TABLES_ASIDE: "5" })).code).toBe(0);
  });

  it("load: a failed check query is exit 1, never 54, 56 or 59; the answer comes only when every query answered", async () => {
    const run = await harness();
    const ok = await run(DB_IMPORT_LOAD_SCRIPT, {});
    expect(ok.code).toBe(0);
    expect(ok.out).toBe('{"prefix":"wp_","oldUrl":"http://old.example.test","tables":12}\n');
    expect(sent(ok, "load")).toBe(true);
    for (const fail of ["counts", "objects", "prefix", "multisite", "users", "home", "siteurl"]) {
      const r = await run(DB_IMPORT_LOAD_SCRIPT, { FAIL: fail });
      expect(r.code, fail).toBe(1);
      expect(r.out, fail).toBe("");
    }
  });
});
