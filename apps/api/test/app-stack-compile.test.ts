import { readFileSync } from "node:fs";
import { ERROR_CODE_HTTP_STATUS, sumAppStackPlanResources, type AppImageAllowlistEntry } from "@hosting-panel/contracts";
import type { AppStackDomainRow, AppStackParameterRow } from "@hosting-panel/database";
import { verifyAppStackPlanHash } from "@hosting-panel/hosting-domain";
import { validateAppTemplateSource } from "@hosting-panel/policy-engine";
import { describe, expect, it } from "vitest";
import {
  carryOverParameters,
  compileRevision,
  domainTargetsMissing,
  entriesOf,
  entriesOfValues,
  parameterValuesOf,
  revisionFromPlan,
  sameEntries,
  secretVersionsOf,
  validatedSpec,
} from "../src/app-stacks/app-stack-compile.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../packages/contracts/test/fixtures/app-stack-notes-demo/${name}`, import.meta.url), "utf8");
const SOURCE = fixture("source.yaml");
const options = { allowlist: JSON.parse(fixture("allowlist.json")) as AppImageAllowlistEntry[] };
/** notes-demo + a customer string and a template-only string parameter. */
const EXTENDED = SOURCE.replace(
  "x-hp-parameters:\n",
  'x-hp-parameters:\n  - key: title\n    label: Title\n    type: string\n    default: "Notes"\n    customer: true\n' +
    '  - key: log_level\n    label: Log level\n    type: string\n    default: "info"\n    customer: false\n',
);
const IDS = {
  stackId: "stk_0123456789abcdef01234567",
  organizationId: "org_acme",
  hostAllocationId: "alloc_0123456789abcdef0123456789abcdef",
  templateVersionId: "atv_0123456789abcdef01234567",
  revisionId: "srev_0123456789abcdef01234567",
};
const compileInput = (parameters: { key: string; value: string | number | boolean }[], secretVersions = new Map([["app_secret", 3]])) => ({
  source: EXTENDED,
  parameters,
  secretVersions,
  ids: IDS,
});
const thrown = (work: () => unknown): ControlPlaneError => {
  try {
    work();
  } catch (err) {
    expect(err).toBeInstanceOf(ControlPlaneError);
    return err as ControlPlaneError;
  }
  throw new Error("expected a refusal");
};
const parameterRow = (parameterKey: string, publicValue: string | number | boolean): AppStackParameterRow => ({
  stackId: IDS.stackId,
  organizationId: IDS.organizationId,
  parameterKey,
  publicValue,
  updatedAt: new Date(0),
});

describe("parameter entries", () => {
  it("round-trips rows, entries and stored values, sorted by key", () => {
    const entries = entriesOf([parameterRow("worker_count", 3), parameterRow("title", "Mine"), parameterRow("debug", false)]);
    expect(entries).toEqual([
      { key: "debug", value: false },
      { key: "title", value: "Mine" },
      { key: "worker_count", value: 3 },
    ]);
    const values = parameterValuesOf([...entries].reverse());
    expect(values).toEqual([
      { parameterKey: "debug", value: false },
      { parameterKey: "title", value: "Mine" },
      { parameterKey: "worker_count", value: 3 },
    ]);
    expect(entriesOfValues([...values].reverse())).toEqual(entries);
  });

  it("carries over only customer, non-secret parameters the new spec still declares", () => {
    const spec = validatedSpec(EXTENDED, options);
    const stored = [
      { key: "app_secret", value: "x" },
      { key: "gone", value: 1 },
      { key: "log_level", value: "debug" },
      { key: "title", value: "Mine" },
      { key: "worker_count", value: 3 },
    ];
    expect(carryOverParameters(spec, stored)).toEqual([
      { key: "title", value: "Mine" },
      { key: "worker_count", value: 3 },
    ]);
  });

  it("compares entries regardless of order", () => {
    const a = [
      { key: "title", value: "Mine" },
      { key: "worker_count", value: 3 },
    ];
    expect(sameEntries(a, [...a].reverse())).toBe(true);
    expect(sameEntries(a, [{ key: "title", value: "Mine" }])).toBe(false);
    expect(sameEntries(a, [{ key: "title", value: "Mine" }, { key: "worker_count", value: "3" }])).toBe(false);
    expect(sameEntries([], [])).toBe(true);
  });

  it("keeps the latest version of each secret", () => {
    const at = new Date(0);
    const versions = secretVersionsOf([
      { parameterKey: "app_secret", version: 1, rotatedAt: at },
      { parameterKey: "app_secret", version: 3, rotatedAt: at },
      { parameterKey: "app_secret", version: 2, rotatedAt: at },
      { parameterKey: "other", version: 1, rotatedAt: at },
    ]);
    expect([...versions.entries()].sort()).toEqual([
      ["app_secret", 3],
      ["other", 1],
    ]);
  });
});

