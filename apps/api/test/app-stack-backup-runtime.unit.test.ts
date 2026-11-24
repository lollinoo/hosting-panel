import { createHash, randomBytes } from "node:crypto";
import {
  APP_STACK_BACKUP_STEPS_BY_KIND,
  ApprovedStackPlanSchema,
  PLATFORM_OPS_ORG_ID,
  appStackEnqueueTarget,
  type AppStackBackupOperationKind,
  type AppStackOperationKind,
  type AppStackPlanComponent,
  type ApprovedStackPlan,
  type BackupsIpcRequest,
  type ErrorCode,
} from "@hosting-panel/contracts";
import {
  addAppStackDomainsTransactional,
  and,
  auditEvents,
  appStackBackupCopies,
  appStackBackups,
  appStackDeployments,
  appStacks,
  asc,
  backupTargets,
  createAppStackTransactional,
  createAppTemplate,
  createDatabaseClient,
  enqueueAppStackBackupTransactional,
  enqueueAppStackOperationTransactional,
  eq,
  getPolicy,
  hostAllocations,
  hosts,
  insertS3Target,
  listAppStackBackupRetentionScopes,
  listAppStackBackupsForRetention,
  newAppEntityId,
  operations,
  operationSteps,
  organizations,
  outboxEvents,
  platformInstallations,
  setPolicyTargets,
  transitionOperation,
  unlockOperationBreakGlassTransactional,
  updateAppTemplate,
  type DatabaseClient,
  type NewAppStackRevision,
} from "@hosting-panel/database";
import { SimulatedBackups } from "@hosting-panel/docker-executor";
import type { DockerExecutorPort } from "@hosting-panel/executor-contracts";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import { computeAppStackPlanHash } from "@hosting-panel/hosting-domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { enqueueAppStackPrune, listAppStackPruneCandidates } from "../src/app-stacks/app-stack-backup-retention.js";
import {
  APP_STACK_BACKUP_FAILED_TEXT,
  APP_STACK_BACKUP_POLL_GIVE_UP_MS,
  APP_STACK_BACKUP_POLL_MS,
  APP_STACK_BACKUP_STEP_DONE_TEXT,
  APP_STACK_BACKUP_STEP_NOT_NEEDED_TEXT,
} from "../src/app-stacks/app-stack-backup-runtime.js";
import { AppStackBackupsService } from "../src/app-stacks/app-stack-backups.service.js";
import { AppStackRuntime } from "../src/app-stacks/app-stack-runtime.js";
import {
  APP_STACK_FAILURE,
  APP_STACK_STEP_FAILED_TEXT,
  APP_STACK_STEP_SKIPPED_TEXT,
  APP_STACK_UNCERTAIN_TEXT,
} from "../src/app-stacks/app-stack-runtime-policy.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import {
  RECOVERY_READ_GIVE_UP_MS,
  RECOVERY_UNCONFIRMED_AUDIT_ACTION,
  RECOVERY_UNCONFIRMED_TEXT,
  RecoveryReadBound,
} from "../src/runtime/recovery-read-bound.js";
import type { SiteProvisioner } from "../src/runtime/site-provisioner.js";
import type { SiteDomainsApplier } from "../src/sites/site-domains-applier.js";
import type { SiteFilesApplier } from "../src/sites/site-files-applier.js";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";
import { FakeStackExecutor } from "./support/fake-stack-executor.js";

// ADR-0038: the backup kinds through AppStackRuntime (no worker) on PGlite, with the scripted fake for the
// application and the backup simulator for the jobs. The fake clock's sleep advances time, so polls cost nothing.

/** The next `failures` renewals of an operation's lease throw, as a lost database connection would. */
const lease = vi.hoisted(() => ({ failures: 0 }));
vi.mock("@hosting-panel/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hosting-panel/database")>();
  return {
    ...actual,
    renewOperationLease: async (...args: Parameters<typeof actual.renewOperationLease>) => {
      if (lease.failures > 0) {
        lease.failures -= 1;
        throw new Error("connection terminated");
      }
      return actual.renewOperationLease(...args);
    },
  };
});

