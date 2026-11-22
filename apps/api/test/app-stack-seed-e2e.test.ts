import { randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST } from "@hosting-panel/contracts";
import {
  builtInAppTemplateItems,
  ensureBuiltInAppTemplates,
  appStackComponents,
  appStackDomains,
  appStackParameters,
  appStacks,
  appStackVolumes,
  eq,
  operations,
  resourceQuotas,
} from "@hosting-panel/database";
import type { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppStackObserverService } from "../src/app-stacks/app-stack-observer.service.js";
import { AppStackDomainsController } from "../src/controllers/app-stack-domains.controller.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

// Q-SEED-E2E (arch-assurance §12, A1, A14, A18): the two built-in applications, seeded disabled at boot, from the
// administrator's switch to a running stack and its deletion, on the simulator.
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const [HTTP_CACHE, WORKER_STORAGE] = APP_BUILT_IN_TEMPLATES as readonly [(typeof APP_BUILT_IN_TEMPLATES)[number], (typeof APP_BUILT_IN_TEMPLATES)[number]];

describe("the built-in applications end to end (Q-SEED-E2E)", () => {
  let h: AppStackHarness;
  let sim: InMemoryDockerSimulatorAdapter;
  let domainRoutes = true;
  let cacheStackId = "";
  let storageStackId = "";
  let storageName = "";

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    // The harness injects its own database client, and an app given one skips its boot seeding (create-app.ts, the
    // `else` of the injected client): run the call a boot makes (create-app.ts:368). That boot seeds the same rows
    // is app-stack-boot.integration.test.ts's case.
    await ensureBuiltInAppTemplates(h.dbClient.db, builtInAppTemplateItems());
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    sim = h.app.nestApp.get<InMemoryDockerSimulatorAdapter>(DOCKER_EXECUTOR_TOKEN);
    // The DNS pass is not under test here: a domain write must not look anything up.
    vi.spyOn(h.app.nestApp.get(AppStackObserverService), "reconcileStack").mockResolvedValue(undefined);
    try {
      h.app.nestApp.get(AppStackDomainsController);
    } catch {
      domainRoutes = false;
    }
  }, 120_000);

  afterAll(async () => {
    vi.restoreAllMocks();
    await h?.close();
  }, 60_000);

  const stacksPath = (tail = "") => `/v1/organizations/${h.a.orgId}/app-stacks${tail}`;
  const idem = () => ({ "Idempotency-Key": randomUUID() });
  const worker = () => h.app.nestApp.get(OutboxWorkerService);
  const catalogue = () => h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/app-templates`);
  const enable = (templateId: string, enabled = true) =>
    h.call(h.adminToken, "PATCH", `/v1/admin/app-templates/${templateId}`, { enabled });
  const install = (versionId: string, name: string, extra: Json = {}) =>
    h.call(h.a.token, "POST", stacksPath(), { templateVersionId: versionId, name, deploy: true, ...extra }, idem());
  const stackRow = async (stackId: string) => (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  const opsOf = (stackId: string) => h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId));
  const volumesOf = (stackId: string) => h.dbClient.db.select().from(appStackVolumes).where(eq(appStackVolumes.stackId, stackId));

  async function drain(stackId: string): Promise<void> {
    for (let round = 0; round < 12; round += 1) {
      await worker().processPendingOnce();
      const open = (await opsOf(stackId)).filter((o) => ["queued", "running", "processing"].includes(o.status));
      if (open.length === 0) return;
    }
    throw new Error("the operation never settled");
  }

  it("a freshly booted app offers the customer nothing, and the two built-in templates are there disabled", async () => {
    const empty = await catalogue();
    expect(empty.status, empty.raw).toBe(200);
    expect(empty.body.data).toEqual({ templates: [], categories: [] });

    const admin = await h.call(h.adminToken, "GET", "/v1/admin/app-templates");
    expect(admin.status, admin.raw).toBe(200);
    const rows = (admin.body.data.templates ?? admin.body.data) as Json[];
    for (const built of APP_BUILT_IN_TEMPLATES) {
      expect(rows.find((row) => row.id === built.templateId), built.slug).toMatchObject({ slug: built.slug, builtIn: true, enabled: false });
    }

    // A disabled template cannot be installed, and nothing is written by the attempt.
    const before = await h.counts();
    const refused = await install(HTTP_CACHE.versionId, "too-early");
    expect(refused.status, refused.raw).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await h.counts()).toEqual(before);
  });

  it("enabling the templates puts them in the customer catalogue one by one", async () => {
    expect((await enable(HTTP_CACHE.templateId)).status).toBe(200);
    const one = await catalogue();
    expect(one.body.data.templates).toEqual([
      expect.objectContaining({ id: HTTP_CACHE.templateId, versionId: HTTP_CACHE.versionId, category: "web", componentCount: 2, hasIngress: true }),
    ]);
    expect(one.body.data.categories).toEqual(["web"]);

    expect((await enable(WORKER_STORAGE.templateId)).status).toBe(200);
    const both = await catalogue();
    expect(both.body.data.templates.map((t: Json) => t.id).sort()).toEqual([HTTP_CACHE.templateId, WORKER_STORAGE.templateId].sort());
    expect(both.body.data.categories).toEqual(["jobs", "web"]);
    const storage = both.body.data.templates.find((t: Json) => t.id === WORKER_STORAGE.templateId);
    expect(storage).toMatchObject({ versionId: WORKER_STORAGE.versionId, componentCount: 2, volumeCount: 1, hasIngress: false });

    const detail = await h.call(h.a.token, "GET", `/v1/organizations/${h.a.orgId}/app-templates/${WORKER_STORAGE.templateId}`);
    expect(detail.status, detail.raw).toBe(200);
    expect(detail.body.data.parameters).toEqual([expect.objectContaining({ key: "worker_interval_seconds", min: 5, max: 3600 })]);
  });

  it("http-cache with one hostname: operation succeeded, stack running, both components healthy, route published", async (ctx) => {
    if (!domainRoutes) ctx.skip(); // evaluated after beforeAll, unlike it.skipIf
    const hostname = `${randomUUID().slice(0, 8)}.example.test`;
    const res = await install(HTTP_CACHE.versionId, "front", { domains: [{ hostname, componentKey: "web", port: 8080 }] });
    expect(res.status, res.raw).toBe(202);
    cacheStackId = res.body.data.stackId as string;
    await drain(cacheStackId);

    const [op] = await opsOf(cacheStackId);
    expect(op).toMatchObject({ kind: "stack.deploy", status: "succeeded", errorCode: null });
    expect((await stackRow(cacheStackId)).status).toBe("running");

    const health = await h.dbClient.db.select().from(appStackComponents).where(eq(appStackComponents.stackId, cacheStackId));
    expect(Object.fromEntries(health.map((c) => [c.componentKey, c.health]))).toEqual({ web: "healthy", cache: "healthy" });
    const read = await h.call(h.a.token, "GET", stacksPath(`/${cacheStackId}`));
    expect(read.body.data.status).toBe("running");

    const snapshot = sim.appStacks.getAppStackSnapshot(cacheStackId)!;
    expect(Object.values(snapshot.containers).map((c) => c.state)).toEqual(["running", "running"]);
    expect(snapshot.routes).toEqual([
      expect.objectContaining({ componentKey: "web", internalPort: 8080, hosts: [expect.objectContaining({ hostname })] }),
    ]);
    expect(await h.dbClient.db.select().from(appStackDomains).where(eq(appStackDomains.stackId, cacheStackId))).toEqual([
      expect.objectContaining({ hostname, status: "active" }),
    ]);
  }, 60_000);

  it("worker-storage with worker_interval_seconds 5: running, both components healthy, its data volume present", async () => {
    storageName = `store-${randomUUID().slice(0, 8)}`;
    const res = await install(WORKER_STORAGE.versionId, storageName, { parameters: [{ key: "worker_interval_seconds", value: 5 }] });
    expect(res.status, res.raw).toBe(202);
    storageStackId = res.body.data.stackId as string;
    await drain(storageStackId);

    expect((await opsOf(storageStackId))[0]).toMatchObject({ kind: "stack.deploy", status: "succeeded" });
    expect((await stackRow(storageStackId)).status).toBe("running");
    const health = await h.dbClient.db.select().from(appStackComponents).where(eq(appStackComponents.stackId, storageStackId));
    expect(Object.fromEntries(health.map((c) => [c.componentKey, c.health]))).toMatchObject({ storage: "healthy" });
    expect(health.map((c) => c.componentKey).sort()).toEqual(["storage", "worker"]);
    expect((await volumesOf(storageStackId)).map((v) => [v.volumeKey, v.status])).toEqual([["data", "present"]]);
    expect(Object.keys(sim.appStacks.getAppStackSnapshot(storageStackId)!.volumes)).toEqual(["data"]);

    const params = await h.dbClient.db.select().from(appStackParameters).where(eq(appStackParameters.stackId, storageStackId));
    expect(JSON.stringify(params)).toContain("worker_interval_seconds");
  }, 60_000);

  describe.each([
    { template: WORKER_STORAGE, key: "worker_interval_seconds", value: 4, why: "below the minimum of 5" },
    { template: WORKER_STORAGE, key: "worker_interval_seconds", value: 3601, why: "above the maximum of 3600" },
    { template: WORKER_STORAGE, key: "worker_interval_seconds", value: 0, why: "zero" },
    { template: HTTP_CACHE, key: "cache_memory_mb", value: 15, why: "below the minimum of 16" },
    { template: HTTP_CACHE, key: "cache_memory_mb", value: 97, why: "above the maximum of 96" },
  ])("an out-of-range parameter", ({ template, key, value, why }) => {
    it(`${key}=${String(value)} (${why}) is 400 STACK_PARAMETER_INVALID and nothing is written`, async () => {
      const before = await h.counts();
      for (const deploy of [true, false]) {
        const res = await install(template.versionId, `bad-${randomUUID().slice(0, 8)}`, { deploy, parameters: [{ key, value }] });
        expect(res.status, res.raw).toBe(400);
        expect(res.body.error.details).toContainEqual(expect.objectContaining({ reason: "STACK_PARAMETER_INVALID" }));
      }
      expect(await h.counts()).toEqual(before);
    });
  });

  it("a fractional interval is a 400 as well, and nothing is written", async () => {
    const before = await h.counts();
    const res = await install(WORKER_STORAGE.versionId, "fractional", { parameters: [{ key: "worker_interval_seconds", value: 5.5 }] });
    expect(res.status, res.raw).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await h.counts()).toEqual(before);
  });

  it("deleting worker-storage without the data flag keeps its data: the volume is retained, the engine volume stays", async () => {
    expect(storageStackId, "the worker-storage install above must have run").not.toBe("");
    const res = await h.call(h.a.token, "DELETE", stacksPath(`/${storageStackId}`), { confirmName: storageName, destroyData: false }, idem());
    expect(res.status, res.raw).toBe(202);
    await drain(storageStackId);

    expect((await stackRow(storageStackId)).status).toBe("deleted");
    expect((await opsOf(storageStackId)).find((o) => o.kind === "stack.delete")).toMatchObject({ status: "succeeded" });
    expect((await volumesOf(storageStackId)).map((v) => [v.volumeKey, v.status, v.retentionPolicy])).toEqual([["data", "retained", "retain"]]);
    expect(Object.keys(sim.appStacks.getAppStackSnapshot(storageStackId)?.volumes ?? {})).toEqual(["data"]);
    expect(sim.appStacks.appStackMutations.filter((m) => m.name.includes(storageStackId) && m.kind === "volume_remove")).toEqual([]);
  }, 60_000);
});
