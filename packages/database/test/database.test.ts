import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OperationDtoSchema } from "@hosting-panel/contracts";
import {
  appendAuditEvent,
  auditEvents,
  claimPendingOutboxEvents,
  computeRequestHash,
  createDatabaseClient,
  type DatabaseClient,
  databases,
  DEMO_IDS,
  domains,
  enqueueOperationTransactional,
  eq,
  getOperationWithSteps,
  hostingResources,
  InvalidOperationTransitionError,
  mapOperationToDto,
  membershipRoles,
  memberships,
  operations,
  organizations,
  outboxEvents,
  providerConnections,
  providerInstances,
  requeueOutboxEvent,
  resolveMigrationsDirectory,
  resourceGrants,
  seedDemoDataset,
  serverAllocations,
  sql,
  transitionOperation,
  users,
} from "../src/index.js";

interface PgCauseError {
  readonly code?: string;
  readonly constraint?: string;
  readonly message?: string;
}

async function expectPostgresConstraintError(
  operation: Promise<unknown>,
  expected: {
    readonly sqlState: string;
    readonly constraint?: string;
    readonly messagePattern?: RegExp;
  },
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeDefined();
  const wrapper = caught as { cause?: PgCauseError } & PgCauseError;
  const pgError: PgCauseError = wrapper.cause ?? wrapper;
  expect(pgError.code).toBe(expected.sqlState);
  if (expected.constraint) {
    expect(pgError.constraint).toBe(expected.constraint);
  }
  if (expected.messagePattern) {
    expect(pgError.message ?? "").toMatch(expected.messagePattern);
  }
}

