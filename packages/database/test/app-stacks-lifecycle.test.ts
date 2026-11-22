import { createHash } from "node:crypto";
import {
  APP_STACK_ENQUEUE_TRANSITIONS,
  APP_STACK_STEPS_BY_KIND,
  type AppStackOperationKind,
  type AppStackStatus,
} from "@hosting-panel/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addAppStackDomainsTransactional,
  addAppTemplateVersion,
  appStackComponents,
  appStackDeployments,
  appStackDomains,
  appStackParameters,
  appStackRevisions,
  appStacks,
  appStackSecrets,
  appStackVolumes,
  AppStackRepositoryError,
  createAppStackTransactional,
  createAppTemplate,
  createDatabaseClient,
  enqueueAppStackOperationTransactional,
  eq,
  findAppStackAllocation,
  getAppStack,
  getAppStackDeployment,
  getAppStackRevision,
  hostAllocations,
  hosts,
  listAppStackComponents,
  listAppStackDeployments,
  listAppStackParameters,
  listAppStackRevisions,
  listAppStacks,
  listAppStacksByStatus,
  listAppStackVolumes,
  newAppEntityId,
  operations,
  operationSteps,
  organizations,
  platformInstallations,
  recordAppStackComponentHealthTransactional,
  repairOrphanedAppStackStatusesTransactional,
  resourceQuotas,
  setAppStackSecretTransactional,
  setAppStackVolumeStatusTransactional,
  transitionAppStackTransactional,
  updateAppStackDeploymentTransactional,
  updateAppTemplate,
  type AppStackRow,
  type AppStackWriteResult,
  type DatabaseClient,
  type EnqueueAppStackOperationInput,
  type HostingPanelDatabase,
  type NewAppStackRevision,
} from "../src/index.js";

// The life of a stack after its create: enqueue per kind through the transition table, new revisions (components and
// volumes synced, quota charged by the delta), deployment settle, delete finalisation, boot repair and tenant reads.
const orgA = "org_sl_a";
const orgB = "org_sl_b";
const ALLOC: Record<string, string> = { [orgA]: "alloc_sl_a", [orgB]: "alloc_sl_b" };
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
const PARAMETERS = [
  { parameterKey: "title", value: "Hello" },
  { parameterKey: "port", value: 8080 },
];

interface PlanOptions {
  readonly components?: readonly string[];
  readonly volumes?: readonly string[];
  readonly ingress?: readonly { componentKey: string; port: number }[];
  readonly templateVersionId?: string;
  readonly parameters?: NewAppStackRevision["parameters"];
}

function revisionFor(stack: Pick<AppStackRow, "id" | "organizationId" | "templateVersionId">, options: PlanOptions = {}): NewAppStackRevision {
  const componentKeys = options.components ?? ["web", "cache"];
  const volumeKeys = options.volumes ?? ["data"];
  const templateVersionId = options.templateVersionId ?? stack.templateVersionId;
  const revisionId = newAppEntityId("srev");
  const planHash = hex(`${revisionId}:${componentKeys.join(",")}`);
  return {
    revisionId,
    templateVersionId,
    plan: {
      schemaVersion: 1,
      stackId: stack.id,
      organizationId: stack.organizationId,
      hostAllocationId: ALLOC[stack.organizationId]!,
      templateVersionId,
      revisionId,
      planHash,
      components: componentKeys.map((key) => ({ key, resources: { cpuMilli: 250, memoryBytes: "134217728" } })),
      volumes: volumeKeys.map((key) => ({ key })),
      ingress: options.ingress ?? [{ componentKey: componentKeys[0], port: 8080 }],
    },
    planHash,
    componentKeys,
    volumeKeys,
    cpuMilli: 250 * componentKeys.length,
    memoryBytes: 134217728 * componentKeys.length,
    parameters: options.parameters ?? PARAMETERS,
  };
}

