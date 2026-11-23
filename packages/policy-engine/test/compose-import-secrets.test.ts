/**
 * Compose importer (spec §7): a secret the file writes in the clear reaches neither the draft nor the report. Every
 * case seeds one marker where a real file keeps a password and looks for it in everything the importer answers. The
 * last block says where the importer stops: what no name, place or text marks as a secret is kept as it is written.
 */
import { describe, expect, it } from "vitest";
import { type AppTemplateSpec } from "@hosting-panel/contracts";
import { validateAppTemplateSource } from "../src/app-template-validation.js";
import { importComposeToAppTemplate, listComposeImages, type ComposeImportResult } from "../src/compose-import.js";

/** Distinctive on purpose: eight characters or more, of two kinds. */
const MARKER = "hunter2XQ";
const IMAGE = "registry.example.invalid/acme/web:1.0";
const digest = (n: number): string => `sha256:${n.toString(16).padStart(2, "0").repeat(32)}`;

const file = (...lines: string[]): string => `${lines.join("\n")}\n`;
const serviceLines = (name: string, ...lines: string[]): string[] => [`  ${name}:`, `    image: ${IMAGE}`, ...lines.map((line) => `    ${line}`)];
/** A file with one service, `web`. */
const web = (...lines: string[]): string => file("services:", ...serviceLines("web", ...lines));

const run = (compose: string): ComposeImportResult =>
  importComposeToAppTemplate({ compose, digests: new Map(listComposeImages(compose).map((image, index) => [image, digest(index + 1)])) });

const notes = (result: ComposeImportResult): string[] => result.report.map((note) => `${note.level} ${note.code} ${note.path}`);
/** The notes about secrets and about the environment, which are the ones these tests are about. */
const secretNotes = (result: ComposeImportResult): string[] => notes(result).filter((note) => /SECRET|ENV_|PARAMETER/.test(note));
const messagesOf = (result: ComposeImportResult, code: string): string[] => result.report.filter((note) => note.code === code).map((note) => note.message);

/** The draft as the validator reads it; fails the test when the importer refused the file or the draft is not valid. */
function specOf(result: ComposeImportResult): AppTemplateSpec {
  if (!result.ok) throw new Error(`refused: ${notes(result).join("; ")}`);
  const checked = validateAppTemplateSource(result.source);
  if (!checked.ok) throw new Error(`draft not valid: ${checked.errors.map((issue) => `${issue.code} ${issue.path}`).join("; ")}`);
  return checked.spec;
}
const environmentOf = (result: ComposeImportResult, key = "web"): unknown => specOf(result).services.find((service) => service.key === key)?.environment;
const keysOf = (result: ComposeImportResult): string[] => specOf(result).parameters.map((parameter) => parameter.key);

/** The marker is nowhere in the answer: not in the draft, not in a note, not in a path. */
const expectNoMarker = (result: ComposeImportResult): void => {
  expect(JSON.stringify(result)).not.toContain(MARKER);
  expect(JSON.stringify(result).toLowerCase()).not.toContain(MARKER.toLowerCase());
};

const generated = (key: string, label: string): unknown => ({ key, label, type: "secret", required: true, customer: false, generate: { kind: "password", length: 32 } });

