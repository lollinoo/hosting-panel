import { APP_BUILT_IN_TEMPLATES, APP_FEATURES_OFF, type AppFeatureFlags } from "@hosting-panel/contracts";
import {
  appStackComponents,
  appStackDeployments,
  appStackDomains,
  appStackParameters,
  appStackRevisions,
  appStackSecrets,
  appStackVolumes,
  appStacks,
  appTemplateVersions,
  appTemplates,
  builtInAppTemplateItems,
  ensureBuiltInAppTemplates,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { APP_STACK_EXECUTOR_METHODS } from "@hosting-panel/executor-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppStackObserverService } from "../src/app-stacks/app-stack-observer.service.js";
import { totpCodeAt } from "../src/auth/totp.js";
import { createServerAdmin, setupInstallation } from "../src/cli/accounts.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";
import { skipPasswordChange } from "./fixtures/password-change.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const KEY = Buffer.alloc(32, 7);
const PW = "correct horse battery";
const FLAGS = Object.keys(APP_FEATURES_OFF) as (keyof AppFeatureFlags)[];
const ALL_ON: AppFeatureFlags = { applicationTemplatesAvailable: true, applicationStacksAvailable: true, stackPublicPortsAvailable: true, gitBuildsAvailable: true };
const STACK_TABLES = {
  app_stacks: appStacks,
  app_stack_parameters: appStackParameters,
  app_stack_secrets: appStackSecrets,
  app_stack_revisions: appStackRevisions,
  app_stack_components: appStackComponents,
  app_stack_volumes: appStackVolumes,
  app_stack_domains: appStackDomains,
  app_stack_deployments: appStackDeployments,
};

interface Boot {
  readonly app: ControlPlaneAppHandle;
  readonly sim: InMemoryDockerSimulatorAdapter;
  /** Every method name invoked on the executor since boot, in order. */
  readonly executorCalls: string[];
  readonly adminToken: string;
  readonly customer: { readonly orgId: string; readonly token: string };
  call(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json; raw: string }>;
}

/** A boot that owns its database (own PGlite: migrations, WordPress seed, application seed) and records every executor call. */
async function boot(appFeatures?: Partial<AppFeatureFlags>): Promise<Boot> {
  const sim = new InMemoryDockerSimulatorAdapter();
  const executorCalls: string[] = [];
  const recording = new Proxy(sim, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        executorCalls.push(String(prop));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  const app = await createControlPlaneApp({
    listen: true,
    host: "127.0.0.1",
    port: 0,
    secretsMasterKey: KEY,
    runtimeBackend: "local-simulator",
    dockerExecutor: recording,
    autoProcessOutbox: false,
    outboxPollIntervalMs: null,
    driftReconcileIntervalMs: null,
    domainReconcileIntervalMs: null,
    recoverUnknownOnStart: false,
    ...(appFeatures ? { appFeatures } : {}),
  });
  const call: Boot["call"] = async (token, method, path, body) => {
    const res = await fetch(`${app.baseUrl!}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    return { status: res.status, body: raw ? (JSON.parse(raw) as Json) : {}, raw };
  };
  const login = async (email: string, password: string, totpSecret?: string): Promise<string> => {
    const res = await fetch(`${app.baseUrl!}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        ...(totpSecret ? { totpCode: totpCodeAt(totpSecret, Math.floor(Date.now() / 30_000)) } : {}),
      }),
    });
    const raw = await res.text();
    if (res.status !== 200) throw new Error(`login of ${email} failed: ${raw}`);
    return (JSON.parse(raw) as Json)["data"].accessToken as string;
  };

  const db = app.dbClient.db;
  await setupInstallation(db, { installationName: "Test", hostHostname: "panel.test", hostIpv4: "10.0.0.1" });
  const admin = await createServerAdmin(db, KEY, { email: "admin@x.it", name: "Admin", password: PW });
  const adminToken = await login("admin@x.it", PW, admin.totpSecretBase32);
  const created = await call(adminToken, "POST", "/v1/admin/customer-account", {
    organizationName: "Hotel Mario",
    ownerEmail: "mario@hotel.it",
    ownerName: "Mario",
  });
  if (created.status !== 201) throw new Error(`customer: ${created.raw}`);
  await skipPasswordChange(db, "mario@hotel.it");
  const token = await login("mario@hotel.it", created.body["data"].temporaryPassword as string);
  return { app, sim, executorCalls, adminToken, customer: { orgId: created.body["data"].organizationId as string, token }, call };
}

/** One full background round: the outbox three times, then every tick the runtime exposes once. */
async function tickEverything(b: Boot): Promise<void> {
  for (let i = 0; i < 3; i += 1) await b.app.outboxWorker.processPendingOnce();
  await b.app.nestApp.get(AppStackObserverService).reconcileOnce();
  await b.app.driftReconciler.reconcileAllOnce();
  await b.app.domainReconciler.reconcileOnce();
}

