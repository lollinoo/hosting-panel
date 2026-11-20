import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  deleteDnsProviderSettings,
  domains,
  eq,
  getDnsProviderSettingsPublic,
  upsertDnsProviderSettings,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
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
const DAY = 24 * 3600_000;
const MIN = 60_000;
const CLOUDFLARE = { provider: "cloudflare" as const, credentials: { CLOUDFLARE_DNS_API_TOKEN: "cf-token" } };

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("per-domain certificate challenge", () => {
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
  const at = (min: number) => new Date(t0.getTime() + min * MIN);
  const reconcile = async (min: number) => {
    await app.domainReconciler.reconcileOnce(at(min));
    await run();
  };
  const dom = async (h: string) => (await dbClient.db.select().from(domains).where(eq(domains.hostname, h)))[0]!;
  const pointHere = (h: string) => dnsAnswers.set(h, { a: ["10.0.0.1"], aaaa: [] });
  const plan = (siteId: string) => sim.appliedRoutes.get(siteId)!.hosts.map((h) => ({ ...h }));
  const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const plain = { hostname: "hotel.it", tls: false, httpsRedirect: false, redirectTo: null };
  const saveProvider = () =>
    upsertDnsProviderSettings(dbClient.db, KEY.toString("hex"), { ...CLOUDFLARE, actorId: null });
  const patch = async (siteId: string, challenge: unknown, as: string = adminToken) =>
    call("PATCH", `/v1/admin/sites/${siteId}/domains/${(await dom("hotel.it")).id}`, { challenge }, as);

  /** Runs `between` just before a challenge write made outside a transaction, as a concurrent request would. */
  function beforeUnlockedChallengeWrite(between: () => Promise<unknown>) {
    const db = dbClient.db as unknown as Json;
    const update = db.update.bind(db);
    db.update = (table: unknown) => {
      const builder = update(table);
      const set = builder.set.bind(builder);
      builder.set = (values: Json) => {
        const query = set(values);
        if (!("certChallenge" in values)) return query;
        const execute = query.execute.bind(query);
        query.execute = async (...args: unknown[]) => {
          await between();
          return execute(...args);
        };
        return query;
      };
      return builder;
    };
  }

  async function createAndRun(): Promise<string> {
    const res = await call("POST", org("/managed-sites"), SITE);
    expect(res.status).toBe(202);
    await run();
    return res.body.data.siteId as string;
  }

  /** A site whose hotel.it is set to dns-01, with the DNS resolver not yet in the proxy. */
  async function dnsSite(): Promise<string> {
    const siteId = await createAndRun();
    await saveProvider();
    expect((await patch(siteId, "dns-01")).status).toBe(200);
    return siteId;
  }

  /** A dns-01 order in flight, with no A record. */
  async function dnsRequested(): Promise<string> {
    const siteId = await dnsSite();
    await sim.applyDnsProvider(CLOUDFLARE);
    await reconcile(0);
    expect((await dom("hotel.it")).certStatus).toBe("requested");
    return siteId;
  }

  /** An http-01 order in flight that failed with `problem` at minute 0. */
  async function httpFailed(problem: "port_80_blocked" | "rate_limited"): Promise<string> {
    const siteId = await createAndRun();
    pointHere("hotel.it");
    await reconcile(0);
    expect((await dom("hotel.it")).certStatus).toBe("requested");
    sim.failCertificate("hotel.it", problem, at(0).toISOString());
    await reconcile(0);
    expect(await dom("hotel.it")).toMatchObject({ certStatus: "failed", certProblem: problem });
    await saveProvider();
    await sim.applyDnsProvider(CLOUDFLARE);
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
    // A minute ahead of the clock: rows the test creates are already due for a DNS check.
    t0 = new Date(Date.now() + MIN);
  });

  afterEach(async () => {
    await app.close();
    await dbClient.close();
  });

  it("admin sets dns-01 only when a DNS provider is saved (dns_provider_missing)", async () => {
    const siteId = await createAndRun();
    const refused = await patch(siteId, "dns-01");
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("VALIDATION_ERROR");
    expect(refused.body.error.details).toEqual([{ message: "Set up a DNS provider first.", reason: "dns_provider_missing" }]);
    expect((await dom("hotel.it")).certChallenge).toBe("http-01");
    expect((await patch(siteId, "tls-alpn-01")).status).toBe(400);

    await saveProvider();
    const ok = await patch(siteId, "dns-01");
    expect(ok.status).toBe(200);
    expect(ok.body.data.domains[0]).toMatchObject({ hostname: "hotel.it", challenge: "dns-01" });
    expect((await dom("hotel.it")).certChallenge).toBe("dns-01");

    const back = await patch(siteId, "http-01");
    expect(back.status).toBe(200);
    expect(back.body.data.domains[0].challenge).toBe("http-01");
  });

  it("customers see the challenge but have no PATCH route", async () => {
    const siteId = await dnsSite();
    const base = org(`/managed-sites/${siteId}/domains`);
    const list = await call("GET", base);
    expect(list.status).toBe(200);
    expect(list.body.data.domains[0].challenge).toBe("dns-01");
    const id = (await dom("hotel.it")).id;
    expect((await call("PATCH", `${base}/${id}`, { challenge: "http-01" })).status).toBe(404);
    expect((await patch(siteId, "http-01", token)).status).toBe(403);
    expect((await dom("hotel.it")).certChallenge).toBe("dns-01");
  });

  it("a dns-01 domain is ordered with no A record once the proxy has the DNS resolver, and its route carries challenge dns-01", async () => {
    const siteId = await dnsRequested();
    const d = await dom("hotel.it");
    expect(d).toMatchObject({ dnsStatus: "not_found", certStatus: "requested" });
    expect(d.certRequestedAt).toEqual(at(0));
    expect(plan(siteId)).toEqual([{ ...plain, tls: true, challenge: "dns-01" }]);
    const [audit] = await audits("site.certificate.requested");
    expect(audit!.details).toEqual({ hostname: "hotel.it", challenge: "dns-01" });
  });

  it("a dns-01 domain waits while the proxy has no DNS resolver", async () => {
    const siteId = await dnsSite();
    pointHere("hotel.it");
    await reconcile(0);
    await reconcile(1);
    expect(await dom("hotel.it")).toMatchObject({ dnsStatus: "ok", certStatus: "none" });
    expect(plan(siteId)).toEqual([plain]);

    await sim.applyDnsProvider(CLOUDFLARE);
    await reconcile(2);
    expect((await dom("hotel.it")).certStatus).toBe("requested");
    expect(plan(siteId)).toEqual([{ ...plain, tls: true, challenge: "dns-01" }]);
  });

  it("a fresh dns-01 request goes back to none when the DNS resolver disappears", async () => {
    const siteId = await dnsRequested();
    await sim.applyDnsProvider(null);
    await reconcile(1);
    expect((await dom("hotel.it")).certStatus).toBe("none");
    expect(plan(siteId)).toEqual([plain]);
  });

  it("switching a failed domain clears the failure but keeps the 15-minute gap", async () => {
    const siteId = await httpFailed("port_80_blocked");
    expect((await patch(siteId, "dns-01")).status).toBe(200);
    expect(await dom("hotel.it")).toMatchObject({
      certChallenge: "dns-01",
      certStatus: "none",
      certProblem: null,
      certRetryAt: null,
      certRequestedAt: at(0),
    });
    await reconcile(14);
    expect((await dom("hotel.it")).certStatus).toBe("none");
    await reconcile(15);
    expect(await dom("hotel.it")).toMatchObject({ certStatus: "requested", certRequestedAt: at(15) });
    expect(plan(siteId)).toEqual([{ ...plain, tls: true, challenge: "dns-01" }]);
  });

  it("a rate-limited domain stays failed after a switch", async () => {
    const siteId = await httpFailed("rate_limited");
    const retryAt = new Date(at(0).getTime() + DAY);
    expect((await dom("hotel.it")).certRetryAt).toEqual(retryAt);
    expect((await patch(siteId, "dns-01")).status).toBe(200);
    expect(await dom("hotel.it")).toMatchObject({
      certChallenge: "dns-01",
      certStatus: "failed",
      certProblem: "rate_limited",
      certRetryAt: retryAt,
    });
    await reconcile(30);
    expect((await dom("hotel.it")).certStatus).toBe("failed");
  });

  it("a dns_provider failure fails the request, schedules a retry and raises a not-issued admin alert", async () => {
    const siteId = await dnsRequested();
    sim.failCertificate("hotel.it", "dns_provider", at(1).toISOString());
    await reconcile(1);
    const d = await dom("hotel.it");
    expect(d).toMatchObject({ certStatus: "failed", certProblem: "dns_provider", certAttempts: 1 });
    expect(d.certRetryAt).toEqual(at(16));
    expect(plan(siteId)).toEqual([plain]);
    const [audit] = await audits("site.certificate.failed");
    expect(audit!.details).toEqual({ hostname: "hotel.it", problem: "dns_provider", detail: "simulated dns_provider", challenge: "dns-01" });
    const res = await call("GET", "/v1/admin/sites", undefined, adminToken);
    expect(res.body.data.certificateAlerts).toEqual([
      { kind: "not_issued", siteId, siteName: "Hotel Bella", hostname: "hotel.it", expiresAt: null, problem: "dns_provider" },
    ]);
  });

  it("the change is audited as admin.site.domain.challenge", async () => {
    const siteId = await dnsSite();
    const [audit] = await audits("admin.site.domain.challenge");
    expect(audit).toMatchObject({ targetType: "site", targetId: siteId });
    expect(audit!.details).toMatchObject({ hostnames: ["hotel.it"], challenge: "dns-01" });
  });

  it("a same-challenge PATCH writes nothing and is not audited", async () => {
    const siteId = await createAndRun();
    expect((await patch(siteId, "http-01")).status).toBe(200);
    expect(await audits("admin.site.domain.challenge")).toHaveLength(0);
  });

  it("a provider removed while dns-01 is being set never leaves a dns-01 domain without a provider", async () => {
    const siteId = await createAndRun();
    await saveProvider();
    beforeUnlockedChallengeWrite(() => deleteDnsProviderSettings(dbClient.db));
    const res = await patch(siteId, "dns-01");
    const provider = await getDnsProviderSettingsPublic(dbClient.db);
    if ((await dom("hotel.it")).certChallenge === "dns-01") expect(provider).not.toBeNull();
    else expect(res.status).toBe(400);
  });

  it("a certificate change between the read and the write does not drop the challenge", async () => {
    const siteId = await createAndRun();
    await saveProvider();
    beforeUnlockedChallengeWrite(() => dbClient.db.update(domains).set({ certStatus: "requested" }));
    const res = await patch(siteId, "dns-01");
    expect(res.status).toBe(200);
    expect(res.body.data.domains[0].challenge).toBe("dns-01");
    expect((await dom("hotel.it")).certChallenge).toBe("dns-01");
    expect(await audits("admin.site.domain.challenge")).toHaveLength(1);
  });
});
