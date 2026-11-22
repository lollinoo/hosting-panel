// Q8 · A20 and the spec §20 sentinel: a running application stack changes nothing a WordPress site sends the executor.
// The same site life runs twice: once on a panel with no stack (control) and once with a running stack. The frozen pins
// in fixtures/site-type-pins are never rewritten here; the steps they do not cover (domain add, TLS assignment) are
// compared against the control run.
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST } from "@hosting-panel/contracts";
import {
  createDatabaseClient,
  domains,
  eq,
  operations,
  resourceQuotas,
  sql,
  users,
  stackRevisions,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { SITE_WORK_BLOCKED_JOBS, enqueueHostJob } from "../src/host/host-jobs.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { APP_TEST_ALLOWLIST } from "./fixtures/app-stack-harness.js";
import { skipPasswordChange } from "./fixtures/password-change.js";
import { issueCert, issuePki } from "./fixtures/tls-certgen.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Call {
  readonly method: string;
  readonly args: unknown[];
}

const FIXTURES = new URL("./fixtures/site-type-pins/", import.meta.url);
const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-login-pass-0001";
const ADMIN_EMAIL = "admin@example.test";
const OWNER_EMAIL = "owner@example.test";
const SETUP = { installationName: "Pins", hostHostname: "panel.example.test", hostIpv4: "192.0.2.10" };
// Same site, same secrets as site-type-pins.test.ts: the fixtures hold these exact request bodies.
const SITE = {
  name: "Site A",
  domain: "wp-a.example.test",
  includeWww: true,
  phpVersion: "8.3",
  title: "Site A",
  adminUser: "siteadmin",
  adminEmail: "admin@example.test",
  adminPassword: "sentinel-Admin-Pass-0001",
};
const BACKUP_SETTINGS = {
  endpoint: "https://s3.example.test",
  region: "eu-south-1",
  bucket: "pins-bucket",
  prefix: "panel/pins",
  accessKeyId: "SENTINELACCESSKEY01",
  secretAccessKey: "sentinel-secret-access-key-0001",
  scheduleHourUtc: 2,
  retentionDays: 14,
};
const EXTRA_HOST = "shop.example.test";
const PKI = issuePki();
// One certificate for both runs: its key is random, and the request carries it.
const LEAF = issueCert({ dns: [EXTRA_HOST], issuer: PKI.intermediate });
const SECRET_KEY = /(password|passwordHash|secretAccessKey|accessKeyId|masterKey|token)$/i;
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const RANDOM = /(?<![0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64}|[0-9a-f]{32})(?![0-9a-f])/g;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const WEB_SOURCE = APP_BUILT_IN_TEMPLATES[0]!.source;

/** Same key order as the stack revision hash. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Json).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Drops every siteType key at any depth (the pins are compared without it). */
function stripSiteType(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSiteType);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Json).filter(([k]) => k !== "siteType").map(([k, v]) => [k, stripSiteType(v)]));
}

/** Random-by-design values become stable tokens numbered by first appearance; secrets keep only their key. Same rules as the pin test. */
function tokenize(value: unknown, derived: ReadonlyMap<string, string>, keep: ReadonlySet<string>, secrets: Set<string>): unknown {
  const ids = new Map<string, string>();
  const secretTokens = new Map<string, string>();
  const idToken = (raw: string) => {
    if (!ids.has(raw)) ids.set(raw, `<id:${ids.size + 1}>`);
    return ids.get(raw)!;
  };
  const str = (s: string): string => {
    if (keep.has(s)) return s;
    let out = s.replace(TIME, "<time>").replace(RANDOM, (m) => idToken(m));
    for (const [hex, label] of derived) out = out.split(hex).join(label);
    return out;
  };
  const walk = (node: unknown, key: string | null): unknown => {
    if (Array.isArray(node)) return node.map((v) => walk(v, null));
    if (node !== null && typeof node === "object") {
      const entries = Object.entries(node as Json).sort(([a], [b]) => a.localeCompare(b));
      return Object.fromEntries(
        entries.map(([k, v]) => {
          if (k === "resolvedSecrets" && v !== null && typeof v === "object") {
            for (const s of Object.values(v as Json)) secrets.add(String(s));
            return [k, Object.fromEntries(Object.keys(v as Json).sort().map((name) => [name, "<present>"]))];
          }
          return [k, walk(v, k)];
        }),
      );
    }
    if (typeof node === "string") {
      if (key !== null && SECRET_KEY.test(key) && node !== "") {
        secrets.add(node);
        if (!secretTokens.has(node)) secretTokens.set(node, `<secret:${secretTokens.size + 1}>`);
        return secretTokens.get(node);
      }
      return str(node);
    }
    return node;
  };
  return walk(value, null);
}