const rowCounts = async (db: DatabaseClient["db"]): Promise<Record<string, number>> =>
  Object.fromEntries(
    await Promise.all(Object.entries(STACK_TABLES).map(async ([name, table]) => [name, (await db.select().from(table)).length] as const)),
  );

/** Nothing for applications was created, started, pulled or published, and the recorder saw no stack method at all. */
function expectNoApplicationDockerWork(b: Boot): void {
  const stackMethods: readonly string[] = APP_STACK_EXECUTOR_METHODS;
  expect(b.executorCalls.filter((name) => stackMethods.includes(name))).toEqual([]);
  expect(b.executorCalls.filter((name) => /appstack/i.test(name))).toEqual([]);
  expect(b.sim.appStacks.appStackCalls).toEqual([]);
  expect(b.sim.appStacks.appStackMutations).toEqual([]);
  expect(b.sim.appStacks.appStackMutations.filter((m) => m.name.startsWith("hp_app"))).toEqual([]);
}

async function expectBuiltInsOnly(db: DatabaseClient["db"]): Promise<void> {
  const templates = await db.select().from(appTemplates).orderBy(appTemplates.id);
  expect(templates.map((t) => [t.id, t.slug, t.builtIn, t.defaultVersionId])).toEqual([
    ["atpl_http_cache", "http-cache", true, "atv_http_cache_1"],
    ["atpl_mariadb", "mariadb", true, "atv_mariadb_2"],
    ["atpl_postgresql", "postgresql", true, "atv_postgresql_1"],
    ["atpl_valkey", "valkey", true, "atv_valkey_1"],
    ["atpl_wordpress_mariadb", "wordpress-mariadb", true, "atv_wordpress_mariadb_2"],
    ["atpl_worker_storage", "worker-storage", true, "atv_worker_storage_1"],
  ]);
  const versions = await db.select().from(appTemplateVersions).orderBy(appTemplateVersions.id);
  const source = (slug: string) => APP_BUILT_IN_TEMPLATES.find((t) => t.slug === slug)!.source;
  const earlierSource = (slug: string) => APP_BUILT_IN_TEMPLATES.find((t) => t.slug === slug)!.previousVersions![0]!.source;
  expect(versions.map((v) => [v.id, v.templateId, v.versionNumber, v.source])).toEqual([
    ["atv_http_cache_1", "atpl_http_cache", 1, source("http-cache")],
    ["atv_mariadb_1", "atpl_mariadb", 1, earlierSource("mariadb")],
    ["atv_mariadb_2", "atpl_mariadb", 2, source("mariadb")],
    ["atv_postgresql_1", "atpl_postgresql", 1, source("postgresql")],
    ["atv_valkey_1", "atpl_valkey", 1, source("valkey")],
    ["atv_wordpress_mariadb_1", "atpl_wordpress_mariadb", 1, earlierSource("wordpress-mariadb")],
    ["atv_wordpress_mariadb_2", "atpl_wordpress_mariadb", 2, source("wordpress-mariadb")],
    ["atv_worker_storage_1", "atpl_worker_storage", 1, source("worker-storage")],
  ]);
}

