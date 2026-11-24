/**
 * Compose importer (ADR-0036, spec §7) on whole files: each fixture imports to a draft the template validator accepts,
 * with the services, parameters, volumes, ingress and report the rules promise. The fixtures are written for this
 * repository from the public documentation of the images; their digests are made up.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTemplateYaml, type AppTemplateSpec } from "@hosting-panel/contracts";
import { validateAppTemplateSource } from "../src/app-template-validation.js";
import {
  COMPOSE_IMPORT_CODES,
  COMPOSE_IMPORT_DEFAULT_CATEGORY,
  COMPOSE_IMPORT_DEFAULT_NAME,
  COMPOSE_IMPORT_KEY_LEVELS,
  COMPOSE_IMPORT_REPORT_MAX,
  importComposeToAppTemplate,
  listComposeImages,
  type ComposeImportCode,
  type ComposeImportResult,
} from "../src/index.js";

const digest = (n: number): string => `sha256:${n.toString(16).padStart(2, "0").repeat(32)}`;

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/compose-import/${name}.yml`, import.meta.url), "utf8");

/** Imports a file with a digest resolved for every image it lists: the n-th listed image gets `digest(n)`. */
const run = (compose: string, header: { name?: string; category?: string } = {}): ComposeImportResult =>
  importComposeToAppTemplate({ compose, ...header, digests: new Map(listComposeImages(compose).map((image, index) => [image, digest(index + 1)])) });

const notes = (result: ComposeImportResult): string[] => result.report.map((note) => `${note.level} ${note.code} ${note.path}`);

/** The draft as the validator reads it; fails the test when the importer refused the file or the draft is not valid. */
function specOf(result: ComposeImportResult): AppTemplateSpec {
  if (!result.ok) throw new Error(`refused: ${notes(result).join("; ")}`);
  expect(parseTemplateYaml(result.source).ok).toBe(true);
  const checked = validateAppTemplateSource(result.source);
  if (!checked.ok) throw new Error(`draft not valid: ${checked.errors.map((issue) => `${issue.code} ${issue.path}`).join("; ")}`);
  return checked.spec;
}

const service = (spec: AppTemplateSpec, key: string): AppTemplateSpec["services"][number] => {
  const found = spec.services.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`no service ${key}`);
  return found;
};

const generated = (key: string, label: string, kind: string, length: number): object => ({
  key,
  label,
  type: "secret",
  required: true,
  customer: false,
  generate: { kind, length },
});

const FIXTURES = ["wordpress-mariadb", "literal-secrets", "tracker-postgres-redis"] as const;
const DEFAULT_LIMITS = { cpuMilli: 500, memoryBytes: "536870912" };

