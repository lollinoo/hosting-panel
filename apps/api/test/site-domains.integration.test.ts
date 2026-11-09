import { randomUUID } from "node:crypto";
import {
  and,
  auditEvents,
  createDatabaseClient,
  domains,
  eq,
  operations,
  operationSteps,
  outboxEvents,
  sites,
  type DatabaseClient,
  type DomainRow,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { SiteRoutesRequest } from "@hosting-panel/executor-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import {
  buildSiteHostRoutes,
  desiredWordpressUrl,
  manualCertRetryAt,
  routePlanHash,
} from "../src/sites/domain-policy.js";
import { enqueueSiteDomainsOperation } from "../src/sites/site-domains-applier.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const SITE = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
  adminPassword: "canary-Pass-123456",
};
const DAY = 24 * 3600_000;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function row(hostname: string, over: Partial<DomainRow> = {}): DomainRow {
  const now = new Date();
  return {
    id: `dom_${hostname}`,
    siteId: "site_1",
    organizationId: "org_1",
    hostname,
    isPrimary: false,
    status: "active",
    dnsStatus: "ok",
    dnsObserved: { a: [], aaaa: [] },
    dnsCheckedAt: null,
    dnsNextCheckAt: now,
    dnsAttempts: 0,
    certStatus: "none",
    certProblem: null,
    certRequestedAt: null,
    certRetryAt: null,
    certAttempts: 0,
    certExpiresAt: null,
    certTrusted: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

describe("route plan rules", () => {
  const now = new Date();
  const later = new Date(now.getTime() + 60 * DAY);
  const yesterday = new Date(now.getTime() - DAY);

  it("an expired certificate stops the https redirect but keeps the resolver", () => {
    const [h] = buildSiteHostRoutes([row("hotel.it", { isPrimary: true, certStatus: "active", certExpiresAt: yesterday })], now);
    expect(h).toEqual({ hostname: "hotel.it", tls: true, httpsRedirect: false, redirectTo: null });
  });

  it("expired certificate keeps the WordPress address on https", () => {
    const rows = [row("hotel.it", { isPrimary: true, certStatus: "active", certExpiresAt: yesterday })];
    expect(desiredWordpressUrl(rows, now, "https://hotel.it")).toBe("https://hotel.it");
    expect(desiredWordpressUrl(rows, now, "http://hotel.it")).toBe("http://hotel.it");
  });

  it("the primary moves to https only with a usable certificate, and only its host changes once on https", () => {
    const active = [row("hotel.it", { isPrimary: true, certStatus: "active", certExpiresAt: later })];
    expect(desiredWordpressUrl(active, now, "http://hotel.it")).toBe("https://hotel.it");
    expect(desiredWordpressUrl(active, now, "http://hotel.it", false)).toBe("http://hotel.it");
    const www = [row("www.hotel.it", { isPrimary: true })];
    expect(desiredWordpressUrl(www, now, "https://hotel.it")).toBe("https://www.hotel.it");
    expect(desiredWordpressUrl([row("hotel.it", { isPrimary: true, status: "pending" })], now, null)).toBeNull();
  });

  it("a redirect targets https only when the primary has a certificate active or requested", () => {
    const plan = (certStatus: DomainRow["certStatus"]) =>
      buildSiteHostRoutes([row("hotel.it", { isPrimary: true, certStatus, certExpiresAt: later }), row("www.hotel.it")], now)[1]!
        .redirectTo;
    expect(plan("active")).toBe("https://hotel.it");
    expect(plan("requested")).toBe("https://hotel.it");
    expect(plan("none")).toBe("http://hotel.it");
    expect(plan("failed")).toBe("http://hotel.it");
  });

  it("the https redirect waits until the host's certificate is active", () => {
    const [requested] = buildSiteHostRoutes([row("hotel.it", { isPrimary: true, certStatus: "requested" })], now);
    expect(requested).toMatchObject({ tls: true, httpsRedirect: false });
    const [active] = buildSiteHostRoutes([row("hotel.it", { isPrimary: true, certStatus: "active", certExpiresAt: later })], now);
    expect(active).toMatchObject({ tls: true, httpsRedirect: true });
  });

  it("with ACME disabled only http origins and no TLS routes", () => {
    const rows = [row("hotel.it", { isPrimary: true, certStatus: "active", certExpiresAt: later }), row("www.hotel.it", { certStatus: "requested" })];
    expect(buildSiteHostRoutes(rows, now, { acmeEnabled: false })).toEqual([
      { hostname: "hotel.it", tls: false, httpsRedirect: false, redirectTo: null },
      { hostname: "www.hotel.it", tls: false, httpsRedirect: false, redirectTo: "http://hotel.it" },
    ]);
  });

  it("the transition plan serves every host without redirects, and unrouted names drop out", () => {
    const rows = [
      row("hotel.it", { isPrimary: true, certStatus: "active", certExpiresAt: later }),
      row("www.hotel.it", { certStatus: "active", certExpiresAt: later }),
      row("old.it", { status: "pending" }),
    ];
    expect(buildSiteHostRoutes(rows, now, { transition: true })).toEqual([
      { hostname: "hotel.it", tls: true, httpsRedirect: false, redirectTo: null },
      { hostname: "www.hotel.it", tls: true, httpsRedirect: false, redirectTo: null },
    ]);
  });

  it("the plan hash ignores key and host order", () => {
    const a = { hostname: "a.it", tls: true, httpsRedirect: false, redirectTo: null };
    const b = { hostname: "b.it", tls: false, httpsRedirect: false, redirectTo: "http://a.it" };
    const reordered = { redirectTo: null, httpsRedirect: false, tls: true, hostname: "a.it" };
    expect(routePlanHash([a, b], "http://a.it")).toBe(routePlanHash([b, reordered], "http://a.it"));
    expect(routePlanHash([a, b], "http://a.it")).not.toBe(routePlanHash([a, b], "https://a.it"));
  });
});

describe("site.domains operation", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let token: string;
  let orgId: string;
  const dnsAnswers = new Map<string, { a: string[]; aaaa: string[] } | Error>();

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

  async function call(method: string, path: string, body?: unknown, as: string = token) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  const org = (p: string) => `/v1/organizations/${orgId}${p}`;
  const run = () => app.outboxWorker.processPendingOnce();

  async function createAndRun(body: Json = SITE): Promise<string> {
    const res = await call("POST", org("/managed-sites"), body);
    expect(res.status).toBe(202);
    await run();
    return res.body.data.siteId as string;
  }

  const site = async (siteId: string) => (await dbClient.db.select().from(sites).where(eq(sites.id, siteId)))[0]!;
  const opRow = async (opId: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, opId)))[0]!;
  const steps = async (opId: string) =>
    Object.fromEntries(
      (await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, opId))).map((s) => [s.key, s]),
    );
  const setCert = (hostname: string, set: Partial<DomainRow>) =>
    dbClient.db.update(domains).set(set).where(eq(domains.hostname, hostname));
  const routesOf = (req: SiteRoutesRequest) => req.hosts.map((h) => ({ ...h }));

  async function applyDomains(siteId: string): Promise<string> {
    const { operation } = await enqueueSiteDomainsOperation(dbClient.db, { organizationId: orgId, siteId });
    await run();
    return operation.id;
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter();
    dnsAnswers.clear();
    app = await createControlPlaneApp({
      dnsLookup: {
        lookup: async (h) => {
          const v = dnsAnswers.get(h) ?? { a: [], aaaa: [] };
          if (v instanceof Error) throw v;
          return v;
        },
      },
      domainReconcileIntervalMs: null,
      listen: true,
      host: "127.0.0.1",
      port: 0,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: sim,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    const adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
    const created = await call(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Hotel Mario", ownerEmail: "mario@hotel.it", ownerName: "Mario" },
      adminToken,
    );
    expect(created.status).toBe(201);
    orgId = created.body.data.organizationId as string;
    token = await login("mario@hotel.it", created.body.data.temporaryPassword as string);
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  it("create with includeWww adds a pending pair that goes live at publish", async () => {
    const res = await call("POST", org("/managed-sites"), { ...SITE, includeWww: true });
    const siteId = res.body.data.siteId as string;
    const before = await dbClient.db.select().from(domains).where(eq(domains.siteId, siteId));
    expect(before.map((d) => [d.hostname, d.isPrimary, d.status]).sort()).toEqual([
      ["hotel.it", true, "pending"],
      ["www.hotel.it", false, "pending"],
    ]);
    await run();
    expect(sim.deployedSpecs.at(-1)!.hostRoutes).toEqual([
      { hostname: "hotel.it", tls: false, httpsRedirect: false, redirectTo: null },
      { hostname: "www.hotel.it", tls: false, httpsRedirect: false, redirectTo: "http://hotel.it" },
    ]);
    expect(sim.deployedSpecs.at(-1)!.domains).toEqual(["hotel.it", "www.hotel.it"]);
  });

  it("the www partner is covered by the domain conflict check", async () => {
    await createAndRun({ ...SITE, domain: "www.hotel.it" });
    const res = await call("POST", org("/managed-sites"), { ...SITE, name: "Other", includeWww: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DOMAIN_CONFLICT");
    expect(res.body.error.message).not.toContain("hotel.it");
  });

  it("publish_site stores the applied plan", async () => {
    const siteId = await createAndRun();
    const deployed = sim.deployedSpecs.at(-1)!.hostRoutes!;
    const s = await site(siteId);
    expect(s.appliedRoutes).toEqual(deployed);
    expect(s.wordpressUrl).toBe("http://hotel.it");
    expect(s.appliedRoutesHash).toBe(
      routePlanHash(buildSiteHostRoutes(await dbClient.db.select().from(domains).where(eq(domains.siteId, siteId)), new Date()), "http://hotel.it"),
    );
    expect(s.appliedRoutesHash).toBe(routePlanHash(deployed, "http://hotel.it"));
  });

  it("a URL change opens a transition plan before running set-url", async () => {
    const siteId = await createAndRun({ ...SITE, includeWww: true });
    await setCert("hotel.it", { certStatus: "active", certExpiresAt: new Date(Date.now() + 60 * DAY) });
    const from = sim.routeHistory.length;
    let routesAtJob = -1;
    sim.onJob = async (req) => {
      if (req.kind === "wordpress.set-url") routesAtJob = sim.routeHistory.length;
    };

    const opId = await applyDomains(siteId);
    expect((await opRow(opId)).status).toBe("succeeded");

    const history = sim.routeHistory.slice(from).map(routesOf);
    expect(history).toEqual([
      [
        { hostname: "hotel.it", tls: true, httpsRedirect: false, redirectTo: null },
        { hostname: "www.hotel.it", tls: false, httpsRedirect: false, redirectTo: null },
      ],
      [
        { hostname: "hotel.it", tls: true, httpsRedirect: true, redirectTo: null },
        { hostname: "www.hotel.it", tls: false, httpsRedirect: false, redirectTo: "https://hotel.it" },
      ],
    ]);
    expect(routesAtJob).toBe(from + 1);
    const job = sim.jobs.at(-1)!;
    expect(job.kind).toBe("wordpress.set-url");
    expect(job.params).toEqual({ phpVersion: "8.4", siteUrl: "https://hotel.it", previousUrl: "http://hotel.it" });

    const s = await site(siteId);
    expect(s.wordpressUrl).toBe("https://hotel.it");
    expect(s.appliedRoutes).toEqual(history[1]);
    expect(s.appliedRoutesHash).toBe(routePlanHash(history[1]!, "https://hotel.it"));
    const audit = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "site.domains.applied"));
    expect(audit).toHaveLength(1);
  });

  it("no URL change skips prepare and update_address", async () => {
    const siteId = await createAndRun();
    const before = await site(siteId);
    const from = sim.routeHistory.length;
    const jobs = sim.jobs.length;

    const opId = await applyDomains(siteId);
    expect((await opRow(opId)).status).toBe("succeeded");
    const st = await steps(opId);
    expect(st["prepare"]).toMatchObject({ status: "skipped", message: "Nothing to change" });
    expect(st["update_address"]).toMatchObject({ status: "skipped", message: "Nothing to change" });
    expect(st["publish"]!.status).toBe("succeeded");
    expect(sim.jobs).toHaveLength(jobs);
    expect(sim.routeHistory.slice(from).map(routesOf)).toEqual([before.appliedRoutes]);
    expect((await site(siteId)).appliedRoutesHash).toBe(before.appliedRoutesHash);
  });

  it("a failed set-url keeps the site ready and leaves the safe transition plan", async () => {
    const siteId = await createAndRun({ ...SITE, includeWww: true });
    await setCert("hotel.it", { certStatus: "active", certExpiresAt: new Date(Date.now() + 60 * DAY) });
    const before = await site(siteId);
    const leak = "Error: wp-cli exploded at /var/www/html";
    sim.failNextJob("wordpress.set-url", 1, leak);

    const opId = await applyDomains(siteId);
    const op = await opRow(opId);
    expect(op.status).toBe("failed");
    expect(op.errorMessage).toBe("The web address change did not finish. We'll try again shortly.");
    const s = await site(siteId);
    expect(s.status).toBe("ready");
    expect(s.appliedRoutesHash).toBe(before.appliedRoutesHash);
    expect(s.wordpressUrl).toBe(before.wordpressUrl);
    expect(routesOf(sim.routeHistory.at(-1)!)).toEqual([
      { hostname: "hotel.it", tls: true, httpsRedirect: false, redirectTo: null },
      { hostname: "www.hotel.it", tls: false, httpsRedirect: false, redirectTo: null },
    ]);

    const st = await steps(opId);
    expect(st["prepare"]!.status).toBe("succeeded");
    expect(st["update_address"]).toMatchObject({ status: "failed", message: "Could not finish this step" });
    expect(st["publish"]!.status).toBe("skipped");
    expect(JSON.stringify([op, st])).not.toContain(leak);
    const [audit] = await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, "site.domains.failed"));
    expect(audit!.details).toMatchObject({ step: "update_address", exitCode: 1, outputTail: leak });
  });

  it("store briefly missing a certificate never rewrites the site to http", async () => {
    const siteId = await createAndRun();
    await dbClient.db.update(sites).set({ wordpressUrl: "https://hotel.it" }).where(eq(sites.id, siteId));
    await setCert("hotel.it", { certStatus: "requested" });
    const jobs = sim.jobs.length;

    const opId = await applyDomains(siteId);
    expect((await opRow(opId)).status).toBe("succeeded");
    expect(sim.jobs).toHaveLength(jobs);
    const s = await site(siteId);
    expect(s.wordpressUrl).toBe("https://hotel.it");
    expect(s.appliedRoutes).toEqual([{ hostname: "hotel.it", tls: true, httpsRedirect: false, redirectTo: null }]);
  });

  it("a restart re-publishes the last applied plan", async () => {
    const siteId = await createAndRun({ ...SITE, includeWww: true });
    await setCert("hotel.it", { certStatus: "active", certExpiresAt: new Date(Date.now() + 60 * DAY) });
    await applyDomains(siteId);
    const applied = (await site(siteId)).appliedRoutes!;
    expect(applied[0]!.httpsRedirect).toBe(true);
    await setCert("hotel.it", { certStatus: "requested" });

    const res = await call("PATCH", org(`/managed-sites/${siteId}/runtime`), { phpVersion: "8.5" });
    expect(res.status).toBe(202);
    await run();
    expect((await opRow(res.body.data.operationId as string)).status).toBe("succeeded");
    const spec = sim.deployedSpecs.at(-1)!;
    expect(spec.image).toBe("wordpress:7.1.4-php8.5-apache");
    expect(spec.hostRoutes).toEqual(applied);
  });

  it("a publish failure after the address switch keeps the transition plan for restarts, and the retry does not switch again", async () => {
    const siteId = await createAndRun({ ...SITE, includeWww: true });
    await setCert("hotel.it", { certStatus: "active", certExpiresAt: new Date(Date.now() + 60 * DAY) });
    const transition = [
      { hostname: "hotel.it", tls: true, httpsRedirect: false, redirectTo: null },
      { hostname: "www.hotel.it", tls: false, httpsRedirect: false, redirectTo: null },
    ];
    const original = sim.applySiteRoutes.bind(sim);
    let calls = 0;
    sim.applySiteRoutes = async (req) => {
      calls += 1;
      if (calls === 2) throw new Error("proxy unavailable");
      return original(req);
    };

    const failedOp = await applyDomains(siteId);
    expect((await opRow(failedOp)).status).toBe("failed");
    const s = await site(siteId);
    expect(s.wordpressUrl).toBe("https://hotel.it");
    expect(s.appliedRoutes).toEqual(transition);
    expect(s.appliedRoutesHash).toBe(routePlanHash(transition, "https://hotel.it"));

    const res = await call("PATCH", org(`/managed-sites/${siteId}/runtime`), { phpVersion: "8.5" });
    await run();
    expect((await opRow(res.body.data.operationId as string)).status).toBe("succeeded");
    expect(sim.deployedSpecs.at(-1)!.hostRoutes).toEqual(transition);

    const setUrlJobs = sim.jobs.filter((j) => j.kind === "wordpress.set-url").length;
    const retry = await applyDomains(siteId);
    expect((await opRow(retry)).status).toBe("succeeded");
    expect(sim.jobs.filter((j) => j.kind === "wordpress.set-url")).toHaveLength(setUrlJobs);
    expect((await steps(retry))["update_address"]!.status).toBe("skipped");
    expect((await site(siteId)).appliedRoutes).toEqual([
      { hostname: "hotel.it", tls: true, httpsRedirect: true, redirectTo: null },
      { hostname: "www.hotel.it", tls: false, httpsRedirect: false, redirectTo: "https://hotel.it" },
    ]);
  });

  it("a restart drops a redirect to a name that is no longer routed", async () => {
    const siteId = await createAndRun({ ...SITE, includeWww: true });
    // The main address moved to www and the old name was removed, before site.domains ran.
    await setCert("hotel.it", { isPrimary: false, status: "pending" });
    await setCert("www.hotel.it", { isPrimary: true });
    expect((await site(siteId)).appliedRoutes).toContainEqual(
      expect.objectContaining({ hostname: "www.hotel.it", redirectTo: "http://hotel.it" }),
    );

    const res = await call("PATCH", org(`/managed-sites/${siteId}/runtime`), { phpVersion: "8.5" });
    await run();
    expect((await opRow(res.body.data.operationId as string)).status).toBe("succeeded");
    expect(sim.deployedSpecs.at(-1)!.hostRoutes).toEqual([
      { hostname: "www.hotel.it", tls: false, httpsRedirect: false, redirectTo: null },
    ]);
  });

  it("a site.domains request during provisioning is refused with RESOURCE_LOCKED", async () => {
    const res = await call("POST", org("/managed-sites"), SITE);
    const siteId = res.body.data.siteId as string;
    await expect(enqueueSiteDomainsOperation(dbClient.db, { organizationId: orgId, siteId })).rejects.toMatchObject({
      code: "RESOURCE_LOCKED",
    });
  });

  it("interrupted site.domains converges to failed without degrading the site", async () => {
    const siteId = await createAndRun();
    const { operation } = await enqueueSiteDomainsOperation(dbClient.db, { organizationId: orgId, siteId });
    await dbClient.db
      .update(operations)
      .set({ status: "processing", leaseExpiresAt: new Date(Date.now() - 5_000) })
      .where(eq(operations.id, operation.id));
    await dbClient.db.update(outboxEvents).set({ status: "published" }).where(eq(outboxEvents.aggregateId, siteId));
    const routes = sim.routeHistory.length;

    const recovery = await app.outboxWorker.recoverUnknownOperations();
    expect(recovery.convergedFailed).toBe(1);
    const op = await opRow(operation.id);
    expect(op.status).toBe("failed");
    expect(op.errorMessage).toBe("This change was interrupted. We'll try again shortly.");
    expect((await site(siteId)).status).toBe("ready");
    expect(sim.routeHistory).toHaveLength(routes);
  });

  describe("reconciler", () => {
    const MIN = 60_000;
    let t0: Date;
    const at = (min: number) => new Date(t0.getTime() + min * MIN);
    const reconcile = async (min: number) => {
      await app.domainReconciler.reconcileOnce(at(min));
      await run();
    };
    const dom = async (h: string) => (await dbClient.db.select().from(domains).where(eq(domains.hostname, h)))[0]!;
    const pointHere = (h: string) => dnsAnswers.set(h, { a: ["10.0.0.1"], aaaa: [] });
    const plan = (siteId: string) => sim.appliedRoutes.get(siteId)!.hosts.map((h) => ({ ...h }));
    const domainOps = (siteId: string) =>
      dbClient.db
        .select()
        .from(operations)
        .where(and(eq(operations.resourceId, siteId), eq(operations.kind, "site.domains")));
    const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
    const tlsRequests = () => sim.routeHistory.filter((r) => r.hosts.some((h) => h.tls)).length;
    // What "Check now" does (Task 9): bring a retry forward within the policy, then reconcile the site.
    const checkNow = async (siteId: string, h: string, min: number) => {
      const retry = manualCertRetryAt(at(min), await dom(h));
      if (retry) await setCert(h, { certRetryAt: retry });
      await app.domainReconciler.reconcileSite(siteId, at(min), { forceDnsCheck: true });
      await run();
    };
    const plain = { hostname: "hotel.it", tls: false, httpsRedirect: false, redirectTo: null };

    beforeEach(() => {
      // A minute ahead of the clock: rows the test creates are already due for a DNS check.
      t0 = new Date(Date.now() + MIN);
    });

    async function requested(): Promise<string> {
      const siteId = await createAndRun();
      pointHere("hotel.it");
      await reconcile(0);
      expect((await dom("hotel.it")).certStatus).toBe("requested");
      return siteId;
    }

    async function activated(): Promise<string> {
      const siteId = await requested();
      sim.issueCertificate("hotel.it", new Date(t0.getTime() + 90 * DAY).toISOString());
      await reconcile(1);
      expect((await dom("hotel.it")).certStatus).toBe("active");
      return siteId;
    }

    it("waiting for DNS until the A record points here, then a certificate is requested and the site goes https", async () => {
      const siteId = await createAndRun();
      await reconcile(0);
      let d = await dom("hotel.it");
      expect(d).toMatchObject({ dnsStatus: "not_found", certStatus: "none", dnsAttempts: 1 });
      expect(d.dnsNextCheckAt).toEqual(at(1));
      expect(await domainOps(siteId)).toHaveLength(0);

      pointHere("hotel.it");
      await reconcile(1);
      d = await dom("hotel.it");
      expect(d).toMatchObject({ dnsStatus: "ok", certStatus: "requested", dnsAttempts: 0 });
      expect(d.dnsObserved).toEqual({ a: ["10.0.0.1"], aaaa: [] });
      expect(d.certRequestedAt).toEqual(at(1));
      const ops = await domainOps(siteId);
      expect(ops.map((o) => o.status)).toEqual(["succeeded"]);
      expect(plan(siteId)).toEqual([{ ...plain, tls: true }]);

      sim.issueCertificate("hotel.it", new Date(t0.getTime() + 90 * DAY).toISOString());
      const jobs = sim.jobs.length;
      await reconcile(2);
      expect(await dom("hotel.it")).toMatchObject({ certStatus: "active", certProblem: null, certAttempts: 0 });
      expect(sim.jobs.slice(jobs).map((j) => j.kind)).toEqual(["wordpress.set-url"]);
      expect(plan(siteId)).toEqual([{ ...plain, tls: true, httpsRedirect: true }]);
      expect((await site(siteId)).wordpressUrl).toBe("https://hotel.it");
      expect(await audits("site.certificate.issued")).toHaveLength(1);

      await reconcile(3);
      expect(await domainOps(siteId)).toHaveLength(2);
      expect(await audits("site.certificate.issued")).toHaveLength(1);
    });

    it("a failure removes the resolver and schedules a retry", async () => {
      const siteId = await requested();
      sim.failCertificate("hotel.it", "port_80_blocked", at(1).toISOString());
      await reconcile(1);
      const d = await dom("hotel.it");
      expect(d).toMatchObject({ certStatus: "failed", certProblem: "port_80_blocked", certAttempts: 1 });
      expect(d.certRetryAt).toEqual(at(16));
      expect(plan(siteId)).toEqual([plain]);
      const [audit] = await audits("site.certificate.failed");
      expect(audit!.details).toEqual({ hostname: "hotel.it", problem: "port_80_blocked", detail: "simulated port_80_blocked" });

      await reconcile(15);
      expect((await dom("hotel.it")).certStatus).toBe("failed");
      await reconcile(16);
      expect(await dom("hotel.it")).toMatchObject({ certStatus: "requested", certRequestedAt: at(16) });
      expect(plan(siteId)).toEqual([{ ...plain, tls: true }]);
    });

    it("a request with no certificate and no failure after 10 minutes counts as failed", async () => {
      await requested();
      await reconcile(9);
      expect((await dom("hotel.it")).certStatus).toBe("requested");
      await reconcile(10);
      expect(await dom("hotel.it")).toMatchObject({ certStatus: "failed", certProblem: "other", certRetryAt: at(25) });
    });

    it("check now does not shorten a rate-limit wait", async () => {
      const siteId = await requested();
      sim.failCertificate("hotel.it", "rate_limited", at(0).toISOString());
      await reconcile(0);
      expect((await dom("hotel.it")).certRetryAt).toEqual(new Date(at(0).getTime() + DAY));
      await checkNow(siteId, "hotel.it", 1);
      const d = await dom("hotel.it");
      expect(d).toMatchObject({ certStatus: "failed", certProblem: "rate_limited" });
      expect(d.certRetryAt).toEqual(new Date(at(0).getTime() + DAY));
    });

    it("check now cannot bring a certificate retry forward twice within 15 min", async () => {
      const siteId = await requested();
      expect(tlsRequests()).toBe(1);
      sim.failCertificate("hotel.it", "port_80_blocked", at(0).toISOString());
      await reconcile(0);
      for (const min of [1, 2, 3]) {
        await checkNow(siteId, "hotel.it", min);
        await reconcile(min);
        expect(await dom("hotel.it")).toMatchObject({ certStatus: "failed", certRetryAt: at(15) });
      }
      await reconcile(14);
      expect(tlsRequests()).toBe(1);

      await reconcile(16);
      expect((await dom("hotel.it")).certStatus).toBe("requested");
      expect(tlsRequests()).toBe(2);
      sim.failCertificate("hotel.it", "port_80_blocked", at(16).toISOString());
      await reconcile(16);
      expect((await dom("hotel.it")).certRetryAt).toEqual(at(76));
      await checkNow(siteId, "hotel.it", 17);
      expect(await dom("hotel.it")).toMatchObject({ certStatus: "failed", certRetryAt: at(31) });
      await reconcile(30);
      expect(tlsRequests()).toBe(2);
      await reconcile(31);
      expect(tlsRequests()).toBe(3);
    });

    it("concurrent reconciles never request twice", async () => {
      const siteId = await createAndRun();
      pointHere("hotel.it");
      await Promise.all([app.domainReconciler.reconcileOnce(at(0)), app.domainReconciler.reconcileSite(siteId, at(0))]);
      expect((await dom("hotel.it")).certStatus).toBe("requested");
      expect(await audits("site.certificate.requested")).toHaveLength(1);
      expect(await domainOps(siteId)).toHaveLength(1);
    });

    it("a renewal failure keeps the certificate active and raises the problem", async () => {
      const siteId = await activated();
      sim.failCertificate("hotel.it", "port_80_blocked", at(5).toISOString(), "renew");
      await reconcile(5);
      expect(await dom("hotel.it")).toMatchObject({ certStatus: "active", certProblem: "port_80_blocked" });
      expect(plan(siteId)).toEqual([{ ...plain, tls: true, httpsRedirect: true }]);

      // The renewal goes through: a new certificate clears the problem, and the old failure does not bring it back.
      sim.issueCertificate("hotel.it", new Date(t0.getTime() + 120 * DAY).toISOString());
      await reconcile(6);
      expect(await dom("hotel.it")).toMatchObject({ certStatus: "active", certProblem: null });
      await reconcile(7);
      expect((await dom("hotel.it")).certProblem).toBeNull();
      expect(await audits("site.certificate.issued")).toHaveLength(2);
    });

    it("an unreadable store keeps every certificate state", async () => {
      const siteId = await activated();
      const ops = (await domainOps(siteId)).length;
      const before = await dom("hotel.it");
      sim.setCertificateStoreReadable(false);
      await reconcile(5);
      await reconcile(20);
      const after = await dom("hotel.it");
      expect(after.certStatus).toBe("active");
      expect({ ...after, updatedAt: null, dnsCheckedAt: null }).toEqual({ ...before, updatedAt: null, dnsCheckedAt: null });
      expect(await domainOps(siteId)).toHaveLength(ops);
    });

    it("a store that lost a certificate requests it again whatever DNS says", async () => {
      const siteId = await activated();
      dnsAnswers.set("hotel.it", { a: ["198.51.100.9"], aaaa: [] });
      sim.removeCertificate("hotel.it");
      await app.domainReconciler.reconcileSite(siteId, at(5), { forceDnsCheck: true });
      await run();
      expect(await dom("hotel.it")).toMatchObject({ dnsStatus: "points_elsewhere", certStatus: "requested", certRequestedAt: at(5) });
      await reconcile(6);
      expect((await dom("hotel.it")).certStatus).toBe("requested");
      expect(plan(siteId)[0]!.tls).toBe(true);
    });

    it("DNS pointing away later never drops an issued certificate", async () => {
      const siteId = await activated();
      dnsAnswers.set("hotel.it", { a: ["198.51.100.9"], aaaa: [] });
      await app.domainReconciler.reconcileSite(siteId, at(5), { forceDnsCheck: true });
      await run();
      expect(await dom("hotel.it")).toMatchObject({ dnsStatus: "points_elsewhere", certStatus: "active" });
      expect(plan(siteId)[0]!.tls).toBe(true);
    });

    it("a fresh request whose DNS breaks goes back to none", async () => {
      const siteId = await requested();
      dnsAnswers.set("hotel.it", new Error("SERVFAIL"));
      await app.domainReconciler.reconcileSite(siteId, at(1), { forceDnsCheck: true });
      await run();
      expect(await dom("hotel.it")).toMatchObject({ dnsStatus: "lookup_failed", certStatus: "none" });
      expect(plan(siteId)).toEqual([plain]);
    });

    it("a AAAA record blocks the request", async () => {
      await createAndRun();
      dnsAnswers.set("hotel.it", { a: ["10.0.0.1"], aaaa: ["2001:db8::1"] });
      await reconcile(0);
      expect(await dom("hotel.it")).toMatchObject({ dnsStatus: "ipv6_conflict", certStatus: "none" });
    });

    it("a locked site is retried on the next pass", async () => {
      const siteId = await createAndRun();
      const lockId = `op_lock_${randomUUID().replace(/-/g, "")}`;
      await dbClient.db.insert(operations).values({
        id: lockId,
        organizationId: orgId,
        kind: "site.provision",
        status: "processing",
        resourceType: "site",
        resourceId: siteId,
        lockKey: `site:${siteId}`,
      });
      pointHere("hotel.it");
      await reconcile(0);
      expect((await dom("hotel.it")).certStatus).toBe("requested");
      expect(await domainOps(siteId)).toHaveLength(0);

      await dbClient.db.update(operations).set({ status: "succeeded" }).where(eq(operations.id, lockId));
      await reconcile(1);
      expect((await domainOps(siteId)).map((o) => o.status)).toEqual(["succeeded"]);
      expect(plan(siteId)).toEqual([{ ...plain, tls: true }]);
    });

    it("the reconciler never requests with acme disabled", async () => {
      const siteId = await createAndRun();
      sim.acmeEnabled = false;
      pointHere("hotel.it");
      await reconcile(0);
      expect(await dom("hotel.it")).toMatchObject({ dnsStatus: "ok", certStatus: "none" });
      expect(await domainOps(siteId)).toHaveLength(0);
    });
  });
});
