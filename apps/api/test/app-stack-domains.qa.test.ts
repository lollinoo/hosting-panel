// Q6 · B3: a hostname added to or removed from a running application, and an ACME state change, rewrite only that
// application's route file app_<stackId>.yml on the simulator. The proxy is never recreated, the WordPress site file
// and the panel file stay byte for byte the same, one system route refresh runs per change and none on the next pass.
// Also: the global collision site <-> application both ways, another organisation's manual wildcard, and the ACME audit
// rows that share the site throttle. The simulator writes real route files into a temporary ingress directory.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST } from "@hosting-panel/contracts";
import {
  appStackDeployments,
  appStackDomains,
  appStacks,
  auditEvents,
  createDatabaseClient,
  domains,
  eq,
  hostAllocations,
  hosts,
  membershipRoles,
  memberships,
  operations,
  organizations,
  outboxEvents,
  platformInstallations,
  resourceQuotas,
  tlsCertificates,
  tlsCertificateVersions,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { InMemoryHostSimulatorAdapter } from "@hosting-panel/host-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppStackObserverService } from "../src/app-stacks/app-stack-observer.service.js";
import { hashPassword } from "../src/auth/password.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { APP_TEST_ALLOWLIST } from "./fixtures/app-stack-harness.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const KEY = Buffer.alloc(32, 7);
const PW = "domains-login-pass-0001";
const HOST_IPV4 = "192.0.2.10";
const SETUP = { installationName: "Domains", hostHostname: "panel.example.test", hostIpv4: HOST_IPV4 };
const CONFLICT =
  "This web address is already used by another site or by the panel. Remove it from the other site first, or ask your administrator.";
const SITE = {
  name: "Site A",
  domain: "wp-a.example.test",
  includeWww: false,
  phpVersion: "8.3",
  title: "Site A",
  adminUser: "siteadmin",
  adminEmail: "admin@example.test",
  adminPassword: "domains-Admin-Pass-0001",
};
const T0 = Date.now();
/** A pass time `minutes` after the start of the test. Always after the real "now" of the API's own reconcile. */
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const WEB = { componentKey: "web", port: 8080 };

describe("B3: application web addresses touch only the application's own route file", () => {
  let tmp: string;
  let dynamicDir: string;
  let dbClient: DatabaseClient;
  let app: ControlPlaneAppHandle;
  let sim: InMemoryDockerSimulatorAdapter;
  let observer: AppStackObserverService;
  let calls: string[];
  /** Every route request the API sent to the executor, as sent. */
  let routeRequests: { plan: { stackId: string; revisionId: string }; routes: Json[] }[];
  let orgId: string;
  let ownerToken: string;
  let adminToken: string;
  let stackId: string;
  let siteId: string;
  let otherOrgId: string;
  let otherToken: string;
  let otherStackId: string;
  let lookup: Map<string, string[]>;

  async function call(method: string, p: string, body?: unknown, token?: string) {
    const res = await fetch(`${app.baseUrl!}${p}`, {
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
  const owner = (method: string, p: string, body?: unknown) => call(method, p, body, ownerToken);
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

  /** Every file of the ingress dynamic directory: name -> exact text. */
  async function files(): Promise<Map<string, string>> {
    const entries = (await readdir(dynamicDir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
    return new Map(await Promise.all(entries.sort().map(async (n) => [n, await readFile(path.join(dynamicDir, n), "utf8")] as const)));
  }
  const appFileName = () => `app_${stackId}.yml`;
  const others = (all: Map<string, string>) => new Map([...all].filter(([n]) => n !== appFileName()));
  const siteFileNames = (all: Map<string, string>) => [...all.keys()].filter((n) => /^site_.+\.yml$/.test(n));

  const base = (id = stackId) => `/v1/organizations/${orgId}/app-stacks/${id}/domains`;
  const addHost = (hostname: string, id = stackId) => owner("POST", base(id), { hostname, ...WEB });
  const stackRow = async () => (await dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const domainRows = () => dbClient.db.select().from(appStackDomains).where(eq(appStackDomains.stackId, stackId));
  const rowOf = async (hostname: string) => (await domainRows()).find((r) => r.hostname === hostname)!;
  const audits = async (action: string, hostname?: string) =>
    (await dbClient.db.select().from(auditEvents).where(eq(auditEvents.action, action))).filter(
      (a) => hostname === undefined || (a.details as Json).hostname === hostname,
    );
  /** System route refreshes of the stack: stack.deploy operations queued by the observer. */
  const refreshCount = async () =>
    (await dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId))).filter(
      (o) => o.kind === "stack.deploy" && (o.idempotencyKey ?? "").startsWith("sys_routes_") && o.requestedByUserId === null,
    ).length;
  const publishCount = () => calls.filter((c) => c === "publishAppStackRoutes").length;

  /** One observer pass at `minutes`, then the outbox: what the 60 s loop and the worker do. */
  async function pass(minutes: number): Promise<void> {
    await observer.reconcileOnce(at(minutes));
    await drain();
  }

  /** The change: run `act`, one pass, outbox; measure what moved. */
  async function change(act: () => Promise<unknown>, minutes: number) {
    const filesBefore = await files();
    const refreshesBefore = await refreshCount();
    const publishesBefore = publishCount();
    const callsFrom = calls.length;
    await act();
    await pass(minutes);
    const filesAfter = await files();
    return {
      filesBefore,
      filesAfter,
      refreshes: (await refreshCount()) - refreshesBefore,
      publishes: publishCount() - publishesBefore,
      methods: new Set(calls.slice(callsFrom)),
    };
  }

  /** What no application route change may ask the executor for: the proxy, the site or the panel. */
  function expectOnlyApplicationRequests(methods: ReadonlySet<string>): void {
    const foreign = [...methods].filter((m) => !/AppStack/.test(m) && m !== "getCertificateStatus");
    expect(foreign, "requests that are not application requests").toEqual([]);
  }

  /** A refused name leaves no trace: the site and panel files are the same, and no route file names it. */
  async function expectNoTrace(before: Map<string, string>, hostname: string | null): Promise<void> {
    const after = await files();
    const nonApp = (m: Map<string, string>) => new Map([...m].filter(([n]) => !n.startsWith("app_")));
    expect(nonApp(after)).toEqual(nonApp(before));
    if (hostname === null) return;
    // Only application files: a site or panel hostname is legitimately in its own file.
    for (const [name, text] of after) if (name.startsWith("app_")) expect(text.toLowerCase(), name).not.toContain(hostname.toLowerCase());
  }

  function expectSiteAndPanelUntouched(r: { filesBefore: Map<string, string>; filesAfter: Map<string, string> }): void {
    expect(others(r.filesAfter)).toEqual(others(r.filesBefore));
  }

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "hp-b3-"));
    dynamicDir = path.join(tmp, "ingress", "dynamic");
    calls = [];
    routeRequests = [];
    lookup = new Map();
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await setupInstallation(dbClient.db, SETUP);
    const admin = await createServerAdmin(dbClient.db, KEY, { email: "admin@example.test", name: "Admin", password: PW });
    sim = new InMemoryDockerSimulatorAdapter({
      ingressRootDir: path.join(tmp, "ingress"),
      panel: {
        hostname: "panel.example.test",
        ipv4: HOST_IPV4,
        acmeEmail: null,
        acmeStaging: false,
        acmeCaServer: null,
        acmeCaCertFile: null,
        upstreamPort: 3000,
      },
    });
    sim.acmeEnabled = false;
    const recorder = new Proxy(sim, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (typeof v !== "function" || typeof prop !== "string") return v;
        return (...args: unknown[]) => {
          calls.push(prop);
          if (prop === "publishAppStackRoutes") routeRequests.push(structuredClone(args[0]) as (typeof routeRequests)[number]);
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
      dnsLookup: { lookup: async (host: string) => ({ a: lookup.get(host) ?? [], aaaa: [] }) },
      appFeatures: { applicationTemplatesAvailable: true, applicationStacksAvailable: true },
      appTemplateValidation: { allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] },
    });
    observer = app.nestApp.get(AppStackObserverService);

    adminToken = await login("admin@example.test", PW, admin.totpSecretBase32);
    const created = await call("POST", "/v1/admin/customer-account", { organizationName: "Org A", ownerEmail: "owner-a@example.test", ownerName: "Org A" }, adminToken);
    expect(created.status, created.raw).toBe(201);
    await skipPasswordChange(dbClient.db, "owner-a@example.test");
    orgId = created.body.data.organizationId as string;
    await dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, orgId));
    ownerToken = await login("owner-a@example.test", created.body.data.temporaryPassword as string);

    // A dedicated host takes one customer: organisation B gets a host of its own.
    const [inst] = await dbClient.db.select().from(platformInstallations).limit(1);
    const hostId = `hst_${randomUUID()}`;
    await dbClient.db.insert(hosts).values({
      id: hostId,
      platformInstallationId: inst!.id,
      name: "host-b.test",
      hostname: "host-b.test",
      ipv4Address: "10.0.0.32",
      hostingMode: "dedicated",
      totalCpuMilli: 4000,
      totalMemoryBytes: "8589934592",
      totalStorageBytes: "107374182400",
    });
    otherOrgId = `org_${randomUUID()}`;
    await dbClient.db.insert(organizations).values({ id: otherOrgId, platformInstallationId: inst!.id, name: "Org B", slug: "org-b" });
    const allocId = `alloc_${randomUUID()}`;
    await dbClient.db.insert(hostAllocations).values({ id: allocId, hostId, organizationId: otherOrgId, status: "active", hostingMode: "dedicated", dedicatedScope: true });
    await dbClient.db.insert(resourceQuotas).values({
      id: `rq_${randomUUID()}`,
      organizationId: otherOrgId,
      hostAllocationId: allocId,
      maxSites: 10,
      maxServices: 1000,
      maxCpuMilli: 1_000_000,
      maxMemoryBytes: String(2 ** 50),
      maxStorageBytes: String(2 ** 50),
    });
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mem_${randomUUID()}`;
    await dbClient.db.insert(users).values({ id: userId, email: "owner-b@example.test", name: "Owner B", passwordHash: await hashPassword(PW) });
    await dbClient.db.insert(memberships).values({ id: membershipId, organizationId: otherOrgId, userId });
    await dbClient.db.insert(membershipRoles).values({ id: `mrl_${randomUUID()}`, membershipId, roleId: "role_customer_owner" });
    otherToken = await login("owner-b@example.test", PW);

    const tpl = await call("POST", "/v1/admin/app-templates", { slug: `web-${randomUUID().slice(0, 8)}`, source: APP_BUILT_IN_TEMPLATES[0]!.source }, adminToken);
    expect(tpl.status, tpl.raw).toBe(201);
    const on = await call("PATCH", `/v1/admin/app-templates/${tpl.body.data.id as string}`, { enabled: true }, adminToken);
    expect(on.status, on.raw).toBe(200);
    const versionId = tpl.body.data.defaultVersionId as string;

    async function runningStack(org: string, token: string, name: string): Promise<string> {
      const dep = await call("POST", `/v1/organizations/${org}/app-stacks`, { templateVersionId: versionId, name, deploy: true }, token);
      expect(dep.status, dep.raw).toBe(202);
      const id = dep.body.data.stackId as string;
      for (let i = 0; i < 10; i++) {
        await drain();
        const row = await call("GET", `/v1/organizations/${org}/app-stacks/${id}`, undefined, token);
        if (row.body.data?.status === "running") break;
      }
      const row = await call("GET", `/v1/organizations/${org}/app-stacks/${id}`, undefined, token);
      expect(row.body.data.status, row.raw).toBe("running");
      return id;
    }
    stackId = await runningStack(orgId, ownerToken, "app-a");
    otherStackId = await runningStack(otherOrgId, otherToken, "app-b");

    const site = await owner("POST", `/v1/organizations/${orgId}/managed-sites`, SITE);
    expect(site.status, site.raw).toBe(202);
    siteId = site.body.data.siteId as string;
    await drain();
    // The panel proxy and its panel file, as the installer leaves them.
    await sim.ensureIngressProxy();
    lookup.set("panel.example.test", [HOST_IPV4]);
    calls.length = 0; // from here on, only what the tests do
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await dbClient?.close();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it("starts from a running application with no route file, next to a site file and the panel file", async () => {
    const all = await files();
    expect(all.has(appFileName())).toBe(false);
    expect(all.has("hp-panel.yml")).toBe(true);
    expect(siteFileNames(all)).toEqual([`site_${siteId}.yml`]);
    expect((await stackRow()).status).toBe("running");
    expect(await refreshCount()).toBe(0);
  });

  describe("a hostname is added and removed (ACME off, so the file moves only with the addresses)", () => {
    it("adding the first hostname creates only the application's file, with one refresh and none on the next pass", async () => {
      lookup.set("shop.example.test", [HOST_IPV4]);
      const r = await change(async () => {
        const res = await addHost("shop.example.test");
        expect(res.status, res.raw).toBe(201);
      }, 1);
      expect([...r.filesAfter.keys()].sort()).toEqual([...r.filesBefore.keys(), appFileName()].sort());
      expect(r.filesAfter.get(appFileName())).toContain("shop.example.test");
      expect(r.filesAfter.get(appFileName())).toContain(`hp_app_${stackId}_web:8080`);
      expectSiteAndPanelUntouched(r);
      expect(r.refreshes).toBe(1);
      expect(r.publishes).toBe(1);
      expectOnlyApplicationRequests(r.methods);

      const next = await change(async () => undefined, 2);
      expect(next.refreshes).toBe(0);
      expect(next.publishes).toBe(0);
      expect(next.filesAfter).toEqual(next.filesBefore);
      expectOnlyApplicationRequests(next.methods);
    });

    it("the address is live afterwards: row active and DNS ok, the stack still running", async () => {
      const row = await rowOf("shop.example.test");
      expect(row.status).toBe("active");
      expect(row.dnsStatus).toBe("ok");
      expect((await stackRow()).status).toBe("running");
    });

    it("adding a second hostname rewrites the same file, still alone", async () => {
      lookup.set("blog.example.test", [HOST_IPV4]);
      const r = await change(async () => {
        expect((await addHost("blog.example.test")).status).toBe(201);
      }, 3);
      const text = r.filesAfter.get(appFileName())!;
      expect(text).toContain("shop.example.test");
      expect(text).toContain("blog.example.test");
      expect(text).not.toBe(r.filesBefore.get(appFileName()));
      expect([...r.filesAfter.keys()]).toEqual([...r.filesBefore.keys()]);
      expectSiteAndPanelUntouched(r);
      expect(r.refreshes).toBe(1);
      expect(r.publishes).toBe(1);
      expectOnlyApplicationRequests(r.methods);
      const next = await change(async () => undefined, 4);
      expect(next.refreshes).toBe(0);
      expect(next.publishes).toBe(0);
    });

    it("removing one hostname rewrites the file without it, alone, once", async () => {
      const id = (await rowOf("blog.example.test")).id;
      const r = await change(async () => {
        const res = await owner("DELETE", `${base()}/${id}`);
        expect(res.status, res.raw).toBe(200);
      }, 5);
      const text = r.filesAfter.get(appFileName())!;
      expect(text).toContain("shop.example.test");
      expect(text).not.toContain("blog.example.test");
      expectSiteAndPanelUntouched(r);
      expect(r.refreshes).toBe(1);
      expect(r.publishes).toBe(1);
      expectOnlyApplicationRequests(r.methods);
      const next = await change(async () => undefined, 6);
      expect(next.refreshes).toBe(0);
      expect(next.publishes).toBe(0);
    });

    it("a hostname whose DNS does not point here is routed too, and a DNS-only change moves nothing", async () => {
      lookup.set("later.example.test", []);
      const r = await change(async () => {
        expect((await addHost("later.example.test")).status).toBe(201);
      }, 7);
      expect(r.filesAfter.get(appFileName())).toContain("later.example.test");
      expect(r.refreshes).toBe(1);
      expectSiteAndPanelUntouched(r);
      const row = await rowOf("later.example.test");
      expect(row.dnsStatus).not.toBe("ok");
      // The record appears: the DNS state changes, the route file does not.
      lookup.set("later.example.test", [HOST_IPV4]);
      const dns = await change(async () => undefined, 120);
      expect((await rowOf("later.example.test")).dnsStatus).toBe("ok");
      expect(dns.refreshes).toBe(0);
      expect(dns.publishes).toBe(0);
      expect(dns.filesAfter).toEqual(dns.filesBefore);
      const id = row.id;
      const gone = await change(async () => {
        expect((await owner("DELETE", `${base()}/${id}`)).status).toBe(200);
      }, 121);
      expect(gone.filesAfter.get(appFileName())).not.toContain("later.example.test");
      expect(gone.refreshes).toBe(1);
    });

    it("removing the last hostname unpublishes the application's file, and nothing else", async () => {
      const id = (await rowOf("shop.example.test")).id;
      const r = await change(async () => {
        expect((await owner("DELETE", `${base()}/${id}`)).status).toBe(200);
      }, 122);
      expect(r.filesAfter.has(appFileName())).toBe(false);
      expect([...r.filesAfter.keys()].sort()).toEqual([...r.filesBefore.keys()].filter((n) => n !== appFileName()).sort());
      expectSiteAndPanelUntouched(r);
      expect(r.refreshes).toBe(1);
      expect((await stackRow()).appliedRoutesHash).toBeNull();
      const next = await change(async () => undefined, 123);
      expect(next.refreshes).toBe(0);
      expect(next.publishes).toBe(0);
      expect((await stackRow()).status).toBe("running");
    });
  });

  describe("routing options rewrite only the application's file (ADR-0037)", () => {
    const MAIN = "main.example.test";
    const OLD = "old.example.test";
    const PASSWORD = "Routing-Canary-Pass-0001";
    const OFF = { redirectToDomainId: null, compression: false, protection: null, pathRoutes: [] };
    const FILES = { pathPrefix: "/files", componentKey: "web", port: 8080, stripPrefix: true };
    const OPTION_WORDS = ["basicAuth", "compress", "redirectRegex", "stripPrefix", "PathPrefix", "apr1"];
    let plain: string;
    let plainHash: string | null;

    async function setOptions(hostname: string, body: Json): Promise<void> {
      const res = await owner("PATCH", `${base()}/${(await rowOf(hostname)).id}`, body);
      expect(res.status, res.raw).toBe(200);
      expect(res.raw).not.toContain(PASSWORD);
      expect(res.raw).not.toContain("apr1");
    }
    /** One change of the options: only the application's file moved, with one refresh, and the next pass is idle. */
    async function expectOneRewrite(act: () => Promise<unknown>, minutes: number): Promise<string> {
      const r = await change(act, minutes);
      expect(r.filesAfter.get(appFileName())).not.toBe(r.filesBefore.get(appFileName()));
      expect([...r.filesAfter.keys()]).toEqual([...r.filesBefore.keys()]);
      expectSiteAndPanelUntouched(r);
      expect(r.refreshes).toBe(1);
      expect(r.publishes).toBe(1);
      expectOnlyApplicationRequests(r.methods);
      const next = await change(async () => undefined, minutes + 1);
      expect(next.refreshes).toBe(0);
      expect(next.publishes).toBe(0);
      expect(next.filesAfter).toEqual(next.filesBefore);
      return r.filesAfter.get(appFileName())!;
    }
    /** The password and its verifier are in no audit row, operation or outbox row. */
    async function expectNoPasswordKept(...verifiers: string[]): Promise<void> {
      const db = dbClient.db;
      const kept = JSON.stringify([await db.select().from(auditEvents), await db.select().from(operations), await db.select().from(outboxEvents)]);
      for (const word of [PASSWORD, "apr1", ...verifiers]) expect(kept).not.toContain(word);
    }

    it("two addresses without options give a file with none of the options in it", async () => {
      lookup.set(MAIN, [HOST_IPV4]);
      lookup.set(OLD, [HOST_IPV4]);
      await change(async () => expect((await addHost(MAIN)).status).toBe(201), 130);
      const r = await change(async () => expect((await addHost(OLD)).status).toBe(201), 131);
      plain = r.filesAfter.get(appFileName())!;
      plainHash = (await stackRow()).appliedRoutesHash;
      expect(plain).toContain(MAIN);
      expect(plain).toContain(OLD);
      for (const word of OPTION_WORDS) expect(plain).not.toContain(word);
      expect(plainHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("a password, compression and a path reach the file in one rewrite, with the verifier of the row and never the password", async () => {
      const text = await expectOneRewrite(
        () => setOptions(MAIN, { redirectToDomainId: null, compression: true, protection: { username: "guest", password: PASSWORD }, pathRoutes: [FILES] }),
        132,
      );
      const verifier = (await rowOf(MAIN)).accessPasswordHash!;
      expect(text).toContain(`- "guest:${verifier}"`);
      expect(text).toContain("basicAuth:");
      expect(text).toContain("compress: {}");
      expect(text).toContain("Host(`main.example.test`) && (Path(`/files`) || PathPrefix(`/files/`))");
      expect(text).toContain("stripPrefix:");
      expect(text).not.toContain("redirectRegex");
      expect(text).not.toContain(PASSWORD);
      expect((await stackRow()).appliedRoutesHash).not.toBe(plainHash);
      await expectNoPasswordKept(verifier);
    });

    it("the same options sent again, with the user name alone, move nothing", async () => {
      const verifier = (await rowOf(MAIN)).accessPasswordHash!;
      const r = await change(() => setOptions(MAIN, { redirectToDomainId: null, compression: true, protection: { username: "guest" }, pathRoutes: [FILES] }), 134);
      expect((await rowOf(MAIN)).accessPasswordHash).toBe(verifier);
      expect(r.refreshes).toBe(0);
      expect(r.publishes).toBe(0);
      expect(r.filesAfter).toEqual(r.filesBefore);
    });

    it("a new password rewrites the file with the new verifier and without the old one", async () => {
      const old = (await rowOf(MAIN)).accessPasswordHash!;
      const text = await expectOneRewrite(
        () => setOptions(MAIN, { redirectToDomainId: null, compression: true, protection: { username: "guest", password: `${PASSWORD}-b` }, pathRoutes: [FILES] }),
        135,
      );
      const verifier = (await rowOf(MAIN)).accessPasswordHash!;
      expect(verifier).not.toBe(old);
      expect(text).toContain(`- "guest:${verifier}"`);
      expect(text).not.toContain(old);
      await expectNoPasswordKept(old, verifier);
    });

    it("a redirect sends the old address to the main one, keeps it live, and gives it no other option", async () => {
      const mainId = (await rowOf(MAIN)).id;
      const before = (await files()).get(appFileName())!;
      const text = await expectOneRewrite(() => setOptions(OLD, { ...OFF, compression: true, redirectToDomainId: mainId }), 137);
      // No certificate yet on this host (ACME off), so the destination is reached over plain HTTP.
      expect(text).toContain("redirectRegex:");
      expect(text).toContain('replacement: "http://main.example.test${1}"');
      expect(text).toContain("permanent: true");
      // One protected host and one compressed host, as before: the redirecting address added neither.
      const count = (t: string, word: string) => t.split(word).length - 1;
      for (const word of ["_auth\"", "_compress\"", "basicAuth:"]) expect(count(text, word), word).toBe(count(before, word));
      expect((await rowOf(OLD)).status).toBe("active");
      expect((await rowOf(OLD)).compression).toBe(true);
    });

    it("with every option cleared the file and its hash are the plain ones again, byte for byte", async () => {
      await expectOneRewrite(() => setOptions(OLD, OFF), 139);
      const text = await expectOneRewrite(() => setOptions(MAIN, OFF), 141);
      expect(text).toBe(plain);
      expect((await stackRow()).appliedRoutesHash).toBe(plainHash);
    });

    it("removing the destination of a redirect takes the redirect away: the other address serves content again, compressed as it was set", async () => {
      const mainId = (await rowOf(MAIN)).id;
      await expectOneRewrite(() => setOptions(OLD, { ...OFF, compression: true, redirectToDomainId: mainId }), 143);
      const text = await expectOneRewrite(async () => expect((await owner("DELETE", `${base()}/${mainId}`)).status).toBe(200), 145);
      expect((await rowOf(OLD)).redirectToDomainId).toBeNull();
      expect(text).toContain(OLD);
      expect(text).not.toContain(MAIN);
      expect(text).not.toContain("redirectRegex");
      expect(text).toContain("compress: {}");
    });

    it("removing the last address unpublishes the file, as without options", async () => {
      const id = (await rowOf(OLD)).id;
      const r = await change(async () => expect((await owner("DELETE", `${base()}/${id}`)).status).toBe(200), 147);
      expect(r.filesAfter.has(appFileName())).toBe(false);
      expectSiteAndPanelUntouched(r);
      expect(r.refreshes).toBe(1);
      expect((await stackRow()).appliedRoutesHash).toBeNull();
      expect((await change(async () => undefined, 148)).refreshes).toBe(0);
      await expectNoPasswordKept();
    });
  });

  describe("an ACME state change rewrites only the application's file", () => {
    const HOST = "secure.example.test";

    it("with ACME on, a hostname gets a request: audit row, one refresh, only the application's file", async () => {
      lookup.set(HOST, [HOST_IPV4]);
      sim.acmeEnabled = true;
      expect((await addHost(HOST)).status).toBe(201);
      await pass(200);
      // Settle: DNS ok, domain active (after the publish), and the request goes out on a later pass.
      for (let m = 201; m < 206 && (await rowOf(HOST)).certStatus === "none"; m++) await pass(m);
      expect((await rowOf(HOST)).certStatus).toBe("requested");
      const requested = await audits("site.certificate.requested", HOST);
      expect(requested).toHaveLength(1);
      expect(requested[0]!.actorType).toBe("system");
      expect(requested[0]!.targetType).toBe("app_stack_domain");
      expect(requested[0]!.targetId).toBe((await rowOf(HOST)).id);
      expect(requested[0]!.organizationId).toBe(orgId);
      const next = await change(async () => undefined, 207);
      expect(next.refreshes).toBe(0);
      expect(next.publishes).toBe(0);
      expect(await audits("site.certificate.requested", HOST)).toHaveLength(1);
    });

    it("the certificate is issued: one refresh, the file changes, the site and panel files do not", async () => {
      const row = await rowOf(HOST);
      const before = await files();
      const refreshesBefore = await refreshCount();
      sim.issueCertificate(HOST, at(60 * 24 * 90).toISOString());
      const r = await change(async () => undefined, 208);
      expect((await rowOf(HOST)).certStatus).toBe("active");
      expect((await rowOf(HOST)).certExpiresAt?.toISOString()).toBe(at(60 * 24 * 90).toISOString());
      const issued = await audits("site.certificate.issued", HOST);
      expect(issued).toHaveLength(1);
      expect(issued[0]!.targetId).toBe(row.id);
      expect(JSON.stringify(issued[0]!.details)).not.toMatch(/privateKey|BEGIN /);
      expect(r.filesAfter.get(appFileName())).not.toBe(before.get(appFileName()));
      expect(r.filesAfter.get(appFileName())).toContain('"tls":true,"httpsRedirect":true');
      expectSiteAndPanelUntouched({ filesBefore: before, filesAfter: r.filesAfter });
      expect((await refreshCount()) - refreshesBefore).toBe(1);
      expect(r.publishes).toBe(1);
      expectOnlyApplicationRequests(r.methods);
      const next = await change(async () => undefined, 209);
      expect(next.refreshes).toBe(0);
      expect(next.publishes).toBe(0);
      expect(await audits("site.certificate.issued", HOST)).toHaveLength(1);
    });

    it("an ACME failure on a second hostname: failed audit with the site action, one refresh, only the application's file", async () => {
      const host = "refused.example.test";
      lookup.set(host, [HOST_IPV4]);
      expect((await addHost(host)).status).toBe(201);
      for (let m = 300; m < 304 && (await rowOf(host)).certStatus !== "requested"; m++) await pass(m);
      expect((await rowOf(host)).certStatus).toBe("requested");
      sim.failCertificate(host, "rate_limited", at(305).toISOString());
      const r = await change(async () => undefined, 306);
      const row = await rowOf(host);
      expect(row.certStatus).toBe("failed");
      expect(row.certProblem).toBe("rate_limited");
      expect(row.certAttempts).toBe(1);
      const failed = await audits("site.certificate.failed", host);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.details).toMatchObject({ hostname: host, problem: "rate_limited" });
      expect(failed[0]!.targetType).toBe("app_stack_domain");
      expect(failed[0]!.actorType).toBe("system");
      expectSiteAndPanelUntouched(r);
      expect(r.refreshes).toBe(1);
      expectOnlyApplicationRequests(r.methods);
      const next = await change(async () => undefined, 307);
      expect(next.refreshes).toBe(0);
      expect(next.publishes).toBe(0);
      expect(await audits("site.certificate.failed", host)).toHaveLength(1);
    });

    it("a failed read of the certificate store moves nothing and queues no refresh", async () => {
      sim.setCertificateStoreReadable(false);
      try {
        const r = await change(async () => undefined, 330);
        expect(r.refreshes).toBe(0);
        expect(r.publishes).toBe(0);
        expect(r.filesAfter).toEqual(r.filesBefore);
        expect((await rowOf(HOST)).certStatus).toBe("active");
      } finally {
        sim.setCertificateStoreReadable(true);
      }
    });
  });

  describe("the proxy is never recreated", () => {
    it("no pass, add, remove or ACME change in this file asked for the proxy, a site route or a service", () => {
      const forbidden = calls.filter((c) => /Proxy|SiteRoutes|deployService|removeService|applyManual|putManual|applyDnsProvider/.test(c));
      expect(forbidden).toEqual([]);
      expect(calls.filter((c) => c === "publishAppStackRoutes").length).toBeGreaterThan(0);
    });
  });

  describe("global collision between a site and an application", () => {
    it.each([
      ["a site's hostname", SITE.domain],
      ["the panel's hostname", "panel.example.test"],
    ])("an application refuses %s with the same conflict text and writes nothing", async (_n, hostname) => {
      const before = await files();
      const rows = (await domainRows()).length;
      const auditsBefore = (await audits("app.stack.domain.assign")).length;
      const res = await addHost(hostname);
      expect(res.status, res.raw).toBe(409);
      expect(res.body.error.code).toBe("DOMAIN_CONFLICT");
      expect(res.body.error.message).toBe(CONFLICT);
      expect((await domainRows()).length).toBe(rows);
      expect((await audits("app.stack.domain.assign")).length).toBe(auditsBefore);
      await pass(400);
      await expectNoTrace(before, hostname);
    });

    it("a site refuses a hostname an application of the same organisation holds, and the file is untouched", async () => {
      lookup.set("taken.example.test", [HOST_IPV4]);
      expect((await addHost("taken.example.test")).status).toBe(201);
      await pass(401);
      const before = await files();
      const res = await owner("POST", `/v1/organizations/${orgId}/managed-sites/${siteId}/domains`, { hostname: "taken.example.test", includeWww: false });
      expect(res.status, res.raw).toBe(409);
      expect(res.body.error.code).toBe("DOMAIN_CONFLICT");
      expect(res.body.error.message).toBe(CONFLICT);
      expect(await dbClient.db.select().from(domains).where(eq(domains.hostname, "taken.example.test"))).toHaveLength(0);
      await pass(402);
      await expectNoTrace(before, null);
      expect((await rowOf("taken.example.test")).status).toBe("active");
    });

    it("a site of another organisation is refused too, and without naming the owner", async () => {
      const res = await call("POST", `/v1/organizations/${otherOrgId}/app-stacks/${otherStackId}/domains`, { hostname: "taken.example.test", ...WEB }, otherToken);
      expect(res.status, res.raw).toBe(409);
      expect(res.body.error.code).toBe("DOMAIN_CONFLICT");
      expect(res.body.error.message).toBe(CONFLICT);
      expect(res.raw).not.toContain(orgId);
      expect(res.raw).not.toContain(stackId);
    });

    it("two applications never hold the same hostname, in either order", async () => {
      const res = await call("POST", `/v1/organizations/${otherOrgId}/app-stacks/${otherStackId}/domains`, { hostname: "TAKEN.example.test", ...WEB }, otherToken);
      expect(res.status, res.raw).toBe(409);
      expect(res.body.error.code).toBe("DOMAIN_CONFLICT");
      lookup.set("theirs.example.test", [HOST_IPV4]);
      expect((await call("POST", `/v1/organizations/${otherOrgId}/app-stacks/${otherStackId}/domains`, { hostname: "theirs.example.test", ...WEB }, otherToken)).status).toBe(201);
      const mine = await addHost("theirs.example.test");
      expect(mine.status, mine.raw).toBe(409);
      expect(mine.body.error.message).toBe(CONFLICT);
      expect(mine.raw).not.toContain(otherOrgId);
      expect(mine.raw).not.toContain(otherStackId);
    });
  });

  describe("another organisation's manual wildcard", () => {
    async function manualCertificate(org: string, names: string[]): Promise<void> {
      const certificateId = `tlc_${randomUUID()}`;
      await dbClient.db.insert(tlsCertificates).values({ id: certificateId, organizationId: org, name: `cert-${certificateId}` });
      await dbClient.db.insert(tlsCertificateVersions).values({
        id: `tlv_${randomUUID()}`,
        certificateId,
        organizationId: org,
        versionNumber: 1,
        leafPem: "leaf",
        chainPem: "chain",
        keyCiphertextBase64: "a",
        keyIvBase64: "b",
        keyAuthTagBase64: "c",
        subject: `CN=${names[0]!}`,
        issuer: "CN=Test CA",
        serialNumber: "01",
        fingerprintSha256: "f".repeat(64),
        notBefore: new Date(Date.now() - 86_400_000),
        notAfter: new Date(Date.now() + 86_400_000 * 90),
        sanDns: names,
        keyType: "ec",
        keyBits: 256,
        status: "active",
      });
    }

    it.each([
      ["a name one label under the wildcard", "shop.covered.test", true],
      ["the same name in capitals", "SHOP.Covered.Test", true],
      ["a name two labels under the wildcard", "a.shop.covered.test", false],
      ["the apex the wildcard does not cover", "covered.test", false],
      ["a lookalike suffix", "shop.notcovered.test", false],
    ])("%s (%s) is refused: %s", async (_n, hostname, refused) => {
      if (hostname === "shop.covered.test") await manualCertificate(otherOrgId, ["*.covered.test"]);
      lookup.set(hostname.toLowerCase(), [HOST_IPV4]);
      const before = await files();
      const rows = (await domainRows()).length;
      const res = await addHost(hostname);
      if (refused) {
        expect(res.status, res.raw).toBe(409);
        expect(res.body.error.code).toBe("DOMAIN_CONFLICT");
        expect(res.raw).not.toContain(otherOrgId);
        expect((await domainRows()).length).toBe(rows);
        await pass(500);
        await expectNoTrace(before, hostname);
      } else {
        expect(res.status, res.raw).toBe(201);
        expect((await domainRows()).length).toBe(rows + 1);
      }
    });

    it("the organisation that owns the wildcard is refused too: applications are ACME-only, no manual certificate may cover them", async () => {
      const res = await call("POST", `/v1/organizations/${otherOrgId}/app-stacks/${otherStackId}/domains`, { hostname: "mine.covered.test", ...WEB }, otherToken);
      expect(res.status, res.raw).toBe(409);
      expect(res.body.error.code).toBe("CERTIFICATE_IN_USE");
      expect(await dbClient.db.select().from(appStackDomains).where(eq(appStackDomains.hostname, "mine.covered.test"))).toHaveLength(0);
    });
  });

  describe("tenancy of the address list", () => {
    it("another organisation cannot list or remove this application's addresses", async () => {
      const id = (await domainRows())[0]!.id;
      const list = await call("GET", base(), undefined, otherToken);
      expect(list.status).toBe(404);
      const del = await call("DELETE", `${base()}/${id}`, undefined, otherToken);
      expect(del.status).toBe(404);
      expect((await domainRows()).some((r) => r.id === id)).toBe(true);
    });
  });

  describe("the ACME audit rows are the site's", () => {
    it("the audit rows share the 24 h throttle with sites: the same name on a site starts failed, not fresh", async () => {
      const host = "refused.example.test";
      const row = await rowOf(host);
      expect((await owner("DELETE", `${base()}/${row.id}`)).status).toBe(200);
      await pass(310);
      const added = await owner("POST", `/v1/organizations/${orgId}/managed-sites/${siteId}/domains`, { hostname: host, includeWww: false });
      expect(added.status, added.raw).toBe(201);
      const [siteRow] = (await dbClient.db.select().from(domains).where(eq(domains.hostname, host)));
      expect(siteRow!.certStatus).toBe("failed");
      expect(siteRow!.certProblem).toBe("rate_limited");
      expect(siteRow!.certAttempts).toBe(1);
      expect(siteRow!.certRequestedAt).not.toBeNull();
    });
  });

  // Last in the file: this application of its own moves nothing the tests above count.
  describe("after an upgrade that failed before it changed anything, the options still reach the file (ADR-0037)", () => {
    const HOST = "after-upgrade.example.test";
    const PASSWORD = "Upgrade-Canary-Pass-0001";
    const V2 = APP_BUILT_IN_TEMPLATES[0]!.source.replace("          memory: 64M", "          memory: 96M");
    let appId: string;

    const appRow = async () => (await dbClient.db.select().from(appStacks).where(eq(appStacks.id, appId)))[0]!;
    const appPath = (verb: string) => `/v1/organizations/${orgId}/app-stacks/${appId}/${verb}`;

    it("the application runs revision 1 and its address is published without a password", async () => {
      const tpl = await call("POST", "/v1/admin/app-templates", { slug: `up-${randomUUID().slice(0, 8)}`, source: APP_BUILT_IN_TEMPLATES[0]!.source }, adminToken);
      expect(tpl.status, tpl.raw).toBe(201);
      expect((await call("PATCH", `/v1/admin/app-templates/${tpl.body.data.id as string}`, { enabled: true }, adminToken)).status).toBe(200);
      const dep = await owner("POST", `/v1/organizations/${orgId}/app-stacks`, { templateVersionId: tpl.body.data.defaultVersionId, name: "app-up", deploy: true });
      expect(dep.status, dep.raw).toBe(202);
      appId = dep.body.data.stackId as string;
      await drain();
      expect((await appRow()).status).toBe("running");
      // DNS elsewhere: the address is routed, and no certificate request moves the file during this test.
      lookup.set(HOST, []);
      expect((await addHost(HOST, appId)).status).toBe(201);
      await pass(600);
      expect((await files()).get(`app_${appId}.yml`)).toContain(HOST);
      expect((await files()).get(`app_${appId}.yml`)).not.toContain("basicAuth");

      const v2 = await call("POST", `/v1/admin/app-templates/${tpl.body.data.id as string}/versions`, { source: V2, makeDefault: true }, adminToken);
      expect(v2.status, v2.raw).toBe(201);
      const preview = await owner("POST", appPath("plan"), { templateVersionId: v2.body.data.versionId });
      expect(preview.status, preview.raw).toBe(200);
      sim.appStacks.failNextAppStackStep("pull", "pull_failed");
      const up = await owner("POST", appPath("upgrade"), { templateVersionId: v2.body.data.versionId, planHash: preview.body.data.planHash });
      expect(up.status, up.raw).toBe(202);
      await drain();
      const row = await appRow();
      expect(row.status).toBe("running");
      expect(row.appliedRevisionId).not.toBeNull();
      expect(row.desiredRevisionId).not.toBe(row.appliedRevisionId);
    });

    it("a password set now is in the next route request of the revision that runs, and in the file", async () => {
      const { appliedRevisionId } = await appRow();
      const sentBefore = routeRequests.length;
      const address = async () => (await dbClient.db.select().from(appStackDomains).where(eq(appStackDomains.hostname, HOST)))[0]!;
      const res = await owner("PATCH", `${base(appId)}/${(await address()).id}`, {
        redirectToDomainId: null,
        compression: false,
        protection: { username: "guest", password: PASSWORD },
        pathRoutes: [],
      });
      expect(res.status, res.raw).toBe(200);
      expect(res.raw).not.toContain(PASSWORD);
      await pass(601);

      const verifier = (await address()).accessPasswordHash!;
      const sent = routeRequests.slice(sentBefore).filter((r) => r.plan.stackId === appId);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.plan.revisionId).toBe(appliedRevisionId);
      expect(sent[0]!.routes.flatMap((e) => e.hosts as Json[]).find((h) => h.hostname === HOST)).toMatchObject({
        protection: { username: "guest", passwordHash: verifier },
      });
      expect((await files()).get(`app_${appId}.yml`)).toContain(`- "guest:${verifier}"`);
      // The refresh installed nothing and names the revision that runs; the newer one is still the one asked for.
      const refreshes = (
        await dbClient.db
          .select({ key: operations.idempotencyKey, revisionId: appStackDeployments.revisionId, status: appStackDeployments.status })
          .from(appStackDeployments)
          .innerJoin(operations, eq(operations.id, appStackDeployments.operationId))
          .where(eq(appStackDeployments.stackId, appId))
      ).filter((d) => (d.key ?? "").startsWith("sys_routes_"));
      expect(refreshes).toHaveLength(2);
      for (const refresh of refreshes) expect(refresh).toMatchObject({ revisionId: appliedRevisionId, status: "succeeded" });
      expect(await appRow()).toMatchObject({ status: "running", appliedRevisionId });
      expect(res.body.applies).toBe("shortly");
    });
  });
});
