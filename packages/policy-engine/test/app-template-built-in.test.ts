/**
 * The built-in application templates (ADR-0035): the sources the platform seeds are valid with the code allowlist and
 * compile with their defaults to the plans the acceptance scripts expect.
 */
import { describe, expect, it } from "vitest";
import {
  APP_BUILT_IN_TEMPLATES,
  ApprovedStackPlanSchema,
  appStackPlanImageProblems,
  sumAppStackPlanResources,
  type AppBuiltInTemplate,
  type AppTemplateParameterEntry,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import { verifyAppStackPlanHash } from "@hosting-panel/hosting-domain";
import { compileAppStackPlan } from "../src/app-template-compile.js";
import { validateAppTemplateSource } from "../src/app-template-validation.js";

const seed = (slug: string): AppBuiltInTemplate => {
  const found = APP_BUILT_IN_TEMPLATES.find((t) => t.slug === slug);
  if (!found) throw new Error(`no built-in template ${slug}`);
  return found;
};
const compile = (t: AppBuiltInTemplate, parameters: readonly AppTemplateParameterEntry[] = []) =>
  compileAppStackPlan({
    source: t.source,
    parameters,
    secretVersions: new Map(),
    ids: {
      stackId: "stk_0123456789abcdef0123456789abcdef",
      organizationId: "org_acme",
      hostAllocationId: "alloc_0123456789abcdef0123456789abcdef",
      templateVersionId: t.versionId,
      revisionId: "srev_0123456789abcdef0123456789abcdef",
    },
  });
const planOf = (t: AppBuiltInTemplate, parameters?: readonly AppTemplateParameterEntry[]): ApprovedStackPlan => {
  const result = compile(t, parameters);
  if (!result.ok) throw new Error(`expected a plan, got ${JSON.stringify(result.issues)}`);
  return result.plan;
};
const component = (plan: ApprovedStackPlan, key: string) => plan.components.find((c) => c.key === key);

describe("the built-in application templates", () => {
  it.each(APP_BUILT_IN_TEMPLATES.map((t) => [t.slug, t] as const))("%s validates with the default allowlist only", (_slug, t) => {
    expect(validateAppTemplateSource(t.source).ok).toBe(true);
    const refused = validateAppTemplateSource(t.source, { allowlist: [] });
    if (refused.ok) throw new Error("expected the empty allowlist to refuse");
    const imagePaths = [...t.source.matchAll(/^ {2}([a-z][a-z0-9_-]*):\n {4}image: /gm)].map((m) => `services.${m[1]}.image`);
    expect(imagePaths).toHaveLength(2);
    expect(refused.errors.filter((e) => e.reason === "STACK_IMAGE_NOT_ALLOWED").map((e) => e.path).sort()).toEqual(imagePaths.sort());
  });

  it.each(APP_BUILT_IN_TEMPLATES.map((t) => [t.slug, t] as const))("%s compiles with its defaults to a valid, allowlisted, hashed plan", (_slug, t) => {
    const plan = planOf(t);
    expect(ApprovedStackPlanSchema.safeParse(plan).success).toBe(true);
    expect(appStackPlanImageProblems(plan)).toEqual([]);
    expect(verifyAppStackPlanHash(plan)).toBe(true);
    expect(plan.components.every((c) => c.secretFiles.length === 0)).toBe(true);
  });

  it("http-cache: cache before web, memcached argv, bounded memory, web is the only ingress", () => {
    const t = seed("http-cache");
    const plan = planOf(t);
    expect(plan.components.map((c) => c.key)).toEqual(["cache", "web"]);
    expect(component(plan, "cache")?.argv).toEqual(["memcached", "-m", "48", "-c", "256"]);
    expect(plan.components.map((c) => c.runAsUser)).toEqual([null, null]);
    expect(plan.volumes).toEqual([]);
    expect(plan.ingress).toEqual([{ componentKey: "web", port: 8080 }]);
    expect(sumAppStackPlanResources(plan)).toEqual({ components: 2, cpuMilli: 500, memoryBytes: "201326592" });
    expect(component(planOf(t, [{ key: "cache_memory_mb", value: 96 }]), "cache")?.argv).toEqual(["memcached", "-m", "96", "-c", "256"]);
    for (const value of [97, 15]) {
      const result = compile(t, [{ key: "cache_memory_mb", value }]);
      expect(result.ok ? [] : result.issues.map((i) => [i.path, i.code])).toEqual([["parameters.cache_memory_mb", "PARAM_VALUE_OUT_OF_RANGE"]]);
    }
  });

  it("worker-storage: storage before worker, forced user, interval in argv, data volume read-write, no ingress", () => {
    const plan = planOf(seed("worker-storage"));
    expect(plan.components.map((c) => c.key)).toEqual(["storage", "worker"]);
    expect(plan.components.map((c) => c.runAsUser)).toEqual(["999:1000", "999:1000"]);
    expect(component(plan, "worker")?.argv).toEqual(["valkey-cli", "-h", "storage", "-p", "6379", "-r", "-1", "-i", "30", "INCR", "worker:ticks"]);
    expect(component(plan, "storage")?.volumes).toEqual([{ volumeKey: "data", containerPath: "/data", readOnly: false }]);
    expect(component(plan, "worker")?.volumes).toEqual([]);
    expect(plan.volumes).toEqual([{ key: "data" }]);
    expect(plan.ingress).toEqual([]);
    expect(sumAppStackPlanResources(plan)).toEqual({ components: 2, cpuMilli: 600, memoryBytes: "167772160" });
  });

  it.each(APP_BUILT_IN_TEMPLATES.map((t) => [t.slug, t] as const))("%s compiles byte-identically 20 times", (_slug, t) => {
    const runs = new Set(Array.from({ length: 20 }, () => JSON.stringify(planOf(t))));
    expect(runs.size).toBe(1);
  });
});
