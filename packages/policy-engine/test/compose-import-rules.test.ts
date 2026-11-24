/**
 * Compose importer (spec §7), rule by rule, first half of the table: images, environment, the SERVICE_ variables that
 * become generated secrets or ingress entries, and ordinary variables. Each case is a file with one service unless it
 * says otherwise; every accepted draft is checked by the template validator.
 */
import { describe, expect, it } from "vitest";
import { type AppTemplateSpec } from "@hosting-panel/contracts";
import { validateAppTemplateSource } from "../src/app-template-validation.js";
import { importComposeToAppTemplate, listComposeImages, type ComposeImportResult } from "../src/compose-import.js";

const IMAGE = "registry.example.invalid/acme/web:1.0";
const digest = (n: number): string => `sha256:${n.toString(16).padStart(2, "0").repeat(32)}`;

const file = (...lines: string[]): string => `${lines.join("\n")}\n`;
/** A file with one service, `web`, made of the image and the given lines. */
const web = (...lines: string[]): string => file("services:", "  web:", `    image: ${IMAGE}`, ...lines.map((line) => `    ${line}`));

/** Imports a file with a digest resolved for every image it lists: the n-th listed image gets `digest(n)`. */
const run = (compose: string): ComposeImportResult =>
  importComposeToAppTemplate({ compose, digests: new Map(listComposeImages(compose).map((image, index) => [image, digest(index + 1)])) });

const notes = (result: ComposeImportResult): string[] => result.report.map((note) => `${note.level} ${note.code} ${note.path}`);
const refusals = (result: ComposeImportResult): string[] => notes(result).filter((note) => note.startsWith("refused "));

/** The draft as the validator reads it; fails the test when the importer refused the file or the draft is not valid. */
function specOf(result: ComposeImportResult): AppTemplateSpec {
  if (!result.ok) throw new Error(`refused: ${notes(result).join("; ")}`);
  const checked = validateAppTemplateSource(result.source);
  if (!checked.ok) throw new Error(`draft not valid: ${checked.errors.map((issue) => `${issue.code} ${issue.path}`).join("; ")}`);
  return checked.spec;
}

const serviceOf = (result: ComposeImportResult, key = "web"): AppTemplateSpec["services"][number] => {
  const found = specOf(result).services.find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`no service ${key}`);
  return found;
};

/** The image of the only service, as the draft writes it. */
const imageOf = (result: ComposeImportResult): string | undefined => (result.ok ? /^ {4}image: "(.*)"$/m.exec(result.source)?.[1] : undefined);

const expectRefused = (result: ComposeImportResult, ...expected: string[]): void => {
  expect(result.ok).toBe(false);
  expect("source" in result).toBe(false);
  expect(refusals(result)).toEqual(expected);
};

const generated = (key: string, label: string, kind: string, length: number): object => ({
  key,
  label,
  type: "secret",
  required: true,
  customer: false,
  generate: { kind, length },
});

