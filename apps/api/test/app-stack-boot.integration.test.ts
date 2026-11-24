import {
  appStacks,
  appTemplates,
  appTemplateVersions,
  asc,
  DEMO_IDS,
  inArray,
  newAppEntityId,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { AppStackObserverService } from "../src/app-stacks/app-stack-observer.service.js";
import { createControlPlaneApp, type CreateControlPlaneAppOptions } from "../src/create-app.js";
import { LogReadGate } from "../src/sites/log-read-gate.js";
import { ManagedSitesService } from "../src/sites/managed-sites.service.js";

// RT8: boot tasks of application stacks. Every boot of this file owns the same PGlite (as a restarted API owns the same
// database), so the tests run in order: the first one seeds, the later ones boot again on its data.
const shared = vi.hoisted(() => ({ client: null as DatabaseClient | null }));
vi.mock("@hosting-panel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hosting-panel/database")>();
  return {
    ...actual,
    createDatabaseClient: (config: Parameters<typeof actual.createDatabaseClient>[0]): DatabaseClient => {
      shared.client ??= actual.createDatabaseClient(config);
      return { ...shared.client, close: async () => undefined };
    },
  };
});

const KEY = Buffer.alloc(32, 9);
const boot = (options: CreateControlPlaneAppOptions = {}) =>
  createControlPlaneApp({ listen: false, secretsMasterKey: KEY, terminalSweepIntervalMs: null, ...options });
const db = () => shared.client!.db;
const builtIns = async () => ({
  templates: await db().select().from(appTemplates).orderBy(asc(appTemplates.id)),
  versions: await db().select().from(appTemplateVersions).orderBy(asc(appTemplateVersions.id)),
});

describe("application stack boot tasks (RT8)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await shared.client?.close();
  });

  it("a default app (flags off, runtime disabled) seeds the six built-in templates disabled, starts and stops the observer, and closes cleanly", async () => {
    const start = vi.spyOn(AppStackObserverService.prototype, "startBackgroundLoop");
    const stop = vi.spyOn(AppStackObserverService.prototype, "stop");
    const app = await boot({ seedPhase1: true });
    expect(app.runtimeBackend).toBe("disabled");
    const observer = app.nestApp.get(AppStackObserverService);
    expect(start).toHaveBeenCalledOnce();
    expect(start.mock.contexts[0]).toBe(observer);
    expect(stop).not.toHaveBeenCalled();

    const { templates, versions } = await builtIns();
    expect(templates.map((t) => [t.id, t.builtIn, t.enabled, t.defaultVersionId])).toEqual([
      ["atpl_http_cache", true, false, "atv_http_cache_1"],
      ["atpl_mariadb", true, false, "atv_mariadb_1"],
      ["atpl_postgresql", true, false, "atv_postgresql_1"],
      ["atpl_valkey", true, false, "atv_valkey_1"],
      ["atpl_wordpress_mariadb", true, false, "atv_wordpress_mariadb_1"],
      ["atpl_worker_storage", true, false, "atv_worker_storage_1"],
    ]);
    expect(versions.map((v) => v.id)).toEqual([
      "atv_http_cache_1",
      "atv_mariadb_1",
      "atv_postgresql_1",
      "atv_valkey_1",
      "atv_wordpress_mariadb_1",
      "atv_worker_storage_1",
    ]);

    await expect(app.close()).resolves.toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
    expect(stop.mock.contexts[0]).toBe(observer);
  });

  it("a second boot on the same database changes nothing in the built-in templates", async () => {
    const before = await builtIns();
    const app = await boot();
    try {
      expect(await builtIns()).toEqual(before);
    } finally {
      await app.close();
    }
  });

  it("repairs a busy stack without an active operation to failed at boot and leaves a settled one alone", async () => {
    const busy = newAppEntityId("stk");
    const settled = newAppEntityId("stk");
    for (const [id, status] of [
      [busy, "deploying"],
      [settled, "running"],
    ] as const) {
      await db().insert(appStacks).values({
        id,
        organizationId: DEMO_IDS.organizations.acme,
        hostAllocationId: DEMO_IDS.allocations.acme,
        templateId: "atpl_http_cache",
        templateVersionId: "atv_http_cache_1",
        name: id,
        status,
      });
    }
    const app = await boot();
    try {
      const rows = await db()
        .select({ id: appStacks.id, status: appStacks.status })
        .from(appStacks)
        .where(inArray(appStacks.id, [busy, settled]));
      expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [busy]: "failed", [settled]: "running" });
    } finally {
      await app.close();
    }
  });

  it("site log reads use the app's one LogReadGate", async () => {
    const app = await boot({
      runtimeBackend: "local-simulator",
      dockerExecutor: new InMemoryDockerSimulatorAdapter() as DockerExecutorPort,
      recoverUnknownOnStart: false,
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = app.nestApp.get(LogReadGate);
    const holds = [1, 2].map(() => gate.run(DEMO_IDS.organizations.acme, () => held));
    try {
      await expect(
        app.nestApp.get(ManagedSitesService).logs(DEMO_IDS.sites.acmeShop, DEMO_IDS.organizations.acme, 200),
      ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    } finally {
      release();
      await Promise.all(holds);
      await app.close();
    }
  });
});
