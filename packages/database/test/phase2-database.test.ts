import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findForbiddenPublicDtoKeys } from "@hosting-panel/contracts";
import {
  DEMO_IDS,
  auditEvents,
  claimPendingOutboxEvents,
  completeOutboxEvent,
  createDatabaseClient,
  decryptSecretAesGcm,
  deleteEncryptedSecretTransactional,
  dockerResources,
  encryptSecretAesGcm,
  encryptedSecrets,
  enqueueOperationTransactional,
  eq,
  failOutboxEvent,
  generateSecretsMasterKeyHex,
  listEncryptedSecretsMetadata,
  listHostAgentHeartbeats,
  markExpiredOperationsUnknownTransactional,
  recordObservedStateReconciliationTransactional,
  resolveDecryptedSecretRefs,
  schemaMigrations,
  seedPhase1Dataset,
  serviceInstances,
  stackRevisions,
  transitionOperation,
  unlockOperationBreakGlassTransactional,
  updateOperationStepTransactional,
  upsertEncryptedSecretTransactional,
  upsertHostAgentHeartbeat,
  type DatabaseClient,
} from "../src/index.js";

describe("@hosting-panel/database — Phase 2 Runtime, AES-256-GCM Secrets, Outbox & Reconciler (AC-F2-05..08)", () => {
  let client: DatabaseClient;
  const masterKey = generateSecretsMasterKeyHex();

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    const applied = await client.migrate();
    expect(applied).toEqual([
      "0001_phase1_docker_native.sql",
      "0002_phase2_runtime_and_secrets.sql",
      "0003_production_accounts.sql",
      "0004_sites_and_databases.sql",
    ]);
    await seedPhase1Dataset(client.db);
  });

  afterAll(async () => {
    await client.close();
  });

  it("1. tracks applied SQL migrations idempotently in schema_migrations", async () => {
    const firstRows = await client.db.select().from(schemaMigrations);
    expect(firstRows.map((r) => r.filename)).toEqual([
      "0001_phase1_docker_native.sql",
      "0002_phase2_runtime_and_secrets.sql",
      "0003_production_accounts.sql",
      "0004_sites_and_databases.sql",
    ]);

    const firstTimestamps = firstRows.map((r) => r.appliedAt.getTime());

    // Running migrate() again must NOT re-execute or overwrite applied_at rows
    const appliedAgain = await client.migrate();
    expect(appliedAgain).toEqual([
      "0001_phase1_docker_native.sql",
      "0002_phase2_runtime_and_secrets.sql",
      "0003_production_accounts.sql",
      "0004_sites_and_databases.sql",
    ]);

    const secondRows = await client.db.select().from(schemaMigrations);
    expect(secondRows.map((r) => r.appliedAt.getTime())).toEqual(firstTimestamps);
  });

  it("2. encrypts and decrypts secrets with AES-256-GCM + tenant/site/key AAD binding (AC-F2-05)", () => {
    const envelope = encryptSecretAesGcm({
      plaintext: "super-secret-db-password-2026!",
      masterKey,
      organizationId: DEMO_IDS.organizations.acme,
      siteId: DEMO_IDS.sites.acmeShop,
      secretKey: "WORDPRESS_DB_PASSWORD",
      keyVersion: "v1",
    });

    // 12-byte IV & 16-byte authTag
    expect(Buffer.from(envelope.ivBase64, "base64")).toHaveLength(12);
    expect(Buffer.from(envelope.authTagBase64, "base64")).toHaveLength(16);
    expect(envelope.ciphertextBase64).not.toContain("super-secret");

    const decrypted = decryptSecretAesGcm({
      ...envelope,
      masterKey,
      organizationId: DEMO_IDS.organizations.acme,
      siteId: DEMO_IDS.sites.acmeShop,
      secretKey: "WORDPRESS_DB_PASSWORD",
    });
    expect(decrypted).toBe("super-secret-db-password-2026!");

    // Cross-tenant AAD mismatch MUST fail GCM authentication
    expect(() =>
      decryptSecretAesGcm({
        ...envelope,
        masterKey,
        organizationId: DEMO_IDS.organizations.beta,
        siteId: DEMO_IDS.sites.acmeShop,
        secretKey: "WORDPRESS_DB_PASSWORD",
      }),
    ).toThrow();

    // Cross-site AAD mismatch MUST fail GCM authentication
    expect(() =>
      decryptSecretAesGcm({
        ...envelope,
        masterKey,
        organizationId: DEMO_IDS.organizations.acme,
        siteId: null,
        secretKey: "WORDPRESS_DB_PASSWORD",
      }),
    ).toThrow();

    // SecretKey AAD mismatch MUST fail GCM authentication
    expect(() =>
      decryptSecretAesGcm({
        ...envelope,
        masterKey,
        organizationId: DEMO_IDS.organizations.acme,
        siteId: DEMO_IDS.sites.acmeShop,
        secretKey: "OTHER_KEY",
      }),
    ).toThrow();

    // Wrong master key MUST fail GCM authentication
    expect(() =>
      decryptSecretAesGcm({
        ...envelope,
        masterKey: generateSecretsMasterKeyHex(),
        organizationId: DEMO_IDS.organizations.acme,
        siteId: DEMO_IDS.sites.acmeShop,
        secretKey: "WORDPRESS_DB_PASSWORD",
      }),
    ).toThrow();
  });

  it("3. manages encrypted_secrets write-only lifecycle, composite ownership FKs, and JIT resolution (AC-F2-05)", async () => {
    // 1. Organization-wide secret
    const orgSecret = await upsertEncryptedSecretTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      siteId: null,
      secretKey: "SMTP_PASSWORD",
      value: "org-smtp-secret-v1",
      masterKey,
      actorId: DEMO_IDS.users.elena,
    });
    expect(orgSecret.version).toBe(1);
    expect(findForbiddenPublicDtoKeys(orgSecret)).toHaveLength(0);

    // 2. Rotate organization-wide secret -> version increments to 2
    const rotatedOrgSecret = await upsertEncryptedSecretTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      siteId: null,
      secretKey: "SMTP_PASSWORD",
      value: "org-smtp-secret-v2",
      masterKey,
      actorId: DEMO_IDS.users.elena,
    });
    expect(rotatedOrgSecret.id).toBe(orgSecret.id);
    expect(rotatedOrgSecret.version).toBe(2);

    // 3. Site-scoped secret on acmeShop
    const siteSecret = await upsertEncryptedSecretTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      siteId: DEMO_IDS.sites.acmeShop,
      secretKey: "WORDPRESS_DB_PASSWORD",
      value: "shop-db-secret-999",
      masterKey,
      actorId: DEMO_IDS.users.elena,
    });
    expect(siteSecret.siteId).toBe(DEMO_IDS.sites.acmeShop);
    expect(siteSecret.version).toBe(1);

    // 4. Cross-tenant site reference rejected with NOT_FOUND + enforced by SQL composite FK
    await expect(
      upsertEncryptedSecretTransactional(client.db, {
        organizationId: DEMO_IDS.organizations.acme,
        siteId: DEMO_IDS.sites.betaPortal,
        secretKey: "ILLEGAL_CROSS_SITE",
        value: "val",
        masterKey,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      client.db.insert(encryptedSecrets).values({
        id: "sec_illegal_fk",
        organizationId: DEMO_IDS.organizations.acme,
        siteId: DEMO_IDS.sites.betaPortal,
        secretKey: "ILLEGAL_SQL_FK",
        ciphertextBase64: "YWJj",
        ivBase64: "MTIzNDU2Nzg5MDEy",
        authTagBase64: "MTIzNDU2Nzg5MDEyMzQ1Ng==",
      }),
    ).rejects.toThrow();

    // 5. Metadata listing never leaks ciphertext or plaintext
    const listMeta = await listEncryptedSecretsMetadata(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
    });
    expect(listMeta).toHaveLength(2);
    expect(findForbiddenPublicDtoKeys(listMeta)).toHaveLength(0);

    // 6. JIT resolution by both sec_* ID and secretKey within site + org scope
    const resolvedForShop = await resolveDecryptedSecretRefs(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      siteId: DEMO_IDS.sites.acmeShop,
      secretRefs: {
        WP_DB_PASS: siteSecret.id,
        MAIL_PASS: "SMTP_PASSWORD",
      },
      masterKey,
    });
    expect(resolvedForShop).toEqual({
      WP_DB_PASS: "shop-db-secret-999",
      MAIL_PASS: "org-smtp-secret-v2",
    });

    // Site B (acmeBlog) MUST NOT resolve Site A (acmeShop) secret!
    await expect(
      resolveDecryptedSecretRefs(client.db, {
        organizationId: DEMO_IDS.organizations.acme,
        siteId: DEMO_IDS.sites.acmeBlog,
        secretRefs: {
          WP_DB_PASS: siteSecret.id,
        },
        masterKey,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Cross-tenant delete returns NOT_FOUND
    await expect(
      deleteEncryptedSecretTransactional(client.db, {
        organizationId: DEMO_IDS.organizations.beta,
        secretId: siteSecret.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Valid delete
    const del = await deleteEncryptedSecretTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      secretId: siteSecret.id,
      actorId: DEMO_IDS.users.elena,
    });
    expect(del.deletedId).toBe(siteSecret.id);
  });

  it("4. enforces active lockKey mutual exclusion, org idempotency replay, and secret-free outbox payloads (AC-F2-06)", async () => {
    const lockKey = `svc:${DEMO_IDS.services.acmeShopWp}`;

    // Rejects outboxPayload containing secrets
    await expect(
      enqueueOperationTransactional(client.db, {
        organizationId: DEMO_IDS.organizations.acme,
        kind: "service.deploy",
        resourceType: "service",
        resourceId: DEMO_IDS.services.acmeShopWp,
        outboxPayload: { password: "leaked-plain-secret" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // First enqueue acquires lockKey and creates outbox event
    const first = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "service.deploy",
      resourceType: "service",
      resourceId: DEMO_IDS.services.acmeShopWp,
      requestedByUserId: DEMO_IDS.users.elena,
      idempotencyKey: "idem-deploy-shop-01",
      lockKey,
      steps: [
        { key: "validate", label: "Validate spec" },
        { key: "deploy", label: "Deploy container" },
      ],
    });
    expect(first.idempotentReplay).toBe(false);
    expect(first.outbox).not.toBeNull();
    expect(first.operation.leaseExpiresAt).toBeInstanceOf(Date);

    // Replay with identical (organizationId, idempotencyKey) returns existing operation with outbox: null
    const replay = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "service.deploy",
      resourceType: "service",
      resourceId: DEMO_IDS.services.acmeShopWp,
      requestedByUserId: DEMO_IDS.users.elena,
      idempotencyKey: "idem-deploy-shop-01",
      lockKey,
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.operation.id).toBe(first.operation.id);
    expect(replay.outbox).toBeNull();
    expect(replay.steps).toHaveLength(2);

    // Reusing same idempotencyKey for a DIFFERENT resource fails with IDEMPOTENCY_CONFLICT
    await expect(
      enqueueOperationTransactional(client.db, {
        organizationId: DEMO_IDS.organizations.acme,
        kind: "service.stop",
        resourceType: "service",
        resourceId: DEMO_IDS.services.acmeShopWp,
        idempotencyKey: "idem-deploy-shop-01",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    // Concurrent mutation with a DIFFERENT idempotencyKey on the SAME active lockKey fails with RESOURCE_LOCKED
    await expect(
      enqueueOperationTransactional(client.db, {
        organizationId: DEMO_IDS.organizations.acme,
        kind: "service.restart",
        resourceType: "service",
        resourceId: DEMO_IDS.services.acmeShopWp,
        idempotencyKey: "idem-restart-shop-02",
        lockKey,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

    // Claim outbox event with FOR UPDATE SKIP LOCKED -> transitions to 'processing' with lockedAt
    const claimed = await claimPendingOutboxEvents(client.db, 10, 60_000);
    const ourClaimed = claimed.find((e) => e.id === first.outbox!.id);
    expect(ourClaimed).toBeDefined();
    expect(ourClaimed?.status).toBe("processing");
    expect(ourClaimed?.lockedAt).toBeInstanceOf(Date);

    // Second claim while already 'processing' returns empty
    const claimedAgain = await claimPendingOutboxEvents(client.db, 10, 60_000);
    expect(claimedAgain.find((e) => e.id === first.outbox!.id)).toBeUndefined();

    // Update operation steps and complete operation + outbox
    const runningStep = await updateOperationStepTransactional(
      client.db,
      first.operation.id,
      "validate",
      "succeeded",
      "Spec verified",
    );
    expect(runningStep.status).toBe("succeeded");
    expect(runningStep.completedAt).toBeInstanceOf(Date);

    await transitionOperation(client.db, first.operation.id, "processing");
    await transitionOperation(client.db, first.operation.id, "reconciling");
    const completedOp = await transitionOperation(client.db, first.operation.id, "succeeded");
    expect(completedOp.status).toBe("succeeded");

    const publishedOutbox = await completeOutboxEvent(client.db, first.outbox!.id);
    expect(publishedOutbox.status).toBe("published");
    expect(publishedOutbox.publishedAt).toBeInstanceOf(Date);

    // Now that first operation is in terminal 'succeeded', lockKey is released!
    const nextAfterRelease = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "service.restart",
      resourceType: "service",
      resourceId: DEMO_IDS.services.acmeShopWp,
      idempotencyKey: "idem-restart-shop-03",
      lockKey,
    });
    expect(nextAfterRelease.operation.status).toBe("queued");

    // Fail outbox event increments retryCount and redacts sensitive tokens
    const failedOutbox = await failOutboxEvent(
      client.db,
      nextAfterRelease.outbox!.id,
      "Executor failed with Bearer secret-jwt-xyz",
    );
    expect(failedOutbox.status).toBe("failed");
    expect(failedOutbox.retryCount).toBe(1);
    expect(failedOutbox.lastError).toBe("Executor failed with Bearer [REDACTED]");

    // Clean up lock by cancelling queued operation
    await transitionOperation(client.db, nextAfterRelease.operation.id, "cancelled");
  });

  it("5. transitions expired operations to 'unknown' keeping lockKey active and unlocks via break-glass with mandatory audit (AC-F2-07)", async () => {
    const lockKey = `host:${DEMO_IDS.hosts.acme}`;
    const pastTime = new Date(Date.now() - 120_000);

    const enqueued = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "host.security",
      resourceType: "host",
      resourceId: DEMO_IDS.hosts.acme,
      idempotencyKey: "idem-host-sec-01",
      lockKey,
      steps: [{ key: "nft_check", label: "Verify nftables posture" }],
    });

    await updateOperationStepTransactional(
      client.db,
      enqueued.operation.id,
      "nft_check",
      "running",
    );

    // Transition to 'processing' with an already-expired lease
    await transitionOperation(client.db, enqueued.operation.id, "processing", {
      leaseExpiresAt: pastTime,
    });

    const markedUnknown = await markExpiredOperationsUnknownTransactional(client.db, new Date());
    expect(markedUnknown.map((o) => o.id)).toContain(enqueued.operation.id);

    const unknownOp = markedUnknown.find((o) => o.id === enqueued.operation.id)!;
    expect(unknownOp.status).toBe("unknown");
    expect(unknownOp.lockKey).toBe(lockKey);

    // CRITICAL (TH-08): While in 'unknown', lockKey MUST remain locked against concurrent mutations!
    await expect(
      enqueueOperationTransactional(client.db, {
        organizationId: DEMO_IDS.organizations.acme,
        kind: "host.maintenance",
        resourceType: "host",
        resourceId: DEMO_IDS.hosts.acme,
        idempotencyKey: "idem-host-maint-blocked",
        lockKey,
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });

    // Break-glass unlock without reason MUST be rejected
    await expect(
      unlockOperationBreakGlassTransactional(client.db, {
        operationId: enqueued.operation.id,
        reason: "   ",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    // Break-glass unlock transitions 'unknown' -> 'failed' (OPERATION_INTERRUPTED) and writes system audit
    const unlocked = await unlockOperationBreakGlassTransactional(client.db, {
      operationId: enqueued.operation.id,
      reason: "Verified via SSH that nftables command did not apply before power loss",
      actorId: DEMO_IDS.users.infra,
    });

    expect(unlocked.operation.status).toBe("failed");
    expect(unlocked.operation.errorCode).toBe("OPERATION_INTERRUPTED");
    expect(unlocked.auditEvent.actorType).toBe("system");
    expect(unlocked.auditEvent.action).toBe("breakglass.operation.unlock");
    expect(unlocked.auditEvent.details).toMatchObject({
      reason: "Verified via SSH that nftables command did not apply before power loss",
      lockKey,
    });

    // Now lockKey is released for new operations!
    const afterUnlock = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "host.maintenance",
      resourceType: "host",
      resourceId: DEMO_IDS.hosts.acme,
      idempotencyKey: "idem-host-maint-after-unlock",
      lockKey,
    });
    expect(afterUnlock.operation.status).toBe("queued");
    await transitionOperation(client.db, afterUnlock.operation.id, "cancelled");
  });

  it("6. records daemon heartbeats and executes observe-only drift reconciliation without mutating desiredStatus or containers (AC-F2-08)", async () => {
    // Heartbeats upsert & list
    const hb1 = await upsertHostAgentHeartbeat(client.db, {
      hostId: DEMO_IDS.hosts.acme,
      component: "docker_executor",
      status: "online",
      version: "0.2.0",
      telemetrySnapshot: { managedContainers: 3 },
    });
    expect(hb1.status).toBe("online");

    const hbUpdated = await upsertHostAgentHeartbeat(client.db, {
      hostId: DEMO_IDS.hosts.acme,
      component: "docker_executor",
      status: "degraded",
      version: "0.2.1",
      telemetrySnapshot: { managedContainers: 3, warning: "high load" },
    });
    expect(hbUpdated.status).toBe("degraded");
    expect(hbUpdated.version).toBe("0.2.1");

    const heartbeats = await listHostAgentHeartbeats(client.db, DEMO_IDS.hosts.acme);
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]?.component).toBe("docker_executor");

    // Observe-only drift reconciliation on svc_beta_portal_node
    const [svcBefore] = await client.db
      .select()
      .from(serviceInstances)
      .where(eq(serviceInstances.id, DEMO_IDS.services.betaPortalNode));
    const [rev] = await client.db
      .select()
      .from(stackRevisions)
      .where(eq(stackRevisions.id, svcBefore!.currentRevisionId!));
    const [dockBefore] = await client.db
      .select()
      .from(dockerResources)
      .where(eq(dockerResources.serviceInstanceId, DEMO_IDS.services.betaPortalNode));

    // Step A: In-sync observation -> no drift audit emitted
    const syncRes = await recordObservedStateReconciliationTransactional(client.db, {
      serviceInstanceId: DEMO_IDS.services.betaPortalNode,
      observedStatus: "running",
      observedRevisionHash: rev!.specHash,
      outOfBandModified: false,
    });
    expect(syncRes.drift.driftStatus).toBe("in_sync");
    expect(syncRes.newlyDrifted).toBe(false);
    expect(syncRes.auditEvent).toBeNull();

    // Step B: Out-of-band container modification (manual docker change) -> marks 'drifted' + writes system audit
    const driftRes = await recordObservedStateReconciliationTransactional(client.db, {
      serviceInstanceId: DEMO_IDS.services.betaPortalNode,
      observedStatus: "running",
      observedRevisionHash: "0".repeat(64),
      outOfBandModified: true,
      rawState: { manualImageTag: "node:latest", apiKey: "should-be-redacted" },
    });
    expect(driftRes.drift.driftStatus).toBe("drifted");
    expect(driftRes.newlyDrifted).toBe(true);
    expect(driftRes.auditEvent).not.toBeNull();
    expect(driftRes.auditEvent?.actorType).toBe("system");
    expect(driftRes.auditEvent?.action).toBe("service.drift.detected");
    expect((driftRes.observedState.rawState as Record<string, unknown>).apiKey).toBe("[REDACTED]");

    // Step C: Subsequent poll while still drifted does NOT spam duplicate audit_events
    const repeatDriftRes = await recordObservedStateReconciliationTransactional(client.db, {
      serviceInstanceId: DEMO_IDS.services.betaPortalNode,
      observedStatus: "running",
      observedRevisionHash: "0".repeat(64),
      outOfBandModified: true,
    });
    expect(repeatDriftRes.drift.driftStatus).toBe("drifted");
    expect(repeatDriftRes.newlyDrifted).toBe(false);
    expect(repeatDriftRes.auditEvent).toBeNull();

    // Verify desiredStatus and dockerResource were NEVER mutated by observe-only reconciler!
    const [svcAfter] = await client.db
      .select()
      .from(serviceInstances)
      .where(eq(serviceInstances.id, DEMO_IDS.services.betaPortalNode));
    const [dockAfter] = await client.db
      .select()
      .from(dockerResources)
      .where(eq(dockerResources.serviceInstanceId, DEMO_IDS.services.betaPortalNode));

    expect(svcAfter?.desiredStatus).toBe(svcBefore?.desiredStatus);
    expect(svcAfter?.currentRevisionId).toBe(svcBefore?.currentRevisionId);
    expect(dockAfter?.internalDockerRef).toBe(dockBefore?.internalDockerRef);

    // Verify audit event persisted in audit_events
    const allAudits = await client.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, DEMO_IDS.services.betaPortalNode));
    expect(allAudits.some((a) => a.action === "service.drift.detected")).toBe(true);
  });
});
