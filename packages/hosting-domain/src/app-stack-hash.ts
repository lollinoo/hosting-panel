import { createHash } from "node:crypto";
import {
  appStackComponentHashInput,
  appStackPlanHashInput,
  canonicalAppStackJson,
  type AppStackPlanHashSource,
  type AppTemplateSpec,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";

const sha256Hex = (value: unknown): string =>
  createHash("sha256").update(canonicalAppStackJson(value), "utf8").digest("hex");

/** app_stack_revisions.plan_hash. */
export function computeAppStackPlanHash(plan: AppStackPlanHashSource): string {
  return sha256Hex(appStackPlanHashInput(plan));
}

export function verifyAppStackPlanHash(plan: ApprovedStackPlan): boolean {
  return computeAppStackPlanHash(plan) === plan.planHash;
}

/** Container label value: an equal hash means the running container already matches. */
export function computeAppStackComponentHash(
  plan: Pick<ApprovedStackPlan, "schemaVersion" | "components" | "ingress">,
  componentKey: string,
): string {
  const input = appStackComponentHashInput(plan, componentKey);
  if (input === null) throw new RangeError(`Unknown stack component: ${componentKey}`);
  return sha256Hex(input);
}

/** app_template_versions.spec_hash. */
export function computeAppTemplateSpecHash(spec: AppTemplateSpec): string {
  return sha256Hex(spec);
}