describe("compileRevision", () => {
  it("compiles the notes-demo source into a verified plan and its revision", () => {
    const c = compileRevision(compileInput([{ key: "worker_count", value: 3 }, { key: "title", value: "Mine" }]), options);
    expect(verifyAppStackPlanHash(c.plan)).toBe(true);
    expect(c.plan).toMatchObject({ stackId: IDS.stackId, revisionId: IDS.revisionId, templateVersionId: IDS.templateVersionId });
    expect(c.plan.components.find((x) => x.key === "app")?.secretFiles).toEqual([
      { envName: "APP_SECRET_FILE", parameterKey: "app_secret", version: 3 },
    ]);
    expect(c.entries).toEqual([
      { key: "title", value: "Mine" },
      { key: "worker_count", value: 3 },
    ]);
    expect(c.revision).toEqual(revisionFromPlan(c.plan, c.entries));
  });

  it("builds the revision from the plan: ids, keys, totals (memory as a number) and parameters", () => {
    const { plan } = compileRevision(compileInput([]), options);
    const sum = sumAppStackPlanResources(plan);
    const revision = revisionFromPlan(plan, [{ key: "worker_count", value: 2 }]);
    expect(revision).toEqual({
      revisionId: plan.revisionId,
      templateVersionId: plan.templateVersionId,
      plan,
      planHash: plan.planHash,
      componentKeys: plan.components.map((x) => x.key),
      volumeKeys: ["data"],
      cpuMilli: 1500,
      memoryBytes: Number(sum.memoryBytes),
      parameters: [{ parameterKey: "worker_count", value: 2 }],
    });
    expect(revision.memoryBytes).toBe(768 * 1024 * 1024);
    expect(revision.componentKeys).toEqual(["cache", "app"]);
  });

  it("refuses a template-only parameter at parameters.<key> without a source position", () => {
    const err = thrown(() => compileRevision(compileInput([{ key: "log_level", value: "debug" }]), options));
    expect(ERROR_CODE_HTTP_STATUS[err.code]).toBe(400);
    expect(err.details).toEqual([
      { field: "parameters.log_level", reason: "STACK_PARAMETER_INVALID", message: expect.stringMatching(/^PARAM_VALUE_NOT_CUSTOMER: /) },
    ]);
  });

  it("refuses a missing required secret with STACK_SECRET_MISSING", () => {
    const err = thrown(() => compileRevision(compileInput([], new Map()), options));
    expect(err.details).toEqual([expect.objectContaining({ field: "parameters.app_secret", reason: "STACK_SECRET_MISSING" })]);
  });
});

describe("validatedSpec", () => {
  it("returns the validator's spec", () => {
    const checked = validateAppTemplateSource(SOURCE, options);
    expect(checked.ok && validatedSpec(SOURCE, options)).toEqual(checked.ok ? checked.spec : null);
  });

  it("re-validates with today's options: a source no longer allowed collapses into one template detail", () => {
    const err = thrown(() => validatedSpec(SOURCE, {}));
    expect(ERROR_CODE_HTTP_STATUS[err.code]).toBe(400);
    expect(err.details).toEqual([expect.objectContaining({ field: "templateVersionId", reason: "STACK_TEMPLATE_INVALID" })]);
    expect(JSON.stringify(err.details)).not.toMatch(/line|column|registry\.example/);
  });
});

describe("domainTargetsMissing", () => {
  const domain = (id: string, componentKey: string, internalPort: number) => ({ id, componentKey, internalPort }) as AppStackDomainRow;

  it("returns the rows whose component and port are not an ingress pair", () => {
    const rows = [domain("d1", "app", 8080), domain("d2", "app", 9090), domain("d3", "cache", 8080)];
    expect(domainTargetsMissing(rows, [{ componentKey: "app", port: 8080 }]).map((r) => r.id)).toEqual(["d2", "d3"]);
    expect(domainTargetsMissing(rows, [])).toEqual(rows);
    expect(domainTargetsMissing([], [{ componentKey: "app", port: 8080 }])).toEqual([]);
  });
});
