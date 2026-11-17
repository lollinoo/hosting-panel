// The life of a site outside the five subsystems asks the site type (M6a, A2); a WordPress site matches the pins.
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { siteDatabasePrefix } from "@hosting-panel/contracts";
import {
  createDatabaseClient,
  domains,
  eq,
  operationSteps,
  operations,
  siteDatabases,
  sites,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { siteProvisionSteps } from "../src/runtime/site-provisioner.js";
import { getApiSiteType } from "../src/site-types/index.js";
import { TEST_API_SITE_TYPE } from "./fixtures/test-site-type.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Call { readonly method: string; readonly arg: Json }

const KEY = Buffer.alloc(32, 7);
const PW = "sentinel-login-pass-0001";
const SITE = {
  name: "Site A",
  domain: "wp-a.example.test",
  includeWww: true,
  phpVersion: "8.3" as const,
  title: "Site A",
  adminUser: "siteadmin",
  adminEmail: "admin@example.test",
  adminPassword: "sentinel-Admin-Pass-0001",
};
// Today's step list of site.provision, written out: the stored keys and labels never change.
const TODAY_PROVISION_STEPS = [
  { key: "create_database", label: "Prepare the database" },
  { key: "deploy_site", label: "Start the site" },
  { key: "install_wordpress", label: "Install WordPress" },
  { key: "publish_site", label: "Publish the site" },
  { key: "finish", label: "Finish" },
];

const fixture = (file: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/site-type-pins/${file}`, import.meta.url), "utf8")) as {
    calls: { method: string; args: Json[] }[];
  };
const pinned = (file: string, method: string) => fixture(file).calls.filter((c) => c.method === method).map((c) => c.args[0]!);

describe("the provision step list comes from the type", () => {
  it("is today's list for WordPress and leaves out the database and install steps of a type without them", () => {
    expect(siteProvisionSteps(getApiSiteType("wordpress"))).toEqual(TODAY_PROVISION_STEPS);
    expect(siteProvisionSteps(TEST_API_SITE_TYPE).map((s) => s.key)).toEqual(["deploy_site", "publish_site", "finish"]);
  });
});

describe("a WordPress site walks creation, provision, address change and updates as before", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let adminToken: string;
  let ownerToken: string;
  let orgId: string;
  const calls: Call[] = [];

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

  /** Runs one step and returns the executor calls it made. */
  async function during(run: () => Promise<void>): Promise<Call[]> {
    const from = calls.length;
    await run();
    return calls.slice(from);
  }

  async function createSite(name: string, domain: string): Promise<{ siteId: string; operationId: string }> {
    const res = await http("POST", `/v1/organizations/${orgId}/managed-sites`, { ...SITE, name, domain });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    return res.body.data as { siteId: string; operationId: string };
  }

  const opRow = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, { installationName: "Walk", hostHostname: "panel.example.test", hostIpv4: "192.0.2.10" });
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter();
    const recorded = new Proxy(sim, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (typeof v !== "function" || typeof prop !== "string") return v;
        return (...args: unknown[]) => {
          calls.push({ method: prop, arg: JSON.parse(JSON.stringify(args[0] ?? null)) as Json });
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    app = await createControlPlaneApp({
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      jwtSigningKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      runtimeBackend: "linux-systemd",
      dockerExecutor: recorded,
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
    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);
    const created = await http(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Org A", ownerEmail: "owner@example.test", ownerName: "Owner A" },
      adminToken,
    );
    expect(created.status).toBe(201);
    orgId = created.body.data.organizationId as string;
    ownerToken = await login("owner@example.test", created.body.data.temporaryPassword as string);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await dbClient?.close();
  });

  let siteId = "";

  it("creates and provisions with today's steps, the pinned jobs and the pinned spec hash", async () => {
    let operationId = "";
    const taken = await during(async () => {
      ({ siteId, operationId } = await createSite(SITE.name, SITE.domain));
      await drain();
    });
    expect((await opRow(operationId)).status).toBe("succeeded");
    const steps = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, operationId));
    expect(steps.map((s) => ({ key: s.key, label: s.label }))).toEqual(TODAY_PROVISION_STEPS);
    const [siteDb] = await dbClient.db.select().from(siteDatabases).where(eq(siteDatabases.siteId, siteId));
    expect(siteDb?.dbName).toBe(siteDatabasePrefix(siteId));

    const sha12 = createHash("sha256").update(siteId).digest("hex").slice(0, 12);
    const jobs = taken
      .filter((c) => c.method === "runSiteJob")
      .map((c) => ({ kind: c.arg.kind, params: c.arg.params, secrets: Object.keys(c.arg.resolvedSecrets ?? {}).sort() }));
    const pinnedJobs = pinned("provision-jobs.json", "runSiteJob").map((j) => ({
      kind: j.kind,
      params: JSON.parse(JSON.stringify(j.params).replaceAll("<site-sha12>", sha12)) as Json,
      secrets: Object.keys(j.resolvedSecrets ?? {}).sort(),
    }));
    expect(jobs).toEqual(pinnedJobs);
    const specs = taken.filter((c) => c.method === "deployService").map((c) => [c.arg.specHash, c.arg.image]);
    expect(specs).toEqual(pinned("provision-jobs.json", "deployService").map((s) => [s.specHash, s.image]));
  }, 60_000);

  it("switches the address with the pinned job", async () => {
    const base = `/v1/organizations/${orgId}/managed-sites/${siteId}`;
    const list = (await http("GET", `${base}/domains`)).body.data.domains as Json[];
    const expires = new Date(Date.now() + 60 * 86_400_000);
    for (const d of list) {
      await dbClient.db.update(domains).set({ certStatus: "active", certExpiresAt: expires }).where(eq(domains.id, d.id as string));
      sim.issueCertificate(d.hostname as string, expires.toISOString());
    }
    const www = list.find((d) => d.hostname === `www.${SITE.domain}`)!;
    const taken = await during(async () => {
      expect((await http("POST", `${base}/domains/${www.id as string}/primary`)).status).toBe(200);
      await drain();
    });
    const jobs = taken.filter((c) => c.method === "runSiteJob").map((c) => ({ kind: c.arg.kind, params: c.arg.params }));
    expect(jobs).toEqual(pinned("domains-jobs.json", "runSiteJob").map((j) => ({ kind: j.kind, params: j.params })));
  }, 60_000);

  it("marks no site behind on the updates page, and still marks one whose PHP version moved", async () => {
    const updates = async () => (await http("GET", "/v1/admin/updates", undefined, adminToken)).body.data as Json;
    expect(await updates()).toMatchObject({ sites: [], sitesTotal: 0 });
    await dbClient.db.update(sites).set({ phpVersion: "8.4" }).where(eq(sites.id, siteId));
    expect(await updates()).toMatchObject({ sites: [{ siteId, phpVersion: "8.4" }], sitesTotal: 1 });
    await dbClient.db.update(sites).set({ phpVersion: SITE.phpVersion }).where(eq(sites.id, siteId));
  }, 60_000);

  it("does not provision a site whose row has no known type as WordPress", async () => {
    const { siteId: otherId, operationId } = await createSite("Site B", "wp-b.example.test");
    await dbClient.db.update(sites).set({ siteType: "teststatic" }).where(eq(sites.id, otherId));
    const taken = await during(drain);
    expect((await opRow(operationId)).status).toBe("failed");
    expect(taken.filter((c) => ["runSiteJob", "deployService"].includes(c.method))).toEqual([]);
  }, 60_000);
});