describe("WordPress with MariaDB", () => {
  const compose = fixture("wordpress-mariadb");
  const result = run(compose);

  it("lists the two images to resolve, in file order", () => {
    expect(listComposeImages(compose)).toEqual(["wordpress:6.8-apache", "mariadb:11.4"]);
  });

  it("imports to a draft the validator accepts, with the header of the comment lines", () => {
    const spec = specOf(result);
    expect(spec).toMatchObject({ schemaVersion: 2, name: "WordPress", category: "cms" });
    expect(spec.services.map((s) => [s.key, "profile" in s ? s.profile : "absent"])).toEqual([
      ["mariadb", "standard"],
      ["wordpress", "standard"],
    ]);
    expect(spec.volumes).toEqual([{ key: "mariadb-data" }, { key: "wordpress-data" }]);
    expect(spec.ingress).toEqual([{ service: "wordpress", port: 80 }]);
  });

  it("makes one generated secret per SERVICE_ variable and one parameter per ordinary variable", () => {
    expect(specOf(result).parameters).toEqual([
      generated("user_wordpress", "SERVICE_USER_WORDPRESS", "user", 16),
      generated("password_wordpress", "SERVICE_PASSWORD_WORDPRESS", "password", 32),
      { key: "wordpress_db_name", label: "WORDPRESS_DB_NAME", type: "string", default: "wordpress", customer: false },
      generated("password_root", "SERVICE_PASSWORD_ROOT", "password", 32),
    ]);
  });

  it("delivers the same database password to both services as an environment secret", () => {
    const spec = specOf(result);
    expect(service(spec, "wordpress").environment).toEqual([
      { name: "WORDPRESS_DB_HOST", value: "mariadb" },
      { name: "WORDPRESS_DB_USER", secretParameter: "user_wordpress" },
      { name: "WORDPRESS_DB_PASSWORD", secretParameter: "password_wordpress" },
      { name: "WORDPRESS_DB_NAME", value: "${wordpress_db_name}" },
      { name: "WORDPRESS_TABLE_PREFIX", value: "wp_" },
    ]);
    expect(service(spec, "mariadb").environment).toEqual([
      { name: "MARIADB_DATABASE", value: "${wordpress_db_name}" },
      { name: "MARIADB_USER", secretParameter: "user_wordpress" },
      { name: "MARIADB_PASSWORD", secretParameter: "password_wordpress" },
      { name: "MARIADB_ROOT_PASSWORD", secretParameter: "password_root" },
    ]);
  });

  it("converts the rest of each service", () => {
    const spec = specOf(result);
    expect(service(spec, "wordpress")).toMatchObject({
      image: { name: "wordpress", tag: "6.8-apache", digest: digest(1) },
      command: null,
      volumes: [{ volumeKey: "wordpress-data", containerPath: "/var/www/html", readOnly: false }],
      expose: [80],
      dependsOn: ["mariadb"],
      healthcheck: { kind: "http", port: 80, path: "/wp-login.php", intervalSeconds: 30, timeoutSeconds: 10 },
      limits: DEFAULT_LIMITS,
    });
    expect(service(spec, "mariadb")).toMatchObject({
      image: { name: "mariadb", tag: "11.4", digest: digest(2) },
      command: null,
      volumes: [{ volumeKey: "mariadb-data", containerPath: "/var/lib/mysql", readOnly: false }],
      expose: [3306],
      dependsOn: [],
      healthcheck: { kind: "tcp", port: 3306, intervalSeconds: 10, timeoutSeconds: 5 },
      limits: DEFAULT_LIMITS,
    });
  });

  it("reports everything it changed or dropped, in the order of the file", () => {
    expect(notes(result)).toEqual([
      "dropped KEY_DROPPED services.wordpress.restart",
      "dropped KEY_DROPPED services.mariadb.restart",
      "changed IMAGE_PINNED services.wordpress.image",
      "info SECRET_FROM_VARIABLE services.wordpress.environment.WORDPRESS_DB_USER",
      "info SECRET_FROM_VARIABLE services.wordpress.environment.WORDPRESS_DB_PASSWORD",
      "info PARAMETER_FROM_VARIABLE services.wordpress.environment.WORDPRESS_DB_NAME",
      "dropped ENV_URL_VARIABLE_DROPPED services.wordpress.environment.SITE_ADDRESS",
      "dropped PORTS_DROPPED services.wordpress.ports",
      "changed INGRESS_FROM_VARIABLE services.wordpress.environment.SITE_ADDRESS",
      "changed HEALTHCHECK_CONVERTED services.wordpress.healthcheck",
      "info LIMITS_DEFAULTED services.wordpress",
      "changed IMAGE_PINNED services.mariadb.image",
      "info SECRET_FROM_VARIABLE services.mariadb.environment.MARIADB_ROOT_PASSWORD",
      "changed HEALTHCHECK_CONVERTED services.mariadb.healthcheck",
      "info LIMITS_DEFAULTED services.mariadb",
      "info EXPOSE_ADDED services.mariadb.expose",
    ]);
  });

  it("writes the profile of every service in the source", () => {
    if (!result.ok) throw new Error("refused");
    expect(result.source.match(/^ {4}x-hp-profile: standard$/gm)).toHaveLength(2);
    expect(result.source.startsWith('x-hp-stack:\n  schemaVersion: 2\n  name: "WordPress"\n  category: "cms"\n')).toBe(true);
  });

  it("gives the same draft for the same input", () => {
    expect(run(compose)).toEqual(result);
  });

  it("refuses the file when a digest is missing", () => {
    const partial = importComposeToAppTemplate({ compose, digests: new Map([["wordpress:6.8-apache", digest(1)]]) });
    expect(partial.ok).toBe(false);
    expect("source" in partial).toBe(false);
    expect(notes(partial)).toContain("refused IMAGE_UNRESOLVED services.mariadb.image");
  });
});

