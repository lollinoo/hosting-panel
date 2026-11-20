import { randomUUID } from "node:crypto";
import {
  auditEvents,
  createDatabaseClient,
  dnsProviderSettings,
  domains,
  eq,
  getDnsProviderSettings,
  hostingAdminScopes,
  membershipRoles,
  memberships,
  operationSteps,
  operations,
  outboxEvents,
  platformInstallations,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const SETUP = { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" };
const MARK = "QA-MARKER-9f3c1d7e";
const DNS = "/v1/admin/dns-provider";
const CLOUDFLARE = { provider: "cloudflare", credentials: { CLOUDFLARE_DNS_API_TOKEN: `${MARK}-cf` } } as const;
const OVH = {
  provider: "ovh",
  credentials: { OVH_ENDPOINT: "ovh-eu", OVH_APPLICATION_KEY: "ak", OVH_APPLICATION_SECRET: "as", OVH_CONSUMER_KEY: "ck" },
} as const;
const HTTPREQ = {
  provider: "httpreq",
  credentials: { HTTPREQ_ENDPOINT: "https://dns.example.test/acme", HTTPREQ_USERNAME: "u", HTTPREQ_PASSWORD: `${MARK}-pw` },
} as const;
const SITE = {
  name: "Hotel Bella",
  domain: "hotel.it",
  title: "Hotel Bella Vista",
  adminUser: "admin",
  adminEmail: "admin@hotel.it",
  adminPassword: "canary-Pass-123456",
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The refused fields as {field, message}: the zod path adds a `reason` key the service path does not. */
const fieldsOf = (res: { body: Json }): { field: string; message: string }[] =>
  (res.body.error.details as Json[]).map((d) => ({ field: d["field"], message: d["message"] }));

const coded = (code: string, message = `simulated ${code}`) => Object.assign(new Error(message), { code });

describe("DNS provider API (QA)", () => {
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let adminToken: string;
  let ownerToken: string;
  let orgId: string;

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
    as: string | null = adminToken,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Json; raw: string }> {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { ...(as ? { Authorization: `Bearer ${as}` } : {}), "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  }

  const audits = (action: string) => dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action));
  const storedRow = async () => (await dbClient.db.select().from(dnsProviderSettings))[0] ?? null;
  const storedCredentials = async () => (await getDnsProviderSettings(dbClient.db, KEY.toString("hex")))?.credentials ?? null;

  async function saveAndApply(body: unknown = CLOUDFLARE) {
    const res = await call("PATCH", DNS, body);
    expect(res.status).toBe(200);
    await app.dnsProvider.ensureApplied();
    return res;
  }

  /** A user with the given roles in the organisation, or a hosting_admin scope, logged in. */
  async function memberToken(email: string, roleIds: string[], hostingAdmin = false): Promise<string> {
    const userId = `usr_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: userId, email, name: email, passwordHash: await hashPassword(PW) });
    if (roleIds.length > 0) {
      const membershipId = `mem_${randomUUID()}`;
      await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: orgId, userId });
      for (const roleId of roleIds) {
        await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId });
      }
    }
    if (hostingAdmin) {
      const [installation] = await dbClient.db.select().from(platformInstallations);
      await dbClient.db.insert(hostingAdminScopes).values({ id: `has_${randomUUID()}`, userId, installationId: installation!.id });
    }
    return login(email, PW);
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
    ownerToken = await login("mario@hotel.it", created.body.data.temporaryPassword as string);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    await dbClient.close();
  });

  describe("credentials are write-only", () => {
    it("the marker is in no response, row, audit, outbox, operation or log, only encrypted in the settings row", async () => {
      const logs: string[] = [];
      for (const level of ["log", "info", "warn", "error", "debug"] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
      }
      for (const stream of [process.stdout, process.stderr]) {
        vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
          logs.push(String(chunk));
          return true;
        }) as never);
      }
      // An executor error that carries the credential in its message: only the code may be logged.
      const original = sim.applyDnsProvider.bind(sim);
      let failures = 1;
      sim.applyDnsProvider = async (req) => {
        if (failures-- > 0) throw coded("DOCKER_ENGINE_UNAVAILABLE", `engine refused ${MARK}-cf`);
        return original(req);
      };

      const responses = [await call("PATCH", DNS, CLOUDFLARE)];
      await app.dnsProvider.ensureApplied();
      responses.push(await call("GET", DNS));
      // Refused saves: the marker is the value that is refused, and must not come back in the details.
      responses.push(await call("PATCH", DNS, { provider: "ovh", credentials: { ...OVH.credentials, OVH_ENDPOINT: `${MARK}-ep` } }));
      responses.push(await call("PATCH", DNS, { provider: "hetzner", credentials: { HETZNER_API_TOKEN: ` ${MARK} ` } }));
      responses.push(await call("PATCH", DNS, { provider: "hetzner", credentials: { HETZNER_API_TOKEN: "t", OTHER_FIELD: MARK } }));
      responses.push(await call("PATCH", DNS, { provider: "httpreq", credentials: { HTTPREQ_ENDPOINT: `ftp://${MARK}` } }));
      responses.push(await call("PATCH", DNS, { provider: "cloudflare", credentials: { CLOUDFLARE_DNS_API_TOKEN: MARK.repeat(200) } }));
      responses.push(await call("PATCH", DNS, { provider: "cloudflare", credentials: { CLOUDFLARE_DNS_API_TOKEN: 5, OTHER: MARK } }));
      expect(responses.slice(2).map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400]);
      responses.push(await call("DELETE", DNS));
      await app.dnsProvider.ensureApplied();
      await saveAndApply(HTTPREQ);

      for (const r of responses) expect(r.raw, r.raw).not.toContain(MARK);
      const row = await storedRow();
      expect(row?.provider).toBe("httpreq");
      expect(JSON.stringify(row)).not.toContain(MARK);
      expect(JSON.stringify(row)).not.toContain(Buffer.from(MARK).toString("base64").slice(0, 16));
      expect(await storedCredentials()).toEqual(HTTPREQ.credentials);
      for (const table of [auditEvents, outboxEvents, operations, operationSteps]) {
        expect(JSON.stringify(await dbClient.db.select().from(table))).not.toContain(MARK);
      }
      expect(logs.join("\n")).not.toContain(MARK);
      expect(logs.some((l) => l.includes("dns_provider_apply_failed"))).toBe(true);
      // Even the credential names are the only thing the update audit keeps.
      expect((await audits("admin.dns_provider.update")).map((a) => a.details)).toEqual([
        { provider: "cloudflare", fieldsChanged: ["CLOUDFLARE_DNS_API_TOKEN"] },
        { provider: "httpreq", fieldsChanged: ["HTTPREQ_ENDPOINT", "HTTPREQ_PASSWORD", "HTTPREQ_USERNAME"] },
      ]);
    });

    it("a refused save audits nothing, stores nothing and applies nothing", async () => {
      for (const body of [
        { provider: "cloudflare", credentials: { CLOUDFLARE_DNS_API_TOKEN: ` ${MARK}` } },
        { provider: "nope", credentials: {} },
        { credentials: { CLOUDFLARE_DNS_API_TOKEN: "t" } },
        { provider: "cloudflare", credentials: ["t"] },
        { provider: "cloudflare", credentials: { CLOUDFLARE_DNS_API_TOKEN: 5 } },
      ]) {
        const res = await call("PATCH", DNS, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code).toBe("VALIDATION_ERROR");
      }
      const noBody = await call("PATCH", DNS);
      expect(noBody.status).toBe(400);
      expect(noBody.body.error.code).toBe("VALIDATION_ERROR");
      await app.dnsProvider.ensureApplied();
      expect(await storedRow()).toBeNull();
      expect(await audits("admin.dns_provider.update")).toHaveLength(0);
      expect(sim.dnsProvider).toBeNull();
    });
  });

  describe("merging stored values", () => {
    it("switching provider without every required field is refused and leaves the settings untouched", async () => {
      await saveAndApply(OVH);
      const before = await storedRow();
      const applies = sim.dnsProviderApplies;

      // The new provider is complete only through values the old one cannot supply.
      const res = await call("PATCH", DNS, { provider: "httpreq", credentials: { HTTPREQ_USERNAME: "u", HTTPREQ_PASSWORD: "p" } });
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([{ field: "credentials.HTTPREQ_ENDPOINT", message: "field_required" }]);
      const empty = await call("PATCH", DNS, { provider: "hetzner" });
      expect(empty.status).toBe(400);
      expect(empty.body.error.details).toEqual([{ field: "credentials.HETZNER_API_TOKEN", message: "field_required" }]);

      expect(await storedRow()).toEqual(before);
      expect(await storedCredentials()).toEqual(OVH.credentials);
      await app.dnsProvider.ensureApplied();
      expect(sim.dnsProviderApplies).toBe(applies);
      expect(sim.dnsProvider).toEqual(OVH);
      expect(await audits("admin.dns_provider.update")).toHaveLength(1);
      expect((await call("GET", DNS)).body.data).toMatchObject({ provider: "ovh", applied: true });
    });

    it("values of the old provider are not kept after a switch, even when it is switched back", async () => {
      await saveAndApply(OVH);
      await saveAndApply(CLOUDFLARE);
      expect(await storedCredentials()).toEqual(CLOUDFLARE.credentials);

      const back = await call("PATCH", DNS, { provider: "ovh", credentials: { OVH_CONSUMER_KEY: "ck2" } });
      expect(back.status).toBe(400);
      expect(back.body.error.details).toEqual([
        { field: "credentials.OVH_ENDPOINT", message: "field_required" },
        { field: "credentials.OVH_APPLICATION_KEY", message: "field_required" },
        { field: "credentials.OVH_APPLICATION_SECRET", message: "field_required" },
      ]);
      expect(await storedCredentials()).toEqual(CLOUDFLARE.credentials);

      const full = await saveAndApply({ provider: "ovh", credentials: { ...OVH.credentials, OVH_CONSUMER_KEY: "ck2" } });
      expect(full.body.data.fieldsSet).toEqual(["OVH_APPLICATION_KEY", "OVH_APPLICATION_SECRET", "OVH_CONSUMER_KEY", "OVH_ENDPOINT"]);
      expect(sim.dnsProvider).toEqual({ provider: "ovh", credentials: { ...OVH.credentials, OVH_CONSUMER_KEY: "ck2" } });
    });

    it("an empty credentials object with the same provider keeps every stored value", async () => {
      await saveAndApply(HTTPREQ);
      const res = await call("PATCH", DNS, { provider: "httpreq", credentials: {} });
      expect(res.status).toBe(200);
      expect(await storedCredentials()).toEqual(HTTPREQ.credentials);
    });
  });

  describe("provider rules over the API", () => {
    it("httpreq refuses a username without a password and a password without a username, and stores nothing", async () => {
      const onlyUser = await call("PATCH", DNS, {
        provider: "httpreq",
        credentials: { HTTPREQ_ENDPOINT: "https://dns.example.test/acme", HTTPREQ_USERNAME: "u" },
      });
      expect(onlyUser.status).toBe(400);
      expect(fieldsOf(onlyUser)).toEqual([{ field: "credentials.HTTPREQ_PASSWORD", message: "credentials_pair" }]);
      const onlyPass = await call("PATCH", DNS, {
        provider: "httpreq",
        credentials: { HTTPREQ_ENDPOINT: "https://dns.example.test/acme", HTTPREQ_PASSWORD: "p" },
      });
      expect(onlyPass.status).toBe(400);
      expect(fieldsOf(onlyPass)).toEqual([{ field: "credentials.HTTPREQ_USERNAME", message: "credentials_pair" }]);
      expect(await storedRow()).toBeNull();

      // The pair is judged on the stored set merged with the request: a half that leaves no partner is refused.
      await saveAndApply({ provider: "httpreq", credentials: { HTTPREQ_ENDPOINT: "https://dns.example.test/acme" } });
      const lonely = await call("PATCH", DNS, { provider: "httpreq", credentials: { HTTPREQ_PASSWORD: "p" } });
      expect(lonely.status).toBe(400);
      expect(fieldsOf(lonely)).toEqual([{ field: "credentials.HTTPREQ_USERNAME", message: "credentials_pair" }]);
      expect(await storedCredentials()).toEqual({ HTTPREQ_ENDPOINT: "https://dns.example.test/acme" });

      // A stored pair may be rotated one half at a time.
      await saveAndApply(HTTPREQ);
      const half = await call("PATCH", DNS, { provider: "httpreq", credentials: { HTTPREQ_PASSWORD: "p2" } });
      expect(half.status).toBe(200);
      expect(await storedCredentials()).toEqual({ ...HTTPREQ.credentials, HTTPREQ_PASSWORD: "p2" });
      const both = await call("PATCH", DNS, { provider: "httpreq", credentials: { HTTPREQ_USERNAME: "u2", HTTPREQ_PASSWORD: "p3" } });
      expect(both.status).toBe(200);
      expect(await storedCredentials()).toEqual({ ...HTTPREQ.credentials, HTTPREQ_USERNAME: "u2", HTTPREQ_PASSWORD: "p3" });
    });

    it("httpreq works without credentials: endpoint only", async () => {
      const res = await saveAndApply({ provider: "httpreq", credentials: { HTTPREQ_ENDPOINT: "http://10.0.0.1:8080" } });
      expect(res.body.data.fieldsSet).toEqual(["HTTPREQ_ENDPOINT"]);
      expect(sim.dnsProvider).toEqual({ provider: "httpreq", credentials: { HTTPREQ_ENDPOINT: "http://10.0.0.1:8080" } });
    });

    it("ovh refuses an endpoint outside ovh-eu, ovh-ca and ovh-us, also when the rest is kept from the store", async () => {
      for (const endpoint of ["ovh-xx", "OVH-EU", "kimsufi-eu", "ovh-eu ", "https://eu.api.ovh.com/1.0", ""]) {
        const res = await call("PATCH", DNS, { provider: "ovh", credentials: { ...OVH.credentials, OVH_ENDPOINT: endpoint } });
        expect(res.status, endpoint).toBe(400);
        expect(fieldsOf(res)).toEqual([{ field: "credentials.OVH_ENDPOINT", message: "ovh_endpoint_invalid" }]);
      }
      expect(await storedRow()).toBeNull();
      await saveAndApply(OVH);
      expect((await call("PATCH", DNS, { provider: "ovh", credentials: { OVH_ENDPOINT: "ovh-xx" } })).status).toBe(400);
      expect(await storedCredentials()).toEqual(OVH.credentials);
      for (const endpoint of ["ovh-ca", "ovh-us"]) {
        expect((await call("PATCH", DNS, { provider: "ovh", credentials: { OVH_ENDPOINT: endpoint } })).status).toBe(200);
        expect((await storedCredentials())?.["OVH_ENDPOINT"]).toBe(endpoint);
      }
    });

    it("a field of another provider or an arbitrary environment name is refused, whatever the provider", async () => {
      for (const field of ["HETZNER_API_TOKEN", "PATH", "LD_PRELOAD", "CF_DNS_API_TOKEN", "CLOUDFLARE_DNS_API_TOKEN_FILE", "cloudflare_dns_api_token"]) {
        const res = await call("PATCH", DNS, { provider: "cloudflare", credentials: { CLOUDFLARE_DNS_API_TOKEN: "t", [field]: "x" } });
        expect(res.status, field).toBe(400);
        expect(fieldsOf(res)).toContainEqual({ field: `credentials.${field}`, message: "field_unknown" });
      }
      expect(await storedRow()).toBeNull();
      expect(sim.dnsProviderApplies).toBe(0);
    });
  });

  describe("clear", () => {
    it("with no settings it answers 200 with the empty settings, twice, and leaves nothing behind", async () => {
      for (let i = 0; i < 2; i += 1) {
        const res = await call("DELETE", DNS);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ provider: null, fieldsSet: [], updatedAt: null, ready: null });
      }
      await app.dnsProvider.ensureApplied();
      expect(await storedRow()).toBeNull();
      expect(sim.dnsProvider).toBeNull();
    });

    it("while a dns-01 domain exists it is refused, the row and the applied provider stay, and it works after the domain is back on http-01", async () => {
      await saveAndApply();
      const site = await call("POST", `/v1/organizations/${orgId}/managed-sites`, SITE, ownerToken, { "Idempotency-Key": randomUUID() });
      expect(site.status).toBe(202);
      await app.outboxWorker.processPendingOnce();
      await dbClient.db.update(domains).set({ certChallenge: "dns-01" });
      const before = await storedRow();
      const applies = sim.dnsProviderApplies;

      const res = await call("DELETE", DNS);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(res.body.error.details).toEqual([{ message: "Switch every domain back to HTTP-01 first.", reason: "dns_challenge_in_use" }]);
      await app.dnsProvider.ensureApplied();
      expect(await storedRow()).toEqual(before);
      expect(sim.dnsProviderApplies).toBe(applies);
      expect(sim.dnsProvider).toEqual(CLOUDFLARE);

      await dbClient.db.update(domains).set({ certChallenge: "http-01" });
      expect((await call("DELETE", DNS)).status).toBe(200);
      await app.dnsProvider.ensureApplied();
      expect(await storedRow()).toBeNull();
      expect(sim.dnsProvider).toBeNull();
    });
  });

  describe("access", () => {
    it("a customer, a support user and an organisation admin get 403 on every verb, and nothing changes", async () => {
      await saveAndApply();
      const before = await storedRow();
      const applies = sim.dnsProviderApplies;
      const tokens = {
        "customer (collaborator)": await memberToken("collab@hotel.it", ["role_customer_collaborator"]),
        "support user (hosting_admin)": await memberToken("support@x.it", [], true),
        "support user as a member": await memberToken("support-member@x.it", ["role_hosting_admin"], true),
        "organisation admin (owner)": ownerToken,
      };
      for (const [who, as] of Object.entries(tokens)) {
        for (const [method, body] of [
          ["GET", undefined],
          ["PATCH", { provider: "cloudflare", credentials: { CLOUDFLARE_DNS_API_TOKEN: `${MARK}-other` } }],
          ["DELETE", undefined],
        ] as const) {
          const res = await call(method, DNS, body, as);
          expect(res.status, `${who} ${method}`).toBe(403);
          expect(res.body.error.code).toBe("PERMISSION_DENIED");
          expect(res.raw).not.toContain("CLOUDFLARE_DNS_API_TOKEN");
        }
      }
      await app.dnsProvider.ensureApplied();
      expect(await storedRow()).toEqual(before);
      expect(sim.dnsProviderApplies).toBe(applies);
      expect(await audits("admin.dns_provider.update")).toHaveLength(1);
      expect(await audits("admin.dns_provider.clear")).toHaveLength(0);
    });

    it("no token and a bad token get 401 on every verb", async () => {
      for (const as of [null, "not-a-token"]) {
        for (const method of ["GET", "PATCH", "DELETE"]) {
          expect((await call(method, DNS, method === "PATCH" ? CLOUDFLARE : undefined, as)).status, `${as} ${method}`).toBe(401);
        }
      }
      expect(await storedRow()).toBeNull();
    });
  });

  describe("background apply", () => {
    it("one save is applied once, with exactly the stored credentials, and later ticks do not repeat it", async () => {
      await call("PATCH", DNS, OVH);
      await app.dnsProvider.ensureApplied();
      await app.dnsProvider.ensureApplied();
      await app.dnsProvider.ensureApplied();
      expect(sim.dnsProviderApplies).toBe(1);
      expect(sim.dnsProvider).toEqual({ provider: "ovh", credentials: await storedCredentials() });
      expect(Object.keys(sim.dnsProvider!)).toEqual(["provider", "credentials"]);
    });

    it("a second identical save does not apply again", async () => {
      await saveAndApply();
      expect(sim.dnsProviderApplies).toBe(1);
      await saveAndApply();
      await app.dnsProvider.ensureApplied();
      expect(sim.dnsProviderApplies).toBe(1);
      expect((await call("GET", DNS)).body.data.applied).toBe(true);
    });

    it("two saves in a row end with the last credentials applied", async () => {
      await call("PATCH", DNS, CLOUDFLARE);
      await call("PATCH", DNS, { provider: "hetzner", credentials: { HETZNER_API_TOKEN: "second" } });
      await app.dnsProvider.ensureApplied();
      expect(sim.dnsProvider).toEqual({ provider: "hetzner", credentials: { HETZNER_API_TOKEN: "second" } });
      expect((await call("GET", DNS)).body.data).toMatchObject({ provider: "hetzner", applied: true });
    });

    it("a failing executor leaves applied false and a later tick applies the stored credentials once", async () => {
      const original = sim.applyDnsProvider.bind(sim);
      let calls = 0;
      sim.applyDnsProvider = async (req) => {
        calls += 1;
        if (calls <= 2) throw coded("DOCKER_ENGINE_UNAVAILABLE");
        return original(req);
      };
      const saved = await call("PATCH", DNS, CLOUDFLARE);
      expect(saved.status).toBe(200);
      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(1));
      expect((await call("GET", DNS)).body.data.applied).toBe(false);

      await app.dnsProvider.ensureApplied(); // a tick: fails again, still not applied
      expect(calls).toBe(2);
      expect((await call("GET", DNS)).body.data.applied).toBe(false);
      expect(sim.dnsProviderApplies).toBe(0);

      await app.dnsProvider.ensureApplied(); // the next tick: lands
      expect(sim.dnsProviderApplies).toBe(1);
      expect(sim.dnsProvider).toEqual(CLOUDFLARE);
      expect((await call("GET", DNS)).body.data.applied).toBe(true);
      await app.dnsProvider.ensureApplied();
      expect(sim.dnsProviderApplies).toBe(1);
    });

    it("a failed clear apply is retried and ends with the executor holding nothing", async () => {
      await saveAndApply();
      sim.failNextDnsProviderApply();
      expect((await call("DELETE", DNS)).status).toBe(200);
      await app.dnsProvider.ensureApplied(); // the failed one may have been consumed by the save's own apply
      await app.dnsProvider.ensureApplied();
      expect(sim.dnsProvider).toBeNull();
      expect((await call("GET", DNS)).body.data).toMatchObject({ provider: null, applied: true });
    });
  });
});
