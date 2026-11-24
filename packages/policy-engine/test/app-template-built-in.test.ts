/**
 * The built-in application templates (ADR-0035): the sources the platform seeds are valid with the code allowlist and
 * compile with their defaults to the plans the acceptance scripts expect.
 */
import { describe, expect, it } from "vitest";
import {
  APP_BUILT_IN_TEMPLATES,
  ApprovedStackPlanSchema,
  appStackComponentProfile,
  appStackComponentSecretEnvironment,
  appStackComponentSecretRefs,
  appStackPlanImageProblems,
  appStackPlanSecretRefs,
  appTemplateHiddenSecretKeys,
  appTemplateInstallParameters,
  appTemplateSecretGenerate,
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
/** The seeds of the first format (ADR-0035); the WordPress one is of the extended format (ADR-0036). */
const FIRST_FORMAT = APP_BUILT_IN_TEMPLATES.filter((t) => t.slug !== "wordpress-mariadb");
const WORDPRESS_SECRETS = new Map([
  ["db_password", 1],
  ["db_root_password", 1],
]);

describe("the built-in application templates", () => {
  it.each(FIRST_FORMAT.map((t) => [t.slug, t] as const))("%s validates with the default allowlist only", (_slug, t) => {
    expect(validateAppTemplateSource(t.source).ok).toBe(true);
    const refused = validateAppTemplateSource(t.source, { allowlist: [] });
    if (refused.ok) throw new Error("expected the empty allowlist to refuse");
    const imagePaths = [...t.source.matchAll(/^ {2}([a-z][a-z0-9_-]*):\n {4}image: /gm)].map((m) => `services.${m[1]}.image`);
    expect(imagePaths).toHaveLength(2);
    expect(refused.errors.filter((e) => e.reason === "STACK_IMAGE_NOT_ALLOWED").map((e) => e.path).sort()).toEqual(imagePaths.sort());
  });

  it.each(FIRST_FORMAT.map((t) => [t.slug, t] as const))("%s compiles with its defaults to a valid, allowlisted, hashed plan", (_slug, t) => {
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

  it.each(FIRST_FORMAT.map((t) => [t.slug, t] as const))("%s compiles byte-identically 20 times", (_slug, t) => {
    const runs = new Set(Array.from({ length: 20 }, () => JSON.stringify(planOf(t))));
    expect(runs.size).toBe(1);
  });

  describe("wordpress-mariadb (extended format)", () => {
    const t = seed("wordpress-mariadb");
    const wordpress = (secretVersions: ReadonlyMap<string, number> = WORDPRESS_SECRETS) =>
      compileAppStackPlan({
        source: t.source,
        parameters: [],
        secretVersions,
        ids: {
          stackId: "stk_0123456789abcdef0123456789abcdef",
          organizationId: "org_acme",
          hostAllocationId: "alloc_0123456789abcdef0123456789abcdef",
          templateVersionId: t.versionId,
          revisionId: "srev_0123456789abcdef0123456789abcdef",
        },
      });
    const plan = (): ApprovedStackPlan => {
      const result = wordpress();
      if (!result.ok) throw new Error(`expected a plan, got ${JSON.stringify(result.issues)}`);
      return result.plan;
    };

    it("validates with any allowlist: its images are pinned by digest and need no row", () => {
      for (const options of [undefined, { allowlist: [] }]) {
        const result = validateAppTemplateSource(t.source, options);
        if (!result.ok) throw new Error(JSON.stringify(result.errors));
        expect(result.spec.schemaVersion).toBe(2);
        expect(result.spec.parameters.map((p) => [p.key, p.type, p.customer])).toEqual([
          ["db_password", "secret", false],
          ["db_root_password", "secret", false],
        ]);
        expect(appTemplateInstallParameters(result.spec.parameters)).toEqual([]);
        expect([...appTemplateHiddenSecretKeys(result.spec.parameters)]).toEqual(["db_password", "db_root_password"]);
        expect(result.spec.parameters.map((p) => appTemplateSecretGenerate(p))).toEqual([
          { kind: "password", length: 32 },
          { kind: "password", length: 32 },
        ]);
      }
    });

    it("needs both generated secrets before it compiles", () => {
      const result = wordpress(new Map());
      expect(result.ok ? [] : result.issues.map((i) => i.path).sort()).toEqual(["parameters.db_password", "parameters.db_root_password"]);
    });

    it("compiles to a valid, hashed plan of the second version: database first, both on the standard profile", () => {
      const p = plan();
      expect(ApprovedStackPlanSchema.safeParse(p).success).toBe(true);
      expect(verifyAppStackPlanHash(p)).toBe(true);
      expect(appStackPlanImageProblems(p)).toEqual([]);
      expect(p.schemaVersion).toBe(2);
      expect(p.components.map((c) => [c.key, appStackComponentProfile(c), c.runAsUser, c.argv])).toEqual([
        ["db", "standard", null, null],
        ["wordpress", "standard", null, null],
      ]);
      expect(p.components.map((c) => c.image)).toEqual([
        "mariadb@sha256:4aaf88b3106382c8c18e49f0cec60267be618fc22f858c4503afb2a2555afed3",
        "wordpress@sha256:4bf2c44f19a5eba28de4e5cbe50e1c5dc55ae3f8b894f681f4d7676a7e2512e5",
      ]);
      expect(component(p, "wordpress")?.dependsOn).toEqual(["db"]);
      expect(p.volumes).toEqual([{ key: "database" }, { key: "site" }]);
      expect(component(p, "db")?.volumes).toEqual([{ volumeKey: "database", containerPath: "/var/lib/mysql", readOnly: false }]);
      expect(component(p, "wordpress")?.volumes).toEqual([{ volumeKey: "site", containerPath: "/var/www/html", readOnly: false }]);
      expect(p.ingress).toEqual([{ componentKey: "wordpress", port: 80 }]);
      expect(p.components.map((c) => c.healthcheck)).toEqual([
        { kind: "tcp", port: 3306, intervalSeconds: 15, timeoutSeconds: 3 },
        { kind: "tcp", port: 80, intervalSeconds: 15, timeoutSeconds: 3 },
      ]);
      expect(sumAppStackPlanResources(p)).toEqual({ components: 2, cpuMilli: 2000, memoryBytes: "1073741824" });
    });

    it("gives the passwords only as environment secrets pinned by version: the plan holds names, never a value", () => {
      const p = plan();
      expect(p.components.every((c) => c.secretFiles.length === 0)).toBe(true);
      expect(component(p, "db")?.environment).toEqual([
        { name: "MARIADB_DATABASE", value: "wordpress" },
        { name: "MARIADB_USER", value: "wordpress" },
      ]);
      expect(component(p, "wordpress")?.environment).toEqual([
        { name: "WORDPRESS_DB_HOST", value: "db" },
        { name: "WORDPRESS_DB_NAME", value: "wordpress" },
        { name: "WORDPRESS_DB_USER", value: "wordpress" },
      ]);
      expect(appStackComponentSecretEnvironment(component(p, "db")!)).toEqual([
        { name: "MARIADB_PASSWORD", pieces: [{ parameterKey: "db_password", version: 1 }] },
        { name: "MARIADB_ROOT_PASSWORD", pieces: [{ parameterKey: "db_root_password", version: 1 }] },
      ]);
      expect(appStackComponentSecretEnvironment(component(p, "wordpress")!)).toEqual([
        { name: "WORDPRESS_DB_PASSWORD", pieces: [{ parameterKey: "db_password", version: 1 }] },
      ]);
      expect(appStackPlanSecretRefs(p)).toEqual([
        { parameterKey: "db_password", version: 1 },
        { parameterKey: "db_root_password", version: 1 },
      ]);
      expect(appStackComponentSecretRefs(component(p, "wordpress")!)).toEqual([{ parameterKey: "db_password", version: 1 }]);
    });

    it("compiles byte-identically 20 times, and a new secret version changes the plan", () => {
      expect(new Set(Array.from({ length: 20 }, () => JSON.stringify(plan()))).size).toBe(1);
      const next = wordpress(new Map([...WORDPRESS_SECRETS, ["db_password", 2]]));
      if (!next.ok) throw new Error(JSON.stringify(next.issues));
      expect(next.plan.planHash).not.toBe(plan().planHash);
    });
  });
});