describe("image", () => {
  const one = (image: string): string => file("services:", "  web:", `    image: ${image}`);

  it("pins a tagged image with the digest resolved for it", () => {
    const result = run(one("registry.example.invalid/acme/web:1.0"));
    expect(imageOf(result)).toBe(`registry.example.invalid/acme/web:1.0@${digest(1)}`);
    expect(serviceOf(result).image).toEqual({ name: "registry.example.invalid/acme/web", tag: "1.0", digest: digest(1) });
    expect(notes(result)).toEqual(["changed IMAGE_PINNED services.web.image", "info LIMITS_DEFAULTED services.web"]);
  });

  it.each(["wordpress:latest", "wordpress"])("drops the tag of '%s', which names no fixed version", (image) => {
    const compose = one(image);
    expect(listComposeImages(compose)).toEqual([image]);
    const result = run(compose);
    expect(imageOf(result)).toBe(`wordpress@${digest(1)}`);
    specOf(result);
    expect(notes(result).filter((note) => note.endsWith("services.web.image"))).toEqual([
      "changed IMAGE_PINNED services.web.image",
      "changed IMAGE_TAG_DROPPED services.web.image",
    ]);
  });

  it("keeps an image that already carries a digest, and asks for no lookup", () => {
    const pinned = `registry.example.invalid/acme/web:1.0@${digest(9)}`;
    const compose = one(pinned);
    expect(listComposeImages(compose)).toEqual([]);
    const result = importComposeToAppTemplate({ compose, digests: new Map() });
    expect(imageOf(result)).toBe(pinned);
    specOf(result);
    expect(notes(result)).toContain("info IMAGE_DIGEST_KEPT services.web.image");
  });

  it("drops 'latest' also from an image that carries a digest", () => {
    const result = importComposeToAppTemplate({ compose: one(`wordpress:latest@${digest(9)}`), digests: new Map() });
    expect(imageOf(result)).toBe(`wordpress@${digest(9)}`);
    specOf(result);
    expect(notes(result)).toEqual(expect.arrayContaining(["info IMAGE_DIGEST_KEPT services.web.image", "changed IMAGE_TAG_DROPPED services.web.image"]));
  });

  it("accepts a registry with a port", () => {
    const compose = one("registry.example.invalid:5000/acme/web:1.0");
    expect(listComposeImages(compose)).toEqual(["registry.example.invalid:5000/acme/web:1.0"]);
    expect(serviceOf(run(compose)).image).toMatchObject({ name: "registry.example.invalid:5000/acme/web", tag: "1.0" });
  });

  it("lists an image used by two services once", () => {
    const compose = file("services:", "  a:", "    image: redis:7.4", "  b:", "    image: redis:7.4", "  c:", "    image: postgres:17");
    expect(listComposeImages(compose)).toEqual(["redis:7.4", "postgres:17"]);
    expect(specOf(run(compose)).services.map((service) => service.image.digest)).toEqual([digest(1), digest(1), digest(2)]);
  });

  it("refuses an image with no digest resolved for it", () => {
    const result = importComposeToAppTemplate({ compose: one(IMAGE), digests: new Map([["registry.example.invalid/acme/other:1.0", digest(1)]]) });
    expectRefused(result, "refused IMAGE_UNRESOLVED services.web.image");
  });

  it.each(["latest", "sha256:abc", `md5:${"a".repeat(64)}`, `sha256:${"A".repeat(64)}`])("refuses a resolved value that is not a digest (%s)", (value) => {
    expectRefused(importComposeToAppTemplate({ compose: one(IMAGE), digests: new Map([[IMAGE, value]]) }), "refused IMAGE_UNRESOLVED services.web.image");
  });

  it("refuses a service without an image", () => {
    expectRefused(run(file("services:", "  web:", "    expose:", "      - 80")), "refused IMAGE_MISSING services.web.image");
  });

  it.each(["5", "Acme/Web:1.0", "acme/web:${TAG:-1}", "acme/web@sha256:abc", '"acme/web 1.0"', "[a, b]"])("refuses the image %s and does not list it", (image) => {
    const compose = one(image);
    expect(listComposeImages(compose)).toEqual([]);
    expectRefused(run(compose), "refused IMAGE_INVALID services.web.image");
  });

  it.each([
    "127.0.0.1:5000/acme/web:1.0",
    "localhost:5000/acme/web",
    "10.0.0.5/acme/web:1.0",
    "registry.internal/acme/web:1.0",
    `127.0.0.1:5000/acme/web:1.0@${digest(9)}`,
    `registry.local/acme/web@${digest(9)}`,
  ])("refuses the image %s of this server or a private network and does not look it up", (image) => {
    const compose = one(image);
    expect(listComposeImages(compose)).toEqual([]);
    const result = importComposeToAppTemplate({ compose, digests: new Map([[image, digest(1)]]) });
    expectRefused(result, "refused IMAGE_REGISTRY_REFUSED services.web.image");
    expect(result.report.find((note) => note.code === "IMAGE_REGISTRY_REFUSED")?.message).not.toContain("acme");
  });
});

