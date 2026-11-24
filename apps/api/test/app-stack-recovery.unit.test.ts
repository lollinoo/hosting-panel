import { createHash, randomBytes } from "node:crypto";
import {
  ApprovedStackPlanSchema,
  type AppStackOperationKind,
  type AppStackPlanComponent,
  type AppStackStepKey,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import {
  addAppStackDomainsTransactional,
  appStackComponents,
  appStackDeployments,
  appStackDomains,
  appStackRevisions,
  appStacks,
  appStackVolumes,
  auditEvents,
  createAppStackTransactional,
  createAppTemplate,
  createDatabaseClient,
  enqueueAppStackOperationTransactional,
  eq,
  hostAllocations,
  hosts,
  newAppEntityId,
  operations,
  operationSteps,
  organizations,
  platformInstallations,
  resourceQuotas,
  sql,
  transitionOperation,
  updateAppTemplate,
  type AppStackWriteResult,
  type DatabaseClient,
  type NewAppStackRevision,
} from "@hosting-panel/database";
import { isStackExecutor, Phase1DisabledDockerExecutor, type DockerExecutorPort } from "@hosting-panel/executor-contracts";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import { computeAppStackPlanHash } from "@hosting-panel/hosting-domain";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppStackRuntime } from "../src/app-stacks/app-stack-runtime.js";
import {
  APP_STACK_FAILURE,
  APP_STACK_ROUTES_KEY_PREFIX,
  APP_STACK_STEP_DONE_TEXT,
  APP_STACK_STEP_FAILED_TEXT,
} from "../src/app-stacks/app-stack-runtime-policy.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import type { SiteProvisioner } from "../src/runtime/site-provisioner.js";
import type { SiteDomainsApplier } from "../src/sites/site-domains-applier.js";
import type { SiteFilesApplier } from "../src/sites/site-files-applier.js";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";
import { FakeStackExecutor } from "./support/fake-stack-executor.js";

// RT4: recovery of a stack operation parked `unknown`. Each scenario drives the real handler into an ambiguous
// failure with the scripted fake, parks the operation as the worker does, then recovers through a port that throws on
// every method but the two reads (A17: no continuation, no replay).

const ORG = "org_rt4";
const ALLOC = "alloc_rt4";
const QUOTA = "quota_rt4";
const NGINX = `nginxinc/nginx-unprivileged@sha256:${"a".repeat(64)}`;
const MEMCACHED = `memcached@sha256:${"b".repeat(64)}`;
const START = Date.UTC(2026, 10, 22, 12);
const READS = new Set(["getAppStackStatus", "getAppStackComponentLogs"]);
const INTERRUPTED = APP_STACK_FAILURE.OPERATION_INTERRUPTED;
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");

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

