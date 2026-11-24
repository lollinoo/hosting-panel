import { readFileSync } from "node:fs";
import {
  AppStackAcceptedEnvelopeSchema,
  AppStackDeploymentDtoSchema,
  AppStackDetailDtoSchema,
  AppStackDomainDtoSchema,
  AppStackSummaryDtoSchema,
  type AppImageAllowlistEntry,
  type AppStackComponentHealth,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import type {
  AppStackComponentRow,
  AppStackDeploymentRow,
  AppStackDomainRow,
  AppStackRevisionRow,
  AppStackRow,
  AppStackWriteResult,
} from "@hosting-panel/database";
import { compileAppStackPlan, validateAppTemplateSource } from "@hosting-panel/policy-engine";
import { describe, expect, it } from "vitest";
import {
  appStackAcceptedEnvelope,
  appStackDeploymentDto,
  appStackDetailDto,
  appStackDomainDto,
  appStackSummaryDto,
} from "../src/app-stacks/app-stack-dto.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../packages/contracts/test/fixtures/app-stack-notes-demo/${name}`, import.meta.url), "utf8");
const SOURCE = fixture("source.yaml");
const options = { allowlist: JSON.parse(fixture("allowlist.json")) as AppImageAllowlistEntry[] };
const NOW = new Date("2026-11-22T12:00:00.000Z");
const FRESH = new Date(NOW.getTime() - 60_000);
const STALE = new Date(NOW.getTime() - 6 * 60_000);
const ORG = "org_acme";
const STACK = "stk_0123456789abcdef01234567";
const REVISION = "srev_0123456789abcdef01234567";

const checked = validateAppTemplateSource(SOURCE, options);
if (!checked.ok) throw new Error("the fixture must validate");
const SPEC = checked.spec;
const compiled = compileAppStackPlan(
  {
    source: SOURCE,
    parameters: [],
    secretVersions: new Map([["app_secret", 2]]),
    ids: { stackId: STACK, organizationId: ORG, hostAllocationId: "alloc_1", templateVersionId: "atv_1", revisionId: REVISION },
  },
  options,
);
if (!compiled.ok) throw new Error("the fixture must compile");
const PLAN: ApprovedStackPlan = compiled.plan;

const stackRow = (change: Partial<AppStackRow> = {}): AppStackRow => ({
  id: STACK,
  organizationId: ORG,
  hostAllocationId: "alloc_1",
  templateId: "atpl_1",
  templateVersionId: "atv_1",
  name: "My notes",
  status: "draft",
  desiredRevisionId: null,
  appliedRevisionId: null,
  resourceQuotaId: null,
  appliedRoutesHash: null,
  idempotencyKey: "k-1",
  requestHash: "h",
  createdBy: "usr_1",
  createdAt: new Date("2026-11-20T10:00:00.000Z"),
  updatedAt: new Date("2026-11-21T10:00:00.000Z"),
  deletedAt: null,
  ...change,
});
const component = (componentKey: string, health: AppStackComponentHealth, healthObservedAt: Date | null): AppStackComponentRow => ({
  stackId: STACK,
  organizationId: ORG,
  componentKey,
  health,
  healthObservedAt,
  appliedRevisionId: REVISION,
  createdAt: NOW,
  updatedAt: NOW,
});
const domain = (id: string, hostname: string, status: AppStackDomainRow["status"]): AppStackDomainRow => ({
  id,
  stackId: STACK,
  organizationId: ORG,
  componentKey: "app",
  internalPort: 8080,
  hostname,
  status,
  dnsStatus: "unchecked",
  dnsObserved: { a: [], aaaa: [] },
  dnsCheckedAt: null,
  dnsNextCheckAt: NOW,
  dnsAttempts: 0,
  certStatus: "none",
  certProblem: null,
  certChallenge: "http-01",
  certRequestedAt: null,
  certRetryAt: null,
  certAttempts: 0,
  certExpiresAt: null,
  certTrusted: true,
  createdAt: NOW,
  updatedAt: NOW,
});
const revision: AppStackRevisionRow = {
  id: REVISION,
  stackId: STACK,
  organizationId: ORG,
  revisionNumber: 3,
  templateVersionId: "atv_1",
  plan: PLAN,
  planHash: PLAN.planHash,
  parameters: [],
  componentCount: 2,
  cpuMilli: 1500,
  memoryBytes: 805306368,
  createdAt: NOW,
};
const detailInput = (change: Partial<Parameters<typeof appStackDetailDto>[0]> = {}): Parameters<typeof appStackDetailDto>[0] => ({
  stack: stackRow(),
  templateName: "Notes Demo",
  templateVersionNumber: 1,
  spec: SPEC,
  desired: null,
  components: [],
  volumes: [],
  domains: [],
  parameters: [],
  secrets: [],
  activeOperationId: null,
  installed: null,
  appliedPlan: null,
  upgrade: null,
  rollback: null,
  now: NOW,
  ...change,
});
const deployed = (components: AppStackComponentRow[], change: Partial<Parameters<typeof appStackDetailDto>[0]> = {}) =>
  detailInput({
    stack: stackRow({ status: "running", desiredRevisionId: REVISION, appliedRevisionId: REVISION }),
    desired: { revision, plan: PLAN },
    components,
    ...change,
  });

describe("appStackSummaryDto", () => {
  const summary = (components: AppStackComponentRow[], domains: AppStackDomainRow[] = []) =>
    appStackSummaryDto({ stack: stackRow({ status: "running" }), templateName: "Notes Demo", templateVersionNumber: 2, components, domains, now: NOW });

  it("counts unhealthy and missing components; a stale observation reads unknown and is not counted", () => {
    const dto = summary([
      component("app", "unhealthy", FRESH),
      component("cache", "missing", FRESH),
      component("worker", "unhealthy", STALE),
      component("web", "healthy", FRESH),
      component("never", "unhealthy", null),
    ]);
    expect(dto).toMatchObject({ componentCount: 5, unhealthyCount: 2, status: "running", templateVersionNumber: 2 });
    expect(AppStackSummaryDtoSchema.strict().parse(dto)).toEqual(dto);
  });

  it("primary hostname: the first active one by name, else the first one, else none", () => {
    expect(summary([], [domain("d1", "z.example.test", "active"), domain("d2", "c.example.test", "pending"), domain("d3", "b.example.test", "active")]).primaryHostname).toBe(
      "b.example.test",
    );
    expect(summary([], [domain("d1", "z.example.test", "failed"), domain("d2", "c.example.test", "pending")]).primaryHostname).toBe("c.example.test");
    expect(summary([]).primaryHostname).toBeNull();
  });
});

describe("appStackDetailDto", () => {
  it("a draft shows the spec services by key, no revision and the spec totals", () => {
    const dto = appStackDetailDto(detailInput());
    expect(dto).toMatchObject({
      status: "draft",
      revisionNumber: null,
      componentCount: 0,
      cpuMilli: 1500,
      memoryBytes: String(768 * 1024 * 1024),
      ingress: [{ componentKey: "app", port: 8080 }],
    });
    expect(dto.components).toEqual([
      { key: "app", health: "unknown", healthObservedAt: null, dependsOn: ["cache"], ingress: true, cpuMilli: 1000, memoryBytes: String(512 * 1024 * 1024) },
      { key: "cache", health: "unknown", healthObservedAt: null, dependsOn: [], ingress: false, cpuMilli: 500, memoryBytes: String(256 * 1024 * 1024) },
    ]);
    expect(AppStackDetailDtoSchema.strict().parse(dto)).toEqual(dto);
  });

  it("a deployed stack shows the plan order, ingress flags, effective health and the revision number", () => {
    const dto = appStackDetailDto(deployed([component("app", "healthy", FRESH), component("cache", "healthy", FRESH)]));
    expect(PLAN.components.map((c) => c.key)).toEqual(["cache", "app"]);
    expect(dto.components.map(({ key, ingress, health }) => ({ key, ingress, health }))).toEqual([
      { key: "cache", ingress: false, health: "healthy" },
      { key: "app", ingress: true, health: "healthy" },
    ]);
    expect(dto.components[1]?.healthObservedAt).toBe(FRESH.toISOString());
    expect(dto).toMatchObject({ status: "running", revisionNumber: 3, componentCount: 2, unhealthyCount: 0, cpuMilli: 1500 });
    expect(AppStackDetailDtoSchema.strict().parse(dto)).toEqual(dto);
  });

  it("shows the read-time status: a stale component of a running stack reads unknown", () => {
    const dto = appStackDetailDto(deployed([component("app", "healthy", FRESH), component("cache", "healthy", STALE)]));
    expect(dto.status).toBe("unknown");
    expect(dto.components[0]).toMatchObject({ key: "cache", health: "unknown", healthObservedAt: STALE.toISOString() });
  });

  it("while the desired revision is not the applied one, the status follows the applied revision's plan", () => {
    // The target runs only the cache; what runs is the full plan, whose web part is the essential one.
    const target = {
      revision: { ...revision, id: "srev_new", revisionNumber: 4 },
      plan: { ...PLAN, revisionId: "srev_new", components: PLAN.components.filter((c) => c.key === "cache"), ingress: [] } as ApprovedStackPlan,
    };
    const shown = (components: AppStackComponentRow[]) =>
      appStackDetailDto(
        detailInput({
          stack: stackRow({ status: "running", desiredRevisionId: "srev_new", appliedRevisionId: REVISION }),
          desired: target,
          appliedPlan: PLAN,
          components,
        }),
      ).status;
    expect(shown([component("app", "healthy", FRESH), component("cache", "healthy", FRESH)])).toBe("running");
    // A crash of what runs shows, and so does an observation gone stale.
    expect(shown([component("app", "stopped", FRESH), component("cache", "healthy", FRESH)])).toBe("failed");
    expect(shown([component("app", "healthy", STALE), component("cache", "healthy", FRESH)])).toBe("unknown");
    // No readable applied plan: the stored status.
    expect(
      appStackDetailDto(
        detailInput({
          stack: stackRow({ status: "running", desiredRevisionId: "srev_new", appliedRevisionId: REVISION }),
          desired: target,
          components: [component("app", "stopped", FRESH)],
        }),
      ).status,
    ).toBe("running");
  });

  it("joins secret parameters with their latest metadata and never lists a secret key among the parameters", () => {
    const rotated = new Date("2026-11-21T08:00:00.000Z");
    const row = (parameterKey: string, publicValue: string | number | boolean) => ({ stackId: STACK, organizationId: ORG, parameterKey, publicValue, updatedAt: NOW });
    const unset = appStackDetailDto(detailInput({ parameters: [row("worker_count", 3), row("app_secret", "x"), row("gone", 1)] }));
    expect(unset.parameters).toEqual([{ key: "worker_count", label: "Worker count", value: 3 }]);
    expect(unset.secretParameters).toEqual([{ key: "app_secret", label: "Application secret", required: true, isSet: false, version: null, setAt: null }]);

    const set = appStackDetailDto(
      detailInput({
        secrets: [
          { parameterKey: "app_secret", version: 2, rotatedAt: rotated },
          { parameterKey: "app_secret", version: 1, rotatedAt: NOW },
        ],
      }),
    );
    expect(set.secretParameters).toEqual([
      { key: "app_secret", label: "Application secret", required: true, isSet: true, version: 2, setAt: rotated.toISOString() },
    ]);
  });

  it("passes volumes, the active operation, upgrade and rollback through", () => {
    const dto = appStackDetailDto(
      deployed([], {
        volumes: [{ stackId: STACK, organizationId: ORG, volumeKey: "data", retentionPolicy: "retain", status: "present", createdAt: NOW, updatedAt: NOW }],
        activeOperationId: "op_1",
        installed: { revisionNumber: 2, templateVersionNumber: 1 },
        upgrade: { templateVersionId: "atv_2", versionNumber: 2 },
        rollback: { revisionId: "srev_2", revisionNumber: 2, templateVersionNumber: 1 },
      }),
    );
    expect(dto).toMatchObject({
      volumes: [{ key: "data", status: "present", retentionPolicy: "retain" }],
      activeOperationId: "op_1",
      installed: { revisionNumber: 2, templateVersionNumber: 1 },
      upgrade: { templateVersionId: "atv_2", versionNumber: 2 },
      rollback: { revisionId: "srev_2", revisionNumber: 2, templateVersionNumber: 1 },
    });
    expect(AppStackDetailDtoSchema.strict().parse(dto)).toEqual(dto);
  });
});

describe("row mappers", () => {
  it("maps a domain row", () => {
    const expires = new Date("2027-01-01T00:00:00.000Z");
    const dto = appStackDomainDto({ ...domain("sdom_1", "app.example.test", "active"), certStatus: "failed", certProblem: "not_pointing", certExpiresAt: expires, dnsCheckedAt: NOW });
    expect(dto).toEqual({
      id: "sdom_1",
      hostname: "app.example.test",
      componentKey: "app",
      port: 8080,
      status: "active",
      certificateStatus: "failed",
      certificateProblem: "not_pointing",
      certificateExpiresAt: expires.toISOString(),
      checkedAt: NOW.toISOString(),
    });
    expect(AppStackDomainDtoSchema.strict().parse(dto)).toEqual(dto);
  });

  it("maps a deployment row with its operation kind and revision number", () => {
    const row: AppStackDeploymentRow = {
      id: "sdep_1",
      stackId: STACK,
      organizationId: ORG,
      operationId: "op_1",
      revisionId: REVISION,
      status: "failed",
      problem: "STACK_HEALTH_TIMEOUT",
      startedAt: FRESH,
      endedAt: null,
      replacedRevisionId: null,
      replacedStatus: null,
    };
    const dto = appStackDeploymentDto(row, "stack.deploy", 3);
    expect(dto).toEqual({
      id: "sdep_1",
      operationId: "op_1",
      kind: "stack.deploy",
      revisionNumber: 3,
      status: "failed",
      problem: "STACK_HEALTH_TIMEOUT",
      startedAt: FRESH.toISOString(),
      endedAt: null,
    });
    expect(AppStackDeploymentDtoSchema.strict().parse(dto)).toEqual(dto);
  });

  it("builds the accepted envelope links", () => {
    const queued = {
      stack: stackRow({ status: "queued" }),
      revision,
      deployment: { id: "sdep_1" },
      operation: { id: "op_1" },
      idempotentReplay: false,
    } as unknown as AppStackWriteResult;
    expect(appStackAcceptedEnvelope(ORG, queued)).toEqual({
      data: { stackId: STACK, operationId: "op_1", deploymentId: "sdep_1", status: "queued" },
      links: { stack: `/v1/organizations/${ORG}/app-stacks/${STACK}`, operation: `/v1/organizations/${ORG}/operations/op_1` },
    });
    const draft = appStackAcceptedEnvelope(ORG, { stack: stackRow(), revision: null, deployment: null, operation: null, idempotentReplay: false });
    expect(draft).toEqual({
      data: { stackId: STACK, operationId: null, deploymentId: null, status: "draft" },
      links: { stack: `/v1/organizations/${ORG}/app-stacks/${STACK}`, operation: null },
    });
    expect(AppStackAcceptedEnvelopeSchema.strict().parse(draft)).toEqual(draft);
  });
});
