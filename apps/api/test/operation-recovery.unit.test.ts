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
  operations,
  outboxEvents,
  seedPhase1Dataset,
  sql,
  type DatabaseClient,
} from "@hosting-panel/database";
import { InMemoryDockerSimulatorAdapter } from "@hosting-panel/docker-executor";
import type { HostAgentPort } from "@hosting-panel/host-agent-contracts";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
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

  beforeAll(async () => {
    dbClient = createDatabaseClient({ mode: "pglite" });
    await dbClient.migrate();
    await ensureWordpressTemplate(dbClient.db);
    const config: ControlPlaneRuntimeConfig = {
      oidcIssuer: "https://issuer.local",
      oidcAudience: "hosting-panel-api",
      enableDevOidc: true,
      runtimeBackend: "local-simulator",
      secretsMasterKey: randomBytes(32),
      jwtSigningKeyPem: null,
      autoProcessOutbox: false,
    };
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
});
