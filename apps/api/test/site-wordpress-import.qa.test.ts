import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  SiteWordpressImportDtoSchema,
  SiteWordpressLastImportDtoSchema,
  WORDPRESS_IMPORT_KIND,
  WORDPRESS_IMPORT_REASONS,
} from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  eq,
  getSiteWordpressState,
  operations,
  operationSteps,
  outboxEvents,
  serviceInstances,
  siteWordpressState,
  upsertBackupSettings,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { SiteFilesRequest, SiteJobRequest } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { skipPasswordChange } from "./fixtures/password-change.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const KEY = Buffer.alloc(32, 7);
const JWT_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PW = "sentinel-pass-phrase";
const SETUP = { installationName: "Test", hostHostname: "panel.example.test", hostIpv4: "10.0.0.1" };
const SITE = {
  name: "Site A",
  domain: "wp-a.example.test",
  title: "Site A",
  adminUser: "admin",
  adminEmail: "admin@example.test",
  adminPassword: "sentinel-Pass-123456",
};
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
/** The simulator's own archive format (HPSIMZIP), a WordPress tree under one top folder. */
const ARCHIVE = Buffer.from(
  `HPSIMZIP\n${JSON.stringify([
    { p: "site/index.php", d: b64("<?php // imported index") },
    { p: "site/wp-load.php", d: b64("<?php // load") },
    { p: "site/wp-includes/version.php", d: b64("<?php $wp_version = '6.9';") },
    { p: "site/wp-content/themes/neutral/style.css", d: b64("/* Theme Name: Neutral */") },
    { p: "site/wp-config.php", d: b64("<?php // the old configuration") },
  ])}`,
  "utf8",
);
const DUMP = Buffer.from("-- MariaDB dump\nCREATE TABLE `wp_options` (id int);\nINSERT INTO `wp_options` VALUES (1);\n", "utf8");
const LINE = '{"line":12,"errorNumber":1064}\n';
const ambiguous = () => Object.assign(new Error("timeout"), { code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true });
const coded = (code: string) => Object.assign(new Error("executor"), { code });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** R-secrets: what nothing written by the API may hold. */
const FORBIDDEN: [string, RegExp][] = [
  ["HP_", /HP_/],
  ["staging names", /hp_i[samu]_/],
  ["marker", /\.htpanel-import/],
  ["host path", /(^|[^A-Za-z0-9._~-])\/(srv|var|home|opt|tmp|etc|run|data|mnt|root|usr|proc)\//],
  ["SQL text", /\b(create|drop|alter)\s+(table|database|user)\b|\binsert\s+into\b|\bgrant\s+all\b|\bselect\s+\S+\s+from\b/i],
  ["64-hex", /[0-9a-f]{64}/i],
  ["Docker id", /\b[0-9a-f]{12}\b/],
  ["password or secret key", /"[^"]*(password|secret)[^"]*"\s*:/i],
];
/** The patterns a text matches, with UUIDs (organisation ids) taken out first. */
const leaks = (text: string) =>
  FORBIDDEN.filter(([, re]) => re.test(text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>"))).map(([n]) => n);
const WORDS = /\b(docker|containers?|images?|networks?|volumes?|revisions?|jobs?|schemas?)\b/i;

describe("qa-api: what an import writes, the reasons it stores and the answers it trusts", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let orgId: string;
  let token: string;
  let siteId: string;
  let adminUserId: string;
  /** Every executor call by name (`db.import:<step>` for the database job). */
  const sent: string[] = [];
  /** One-shot faults by call name: thrown before the call, or after its effect. */
  const faults = new Map<string, { when: "before" | "after"; error: () => Error }>();
  /** One-shot replacements of an answer by call name. */
  const answers = new Map<string, (real: unknown) => unknown>();
  /** Every answer body the routes gave. */
  const bodies: Json[] = [];

  async function call(method: string, path: string, as: string, body?: unknown, key: string | null = randomUUID()) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", ...(key === null ? {} : { "Idempotency-Key": key }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    const parsed = raw ? (JSON.parse(raw) as Json) : {};
    bodies.push(parsed);
    return { status: res.status, body: parsed };
  }

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await call("POST", "/v1/auth/login", "", {
      email,
      password,
      ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
    });
    bodies.pop(); // a login answer holds a token, not import text
    return res.body.data.accessToken as string;
  }

  const imp = () => `/v1/organizations/${orgId}/managed-sites/${siteId}/wordpress/import`;
  const lastImport = async () => ((await getSiteWordpressState(dbClient.db, { organizationId: orgId, siteId }))?.lastImport ?? null) as Json | null;
  const opRow = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const stepsOf = async (id: string) =>
    Object.fromEntries((await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, id))).map((s) => [s.key, s.status]));
  const svc = async () => (await dbClient.db.select({ id: serviceInstances.id }).from(serviceInstances).where(eq(serviceInstances.siteId, siteId)))[0]!.id;

  async function upload(slot: "archive" | "dump", data: Buffer) {
    const res = await call("PUT", `${imp()}/files/${slot}`, token, {
      uploadId: `upload_${slot}_0123456789abcdef`,
      offset: 0,
      dataBase64: data.toString("base64"),
      final: true,
    });
    expect([slot, res.status]).toEqual([slot, 200]);
  }

  /** Uploads both files unless they are still there. */
  async function ready() {
    const { body } = await call("GET", imp(), token);
    if (body.data.slots.archive.state !== "complete") await upload("archive", ARCHIVE);
    if (body.data.slots.dump.state !== "complete") await upload("dump", DUMP);
  }

  /** Starts an import through the route, arms a fault, runs the real worker once; the start is moved out of the hour's heavy limit. */
  async function run(arm: () => void = () => {}): Promise<string> {
    await ready();
    const res = await call("POST", imp(), token, { confirm: true });
    expect(res.status).toBe(202);
    const id = res.body.data.operationId as string;
    await dbClient.db.update(operations).set({ submittedAt: new Date(Date.now() - 2 * 3_600_000) }).where(eq(operations.id, id));
    sent.length = 0;
    arm();
    await app.outboxWorker.processPendingOnce();
    return id;
  }

  /** One recovery pass of the real worker. */
  async function pass() {
    sent.length = 0;
    await app.outboxWorker.recoverUnknownOperations();
    return [...sent];
  }

  const through = async (name: string, real: () => Promise<unknown>) => {
    const f = faults.get(name);
    if (f?.when === "before") {
      faults.delete(name);
      throw f.error();
    }
    const out = await real();
    if (f) {
      faults.delete(name);
      throw f.error();
    }
    const swap = answers.get(name);
    answers.delete(name);
    return swap ? swap(out) : out;
  };

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "staff@example.test", name: "Staff", password: PW });
    adminUserId = admin.userId;
    sim = new InMemoryDockerSimulatorAdapter();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem: JWT_PEM,
      runtimeBackend: "linux-systemd",
      dockerExecutor: sim,
      hostAgent: new InMemoryHostSimulatorAdapter(),
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      sftpRetryIntervalMs: null,
      backupScheduleIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    const adminToken = await login("staff@example.test", PW, admin.totpSecretBase32);
    const created = await call("POST", "/v1/admin/customer-account", adminToken, {
      organizationName: "Customer A",
      ownerEmail: "admin@example.test",
      ownerName: "Customer A",
    });
    expect(created.status).toBe(201);
    orgId = created.body.data.organizationId as string;
    await skipPasswordChange(dbClient.db, "admin@example.test");
    token = await login("admin@example.test", created.body.data.temporaryPassword as string);
    const site = await call("POST", `/v1/organizations/${orgId}/managed-sites`, token, SITE);
    expect(site.status).toBe(202);
    siteId = site.body.data.siteId as string;
    await app.outboxWorker.processPendingOnce();
    const files = sim.siteFiles.bind(sim);
    const jobs = sim.runSiteJob.bind(sim);
    vi.spyOn(sim, "siteFiles").mockImplementation((async (req: SiteFilesRequest) => {
      sent.push(req.op);
      return through(req.op, () => files(req));
    }) as never);
    vi.spyOn(sim, "runSiteJob").mockImplementation((async (req: SiteJobRequest) => {
      const name = req.kind === "db.import" ? `db.import:${String(req.params?.["step"])}` : req.kind;
      sent.push(name);
      return through(name, () => jobs(req));
    }) as never);
    sent.length = 0;
    bodies.length = 0;
    faults.clear();
    answers.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  /** Points 11 and 15: the happy path, a failure at each step and each recovery branch, through the routes and the worker. */
  async function everyPath(): Promise<string[]> {
    await upsertBackupSettings(dbClient.db, KEY, {
      endpoint: "https://s3.example.test",
      region: "eu-south-1",
      bucket: "test-backups",
      prefix: "panel",
      accessKeyId: "AKIATESTONLY0001",
      secretAccessKey: "test-only-not-a-secret",
      scheduleHourUtc: 2,
      retentionDays: 14,
      updatedByUserId: adminUserId,
    });
    const ops: string[] = [];
    const expectOutcome = async (id: string, outcome: string, reason: string | null) => {
      expect([id, (await lastImport())?.["outcome"], (await lastImport())?.["reason"]]).toEqual([id, outcome, reason]);
      ops.push(id);
    };
    await expectOutcome(await run(), "imported", null);
    await expectOutcome(await run(() => sim.files.failNextImport("import.unpack", "not_a_zip")), "nothing_changed", "archive_not_zip");
    await expectOutcome(await run(() => sim.failNextJob("db.import-load", 60, "", LINE)), "nothing_changed", "dump_load_failed");
    await expectOutcome(await run(() => sim.failNextJob("db.import", 84)), "nothing_changed", "dump_names_unsupported");
    await expectOutcome(await run(() => sim.failNextJob("wordpress.import-finalize", 25)), "site_restored", "site_check_failed");
    // The executor down at unpack.
    await expectOutcome(
      await run(() => faults.set("import.unpack", { when: "before", error: () => coded("DOCKER_ENGINE_UNAVAILABLE") })),
      "nothing_changed",
      "unavailable",
    );
    // finish refused, then settled by recovery.
    const fin = await run(() => sim.files.failNextImport("import.finish", "staging_unsafe"));
    expect((await opRow(fin)).status).toBe("unknown");
    await pass();
    await expectOutcome(fin, "imported", null);
    // unknown at unpack, then at switch: undone by recovery.
    const unpack = await run(() => sim.files.failNextImport("import.unpack", "timeout"));
    await pass();
    await expectOutcome(unpack, "nothing_changed", "interrupted");
    const sw = await run(() => sim.files.failNextImport("import.switch", "timeout"));
    await pass();
    await expectOutcome(sw, "site_restored", "interrupted");
    // the executor down during recovery, then back.
    const down = await run(() => faults.set("db.import-load", { when: "after", error: ambiguous }));
    sim.setEngineReachable(false);
    await pass();
    expect((await opRow(down)).status).toBe("unknown");
    sim.setEngineReachable(true);
    await pass();
    await expectOutcome(down, "nothing_changed", "interrupted");
    // last: the undo that cannot finish leaves the site with an earlier import unfinished.
    const stuck = await run(() => sim.files.failNextImport("import.switch", "timeout"));
    sim.failNextJob("db.import", 92);
    await pass();
    await expectOutcome(stuck, "undo_incomplete", "interrupted");
    const refused = await call("POST", imp(), token, { confirm: true });
    expect(refused.status).toBe(409);
    for (const id of ops) await call("GET", `/v1/organizations/${orgId}/operations/${id}`, token);
    await call("GET", imp(), token);
    return ops;
  }

  // ---- point 11 ----
  it("leaks: nothing written or answered holds a staging name, a path, SQL, a long hex, a key named password, and the staging password is nowhere", async () => {
    const logs: string[] = [];
    const capture = (...args: unknown[]) => void logs.push(args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation(capture);
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, ...rest: never[]) => (capture(String(chunk)), out(chunk as string, ...rest))) as never);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown, ...rest: never[]) => (capture(String(chunk)), err(chunk as string, ...rest))) as never);

    const ops = await everyPath();
    const passwords = [...new Set(sim.jobs.map((j) => j.resolvedSecrets?.["HP_IMPORT_DB_PASSWORD"]).filter((p): p is string => !!p))];
    expect(passwords.length).toBeGreaterThanOrEqual(5);

    const db = dbClient.db;
    const allOps = await db.select().from(operations);
    const allSteps = await db.select().from(operationSteps);
    const allOutbox = await db.select().from(outboxEvents);
    const allAudit = await db.select().from(auditEvents);
    const allState = await db.select().from(siteWordpressState);
    // The staging password: in no row of any of these tables, in no answer, in no log line.
    const everything = JSON.stringify([allOps, allSteps, allOutbox, allAudit, allState, bodies, logs]);
    for (const p of passwords) expect(everything.includes(p)).toBe(false);

    // What the import wrote, row by row.
    const mine = (o: Json) => ops.includes(o["operationId"]) || ops.includes(o["id"]) || ops.includes((o["payload"] ?? {})["operationId"]);
    const written: [string, unknown][] = [
      ...allOps.filter((o) => o.kind === WORDPRESS_IMPORT_KIND).map((o) => ["operation", o] as [string, unknown]),
      ...allSteps.filter((s) => ops.includes(s.operationId)).map((s) => ["step", s] as [string, unknown]),
      ...allOutbox.filter((e) => mine(e as Json)).map((e) => ["outbox", e] as [string, unknown]),
      ...allAudit
        .filter((r) => r.action.startsWith("site.wordpress.import.") || ops.includes(r.targetId ?? "") || ops.includes(String((r.details as Json)["operationId"])))
        .map((r) => [`audit ${r.action}`, r] as [string, unknown]),
      ...allState.map((s) => ["wordpress state", s] as [string, unknown]),
      ...bodies.map((b) => ["answer", b] as [string, unknown]),
    ];
    expect(written.filter(([n]) => n.startsWith("audit")).length).toBeGreaterThan(20);
    const found = written.map(([n, v]) => [n, leaks(JSON.stringify(v))] as const).filter(([, l]) => l.length > 0);
    expect(found).toEqual([]);

    // The scan can fail: each pattern catches its sample, and a password-shaped value is caught.
    const samples = [
      "HP_IMPORT_DB_PASSWORD",
      "hp_is_0123",
      "/x/.htpanel-import",
      '"/srv/sites/a"',
      "INSERT INTO wp_options",
      passwords[0]!,
      "id 0123456789ab done",
      '{"dbPassword":1}',
    ];
    expect(samples.map((s, i) => leaks(s).includes(FORBIDDEN[i]![0]))).toEqual(samples.map(() => true));
  });

  // ---- point 15 ----
  it("words: no customer text of an import says Docker, container, image, network, volume, revision, job or schema", async () => {
    const ops = await everyPath();
    const texts: string[] = [];
    const collect = (v: unknown, key = ""): void => {
      if (typeof v === "string" && ["message", "label", "title", "detail", "errorMessage"].includes(key)) texts.push(v);
      else if (Array.isArray(v)) v.forEach((x) => collect(x, key));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) collect(x, k);
    };
    collect(bodies);
    for (const s of await dbClient.db.select().from(operationSteps)) {
      if (ops.includes(s.operationId)) texts.push(s.label, s.message ?? "");
    }
    for (const o of await dbClient.db.select().from(operations)) {
      if (ops.includes(o.id)) collect(o);
    }
    expect(texts.length).toBeGreaterThan(60);
    expect(texts.filter((t) => WORDS.test(t))).toEqual([]);
    // The check can fail.
    expect(WORDS.test("The job could not reach its container")).toBe(true);
  });

  // ---- point 12 ----
  it("reasons: every exit and helper refusal through the worker stores its R157 reason, an unlisted one stores other, line and errorNumber only from 60 and 61", async () => {
    const cases: [string, () => void, string, Json?][] = [
      ...([50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 62] as const).map(
        (exit, i) =>
          [
            `load ${exit}`,
            () => sim.failNextJob("db.import-load", exit),
            ["dump_unsafe", "dump_not_sql", "dump_too_large", "dump_incomplete", "dump_not_wordpress", "dump_ambiguous", "multisite_unsupported", "dump_objects_unsupported", "dump_names_unsupported", "address_unsupported", "dump_too_many_tables"][i]!,
            { line: null, errorNumber: null },
          ] as [string, () => void, string, Json],
      ),
      ["load 60 with its line", () => sim.failNextJob("db.import-load", 60, "", LINE), "dump_load_failed", { line: 12, errorNumber: 1064 }],
      ["load 61 with its line", () => sim.failNextJob("db.import-load", 61, "", LINE), "dump_statement_unsupported", { line: 12, errorNumber: 1064 }],
      ["load 60 without an answer", () => sim.failNextJob("db.import-load", 60), "dump_load_failed", { line: null, errorNumber: null }],
      ["load 60 with a negative line", () => sim.failNextJob("db.import-load", 60, "", '{"line":-1,"errorNumber":1064}\n'), "dump_load_failed", { line: null, errorNumber: null }],
      ["load 124", () => sim.failNextJob("db.import-load", 124), "timed_out"],
      ["load 137", () => sim.failNextJob("db.import-load", 137), "timed_out"],
      ["load 11", () => sim.failNextJob("db.import-load", 11), "unavailable"],
      ["load 1", () => sim.failNextJob("db.import-load", 1), "other"],
      ["load 64", () => sim.failNextJob("db.import-load", 64), "other"],
      ["prepare 1", () => sim.failNextJob("db.import", 1), "unavailable"],
      ["prepare 84", () => sim.failNextJob("db.import", 84), "dump_names_unsupported"],
      ["prepare 85", () => sim.failNextJob("db.import", 85), "site_objects_unsupported"],
      ["prepare 86", () => sim.failNextJob("db.import", 86), "other"],
      ["prepare 137", () => sim.failNextJob("db.import", 137), "timed_out"],
      ["finalize 25", () => sim.failNextJob("wordpress.import-finalize", 25), "site_check_failed"],
      ["finalize 26", () => sim.failNextJob("wordpress.import-finalize", 26), "address_rewrite_failed"],
      ["finalize 20", () => sim.failNextJob("wordpress.import-finalize", 20), "other"],
      ["finalize 124", () => sim.failNextJob("wordpress.import-finalize", 124), "timed_out"],
      ...(
        [
          ["not_a_zip", "archive_not_zip"],
          ["dump_not_sql", "dump_not_sql"],
          ["archive_unsafe", "archive_unsafe"],
          ["archive_limit", "archive_limit"],
          ["archive_not_wordpress", "archive_not_wordpress"],
          ["disk_full", "disk_full"],
          ["staging_unsafe", "staging_unsafe"],
          ["files_missing", "files_missing"],
          ["not_found", "other"],
          ["invalid_path", "other"],
        ] as const
      ).map(([helper, r]) => [`unpack ${helper}`, () => sim.files.failNextImport("import.unpack", helper), r] as [string, () => void, string]),
      ["switch disk_full", () => sim.files.failNextImport("import.switch", "disk_full"), "disk_full"],
      ["unpack helper time limit", () => faults.set("import.unpack", { when: "before", error: () => coded("OPERATION_INTERRUPTED") }), "timed_out"],
      ["unpack executor down", () => faults.set("import.unpack", { when: "before", error: () => coded("DOCKER_ENGINE_UNAVAILABLE") }), "unavailable"],
    ];
    const got: [string, unknown, unknown, Json][] = [];
    for (const [name, arm, , extra] of cases) {
      const id = await run(arm);
      const stored = (await lastImport())!;
      expect([name, stored["operationId"], (await opRow(id)).status]).toEqual([name, id, "failed"]);
      got.push([name, stored["outcome"], stored["reason"], extra ? { line: stored["line"], errorNumber: stored["errorNumber"] } : {}]);
    }
    expect(got).toEqual(cases.map(([name, , r, extra]) => [name, expect.stringMatching(/^(nothing_changed|site_restored)$/), r, extra ?? {}]));
    const reasons = (await dbClient.db.select().from(siteWordpressState)).map((s) => (s.lastImport as Json | null)?.["reason"]);
    for (const r of [...reasons, ...got.map(([, , x]) => x)]) expect(WORDPRESS_IMPORT_REASONS).toContain(r);
  });

  it("reasons: a load refused with another exit than 60 or 61 stores no line and no error number, even when its answer has them", async () => {
    await run(() => sim.failNextJob("db.import-load", 50, "", LINE));
    const stored = (await lastImport())!;
    expect([stored["reason"], stored["line"], stored["errorNumber"]]).toEqual(["dump_unsafe", null, null]);
  });

  // ---- point 13 ----
  it.each([
    ["a name outside the left-out list", { entries: 5, leftOut: ["wp-content/plugins/neutral.php"] }],
    ["a path climbing out", { entries: 5, leftOut: ["../wp-config.php"] }],
    ["a control character", { entries: 5, leftOut: ["wp-config.php\u0007"] }],
    ["a negative count", { entries: -1, leftOut: [] }],
  ])("trust: an unpack answer with %s fails the import as other, undone, and stores nothing of it", async (_name, answer) => {
    const id = await run(() => answers.set("import.unpack", () => answer));
    expect(sent).toEqual(["import.stat", "import.unpack", "db.import:undo", "import.undo"]);
    expect((await opRow(id)).status).toBe("failed");
    expect(await stepsOf(id)).toMatchObject({ unpack: "failed", database: "skipped", switch: "skipped", finish: "skipped" });
    const stored = (await lastImport())!;
    expect([stored["outcome"], stored["reason"], stored["leftOut"]]).toEqual(["nothing_changed", "other", []]);
    if (answer.leftOut[0]) expect(JSON.stringify(stored)).not.toContain(answer.leftOut[0]);
    expect(sim.files.importState(await svc())).toEqual({ gate: false, plans: [] });
  });

  it("trust: an extra key in an unpack answer is dropped, the import goes on, and the key is stored nowhere", async () => {
    const id = await run(() =>
      answers.set("import.unpack", (real) => ({ ...(real as Json), note: "/srv/sites/neutral", leftOut: ["wp-config.php"] })),
    );
    expect((await opRow(id)).status).toBe("succeeded");
    const stored = (await lastImport())!;
    expect([stored["outcome"], stored["leftOut"]]).toEqual(["imported", ["wp-config.php"]]);
    const rows = JSON.stringify([await dbClient.db.select().from(operationSteps), await dbClient.db.select().from(auditEvents), stored]);
    expect(rows).not.toContain("/srv/sites/neutral");
  });

  // ---- point 14 ----
  it("contract: the import DTOs refuse from outside what the API must never answer", () => {
    const good = {
      operationId: `op_${"a".repeat(32)}`,
      finishedAt: "2026-11-16T03:00:00.000Z",
      outcome: "imported",
      reason: null,
      backup: "skipped",
      oldAddress: "http://old.example.test",
      leftOut: ["wp-config.php"],
      tables: 12,
      line: null,
      errorNumber: null,
    };
    expect(SiteWordpressLastImportDtoSchema.safeParse(good).success).toBe(true);
    const bad: [string, Json][] = [
      ["an unknown key", { ...good, extra: 1 }],
      ["a key named password", { ...good, password: "sentinel" }],
      ["an address with a path", { ...good, oldAddress: "http://old.example.test/wp" }],
      ["an address with a user part", { ...good, oldAddress: "http://admin@old.example.test" }],
      ["an address in upper case", { ...good, oldAddress: "http://OLD.example.test" }],
      ["an address with a control character", { ...good, oldAddress: "http://old.example.test\u0007" }],
      ["an address with NUL", { ...good, oldAddress: "http://old.example.test\u0000" }],
      ["an address over 300 characters", { ...good, oldAddress: `http://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.test` }],
      ["an address that is not http", { ...good, oldAddress: "ftp://old.example.test" }],
      ["a reason not in R157", { ...good, reason: "undo_incomplete" }],
      ["a left-out name not in the list", { ...good, leftOut: ["wp-content/plugins/x.php"] }],
      ["a left-out path climbing out", { ...good, leftOut: ["../wp-config.php"] }],
      ["seventeen left-out names", { ...good, leftOut: Array.from({ length: 17 }, () => "wp-config.php") }],
      ["an errorNumber over 99999", { ...good, errorNumber: 100_000 }],
      ["a negative line", { ...good, line: -1 }],
      ["an operation id with a control character", { ...good, operationId: `op_${"a".repeat(31)}\u0007` }],
      ["an operation id with NUL", { ...good, operationId: `op_${"a".repeat(31)}\u0000` }],
    ];
    expect(bad.filter(([, v]) => SiteWordpressLastImportDtoSchema.safeParse(v).success).map(([n]) => n)).toEqual([]);

    const dto = {
      available: true,
      backupsConfigured: false,
      slots: { archive: { state: "complete", size: 1, uploadId: null }, dump: { state: "partial", size: 1, uploadId: "upload_dump_0123456789abcdef" } },
      earlierImportUnfinished: false,
      runningOperation: null,
      lastImport: good,
    };
    expect(SiteWordpressImportDtoSchema.safeParse(dto).success).toBe(true);
    const badDto: [string, Json][] = [
      ["an unknown key", { ...dto, extra: 1 }],
      ["a key named secret", { ...dto, secret: "x" }],
      ["a third slot", { ...dto, slots: { ...dto.slots, theme: dto.slots.archive } }],
      ["an upload id with a control character", { ...dto, slots: { ...dto.slots, dump: { ...dto.slots.dump, uploadId: "upload_dump_0123456789\u0007" } } }],
      ["an upload id with a slash", { ...dto, slots: { ...dto.slots, dump: { ...dto.slots.dump, uploadId: "upload/../0123456789ab" } } }],
      ["a running operation of seven steps", { ...dto, runningOperation: { id: "op_x", kind: WORDPRESS_IMPORT_KIND, status: "running", steps: Array.from({ length: 7 }, () => ({ key: "check", status: "pending" })) } }],
    ];
    expect(badDto.filter(([, v]) => SiteWordpressImportDtoSchema.safeParse(v).success).map(([n]) => n)).toEqual([]);
    // No key of either shape is named password or secret.
    const keys = [...Object.keys(SiteWordpressImportDtoSchema.shape), ...Object.keys(SiteWordpressLastImportDtoSchema.shape)];
    expect(keys.filter((k) => /password|secret/i.test(k))).toEqual([]);
  });
});
