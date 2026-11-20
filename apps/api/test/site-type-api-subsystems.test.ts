import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { SITE_FILE_ERROR_REASONS } from "@hosting-panel/contracts";
import { createDatabaseClient, domains, eq, operations, operationSteps, sites, users, type DatabaseClient } from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { SiteBackupsApplier } from "../src/backups/site-backups-applier.js";
import { SiteRestoreApplier } from "../src/backups/site-restore-applier.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { WORDPRESS_API_SITE_TYPE } from "../src/site-types/wordpress.js";
import { siteFileReasonError } from "../src/sites/site-files.service.js";
import { CONTROL_PLANE_CONFIG_TOKEN, type ControlPlaneRuntimeConfig } from "../src/tokens.js";
import { TEST_API_SITE_TYPE } from "./fixtures/test-site-type.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Call { readonly method: string; readonly args: Json[] }

const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-login-pass-0002";
const SETUP = { installationName: "Subsystems", hostHostname: "panel.example.test", hostIpv4: "192.0.2.10" };
// Same site and target as the pin test, so the restore calls render to its fixture.
const SITE = {
  name: "Site A",
  domain: "wp-a.example.test",
  includeWww: true,
  phpVersion: "8.3",
  title: "Site A",
  adminUser: "siteadmin",
  adminEmail: "admin@example.test",
  adminPassword: "sentinel-Admin-Pass-0002",
};
const BACKUP_SETTINGS = {
  endpoint: "https://s3.example.test",
  region: "eu-south-1",
  bucket: "pins-bucket",
  prefix: "panel/pins",
  accessKeyId: "SENTINELACCESSKEY02",
  secretAccessKey: "sentinel-secret-access-key-0002",
  scheduleHourUtc: 2,
  retentionDays: 14,
};
const SECRET_KEY = /(password|passwordHash|secretAccessKey|accessKeyId|masterKey|token)$/i;
const RANDOM = /(?<![0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64}|[0-9a-f]{32})(?![0-9a-f])/g;
/** The executor requests that carry the site's type. */
const TYPED_BACKUP_ACTIONS = new Set(["start", "restore", "siteState"]);

/** The pin test's rendering: siteType dropped, keys sorted, ids and secrets numbered by first appearance. */
function render(value: unknown): unknown {
  const ids = new Map<string, string>();
  const secrets = new Map<string, string>();
  const walk = (node: unknown, key: string | null): unknown => {
    if (Array.isArray(node)) return node.map((v) => walk(v, null));
    if (node !== null && typeof node === "object") {
      const entries = Object.entries(node as Json).filter(([k]) => k !== "siteType").sort(([a], [b]) => a.localeCompare(b));
      return Object.fromEntries(
        entries.map(([k, v]) =>
          k === "resolvedSecrets" && v !== null && typeof v === "object"
            ? [k, Object.fromEntries(Object.keys(v as Json).sort().map((name) => [name, "<present>"]))]
            : [k, walk(v, k)],
        ),
      );
    }
    if (typeof node !== "string") return node;
    if (key !== null && SECRET_KEY.test(key) && node !== "") {
      if (!secrets.has(node)) secrets.set(node, `<secret:${secrets.size + 1}>`);
      return secrets.get(node);
    }
    return node.replace(RANDOM, (m) => {
      if (!ids.has(m)) ids.set(m, `<id:${ids.size + 1}>`);
      return ids.get(m)!;
    });
  };
  return walk(value, null);
}

