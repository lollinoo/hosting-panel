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
  getSiteWordpressState,
  saveSiteWordpressLastImport,
  listEncryptedSecretsMetadata,
  listHostAgentHeartbeats,
  listUnsettledOperations,
  markExpiredOperationsUnknownTransactional,
  operations,
  outboxEvents,
  recordObservedStateReconciliationTransactional,
  resolveDecryptedSecretRefs,
  saveSiteWordpressLastUpdate,
  saveSiteWordpressState,
  schemaMigrations,
  seedPhase1Dataset,
  sql,
  serviceInstances,
  siteBackups,
  inArray,
  sites,
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
      "0005_allow_revision_cascade_delete.sql",
      "0006_domains_dns_tls.sql",
      "0007_mail_relay.sql",
      "0008_site_sftp_users.sql",
      "0009_backups.sql",
      "0010_backup_restore.sql",
      "0011_panel_backup.sql",
      "0012_wordpress_tools.sql",
      "0013_wordpress_import.sql",
      "0014_password_reset_tokens.sql",
      "0015_operations_audit_indexes.sql",
      "0016_admin_terminal_sessions.sql",
      "0017_m5d_firewall.sql",
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
      "0005_allow_revision_cascade_delete.sql",
      "0006_domains_dns_tls.sql",
      "0007_mail_relay.sql",
      "0008_site_sftp_users.sql",
      "0009_backups.sql",
      "0010_backup_restore.sql",
      "0011_panel_backup.sql",
      "0012_wordpress_tools.sql",
      "0013_wordpress_import.sql",
      "0014_password_reset_tokens.sql",
      "0015_operations_audit_indexes.sql",
      "0016_admin_terminal_sessions.sql",
      "0017_m5d_firewall.sql",
    ]);

    const firstTimestamps = firstRows.map((r) => r.appliedAt.getTime());

    // Running migrate() again must NOT re-execute or overwrite applied_at rows
    const appliedAgain = await client.migrate();
    expect(appliedAgain).toEqual([
      "0001_phase1_docker_native.sql",
      "0002_phase2_runtime_and_secrets.sql",
      "0003_production_accounts.sql",
      "0004_sites_and_databases.sql",
      "0005_allow_revision_cascade_delete.sql",
      "0006_domains_dns_tls.sql",
      "0007_mail_relay.sql",
      "0008_site_sftp_users.sql",
      "0009_backups.sql",
      "0010_backup_restore.sql",
      "0011_panel_backup.sql",
      "0012_wordpress_tools.sql",
      "0013_wordpress_import.sql",
      "0014_password_reset_tokens.sql",
      "0015_operations_audit_indexes.sql",
      "0016_admin_terminal_sessions.sql",
      "0017_m5d_firewall.sql",
    ]);

    const secondRows = await client.db.select().from(schemaMigrations);
    expect(secondRows.map((r) => r.appliedAt.getTime())).toEqual(firstTimestamps);
  });

  it("1c. 0017 refuses an unknown firewall family and a second row with the same cidr", async () => {
    await expect(
      client.db.execute(sql`INSERT INTO firewall_blocks (id, family, cidr) VALUES ('fwb_x1', 'ipv5', '192.0.2.0/24')`),
    ).rejects.toThrow();
    await client.db.execute(sql`INSERT INTO firewall_blocks (id, family, cidr) VALUES ('fwb_x2', 'ipv4', '198.51.100.0/24')`);
    await expect(
      client.db.execute(sql`INSERT INTO firewall_blocks (id, family, cidr) VALUES ('fwb_x3', 'ipv4', '198.51.100.0/24')`),
    ).rejects.toThrow();
    await client.db.execute(sql`DELETE FROM firewall_blocks`);
  });

  it("1b. 0011 adds the panel copy outcome columns and refuses an unknown status", async () => {
    const cols = await client.db.execute(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'backup_settings' AND column_name LIKE 'last_panel_backup%' ORDER BY column_name`,
    );
    expect(cols.rows.map((r) => (r as { column_name: string }).column_name)).toEqual([
      "last_panel_backup_at",
      "last_panel_backup_problem",
      "last_panel_backup_status",
    ]);
    const check = await client.db.execute(
      sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'backup_settings'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%last_panel_backup_status%'`,
    );
    expect(String((check.rows[0] as { def: string }).def)).toMatch(/succeeded.*failed/);
  });

  it("1c. 0012 accepts pre_update copies and keeps one WordPress state row per site", async () => {
    const db = client.db;
    await db.insert(siteBackups).values({ id: "bk_0012_pre", siteId: DEMO_IDS.sites.acmeShop, kind: "pre_update", status: "running" });
    await expect(
      db.execute(sql`INSERT INTO site_backups (id, site_id, kind, status) VALUES ('bk_0012_bad', 'x', 'other', 'running')`),
    ).rejects.toThrow();

    const acme = { organizationId: DEMO_IDS.organizations.acme, siteId: "site_0012_wp" };
    await db.insert(sites).values({ id: acme.siteId, organizationId: acme.organizationId, hostAllocationId: DEMO_IDS.allocations.acme, name: "WP", slug: "wp-0012" });
    expect(await getSiteWordpressState(db, acme)).toBeNull();

    await saveSiteWordpressState(db, { ...acme, state: { v: 1 } });
    await saveSiteWordpressState(db, { ...acme, state: { v: 2 } });
    expect(await getSiteWordpressState(db, acme)).toEqual({ state: { v: 2 }, lastUpdate: null, lastImport: null });
    await saveSiteWordpressLastUpdate(db, { ...acme, lastUpdate: { u: 1 } });
    expect(await getSiteWordpressState(db, acme)).toEqual({ state: { v: 2 }, lastUpdate: { u: 1 }, lastImport: null });
    await saveSiteWordpressState(db, { ...acme, state: { v: 3 } });
    expect(await getSiteWordpressState(db, acme)).toEqual({ state: { v: 3 }, lastUpdate: { u: 1 }, lastImport: null });

    expect(await getSiteWordpressState(db, { ...acme, organizationId: DEMO_IDS.organizations.beta })).toBeNull();

    // 0013: the last import is stored and replaced without touching state and last update.
    await saveSiteWordpressLastImport(db, { ...acme, lastImport: { i: 1 } });
    await saveSiteWordpressLastImport(db, { ...acme, lastImport: { i: 2 } });
    expect(await getSiteWordpressState(db, acme)).toEqual({ state: { v: 3 }, lastUpdate: { u: 1 }, lastImport: { i: 2 } });
    await saveSiteWordpressLastImport(db, { ...acme, organizationId: DEMO_IDS.organizations.beta, lastImport: { i: 3 } });
    expect((await getSiteWordpressState(db, acme))?.lastImport).toEqual({ i: 2 });
    expect(await getSiteWordpressState(db, { ...acme, organizationId: DEMO_IDS.organizations.beta })).toBeNull();

    await db.delete(sites).where(eq(sites.id, acme.siteId));
    expect((await db.execute(sql`SELECT count(*)::int AS n FROM site_wordpress_state`)).rows[0]).toEqual({ n: 0 });
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

  it("7. claimPendingOutboxEvents filters by operation kind without claiming other lanes", async () => {
    const fileKinds = ["site.files.archive", "site.files.extract"] as const;

    const opArchive = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "site.files.archive",
      resourceType: "site",
      resourceId: DEMO_IDS.sites.acmeShop,
      idempotencyKey: "idem-claim-filter-arch-1",
      lockKey: "site:claim-filter-1",
      outboxPayload: { op: "archive", paths: ["index.php"], to: "out.zip" },
    });
    const opExtract = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "site.files.extract",
      resourceType: "site",
      resourceId: DEMO_IDS.sites.acmeBlog,
      idempotencyKey: "idem-claim-filter-ext-1",
      lockKey: "site:claim-filter-2",
      outboxPayload: { op: "extract", path: "out.zip", to: "dest" },
    });
    const opMain = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.beta,
      kind: "site.provision",
      resourceType: "site",
      resourceId: DEMO_IDS.sites.betaPortal,
      idempotencyKey: "idem-claim-filter-main-1",
      lockKey: "site:claim-filter-3",
    });

    // includeKinds claims only archive/extract and leaves site.provision pending
    const fileClaimed = await claimPendingOutboxEvents(client.db, 10, 60_000, {
      includeKinds: fileKinds,
    });
    expect(fileClaimed.map((e) => e.id)).toEqual([
      opArchive.outbox!.id,
      opExtract.outbox!.id,
    ]);
    const [mainPending] = await client.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, opMain.outbox!.id));
    expect(mainPending?.status).toBe("pending");

    // excludeKinds now claims the remaining site.provision event (and any earlier non-file rows)
    const mainClaimed = await claimPendingOutboxEvents(client.db, 50, 60_000, {
      excludeKinds: fileKinds,
    });
    expect(mainClaimed.map((e) => e.id)).toContain(opMain.outbox!.id);
    expect(mainClaimed.map((e) => e.id)).not.toContain(opArchive.outbox!.id);
    expect(mainClaimed.map((e) => e.id)).not.toContain(opExtract.outbox!.id);

    // Reverse order: excludeKinds claims main work first and leaves file jobs pending
    const opArchive2 = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "site.files.archive",
      resourceType: "site",
      resourceId: DEMO_IDS.sites.acmeShop,
      idempotencyKey: "idem-claim-filter-arch-2",
      lockKey: "site:claim-filter-4",
      outboxPayload: { op: "archive", paths: ["index.php"], to: "out2.zip" },
    });
    const opDomains2 = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.beta,
      kind: "site.domains",
      resourceType: "site",
      resourceId: DEMO_IDS.sites.betaPortal,
      idempotencyKey: "idem-claim-filter-dom-2",
      lockKey: "site:claim-filter-5",
    });

    const mainFirst = await claimPendingOutboxEvents(client.db, 50, 60_000, {
      excludeKinds: fileKinds,
    });
    expect(mainFirst.map((e) => e.id)).toEqual([opDomains2.outbox!.id]);
    const [arch2Pending] = await client.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, opArchive2.outbox!.id));
    expect(arch2Pending?.status).toBe("pending");

    const fileAfter = await claimPendingOutboxEvents(client.db, 10, 60_000, {
      includeKinds: fileKinds,
    });
    expect(fileAfter.map((e) => e.id)).toEqual([opArchive2.outbox!.id]);

    for (const enq of [opArchive, opExtract, opMain, opArchive2, opDomains2]) {
      await completeOutboxEvent(client.db, enq.outbox!.id);
      await transitionOperation(client.db, enq.operation.id, "cancelled");
    }
  });

  it("8. hides the panel_containers and panel_certificate rows from the heartbeat list", async () => {
    for (const component of ["panel_containers", "panel_certificate"] as const) {
      await upsertHostAgentHeartbeat(client.db, {
        hostId: DEMO_IDS.hosts.acme,
        component,
        status: "online",
        version: "1",
        telemetrySnapshot: {},
      });
    }
    const daemons = ["docker_executor", "host_agent"];
    for (const rows of [
      await listHostAgentHeartbeats(client.db, DEMO_IDS.hosts.acme),
      await listHostAgentHeartbeats(client.db),
    ]) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => daemons.includes(row.component))).toBe(true);
    }
  });

  it("9. sets notRunningSince at the first observation that is not running, keeps it, drops it at running", async () => {
    const first = new Date("2026-11-16T10:00:00.000Z");
    const record = (observedStatus: string, observedAt: Date) =>
      recordObservedStateReconciliationTransactional(client.db, {
        serviceInstanceId: DEMO_IDS.services.acmeBlogWp,
        observedStatus,
        rawState: { restartCount: 2 },
        observedAt,
      });
    const stopped = await record("stopped", first);
    expect(stopped.observedState.rawState).toEqual({ restartCount: 2, notRunningSince: first.toISOString() });
    const degraded = await record("degraded", new Date(first.getTime() + 60_000));
    expect(degraded.observedState.rawState).toEqual({ restartCount: 2, notRunningSince: first.toISOString() });
    const running = await record("running", new Date(first.getTime() + 120_000));
    expect(running.observedState.rawState).toEqual({ restartCount: 2 });
  });

  it("10. remembers a restart count rise for two minutes of look time, forgets it on a lower count", async () => {
    const t0 = new Date("2026-11-16T10:00:00.000Z");
    const record = (restartCount: number, seconds: number) =>
      recordObservedStateReconciliationTransactional(client.db, {
        serviceInstanceId: DEMO_IDS.services.acmeBlogWp,
        observedStatus: "running",
        rawState: { restartCount },
        observedAt: new Date(t0.getTime() + seconds * 1000),
      });
    await record(0, 0);
    const rise = new Date(t0.getTime() + 15_000).toISOString();
    expect((await record(1, 15)).observedState.rawState).toEqual({ restartCount: 1, notRunningSince: rise, lastRestartAt: rise });
    expect((await record(1, 134)).observedState.rawState).toEqual({ restartCount: 1, notRunningSince: rise, lastRestartAt: rise });
    expect((await record(1, 135)).observedState.rawState).toEqual({ restartCount: 1 });
    await record(2, 150);
    expect((await record(0, 165)).observedState.rawState).toEqual({ restartCount: 0 });
  });

  it("10b. forgets a remembered rise when the container is seen missing (R191 1.3)", async () => {
    const t0 = new Date("2026-11-16T11:00:00.000Z");
    const record = (observedStatus: string, seconds: number, rawState: Record<string, unknown>) =>
      recordObservedStateReconciliationTransactional(client.db, {
        serviceInstanceId: DEMO_IDS.services.acmeBlogWp,
        observedStatus,
        rawState,
        observedAt: new Date(t0.getTime() + seconds * 1000),
      });
    await record("running", 0, { restartCount: 0 });
    await record("running", 15, { restartCount: 1 });
    await record("missing", 30, {});
    expect((await record("running", 45, { restartCount: 0 })).observedState.rawState).toEqual({ restartCount: 0 });
  });

  const makeOperation = async (patch: Partial<typeof operations.$inferInsert>) => {
    const enq = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "site.deploy",
      resourceType: "site",
      resourceId: DEMO_IDS.sites.acmeShop,
    });
    await client.db.update(operations).set(patch).where(eq(operations.id, enq.operation.id));
    return enq.operation.id;
  };
  const statusesOf = async (ids: string[]) =>
    Object.fromEntries(
      (await client.db.select({ id: operations.id, status: operations.status }).from(operations).where(inArray(operations.id, ids)))
        .map((row) => [row.id, row.status]),
    );

  it("10. sweeps reconciling with an expired or a null lease to unknown and leaves a live lease alone", async () => {
    const now = new Date();
    const expired = await makeOperation({ status: "reconciling", leaseExpiresAt: new Date(now.getTime() - 1_000) });
    const nullLease = await makeOperation({ status: "reconciling", leaseExpiresAt: null });
    const live = await makeOperation({ status: "reconciling", leaseExpiresAt: new Date(now.getTime() + 60_000) });
    await markExpiredOperationsUnknownTransactional(client.db, now);
    expect(await statusesOf([expired, nullLease, live])).toEqual({
      [expired]: "unknown",
      [nullLease]: "unknown",
      [live]: "reconciling",
    });
  });

  it("11. lists unknown operations after 15 minutes and stuck ones 5 minutes after the lease, with the site name", async () => {
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const unknownOld = await makeOperation({ status: "unknown", updatedAt: ago(15 * 60_000 + 1_000) });
    const unknownNew = await makeOperation({ status: "unknown", updatedAt: ago(14 * 60_000) });
    const stuckLease = await makeOperation({ status: "processing", leaseExpiresAt: ago(5 * 60_000 + 1_000), updatedAt: ago(20 * 60_000) });
    const liveLease = await makeOperation({ status: "processing", leaseExpiresAt: ago(4 * 60_000), updatedAt: ago(20 * 60_000) });
    const stuckNoLease = await makeOperation({ status: "reconciling", leaseExpiresAt: null, updatedAt: ago(6 * 60_000) });
    const [site] = await client.db.select({ name: sites.name }).from(sites).where(eq(sites.id, DEMO_IDS.sites.acmeShop));
    const mine = [unknownOld, unknownNew, stuckLease, liveLease, stuckNoLease];
    const rows = (await listUnsettledOperations(client.db, now)).filter((row) => mine.includes(row.operationId));
    const expected = (operationId: string, status: string, alert: string, since: Date) => ({
      operationId,
      kind: "site.deploy",
      status,
      alert,
      siteId: DEMO_IDS.sites.acmeShop,
      siteName: site!.name,
      since,
    });
    expect(rows).toEqual([
      expected(unknownOld, "unknown", "operation_unknown", ago(15 * 60_000 + 1_000)),
      expected(stuckNoLease, "reconciling", "operation_stuck", ago(6 * 60_000)),
      expected(stuckLease, "processing", "operation_stuck", ago(5 * 60_000 + 1_000)),
    ]);
  });
});
