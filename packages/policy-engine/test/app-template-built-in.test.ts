/**
 * The built-in application templates (ADR-0035): the sources the platform seeds are valid with the code allowlist and
 * compile with their defaults to the plans the acceptance scripts expect.
 */
import { describe, expect, it } from "vitest";
import {
  APP_BUILT_IN_TEMPLATES,
  APP_DATABASE_TEMPLATE_CATEGORY,
  ApprovedStackPlanSchema,
  appStackComponentProfile,
  appStackComponentSecretEnvironment,
  appStackComponentSecretRefs,
  appStackLinkTarget,
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
import { computeAppTemplateSpecHash, verifyAppStackPlanHash } from "@hosting-panel/hosting-domain";
import { compileAppStackPlan } from "../src/app-template-compile.js";
import { validateAppTemplateSource } from "../src/app-template-validation.js";

const seed = (slug: string): AppBuiltInTemplate => {
  const found = APP_BUILT_IN_TEMPLATES.find((t) => t.slug === slug);
  if (!found) throw new Error(`no built-in template ${slug}`);
  return found;
};
/** The reserved values each database asks the customer for; every other seed asks for none. */
const SECRET_KEYS: Readonly<Record<string, readonly string[]>> = { mariadb: ["admin_password", "database_password"], postgresql: ["database_password"] };
const isDatabase = (t: AppBuiltInTemplate) => t.category === APP_DATABASE_TEMPLATE_CATEGORY;
const compile = (t: AppBuiltInTemplate, parameters: readonly AppTemplateParameterEntry[] = [], withSecrets = true) =>
  compileAppStackPlan({
    source: t.source,
    parameters,
    secretVersions: new Map(withSecrets ? (SECRET_KEYS[t.slug] ?? []).map((key) => [key, 1]) : []),
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
/** The template as one of its earlier versions was shipped: the id and the source of that version. */
const earlierVersion = (t: AppBuiltInTemplate, index = 0): AppBuiltInTemplate => {
  const found = t.previousVersions?.[index];
  if (!found) throw new Error(`no earlier version ${index} of ${t.slug}`);
  return { ...t, versionId: found.versionId, source: found.source };
};
/** The seeds of the first format (ADR-0035); the WordPress one is of the extended format (ADR-0036). */
const FIRST_FORMAT = APP_BUILT_IN_TEMPLATES.filter((t) => t.slug !== "wordpress-mariadb");
const WORDPRESS_SECRETS = new Map([
  ["db_password", 1],
  ["db_root_password", 1],
]);
/** WORDPRESS_CONFIG_EXTRA as PHP reads it (one line): the site's address is the name it is asked by, lower-cased, when
 *  that is a host name with a letter or digit at both ends and an optional port; its variable does not outlive it. */
const CONFIG_EXTRA =
  "$hcp_host = isset($_SERVER['HTTP_HOST']) ? strtolower($_SERVER['HTTP_HOST']) : ''; if (preg_match('/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/D', $hcp_host)) { define('WP_HOME', ((isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') ? 'https' : 'http') . '://' . $hcp_host); define('WP_SITEURL', WP_HOME); } unset($hcp_host);";
const UPLOADS_ARGV = ["apache2-foreground", "-c", "php_value upload_max_filesize 64M", "-c", "php_value post_max_size 64M"];

describe("the built-in application templates", () => {
  it.each(FIRST_FORMAT.map((t) => [t.slug, t] as const))("%s validates with the default allowlist only", (_slug, t) => {
    expect(validateAppTemplateSource(t.source).ok).toBe(true);
    const refused = validateAppTemplateSource(t.source, { allowlist: [] });
    if (refused.ok) throw new Error("expected the empty allowlist to refuse");
    const imagePaths = [...t.source.matchAll(/^ {2}([a-z][a-z0-9_-]*):\n {4}image: /gm)].map((m) => `services.${m[1]}.image`);
    expect(imagePaths).toHaveLength(isDatabase(t) ? 1 : 2);
    expect(refused.errors.filter((e) => e.reason === "STACK_IMAGE_NOT_ALLOWED").map((e) => e.path).sort()).toEqual(imagePaths.sort());
  });

  it.each(FIRST_FORMAT.map((t) => [t.slug, t] as const))("%s compiles with its defaults to a valid, allowlisted, hashed plan", (_slug, t) => {
    const plan = planOf(t);
    expect(ApprovedStackPlanSchema.safeParse(plan).success).toBe(true);
    expect(appStackPlanImageProblems(plan)).toEqual([]);
    expect(verifyAppStackPlanHash(plan)).toBe(true);
    expect(plan.components.flatMap((c) => c.secretFiles.map((f) => f.parameterKey)).sort()).toEqual([...(SECRET_KEYS[t.slug] ?? [])]);
  });

  it("mariadb: one component as 999:999, socket and pid file under /tmp, temporary files on the data area, passwords as files, no address", () => {
    const plan = planOf(seed("mariadb"));
    expect(plan.components.map((c) => c.key)).toEqual(["db"]);
    const db = component(plan, "db");
    expect(db?.image).toBe("docker.io/library/mariadb@sha256:4aaf88b3106382c8c18e49f0cec60267be618fc22f858c4503afb2a2555afed3");
    expect(db?.runAsUser).toBe("999:999");
    expect(db?.argv).toEqual(["mariadbd", "--socket=/tmp/mysqld.sock", "--pid-file=/tmp/mysqld.pid", "--tmpdir=/var/lib/mysql"]);
    expect(db?.environment).toEqual([
      { name: "MARIADB_DATABASE", value: "app" },
      { name: "MARIADB_ROOT_HOST", value: "localhost" },
      { name: "MARIADB_USER", value: "app" },
    ]);
    expect(db?.secretFiles).toEqual([
      { envName: "MARIADB_PASSWORD_FILE", parameterKey: "database_password", version: 1 },
      { envName: "MARIADB_ROOT_PASSWORD_FILE", parameterKey: "admin_password", version: 1 },
    ]);
    expect(db?.volumes).toEqual([{ volumeKey: "data", containerPath: "/var/lib/mysql", readOnly: false }]);
    expect(db?.expose).toEqual([3306]);
    expect(db?.healthcheck).toMatchObject({ kind: "tcp", port: 3306 });
    expect(plan.ingress).toEqual([]);
    expect(sumAppStackPlanResources(plan)).toEqual({ components: 1, cpuMilli: 1000, memoryBytes: "536870912" });
  });

  it("postgresql: one component as 999:999, the password as a file, no address", () => {
    const plan = planOf(seed("postgresql"));
    expect(plan.components.map((c) => c.key)).toEqual(["db"]);
    const db = component(plan, "db");
    expect(db?.image).toBe("docker.io/library/postgres@sha256:194e55feb2597b1465dbee81cc9fd8d204566cd2eb42c8d22fd6c931a38781b1");
    expect(db?.runAsUser).toBe("999:999");
    expect(db?.argv).toEqual(["postgres"]);
    expect(db?.environment).toEqual([
      { name: "POSTGRES_DB", value: "app" },
      { name: "POSTGRES_USER", value: "app" },
    ]);
    expect(db?.secretFiles).toEqual([{ envName: "POSTGRES_PASSWORD_FILE", parameterKey: "database_password", version: 1 }]);
    expect(db?.volumes).toEqual([{ volumeKey: "data", containerPath: "/var/lib/postgresql", readOnly: false }]);
    expect(db?.expose).toEqual([5432]);
    expect(plan.ingress).toEqual([]);
    expect(sumAppStackPlanResources(plan)).toEqual({ components: 1, cpuMilli: 1000, memoryBytes: "536870912" });
  });

  it("valkey: one component as 999:1000, bounded memory below the limit, nothing asked to the customer", () => {
    const plan = planOf(seed("valkey"));
    expect(plan.components.map((c) => c.key)).toEqual(["db"]);
    const db = component(plan, "db");
    expect(db?.runAsUser).toBe("999:1000");
    expect(db?.argv).toEqual(["valkey-server", "--appendonly", "yes", "--dir", "/data", "--maxmemory", "256mb", "--maxmemory-policy", "noeviction", "--protected-mode", "no"]);
    expect(db?.environment).toEqual([]);
    expect(db?.secretFiles).toEqual([]);
    expect(db?.volumes).toEqual([{ volumeKey: "data", containerPath: "/data", readOnly: false }]);
    expect(db?.expose).toEqual([6379]);
    expect(plan.ingress).toEqual([]);
    // The ceiling is 256 MB and the limit 512 MB: the process and its buffers need room above what it may hold.
    expect(sumAppStackPlanResources(plan)).toEqual({ components: 1, cpuMilli: 500, memoryBytes: "536870912" });
  });

  it.each(APP_BUILT_IN_TEMPLATES.filter((t) => isDatabase(t) && t.previousVersions !== undefined).map((t) => [t.slug, t] as const))(
    "%s: every earlier version still validates and compiles to a valid, allowlisted, hashed plan of its own version",
    (_slug, t) => {
      expect(t.previousVersions?.length).toBeGreaterThan(0);
      t.previousVersions?.forEach((v, index) => {
        const first = earlierVersion(t, index);
        expect(validateAppTemplateSource(first.source).ok, v.versionId).toBe(true);
        const plan = planOf(first);
        expect(plan.templateVersionId).toBe(v.versionId);
        expect(ApprovedStackPlanSchema.safeParse(plan).success, v.versionId).toBe(true);
        expect(appStackPlanImageProblems(plan), v.versionId).toEqual([]);
        expect(verifyAppStackPlanHash(plan), v.versionId).toBe(true);
      });
    },
  );

  it("mariadb: version 1 compiles as it did, with no temporary directory; version 2 differs from it in that argument only", () => {
    const t = seed("mariadb");
    const [before, after] = [planOf(earlierVersion(t)), planOf(t)];
    expect(component(before, "db")?.argv).toEqual(["mariadbd", "--socket=/tmp/mysqld.sock", "--pid-file=/tmp/mysqld.pid"]);
    expect(component(after, "db")?.argv).toEqual([...component(before, "db")!.argv!, "--tmpdir=/var/lib/mysql"]);
    expect({ ...component(after, "db")!, argv: null }).toEqual({ ...component(before, "db")!, argv: null });
    expect(after.volumes).toEqual(before.volumes);
    expect(sumAppStackPlanResources(after)).toEqual(sumAppStackPlanResources(before));
  });

  it("valkey: version 1 compiles as it did, with 384 MB; version 2 differs from it in the memory limit only", () => {
    const t = seed("valkey");
    const [before, after] = [planOf(earlierVersion(t)), planOf(t)];
    expect(sumAppStackPlanResources(before)).toEqual({ components: 1, cpuMilli: 500, memoryBytes: "402653184" });
    expect(sumAppStackPlanResources(after)).toEqual({ components: 1, cpuMilli: 500, memoryBytes: "536870912" });
    expect(component(after, "db")?.argv).toEqual(component(before, "db")?.argv);
    expect(component(after, "db")?.argv).toContain("256mb");
    const rest = (plan: ApprovedStackPlan) => ({ ...component(plan, "db")!, resources: null });
    expect(rest(after)).toEqual(rest(before));
    expect(component(after, "db")?.resources.cpuMilli).toBe(component(before, "db")?.resources.cpuMilli);
    expect(after.volumes).toEqual(before.volumes);
  });

  it.each(["mariadb", "postgresql"])("%s does not compile until the customer has set its passwords", (slug) => {
    const result = compile(seed(slug), [], false);
    expect(result.ok ? [] : result.issues.map((i) => [i.path, i.code])).toEqual((SECRET_KEYS[slug] ?? []).map((key) => [`parameters.${key}`, "SECRET_MISSING"]));
  });

  it.each(APP_BUILT_IN_TEMPLATES.filter(isDatabase).map((t) => [t.slug, t] as const))("%s is something an application can be linked to", (_slug, t) => {
    expect(appStackLinkTarget(planOf(t).components)).toEqual({ componentKey: "db", port: planOf(t).components[0]?.expose[0] });
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
    const earlier = () => t.previousVersions![0]!;
    const wordpress = (secretVersions: ReadonlyMap<string, number> = WORDPRESS_SECRETS, version: { source: string; versionId: string } = t) =>
      compileAppStackPlan({
        source: version.source,
        parameters: [],
        secretVersions,
        ids: {
          stackId: "stk_0123456789abcdef0123456789abcdef",
          organizationId: "org_acme",
          hostAllocationId: "alloc_0123456789abcdef0123456789abcdef",
          templateVersionId: version.versionId,
          revisionId: "srev_0123456789abcdef0123456789abcdef",
        },
      });
    const plan = (version: { source: string; versionId: string } = t): ApprovedStackPlan => {
      const result = wordpress(WORDPRESS_SECRETS, version);
      if (!result.ok) throw new Error(`expected a plan, got ${JSON.stringify(result.issues)}`);
      return result.plan;
    };

    it("version 1 still validates to the same spec, and compiles without a command or a config line", () => {
      const first = earlier();
      const result = validateAppTemplateSource(first.source);
      if (!result.ok) throw new Error(JSON.stringify(result.errors));
      expect(first.versionId).toBe("atv_wordpress_mariadb_1");
      expect(computeAppTemplateSpecHash(result.spec)).toBe("78625e4ec918338d8c20b88ce42f1ec366f065412d0b1a190ee211a886bf42eb");
      const p = plan(first);
      expect(p.templateVersionId).toBe("atv_wordpress_mariadb_1");
      expect(p.components.map((c) => [c.key, c.argv])).toEqual([
        ["db", null],
        ["wordpress", null],
      ]);
      expect(component(p, "wordpress")?.environment.map((e) => e.name)).toEqual(["WORDPRESS_DB_HOST", "WORDPRESS_DB_NAME", "WORDPRESS_DB_USER"]);
    });

    it("version 2 differs from version 1 only in the wordpress component: same parameters, volumes, address and database", () => {
      const first = earlier();
      const [before, after] = [plan(first), plan()];
      const [specBefore, specAfter] = [validateAppTemplateSource(first.source), validateAppTemplateSource(t.source)];
      if (!specBefore.ok || !specAfter.ok) throw new Error("expected both versions to validate");
      expect(specAfter.spec.parameters).toEqual(specBefore.spec.parameters);
      expect(after.volumes).toEqual(before.volumes);
      expect(after.ingress).toEqual(before.ingress);
      expect(component(after, "db")).toEqual(component(before, "db"));
      expect(component(after, "wordpress")).not.toEqual(component(before, "wordpress"));
      expect({ ...component(after, "wordpress")!, argv: null, environment: component(before, "wordpress")!.environment }).toEqual(component(before, "wordpress"));
    });

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
        // The uploads limit is set on the command line of the image's own start program: no file to write, no shell.
        ["wordpress", "standard", null, UPLOADS_ARGV],
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
        { name: "WORDPRESS_CONFIG_EXTRA", value: CONFIG_EXTRA },
        { name: "WORDPRESS_DB_HOST", value: "db" },
        { name: "WORDPRESS_DB_NAME", value: "wordpress" },
        { name: "WORDPRESS_DB_USER", value: "wordpress" },
      ]);
      // One line, no other constant, nothing the customer typed.
      expect(CONFIG_EXTRA).not.toContain("\n");
      expect([...CONFIG_EXTRA.matchAll(/define\('([A-Z_]+)'/g)].map((m) => m[1])).toEqual(["WP_HOME", "WP_SITEURL"]);
      expect(CONFIG_EXTRA).not.toMatch(/eval|\$\{|\$\$/);
      // The line runs in the global scope of every request: what it assigns, it unsets at the end.
      const assigned = [...CONFIG_EXTRA.matchAll(/(\$[a-z_]+) = /g)].map((m) => m[1]);
      expect(assigned).toEqual(["$hcp_host"]);
      expect(CONFIG_EXTRA.endsWith(` unset(${assigned.join(", ")});`)).toBe(true);
      // Its variable is not named like a platform object, which a real-Docker acceptance gate refuses in a request.
      expect(CONFIG_EXTRA).not.toMatch(/(?<![A-Za-z0-9])hp_/);
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

    it("takes the site's address from a Host that is a host name with an optional port, lower-cased, and from nothing else", () => {
      // The pattern of the line as PHP's preg_match reads it ("D": "$" is the very end), after PHP's ASCII strtolower.
      const pattern = new RegExp(/preg_match\('\/(.+?)\/D'/.exec(CONFIG_EXTRA)![1]!);
      const takes = (host: string): boolean => pattern.test(host.replace(/[A-Z]/g, (c) => c.toLowerCase()));
      for (const host of ["wp.example.test", "WP.Example.TEST", "wp.example.test:8443", "a", "10.0.0.1:80", "x--y.test"]) {
        expect(takes(host), host).toBe(true);
      }
      for (const host of ["wp.example.test.", ".wp.example.test", "-wp.example.test", "wp.example.test-", "wp.example.test:",
        "wp.example.test:123456", "wp.example.test\n", "wp.example.test/x", "wp_x.test", "user@wp.example.test", "[::1]:80", ""]) {
        expect(takes(host), JSON.stringify(host)).toBe(false);
      }
    });

    it("compiles byte-identically 20 times, and a new secret version changes the plan", () => {
      expect(new Set(Array.from({ length: 20 }, () => JSON.stringify(plan()))).size).toBe(1);
      const next = wordpress(new Map([...WORDPRESS_SECRETS, ["db_password", 2]]));
      if (!next.ok) throw new Error(JSON.stringify(next.issues));
      expect(next.plan.planHash).not.toBe(plan().planHash);
    });
  });
});
