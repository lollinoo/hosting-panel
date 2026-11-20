// QA for the per-domain certificate challenge: the cases domain-challenge.integration.test.ts does not cover.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SiteHostRoute } from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  domains,
  eq,
  sites,
  upsertDnsProviderSettings,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { routePlanHash } from "../src/sites/domain-policy.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

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
const MIN = 60_000;
const CLOUDFLARE = { provider: "cloudflare" as const, credentials: { CLOUDFLARE_DNS_API_TOKEN: "cf-token" } };
const plain = { hostname: "hotel.it", tls: false, httpsRedirect: false, redirectTo: null };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("per-domain challenge QA", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let token: string;
  let adminToken: string;
  let orgId: string;
  let t0: Date;
  const dnsAnswers = new Map<string, { a: string[]; aaaa: string[] }>();

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

  async function call(method: string, path: string, body?: unknown, as: string | null = token) {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: {
        ...(as ? { Authorization: `Bearer ${as}` } : {}),
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {} };
  }

  const org = (p: string) => `/v1/organizations/${orgId}${p}`;
  const run = () => app.outboxWorker.processPendingOnce();
  const at = (min: number) => new Date(t0.getTime() + min * MIN);
  const reconcile = async (min: number) => {
    await app.domainReconciler.reconcileOnce(at(min));
    await run();
  };
  const dom = async (h: string) => (await dbClient.db.select().from(domains).where(eq(domains.hostname, h)))[0]!;
  const pointHere = (h: string) => dnsAnswers.set(h, { a: ["10.0.0.1"], aaaa: [] });
  const plan = (siteId: string) => sim.appliedRoutes.get(siteId)!.hosts.map((h) => ({ ...h }));
  const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const saveProvider = () =>
    upsertDnsProviderSettings(dbClient.db, KEY.toString("hex"), { ...CLOUDFLARE, actorId: null });
  const patchId = (siteId: string, id: string, body: unknown, as: string | null = adminToken) =>
    call("PATCH", `/v1/admin/sites/${siteId}/domains/${id}`, body, as);
  const patch = async (siteId: string, challenge: unknown, host = "hotel.it") =>
    patchId(siteId, (await dom(host)).id, { challenge });

  async function createAndRun(): Promise<string> {
    const res = await call("POST", org("/managed-sites"), SITE);
    expect(res.status).toBe(202);
    await run();
    return res.body.data.siteId as string;
  }

  /** hotel.it on dns-01 with no A record, the order in flight and the proxy holding the DNS resolver. */
  async function dnsRequested(): Promise<string> {
    const siteId = await createAndRun();
    await saveProvider();
    await sim.applyDnsProvider(CLOUDFLARE);
    expect((await patch(siteId, "dns-01")).status).toBe(200);
    await reconcile(0);
    expect((await dom("hotel.it")).certStatus).toBe("requested");
    return siteId;
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter();
    dnsAnswers.clear();
    app = await createControlPlaneApp({
      dnsLookup: { lookup: async (h) => dnsAnswers.get(h) ?? { a: [], aaaa: [] } },
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
    adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
    const created = await call(
      "POST",
      "/v1/admin/customer-account",
      { organizationName: "Hotel Mario", ownerEmail: "mario@hotel.it", ownerName: "Mario" },
      adminToken,
    );
    expect(created.status).toBe(201);
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    orgId = created.body.data.organizationId as string;
    token = await login("mario@hotel.it", created.body.data.temporaryPassword as string);
    t0 = new Date(Date.now() + MIN);
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  it("switching back to http-01 with a wrong A record withdraws the order and never re-orders", async () => {
    const siteId = await dnsRequested();
    expect(plan(siteId)).toEqual([{ ...plain, tls: true, challenge: "dns-01" }]);
    dnsAnswers.set("hotel.it", { a: ["198.51.100.9"], aaaa: [] });

    expect((await patch(siteId, "http-01")).status).toBe(200);
    await reconcile(1);
    expect(await dom("hotel.it")).toMatchObject({ certChallenge: "http-01", dnsStatus: "points_elsewhere", certStatus: "none" });
    expect(plan(siteId)).toEqual([plain]);

    for (const min of [20, 40]) await reconcile(min);
    expect((await dom("hotel.it")).certStatus).toBe("none");
    expect(await audits("site.certificate.requested")).toHaveLength(1);
    expect(plan(siteId)).toEqual([plain]);
  });

  it("an order switched to http-01 is withdrawn on the stale DNS result, then re-ordered once the A record is seen and the 15-minute gap has passed", async () => {
    const siteId = await dnsRequested();
    pointHere("hotel.it"); // not looked up again yet: the stored result is still not_found
    expect((await patch(siteId, "http-01")).status).toBe(200);
    await reconcile(1);
    expect(await dom("hotel.it")).toMatchObject({ dnsStatus: "ok", certStatus: "none" });
    expect(plan(siteId)).toEqual([plain]);
    await reconcile(16);
    expect(await dom("hotel.it")).toMatchObject({ certStatus: "requested", certChallenge: "http-01" });
    expect(plan(siteId)).toEqual([{ ...plain, tls: true }]);
    expect("challenge" in plan(siteId)[0]!).toBe(false);
  });

  it("a dns-01 domain is ordered whatever the A record says (elsewhere, or IPv6 conflict)", async () => {
    const siteId = await createAndRun();
    await saveProvider();
    await sim.applyDnsProvider(CLOUDFLARE);
    dnsAnswers.set("hotel.it", { a: ["10.0.0.1"], aaaa: ["2001:db8::1"] });
    expect((await patch(siteId, "dns-01")).status).toBe(200);
    await reconcile(0);
    expect(await dom("hotel.it")).toMatchObject({ dnsStatus: "ipv6_conflict", certStatus: "requested" });
    expect(plan(siteId)).toEqual([{ ...plain, tls: true, challenge: "dns-01" }]);
  });

  it("with two hosts, only the dns-01 TLS host carries challenge in the route plan", async () => {
    const siteId = await createAndRun();
    expect((await call("POST", org(`/managed-sites/${siteId}/domains`), { hostname: "www.hotel.it" })).status).toBe(201);
    await saveProvider();
    await sim.applyDnsProvider(CLOUDFLARE);
    expect((await patch(siteId, "dns-01", "www.hotel.it")).status).toBe(200);
    pointHere("hotel.it"); // http-01 host with a right A record; www.hotel.it has none
    await reconcile(0);
    await reconcile(1);
    expect(await dom("hotel.it")).toMatchObject({ certChallenge: "http-01", certStatus: "requested" });
    expect(await dom("www.hotel.it")).toMatchObject({ certChallenge: "dns-01", certStatus: "requested" });
    const hosts = plan(siteId);
    expect(hosts).toEqual([
      { ...plain, tls: true },
      { hostname: "www.hotel.it", tls: true, httpsRedirect: false, redirectTo: "https://hotel.it", challenge: "dns-01" },
    ]);
    expect("challenge" in hosts[0]!).toBe(false);
  });

  it("an issued dns-01 certificate stays active when the DNS resolver disappears", async () => {
    await dnsRequested();
    const notAfter = new Date(at(0).getTime() + 80 * 24 * 3600_000).toISOString();
    sim.issueCertificate("hotel.it", notAfter);
    await reconcile(1);
    expect((await dom("hotel.it")).certStatus).toBe("active");
    await sim.applyDnsProvider(null);
    await reconcile(2);
    expect(await dom("hotel.it")).toMatchObject({ certStatus: "active", certChallenge: "dns-01", certProblem: null });
  });

  it("switching to the challenge a failed domain already has changes nothing", async () => {
    const siteId = await dnsRequested();
    sim.failCertificate("hotel.it", "dns_provider", at(1).toISOString());
    await reconcile(1);
    expect((await dom("hotel.it")).certStatus).toBe("failed");
    const before = await dom("hotel.it");
    expect((await patch(siteId, "dns-01")).status).toBe(200);
    expect(await dom("hotel.it")).toMatchObject({ certStatus: "failed", certProblem: "dns_provider", certRetryAt: before.certRetryAt });
  });

  it("a dns_provider failure is retried after the gap with the dns-01 mark, and shows in the admin alerts and health", async () => {
    const siteId = await dnsRequested();
    sim.failCertificate("hotel.it", "dns_provider", at(1).toISOString());
    await reconcile(1);
    const alerts = await call("GET", "/v1/admin/alerts", undefined, adminToken);
    expect(alerts.status).toBe(200);
    expect(alerts.body.data.filter((a: Json) => a.kind === "certificate_not_issued")).toMatchObject([
      { subject: "hotel.it", details: { siteId, siteName: "Hotel Bella", hostname: "hotel.it", problem: "dns_provider" } },
    ]);
    expect((await call("GET", "/v1/admin/health", undefined, adminToken)).status).toBe(200);

    await reconcile(15); // retry at minute 16
    expect((await dom("hotel.it")).certStatus).toBe("failed");
    await reconcile(16);
    expect(await dom("hotel.it")).toMatchObject({ certStatus: "requested", certChallenge: "dns-01" });
    expect(plan(siteId)).toEqual([{ ...plain, tls: true, challenge: "dns-01" }]);
    expect((await audits("site.certificate.requested")).map((a) => a.details)).toEqual([
      { hostname: "hotel.it", challenge: "dns-01" },
      { hostname: "hotel.it", challenge: "dns-01" },
    ]);
  });

  it("PATCH refuses a bad body, an unknown domain, another site's domain and a missing token", async () => {
    const siteId = await createAndRun();
    await saveProvider();
    const id = (await dom("hotel.it")).id;
    expect((await patchId(siteId, id, {})).status).toBe(400);
    expect((await patchId(siteId, id, { challenge: "DNS-01" })).status).toBe(400);
    expect((await patchId(siteId, id, { challenge: "dns-01", extra: 1 })).status).toBe(200);
    expect((await patchId(siteId, "dom_nope", { challenge: "dns-01" })).status).toBe(404);
    const other = await call("POST", "/v1/admin/sites", { ...SITE, name: "Albergo", domain: "albergo.it", ownerOrganizationId: null }, adminToken);
    expect(other.status).toBe(202);
    await run();
    expect((await patchId(other.body.data.siteId as string, id, { challenge: "http-01" })).status).toBe(404);
    expect((await dom("hotel.it")).certChallenge).toBe("dns-01");
    expect((await patchId(siteId, id, { challenge: "http-01" }, null)).status).toBe(401);
  });

  it("the customer DTO shows the default http-01 read-only, and no customer body can change it", async () => {
    const siteId = await createAndRun();
    const list = await call("GET", org(`/managed-sites/${siteId}/domains`));
    expect(list.body.data.domains[0].challenge).toBe("http-01");
    await saveProvider();
    const id = (await dom("hotel.it")).id;
    expect((await call("POST", org(`/managed-sites/${siteId}/domains`), { hostname: "hotel.it", challenge: "dns-01" })).status).toBeLessThan(500);
    expect((await call("POST", org(`/managed-sites/${siteId}/domains/${id}/primary`), { challenge: "dns-01" })).status).toBeLessThan(500);
    expect((await dom("hotel.it")).certChallenge).toBe("http-01");
  });

  it("the hash of a site with only http-01 hosts is the pinned one, saved provider or not", async () => {
    const pinned = JSON.parse(
      readFileSync(new URL("./fixtures/site-type-pins/route-hash.json", import.meta.url), "utf8"),
    ) as Record<string, { hashOf: { hosts: [string, boolean, boolean, string | null][]; wordpressUrl: string }; routePlanHash: string }>;
    for (const { hashOf, routePlanHash: expected } of Object.values(pinned)) {
      const hosts: SiteHostRoute[] = hashOf.hosts.map(([hostname, tls, httpsRedirect, redirectTo]) => ({ hostname, tls, httpsRedirect, redirectTo }));
      expect(routePlanHash(hosts, hashOf.wordpressUrl)).toBe(expected);
    }

    await saveProvider();
    await sim.applyDnsProvider(CLOUDFLARE);
    const siteId = await createAndRun();
    pointHere("hotel.it");
    await reconcile(0);
    await reconcile(1);
    expect((await dom("hotel.it")).certStatus).toBe("requested");
    const applied = plan(siteId);
    expect(applied).toEqual([{ ...plain, tls: true }]);
    const legacy = createHash("sha256")
      .update(JSON.stringify({ hosts: applied.map((h) => [h.hostname, h.tls, h.httpsRedirect, h.redirectTo]), wordpressUrl: "http://hotel.it" }))
      .digest("hex");
    const [row] = await dbClient.db.select({ hash: sites.appliedRoutesHash }).from(sites).where(eq(sites.id, siteId));
    expect(row!.hash).toBe(legacy);
  });
});