describe("environment", () => {
  it("keeps text, numbers and booleans of the map form as text", () => {
    const result = run(web("environment:", "  A: one", "  B: 5", "  C: true", '  E: ""', "  PORT: 8080", "  F: 1.50", '  G: "null"'));
    expect(serviceOf(result).environment).toEqual([
      { name: "A", value: "one" },
      { name: "B", value: "5" },
      { name: "C", value: "true" },
      { name: "E", value: "" },
      { name: "PORT", value: "8080" },
      { name: "F", value: "1.50" },
      { name: "G", value: "null" },
    ]);
  });

  it("reads the list form: the value starts after the first '='", () => {
    const result = run(web("environment:", "  - A=one", "  - C=a=b", "  - D=", '  - "E=two words"'));
    expect(serviceOf(result).environment).toEqual([
      { name: "A", value: "one" },
      { name: "C", value: "a=b" },
      { name: "D", value: "" },
      { name: "E", value: "two words" },
    ]);
  });

  it("carries quotes, a backslash, '#', spaces and a literal dollar through the draft", () => {
    const result = run(
      web("environment:", "  A: 'say \"hi\" \\ there'", '  B: "#notcomment"', "  C: 'it''s'", '  F: "  spaced  "', "  P: 100$$", "  Q: $$%.2f and $${X}"),
    );
    expect(serviceOf(result).environment).toEqual([
      { name: "A", value: 'say "hi" \\ there' },
      { name: "B", value: "#notcomment" },
      { name: "C", value: "it's" },
      { name: "F", value: "  spaced  " },
      { name: "P", value: "100$$" },
      { name: "Q", value: "$$%.2f and $${X}" },
    ]);
  });

  it("drops what it cannot carry, one note each", () => {
    const result = run(
      web("environment:", "  KEPT: yes", "  NOTHING:", "  lower: x", "  PATH: /bin", "  HP_X: x", "  LD_PRELOAD: x", "  DOCKER_HOST: x", "  DB_PASSWORD_FILE: /x", "  LIST: [a, b]"),
    );
    expect(serviceOf(result).environment).toEqual([{ name: "KEPT", value: "yes" }]);
    expect(notes(result).filter((note) => note.includes(".environment"))).toEqual([
      "dropped ENV_PASSTHROUGH_DROPPED services.web.environment.NOTHING",
      // A name the platform does not accept is shown by its place, never by its text.
      "dropped ENV_NAME_INVALID services.web.environment[2]",
      "dropped ENV_NAME_RESERVED services.web.environment.PATH",
      "dropped ENV_NAME_RESERVED services.web.environment.HP_X",
      "dropped ENV_NAME_RESERVED services.web.environment.LD_PRELOAD",
      "dropped ENV_NAME_RESERVED services.web.environment.DOCKER_HOST",
      "dropped ENV_NAME_RESERVED services.web.environment.DB_PASSWORD_FILE",
      "dropped ENV_VALUE_DROPPED services.web.environment.LIST",
    ]);
  });

  it("drops a list item without a value, without a name or that is not text, and keeps the last of two", () => {
    const result = run(web("environment:", "  - A=one", "  - B", "  - [x]", "  - =x", "  - A=two"));
    expect(serviceOf(result).environment).toEqual([{ name: "A", value: "two" }]);
    expect(notes(result).filter((note) => note.includes(".environment"))).toEqual([
      "dropped ENV_VALUE_DROPPED services.web.environment[2]",
      "dropped ENV_PASSTHROUGH_DROPPED services.web.environment[1]",
      "dropped ENV_NAME_INVALID services.web.environment[3]",
      "dropped ENV_DUPLICATE_DROPPED services.web.environment[0]",
    ]);
  });

  it("refuses an environment that is neither a mapping nor a list", () => {
    expectRefused(run(web("environment: nope")), "refused VALUE_INVALID services.web.environment");
  });

  it("replaces a literal under a secret-looking name by a generated secret, and never says the value", () => {
    const result = run(web("environment:", "  DB_PASSWORD: hunter2-hunter2", "  API_KEY: 12345", "  SESSION_SECRET: keyboard cat", "  PLAIN: visible"));
    expect(specOf(result).parameters).toEqual([
      generated("db_password", "DB_PASSWORD", "password", 32),
      generated("api_key", "API_KEY", "password", 32),
      generated("session_secret", "SESSION_SECRET", "password", 32),
    ]);
    expect(serviceOf(result).environment).toEqual([
      { name: "DB_PASSWORD", secretParameter: "db_password" },
      { name: "API_KEY", secretParameter: "api_key" },
      { name: "SESSION_SECRET", secretParameter: "session_secret" },
      { name: "PLAIN", value: "visible" },
    ]);
    expect(notes(result)).toEqual(
      expect.arrayContaining([
        "changed SECRET_GENERATED services.web.environment.DB_PASSWORD",
        "changed SECRET_GENERATED services.web.environment.API_KEY",
        "changed SECRET_GENERATED services.web.environment.SESSION_SECRET",
      ]),
    );
    const everything = JSON.stringify(result);
    expect(everything).not.toContain("hunter2");
    expect(everything).not.toContain("12345");
    expect(everything).not.toContain("keyboard cat");
    expect(result.report.find((note) => note.code === "SECRET_GENERATED")?.message).toContain("DB_PASSWORD");
  });

  it.each([
    ["a bearer token", "Bearer abcdefghijklmnopqrstuvwxyz012345", "abcdefghijklmnopqrstuvwxyz012345"],
    ["a token with the prefix of its issuer", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnopqrstuvwxyz0123456789"],
  ])("replaces a value that is a secret under a plain name (%s)", (_title, value, fragment) => {
    const result = run(web("environment:", `  UPSTREAM: "${value}"`));
    expect(serviceOf(result).environment).toEqual([{ name: "UPSTREAM", secretParameter: "upstream" }]);
    expect(notes(result)).toContain("changed SECRET_GENERATED services.web.environment.UPSTREAM");
    expect(JSON.stringify(result)).not.toContain(fragment);
  });

  it.each([
    ["with a user", "amqp://app:s3cr3t-broker-pw@queue:5672/main", "amqp://app:${upstream_password}@queue:5672/main"],
    ["without a user", "redis://:s3cr3t-broker-pw@cache:6379/0", "redis://:${upstream_password}@cache:6379/0"],
  ])("takes the password out of an address under a plain name and keeps the rest (%s)", (_title, value, kept) => {
    const result = run(web("environment:", `  UPSTREAM: "${value}"`));
    expect(specOf(result).parameters).toEqual([generated("upstream_password", "UPSTREAM_PASSWORD", "password", 32)]);
    expect(serviceOf(result).environment).toEqual([{ name: "UPSTREAM", value: kept }]);
    expect(notes(result).filter((note) => note.includes(".environment"))).toEqual(["changed SECRET_EXTRACTED services.web.environment.UPSTREAM"]);
    expect(result.report.find((note) => note.code === "SECRET_EXTRACTED")?.message).toBe(
      "A part of the value of UPSTREAM is a secret (the password of an address, or a secret the file also writes elsewhere): that part is replaced by the generated secret parameter 'upstream_password', and the rest of the value is kept.",
    );
    expect(JSON.stringify(result)).not.toContain("s3cr3t-broker-pw");
  });

  it("names the secret of an address after the variable, without the word for the address", () => {
    const result = run(web("environment:", "  DATABASE_URL: postgres://app:s3cr3t-db-pw@db:5432/app", "  BROKER_DSN: amqp://app:s3cr3t-mq-pw@queue:5672/main"));
    expect(specOf(result).parameters.map((parameter) => parameter.key)).toEqual(["database_password", "broker_password"]);
  });

  it("drops a setting under a name the platform keeps for secrets, and keeps one under a name that only looks alike", () => {
    const result = run(
      web(
        "environment:",
        '  MYSQL_ALLOW_EMPTY_PASSWORD: "no"',
        "  PASSWORD_MIN_LENGTH: 8",
        "  SSH_KEY: /data/key",
        "  API_TOKEN_TTL: 30",
        "  ACCESS_TOKEN_EXPIRE_MINUTES: 30",
        "  SESSION_COOKIE_NAME: sid",
        '  BYPASS_MODE: "on"',
      ),
    );
    expect(specOf(result).parameters).toEqual([]);
    expect(serviceOf(result).environment).toEqual([
      { name: "SESSION_COOKIE_NAME", value: "sid" },
      { name: "BYPASS_MODE", value: "on" },
    ]);
    expect(notes(result).filter((note) => note.includes(".environment"))).toEqual([
      "dropped ENV_SETTING_DROPPED services.web.environment.MYSQL_ALLOW_EMPTY_PASSWORD",
      "dropped ENV_SETTING_DROPPED services.web.environment.PASSWORD_MIN_LENGTH",
      "dropped ENV_SETTING_DROPPED services.web.environment.SSH_KEY",
      "dropped ENV_SETTING_DROPPED services.web.environment.API_TOKEN_TTL",
      "dropped ENV_SETTING_DROPPED services.web.environment.ACCESS_TOKEN_EXPIRE_MINUTES",
    ]);
    expect(result.report.find((note) => note.code === "ENV_SETTING_DROPPED")?.message).toBe(
      "The name of MYSQL_ALLOW_EMPTY_PASSWORD looks like a secret's and its value is plainly a setting (a switch, a number or a path): a template cannot carry a plain value under such a name, and a generated secret would mean something else, so the variable is dropped.",
    );
  });

  it("takes a number for the secret when the name ends in the secret word itself", () => {
    const result = run(web("environment:", "  DB_PASSWORD: 12345678", "  ADMIN_PIN_TOKEN: 4821"));
    expect(serviceOf(result).environment).toEqual([
      { name: "DB_PASSWORD", secretParameter: "db_password" },
      { name: "ADMIN_PIN_TOKEN", secretParameter: "admin_pin_token" },
    ]);
    expect(JSON.stringify(result)).not.toContain("12345678");
    expect(JSON.stringify(result)).not.toContain("4821");
  });

  it("drops an empty secret: the platform never passes one", () => {
    const result = run(web("environment:", '  API_KEY: ""'));
    expect(serviceOf(result).environment).toEqual([]);
    expect(notes(result)).toContain("dropped SECRET_EMPTY_DROPPED services.web.environment.API_KEY");
  });

  it.each([
    ["the Docker socket", "unix:///var/run/docker.sock"],
    ["a cloud metadata address", "http://169.254.169.254/latest/meta-data/"],
    ["an escaped control character", '"bell\\u0007"'],
    ["a tab", '"a\\tb"'],
  ])("drops a value that holds %s", (_title, value) => {
    const result = run(web("environment:", `  TARGET: ${value}`, "  KEPT: x"));
    expect(serviceOf(result).environment).toEqual([{ name: "KEPT", value: "x" }]);
    expect(notes(result)).toContain("dropped ENV_VALUE_DROPPED services.web.environment.TARGET");
  });

  it("drops a value over 4096 characters and keeps one of exactly 4096", () => {
    const result = run(web("environment:", `  A: ${"v".repeat(4097)}`, `  B: ${"v".repeat(4096)}`));
    expect(serviceOf(result).environment).toEqual([{ name: "B", value: "v".repeat(4096) }]);
    expect(notes(result)).toContain("dropped ENV_VALUE_DROPPED services.web.environment.A");
  });

  it("refuses a service with more than 64 variables", () => {
    const lines = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `  V${index}: x`);
    expect(serviceOf(run(web("environment:", ...lines(64)))).environment).toHaveLength(64);
    expectRefused(run(web("environment:", ...lines(65))), "refused ENV_TOO_MANY services.web.environment");
  });
});