const fixture = (file: string) => readFileSync(new URL(file, FIXTURES), "utf8");

interface World {
  readonly app: ControlPlaneAppHandle;
  readonly dbClient: DatabaseClient;
  readonly sim: InMemoryDockerSimulatorAdapter;
  readonly orgId: string;
  readonly siteId: string;
  readonly adminToken: string;
  readonly steps: Map<string, Call[]>;
  readonly extra: Map<string, unknown>;
  readonly stackId: string | null;
  call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: Json; raw: string }>;
  drain(): Promise<void>;
  /** The fixture text of a recorded value (the pin test's rendering). */
  render(value: unknown): string;
  close(): Promise<void>;
}

/** One panel, one WordPress site's life. With `withStack` a stack is deployed and running before the first site request. */
async function runWorld(withStack: boolean): Promise<World> {
  const dbClient = createDatabaseClient({ mode: "pglite" });
  await dbClient.migrate();
  await setupInstallation(dbClient.db, SETUP);
  const admin = await createServerAdmin(dbClient.db, KEY, { email: ADMIN_EMAIL, name: "Admin", password: PW });
  const sim = new InMemoryDockerSimulatorAdapter();
  const calls: Call[] = [];
  let recordingOn = false;
  const recorder = new Proxy(sim, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function" || typeof prop !== "string") return v;
      return (...args: unknown[]) => {
        if (recordingOn) calls.push({ method: prop, args: JSON.parse(JSON.stringify(args)) as unknown[] });
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const app = await createControlPlaneApp({
    listen: true,
    host: "127.0.0.1",
    port: 0,
    databaseClient: dbClient,
    secretsMasterKey: KEY,
    jwtSigningKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    runtimeBackend: "linux-systemd",
    dockerExecutor: recorder,
    hostAgent: new InMemoryHostSimulatorAdapter(),
    autoProcessOutbox: false,
    outboxPollIntervalMs: null,
    driftReconcileIntervalMs: null,
    domainReconcileIntervalMs: null,
    mailRelayRetryIntervalMs: null,
    sftpRetryIntervalMs: null,
    backupScheduleIntervalMs: null,
    tlsConvergeIntervalMs: null,
    recoverUnknownOnStart: false,
    dnsLookup: { lookup: async () => ({ a: [], aaaa: [] }) },
    tlsValidatorOptions: { trustAnchors: [PKI.root.pem] },
    appFeatures: { applicationTemplatesAvailable: true, applicationStacksAvailable: true },
    appTemplateValidation: { allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] },
  });

  async function call(method: string, path: string, body?: unknown, token?: string) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Idempotency-Key": randomUUID(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }
  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await call("POST", "/v1/auth/login", {
      email,
      password,
      ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
    });
    return res.body.data.accessToken as string;
  }
  async function drain(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      if ((await app.outboxWorker.processPendingOnce()).claimed === 0) return;
    }
    throw new Error("outbox never drained");
  }

  const adminToken = await login(ADMIN_EMAIL, PW, admin.totpSecretBase32);
  const created = await call("POST", "/v1/admin/customer-account", { organizationName: "Org A", ownerEmail: OWNER_EMAIL, ownerName: "Owner A" }, adminToken);
  expect(created.status, created.raw).toBe(201);
  await skipPasswordChange(dbClient.db, OWNER_EMAIL);
  const orgId = created.body.data.organizationId as string;
  const ownerToken = await login(OWNER_EMAIL, created.body.data.temporaryPassword as string);
  const owner = (method: string, path: string, body?: unknown) => call(method, path, body, ownerToken);

  let stackId: string | null = null;
  if (withStack) {
    // Room for the stack next to the site, and a published template whose images are on the code allowlist.
    await dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, orgId));
    const tpl = await call("POST", "/v1/admin/app-templates", { slug: `web-${randomUUID().slice(0, 8)}`, source: WEB_SOURCE }, adminToken);
    expect(tpl.status, tpl.raw).toBe(201);
    const on = await call("PATCH", `/v1/admin/app-templates/${tpl.body.data.id as string}`, { enabled: true }, adminToken);
    expect(on.status, on.raw).toBe(200);
    const dep = await owner("POST", `/v1/organizations/${orgId}/app-stacks`, {
      templateVersionId: tpl.body.data.defaultVersionId,
      name: "witness-stack",
      deploy: true,
    });
    expect(dep.status, dep.raw).toBe(202);
    stackId = dep.body.data.stackId as string;
    for (let i = 0; i < 10; i++) {
      await drain();
      const row = await owner("GET", `/v1/organizations/${orgId}/app-stacks/${stackId}`);
      if (row.body.data?.status === "running") break;
    }
    const row = await owner("GET", `/v1/organizations/${orgId}/app-stacks/${stackId}`);
    expect(row.body.data.status, row.raw).toBe("running");
  }

  const steps = new Map<string, Call[]>();
  const extra = new Map<string, unknown>();
  let siteId = "";
  const siteBase = (tail = "") => `/v1/organizations/${orgId}/managed-sites/${siteId}${tail}`;
  const keepRaw = new Set<string>();
  async function step(name: string, run: () => Promise<void>): Promise<void> {
    const from = calls.length;
    recordingOn = true;
    try {
      await run();
    } finally {
      recordingOn = false;
    }
    steps.set(name, calls.slice(from));
  }
  const opStatus = async (id: string) => (await owner("GET", `/v1/organizations/${orgId}/operations/${id}`)).body.data.status as string;

  async function routeHash(): Promise<Json> {
    const rows = await dbClient.db.execute(sql`SELECT applied_routes_hash AS h, wordpress_url AS u FROM sites WHERE id = ${siteId}`);
    const row = (rows as unknown as { rows: Array<{ h: string; u: string | null }> }).rows[0]!;
    const routes = sim.appliedRoutes.get(siteId)!;
    const hosts = [...routes.hosts]
      .sort((a, b) => a.hostname.localeCompare(b.hostname))
      .map((h) => [h.hostname, h.tls, h.httpsRedirect, h.redirectTo]);
    const hashOf = { hosts, wordpressUrl: row.u };
    keepRaw.add(row.h);
    return { routePlanHash: row.h, recomputed: sha256(JSON.stringify(hashOf)), hashOf };
  }

  await step("provision", async () => {
    const res = await owner("POST", `/v1/organizations/${orgId}/managed-sites`, SITE);
    expect(res.status, res.raw).toBe(202);
    siteId = res.body.data.siteId as string;
    await drain();
    expect(await opStatus(res.body.data.operationId as string)).toBe("succeeded");
  });
  const deploy = steps.get("provision")!.find((c) => c.method === "deployService")!;
  const svcId = (deploy.args[0] as Json).serviceInstanceId as string;
  const rev = (await dbClient.db.select().from(stackRevisions).where(eq(stackRevisions.serviceInstanceId, svcId)))[0]!;
  keepRaw.add(rev.specHash);
  extra.set("specAfterCreate", {
    revisionNumber: rev.revisionNumber,
    specHash: rev.specHash,
    recomputed: sha256(canonicalJson({ config: rev.declarativeConfig, secretRefs: rev.secretRefs, resourceLimits: rev.resourceLimits })),
    hashOf: { config: rev.declarativeConfig, secretRefs: rev.secretRefs, resourceLimits: rev.resourceLimits },
  });
  extra.set("routesAfterCreate", await routeHash());

  await step("domains", async () => {
    const list = (await owner("GET", siteBase("/domains"))).body.data.domains as Json[];
    const expires = new Date(Date.now() + 60 * 86_400_000);
    for (const d of list) {
      await dbClient.db.update(domains).set({ certStatus: "active", certExpiresAt: expires }).where(eq(domains.id, d.id as string));
      sim.issueCertificate(d.hostname as string, expires.toISOString());
    }
    const www = list.find((d) => d.hostname === `www.${SITE.domain}`)!;
    const res = await owner("POST", siteBase(`/domains/${www.id as string}/primary`));
    expect(res.status, res.raw).toBe(200);
    await drain();
  });
  extra.set("routesAfterPrimary", await routeHash());

  expect((await call("PATCH", "/v1/admin/backups", BACKUP_SETTINGS, adminToken)).status).toBe(200);
  let backupId = "";
  await step("backup", async () => {
    const res = await owner("POST", siteBase("/backups"), {});
    expect(res.status, res.raw).toBe(202);
    backupId = res.body.data.backupId as string;
    await drain();
    expect(await opStatus(res.body.data.operationId as string)).toBe("succeeded");
  });
  await step("restore", async () => {
    const res = await owner("POST", siteBase(`/backups/${backupId}/restore`), { confirmName: SITE.name });
    expect(res.status, res.raw).toBe(202);
    await drain();
    expect(await opStatus(res.body.data.operationId as string)).toBe("succeeded");
  });

  // Steps the frozen pins do not cover: compared with the control run.
  await step("domainAdd", async () => {
    const res = await owner("POST", siteBase("/domains"), { hostname: EXTRA_HOST, includeWww: false });
    expect(res.status, res.raw).toBe(201);
    await drain();
  });
  const imported = await owner("POST", siteBase("/tls-certificates"), {
    name: "Shop certificate",
    format: "pem",
    leafPem: LEAF.pem,
    chainPem: PKI.intermediate.pem,
    privateKeyPem: LEAF.keyPem,
  });
  expect(imported.status, imported.raw).toBe(201);
  const certId = imported.body.data.id as string;
  const versionId = imported.body.data.versions.at(-1).id as string;
  const [extraDomain] = await dbClient.db.select().from(domains).where(eq(domains.hostname, EXTRA_HOST));
  await step("tlsAssign", async () => {
    const res = await owner("POST", siteBase(`/tls-certificates/${certId}/versions/${versionId}/activate`), { domainIds: [extraDomain!.id] });
    expect(res.status, res.raw).toBe(202);
    await drain();
  });
  extra.set("routesAtEnd", await routeHash());

  const render = (value: unknown): string => {
    const h = sha256(siteId);
    const derived = new Map([
      [h.slice(0, 12), "<site-sha12>"],
      [h.slice(0, 8), "<site-sha8>"],
    ]);
    const secrets = new Set<string>([SITE.adminPassword, BACKUP_SETTINGS.secretAccessKey, PW]);
    const text = `${JSON.stringify(tokenize(stripSiteType(value), derived, keepRaw, secrets), null, 2)}\n`;
    for (const s of secrets) expect(text.includes(s), "a secret is in a recorded request").toBe(false);
    return text;
  };

  return {
    app,
    dbClient,
    sim,
    orgId,
    siteId,
    adminToken,
    steps,
    extra,
    stackId,
    call: (method, path, body, token) => call(method, path, body, token ?? ownerToken),
    drain,
    render,
    async close() {
      await app.close();
      await dbClient.close();
    },
  };
}