describe("a secret under a name that holds one", () => {
  it.each(["MYSQL_PWD", "PGPASSWORD", "RABBITMQ_DEFAULT_PASS", "SMTP_PASS", "GPG_PASSPHRASE", "ERLANG_COOKIE", "API_KEYS", "REDIS_MASTERAUTH", "HASH_SALT", "JWT_PRIVATEKEY"])(
    "replaces the value of %s by a generated secret",
    (name) => {
      const result = run(web("environment:", `  ${name}: ${MARKER}`));
      expect(specOf(result).parameters).toEqual([generated(name.toLowerCase(), name)]);
      expect(environmentOf(result)).toEqual([{ name, secretParameter: name.toLowerCase() }]);
      expect(secretNotes(result)).toEqual([`changed SECRET_GENERATED services.web.environment.${name}`]);
      expectNoMarker(result);
    },
  );

  it("does the same in the list form, where the note names the place of the item", () => {
    const result = run(web("environment:", `  - DB_PASSWORD=${MARKER}`, "  - API_KEY", `  - "REDIS_URL=redis://:${MARKER}@redis:6379/0"`));
    expect(keysOf(result)).toEqual(["db_password"]);
    expect(environmentOf(result)).toEqual([
      { name: "DB_PASSWORD", secretParameter: "db_password" },
      { name: "REDIS_URL", value: "redis://:${db_password}@redis:6379/0" },
    ]);
    expect(secretNotes(result)).toEqual([
      "dropped ENV_PASSTHROUGH_DROPPED services.web.environment[1]",
      "changed SECRET_GENERATED services.web.environment[0]",
      "changed SECRET_EXTRACTED services.web.environment[2]",
    ]);
    expectNoMarker(result);
  });

  it("never shows a key that is not a name, whatever it carries", () => {
    const result = run(web("environment:", `  "DB_PASSWORD=${MARKER}": x`, `  "${MARKER}": y`, "  PLAIN: kept"));
    expect(environmentOf(result)).toEqual([{ name: "PLAIN", value: "kept" }]);
    expect(secretNotes(result)).toEqual(["dropped ENV_NAME_INVALID services.web.environment[0]", "dropped ENV_NAME_INVALID services.web.environment[1]"]);
    expectNoMarker(result);
  });

  it("drops the default of a variable that holds a secret, alone or inside an address", () => {
    const alone = run(web("environment:", `  DB_PASS: "\${DB_PASS:-${MARKER}}"`));
    expect(specOf(alone).parameters).toEqual([generated("db_pass", "DB_PASS")]);
    expect(environmentOf(alone)).toEqual([{ name: "DB_PASS", secretParameter: "db_pass" }]);
    expectNoMarker(alone);

    const inside = run(web("environment:", `  DATABASE_URL: "postgres://app:\${DB_PASSWORD:-${MARKER}}@db/app"`));
    expect(keysOf(inside)).toEqual(["db_password"]);
    expect(environmentOf(inside)).toEqual([{ name: "DATABASE_URL", value: "postgres://app:${db_password}@db/app" }]);
    expect(secretNotes(inside)).toEqual(["changed SECRET_GENERATED services.web.environment.DATABASE_URL"]);
    expect(messagesOf(inside, "SECRET_GENERATED")).toEqual([
      "The variable DB_PASSWORD holds a secret: it became the generated secret parameter 'db_password' (password of 32 characters); a default written in the file is not kept.",
    ]);
    expectNoMarker(inside);
  });

  it("makes one secret of a variable used under two names, whatever default each use gives it", () => {
    const result = run(web("environment:", `  A_TOKEN: "\${SHARED_TOKEN:-${MARKER}}"`, '  B_HEADER: "Bearer ${SHARED_TOKEN}"'));
    expect(keysOf(result)).toEqual(["shared_token"]);
    expect(environmentOf(result)).toEqual([
      { name: "A_TOKEN", secretParameter: "shared_token" },
      { name: "B_HEADER", value: "Bearer ${shared_token}" },
    ]);
    expectNoMarker(result);
  });
});