describe("@hosting-panel/database — PostgreSQL schema, invariants, seed & transactional outbox", () => {
  let client: DatabaseClient;

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    const applied = await client.migrate();
    expect(applied).toContain("0001_initial_poc.sql");
    await seedDemoDataset(client.db);
  });

  afterAll(async () => {
    await client.close();
  });

  it("1. runs SQL migrations and demo dataset seed idempotently with full HCP-SPEC-001 topology", async () => {
    expect(resolveMigrationsDirectory()).toBeTruthy();

    // Second migration + seed pass must be completely idempotent
    const appliedAgain = await client.migrate();
    expect(appliedAgain).toContain("0001_initial_poc.sql");

    await seedDemoDataset(client.db, {
      coolifyBaseUrl: "http://127.0.0.1:4199",
    });

    const allOrgs = await client.db.select().from(organizations);
    expect(allOrgs).toHaveLength(3);

    const legacyOrg = allOrgs.find((org) => org.id === DEMO_IDS.organizations.legacy);
    expect(legacyOrg?.status).toBe("suspended");

    const allUsers = await client.db.select().from(users);
    expect(allUsers).toHaveLength(5);

    const adminUser = allUsers.find((user) => user.id === DEMO_IDS.users.admin);
    expect(adminUser?.isPlatformAdmin).toBe(true);

    const allMemberships = await client.db.select().from(memberships);
    expect(allMemberships).toHaveLength(6);

    // Verify Marco has resource-scoped developer access ONLY to app_acme_storefront (not app_acme_api)
    const marcoRoles = await client.db
      .select()
      .from(membershipRoles)
      .where(eq(membershipRoles.membershipId, DEMO_IDS.memberships.marcoAcme));
    expect(marcoRoles).toHaveLength(1);
    expect(marcoRoles[0]?.roleId).toBe(DEMO_IDS.roles.developer);
    expect(marcoRoles[0]?.scopeType).toBe("resource");
    expect(marcoRoles[0]?.scopeResourceId).toBe(DEMO_IDS.applications.acmeStorefront);

    const marcoGrants = await client.db
      .select()
      .from(resourceGrants)
      .where(eq(resourceGrants.principalUserId, DEMO_IDS.users.marco));
    expect(marcoGrants.length).toBeGreaterThan(0);
    expect(
      marcoGrants.every((grant) => grant.resourceId === DEMO_IDS.applications.acmeStorefront),
    ).toBe(true);

    // Verify Luca is sole owner in org_beta (Elena is viewer only)
    const betaMemberships = allMemberships.filter(
      (membership) => membership.organizationId === DEMO_IDS.organizations.beta,
    );
    expect(betaMemberships).toHaveLength(2);

    // Verify provider instance baseUrl updated cleanly and provider_connections hold only vault:// refs
    const [provider] = await client.db
      .select()
      .from(providerInstances)
      .where(eq(providerInstances.id, DEMO_IDS.providers.coolifyLab));
    expect(provider?.baseUrl).toBe("http://127.0.0.1:4199");

    const connections = await client.db.select().from(providerConnections);
    expect(connections).toHaveLength(3);
    for (const conn of connections) {
      expect(conn.secretRefRead.startsWith("vault://")).toBe(true);
      if (conn.secretRefWrite !== null) {
        expect(conn.secretRefWrite.startsWith("vault://")).toBe(true);
      }
      if (conn.secretRefDeploy !== null) {
        expect(conn.secretRefDeploy.startsWith("vault://")).toBe(true);
      }
    }

    // Verify PostgreSQL 18.1 and Redis 7.4 databases seeded for AC-012
    const seededDbs = await client.db.select().from(databases);
    expect(seededDbs).toHaveLength(2);
    const pgDb = seededDbs.find((row) => row.resourceId === DEMO_IDS.databases.acmePostgres);
    const redisDb = seededDbs.find((row) => row.resourceId === DEMO_IDS.databases.acmeRedis);
    expect(pgDb?.engine).toBe("postgresql");
    expect(pgDb?.engineVersion).toBe("18.1");
    expect(redisDb?.engine).toBe("redis");
    expect(redisDb?.engineVersion).toBe("7.4");

    // Verify audit_events did not duplicate across re-seed
    const seededAudits = await client.db.select().from(auditEvents);
    expect(seededAudits).toHaveLength(2);
  });

  it("2. enforces SQL-level composite tenant ownership foreign keys across all resource tables", async () => {
    // (a) hosting_resources of org_acme referencing provider_connections of org_beta -> REJECTED
    await expectPostgresConstraintError(
      client.db.insert(hostingResources).values({
        id: "app_cross_tenant_conn",
        organizationId: DEMO_IDS.organizations.acme,
        connectionId: DEMO_IDS.providerConnections.beta,
        serverAllocationId: DEMO_IDS.servers.acmeProd,
        type: "application",
        name: "Cross Tenant App",
        slug: "cross-tenant-app",
        providerId: "coolify-cross-01",
      }),
      {
        sqlState: "23503",
        constraint: "fk_hosting_resources_connection_org",
      },
    );

    // (b) hosting_resources of org_acme referencing server_allocations of org_beta -> REJECTED
    await expectPostgresConstraintError(
      client.db.insert(hostingResources).values({
        id: "app_cross_tenant_srv",
        organizationId: DEMO_IDS.organizations.acme,
        connectionId: DEMO_IDS.providerConnections.acme,
        serverAllocationId: DEMO_IDS.servers.betaProd,
        type: "application",
        name: "Cross Tenant Server App",
        slug: "cross-tenant-srv",
        providerId: "coolify-cross-02",
      }),
      {
        sqlState: "23503",
        constraint: "fk_hosting_resources_server_org",
      },
    );

    // (c) server_allocations of org_acme referencing provider_connections of org_beta -> REJECTED
    await expectPostgresConstraintError(
      client.db.insert(serverAllocations).values({
        id: "srv_cross_tenant",
        organizationId: DEMO_IDS.organizations.acme,
        providerConnectionId: DEMO_IDS.providerConnections.beta,
        providerServerId: "coolify-srv-cross",
        name: "cross-srv",
        region: "eu-south-1",
        vcpuCount: 2,
        memoryMb: 2048,
        diskGb: 20,
      }),
      {
        sqlState: "23503",
        constraint: "fk_server_allocations_connection_org",
      },
    );

    // (d) domains of org_acme referencing application of org_beta -> REJECTED
    await expectPostgresConstraintError(
      client.db.insert(domains).values({
        id: "dom_cross_tenant",
        organizationId: DEMO_IDS.organizations.acme,
        applicationResourceId: DEMO_IDS.applications.betaPortal,
        hostname: "cross.acme.it",
      }),
      {
        sqlState: "23503",
        constraint: "fk_domains_app_resource_org",
      },
    );

    // (e) non-lowercase domain hostname -> REJECTED by CHECK constraint
    await expectPostgresConstraintError(
      client.db.insert(domains).values({
        id: "dom_uppercase_invalid",
        organizationId: DEMO_IDS.organizations.acme,
        applicationResourceId: DEMO_IDS.applications.acmeStorefront,
        hostname: "UpperCase.Acme.it",
      }),
      {
        sqlState: "23514",
        constraint: "domains_hostname_lowercase_check",
      },
    );

    // (f) resource_grants of org_acme referencing hosting_resources of org_beta -> REJECTED
    await expectPostgresConstraintError(
      client.db.insert(resourceGrants).values({
        id: "rgrant_cross_tenant",
        organizationId: DEMO_IDS.organizations.acme,
        principalUserId: DEMO_IDS.users.marco,
        resourceId: DEMO_IDS.applications.betaPortal,
        permission: "application.read",
        effect: "allow",
      }),
      {
        sqlState: "23503",
        constraint: "fk_resource_grants_resource_org",
      },
    );
  });

  it("3. enforces immutable append-only audit_events via PostgreSQL triggers and rejects secret metadata keys", async () => {
    const inserted = await appendAuditEvent(client.db, {
      id: "aud_immutability_check",
      organizationId: DEMO_IDS.organizations.acme,
      actorUserId: DEMO_IDS.users.elena,
      actorEmail: "elena.rossi@acme.it",
      action: "application.read",
      targetType: "application",
      targetId: DEMO_IDS.applications.acmeStorefront,
      outcome: "allowed",
      requestId: "req_immutability_01",
      metadata: {
        source: "integration-test",
      },
    });
    expect(inserted.id).toBe("aud_immutability_check");

    // SQL UPDATE must be rejected by PostgreSQL trigger
    await expectPostgresConstraintError(
      client.db
        .update(auditEvents)
        .set({ outcome: "denied" })
        .where(eq(auditEvents.id, "aud_immutability_check")),
      {
        sqlState: "55000",
        messagePattern: /audit_events is append-only and immutable; UPDATE is prohibited/,
      },
    );

    // SQL DELETE must be rejected by PostgreSQL trigger
    await expectPostgresConstraintError(
      client.db.delete(auditEvents).where(eq(auditEvents.id, "aud_immutability_check")),
      {
        sqlState: "55000",
        messagePattern: /audit_events is append-only and immutable; DELETE is prohibited/,
      },
    );

    // SQL TRUNCATE must also be rejected by PostgreSQL trigger
    await expectPostgresConstraintError(
      client.db.execute(sql`TRUNCATE TABLE audit_events`),
      {
        sqlState: "55000",
        messagePattern: /audit_events is append-only and immutable; TRUNCATE is prohibited/,
      },
    );

    // Row remains completely intact
    const [persisted] = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.id, "aud_immutability_check"));
    expect(persisted?.outcome).toBe("allowed");

    // Forbidden secret / internal provider keys must be rejected by AuditMetadataSchema
    await expect(
      appendAuditEvent(client.db, {
        organizationId: DEMO_IDS.organizations.acme,
        actorUserId: DEMO_IDS.users.elena,
        action: "application.deploy",
        targetType: "application",
        targetId: DEMO_IDS.applications.acmeStorefront,
        outcome: "allowed",
        requestId: "req_forbidden_meta",
        metadata: {
          coolifyToken: "super-secret-bearer",
        },
      }),
    ).rejects.toThrow();
  });

  it("4. enforces transactional outbox idempotency (AC-005 same hash deduplicated; AC-006 different hash conflict)", async () => {
    const hashA = computeRequestHash({ forceRebuild: true, reason: "Hotfix v2.4.2" });
    const hashB = computeRequestHash({ reason: "Hotfix v2.4.2", forceRebuild: true });
    const hashDifferent = computeRequestHash({ forceRebuild: false, reason: "Hotfix v2.4.2" });

    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(hashDifferent);

    const firstEnqueue = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      resourceType: "application",
      resourceId: DEMO_IDS.applications.acmeStorefront,
      kind: "application.deploy",
      requestedByUserId: DEMO_IDS.users.elena,
      actorEmail: "elena.rossi@acme.it",
      idempotencyKey: "idem-deploy-storefront-001",
      payload: { forceRebuild: true, reason: "Hotfix v2.4.2" },
      requestId: "req_deploy_001",
    });

    expect(firstEnqueue.ok).toBe(true);
    if (!firstEnqueue.ok || firstEnqueue.deduplicated) {
      throw new Error("Expected fresh operation enqueue.");
    }

    expect(firstEnqueue.operation.status).toBe("queued");
    expect(firstEnqueue.operation.steps).toHaveLength(3);
    expect(firstEnqueue.operation.steps.map((step) => [step.key, step.status])).toEqual([
      ["queued", "succeeded"],
      ["provider_dispatch", "pending"],
      ["reconcile_health", "pending"],
    ]);

    // DTO mapping validates cleanly against @hosting-panel/contracts OperationDtoSchema
    const parsedDto = OperationDtoSchema.parse(mapOperationToDto(firstEnqueue.operation));
    expect(parsedDto.id).toBe(firstEnqueue.operation.id);

    // AC-005: Replay with identical Idempotency-Key and canonically identical payload -> deduplicated
    const replaySame = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      resourceType: "application",
      resourceId: DEMO_IDS.applications.acmeStorefront,
      kind: "application.deploy",
      requestedByUserId: DEMO_IDS.users.elena,
      idempotencyKey: "idem-deploy-storefront-001",
      payload: { reason: "Hotfix v2.4.2", forceRebuild: true },
    });

    expect(replaySame.ok).toBe(true);
    expect(replaySame.deduplicated).toBe(true);
    if (!replaySame.ok) {
      throw new Error("Expected deduplicated replay.");
    }
    expect(replaySame.operation.id).toBe(firstEnqueue.operation.id);

    // Ensure only ONE operation row and ONE outbox_events row exist
    const allOps = await client.db.select().from(operations);
    expect(allOps).toHaveLength(1);
    const allOutbox = await client.db.select().from(outboxEvents);
    expect(allOutbox).toHaveLength(1);

    // AC-006: Replay with same Idempotency-Key and different payload -> IDEMPOTENCY_CONFLICT
    const replayConflict = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      resourceType: "application",
      resourceId: DEMO_IDS.applications.acmeStorefront,
      kind: "application.deploy",
      requestedByUserId: DEMO_IDS.users.elena,
      idempotencyKey: "idem-deploy-storefront-001",
      payload: { forceRebuild: false, reason: "Different payload" },
    });

    expect(replayConflict).toMatchObject({
      ok: false,
      deduplicated: false,
      errorCode: "IDEMPOTENCY_CONFLICT",
      conflictingOperationId: firstEnqueue.operation.id,
    });

    // Outbox claim & requeue verification
    const claimedFirst = await claimPendingOutboxEvents(client.db, 5);
    expect(claimedFirst).toHaveLength(1);
    expect(claimedFirst[0]?.operationId).toBe(firstEnqueue.operation.id);
    expect(claimedFirst[0]?.attempts).toBe(1);
    expect(claimedFirst[0]?.publishedAt).not.toBeNull();

    const claimedSecond = await claimPendingOutboxEvents(client.db, 5);
    expect(claimedSecond).toHaveLength(0);

    await requeueOutboxEvent(client.db, firstEnqueue.outboxEventId);
    const claimedAfterRequeue = await claimPendingOutboxEvents(client.db, 5);
    expect(claimedAfterRequeue).toHaveLength(1);
    expect(claimedAfterRequeue[0]?.attempts).toBe(2);

    // Complete operation so storefront lock is released for subsequent tests
    await transitionOperation(client.db, {
      operationId: firstEnqueue.operation.id,
      toStatus: "processing",
      step: { key: "provider_dispatch", status: "running" },
    });
    await transitionOperation(client.db, {
      operationId: firstEnqueue.operation.id,
      toStatus: "accepted_by_provider",
      providerOperationId: "coolify-deployment-xyz",
      step: { key: "provider_dispatch", status: "succeeded" },
    });
    await transitionOperation(client.db, {
      operationId: firstEnqueue.operation.id,
      toStatus: "reconciling",
      step: { key: "reconcile_health", status: "running" },
    });
    const completed = await transitionOperation(client.db, {
      operationId: firstEnqueue.operation.id,
      toStatus: "succeeded",
      step: {
        key: "reconcile_health",
        status: "succeeded",
        message: "Applicazione sana e raggiungibile.",
      },
    });
    expect(completed.status).toBe("succeeded");
    expect(completed.completedAt).not.toBeNull();
  });

  it("5. enforces per-resource mutation lock while active/unknown and unlocks automatically on succeeded/failed", async () => {
    const firstLockOp = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      resourceType: "application",
      resourceId: DEMO_IDS.applications.acmeApi,
      kind: "application.restart",
      requestedByUserId: DEMO_IDS.users.elena,
      idempotencyKey: "idem-restart-api-001",
      payload: { reason: "Memory pressure" },
    });

    expect(firstLockOp.ok).toBe(true);
    if (!firstLockOp.ok) {
      throw new Error("Expected operation to acquire lock.");
    }

    const [lockedResource] = await client.db
      .select()
      .from(hostingResources)
      .where(eq(hostingResources.id, DEMO_IDS.applications.acmeApi));
    expect(lockedResource?.lockedByOperationId).toBe(firstLockOp.operation.id);

    // Concurrent mutation with a different Idempotency-Key on the locked resource -> RESOURCE_LOCKED
    const blockedOp = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      resourceType: "application",
      resourceId: DEMO_IDS.applications.acmeApi,
      kind: "application.deploy",
      requestedByUserId: DEMO_IDS.users.elena,
      idempotencyKey: "idem-deploy-api-while-locked",
      payload: { forceRebuild: false },
    });

    expect(blockedOp).toMatchObject({
      ok: false,
      deduplicated: false,
      errorCode: "RESOURCE_LOCKED",
      conflictingOperationId: firstLockOp.operation.id,
    });

    // Transitioning through processing -> unknown keeps the resource locked (ambiguous state!)
    await transitionOperation(client.db, {
      operationId: firstLockOp.operation.id,
      toStatus: "processing",
      step: { key: "provider_dispatch", status: "running" },
    });
    await transitionOperation(client.db, {
      operationId: firstLockOp.operation.id,
      toStatus: "unknown",
      errorCode: "OPERATION_AMBIGUOUS",
      errorMessage: "Timeout durante la conferma del provider.",
      step: { key: "provider_dispatch", status: "unknown" },
    });

    const [stillLockedInUnknown] = await client.db
      .select()
      .from(hostingResources)
      .where(eq(hostingResources.id, DEMO_IDS.applications.acmeApi));
    expect(stillLockedInUnknown?.lockedByOperationId).toBe(firstLockOp.operation.id);

    // Transitioning unknown -> failed (terminal) automatically releases the lock
    const failedOp = await transitionOperation(client.db, {
      operationId: firstLockOp.operation.id,
      toStatus: "failed",
      errorCode: "COOLIFY_UNAVAILABLE",
      errorMessage: "Provider confermato non raggiungibile dopo riconciliazione.",
      steps: [
        { key: "provider_dispatch", status: "failed" },
        { key: "reconcile_health", status: "skipped" },
      ],
    });
    expect(failedOp.status).toBe("failed");

    const [unlockedAfterFailure] = await client.db
      .select()
      .from(hostingResources)
      .where(eq(hostingResources.id, DEMO_IDS.applications.acmeApi));
    expect(unlockedAfterFailure?.lockedByOperationId).toBeNull();

    // Now a subsequent operation on app_acme_api succeeds and unlocks on succeeded
    const secondOp = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      resourceType: "application",
      resourceId: DEMO_IDS.applications.acmeApi,
      kind: "application.restart",
      requestedByUserId: DEMO_IDS.users.elena,
      idempotencyKey: "idem-restart-api-002",
    });
    expect(secondOp.ok).toBe(true);
    if (!secondOp.ok) {
      throw new Error("Expected unlocked resource to accept new operation.");
    }

    await transitionOperation(client.db, {
      operationId: secondOp.operation.id,
      toStatus: "processing",
    });
    await transitionOperation(client.db, {
      operationId: secondOp.operation.id,
      toStatus: "accepted_by_provider",
    });
    await transitionOperation(client.db, {
      operationId: secondOp.operation.id,
      toStatus: "reconciling",
    });
    await transitionOperation(client.db, {
      operationId: secondOp.operation.id,
      toStatus: "succeeded",
    });

    const [unlockedAfterSuccess] = await client.db
      .select()
      .from(hostingResources)
      .where(eq(hostingResources.id, DEMO_IDS.applications.acmeApi));
    expect(unlockedAfterSuccess?.lockedByOperationId).toBeNull();
  });

  it("6. rejects invalid operation state transitions (e.g., queued -> succeeded and succeeded -> processing)", async () => {
    const enqueued = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.beta,
      resourceType: "application",
      resourceId: DEMO_IDS.applications.betaPortal,
      kind: "application.restart",
      requestedByUserId: DEMO_IDS.users.luca,
      idempotencyKey: "idem-beta-invalid-transition",
    });

    expect(enqueued.ok).toBe(true);
    if (!enqueued.ok) {
      throw new Error("Expected operation enqueue.");
    }

    // Illegal jump directly from queued -> succeeded must be rejected
    await expect(
      transitionOperation(client.db, {
        operationId: enqueued.operation.id,
        toStatus: "succeeded",
      }),
    ).rejects.toThrow(InvalidOperationTransitionError);

    // Operation remains queued and resource remains locked
    const persistedQueued = await getOperationWithSteps(
      client.db,
      DEMO_IDS.organizations.beta,
      enqueued.operation.id,
    );
    expect(persistedQueued?.status).toBe("queued");

    // Valid transition queued -> cancelled releases lock
    const cancelled = await transitionOperation(client.db, {
      operationId: enqueued.operation.id,
      toStatus: "cancelled",
      step: { key: "provider_dispatch", status: "cancelled" },
    });
    expect(cancelled.status).toBe("cancelled");

    const [betaResource] = await client.db
      .select()
      .from(hostingResources)
      .where(eq(hostingResources.id, DEMO_IDS.applications.betaPortal));
    expect(betaResource?.lockedByOperationId).toBeNull();

    // Terminal state cancelled -> processing must also be rejected
    await expect(
      transitionOperation(client.db, {
        operationId: enqueued.operation.id,
        toStatus: "processing",
      }),
    ).rejects.toThrow(InvalidOperationTransitionError);
  });
});