describe("SERVICE_ variables that become generated secrets", () => {
  it.each([
    ["SERVICE_PASSWORD_X", "password_x", "password", 32, false],
    ["SERVICE_PASSWORD_64_X", "password_64_x", "password", 64, false],
    ["SERVICE_USER_X", "user_x", "user", 16, false],
    ["SERVICE_BASE64_X", "base64_x", "base64", 32, false],
    ["SERVICE_BASE64_64_X", "base64_64_x", "base64", 64, false],
    ["SERVICE_HEX_X", "hex_x", "hex", 32, false],
    ["SERVICE_HEX_32_X", "hex_32_x", "hex", 32, false],
    ["SERVICE_HEX_64_X", "hex_64_x", "hex", 64, false],
    ["SERVICE_HEX_128_X", "hex_128_x", "hex", 128, false],
    // A length outside what the platform generates is brought to the nearest bound.
    ["SERVICE_BASE64_128_X", "base64_128_x", "base64", 96, true],
    ["SERVICE_HEX_8_X", "hex_8_x", "hex", 16, true],
    ["SERVICE_PASSWORD_200_X", "password_200_x", "password", 128, true],
    ["SERVICE_USER_64_X", "user_64_x", "user", 32, true],
    // A kind the platform does not generate becomes the nearest one.
    ["SERVICE_PASSWORDWITHSYMBOLS_X", "passwordwithsymbols_x", "password", 32, true],
    ["SERVICE_REALBASE64_X", "realbase64_x", "base64", 32, true],
    ["SERVICE_REALBASE64_64_X", "realbase64_64_x", "base64", 64, true],
  ])("%s -> '%s' (%s, %i)", (variable, key, kind, length, adjusted) => {
    const result = run(web("environment:", `  SETTING: \${${variable}}`));
    expect(specOf(result).parameters).toEqual([generated(key, variable, kind, length)]);
    expect(serviceOf(result).environment).toEqual([{ name: "SETTING", secretParameter: key }]);
    expect(notes(result).filter((note) => note.includes(".environment"))).toEqual([
      "info SECRET_FROM_VARIABLE services.web.environment.SETTING",
      ...(adjusted ? ["changed SECRET_KIND_ADJUSTED services.web.environment.SETTING"] : []),
    ]);
  });

  it("reads the form without braces, and a bare list item as the variable of its own name", () => {
    const result = run(web("environment:", "  - SETTING=$SERVICE_HEX_32_APP", "  - SERVICE_PASSWORD_ADMIN"));
    expect(serviceOf(result).environment).toEqual([
      { name: "SETTING", secretParameter: "hex_32_app" },
      { name: "SERVICE_PASSWORD_ADMIN", secretParameter: "password_admin" },
    ]);
  });

  it("shares one parameter between the services that use the same variable", () => {
    const compose = file(
      "services:",
      "  app:",
      "    image: registry.example.invalid/acme/app:1.0",
      "    environment:",
      "      DB_PASSWORD: ${SERVICE_PASSWORD_DB}",
      "  db:",
      "    image: postgres:17",
      "    environment:",
      "      - POSTGRES_PASSWORD=${SERVICE_PASSWORD_DB}",
    );
    const result = run(compose);
    expect(specOf(result).parameters).toEqual([generated("password_db", "SERVICE_PASSWORD_DB", "password", 32)]);
    expect(serviceOf(result, "app").environment).toEqual([{ name: "DB_PASSWORD", secretParameter: "password_db" }]);
    expect(serviceOf(result, "db").environment).toEqual([{ name: "POSTGRES_PASSWORD", secretParameter: "password_db" }]);
    // Said once, where the variable is first used.
    expect(notes(result).filter((note) => note.includes("SECRET_FROM_VARIABLE"))).toEqual(["info SECRET_FROM_VARIABLE services.app.environment.DB_PASSWORD"]);
  });

  it("keeps a value that mixes text, a secret and a variable, with placeholders", () => {
    const result = run(web("environment:", "  BROKER_URL: amqp://app:${SERVICE_PASSWORD_Q}@queue:5672/${VHOST:-main}"));
    expect(serviceOf(result).environment).toEqual([{ name: "BROKER_URL", value: "amqp://app:${password_q}@queue:5672/${vhost}" }]);
    expect(specOf(result).parameters.map((parameter) => [parameter.key, parameter.type])).toEqual([
      ["password_q", "secret"],
      ["vhost", "string"],
    ]);
  });

  it("accepts four secrets in one value and refuses five", () => {
    const value = (count: number): string => Array.from({ length: count }, (_unused, index) => `\${SERVICE_PASSWORD_P${index}}`).join(":");
    const four = run(web("environment:", `  JOINED: ${value(4)}`));
    expect(serviceOf(four).environment).toEqual([{ name: "JOINED", value: "${password_p0}:${password_p1}:${password_p2}:${password_p3}" }]);
    expectRefused(run(web("environment:", `  JOINED: ${value(5)}`)), "refused SECRET_REFERENCES_TOO_MANY services.web.environment.JOINED");
  });

  it("accepts eight generated secrets in a template and refuses nine", () => {
    const lines = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `  S${index}: \${SERVICE_PASSWORD_N${index}}`);
    expect(specOf(run(web("environment:", ...lines(8)))).parameters).toHaveLength(8);
    expectRefused(run(web("environment:", ...lines(9))), "refused SECRETS_TOO_MANY ");
  });
});