describe("a secret in the password of an address", () => {
  it("takes it out when the address has no user", () => {
    const result = run(web("environment:", `  REDIS_URL: "redis://:${MARKER}@redis:6379/0"`));
    expect(specOf(result).parameters).toEqual([generated("redis_password", "REDIS_PASSWORD")]);
    expect(environmentOf(result)).toEqual([{ name: "REDIS_URL", value: "redis://:${redis_password}@redis:6379/0" }]);
    expect(secretNotes(result)).toEqual(["changed SECRET_EXTRACTED services.web.environment.REDIS_URL"]);
    expectNoMarker(result);
  });

  it("reads the password up to the last '@' before the host, as an address is read", () => {
    const result = run(web("environment:", `  REDIS_URL: "redis://:S3cret@${MARKER}@redis:6379/0"`));
    expect(specOf(result).parameters).toEqual([generated("redis_password", "REDIS_PASSWORD")]);
    expect(environmentOf(result)).toEqual([{ name: "REDIS_URL", value: "redis://:${redis_password}@redis:6379/0" }]);
    expectNoMarker(result);
  });

  it.each([`S3cret@${MARKER}`, `S3cret@Pa55/${MARKER}`])("gives an address the parameter of the password it repeats (%s)", (password) => {
    const result = run(
      file(
        "services:",
        ...serviceLines("db", "environment:", `  POSTGRES_PASSWORD: "${password}"`),
        ...serviceLines("app", "depends_on: [db]", "environment:", `  DATABASE_URL: "postgres://app:${password}@db:5432/app"`),
      ),
    );
    expect(keysOf(result)).toEqual(["postgres_password"]);
    expect(environmentOf(result, "app")).toEqual([{ name: "DATABASE_URL", value: "postgres://app:${postgres_password}@db:5432/app" }]);
    expectNoMarker(result);
  });

  it.each([
    ["a path and a query with an '@'", `postgres://app:${MARKER}@db:5432/app?options=a@b`, "postgres://app:${database_password}@db:5432/app?options=a@b"],
    ["an IPv6 host", `postgres://app:${MARKER}@[::1]:5432/app`, "postgres://app:${database_password}@[::1]:5432/app"],
    ["a user with an '@'", `smtp://app@example.invalid:${MARKER}@mail:587`, "smtp://app@example.invalid:${database_password}@mail:587"],
  ])("takes out the password alone from an address with %s", (_title, address, kept) => {
    const result = run(web("environment:", `  DATABASE_URL: "${address}"`));
    expect(specOf(result).parameters).toEqual([generated("database_password", "DATABASE_PASSWORD")]);
    expect(environmentOf(result)).toEqual([{ name: "DATABASE_URL", value: kept }]);
    expectNoMarker(result);
  });

  it("keeps an address with a user and no password, and one whose password is a variable", () => {
    const result = run(web("environment:", '  REPLICA_URL: "postgres://app@[::1]:5432/app?x=a@b"', '  DATABASE_URL: "postgres://app:${DB_PASSWORD}@db:5432/app"'));
    expect(specOf(result).parameters).toEqual([generated("db_password", "DB_PASSWORD")]);
    expect(environmentOf(result)).toEqual([
      { name: "REPLICA_URL", value: "postgres://app@[::1]:5432/app?x=a@b" },
      { name: "DATABASE_URL", value: "postgres://app:${db_password}@db:5432/app" },
    ]);
  });

  /** What the note of an extracted secret adds when an address of the value can be read in more than one way. */
  const CHECK_BY_HAND = "check by hand that it keeps its host and holds no part of the password";
  const extractedNotes = (result: ComposeImportResult): string[] => messagesOf(result, "SECRET_EXTRACTED");

  it.each([
    ["a query with an '@'", `postgres://app:${MARKER}@db:5432?notify=ops@example.com`, "postgres://app:${postgres_password}@db:5432?notify=ops@example.com"],
    ["a list with an '@'", `postgres://app:${MARKER}@db:5432,admin@example.com`, "postgres://app:${postgres_password}@db:5432,admin@example.com"],
  ])("keeps the host of an address with no path and %s, and asks for a check by hand", (_title, address, kept) => {
    const result = run(
      file(
        "services:",
        ...serviceLines("db", "environment:", `  POSTGRES_PASSWORD: "${MARKER}"`),
        ...serviceLines("web", "environment:", `  DATABASE_URL: "${address}"`),
      ),
    );
    expect(keysOf(result)).toEqual(["postgres_password"]);
    expect(environmentOf(result)).toEqual([{ name: "DATABASE_URL", value: kept }]);
    expect(extractedNotes(result)).toHaveLength(1);
    expect(extractedNotes(result)[0]).toContain(CHECK_BY_HAND);
    expectNoMarker(result);
  });

  it("reads a '?', a '#' or an '@' inside a password, and a list of addresses one host at a time, without a note", () => {
    const result = run(
      web(
        "environment:",
        `  DATABASE_URL: "postgres://app:p?a#ss@${MARKER}@db/app"`,
        `  REPLICA_URL: "postgres://app:${MARKER}-2@db1:5432,db2:5432/app"`,
        `  BROKER_URL: "amqp://u:${MARKER}-3@h0,amqp://u:${MARKER}-4@h1"`,
      ),
    );
    expect(environmentOf(result)).toEqual([
      { name: "DATABASE_URL", value: "postgres://app:${database_password}@db/app" },
      { name: "REPLICA_URL", value: "postgres://app:${replica_password}@db1:5432,db2:5432/app" },
      { name: "BROKER_URL", value: "amqp://u:${broker_password}@h0,amqp://u:${broker_password_2}@h1" },
    ]);
    expect(extractedNotes(result).filter((message) => message.includes(CHECK_BY_HAND))).toEqual([]);
    expectNoMarker(result);
  });

  it.each([
    ["a password with an '@' before a '?'", "postgres://app:p@ss?word@db/app", "postgres://app:${database_password}@ss?word@db/app"],
    ["a user with an '@' and no password", "postgres://app@db:5432?notify=ops@example.com", "postgres://app@db:${database_password}@example.com"],
  ])("asks for a check by hand of an address it cannot read one way only: %s", (_title, address, kept) => {
    const result = run(web("environment:", `  DATABASE_URL: "${address}"`));
    expect(environmentOf(result)).toEqual([{ name: "DATABASE_URL", value: kept }]);
    expect(extractedNotes(result)).toEqual([
      "A part of the value of DATABASE_URL is a secret (the password of an address, or a secret the file also writes elsewhere): that part is replaced by the generated secret parameter 'database_password', and the rest of the value is kept. An address of the value can be read in more than one way (it holds another '@'): check by hand that it keeps its host and holds no part of the password.",
    ]);
  });

  it("gives two addresses with the same password one secret, and another password another", () => {
    const result = run(
      web("environment:", `  PRIMARY_URL: postgres://app:${MARKER}@db1/app`, `  REPLICA_URL: postgres://app:${MARKER}@db2/app`, `  OTHER_URL: postgres://app:${MARKER}-b@db3/app`),
    );
    expect(keysOf(result)).toEqual(["primary_password", "other_password"]);
    expect(environmentOf(result)).toEqual([
      { name: "PRIMARY_URL", value: "postgres://app:${primary_password}@db1/app" },
      { name: "REPLICA_URL", value: "postgres://app:${primary_password}@db2/app" },
      { name: "OTHER_URL", value: "postgres://app:${other_password}@db3/app" },
    ]);
    expectNoMarker(result);
  });

  it("drops what a health check carries with its address: the draft keeps the port and the path", () => {
    const withOption = run(web("expose: [8080]", "healthcheck:", `  test: ["CMD", "curl", "-u", "admin:${MARKER}", "http://localhost:8080/health"]`));
    expect(specOf(withOption).services[0]?.healthcheck).toMatchObject({ kind: "http", port: 8080, path: "/health" });
    expectNoMarker(withOption);

    const inAddress = run(web("expose: [8080]", "healthcheck:", `  test: curl -f http://admin:${MARKER}@localhost:8080/health`));
    expect(specOf(inAddress).services[0]?.healthcheck).toMatchObject({ kind: "tcp", port: 8080 });
    expectNoMarker(inAddress);
  });
});