const pinFixture = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/site-type-pins/${file}`, import.meta.url), "utf8"));

/** Wraps the simulator so every call the API makes is recorded with a deep copy of its arguments. */
function recording(sim: InMemoryDockerSimulatorAdapter, calls: Call[]): InMemoryDockerSimulatorAdapter {
  return new Proxy(sim, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function" || typeof prop !== "string") return v;
      return (...args: unknown[]) => {
        calls.push({ method: prop, args: JSON.parse(JSON.stringify(args)) as Json[] });
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** Every request of the five subsystems among the calls, with the type it carried. */
function typedRequests(calls: readonly Call[]): Array<{ what: string; siteType: unknown }> {
  const out: Array<{ what: string; siteType: unknown }> = [];
  for (const c of calls) {
    const req = c.args[0]!;
    if (c.method === "siteFiles") out.push({ what: `files.${req.op as string}`, siteType: req.siteType });
    if (c.method === "backups" && TYPED_BACKUP_ACTIONS.has(req.action as string)) {
      out.push({ what: `backups.${req.action as string}`, siteType: req.siteType });
    }
    if (c.method === "applySftpAccess") {
      for (const u of req.users as Json[]) out.push({ what: "sftp.user", siteType: u.siteType });
    }
    if (c.method === "openTerminal") out.push({ what: "terminal.open", siteType: req.siteType });
  }
  return out;
}

describe("the five subsystems name the site's type on every executor request", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let adminToken: string;
  let adminSecret: string;
  let adminId: string;
  let ownerToken: string;
  let orgId: string;
  let siteId: string;
  const calls: Call[] = [];
  const steps = new Map<string, Call[]>();

  async function http(method: string, path: string, body?: unknown, token = ownerToken): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": randomUUID(),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

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

  async function drain(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      if ((await app.outboxWorker.processPendingOnce()).claimed === 0) return;
    }
    throw new Error("outbox never drained");
  }

  async function step(name: string, run: () => Promise<void>): Promise<Call[]> {
    const from = calls.length;
    await run();
    const taken = calls.slice(from);
    steps.set(name, taken);
    return taken;
  }

  async function operation(operationId: string): Promise<{ status: string; errorCode: string | null }> {
    const [row] = await dbClient.db.select().from(operations).where(eq(operations.id, operationId));
    return { status: row!.status, errorCode: row!.errorCode };
  }

  async function openTerminal(): Promise<{ status: number; body: Json }> {
    await dbClient.db.update(users).set({ totpLastStep: null }).where(eq(users.id, adminId));
    return await http(
      "POST",
      `/v1/admin/sites/${siteId}/terminal`,
      { code: totpCodeAt(adminSecret, Math.floor(Date.now() / 30_000)) },
      adminToken,
    );
  }

  const siteBase = (tail = "") => `/v1/organizations/${orgId}/managed-sites/${siteId}${tail}`;
  const setType = (siteType: string | null) => dbClient.db.update(sites).set({ siteType }).where(eq(sites.id, siteId));

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    adminSecret = admin.totpSecretBase32;
    adminId = admin.userId;
    sim = new InMemoryDockerSimulatorAdapter();
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      runtimeBackend: "linux-systemd",
      dockerExecutor: recording(sim, calls),
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
    adminToken = await login("admin@example.test", PW, adminSecret);
    const created = await http(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Org A", ownerEmail: "owner@example.test", ownerName: "Owner A" },
      adminToken,
    );
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "owner@example.test");
    orgId = created.body.data.organizationId as string;
    ownerToken = await login("owner@example.test", created.body.data.temporaryPassword as string);

    const res = await http("POST", `/v1/organizations/${orgId}/managed-sites`, SITE);
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    siteId = res.body.data.siteId as string;
    await drain();

    // The main address moves to www, as in the pin test.
    const list = (await http("GET", siteBase("/domains"))).body.data.domains as Json[];
    const expires = new Date(Date.now() + 60 * 86_400_000);
    for (const d of list) {
      await dbClient.db.update(domains).set({ certStatus: "active", certExpiresAt: expires }).where(eq(domains.id, d.id as string));
      sim.issueCertificate(d.hostname as string, expires.toISOString());
    }
    const www = list.find((d) => d.hostname === `www.${SITE.domain}`)!;
    expect((await http("POST", siteBase(`/domains/${www.id as string}/primary`))).status).toBe(200);
    await drain();

    expect((await http("PATCH", "/v1/admin/backups", BACKUP_SETTINGS, adminToken)).status).toBe(200);
    let backupId = "";
    await step("backup", async () => {
      const r = await http("POST", siteBase("/backups"), {});
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      backupId = r.body.data.backupId as string;
      await drain();
      expect((await operation(r.body.data.operationId as string)).status).toBe("succeeded");
    });
    await step("restore", async () => {
      const r = await http("POST", siteBase(`/backups/${backupId}/restore`), { confirmName: SITE.name });
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      await drain();
      expect((await operation(r.body.data.operationId as string)).status).toBe("succeeded");
    });
    await step("adminRestore", async () => {
      const r = await http("POST", `/v1/admin/backups/sites/${siteId}/restore`, { confirmName: SITE.name }, adminToken);
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      await drain();
      expect((await operation(r.body.data.operationId as string)).status).toBe("succeeded");
    });
    await step("files", async () => {
      expect((await http("GET", siteBase("/files?path="))).status).toBe(200);
      const write = await http("PUT", siteBase("/files/content"), {
        path: "pin.txt",
        uploadId: "upl_0123456789abcdef",
        offset: 0,
        dataBase64: Buffer.from("pin\n").toString("base64"),
        final: true,
        overwrite: false,
      });
      expect(write.status, JSON.stringify(write.body)).toBeLessThan(300);
      const archive = await http("POST", siteBase("/files/archive"), { paths: ["pin.txt"], to: "pin.zip" });
      expect(archive.status, JSON.stringify(archive.body)).toBe(202);
      await drain();
      expect((await operation(archive.body.data.operationId as string)).status).toBe("succeeded");
    });
    await step("sftp", async () => {
      expect((await http("POST", siteBase("/sftp/users"), { name: "dev1" })).status).toBe(201);
      await app.siteSftp.tick();
    });
    await step("terminal", async () => {
      const r = await openTerminal();
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await http("POST", `/v1/admin/terminal/${r.body.data.sessionId as string}/close`, undefined, adminToken);
    });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await dbClient?.close();
  });

  it("a WordPress site: every files, backups, SFTP and terminal request carries siteType wordpress", () => {
    const typed = typedRequests([...steps.values()].flat());
    const kinds = new Set(typed.map((t) => t.what));
    for (const k of ["files.list", "files.write", "files.archive", "backups.start", "backups.restore", "backups.siteState", "sftp.user", "terminal.open"]) {
      expect(kinds.has(k), k).toBe(true);
    }
    for (const t of typed) expect(t.siteType, t.what).toBe("wordpress");
  });

  it("a WordPress restore: the restore request and the address job equal the pin fixture", () => {
    expect(render({ calls: steps.get("restore") })).toEqual(pinFixture("restore-requests.json"));
  });

  it("the restore asks its resolver: a type with no database and no address job skips both steps and sends its own key", async () => {
    const parent = app.nestApp.get(SiteBackupsApplier);
    const config = app.nestApp.get<ControlPlaneRuntimeConfig>(CONTROL_PLANE_CONFIG_TOKEN);
    // This release's executor knows only wordpress: record what the restore sends, then pass it on without the key.
    const sent: Call[] = [];
    const executor = new Proxy(app.dockerExecutor, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (typeof v !== "function" || typeof prop !== "string") return v;
        return (req: unknown, ...rest: unknown[]) => {
          sent.push({ method: prop, args: JSON.parse(JSON.stringify([req])) as Json[] });
          const { siteType: _key, ...plain } = (req ?? {}) as Json;
          return (v as (...a: unknown[]) => unknown).apply(target, [req && typeof req === "object" ? plain : req, ...rest]);
        };
      },
    });
    const restorer = new SiteRestoreApplier(parent, dbClient, executor, config, () => TEST_API_SITE_TYPE);
    const spy = vi.spyOn(parent, "apply").mockImplementation((op) => restorer.apply(op));
    const from = calls.length;
    try {
      const r = await http("POST", `/v1/admin/backups/sites/${siteId}/restore`, { confirmName: SITE.name }, adminToken);
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      const operationId = r.body.data.operationId as string;
      await drain();
      expect(spy).toHaveBeenCalled();
      expect((await operation(operationId)).status).toBe("succeeded");
      const steps = await dbClient.db
        .select({ key: operationSteps.key, status: operationSteps.status })
        .from(operationSteps)
        .where(eq(operationSteps.operationId, operationId));
      const statusOf = new Map(steps.map((s) => [s.key, s.status]));
      expect(statusOf.get("provision_database")).toBe("skipped");
      expect(statusOf.get("update_address")).toBe("skipped");
      const typed = typedRequests(sent);
      expect(typed.map((t) => t.what)).toEqual(expect.arrayContaining(["backups.siteState", "backups.restore"]));
      for (const t of typed) expect(t.siteType, t.what).toBe("teststatic");
      expect(calls.slice(from).filter((c) => c.method === "runSiteJob")).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("every file error reason has a message, the type's own taken from the type module", () => {
    for (const reason of SITE_FILE_ERROR_REASONS) expect(siteFileReasonError(reason).message, reason).toMatch(/\S/);
    for (const [reason, text] of Object.entries(WORDPRESS_API_SITE_TYPE.fileReasonMessages)) {
      expect(siteFileReasonError(reason as (typeof SITE_FILE_ERROR_REASONS)[number]).message).toBe(text);
    }
  });

  describe.each([
    ["no type", null],
    ["an unknown type", "unknowntype"],
  ])("a site whose row has %s", (_label, siteType) => {
    it("the files service refuses it with 404 and the files applier fails it as a site that is gone", async () => {
      const queued = await http("POST", siteBase("/files/archive"), { paths: ["pin.txt"], to: "gone.zip" });
      expect(queued.status).toBe(202);
      await setType(siteType);
      const from = calls.length;
      try {
        expect((await http("GET", siteBase("/files?path="))).status).toBe(404);
        expect((await http("POST", siteBase("/files/archive"), { paths: ["pin.txt"], to: "x.zip" })).status).toBe(404);
        await drain();
        expect(await operation(queued.body.data.operationId as string)).toEqual({ status: "failed", errorCode: "NOT_FOUND" });
        expect(calls.slice(from).filter((c) => c.method === "siteFiles")).toEqual([]);
      } finally {
        await setType("wordpress");
      }
    });

    it("the backup and the restore fail as for a site that is gone and send nothing", async () => {
      const backup = await http("POST", `/v1/admin/backups/sites/${siteId}/run`, {}, adminToken);
      expect(backup.status, JSON.stringify(backup.body)).toBe(202);
      await setType(siteType);
      const from = calls.length;
      try {
        await drain();
        expect(await operation(backup.body.data.operationId as string)).toEqual({ status: "failed", errorCode: "NOT_FOUND" });
      } finally {
        await setType("wordpress");
      }
      const restore = await http("POST", `/v1/admin/backups/sites/${siteId}/restore`, { confirmName: SITE.name }, adminToken);
      expect(restore.status, JSON.stringify(restore.body)).toBe(202);
      await setType(siteType);
      try {
        await drain();
        expect(await operation(restore.body.data.operationId as string)).toEqual({ status: "failed", errorCode: "NOT_FOUND" });
        expect(typedRequests(calls.slice(from))).toEqual([]);
        expect(calls.slice(from).filter((c) => c.method === "runSiteJob")).toEqual([]);
      } finally {
        await setType("wordpress");
      }
    });

    it("SFTP refuses a new account with 404 and leaves the site's accounts out of the apply", async () => {
      await setType(siteType);
      const from = calls.length;
      try {
        expect((await http("POST", siteBase("/sftp/users"), { name: "dev2" })).status).toBe(404);
        await app.siteSftp.ensureApplied(true);
        const applies = calls.slice(from).filter((c) => c.method === "applySftpAccess");
        expect(applies.length).toBeGreaterThan(0);
        for (const a of applies) expect(a.args[0]!.users).toEqual([]);
      } finally {
        await setType("wordpress");
      }
    });

    it("the terminal refuses it with 404 and opens nothing", async () => {
      await setType(siteType);
      const from = calls.length;
      try {
        expect((await openTerminal()).status).toBe(404);
        expect(calls.slice(from).filter((c) => c.method === "openTerminal")).toEqual([]);
      } finally {
        await setType("wordpress");
      }
    });
  });
});
