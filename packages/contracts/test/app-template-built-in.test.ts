import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";
import { APP_BUILT_IN_TEMPLATES } from "../src/app-templates/built-in.js";
import { APP_IMAGE_ALLOWLIST } from "../src/app-templates/images.js";
import { APP_STACK_ID_PATTERN, APP_TEMPLATE_CATEGORY_PATTERN, APP_TEMPLATE_LIMITS } from "../src/app-templates/limits.js";
import { APP_DATABASE_TEMPLATE_CATEGORY } from "../src/app-templates/stack-links.js";
import { appStackTextProblem } from "../src/app-templates/text.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const databaseSeed = (slug: string): (typeof APP_BUILT_IN_TEMPLATES)[number] => APP_BUILT_IN_TEMPLATES.find((t) => t.slug === slug)!;
const CUSTOMER_WORDING = /container|image|volume|service|network|template|immagin|volum|servizi|\brete\b|\breti\b/i;
const IMAGE_LINE = /^ {4}image: (.+)$/gm;
const PINNED_IMAGE = /^([^:@\s]+):[A-Za-z0-9._-]+@sha256:[a-f0-9]{64}$/;
const imagesOf = (t: (typeof APP_BUILT_IN_TEMPLATES)[number]) => [...t.source.matchAll(IMAGE_LINE)].map((m) => m[1]!);
const seedImages = APP_BUILT_IN_TEMPLATES.flatMap(imagesOf);
/** The seeds of the first format (ADR-0035, and the databases of ADR-0039) and the one of the extended format (ADR-0036). */
const isExtended = (t: (typeof APP_BUILT_IN_TEMPLATES)[number]) => t.source.startsWith("x-hp-stack:\n  schemaVersion: 2\n");
const FIRST_FORMAT = APP_BUILT_IN_TEMPLATES.filter((t) => !isExtended(t));
const EXTENDED = APP_BUILT_IN_TEMPLATES.filter(isExtended);
/** WORDPRESS_CONFIG_EXTRA as written in the source: a "$$" is one "$" for PHP. */
const CONFIG_EXTRA_YAML =
  "\"$$hcp_host = isset($$_SERVER['HTTP_HOST']) ? strtolower($$_SERVER['HTTP_HOST']) : ''; if (preg_match('/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$$/D', $$hcp_host)) { define('WP_HOME', ((isset($$_SERVER['HTTPS']) && $$_SERVER['HTTPS'] === 'on') ? 'https' : 'http') . '://' . $$hcp_host); define('WP_SITEURL', WP_HOME); } unset($$hcp_host);\"";

