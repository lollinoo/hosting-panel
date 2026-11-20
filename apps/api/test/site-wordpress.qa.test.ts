import { generateKeyPairSync, randomUUID } from "node:crypto";
import {
  SiteJobIpcRequestSchema,
  SiteWordpressDtoSchema,
  WORDPRESS_UPDATE_TARGET_PATTERN,
  WORDPRESS_USER_ID_PATTERN,
  type IpcSigningKey,
  type IpcVerificationKey,
  type WordpressStateResult,
} from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  eq,
  memberships,
  membershipRoles,
  operations,
  operationSteps,
  organizations,
  outboxEvents,
  resourceGrants,
  siteBackups,
  siteWordpressState,
  sites,
  upsertBackupSettings,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import {
  DockerExecutorIpcServer,
  InMemoryDockerSimulatorAdapter,
  SignedDockerExecutorIpcClient,
  SIMULATED_WORDPRESS_STATE,
} from "@hosting-panel/docker-executor";
import type { DockerExecutorPort, SiteJobRequest, SiteJobResult } from "@hosting-panel/executor-contracts";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 9);
const JWT_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PW = "qa horse battery staple";
const SETUP = { installationName: "QA", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const SITE = {
  name: "QA Site",
  domain: "qa-a.example.test",
  title: "QA Site",
  adminUser: "admin",
  adminEmail: "admin@example.test",
  adminPassword: "qa-fixture-Pass-123456",
};
const SETTINGS = {
  endpoint: "https://s3.example.test",
  region: "eu-south-1",
  bucket: "qa-backups",
  prefix: "panel",
  accessKeyId: "AKIAQAONLY00001",
  secretAccessKey: "qa-only-not-a-secret",
  scheduleHourUtc: 2,
  retentionDays: 14,
};
const MARKER = "QA-TAIL-MARKER-7f3c9e";
const WP_KINDS = ["wordpress.inspect", "wordpress.update", "wordpress.settle", "wordpress.reset-password"];
// The closed parameter set per kind, written here from R126, not read from the executor.
const PARAMS: Record<string, readonly string[]> = {
  "wordpress.inspect": ["phpVersion"],
  "wordpress.update": ["phpVersion", "target"],
  "wordpress.settle": ["phpVersion"],
  "wordpress.reset-password": ["phpVersion", "userId"],
};
const AMBIGUOUS = () => Object.assign(new Error("executor connection lost"), { code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Call = { method: string; args: unknown[]; result?: unknown };

// Every site job the API sent to the executor, across all cases of this file.
const allJobs: SiteJobRequest[] = [];

/** Wraps the simulator so that every call the API makes is recorded with its answer. */
function recording(target: InMemoryDockerSimulatorAdapter, calls: Call[]): DockerExecutorPort {
  return new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const call: Call = { method: String(prop), args };
        calls.push(call);
        const out: unknown = (value as (...a: unknown[]) => unknown).apply(t, args);
        if (out instanceof Promise) {
          return out.then((r: unknown) => {
            calls.push({ method: `<-${String(prop)}`, args, result: r });
            return r;
          });
        }
        return out;
      };
    },
  }) as unknown as DockerExecutorPort;
}

