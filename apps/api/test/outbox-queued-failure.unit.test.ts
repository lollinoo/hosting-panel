import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DEMO_IDS,
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
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import type { ControlPlaneRuntimeConfig } from "../src/tokens.js";
import { OutboxWorkerService } from "../src/runtime/outbox-worker.service.js";
import type { SiteProvisioner } from "../src/runtime/site-provisioner.js";
import type { SiteDomainsApplier } from "../src/sites/site-domains-applier.js";
import type { SiteFilesApplier } from "../src/sites/site-files-applier.js";

// R207 host.3 (R189 3.2): queued -> failed is not allowed, so a failed move to processing must not leave the site locked.
describe("an operation whose move to processing fails", () => {
  let dbClient: DatabaseClient;
  let worker: OutboxWorkerService;
  const apply = vi.fn<SiteFilesApplier["apply"]>();
  const siteId = DEMO_IDS.sites.acmeShop;

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
  const opRow = async (id: string) => (await dbClient.db.select().from(operations).where(eq(operations.id, id)))[0]!;
  const eventStatuses = async (id: string) =>
    (await dbClient.db.select({ status: outboxEvents.status }).from(outboxEvents).where(sql`${outboxEvents.payload}->>'operationId' = ${id}`))
      .map((e) => e.status);

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
    worker = new OutboxWorkerService(
      dbClient,
      new InMemoryDockerSimulatorAdapter(),
      {} as unknown as HostAgentPort,
      config,
      {} as unknown as SiteProvisioner,
      {} as unknown as SiteDomainsApplier,
      { apply } as unknown as SiteFilesApplier,
    );
  });

  afterAll(async () => {
    await dbClient.close();
  });

  it("still queued: the event fails, the operation is cancelled and the site takes a new action", async () => {
    const { operation } = await enqueueArchive("queued-failure-1");
    // The database stays up; only the one move to processing throws.
    await dbClient.db.execute(sql.raw("CREATE FUNCTION test_fail_processing() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$"));
    await dbClient.db.execute(sql.raw("CREATE TRIGGER test_fail_processing BEFORE UPDATE ON operations FOR EACH ROW WHEN (NEW.status = 'processing') EXECUTE FUNCTION test_fail_processing()"));
    try {
      await worker.processPendingOnce();
    } finally {
      await dbClient.db.execute(sql.raw("DROP TRIGGER IF EXISTS test_fail_processing ON operations"));
      await dbClient.db.execute(sql.raw("DROP FUNCTION IF EXISTS test_fail_processing()"));
    }

    expect(apply).not.toHaveBeenCalled();
    expect(await eventStatuses(operation.id)).toEqual(["failed"]);
    const after = await opRow(operation.id);
    expect(after).toMatchObject({ status: "cancelled", leaseExpiresAt: null });
    expect(after.completedAt).not.toBeNull();
    const next = await enqueueArchive("queued-failure-2");
    expect(next.operation.status).toBe("queued");
  });

  it("already processing: the operation ends failed, as before", async () => {
    apply.mockRejectedValueOnce(new ControlPlaneError("NOT_SUPPORTED", "injected"));
    const [pending] = await dbClient.db.select().from(operations).where(eq(operations.status, "queued"));
    await worker.processPendingOnce();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(await eventStatuses(pending!.id)).toEqual(["failed"]);
    expect(await opRow(pending!.id)).toMatchObject({ status: "failed", errorCode: "NOT_SUPPORTED" });
  });
});