describe("literal secrets in the environment", () => {
  const compose = fixture("literal-secrets");
  const result = run(compose);
  const LITERALS = ["correct-horse-battery-staple", "0f1e2d3c4b5a6978", "abcdefghijklmnopqrstuvwxyz012345", "relay-pass-1234"];

  it("lists both images", () => {
    expect(listComposeImages(compose)).toEqual(["registry.example.invalid/forum/app:3.2", "postgres:17"]);
  });

  it("replaces every literal secret by a generated secret parameter", () => {
    const spec = specOf(result);
    expect(spec).toMatchObject({ name: "Forum", category: "community" });
    expect(spec.parameters).toEqual([
      generated("forum_db_password", "FORUM_DB_PASSWORD", "password", 32),
      generated("forum_secret_key_base", "FORUM_SECRET_KEY_BASE", "password", 32),
      generated("forum_upstream_header", "FORUM_UPSTREAM_HEADER", "password", 32),
      generated("forum_mail_password", "FORUM_MAIL_PASSWORD", "password", 32),
    ]);
    expect(service(spec, "app").environment).toEqual([
      { name: "FORUM_DB_HOST", value: "db" },
      { name: "FORUM_DB_USER", value: "forum" },
      { name: "FORUM_DB_PASSWORD", secretParameter: "forum_db_password" },
      { name: "FORUM_SECRET_KEY_BASE", secretParameter: "forum_secret_key_base" },
      { name: "FORUM_UPSTREAM_HEADER", secretParameter: "forum_upstream_header" },
      { name: "FORUM_MAIL_URL", value: "smtp://mailer:${forum_mail_password}@mail.example.invalid:587" },
    ]);
  });

  it("gives the password written twice to both services through one parameter (list form)", () => {
    expect(service(specOf(result), "db").environment).toEqual([
      { name: "POSTGRES_USER", value: "forum" },
      { name: "POSTGRES_PASSWORD", secretParameter: "forum_db_password" },
      { name: "POSTGRES_DB", value: "forum" },
    ]);
  });

  it("says which variables it replaced, and which one it only took the password out of", () => {
    const replaced = result.report.filter((note) => note.code === "SECRET_GENERATED" || note.code === "SECRET_EXTRACTED");
    expect(replaced.map((note) => `${note.level} ${note.code} ${note.path}`)).toEqual([
      "changed SECRET_GENERATED services.app.environment.FORUM_DB_PASSWORD",
      "changed SECRET_GENERATED services.app.environment.FORUM_SECRET_KEY_BASE",
      "changed SECRET_GENERATED services.app.environment.FORUM_UPSTREAM_HEADER",
      "changed SECRET_EXTRACTED services.app.environment.FORUM_MAIL_URL",
      "changed SECRET_GENERATED services.db.environment[1]",
    ]);
    expect(replaced[0]?.message).toContain("FORUM_DB_PASSWORD");
    expect(replaced[3]?.message).toContain("FORUM_MAIL_URL");
    expect(replaced[4]?.message).toContain("POSTGRES_PASSWORD");
  });

  it("never shows a literal secret, in the draft or in the report", () => {
    const everything = JSON.stringify(result);
    for (const literal of LITERALS) {
      expect(compose).toContain(literal);
      expect(everything).not.toContain(literal);
    }
  });

  it("keeps the literal out of a refusal too", () => {
    const refused = importComposeToAppTemplate({ compose, digests: new Map() });
    expect(refused.ok).toBe(false);
    for (const literal of LITERALS) expect(JSON.stringify(refused)).not.toContain(literal);
  });

  it("renames a volume the platform cannot name, and adds no ingress or health check nobody asked for", () => {
    const spec = specOf(result);
    expect(spec.volumes).toEqual([{ key: "db-data" }]);
    expect(service(spec, "db").volumes).toEqual([{ volumeKey: "db-data", containerPath: "/var/lib/postgresql/data", readOnly: false }]);
    expect(notes(result)).toContain("changed VOLUME_RENAMED volumes.db_data");
    expect(service(spec, "app")).toMatchObject({ expose: [3000], healthcheck: null });
    expect(spec.ingress).toEqual([]);
  });
});

