import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_STACK_STEPS_BY_KIND } from "@hosting-panel/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  and,
  appStackComponents,
  appStackDeployments,
  appStackParameters,
  appStackRevisions,
  appStacks,
  appStackVolumes,
  AppStackQuotaError,
  AppStackRepositoryError,
  archiveAppTemplate,
  createAppTemplate,
  createAppStackTransactional,
  createDatabaseClient,
  eq,
  hostAllocations,
  hosts,
  newAppEntityId,
  operations,
  operationSteps,
  organizations,
  outboxEvents,
  platformInstallations,
  resourceQuotas,
  updateAppTemplate,
  updateOrganizationAppStackLimitTransactional,
  type CreateAppStackInput,
  type DatabaseClient,
  type HostingPanelDatabase,
  type NewAppStackRevision,
} from "../src/index.js";

// Creating a stack: a draft, or stack + parameters + revision 1 + components + volumes + deployment + stack.deploy
// operation + outbox row in one transaction, replayable by idempotency key and bounded by the organisation's limit.
const orgA = "org_sr_a";
const orgB = "org_sr_b";
const ALLOC: Record<string, string> = { [orgA]: "alloc_sr_a", [orgB]: "alloc_sr_b" };
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
const PARAMETERS = [
  { parameterKey: "title", value: "Hello" },
  { parameterKey: "port", value: 8080 },
];

interface PlanOptions {
  readonly components?: readonly string[];
  readonly volumes?: readonly string[];
}

function revisionFor(stack: { stackId: string; organizationId: string; templateVersionId: string }, options: PlanOptions = {}): NewAppStackRevision {
  const componentKeys = options.components ?? ["web", "cache"];
  const volumeKeys = options.volumes ?? ["data"];
  const revisionId = newAppEntityId("srev");
  const planHash = hex(`${revisionId}:${componentKeys.join(",")}`);
  return {
    revisionId,
    templateVersionId: stack.templateVersionId,
    plan: {
      schemaVersion: 1,
      stackId: stack.stackId,
      organizationId: stack.organizationId,
      hostAllocationId: ALLOC[stack.organizationId]!,
      templateVersionId: stack.templateVersionId,
      revisionId,
      planHash,
      components: componentKeys.map((key) => ({ key, resources: { cpuMilli: 250, memoryBytes: "134217728" } })),
      volumes: volumeKeys.map((key) => ({ key })),
      ingress: [{ componentKey: componentKeys[0], port: 8080 }],
    },
    planHash,
    componentKeys,
    volumeKeys,
    cpuMilli: 250 * componentKeys.length,
    memoryBytes: 134217728 * componentKeys.length,
    parameters: PARAMETERS,
  };
}

