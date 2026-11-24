import { createHash } from "node:crypto";
import {
  APP_STACK_BACKUP_ACTION_WINDOW_MS,
  APP_STACK_BACKUP_ACTIONS_PER_HOUR,
  APP_STACK_BACKUP_STEPS_BY_KIND,
  type AppStackStatus,
} from "@hosting-panel/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AppStackBackupRepositoryError,
  AppStackRepositoryError,
  appStackBackupCopies,
  appStackBackupRetryAt,
  appStackBackups,
  appStackComponents,
  appStackDeployments,
  appStacks,
  backupPolicyTargets,
  backupTargets,
  createAppStackTransactional,
  createAppTemplate,
  createDatabaseClient,
  deleteAppStackBackupCopies,
  deleteAppStackBackupsWithoutCopies,
  deleteBackupTargetIfUnreferenced,
  enqueueAppStackBackupTransactional,
  enqueueAppStackResumeTransactional,
  eq,
  failRunningAppStackBackupCopies,
  getAppStackBackup,
  getAppStackBackupByOperation,
  getAppStackIncompleteDataMark,
  getAppStackRestoreSource,
  getPolicy,
  hostAllocations,
  hosts,
  listAppStackBackupCopies,
  listAppStackBackupRetentionScopes,
  listAppStackBackups,
  listAppStackBackupsForRetention,
  newAppEntityId,
  operations,
  operationSteps,
  organizations,
  outboxEvents,
  platformInstallations,
  setAppStackVolumeStatusTransactional,
  setPolicyTargets,
  settleAppStackBackupAggregate,
  settleAppStackBackupCopy,
  settleAppStackBackupStopTransactional,
  settleAppStackRestore,
  settleOperation,
  sql,
  transitionOperation,
  updateAppTemplate,
  users,
  type AppStackBackupWriteResult,
  type AppStackRow,
  type DatabaseClient,
  type EnqueueAppStackBackupInput,
  type HostingPanelDatabase,
  type NewAppStackRevision,
} from "../src/index.js";

// Backups of applications (ADR-0038): what a request writes, what it refuses, how copies and restores end, the chained
// start after the operation, and the reads of the retention sweep.
const orgA = "org_sb_a";
const orgB = "org_sb_b";
const ALLOC: Record<string, string> = { [orgA]: "alloc_sb_a", [orgB]: "alloc_sb_b" };
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
const LOCAL = `bkt_${"1".repeat(32)}`;
const S3 = `bkt_${"2".repeat(32)}`;
const CUSTOMER = "usr_sb_customer";
const ADMIN = "usr_sb_admin";

function revisionFor(stack: { id: string; organizationId: string; templateVersionId: string }, volumeKeys: readonly string[]): NewAppStackRevision {
  const componentKeys = ["web", "cache"];
  const revisionId = newAppEntityId("srev");
  const planHash = hex(revisionId);
  return {
    revisionId,
    templateVersionId: stack.templateVersionId,
    plan: {
      schemaVersion: 1,
      stackId: stack.id,
      organizationId: stack.organizationId,
      hostAllocationId: ALLOC[stack.organizationId]!,
      templateVersionId: stack.templateVersionId,
      revisionId,
      planHash,
      components: componentKeys.map((key) => ({ key, resources: { cpuMilli: 250, memoryBytes: "134217728" } })),
      volumes: volumeKeys.map((key) => ({ key })),
      ingress: [{ componentKey: "web", port: 8080 }],
    },
    planHash,
    componentKeys,
    volumeKeys,
    cpuMilli: 500,
    memoryBytes: 268435456,
    parameters: [{ parameterKey: "title", value: "Hello" }],
  };
}