describe("tracker with PostgreSQL and Redis", () => {
  const compose = fixture("tracker-postgres-redis");
  const result = run(compose);

  it("lists only the images without a digest", () => {
    expect(listComposeImages(compose)).toEqual(["registry.example.invalid/acme/tracker:2.4.1", "postgres:17-alpine"]);
  });

  it("imports with the default header and one ingress entry", () => {
    const spec = specOf(result);
    expect(spec).toMatchObject({ name: COMPOSE_IMPORT_DEFAULT_NAME, category: COMPOSE_IMPORT_DEFAULT_CATEGORY });
    expect(spec.services.map((s) => [s.key, "profile" in s ? s.profile : "absent"])).toEqual([
      ["postgres", "standard"],
      ["redis", "standard"],
      ["web", "standard"],
    ]);
    expect(spec.volumes.map((volume) => volume.key)).toEqual(["pgdata", "redis-conf", "redis-data", "uploads"]);
    expect(spec.ingress).toEqual([{ service: "web", port: 8000 }]);
  });

  it("turns variables into parameters and SERVICE_ variables into generated secrets", () => {
    expect(specOf(result).parameters).toEqual([
      { key: "tracker_workers", label: "TRACKER_WORKERS", type: "string", default: "2", customer: false },
      generated("password_postgres", "SERVICE_PASSWORD_POSTGRES", "password", 32),
      generated("base64_64_session", "SERVICE_BASE64_64_SESSION", "base64", 64),
      { key: "log_level", label: "LOG_LEVEL", type: "string", default: "info", customer: false },
    ]);
  });

  it("converts the web service: command, mixed values, long-form mount, map-form dependencies, limits", () => {
    const web = service(specOf(result), "web");
    expect(web.command).toEqual(["tracker", "serve", "--port", "8000", "--workers", "${tracker_workers}"]);
    expect(web.environment).toEqual([
      { name: "TRACKER_DATABASE_URL", value: "postgres://tracker:${password_postgres}@postgres:5432/tracker" },
      { name: "TRACKER_REDIS_URL", value: "redis://redis:6379/0" },
      { name: "TRACKER_SESSION_SECRET", secretParameter: "base64_64_session" },
      { name: "TRACKER_LOG_LEVEL", value: "${log_level}" },
      { name: "TRACKER_PRICE_FORMAT", value: "$$%.2f" },
    ]);
    expect(web).toMatchObject({
      volumes: [{ volumeKey: "uploads", containerPath: "/srv/tracker/uploads", readOnly: false }],
      expose: [8000],
      dependsOn: ["postgres", "redis"],
      healthcheck: { kind: "http", port: 8000, path: "/healthz", intervalSeconds: 90, timeoutSeconds: 30 },
      limits: { cpuMilli: 1500, memoryBytes: "1073741824" },
    });
  });

  it("converts the database and the cache", () => {
    const spec = specOf(result);
    expect(service(spec, "postgres")).toMatchObject({
      image: { name: "postgres", tag: "17-alpine", digest: digest(2) },
      expose: [5432],
      healthcheck: { kind: "tcp", port: 5432, intervalSeconds: 5, timeoutSeconds: 3 },
      limits: { cpuMilli: 750, memoryBytes: String(768 * 1024 * 1024) },
    });
    expect(service(spec, "postgres").environment).toContainEqual({ name: "POSTGRES_PASSWORD", secretParameter: "password_postgres" });
    expect(service(spec, "redis")).toMatchObject({
      image: { name: "redis", tag: "7.4", digest: "sha256:5c1d7e2f9a3b4c6d8e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d" },
      command: ["redis-server", "--appendonly", "yes"],
      volumes: [
        { volumeKey: "redis-data", containerPath: "/data", readOnly: false },
        { volumeKey: "redis-conf", containerPath: "/usr/local/etc/redis", readOnly: true },
      ],
      expose: [6379],
      healthcheck: null,
      limits: DEFAULT_LIMITS,
    });
  });

  it("reports everything it changed or dropped", () => {
    expect(notes(result)).toEqual([
      "dropped KEY_DROPPED name",
      "dropped VOLUME_OPTION_DROPPED volumes.pgdata",
      "changed IMAGE_PINNED services.web.image",
      "info PARAMETER_FROM_VARIABLE services.web.command",
      "dropped ENV_URL_VARIABLE_DROPPED services.web.environment[0]",
      "info SECRET_FROM_VARIABLE services.web.environment[1]",
      "info SECRET_FROM_VARIABLE services.web.environment[3]",
      "info PARAMETER_FROM_VARIABLE services.web.environment[4]",
      "dropped DEPENDS_ON_CONDITION_DROPPED services.web.depends_on",
      "changed INGRESS_FROM_VARIABLE services.web.environment[0]",
      "changed HEALTHCHECK_CONVERTED services.web.healthcheck",
      "changed HEALTHCHECK_TIMING_ADJUSTED services.web.healthcheck.timeout",
      "dropped KEY_DROPPED services.web.deploy.resources.reservations",
      "info EXPOSE_ADDED services.web.expose",
      "changed IMAGE_PINNED services.postgres.image",
      "changed HEALTHCHECK_CONVERTED services.postgres.healthcheck",
      "info EXPOSE_ADDED services.postgres.expose",
      "info IMAGE_DIGEST_KEPT services.redis.image",
      "changed COMMAND_SPLIT services.redis.command",
      "info LIMITS_DEFAULTED services.redis",
    ]);
  });
});

