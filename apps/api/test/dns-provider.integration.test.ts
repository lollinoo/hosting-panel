import { randomUUID } from "node:crypto";
import type { DnsProviderApplyRequest } from "@hosting-panel/contracts";
import {
  auditEvents,
  createDatabaseClient,
  domains,
  eq,
  outboxEvents,
  upsertDnsProviderSettings,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const CANARY = "canary-DNS:tok 1";
const CLOUDFLARE = { provider: "cloudflare", credentials: { CLOUDFLARE_DNS_API_TOKEN: CANARY } } as const;
const OVH = {
  provider: "ovh",
  credentials: { OVH_ENDPOINT: "ovh-eu", OVH_APPLICATION_KEY: "ak", OVH_APPLICATION_SECRET: "as", OVH_CONSUMER_KEY: "ck" },
} as const;
const SITE = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
  adminPassword: "canary-Pass-123456",
};
const DNS = "/v1/admin/dns-provider";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const coded = (code: string) => Object.assign(new Error(`simulated ${code}`), { code });

describe("DNS provider API", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let token: string;
  let adminToken: string;
  let orgId: string;
  const extraApps: ControlPlaneAppHandle[] = [];

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

  async function call(
    method: string,
    path: string,
    body?: unknown,
    as: string = adminToken,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Json; raw: string }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${as}`, "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));

  async function saveAndApply(body: unknown = CLOUDFLARE) {
    const res = await call("PATCH", DNS, body);
    expect(res.status).toBe(200);
    await app.dnsProvider.ensureApplied();
    return res;
  }

  /** Records every apply, and fails the first `failures` of them as an executor that is down. */
  function recordApplies(executor: InMemoryDockerSimulatorAdapter, failures = 0): (DnsProviderApplyRequest | null)[] {
    const seen: (DnsProviderApplyRequest | null)[] = [];
    const original = executor.applyDnsProvider.bind(executor);
    executor.applyDnsProvider = async (req) => {
      if (failures > 0) {
        failures -= 1;
        throw coded("DOCKER_ENGINE_UNAVAILABLE");
      }
      seen.push(req);
      return original(req);
    };
    return seen;
  }

  async function bootApp(executor: InMemoryDockerSimulatorAdapter): Promise<ControlPlaneAppHandle> {
    const booted = await createControlPlaneApp({
      listen: false,
      databaseClient: dbClient,
      secretsMasterKey: KEY,
      runtimeBackend: "local-simulator",
      dockerExecutor: executor,
      autoProcessOutbox: false,
      outboxPollIntervalMs: null,
      driftReconcileIntervalMs: null,
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: 20,
      recoverUnknownOnStart: false,
    });
    extraApps.push(booted);
    return booted;
  }

  beforeEach(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter();
    app = await createControlPlaneApp({
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
      domainReconcileIntervalMs: null,
      mailRelayRetryIntervalMs: null,
      recoverUnknownOnStart: false,
    });
    adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
    const created = await call("POST", "/v1/admin/customer-account", {
      organizationName: "Hotel Mario",
      ownerEmail: "mario@hotel.it",
      ownerName: "Mario",
    });
    expect(created.status).toBe(201);
    orgId = created.body.data.organizationId as string;
    await skipPasswordChange(dbClient.db, "mario@hotel.it");
    token = await login("mario@hotel.it", created.body.data.temporaryPassword as string);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const extra of extraApps.splice(0)) await extra.close();
    await app.close();
    await dbClient.close();
  });

  it("admin saves a provider and it is applied", async () => {
    const res = await call("PATCH", DNS, CLOUDFLARE);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      provider: "cloudflare",
      fieldsSet: ["CLOUDFLARE_DNS_API_TOKEN"],
      applied: false,
      ready: null,
    });
    expect(typeof res.body.data.updatedAt).toBe("string");

    await app.dnsProvider.ensureApplied();
    expect(sim.dnsProvider).toEqual(CLOUDFLARE);
    const got = await call("GET", DNS);
    expect(got.status).toBe(200);
    expect(got.body.data).toMatchObject({ provider: "cloudflare", applied: true, ready: true });

    const [audit] = await audits("admin.dns_provider.update");
    expect(audit).toMatchObject({ targetType: "dns_provider", targetId: null });
    expect(audit?.details).toEqual({ provider: "cloudflare", fieldsChanged: ["CLOUDFLARE_DNS_API_TOKEN"] });
  });

  it("save answers before the apply finishes", async () => {
    const original = sim.applyDnsProvider.bind(sim);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    sim.applyDnsProvider = async (req) => {
      await gate;
      return original(req);
    };
    const res = await call("PATCH", DNS, CLOUDFLARE);
    expect(res.status).toBe(200);
    expect(res.body.data.applied).toBe(false);
    const got = await call("GET", DNS);
    expect(got.body.data).toMatchObject({ applied: false, ready: false });
    expect(sim.dnsProviderApplies).toBe(0);

    release();
    await app.dnsProvider.ensureApplied();
    expect((await call("GET", DNS)).body.data).toMatchObject({ applied: true, ready: true });
  });

  it("credentials never leave the API in a response, audit row, outbox row or log", async () => {
    const logs: unknown[][] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args));
    }
    const saved = await saveAndApply();
    const got = await call("GET", DNS);

    recordApplies(sim, 2); // the save's own apply, then the one awaited here
    const failed = await call("PATCH", DNS, { provider: "cloudflare", credentials: { CLOUDFLARE_DNS_API_TOKEN: `${CANARY}-2` } });
    await app.dnsProvider.ensureApplied();
    expect((await call("GET", DNS)).body.data.applied).toBe(false);
    const cleared = await call("DELETE", DNS);

    for (const r of [saved, got, failed, cleared]) expect(r.raw).not.toContain(CANARY);
    expect(JSON.stringify(await dbClient.db.select().from(auditEvents))).not.toContain(CANARY);
    expect(JSON.stringify(await dbClient.db.select().from(outboxEvents))).not.toContain(CANARY);
    const logged = logs.map((args) => args.map(String).join(" "));
    expect(logged.join("\n")).not.toContain(CANARY);
    expect(logged.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Json)).toContainEqual({
      event: "dns_provider_apply_failed",
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
  });

  it("a field left out keeps the stored value while the provider is unchanged", async () => {
    await saveAndApply(OVH);
    const res = await saveAndApply({ provider: "ovh", credentials: { OVH_CONSUMER_KEY: "ck2" } });
    expect(res.body.data.fieldsSet).toEqual(["OVH_APPLICATION_KEY", "OVH_APPLICATION_SECRET", "OVH_CONSUMER_KEY", "OVH_ENDPOINT"]);
    expect(sim.dnsProvider).toEqual({ provider: "ovh", credentials: { ...OVH.credentials, OVH_CONSUMER_KEY: "ck2" } });
    const updates = await audits("admin.dns_provider.update");
    expect(updates.map((a) => (a.details as Json)["fieldsChanged"])).toContainEqual(["OVH_CONSUMER_KEY"]);
  });

  it("an identical save is not applied again, a changed one is", async () => {
    await saveAndApply(OVH);
    await saveAndApply(OVH);
    await saveAndApply({ provider: "ovh", credentials: {} });
    expect(sim.dnsProviderApplies).toBe(1);
    expect((await call("GET", DNS)).body.data.applied).toBe(true);
    await saveAndApply({ provider: "ovh", credentials: { OVH_CONSUMER_KEY: "ck2" } });
    expect(sim.dnsProviderApplies).toBe(2);
  });

  it("httpreq rotates one half of a stored pair, and an unpaired merged set is refused with credentials_pair", async () => {
    const endpoint = { HTTPREQ_ENDPOINT: "https://dns.example.test/acme" };
    const half = await call("PATCH", DNS, { provider: "httpreq", credentials: { ...endpoint, HTTPREQ_USERNAME: "u" } });
    expect(half.status).toBe(400);
    expect(half.body.error.code).toBe("VALIDATION_ERROR");
    expect(half.body.error.details).toEqual([{ field: "credentials.HTTPREQ_PASSWORD", message: "credentials_pair" }]);

    await saveAndApply({ provider: "httpreq", credentials: { ...endpoint, HTTPREQ_USERNAME: "u", HTTPREQ_PASSWORD: "p" } });
    const rotated = await saveAndApply({ provider: "httpreq", credentials: { HTTPREQ_PASSWORD: "p2" } });
    expect(rotated.body.data.fieldsSet).toEqual(["HTTPREQ_ENDPOINT", "HTTPREQ_PASSWORD", "HTTPREQ_USERNAME"]);
    expect(sim.dnsProvider).toEqual({ provider: "httpreq", credentials: { ...endpoint, HTTPREQ_USERNAME: "u", HTTPREQ_PASSWORD: "p2" } });
  });

  it("changing the provider requires its required fields (field_required on credentials.<NAME>)", async () => {
    await saveAndApply(CLOUDFLARE);
    const res = await call("PATCH", DNS, { provider: "ovh", credentials: { OVH_ENDPOINT: "ovh-eu" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toBe("field_required");
    expect(res.body.error.details).toEqual([
      { field: "credentials.OVH_APPLICATION_KEY", message: "field_required" },
      { field: "credentials.OVH_APPLICATION_SECRET", message: "field_required" },
      { field: "credentials.OVH_CONSUMER_KEY", message: "field_required" },
    ]);
    expect(sim.dnsProvider).toEqual(CLOUDFLARE);

    const first = await call("DELETE", DNS);
    expect(first.status).toBe(200);
    const empty = await call("PATCH", DNS, { provider: "cloudflare" });
    expect(empty.status).toBe(400);
    expect(empty.body.error.details).toEqual([{ field: "credentials.CLOUDFLARE_DNS_API_TOKEN", message: "field_required" }]);
  });

  it("an unknown field is refused with field_unknown", async () => {
    const res = await call("PATCH", DNS, { provider: "cloudflare", credentials: { CLOUDFLARE_DNS_API_TOKEN: "t", PATH: "/x" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details).toContainEqual(expect.objectContaining({ field: "credentials.PATH", message: "field_unknown" }));
    expect(sim.dnsProviderApplies).toBe(0);
  });

  it("boot applies stored settings and retries until the executor answers", async () => {
    await upsertDnsProviderSettings(dbClient.db, KEY.toString("hex"), { ...CLOUDFLARE, credentials: { ...CLOUDFLARE.credentials }, actorId: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fresh = new InMemoryDockerSimulatorAdapter();
    const applies = recordApplies(fresh, 2);
    const booted = await bootApp(fresh);
    const tick = async () => {
      await vi.advanceTimersByTimeAsync(20);
      await booted.dnsProvider.idle();
    };

    await booted.dnsProvider.idle(); // tick 1, at boot: fails
    expect(applies).toEqual([]);
    await tick(); // tick 2: fails
    expect(applies).toEqual([]);
    await tick(); // tick 3: applied
    const failures = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes("dns_provider_apply_failed"))
      .map((l) => JSON.parse(l) as Json);
    expect(failures).toEqual([
      { event: "dns_provider_apply_failed", code: "DOCKER_ENGINE_UNAVAILABLE" },
      { event: "dns_provider_apply_failed", code: "DOCKER_ENGINE_UNAVAILABLE" },
    ]);
    expect(applies).toEqual([CLOUDFLARE]);
    for (let i = 4; i <= 9; i += 1) await tick();
    expect(applies).toHaveLength(1);
    await tick(); // tick 10: forced
    expect(applies).toEqual([CLOUDFLARE, CLOUDFLARE]);
  });

  it("boot with no settings applies null", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fresh = new InMemoryDockerSimulatorAdapter();
    fresh.dnsProvider = { ...CLOUDFLARE, credentials: { CLOUDFLARE_DNS_API_TOKEN: "leftover" } };
    const applies = recordApplies(fresh);
    const booted = await bootApp(fresh);
    await booted.dnsProvider.idle();
    expect(applies).toEqual([null]);
    expect(fresh.dnsProvider).toBeNull();
    await vi.advanceTimersByTimeAsync(20);
    await booted.dnsProvider.idle();
    expect(applies).toEqual([null]);
  });

  it("GET answers with ready null when the executor is down", async () => {
    await saveAndApply();
    sim.getCertificateStatus = () => Promise.reject(coded("DOCKER_ENGINE_UNAVAILABLE"));
    const got = await call("GET", DNS);
    expect(got.status).toBe(200);
    expect(got.body.data).toMatchObject({ provider: "cloudflare", applied: true, ready: null });
  });

  it("clear is refused with dns_challenge_in_use while a dns-01 domain exists", async () => {
    await saveAndApply();
    const site = await call("POST", `/v1/organizations/${orgId}/managed-sites`, SITE, token, { "Idempotency-Key": randomUUID() });
    expect(site.status).toBe(202);
    await app.outboxWorker.processPendingOnce();
    await dbClient.db.update(domains).set({ certChallenge: "dns-01" });

    const res = await call("DELETE", DNS);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details).toEqual([
      { message: "Switch every domain back to HTTP-01 first.", reason: "dns_challenge_in_use" },
    ]);
    expect((await call("GET", DNS)).body.data.provider).toBe("cloudflare");
    expect(await audits("admin.dns_provider.clear")).toHaveLength(0);
  });

  it("clear removes the settings and applies null", async () => {
    await saveAndApply();
    const res = await call("DELETE", DNS);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ provider: null, fieldsSet: [], updatedAt: null, applied: false });
    await app.dnsProvider.ensureApplied();
    expect(sim.dnsProvider).toBeNull();
    expect(await audits("admin.dns_provider.clear")).toHaveLength(1);
    expect((await call("GET", DNS)).body.data).toMatchObject({ provider: null, applied: true, ready: false });
  });

  it("only server administrators reach the routes (customer gets 403 on every verb, no applies)", async () => {
    for (const [method, body] of [
      ["GET", undefined],
      ["PATCH", CLOUDFLARE],
      ["DELETE", undefined],
    ] as const) {
      expect((await call(method, DNS, body, token)).status).toBe(403);
    }
    expect(sim.dnsProviderApplies).toBe(0);
    expect(await audits("admin.dns_provider.update")).toHaveLength(0);
  });
});