describe("@hosting-panel/database — app stacks lifecycle", () => {
  let client: DatabaseClient;
  const db = (): HostingPanelDatabase => client.db;
  let counter = 0;
  let versionId = "";

  async function template(slug: string): Promise<{ templateId: string; versionId: string }> {
    const created = await createAppTemplate(db(), {
      slug,
      name: slug,
      description: null,
      category: "web",
      createdBy: null,
      firstVersion: { source: `source ${slug}`, specVersion: 1, compiledSchema: {}, specHash: hex(slug) },
    });
    await updateAppTemplate(db(), { templateId: created.template.id, enabled: true });
    return { templateId: created.template.id, versionId: created.version.id };
  }

  async function organization(id: string, quota = false) {
    await db().insert(organizations).values({ id, platformInstallationId: "pin_sl", name: id, slug: id.replace(/_/g, "-") });
    ALLOC[id] = `alloc_${id}`;
    await db().insert(hostAllocations).values({ id: ALLOC[id], hostId: "hst_sl", organizationId: id, status: "active" });
    if (quota) {
      await db().insert(resourceQuotas).values({
        id: `rq_${id}`,
        organizationId: id,
        hostAllocationId: ALLOC[id],
        maxSites: 10,
        maxServices: 8,
        maxCpuMilli: 4000,
        maxMemoryBytes: "4000000000",
        maxStorageBytes: "1000000000",
      });
    }
  }

  function create(org = orgA, options: PlanOptions & { draft?: boolean; name?: string } = {}): Promise<AppStackWriteResult> {
    counter += 1;
    const stackId = newAppEntityId("stk");
    const templateVersionId = options.templateVersionId ?? versionId;
    return createAppStackTransactional(db(), {
      stackId,
      organizationId: org,
      hostAllocationId: ALLOC[org]!,
      templateVersionId,
      name: options.name ?? `Stack ${String(counter)}`,
      parameters: PARAMETERS,
      createdBy: null,
      idempotencyKey: `lc-create-${String(counter)}`,
      requestHash: hex(`create ${String(counter)}`),
      deploy: options.draft ? null : revisionFor({ id: stackId, organizationId: org, templateVersionId }, options),
    });
  }

  /** Settles every operation of the stack and stores `status`, as a finished worker would. */
  async function ready(stackId: string, status: AppStackStatus = "running"): Promise<AppStackRow> {
    await db().update(operations).set({ status: "succeeded" }).where(eq(operations.resourceId, stackId));
    const [row] = await db().update(appStacks).set({ status }).where(eq(appStacks.id, stackId)).returning();
    return row!;
  }

  function enqueue(
    stack: AppStackRow,
    kind: AppStackOperationKind,
    over: Partial<EnqueueAppStackOperationInput> & { plan?: PlanOptions } = {},
  ): Promise<AppStackWriteResult> {
    counter += 1;
    const { plan, ...rest } = over;
    const needsRevision = kind === "stack.upgrade" || kind === "stack.rollback" || (kind === "stack.deploy" && stack.status === "draft");
    const revision = rest.revision !== undefined ? rest.revision : needsRevision ? revisionFor(stack, plan) : null;
    return enqueueAppStackOperationTransactional(db(), {
      organizationId: stack.organizationId,
      stackId: stack.id,
      kind,
      requestedByUserId: null,
      idempotencyKey: `lc-${String(counter)}`,
      requestHash: hex(`enqueue ${String(counter)}`),
      revision,
      parameters: revision?.parameters ?? null,
      destroyData: false,
      ...rest,
    });
  }

  const keysOf = async (stackId: string) => ({
    components: (await db().select().from(appStackComponents).where(eq(appStackComponents.stackId, stackId))).map((c) => c.componentKey).sort(),
    volumes: (await db().select().from(appStackVolumes).where(eq(appStackVolumes.stackId, stackId))).map((v) => v.volumeKey).sort(),
    revisions: (await db().select().from(appStackRevisions).where(eq(appStackRevisions.stackId, stackId))).length,
    deployments: (await db().select().from(appStackDeployments).where(eq(appStackDeployments.stackId, stackId))).length,
  });
  const quotaOf = async (id: string) => (await db().select().from(resourceQuotas).where(eq(resourceQuotas.id, id)))[0]!;
  const stackOf = async (id: string) => (await db().select().from(appStacks).where(eq(appStacks.id, id)))[0]!;
  const domain = (stack: AppStackRow, hostname: string, componentKey: string, internalPort: number) =>
    addAppStackDomainsTransactional(db(), {
      organizationId: stack.organizationId,
      stackId: stack.id,
      entries: [{ hostname, componentKey, internalPort }],
    });

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_sl", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_sl",
      platformInstallationId: "pin_sl",
      name: "sl-host",
      hostname: "panel.sl.example",
      ipv4Address: "10.0.0.61",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    for (const org of [orgA, orgB]) {
      await db().insert(organizations).values({ id: org, platformInstallationId: "pin_sl", name: org, slug: org.replace(/_/g, "-") });
      await db().insert(hostAllocations).values({ id: ALLOC[org]!, hostId: "hst_sl", organizationId: org, status: "active" });
    }
    versionId = (await template("sl-alpha")).versionId;
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  it("enqueues every kind from every allowed status: target status, queued deployment, locked operation", async () => {
    for (const [kind, table] of Object.entries(APP_STACK_ENQUEUE_TRANSITIONS) as [AppStackOperationKind, Record<string, AppStackStatus>][]) {
      for (const [from, target] of Object.entries(table) as [AppStackStatus, AppStackStatus][]) {
        const created = await create(orgA, { draft: from === "draft" });
        const stack = from === "draft" ? created.stack : await ready(created.stack.id, from);
        const result = await enqueue(stack, kind);
        expect([kind, from, result.stack.status]).toEqual([kind, from, target]);
        expect(result.idempotentReplay).toBe(false);
        expect(result.operation).toMatchObject({ kind, status: "queued", resourceId: stack.id, lockKey: `stack:${stack.id}` });
        expect(result.deployment).toMatchObject({ operationId: result.operation!.id, status: "queued", revisionId: result.stack.desiredRevisionId });
        const steps = await db().select().from(operationSteps).where(eq(operationSteps.operationId, result.operation!.id));
        expect(steps).toHaveLength(APP_STACK_STEPS_BY_KIND[kind].length);
      }
    }
  });

  it("replays an enqueue by key and hash, and refuses the key with another request", async () => {
    const stack = await ready((await create()).stack.id);
    const input = { idempotencyKey: "lc-replay", requestHash: hex("replay") };
    const first = await enqueue(stack, "stack.restart", input);
    const again = await enqueue(stack, "stack.restart", input);
    expect(again).toMatchObject({ idempotentReplay: true, operation: { id: first.operation!.id }, deployment: { id: first.deployment!.id } });
    expect(again.revision?.id).toBe(first.revision!.id);
    expect((await keysOf(stack.id)).deployments).toBe(2);
    await expect(enqueue(stack, "stack.restart", { ...input, requestHash: hex("other") })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(enqueue(stack, "stack.stop", input)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("refuses a kind the current status does not allow, carrying the status, and writes nothing", async () => {
    const cases: [AppStackStatus, AppStackOperationKind][] = [
      ["running", "stack.start"],
      ["stopped", "stack.stop"],
      ["stopped", "stack.restart"],
      ["deleting", "stack.deploy"],
      ["delete_failed", "stack.upgrade"],
      ["draft", "stack.start"],
    ];
    for (const [status, kind] of cases) {
      const stack = await ready((await create()).stack.id, status);
      const err = await enqueue(stack, kind).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppStackRepositoryError);
      expect(err).toMatchObject({ code: "INVALID_TRANSITION", status });
      expect(await keysOf(stack.id)).toMatchObject({ revisions: 1, deployments: 1 });
      expect((await stackOf(stack.id)).status).toBe(status);
    }
  });

  it("refuses to deploy a draft without a revision", async () => {
    const { stack } = await create(orgA, { draft: true });
    await expect(enqueue(stack, "stack.deploy", { revision: null })).rejects.toMatchObject({ code: "NO_REVISION" });
    expect((await stackOf(stack.id)).status).toBe("draft");
  });

  it("refuses while an operation holds the stack's lock, before any write", async () => {
    const { stack } = await create();
    await expect(enqueue(stack, "stack.stop")).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    const running = { ...stack, status: "running" as const };
    await db().update(appStacks).set({ status: "running" }).where(eq(appStacks.id, stack.id));
    await expect(enqueue(running, "stack.upgrade")).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    expect(await keysOf(stack.id)).toEqual({ components: ["cache", "web"], volumes: ["data"], revisions: 1, deployments: 1 });
  });

  it("upgrade and rollback: revision n+1, components synced, volumes kept, quota charged by the delta, parameters snapshotted", async () => {
    await organization("org_sl_quota", true);
    const t = await template("sl-upgrade");
    const created = await create("org_sl_quota", { templateVersionId: t.versionId, volumes: ["data", "logs"] });
    const firstRevision = created.revision!;
    let stack = await ready(created.stack.id);
    expect(await quotaOf("rq_org_sl_quota")).toMatchObject({ usedServices: 2, usedCpuMilli: 500 });

    const v2 = await addAppTemplateVersion(db(), {
      templateId: t.templateId,
      createdBy: null,
      version: { source: "source v2", specVersion: 1, compiledSchema: {}, specHash: hex("v2") },
    });
    await updateAppTemplate(db(), { templateId: t.templateId, defaultVersionId: v2.version.id });
    const upgraded = await enqueue(stack, "stack.upgrade", {
      plan: {
        templateVersionId: v2.version.id,
        components: ["web", "worker", "queue"],
        volumes: ["data"],
        parameters: [{ parameterKey: "title", value: "Second" }],
      },
    });
    expect(upgraded.revision).toMatchObject({ revisionNumber: 2, templateVersionId: v2.version.id, parameters: [{ key: "title", value: "Second" }] });
    expect(upgraded.stack).toMatchObject({ status: "updating", templateVersionId: v2.version.id, desiredRevisionId: upgraded.revision!.id });
    expect(upgraded.deployment?.revisionId).toBe(upgraded.revision!.id);
    expect(await keysOf(stack.id)).toMatchObject({ components: ["queue", "web", "worker"], volumes: ["data", "logs"], revisions: 2 });
    expect(await quotaOf("rq_org_sl_quota")).toMatchObject({ usedServices: 3, usedCpuMilli: 750, usedMemoryBytes: String(3 * 134217728) });
    const stored = await db().select().from(appStackParameters).where(eq(appStackParameters.stackId, stack.id));
    expect(stored.map((p) => [p.parameterKey, p.publicValue])).toEqual([["title", "Second"]]);

    stack = await ready(stack.id);
    await expect(enqueue(stack, "stack.upgrade", { plan: { templateVersionId: t.versionId } })).rejects.toMatchObject({
      code: "TEMPLATE_UNPUBLISHED",
    });
    const rolledBack = await enqueue(stack, "stack.rollback", {
      plan: { templateVersionId: t.versionId, parameters: firstRevision.parameters.map((p) => ({ parameterKey: p.key, value: p.value })) },
    });
    expect(rolledBack.revision).toMatchObject({ revisionNumber: 3, templateVersionId: t.versionId, parameters: firstRevision.parameters });
    expect(rolledBack.stack.templateVersionId).toBe(t.versionId);
    expect(await keysOf(stack.id)).toMatchObject({ components: ["cache", "web"], volumes: ["data", "logs"], revisions: 3 });
    expect(await quotaOf("rq_org_sl_quota")).toMatchObject({ usedServices: 2, usedCpuMilli: 500 });
    expect((await listAppStackParameters(db(), { organizationId: "org_sl_quota", stackId: stack.id })).map((p) => p.publicValue)).toEqual([
      8080,
      "Hello",
    ]);
    const original = await getAppStackRevision(db(), { organizationId: "org_sl_quota", stackId: stack.id, revisionId: firstRevision.id });
    expect(original?.parameters).toEqual([
      { key: "port", value: 8080 },
      { key: "title", value: "Hello" },
    ]);
  });

  it("refuses a revision of another template's version", async () => {
    const other = await template("sl-other");
    const stack = await ready((await create()).stack.id);
    for (const kind of ["stack.upgrade", "stack.rollback", "stack.deploy"] as const) {
      const revision = revisionFor(stack, { templateVersionId: other.versionId });
      await expect(enqueue(stack, kind, { revision })).rejects.toMatchObject({ code: "TEMPLATE_MISMATCH" });
    }
    expect(await keysOf(stack.id)).toMatchObject({ revisions: 1, deployments: 1 });
  });

  it("refuses COMPONENT_IN_USE when a new plan drops a domain's component or its ingress pair", async () => {
    const ingress = [
      { componentKey: "web", port: 8080 },
      { componentKey: "cache", port: 6379 },
    ];
    const stack = await ready((await create(orgA, { ingress })).stack.id);
    await domain(stack, "web.inuse.example", "web", 8080);
    await domain(stack, "cache.inuse.example", "cache", 6379);
    const plans: PlanOptions[] = [
      { components: ["web"], ingress: [{ componentKey: "web", port: 8080 }] },
      { components: ["web", "cache"], ingress: [{ componentKey: "web", port: 9090 }, { componentKey: "cache", port: 6379 }] },
      // The ingress pair survives but the component goes: the domain FK is the backstop.
      { components: ["web"], ingress },
    ];
    for (const plan of plans) {
      const err = await enqueue(stack, "stack.upgrade", { plan }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppStackRepositoryError);
      expect(err).toMatchObject({ code: "COMPONENT_IN_USE" });
      expect(await keysOf(stack.id)).toEqual({ components: ["cache", "web"], volumes: ["data"], revisions: 1, deployments: 1 });
    }
    expect((await enqueue(stack, "stack.upgrade", { plan: { ingress } })).revision?.revisionNumber).toBe(2);
  });

  it("delete with destroyData marks every volume for destruction", async () => {
    const stack = await ready((await create(orgA, { volumes: ["data", "logs"] })).stack.id);
    const result = await enqueue(stack, "stack.delete", { destroyData: true });
    expect(result.stack.status).toBe("deleting");
    const volumes = await listAppStackVolumes(db(), { organizationId: orgA, stackId: stack.id });
    expect(volumes.map((v) => [v.volumeKey, v.retentionPolicy])).toEqual([
      ["data", "destroy"],
      ["logs", "destroy"],
    ]);
  });

  it("moves the stack status only through allowed transitions", async () => {
    const { stack } = await create();
    expect((await transitionAppStackTransactional(db(), { organizationId: orgA, stackId: stack.id, to: "deploying" })).status).toBe("deploying");
    expect((await transitionAppStackTransactional(db(), { organizationId: orgA, stackId: stack.id, to: "deploying" })).status).toBe("deploying");
    await expect(transitionAppStackTransactional(db(), { organizationId: orgA, stackId: stack.id, to: "stopped" })).rejects.toMatchObject({
      code: "INVALID_TRANSITION",
      status: "deploying",
    });
    await expect(transitionAppStackTransactional(db(), { organizationId: orgB, stackId: stack.id, to: "failed" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("settles a deployment: ended_at on terminal statuses, applied revision on stack and components, problem kept on success", async () => {
    const { stack, deployment, revision } = await create();
    const scope = { organizationId: orgA, stackId: stack.id, deploymentId: deployment!.id };
    await transitionAppStackTransactional(db(), { organizationId: orgA, stackId: stack.id, to: "deploying" });
    await updateAppStackDeploymentTransactional(db(), { ...scope, deploymentStatus: "running", problem: null, stackStatus: null });
    expect((await getAppStackDeployment(db(), { organizationId: orgA, deploymentId: deployment!.id }))?.endedAt).toBeNull();

    await expect(
      updateAppStackDeploymentTransactional(db(), { ...scope, deploymentStatus: "succeeded", problem: null, stackStatus: "stopped" }),
    ).rejects.toMatchObject({ code: "INVALID_TRANSITION", status: "deploying" });
    expect((await getAppStackDeployment(db(), { organizationId: orgA, deploymentId: deployment!.id }))?.status).toBe("running");

    const settled = await updateAppStackDeploymentTransactional(db(), {
      ...scope,
      deploymentStatus: "succeeded",
      problem: "STACK_ROUTES_PENDING",
      stackStatus: "degraded",
      appliedRevisionId: revision!.id,
      appliedRoutesHash: hex("routes"),
    });
    expect(settled).toMatchObject({ status: "degraded", appliedRevisionId: revision!.id, appliedRoutesHash: hex("routes") });
    const row = await getAppStackDeployment(db(), { organizationId: orgA, deploymentId: deployment!.id });
    expect(row).toMatchObject({ status: "succeeded", problem: "STACK_ROUTES_PENDING" });
    expect(row?.endedAt).toBeInstanceOf(Date);
    const components = await listAppStackComponents(db(), { organizationId: orgA, stackId: stack.id });
    expect(components.map((c) => c.appliedRevisionId)).toEqual([revision!.id, revision!.id]);
  });

  it("finalises a delete: quota released, domains and components gone, volumes retained, secrets kept, name reusable", async () => {
    await organization("org_sl_final", true);
    const created = await create("org_sl_final", { name: "Final" });
    let stack = await ready(created.stack.id);
    await domain(stack, "final.example", "web", 8080);
    await setAppStackSecretTransactional(db(), {
      organizationId: "org_sl_final",
      stackId: stack.id,
      parameterKey: "app_secret",
      value: "s3cr3t-value",
      masterKey: "e".repeat(64),
    });
    const deletion = await enqueue(stack, "stack.delete");
    stack = deletion.stack;
    const deleted = await updateAppStackDeploymentTransactional(db(), {
      organizationId: "org_sl_final",
      stackId: stack.id,
      deploymentId: deletion.deployment!.id,
      deploymentStatus: "succeeded",
      problem: null,
      stackStatus: "deleted",
    });
    expect(deleted).toMatchObject({ status: "deleted", resourceQuotaId: null });
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(await quotaOf("rq_org_sl_final")).toMatchObject({ usedServices: 0, usedCpuMilli: 0, usedMemoryBytes: "0" });
    expect(await db().select().from(appStackDomains).where(eq(appStackDomains.stackId, stack.id))).toEqual([]);
    expect((await keysOf(stack.id)).components).toEqual([]);
    const scope = { organizationId: "org_sl_final", stackId: stack.id };
    expect((await listAppStackVolumes(db(), { ...scope, includeDeleted: true })).map((v) => v.status)).toEqual(["retained"]);
    expect(await listAppStackVolumes(db(), scope)).toEqual([]);
    expect(await db().select().from(appStackSecrets).where(eq(appStackSecrets.stackId, stack.id))).toHaveLength(1);
    expect(await getAppStack(db(), scope)).toBeNull();
    expect(await getAppStackRevision(db(), { ...scope, revisionId: created.revision!.id })).not.toBeNull();
    expect(await getAppStackDeployment(db(), { organizationId: "org_sl_final", deploymentId: deletion.deployment!.id })).not.toBeNull();
    expect((await create("org_sl_final", { name: "final" })).stack.name).toBe("final");

    const destroyed = await ready((await create("org_sl_final", { name: "Destroyed" })).stack.id);
    await setAppStackSecretTransactional(db(), {
      organizationId: "org_sl_final",
      stackId: destroyed.id,
      parameterKey: "app_secret",
      value: "s3cr3t-value",
      masterKey: "e".repeat(64),
    });
    const destroying = await enqueue(destroyed, "stack.delete", { destroyData: true });
    await updateAppStackDeploymentTransactional(db(), {
      organizationId: "org_sl_final",
      stackId: destroyed.id,
      deploymentId: destroying.deployment!.id,
      deploymentStatus: "succeeded",
      problem: null,
      stackStatus: "deleted",
    });
    const volumes = await listAppStackVolumes(db(), { organizationId: "org_sl_final", stackId: destroyed.id, includeDeleted: true });
    expect(volumes.map((v) => v.status)).toEqual(["removed"]);
    expect(await db().select().from(appStackSecrets).where(eq(appStackSecrets.stackId, destroyed.id))).toEqual([]);
  });

  it("records component health and volume status, ignoring unknown keys", async () => {
    const { stack } = await create();
    const observedAt = new Date("2026-11-22T10:00:00.000Z");
    await recordAppStackComponentHealthTransactional(db(), {
      organizationId: orgA,
      stackId: stack.id,
      observedAt,
      components: [
        { componentKey: "web", health: "healthy" },
        { componentKey: "ghost", health: "unhealthy" },
      ],
    });
    const components = await listAppStackComponents(db(), { organizationId: orgA, stackId: stack.id });
    expect(components.map((c) => [c.componentKey, c.health, c.healthObservedAt?.toISOString() ?? null])).toEqual([
      ["cache", "unknown", null],
      ["web", "healthy", observedAt.toISOString()],
    ]);
    await setAppStackVolumeStatusTransactional(db(), { organizationId: orgA, stackId: stack.id, volumeKeys: ["data", "ghost"], status: "present" });
    expect((await listAppStackVolumes(db(), { organizationId: orgA, stackId: stack.id })).map((v) => v.status)).toEqual(["present"]);
  });

  it("boot repair: busy stacks without an active operation fail, their deployments are interrupted, locked ones are untouched", async () => {
    await repairOrphanedAppStackStatusesTransactional(db());
    const orphan = await create();
    await db().update(operations).set({ status: "failed" }).where(eq(operations.id, orphan.operation!.id));
    const deleting = await enqueue(await ready((await create()).stack.id), "stack.delete");
    await db().update(operations).set({ status: "failed" }).where(eq(operations.id, deleting.operation!.id));
    const locked = await create();

    expect(await repairOrphanedAppStackStatusesTransactional(db())).toBe(2);
    expect((await stackOf(orphan.stack.id)).status).toBe("failed");
    expect((await stackOf(deleting.stack.id)).status).toBe("delete_failed");
    expect((await stackOf(locked.stack.id)).status).toBe("queued");
    const interrupted = await getAppStackDeployment(db(), { organizationId: orgA, deploymentId: orphan.deployment!.id });
    expect(interrupted).toMatchObject({ status: "failed", problem: "OPERATION_INTERRUPTED" });
    expect(interrupted?.endedAt).toBeInstanceOf(Date);
    expect((await getAppStackDeployment(db(), { organizationId: orgA, deploymentId: locked.deployment!.id }))?.status).toBe("queued");
    expect(await repairOrphanedAppStackStatusesTransactional(db())).toBe(0);
  });

  it("pages stacks and deployments by keyset, newest first", async () => {
    await organization("org_sl_pages");
    for (let i = 0; i < 5; i += 1) await create("org_sl_pages", { draft: true });
    const all = await listAppStacks(db(), { organizationId: "org_sl_pages", limit: 100 });
    expect(all).toHaveLength(5);
    const order = [...all].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    expect(all.map((s) => s.id)).toEqual(order.map((s) => s.id));
    const paged: AppStackRow[] = [];
    for (let page = await listAppStacks(db(), { organizationId: "org_sl_pages", limit: 2 }); page.length > 0; ) {
      paged.push(...page);
      const last = page[page.length - 1]!;
      page = await listAppStacks(db(), { organizationId: "org_sl_pages", limit: 2, after: { createdAt: last.createdAt, id: last.id } });
    }
    expect(paged.map((s) => s.id)).toEqual(all.map((s) => s.id));

    let stack = await ready((await create("org_sl_pages")).stack.id);
    for (const kind of ["stack.restart", "stack.stop", "stack.start"] as const) {
      await enqueue(stack, kind);
      stack = await ready(stack.id, kind === "stack.stop" ? "stopped" : "running");
    }
    const scope = { organizationId: "org_sl_pages", stackId: stack.id };
    const deployments = await listAppStackDeployments(db(), { ...scope, limit: 100 });
    expect(deployments).toHaveLength(4);
    const pagedDeployments = [...(await listAppStackDeployments(db(), { ...scope, limit: 3 }))];
    const last = pagedDeployments[2]!;
    pagedDeployments.push(...(await listAppStackDeployments(db(), { ...scope, limit: 3, after: { startedAt: last.startedAt, id: last.id } })));
    expect(pagedDeployments.map((d) => d.id)).toEqual(deployments.map((d) => d.id));
  });

  it("scopes every read and write by organization", async () => {
    const created = await create();
    const stack = created.stack;
    const foreign = { organizationId: orgB, stackId: stack.id };
    expect(await getAppStack(db(), foreign)).toBeNull();
    expect(await getAppStackRevision(db(), { ...foreign, revisionId: created.revision!.id })).toBeNull();
    expect(await listAppStackRevisions(db(), foreign)).toEqual([]);
    expect(await listAppStackParameters(db(), foreign)).toEqual([]);
    expect(await listAppStackComponents(db(), foreign)).toEqual([]);
    expect(await listAppStackVolumes(db(), { ...foreign, includeDeleted: true })).toEqual([]);
    expect(await getAppStackDeployment(db(), { organizationId: orgB, deploymentId: created.deployment!.id })).toBeNull();
    expect(await listAppStackDeployments(db(), { ...foreign, limit: 100 })).toEqual([]);
    expect((await listAppStacks(db(), { organizationId: orgB, limit: 100 })).map((s) => s.id)).not.toContain(stack.id);
    await expect(enqueue({ ...stack, organizationId: orgB }, "stack.stop")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      updateAppStackDeploymentTransactional(db(), {
        ...foreign,
        deploymentId: created.deployment!.id,
        deploymentStatus: "failed",
        problem: null,
        stackStatus: null,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listAppStackRevisions(db(), { organizationId: orgA, stackId: stack.id })).map((r) => r.revisionNumber)).toEqual([1]);
  });

  it("finds the organization's active Dedicated allocation and lists stacks by status across organizations", async () => {
    expect(await findAppStackAllocation(db(), orgA)).toEqual({ id: ALLOC[orgA], hostId: "hst_sl" });
    await db().insert(organizations).values({ id: "org_sl_none", platformInstallationId: "pin_sl", name: "none", slug: "org-sl-none" });
    await db().insert(hostAllocations).values({ id: "alloc_sl_none", hostId: "hst_sl", organizationId: "org_sl_none", status: "suspended" });
    expect(await findAppStackAllocation(db(), "org_sl_none")).toBeNull();

    const a = await ready((await create(orgA)).stack.id, "unknown");
    const b = await ready((await create(orgB)).stack.id, "unknown");
    const unknown = await listAppStacksByStatus(db(), { statuses: ["unknown"], limit: 100 });
    expect(unknown.map((s) => s.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(unknown.every((s) => s.status === "unknown")).toBe(true);
    expect(await listAppStacksByStatus(db(), { statuses: [], limit: 100 })).toEqual([]);
  });
});
