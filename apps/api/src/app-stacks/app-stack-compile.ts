import { sumAppStackPlanResources, type AppTemplateParameterEntry, type AppTemplateSpec, type ApprovedStackPlan } from "@hosting-panel/contracts";
import type {
  AppStackDomainRow,
  AppStackParameterRow,
  AppStackParameterValue,
  AppStackSecretMetadata,
  NewAppStackRevision,
} from "@hosting-panel/database";
import {
  compileAppStackPlan,
  validateAppTemplateSource,
  type AppStackCompileInput,
  type AppTemplateValidationOptions,
} from "@hosting-panel/policy-engine";
import { canonicalRequestHash } from "../common/request-hash.js";
import { customerIssuesError } from "./app-stack-errors.js";

const byKey = (a: AppTemplateParameterEntry, b: AppTemplateParameterEntry): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const sorted = (entries: readonly AppTemplateParameterEntry[]): AppTemplateParameterEntry[] => [...entries].sort(byKey);

/** validateAppTemplateSource; not ok → throws customerIssuesError(errors) (one STACK_TEMPLATE_INVALID detail, H11). */
export function validatedSpec(source: string, options: AppTemplateValidationOptions): AppTemplateSpec {
  const result = validateAppTemplateSource(source, options);
  if (!result.ok) throw customerIssuesError(result.errors);
  return result.spec;
}

/** app_stack_parameters rows → entries sorted by key (value = public_value). */
export function entriesOf(rows: readonly AppStackParameterRow[]): AppTemplateParameterEntry[] {
  return sorted(rows.map((row) => ({ key: row.parameterKey, value: row.publicValue })));
}

/** Stored entries whose key is a customer, non-secret parameter of `spec` (upgrade without explicit parameters). */
export function carryOverParameters(spec: AppTemplateSpec, stored: readonly AppTemplateParameterEntry[]): AppTemplateParameterEntry[] {
  const keys = new Set(spec.parameters.filter((p) => p.type !== "secret" && p.customer).map((p) => p.key));
  return stored.filter((entry) => keys.has(entry.key));
}

/** Latest version per parameter key. */
export function secretVersionsOf(meta: readonly AppStackSecretMetadata[]): Map<string, number> {
  const versions = new Map<string, number>();
  for (const { parameterKey, version } of meta) versions.set(parameterKey, Math.max(version, versions.get(parameterKey) ?? 0));
  return versions;
}

/** compileAppStackPlan; not ok → throws customerIssuesError(issues). Entries are sorted by key before compiling. */
export function compileRevision(
  input: AppStackCompileInput,
  options: AppTemplateValidationOptions,
): { readonly plan: ApprovedStackPlan; readonly revision: NewAppStackRevision; readonly entries: AppTemplateParameterEntry[] } {
  const entries = sorted(input.parameters);
  const result = compileAppStackPlan({ ...input, parameters: entries }, options);
  if (!result.ok) throw customerIssuesError(result.issues);
  return { plan: result.plan, revision: revisionFromPlan(result.plan, entries), entries };
}

/** NewAppStackRevision of a plan: ids from the plan, keys/totals from sumAppStackPlanResources, parameters (R1). */
export function revisionFromPlan(plan: ApprovedStackPlan, entries: readonly AppTemplateParameterEntry[]): NewAppStackRevision {
  const sum = sumAppStackPlanResources(plan);
  return {
    revisionId: plan.revisionId,
    templateVersionId: plan.templateVersionId,
    plan,
    planHash: plan.planHash,
    componentKeys: plan.components.map((c) => c.key),
    volumeKeys: plan.volumes.map((v) => v.key),
    cpuMilli: sum.cpuMilli,
    memoryBytes: Number(sum.memoryBytes),
    parameters: parameterValuesOf(entries),
  };
}

export function parameterValuesOf(entries: readonly AppTemplateParameterEntry[]): AppStackParameterValue[] {
  return sorted(entries).map(({ key, value }) => ({ parameterKey: key, value }));
}

export function entriesOfValues(values: readonly AppStackParameterValue[]): AppTemplateParameterEntry[] {
  return sorted(values.map(({ parameterKey, value }) => ({ key: parameterKey, value })));
}

/** canonicalRequestHash-equal after sorting by key. */
export function sameEntries(a: readonly AppTemplateParameterEntry[], b: readonly AppTemplateParameterEntry[]): boolean {
  return canonicalRequestHash(sorted(a)) === canonicalRequestHash(sorted(b));
}

/** Domain rows whose (componentKey, internalPort) is not an ingress pair of the plan. */
export function domainTargetsMissing(
  domains: readonly AppStackDomainRow[],
  ingress: readonly { componentKey: string; port: number }[],
): AppStackDomainRow[] {
  return domains.filter((d) => !ingress.some((i) => i.componentKey === d.componentKey && i.port === d.internalPort));
}

/** Domain rows with a path rule (ADR-0037) whose (componentKey, port) is not an ingress pair of the plan. */
export function pathTargetsMissing(
  domains: readonly AppStackDomainRow[],
  ingress: readonly { componentKey: string; port: number }[],
): AppStackDomainRow[] {
  return domains.filter((d) => d.pathRoutes.some((p) => !ingress.some((i) => i.componentKey === p.componentKey && i.port === p.port)));
}
