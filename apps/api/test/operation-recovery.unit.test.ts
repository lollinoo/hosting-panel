import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEMO_IDS,
  and,
  auditEvents,
  createDatabaseClient,
  enqueueOperationTransactional,
  ensureWordpressTemplate,
  eq,
  operationSteps,
  operations,
  outboxEvents,
  seedPhase1Dataset,
  serviceInstances,
  sql,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";
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

describe("operation settling and recovery (D15, D16)", () => {
  let dbClient: DatabaseClient;
  let sim: InMemoryDockerSimulatorAdapter;
  let worker: OutboxWorkerService;
  const svcId = DEMO_IDS.services.acmeShopWp;
  const siteId = DEMO_IDS.sites.acmeShop;
  let n = 0;

  // A trigger makes every move to succeeded fail, as a database that drops between the work and its record.
  async function failSucceededMoves(): Promise<void> {
    await dbClient.db.execute(
      sql.raw("CREATE FUNCTION test_fail_succeeded() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$"),
    );
    await dbClient.db.execute(
      sql.raw(
        "CREATE TRIGGER test_fail_succeeded BEFORE UPDATE ON operations FOR EACH ROW WHEN (NEW.status = 'succeeded') EXECUTE FUNCTION test_fail_succeeded()",
      ),
    );
  }

  async function allowSucceededMoves(): Promise<void> {
    await dbClient.db.execute(sql.raw("DROP TRIGGER IF EXISTS test_fail_succeeded ON operations"));
    await dbClient.db.execute(sql.raw("DROP FUNCTION IF EXISTS test_fail_succeeded()"));
  }

  async function opRow(id: string) {
    const [row] = await dbClient.db.select().from(operations).where(eq(operations.id, id));
    return row!;
  }

  async function audits(id: string, action: string): Promise<number> {
    const rows = await dbClient.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, id), eq(auditEvents.action, action)));
    return rows.length;
  }

  async function enqueueDeploy() {
    n += 1;
    return enqueueOperationTransactional(dbClient.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "service.deploy",
      resourceType: "service",
      resourceId: svcId,
      lockKey: `service:${svcId}`,
      idempotencyKey: `recovery-deploy-${String(n)}`,
      outboxPayload: {},
      steps: [
        { key: "validate_spec", label: "Check the request" },
        { key: "dispatch_ipc", label: "Apply the change" },
        { key: "reconcile_state", label: "Check the site" },
      ],
    });
  }

  const config: ControlPlaneRuntimeConfig = {
    oidcIssuer: "https://issuer.local",
    oidcAudience: "hosting-panel-api",
    enableDevOidc: true,
    runtimeBackend: "local-simulator",
    secretsMasterKey: randomBytes(32),
    jwtSigningKeyPem: null,
    autoProcessOutbox: false,
  };

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await ensureWordpressTemplate(dbClient.db);
    await seedPhase1Dataset(dbClient.db, config.secretsMasterKey);
    sim = new InMemoryDockerSimulatorAdapter();
    worker = new OutboxWorkerService(
      dbClient,
      sim,
      {} as unknown as HostAgentPort,
      config,
      {} as unknown as SiteProvisioner,
      {} as unknown as SiteDomainsApplier,
      {} as unknown as SiteFilesApplier,
    );
  });

  afterAll(async () => {
    await allowSucceededMoves();
    await dbClient.close();
  });

  it("worker catch moves a deploy to unknown, not failed, when settleOperation throws", async () => {
    const { operation } = await enqueueDeploy();
    let leaseWhileReconciling: Date | null = null;
    const original = sim.getObservedState.bind(sim);
    const observe = vi.spyOn(sim, "getObservedState").mockImplementationOnce(async (id) => {
      leaseWhileReconciling = (await opRow(operation.id)).leaseExpiresAt;
      return original(id);
    });
    await failSucceededMoves();
    try {
      await worker.processPendingOnce();
    } finally {
      await allowSucceededMoves();
      observe.mockRestore();
    }

    // Deploy reconciling carries DEPLOY_LEASE_MS, so the sweep never takes it mid-flight.
    expect(leaseWhileReconciling!.getTime()).toBeGreaterThan(Date.now() + 5 * 60_000);
    const after = await opRow(operation.id);
    expect(after.status).toBe("unknown");
    expect(await audits(svcId, "service.deploy.succeeded")).toBe(0);

    // The deployed container is there: recovery reads it and settles the deploy as succeeded.
    const recovery = await worker.recoverUnknownOperations();
    expect(recovery.recoveryErrors).toBeUndefined();
    expect((await opRow(operation.id)).status).toBe("succeeded");
    expect(await audits(operation.id, "operation.recovered.succeeded")).toBe(1);
  });

  it("service recovery writes operation.recovered.succeeded in the settling transaction", async () => {
    const { operation } = await enqueueDeploy();
    await dbClient.db
      .update(operations)
      .set({ status: "unknown", leaseExpiresAt: null })
      .where(eq(operations.id, operation.id));
    await dbClient.db
      .update(outboxEvents)
      .set({ status: "processing" })
      .where(sql`${outboxEvents.payload}->>'operationId' = ${operation.id}`);

    await failSucceededMoves();
    try {
      const failed = await worker.recoverUnknownOperations();
      expect(failed.recoveryErrors?.map((e) => e.operationId)).toEqual([operation.id]);
    } finally {
      await allowSucceededMoves();
    }
    // Nothing half-done: still unknown (never a reconciling row without a lease) and no audit.
    expect(await opRow(operation.id)).toMatchObject({ status: "unknown" });
    expect(await audits(operation.id, "operation.recovered.succeeded")).toBe(0);

    // The audit insert itself fails: the operation must stay unknown, so the row is written inside the settle.
    await dbClient.db.execute(sql.raw("CREATE FUNCTION test_fail_recovered_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$"));
    await dbClient.db.execute(sql.raw("CREATE TRIGGER test_fail_recovered_audit BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.action = 'operation.recovered.succeeded') EXECUTE FUNCTION test_fail_recovered_audit()"));
    try {
      const failed = await worker.recoverUnknownOperations();
      expect(failed.recoveryErrors?.map((e) => e.operationId)).toEqual([operation.id]);
    } finally {
      await dbClient.db.execute(sql.raw("DROP TRIGGER IF EXISTS test_fail_recovered_audit ON audit_events"));
      await dbClient.db.execute(sql.raw("DROP FUNCTION IF EXISTS test_fail_recovered_audit()"));
    }
    expect(await opRow(operation.id)).toMatchObject({ status: "unknown" });

    await worker.recoverUnknownOperations();
    expect((await opRow(operation.id)).status).toBe("succeeded");
    expect(await audits(operation.id, "operation.recovered.succeeded")).toBe(1);
    const events = await dbClient.db
      .select({ status: outboxEvents.status })
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'operationId' = ${operation.id}`);
    expect(events.map((e) => e.status)).not.toContain("processing");
  });

  it("a reconciling operation with a past lease is swept, settled and frees the site lock", async () => {
    const enqueueArchive = (key: string) =>
      enqueueOperationTransactional(dbClient.db, {
        organizationId: DEMO_IDS.organizations.acme,
        kind: "site.files.archive",
        resourceType: "site",
        resourceId: siteId,
        lockKey: `site:${siteId}`,
        idempotencyKey: key,
        outboxPayload: {},
      });
    const { operation } = await enqueueArchive("recovery-archive-stuck");
    await dbClient.db
      .update(operations)
      .set({ status: "reconciling", leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(operations.id, operation.id));
    await dbClient.db
      .update(outboxEvents)
      .set({ status: "processing" })
      .where(sql`${outboxEvents.payload}->>'operationId' = ${operation.id}`);

    await expect(enqueueArchive("recovery-archive-blocked")).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

    const recovery = await worker.recoverUnknownOperations();
    expect(recovery.markedUnknown).toBe(1);
    expect(await opRow(operation.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_INTERRUPTED" });
    const events = await dbClient.db
      .select({ status: outboxEvents.status })
      .from(outboxEvents)
      .where(sql`${outboxEvents.payload}->>'operationId' = ${operation.id}`);
    expect(events.map((e) => e.status)).toEqual(["failed"]);

    const next = await enqueueArchive("recovery-archive-next");
    expect(next.operation.status).toBe("queued");
  });

  // Issue #183: the read of the service's container keeps failing in a way waiting does not cure.
  const MINUTE = 60_000;
  const coded = (code: string) => Object.assign(new Error(`executor said ${code}`), { code });

  /** A deploy left in doubt, as the sweep leaves it: unknown, its outbox event still processing. */
  async function parkedDeploy() {
    const { operation } = await enqueueDeploy();
    await dbClient.db.update(operations).set({ status: "unknown", leaseExpiresAt: null }).where(eq(operations.id, operation.id));
    await dbClient.db
      .update(outboxEvents)
      .set({ status: "processing" })
      .where(sql`${outboxEvents.payload}->>'operationId' = ${operation.id}`);
    return operation;
  }

  /**
   * A worker on the simulator whose container read throws `fault.err` while it is set. Every call that reaches the
   * executor is recorded, and any other than the read throws, so recovery can only read.
   */
  function boundedWorker(fault: { err: unknown }, clock: { t: number }) {
    const calls: string[] = [];
    const port = new Proxy(sim, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        const name = String(prop);
        return (...args: unknown[]) => {
          calls.push(name);
          if (name !== "getObservedState") throw new Error("mutating call during recovery");
          if (fault.err !== null) return Promise.reject(fault.err);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const w = new OutboxWorkerService(
      dbClient,
      port,
      {} as unknown as HostAgentPort,
      config,
      {} as unknown as SiteProvisioner,
      {} as unknown as SiteDomainsApplier,
      {} as unknown as SiteFilesApplier,
    );
    w.recoveryReads = new RecoveryReadBound(() => clock.t);
    calls.length = 0;
    return { w, calls };
  }

  const serviceRow = async () =>
    (await dbClient.db.select({ desiredStatus: serviceInstances.desiredStatus, currentRevisionId: serviceInstances.currentRevisionId }).from(serviceInstances).where(eq(serviceInstances.id, svcId)))[0]!;
  const eventsOf = async (id: string) =>
    (await dbClient.db.select({ status: outboxEvents.status }).from(outboxEvents).where(sql`${outboxEvents.payload}->>'operationId' = ${id}`)).map((e) => e.status);

  it("#183: a service operation whose container cannot be read for the whole bound is closed as not confirmed, only read", async () => {
    const operation = await parkedDeploy();
    const before = await serviceRow();
    const clock = { t: Date.UTC(2026, 10, 24, 12) };
    const fault: { err: unknown } = { err: coded("INTERNAL_ERROR") };
    const { w, calls } = boundedWorker(fault, clock);

    await w.recoverUnknownOperations();
    clock.t += RECOVERY_READ_GIVE_UP_MS - 1;
    fault.err = new SyntaxError("Unexpected token < in JSON");
    await w.recoverUnknownOperations();
    expect((await opRow(operation.id)).status).toBe("unknown");
    await expect(enqueueDeploy()).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

    clock.t += 1;
    const closing = await w.recoverUnknownOperations();

    expect(closing.recoveryErrors).toBeUndefined();
    expect(closing.convergedFailed).toBe(1);
    expect(await opRow(operation.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_AMBIGUOUS", errorMessage: RECOVERY_UNCONFIRMED_TEXT });
    const steps = await dbClient.db.select().from(operationSteps).where(eq(operationSteps.operationId, operation.id));
    expect(steps.map((s) => s.status)).toEqual(["failed", "failed", "failed"]);
    const unconfirmed = await dbClient.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.targetId, operation.id), eq(auditEvents.action, RECOVERY_UNCONFIRMED_AUDIT_ACTION)));
    expect(unconfirmed.map((a) => a.details)).toEqual([
      { operationId: operation.id, kind: "service.deploy", resourceType: "service", resourceId: svcId, minutesWaited: 30, failure: "unexpected_error" },
    ]);
    expect(await audits(operation.id, "operation.recovered.failed")).toBe(0);
    expect(await eventsOf(operation.id)).toEqual(["failed"]);
    // The service row keeps what the request wrote, as when the executor runtime is unavailable.
    expect(await serviceRow()).toEqual(before);
    expect(calls).toEqual(["getObservedState", "getObservedState", "getObservedState"]);
    expect(w.recoveryReads.size).toBe(0);

    // Nothing left in doubt: no read, no second row; the lock is free.
    await w.recoverUnknownOperations();
    expect(calls).toHaveLength(3);
    const next = await enqueueDeploy();
    expect(next.operation.status).toBe("queued");
    await dbClient.db.update(operations).set({ status: "failed" }).where(eq(operations.id, next.operation.id));
  });

  it("#183: a service read that fails as an honest wait never closes the operation, and starts the count again", async () => {
    const operation = await parkedDeploy();
    const clock = { t: Date.UTC(2026, 10, 24, 12) };
    const fault: { err: unknown } = { err: null };
    const { w } = boundedWorker(fault, clock);
    for (const code of ["DOCKER_ENGINE_UNAVAILABLE", "OPERATION_AMBIGUOUS", "RESOURCE_LOCKED"]) {
      fault.err = coded(code);
      for (let pass = 0; pass < 4; pass += 1) {
        await w.recoverUnknownOperations();
        clock.t += 30 * MINUTE;
      }
    }
    expect((await opRow(operation.id)).status).toBe("unknown");
    expect(w.recoveryReads.size).toBe(0);

    // Counted, honest, counted again: the count starts from the last honest wait.
    fault.err = coded("VALIDATION_ERROR");
    await w.recoverUnknownOperations();
    clock.t += 20 * MINUTE;
    fault.err = coded("DOCKER_ENGINE_UNAVAILABLE");
    await w.recoverUnknownOperations();
    clock.t += 20 * MINUTE;
    fault.err = coded("VALIDATION_ERROR");
    await w.recoverUnknownOperations();
    clock.t += 29 * MINUTE;
    await w.recoverUnknownOperations();
    expect((await opRow(operation.id)).status).toBe("unknown");
    expect(await audits(operation.id, RECOVERY_UNCONFIRMED_AUDIT_ACTION)).toBe(0);
    clock.t += MINUTE;
    await w.recoverUnknownOperations();
    expect(await opRow(operation.id)).toMatchObject({ status: "failed", errorCode: "OPERATION_AMBIGUOUS" });
  });

  it("#183: a service read that answers settles the operation from what it shows and drops its count", async () => {
    const operation = await parkedDeploy();
    const clock = { t: Date.UTC(2026, 10, 24, 12) };
    const fault: { err: unknown } = { err: coded("INTERNAL_ERROR") };
    const { w, calls } = boundedWorker(fault, clock);
    await w.recoverUnknownOperations();
    expect(w.recoveryReads.size).toBe(1);
    clock.t += 29 * MINUTE;
    fault.err = null;

    await w.recoverUnknownOperations();

    expect(w.recoveryReads.size).toBe(0);
    // The container deployed by the first test runs the current revision.
    expect((await opRow(operation.id)).status).toBe("succeeded");
    expect(await audits(operation.id, "operation.recovered.succeeded")).toBe(1);
    expect(await audits(operation.id, RECOVERY_UNCONFIRMED_AUDIT_ACTION)).toBe(0);
    expect(calls).toEqual(["getObservedState", "getObservedState"]);
  });
});