describe("header of the draft", () => {
  const body = "services:\n  web:\n    image: registry.example.invalid/acme/web:1.0\n";

  it("takes the name and category of the input before those of the comments", () => {
    const spec = specOf(run(fixture("wordpress-mariadb"), { name: "Blog aziendale", category: "sites" }));
    expect(spec).toMatchObject({ name: "Blog aziendale", category: "sites" });
  });

  it("reads '# name:' and '# category:' in the comment lines that open the file, the first of each", () => {
    const spec = specOf(run(`# Name:   My App  \n#category: Web-Apps\n# name: Second\n\n# a remark\n${body}`));
    expect(spec).toMatchObject({ name: "My App", category: "web-apps" });
  });

  it("ignores a comment after the first line of YAML, and a comment value it cannot use", () => {
    expect(specOf(run(`# category: Not a category!\n${body}# name: Too late\n`))).toMatchObject({
      name: COMPOSE_IMPORT_DEFAULT_NAME,
      category: COMPOSE_IMPORT_DEFAULT_CATEGORY,
    });
  });

  it("falls back to the defaults, also for a blank name or category", () => {
    expect(COMPOSE_IMPORT_DEFAULT_NAME).toBe("Applicazione importata");
    expect(COMPOSE_IMPORT_DEFAULT_CATEGORY).toBe("apps");
    expect(specOf(run(body, { name: "  ", category: "" }))).toMatchObject({ name: "Applicazione importata", category: "apps" });
  });

  it("keeps quotes, a backslash and accented letters of a name", () => {
    const name = 'Caffè "x" \\ y';
    expect(specOf(run(body, { name, category: "food-1" })).name).toBe(name);
  });

  it.each([
    ["a name over 80 characters", { name: "n".repeat(81) }, "x-hp-stack.name"],
    ["a name with a control character", { name: `a${String.fromCharCode(7)}b` }, "x-hp-stack.name"],
    ["a category with a capital letter", { category: "Apps" }, "x-hp-stack.category"],
    ["a category with a space", { category: "my apps" }, "x-hp-stack.category"],
  ])("refuses %s given by the caller", (_title, header, path) => {
    const result = run(body, header);
    expect(result.ok).toBe(false);
    expect(notes(result)).toContain(`refused HEADER_INVALID ${path}`);
  });
});

describe("codes and key lists", () => {
  it("exports a frozen list of distinct codes", () => {
    expect(Object.isFrozen(COMPOSE_IMPORT_CODES)).toBe(true);
    expect(new Set(COMPOSE_IMPORT_CODES).size).toBe(COMPOSE_IMPORT_CODES.length);
    for (const code of COMPOSE_IMPORT_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    expect(COMPOSE_IMPORT_REPORT_MAX).toBe(200);
  });

  it("uses only listed codes, known levels and fixed English text in the notes of the fixtures", () => {
    const codes: readonly ComposeImportCode[] = COMPOSE_IMPORT_CODES;
    for (const name of FIXTURES) {
      for (const note of run(fixture(name)).report) {
        expect(codes).toContain(note.code);
        expect(["info", "changed", "dropped", "refused"]).toContain(note.level);
        expect(note.message).toMatch(/^[\x20-\x7e]+$/);
      }
    }
  });

  it("puts no key on two lists of the same level", () => {
    for (const lists of Object.values(COMPOSE_IMPORT_KEY_LEVELS)) {
      const all = [...lists.read, ...lists.dropped, ...lists.refused];
      expect(new Set(all).size).toBe(all.length);
    }
    expect(Object.isFrozen(COMPOSE_IMPORT_KEY_LEVELS)).toBe(true);
  });
});
