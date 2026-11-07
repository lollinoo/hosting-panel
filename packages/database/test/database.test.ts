import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  allocateHostTransactional,
  appendStackRevisionTransactional,
  auditEvents,
  claimPendingOutboxEvents,
  commitQuotaReservationTransactional,
  createDatabaseClient,
  createServiceWithRevisionTransactional,
  createSiteTransactional,
  dockerResources,
  domains,
  enqueueOperationTransactional,
  eq,
  hosts,
  organizations,
  rebindDockerResourceTransactional,
  releaseQuotaReservationTransactional,
  reserveQuotaTransactional,
  resolveMigrationsDirectory,
  resourceQuotas,
  seedPhase1Dataset,
  serviceInstances,
  serviceTemplates,
  sites,
  stackRevisions,
  transitionOperation,
  type DatabaseClient,
  DEMO_IDS,
} from "../src/index.js";

describe("@hosting-panel/database — Phase 1 Docker-Native Architecture & Invariants", () => {
  let client: DatabaseClient;

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    const applied = await client.migrate();
    expect(applied).toContain("0001_phase1_docker_native.sql");
    await seedPhase1Dataset(client.db);
  });

  afterAll(async () => {
    await client.close();
  });

  it("1. runs SQL baseline migrations and seeds Phase 1 demo dataset idempotently", async () => {
    expect(resolveMigrationsDirectory()).toBeTruthy();

    // Second migration + seed pass must be completely idempotent
    const appliedAgain = await client.migrate();
    expect(appliedAgain).toContain("0001_phase1_docker_native.sql");
    await seedPhase1Dataset(client.db);

    const allHosts = await client.db.select().from(hosts);
    expect(allHosts.length).toBeGreaterThanOrEqual(4);

    const allOrgs = await client.db.select().from(organizations);
    expect(allOrgs).toHaveLength(3);

    const gammaOrg = allOrgs.find((o) => o.id === DEMO_IDS.organizations.gamma);
    expect(gammaOrg?.status).toBe("suspended");

    const allSites = await client.db.select().from(sites);
    expect(allSites.length).toBeGreaterThanOrEqual(4);

    const allTemplates = await client.db.select().from(serviceTemplates);
    expect(allTemplates).toHaveLength(4);
  });

  it("2. enforces PostgreSQL SQL composite ownership foreign keys across tenant boundaries", async () => {
    // Attempting to create a site using an allocation from another org must fail composite FK
    // fk_sites_host_allocation_org: (host_allocation_id, organization_id) -> host_allocations(id, organization_id)
    await expect(
      client.db.insert(sites).values({
        id: "site_illegal_composite",
        organizationId: DEMO_IDS.organizations.acme,
        hostAllocationId: DEMO_IDS.allocations.beta, // Beta's allocation with Acme's org!
        name: "Illegal Site",
        slug: "illegal-site",
        status: "ready",
      }),
    ).rejects.toThrow();

    // Attempting to create a service in Acme org pointing to a Beta site must fail composite FK
    await expect(
      client.db.insert(serviceInstances).values({
        id: "svc_illegal_composite",
        siteId: DEMO_IDS.sites.betaPortal, // Beta's site
        organizationId: DEMO_IDS.organizations.acme, // Acme's org
        serviceTemplateId: DEMO_IDS.templates.wordpress,
        name: "Cross Tenant Service",
        desiredStatus: "running",
      }),
    ).rejects.toThrow();

    // Attempting to create a domain in Acme org pointing to Beta site must fail composite FK
    await expect(
      client.db.insert(domains).values({
        id: "dom_illegal_composite",
        siteId: DEMO_IDS.sites.betaPortal,
        organizationId: DEMO_IDS.organizations.acme,
        hostname: "cross-tenant.acme.it",
      }),
    ).rejects.toThrow();
  });

  it("3. enforces PostgreSQL immutability triggers on BOTH audit_events AND stack_revisions", async () => {
    const [audit] = await client.db.select().from(auditEvents).limit(1);
    expect(audit).toBeDefined();

    // Attempting to UPDATE an audit_event must be rejected by trigger prevent_audit_events_mutation
    await expect(
      client.db
        .update(auditEvents)
        .set({ action: "tampered_action" })
        .where(eq(auditEvents.id, audit!.id)),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/audit_events is append-only and immutable/),
      }),
    });

    // Attempting to DELETE an audit_event must be rejected by trigger
    await expect(
      client.db.delete(auditEvents).where(eq(auditEvents.id, audit!.id)),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/audit_events is append-only and immutable/),
      }),
    });

    const [rev] = await client.db.select().from(stackRevisions).limit(1);
    expect(rev).toBeDefined();

    // Attempting to UPDATE a stack_revision must be rejected by trigger prevent_stack_revisions_mutation
    await expect(
      client.db
        .update(stackRevisions)
        .set({ specHash: "tampered_hash_0000000000000000000000000000000000000000000000000000" })
        .where(eq(stackRevisions.id, rev!.id)),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/stack_revisions is append-only and immutable/),
      }),
    });

    // Attempting to DELETE a stack_revision must be rejected by trigger
    await expect(
      client.db.delete(stackRevisions).where(eq(stackRevisions.id, rev!.id)),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/stack_revisions is append-only and immutable/),
      }),
    });
  });

  it("4. allocateHostTransactional enforces dedicated host exclusivity under concurrency (AC-F1-01)", async () => {
    // 1. Allocating hst_ded_free to org_acme succeeds
    const { allocation, quota } = await allocateHostTransactional(client.db, {
      hostId: DEMO_IDS.hosts.free,
      organizationId: DEMO_IDS.organizations.acme,
      hostingMode: "dedicated",
      actorId: DEMO_IDS.users.infra,
    });

    expect(allocation.hostId).toBe(DEMO_IDS.hosts.free);
    expect(allocation.organizationId).toBe(DEMO_IDS.organizations.acme);
    expect(quota.organizationId).toBe(DEMO_IDS.organizations.acme);

    // 2. Additional allocation on the SAME host for the SAME org succeeds
    const sameOrgResult = await allocateHostTransactional(client.db, {
      hostId: DEMO_IDS.hosts.free,
      organizationId: DEMO_IDS.organizations.acme,
      hostingMode: "dedicated",
      actorId: DEMO_IDS.users.infra,
    });
    expect(sameOrgResult.allocation.id).toBeDefined();

    // 3. Attempting to allocate occupied dedicated host to a DIFFERENT org is strictly blocked (AC-F1-01)
    await expect(
      allocateHostTransactional(client.db, {
        hostId: DEMO_IDS.hosts.free,
        organizationId: DEMO_IDS.organizations.beta,
        hostingMode: "dedicated",
        actorId: DEMO_IDS.users.infra,
      }),
    ).rejects.toMatchObject({
      code: "DEDICATED_HOST_OCCUPIED",
    });
  });

  it("5. reserveQuotaTransactional enforces concurrency limits & idempotency (AC-F1-07)", async () => {
    const quotaRows = await client.db
      .select()
      .from(resourceQuotas)
      .where(eq(resourceQuotas.organizationId, DEMO_IDS.organizations.beta));

    const quota = quotaRows[0]!;

    // Beta quota: maxSites = 5, usedSites = 1 -> available is 4
    // Reservation 1: 3 sites
    const res1 = await reserveQuotaTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.beta,
      resourceQuotaId: quota.id,
      idempotencyKey: "idem_beta_01",
      demand: { sites: 3 },
    });
    expect(res1.reservation.status).toBe("pending");
    expect(res1.idempotentReplay).toBe(false);

    // Replay with SAME idempotency key returns existing without double booking
    const replay = await reserveQuotaTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.beta,
      resourceQuotaId: quota.id,
      idempotencyKey: "idem_beta_01",
      demand: { sites: 3 },
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.reservation.id).toBe(res1.reservation.id);

    // Reservation 2: 2 sites -> used (1) + pending (3) + requested (2) = 6 > 5 -> EXCEEDED! (AC-F1-07)
    await expect(
      reserveQuotaTransactional(client.db, {
        organizationId: DEMO_IDS.organizations.beta,
        resourceQuotaId: quota.id,
        idempotencyKey: "idem_beta_02",
        demand: { sites: 2 },
      }),
    ).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
    });

    // Commit res1 -> updates usedSites from 1 to 4
    const commitRes = await commitQuotaReservationTransactional(client.db, res1.reservation.id);
    expect(commitRes.reservation.status).toBe("committed");
    expect(commitRes.quota!.usedSites).toBe(4);

    // Release res1 -> reverts usedSites back to 1
    const releaseRes = await releaseQuotaReservationTransactional(client.db, res1.reservation.id);
    expect(releaseRes.reservation.status).toBe("released");

    const [revertedQuota] = await client.db
      .select()
      .from(resourceQuotas)
      .where(eq(resourceQuotas.id, quota.id));
    expect(revertedQuota?.usedSites).toBe(1);
  });

  it("6. createSiteTransactional, createServiceWithRevisionTransactional & appendStackRevisionTransactional", async () => {
    // 1. Create site with domain
    const { site, domain } = await createSiteTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      hostAllocationId: DEMO_IDS.allocations.acme,
      name: "Acme Landing Page",
      slug: "acme-landing",
      initialDomain: "landing.acme.it",
      actorId: DEMO_IDS.users.elena,
    });
    expect(site.id).toBeDefined();
    expect(domain?.hostname).toBe("landing.acme.it");

    // 2. Create service with revision #1
    const { service, revision, observedState, dockerResource } =
      await createServiceWithRevisionTransactional(client.db, {
        siteId: site.id,
        organizationId: DEMO_IDS.organizations.acme,
        serviceTemplateId: DEMO_IDS.templates.nodejs,
        name: "Landing API",
        desiredStatus: "running",
        configuration: { NODE_ENV: "production", PORT: 3000 },
        secretRefs: { JWT_SECRET: "vault://landing/jwt" },
        resourceLimits: { cpuMilli: 500, memoryBytes: "536870912" },
        actorId: DEMO_IDS.users.elena,
      });

    expect(service.currentRevisionId).toBe(revision.id);
    expect(revision.revisionNumber).toBe(1);
    expect(observedState.observedStatus).toBe("running");
    expect(dockerResource.internalDockerRef).toBe(`cnt_${service.id}_1`);

    // 3. Append revision #2
    const rev2 = await appendStackRevisionTransactional(client.db, {
      serviceInstanceId: service.id,
      organizationId: DEMO_IDS.organizations.acme,
      declarativeConfig: { NODE_ENV: "production", PORT: 3001 },
      secretRefs: { JWT_SECRET: "vault://landing/jwt_v2" },
      authorId: DEMO_IDS.users.elena,
    });

    expect(rev2.revisionNumber).toBe(2);

    const [updatedService] = await client.db
      .select()
      .from(serviceInstances)
      .where(eq(serviceInstances.id, service.id));
    expect(updatedService?.currentRevisionId).toBe(rev2.id);
  });

  it("7. rebindDockerResourceTransactional replaces internal Docker ref while preserving Site and Service IDs (AC-F1-05)", async () => {
    const rebindResult = await rebindDockerResourceTransactional(
      client.db,
      DEMO_IDS.services.acmeShopWp,
      "cnt_acme_shop_wp_recreated_99",
      "running",
    );

    expect(rebindResult.siteIdPreserved).toBe(true);
    expect(rebindResult.serviceInstanceIdPreserved).toBe(true);
    expect(rebindResult.updatedResource.serviceInstanceId).toBe(DEMO_IDS.services.acmeShopWp);
    expect(rebindResult.updatedResource.internalDockerRef).toBe(
      "cnt_acme_shop_wp_recreated_99",
    );

    const [dock] = await client.db
      .select()
      .from(dockerResources)
      .where(eq(dockerResources.serviceInstanceId, DEMO_IDS.services.acmeShopWp));
    expect(dock?.internalDockerRef).toBe("cnt_acme_shop_wp_recreated_99");
  });

  it("8. enqueueOperationTransactional, claimPendingOutboxEvents and transitionOperation", async () => {
    const { operation, steps, outbox } = await enqueueOperationTransactional(client.db, {
      organizationId: DEMO_IDS.organizations.acme,
      kind: "service.deploy",
      resourceType: "service",
      resourceId: DEMO_IDS.services.acmeShopWp,
      requestedByUserId: DEMO_IDS.users.elena,
      steps: [
        { key: "validate", label: "Spec validation" },
        { key: "reconcile", label: "Container reconcile" },
      ],
    });

    expect(operation.status).toBe("queued");
    expect(steps).toHaveLength(2);
    expect(outbox.status).toBe("pending");

    // Transition queued -> processing -> reconciling -> succeeded
    const op1 = await transitionOperation(client.db, operation.id, "processing");
    expect(op1.status).toBe("processing");

    const op2 = await transitionOperation(client.db, operation.id, "reconciling");
    expect(op2.status).toBe("reconciling");

    const op3 = await transitionOperation(client.db, operation.id, "succeeded");
    expect(op3.status).toBe("succeeded");
    expect(op3.completedAt).toBeDefined();

    // Invalid transition from terminal status should throw
    await expect(transitionOperation(client.db, operation.id, "reconciling")).rejects.toThrow(
      /Invalid operation status transition/,
    );

    // Claim pending outbox
    const claimed = await claimPendingOutboxEvents(client.db);
    expect(claimed.length).toBeGreaterThan(0);
  });
});
