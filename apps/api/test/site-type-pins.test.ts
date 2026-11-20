// Frozen pins: these fixtures are frozen and the lead holds their sha256 hashes; rewrite them only with UPDATE_SITE_TYPE_PINS=1 on untouched code.
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createDatabaseClient, eq, sql, stackRevisions, users, domains, type DatabaseClient } from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Call { readonly method: string; readonly args: unknown[] }

const FIXTURES = new URL("./fixtures/site-type-pins/", import.meta.url);
const UPDATE = process.env.UPDATE_SITE_TYPE_PINS === "1";
const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-login-pass-0001";
const ADMIN_EMAIL = "admin@example.test";
const OWNER_EMAIL = "owner@example.test";
const SETUP = { installationName: "Pins", hostHostname: "panel.example.test", hostIpv4: "192.0.2.10" };
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
const UPLOAD_ID = "upl_0123456789abcdef";

const SECRET_KEY = /(password|passwordHash|secretAccessKey|accessKeyId|masterKey|token)$/i;
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const RANDOM = /(?<![0-9a-f])([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64}|[0-9a-f]{32})(?![0-9a-f])/g;

/** Same key order as the stack revision hash (packages/hosting-domain canonicalize.ts). */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Json).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Drops every siteType key at any depth and collects its values. */
function stripSiteType(value: unknown, seen: unknown[]): unknown {
  if (Array.isArray(value)) return value.map((v) => stripSiteType(v, seen));
  if (value === null || typeof value !== "object") return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value as Json)) {
    if (k === "siteType") seen.push(v);
    else out[k] = stripSiteType(v, seen);
  }
  return out;
}

/** Replaces random-by-design values with stable tokens numbered by first appearance; secrets keep only their key. */
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