describe("@hosting-panel/database — app stacks repository (create)", () => {
  let client: DatabaseClient;
  const db = (): HostingPanelDatabase => client.db;
  let counter = 0;
  let versionId = "";
  let draftVersionId = "";
  let archivedVersionId = "";

  async function template(slug: string, publish: boolean): Promise<{ templateId: string; versionId: string }> {
    const created = await createAppTemplate(db(), {
      slug,
      name: slug,
      description: null,
      category: "web",
      createdBy: null,
      firstVersion: { source: `source ${slug}`, specVersion: 1, compiledSchema: {}, specHash: hex(slug) },
    });
    if (publish) await updateAppTemplate(db(), { templateId: created.template.id, enabled: true });
    return { templateId: created.template.id, versionId: created.version.id };
  }

  type InputOptions = Partial<Pick<CreateAppStackInput, "stackId" | "organizationId" | "templateVersionId" | "name">> & { deployed?: boolean };
  function input(over: InputOptions = {}): CreateAppStackInput {
    counter += 1;
    const { deployed = true, ...rest } = over;
    const stackId = rest.stackId ?? newAppEntityId("stk");
    const organizationId = rest.organizationId ?? orgA;
    const templateVersionId = rest.templateVersionId ?? versionId;
    const common = {
      stackId,
      organizationId,
      hostAllocationId: ALLOC[organizationId]!,
      templateVersionId,
      name: rest.name ?? `Stack ${String(counter)}`,
      createdBy: null,
      idempotencyKey: `key-${String(counter)}`,
      requestHash: hex(`request ${String(counter)}`),
    };
    return deployed
      ? { ...common, deploy: revisionFor({ stackId, organizationId, templateVersionId }) }
      : { ...common, deploy: null, parameters: PARAMETERS, componentKeys: ["web", "cache"] };
  }

  const rowsOf = async (stackId: string) => ({
    stacks: await db().select().from(appStacks).where(eq(appStacks.id, stackId)),
    parameters: await db().select().from(appStackParameters).where(eq(appStackParameters.stackId, stackId)),
    revisions: await db().select().from(appStackRevisions).where(eq(appStackRevisions.stackId, stackId)),
    components: await db().select().from(appStackComponents).where(eq(appStackComponents.stackId, stackId)),
    volumes: await db().select().from(appStackVolumes).where(eq(appStackVolumes.stackId, stackId)),
    deployments: await db().select().from(appStackDeployments).where(eq(appStackDeployments.stackId, stackId)),
    operations: await db().select().from(operations).where(eq(operations.resourceId, stackId)),
    outbox: await db().select().from(outboxEvents).where(eq(outboxEvents.aggregateId, stackId)),
  });

  async function organization(id: string, maxAppStacks: number | null) {
    await db().insert(organizations).values({ id, platformInstallationId: "pin_sr", name: id, slug: id.replace(/_/g, "-"), maxAppStacks });
    await db().insert(hostAllocations).values({ id: `alloc_${id}`, hostId: "hst_sr", organizationId: id, status: "active" });
    ALLOC[id] = `alloc_${id}`;
  }

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_sr", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_sr",
      platformInstallationId: "pin_sr",
      name: "sr-host",
      hostname: "panel.sr.example",
      ipv4Address: "10.0.0.51",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    for (const org of [orgA, orgB]) {
      await db().insert(organizations).values({ id: org, platformInstallationId: "pin_sr", name: org, slug: org.replace(/_/g, "-") });
      await db().insert(hostAllocations).values({ id: ALLOC[org]!, hostId: "hst_sr", organizationId: org, status: "active" });
    }
    versionId = (await template("sr-alpha", true)).versionId;
    draftVersionId = (await template("sr-draft", false)).versionId;
    const archived = await template("sr-archived", true);
    archivedVersionId = archived.versionId;
    await archiveAppTemplate(db(), archived.templateId);
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  it("creates a draft: stack, parameters and one component row per key, no revision, volume, operation or deployment", async () => {
    const values = input({ deployed: false });
    const result = await createAppStackTransactional(db(), values);
    expect(result).toMatchObject({ revision: null, deployment: null, operation: null, idempotentReplay: false });
    expect(result.stack).toMatchObject({
      id: values.stackId,
      organizationId: orgA,
      status: "draft",
      desiredRevisionId: null,
      idempotencyKey: values.idempotencyKey,
      requestHash: values.requestHash,
    });
    const rows = await rowsOf(values.stackId);
    expect(rows.parameters.map((p) => [p.parameterKey, p.publicValue]).sort()).toEqual([
      ["port", 8080],
      ["title", "Hello"],
    ]);
    expect(rows.revisions).toEqual([]);
    expect(rows.components.map((c) => [c.componentKey, c.health, c.appliedRevisionId]).sort()).toEqual([
      ["cache", "unknown", null],
      ["web", "unknown", null],
    ]);
    expect(rows.volumes).toEqual([]);
    expect(rows.deployments).toEqual([]);
    expect(rows.operations).toEqual([]);
  });

  it("refuses a draft whose component keys are missing, too many, repeated or malformed", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `part-${String(i)}`);
    for (const componentKeys of [[], nine, ["web", "web"], ["Web"], ["web-"]]) {
      const values = { ...input({ deployed: false }), deploy: null, parameters: PARAMETERS, componentKeys };
      await expect(createAppStackTransactional(db(), values)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect((await rowsOf(values.stackId)).stacks).toEqual([]);
    }
  });

  it("stores the revision's parameters at create with deploy: one source for both copies", async () => {
    const values = input();
    const deploy = { ...values.deploy!, parameters: [{ parameterKey: "title", value: "From the revision" }] };
    const result = await createAppStackTransactional(db(), { ...values, deploy });
    expect(result.revision?.parameters).toEqual([{ key: "title", value: "From the revision" }]);
    const rows = await rowsOf(values.stackId);
    expect(rows.parameters.map((p) => [p.parameterKey, p.publicValue])).toEqual([["title", "From the revision"]]);
  });

  it("creates with deploy: every row in one transaction, the operation locked on the stack with the deploy steps", async () => {
    const values = input();
    const result = await createAppStackTransactional(db(), values);
    const revision = values.deploy!;
    expect(result.idempotentReplay).toBe(false);
    expect(result.stack).toMatchObject({ status: "queued", desiredRevisionId: revision.revisionId, appliedRevisionId: null });
    expect(result.revision).toMatchObject({
      id: revision.revisionId,
      revisionNumber: 1,
      templateVersionId: versionId,
      planHash: revision.planHash,
      componentCount: 2,
      cpuMilli: 500,
      memoryBytes: 268435456,
      parameters: [
        { key: "port", value: 8080 },
        { key: "title", value: "Hello" },
      ],
    });
    expect(result.operation).toMatchObject({
      kind: "stack.deploy",
      status: "queued",
      resourceType: "stack",
      resourceId: values.stackId,
      lockKey: `stack:${values.stackId}`,
      idempotencyKey: values.idempotencyKey,
      requestHash: values.requestHash,
    });
    expect(result.deployment).toMatchObject({
      stackId: values.stackId,
      operationId: result.operation!.id,
      revisionId: revision.revisionId,
      status: "queued",
      endedAt: null,
    });
    expect(result.deployment!.id).toMatch(/^sdep_[0-9a-f]{24}$/);
    const rows = await rowsOf(values.stackId);
    expect(rows.components.map((c) => [c.componentKey, c.health]).sort()).toEqual([
      ["cache", "unknown"],
      ["web", "unknown"],
    ]);
    expect(rows.volumes.map((v) => [v.volumeKey, v.status, v.retentionPolicy])).toEqual([["data", "pending", "retain"]]);
    const steps = await db().select().from(operationSteps).where(eq(operationSteps.operationId, result.operation!.id));
    expect(steps.map((s) => s.key)).toEqual([...APP_STACK_STEPS_BY_KIND["stack.deploy"]]);
    expect(rows.outbox).toHaveLength(1);
    expect(Object.keys(rows.outbox[0]!.payload as object).sort()).toEqual(
      ["deploymentId", "kind", "operationId", "organizationId", "resourceId", "resourceType", "revisionId", "stackId"],
    );
    expect(rows.outbox[0]!.payload).toMatchObject({ stackId: values.stackId, deploymentId: result.deployment!.id, revisionId: revision.revisionId });
  });

  it("charges the allocation's resource quota with the first revision", async () => {
    await organization("org_sr_quota", null);
    await db().insert(resourceQuotas).values({
      id: "rq_sr_quota",
      organizationId: "org_sr_quota",
      hostAllocationId: ALLOC.org_sr_quota!,
      maxSites: 10,
      maxServices: 8,
      maxCpuMilli: 4000,
      maxMemoryBytes: "4000000000",
      maxStorageBytes: "1000000000",
    });
    const result = await createAppStackTransactional(db(), input({ organizationId: "org_sr_quota" }));
    expect(result.stack.resourceQuotaId).toBe("rq_sr_quota");
    const [quota] = await db().select().from(resourceQuotas).where(eq(resourceQuotas.id, "rq_sr_quota"));
    expect(quota).toMatchObject({ usedServices: 2, usedCpuMilli: 500, usedMemoryBytes: "268435456" });
  });

  it("rolls the whole create back when a step after the revision insert fails", async () => {
    const values = input();
    // An active operation already holding the stack's lock makes the enqueue fail after revision, components and volumes.
    await db().insert(operations).values({
      id: `op_sr_lock_${String(counter)}`,
      organizationId: orgA,
      kind: "stack.stop",
      status: "processing",
      resourceType: "stack",
      resourceId: "stk_elsewhere",
      lockKey: `stack:${values.stackId}`,
    });
    await expect(createAppStackTransactional(db(), values)).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    const rows = await rowsOf(values.stackId);
    expect(rows).toEqual({ stacks: [], parameters: [], revisions: [], components: [], volumes: [], deployments: [], operations: [], outbox: [] });
  });

  it("replays the same key and hash: the same stack and operation, no new rows", async () => {
    const values = input();
    const first = await createAppStackTransactional(db(), values);
    const before = await rowsOf(values.stackId);
    const replay = await createAppStackTransactional(db(), { ...values, stackId: newAppEntityId("stk"), deploy: revisionFor(values) });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.stack.id).toBe(values.stackId);
    expect(replay.operation?.id).toBe(first.operation!.id);
    expect(replay.deployment?.id).toBe(first.deployment!.id);
    expect(replay.revision?.id).toBe(first.revision!.id);
    expect(await rowsOf(values.stackId)).toEqual(before);
    const draft = input({ deployed: false });
    await createAppStackTransactional(db(), draft);
    expect(await createAppStackTransactional(db(), draft)).toMatchObject({ idempotentReplay: true, revision: null, operation: null });
  });

  it("refuses the same key with another request hash", async () => {
    const values = input();
    await createAppStackTransactional(db(), values);
    await expect(createAppStackTransactional(db(), { ...values, requestHash: hex("other") })).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    });
  });

  it("refuses a name already used by a live stack of the organization (any case)", async () => {
    const first = input({ deployed: false });
    await createAppStackTransactional(db(), first);
    await expect(createAppStackTransactional(db(), input({ name: first.name.toUpperCase() }))).rejects.toSatisfy(
      (err: unknown) => err instanceof AppStackRepositoryError && err.code === "NAME_TAKEN",
    );
    const other = await createAppStackTransactional(db(), input({ organizationId: orgB, name: first.name, deployed: false }));
    expect(other.stack.name).toBe(first.name);
  });

  it("refuses a version that is not the default of an enabled, non-archived template", async () => {
    for (const templateVersionId of [draftVersionId, archivedVersionId]) {
      const values = input({ templateVersionId });
      await expect(createAppStackTransactional(db(), values)).rejects.toMatchObject({ code: "TEMPLATE_UNPUBLISHED" });
      expect((await rowsOf(values.stackId)).stacks).toEqual([]);
    }
  });

  it("refuses a create at the organization's stack limit, counting live stacks only", async () => {
    await organization("org_sr_limit", 1);
    await createAppStackTransactional(db(), input({ organizationId: "org_sr_limit", deployed: false }));
    const refused = await createAppStackTransactional(db(), input({ organizationId: "org_sr_limit" })).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(AppStackQuotaError);
    expect(refused).toMatchObject({ field: "appStacks", used: 1, limit: 1 });
    await updateOrganizationAppStackLimitTransactional(db(), { organizationId: "org_sr_limit", maxAppStacks: null });
    expect((await createAppStackTransactional(db(), input({ organizationId: "org_sr_limit" }))).stack.status).toBe("queued");
  });

  it("B2: two simultaneous creates at limit 1 leave exactly one stack", async () => {
    await organization("org_sr_b2", 1);
    const results = await Promise.allSettled([
      createAppStackTransactional(db(), input({ organizationId: "org_sr_b2" })),
      createAppStackTransactional(db(), input({ organizationId: "org_sr_b2" })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(AppStackQuotaError);
    expect(await db().select().from(appStacks).where(eq(appStacks.organizationId, "org_sr_b2"))).toHaveLength(1);
    const source = readFileSync(fileURLToPath(new URL("../src/app-stack-limit.ts", import.meta.url)), "utf8");
    expect(source).toContain('.for("no key update")');
  });

  it("refuses a revision whose plan does not match the stack or its own ids and keys", async () => {
    const mismatches: ((r: NewAppStackRevision) => NewAppStackRevision)[] = [
      (r) => ({ ...r, plan: { ...r.plan, stackId: "stk_other" } }),
      (r) => ({ ...r, plan: { ...r.plan, organizationId: orgB } }),
      (r) => ({ ...r, plan: { ...r.plan, hostAllocationId: ALLOC[orgB] } }),
      (r) => ({ ...r, plan: { ...r.plan, revisionId: newAppEntityId("srev") } }),
      (r) => ({ ...r, planHash: hex("another plan") }),
      (r) => ({ ...r, componentKeys: ["web"] }),
      (r) => ({ ...r, volumeKeys: [] }),
      (r) => ({ ...r, templateVersionId: draftVersionId }),
    ];
    for (const change of mismatches) {
      const values = input();
      await expect(createAppStackTransactional(db(), { ...values, deploy: change(values.deploy!) })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect((await rowsOf(values.stackId)).stacks).toEqual([]);
    }
  });

  it("refuses a plan or parameters carrying secret material", async () => {
    const values = input();
    const revision = values.deploy!;
    const withPassword = { ...revision, plan: { ...revision.plan, components: [{ key: "web", password: "hunter2" }, { key: "cache" }] } };
    await expect(createAppStackTransactional(db(), { ...values, deploy: withPassword })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const pem = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
    const withPem = { ...revision, parameters: [{ parameterKey: "title", value: pem }] };
    await expect(createAppStackTransactional(db(), { ...values, deploy: withPem })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await rowsOf(values.stackId)).stacks).toEqual([]);
    const draft = { ...input({ deployed: false }), deploy: null, parameters: [{ parameterKey: "title", value: pem }], componentKeys: ["web"] };
    await expect(createAppStackTransactional(db(), draft)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await rowsOf(draft.stackId)).stacks).toEqual([]);
    expect(await db().select().from(appStacks).where(and(eq(appStacks.organizationId, orgA), eq(appStacks.idempotencyKey, values.idempotencyKey)))).toEqual([]);
  });
});