describe("HCP-SPEC-005 §20 boot sentinel: an API boot without application stacks creates nothing in Docker", () => {
  describe("flags at their defaults (all false)", () => {
    let b: Boot;

    beforeAll(async () => {
      b = await boot();
      await tickEverything(b);
    }, 120_000);

    afterAll(async () => {
      await b?.app.close();
    });

    it("makes no application executor call and creates no hp_app network, volume or container", () => {
      expectNoApplicationDockerWork(b);
      expect(b.sim.deployedSpecs).toEqual([]);
      expect(b.sim.jobs).toEqual([]);
    });

    it("seeds exactly the six built-in templates, disabled, each with its newest version as the default", async () => {
      const db = b.app.dbClient.db;
      await expectBuiltInsOnly(db);
      const templates = await db.select().from(appTemplates);
      expect(templates.map((t) => t.enabled)).toEqual([false, false, false, false, false, false]);
    });

    it("leaves every application stack table empty", async () => {
      expect(await rowCounts(b.app.dbClient.db)).toEqual(Object.fromEntries(Object.keys(STACK_TABLES).map((name) => [name, 0])));
    });

    it("reports all four capability flags false to the admin and to the customer", async () => {
      const me = await b.call(b.adminToken, "GET", "/v1/me");
      expect(me.status, me.raw).toBe(200);
      for (const flag of FLAGS) expect(me.body["data"].platformCapabilities[flag], flag).toBe(false);
      const org = await b.call(b.customer.token, "GET", `/v1/organizations/${b.customer.orgId}`);
      expect(org.status, org.raw).toBe(200);
      for (const flag of FLAGS) expect(org.body["data"].capabilities[flag], flag).toBe(false);
    });

    it("answers the feature refusal on the customer catalogue and the stack list, and the admin catalogue", async () => {
      const paths: [string, string][] = [
        [b.customer.token, `/v1/organizations/${b.customer.orgId}/app-templates`],
        [b.customer.token, `/v1/organizations/${b.customer.orgId}/app-stacks`],
        [b.adminToken, "/v1/admin/app-templates"],
      ];
      for (const [token, path] of paths) {
        const res = await b.call(token, "GET", path);
        expect(res.status, path).toBe(422);
        expect(res.body["error"].code, path).toBe("NOT_SUPPORTED");
        expect(res.body["error"].details, path).toContainEqual(expect.objectContaining({ reason: "STACK_UNSUPPORTED_FEATURE" }));
      }
      expectNoApplicationDockerWork(b);
    });

    it("a second seeding of the built-ins changes no row (counts and updated_at included)", async () => {
      const db = b.app.dbClient.db;
      const before = [await db.select().from(appTemplates).orderBy(appTemplates.id), await db.select().from(appTemplateVersions).orderBy(appTemplateVersions.id)];
      await ensureBuiltInAppTemplates(db, builtInAppTemplateItems());
      await ensureBuiltInAppTemplates(db, builtInAppTemplateItems());
      const after = [await db.select().from(appTemplates).orderBy(appTemplates.id), await db.select().from(appTemplateVersions).orderBy(appTemplateVersions.id)];
      expect(after[0]).toHaveLength(6);
      expect(after[1]).toHaveLength(8);
      expect(after).toEqual(before);
    });

    it("a second boot on the same data changes no row and still makes no application call", async () => {
      // The seed is idempotent when the database already holds the rows: an own PGlite cannot be reopened, so the
      // production seed runs against the live one again, under a fresh round of ticks.
      const db = b.app.dbClient.db;
      const before = await db.select().from(appTemplates).orderBy(appTemplates.id);
      await ensureBuiltInAppTemplates(db, builtInAppTemplateItems());
      await tickEverything(b);
      expect(await db.select().from(appTemplates).orderBy(appTemplates.id)).toEqual(before);
      expectNoApplicationDockerWork(b);
    });
  });

  describe("every flag on", () => {
    let b: Boot;

    beforeAll(async () => {
      b = await boot(ALL_ON);
      await tickEverything(b);
    }, 120_000);

    afterAll(async () => {
      await b?.app.close();
    });

    it("still makes no application call when no stack exists", async () => {
      await tickEverything(b);
      expectNoApplicationDockerWork(b);
      expect(await rowCounts(b.app.dbClient.db)).toEqual(Object.fromEntries(Object.keys(STACK_TABLES).map((name) => [name, 0])));
    });

    it("lists the six built-ins to the admin as disabled drafts and offers the customer an empty catalogue", async () => {
      const me = await b.call(b.adminToken, "GET", "/v1/me");
      for (const flag of FLAGS) expect(me.body["data"].platformCapabilities[flag], flag).toBe(true);

      const admin = await b.call(b.adminToken, "GET", "/v1/admin/app-templates");
      expect(admin.status, admin.raw).toBe(200);
      const rows = (admin.body["data"] as Json[]).map((t) => [t.id, t.builtIn, t.enabled]).sort();
      expect(rows).toEqual([
        ["atpl_http_cache", true, false],
        ["atpl_mariadb", true, false],
        ["atpl_postgresql", true, false],
        ["atpl_valkey", true, false],
        ["atpl_wordpress_mariadb", true, false],
        ["atpl_worker_storage", true, false],
      ]);

      const catalogue = await b.call(b.customer.token, "GET", `/v1/organizations/${b.customer.orgId}/app-templates`);
      expect(catalogue.status, catalogue.raw).toBe(200);
      expect(catalogue.body["data"].templates).toEqual([]);
    });

    it("enabling a built-in publishes it to the customer and still creates nothing in Docker", async () => {
      const enabled = await b.call(b.adminToken, "PATCH", "/v1/admin/app-templates/atpl_http_cache", { enabled: true });
      expect(enabled.status, enabled.raw).toBe(200);
      const catalogue = await b.call(b.customer.token, "GET", `/v1/organizations/${b.customer.orgId}/app-templates`);
      expect(catalogue.status, catalogue.raw).toBe(200);
      expect((catalogue.body["data"].templates as Json[]).map((t) => t.id)).toEqual(["atpl_http_cache"]);
      await tickEverything(b);
      expectNoApplicationDockerWork(b);
    });
  });

  it("the recorder is not blind: a stack call made through the executor is seen", async () => {
    const b = await boot();
    try {
      expect(b.executorCalls).not.toContain("getAppStackStatus");
      await (b.app.dockerExecutor as unknown as { getAppStackStatus(req: unknown): Promise<unknown> })
        .getAppStackStatus({ stackId: "stk_probe", organizationId: "org_probe" })
        .catch(() => undefined);
      expect(b.executorCalls).toContain("getAppStackStatus");
    } finally {
      await b.app.close();
    }
  }, 120_000);
});