describe("A20 / §20 sentinel: application stacks leave WordPress sites untouched", () => {
  let withStack: World;
  let stackSnapshotBefore: string;

  const snapshotText = (w: World) => JSON.stringify(w.sim.appStacks.getAppStackSnapshot(w.stackId!), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));

  // The control panel is closed before the second one starts (memory): only its rendered text stays.
  const controlRenders = new Map<string, string>();
  let controlRoutes: unknown;

  beforeAll(async () => {
    const control = await runWorld(false);
    for (const [name, calls] of control.steps) controlRenders.set(name, control.render({ calls }));
    controlRoutes = control.extra.get("routesAtEnd");
    await control.close();
    withStack = await runWorld(true);
    stackSnapshotBefore = snapshotText(withStack);
  }, 300_000);

  afterAll(async () => {
    await withStack?.close();
  });

  const controlText = (name: string) => controlRenders.get(name)!;

  it("the stack is running and has its own components before the site is touched", () => {
    expect(withStack.stackId).toMatch(/^stk_/);
    expect(stackSnapshotBefore.length).toBeGreaterThan(10);
  });

  it.each([
    ["provision", "provision-jobs.json"],
    ["domains", "domains-jobs.json"],
    ["backup", "backup-requests.json"],
    ["restore", "restore-requests.json"],
  ])("%s: the executor requests are the frozen pin %s", (name, file) => {
    const calls = withStack.steps.get(name)!;
    expect(calls.length, `${name} recorded no request`).toBeGreaterThan(0);
    expect(withStack.render({ calls })).toBe(fixture(file));
  });

  it("the spec hash and the route plan hashes are the frozen ones", () => {
    const spec = withStack.extra.get("specAfterCreate") as Json;
    expect(spec.recomputed).toBe(spec.specHash);
    const pinned = JSON.parse(fixture("spec-hash.json")) as Json;
    expect(JSON.parse(withStack.render(spec))).toEqual(pinned.afterCreate);
    const routes = JSON.parse(fixture("route-hash.json")) as Json;
    expect(JSON.parse(withStack.render(withStack.extra.get("routesAfterCreate")))).toEqual(routes.afterCreate);
    expect(JSON.parse(withStack.render(withStack.extra.get("routesAfterPrimary")))).toEqual(routes.afterPrimaryChange);
  });

  it.each(["provision", "domains", "backup", "restore", "domainAdd", "tlsAssign"])(
    "%s: the requests equal those of a panel with no stack, and are not empty",
    (name) => {
      const calls = withStack.steps.get(name)!;
      expect(calls.length, `${name} recorded no request`).toBeGreaterThan(0);
      expect(withStack.render({ calls })).toBe(controlText(name));
    },
  );

  it("no site request names the stack, one of its components or the application namespace", () => {
    const everything = JSON.stringify([...withStack.steps.values()]);
    expect(everything).not.toContain(withStack.stackId!);
    expect(everything).not.toMatch(/hp_app_|app-stack|appStack/i);
  });

  it("the site life leaves the stack exactly as it was", () => {
    expect(snapshotText(withStack)).toBe(stackSnapshotBefore);
  });

  it("the site's own routes end the same with and without a stack", () => {
    const strip = (r: unknown) => (r as Json).hashOf;
    expect(strip(withStack.extra.get("routesAtEnd"))).toEqual(strip(controlRoutes));
  });

  describe("host jobs and an active stack operation", () => {
    let actorId = "";
    beforeAll(async () => {
      actorId = (await withStack.dbClient.db.select().from(users).where(eq(users.email, ADMIN_EMAIL)))[0]!.id;
    });
    const job = (j: Parameters<typeof enqueueHostJob>[1]["job"]) => ({
      job: j,
      actorId,
      idempotencyKey: randomUUID(),
      audit: { action: "admin.host_service.restart", targetType: "host", targetId: null, details: {}, ipAddress: null, userAgent: null },
    });
    const reasonOf = async (j: Parameters<typeof enqueueHostJob>[1]["job"]): Promise<string | { operationId: string }> => {
      try {
        return await enqueueHostJob(withStack.dbClient.db, job(j));
      } catch (err) {
        const e = err as { code?: string; details?: Array<{ reason?: string }> };
        if (e.code === undefined) throw err;
        return `${e.code}:${e.details?.[0]?.reason}`;
      }
    };
    const stackOp = async () =>
      (await withStack.dbClient.db.select().from(operations).where(eq(operations.resourceId, withStack.stackId!))).sort(
        (a, b) => b.submittedAt.getTime() - a.submittedAt.getTime(),
      )[0]!;
    const setHostJobsDone = () =>
      withStack.dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.kind, "host.job"));

    it("with a stack action queued, every site-work-blocked job is refused and a job outside the list is not", async () => {
      const stop = await withStack.call("POST", `/v1/organizations/${withStack.orgId}/app-stacks/${withStack.stackId!}/stop`, {});
      expect(stop.status, stop.raw).toBe(202);
      expect((await stackOp()).status).toBe("queued");
      for (const j of SITE_WORK_BLOCKED_JOBS) expect(await reasonOf(j), j).toBe("RESOURCE_LOCKED:site_work_running");
      expect(await reasonOf("restart_hp_web")).toMatchObject({ operationId: expect.stringMatching(/^op_/) });
      await setHostJobsDone();
    });

    it("once the stack operation ends, the same jobs are accepted", async () => {
      await withStack.drain();
      const op = await stackOp();
      expect(["succeeded", "failed"]).toContain(op.status);
      expect(op.status).toBe("succeeded");
      for (const j of SITE_WORK_BLOCKED_JOBS) {
        expect(await reasonOf(j), j).toMatchObject({ operationId: expect.stringMatching(/^op_/) });
        await setHostJobsDone();
      }
    });

    it("a stack operation left in unknown still blocks, and releasing it unblocks", async () => {
      const start = await withStack.call("POST", `/v1/organizations/${withStack.orgId}/app-stacks/${withStack.stackId!}/start`, {});
      expect(start.status, start.raw).toBe(202);
      const op = await stackOp();
      await withStack.dbClient.db.update(operations).set({ status: "unknown" }).where(eq(operations.id, op.id));
      for (const j of SITE_WORK_BLOCKED_JOBS) expect(await reasonOf(j), j).toBe("RESOURCE_LOCKED:site_work_running");
      await withStack.dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, op.id));
      expect(await reasonOf("restart_hp_docker_executor")).toMatchObject({ operationId: expect.stringMatching(/^op_/) });
    });
  });
});