describe("APP_BUILT_IN_TEMPLATES", () => {
  it("holds the six seeds with their fixed ids, frozen", () => {
    expect(Object.isFrozen(APP_BUILT_IN_TEMPLATES)).toBe(true);
    for (const t of APP_BUILT_IN_TEMPLATES) expect(Object.isFrozen(t), t.slug).toBe(true);
    expect(APP_BUILT_IN_TEMPLATES.map(({ templateId, versionId, slug, category, name }) => ({ templateId, versionId, slug, category, name }))).toEqual([
      { templateId: "atpl_http_cache", versionId: "atv_http_cache_1", slug: "http-cache", category: "web", name: "Sito HTTP con cache" },
      {
        templateId: "atpl_worker_storage",
        versionId: "atv_worker_storage_1",
        slug: "worker-storage",
        category: "jobs",
        name: "Lavoro periodico con archivio",
      },
      {
        templateId: "atpl_wordpress_mariadb",
        versionId: "atv_wordpress_mariadb_2",
        slug: "wordpress-mariadb",
        category: "content",
        name: "WordPress in contenitore",
      },
      { templateId: "atpl_mariadb", versionId: "atv_mariadb_2", slug: "mariadb", category: "database", name: "Database MariaDB" },
      { templateId: "atpl_postgresql", versionId: "atv_postgresql_1", slug: "postgresql", category: "database", name: "Database PostgreSQL" },
      { templateId: "atpl_valkey", versionId: "atv_valkey_2", slug: "valkey", category: "database", name: "Archivio Valkey" },
    ]);
    expect(FIRST_FORMAT.map((t) => t.slug)).toEqual(["http-cache", "worker-storage", "mariadb", "postgresql", "valkey"]);
    expect(EXTENDED.map((t) => t.slug)).toEqual(["wordpress-mariadb"]);
  });

  it.each(APP_BUILT_IN_TEMPLATES.map((t) => [t.slug, t] as const))("%s: ids, slug and category fit every pattern", (_, t) => {
    expect(t.templateId).toMatch(APP_STACK_ID_PATTERN);
    expect(t.versionId).toMatch(APP_STACK_ID_PATTERN);
    expect(t.slug).toMatch(/^[a-z][a-z0-9-]{1,47}$/);
    expect(t.category).toMatch(APP_TEMPLATE_CATEGORY_PATTERN);
    expect(t.category).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
  });

  it.each(APP_BUILT_IN_TEMPLATES.map((t) => [t.slug, t] as const))("%s: texts are bounded, clean and in customer wording", (_, t) => {
    expect(t.name.length).toBeLessThanOrEqual(APP_TEMPLATE_LIMITS.stackName);
    expect(t.description.length).toBeLessThanOrEqual(APP_TEMPLATE_LIMITS.stackDescription);
    expect(t.descriptionEn.length).toBeLessThanOrEqual(APP_TEMPLATE_LIMITS.stackDescription);
    for (const text of [t.name, t.description, t.descriptionEn]) {
      expect(text.length).toBeGreaterThan(0);
      expect(appStackTextProblem(text), text).toBeNull();
      expect(text).not.toMatch(CUSTOMER_WORDING);
    }
  });

  it.each(APP_BUILT_IN_TEMPLATES.map((t) => [t.slug, t] as const))("%s: source is bounded LF text that repeats the metadata", (_, t) => {
    expect(new TextEncoder().encode(t.source).length).toBeLessThanOrEqual(APP_TEMPLATE_LIMITS.sourceBytes);
    expect(t.source).not.toContain("\r");
    expect(t.source.endsWith("\n")).toBe(true);
    for (const word of ["build", "x-hp-ports", "latest"]) expect(t.source).not.toContain(word);
    // A secret is something only the extended format may generate, or a database asks the customer for (it reaches
    // the component as a file, never as a value); the other seeds of the first format have none.
    if (!isExtended(t) && t.category !== APP_DATABASE_TEMPLATE_CATEGORY) expect(t.source).not.toContain("secret");
    expect(t.source).toMatch(/^x-hp-stack:\n {2}schemaVersion: [12]\n/);
    expect(t.source).toContain(`\n  name: "${t.name}"\n  category: ${t.category}\n  description: "${t.description}"\n`);
  });

  it("first format: pins every image by digest to an allowlist row, and uses every row", () => {
    const images = FIRST_FORMAT.flatMap(imagesOf);
    expect(images).toHaveLength(7);
    const repositories = images.map((image) => PINNED_IMAGE.exec(image)?.[1]);
    expect(new Set(repositories)).toEqual(new Set(APP_IMAGE_ALLOWLIST.map((entry) => entry.repository)));
  });

  it("extended format: pins every image by digest; the images need no allowlist row", () => {
    const images = EXTENDED.flatMap(imagesOf);
    expect(images.map((image) => PINNED_IMAGE.exec(image)?.[1])).toEqual(["wordpress", "mariadb"]);
    const listed = new Set(APP_IMAGE_ALLOWLIST.map((entry) => entry.repository));
    for (const image of images) expect(listed.has(PINNED_IMAGE.exec(image)![1]!), image).toBe(false);
  });

  it.each(APP_BUILT_IN_TEMPLATES.filter((t) => t.category === APP_DATABASE_TEMPLATE_CATEGORY).map((t) => [t.slug, t] as const))(
    "%s: a database is one component with one port, one data area and no address",
    (_, t) => {
      expect(isExtended(t)).toBe(false);
      expect([...t.source.matchAll(IMAGE_LINE)]).toHaveLength(1);
      expect(t.source).toContain("\nservices:\n  db:\n");
      expect([...t.source.matchAll(/^ {4}expose:\n {6}- [0-9]+\n(?! {6}- )/gm)]).toHaveLength(1);
      expect(t.source).toContain("\nvolumes:\n  data: {}\n");
      expect(t.source).not.toContain("x-hp-ingress");
      // A password is a file the customer sets: no literal value, no default.
      const secretEntries = [...t.source.matchAll(/^ {6}- name: ([A-Z_]+)\n {8}secret: ([a-z_]+)$/gm)].map((m) => [m[1], m[2]]);
      const secretParameters = [...t.source.matchAll(/^ {2}- key: ([a-z_]+)\n {4}label: "[^"]+"\n {4}type: secret\n {4}required: true\n {4}customer: true$/gm)].map((m) => m[1]);
      expect(new Set(secretEntries.map(([, key]) => key))).toEqual(new Set(secretParameters));
      for (const [name] of secretEntries) expect(name).toMatch(/_FILE$/);
      expect(t.source).not.toMatch(/default:/);
    },
  );

  it("names the databases mariadb, postgresql and valkey", () => {
    expect(APP_BUILT_IN_TEMPLATES.filter((t) => t.category === APP_DATABASE_TEMPLATE_CATEGORY).map((t) => t.slug)).toEqual(["mariadb", "postgresql", "valkey"]);
  });

  it("wordpress-mariadb: two generated secrets nobody types, no literal password, both components on the standard profile", () => {
    const source = EXTENDED[0]!.source;
    expect([...source.matchAll(/^ {2}- key: ([a-z_]+)$/gm)].map((m) => m[1])).toEqual(["db_password", "db_root_password"]);
    expect([...source.matchAll(/^ {4}customer: (\w+)$/gm)].map((m) => m[1])).toEqual(["false", "false"]);
    expect([...source.matchAll(/^ {4}generate:\n {6}kind: (\w+)\n {6}length: (\d+)$/gm)].map((m) => [m[1], m[2]])).toEqual([
      ["password", "32"],
      ["password", "32"],
    ]);
    expect([...source.matchAll(/^ {4}x-hp-profile: (\w+)$/gm)].map((m) => m[1])).toEqual(["standard", "standard"]);
    // Every name that carries a password takes it from a secret parameter, never from a written value.
    const entries = [...source.matchAll(/^ {6}- name: ([A-Z_]+)\n {8}(value|secret): (.+)$/gm)].map((m) => [m[1]!, m[2]!, m[3]!]);
    expect(entries.filter(([name]) => name!.includes("PASSWORD"))).toEqual([
      ["WORDPRESS_DB_PASSWORD", "secret", "db_password"],
      ["MARIADB_PASSWORD", "secret", "db_password"],
      ["MARIADB_ROOT_PASSWORD", "secret", "db_root_password"],
    ]);
    expect(entries.filter(([, kind]) => kind === "value").map(([name, , value]) => `${name!}=${value!}`)).toEqual([
      "WORDPRESS_DB_HOST=db",
      "WORDPRESS_DB_NAME=wordpress",
      "WORDPRESS_DB_USER=wordpress",
      `WORDPRESS_CONFIG_EXTRA=${CONFIG_EXTRA_YAML}`,
      "MARIADB_DATABASE=wordpress",
      "MARIADB_USER=wordpress",
    ]);
  });

  it("wordpress-mariadb: version 1 is kept byte for byte as the earlier version, version 2 is the newest", () => {
    const t = EXTENDED[0]!;
    expect(t.versionId).toBe("atv_wordpress_mariadb_2");
    expect(Object.isFrozen(t.previousVersions)).toBe(true);
    expect(t.previousVersions?.map((v) => v.versionId)).toEqual(["atv_wordpress_mariadb_1"]);
    const first = t.previousVersions![0]!;
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.source.length).toBe(2361);
    expect(createHash("sha256").update(first.source).digest("hex")).toBe("90d98e325ce227a7b442f6291bd84f3f821c4e2f20e90e8d4b68c4b30d9ed29e");
    expect(first.source).not.toContain("command:");
    expect(first.source).not.toContain("WORDPRESS_CONFIG_EXTRA");
    // The seeds with an earlier version.
    expect(APP_BUILT_IN_TEMPLATES.filter((s) => s.previousVersions !== undefined).map((s) => s.slug)).toEqual(["wordpress-mariadb", "mariadb", "valkey"]);
  });

  it("wordpress-mariadb version 2: the site follows the address it is asked by, and takes uploads of up to 64 MB", () => {
    const t = EXTENDED[0]!;
    expect(t.source).toContain(
      '\n    x-hp-profile: standard\n    command: ["apache2-foreground", "-c", "php_value upload_max_filesize 64M", "-c", "php_value post_max_size 64M"]\n    environment:\n',
    );
    expect([...t.source.matchAll(/^ {4}command: /gm)]).toHaveLength(1);
    expect(t.source).toContain(`\n      - name: WORDPRESS_CONFIG_EXTRA\n        value: ${CONFIG_EXTRA_YAML}\n`);
    expect(t.description).toContain("64 MB");
    expect(t.descriptionEn).toContain("64 MB");
    // Everything else of version 1 is unchanged.
    const first = t.previousVersions![0]!.source;
    const strip = (source: string) =>
      source
        .replace(/^ {2}description: ".*"$/m, "")
        .replace(/^ {4}command: .*\n/m, "")
        .replace(/^ {6}- name: WORDPRESS_CONFIG_EXTRA\n {8}value: .*\n/m, "");
    expect(strip(t.source)).toBe(strip(first));
  });

  it("mariadb: version 2 keeps the database's temporary files on its data area; version 1 is kept byte for byte as the earlier version", () => {
    const t = databaseSeed("mariadb");
    expect(t.versionId).toBe("atv_mariadb_2");
    expect(t.templateId).toBe("atpl_mariadb");
    expect(Object.isFrozen(t.previousVersions)).toBe(true);
    expect(t.previousVersions?.map((v) => v.versionId)).toEqual(["atv_mariadb_1"]);
    const first = t.previousVersions![0]!;
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.source.length).toBe(1395);
    expect(sha256(first.source)).toBe("a3c7de82e0b0b51d33fa9194d82b37ee98a8573f1c881e2023bd25cd6ea0cebc");
    const commandOf = (source: string) => [...source.matchAll(/^ {4}command: (.*)$/gm)].map((m) => m[1]);
    expect(commandOf(first.source)).toEqual(['["mariadbd", "--socket=/tmp/mysqld.sock", "--pid-file=/tmp/mysqld.pid"]']);
    // The strict profile's /tmp is a 64 MB area counted as memory: a sort or an index build larger than that failed there.
    expect(commandOf(t.source)).toEqual(['["mariadbd", "--socket=/tmp/mysqld.sock", "--pid-file=/tmp/mysqld.pid", "--tmpdir=/var/lib/mysql"]']);
    expect(t.source).toContain("      - data:/var/lib/mysql\n");
    // Everything else of version 1 is unchanged: the description, the parameters, the environment, the limits.
    const strip = (source: string) => source.replace(/^ {4}command: .*\n/m, "");
    expect(strip(t.source)).toBe(strip(first.source));
    expect(t.source.includes(`description: "${t.description}"`)).toBe(true);
  });

  it("valkey: version 2 says how much it holds and leaves room above its ceiling; version 1 is kept byte for byte as the earlier version", () => {
    const t = databaseSeed("valkey");
    expect(t.versionId).toBe("atv_valkey_2");
    expect(t.templateId).toBe("atpl_valkey");
    expect(Object.isFrozen(t.previousVersions)).toBe(true);
    expect(t.previousVersions?.map((v) => v.versionId)).toEqual(["atv_valkey_1"]);
    const first = t.previousVersions![0]!;
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.source.length).toBe(909);
    expect(sha256(first.source)).toBe("311ac911841030abf3a0f7f1ef19294bcb92f9602b7f23c2d97f7558cf5711a7");
    const commandOf = (source: string) => [...source.matchAll(/^ {4}command: (.*)$/gm)].map((m) => m[1]);
    const ceilingMb = (source: string) => Number(/"--maxmemory", "(\d+)mb"/.exec(commandOf(source)[0]!)![1]);
    const limitMb = (source: string) => Number(/^ {10}memory: (\d+)M$/m.exec(source)![1]);
    // The ceiling and every other argument are the same on both versions; the limit leaves room for the process and its buffers.
    expect(commandOf(t.source)).toEqual(commandOf(first.source));
    expect(commandOf(first.source)).toEqual([
      '["valkey-server", "--appendonly", "yes", "--dir", "/data", "--maxmemory", "256mb", "--maxmemory-policy", "noeviction", "--protected-mode", "no"]',
    ]);
    expect([ceilingMb(first.source), limitMb(first.source)]).toEqual([256, 384]);
    expect([ceilingMb(t.source), limitMb(t.source)]).toEqual([256, 512]);
    expect(limitMb(t.source)).toBeGreaterThanOrEqual(2 * ceilingMb(t.source));
    expect(t.source).toContain('          cpus: "0.5"\n          memory: 512M\n');
    // What the store does at its ceiling is told to the customer, in both languages; version 1 said nothing of it.
    expect(t.description).toContain("256 MB");
    expect(t.description).toContain("quando è pieno rifiuta le nuove scritture e tiene quello che ha");
    expect(t.descriptionEn).toContain("256 MB");
    expect(t.descriptionEn).toContain("when it is full it refuses new writes and keeps what it holds");
    expect(first.source).not.toContain("256 MB");
    expect(first.source).toContain('  description: "Un archivio chiave-valore Valkey, compatibile con Redis, con i dati conservati su disco.');
    expect(first.source).toContain('da fuori del server non è raggiungibile. Non ha password."\n');
    // Everything else of version 1 is unchanged: the description and the memory limit are the two differences.
    const strip = (source: string) => source.replace(/^ {2}description: ".*"$/m, "").replace(/^ {10}memory: \d+M$/m, "");
    expect(strip(t.source)).toBe(strip(first.source));
    expect(t.source.includes(`description: "${t.description}"`)).toBe(true);
  });

  it("exports no *_IMAGE constant carrying a seed image", () => {
    const imageExports = Object.entries(contracts).filter(([name]) => name.endsWith("_IMAGE"));
    expect(imageExports.length).toBeGreaterThan(0);
    for (const [name, value] of imageExports) {
      for (const image of seedImages) expect(String(value), name).not.toContain(image.slice(image.indexOf("@")));
    }
  });
});