describe("QA: WordPress tools through the real routes and the real outbox worker", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let port: DockerExecutorPort;
  let calls: Call[];
  let logs: string[];
  let adminToken: string;
  let a: { orgId: string; token: string; siteId: string; userId: string };
  let b: { orgId: string; siteId: string };
  let ready: boolean;

  const startApp = async () =>
    createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem: JWT_PEM,
      runtimeBackend: "linux-systemd",
      dockerExecutor: port,
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

  async function login(email: string, password: string, totpSecret?: string): Promise<string> {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
      }),
    });
    return ((await res.json()) as Json).data.accessToken as string;
  }

  async function call(method: string, path: string, as: string, body?: unknown, key: string = randomUUID()): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": key },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  async function customerWithSite(name: string, email: string, domain: string) {
    const created = await call("POST", "/v1/admin/customer-account", adminToken, { organizationName: name, ownerEmail: email, ownerName: name });
    expect(created.status).toBe(201);
    const orgId = created.body.data.organizationId as string;
    await skipPasswordChange(dbClient.db, email);
    const token = await login(email, created.body.data.temporaryPassword as string);
    const site = await call("POST", `/v1/organizations/${orgId}/managed-sites`, token, { ...SITE, domain });
    expect(site.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const [user] = await dbClient.db.select({ id: users.id }).from(users).where(eq(users.email, email));
    return { orgId, token, siteId: site.body.data.siteId as string, userId: user!.id };
  }

  const wp = (site: { orgId: string; siteId: string } = a) => `/v1/organizations/${site.orgId}/managed-sites/${site.siteId}/wordpress`;
  const opRow = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const tab = async () => SiteWordpressDtoSchema.parse((await call("GET", wp(), a.token)).body.data);
  const jobs = () => calls.filter((c) => c.method === "runSiteJob").map((c) => c.args[0] as SiteJobRequest);
  const jobsOf = (opId: string) => jobs().filter((j) => j.jobId.startsWith(`job_${opId.replace(/^op_/, "")}_`));
  const audits = async (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const configureBackups = () => upsertBackupSettings(dbClient.db, KEY, { ...SETTINGS, updatedByUserId: a.userId });
  const simSite = () => {
    if (!sim.wordpressSites.has(a.siteId)) sim.wordpressSites.set(a.siteId, structuredClone(SIMULATED_WORDPRESS_STATE));
    return sim.wordpressSites.get(a.siteId)!;
  };
  /** Every row of the tables a secret or a job's output must never reach, as one text. */
  const storedText = async () =>
    JSON.stringify([
      await dbClient.db.select().from(auditEvents),
      await dbClient.db.select().from(outboxEvents),
      await dbClient.db.select().from(operations),
      await dbClient.db.select().from(operationSteps),
      await dbClient.db.select().from(siteWordpressState),
      await dbClient.db.select().from(siteBackups),
    ]);
  const counts = async () => ({
    ops: (await dbClient.db.select().from(operations)).length,
    outbox: (await dbClient.db.select().from(outboxEvents)).length,
    copies: (await dbClient.db.select().from(siteBackups)).length,
    calls: calls.length,
  });
  const refreshed = async () => {
    const res = await call("POST", `${wp()}/refresh`, a.token, {});
    expect(res.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    return res.body.data.operationId as string;
  };
  /** Lets the job run on the simulated site, then loses its answer once, as when the executor restarts. */
  const loseAnswerOnce = (kind: string) => {
    const run = sim.runSiteJob.bind(sim);
    let lost = false;
    return vi.spyOn(sim, "runSiteJob").mockImplementation(async (req: SiteJobRequest): Promise<SiteJobResult> => {
      const res = await run(req);
      if (req.kind === kind && !lost) {
        lost = true;
        throw AMBIGUOUS();
      }
      return res;
    });
  };

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    ready = false;
    sim = new InMemoryDockerSimulatorAdapter();
    calls = [];
    port = recording(sim, calls);
    app = await startApp();
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);
    a = await customerWithSite("QA Org A", "owner-a@example.test", "qa-a.example.test");
    // One customer per dedicated server: the other organisation is the platform's own, holding a site.
    const kept = await call("POST", "/v1/admin/sites", adminToken, { ...SITE, domain: "qa-b.example.test", ownerOrganizationId: null });
    expect(kept.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    const [keptRow] = await dbClient.db.select().from(sites).where(eq(sites.id, kept.body.data.siteId as string));
    b = { orgId: keptRow!.organizationId, siteId: keptRow!.id };
    expect(b.orgId).not.toBe(a.orgId);
    calls.length = 0;
    ready = true;
    logs = [];
    const keep = (args: unknown[]) => logs.push(args.map((x) => (typeof x === "string" ? x : JSON.stringify(x) ?? String(x))).join(" "));
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      const original = console[level].bind(console);
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        keep(args);
        original(...args);
      });
    }
    for (const stream of [process.stdout, process.stderr]) {
      const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
      vi.spyOn(stream, "write").mockImplementation(((...args: unknown[]) => {
        keep([String(args[0])]);
        return original(...args);
      }) as typeof stream.write);
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (ready) allJobs.push(...jobs());
    await app.close();
    await dbClient.close();
  });

  describe("1. the whole path", () => {
    it("a check, one plugin and everything: from the request to what GET shows, without backups and without a copy", async () => {
      const startedAt = Date.now();
      const checkId = await refreshed();
      expect((await opRow(checkId)).status).toBe("succeeded");
      let got = await tab();
      expect(got.state).toEqual({ ...SIMULATED_WORDPRESS_STATE, checkedAt: expect.any(String), problem: null });
      expect(Date.parse(got.state!.checkedAt)).toBeGreaterThanOrEqual(startedAt - 1000);
      expect(got.state!.updatesKnown).toBe(true);
      expect(got.runningOperation).toBeNull();
      expect(jobsOf(checkId).map((j) => j.kind)).toEqual(["wordpress.inspect"]);

      const one = await call("POST", `${wp()}/updates`, a.token, { scope: "plugin", name: "classic-editor" });
      expect(one.status).toBe(202);
      const oneId = one.body.data.operationId as string;
      await app.outboxWorker.processPendingOnce();
      got = await tab();
      expect(got.lastUpdate).toEqual({
        operationId: oneId,
        target: { scope: "plugin", name: "classic-editor" },
        status: "succeeded",
        finishedAt: expect.any(String),
        problem: null,
        backup: "skipped",
        items: [{ type: "plugin", name: "classic-editor", oldVersion: "1.6.0", newVersion: "1.7.0", status: "updated" }],
      });
      expect(got.state!.plugins.find((p) => p.name === "classic-editor")).toMatchObject({ version: "1.7.0", updateVersion: null });
      expect(got.runningOperation).toBeNull();
      expect((await opRow(oneId)).status).toBe("succeeded");
      expect(jobsOf(oneId).map((j) => [j.kind, j.params["target"]])).toEqual([
        ["wordpress.update", "plugin:classic-editor"],
        ["wordpress.settle", undefined],
        ["wordpress.inspect", undefined],
      ]);
      expect(await dbClient.db.select().from(siteBackups)).toEqual([]);

      // New updates appear on the site; a check shows them, then "update everything" installs core, plugins, themes.
      const site = simSite();
      site.coreUpdate = "7.2.0";
      site.plugins[0]!.updateVersion = "5.8.0";
      site.themes[0]!.updateVersion = "1.6";
      await refreshed();
      expect((await tab()).state).toMatchObject({ coreVersion: "7.1.4", coreUpdate: "7.2.0" });
      const all = await call("POST", `${wp()}/updates`, a.token, { scope: "all" });
      expect(all.status).toBe(202);
      await app.outboxWorker.processPendingOnce();
      got = await tab();
      expect(got.lastUpdate).toMatchObject({ operationId: all.body.data.operationId, target: { scope: "all" }, status: "succeeded", backup: "skipped" });
      expect(got.lastUpdate!.items).toEqual([
        { type: "core", name: "wordpress", oldVersion: "7.1.4", newVersion: "7.2.0", status: "updated" },
        { type: "plugin", name: "akismet", oldVersion: "5.7.2", newVersion: "5.8.0", status: "updated" },
        { type: "theme", name: "twentytwentyfive", oldVersion: "1.5", newVersion: "1.6", status: "updated" },
      ]);
      expect(got.state).toMatchObject({ coreVersion: "7.2.0", coreUpdate: null });
      expect([...got.state!.plugins, ...got.state!.themes].map((i) => i.updateVersion)).toEqual([null, null, null]);
      expect(got.runningOperation).toBeNull();
    });

    it("with backups set up, the pre_update copy of the update's own operation succeeds before the update job is called", async () => {
      await configureBackups();
      await refreshed();
      calls.length = 0;
      const res = await call("POST", `${wp()}/updates`, a.token, { scope: "all" });
      expect(res.status).toBe(202);
      const opId = res.body.data.operationId as string;
      await app.outboxWorker.processPendingOnce();

      const updateAt = calls.findIndex((c) => c.method === "runSiteJob" && (c.args[0] as SiteJobRequest).kind === "wordpress.update");
      const copyDoneAt = calls.findIndex((c) => c.method === "<-backups" && (c.result as { state?: string }).state === "succeeded");
      const copyStartAt = calls.findIndex((c) => c.method === "backups" && (c.args[0] as { action: string }).action === "start");
      expect(copyStartAt).toBeGreaterThanOrEqual(0);
      expect(copyDoneAt).toBeGreaterThan(copyStartAt);
      expect(updateAt).toBeGreaterThan(copyDoneAt);
      expect((calls[copyStartAt]!.args[0] as { jobId: string }).jobId).toBe(opId);

      const copies = await dbClient.db.select().from(siteBackups);
      expect(copies).toEqual([expect.objectContaining({ siteId: a.siteId, kind: "pre_update", status: "succeeded", operationId: opId })]);
      expect((await tab()).lastUpdate).toMatchObject({ operationId: opId, status: "succeeded", backup: "taken" });
      expect((await opRow(opId)).status).toBe("succeeded");
    });

    it("when the copy fails nothing is updated and the last update says so", async () => {
      await configureBackups();
      await refreshed();
      sim.backupState.failNext("other");
      const res = await call("POST", `${wp()}/updates`, a.token, { scope: "plugin", name: "classic-editor" });
      expect(res.status).toBe(202);
      const opId = res.body.data.operationId as string;
      await app.outboxWorker.processPendingOnce();

      expect(jobs().filter((j) => j.kind === "wordpress.update")).toEqual([]);
      expect(simSite().plugins.find((p) => p.name === "classic-editor")!.version).toBe("1.6.0");
      const got = await tab();
      expect(got.lastUpdate).toMatchObject({ operationId: opId, status: "failed", problem: "backup_failed", backup: "failed", items: [] });
      expect(got.runningOperation).toBeNull();
      expect((await opRow(opId)).status).toBe("failed");
      const steps = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, opId));
      expect(Object.fromEntries(steps.map((s) => [s.key, s.status]))).toEqual({ backup: "failed", update: "skipped", settle: "skipped" });
      expect(await dbClient.db.select().from(siteBackups)).toEqual([expect.objectContaining({ kind: "pre_update", status: "failed", operationId: opId })]);
    });
  });

  describe("2. only closed kinds, only checked values", () => {
    const HOSTILE = ["plugin; id", "$(id)", "a`id`", "a b", "../x", "a\u0000b", "-x", "a".repeat(200), "x/../../etc", "a\nb"];

    it("hostile names in an update request are refused with 400 before any operation or executor call", async () => {
      await refreshed();
      // On the site, but not in the stored state: the stored state decides, not the request.
      simSite().plugins.push({ name: "hello-dolly", title: "Hello Dolly", status: "inactive", version: "1.7.2", updateVersion: "1.7.3" });
      const before = await counts();
      for (const scope of ["plugin", "theme"]) {
        for (const name of HOSTILE) {
          const res = await call("POST", `${wp()}/updates`, a.token, { scope, name });
          expect([scope, name, res.status, res.body.error?.code]).toEqual([scope, name, 400, "VALIDATION_ERROR"]);
        }
      }
      const known = await call("POST", `${wp()}/updates`, a.token, { scope: "plugin", name: "hello-dolly" });
      expect([known.status, known.body.error.details[0].reason]).toEqual([400, "item_unknown"]);
      // "%2e%2e" is left out: fetch folds it into "..", so it never reaches this route.
      for (const userId of ["1;id", "-1", "0x1", "1%20", "abc", "99999999999"]) {
        const res = await call("POST", `${wp()}/administrators/${userId}/password-reset`, a.token, {});
        expect([userId, res.status]).toEqual([userId, 400]);
      }
      expect(await counts()).toEqual(before);
      expect(await audits("site.wordpress.update")).toEqual([]);
    });

    it("the executor's IPC refuses an unknown kind, parameter or secret and a target or userId that does not fit", async () => {
      const hmac = "qa-only-ipc-key-0123456789abcdef0123456789";
      const signingKey: IpcSigningKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: hmac };
      const verificationKey: IpcVerificationKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: hmac };
      const executor = new InMemoryDockerSimulatorAdapter();
      const server = new DockerExecutorIpcServer({ executor, keyring: { "hmac-v1": verificationKey }, transport: "loopback-test" });
      const bound = await server.start();
      try {
        const client = new SignedDockerExecutorIpcClient({ signingKey, transport: "loopback-test", port: bound.port });
        const base = { jobId: "job_qa_ipc_1", siteId: "site_qa", organizationId: "org_qa", serviceInstanceId: "svc_qa" };
        const req = (kind: string, params: Record<string, string>, resolvedSecrets?: Record<string, string>) =>
          ({ ...base, kind, params: { phpVersion: "8.4", ...params }, ...(resolvedSecrets ? { resolvedSecrets } : {}) }) as unknown as SiteJobRequest;
        const secret = { HP_ADMIN_PASSWORD: "qa-only-not-a-password" };

        expect(SiteJobIpcRequestSchema.safeParse(req("wordpress.eval", {})).success).toBe(false);
        expect(SiteJobIpcRequestSchema.safeParse(req("shell", {})).success).toBe(false);
        const refused: SiteJobRequest[] = [
          req("wordpress.eval", {}),
          req("wordpress.inspect", { target: "all" }),
          req("wordpress.settle", { userId: "1" }),
          req("wordpress.inspect", {}, { HP_DB_ROOT_PASSWORD: "x" }),
          req("wordpress.settle", {}, secret),
          req("wordpress.reset-password", { userId: "1" }, { ...secret, HP_BACKUP_KEY: "x" }),
          req("wordpress.reset-password", { userId: "1" }),
          req("wordpress.update", {}),
          req("wordpress.inspect", { phpVersion: "8.4; id" }),
          ...["plugin:$(id)", "plugin:-x", "plugin:a b", "everything", "plugin:../x", `plugin:${"a".repeat(101)}`, "all\n", "theme:a`b`", "plugin:"].map((target) =>
            req("wordpress.update", { target }),
          ),
          ...["0", "01", "-1", "1;id", "1 ", "12345678901", "abc"].map((userId) => req("wordpress.reset-password", { userId }, secret)),
        ];
        for (const bad of refused) {
          await expect(client.runSiteJob(bad), JSON.stringify(bad)).rejects.toBeTruthy();
        }
        expect(executor.jobs).toEqual([]);
        // The same channel accepts a well-formed request, so the refusals above are the checks, not a broken link.
        expect((await client.runSiteJob(req("wordpress.reset-password", { userId: "1" }, secret))).exitCode).toBe(0);
        expect(executor.jobs).toHaveLength(1);
      } finally {
        await server.stop();
      }
    });
  });

  describe("3. a result is untrusted", () => {
    it("hostile text from the site is stored and answered unchanged as text and reaches no message, audit event or log line", async () => {
      const site = simSite();
      site.plugins[0]!.title = "<script>alert(1)</script>";
      site.plugins[1]!.version = "9".repeat(40);
      site.administrators[0]!.login = "<b>boss</b>";
      await refreshed();
      const got = await tab();
      expect(got.state!.plugins[0]!.title).toBe("<script>alert(1)</script>");
      expect(got.state!.plugins[1]!.version).toBe("9".repeat(40));
      expect(got.state!.administrators).toEqual([{ id: 1, login: "<b>boss</b>" }]);

      await call("POST", `${wp()}/updates`, a.token, { scope: "plugin", name: "classic-editor" });
      await app.outboxWorker.processPendingOnce();
      const others = JSON.stringify([
        await dbClient.db.select().from(auditEvents),
        await dbClient.db.select().from(operations),
        await dbClient.db.select().from(operationSteps),
        await dbClient.db.select().from(outboxEvents),
      ]);
      for (const piece of ["<script>", "9".repeat(40), "<b>boss"]) {
        expect(others).not.toContain(piece);
        expect(logs.join("\n")).not.toContain(piece);
      }
    });

    it("a version longer than the bound of 40 refuses the whole result and leaves the stored state as it was", async () => {
      await refreshed();
      const stored = (await tab()).state;
      simSite().plugins[1]!.version = "9".repeat(64);
      const opId = await refreshed();
      expect((await opRow(opId))).toMatchObject({ status: "failed", errorMessage: "The check did not finish. Press Check now." });
      expect((await tab()).state).toEqual(stored);
    });

    it("a result that fails the schema, or none on exit 0, leaves the stored state and ends the check as failed", async () => {
      await refreshed();
      const stored = (await tab()).state;
      const valid = structuredClone(SIMULATED_WORDPRESS_STATE) as WordpressStateResult;
      const plugin = valid.plugins[0]!;
      const tooMany = { ...valid, plugins: Array.from({ length: 501 }, (_, i) => ({ ...plugin, name: `p${i}` })) };
      const badStatus = { ...valid, plugins: [{ ...plugin, status: "enabled" }] };
      const extraKey = { ...valid, phpBinary: "/usr/bin/php" };
      const cases: [string, () => void][] = [
        ["too many plugins", () => sim.failNextJob("wordpress.inspect", 0, "", JSON.stringify(tooMany))],
        ["unknown status", () => sim.failNextJob("wordpress.inspect", 0, "", JSON.stringify(badStatus))],
        ["extra key", () => sim.failNextJob("wordpress.inspect", 0, "", JSON.stringify(extraKey))],
        ["not JSON", () => sim.failNextJob("wordpress.inspect", 0, "", "<html>")],
        ["no result on exit 0", () => sim.failNextJob("wordpress.inspect", 0, "")],
        // The API checks again: a result the executor let through is refused on this side too.
        ["extra key past the executor", () => {
          vi.spyOn(sim, "runSiteJob").mockImplementationOnce(async (r) => ({ jobId: r.jobId, exitCode: 0, outputTail: "", result: extraKey }) as unknown as SiteJobResult);
        }],
        ["too many past the executor", () => {
          vi.spyOn(sim, "runSiteJob").mockImplementationOnce(async (r) => ({ jobId: r.jobId, exitCode: 0, outputTail: "", result: tooMany }) as unknown as SiteJobResult);
        }],
      ];
      for (const [name, arrange] of cases) {
        arrange();
        const opId = await refreshed();
        expect([name, (await opRow(opId)).status, (await opRow(opId)).errorMessage]).toEqual([name, "failed", "The check did not finish. Press Check now."]);
        expect([name, (await tab()).state]).toEqual([name, stored]);
      }
    });

    it("an item still in the stored state but gone from the site is sent once and reported as item_unknown", async () => {
      await refreshed();
      simSite().plugins = simSite().plugins.filter((p) => p.name !== "classic-editor");
      const res = await call("POST", `${wp()}/updates`, a.token, { scope: "plugin", name: "classic-editor" });
      expect(res.status).toBe(202);
      await app.outboxWorker.processPendingOnce();
      expect(jobs().filter((j) => j.kind === "wordpress.update").map((j) => j.params["target"])).toEqual(["plugin:classic-editor"]);
      expect((await tab()).lastUpdate).toMatchObject({ status: "failed", problem: "item_unknown", items: [] });
    });
  });

  describe("4. never twice", () => {
    it("an update whose end was not seen is never sent again: restart, recovery, clean-up and a check", async () => {
      await refreshed();
      loseAnswerOnce("wordpress.update");
      const res = await call("POST", `${wp()}/updates`, a.token, { scope: "plugin", name: "classic-editor" });
      const opId = res.body.data.operationId as string;
      await app.outboxWorker.processPendingOnce();
      expect((await opRow(opId)).status).toBe("unknown");
      const updates = () => jobs().filter((j) => j.kind === "wordpress.update");
      expect(updates()).toHaveLength(1);

      // A restart of the API on the same database: the tab still shows the open operation.
      vi.restoreAllMocks();
      await app.close();
      app = await startApp();
      const reopened = await tab();
      expect(reopened.runningOperation).toMatchObject({ id: opId, kind: "site.wordpress.update", status: "unknown" });
      await app.outboxWorker.processPendingOnce();
      expect(updates()).toHaveLength(1);

      await app.outboxWorker.recoverUnknownOperations();
      await app.outboxWorker.recoverUnknownOperations();
      await app.outboxWorker.processPendingOnce();
      expect(updates()).toHaveLength(1);
      expect(jobsOf(opId).map((j) => [j.kind, j.jobId.split("_").at(-1)])).toEqual([
        ["wordpress.update", "update"],
        ["wordpress.settle", "r"],
        ["wordpress.inspect", "r"],
      ]);
      const op = await opRow(opId);
      expect([op.status, op.errorCode]).toEqual(["failed", "OPERATION_INTERRUPTED"]);
      const got = await tab();
      expect(got.runningOperation).toBeNull();
      expect(got.lastUpdate).toMatchObject({ operationId: opId, status: "failed", problem: "outcome_unknown", items: [] });
      // The check after the clean-up shows what the site really has now.
      expect(got.state!.plugins.find((p) => p.name === "classic-editor")!.version).toBe("1.7.0");
    });

    it("an interrupted check is closed as failed with its sentence and asks nothing of the executor", async () => {
      loseAnswerOnce("wordpress.inspect");
      const res = await call("POST", `${wp()}/refresh`, a.token, {});
      const opId = res.body.data.operationId as string;
      await app.outboxWorker.processPendingOnce();
      expect((await opRow(opId)).status).toBe("unknown");
      expect((await tab()).runningOperation).toMatchObject({ id: opId, kind: "site.wordpress.inspect" });
      const before = calls.length;
      await app.outboxWorker.recoverUnknownOperations();
      expect(calls.slice(before)).toEqual([]);
      expect(await opRow(opId)).toMatchObject({ status: "failed", errorMessage: "The check was interrupted. Press Check now." });
      expect((await tab()).runningOperation).toBeNull();
    });

    it("a second update while one is open is refused; the same key answers the same operation and creates nothing", async () => {
      await configureBackups();
      await refreshed();
      const key = randomUUID();
      const first = await call("POST", `${wp()}/updates`, a.token, { scope: "all" }, key);
      expect(first.status).toBe(202);
      const before = { ...(await counts()), audits: (await audits("site.wordpress.update")).length };
      const second = await call("POST", `${wp()}/updates`, a.token, { scope: "core" });
      expect([second.status, second.body.error.code]).toEqual([409, "RESOURCE_LOCKED"]);
      const check = await call("POST", `${wp()}/refresh`, a.token, {});
      expect([check.status, check.body.error.code]).toEqual([409, "RESOURCE_LOCKED"]);
      const replay = await call("POST", `${wp()}/updates`, a.token, { scope: "all" }, key);
      expect([replay.status, replay.body.data.operationId]).toEqual([202, first.body.data.operationId]);
      // The shared rule matches a key on kind and site, not body: a changed body replays the first operation.
      const changed = await call("POST", `${wp()}/updates`, a.token, { scope: "core" }, key);
      expect([changed.status, changed.body.data.operationId]).toEqual([202, first.body.data.operationId]);
      expect({ ...(await counts()), audits: (await audits("site.wordpress.update")).length }).toEqual(before);

      await app.outboxWorker.processPendingOnce();
      await app.outboxWorker.processPendingOnce();
      expect(jobs().filter((j) => j.kind === "wordpress.update").map((j) => j.params["target"])).toEqual(["all"]);
    });
  });

  describe("5. the password and a job's output", () => {
    const resetJobs = () => jobs().filter((j) => j.kind === "wordpress.reset-password");
    const passwordOf = (job: SiteJobRequest) => job.resolvedSecrets!["HP_ADMIN_PASSWORD"]!;

    it("no password of a reset (succeeded, failed, end not seen) reaches a row, an answer of another route or a log line", async () => {
      await refreshed();
      const reset = () => call("POST", `${wp()}/administrators/1/password-reset`, a.token, {});

      const ok = await reset();
      expect(ok.status).toBe(200);
      const answered = ok.body.data.temporaryPassword as string;
      expect(passwordOf(resetJobs()[0]!)).toBe(answered);
      // Positive control: the same search finds the password where it belongs.
      expect(JSON.stringify(ok.body)).toContain(answered);

      sim.failNextJob("wordpress.reset-password", 22, `${MARKER} config`);
      const failed = await reset();
      expect([failed.status, failed.body.data]).toEqual([503, undefined]);

      loseAnswerOnce("wordpress.reset-password");
      const unseen = await reset();
      expect([unseen.status, unseen.body.error.details[0].reason, unseen.body.data]).toEqual([503, "unavailable", undefined]);

      const passwords = resetJobs().map(passwordOf);
      expect(passwords).toHaveLength(3);
      expect(new Set(passwords).size).toBe(3);
      const stored = await storedText();
      const answers = JSON.stringify([failed.body, unseen.body, (await call("GET", wp(), a.token)).body]);
      for (const password of passwords) {
        expect(password).toMatch(/^[A-Za-z0-9]{24}$/);
        expect(stored).not.toContain(password);
        expect(answers).not.toContain(password);
        expect(logs.join("\n")).not.toContain(password);
      }
      expect(stored).not.toContain(MARKER);
      expect(answers).not.toContain(MARKER);

      const resets = (await audits("site.wordpress.password_reset")).map((r) => [r.actorType, r.actorId, r.details as Json]);
      expect(resets).toEqual([
        ["user", a.userId, expect.objectContaining({ outcome: "succeeded", userId: 1, login: "admin" })],
        ["user", a.userId, expect.objectContaining({ outcome: "failed", userId: 1, login: "admin", reason: "config_broken" })],
        ["user", a.userId, expect.objectContaining({ outcome: "unknown", userId: 1, login: "admin" })],
      ]);
    });

    it("a job tail holding a marker reaches no row, answer or log line, for the check, the update and its clean-up", async () => {
      sim.failNextJob("wordpress.inspect", 22, `${MARKER} wp-config broken`);
      const broken = await refreshed();
      expect((await tab()).state).toMatchObject({ problem: "config_broken", coreVersion: null });
      sim.failNextJob("wordpress.inspect", 1, `${MARKER} other`);
      const other = await refreshed();
      await refreshed();

      sim.failNextJob(
        "wordpress.update",
        32,
        `${MARKER} failed`,
        JSON.stringify({ items: [{ type: "plugin", name: "classic-editor", oldVersion: "1.6.0", newVersion: null, status: "failed" }] }),
      );
      sim.failNextJob("wordpress.settle", 1, `${MARKER} settle`);
      const up = await call("POST", `${wp()}/updates`, a.token, { scope: "plugin", name: "classic-editor" });
      const upId = up.body.data.operationId as string;
      await app.outboxWorker.processPendingOnce();
      expect((await tab()).lastUpdate).toMatchObject({ status: "failed", problem: "items_failed", items: [expect.objectContaining({ status: "failed" })] });
      const steps = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, upId));
      expect(steps.find((s) => s.key === "settle")!.status).toBe("failed");

      const answers = JSON.stringify(
        await Promise.all([
          call("GET", wp(), a.token),
          ...[broken, other, upId].map((id) => call("GET", `/v1/organizations/${a.orgId}/operations/${id}`, a.token)),
        ]),
      );
      expect(answers).toContain(upId);
      // Positive control: the marker really came back from the executor in four answers.
      const tails = calls.filter((c) => c.method === "<-runSiteJob").map((c) => JSON.stringify(c.result));
      expect(tails.filter((t) => t.includes(MARKER))).toHaveLength(4);
      expect(answers).not.toContain(MARKER);
      expect(await storedText()).not.toContain(MARKER);
      expect(logs.join("\n")).not.toContain(MARKER);
    });

    it("audit events: requested with the actor, finished by the system with the outcome, never a tail or a password", async () => {
      await configureBackups();
      const checkId = await refreshed();
      const up = await call("POST", `${wp()}/updates`, a.token, { scope: "plugin", name: "classic-editor" });
      const upId = up.body.data.operationId as string;
      await app.outboxWorker.processPendingOnce();

      const refresh = await audits("site.wordpress.refresh");
      expect(refresh).toEqual([
        expect.objectContaining({ actorType: "user", actorId: a.userId, organizationId: a.orgId, targetType: "site", targetId: a.siteId }),
      ]);
      expect(refresh[0]!.details).toMatchObject({ outcome: "requested", operationId: checkId });
      const requested = await audits("site.wordpress.update");
      expect(requested).toEqual([expect.objectContaining({ actorType: "user", actorId: a.userId, targetId: a.siteId })]);
      expect(requested[0]!.details).toMatchObject({ outcome: "requested", operationId: upId, target: { scope: "plugin", name: "classic-editor" } });
      const finished = await audits("site.wordpress.update.finished");
      expect(finished).toEqual([expect.objectContaining({ actorType: "system", actorId: null, organizationId: a.orgId, targetId: a.siteId })]);
      expect(finished[0]!.details).toEqual({
        operationId: upId,
        target: { scope: "plugin", name: "classic-editor" },
        status: "succeeded",
        problem: null,
        backup: "taken",
        updated: 1,
        failed: 0,
      });
      const all = JSON.stringify([...refresh, ...requested, ...finished]);
      expect(all).not.toMatch(/outputTail|temporaryPassword|HP_ADMIN_PASSWORD|Classic Editor/);
    });
  });

  describe("6. who may", () => {
    const routes = (site: { orgId: string; siteId: string }): [string, string, unknown?][] => {
      const base = wp(site);
      return [
        ["GET", base],
        ["POST", `${base}/refresh`, {}],
        ["POST", `${base}/updates`, { scope: "all" }],
        ["POST", `${base}/administrators/1/password-reset`, {}],
      ];
    };
    const bodyOf = (body: Json) => JSON.stringify(body, (k, v: unknown) => (k === "requestId" ? undefined : v)).replaceAll(/[a-z]+_[0-9a-f-]{20,}/g, "<id>");

    it("another organisation's site answers 404 with the body of a site that does not exist, on every route", async () => {
      await call("POST", `${wp(b)}/refresh`, adminToken, {});
      await app.outboxWorker.processPendingOnce();
      const before = await counts();
      const missing = routes({ orgId: a.orgId, siteId: `site_${randomUUID().replaceAll("-", "")}` });
      const foreign = routes({ orgId: a.orgId, siteId: b.siteId });
      const crossed = routes({ orgId: b.orgId, siteId: b.siteId });
      for (let i = 0; i < foreign.length; i += 1) {
        const [method, path, body] = foreign[i]!;
        const viaOwnOrg = await call(method, path, a.token, body);
        const notThere = await call(missing[i]![0], missing[i]![1], a.token, missing[i]![2]);
        expect([path, viaOwnOrg.status, notThere.status]).toEqual([path, 404, 404]);
        expect(bodyOf(viaOwnOrg.body)).toBe(bodyOf(notThere.body));
        const viaTheirOrg = await call(crossed[i]![0], crossed[i]![1], a.token, crossed[i]![2]);
        expect([crossed[i]![1], viaTheirOrg.status]).toEqual([crossed[i]![1], 404]);
      }
      expect(await counts()).toEqual(before);
    });

    it("a reader gets 403 on the three POSTs; a suspended organisation reads but cannot act", async () => {
      await refreshed();
      const userId = `usr_${randomUUID()}`;
      const membershipId = `mem_${randomUUID()}`;
      await dbClient.db.insert(users).values({ id: userId, email: "reader@example.test", name: "Reader", passwordHash: await hashPassword(PW) });
      await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: a.orgId, userId });
      await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_collaborator" });
      await dbClient.db
        .insert(resourceGrants)
        .values({ id: `rg_${randomUUID()}`, organizationId: a.orgId, principalUserId: userId, resourceId: a.siteId, permission: "site.read" });
      const reader = await login("reader@example.test", PW);
      const before = await counts();
      const [get, ...posts] = routes(a);
      expect((await call(get![0], get![1], reader)).status).toBe(200);
      for (const [method, path, body] of posts) {
        const res = await call(method, path, reader, body);
        expect([path, res.status, res.body.error.code]).toEqual([path, 403, "PERMISSION_DENIED"]);
      }
      await dbClient.db.update(organizations).set({ status: "suspended" }).where(eq(organizations.id, a.orgId));
      expect((await call(get![0], get![1], a.token)).status).toBe(200);
      for (const [method, path, body] of posts) {
        const res = await call(method, path, a.token, body);
        expect([path, res.status, res.body.error.code]).toEqual([path, 403, "ORGANIZATION_SUSPENDED"]);
      }
      expect(await counts()).toEqual(before);
    });

    it("a server administrator without a membership gets what the shipped site routes give", async () => {
      await refreshed();
      const site = `/v1/organizations/${a.orgId}/managed-sites/${a.siteId}`;
      const shippedRead = await call("GET", site, adminToken);
      const shippedWrite = await call("POST", `${site}/backups`, adminToken, {});
      const [get, ...posts] = routes(a);
      const read = await call(get![0], get![1], adminToken);
      expect([read.status, read.body.error?.code]).toEqual([shippedRead.status, shippedRead.body.error?.code]);
      for (const [method, path, body] of posts) {
        const res = await call(method, path, adminToken, body);
        expect([path, res.status, res.body.error?.code]).toEqual([path, shippedWrite.status, shippedWrite.body.error?.code]);
      }
    });

    it("the stored state is written by nothing but the applier: a walk through the four routes leaves it empty", async () => {
      await configureBackups();
      for (const [method, path, body] of routes(a)) {
        expect((await call(method, path, a.token, body)).status).toBeLessThan(500);
      }
      await call("POST", `${wp()}/updates`, a.token, { scope: "core" });
      await call("POST", `${wp()}/updates`, a.token, { scope: "plugin", name: "akismet" });
      expect(await dbClient.db.select().from(siteWordpressState)).toEqual([]);
      expect(jobs()).toEqual([]);
    });
  });
});