describe("@hosting-panel/database — application backups", () => {
  let client: DatabaseClient;
  const db = (): HostingPanelDatabase => client.db;
  let counter = 0;
  let versionId = "";
  let policyId = "";

  /** An installed application: its create settled, every volume written, the given status. */
  async function installed(
    options: { org?: string; status?: AppStackStatus; volumes?: readonly string[]; present?: readonly string[] } = {},
  ): Promise<AppStackRow> {
    counter += 1;
    const org = options.org ?? orgA;
    const volumes = options.volumes ?? ["db", "data"];
    const stackId = newAppEntityId("stk");
    const created = await createAppStackTransactional(db(), {
      stackId,
      organizationId: org,
      hostAllocationId: ALLOC[org]!,
      templateVersionId: versionId,
      name: `Backup ${String(counter)}`,
      createdBy: null,
      idempotencyKey: `sb-create-${String(counter)}`,
      requestHash: hex(`create ${String(counter)}`),
      deploy: revisionFor({ id: stackId, organizationId: org, templateVersionId: versionId }, volumes),
    });
    await db().update(operations).set({ status: "succeeded" }).where(eq(operations.resourceId, stackId));
    await setAppStackVolumeStatusTransactional(db(), {
      organizationId: org,
      stackId,
      volumeKeys: options.present ?? volumes,
      status: "present",
    });
    const [row] = await db()
      .update(appStacks)
      .set({
        status: options.status ?? "running",
        appliedRevisionId: created.stack.desiredRevisionId,
        appliedRoutesHash: hex("routes"),
        appliedAddressesHash: hex("addresses"),
      })
      .where(eq(appStacks.id, stackId))
      .returning();
    return row!;
  }

  function request(stack: AppStackRow, over: Partial<EnqueueAppStackBackupInput> = {}): Promise<AppStackBackupWriteResult> {
    counter += 1;
    return enqueueAppStackBackupTransactional(db(), {
      organizationId: stack.organizationId,
      stackId: stack.id,
      kind: "stack.backup",
      sourceBackupId: null,
      requestedByUserId: null,
      idempotencyKey: `sb-${String(counter)}`,
      requestHash: hex(`request ${String(counter)}`),
      limited: false,
      ...over,
    });
  }

  const snapshot = (seed: string) => hex(seed);
  const stackOf = async (id: string) => (await db().select().from(appStacks).where(eq(appStacks.id, id)))[0]!;
  const backupOf = async (id: string) => (await db().select().from(appStackBackups).where(eq(appStackBackups.id, id)))[0]!;
  const copiesOf = async (backupId: string) => (await listAppStackBackupCopies(db(), [backupId])).get(backupId) ?? [];
  const operationsOf = async (stackId: string) => db().select().from(operations).where(eq(operations.resourceId, stackId));
  const eventOf = async (operationId: string) =>
    (await db().select().from(outboxEvents).where(sql`${outboxEvents.payload}->>'operationId' = ${operationId}`))[0];
  /** A deleted application: the row stays, as the backups that outlive it need. */
  const remove = (stackId: string) =>
    db().update(appStacks).set({ status: "deleted", deletedAt: new Date() }).where(eq(appStacks.id, stackId));

  /** Ends the operation of a request and every copy of its backup, as a finished worker would. */
  async function finish(written: AppStackBackupWriteResult, outcome: "succeeded" | "failed" = "succeeded"): Promise<void> {
    for (const copy of await copiesOf(written.backup.id)) {
      await settleAppStackBackupCopy(
        db(),
        copy.id,
        outcome === "succeeded"
          ? { status: "succeeded", snapshotId: snapshot(copy.id), sizeBytes: 2048 }
          : { status: "failed", problem: "unreachable" },
      );
    }
    await settleAppStackBackupAggregate(db(), written.backup.id);
    await db().update(operations).set({ status: "succeeded" }).where(eq(operations.id, written.operation.id));
  }

  /** A good backup of the application, which is running again afterwards. */
  async function goodBackup(stack: AppStackRow): Promise<AppStackBackupWriteResult> {
    const written = await request(stack);
    await finish(written);
    await db().update(appStacks).set({ status: stack.status }).where(eq(appStacks.id, stack.id));
    return written;
  }

  async function refusal(promise: Promise<unknown>): Promise<{ name: string; code: string; status?: string; retryAt?: Date | null }> {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    return error as { name: string; code: string; status?: string; retryAt?: Date | null };
  }

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_sb", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_sb",
      platformInstallationId: "pin_sb",
      name: "sb-host",
      hostname: "panel.sb.example",
      ipv4Address: "10.0.0.71",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    for (const org of [orgA, orgB]) {
      await db().insert(organizations).values({ id: org, platformInstallationId: "pin_sb", name: org, slug: org.replace(/_/g, "-") });
      await db().insert(hostAllocations).values({ id: ALLOC[org]!, hostId: "hst_sb", organizationId: org, status: "active" });
    }
    await db().insert(users).values([
      { id: CUSTOMER, email: "customer@sb.example.test", name: "Customer" },
      { id: ADMIN, email: "admin@sb.example.test", name: "Admin", platformRole: "infrastructure_admin" },
    ]);
    const template = await createAppTemplate(db(), {
      slug: "sb-alpha",
      name: "sb-alpha",
      description: null,
      category: "web",
      createdBy: null,
      firstVersion: { source: "source sb-alpha", specVersion: 1, compiledSchema: {}, specHash: hex("sb-alpha") },
    });
    await updateAppTemplate(db(), { templateId: template.template.id, enabled: true });
    versionId = template.version.id;

    await db().insert(backupTargets).values({ id: LOCAL, kind: "local", name: "Local" });
    await db().execute(sql`INSERT INTO backup_targets (id, kind, name, config_json, s3_location_key, s3_secret_ciphertext_base64,
        s3_secret_iv_base64, s3_secret_auth_tag_base64, s3_secret_key_version)
      SELECT ${S3}, 's3', 'Remote', c.cfg, hp_s3_location_key(c.cfg->>'endpoint', c.cfg->>'bucket', c.cfg->>'prefix'), 'c', 'i', 't', 'v1'
      FROM (SELECT jsonb_build_object('endpoint', 'https://s3.sb.example', 'region', 'r', 'bucket', 'b', 'prefix', 'p',
        'accessKeyId', 'A') AS cfg) c`);
    policyId = (await getPolicy(db(), "default_site")).id;
  }, 120_000);

  beforeEach(async () => {
    await setPolicyTargets(db(), policyId, [LOCAL]);
  });

  afterAll(async () => {
    await client.close();
  });

  describe("a backup request", () => {
    it("writes the operation, the backup with one copy per destination, and stops the application", async () => {
      const stack = await installed();
      const deployments = (await db().select().from(appStackDeployments).where(eq(appStackDeployments.stackId, stack.id))).length;
      const written = await request(stack, { requestedByUserId: CUSTOMER });

      expect(written.idempotentReplay).toBe(false);
      expect(written.stack.status).toBe("stopping");
      expect(written.operation).toMatchObject({
        kind: "stack.backup",
        status: "queued",
        resourceType: "stack",
        resourceId: stack.id,
        lockKey: `stack:${stack.id}`,
        organizationId: orgA,
        requestedByUserId: CUSTOMER,
      });
      expect(written.backup).toMatchObject({
        stackId: stack.id,
        organizationId: orgA,
        kind: "manual",
        status: "running",
        operationId: written.operation.id,
        revisionId: stack.appliedRevisionId,
        volumeKeys: ["data", "db"],
        resumeAfter: true,
        finishedAt: null,
        restoreOperationId: null,
        restoreStatus: null,
      });
      expect(written.backup.id).toMatch(/^sbak_[0-9a-f]{24}$/);

      const copies = await copiesOf(written.backup.id);
      expect(copies.map((c) => [c.targetId, c.targetKind, c.priority, c.required, c.jobId, c.status, c.snapshotId])).toEqual([
        [LOCAL, "local", 1, true, written.operation.id, "running", null],
      ]);
      expect(copies[0]?.id).toMatch(/^sbkc_[0-9a-f]{24}$/);

      const steps = await db().select().from(operationSteps).where(eq(operationSteps.operationId, written.operation.id));
      expect(steps.map((s) => s.key).sort()).toEqual([...APP_STACK_BACKUP_STEPS_BY_KIND["stack.backup"]].sort());
      const event = await eventOf(written.operation.id);
      expect(event?.payload).toMatchObject({
        operationId: written.operation.id,
        kind: "stack.backup",
        stackId: stack.id,
        backupId: written.backup.id,
        sourceBackupId: null,
      });
      // A backup is not a deployment: the history of installs gains no row.
      expect(await db().select().from(appStackDeployments).where(eq(appStackDeployments.stackId, stack.id))).toHaveLength(deployments);
    });

    it("goes to both destinations of the server's policy, the second under its own job", async () => {
      await setPolicyTargets(db(), policyId, [S3, LOCAL]);
      const written = await request(await installed());
      expect((await copiesOf(written.backup.id)).map((c) => [c.targetId, c.targetKind, c.priority, c.jobId])).toEqual([
        [S3, "s3", 1, written.operation.id],
        [LOCAL, "local", 2, `${written.operation.id}-t2`],
      ]);
    });

    it("stops a degraded or failed application too, and leaves a stopped one stopped", async () => {
      for (const [from, to, resume] of [
        ["degraded", "stopping", true],
        ["failed", "stopping", true],
        ["stopped", "stopped", false],
      ] as const) {
        const written = await request(await installed({ status: from }));
        expect([from, written.stack.status, written.backup.resumeAfter]).toEqual([from, to, resume]);
      }
    });

    it("saves only the data that exist", async () => {
      const written = await request(await installed({ volumes: ["data", "db", "cache"], present: ["db"] }));
      expect(written.backup.volumeKeys).toEqual(["db"]);
    });

    it("replays by key and hash, and refuses the key with another request", async () => {
      const stack = await installed();
      const input = { idempotencyKey: "sb-replay", requestHash: hex("replay") };
      const first = await request(stack, input);
      const again = await request(stack, input);
      expect(again).toMatchObject({ idempotentReplay: true, operation: { id: first.operation.id }, backup: { id: first.backup.id } });
      expect(await operationsOf(stack.id)).toHaveLength(2); // the create and one backup
      expect(await refusal(request(stack, { ...input, requestHash: hex("other") }))).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(await refusal(request(stack, { ...input, kind: "stack.restore", sourceBackupId: first.backup.id }))).toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
      });
    });
  });

  describe("a refused request writes nothing", () => {
    const untouched = async (stack: AppStackRow, promise: Promise<unknown>, expected: Record<string, unknown>) => {
      const before = (await operationsOf(stack.id)).length;
      expect(await refusal(promise)).toMatchObject(expected);
      expect(await operationsOf(stack.id)).toHaveLength(before);
      expect((await stackOf(stack.id)).status).toBe(stack.status);
      expect(await listAppStackBackups(db(), { organizationId: stack.organizationId, stackId: stack.id })).toEqual([]);
    };

    it("another customer's application, an unknown one and a deleted one are not found", async () => {
      const stack = await installed();
      await untouched(stack, request(stack, { organizationId: orgB }), { name: "AppStackRepositoryError", code: "NOT_FOUND" });
      expect(await refusal(request({ ...stack, id: "stk_missing" }))).toMatchObject({ code: "NOT_FOUND" });
      const gone = { ...(await installed()), status: "deleted" as const };
      await remove(gone.id);
      await untouched(gone, request(gone), { code: "NOT_FOUND" });
    });

    it("an application with an action in progress is locked", async () => {
      const stack = await installed();
      const first = await request(stack);
      const error = await refusal(request(stack));
      expect(error).toMatchObject({ code: "RESOURCE_LOCKED" });
      expect(await operationsOf(stack.id)).toHaveLength(2);
      expect(await getAppStackBackupByOperation(db(), first.operation.id)).toMatchObject({ id: first.backup.id });
    });

    it("an application that is not installed, or whose state is unknown, is refused with its status", async () => {
      for (const status of ["draft", "unknown", "delete_failed"] as const) {
        const stack = await installed({ status });
        await untouched(stack, request(stack), { name: "AppStackRepositoryError", code: "INVALID_TRANSITION", status });
      }
    });

    it("an application with no data", async () => {
      const stack = await installed({ present: [] });
      await untouched(stack, request(stack), { name: "AppStackBackupRepositoryError", code: "NO_DATA" });
    });

    it("a server with no usable destination", async () => {
      const stack = await installed();
      await setPolicyTargets(db(), policyId, []);
      await untouched(stack, request(stack), { name: "AppStackBackupRepositoryError", code: "NO_DESTINATION" });
      await setPolicyTargets(db(), policyId, [LOCAL]);
      await db().update(backupTargets).set({ enabled: false }).where(eq(backupTargets.id, LOCAL));
      try {
        await untouched(stack, request(stack), { code: "NO_DESTINATION" });
      } finally {
        await db().update(backupTargets).set({ enabled: true }).where(eq(backupTargets.id, LOCAL));
      }
    });
  });

  describe("the hourly limit", () => {
    const past = (stack: AppStackRow, n: number, userId: string, minutesAgo: (i: number) => number, now: Date) =>
      db()
        .insert(operations)
        .values(
          Array.from({ length: n }, (_, i) => ({
            id: `op_${hex(`${stack.id}:${userId}:${String(i)}:${String(minutesAgo(i))}`).slice(0, 32)}`,
            organizationId: stack.organizationId,
            kind: i % 2 === 0 ? ("stack.backup" as const) : ("stack.restore" as const),
            resourceType: "stack" as const,
            resourceId: stack.id,
            requestedByUserId: userId,
            status: "succeeded" as const,
            submittedAt: new Date(now.getTime() - minutesAgo(i) * 60_000),
          })),
        );

    it("refuses the request past the limit, says when to try again, and writes nothing", async () => {
      const stack = await installed();
      const now = new Date();
      await past(stack, APP_STACK_BACKUP_ACTIONS_PER_HOUR, CUSTOMER, (i) => 10 + i, now);
      const before = (await operationsOf(stack.id)).length;

      const error = await refusal(request(stack, { requestedByUserId: CUSTOMER, limited: true }));
      expect(error).toMatchObject({ name: "AppStackBackupRepositoryError", code: "TOO_MANY" });
      expect(error).toBeInstanceOf(AppStackBackupRepositoryError);
      // The slot frees one window after the oldest of the counted requests.
      const oldest = now.getTime() - (10 + APP_STACK_BACKUP_ACTIONS_PER_HOUR - 1) * 60_000;
      expect(error.retryAt?.getTime()).toBe(oldest + APP_STACK_BACKUP_ACTION_WINDOW_MS);
      expect(await operationsOf(stack.id)).toHaveLength(before);
      expect((await stackOf(stack.id)).status).toBe("running");
      expect(await listAppStackBackups(db(), { organizationId: orgA, stackId: stack.id })).toEqual([]);

      // A server administrator is not limited.
      const allowed = await request(stack, { requestedByUserId: ADMIN, limited: false });
      expect(allowed.operation.kind).toBe("stack.backup");
    });

    it("counts neither what an administrator asked, nor what is older than the window, nor another application", async () => {
      const stack = await installed();
      const other = await installed();
      const now = new Date();
      await past(stack, APP_STACK_BACKUP_ACTIONS_PER_HOUR, ADMIN, (i) => 5 + i, now);
      await past(stack, APP_STACK_BACKUP_ACTIONS_PER_HOUR - 1, CUSTOMER, (i) => 5 + i, now);
      await past(stack, 3, CUSTOMER, (i) => 61 + i, now);
      await past(other, APP_STACK_BACKUP_ACTIONS_PER_HOUR, CUSTOMER, (i) => 5 + i, now);
      expect(await appStackBackupRetryAt(db(), stack.id, now, "op_none")).toBeNull();
      expect(await appStackBackupRetryAt(db(), other.id, now, "op_none")).not.toBeNull();

      const written = await request(stack, { requestedByUserId: CUSTOMER, limited: true });
      expect(written.stack.status).toBe("stopping");
    });
  });

  describe("a restore request", () => {
    it("writes a safety backup under the restore operation and marks the backup it reads", async () => {
      const stack = await installed();
      const source = await goodBackup(stack);
      const written = await request(stack, { kind: "stack.restore", sourceBackupId: source.backup.id });

      expect(written.operation).toMatchObject({ kind: "stack.restore", status: "queued", lockKey: `stack:${stack.id}` });
      expect(written.stack.status).toBe("stopping");
      expect(written.backup).toMatchObject({ kind: "pre_restore", status: "running", operationId: written.operation.id, resumeAfter: true });
      expect(written.backup.id).not.toBe(source.backup.id);
      expect(await backupOf(source.backup.id)).toMatchObject({
        status: "succeeded",
        restoreOperationId: written.operation.id,
        restoreStatus: "running",
        restoreProblem: null,
        restoredAt: null,
      });
      expect(await getAppStackRestoreSource(db(), written.operation.id)).toMatchObject({ id: source.backup.id });
      const steps = await db().select().from(operationSteps).where(eq(operationSteps.operationId, written.operation.id));
      expect(steps).toHaveLength(APP_STACK_BACKUP_STEPS_BY_KIND["stack.restore"].length);
      const event = await eventOf(written.operation.id);
      expect(event?.payload).toMatchObject({ stackId: stack.id, backupId: written.backup.id, sourceBackupId: source.backup.id });
    });

    it("ends once: succeeded, or failed with its problem; a late answer changes nothing", async () => {
      const stack = await installed();
      const source = await goodBackup(stack);
      const first = await request(stack, { kind: "stack.restore", sourceBackupId: source.backup.id });
      expect(await settleAppStackRestore(db(), { operationId: first.operation.id, status: "failed", problem: "interrupted" })).toBe(true);
      expect(await backupOf(source.backup.id)).toMatchObject({ restoreStatus: "failed", restoreProblem: "interrupted" });
      expect((await backupOf(source.backup.id)).restoredAt).toBeInstanceOf(Date);
      expect(await settleAppStackRestore(db(), { operationId: first.operation.id, status: "succeeded", problem: null })).toBe(false);
      expect((await backupOf(source.backup.id)).restoreStatus).toBe("failed");

      // The same backup can be restored again: the marker follows the last restore.
      await finish(first);
      await db().update(appStacks).set({ status: "running" }).where(eq(appStacks.id, stack.id));
      const second = await request(stack, { kind: "stack.restore", sourceBackupId: source.backup.id });
      expect(await backupOf(source.backup.id)).toMatchObject({ restoreOperationId: second.operation.id, restoreStatus: "running", restoreProblem: null });
      expect(await settleAppStackRestore(db(), { operationId: second.operation.id, status: "succeeded", problem: "ignored" })).toBe(true);
      expect(await backupOf(source.backup.id)).toMatchObject({ restoreStatus: "succeeded", restoreProblem: null });
      expect(await getAppStackRestoreSource(db(), first.operation.id)).toBeNull();
    });

    it("refuses a backup of another application, an unknown one, and one with no good copy or no data left in common", async () => {
      const stack = await installed();
      const other = await installed();
      const foreign = await goodBackup(other);
      const before = (await operationsOf(stack.id)).length;
      const restore = (sourceBackupId: string | null) => refusal(request(stack, { kind: "stack.restore", sourceBackupId }));

      expect(await restore(foreign.backup.id)).toMatchObject({ name: "AppStackBackupRepositoryError", code: "BACKUP_NOT_FOUND" });
      expect(await restore("sbak_missing")).toMatchObject({ code: "BACKUP_NOT_FOUND" });
      expect(await restore(null)).toMatchObject({ code: "BACKUP_NOT_FOUND" });

      const failed = await request(stack);
      await finish(failed, "failed");
      await db().update(appStacks).set({ status: "running" }).where(eq(appStacks.id, stack.id));
      expect((await backupOf(failed.backup.id)).status).toBe("failed");
      expect(await restore(failed.backup.id)).toMatchObject({ code: "NOT_RESTORABLE" });

      const good = await goodBackup(stack);
      await db().update(appStackBackups).set({ volumeKeys: ["uploads"] }).where(eq(appStackBackups.id, good.backup.id));
      expect(await restore(good.backup.id)).toMatchObject({ code: "NOT_RESTORABLE" });

      expect(await operationsOf(stack.id)).toHaveLength(before + 2);
      expect((await stackOf(stack.id)).status).toBe("running");
      expect((await backupOf(good.backup.id)).restoreOperationId).toBeNull();
    });

    it("marks a safety backup of data a failed restore left half written, until anything but a backup runs the application", async () => {
      const stack = await installed();
      const source = await goodBackup(stack);
      const restore = (over: Partial<EnqueueAppStackBackupInput> = {}) =>
        request(stack, { kind: "stack.restore", sourceBackupId: source.backup.id, ...over });
      /** A restore whose safety copy was good, ended as the worker would; the application stays stopped. */
      const ended = async (written: AppStackBackupWriteResult, outcome: "succeeded" | "failed", mayHaveWritten?: boolean) => {
        await finish(written);
        await settleAppStackRestore(db(), { operationId: written.operation.id, status: outcome, problem: outcome === "failed" ? "no_space" : null, mayHaveWritten });
        await db().update(appStacks).set({ status: "stopped" }).where(eq(appStacks.id, stack.id));
      };

      const first = await restore();
      expect(first.backup.incompleteData).toBe(false);
      await ended(first, "failed", true);
      expect(await backupOf(first.backup.id)).toMatchObject({ incompleteData: false, leftIncomplete: true });

      // A backup of the stopped application changes nothing: the next safety backup copies the same half written data.
      await goodBackup(await stackOf(stack.id));
      const second = await restore();
      expect(second.backup.incompleteData).toBe(true);
      // Refused before writing: the data stay as they were, half written.
      await ended(second, "failed", false);
      expect(await backupOf(second.backup.id)).toMatchObject({ incompleteData: true, leftIncomplete: true });

      // Not known whether it wrote (the panel was restored, or the worker's last resort): a good safety copy says it may have.
      const third = await restore();
      await finish(third);
      await db().update(appStackBackups).set({ incompleteData: false }).where(eq(appStackBackups.id, third.backup.id));
      await settleAppStackRestore(db(), { operationId: third.operation.id, status: "failed", problem: "interrupted" });
      expect((await backupOf(third.backup.id)).leftIncomplete).toBe(true);
      await db().update(appStacks).set({ status: "stopped" }).where(eq(appStacks.id, stack.id));

      // The application ran since: its data are taken as they are.
      await db().insert(operations).values({
        id: `op_${hex("ran").slice(0, 24)}`,
        organizationId: orgA,
        kind: "stack.start",
        resourceType: "stack",
        resourceId: stack.id,
        status: "succeeded",
        lockKey: `stack:${stack.id}`,
        idempotencyKey: `sb-ran-${String(counter)}`,
      });
      const fourth = await restore();
      expect(fourth.backup.incompleteData).toBe(false);
      await ended(fourth, "succeeded");
      expect((await backupOf(fourth.backup.id)).leftIncomplete).toBe(false);

      // A restore of a running application never copies half written data.
      await db().update(appStacks).set({ status: "running" }).where(eq(appStacks.id, stack.id));
      expect((await restore()).backup.incompleteData).toBe(false);
    });

    it("a restore that succeeded leaves the data as whole as the backup it wrote back", async () => {
      const stack = await installed();
      const source = await goodBackup(stack);
      const restore = async (sourceBackupId: string, outcome: "succeeded" | "failed") => {
        const written = await request(stack, { kind: "stack.restore", sourceBackupId });
        await finish(written);
        await settleAppStackRestore(db(), {
          operationId: written.operation.id,
          status: outcome,
          problem: outcome === "failed" ? "no_space" : null,
          mayHaveWritten: true,
        });
        await db().update(appStacks).set({ status: "stopped" }).where(eq(appStacks.id, stack.id));
        return written.backup.id;
      };

      const whole = await restore(source.backup.id, "failed");
      const broken = await restore(source.backup.id, "failed");
      expect(await backupOf(broken)).toMatchObject({ incompleteData: true, leftIncomplete: true });
      expect((await getAppStackIncompleteDataMark(db(), stack.id))?.id).toBe(broken);

      // Writing back a copy of half written data leaves them half written: the mark moves to this restore.
      const again = await restore(broken, "succeeded");
      expect(await backupOf(again)).toMatchObject({ incompleteData: true, leftIncomplete: true });
      expect((await getAppStackIncompleteDataMark(db(), stack.id))?.id).toBe(again);
      // Writing back the copy of whole data makes them whole.
      const back = await restore(whole, "succeeded");
      expect(await backupOf(back)).toMatchObject({ incompleteData: true, leftIncomplete: false });
      expect(await getAppStackIncompleteDataMark(db(), stack.id)).toBeNull();
    });

    it("takes the data as they are once anything but a backup or a clean-up has succeeded on the application", async () => {
      const stack = await installed();
      const source = await goodBackup(stack);
      const failed = await request(stack, { kind: "stack.restore", sourceBackupId: source.backup.id });
      await finish(failed);
      await settleAppStackRestore(db(), { operationId: failed.operation.id, status: "failed", problem: "no_space", mayHaveWritten: true });
      await db().update(appStacks).set({ status: "stopped" }).where(eq(appStacks.id, stack.id));
      expect((await getAppStackIncompleteDataMark(db(), stack.id))?.id).toBe(failed.backup.id);
      const operation = (kind: "stack.prune" | "stack.start", status: "succeeded" | "queued") =>
        db().insert(operations).values({
          id: `op_${hex(`${kind} mark`).slice(0, 24)}`,
          organizationId: orgA,
          kind,
          resourceType: "stack",
          resourceId: stack.id,
          status,
          lockKey: `stack:${stack.id}`,
          idempotencyKey: `sb-${kind}-mark`,
        });

      // A backup and a clean-up of the stopped application change nothing.
      await goodBackup(await stackOf(stack.id));
      await operation("stack.prune", "succeeded");
      expect((await getAppStackIncompleteDataMark(db(), stack.id))?.id).toBe(failed.backup.id);

      // A start takes them as they are once it succeeded, not while it is under way; a later safety backup copies whole data.
      await operation("stack.start", "queued");
      expect((await getAppStackIncompleteDataMark(db(), stack.id))?.id).toBe(failed.backup.id);
      await db().update(operations).set({ status: "succeeded" }).where(eq(operations.idempotencyKey, "sb-stack.start-mark"));
      expect(await getAppStackIncompleteDataMark(db(), stack.id)).toBeNull();
      expect((await request(stack, { kind: "stack.restore", sourceBackupId: source.backup.id })).backup.incompleteData).toBe(false);
    });

    it("an action that failed, a restore aside, leaves the data as the failed restore left them", async () => {
      const stack = await installed();
      const source = await goodBackup(stack);
      const failedRestore = async () => {
        const written = await request(stack, { kind: "stack.restore", sourceBackupId: source.backup.id });
        await finish(written);
        await settleAppStackRestore(db(), { operationId: written.operation.id, status: "failed", problem: "no_space", mayHaveWritten: true });
        await db().update(appStacks).set({ status: "stopped" }).where(eq(appStacks.id, stack.id));
        return written;
      };
      const start = (status: "failed" | "cancelled" | "queued") =>
        db().insert(operations).values({
          id: `op_${hex(`start ${status}`).slice(0, 24)}`,
          organizationId: orgA,
          kind: "stack.start",
          resourceType: "stack",
          resourceId: stack.id,
          status,
          lockKey: `stack:${stack.id}`,
          idempotencyKey: `sb-start-${status}`,
        });
      const first = await failedRestore();

      // A restore cancelled before the worker took it up never ran: its safety backup says nothing of the data.
      const cancelled = await request(stack, { kind: "stack.restore", sourceBackupId: source.backup.id });
      await finish(cancelled, "failed");
      await db().update(operations).set({ status: "cancelled" }).where(eq(operations.id, cancelled.operation.id));
      expect((await getAppStackIncompleteDataMark(db(), stack.id))?.id).toBe(first.backup.id);

      // The customer presses Start and it fails before any part runs (or never leaves the queue): nothing ran on the data.
      await start("failed");
      expect((await getAppStackIncompleteDataMark(db(), stack.id))?.id).toBe(first.backup.id);
      await start("cancelled");
      expect((await getAppStackIncompleteDataMark(db(), stack.id))?.id).toBe(first.backup.id);

      // The next restore copies the same half written data; failing too, it holds the mark itself.
      const second = await failedRestore();
      expect(second.backup.incompleteData).toBe(true);
      expect((await getAppStackIncompleteDataMark(db(), stack.id))?.id).toBe(second.backup.id);

      // A start under way has not taken the data yet; once it succeeded it has.
      await start("queued");
      expect((await getAppStackIncompleteDataMark(db(), stack.id))?.id).toBe(second.backup.id);
      await db().update(operations).set({ status: "succeeded" }).where(eq(operations.idempotencyKey, "sb-start-queued"));
      expect(await getAppStackIncompleteDataMark(db(), stack.id)).toBeNull();
    });

    it("marks a backup made by hand while the data are half written: writing it back leaves them so", async () => {
      const stack = await installed();
      const source = await goodBackup(stack);
      const failed = await request(stack, { kind: "stack.restore", sourceBackupId: source.backup.id });
      await finish(failed);
      await settleAppStackRestore(db(), { operationId: failed.operation.id, status: "failed", problem: "no_space", mayHaveWritten: true });
      await db().update(appStacks).set({ status: "stopped" }).where(eq(appStacks.id, stack.id));

      const manual = await goodBackup(await stackOf(stack.id));
      expect(await backupOf(manual.backup.id)).toMatchObject({ kind: "manual", incompleteData: true });

      // Writing it back succeeds and brings the half written data back: the mark moves to this restore.
      const back = await request(stack, { kind: "stack.restore", sourceBackupId: manual.backup.id });
      await finish(back);
      await settleAppStackRestore(db(), { operationId: back.operation.id, status: "succeeded", problem: null, mayHaveWritten: true });
      expect(await backupOf(back.backup.id)).toMatchObject({ incompleteData: true, leftIncomplete: true });
      expect((await getAppStackIncompleteDataMark(db(), stack.id))?.id).toBe(back.backup.id);

      // Once a start took the data as they are, a backup made by hand is not marked.
      await db().insert(operations).values({
        id: `op_${hex("manual ran").slice(0, 24)}`,
        organizationId: orgA,
        kind: "stack.start",
        resourceType: "stack",
        resourceId: stack.id,
        status: "succeeded",
        lockKey: `stack:${stack.id}`,
        idempotencyKey: "sb-manual-ran",
      });
      expect((await goodBackup(await stackOf(stack.id))).backup.incompleteData).toBe(false);
    });

    it("accepts a partial backup: one good copy is enough", async () => {
      await setPolicyTargets(db(), policyId, [S3, LOCAL]);
      const stack = await installed();
      const written = await request(stack);
      const [remote, local] = await copiesOf(written.backup.id);
      await settleAppStackBackupCopy(db(), remote!.id, { status: "failed", problem: "unreachable" });
      await settleAppStackBackupCopy(db(), local!.id, { status: "succeeded", snapshotId: snapshot("partial"), sizeBytes: 10 });
      expect(await settleAppStackBackupAggregate(db(), written.backup.id)).toBe("partial");
      await db().update(operations).set({ status: "succeeded" }).where(eq(operations.id, written.operation.id));
      await db().update(appStacks).set({ status: "running" }).where(eq(appStacks.id, stack.id));
      const restore = await request(stack, { kind: "stack.restore", sourceBackupId: written.backup.id });
      expect(restore.backup.kind).toBe("pre_restore");
    });
  });

  describe("copies and the backup's status", () => {
    it("ends a copy once and never stores a snapshot for a failure", async () => {
      const written = await request(await installed());
      const [copy] = await copiesOf(written.backup.id);
      expect(await settleAppStackBackupCopy(db(), copy!.id, { status: "failed", snapshotId: snapshot("x"), sizeBytes: 9 })).toBe(true);
      expect((await copiesOf(written.backup.id))[0]).toMatchObject({ status: "failed", snapshotId: null, sizeBytes: null, problem: "other" });
      expect(await settleAppStackBackupCopy(db(), copy!.id, { status: "succeeded", snapshotId: snapshot("late") })).toBe(false);
      expect((await copiesOf(written.backup.id))[0]?.status).toBe("failed");
    });

    it("the database refuses a good copy without a snapshot", async () => {
      const written = await request(await installed());
      const [copy] = await copiesOf(written.backup.id);
      await expect(settleAppStackBackupCopy(db(), copy!.id, { status: "succeeded" })).rejects.toThrow();
      expect((await copiesOf(written.backup.id))[0]?.status).toBe("running");
    });

    it("stays running while a copy runs, then good, partial or failed by the sites' rule", async () => {
      await setPolicyTargets(db(), policyId, [S3, LOCAL]);
      const outcomes = async (first: "succeeded" | "failed", second: "succeeded" | "failed") => {
        const written = await request(await installed());
        const copies = await copiesOf(written.backup.id);
        const settle = (i: number, status: "succeeded" | "failed") =>
          settleAppStackBackupCopy(
            db(),
            copies[i]!.id,
            status === "succeeded"
              ? { status, snapshotId: snapshot(`${copies[i]!.id}`), sizeBytes: 100 * (i + 1) }
              : { status, problem: i === 0 ? "unreachable" : "no_space" },
          );
        await settle(0, first);
        expect(await settleAppStackBackupAggregate(db(), written.backup.id)).toBe("running");
        expect((await backupOf(written.backup.id)).finishedAt).toBeNull();
        await settle(1, second);
        const status = await settleAppStackBackupAggregate(db(), written.backup.id);
        return { status, row: await backupOf(written.backup.id) };
      };

      const good = await outcomes("succeeded", "succeeded");
      expect(good).toMatchObject({ status: "succeeded", row: { status: "succeeded", sizeBytes: 100, problem: null } });
      expect(good.row.finishedAt).toBeInstanceOf(Date);
      expect(await outcomes("failed", "succeeded")).toMatchObject({ status: "partial", row: { sizeBytes: 200, problem: "unreachable" } });
      expect(await outcomes("succeeded", "failed")).toMatchObject({ status: "partial", row: { sizeBytes: 100, problem: "no_space" } });
      expect(await outcomes("failed", "failed")).toMatchObject({ status: "failed", row: { sizeBytes: null, problem: "unreachable" } });
    });

    it("fails the copies that never ran, and leaves an ended backup as it is", async () => {
      await setPolicyTargets(db(), policyId, [S3, LOCAL]);
      const written = await request(await installed());
      const [first] = await copiesOf(written.backup.id);
      await settleAppStackBackupCopy(db(), first!.id, { status: "succeeded", snapshotId: snapshot("kept"), sizeBytes: 7 });
      expect(await failRunningAppStackBackupCopies(db(), written.backup.id, "interrupted")).toBe(1);
      expect((await copiesOf(written.backup.id)).map((c) => [c.status, c.problem])).toEqual([
        ["succeeded", null],
        ["failed", "interrupted"],
      ]);
      expect(await settleAppStackBackupAggregate(db(), written.backup.id)).toBe("partial");
      const ended = await backupOf(written.backup.id);
      expect(await failRunningAppStackBackupCopies(db(), written.backup.id, "other")).toBe(0);
      expect(await settleAppStackBackupAggregate(db(), written.backup.id)).toBe("partial");
      expect(await backupOf(written.backup.id)).toEqual(ended);
      expect(await settleAppStackBackupAggregate(db(), "sbak_missing")).toBeNull();
    });
  });

  describe("the stop step", () => {
    it("stopped: every part reads stopped and nothing is published", async () => {
      const stack = await installed();
      await request(stack);
      const stopped = await settleAppStackBackupStopTransactional(db(), { organizationId: orgA, stackId: stack.id, to: "stopped", routesWithdrawn: true });
      // Nothing published, so nothing pending: the fingerprint of the published addresses goes with the routes (ADR-0037).
      expect(stopped).toMatchObject({ status: "stopped", appliedRoutesHash: null, appliedAddressesHash: null });
      const parts = await db().select().from(appStackComponents).where(eq(appStackComponents.stackId, stack.id));
      expect(parts.map((p) => p.health)).toEqual(["stopped", "stopped"]);
      // Asked again (a worker that lost its answer): no change, no refusal.
      expect(await settleAppStackBackupStopTransactional(db(), { organizationId: orgA, stackId: stack.id, to: "stopped", routesWithdrawn: true })).toMatchObject({
        status: "stopped",
      });
    });

    it("degraded when the stop failed for certain; the routes are kept unless they were withdrawn", async () => {
      const stack = await installed();
      await request(stack);
      const degraded = await settleAppStackBackupStopTransactional(db(), { organizationId: orgA, stackId: stack.id, to: "degraded", routesWithdrawn: false });
      expect(degraded).toMatchObject({ status: "degraded", appliedRoutesHash: stack.appliedRoutesHash, appliedAddressesHash: stack.appliedAddressesHash });
      const parts = await db().select().from(appStackComponents).where(eq(appStackComponents.stackId, stack.id));
      expect(parts.map((p) => p.health)).not.toContain("stopped");
    });

    it("answers null for an application that is gone or belongs to someone else, and refuses an impossible move", async () => {
      const stack = await installed();
      await request(stack);
      expect(await settleAppStackBackupStopTransactional(db(), { organizationId: orgB, stackId: stack.id, to: "stopped", routesWithdrawn: true })).toBeNull();
      expect((await stackOf(stack.id)).status).toBe("stopping");
      await db().update(appStacks).set({ status: "deleting" }).where(eq(appStacks.id, stack.id));
      const error = await refusal(settleAppStackBackupStopTransactional(db(), { organizationId: orgA, stackId: stack.id, to: "stopped", routesWithdrawn: true }));
      expect(error).toBeInstanceOf(AppStackRepositoryError);
      expect(error).toMatchObject({ code: "INVALID_TRANSITION", status: "deleting" });
    });
  });

  describe("the start after a backup or a restore", () => {
    const processing = async (written: AppStackBackupWriteResult) => {
      await transitionOperation(db(), written.operation.id, "processing");
      return written;
    };
    const resume = (stack: AppStackRow, written: AppStackBackupWriteResult) => (tx: HostingPanelDatabase) =>
      enqueueAppStackResumeTransactional(tx, {
        organizationId: stack.organizationId,
        stackId: stack.id,
        requestedByUserId: written.operation.requestedByUserId,
        sourceOperationId: written.operation.id,
      });

    it("is queued in the transaction that ends the backup: a start for a stopped application", async () => {
      const stack = await installed();
      const written = await processing(await request(stack, { requestedByUserId: CUSTOMER }));
      await settleAppStackBackupStopTransactional(db(), { organizationId: orgA, stackId: stack.id, to: "stopped", routesWithdrawn: true });

      let chained: Awaited<ReturnType<typeof enqueueAppStackResumeTransactional>> = null;
      expect(
        await settleOperation(db(), written.operation.id, { status: "succeeded" }, undefined, async (tx) => {
          chained = await resume(stack, written)(tx);
        }),
      ).toBe(true);

      const queued = chained as unknown as NonNullable<Awaited<ReturnType<typeof enqueueAppStackResumeTransactional>>>;
      expect(queued.kind).toBe("stack.start");
      expect(queued.operation).toMatchObject({
        kind: "stack.start",
        status: "queued",
        lockKey: `stack:${stack.id}`,
        requestedByUserId: CUSTOMER,
        idempotencyKey: `resume:${written.operation.id}`,
      });
      // The platform stopped it, not the customer: no replaced status, so a resume refused before create ends failed.
      expect(queued.deployment).toMatchObject({
        operationId: queued.operation.id,
        status: "queued",
        revisionId: stack.desiredRevisionId,
        replacedRevisionId: null,
        replacedStatus: null,
      });
      expect((await stackOf(stack.id)).status).toBe("starting");
      const event = await eventOf(queued.operation.id);
      expect(event?.payload).toMatchObject({ kind: "stack.start", stackId: stack.id, deploymentId: queued.deployment.id });
      const statuses = Object.fromEntries((await operationsOf(stack.id)).map((o) => [o.kind, o.status]));
      expect(statuses).toMatchObject({ "stack.backup": "succeeded", "stack.start": "queued" });
    });

    it("is a restart when the stop left the application degraded, also after a failed backup", async () => {
      const stack = await installed();
      const written = await processing(await request(stack));
      await settleAppStackBackupStopTransactional(db(), { organizationId: orgA, stackId: stack.id, to: "degraded", routesWithdrawn: false });
      let kind: string | null = null;
      await settleOperation(
        db(),
        written.operation.id,
        { status: "failed", errorCode: "DOCKER_ENGINE_UNAVAILABLE", errorMessage: "The application could not be stopped." },
        undefined,
        async (tx) => {
          kind = (await resume(stack, written)(tx))?.kind ?? null;
        },
      );
      expect(kind).toBe("stack.restart");
      expect((await stackOf(stack.id)).status).toBe("starting");
    });

    it("cannot be queued while the backup still holds the application: that is why it runs after the settle", async () => {
      const stack = await installed();
      const written = await processing(await request(stack));
      await settleAppStackBackupStopTransactional(db(), { organizationId: orgA, stackId: stack.id, to: "stopped", routesWithdrawn: true });
      const error = await refusal(db().transaction((tx) => resume(stack, written)(tx as unknown as HostingPanelDatabase)));
      expect(error).toMatchObject({ code: "RESOURCE_LOCKED" });
      expect((await stackOf(stack.id)).status).toBe("stopped");
    });

    it("rolls back with the settle when it fails, and the backup operation stays open", async () => {
      const stack = await installed();
      const written = await processing(await request(stack));
      await settleAppStackBackupStopTransactional(db(), { organizationId: orgA, stackId: stack.id, to: "stopped", routesWithdrawn: true });
      const error = await refusal(
        settleOperation(db(), written.operation.id, { status: "succeeded" }, undefined, async (tx) => {
          await resume(stack, written)(tx);
          throw new Error("injected");
        }),
      );
      expect(error).toMatchObject({ message: "injected", ambiguousOutcome: true });
      const statuses = (await operationsOf(stack.id)).map((o) => [o.kind, o.status]);
      expect(statuses).toContainEqual(["stack.backup", "processing"]);
      expect(statuses.map(([kind]) => kind)).not.toContain("stack.start");
      expect((await stackOf(stack.id)).status).toBe("stopped");
    });

    it("queues nothing for an application that is running, busy, deleted or never installed", async () => {
      for (const status of ["running", "unknown", "starting", "deleting"] as const) {
        const stack = await installed({ status });
        const queued = await db().transaction((tx) =>
          enqueueAppStackResumeTransactional(tx, { organizationId: orgA, stackId: stack.id, requestedByUserId: null, sourceOperationId: `op_${status}` }),
        );
        expect([status, queued]).toEqual([status, null]);
        expect((await stackOf(stack.id)).status).toBe(status);
      }
      const gone = await installed({ status: "stopped" });
      await remove(gone.id);
      const draft = await installed({ status: "stopped" });
      await db().update(appStacks).set({ desiredRevisionId: null }).where(eq(appStacks.id, draft.id));
      for (const stack of [gone, draft]) {
        expect(
          await enqueueAppStackResumeTransactional(db(), { organizationId: orgA, stackId: stack.id, requestedByUserId: null, sourceOperationId: `op_${stack.id}` }),
        ).toBeNull();
      }
      const foreign = await installed({ status: "stopped" });
      expect(
        await enqueueAppStackResumeTransactional(db(), { organizationId: orgB, stackId: foreign.id, requestedByUserId: null, sourceOperationId: "op_foreign" }),
      ).toBeNull();
    });
  });

  describe("reads", () => {
    it("lists the backups of one application of one customer, newest first", async () => {
      const stack = await installed();
      const other = await installed({ org: orgB });
      const first = await goodBackup(stack);
      await db().update(appStackBackups).set({ startedAt: new Date(Date.now() - 60_000) }).where(eq(appStackBackups.id, first.backup.id));
      const second = await goodBackup(stack);
      await goodBackup(other);

      const listed = await listAppStackBackups(db(), { organizationId: orgA, stackId: stack.id });
      expect(listed.map((b) => b.id)).toEqual([second.backup.id, first.backup.id]);
      expect(await listAppStackBackups(db(), { organizationId: orgA, stackId: stack.id, limit: 1 })).toHaveLength(1);
      expect(await listAppStackBackups(db(), { organizationId: orgB, stackId: stack.id })).toEqual([]);
      expect(await getAppStackBackup(db(), { organizationId: orgA, stackId: stack.id, backupId: first.backup.id })).toMatchObject({ id: first.backup.id });
      expect(await getAppStackBackup(db(), { organizationId: orgB, stackId: stack.id, backupId: first.backup.id })).toBeNull();
      expect(await getAppStackBackup(db(), { organizationId: orgA, stackId: other.id, backupId: first.backup.id })).toBeNull();
      expect(await listAppStackBackupCopies(db(), [])).toEqual(new Map());
      const copies = await listAppStackBackupCopies(db(), listed.map((b) => b.id));
      expect([...copies.keys()].sort()).toEqual(listed.map((b) => b.id).sort());
    });
  });

  describe("retention", () => {
    it("names every application that has backups, deleted ones included", async () => {
      const live = await installed();
      const gone = await installed();
      const none = await installed();
      await goodBackup(live);
      await goodBackup(gone);
      await remove(gone.id);

      const scopes = await listAppStackBackupRetentionScopes(db());
      const byStack = new Map(scopes.map((s) => [s.stackId, s]));
      expect(byStack.get(live.id)).toEqual({ stackId: live.id, organizationId: orgA, live: true });
      expect(byStack.get(gone.id)).toEqual({ stackId: gone.id, organizationId: orgA, live: false });
      expect(byStack.has(none.id)).toBe(false);
      expect(scopes.filter((s) => s.stackId === live.id)).toHaveLength(1);
      expect((await listAppStackBackupsForRetention(db(), gone.id)).map((b) => b.stackId)).toEqual([gone.id]);
    });

    it("removes a backup only once it ended and its copies are gone", async () => {
      const stack = await installed();
      const old = await goodBackup(stack);
      const kept = await goodBackup(stack);
      const running = await request(stack);
      const ids = [old.backup.id, kept.backup.id, running.backup.id];

      expect(await deleteAppStackBackupsWithoutCopies(db(), ids)).toBe(0);
      await deleteAppStackBackupCopies(db(), []);
      await deleteAppStackBackupCopies(db(), [...(await copiesOf(old.backup.id)), ...(await copiesOf(running.backup.id))].map((c) => c.id));
      expect(await deleteAppStackBackupsWithoutCopies(db(), [])).toBe(0);
      expect(await deleteAppStackBackupsWithoutCopies(db(), ids)).toBe(1);
      const left = (await listAppStackBackupsForRetention(db(), stack.id)).map((b) => b.id);
      expect(left).toEqual(expect.arrayContaining([kept.backup.id, running.backup.id]));
      expect(left).not.toContain(old.backup.id);
    });

    it("a destination that holds a copy of an application cannot be deleted", async () => {
      const id = `bkt_${"3".repeat(32)}`;
      await db().execute(sql`INSERT INTO backup_targets (id, kind, name, config_json, s3_location_key, s3_secret_ciphertext_base64,
          s3_secret_iv_base64, s3_secret_auth_tag_base64, s3_secret_key_version)
        SELECT ${id}, 's3', 'Old', c.cfg, hp_s3_location_key(c.cfg->>'endpoint', c.cfg->>'bucket', c.cfg->>'prefix'), 'c', 'i', 't', 'v1'
        FROM (SELECT jsonb_build_object('endpoint', 'https://s3.old.example', 'region', 'r', 'bucket', 'b', 'prefix', 'p',
          'accessKeyId', 'A') AS cfg) c`);
      await setPolicyTargets(db(), policyId, [id]);
      const written = await goodBackup(await installed());
      await setPolicyTargets(db(), policyId, [LOCAL]);
      expect(await db().select().from(backupPolicyTargets).where(eq(backupPolicyTargets.targetId, id))).toEqual([]);

      expect(await deleteBackupTargetIfUnreferenced(db(), id)).toBe("in_use");
      // The database says the same to a release that does not know the table.
      await expect(db().delete(backupTargets).where(eq(backupTargets.id, id))).rejects.toThrow();
      await deleteAppStackBackupCopies(db(), (await copiesOf(written.backup.id)).map((c) => c.id));
      expect(await deleteBackupTargetIfUnreferenced(db(), id)).toBe("deleted");
    });

    it("the copies of a backup go with it", async () => {
      const written = await goodBackup(await installed());
      await db().delete(appStackBackups).where(eq(appStackBackups.id, written.backup.id));
      expect(await db().select().from(appStackBackupCopies).where(eq(appStackBackupCopies.backupId, written.backup.id))).toEqual([]);
    });
  });
});
