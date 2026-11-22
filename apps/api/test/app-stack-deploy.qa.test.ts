import { randomUUID } from "node:crypto";
import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST } from "@hosting-panel/contracts";
import {
  appStackComponents,
  appStackDeployments,
  appStackDomains,
  appStacks,
  appStackVolumes,
  asc,
  eq,
  operations,
  operationSteps,
  resourceQuotas,
} from "@hosting-panel/database";
import type { AppStackSimFault, AppStackSimStep, InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AppStackObserverService } from "../src/app-stacks/app-stack-observer.service.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import { DOCKER_EXECUTOR_TOKEN } from "../src/tokens.js";
import { APP_TEST_ALLOWLIST, startAppStackHarness, type AppStackHarness } from "./fixtures/app-stack-harness.js";

// Images of the code allowlist only: the runtime refuses anything else at its validate step.
const WEB_SOURCE = APP_BUILT_IN_TEMPLATES[0]!.source;
/** The same site, but the cache is an accessory: nothing depends on it and it is not the web address target. */
const WEB_ACCESSORY_SOURCE = WEB_SOURCE.replace("    depends_on:\n      - cache\n", "");
const STORAGE_SOURCE = APP_BUILT_IN_TEMPLATES[1]!.source;
const BUDGET_MS = 10 * 60_000;
const POLL_MS = 5_000;

const STEP_TEXT: Readonly<Record<string, string>> = {
  validate: "Request checked",
  reserve: "Resources reserved",
  pull: "Software downloaded",
  prepare: "Environment ready",
  create: "Components ready",
  start: "Components started",
  health: "Application ready",
  publish: "Web addresses published",
};
const DEPLOY_STEPS = Object.keys(STEP_TEXT);