describe("QA: every site job the API sent in this file", () => {
  afterAll(() => {
    allJobs.length = 0;
  });

  it("is one of the four closed WordPress kinds with checked values and only its own secret", () => {
    expect(new Set(allJobs.map((j) => j.kind))).toEqual(new Set(WP_KINDS));
    for (const job of allJobs) {
      const where = `${job.jobId} ${job.kind}`;
      expect(WP_KINDS, where).toContain(job.kind);
      expect(Object.keys(job.params).sort(), where).toEqual([...PARAMS[job.kind]!].sort());
      expect(job.params["phpVersion"], where).toMatch(/^[0-9]\.[0-9]$/);
      if (job.kind === "wordpress.update") expect(job.params["target"], where).toMatch(WORDPRESS_UPDATE_TARGET_PATTERN);
      if (job.kind === "wordpress.reset-password") {
        expect(job.params["userId"], where).toMatch(WORDPRESS_USER_ID_PATTERN);
        expect(Object.keys(job.resolvedSecrets ?? {}), where).toEqual(["HP_ADMIN_PASSWORD"]);
      } else {
        expect(Object.keys(job.resolvedSecrets ?? {}), where).toEqual([]);
      }
      expect(job.jobId, where).toMatch(/^job_[A-Za-z0-9_]+$/);
    }
  });
});