describe("SERVICE_FQDN_ and SERVICE_URL_ variables", () => {
  it("makes an ingress entry on the port of the suffix, drops the variable and adds the health check the entry needs", () => {
    const result = run(web("environment:", "  APP_URL: ${SERVICE_FQDN_WEB_3000}", "  KEPT: x"));
    const spec = specOf(result);
    expect(spec.ingress).toEqual([{ service: "web", port: 3000 }]);
    expect(serviceOf(result)).toMatchObject({
      environment: [{ name: "KEPT", value: "x" }],
      expose: [3000],
      healthcheck: { kind: "tcp", port: 3000, intervalSeconds: 10, timeoutSeconds: 3 },
    });
    expect(notes(result)).toEqual([
      "changed IMAGE_PINNED services.web.image",
      "dropped ENV_URL_VARIABLE_DROPPED services.web.environment.APP_URL",
      "changed INGRESS_FROM_VARIABLE services.web.environment.APP_URL",
      "info HEALTHCHECK_ADDED services.web.healthcheck",
      "info LIMITS_DEFAULTED services.web",
      "info EXPOSE_ADDED services.web.expose",
    ]);
    expect(result.report.find((note) => note.code === "EXPOSE_ADDED")?.message).toBe(
      "Port 3000 is not among the ports the file gives the service: it is added to 'expose', because the ingress entry of the service uses it.",
    );
  });

  it("takes the port from 'expose' before the container side of 'ports'", () => {
    const result = run(web("environment:", "  APP_URL: ${SERVICE_URL_WEB}", "expose:", "  - 9000", "ports:", '  - "8080:80"'));
    expect(specOf(result).ingress).toEqual([{ service: "web", port: 9000 }]);
    expect(serviceOf(result).expose).toEqual([9000, 80]);
  });

  it("takes the container side of 'ports' when nothing is exposed, also inside a longer value", () => {
    const result = run(web("environment:", "  APP_URL: https://${SERVICE_FQDN_WEB}/x", "ports:", '  - "8080:8081"'));
    expect(specOf(result).ingress).toEqual([{ service: "web", port: 8081 }]);
    expect(serviceOf(result).environment).toEqual([]);
  });

  it("uses port 80, with a note, when the file names no port at all", () => {
    const result = run(web("environment:", "  - SERVICE_FQDN_WEB"));
    expect(specOf(result).ingress).toEqual([{ service: "web", port: 80 }]);
    expect(notes(result)).toEqual(
      expect.arrayContaining(["info INGRESS_PORT_DEFAULTED services.web.environment[0]", "changed INGRESS_FROM_VARIABLE services.web.environment[0]"]),
    );
  });

  it("does not read a suffix that is not a port", () => {
    const result = run(web("environment:", "  APP_URL: ${SERVICE_FQDN_WEB_99999}"));
    expect(specOf(result).ingress).toEqual([{ service: "web", port: 80 }]);
  });

  it("makes one entry per distinct port", () => {
    const result = run(web("environment:", "  A: ${SERVICE_FQDN_WEB_3000}", "  B: ${SERVICE_URL_WEB_3000}", "  C: ${SERVICE_URL_ADMIN_4000}"));
    expect(specOf(result).ingress).toEqual([
      { service: "web", port: 3000 },
      { service: "web", port: 4000 },
    ]);
    expect(notes(result).filter((note) => note.includes("INGRESS_FROM_VARIABLE"))).toHaveLength(2);
  });

  it("refuses more than eight ingress entries", () => {
    const lines = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `  U${index}: \${SERVICE_FQDN_WEB_${3000 + index}}`);
    expect(specOf(run(web("environment:", ...lines(8)))).ingress).toHaveLength(8);
    expectRefused(run(web("environment:", ...lines(9))), "refused INGRESS_TOO_MANY services");
  });
});