describe("one secret written in more than one place", () => {
  it("is one parameter for two services that call it by different names", () => {
    const result = run(
      file(
        "services:",
        ...serviceLines("db", "environment:", `  POSTGRES_PASSWORD: ${MARKER}`),
        ...serviceLines("app", "depends_on: [db]", "environment:", `  PGPASSWORD: ${MARKER}`, `  DATABASE_URL: postgres://postgres:${MARKER}@db:5432/postgres`),
      ),
    );
    expect(specOf(result).parameters).toEqual([generated("postgres_password", "POSTGRES_PASSWORD")]);
    expect(environmentOf(result, "db")).toEqual([{ name: "POSTGRES_PASSWORD", secretParameter: "postgres_password" }]);
    expect(environmentOf(result, "app")).toEqual([
      { name: "PGPASSWORD", secretParameter: "postgres_password" },
      { name: "DATABASE_URL", value: "postgres://postgres:${postgres_password}@db:5432/postgres" },
    ]);
    expect(secretNotes(result)).toEqual([
      "changed SECRET_GENERATED services.db.environment.POSTGRES_PASSWORD",
      "changed SECRET_GENERATED services.app.environment.PGPASSWORD",
      "changed SECRET_EXTRACTED services.app.environment.DATABASE_URL",
    ]);
    expectNoMarker(result);
  });

  it("is found again inside a value no name announces, when its text is distinctive", () => {
    const result = run(web("environment:", `  DB_PASSWORD: ${MARKER}`, `  JAVA_OPTS: "-Dpass=${MARKER} -Xmx1g"`, `  DB_NAME: ${MARKER}`));
    expect(keysOf(result)).toEqual(["db_password"]);
    expect(environmentOf(result)).toEqual([
      { name: "DB_PASSWORD", secretParameter: "db_password" },
      { name: "JAVA_OPTS", value: "-Dpass=${db_password} -Xmx1g" },
      // The file gives the database the name of its password: the draft follows the file, and says so.
      { name: "DB_NAME", secretParameter: "db_password" },
    ]);
    expect(secretNotes(result)).toEqual([
      "changed SECRET_GENERATED services.web.environment.DB_PASSWORD",
      "changed SECRET_EXTRACTED services.web.environment.JAVA_OPTS",
      "changed SECRET_GENERATED services.web.environment.DB_NAME",
    ]);
    expectNoMarker(result);
  });

  it("is known from an address that also names a variable before the first service is converted", () => {
    const worker = serviceLines("worker", "environment:", `  JAVA_OPTS: "-Ddb.pw=${MARKER}"`);
    const app = (...lines: string[]): string[] => serviceLines("app", ...lines, "environment:", `  DATABASE_URL: "postgres://app:${MARKER}@\${DB_HOST:-db}/app"`);
    const result = run(file("services:", ...worker, ...app(`command: ["serve", "--opt=${MARKER}"]`)));
    // The command of the service that writes the address is read before its environment, and carries the secret.
    expect(notes(result).filter((note) => note.startsWith("refused "))).toEqual(["refused COMMAND_SECRET_REFUSED services.app.command[1]"]);
    expectNoMarker(result);

    for (const services of [[...worker, ...app()], [...app(), ...worker]]) {
      const imported = run(file("services:", ...services));
      expect(environmentOf(imported, "worker")).toEqual([{ name: "JAVA_OPTS", value: "-Ddb.pw=${database_password}" }]);
      expect(environmentOf(imported, "app")).toEqual([{ name: "DATABASE_URL", value: "postgres://app:${database_password}@${db_host}/app" }]);
      expectNoMarker(imported);
    }
  });

  it.each([
    ["under a name that looks like a secret's", `  AUTH_TOKEN_URL: "https://svc:${MARKER}@auth/\${REALM}"`, "AUTH_TOKEN_URL", "auth_token_password"],
    ["whose '$' form cannot be read", `  DATABASE_URL: "postgres://app:${MARKER}@\${DB_HOST:+db}/app"`, "DATABASE_URL", "database_password"],
  ])("is known from an address in a value replaced whole, %s", (_title, line, name, key) => {
    const result = run(file("services:", ...serviceLines("worker", "environment:", `  JAVA_OPTS: "-Ddb.pw=${MARKER}"`), ...serviceLines("app", "environment:", line)));
    expect(environmentOf(result, "worker")).toEqual([{ name: "JAVA_OPTS", value: `-Ddb.pw=\${${key}}` }]);
    expect(environmentOf(result, "app")).toEqual([{ name, secretParameter: name.toLowerCase() }]);
    expectNoMarker(result);
  });

  it("is not looked for everywhere when its text is an ordinary word: the name of the database stays", () => {
    const result = run(
      file(
        "services:",
        ...serviceLines("db", "environment:", "  MYSQL_DATABASE: wordpress", "  MYSQL_USER: wordpress", "  MYSQL_PASSWORD: wordpress", '  MYSQL_ROOT_PASSWORD: "${ROOT_PW:-wordpress}"'),
        ...serviceLines(
          "wordpress",
          "depends_on: [db]",
          "environment:",
          "  WORDPRESS_DB_NAME: wordpress",
          "  WORDPRESS_DB_USER: wordpress",
          "  WORDPRESS_DB_PASSWORD: wordpress",
          "  WORDPRESS_DSN: mysql://wordpress:wordpress@db:3306/wordpress",
          '  NOTE: "a wordpress site"',
        ),
      ),
    );
    expect(specOf(result).parameters).toEqual([generated("mysql_password", "MYSQL_PASSWORD")]);
    expect(environmentOf(result, "db")).toEqual([
      { name: "MYSQL_DATABASE", value: "wordpress" },
      { name: "MYSQL_USER", value: "wordpress" },
      { name: "MYSQL_PASSWORD", secretParameter: "mysql_password" },
      { name: "MYSQL_ROOT_PASSWORD", secretParameter: "mysql_password" },
    ]);
    expect(environmentOf(result, "wordpress")).toEqual([
      { name: "WORDPRESS_DB_NAME", value: "wordpress" },
      { name: "WORDPRESS_DB_USER", value: "wordpress" },
      { name: "WORDPRESS_DB_PASSWORD", secretParameter: "mysql_password" },
      { name: "WORDPRESS_DSN", value: "mysql://wordpress:${mysql_password}@db:3306/wordpress" },
      { name: "NOTE", value: "a wordpress site" },
    ]);
    // The default of ROOT_PW is the password of the line above: its note stands where the shared secret is first used.
    expect(messagesOf(result, "SECRET_GENERATED").filter((message) => message.includes("ROOT_PW"))).toHaveLength(1);
  });

  it("keeps a generated value of the platform and a secret of the file apart in one value", () => {
    const result = run(web("environment:", '  DB_PASSWORD: "${SERVICE_PASSWORD_DB}"', `  ADMIN_PASSWORD: ${MARKER}`, `  DSN: "mysql://u:\${SERVICE_PASSWORD_DB}@db/x?alt=${MARKER}"`));
    expect(keysOf(result)).toEqual(["password_db", "admin_password"]);
    expect(environmentOf(result)).toEqual([
      { name: "DB_PASSWORD", secretParameter: "password_db" },
      { name: "ADMIN_PASSWORD", secretParameter: "admin_password" },
      { name: "DSN", value: "mysql://u:${password_db}@db/x?alt=${admin_password}" },
    ]);
    expectNoMarker(result);
  });
});