describe("recoverAppStackOperation (RT4)", () => {
  let dbClient: DatabaseClient;
  let versionId = "";
  let n = 0;
  let fake: ReturnType<typeof FakeStackExecutor.create>;
  let clock: { now(): number; sleep(ms: number): Promise<void> };
  /** Mutating calls attempted during any recovery: must stay empty (checked after every test). */
  const violations: string[] = [];
  /** Every executor method recovery called, across the file. */
  const recoveryCalls: string[] = [];
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

  /** A port that forwards the two reads and throws on every other method (DockerExecutorPort ones included). */
  function readOnly(target: object): DockerExecutorPort {
    return new Proxy(target, {
      get(t, prop) {
        const value: unknown = Reflect.get(t, prop, t);
        if (typeof value !== "function") return value;
        const name = String(prop);
        return (...args: unknown[]) => {
          recoveryCalls.push(name);
          if (!READS.has(name)) {
            violations.push(name);
            throw new Error("mutating call during recovery");
          }
          return (value as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    }) as DockerExecutorPort;
  }

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

  async function create() {
    n += 1;
    const stackId = newAppEntityId("stk");
    const rev = revision(stackId, [CACHE, WEB]);
    const write = await createAppStackTransactional(db(), {
      stackId,
      organizationId: ORG,
      hostAllocationId: ALLOC,
      templateVersionId: versionId,
      name: `Stack ${String(n)}`,
      createdBy: null,
      idempotencyKey: `rt4-${String(n)}`,
      requestHash: hex(`create ${String(n)}`),
      deploy: rev,
    });
    await addAppStackDomainsTransactional(db(), {
      organizationId: ORG,
      stackId,
      entries: [{ hostname: `app${String(n)}.example.test`, componentKey: "web", internalPort: 8080 }],
    });
    return { stackId, rev, write };
  }

  function enqueue(stackId: string, kind: AppStackOperationKind, rev: NewAppStackRevision | null = null) {
    n += 1;
    return enqueueAppStackOperationTransactional(db(), {
      organizationId: ORG,
      stackId,
      kind,
      requestedByUserId: null,
      idempotencyKey: `rt4-${String(n)}`,
      requestHash: hex(`enqueue ${String(n)}`),
      revision: rev,
      destroyData: false,
    });
  }

  /** What the worker does: processing, the handler, and on OPERATION_AMBIGUOUS the operation parked unknown. */
  async function apply(write: AppStackWriteResult): Promise<string | undefined> {
    const op = write.operation!;
    await transitionOperation(db(), op.id, "processing");
    try {
      await new AppStackRuntime(dbClient, fake, config, clock).apply(op, {
        operationId: op.id,
        stackId: write.stack.id,
        deploymentId: write.deployment!.id,
        revisionId: write.deployment!.revisionId,
      });
      return undefined;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "OPERATION_AMBIGUOUS") await transitionOperation(db(), op.id, "unknown");
      return code;
    }
  }

  async function parked(write: AppStackWriteResult): Promise<void> {
    expect(await apply(write)).toBe("OPERATION_AMBIGUOUS");
    expect((await opOf(write)).status).toBe("unknown");
    fake.calls.length = 0;
  }

  async function recover(write: AppStackWriteResult, executor: object = fake, cfg = config) {
    return new AppStackRuntime(dbClient, readOnly(executor), cfg, clock).recover(await opOf(write));
  }

  /** The worker's recovery pass (it routes stack kinds to AppStackRuntime.recover), on the read-only port. */
  function worker(): OutboxWorkerService {
    const port = readOnly(fake);
    return new OutboxWorkerService(
      dbClient,
      port,
      {} as unknown as HostAgentPort,
      config,
      {} as unknown as SiteProvisioner,
      {} as unknown as SiteDomainsApplier,
      {} as unknown as SiteFilesApplier,
      undefined,
      undefined,
      undefined,
      new AppStackRuntime(dbClient, port, config, clock),
    );
  }

  /** A first deploy brought to running with a web address, the fake's trace cleared. */
  async function running() {
    const created = await create();
    expect(await apply(created.write)).toBeUndefined();
    expect((await stackOf(created.stackId)).status).toBe("running");
    fake.calls.length = 0;
    return created;
  }

  const trace = () => fake.calls.map((c) => c.method);
  const stackOf = async (id: string) => (await db().select().from(appStacks).where(eq(appStacks.id, id)))[0]!;
  const opOf = async (write: AppStackWriteResult) => (await db().select().from(operations).where(eq(operations.id, write.operation!.id)))[0]!;
  const deploymentOf = async (write: AppStackWriteResult) =>
    (await db().select().from(appStackDeployments).where(eq(appStackDeployments.id, write.deployment!.id)))[0]!;
  const stepsOf = async (write: AppStackWriteResult) =>
    Object.fromEntries((await db().select().from(operationSteps).where(eq(operationSteps.operationId, write.operation!.id))).map((s) => [s.key, s.status]));
  const healthOf = async (stackId: string) =>
    Object.fromEntries((await db().select().from(appStackComponents).where(eq(appStackComponents.stackId, stackId))).map((c) => [c.componentKey, c.health]));
  const volumesOf = async (stackId: string) =>
    Object.fromEntries((await db().select().from(appStackVolumes).where(eq(appStackVolumes.stackId, stackId))).map((v) => [v.volumeKey, v.status]));
  const domainsOf = async (stackId: string) => (await db().select().from(appStackDomains).where(eq(appStackDomains.stackId, stackId))).length;
  const usedCpu = async () => (await db().select().from(resourceQuotas).where(eq(resourceQuotas.id, QUOTA)))[0]!.usedCpuMilli;
  const expectInterrupted = async (write: AppStackWriteResult) => {
    expect(await opOf(write)).toMatchObject({ status: "failed", errorCode: INTERRUPTED.code, errorMessage: INTERRUPTED.text });
    expect(await deploymentOf(write)).toMatchObject({ status: "failed", problem: "OPERATION_INTERRUPTED" });
  };

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await db().insert(platformInstallations).values({ id: "pin_rt4", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_rt4",
      platformInstallationId: "pin_rt4",
      name: "rt4-host",
      hostname: "panel.rt4.example",
      ipv4Address: "10.0.0.64",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    await db().insert(organizations).values({ id: ORG, platformInstallationId: "pin_rt4", name: ORG, slug: "org-rt4" });
    await db().insert(hostAllocations).values({ id: ALLOC, hostId: "hst_rt4", organizationId: ORG, status: "active" });
    await db().insert(resourceQuotas).values({
      id: QUOTA,
      organizationId: ORG,
      hostAllocationId: ALLOC,
      maxSites: 10,
      maxServices: 1000,
      maxCpuMilli: 1_000_000,
      maxMemoryBytes: "1000000000000",
      maxStorageBytes: "1000000000000",
    });
    const template = await createAppTemplate(db(), {
      slug: "rt4-demo",
      name: "rt4-demo",
      description: null,
      category: "web",
      createdBy: null,
      firstVersion: { source: "source rt4", specVersion: 1, compiledSchema: {}, specHash: hex("rt4") },
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
    clock = {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    };
  });

  afterEach(() => {
    expect(violations).toEqual([]);
  });

  it("(1) A17: a deploy in doubt after create, observed created but not running, settles failed", async () => {
    const { stackId, rev, write } = await create();
    fake.failNext("createAppStackComponents", "ambiguous");
    await parked(write);
    expect((await stackOf(stackId)).status).toBe("unknown");

    const recovered = async () =>
      (await db().select().from(auditEvents).where(eq(auditEvents.targetId, write.operation!.id))).filter((a) => a.action.startsWith("operation.recovered."));

    expect(await worker().recoverUnknownOperations()).toMatchObject({ convergedFailed: 1, convergedSucceeded: 0 });

    expect(trace()).toEqual(["getAppStackStatus"]);
    await expectInterrupted(write);
    expect((await stackOf(stackId)).status).toBe("failed");
    expect((await stackOf(stackId)).appliedRevisionId).toBe(rev.revisionId);
    expect(await healthOf(stackId)).toEqual({ cache: "stopped", web: "stopped" });
    expect(await stepsOf(write)).toMatchObject({ validate: "succeeded", prepare: "succeeded", create: "failed", start: "failed", settle: "failed" });
    expect((await recovered()).map((a) => a.action)).toEqual(["operation.recovered.failed"]);
    // Settled once: another pass finds nothing in doubt.
    expect(await worker().recoverUnknownOperations()).toMatchObject({ convergedFailed: 0, convergedSucceeded: 0 });
    expect(await recovered()).toHaveLength(1);
  });

  it("(2) everything running with matching hashes and healthy settles succeeded, routes hash as it was", async () => {
    const { stackId, rev, write } = await create();
    fake.failNext("publishAppStackRoutes", "ambiguous");
    await parked(write);
    expect((await stackOf(stackId)).appliedRevisionId).toBeNull();

    expect(await recover(write)).toBe("settled");

    expect(trace()).toEqual(["getAppStackStatus"]);
    expect(await opOf(write)).toMatchObject({ status: "succeeded", errorCode: null });
    expect(await deploymentOf(write)).toMatchObject({ status: "succeeded", problem: null });
    const stack = await stackOf(stackId);
    expect(stack).toMatchObject({ status: "running", appliedRevisionId: rev.revisionId, appliedRoutesHash: null });
    expect(await healthOf(stackId)).toEqual({ cache: "healthy", web: "healthy" });
    const steps = await db().select().from(operationSteps).where(eq(operationSteps.operationId, write.operation!.id));
    expect(steps.every((s) => s.status === "succeeded" && s.message === APP_STACK_STEP_DONE_TEXT[s.key as AppStackStepKey])).toBe(true);
  });

  it("(3) a failed status read keeps the operation unknown with its lock; the next pass settles", async () => {
    const { stackId, write } = await create();
    fake.failNext("createAppStackComponents", "ambiguous");
    await parked(write);
    fake.failNext("getAppStackStatus", "definite");

    expect(await recover(write)).toBe("pending");

    expect((await opOf(write)).status).toBe("unknown");
    expect((await stackOf(stackId)).status).toBe("unknown");
    expect(await deploymentOf(write)).toMatchObject({ status: "unknown", problem: "OPERATION_AMBIGUOUS" });
    await expect(enqueue(stackId, "stack.start")).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

    expect(await recover(write)).toBe("settled");
    expect(trace()).toEqual(["getAppStackStatus", "getAppStackStatus"]);
    await expectInterrupted(write);
    expect((await stackOf(stackId)).status).toBe("failed");
  });

  it("(4) a delete in doubt stays deleting until removal is certified: remnants ⇒ delete_failed, clean ⇒ deleted", async () => {
    const left = await running();
    const del = await enqueue(left.stackId, "stack.delete");
    fake.failNext("stopAppStack", "ambiguous");
    await parked(del);
    expect((await stackOf(left.stackId)).status).toBe("deleting");

    expect(await recover(del)).toBe("settled");

    await expectInterrupted(del);
    const kept = await stackOf(left.stackId);
    expect(kept).toMatchObject({ status: "delete_failed", deletedAt: null });
    expect(kept.resourceQuotaId).toBe(QUOTA);
    expect(await volumesOf(left.stackId)).toEqual({ data: "present" });
    expect(await domainsOf(left.stackId)).toBe(1);
    expect(Object.keys(await healthOf(left.stackId)).sort()).toEqual(["cache", "web"]);

    const gone = await running();
    const before = await usedCpu();
    const clean = await enqueue(gone.stackId, "stack.delete");
    fake.failNext("removeAppStack", "ambiguous");
    await parked(clean);
    fake.failNext("getAppStackStatus", "definite");
    expect(await recover(clean)).toBe("pending");
    expect((await stackOf(gone.stackId)).status).toBe("deleting");
    expect((await opOf(clean)).status).toBe("unknown");

    expect(await recover(clean)).toBe("settled");

    expect(trace()).toEqual(["getAppStackStatus", "getAppStackStatus"]);
    expect(await opOf(clean)).toMatchObject({ status: "succeeded" });
    expect(await deploymentOf(clean)).toMatchObject({ status: "succeeded" });
    const deleted = await stackOf(gone.stackId);
    expect(deleted.status).toBe("deleted");
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.resourceQuotaId).toBeNull();
    expect(await usedCpu()).toBe(before - 500);
    expect(await volumesOf(gone.stackId)).toEqual({ data: "retained" });
    expect(await domainsOf(gone.stackId)).toBe(0);
  });

  it("(5) a stop in doubt: all stopped ⇒ stopped; one still running ⇒ failed, stack degraded", async () => {
    const all = await running();
    const stop = await enqueue(all.stackId, "stack.stop");
    fake.failNext("stopAppStack", "ambiguous");
    await parked(stop);
    expect((await stackOf(all.stackId)).status).toBe("unknown");

    expect(await recover(stop)).toBe("settled");

    expect(await opOf(stop)).toMatchObject({ status: "succeeded" });
    expect(await stackOf(all.stackId)).toMatchObject({ status: "stopped", appliedRoutesHash: null });
    expect(await healthOf(all.stackId)).toEqual({ cache: "stopped", web: "stopped" });

    const one = await running();
    const stop2 = await enqueue(one.stackId, "stack.stop");
    fake.failNext("unpublishAppStackRoutes", "ambiguous");
    await parked(stop2);
    fake.stack(one.stackId).components.get("cache")!.state = "exited";

    expect(await recover(stop2)).toBe("settled");

    await expectInterrupted(stop2);
    expect(await stackOf(one.stackId)).toMatchObject({ status: "degraded", appliedRoutesHash: null });
    expect(await healthOf(one.stackId)).toEqual({ cache: "stopped", web: "healthy" });
    expect((await stepsOf(stop2))["stop"]).toBe("failed");
  });

  it("(6) with no stack port recovery reads nothing and fails closed", async () => {
    const deploy = await create();
    fake.failNext("createAppStackComponents", "ambiguous");
    await parked(deploy.write);

    expect(await recover(deploy.write, new Phase1DisabledDockerExecutor())).toBe("settled");

    await expectInterrupted(deploy.write);
    expect((await stackOf(deploy.stackId)).status).toBe("failed");

    const { stackId } = await running();
    const del = await enqueue(stackId, "stack.delete");
    fake.failNext("removeAppStack", "ambiguous");
    await parked(del);

    expect(await recover(del, fake, { ...config, runtimeBackend: "disabled" })).toBe("settled");

    expect(trace()).toEqual([]);
    await expectInterrupted(del);
    expect(await stackOf(stackId)).toMatchObject({ status: "delete_failed", deletedAt: null });
    const steps = await db().select().from(operationSteps).where(eq(operationSteps.operationId, del.operation!.id));
    expect(steps.filter((s) => s.status === "failed").every((s) => s.message === APP_STACK_STEP_FAILED_TEXT)).toBe(true);
  });

  it("(8) an upgrade in doubt at pull, the previous revision still serving: failed, the stack keeps its status and revision", async () => {
    const { stackId, rev } = await running();
    const routesHash = (await stackOf(stackId)).appliedRoutesHash;
    expect(routesHash).not.toBeNull();
    const v2 = revision(stackId, [CACHE, { ...WEB, environment: [{ name: "CACHE_HOST", value: "cache" }] }]);
    const upgrade = await enqueue(stackId, "stack.upgrade", v2);
    fake.failNext("pullAppStackImage", "ambiguous");
    await parked(upgrade);
    expect((await stackOf(stackId)).status).toBe("unknown");

    expect(await recover(upgrade)).toBe("settled");

    expect(trace()).toEqual(["getAppStackStatus"]);
    await expectInterrupted(upgrade);
    // The create step never started, so nothing of the new revision exists: its target is taken back.
    expect(await stackOf(stackId)).toMatchObject({
      status: "running",
      appliedRevisionId: rev.revisionId,
      desiredRevisionId: rev.revisionId,
      appliedRoutesHash: routesHash,
    });
    expect(await healthOf(stackId)).toEqual({ cache: "healthy", web: "healthy" });
    expect(fake.stack(stackId).routes).toHaveLength(1);
  });

  it("(8b) an upgrade in doubt at create keeps its target even while the previous revision is what shows: it may be creating", async () => {
    const { stackId, rev } = await running();
    const components = new Map(fake.stack(stackId).components);
    const v2 = revision(stackId, [CACHE, { ...WEB, environment: [{ name: "CACHE_HOST", value: "cache" }] }]);
    const upgrade = await enqueue(stackId, "stack.upgrade", v2);
    fake.failNext("createAppStackComponents", "ambiguous");
    await parked(upgrade);
    // The answer was lost before the executor replaced anything.
    for (const [key, value] of components) fake.stack(stackId).components.set(key, { ...value });

    expect(await recover(upgrade)).toBe("settled");

    expect(await stepsOf(upgrade)).toMatchObject({ pull: "succeeded", prepare: "succeeded", create: "failed" });
    expect(await stackOf(stackId)).toMatchObject({ status: "running", appliedRevisionId: rev.revisionId, desiredRevisionId: v2.revisionId });
  });

  it("(8c) a stopped application whose upgrade or redeploy is in doubt before create settles stopped (#129)", async () => {
    const { stackId, rev } = await running();
    expect(await apply(await enqueue(stackId, "stack.stop"))).toBeUndefined();
    expect((await stackOf(stackId)).status).toBe("stopped");
    const v2 = revision(stackId, [CACHE, { ...WEB, environment: [{ name: "CACHE_HOST", value: "cache" }] }]);
    const upgrade = await enqueue(stackId, "stack.upgrade", v2);
    fake.failNext("prepareAppStack", "ambiguous");
    await parked(upgrade);
    expect((await stackOf(stackId)).status).toBe("unknown");

    expect(await recover(upgrade)).toBe("settled");

    expect(trace()).toEqual(["getAppStackStatus"]);
    await expectInterrupted(upgrade);
    expect(await stepsOf(upgrade)).toMatchObject({ pull: "succeeded", prepare: "failed", create: "failed" });
    expect(await stackOf(stackId)).toMatchObject({ status: "stopped", appliedRevisionId: rev.revisionId, desiredRevisionId: rev.revisionId, appliedRoutesHash: null });
    expect(await healthOf(stackId)).toEqual({ cache: "stopped", web: "stopped" });

    // A deploy is not taken back, and its application stays stopped all the same.
    const redeploy = await enqueue(stackId, "stack.deploy");
    fake.failNext("pullAppStackImage", "ambiguous");
    await parked(redeploy);
    expect(await recover(redeploy)).toBe("settled");
    await expectInterrupted(redeploy);
    expect(await stackOf(stackId)).toMatchObject({ status: "stopped", appliedRevisionId: rev.revisionId });
  });

  it("(8d) a stopped application that never ran, whose upgrade is in doubt before create, ends failed as before (#129)", async () => {
    // A first install refused at create leaves no applied revision.
    const { stackId, write } = await create();
    fake.failNext("createAppStackComponents", "definite");
    expect(await apply(write)).toBe(APP_STACK_FAILURE.DOCKER_ENGINE_UNAVAILABLE.code);
    expect(await stackOf(stackId)).toMatchObject({ status: "failed", appliedRevisionId: null });
    expect(await apply(await enqueue(stackId, "stack.stop"))).toBeUndefined();
    expect((await stackOf(stackId)).status).toBe("stopped");
    const v2 = revision(stackId, [CACHE, WEB, component("extra")], [{ componentKey: "extra", port: 8080 }, ...INGRESS]);
    const upgrade = await enqueue(stackId, "stack.upgrade", v2);
    await addAppStackDomainsTransactional(db(), {
      organizationId: ORG,
      stackId,
      entries: [{ hostname: `extra${String(n)}.example.test`, componentKey: "extra", internalPort: 8080 }],
    });
    fake.failNext("pullAppStackImage", "ambiguous");
    await parked(upgrade);

    expect(await recover(upgrade)).toBe("settled");

    expect(trace()).toEqual(["getAppStackStatus"]);
    await expectInterrupted(upgrade);
    expect(await stepsOf(upgrade)).toMatchObject({ pull: "failed", create: "failed" });
    // Not taken back: the address points at a part only the new version has.
    expect(await stackOf(stackId)).toMatchObject({ status: "failed", appliedRevisionId: null, desiredRevisionId: v2.revisionId });
  });

  it("(8e) a stopped application whose applied revision no longer reads still settles stopped: one was applied (#129)", async () => {
    const { stackId, rev } = await running();
    expect(await apply(await enqueue(stackId, "stack.stop"))).toBeUndefined();
    const v2 = revision(stackId, [CACHE, { ...WEB, environment: [{ name: "CACHE_HOST", value: "cache" }] }]);
    const upgrade = await enqueue(stackId, "stack.upgrade", v2);
    fake.failNext("prepareAppStack", "ambiguous");
    await parked(upgrade);
    // Revisions are immutable: only this test can make the applied one's plan unreadable.
    await db().execute(sql`ALTER TABLE app_stack_revisions DISABLE TRIGGER trg_prevent_app_stack_revisions_mutation`);
    await db().update(appStackRevisions).set({ plan: { ...rev.plan, schemaVersion: 99 } }).where(eq(appStackRevisions.id, rev.revisionId));
    await db().execute(sql`ALTER TABLE app_stack_revisions ENABLE TRIGGER trg_prevent_app_stack_revisions_mutation`);

    expect(await recover(upgrade)).toBe("settled");

    expect(trace()).toEqual(["getAppStackStatus"]);
    await expectInterrupted(upgrade);
    expect(await stackOf(stackId)).toMatchObject({ status: "stopped", appliedRevisionId: rev.revisionId, desiredRevisionId: rev.revisionId });
  });

  it("(9) routes observed published keep the stored routes hash", async () => {
    const { stackId } = await running();
    const routesHash = (await stackOf(stackId)).appliedRoutesHash;
    const restart = await enqueue(stackId, "stack.restart");
    fake.failNext("restartAppStackComponent", "ambiguous");
    await parked(restart);

    expect(await recover(restart)).toBe("settled");

    expect(await opOf(restart)).toMatchObject({ status: "succeeded" });
    expect(await stackOf(stackId)).toMatchObject({ status: "running", appliedRoutesHash: routesHash });
  });

  /** The observer's route refresh: a system stack.deploy under the routes key prefix. */
  function refresh(stackId: string) {
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
  }

  it("(10) a route refresh in doubt while its target is unhealthy settles as the refresh would have: degraded, never failed", async () => {
    const { stackId, rev } = await running();
    fake.setHealth("web", "unhealthy");
    fake.failNext("unpublishAppStackRoutes", "ambiguous");
    const write = await refresh(stackId);
    await parked(write);

    expect(await recover(write)).toBe("settled");

    expect(trace()).toEqual(["getAppStackStatus"]);
    expect(await opOf(write)).toMatchObject({ status: "succeeded" });
    expect(await stackOf(stackId)).toMatchObject({ status: "degraded", appliedRevisionId: rev.revisionId, appliedRoutesHash: null });
    expect(await healthOf(stackId)).toEqual({ cache: "healthy", web: "unhealthy" });
  });

  it("(11) a route refresh whose routes are not seen as recorded fails, the stack degraded and its routes hash rewritten on the next pass", async () => {
    const { stackId } = await running();
    const before = await stackOf(stackId);
    const added = `added${String(n)}.example.test`;
    await addAppStackDomainsTransactional(db(), { organizationId: ORG, stackId, entries: [{ hostname: added, componentKey: "web", internalPort: 8080 }] });
    fake.failNext("publishAppStackRoutes", "ambiguous");
    const write = await refresh(stackId);
    await parked(write);
    // Removed while the outcome was in doubt: the route written for it must still be withdrawn.
    await db().delete(appStackDomains).where(eq(appStackDomains.hostname, added));

    expect(await recover(write)).toBe("settled");

    await expectInterrupted(write);
    const stack = await stackOf(stackId);
    expect(stack).toMatchObject({ status: "degraded", appliedRevisionId: before.appliedRevisionId });
    // Neither none nor the hash of today's addresses: the observer refreshes again and withdraws the address.
    expect(stack.appliedRoutesHash).not.toBeNull();
    expect(stack.appliedRoutesHash).not.toBe(before.appliedRoutesHash);
  });

  it("(7) no mutating call: every recovery above went through a port that throws on all but the two reads", () => {
    const seen = new Set(recoveryCalls);
    const guarded = readOnly(FakeStackExecutor.create());
    expect(isStackExecutor(guarded)).toBe(true);
    expect(() => (guarded as unknown as FakeStackExecutor).startAppStackComponent({} as never)).toThrow("mutating call during recovery");
    expect(() => guarded.getCertificateStatus({ failuresSince: new Date(START).toISOString() })).toThrow("mutating call during recovery");
    expect(violations).toEqual(["startAppStackComponent", "getCertificateStatus"]);
    violations.length = 0;
    expect([...seen].every((method) => READS.has(method))).toBe(true);
  });
});