const ORG = "org_bk";
const ALLOC = "alloc_bk";
const NGINX = `nginxinc/nginx-unprivileged@sha256:${"a".repeat(64)}`;
const LOCAL = `bkt_${"1".repeat(32)}`;
const START = Date.UTC(2026, 10, 22, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
type OperationRow = typeof operations.$inferSelect;

const WEB: AppStackPlanComponent = {
  key: "web",
  image: NGINX,
  runAsUser: null,
  argv: null,
  environment: [],
  secretFiles: [],
  resources: { cpuMilli: 250, memoryBytes: "134217728" },
  expose: [8080],
  dependsOn: [],
  volumes: [{ volumeKey: "data", containerPath: "/app/data", readOnly: false }],
  healthcheck: { kind: "tcp", port: 8080, intervalSeconds: 10, timeoutSeconds: 3 },
};
const INGRESS = [{ componentKey: "web", port: 8080 }];
const busy = () => Object.assign(new Error("busy"), { code: "RESOURCE_LOCKED" });

describe("AppStackRuntime: backup, restore and clean-up of an application (ADR-0038)", () => {
  let dbClient: DatabaseClient;
  let versionId = "";
  let policyId = "";
  let remote = "";
  let n = 0;
  let fake: ReturnType<typeof FakeStackExecutor.create>;
  let sim: SimulatedBackups;
  /** Runs before a backup request reaches the simulator; throwing refuses the request. */
  let before: ((req: BackupsIpcRequest) => void) | null = null;
  /** Runs after the simulator accepted a request; throwing loses the answer. */
  let after: ((req: BackupsIpcRequest) => void) | null = null;
  let onSleep: (() => void) | null = null;
  let clock: { now(): number; sleep(ms: number): Promise<void>; elapsed(): number; advance(ms: number): void };
  const config: ControlPlaneRuntimeConfig = {
    oidcIssuer: "https://issuer.local",
    oidcAudience: "hosting-panel-api",
    enableDevOidc: true,
    runtimeBackend: "linux-systemd",
    secretsMasterKey: randomBytes(32),
    jwtSigningKeyPem: null,
    autoProcessOutbox: false,
  };
  const db = () => dbClient.db;
  const runtime = (executor: DockerExecutorPort = fake, cfg: ControlPlaneRuntimeConfig = config) =>
    new AppStackRuntime(dbClient, executor, cfg, clock);

  function revision(stackId: string): NewAppStackRevision {
    const revisionId = newAppEntityId("srev");
    const base = {
      schemaVersion: 1 as const,
      stackId,
      organizationId: ORG,
      hostAllocationId: ALLOC,
      templateVersionId: versionId,
      revisionId,
      components: [WEB],
      volumes: [{ key: "data" }],
      ingress: INGRESS,
    };
    const plan: ApprovedStackPlan = { ...base, planHash: computeAppStackPlanHash(base) };
    expect(ApprovedStackPlanSchema.safeParse(plan).success).toBe(true);
    return {
      revisionId,
      templateVersionId: versionId,
      plan,
      planHash: plan.planHash,
      componentKeys: ["web"],
      volumeKeys: ["data"],
      cpuMilli: 250,
      memoryBytes: 134217728,
      parameters: [],
    };
  }

  /** What the worker does around apply: processing first, then the handler; returns what it threw. */
  async function apply(op: OperationRow, rt = runtime()): Promise<unknown> {
    await transitionOperation(db(), op.id, "processing");
    const [deployment] = await db().select().from(appStackDeployments).where(eq(appStackDeployments.operationId, op.id));
    try {
      await rt.apply(op, { operationId: op.id, stackId: op.resourceId, deploymentId: deployment?.id, revisionId: deployment?.revisionId });
      return undefined;
    } catch (err) {
      return err;
    }
  }

  const trace = () => fake.calls.map((c) => c.method);
  const stackOf = async (id: string) => (await db().select().from(appStacks).where(eq(appStacks.id, id)))[0]!;
  const opOf = async (id: string) => (await db().select().from(operations).where(eq(operations.id, id)))[0]!;
  const backupOf = async (id: string) => (await db().select().from(appStackBackups).where(eq(appStackBackups.id, id)))[0]!;
  const copiesOf = (backupId: string) =>
    db().select().from(appStackBackupCopies).where(eq(appStackBackupCopies.backupId, backupId)).orderBy(asc(appStackBackupCopies.priority));
  const stepsOf = async (operationId: string) =>
    Object.fromEntries(
      (await db().select().from(operationSteps).where(eq(operationSteps.operationId, operationId))).map((s) => [s.key, [s.status, s.message]]),
    );
  const done = (kind: AppStackBackupOperationKind) =>
    Object.fromEntries(APP_STACK_BACKUP_STEPS_BY_KIND[kind].map((k) => [k, ["succeeded", APP_STACK_BACKUP_STEP_DONE_TEXT[k]]]));
  const FAILED = ["failed", APP_STACK_STEP_FAILED_TEXT];
  const SKIPPED = ["skipped", APP_STACK_STEP_SKIPPED_TEXT];
  const NOT_NEEDED = ["skipped", APP_STACK_BACKUP_STEP_NOT_NEEDED_TEXT];
  const expectFailed = (err: unknown, code: ErrorCode, kind: AppStackBackupOperationKind) => {
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).code).toBe(code);
    expect((err as ControlPlaneError).message).toBe(APP_STACK_BACKUP_FAILED_TEXT[kind]);
  };
  const expectParked = (err: unknown) => {
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect((err as ControlPlaneError).code).toBe("OPERATION_AMBIGUOUS");
    expect((err as ControlPlaneError).message).toBe(APP_STACK_UNCERTAIN_TEXT);
  };

  async function lifecycle(stackId: string, kind: AppStackOperationKind) {
    n += 1;
    const write = await enqueueAppStackOperationTransactional(db(), {
      organizationId: ORG,
      stackId,
      kind,
      requestedByUserId: null,
      idempotencyKey: `bk-${String(n)}`,
      requestHash: hex(`lifecycle ${String(n)}`),
      revision: null,
      destroyData: false,
    });
    expect(await apply(write.operation!)).toBeUndefined();
  }

  /** An application with one data volume and a web address, brought to running; the fake's trace cleared afterwards. */
  async function running() {
    n += 1;
    const stackId = newAppEntityId("stk");
    const rev = revision(stackId);
    const write = await createAppStackTransactional(db(), {
      stackId,
      organizationId: ORG,
      hostAllocationId: ALLOC,
      templateVersionId: versionId,
      name: `Stack ${String(n)}`,
      createdBy: null,
      idempotencyKey: `bk-${String(n)}`,
      requestHash: hex(`create ${String(n)}`),
      deploy: rev,
    });
    await addAppStackDomainsTransactional(db(), {
      organizationId: ORG,
      stackId,
      entries: [{ hostname: `bk${String(n)}.example.test`, componentKey: "web", internalPort: 8080 }],
    });
    expect(await apply(write.operation!)).toBeUndefined();
    expect((await stackOf(stackId)).status).toBe("running");
    fake.calls.length = 0;
    return { stackId, rev };
  }

  async function stopped() {
    const created = await running();
    await lifecycle(created.stackId, "stack.stop");
    expect((await stackOf(created.stackId)).status).toBe("stopped");
    fake.calls.length = 0;
    return created;
  }

  function request(stackId: string, kind: "stack.backup" | "stack.restore" = "stack.backup", sourceBackupId: string | null = null) {
    n += 1;
    return enqueueAppStackBackupTransactional(db(), {
      organizationId: ORG,
      stackId,
      kind,
      sourceBackupId,
      requestedByUserId: null,
      idempotencyKey: `bk-${String(n)}`,
      requestHash: hex(`backup ${String(n)}`),
      limited: false,
    });
  }

  /** The operation a backup or a restore queued to bring the application back, if any. */
  const resumeOf = async (operationId: string) =>
    (await db().select().from(operations).where(eq(operations.idempotencyKey, `resume:${operationId}`)))[0] ?? null;

  /** Throws when the application's lock is free: an action asked now would be queued. */
  async function expectLocked(stackId: string) {
    n += 1;
    await expect(
      enqueueAppStackOperationTransactional(db(), {
        organizationId: ORG,
        stackId,
        kind: "stack.start",
        requestedByUserId: null,
        idempotencyKey: `bk-${String(n)}`,
        requestHash: hex(`lifecycle ${String(n)}`),
        revision: null,
        destroyData: false,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
  }

  /** Runs that operation as the worker would on its next pass. */
  async function resume(operationId: string) {
    const next = await resumeOf(operationId);
    expect(next?.status).toBe("queued");
    expect(await apply(next!)).toBeUndefined();
  }

  /** A running application with one good backup, running again after it. */
  async function withBackup() {
    const { stackId } = await running();
    const { operation, backup } = await request(stackId);
    expect(await apply(operation)).toBeUndefined();
    await resume(operation.id);
    expect((await stackOf(stackId)).status).toBe("running");
    fake.calls.length = 0;
    return { stackId, source: await backupOf(backup.id) };
  }

  /** Good backups of a stopped application, oldest first, one hour apart, the newest one hour before START. */
  async function backups(stackId: string, count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const { operation, backup } = await request(stackId);
      expect(await apply(operation)).toBeUndefined();
      await db()
        .update(appStackBackups)
        .set({ startedAt: new Date(START - (count - i) * HOUR) })
        .where(eq(appStackBackups.id, backup.id));
      ids.push(backup.id);
    }
    return ids;
  }

  /**
   * `count` restores that fail while writing, one hour apart before START: the first from `sourceId`, the next ones
   * from the first safety backup, as the page advises. Returns the safety backups, oldest first.
   */
  async function failedRestores(stackId: string, sourceId: string, count: number): Promise<string[]> {
    const safety: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const { operation: op, backup } = await request(stackId, "stack.restore", i === 0 ? sourceId : safety[0]!);
      await db()
        .update(appStackBackups)
        .set({ startedAt: new Date(START - (count - i) * HOUR) })
        .where(eq(appStackBackups.id, backup.id));
      before = (req) => {
        if (req.action === "stackRestore") sim.failNext("no_space");
      };
      expectFailed(await apply(op), "INTERNAL_ERROR", "stack.restore");
      expect((await stackOf(stackId)).status).toBe("stopped");
      safety.push(backup.id);
    }
    before = null;
    return safety;
  }

  /** What the Backup section of the application's page reads. */
  const page = async (stackId: string) => new AppStackBackupsService(dbClient, config, fake).list(await stackOf(stackId));

  /** The nightly request for one application. */
  async function prune(stackId: string): Promise<OperationRow> {
    expect(await enqueueAppStackPrune(db(), stackId)).toBe(true);
    const [op] = await db()
      .select()
      .from(operations)
      .where(and(eq(operations.kind, "stack.prune"), eq(operations.resourceId, stackId), eq(operations.status, "queued")));
    return op!;
  }

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await db().insert(platformInstallations).values({ id: "pin_bk", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_bk",
      platformInstallationId: "pin_bk",
      name: "bk-host",
      hostname: "panel.bk.example",
      ipv4Address: "10.0.0.64",
      totalCpuMilli: 64000,
      totalMemoryBytes: "64000000000",
      totalStorageBytes: "100000000000",
    });
    await db().insert(organizations).values([
      { id: ORG, platformInstallationId: "pin_bk", name: ORG, slug: "org-bk" },
      { id: PLATFORM_OPS_ORG_ID, platformInstallationId: "pin_bk", name: "Platform operations", slug: "platform-ops" },
    ]);
    await db().insert(hostAllocations).values({ id: ALLOC, hostId: "hst_bk", organizationId: ORG, status: "active" });
    const template = await createAppTemplate(db(), {
      slug: "bk-demo",
      name: "bk-demo",
      description: null,
      category: "web",
      createdBy: null,
      firstVersion: { source: "source bk", specVersion: 1, compiledSchema: {}, specHash: hex("bk") },
    });
    await updateAppTemplate(db(), { templateId: template.template.id, enabled: true });
    versionId = template.version.id;
    await db().insert(backupTargets).values({ id: LOCAL, kind: "local", name: "Local" });
    remote = (
      await insertS3Target(db(), config.secretsMasterKey, {
        name: "Remote",
        endpoint: "https://s3.example.test",
        region: "eu-west-1",
        bucket: "backups",
        prefix: "panel",
        accessKeyId: "AKIAEXAMPLEKEY",
        secretAccessKey: "not-a-real-key",
        customerSelectable: false,
        actorId: null,
      })
    ).id;
    policyId = (await getPolicy(db(), "default_site")).id;
  }, 120_000);

  afterAll(async () => {
    await dbClient.close();
  });

  beforeEach(async () => {
    fake = FakeStackExecutor.create();
    sim = new SimulatedBackups();
    before = null;
    after = null;
    onSleep = null;
    lease.failures = 0;
    // The fake's own backups belong to an empty simulator: these tests script the jobs.
    Object.assign(fake, {
      backups: async (req: BackupsIpcRequest) => {
        before?.(req);
        const result = await sim.handle(req);
        after?.(req);
        return result;
      },
    });
    let t = START;
    clock = {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
        onSleep?.();
      },
      elapsed: () => t - START,
      advance: (ms) => {
        t += ms;
      },
    };
    await setPolicyTargets(db(), policyId, [LOCAL]);
  });

  describe("stack.backup", () => {
    it("a running application: addresses withdrawn, stopped, its data copied, then started again by an operation of its own", async () => {
      const { stackId } = await running();
      const { operation: op, backup, stack } = await request(stackId);
      expect(stack.status).toBe("stopping");
      expect(backup).toMatchObject({ kind: "manual", status: "running", volumeKeys: ["data"], resumeAfter: true });

      expect(await apply(op)).toBeUndefined();

      expect(trace()).toEqual(["unpublishAppStackRoutes", "stopAppStack"]);
      expect(sim.appStackJobs()).toEqual([
        { action: "stackStart", jobId: op.id, stackId, organizationId: ORG, volumeKeys: ["data"], snapshotId: null },
      ]);
      const saved = await backupOf(backup.id);
      expect(saved).toMatchObject({ status: "succeeded", problem: null });
      expect(saved.finishedAt).not.toBeNull();
      const [copy] = await copiesOf(backup.id);
      expect(copy).toMatchObject({ priority: 1, status: "succeeded", problem: null, targetId: LOCAL });
      expect(sim.appStackSnapshots(stackId)).toEqual([copy!.snapshotId]);
      expect(await opOf(op.id)).toMatchObject({ status: "succeeded", errorCode: null });
      expect(await stepsOf(op.id)).toEqual(done("stack.backup"));

      expect(await resumeOf(op.id)).toMatchObject({ kind: "stack.start", status: "queued", organizationId: ORG, resourceId: stackId });
      expect(await stackOf(stackId)).toMatchObject({ status: "starting", appliedRoutesHash: null });
      await resume(op.id);
      expect((await stackOf(stackId)).status).toBe("running");
      expect(fake.stack(stackId).routes).toHaveLength(1);
    });

    it("the stop names the applied plan's components in plan order, so a database goes down after what uses it (#100)", async () => {
      const { stackId } = await running();
      const { operation: op } = await request(stackId);

      expect(await apply(op)).toBeUndefined();

      expect(fake.calls.find((c) => c.method === "stopAppStack")?.request).toEqual({ stackId, organizationId: ORG, order: ["web"] });
    });

    it("an application whose installed version is not the one asked for is stopped without one (#100)", async () => {
      const { stackId, rev } = await running();
      n += 1;
      // An upgrade that failed past create: the containers may be the asked-for version's, which the applied plan does not name.
      const v2 = revision(stackId);
      const upgrade = await enqueueAppStackOperationTransactional(db(), {
        organizationId: ORG,
        stackId,
        kind: "stack.upgrade",
        requestedByUserId: null,
        idempotencyKey: `bk-${String(n)}`,
        requestHash: hex(`upgrade ${String(n)}`),
        revision: v2,
        destroyData: false,
      });
      fake.failNext("createAppStackComponents", "definite");
      expect(await apply(upgrade.operation!)).toBeInstanceOf(Error);
      expect(await stackOf(stackId)).toMatchObject({ status: "failed", appliedRevisionId: rev.revisionId, desiredRevisionId: v2.revisionId });
      fake.calls.length = 0;
      const { operation: op } = await request(stackId);

      expect(await apply(op)).toBeUndefined();

      expect(fake.calls.find((c) => c.method === "stopAppStack")?.request).toEqual({ stackId, organizationId: ORG });
    });

    it("a stopped application stays stopped: nothing is withdrawn, stopped or queued", async () => {
      const { stackId } = await stopped();
      const { operation: op, backup, stack } = await request(stackId);
      expect(stack.status).toBe("stopped");
      expect(backup.resumeAfter).toBe(false);

      expect(await apply(op)).toBeUndefined();

      expect(trace()).toEqual([]);
      expect(await stepsOf(op.id)).toEqual({ ...done("stack.backup"), unpublish: NOT_NEEDED, stop: NOT_NEEDED });
      expect((await backupOf(backup.id)).status).toBe("succeeded");
      expect((await stackOf(stackId)).status).toBe("stopped");
      expect(await resumeOf(op.id)).toBeNull();
    });

    it("two destinations: both receive a copy, each under its own job", async () => {
      await setPolicyTargets(db(), policyId, [LOCAL, remote]);
      const { stackId } = await stopped();
      const { operation: op, backup } = await request(stackId);

      expect(await apply(op)).toBeUndefined();

      expect(sim.appStackJobs().map((j) => j.jobId)).toEqual([op.id, `${op.id}-t2`]);
      expect((await copiesOf(backup.id)).map((c) => [c.priority, c.targetId, c.status])).toEqual([
        [1, LOCAL, "succeeded"],
        [2, remote, "succeeded"],
      ]);
      expect(sim.appStackSnapshots(stackId)).toHaveLength(2);
      expect((await backupOf(backup.id)).status).toBe("succeeded");
    });

    it("two destinations, one failing: the backup is partial and the action still succeeds", async () => {
      await setPolicyTargets(db(), policyId, [LOCAL, remote]);
      const { stackId } = await stopped();
      const { operation: op, backup } = await request(stackId);
      before = (req) => {
        if (req.action === "stackStart" && req.jobId === `${op.id}-t2`) sim.failNext("unreachable");
      };

      expect(await apply(op)).toBeUndefined();

      expect((await copiesOf(backup.id)).map((c) => [c.priority, c.status, c.problem])).toEqual([
        [1, "succeeded", null],
        [2, "failed", "unreachable"],
      ]);
      expect(await backupOf(backup.id)).toMatchObject({ status: "partial", problem: "unreachable" });
      expect((await opOf(op.id)).status).toBe("succeeded");
      expect(await stepsOf(op.id)).toEqual({ ...done("stack.backup"), unpublish: NOT_NEEDED, stop: NOT_NEEDED });
    });

    it("no copy saved: the backup and the action fail, and the application starts again", async () => {
      const { stackId } = await running();
      const { operation: op, backup } = await request(stackId);
      sim.failNext("no_space");

      expectFailed(await apply(op), "INTERNAL_ERROR", "stack.backup");

      expect(await backupOf(backup.id)).toMatchObject({ status: "failed", problem: "no_space" });
      expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: "INTERNAL_ERROR", errorMessage: "The backup did not finish." });
      expect(await stepsOf(op.id)).toEqual({ ...done("stack.backup"), copy: FAILED, settle: SKIPPED });
      expect(await resumeOf(op.id)).toMatchObject({ kind: "stack.start", status: "queued" });
      expect((await stackOf(stackId)).status).toBe("starting");
    });

    it("the stop fails for certain: no copy is tried, the application is marked degraded and a restart is queued", async () => {
      const { stackId } = await running();
      const { operation: op, backup } = await request(stackId);
      fake.failNext("stopAppStack", "definite");

      expectFailed(await apply(op), "INTERNAL_ERROR", "stack.backup");

      expect(sim.appStackJobs()).toEqual([]);
      expect(await backupOf(backup.id)).toMatchObject({ status: "failed", problem: "other" });
      expect(await stepsOf(op.id)).toEqual({ ...done("stack.backup"), stop: FAILED, copy: SKIPPED, settle: SKIPPED });
      expect(await resumeOf(op.id)).toMatchObject({ kind: "stack.restart", status: "queued" });
      expect(await stackOf(stackId)).toMatchObject({ status: appStackEnqueueTarget("stack.restart", "degraded"), appliedRoutesHash: null });
      await resume(op.id);
      expect((await stackOf(stackId)).status).toBe("running");
      expect(fake.stack(stackId).routes).toHaveLength(1);
    });

    it("a stop in doubt parks the action; recovery reads the application, closes the copy as interrupted and starts it again", async () => {
      const { stackId } = await running();
      const { operation: op, backup } = await request(stackId);
      fake.failNext("stopAppStack", "ambiguous");

      expectParked(await apply(op));
      expect((await stackOf(stackId)).status).toBe("unknown");
      expect((await opOf(op.id)).status).toBe("processing");
      expect((await backupOf(backup.id)).status).toBe("running");

      await transitionOperation(db(), op.id, "unknown");
      fake.calls.length = 0;
      fake.failNext("getAppStackStatus", "definite");
      expect(await runtime().recover(await opOf(op.id))).toBe("pending");
      expect((await opOf(op.id)).status).toBe("unknown");

      fake.calls.length = 0;
      expect(await runtime().recover(await opOf(op.id))).toBe("settled");
      expect(trace()).toEqual(["getAppStackStatus"]);
      expect(sim.appStackJobs()).toEqual([]);
      expect(await backupOf(backup.id)).toMatchObject({ status: "failed", problem: "interrupted" });
      expect(await opOf(op.id)).toMatchObject({
        status: "failed",
        errorCode: "OPERATION_INTERRUPTED",
        errorMessage: APP_STACK_FAILURE.OPERATION_INTERRUPTED.text,
      });
      expect(await stepsOf(op.id)).toEqual({ ...done("stack.backup"), stop: FAILED, copy: SKIPPED, settle: SKIPPED });
      expect(await resumeOf(op.id)).toMatchObject({ kind: "stack.start", status: "queued" });
      expect(await stackOf(stackId)).toMatchObject({ status: "starting", appliedRoutesHash: null });
    });

    it("a stop whose unpublish answer is lost: recovery sees no routes, drops their hash, and the restart it queues writes them again", async () => {
      const { stackId } = await running();
      const routesHash = (await stackOf(stackId)).appliedRoutesHash;
      expect(routesHash).not.toBeNull();
      const { operation: op } = await request(stackId);
      // The executor withdrew the routes; its answer could not be read.
      fake.failNext("unpublishAppStackRoutes", "ambiguous");

      expectParked(await apply(op));
      expect(trace()).toEqual(["unpublishAppStackRoutes"]);
      expect(sim.appStackJobs()).toEqual([]);

      await transitionOperation(db(), op.id, "unknown");
      fake.calls.length = 0;
      expect(await runtime().recover(await opOf(op.id))).toBe("settled");
      expect(trace()).toEqual(["getAppStackStatus"]);
      expect((await stackOf(stackId)).appliedRoutesHash).toBeNull();
      const resume = await resumeOf(op.id);
      expect(resume).toMatchObject({ kind: "stack.restart", status: "queued" });

      fake.calls.length = 0;
      expect(await apply(resume!)).toBeUndefined();
      expect(trace()).toContain("publishAppStackRoutes");
      expect(await stackOf(stackId)).toMatchObject({ status: "running", appliedRoutesHash: routesHash });
    });

    it("a copy the executor refuses because the application is busy is closed as busy", async () => {
      const { stackId } = await stopped();
      const { operation: op, backup } = await request(stackId);
      before = (req) => {
        if (req.action === "stackStart") throw busy();
      };

      expectFailed(await apply(op), "INTERNAL_ERROR", "stack.backup");

      expect(await backupOf(backup.id)).toMatchObject({ status: "failed", problem: "site_busy" });
      expect(await resumeOf(op.id)).toBeNull();
      expect((await stackOf(stackId)).status).toBe("stopped");
    });

    it("a long copy is read every five seconds until it ends", async () => {
      const { stackId } = await stopped();
      const { operation: op, backup } = await request(stackId);
      sim.holdJobs();
      let waits = 0;
      onSleep = () => {
        waits += 1;
        if (waits === 3) sim.finishHeld();
      };
      const began = clock.elapsed();

      expect(await apply(op)).toBeUndefined();

      expect(clock.elapsed() - began).toBe(3 * APP_STACK_BACKUP_POLL_MS);
      expect((await backupOf(backup.id)).status).toBe("succeeded");
    });

    it("a copy the executor no longer knows (it restarted) is closed as interrupted", async () => {
      const { stackId } = await running();
      const { operation: op, backup } = await request(stackId);
      sim.holdJobs();
      onSleep = () => {
        sim.simulateRestart();
      };

      expectFailed(await apply(op), "INTERNAL_ERROR", "stack.backup");

      expect(await backupOf(backup.id)).toMatchObject({ status: "failed", problem: "interrupted" });
      expect(await resumeOf(op.id)).toMatchObject({ kind: "stack.start" });
    });

    it("the executor stops answering: the action is parked, and recovery settles it from the job's state without a second copy", async () => {
      const { stackId } = await running();
      const { operation: op, backup } = await request(stackId);
      sim.holdJobs();
      let silent = true;
      before = (req) => {
        if (silent && req.action === "status") throw new Error("socket closed");
      };
      const began = clock.elapsed();

      expectParked(await apply(op));

      expect(clock.elapsed() - began).toBe(APP_STACK_BACKUP_POLL_GIVE_UP_MS);
      // Stopped for certain: parking leaves the application as the stop step wrote it.
      expect((await stackOf(stackId)).status).toBe("stopped");
      await transitionOperation(db(), op.id, "unknown");
      fake.calls.length = 0;
      expect(await runtime().recover(await opOf(op.id))).toBe("pending");
      silent = false;
      expect(await runtime().recover(await opOf(op.id))).toBe("pending");
      sim.finishHeld();
      expect(await runtime().recover(await opOf(op.id))).toBe("settled");

      expect(trace()).toEqual([]);
      expect(sim.appStackJobs()).toHaveLength(1);
      expect((await backupOf(backup.id)).status).toBe("succeeded");
      expect((await copiesOf(backup.id))[0]!.snapshotId).not.toBeNull();
      expect((await opOf(op.id)).status).toBe("succeeded");
      expect(await stepsOf(op.id)).toEqual(done("stack.backup"));
      expect(await resumeOf(op.id)).toMatchObject({ kind: "stack.start", status: "queued" });
    });

    it("a lease renewal that fails while the copy runs parks the backup: nothing starts the application before the copy's end is read", async () => {
      const { stackId } = await running();
      const { operation: op, backup } = await request(stackId);
      before = (req) => {
        if (req.action !== "stackStart") return;
        sim.holdJobs();
        lease.failures = 1;
      };

      expectParked(await apply(op));

      expect((await stackOf(stackId)).status).toBe("stopped");
      expect((await backupOf(backup.id)).status).toBe("running");
      expect(await resumeOf(op.id)).toBeNull();
      await expectLocked(stackId);

      before = null;
      await transitionOperation(db(), op.id, "unknown");
      expect(await runtime().recover(await opOf(op.id))).toBe("pending");
      sim.finishHeld();
      expect(await runtime().recover(await opOf(op.id))).toBe("settled");

      expect(sim.appStackJobs()).toHaveLength(1);
      expect((await backupOf(backup.id)).status).toBe("succeeded");
      expect((await opOf(op.id)).status).toBe("succeeded");
      expect(await resumeOf(op.id)).toMatchObject({ kind: "stack.start", status: "queued" });
    });

    it("where application backups cannot run, the action fails before any request leaves", async () => {
      const { stackId } = await stopped();
      const { operation: op, backup } = await request(stackId);

      expectFailed(await apply(op, runtime(fake, { ...config, runtimeBackend: "local-simulator" })), "NOT_SUPPORTED", "stack.backup");

      expect(trace()).toEqual([]);
      expect(sim.appStackJobs()).toEqual([]);
      expect(await backupOf(backup.id)).toMatchObject({ status: "failed", problem: "tool_unavailable" });
      expect(await stepsOf(op.id)).toEqual({ validate: FAILED, unpublish: SKIPPED, stop: SKIPPED, copy: SKIPPED, settle: SKIPPED });
      expect((await stackOf(stackId)).status).toBe("stopped");
    });
  });

  describe("stack.restore", () => {
    it("saves the data as they are, writes the chosen backup back and starts the application again", async () => {
      const { stackId, source } = await withBackup();
      const [sourceCopy] = await copiesOf(source.id);
      const { operation: op, backup: safety } = await request(stackId, "stack.restore", source.id);
      expect(safety).toMatchObject({ kind: "pre_restore", status: "running", resumeAfter: true });
      expect(await backupOf(source.id)).toMatchObject({ restoreStatus: "running", restoreOperationId: op.id });

      expect(await apply(op)).toBeUndefined();

      expect(trace()).toEqual(["unpublishAppStackRoutes", "stopAppStack"]);
      expect(sim.appStackJobs().slice(1)).toEqual([
        { action: "stackStart", jobId: op.id, stackId, organizationId: ORG, volumeKeys: ["data"], snapshotId: null },
        { action: "stackRestore", jobId: `${op.id}-apply`, stackId, organizationId: ORG, volumeKeys: ["data"], snapshotId: sourceCopy!.snapshotId },
      ]);
      expect((await backupOf(safety.id)).status).toBe("succeeded");
      const restored = await backupOf(source.id);
      expect(restored).toMatchObject({ status: "succeeded", restoreStatus: "succeeded", restoreProblem: null });
      expect(restored.restoredAt).not.toBeNull();
      expect((await opOf(op.id)).status).toBe("succeeded");
      expect(await stepsOf(op.id)).toEqual(done("stack.restore"));
      await resume(op.id);
      expect((await stackOf(stackId)).status).toBe("running");
    });

    it("stops the application in the applied plan's order too (#100)", async () => {
      const { stackId, source } = await withBackup();
      const { operation: op } = await request(stackId, "stack.restore", source.id);

      expect(await apply(op)).toBeUndefined();

      expect(fake.calls.find((c) => c.method === "stopAppStack")?.request).toEqual({ stackId, organizationId: ORG, order: ["web"] });
    });

    it("a stopped application is restored and stays stopped", async () => {
      const { stackId } = await stopped();
      const [sourceId] = await backups(stackId, 1);
      const { operation: op } = await request(stackId, "stack.restore", sourceId);

      expect(await apply(op)).toBeUndefined();

      expect(trace()).toEqual([]);
      expect(await stepsOf(op.id)).toEqual({ ...done("stack.restore"), unpublish: NOT_NEEDED, stop: NOT_NEEDED });
      expect(await backupOf(sourceId!)).toMatchObject({ restoreStatus: "succeeded" });
      expect((await stackOf(stackId)).status).toBe("stopped");
      expect(await resumeOf(op.id)).toBeNull();
    });

    it("without the safety backup nothing is written back: the restore fails and the application starts again", async () => {
      const { stackId, source } = await withBackup();
      const { operation: op, backup: safety } = await request(stackId, "stack.restore", source.id);
      sim.failNext("no_space");

      expectFailed(await apply(op), "INTERNAL_ERROR", "stack.restore");

      expect(sim.appStackJobs().map((j) => j.action)).toEqual(["stackStart", "stackStart"]);
      expect(await backupOf(safety.id)).toMatchObject({ status: "failed", problem: "no_space" });
      expect(await backupOf(source.id)).toMatchObject({ restoreStatus: "failed", restoreProblem: "no_space" });
      expect(await opOf(op.id)).toMatchObject({ status: "failed", errorMessage: "The restore did not finish." });
      expect(await stepsOf(op.id)).toEqual({ ...done("stack.restore"), copy: FAILED, restore: SKIPPED, settle: SKIPPED });
      expect(await resumeOf(op.id)).toMatchObject({ kind: "stack.start", status: "queued" });
    });

    it("a backup whose copies are gone cannot be written back: the application starts again untouched", async () => {
      const { stackId, source } = await withBackup();
      const { operation: op } = await request(stackId, "stack.restore", source.id);
      await db()
        .update(appStackBackupCopies)
        .set({ status: "failed", snapshotId: null, problem: "other" })
        .where(eq(appStackBackupCopies.backupId, source.id));

      expectFailed(await apply(op), "INTERNAL_ERROR", "stack.restore");

      expect(sim.appStackJobs().map((j) => j.action)).toEqual(["stackStart", "stackStart"]);
      expect(await backupOf(source.id)).toMatchObject({ restoreStatus: "failed", restoreProblem: "backup_copy_missing" });
      expect(await stepsOf(op.id)).toEqual({ ...done("stack.restore"), restore: FAILED, settle: SKIPPED });
      expect(await resumeOf(op.id)).toMatchObject({ kind: "stack.start", status: "queued" });
    });

    it("a restore the executor refuses before it starts leaves the data alone: the application starts again", async () => {
      const { stackId, source } = await withBackup();
      const { operation: op } = await request(stackId, "stack.restore", source.id);
      before = (req) => {
        if (req.action === "stackRestore") throw busy();
      };

      expectFailed(await apply(op), "INTERNAL_ERROR", "stack.restore");

      expect(await backupOf(source.id)).toMatchObject({ restoreStatus: "failed", restoreProblem: "site_busy" });
      expect(await stepsOf(op.id)).toEqual({ ...done("stack.restore"), restore: FAILED, settle: SKIPPED });
      expect(await resumeOf(op.id)).toMatchObject({ kind: "stack.start", status: "queued" });
    });

    it("a restore that fails while writing leaves the application stopped, with the safety backup to go back to", async () => {
      const { stackId, source } = await withBackup();
      const { operation: op, backup: safety } = await request(stackId, "stack.restore", source.id);
      before = (req) => {
        if (req.action === "stackRestore") sim.failNext("files_unreadable");
      };

      expectFailed(await apply(op), "INTERNAL_ERROR", "stack.restore");

      expect(await backupOf(source.id)).toMatchObject({ restoreStatus: "failed", restoreProblem: "files_unreadable" });
      expect((await backupOf(safety.id)).status).toBe("succeeded");
      expect(await stepsOf(op.id)).toEqual({ ...done("stack.restore"), restore: FAILED, settle: SKIPPED });
      expect(await resumeOf(op.id)).toBeNull();
      expect((await stackOf(stackId)).status).toBe("stopped");
    });

    it("an answer lost after the restore was accepted: recovery reads the job, never sends it again, and starts the application", async () => {
      const { stackId, source } = await withBackup();
      const { operation: op } = await request(stackId, "stack.restore", source.id);
      let restoresSent = 0;
      before = (req) => {
        if (req.action === "stackRestore") restoresSent += 1;
      };
      after = (req) => {
        if (req.action === "stackRestore") throw new ControlPlaneError("OPERATION_AMBIGUOUS", "answer lost");
      };

      expectParked(await apply(op));
      expect((await stackOf(stackId)).status).toBe("stopped");
      // Not closed (so not recorded as a restore that wrote nothing), and nothing starts the application yet.
      expect((await backupOf(source.id)).restoreStatus).toBe("running");
      expect(await resumeOf(op.id)).toBeNull();

      after = null;
      await transitionOperation(db(), op.id, "unknown");
      fake.calls.length = 0;
      expect(await runtime().recover(await opOf(op.id))).toBe("settled");

      expect(trace()).toEqual([]);
      expect(restoresSent).toBe(1);
      expect(sim.appStackJobs().filter((j) => j.action === "stackRestore")).toHaveLength(1);
      expect((await backupOf(source.id)).restoreStatus).toBe("succeeded");
      expect((await opOf(op.id)).status).toBe("succeeded");
      expect(await stepsOf(op.id)).toEqual(done("stack.restore"));
      expect(await resumeOf(op.id)).toMatchObject({ kind: "stack.start", status: "queued" });
    });

    it("a restore in doubt that the executor does not know stays stopped: the data may be half written", async () => {
      const { stackId, source } = await withBackup();
      const { operation: op } = await request(stackId, "stack.restore", source.id);
      before = (req) => {
        if (req.action === "stackRestore") throw new ControlPlaneError("OPERATION_AMBIGUOUS", "request lost");
      };

      expectParked(await apply(op));
      before = null;
      await transitionOperation(db(), op.id, "unknown");
      expect(await runtime().recover(await opOf(op.id))).toBe("settled");

      expect(sim.appStackJobs().filter((j) => j.action === "stackRestore")).toEqual([]);
      expect(await backupOf(source.id)).toMatchObject({ restoreStatus: "failed", restoreProblem: "interrupted" });
      expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect(await stepsOf(op.id)).toEqual({ ...done("stack.restore"), restore: FAILED, settle: SKIPPED });
      expect(await resumeOf(op.id)).toBeNull();
      expect((await stackOf(stackId)).status).toBe("stopped");
    });

    it.each(["succeeded", "failed"] as const)(
      "a lease renewal that fails while the restore job writes parks the restore until recovery reads the job's end (job %s)",
      async (outcome) => {
        const { stackId, source } = await withBackup();
        const { operation: op, backup: safety } = await request(stackId, "stack.restore", source.id);
        before = (req) => {
          if (req.action !== "stackRestore") return;
          sim.holdJobs();
          if (outcome === "failed") sim.failNext("no_space");
          lease.failures = 1;
        };

        expectParked(await apply(op));

        // The job may still be writing: the application stays stopped and nothing can start it.
        expect((await stackOf(stackId)).status).toBe("stopped");
        expect((await backupOf(source.id)).restoreStatus).toBe("running");
        expect(await resumeOf(op.id)).toBeNull();
        await expectLocked(stackId);

        before = null;
        await transitionOperation(db(), op.id, "unknown");
        expect(await runtime().recover(await opOf(op.id))).toBe("pending");
        await expectLocked(stackId);
        sim.finishHeld();
        expect(await runtime().recover(await opOf(op.id))).toBe("settled");

        expect(sim.appStackJobs().filter((j) => j.action === "stackRestore")).toHaveLength(1);
        expect((await backupOf(safety.id)).status).toBe("succeeded");
        if (outcome === "succeeded") {
          expect((await opOf(op.id)).status).toBe("succeeded");
          expect((await backupOf(source.id)).restoreStatus).toBe("succeeded");
          expect(await resumeOf(op.id)).toMatchObject({ kind: "stack.start", status: "queued" });
        } else {
          expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
          expect(await backupOf(source.id)).toMatchObject({ restoreStatus: "failed", restoreProblem: "no_space" });
          expect(await resumeOf(op.id)).toBeNull();
          expect((await stackOf(stackId)).status).toBe("stopped");
        }
      },
    );

    it("a restore parked before anything was written back is closed as interrupted and the application starts again", async () => {
      const { stackId, source } = await withBackup();
      const { operation: op, backup: safety } = await request(stackId, "stack.restore", source.id);
      fake.failNext("stopAppStack", "ambiguous");

      expectParked(await apply(op));
      await transitionOperation(db(), op.id, "unknown");
      expect(await runtime().recover(await opOf(op.id))).toBe("settled");

      expect(sim.appStackJobs()).toHaveLength(1);
      expect(await backupOf(safety.id)).toMatchObject({ status: "failed", problem: "interrupted" });
      expect(await backupOf(source.id)).toMatchObject({ restoreStatus: "failed", restoreProblem: "interrupted" });
      expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect(await resumeOf(op.id)).toMatchObject({ kind: "stack.start", status: "queued" });
    });
  });

  describe("stack.prune", () => {
    it("the fourth manual backup lets the oldest go: its copy leaves the destination, then its rows; the application is not touched", async () => {
      const { stackId } = await stopped();
      const three = await backups(stackId, 3);
      expect(await listAppStackPruneCandidates(db(), new Date(START))).not.toContain(stackId);
      const [newest] = await backups(stackId, 1);
      const gone = (await copiesOf(three[0]!))[0]!.snapshotId;
      expect(await listAppStackPruneCandidates(db(), new Date(START))).toContain(stackId);

      const op = await prune(stackId);
      expect(op).toMatchObject({ organizationId: PLATFORM_OPS_ORG_ID, resourceType: "stack", lockKey: `stack:${stackId}` });
      expect(await apply(op)).toBeUndefined();

      expect(trace()).toEqual([]);
      expect(sim.appStackSnapshots(stackId)).toHaveLength(3);
      expect(sim.appStackSnapshots(stackId)).not.toContain(gone);
      expect((await listAppStackBackupsForRetention(db(), stackId)).map((b) => b.id).sort()).toEqual([three[1]!, three[2]!, newest!].sort());
      expect(await copiesOf(three[0]!)).toEqual([]);
      expect((await opOf(op.id)).status).toBe("succeeded");
      expect(await stepsOf(op.id)).toEqual(done("stack.prune"));
      expect((await stackOf(stackId)).status).toBe("stopped");
      expect(await listAppStackPruneCandidates(db(), new Date(START))).not.toContain(stackId);
    });

    it("restores that keep failing while writing never let the safety backup of the original data go", async () => {
      const { stackId, source } = await withBackup();
      // After the first failure the customer goes back to the safety backup of the original data.
      const safety = await failedRestores(stackId, source.id, 4);

      expect(await apply(await prune(stackId))).toBeUndefined();

      expect((await listAppStackBackupsForRetention(db(), stackId)).map((b) => b.id)).toEqual(expect.arrayContaining(safety));
      expect(sim.appStackSnapshots(stackId)).toHaveLength(5);
      // Only the first one copied whole data; every one of them left the data half written.
      expect(await backupOf(safety[0]!)).toMatchObject({ incompleteData: false, leftIncomplete: true });
      for (const id of safety.slice(1)) expect(await backupOf(id)).toMatchObject({ incompleteData: true, leftIncomplete: true });
      expect((await page(stackId)).goBackTo).toBe(safety[0]);

      // Going back succeeds: the data are whole again, and the rule lets the oldest safety backup go.
      const { operation: back, backup: last } = await request(stackId, "stack.restore", safety[0]!);
      expect(await apply(back)).toBeUndefined();
      expect(await backupOf(last.id)).toMatchObject({ incompleteData: true, leftIncomplete: false });
      expect((await page(stackId)).goBackTo).toBeNull();
      expect(await apply(await prune(stackId))).toBeUndefined();
      expect((await listAppStackBackupsForRetention(db(), stackId)).map((b) => b.id)).not.toContain(safety[0]);
    });

    it("a start after a restore that failed while writing takes the data as they are: weeks later nothing points back to before", async () => {
      const { stackId, source } = await withBackup();
      const safety = await failedRestores(stackId, source.id, 4);
      expect((await page(stackId)).goBackTo).toBe(safety[0]);

      // The customer starts the application with its data as they are, and it runs for weeks.
      await lifecycle(stackId, "stack.start");
      clock.advance(21 * DAY);
      expect((await page(stackId)).goBackTo).toBeNull();

      // The safety backup of the data before the failed restore counts like any other: the fourth newest goes.
      expect(await listAppStackPruneCandidates(db(), new Date(clock.now()))).toContain(stackId);
      expect(await apply(await prune(stackId))).toBeUndefined();
      const kept = (await listAppStackBackupsForRetention(db(), stackId)).map((b) => b.id);
      expect(kept).not.toContain(safety[0]);
      expect(kept).toEqual(expect.arrayContaining(safety.slice(1)));
    });

    it("a start that fails takes nothing: the page still points back, and the clean-up keeps the safety backup of whole data", async () => {
      const { stackId, source } = await withBackup();
      const safety = await failedRestores(stackId, source.id, 4);

      // The customer presses «Avvia»; the executor refuses it before any part runs, and the start fails.
      n += 1;
      const { operation: start } = await enqueueAppStackOperationTransactional(db(), {
        organizationId: ORG,
        stackId,
        kind: "stack.start",
        requestedByUserId: null,
        idempotencyKey: `bk-${String(n)}`,
        requestHash: hex(`lifecycle ${String(n)}`),
        revision: null,
        destroyData: false,
      });
      fake.failNext("startAppStackComponent", "definite", "STACK_BUSY");
      expect(await apply(start!)).toBeInstanceOf(ControlPlaneError);
      expect((await opOf(start!.id)).status).toBe("failed");

      expect((await page(stackId)).goBackTo).toBe(safety[0]);
      expect(await apply(await prune(stackId))).toBeUndefined();
      expect((await listAppStackBackupsForRetention(db(), stackId)).map((b) => b.id)).toContain(safety[0]);

      // The next restore copies the same half written data; failing too, the page still names the backup of whole data.
      const { operation: next, backup: nextSafety } = await request(stackId, "stack.restore", safety[0]!);
      expect(nextSafety.incompleteData).toBe(true);
      before = (req) => {
        if (req.action === "stackRestore") sim.failNext("no_space");
      };
      expectFailed(await apply(next), "INTERNAL_ERROR", "stack.restore");
      before = null;
      expect((await page(stackId)).goBackTo).toBe(safety[0]);
    });

    it("a backup made by hand while the data are half written is marked, and writing it back keeps the safety backup of whole data", async () => {
      const { stackId, source } = await withBackup();
      const safety = await failedRestores(stackId, source.id, 4);

      const { operation, backup: manual } = await request(stackId);
      expect(await apply(operation)).toBeUndefined();
      expect(await backupOf(manual.id)).toMatchObject({ kind: "manual", incompleteData: true });
      expect((await page(stackId)).backups.find((b) => b.id === manual.id)?.incompleteData).toBe(true);

      // Writing it back succeeds but brings the half written data back: the page points back, the clean-up keeps it.
      const { operation: back, backup: last } = await request(stackId, "stack.restore", manual.id);
      expect(await apply(back)).toBeUndefined();
      expect(await backupOf(last.id)).toMatchObject({ incompleteData: true, leftIncomplete: true });
      expect((await page(stackId)).goBackTo).toBe(safety[0]);
      expect(await apply(await prune(stackId))).toBeUndefined();
      expect((await listAppStackBackupsForRetention(db(), stackId)).map((b) => b.id)).toContain(safety[0]);
    });

    it("a restore that succeeds in writing back a copy of half written data keeps the safety backup of whole data", async () => {
      const { stackId, source } = await withBackup();
      const safety = await failedRestores(stackId, source.id, 4);

      // The customer writes back the newest safety backup, a copy of half written data, and it succeeds.
      const { operation: op, backup: last } = await request(stackId, "stack.restore", safety.at(-1)!);
      expect(await apply(op)).toBeUndefined();
      expect(await backupOf(last.id)).toMatchObject({ incompleteData: true, leftIncomplete: true });
      expect((await stackOf(stackId)).status).toBe("stopped");

      // The data are still half written: the page points back, and the fifth newest safety backup stays.
      expect((await page(stackId)).goBackTo).toBe(safety[0]);
      expect(await apply(await prune(stackId))).toBeUndefined();
      expect((await listAppStackBackupsForRetention(db(), stackId)).map((b) => b.id)).toContain(safety[0]);
    });

    it("data a failed restore left are whole again once the application ran, and stay half written after a restore refused before writing", async () => {
      const { stackId, source } = await withBackup();
      const { operation: first, backup: firstSafety } = await request(stackId, "stack.restore", source.id);
      before = (req) => {
        if (req.action === "stackRestore") sim.failNext("no_space");
      };
      expectFailed(await apply(first), "INTERNAL_ERROR", "stack.restore");
      before = null;
      // The customer starts it anyway and stops it: the data are taken as they are.
      await lifecycle(stackId, "stack.start");
      await lifecycle(stackId, "stack.stop");
      const { operation: second, backup: secondSafety } = await request(stackId, "stack.restore", firstSafety.id);
      expect(secondSafety.incompleteData).toBe(false);
      expect(await apply(second)).toBeUndefined();

      const { operation: third } = await request(stackId, "stack.restore", source.id);
      before = (req) => {
        if (req.action === "stackRestore") sim.failNext("no_space");
      };
      expectFailed(await apply(third), "INTERNAL_ERROR", "stack.restore");
      const { operation: fourth, backup: fourthSafety } = await request(stackId, "stack.restore", source.id);
      expect(fourthSafety.incompleteData).toBe(true);
      // Refused before anything was written: the data stay as the third restore left them.
      before = (req) => {
        if (req.action === "stackRestore") throw busy();
      };
      expectFailed(await apply(fourth), "INTERNAL_ERROR", "stack.restore");
      before = null;
      expect(await backupOf(fourthSafety.id)).toMatchObject({ incompleteData: true, leftIncomplete: true });
      const { backup: fifthSafety } = await request(stackId, "stack.restore", source.id);
      expect(fifthSafety.incompleteData).toBe(true);
    });

    it("a destination that fails keeps the rows: the clean-up fails and the next one finishes the work", async () => {
      const { stackId } = await stopped();
      await backups(stackId, 4);
      const op = await prune(stackId);
      sim.failNext("unreachable");

      expectFailed(await apply(op), "INTERNAL_ERROR", "stack.prune");

      expect(await listAppStackBackupsForRetention(db(), stackId)).toHaveLength(4);
      expect(sim.appStackSnapshots(stackId)).toHaveLength(4);
      expect(await opOf(op.id)).toMatchObject({ status: "failed", errorMessage: "Old backups could not be removed." });
      expect(await stepsOf(op.id)).toEqual({ ...done("stack.prune"), expire: FAILED, settle: SKIPPED });

      expect(await apply(await prune(stackId))).toBeUndefined();
      expect(await listAppStackBackupsForRetention(db(), stackId)).toHaveLength(3);
      expect(sim.appStackSnapshots(stackId)).toHaveLength(3);
    });

    it("a deleted application keeps its backups for the retention period, then every copy and row goes", async () => {
      const { stackId } = await stopped();
      await backups(stackId, 2);
      await db()
        .update(appStacks)
        .set({ status: "deleted", deletedAt: new Date(START) })
        .where(eq(appStacks.id, stackId));
      const { retentionDays } = await getPolicy(db(), "default_site");
      const later = (retentionDays ?? 14) * DAY + DAY;
      expect(await listAppStackPruneCandidates(db(), new Date(START))).not.toContain(stackId);
      expect(await listAppStackPruneCandidates(db(), new Date(START + later))).toContain(stackId);

      clock.advance(later);
      expect(await apply(await prune(stackId))).toBeUndefined();

      expect(await listAppStackBackupsForRetention(db(), stackId)).toEqual([]);
      expect(sim.appStackSnapshots(stackId)).toEqual([]);
      expect((await listAppStackBackupRetentionScopes(db())).map((s) => s.stackId)).not.toContain(stackId);
    });

    it("rows an interrupted action left open are closed, and the application is not moved", async () => {
      const { stackId } = await stopped();
      const [sourceId] = await backups(stackId, 1);
      const { operation: lost, backup: safety } = await request(stackId, "stack.restore", sourceId);
      // The worker's last resort: the operation ends without the handler's own settlement.
      await transitionOperation(db(), lost.id, "processing");
      await transitionOperation(db(), lost.id, "failed", { errorCode: "INTERNAL_ERROR", errorMessage: "lost" });
      expect(await listAppStackPruneCandidates(db(), new Date(START))).toContain(stackId);

      expect(await apply(await prune(stackId))).toBeUndefined();

      expect(await backupOf(safety.id)).toMatchObject({ status: "failed", problem: "interrupted" });
      expect(await backupOf(sourceId!)).toMatchObject({ status: "succeeded", restoreStatus: "failed", restoreProblem: "interrupted" });
      expect((await stackOf(stackId)).status).toBe("stopped");
      expect(await listAppStackPruneCandidates(db(), new Date(START))).not.toContain(stackId);
    });

    it("is not queued while a backup holds the application, and an interrupted clean-up simply fails", async () => {
      const { stackId } = await stopped();
      const { operation: held } = await request(stackId);
      expect(await enqueueAppStackPrune(db(), stackId)).toBe(false);
      expect(await apply(held)).toBeUndefined();

      const op = await prune(stackId);
      await transitionOperation(db(), op.id, "processing");
      await transitionOperation(db(), op.id, "unknown");
      expect(await runtime().recover(await opOf(op.id))).toBe("settled");

      expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect(await stepsOf(op.id)).toEqual({ validate: SKIPPED, expire: SKIPPED, settle: SKIPPED });
      expect((await stackOf(stackId)).status).toBe("stopped");
    });
  });

  describe("in the outbox worker", () => {
    it("a backup of one application that is still copying does not hold up a restart of another", async () => {
      const a = await stopped();
      const b = await running();
      // The tests above ran their operations by hand: their events are not this worker's.
      await db().update(outboxEvents).set({ status: "published" }).where(eq(outboxEvents.status, "pending"));
      const { operation: backup } = await request(a.stackId);
      n += 1;
      const { operation: restart } = await enqueueAppStackOperationTransactional(db(), {
        organizationId: ORG,
        stackId: b.stackId,
        kind: "stack.restart",
        requestedByUserId: null,
        idempotencyKey: `bk-${String(n)}`,
        requestHash: hex(`lifecycle ${String(n)}`),
        revision: null,
        destroyData: false,
      });
      sim.holdJobs();
      // The copy ends once the restart has ended, or after 100 reads of its state if the restart is still waiting.
      let released: "after the restart" | "restart still waiting" | null = null;
      let waits = 0;
      clock.sleep = async (ms) => {
        clock.advance(ms);
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (released !== null) return;
        const restarted = (await opOf(restart!.id)).status === "succeeded";
        if (!restarted && ++waits < 100) return;
        released = restarted ? "after the restart" : "restart still waiting";
        sim.finishHeld();
      };
      const worker = new OutboxWorkerService(
        dbClient,
        fake,
        {} as unknown as HostAgentPort,
        config,
        {} as unknown as SiteProvisioner,
        {} as unknown as SiteDomainsApplier,
        {} as unknown as SiteFilesApplier,
        undefined,
        undefined,
        undefined,
        runtime(),
      );

      await worker.processPendingOnce();
      await worker.stop();

      expect(released).toBe("after the restart");
      expect((await opOf(restart!.id)).status).toBe("succeeded");
      expect((await stackOf(b.stackId)).status).toBe("running");
      expect((await opOf(backup.id)).status).toBe("succeeded");
      expect(sim.appStackSnapshots(a.stackId)).toHaveLength(1);
    });
  });

  describe("a recovery read that keeps failing (issue #183)", () => {
    const MINUTE = 60_000;
    const coded = (code: string) => Object.assign(new Error(`executor said ${code}`), { code });
    const schemaError = (): unknown => z.object({ state: z.literal("running") }).safeParse({ state: "lost" }).error;
    const bound = () => new RecoveryReadBound(() => clock.now());
    const unconfirmed = (operationId: string) =>
      db()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.targetId, operationId), eq(auditEvents.action, RECOVERY_UNCONFIRMED_AUDIT_ACTION)));
    /** Only reads: nothing the application or the backup jobs would act on. */
    const writes = (requests: readonly BackupsIpcRequest[]) => [
      ...trace().filter((m) => !m.startsWith("get")),
      ...requests.filter((r) => r.action !== "status").map((r) => r.action),
    ];

    /** Every status read of a job throws `fault.err` while it is not null; every backup request is recorded. */
    function faulty(fault: { err: unknown }): BackupsIpcRequest[] {
      const seen: BackupsIpcRequest[] = [];
      before = (req) => {
        seen.push(req);
        if (req.action === "status" && fault.err !== null) throw fault.err;
      };
      return seen;
    }

    /** A backup parked while its copy job runs (held): unknown, the application stopped and locked. */
    async function parkedCopy() {
      const { stackId } = await running();
      const { operation: op, backup } = await request(stackId);
      before = (req) => {
        if (req.action !== "stackStart") return;
        sim.holdJobs();
        lease.failures = 1;
      };
      expectParked(await apply(op));
      before = null;
      await transitionOperation(db(), op.id, "unknown");
      fake.calls.length = 0;
      return { stackId, op, backup };
    }

    function worker(): OutboxWorkerService {
      const w = new OutboxWorkerService(
        dbClient,
        fake,
        {} as unknown as HostAgentPort,
        config,
        {} as unknown as SiteProvisioner,
        {} as unknown as SiteDomainsApplier,
        {} as unknown as SiteFilesApplier,
        undefined,
        undefined,
        undefined,
        runtime(),
      );
      w.recoveryReads = bound();
      return w;
    }

    it("a copy whose job cannot be read for the whole bound is closed as not confirmed: copy interrupted, application left stopped, nothing sent", async () => {
      const { stackId, op, backup } = await parkedCopy();
      const fault: { err: unknown } = { err: coded("INTERNAL_ERROR") };
      const seen = faulty(fault);
      const w = worker();

      await w.recoverUnknownOperations();
      clock.advance(RECOVERY_READ_GIVE_UP_MS - 1);
      fault.err = new SyntaxError("Unexpected token < in JSON");
      await w.recoverUnknownOperations();
      expect((await opOf(op.id)).status).toBe("unknown");
      await expectLocked(stackId);

      clock.advance(1);
      await w.recoverUnknownOperations();

      expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_AMBIGUOUS", errorMessage: RECOVERY_UNCONFIRMED_TEXT });
      expect(await stepsOf(op.id)).toEqual({ ...done("stack.backup"), copy: FAILED, settle: SKIPPED });
      // The rows a job the executor no longer knows gets: interrupted. The job may still run: nothing starts the application.
      expect(await backupOf(backup.id)).toMatchObject({ status: "failed", problem: "interrupted" });
      expect((await copiesOf(backup.id)).map((c) => [c.status, c.problem])).toEqual([["failed", "interrupted"]]);
      expect((await stackOf(stackId)).status).toBe("stopped");
      expect(await resumeOf(op.id)).toBeNull();
      const audits = await unconfirmed(op.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.details).toEqual({
        operationId: op.id,
        kind: "stack.backup",
        resourceType: "stack",
        resourceId: stackId,
        minutesWaited: 30,
        failure: "unexpected_error",
      });
      const events = await db().select().from(outboxEvents);
      expect(events.filter((e) => (e.payload as { operationId?: string }).operationId === op.id).map((e) => e.status)).toEqual(["failed"]);
      expect(seen.filter((r) => r.action === "status" && r.jobId === op.id)).toHaveLength(3);
      expect(writes(seen)).toEqual([]);
      expect(sim.appStackJobs()).toHaveLength(1);

      // A second pass finds nothing in doubt: no read, no row.
      const closed = await opOf(op.id);
      await w.recoverUnknownOperations();
      expect(seen.filter((r) => r.action === "status" && r.jobId === op.id)).toHaveLength(3);
      expect(await opOf(op.id)).toEqual(closed);
      expect(await unconfirmed(op.id)).toHaveLength(1);
      expect(w.recoveryReads.size).toBe(0);
      // The lock is free as after any failed operation; the executor refuses a start while the job is awake (STACK_BUSY).
      n += 1;
      const next = await enqueueAppStackOperationTransactional(db(), {
        organizationId: ORG,
        stackId,
        kind: "stack.start",
        requestedByUserId: null,
        idempotencyKey: `bk-${String(n)}`,
        requestHash: hex(`lifecycle ${String(n)}`),
        revision: null,
        destroyData: false,
      });
      expect(next.operation).toMatchObject({ kind: "stack.start", status: "queued" });
    });

    it("an executor that cannot be reached never closes it, however long; the job's end read later settles it", async () => {
      const { stackId, op, backup } = await parkedCopy();
      const honest = [coded("DOCKER_ENGINE_UNAVAILABLE"), Object.assign(coded("OPERATION_AMBIGUOUS"), { ambiguousOutcome: true }), busy()];
      const fault: { err: unknown } = { err: honest[0] };
      const seen = faulty(fault);
      const reads = bound();

      for (let pass = 0; pass < 48; pass += 1) {
        fault.err = honest[pass % honest.length];
        expect(await runtime().recover(await opOf(op.id), reads)).toBe("pending");
        clock.advance(30 * MINUTE);
      }
      expect((await opOf(op.id)).status).toBe("unknown");
      await expectLocked(stackId);
      expect(reads.size).toBe(0);

      fault.err = null;
      sim.finishHeld();
      expect(await runtime().recover(await opOf(op.id), reads)).toBe("settled");
      expect((await opOf(op.id)).status).toBe("succeeded");
      expect((await backupOf(backup.id)).status).toBe("succeeded");
      expect(await unconfirmed(op.id)).toHaveLength(0);
      expect(writes(seen)).toEqual([]);
    });

    it("a readable answer that the job still runs starts the count again", async () => {
      const { op } = await parkedCopy();
      const fault: { err: unknown } = { err: coded("INTERNAL_ERROR") };
      faulty(fault);
      const reads = bound();
      const pass = async () => runtime().recover(await opOf(op.id), reads);

      expect(await pass()).toBe("pending");
      clock.advance(20 * MINUTE);
      fault.err = null; // the job reads as running
      expect(await pass()).toBe("pending");
      clock.advance(20 * MINUTE);
      fault.err = coded("NOT_FOUND");
      expect(await pass()).toBe("pending");
      clock.advance(29 * MINUTE);
      expect(await pass()).toBe("pending");
      expect((await opOf(op.id)).status).toBe("unknown");
      clock.advance(MINUTE);
      expect(await pass()).toBe("unconfirmed");

      expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_AMBIGUOUS" });
      expect((await unconfirmed(op.id))[0]!.details).toMatchObject({ minutesWaited: 30, failure: "error_code" });
    });

    it("a readable answer that a job ended starts the count again, even when the next read of the pass fails", async () => {
      // Two destinations: the first copy's job is held, the second's was never sent.
      await setPolicyTargets(db(), policyId, [LOCAL, remote]);
      const { op, backup } = await parkedCopy();
      const failing = new Set([op.id, `${op.id}-t2`]);
      before = (req) => {
        if (req.action === "status" && failing.has(req.jobId)) throw coded("INTERNAL_ERROR");
      };
      const reads = bound();
      const pass = async () => runtime().recover(await opOf(op.id), reads);

      expect(await pass()).toBe("pending");
      clock.advance(20 * MINUTE);
      failing.delete(op.id);
      sim.finishHeld();
      expect(await pass()).toBe("pending");
      expect((await copiesOf(backup.id)).map((c) => c.status)).toEqual(["succeeded", "running"]);
      clock.advance(15 * MINUTE);
      expect(await pass()).toBe("pending");
      expect((await opOf(op.id)).status).toBe("unknown");
      expect(await unconfirmed(op.id)).toHaveLength(0);

      clock.advance(15 * MINUTE);
      expect(await pass()).toBe("unconfirmed");
      expect((await unconfirmed(op.id))[0]!.details).toMatchObject({ minutesWaited: 30 });
      // The copy saved before stays saved.
      expect((await copiesOf(backup.id)).map((c) => [c.status, c.problem])).toEqual([
        ["succeeded", null],
        ["failed", "interrupted"],
      ]);
    });

    it("a restore whose job cannot be read once sent is closed as not confirmed: the data may be half written, nothing starts, nothing is sent again", async () => {
      const { stackId, source } = await withBackup();
      const { operation: op, backup: safety } = await request(stackId, "stack.restore", source.id);
      before = (req) => {
        if (req.action !== "stackRestore") return;
        sim.holdJobs();
        lease.failures = 1;
      };
      expectParked(await apply(op));
      before = null;
      await transitionOperation(db(), op.id, "unknown");
      fake.calls.length = 0;
      const seen = faulty({ err: schemaError() });
      const reads = bound();

      expect(await runtime().recover(await opOf(op.id), reads)).toBe("pending");
      clock.advance(RECOVERY_READ_GIVE_UP_MS);
      expect(await runtime().recover(await opOf(op.id), reads)).toBe("unconfirmed");

      expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_AMBIGUOUS", errorMessage: RECOVERY_UNCONFIRMED_TEXT });
      expect(await stepsOf(op.id)).toEqual({ ...done("stack.restore"), restore: FAILED, settle: SKIPPED });
      expect(await backupOf(source.id)).toMatchObject({ restoreStatus: "failed", restoreProblem: "interrupted" });
      // The job was sent: the safety backup says the data may be half written, and the application stays stopped.
      expect(await backupOf(safety.id)).toMatchObject({ status: "succeeded", leftIncomplete: true });
      expect((await stackOf(stackId)).status).toBe("stopped");
      expect(await resumeOf(op.id)).toBeNull();
      expect(sim.appStackJobs().filter((j) => j.action === "stackRestore")).toHaveLength(1);
      expect(writes(seen)).toEqual([]);
      expect((await unconfirmed(op.id))[0]!.details).toMatchObject({ kind: "stack.restore", minutesWaited: 30, failure: "unreadable_answer" });
    });

    it("an application whose state cannot be read after its stop was lost is closed and left to be checked", async () => {
      const { stackId } = await running();
      const { operation: op, backup } = await request(stackId);
      fake.failNext("stopAppStack", "ambiguous");
      expectParked(await apply(op));
      await transitionOperation(db(), op.id, "unknown");
      fake.calls.length = 0;
      Object.assign(fake, {
        getAppStackStatus: async () => {
          fake.calls.push({ method: "getAppStackStatus", request: { organizationId: ORG, stackId } });
          throw coded("HOST_POLICY_DENIED");
        },
      });
      const seen = faulty({ err: null });
      const reads = bound();

      expect(await runtime().recover(await opOf(op.id), reads)).toBe("pending");
      clock.advance(RECOVERY_READ_GIVE_UP_MS);
      expect(await runtime().recover(await opOf(op.id), reads)).toBe("unconfirmed");

      expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_AMBIGUOUS", errorMessage: RECOVERY_UNCONFIRMED_TEXT });
      // Neither running nor stopped for certain: the state the page shows as to be checked.
      expect((await stackOf(stackId)).status).toBe("unknown");
      expect(await backupOf(backup.id)).toMatchObject({ status: "failed", problem: "interrupted" });
      expect(await resumeOf(op.id)).toBeNull();
      expect(trace()).toEqual(["getAppStackStatus", "getAppStackStatus"]);
      expect(writes(seen)).toEqual([]);
      expect((await unconfirmed(op.id))[0]!.details).toMatchObject({ kind: "stack.backup", failure: "error_code" });
    });

    it("an operation unlocked by hand between the last failed read and the closing is left as the administrator left it", async () => {
      const { op, backup } = await parkedCopy();
      let unlockNow = false;
      Object.assign(fake, {
        backups: async (req: BackupsIpcRequest) => {
          if (req.action !== "status") return sim.handle(req);
          if (unlockNow) await unlockOperationBreakGlassTransactional(db(), { operationId: op.id, reason: "checked by hand" });
          throw coded("INTERNAL_ERROR");
        },
      });
      const reads = bound();

      expect(await runtime().recover(await opOf(op.id), reads)).toBe("pending");
      clock.advance(RECOVERY_READ_GIVE_UP_MS);
      unlockNow = true;
      expect(await runtime().recover(await opOf(op.id), reads)).toBe("pending");

      expect(await opOf(op.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
      expect(await unconfirmed(op.id)).toHaveLength(0);
      // The command touches no row of the application, and the closing wrote none either.
      expect((await backupOf(backup.id)).status).toBe("running");
      expect((await copiesOf(backup.id)).map((c) => c.status)).toEqual(["running"]);
    });
  });
});
