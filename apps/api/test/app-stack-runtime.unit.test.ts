import { createHash, randomBytes } from "node:crypto";
import {
  APP_STACK_STEPS_BY_KIND,
  ApprovedStackPlanSchema,
  type AppStackOperationKind,
  type AppStackPlanComponent,
  type AppStackRouteWire,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import {
  addAppStackDomainsTransactional,
  appStackComponents,
  appStackDeployments,
  appStackDomains,
  appStackRevisions,
  appStacks,
  appStackSecrets,
  appStackVolumes,
  createAppStackTransactional,
  createAppTemplate,
  createDatabaseClient,
  enqueueAppStackOperationTransactional,
  enqueueAppStackResumeTransactional,
  eq,
  hostAllocations,
  hosts,
  newAppEntityId,
  operations,
  operationSteps,
  organizations,
  platformInstallations,
  setAppStackSecretTransactional,
  sql,
  transitionOperation,
  updateAppTemplate,
  type AppStackWriteResult,
  type DatabaseClient,
  type NewAppStackRevision,
} from "@hosting-panel/database";
import { Phase1DisabledDockerExecutor, type DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { computeAppStackComponentHash, computeAppStackPlanHash } from "@hosting-panel/hosting-domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppStackRuntime } from "../src/app-stacks/app-stack-runtime.js";
import {
  APP_STACK_FAILURE,
  APP_STACK_HEALTH_BUDGET_MS,
  APP_STACK_NO_ADDRESS_TEXT,
  APP_STACK_ROUTES_KEY_PREFIX,
  APP_STACK_STEP_DONE_TEXT,
  APP_STACK_STEP_FAILED_TEXT,
  APP_STACK_STEP_NOT_NEEDED_TEXT,
  APP_STACK_STEP_SKIPPED_TEXT,
  APP_STACK_START_INCOMPLETE_TEXT,
  APP_STACK_UNCERTAIN_TEXT,
  appStackRoutesHash,
} from "../src/app-stacks/app-stack-runtime-policy.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";
import { FakeStackExecutor } from "./support/fake-stack-executor.js";

// RT3: AppStackRuntime called directly (no worker) on PGlite with the scripted fake executor and a fake clock whose
// sleep advances time, so a 10-minute readiness budget elapses in microseconds.

const ORG = "org_rt3";
const ALLOC = "alloc_rt3";
const NGINX = `nginxinc/nginx-unprivileged@sha256:${"a".repeat(64)}`;
const MEMCACHED = `memcached@sha256:${"b".repeat(64)}`;
const START = Date.UTC(2026, 10, 22, 12);
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
type Json = Record<string, unknown>;

function component(key: string, patch: Partial<AppStackPlanComponent> = {}): AppStackPlanComponent {
  return {
    key,
    image: NGINX,
    runAsUser: null,
    argv: null,
    environment: [],
    secretFiles: [],
    resources: { cpuMilli: 250, memoryBytes: "134217728" },
    expose: [8080],
    dependsOn: [],
    volumes: [],
    healthcheck: { kind: "tcp", port: 8080, intervalSeconds: 10, timeoutSeconds: 3 },
    ...patch,
  };
}
const CACHE = component("cache", {
  image: MEMCACHED,
  expose: [11211],
  healthcheck: { kind: "tcp", port: 11211, intervalSeconds: 10, timeoutSeconds: 3 },
});
const WEB = component("web", { dependsOn: ["cache"], volumes: [{ volumeKey: "data", containerPath: "/app/data", readOnly: false }] });
const INGRESS = [{ componentKey: "web", port: 8080 }];

describe("AppStackRuntime (RT3)", () => {
  let dbClient: DatabaseClient;
  let versionId = "";
  let n = 0;
  let fake: ReturnType<typeof FakeStackExecutor.create>;
  let clock: { now(): number; sleep(ms: number): Promise<void>; elapsed(): number };
  const config: ControlPlaneRuntimeConfig = {
    oidcIssuer: "https://issuer.local",
    oidcAudience: "hosting-panel-api",
    enableDevOidc: true,
    runtimeBackend: "local-simulator",
    secretsMasterKey: randomBytes(32),
    jwtSigningKeyPem: null,
    autoProcessOutbox: false,
  };
  const db = () => dbClient.db;
  const runtime = (executor: DockerExecutorPort = fake, cfg: ControlPlaneRuntimeConfig = config) =>
    new AppStackRuntime(dbClient, executor, cfg, clock);

  function revision(stackId: string, components: AppStackPlanComponent[], ingress = INGRESS): NewAppStackRevision {
    const revisionId = newAppEntityId("srev");
    const volumes = [...new Set(components.flatMap((c) => c.volumes.map((v) => v.volumeKey)))].sort().map((key) => ({ key }));
    const base = { schemaVersion: 1 as const, stackId, organizationId: ORG, hostAllocationId: ALLOC, templateVersionId: versionId, revisionId, components, volumes, ingress };
    const plan: ApprovedStackPlan = { ...base, planHash: computeAppStackPlanHash(base) };
    expect(ApprovedStackPlanSchema.safeParse(plan).success).toBe(true);
    return {
      revisionId,
      templateVersionId: versionId,
      plan,
      planHash: plan.planHash,
      componentKeys: components.map((c) => c.key),
      volumeKeys: volumes.map((v) => v.key),
      cpuMilli: 250 * components.length,
      memoryBytes: 134217728 * components.length,
      parameters: [],
    };
  }

  async function create(components: AppStackPlanComponent[], ingress = INGRESS) {
    n += 1;
    const stackId = newAppEntityId("stk");
    const rev = revision(stackId, components, ingress);
    const write = await createAppStackTransactional(db(), {
      stackId,
      organizationId: ORG,
      hostAllocationId: ALLOC,
      templateVersionId: versionId,
      name: `Stack ${String(n)}`,
      createdBy: null,
      idempotencyKey: `rt3-${String(n)}`,
      requestHash: hex(`create ${String(n)}`),
      deploy: rev,
    });
    return { stackId, rev, write };
  }

  function enqueue(stackId: string, kind: AppStackOperationKind, rev: NewAppStackRevision | null = null, destroyData = false) {
    n += 1;
    return enqueueAppStackOperationTransactional(db(), {
      organizationId: ORG,
      stackId,
      kind,
      requestedByUserId: null,
      idempotencyKey: `rt3-${String(n)}`,
      requestHash: hex(`enqueue ${String(n)}`),
      revision: rev,
      destroyData,
    });
  }

  /** What the worker does around apply: processing first, then the handler; returns what it threw. */
  async function run(write: AppStackWriteResult, rt = runtime(), payload?: Json): Promise<unknown> {
    const op = write.operation!;
    await transitionOperation(db(), op.id, "processing");
    try {
      await rt.apply(op, payload ?? { operationId: op.id, stackId: write.stack.id, deploymentId: write.deployment!.id, revisionId: write.deployment!.revisionId });
      return undefined;
    } catch (err) {
      return err;
    }
  }

  const trace = () => fake.calls.map((c) => (c.componentKey ? `${c.method}:${c.componentKey}` : c.method));
  const stackOf = async (id: string) => (await db().select().from(appStacks).where(eq(appStacks.id, id)))[0]!;
  const opOf = async (id: string) => (await db().select().from(operations).where(eq(operations.id, id)))[0]!;
  const deploymentOf = async (write: AppStackWriteResult) =>
    (await db().select().from(appStackDeployments).where(eq(appStackDeployments.id, write.deployment!.id)))[0]!;
  const stepsOf = async (write: AppStackWriteResult) =>
    Object.fromEntries(
      (await db().select().from(operationSteps).where(eq(operationSteps.operationId, write.operation!.id))).map((s) => [s.key, [s.status, s.message]]),
    );
  const healthOf = async (stackId: string) =>
    Object.fromEntries(
      (await db().select().from(appStackComponents).where(eq(appStackComponents.stackId, stackId))).map((c) => [c.componentKey, c.health]),
    );
  const volumesOf = async (stackId: string) =>
    Object.fromEntries((await db().select().from(appStackVolumes).where(eq(appStackVolumes.stackId, stackId))).map((v) => [v.volumeKey, v.status]));
  const addDomain = (stackId: string, componentKey = "web") =>
    addAppStackDomainsTransactional(db(), {
      organizationId: ORG,
      stackId,
      entries: [{ hostname: `app${String(n)}.example.test`, componentKey, internalPort: 8080 }],
    });
  const done = (kind: AppStackOperationKind) => Object.fromEntries(APP_STACK_STEPS_BY_KIND[kind].map((k) => [k, ["succeeded", APP_STACK_STEP_DONE_TEXT[k]]]));
  const expectFailure = (err: unknown, problem: keyof typeof APP_STACK_FAILURE) => {
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).code).toBe(APP_STACK_FAILURE[problem].code);
    expect((err as ControlPlaneError).message).toBe(APP_STACK_FAILURE[problem].text);
  };

  /** A first deploy brought to running (with a web address on `web`), the fake's trace cleared afterwards. */
  async function running(components = [CACHE, WEB], domain = true) {
    const created = await create(components);
    if (domain) await addDomain(created.stackId);
    expect(await run(created.write)).toBeUndefined();
    expect((await stackOf(created.stackId)).status).toBe("running");
    fake.calls.length = 0;
    return created;
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await db().insert(platformInstallations).values({ id: "pin_rt3", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_rt3",
      platformInstallationId: "pin_rt3",
      name: "rt3-host",
      hostname: "panel.rt3.example",
      ipv4Address: "10.0.0.63",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    await db().insert(organizations).values({ id: ORG, platformInstallationId: "pin_rt3", name: ORG, slug: "org-rt3" });
    await db().insert(hostAllocations).values({ id: ALLOC, hostId: "hst_rt3", organizationId: ORG, status: "active" });
    const template = await createAppTemplate(db(), {
      slug: "rt3-demo",
      name: "rt3-demo",
      description: null,
      category: "web",
      createdBy: null,
      firstVersion: { source: "source rt3", specVersion: 1, compiledSchema: {}, specHash: hex("rt3") },
    });
    await updateAppTemplate(db(), { templateId: template.template.id, enabled: true });
    versionId = template.version.id;
  }, 120_000);

  afterAll(async () => {
    await dbClient.close();
  });

  beforeEach(() => {
    fake = FakeStackExecutor.create();
    let t = START;
    clock = { now: () => t, sleep: async (ms) => {
      t += ms;
    }, elapsed: () => t - START };
  });

  describe("stack.deploy", () => {
    it("(1) A14: two components in dependency order, readiness polled, routes published once after health", async () => {
      const { stackId, rev, write } = await create([CACHE, WEB]);
      await addDomain(stackId);
      fake.holdUnhealthy("cache", 2);

      expect(await run(write)).toBeUndefined();

      expect(trace()).toEqual([
        "pullAppStackImage",
        "pullAppStackImage",
        "prepareAppStack",
        "createAppStackComponents",
        "startAppStackComponent:cache",
        "getAppStackStatus",
        "getAppStackStatus",
        "getAppStackStatus",
        "startAppStackComponent:web",
        "getAppStackStatus",
        "getAppStackStatus",
        "publishAppStackRoutes",
      ]);
      expect(fake.calls.slice(0, 2).map((c) => (c.request as { image: string }).image)).toEqual([MEMCACHED, NGINX]);
      expect(clock.elapsed()).toBe(10_000);
      const routes: AppStackRouteWire[] = [
        { componentKey: "web", internalPort: 8080, hosts: [{ hostname: `app${String(n)}.example.test`, tls: false, httpsRedirect: false, redirectTo: null }] },
      ];
      expect(fake.stack(stackId).routes).toEqual(routes);

      const stack = await stackOf(stackId);
      expect(stack.status).toBe("running");
      expect(stack.appliedRevisionId).toBe(rev.revisionId);
      expect(stack.appliedRoutesHash).toBe(appStackRoutesHash(routes));
      expect(await deploymentOf(write)).toMatchObject({ status: "succeeded", problem: null });
      expect((await deploymentOf(write)).endedAt).not.toBeNull();
      expect((await opOf(write.operation!.id)).status).toBe("succeeded");
      expect(await stepsOf(write)).toEqual(done("stack.deploy"));
      expect(await healthOf(stackId)).toEqual({ cache: "healthy", web: "healthy" });
      expect(await volumesOf(stackId)).toEqual({ data: "present" });
      const [domain] = await db().select().from(appStackDomains).where(eq(appStackDomains.stackId, stackId));
      expect(domain!.status).toBe("active");
    });

    it("(2) no web address: the publish step says so and no route call is made", async () => {
      const { stackId, write } = await create([CACHE, WEB]);
      expect(await run(write)).toBeUndefined();
      expect(trace()).not.toContain("publishAppStackRoutes");
      expect(trace()).not.toContain("unpublishAppStackRoutes");
      expect((await stepsOf(write))["publish"]).toEqual(["succeeded", APP_STACK_NO_ADDRESS_TEXT]);
      const stack = await stackOf(stackId);
      expect(stack.status).toBe("running");
      expect(stack.appliedRoutesHash).toBeNull();
    });

    it("(3) A15: a dependency that never becomes healthy keeps its dependents stopped; the budget ends the deploy", async () => {
      const { stackId, rev, write } = await create([CACHE, WEB]);
      await addDomain(stackId);
      fake.holdUnhealthy("cache");

      expectFailure(await run(write), "STACK_HEALTH_TIMEOUT");

      expect(trace()).not.toContain("startAppStackComponent:web");
      expect(trace()).not.toContain("publishAppStackRoutes");
      expect(trace()).not.toContain("removeAppStackComponents");
      expect(clock.elapsed()).toBeGreaterThanOrEqual(APP_STACK_HEALTH_BUDGET_MS);
      expect(clock.elapsed()).toBeLessThan(APP_STACK_HEALTH_BUDGET_MS + 10_000);
      const stack = await stackOf(stackId);
      expect(stack.status).toBe("failed");
      expect(stack.appliedRevisionId).toBe(rev.revisionId);
      expect(await deploymentOf(write)).toMatchObject({ status: "failed", problem: "STACK_HEALTH_TIMEOUT" });
      expect(await opOf(write.operation!.id)).toMatchObject({
        status: "failed",
        errorCode: "DOCKER_ENGINE_UNAVAILABLE",
        errorMessage: APP_STACK_FAILURE.STACK_HEALTH_TIMEOUT.text,
      });
      const steps = await stepsOf(write);
      expect(steps["start"]).toEqual(["succeeded", APP_STACK_START_INCOMPLETE_TEXT]);
      expect(steps["health"]).toEqual(["failed", APP_STACK_STEP_FAILED_TEXT]);
      expect(steps["publish"]).toEqual(["skipped", APP_STACK_STEP_SKIPPED_TEXT]);
      expect(steps["settle"]).toEqual(["skipped", APP_STACK_STEP_SKIPPED_TEXT]);
      expect(await healthOf(stackId)).toEqual({ cache: "unhealthy", web: "stopped" });
      // First deploy: everything is kept so the logs stay readable.
      expect([...fake.stack(stackId).components.keys()]).toEqual(["cache", "web"]);
      expect(fake.stack(stackId).volumes.has("data")).toBe(true);
    });

    it("(4) an unhealthy accessory: degraded, the operation succeeds, the healthy ingress target is published", async () => {
      const { stackId, write } = await create([CACHE, component("web")]);
      await addDomain(stackId);
      fake.setHealth("cache", "unhealthy");

      expect(await run(write)).toBeUndefined();

      expect(trace().filter((c) => c === "publishAppStackRoutes")).toHaveLength(1);
      expect(fake.stack(stackId).routes.map((r) => r.componentKey)).toEqual(["web"]);
      const stack = await stackOf(stackId);
      expect(stack.status).toBe("degraded");
      expect(stack.appliedRoutesHash).not.toBeNull();
      expect(await deploymentOf(write)).toMatchObject({ status: "succeeded", problem: "STACK_HEALTH_TIMEOUT" });
      expect((await opOf(write.operation!.id)).status).toBe("succeeded");
      expect(await healthOf(stackId)).toEqual({ cache: "unhealthy", web: "healthy" });
    });

    it("(5) an image the executor refuses: nothing after the pull, HOST_POLICY_DENIED", async () => {
      const { stackId, write } = await create([CACHE, WEB]);
      fake.failNext("pullAppStackImage", "definite", "STACK_IMAGE_NOT_ALLOWED");

      expectFailure(await run(write), "STACK_IMAGE_NOT_ALLOWED");

      expect(trace()).toEqual(["pullAppStackImage"]);
      expect((await stackOf(stackId)).status).toBe("failed");
      expect((await stackOf(stackId)).appliedRevisionId).toBeNull();
      expect(await deploymentOf(write)).toMatchObject({ status: "failed", problem: "STACK_IMAGE_NOT_ALLOWED" });
      expect((await opOf(write.operation!.id)).errorCode).toBe("HOST_POLICY_DENIED");
      const steps = await stepsOf(write);
      expect(steps["reserve"]![0]).toBe("succeeded");
      expect(steps["pull"]).toEqual(["failed", APP_STACK_STEP_FAILED_TEXT]);
      expect(steps["prepare"]![0]).toBe("skipped");
    });

    it("(6) a missing secret fails at validate with zero executor calls", async () => {
      const web = component("web", { secretFiles: [{ envName: "APP_SECRET_FILE", parameterKey: "app_secret", version: 1 }] });
      const { stackId, write } = await create([web]);

      expectFailure(await run(write), "STACK_SECRET_MISSING");

      expect(fake.calls).toEqual([]);
      expect((await stackOf(stackId)).status).toBe("failed");
      expect(await deploymentOf(write)).toMatchObject({ status: "failed", problem: "STACK_SECRET_MISSING" });
      expect((await stepsOf(write))["validate"]).toEqual(["failed", APP_STACK_STEP_FAILED_TEXT]);
    });

    it("(7) runtime disabled or a Phase 1 executor: NOT_SUPPORTED, zero executor calls", async () => {
      const disabled = await create([CACHE, WEB]);
      expectFailure(await run(disabled.write, runtime(fake, { ...config, runtimeBackend: "disabled" })), "STACK_UNSUPPORTED_FEATURE");
      expect(fake.calls).toEqual([]);
      expect((await stackOf(disabled.stackId)).status).toBe("failed");

      const phase1 = await create([CACHE, WEB]);
      expectFailure(await run(phase1.write, runtime(new Phase1DisabledDockerExecutor())), "STACK_UNSUPPORTED_FEATURE");
      expect(await deploymentOf(phase1.write)).toMatchObject({ status: "failed", problem: "STACK_UNSUPPORTED_FEATURE" });
      expect((await opOf(phase1.write.operation!.id)).errorCode).toBe("NOT_SUPPORTED");
    });

    it("(8) an ambiguous create parks the deployment and the stack unknown and throws OPERATION_AMBIGUOUS", async () => {
      const { stackId, write } = await create([CACHE, WEB]);
      fake.failNext("createAppStackComponents", "ambiguous");

      const err = await run(write);

      expect(err).toBeInstanceOf(ControlPlaneError);
      expect((err as ControlPlaneError).code).toBe("OPERATION_AMBIGUOUS");
      expect((err as ControlPlaneError).message).toBe(APP_STACK_UNCERTAIN_TEXT);
      expect(trace().at(-1)).toBe("createAppStackComponents");
      expect((await stackOf(stackId)).status).toBe("unknown");
      expect(await deploymentOf(write)).toMatchObject({ status: "unknown", problem: "OPERATION_AMBIGUOUS" });
      // Not settled here: the worker parks the operation unknown with its lock.
      expect((await opOf(write.operation!.id)).status).toBe("processing");
    });

    it("(9) B5: a network failure at prepare is a pre-flight failure", async () => {
      const { stackId, write } = await create([CACHE, WEB]);
      fake.failNext("prepareAppStack", "definite");

      expectFailure(await run(write), "DOCKER_ENGINE_UNAVAILABLE");

      expect(trace()).toEqual(["pullAppStackImage", "pullAppStackImage", "prepareAppStack"]);
      expect((await stackOf(stackId)).status).toBe("failed");
      expect((await stackOf(stackId)).appliedRevisionId).toBeNull();
      expect(await deploymentOf(write)).toMatchObject({ status: "failed", problem: "DOCKER_ENGINE_UNAVAILABLE" });
      expect((await stepsOf(write))["prepare"]).toEqual(["failed", APP_STACK_STEP_FAILED_TEXT]);
      expect((await stepsOf(write))["create"]![0]).toBe("skipped");
    });

    it("(12) a definite route publication failure: degraded, revision applied, routes hash unchanged", async () => {
      const { stackId, rev, write } = await create([CACHE, WEB]);
      await addDomain(stackId);
      fake.failNext("publishAppStackRoutes", "definite");

      expectFailure(await run(write), "DOCKER_ENGINE_UNAVAILABLE");

      const stack = await stackOf(stackId);
      expect(stack.status).toBe("degraded");
      expect(stack.appliedRevisionId).toBe(rev.revisionId);
      expect(stack.appliedRoutesHash).toBeNull();
      expect((await stepsOf(write))["publish"]).toEqual(["failed", APP_STACK_STEP_FAILED_TEXT]);
      expect(await healthOf(stackId)).toEqual({ cache: "healthy", web: "healthy" });
      // No route was written, so the address is not live.
      const [domain] = await db().select().from(appStackDomains).where(eq(appStackDomains.stackId, stackId));
      expect(domain!.status).toBe("pending");
    });

    it("a corrupt payload closes the deployment and fails the stack", async () => {
      const { stackId, write } = await create([CACHE, WEB]);

      expectFailure(await run(write, runtime(), { operationId: write.operation!.id, stackId: "stk_other" }), "STACK_TEMPLATE_INVALID");

      expect(fake.calls).toEqual([]);
      expect((await stackOf(stackId)).status).toBe("failed");
      expect(await deploymentOf(write)).toMatchObject({ status: "failed", problem: "STACK_TEMPLATE_INVALID" });
      expect((await opOf(write.operation!.id)).status).toBe("failed");
    });
  });

  describe("stack.upgrade and stack.rollback", () => {
    const WORKER = component("worker", { dependsOn: ["web"] });
    const WEB_V2 = { ...WEB, environment: [{ name: "CACHE_HOST", value: "cache" }] };

    it("(10) only the changed component is replaced, its dependents restarted, volumes untouched", async () => {
      const { stackId } = await running([CACHE, WEB, WORKER]);
      const volumesBefore = [...fake.stack(stackId).volumes];
      const v2 = revision(stackId, [CACHE, WEB_V2, WORKER]);
      const upgrade = await enqueue(stackId, "stack.upgrade", v2);

      expect(await run(upgrade)).toBeUndefined();

      const create = fake.calls.find((c) => c.method === "createAppStackComponents");
      expect(create).toBeDefined();
      expect(trace().filter((c) => /^(start|restart)AppStackComponent/.test(c))).toEqual([
        "startAppStackComponent:cache",
        "startAppStackComponent:web",
        "restartAppStackComponent:worker",
      ]);
      expect(trace()).not.toContain("removeAppStack");
      expect(trace()).not.toContain("removeAppStackComponents");
      expect([...fake.stack(stackId).volumes]).toEqual(volumesBefore);
      expect(fake.stack(stackId).components.get("web")!.componentHash).toBe(computeAppStackComponentHash(v2.plan as ApprovedStackPlan, "web"));
      const stack = await stackOf(stackId);
      expect(stack.status).toBe("running");
      expect(stack.appliedRevisionId).toBe(v2.revisionId);
      expect(stack.desiredRevisionId).toBe(v2.revisionId);
      expect(await volumesOf(stackId)).toEqual({ data: "present" });
    });

    it("(11) a failure after create removes only the replaced component; the previous revision stays applied", async () => {
      const webFirst = component("web");
      const { stackId, rev } = await running([webFirst, CACHE]);
      const v2 = revision(stackId, [{ ...webFirst, environment: [{ name: "CACHE_HOST", value: "cache" }] }, CACHE]);
      const upgrade = await enqueue(stackId, "stack.upgrade", v2);
      fake.failNext("startAppStackComponent", "definite");

      expectFailure(await run(upgrade), "DOCKER_ENGINE_UNAVAILABLE");

      const removal = fake.calls.filter((c) => c.method === "removeAppStackComponents");
      expect(removal.map((c) => (c.request as { componentKeys: string[] }).componentKeys)).toEqual([["web"]]);
      expect([...fake.stack(stackId).components.keys()]).toEqual(["cache"]);
      expect(fake.stack(stackId).volumes.size).toBe(0);
      const stack = await stackOf(stackId);
      expect(stack.status).toBe("failed");
      expect(stack.appliedRevisionId).toBe(rev.revisionId);
      expect(await healthOf(stackId)).toEqual({ cache: "healthy", web: "missing" });
      expect(await deploymentOf(upgrade)).toMatchObject({ status: "failed", problem: "DOCKER_ENGINE_UNAVAILABLE" });
    });

    it("a start in doubt inside an upgrade removes nothing: the recovery settles from what runs", async () => {
      const webFirst = component("web");
      const { stackId } = await running([webFirst, CACHE]);
      const v2 = revision(stackId, [{ ...webFirst, environment: [{ name: "CACHE_HOST", value: "cache" }] }, CACHE]);
      const upgrade = await enqueue(stackId, "stack.upgrade", v2);
      // The executor started the new container; its answer could not be read.
      fake.failNext("startAppStackComponent", "ambiguous");

      expect(((await run(upgrade)) as ControlPlaneError).code).toBe("OPERATION_AMBIGUOUS");

      expect(trace()).not.toContain("removeAppStackComponents");
      expect((await stackOf(stackId)).status).toBe("unknown");
      await transitionOperation(db(), upgrade.operation!.id, "unknown");
      fake.calls.length = 0;
      expect(await runtime().recover(await opOf(upgrade.operation!.id))).toBe("settled");
      expect(trace()).toEqual(["getAppStackStatus"]);
      expect([...fake.stack(stackId).components.keys()].sort()).toEqual(["cache", "web"]);
      expect(fake.stack(stackId).components.get("web")!.componentHash).toBe(computeAppStackComponentHash(v2.plan as ApprovedStackPlan, "web"));
      expect(await stackOf(stackId)).toMatchObject({ status: "running", appliedRevisionId: v2.revisionId });
    });

    it("a cleanup that fails for sure records the component as observed, not missing", async () => {
      const webFirst = component("web");
      const { stackId } = await running([webFirst, CACHE]);
      const upgrade = await enqueue(stackId, "stack.upgrade", revision(stackId, [{ ...webFirst, environment: [{ name: "CACHE_HOST", value: "cache" }] }, CACHE]));
      fake.failNext("startAppStackComponent", "definite");
      fake.failNext("removeAppStackComponents", "definite");

      expectFailure(await run(upgrade), "DOCKER_ENGINE_UNAVAILABLE");

      expect(trace()).toContain("removeAppStackComponents");
      expect([...fake.stack(stackId).components.keys()].sort()).toEqual(["cache", "web"]);
      expect((await stackOf(stackId)).status).toBe("failed");
      expect(await healthOf(stackId)).toEqual({ cache: "healthy", web: "stopped" });
    });

    it("a pre-flight failure of an upgrade touches no component, keeps the observed status and takes its target back", async () => {
      const { stackId, rev } = await running([CACHE, WEB]);
      const v2 = revision(stackId, [CACHE, WEB_V2]);
      const upgrade = await enqueue(stackId, "stack.upgrade", v2);
      fake.failNext("pullAppStackImage", "definite", "STACK_IMAGE_PULL_FAILED");

      expectFailure(await run(upgrade), "DOCKER_ENGINE_UNAVAILABLE");

      expect(trace()).toEqual(["pullAppStackImage", "getAppStackStatus"]);
      const stack = await stackOf(stackId);
      expect(stack.status).toBe("running");
      expect(stack.appliedRevisionId).toBe(rev.revisionId);
      expect(stack.desiredRevisionId).toBe(rev.revisionId);
      // The history keeps what was tried.
      expect(await deploymentOf(upgrade)).toMatchObject({ status: "failed", revisionId: v2.revisionId });
      expect((await opOf(upgrade.operation!.id)).status).toBe("failed");
    });

    it("a rollback that fails at prepare goes back to the revision that runs, not to the one it asked for", async () => {
      const { stackId, rev } = await running([CACHE, WEB]);
      const v2 = revision(stackId, [CACHE, WEB_V2]);
      expect(await run(await enqueue(stackId, "stack.upgrade", v2))).toBeUndefined();
      const rollback = await enqueue(stackId, "stack.rollback", revision(stackId, rev.plan.components as AppStackPlanComponent[]));
      fake.failNext("prepareAppStack", "definite");

      expectFailure(await run(rollback), "DOCKER_ENGINE_UNAVAILABLE");

      expect(await stackOf(stackId)).toMatchObject({ status: "running", appliedRevisionId: v2.revisionId, desiredRevisionId: v2.revisionId });
      expect(fake.stack(stackId).components.get("web")!.componentHash).toBe(computeAppStackComponentHash(v2.plan as ApprovedStackPlan, "web"));
    });

    it("a failure at create keeps the target: the executor may have replaced a component", async () => {
      const { stackId, rev } = await running([CACHE, WEB]);
      const v2 = revision(stackId, [CACHE, WEB_V2]);
      const upgrade = await enqueue(stackId, "stack.upgrade", v2);
      fake.failNext("createAppStackComponents", "definite");

      expectFailure(await run(upgrade), "DOCKER_ENGINE_UNAVAILABLE");

      expect(await stackOf(stackId)).toMatchObject({ status: "failed", appliedRevisionId: rev.revisionId, desiredRevisionId: v2.revisionId });
    });

    it("a rollback runs the deploy path and re-applies the older plan", async () => {
      const { stackId, rev } = await running([CACHE, WEB]);
      const v2 = revision(stackId, [CACHE, WEB_V2]);
      expect(await run(await enqueue(stackId, "stack.upgrade", v2))).toBeUndefined();
      fake.calls.length = 0;
      const back = revision(stackId, rev.plan.components as AppStackPlanComponent[]);
      const rollback = await enqueue(stackId, "stack.rollback", back);

      expect(await run(rollback)).toBeUndefined();

      expect(trace().filter((c) => /^(start|restart)AppStackComponent/.test(c))).toEqual(["startAppStackComponent:cache", "startAppStackComponent:web"]);
      expect(fake.stack(stackId).components.get("web")!.componentHash).toBe(computeAppStackComponentHash(rev.plan as ApprovedStackPlan, "web"));
      expect(await stepsOf(rollback)).toEqual(done("stack.rollback"));
      expect((await stackOf(stackId)).appliedRevisionId).toBe(back.revisionId);
    });
  });

  describe("a stopped application whose deploy, upgrade or rollback is refused before create (#129)", () => {
    // A further variable makes this plan different from the one that runs.
    const WEB_V2 = { ...WEB, environment: [{ name: "CACHE_HOST", value: "cache" }] };
    const STOPPED = { cache: "stopped", web: "stopped" };
    const touched = () => trace().filter((c) => /^(create|start|restart|remove)AppStack|^publishAppStackRoutes/.test(c));

    /** A running application its owner stopped, the fake's trace cleared. */
    async function stopped(components = [CACHE, WEB]) {
      const created = await running(components);
      expect(await run(await enqueue(created.stackId, "stack.stop"))).toBeUndefined();
      expect((await stackOf(created.stackId)).status).toBe("stopped");
      fake.calls.length = 0;
      return created;
    }

    it("an upgrade refused at pull leaves it stopped and takes its target back; the operation fails with its reason", async () => {
      const { stackId, rev } = await stopped();
      const v2 = revision(stackId, [CACHE, WEB_V2]);
      const upgrade = await enqueue(stackId, "stack.upgrade", v2);
      fake.failNext("pullAppStackImage", "definite", "STACK_IMAGE_PULL_FAILED");

      expectFailure(await run(upgrade), "DOCKER_ENGINE_UNAVAILABLE");

      expect(trace()).toEqual(["pullAppStackImage", "getAppStackStatus"]);
      expect(await stackOf(stackId)).toMatchObject({ status: "stopped", appliedRevisionId: rev.revisionId, desiredRevisionId: rev.revisionId, appliedRoutesHash: null });
      expect(await healthOf(stackId)).toEqual(STOPPED);
      expect(await deploymentOf(upgrade)).toMatchObject({ status: "failed", revisionId: v2.revisionId, replacedStatus: "stopped" });
      expect((await opOf(upgrade.operation!.id)).status).toBe("failed");
      expect((await stepsOf(upgrade))["pull"]).toEqual(["failed", APP_STACK_STEP_FAILED_TEXT]);
      expect(fake.stack(stackId).routes).toEqual([]);
    });

    it("an upgrade that is not taken back (an address now points at a part only the new version has) leaves it stopped too", async () => {
      const { stackId, rev } = await stopped();
      const v2 = revision(stackId, [CACHE, WEB, component("extra")], [{ componentKey: "extra", port: 8080 }, ...INGRESS]);
      const upgrade = await enqueue(stackId, "stack.upgrade", v2);
      await addDomain(stackId, "extra");
      fake.failNext("pullAppStackImage", "definite");

      expectFailure(await run(upgrade), "DOCKER_ENGINE_UNAVAILABLE");

      expect(touched()).toEqual([]);
      // The new version stays the one asked for, as after a deploy with new settings; nothing was started.
      expect(await stackOf(stackId)).toMatchObject({ status: "stopped", appliedRevisionId: rev.revisionId, desiredRevisionId: v2.revisionId });
      expect(await deploymentOf(upgrade)).toMatchObject({ status: "failed" });
    });

    it("a rollback refused at prepare leaves it stopped on the revision that runs", async () => {
      const { stackId, rev } = await running();
      const v2 = revision(stackId, [CACHE, WEB_V2]);
      expect(await run(await enqueue(stackId, "stack.upgrade", v2))).toBeUndefined();
      expect(await run(await enqueue(stackId, "stack.stop"))).toBeUndefined();
      fake.calls.length = 0;
      const rollback = await enqueue(stackId, "stack.rollback", revision(stackId, rev.plan.components as AppStackPlanComponent[]));
      fake.failNext("prepareAppStack", "definite");

      expectFailure(await run(rollback), "DOCKER_ENGINE_UNAVAILABLE");

      expect(touched()).toEqual([]);
      expect(await stackOf(stackId)).toMatchObject({ status: "stopped", appliedRevisionId: v2.revisionId, desiredRevisionId: v2.revisionId });
      expect(await healthOf(stackId)).toEqual(STOPPED);
      expect(await deploymentOf(rollback)).toMatchObject({ status: "failed", problem: "DOCKER_ENGINE_UNAVAILABLE" });
      expect((await opOf(rollback.operation!.id)).status).toBe("failed");
    });

    it("a deploy with new settings refused at pull leaves it stopped; the target stays, a deploy is not taken back", async () => {
      const { stackId, rev } = await stopped();
      const v2 = revision(stackId, [CACHE, WEB_V2]);
      const deploy = await enqueue(stackId, "stack.deploy", v2);
      fake.failNext("pullAppStackImage", "definite", "STACK_IMAGE_NOT_ALLOWED");

      expectFailure(await run(deploy), "STACK_IMAGE_NOT_ALLOWED");

      expect(touched()).toEqual([]);
      expect(await stackOf(stackId)).toMatchObject({ status: "stopped", appliedRevisionId: rev.revisionId, desiredRevisionId: v2.revisionId });
      expect(await healthOf(stackId)).toEqual(STOPPED);
      expect(await deploymentOf(deploy)).toMatchObject({ status: "failed", problem: "STACK_IMAGE_NOT_ALLOWED" });
      expect((await opOf(deploy.operation!.id)).errorCode).toBe("HOST_POLICY_DENIED");

      // A plain redeploy refused the same way.
      fake.calls.length = 0;
      const again = await enqueue(stackId, "stack.deploy");
      fake.failNext("pullAppStackImage", "definite", "STACK_IMAGE_NOT_ALLOWED");
      expectFailure(await run(again), "STACK_IMAGE_NOT_ALLOWED");
      expect(touched()).toEqual([]);
      expect((await stackOf(stackId)).status).toBe("stopped");
    });

    it("a deploy refused at validate leaves it stopped, with or without a reading", async () => {
      const web = component("web", { secretFiles: [{ envName: "APP_SECRET_FILE", parameterKey: "app_secret", version: 1 }] });
      const { stackId, write } = await create([CACHE, web]);
      await setAppStackSecretTransactional(db(), { organizationId: ORG, stackId, parameterKey: "app_secret", value: "first", masterKey: config.secretsMasterKey });
      expect(await run(write)).toBeUndefined();
      expect(await run(await enqueue(stackId, "stack.stop"))).toBeUndefined();
      await db().execute(sql`ALTER TABLE app_stack_secrets DISABLE TRIGGER trg_prevent_app_stack_secrets_mutation`);
      await db().delete(appStackSecrets).where(eq(appStackSecrets.stackId, stackId));
      await db().execute(sql`ALTER TABLE app_stack_secrets ENABLE TRIGGER trg_prevent_app_stack_secrets_mutation`);
      fake.calls.length = 0;

      const deploy = await enqueue(stackId, "stack.deploy", revision(stackId, [CACHE, { ...web, environment: [{ name: "CACHE_HOST", value: "cache" }] }]));
      expectFailure(await run(deploy), "STACK_SECRET_MISSING");
      expect(trace()).toEqual(["getAppStackStatus"]);
      expect((await stackOf(stackId)).status).toBe("stopped");
      expect(await healthOf(stackId)).toEqual(STOPPED);
      expect(await deploymentOf(deploy)).toMatchObject({ status: "failed", problem: "STACK_SECRET_MISSING" });
      expect((await stepsOf(deploy))["validate"]).toEqual(["failed", APP_STACK_STEP_FAILED_TEXT]);

      // The executor cannot be read: nothing was touched either, so it stays stopped.
      fake.failNext("getAppStackStatus", "definite");
      const again = await enqueue(stackId, "stack.deploy");
      expectFailure(await run(again), "STACK_SECRET_MISSING");
      expect((await stackOf(stackId)).status).toBe("stopped");
      expect(await deploymentOf(again)).toMatchObject({ status: "failed", problem: "STACK_SECRET_MISSING" });
    });

    it("a redeploy whose first database write fails leaves it stopped: the application was read before it", async () => {
      const { stackId, rev } = await stopped();
      const deploy = await enqueue(stackId, "stack.deploy");
      // A database error on the write that moves the deployment to running, and on that write only.
      await db().execute(sql`CREATE FUNCTION rt3_refuse_running() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$`);
      await db().execute(
        sql`CREATE TRIGGER rt3_refuse_running BEFORE UPDATE ON app_stack_deployments FOR EACH ROW WHEN (NEW.status = 'running') EXECUTE FUNCTION rt3_refuse_running()`,
      );
      let err: unknown;
      try {
        err = await run(deploy);
      } finally {
        await db().execute(sql`DROP TRIGGER rt3_refuse_running ON app_stack_deployments`);
        await db().execute(sql`DROP FUNCTION rt3_refuse_running()`);
      }

      expectFailure(err, "DOCKER_ENGINE_UNAVAILABLE");
      expect(trace()).toEqual([]);
      expect(await stackOf(stackId)).toMatchObject({ status: "stopped", appliedRevisionId: rev.revisionId, desiredRevisionId: rev.revisionId });
      expect(await deploymentOf(deploy)).toMatchObject({ status: "failed", problem: "DOCKER_ENGINE_UNAVAILABLE" });
      expect((await stepsOf(deploy))["validate"]).toEqual(["failed", APP_STACK_STEP_FAILED_TEXT]);
    });

    it("one whose applied revision no longer checks stays stopped: a revision of it was applied all the same", async () => {
      const { stackId, rev } = await stopped();
      // Revisions are immutable: only this test can give one a hash its plan does not have.
      await db().execute(sql`ALTER TABLE app_stack_revisions DISABLE TRIGGER trg_prevent_app_stack_revisions_mutation`);
      await db().update(appStackRevisions).set({ planHash: hex("not the plan") }).where(eq(appStackRevisions.id, rev.revisionId));
      await db().execute(sql`ALTER TABLE app_stack_revisions ENABLE TRIGGER trg_prevent_app_stack_revisions_mutation`);

      const deploy = await enqueue(stackId, "stack.deploy");
      expectFailure(await run(deploy), "STACK_TEMPLATE_INVALID");

      expect(trace()).toEqual([]);
      expect(await stackOf(stackId)).toMatchObject({ status: "stopped", appliedRevisionId: rev.revisionId });
      expect(await deploymentOf(deploy)).toMatchObject({ status: "failed", problem: "STACK_TEMPLATE_INVALID" });
    });

    it("a failure at create still ends failed: the executor may have replaced a component", async () => {
      const { stackId, rev } = await stopped();
      const v2 = revision(stackId, [CACHE, WEB_V2]);
      const upgrade = await enqueue(stackId, "stack.upgrade", v2);
      fake.failNext("createAppStackComponents", "definite");

      expectFailure(await run(upgrade), "DOCKER_ENGINE_UNAVAILABLE");

      expect(await stackOf(stackId)).toMatchObject({ status: "failed", appliedRevisionId: rev.revisionId, desiredRevisionId: v2.revisionId });
    });

    it("one that never ran ends failed, as before: no revision of it was ever installed, so a start has nothing to start", async () => {
      // A first install refused at create leaves no applied revision.
      const { stackId, write } = await create([CACHE, WEB]);
      fake.failNext("createAppStackComponents", "definite");
      expectFailure(await run(write), "DOCKER_ENGINE_UNAVAILABLE");
      expect(await stackOf(stackId)).toMatchObject({ status: "failed", appliedRevisionId: null });
      expect(await run(await enqueue(stackId, "stack.stop"))).toBeUndefined();
      expect((await stackOf(stackId)).status).toBe("stopped");
      const v2 = revision(stackId, [CACHE, WEB, component("extra")], [{ componentKey: "extra", port: 8080 }, ...INGRESS]);
      const upgrade = await enqueue(stackId, "stack.upgrade", v2);
      await addDomain(stackId, "extra");
      fake.calls.length = 0;
      fake.failNext("pullAppStackImage", "definite");

      expectFailure(await run(upgrade), "DOCKER_ENGINE_UNAVAILABLE");

      expect(touched()).toEqual([]);
      // Not taken back: the address points at a part only the new version has.
      expect(await stackOf(stackId)).toMatchObject({ status: "failed", appliedRevisionId: null, desiredRevisionId: v2.revisionId });
      expect(await deploymentOf(upgrade)).toMatchObject({ status: "failed", replacedStatus: "stopped" });

      // A reinstall of it, stopped again and refused the same way, ends failed too.
      expect(await run(await enqueue(stackId, "stack.stop"))).toBeUndefined();
      const redeploy = await enqueue(stackId, "stack.deploy");
      fake.failNext("pullAppStackImage", "definite");
      expectFailure(await run(redeploy), "DOCKER_ENGINE_UNAVAILABLE");
      expect(touched()).toEqual([]);
      expect(await stackOf(stackId)).toMatchObject({ status: "failed", appliedRevisionId: null });
    });
  });

  describe("start, restart, stop, delete (13)", () => {
    it("stop withdraws the routes then stops; start brings it back and republishes", async () => {
      const { stackId } = await running();
      const routesHash = (await stackOf(stackId)).appliedRoutesHash;
      const stop = await enqueue(stackId, "stack.stop");

      expect(await run(stop)).toBeUndefined();

      expect(trace()).toEqual(["unpublishAppStackRoutes", "stopAppStack"]);
      expect((await stackOf(stackId)).status).toBe("stopped");
      expect((await stackOf(stackId)).appliedRoutesHash).toBeNull();
      expect(await healthOf(stackId)).toEqual({ cache: "stopped", web: "stopped" });
      expect(await stepsOf(stop)).toEqual(done("stack.stop"));
      expect(fake.stack(stackId).routes).toEqual([]);

      fake.calls.length = 0;
      const start = await enqueue(stackId, "stack.start");
      expect(await run(start)).toBeUndefined();
      expect(trace()).toEqual([
        "startAppStackComponent:cache",
        "getAppStackStatus",
        "startAppStackComponent:web",
        "getAppStackStatus",
        "getAppStackStatus",
        "publishAppStackRoutes",
      ]);
      expect((await stackOf(stackId)).status).toBe("running");
      expect((await stackOf(stackId)).appliedRoutesHash).toBe(routesHash);
      expect(await stepsOf(start)).toEqual(done("stack.start"));
    });

    it("stop withdraws the routes even when no routes hash is stored", async () => {
      const { stackId } = await running();
      await db().update(appStacks).set({ appliedRoutesHash: null }).where(eq(appStacks.id, stackId));
      expect(fake.stack(stackId).routes).toHaveLength(1);
      const stop = await enqueue(stackId, "stack.stop");

      expect(await run(stop)).toBeUndefined();

      expect(trace()).toEqual(["unpublishAppStackRoutes", "stopAppStack"]);
      expect(fake.stack(stackId).routes).toEqual([]);
      expect(await stepsOf(stop)).toEqual(done("stack.stop"));
    });

    it("restart restarts every component and keeps the published routes", async () => {
      const { stackId, rev } = await running();
      const restart = await enqueue(stackId, "stack.restart");

      expect(await run(restart)).toBeUndefined();

      expect(trace().filter((c) => /^(start|restart)AppStackComponent/.test(c))).toEqual(["restartAppStackComponent:cache", "restartAppStackComponent:web"]);
      expect(trace()).not.toContain("publishAppStackRoutes");
      expect((await stackOf(stackId)).status).toBe("running");
      expect((await stackOf(stackId)).appliedRevisionId).toBe(rev.revisionId);
    });

    it("a start that fails for sure leaves the stack failed", async () => {
      const { stackId } = await running();
      expect(await run(await enqueue(stackId, "stack.stop"))).toBeUndefined();
      fake.failNext("startAppStackComponent", "definite");

      expectFailure(await run(await enqueue(stackId, "stack.start")), "DOCKER_ENGINE_UNAVAILABLE");
      expect((await stackOf(stackId)).status).toBe("failed");
    });

    it("a restart or a start refused at validate touches nothing and shows what runs; the operation fails with its reason", async () => {
      const web = component("web", { secretFiles: [{ envName: "APP_SECRET_FILE", parameterKey: "app_secret", version: 1 }] });
      const { stackId, write } = await create([CACHE, web]);
      await setAppStackSecretTransactional(db(), { organizationId: ORG, stackId, parameterKey: "app_secret", value: "first", masterKey: config.secretsMasterKey });
      expect(await run(write)).toBeUndefined();
      expect((await stackOf(stackId)).status).toBe("running");
      // The pinned version is gone (versions are immutable: only this test can lose one): every start of the plan is
      // refused before the executor is asked anything.
      await db().execute(sql`ALTER TABLE app_stack_secrets DISABLE TRIGGER trg_prevent_app_stack_secrets_mutation`);
      await db().delete(appStackSecrets).where(eq(appStackSecrets.stackId, stackId));
      await db().execute(sql`ALTER TABLE app_stack_secrets ENABLE TRIGGER trg_prevent_app_stack_secrets_mutation`);
      fake.calls.length = 0;

      const restart = await enqueue(stackId, "stack.restart");
      expectFailure(await run(restart), "STACK_SECRET_MISSING");

      expect(trace()).toEqual(["getAppStackStatus"]);
      expect((await stackOf(stackId)).status).toBe("running");
      expect(await healthOf(stackId)).toEqual({ cache: "healthy", web: "healthy" });
      expect(await deploymentOf(restart)).toMatchObject({ status: "failed", problem: "STACK_SECRET_MISSING" });
      expect((await opOf(restart.operation!.id)).status).toBe("failed");
      expect((await stepsOf(restart))["validate"]).toEqual(["failed", APP_STACK_STEP_FAILED_TEXT]);

      // A stop cut short by an API restart leaves it unknown while it still serves: a refused start shows that it does.
      await db().update(appStacks).set({ status: "unknown" }).where(eq(appStacks.id, stackId));
      fake.calls.length = 0;
      const start = await enqueue(stackId, "stack.start");
      expectFailure(await run(start), "STACK_SECRET_MISSING");
      expect(trace()).toEqual(["getAppStackStatus"]);
      expect((await stackOf(stackId)).status).toBe("running");
      expect(await deploymentOf(start)).toMatchObject({ status: "failed", problem: "STACK_SECRET_MISSING" });
    });

    it("a start of a stopped application refused at validate leaves it stopped, with or without a reading; the operation fails with its reason", async () => {
      const web = component("web", { secretFiles: [{ envName: "APP_SECRET_FILE", parameterKey: "app_secret", version: 1 }] });
      const { stackId, write } = await create([CACHE, web]);
      await setAppStackSecretTransactional(db(), { organizationId: ORG, stackId, parameterKey: "app_secret", value: "first", masterKey: config.secretsMasterKey });
      expect(await run(write)).toBeUndefined();
      expect(await run(await enqueue(stackId, "stack.stop"))).toBeUndefined();
      expect((await stackOf(stackId)).status).toBe("stopped");
      await db().execute(sql`ALTER TABLE app_stack_secrets DISABLE TRIGGER trg_prevent_app_stack_secrets_mutation`);
      await db().delete(appStackSecrets).where(eq(appStackSecrets.stackId, stackId));
      await db().execute(sql`ALTER TABLE app_stack_secrets ENABLE TRIGGER trg_prevent_app_stack_secrets_mutation`);
      fake.calls.length = 0;

      const start = await enqueue(stackId, "stack.start");
      expectFailure(await run(start), "STACK_SECRET_MISSING");
      expect(trace()).toEqual(["getAppStackStatus"]);
      expect((await stackOf(stackId)).status).toBe("stopped");
      expect(await healthOf(stackId)).toEqual({ cache: "stopped", web: "stopped" });
      expect(await deploymentOf(start)).toMatchObject({ status: "failed", problem: "STACK_SECRET_MISSING" });
      expect((await opOf(start.operation!.id)).status).toBe("failed");
      expect((await stepsOf(start))["validate"]).toEqual(["failed", APP_STACK_STEP_FAILED_TEXT]);

      // The executor cannot be read: nothing was touched either, so it stays stopped.
      fake.failNext("getAppStackStatus", "definite");
      const again = await enqueue(stackId, "stack.start");
      expectFailure(await run(again), "STACK_SECRET_MISSING");
      expect((await stackOf(stackId)).status).toBe("stopped");
      expect(await deploymentOf(again)).toMatchObject({ status: "failed", problem: "STACK_SECRET_MISSING" });
    });

    it("the start that follows a backup, refused at validate, ends failed: the platform stopped the application, not the customer", async () => {
      const web = component("web", { secretFiles: [{ envName: "APP_SECRET_FILE", parameterKey: "app_secret", version: 1 }] });
      const { stackId, write } = await create([CACHE, web]);
      await setAppStackSecretTransactional(db(), { organizationId: ORG, stackId, parameterKey: "app_secret", value: "first", masterKey: config.secretsMasterKey });
      expect(await run(write)).toBeUndefined();
      // The backup's stop: the containers are stopped and the application with them.
      expect(await run(await enqueue(stackId, "stack.stop"))).toBeUndefined();
      await db().execute(sql`ALTER TABLE app_stack_secrets DISABLE TRIGGER trg_prevent_app_stack_secrets_mutation`);
      await db().delete(appStackSecrets).where(eq(appStackSecrets.stackId, stackId));
      await db().execute(sql`ALTER TABLE app_stack_secrets ENABLE TRIGGER trg_prevent_app_stack_secrets_mutation`);
      const queued = await db().transaction((tx) =>
        enqueueAppStackResumeTransactional(tx, { organizationId: ORG, stackId, requestedByUserId: null, sourceOperationId: `op_backup_${String(n)}` }),
      );
      expect(queued?.kind).toBe("stack.start");
      const resume: AppStackWriteResult = { stack: await stackOf(stackId), revision: null, deployment: queued!.deployment, operation: queued!.operation, idempotentReplay: false };

      expectFailure(await run(resume), "STACK_SECRET_MISSING");
      expect((await stackOf(stackId)).status).toBe("failed");
      expect(await deploymentOf(resume)).toMatchObject({ status: "failed", problem: "STACK_SECRET_MISSING", replacedStatus: null });
      expect((await opOf(queued!.operation.id)).status).toBe("failed");
    });

    it("a stop that fails after the routes are withdrawn settles degraded with no routes hash", async () => {
      const { stackId } = await running();
      fake.failNext("stopAppStack", "definite");
      const stop = await enqueue(stackId, "stack.stop");

      expectFailure(await run(stop), "DOCKER_ENGINE_UNAVAILABLE");

      expect((await stackOf(stackId)).status).toBe("degraded");
      expect((await stackOf(stackId)).appliedRoutesHash).toBeNull();
      expect((await stepsOf(stop))["stop"]).toEqual(["failed", APP_STACK_STEP_FAILED_TEXT]);
    });

    it("a stop whose unpublish answer is lost: the recovery sees no routes and drops the hash, so the restart writes them again", async () => {
      const { stackId } = await running();
      const routesHash = (await stackOf(stackId)).appliedRoutesHash;
      expect(routesHash).not.toBeNull();
      const stop = await enqueue(stackId, "stack.stop");
      // The executor withdrew the routes; its answer could not be read.
      fake.failNext("unpublishAppStackRoutes", "ambiguous");

      expect(((await run(stop)) as ControlPlaneError).code).toBe("OPERATION_AMBIGUOUS");
      expect(trace()).toEqual(["unpublishAppStackRoutes"]);
      expect(fake.stack(stackId).routes).toEqual([]);
      await transitionOperation(db(), stop.operation!.id, "unknown");
      expect(await runtime().recover(await opOf(stop.operation!.id))).toBe("settled");
      expect(await stackOf(stackId)).toMatchObject({ status: "degraded", appliedRoutesHash: null });

      fake.calls.length = 0;
      expect(await run(await enqueue(stackId, "stack.restart"))).toBeUndefined();
      expect(trace()).toContain("publishAppStackRoutes");
      expect(fake.stack(stackId).routes).toHaveLength(1);
      expect(await stackOf(stackId)).toMatchObject({ status: "running", appliedRoutesHash: routesHash });
    });

    it("a stop the executor refuses before anything is withdrawn keeps the routes and their hash", async () => {
      const { stackId } = await running();
      const routesHash = (await stackOf(stackId)).appliedRoutesHash;
      fake.failNext("unpublishAppStackRoutes", "definite");

      expectFailure(await run(await enqueue(stackId, "stack.stop")), "DOCKER_ENGINE_UNAVAILABLE");

      expect(trace()).toEqual(["unpublishAppStackRoutes"]);
      expect(await stackOf(stackId)).toMatchObject({ status: "degraded", appliedRoutesHash: routesHash });
      expect(fake.stack(stackId).routes).toHaveLength(1);
    });

    it("delete without data keeps the volumes; with destroyData it asks the executor to remove them", async () => {
      const kept = await running();
      const del = await enqueue(kept.stackId, "stack.delete");
      expect(await run(del)).toBeUndefined();
      expect(trace()).toEqual(["unpublishAppStackRoutes", "stopAppStack", "removeAppStack"]);
      expect((fake.calls.at(-1)!.request as { removeVolumes: boolean }).removeVolumes).toBe(false);
      const stack = await stackOf(kept.stackId);
      expect(stack.status).toBe("deleted");
      expect(stack.deletedAt).not.toBeNull();
      expect(await volumesOf(kept.stackId)).toEqual({ data: "retained" });
      expect(await stepsOf(del)).toEqual(done("stack.delete"));

      fake.calls.length = 0;
      const gone = await running();
      expect(await run(await enqueue(gone.stackId, "stack.delete", null, true))).toBeUndefined();
      expect((fake.calls.at(-1)!.request as { removeVolumes: boolean }).removeVolumes).toBe(true);
      expect((await stackOf(gone.stackId)).status).toBe("deleted");
      expect(await volumesOf(gone.stackId)).toEqual({ data: "removed" });
      expect(fake.stack(gone.stackId).volumes.size).toBe(0);
    });

    it("a volume still in use on a data-destroying delete: delete_failed, STACK_VOLUME_IN_USE", async () => {
      const { stackId } = await running();
      fake.volumesInUse.add("data");
      const del = await enqueue(stackId, "stack.delete", null, true);

      expectFailure(await run(del), "STACK_VOLUME_IN_USE");

      expect((await stackOf(stackId)).status).toBe("delete_failed");
      expect((await stackOf(stackId)).deletedAt).toBeNull();
      expect(await deploymentOf(del)).toMatchObject({ status: "failed", problem: "STACK_VOLUME_IN_USE" });
      expect((await opOf(del.operation!.id)).errorCode).toBe("RESOURCE_LOCKED");
    });

    it("a delete with a corrupt payload ends delete_failed with its deployment closed, so it can be asked again", async () => {
      const { stackId } = await running();
      const del = await enqueue(stackId, "stack.delete");

      expectFailure(await run(del, runtime(), {}), "STACK_TEMPLATE_INVALID");

      expect(fake.calls).toEqual([]);
      expect((await stackOf(stackId)).status).toBe("delete_failed");
      expect(await deploymentOf(del)).toMatchObject({ status: "failed", problem: "STACK_TEMPLATE_INVALID" });
      expect(await run(await enqueue(stackId, "stack.delete"))).toBeUndefined();
      expect((await stackOf(stackId)).status).toBe("deleted");
    });

    it("an ambiguous delete keeps the stack deleting", async () => {
      const { stackId } = await running();
      fake.failNext("removeAppStack", "ambiguous");
      const del = await enqueue(stackId, "stack.delete");

      expect(((await run(del)) as ControlPlaneError).code).toBe("OPERATION_AMBIGUOUS");

      expect((await stackOf(stackId)).status).toBe("deleting");
      expect(await deploymentOf(del)).toMatchObject({ status: "unknown", problem: "OPERATION_AMBIGUOUS" });
    });
  });

  describe("route refresh (the observer's system stack.deploy, trigger routes)", () => {
    const NOT_NEEDED = ["reserve", "pull", "prepare", "create", "start", "health"] as const;
    const refreshSteps = (publish: [string, string] = ["succeeded", APP_STACK_STEP_DONE_TEXT.publish]) => ({
      ...done("stack.deploy"),
      ...Object.fromEntries(NOT_NEEDED.map((k) => [k, ["skipped", APP_STACK_STEP_NOT_NEEDED_TEXT]])),
      publish,
    });
    const refresh = (stackId: string) => {
      n += 1;
      return enqueueAppStackOperationTransactional(db(), {
        organizationId: ORG,
        stackId,
        kind: "stack.deploy",
        requestedByUserId: null,
        idempotencyKey: `${APP_STACK_ROUTES_KEY_PREFIX}${hex(String(n)).slice(0, 32)}`,
        requestHash: hex(`routes ${String(n)}`),
        revision: null,
        destroyData: false,
      });
    };
    const addHost = (stackId: string, hostname: string) =>
      addAppStackDomainsTransactional(db(), { organizationId: ORG, stackId, entries: [{ hostname, componentKey: "web", internalPort: 8080 }] });
    const routedHosts = (stackId: string) => fake.stack(stackId).routes.flatMap((r) => r.hosts.map((h) => h.hostname)).sort();
    const revisionsOf = async (stackId: string) => (await db().select().from(appStackRevisions).where(eq(appStackRevisions.stackId, stackId))).length;
    const domainStatus = async (hostname: string) =>
      (await db().select().from(appStackDomains).where(eq(appStackDomains.hostname, hostname)))[0]!.status;

    it("a stopped accessory and a removed address: one status read and one publish, nothing started, the address withdrawn", async () => {
      const { stackId, rev, write } = await create([CACHE, WEB]);
      const keep = `keep${String(n)}.example.test`;
      const gone = `gone${String(n)}.example.test`;
      await addHost(stackId, keep);
      await addHost(stackId, gone);
      expect(await run(write)).toBeUndefined();
      expect(routedHosts(stackId)).toEqual([gone, keep]);
      fake.stack(stackId).components.get("cache")!.state = "exited";
      await db().delete(appStackDomains).where(eq(appStackDomains.hostname, gone));
      fake.calls.length = 0;
      const op = await refresh(stackId);

      expect(await run(op)).toBeUndefined();

      expect(trace()).toEqual(["getAppStackStatus", "publishAppStackRoutes"]);
      expect(routedHosts(stackId)).toEqual([keep]);
      const stack = await stackOf(stackId);
      expect(stack).toMatchObject({ status: "degraded", appliedRevisionId: rev.revisionId, desiredRevisionId: rev.revisionId });
      expect(stack.appliedRoutesHash).toBe(appStackRoutesHash(fake.stack(stackId).routes));
      expect(await revisionsOf(stackId)).toBe(1);
      expect(await stepsOf(op)).toEqual(refreshSteps());
      expect(await deploymentOf(op)).toMatchObject({ status: "succeeded", problem: null });
      expect(await healthOf(stackId)).toEqual({ cache: "stopped", web: "healthy" });
    });

    it("the last address removed: exactly a status read and an unpublish, no routes hash", async () => {
      const { stackId } = await running();
      await db().delete(appStackDomains).where(eq(appStackDomains.stackId, stackId));
      const op = await refresh(stackId);

      expect(await run(op)).toBeUndefined();

      expect(trace()).toEqual(["getAppStackStatus", "unpublishAppStackRoutes"]);
      expect(fake.stack(stackId).routes).toEqual([]);
      expect(await stackOf(stackId)).toMatchObject({ status: "running", appliedRoutesHash: null });
      expect(await stepsOf(op)).toEqual(refreshSteps());
    });

    it("an address added while its target is unhealthy stays pending; a later refresh publishes it once the target reads healthy", async () => {
      const { stackId } = await running();
      const added = `added${String(n)}.example.test`;
      await addHost(stackId, added);
      fake.setHealth("web", "unhealthy");
      const first = await refresh(stackId);

      expect(await run(first)).toBeUndefined();

      expect(trace()).toEqual(["getAppStackStatus", "unpublishAppStackRoutes"]);
      expect(fake.stack(stackId).routes).toEqual([]);
      expect(await domainStatus(added)).toBe("pending");
      // A refresh judges no component: the stack stays one the observer refreshes.
      expect(await stackOf(stackId)).toMatchObject({ status: "degraded", appliedRoutesHash: null });

      fake.setHealth("web", "healthy");
      fake.calls.length = 0;
      const second = await refresh(stackId);
      expect(await run(second)).toBeUndefined();

      expect(trace()).toEqual(["getAppStackStatus", "publishAppStackRoutes"]);
      expect(routedHosts(stackId)).toHaveLength(2);
      expect(routedHosts(stackId)).toContain(added);
      expect(await domainStatus(added)).toBe("active");
      expect(await stackOf(stackId)).toMatchObject({ status: "running", appliedRoutesHash: appStackRoutesHash(fake.stack(stackId).routes) });
    });

    it("a publish that fails for sure: degraded, the routes hash and the file unchanged", async () => {
      const { stackId } = await running();
      const before = await stackOf(stackId);
      await addHost(stackId, `more${String(n)}.example.test`);
      fake.failNext("publishAppStackRoutes", "definite");
      const op = await refresh(stackId);

      expectFailure(await run(op), "DOCKER_ENGINE_UNAVAILABLE");

      expect(trace()).toEqual(["getAppStackStatus", "publishAppStackRoutes"]);
      expect(routedHosts(stackId)).toHaveLength(1);
      expect(await stackOf(stackId)).toMatchObject({ status: "degraded", appliedRoutesHash: before.appliedRoutesHash, appliedRevisionId: before.appliedRevisionId });
      expect(await stepsOf(op)).toEqual({ ...refreshSteps(["failed", APP_STACK_STEP_FAILED_TEXT]), settle: ["skipped", APP_STACK_STEP_SKIPPED_TEXT] });
    });

    /** The refresh parked unknown as the worker does, then recovered. */
    async function recovered(op: AppStackWriteResult) {
      expect(((await run(op)) as ControlPlaneError).code).toBe("OPERATION_AMBIGUOUS");
      await transitionOperation(db(), op.operation!.id, "unknown");
      fake.calls.length = 0;
      expect(await runtime().recover(await opOf(op.operation!.id))).toBe("settled");
      expect(trace()).toEqual(["getAppStackStatus"]);
      fake.calls.length = 0;
    }

    it("an unpublish in doubt while the target is unhealthy: recovered degraded, never failed, and the next refresh restores the routes", async () => {
      const { stackId } = await running();
      fake.setHealth("web", "unhealthy");
      fake.failNext("unpublishAppStackRoutes", "ambiguous");
      const op = await refresh(stackId);

      await recovered(op);

      expect(await opOf(op.operation!.id)).toMatchObject({ status: "succeeded" });
      expect(await stackOf(stackId)).toMatchObject({ status: "degraded", appliedRoutesHash: null });
      fake.setHealth("web", "healthy");
      expect(await run(await refresh(stackId))).toBeUndefined();
      expect(trace()).toEqual(["getAppStackStatus", "publishAppStackRoutes"]);
      expect(routedHosts(stackId)).toHaveLength(1);
      expect(await stackOf(stackId)).toMatchObject({ status: "running", appliedRoutesHash: appStackRoutesHash(fake.stack(stackId).routes) });
    });

    it("a publish in doubt with an accessory missing: recovered degraded with a routes hash the next refresh rewrites", async () => {
      const { stackId } = await running();
      await addHost(stackId, `added${String(n)}.example.test`);
      fake.stack(stackId).components.delete("cache");
      fake.failNext("publishAppStackRoutes", "ambiguous");
      const op = await refresh(stackId);

      await recovered(op);

      expect(await opOf(op.operation!.id)).toMatchObject({ status: "succeeded" });
      const stack = await stackOf(stackId);
      expect(stack.status).toBe("degraded");
      expect(routedHosts(stackId)).toHaveLength(2);
      expect(stack.appliedRoutesHash).not.toBeNull();
      expect(stack.appliedRoutesHash).not.toBe(appStackRoutesHash(fake.stack(stackId).routes));
      expect(await run(await refresh(stackId))).toBeUndefined();
      expect(trace()).toEqual(["getAppStackStatus", "publishAppStackRoutes"]);
      expect((await stackOf(stackId)).appliedRoutesHash).toBe(appStackRoutesHash(fake.stack(stackId).routes));
    });

    it("the last address removed while the certificate read fails: no certificate read, the routes unpublished", async () => {
      const { stackId } = await running();
      await db().delete(appStackDomains).where(eq(appStackDomains.stackId, stackId));
      const certificates = vi.spyOn(fake, "getCertificateStatus").mockRejectedValue(new Error("certificate read failed"));
      const op = await refresh(stackId);

      expect(await run(op)).toBeUndefined();

      expect(certificates).not.toHaveBeenCalled();
      expect(trace()).toEqual(["getAppStackStatus", "unpublishAppStackRoutes"]);
      expect(fake.stack(stackId).routes).toEqual([]);
      expect(await stackOf(stackId)).toMatchObject({ status: "running", appliedRoutesHash: null });
    });
  });

  it("(14) the secret reaches only the start call, at the version the plan pins", async () => {
    const sentinel = `SENTINEL-${randomBytes(8).toString("hex")}`;
    const web = component("web", { secretFiles: [{ envName: "APP_SECRET_FILE", parameterKey: "app_secret", version: 1 }] });
    const { stackId, write } = await create([CACHE, web]);
    const secret = (value: string) =>
      setAppStackSecretTransactional(db(), { organizationId: ORG, stackId, parameterKey: "app_secret", value, masterKey: config.secretsMasterKey });
    await secret(`${sentinel}-v1`);
    await secret(`${sentinel}-v2`);

    const err = await run(write);

    expect(err).toBeUndefined();
    const carriers = fake.calls.filter((c) => JSON.stringify(c.request).includes(sentinel));
    expect(carriers.map((c) => `${c.method}:${c.componentKey ?? ""}`)).toEqual(["startAppStackComponent:web"]);
    expect((carriers[0]!.request as Json)["secretFileContents"]).toEqual([{ parameterKey: "app_secret", version: 1, content: `${sentinel}-v1` }]);
    const cacheStart = fake.calls.find((c) => c.componentKey === "cache")!;
    expect((cacheStart.request as Json)["secretFileContents"]).toEqual([]);

    const rowsOf = (result: unknown): Json[] => (Array.isArray(result) ? result : ((result as { rows?: Json[] }).rows ?? [])) as Json[];
    const tables = rowsOf(
      await db().execute(sql`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`),
    ).map((r) => String(r["table_name"]));
    for (const table of tables) {
      const dump = JSON.stringify(rowsOf(await db().execute(sql.raw(`select row_to_json(t)::text as j from "${table}" t`))));
      expect(dump.includes(sentinel), table).toBe(false);
    }
    expect((await db().select().from(appStackSecrets).where(eq(appStackSecrets.stackId, stackId))).length).toBe(2);
  });
});