describe("ordinary variables", () => {
  it.each(["${GREETING:-hello}", "${GREETING-hello}"])("%s becomes a string parameter with that default, not shown to the customer", (written) => {
    const result = run(web("environment:", `  SETTING: ${written}`));
    expect(specOf(result).parameters).toEqual([{ key: "greeting", label: "GREETING", type: "string", default: "hello", customer: false }]);
    expect(serviceOf(result).environment).toEqual([{ name: "SETTING", value: "${greeting}" }]);
    expect(notes(result)).toContain("info PARAMETER_FROM_VARIABLE services.web.environment.SETTING");
  });

  it.each(["${GREETING}", "${GREETING:?must be set}", "${GREETING?oops}", "$GREETING"])("%s becomes an empty string parameter the customer fills in", (written) => {
    const result = run(web("environment:", `  SETTING: ${written}`));
    expect(specOf(result).parameters).toEqual([{ key: "greeting", label: "GREETING", type: "string", default: "", customer: true }]);
    expect(serviceOf(result).environment).toEqual([{ name: "SETTING", value: "${greeting}" }]);
    expect(notes(result)).toContain("changed PARAMETER_REQUIRED services.web.environment.SETTING");
    // The text of ':?' is a value of the file like any other.
    expect(JSON.stringify(result)).not.toContain("must be set");
  });

  it("keeps an empty default, and gives a lower-case variable a key of its own", () => {
    const result = run(web("environment:", "  A: ${EMPTY:-}", "  B: ${lower}"));
    expect(specOf(result).parameters).toEqual([
      { key: "empty", label: "EMPTY", type: "string", default: "", customer: false },
      { key: "lower", label: "lower", type: "string", default: "", customer: true },
    ]);
  });

  it("keeps the first default when a variable has two, and says so", () => {
    const result = run(web("environment:", "  A: ${MODE:-fast}", "  B: ${MODE:-slow}", "  C: ${MODE}"));
    expect(specOf(result).parameters).toEqual([{ key: "mode", label: "MODE", type: "string", default: "fast", customer: false }]);
    expect(notes(result).filter((note) => note.includes(".environment"))).toEqual([
      "info PARAMETER_FROM_VARIABLE services.web.environment.A",
      "changed PARAMETER_DEFAULT_DROPPED services.web.environment.A",
    ]);
  });

  it("drops a variable whose value uses a form it cannot read", () => {
    const result = run(web("environment:", "  A: ${ALT:+x}", '  B: "5 $ each"', "  C: ${OPEN", "  KEPT: x"));
    expect(serviceOf(result).environment).toEqual([{ name: "KEPT", value: "x" }]);
    expect(specOf(result).parameters).toEqual([]);
    expect(notes(result).filter((note) => note.includes("ENV_VARIABLE_SYNTAX"))).toEqual([
      "dropped ENV_VARIABLE_SYNTAX services.web.environment.A",
      "dropped ENV_VARIABLE_SYNTAX services.web.environment.B",
      "dropped ENV_VARIABLE_SYNTAX services.web.environment.C",
    ]);
  });

  it("makes a variable a generated secret when it stands alone under a secret-looking name, everywhere it is used", () => {
    const result = run(web("environment:", "  DB_PASSWORD: ${DB_PASS:-changeme-changeme}", "  OTHER: ${DB_PASS}"));
    expect(specOf(result).parameters).toEqual([generated("db_pass", "DB_PASS", "password", 32)]);
    expect(serviceOf(result).environment).toEqual([
      { name: "DB_PASSWORD", secretParameter: "db_pass" },
      { name: "OTHER", secretParameter: "db_pass" },
    ]);
    expect(notes(result)).toContain("changed SECRET_GENERATED services.web.environment.DB_PASSWORD");
    expect(JSON.stringify(result)).not.toContain("changeme");
  });

  it("makes a variable with a secret-looking name a generated secret under a plain name too", () => {
    const result = run(web("environment:", "  SETTING: ${ADMIN_TOKEN:-0123456789abcdef}"));
    expect(specOf(result).parameters).toEqual([generated("admin_token", "ADMIN_TOKEN", "password", 32)]);
    expect(JSON.stringify(result)).not.toContain("0123456789abcdef");
  });

  it("replaces a value under a secret-looking name that mixes text and a variable, or cannot be read", () => {
    const result = run(web("environment:", "  APP_SECRET: prefix-${SUFFIX:-tail-of-it}", "  AUTH_TOKEN: ${BROKEN"));
    expect(serviceOf(result).environment).toEqual([
      { name: "APP_SECRET", secretParameter: "app_secret" },
      { name: "AUTH_TOKEN", secretParameter: "auth_token" },
    ]);
    const everything = JSON.stringify(result);
    expect(everything).not.toContain("prefix-");
    expect(everything).not.toContain("tail-of-it");
    expect(everything).not.toContain("BROKEN");
  });

  it("accepts 32 parameters and refuses 33", () => {
    const lines = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `  V${index}: \${VAR${index}:-x}`);
    expect(specOf(run(web("environment:", ...lines(32)))).parameters).toHaveLength(32);
    expectRefused(run(web("environment:", ...lines(33))), "refused PARAMETERS_TOO_MANY ");
  });
});