describe("application stacks deploy end to end on the simulator (Q1: A14, A15, B5)", () => {
  let h: AppStackHarness;
  let sim: InMemoryDockerSimulatorAdapter;
  let web: string;
  let accessory: string;
  let storage: string;
  let skew = 0;
  let realNow: () => number;

  beforeAll(async () => {
    h = await startAppStackHarness({ allowlist: [...APP_TEST_ALLOWLIST, ...APP_IMAGE_ALLOWLIST] });
    await h.dbClient.db
      .update(resourceQuotas)
      .set({ maxServices: 1000, maxCpuMilli: 1_000_000, maxMemoryBytes: String(2 ** 50) })
      .where(eq(resourceQuotas.organizationId, h.a.orgId));
    sim = h.app.nestApp.get<InMemoryDockerSimulatorAdapter>(DOCKER_EXECUTOR_TOKEN);
    web = (await h.publish(WEB_SOURCE)).versionId;
    accessory = (await h.publish(WEB_ACCESSORY_SOURCE)).versionId;
    storage = (await h.publish(STORAGE_SOURCE)).versionId;
    // The DNS pass is not under test here: a domain write must not look anything up.
    vi.spyOn(h.app.nestApp.get(AppStackObserverService), "reconcileStack").mockResolvedValue(undefined);
    realNow = Date.now.bind(Date);
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
    skew = 0;
  });

  afterAll(async () => {
    await h?.close();
  });

  const orgPath = (verb = "") => `/v1/organizations/${h.a.orgId}/app-stacks${verb}`;
  const worker = () => h.app.nestApp.get(OutboxWorkerService);
  const snapshot = (stackId: string) => sim.appStacks.getAppStackSnapshot(stackId);

  async function create(templateVersionId: string, deploy: boolean, customer = h.a): Promise<string> {
    const res = await h.call(
      customer.token,
      "POST",
      `/v1/organizations/${customer.orgId}/app-stacks`,
      { templateVersionId, name: `app-${randomUUID().slice(0, 8)}`, deploy },
      { "Idempotency-Key": randomUUID() },
    );
    expect(res.status, res.raw).toBe(deploy ? 202 : 201);
    return res.body.data.stackId as string;
  }

  /** A hostname is unique across the panel: every test gets its own. */
  async function addHost(stackId: string, componentKey = "web"): Promise<string> {
    const hostname = `${randomUUID().slice(0, 8)}.example.test`;
    const res = await h.call(h.a.token, "POST", orgPath(`/${stackId}/domains`), { hostname, componentKey, port: 8080 });
    expect(res.status, res.raw).toBe(201);
    return hostname;
  }

  const deploy = (stackId: string) => h.call(h.a.token, "POST", orgPath(`/${stackId}/deploy`), {}, { "Idempotency-Key": randomUUID() });

  /** The worker until no operation of the stack is open. */
  async function drain(stackId: string): Promise<void> {
    for (let round = 0; round < 10; round += 1) {
      await worker().processPendingOnce();
      const open = (await h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId))).filter((o) =>
        ["queued", "running"].includes(o.status),
      );
      if (open.length === 0) return;
    }
    throw new Error("the operation never settled");
  }

  /** The health budget (10 minutes) and its 5 s waits pass in microseconds: only the runtime's clock reads Date.now. */
  function virtualTime(): void {
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number, ...args: unknown[]) => {
      if (ms === POLL_MS) {
        skew += POLL_MS;
        return originalSetTimeout(fn, 0, ...args);
      }
      return originalSetTimeout(fn, ms, ...args);
    }) as typeof setTimeout);
  }

  async function stackRow(stackId: string) {
    return (await h.dbClient.db.select().from(appStacks).where(eq(appStacks.id, stackId)))[0]!;
  }
  const deployments = (stackId: string) =>
    h.dbClient.db.select().from(appStackDeployments).where(eq(appStackDeployments.stackId, stackId)).orderBy(asc(appStackDeployments.startedAt));
  const opsOf = (stackId: string) =>
    h.dbClient.db.select().from(operations).where(eq(operations.resourceId, stackId)).orderBy(asc(operations.submittedAt));
  async function stepsOf(operationId: string): Promise<Record<string, { status: string; message: string | null }>> {
    const rows = await h.dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, operationId));
    return Object.fromEntries(rows.map((r) => [r.key, { status: r.status, message: r.message }]));
  }
  async function healthOf(stackId: string): Promise<Record<string, string>> {
    const rows = await h.dbClient.db.select().from(appStackComponents).where(eq(appStackComponents.stackId, stackId));
    return Object.fromEntries(rows.map((r) => [r.componentKey, r.health]));
  }
  const domainRows = (stackId: string) => h.dbClient.db.select().from(appStackDomains).where(eq(appStackDomains.stackId, stackId));
  const volumeRows = (stackId: string) => h.dbClient.db.select().from(appStackVolumes).where(eq(appStackVolumes.stackId, stackId));
  /** What the simulator did to one stack, in order: "kind:name". */
  const mutationsOf = (stackId: string) =>
    sim.appStacks.appStackMutations.filter((m) => m.name.includes(stackId)).map((m) => `${m.kind}:${m.name}`);
  const routeWrites = (stackId: string) => mutationsOf(stackId).filter((m) => m.startsWith("route_write:"));
  const calls = (stackId: string) => sim.appStacks.appStackCalls.filter((c) => c.stackId === stackId);

  /** One consistent failed deployment: every row of the three tables tells the same story. */
  async function expectFailedRows(stackId: string, failedStep: string, problem: string, code: string, text: string): Promise<void> {
    expect(await stackRow(stackId)).toMatchObject({ status: "failed" });
    const [dep] = await deployments(stackId);
    expect(dep).toMatchObject({ status: "failed", problem });
    expect(dep!.endedAt).not.toBeNull();
    const [op] = await opsOf(stackId);
    expect(op).toMatchObject({ kind: "stack.deploy", status: "failed", errorCode: code, errorMessage: text });
    expect(dep!.operationId).toBe(op!.id);
    const steps = await stepsOf(op!.id);
    // Exactly one step failed, the ones before it succeeded, the ones after it were skipped; none is left open.
    const order = Object.keys(steps).sort((a, b) => DEPLOY_STEPS.concat("settle").indexOf(a) - DEPLOY_STEPS.concat("settle").indexOf(b));
    const at = order.indexOf(failedStep);
    expect(at).toBeGreaterThanOrEqual(0);
    for (const [i, key] of order.entries()) {
      expect(steps[key]!.status, `step ${key}`).toBe(i < at ? "succeeded" : i === at ? "failed" : "skipped");
    }
    expect(steps[failedStep]!.message).toBe("Could not finish this step");
  }

  it("A14: create and deploy through HTTP ends running, and the route file has the host only once the target is healthy", async () => {
    const stackId = await create(web, false);
    const host = await addHost(stackId);
    const queued = await deploy(stackId);
    expect(queued.status, queued.raw).toBe(202);
    expect(snapshot(stackId)).toBeNull();

    // Witness the moment of publication: what the simulator held when the route call arrived (the design flips the
    // address to active just before the call, and only for a target that is ready).
    const atPublish: { web?: string; cache?: string; routes?: unknown[]; domain?: string } = {};
    const original = sim.appStacks.publishAppStackRoutes.bind(sim.appStacks);
    vi.spyOn(sim.appStacks, "publishAppStackRoutes").mockImplementation(async (req) => {
      const before = snapshot(stackId)!;
      atPublish.web = before.containers.web?.state;
      atPublish.cache = before.containers.cache?.state;
      atPublish.routes = before.routes;
      atPublish.domain = (await domainRows(stackId))[0]!.status;
      return original(req);
    });

    await drain(stackId);

    expect(atPublish).toEqual({ web: "running", cache: "running", routes: [], domain: "active" });
    const row = await stackRow(stackId);
    expect(row.status).toBe("running");
    expect(row.appliedRevisionId).not.toBeNull();
    expect(row.appliedRevisionId).toBe(row.desiredRevisionId);
    expect(row.appliedRoutesHash).not.toBeNull();
    expect(snapshot(stackId)!.routes).toEqual([
      expect.objectContaining({ componentKey: "web", internalPort: 8080, hosts: [expect.objectContaining({ hostname: host })] }),
    ]);
    expect(await domainRows(stackId)).toEqual([expect.objectContaining({ hostname: host, status: "active" })]);

    // The simulator's own order: the dependency starts first, the web address comes last and exactly once.
    const mutations = mutationsOf(stackId);
    const startOf = (key: string) => mutations.findIndex((m) => m.startsWith("container_start:") && m.includes(`_${key}`));
    expect(startOf("cache")).toBeGreaterThanOrEqual(0);
    expect(startOf("cache")).toBeLessThan(startOf("web"));
    expect(startOf("web")).toBeLessThan(mutations.findIndex((m) => m.startsWith("route_write:")));
    expect(mutations.at(-1)).toBe(`route_write:app_${stackId}.yml`);
    expect(routeWrites(stackId)).toHaveLength(1);

    const [dep] = await deployments(stackId);
    expect(dep).toMatchObject({ status: "succeeded", problem: null, revisionId: row.appliedRevisionId });
    const [op] = await opsOf(stackId);
    expect(op).toMatchObject({ status: "succeeded", errorCode: null });
    const steps = await stepsOf(op!.id);
    for (const key of DEPLOY_STEPS) expect(steps[key], key).toEqual({ status: "succeeded", message: STEP_TEXT[key] });
    expect(await healthOf(stackId)).toEqual({ web: "healthy", cache: "healthy" });

    // What the customer reads agrees with the rows.
    const read = await h.call(h.a.token, "GET", orgPath(`/${stackId}`));
    expect(read.status, read.raw).toBe(200);
    expect(read.body.data.status).toBe("running");
    const listed = await h.call(h.a.token, "GET", orgPath(`/${stackId}/deployments`));
    expect(listed.status, listed.raw).toBe(200);
    expect(listed.body.data).toEqual([expect.objectContaining({ status: "succeeded", problem: null })]);
  });

  it("A14: with no web address the deploy still ends running and no route is written", async () => {
    const stackId = await create(web, true);
    await drain(stackId);
    expect((await stackRow(stackId)).status).toBe("running");
    expect((await stackRow(stackId)).appliedRoutesHash).toBeNull();
    expect(calls(stackId).map((c) => c.method)).not.toContain("publishAppStackRoutes");
    expect(snapshot(stackId)!.routes).toEqual([]);
    const [op] = await opsOf(stackId);
    expect((await stepsOf(op!.id)).publish).toEqual({ status: "succeeded", message: "No web address to publish" });
  });

  describe("A15: a component that stays unhealthy", () => {
    it("a dependency that never gets healthy: the dependent never starts, the stack is failed, the route is never published", async () => {
      virtualTime();
      const stackId = await create(web, false);
      const host = await addHost(stackId);
      sim.appStacks.setAppStackComponentProbe(stackId, "cache", "failed");
      expect((await deploy(stackId)).status).toBe(202);
      await drain(stackId);

      // The wait took the whole budget (and not a second less), as the clock of the runtime saw it.
      expect(skew).toBeGreaterThanOrEqual(BUDGET_MS);
      expect(skew).toBeLessThan(BUDGET_MS + 2 * POLL_MS);
      await expectFailedRows(
        stackId,
        "health",
        "STACK_HEALTH_TIMEOUT",
        "DOCKER_ENGINE_UNAVAILABLE",
        "The application did not become ready in time. Check its logs and try again.",
      );
      const mutations = mutationsOf(stackId);
      expect(mutations.some((m) => m.startsWith("container_start:") && m.includes("_web"))).toBe(false);
      expect(mutations.some((m) => m.startsWith("route_write:"))).toBe(false);
      expect(calls(stackId).map((c) => c.method)).not.toContain("publishAppStackRoutes");
      expect(snapshot(stackId)!.routes).toEqual([]);
      expect(snapshot(stackId)!.containers.web!.state).toBe("created");
      // Containers are kept for their logs; the truth about each one is recorded.
      expect(Object.keys(snapshot(stackId)!.containers).sort()).toEqual(["cache", "web"]);
      const health = await healthOf(stackId);
      expect(health.cache).toBe("unhealthy");
      expect(health.web).not.toBe("healthy");
      expect(await domainRows(stackId)).toEqual([expect.objectContaining({ hostname: host, status: "pending" })]);
      const read = await h.call(h.a.token, "GET", orgPath(`/${stackId}`));
      expect(read.body.data.status).toBe("failed");
    });

    it("the web address target itself never gets healthy: failed, and the host never reaches the route file", async () => {
      virtualTime();
      const stackId = await create(accessory, false);
      await addHost(stackId);
      sim.appStacks.setAppStackComponentProbe(stackId, "web", "failed");
      expect((await deploy(stackId)).status).toBe(202);
      await drain(stackId);

      expect(skew).toBeGreaterThanOrEqual(BUDGET_MS);
      await expectFailedRows(
        stackId,
        "health",
        "STACK_HEALTH_TIMEOUT",
        "DOCKER_ENGINE_UNAVAILABLE",
        "The application did not become ready in time. Check its logs and try again.",
      );
      expect(routeWrites(stackId)).toEqual([]);
      expect(snapshot(stackId)!.routes).toEqual([]);
      expect((await healthOf(stackId)).web).toBe("unhealthy");
      expect((await domainRows(stackId))[0]!.status).toBe("pending");
    });

    it("an accessory that stays unhealthy: degraded and truthful, and the healthy target is published", async () => {
      virtualTime();
      const stackId = await create(accessory, false);
      const host = await addHost(stackId);
      sim.appStacks.setAppStackComponentProbe(stackId, "cache", "failed");
      expect((await deploy(stackId)).status).toBe(202);
      await drain(stackId);

      expect(skew).toBeGreaterThanOrEqual(BUDGET_MS);
      const row = await stackRow(stackId);
      expect(row.status).toBe("degraded");
      expect(row.appliedRevisionId).toBe(row.desiredRevisionId);
      const [dep] = await deployments(stackId);
      expect(dep).toMatchObject({ status: "succeeded", problem: "STACK_HEALTH_TIMEOUT" });
      expect((await opsOf(stackId))[0]).toMatchObject({ status: "succeeded" });
      expect(await healthOf(stackId)).toEqual({ web: "healthy", cache: "unhealthy" });
      expect(snapshot(stackId)!.routes).toEqual([expect.objectContaining({ componentKey: "web", hosts: [expect.objectContaining({ hostname: host })] })]);
      expect((await domainRows(stackId))[0]!.status).toBe("active");
      const read = await h.call(h.a.token, "GET", orgPath(`/${stackId}`));
      expect(read.body.data.status).toBe("degraded");
    });

    it("once the dependency recovers, a new deploy of the failed stack reaches running and only then publishes", async () => {
      virtualTime();
      const stackId = await create(web, false);
      const host = await addHost(stackId);
      sim.appStacks.setAppStackComponentProbe(stackId, "cache", "failed");
      expect((await deploy(stackId)).status).toBe(202);
      await drain(stackId);
      expect((await stackRow(stackId)).status).toBe("failed");
      expect(routeWrites(stackId)).toEqual([]);

      sim.appStacks.setAppStackComponentProbe(stackId, "cache", "passed");
      const again = await deploy(stackId);
      expect(again.status, again.raw).toBe(202);
      await drain(stackId);
      expect((await stackRow(stackId)).status).toBe("running");
      const mutations = mutationsOf(stackId);
      expect(routeWrites(stackId)).toHaveLength(1);
      expect(mutations.findIndex((m) => m.startsWith("container_start:") && m.includes("_web"))).toBeLessThan(
        mutations.findIndex((m) => m.startsWith("route_write:")),
      );
      expect((await deployments(stackId)).map((d) => d.status)).toEqual(["failed", "succeeded"]);
      expect(snapshot(stackId)!.routes).toEqual([expect.objectContaining({ hosts: [expect.objectContaining({ hostname: host })] })]);
      expect(await healthOf(stackId)).toEqual({ web: "healthy", cache: "healthy" });
    });
  });

  describe("B5: faults of the engine, step by step", () => {
    // [where the simulator fails, the fault, the first step that must be failed, the mutations that must not have happened]
    const FAULTS: readonly (readonly [AppStackSimStep, AppStackSimFault, string, readonly string[]])[] = [
      ["pull", "pull_failed", "pull", ["pull", "network", "volume", "container_create", "container_start", "route_write"]],
      ["prepare", "engine_unavailable", "prepare", ["network", "volume", "container_create", "container_start", "route_write"]],
      ["create", "engine_unavailable", "create", ["container_create", "container_start", "route_write"]],
      ["start", "engine_unavailable", "start", ["route_write"]],
    ];

    it.each(FAULTS)("a fault at %s (%s): a consistent failed stack, deployment and steps; nothing else touched", async (at, fault, failedStep, absent) => {
      // Another stack of the same customer and one of another customer are running and must not notice.
      const other = await create(storage, true);
      const foreign = await create(web, true, h.b);
      await drain(other);
      await drain(foreign);
      expect((await stackRow(other)).status).toBe("running");
      expect((await stackRow(foreign)).status).toBe("running");
      const otherBefore = { snap: snapshot(other), muts: mutationsOf(other), calls: calls(other).length };
      const foreignBefore = { snap: snapshot(foreign), muts: mutationsOf(foreign), calls: calls(foreign).length };

      const stackId = await create(storage, false);
      sim.appStacks.failNextAppStackStep(at, fault);
      expect((await deploy(stackId)).status).toBe(202);
      await drain(stackId);

      await expectFailedRows(
        stackId,
        failedStep,
        "DOCKER_ENGINE_UNAVAILABLE",
        "DOCKER_ENGINE_UNAVAILABLE",
        "The server could not finish this action. Try again in a few minutes.",
      );
      const kinds = mutationsOf(stackId).map((m) => m.split(":")[0]);
      for (const kind of absent) expect(kinds, `no ${kind}`).not.toContain(kind);
      // The step after the failed one never ran.
      const methods = calls(stackId).map((c) => c.method);
      expect(methods).not.toContain("publishAppStackRoutes");
      expect(methods.at(-1)).not.toBe("getAppStackStatus");
      // The simulator's fault was consumed by this deploy and by nothing else.
      expect(calls(stackId).filter((c) => c.method !== "getAppStackStatus").length).toBeGreaterThan(0);

      // Nothing of another stack, of the same or of another customer, moved.
      expect({ snap: snapshot(other), muts: mutationsOf(other), calls: calls(other).length }).toEqual(otherBefore);
      expect({ snap: snapshot(foreign), muts: mutationsOf(foreign), calls: calls(foreign).length }).toEqual(foreignBefore);
      expect((await stackRow(other)).status).toBe("running");
      expect((await stackRow(foreign)).status).toBe("running");

      // A deploy that failed before it created anything applies nothing.
      const row = await stackRow(stackId);
      if (["pull", "prepare", "create"].includes(failedStep)) expect(row.appliedRevisionId).toBeNull();
      expect(row.desiredRevisionId).not.toBeNull();
      expect(row.deletedAt).toBeNull();
    });

    it("a pull that fails leaves the volume rows reserved, not present, and the engine without a volume or a network", async () => {
      const stackId = await create(storage, false);
      sim.appStacks.failNextAppStackStep("pull", "pull_failed");
      expect((await deploy(stackId)).status).toBe(202);
      await drain(stackId);
      expect((await volumeRows(stackId)).map((v) => [v.volumeKey, v.status])).toEqual([["data", "pending"]]);
      expect(snapshot(stackId)).toBeNull();
    });

    it("data is kept when the health wait times out, and the next deploy reuses the same volume", async () => {
      virtualTime();
      const stackId = await create(storage, false);
      sim.appStacks.setAppStackComponentProbe(stackId, "storage", "failed");
      expect((await deploy(stackId)).status).toBe(202);
      await drain(stackId);

      await expectFailedRows(
        stackId,
        "health",
        "STACK_HEALTH_TIMEOUT",
        "DOCKER_ENGINE_UNAVAILABLE",
        "The application did not become ready in time. Check its logs and try again.",
      );
      expect((await volumeRows(stackId)).map((v) => [v.volumeKey, v.status, v.retentionPolicy])).toEqual([["data", "present", "retain"]]);
      const volume = snapshot(stackId)!.volumes.data!;
      expect(volume).toBeDefined();
      expect(mutationsOf(stackId).filter((m) => m.startsWith("volume_remove:"))).toEqual([]);
      expect(mutationsOf(stackId).filter((m) => m.startsWith("volume:"))).toHaveLength(1);

      sim.appStacks.setAppStackComponentProbe(stackId, "storage", "passed");
      expect((await deploy(stackId)).status).toBe(202);
      await drain(stackId);
      expect((await stackRow(stackId)).status).toBe("running");
      expect(snapshot(stackId)!.volumes.data).toEqual(volume);
      expect(mutationsOf(stackId).filter((m) => m.startsWith("volume:"))).toHaveLength(1);
      expect(await healthOf(stackId)).toEqual({ storage: "healthy", worker: "healthy" });
    });

    it("a network failure after the containers exist keeps them and the volume, and the stack is failed with its web address unpublished", async () => {
      const stackId = await create(accessory, false);
      const host = await addHost(stackId);
      // The route write itself fails: the containers are healthy, the stack is told as degraded and the host is not in the file.
      sim.appStacks.failNextAppStackStep("routes", "engine_unavailable");
      expect((await deploy(stackId)).status).toBe(202);
      await drain(stackId);

      const [op] = await opsOf(stackId);
      expect(op).toMatchObject({ status: "failed", errorCode: "DOCKER_ENGINE_UNAVAILABLE" });
      const [dep] = await deployments(stackId);
      expect(dep).toMatchObject({ status: "failed", problem: "DOCKER_ENGINE_UNAVAILABLE" });
      const steps = await stepsOf(op!.id);
      expect(steps.publish!.status).toBe("failed");
      expect(steps.health!.status).toBe("succeeded");
      expect((await stackRow(stackId)).status).toBe("degraded");
      expect(routeWrites(stackId)).toEqual([]);
      expect(snapshot(stackId)!.routes).toEqual([]);
      expect(Object.values(snapshot(stackId)!.containers).map((c) => c.state)).toEqual(["running", "running"]);
      expect((await domainRows(stackId))[0]!.hostname).toBe(host);
    });
  });
});