describe("what the file says beside its values", () => {
  it("keeps no comment, label, extension or name of a container", () => {
    const result = run(
      file(
        `# the password is ${MARKER}`,
        `x-credentials: ${MARKER}`,
        "services:",
        ...serviceLines("web", "labels:", `  auth: "admin:${MARKER}"`, `container_name: ${MARKER}`, "environment:", `  DB_PASSWORD: ${MARKER} # ${MARKER}`),
      ),
    );
    expect(keysOf(result)).toEqual(["db_password"]);
    expectNoMarker(result);
  });

  it("answers every file of this list without the marker, with a draft the validator accepts or with a refusal", () => {
    const corpus: readonly string[] = [
      web(`command: ["redis-server", "--requirepass", "${MARKER}"]`),
      web(`command: redis-server --requirepass ${MARKER}`),
      web(`command: ["serve", "--db=postgres://app:${MARKER}@db/app"]`),
      web(`entrypoint: ["sh", "-c", "PASSWORD=${MARKER} exec serve"]`),
      web(`env_file: ${MARKER}.env`),
      web("secrets:", `  - ${MARKER}`),
      web("environment:", `  DB_PASSWORD: "${MARKER}$"`),
      web("environment:", `  DB_PASSWORD: "\${UNCLOSED:-${MARKER}"`),
      web("environment:", `  DB_PASSWORD: "\${DB_PASSWORD:?set ${MARKER}}"`),
      web("environment:", `  DB_PASSWORD: "\${DB_PASSWORD-${MARKER}}"`),
      web("environment:", `  DB_PASSWORD: "\${DB_PASSWORD:+${MARKER}}"`),
      web("environment:", `  DB_PASSWORD: [${MARKER}]`),
      web("environment:", "  DB_PASSWORD:", `    nested: ${MARKER}`),
      web("environment:", `  DB_PASSWORD: ${MARKER}`, `  DB_PASSWORD_AGAIN: ${MARKER}${MARKER}`),
      web("environment:", `  SESSION_SECRET: ${MARKER}`, `  WEBHOOK: https://hooks.example.invalid/${MARKER}/notify`),
      web("environment:", `  AMQP_URL: amqp://guest:${MARKER}@queue:5672/%2f`, `  AMQP_PASSWORD: ${MARKER}`),
      web("environment:", `  FTP: "ftp://u:${MARKER}@files/ sftp://u:${MARKER}@files/"`),
      web("environment:", ...Array.from({ length: 12 }, (_unused, index) => `  S${index}_PASSWORD: ${MARKER}-${index}`)),
      file("services:", ...serviceLines("web"), "secrets:", "  db:", `    file: ./${MARKER}.txt`),
    ];
    let drafts = 0;
    for (const compose of corpus) {
      const result = run(compose);
      expectNoMarker(result);
      if (!result.ok) {
        expect(notes(result).some((note) => note.startsWith("refused "))).toBe(true);
        continue;
      }
      drafts += 1;
      expect(validateAppTemplateSource(result.source).ok).toBe(true);
    }
    // Both outcomes are exercised.
    expect(drafts).toBeGreaterThan(0);
    expect(drafts).toBeLessThan(corpus.length);
  });
});

describe("where the importer stops", () => {
  it("keeps a value that no name, place or text marks as a secret: the administrator reads the draft before publishing it", () => {
    const result = run(web("environment:", `  GREETING: "\${GREETING:-${MARKER}}"`, `  BASIC_AUTH: "admin:${MARKER}"`));
    expect(specOf(result).parameters).toEqual([{ key: "greeting", label: "GREETING", type: "string", default: MARKER, customer: false }]);
    expect(environmentOf(result)).toEqual([
      { name: "GREETING", value: "${greeting}" },
      { name: "BASIC_AUTH", value: `admin:${MARKER}` },
    ]);
  });
});