/** Wraps the simulator so every call the API makes is recorded with a deep copy of its arguments. */
function recording(sim: InMemoryDockerSimulatorAdapter, calls: Call[]): InMemoryDockerSimulatorAdapter {
  return new Proxy(sim, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function" || typeof prop !== "string") return v;
      return (...args: unknown[]) => {
        calls.push({ method: prop, args: JSON.parse(JSON.stringify(args)) as unknown[] });
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

describe("site type pins: what the API hands the executor for a WordPress site", () => {
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
  const pins = new Map<string, unknown>();
  const keepRaw = new Set<string>();

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

  /** Runs one step of the site's life and keeps the calls the simulator received during it. */
  async function step(name: string, run: () => Promise<void>): Promise<Call[]> {
    const from = calls.length;
    await run();
    const taken = calls.slice(from);
    pins.set(name, taken);
    return taken;
  }

  async function opStatus(operationId: string): Promise<string> {
    const res = await http("GET", `/v1/organizations/${orgId}/operations/${operationId}`);
    return res.body.data.status as string;
  }

  const siteBase = (tail = "") => `/v1/organizations/${orgId}/managed-sites/${siteId}${tail}`;

  async function routeHash(): Promise<Json> {
    // Raw SQL by column name: column names never change (D8), drizzle property names may.
    const rows = await dbClient.db.execute(
      sql`SELECT applied_routes_hash AS h, wordpress_url AS u FROM sites WHERE id = ${siteId}`,
    );
    const row = (rows as unknown as { rows: Array<{ h: string; u: string | null }> }).rows[0]!;
    const routes = sim.appliedRoutes.get(siteId)!;
    const hosts = [...routes.hosts]
      .sort((a, b) => a.hostname.localeCompare(b.hostname))
      .map((h) => [h.hostname, h.tls, h.httpsRedirect, h.redirectTo]);
    const hashOf = { hosts, wordpressUrl: row.u };
    keepRaw.add(row.h);
    return { routePlanHash: row.h, recomputed: sha256(JSON.stringify(hashOf)), hashOf };
  }

  async function specHash(serviceInstanceId: string): Promise<Json> {
    const rev = (
      await dbClient.db.select().from(stackRevisions).where(eq(stackRevisions.serviceInstanceId, serviceInstanceId))
    ).sort((a, b) => b.revisionNumber - a.revisionNumber)[0]!;
    const hashOf = { config: rev.declarativeConfig, secretRefs: rev.secretRefs, resourceLimits: rev.resourceLimits };
    keepRaw.add(rev.specHash); // no id goes into the hash, so it is the same on every run
    return {
      revisionNumber: rev.revisionNumber,
      specHash: rev.specHash,
      recomputed: sha256(canonicalJson(hashOf)),
      hashOf,
    };
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: ADMIN_EMAIL, name: "Admin", password: PW });
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
    adminToken = await login(ADMIN_EMAIL, PW, adminSecret);
    const created = await http(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Org A", ownerEmail: OWNER_EMAIL, ownerName: "Owner A" },
      adminToken,
    );
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, OWNER_EMAIL);
    orgId = created.body.data.organizationId as string;
    ownerToken = await login(OWNER_EMAIL, created.body.data.temporaryPassword as string);

    // The life of one WordPress site, step by step.
    await step("provision", async () => {
      const res = await http("POST", `/v1/organizations/${orgId}/managed-sites`, SITE);
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      siteId = res.body.data.siteId as string;
      await drain();
      expect(await opStatus(res.body.data.operationId as string)).toBe("succeeded");
    });
    const deploy = (pins.get("provision") as Call[]).find((c) => c.method === "deployService")!;
    const svcId = (deploy.args[0] as Json).serviceInstanceId as string;
    pins.set("specAfterCreate", await specHash(svcId));
    pins.set("routesAfterCreate", await routeHash());

    await step("domains", async () => {
      const list = (await http("GET", siteBase("/domains"))).body.data.domains as Json[];
      const expires = new Date(Date.now() + 60 * 86_400_000);
      for (const d of list) {
        await dbClient.db.update(domains).set({ certStatus: "active", certExpiresAt: expires }).where(eq(domains.id, d.id as string));
        sim.issueCertificate(d.hostname as string, expires.toISOString());
      }
      const www = list.find((d) => d.hostname === `www.${SITE.domain}`)!;
      const res = await http("POST", siteBase(`/domains/${www.id as string}/primary`));
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      await drain();
    });
    pins.set("routesAfterPrimary", await routeHash());

    const settings = await http("PATCH", "/v1/admin/backups", BACKUP_SETTINGS, adminToken);
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    let backupId = "";
    await step("backup", async () => {
      const res = await http("POST", siteBase("/backups"), {});
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      backupId = res.body.data.backupId as string;
      await drain();
      expect(await opStatus(res.body.data.operationId as string)).toBe("succeeded");
    });

    await step("restore", async () => {
      const res = await http("POST", siteBase(`/backups/${backupId}/restore`), { confirmName: SITE.name });
      expect(res.status, JSON.stringify(res.body)).toBe(202);
      await drain();
      expect(await opStatus(res.body.data.operationId as string)).toBe("succeeded");
    });

    await step("files", async () => {
      const list = await http("GET", siteBase("/files?path="));
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const data = Buffer.from("pin\n");
      const write = await http("PUT", siteBase("/files/content"), {
        path: "pin.txt",
        uploadId: UPLOAD_ID,
        offset: 0,
        dataBase64: data.toString("base64"),
        final: true,
        overwrite: false,
      });
      expect(write.status, JSON.stringify(write.body)).toBeLessThan(300);
      await drain();
    });

    await step("sftp", async () => {
      const res = await http("POST", siteBase("/sftp/users"), { name: "dev1" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await app.siteSftp.tick();
    });

    await step("terminal", async () => {
      await dbClient.db.update(users).set({ totpLastStep: null }).where(eq(users.id, adminId));
      const res = await http(
        "POST",
        `/v1/admin/sites/${siteId}/terminal`,
        { code: totpCodeAt(adminSecret, Math.floor(Date.now() / 30_000)) },
        adminToken,
      );
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      pins.set("terminalSession", res.body.data.sessionId);
    });
    await http("POST", `/v1/admin/terminal/${pins.get("terminalSession") as string}/close`, undefined, adminToken);

    pins.set("specAtEnd", await specHash(svcId));
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await dbClient?.close();
  });

  /** The fixture text for a recorded value: siteType removed, random values tokenized, keys sorted. */
  function render(value: unknown): { text: string; secrets: Set<string> } {
    const h = sha256(siteId);
    const derived = new Map([
      [h.slice(0, 12), "<site-sha12>"],
      [h.slice(0, 8), "<site-sha8>"],
    ]);
    const secrets = new Set<string>([SITE.adminPassword, BACKUP_SETTINGS.secretAccessKey, PW]);
    const text = `${JSON.stringify(tokenize(stripSiteType(value, []), derived, keepRaw, secrets), null, 2)}\n`;
    return { text, secrets };
  }

  function pin(file: string, value: unknown): void {
    const { text, secrets } = render(value);
    for (const s of secrets) expect(text.includes(s), `${file} holds a secret`).toBe(false);
    const url = new URL(file, FIXTURES);
    if (UPDATE) writeFileSync(url, text);
    expect(text, file).toBe(readFileSync(url, "utf8"));
  }

  const callsOf = (stepName: string) => pins.get(stepName) as Call[];

  it("provision-jobs.json: the database request, the deploy spec and the install job", () => {
    pin("provision-jobs.json", { calls: callsOf("provision") });
  });

  it("domains-jobs.json: a change of the main address", () => {
    pin("domains-jobs.json", { calls: callsOf("domains") });
  });

  it("backup-requests.json: a site backup", () => {
    pin("backup-requests.json", { calls: callsOf("backup") });
  });

  it("restore-requests.json: a restore of that backup", () => {
    pin("restore-requests.json", { calls: callsOf("restore") });
  });

  it("files-requests.json: a listing and one write", () => {
    pin("files-requests.json", { calls: callsOf("files") });
  });

  it("sftp-users.json: the SFTP apply after an account is added", () => {
    pin("sftp-users.json", { calls: callsOf("sftp") });
  });

  it("terminal-open.json: an administrator opens a terminal", () => {
    pin("terminal-open.json", { calls: callsOf("terminal") });
  });

  it("spec-hash.json: the stored spec hash is the hash of the recorded spec", () => {
    for (const k of ["specAfterCreate", "specAtEnd"]) {
      const s = pins.get(k) as Json;
      expect(s.recomputed, k).toBe(s.specHash);
    }
    pin("spec-hash.json", { afterCreate: pins.get("specAfterCreate"), atEnd: pins.get("specAtEnd") });
  });

  it("route-hash.json: the stored routePlanHash is the hash of the recorded plan", () => {
    for (const k of ["routesAfterCreate", "routesAfterPrimary"]) {
      const r = pins.get(k) as Json;
      expect(r.recomputed, k).toBe(r.routePlanHash);
    }
    pin("route-hash.json", { afterCreate: pins.get("routesAfterCreate"), afterPrimaryChange: pins.get("routesAfterPrimary") });
  });

  it("every siteType the API sends is wordpress", () => {
    const all: unknown[] = [];
    for (const name of ["provision", "domains", "backup", "restore", "files", "sftp", "terminal"]) {
      stripSiteType(callsOf(name), all);
    }
    for (const v of all) expect(v).toBe("wordpress");
  });
});
