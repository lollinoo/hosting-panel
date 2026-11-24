/**
 * `HCP-STACK/v2` in the policy engine (ADR-0036): what the extended format adds, what it still refuses, and that a v1
 * source is held to exactly the v1 rules. The v2 demo below is original text with invented images.
 */
import { describe, expect, it } from "vitest";
import {
  APP_SECRET_GENERATE_BOUNDS,
  APP_SECRET_GENERATE_KINDS,
  APP_TEMPLATE_ISSUE_REASON,
  appStackComponentProfile,
  appStackComponentSecretEnvironment,
  ApprovedStackPlanSchema,
  AppTemplateSpecSchema,
  canonicalAppStackJson,
  findPlaintextSecretKeys,
  findUnsafeDockerInputFields,
  formatTemplatePath,
  parseTemplateYaml,
  type AppTemplateIssue,
  type AppTemplateIssueCode,
  type AppTemplateSpec,
  type ApprovedStackPlan,
  type TemplatePath,
} from "@hosting-panel/contracts";
import { computeAppStackComponentHash, verifyAppStackPlanHash } from "@hosting-panel/hosting-domain";
import {
  appTemplateEnvironmentSecretKeys,
  compileAppStackPlan,
  previewAppTemplateSource,
  type AppStackCompileInput,
} from "../src/app-template-compile.js";
import { APP_TEMPLATE_KEY_LEVELS, APP_TEMPLATE_KEY_LEVELS_V2, type AppTemplateKeyLevelName } from "../src/app-template-keys.js";
import { validateAppTemplate, validateAppTemplateSource } from "../src/app-template-validation.js";

const WEB_DIGEST = `sha256:${"a".repeat(64)}`;
const DB_DIGEST = `sha256:${"b".repeat(64)}`;

const SOURCE = `x-hp-stack:
  schemaVersion: 2
  name: Blog Demo
  category: cms
  description: A two-service demo of the extended format.
x-hp-parameters:
  - key: site_title
    label: Site title
    type: string
    default: "My blog"
    customer: true
  - key: db_password
    label: Database password
    type: secret
    required: true
    customer: false
    generate:
      kind: password
      length: 32
  - key: api_token
    label: API token
    type: secret
    required: false
    customer: true
services:
  web:
    image: blog:1.2.3@${WEB_DIGEST}
    x-hp-profile: standard
    environment:
      - name: BLOG_TITLE
        value: "\${site_title}"
      - name: DATABASE_URL
        value: "postgres://blog:\${db_password}@db:5432/\${site_title}"
      - name: BLOG_DB_PASSWORD
        secret: db_password
      - name: API_TOKEN_FILE
        secret: api_token
      - name: API_TOKEN
        secret: api_token
    volumes:
      - content:/var/www/html
    expose:
      - 80
    depends_on:
      - db
    healthcheck:
      kind: tcp
      port: 80
      intervalSeconds: 15
      timeoutSeconds: 3
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
  db:
    image: ghcr.io/example/database@${DB_DIGEST}
    environment:
      - name: DB_PASSWORD
        secret: db_password
    volumes:
      - dbdata:/var/lib/database
    expose:
      - 5432
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 256M
volumes:
  content: {}
  dbdata: {}
x-hp-ingress:
  - service: web
    port: 80
    protocol: http
`;

const parsed = parseTemplateYaml(SOURCE);
if (!parsed.ok) throw new Error("the v2 demo must parse");
const BASE = parsed.value;

type Node = Record<string | number, unknown>;
type Edit = readonly [path: TemplatePath, value: unknown];
const REMOVE = Symbol("remove");

function build(...edits: Edit[]): unknown {
  const root = structuredClone(BASE) as Node;
  for (const [path, value] of edits) {
    let node = root;
    for (const key of path.slice(0, -1)) node = node[key] as Node;
    const last = path[path.length - 1]!;
    if (value === REMOVE) delete node[last];
    else node[last] = value;
  }
  return root;
}

const web = (...rest: (string | number)[]): TemplatePath => ["services", "web", ...rest];
const param = (index: number, ...rest: string[]): TemplatePath => ["x-hp-parameters", index, ...rest];
const env = (index: number, ...rest: string[]): TemplatePath => web("environment", index, ...rest);

/** No `allowlist` option anywhere in this file: a v2 source is checked against the platform's real list, and passes. */
const specOf = (document: unknown): AppTemplateSpec => {
  const result = validateAppTemplate(document);
  if (!result.ok) throw new Error(`expected the document to be accepted, got ${JSON.stringify(result.errors)}`);
  return result.spec;
};
const errorsOf = (document: unknown): AppTemplateIssue[] => {
  const result = validateAppTemplate(document);
  if (result.ok) throw new Error("expected the document to be refused");
  return result.errors;
};
function refused(document: unknown, code: AppTemplateIssueCode, path: string): AppTemplateIssue[] {
  const errors = errorsOf(document);
  expect(errors).toContainEqual(expect.objectContaining({ path, code, reason: APP_TEMPLATE_ISSUE_REASON[code] }));
  return errors;
}
type Row = readonly [name: string, document: unknown, code: AppTemplateIssueCode, path: string];

const IDS = {
  stackId: "stk_0123456789abcdef0123456789abcdef",
  organizationId: "org_acme",
  hostAllocationId: "alloc_0123456789abcdef0123456789abcdef",
  templateVersionId: "atv_0123456789abcdef01234567",
  revisionId: "astr_0123456789abcdef0123456789abcdef",
};
const input = (change: Partial<AppStackCompileInput> = {}): AppStackCompileInput => ({
  source: SOURCE,
  parameters: [],
  secretVersions: new Map([
    ["db_password", 1],
    ["api_token", 3],
  ]),
  ids: IDS,
  ...change,
});
const planOf = (change?: Partial<AppStackCompileInput>): ApprovedStackPlan => {
  const result = compileAppStackPlan(input(change));
  if (!result.ok) throw new Error(`expected a plan, got ${JSON.stringify(result.issues)}`);
  return result.plan;
};
const componentOf = (plan: ApprovedStackPlan, key: string) => {
  const component = plan.components.find((candidate) => candidate.key === key);
  if (component === undefined) throw new Error(`no component ${key}`);
  return component;
};
const edit = (source: string, from: string, to: string): string => {
  if (!source.includes(from)) throw new Error(`not in the source: ${from}`);
  return source.replace(from, () => to);
};

describe("a v2 source is accepted", () => {
  const spec = specOf(BASE);

  it("validates the demo with the platform's own allowlist, to a version 2 spec", () => {
    expect(validateAppTemplateSource(SOURCE)).toEqual({ ok: true, spec });
    expect(spec.schemaVersion).toBe(2);
    expect(AppTemplateSpecSchema.safeParse(spec).success).toBe(true);
    expect(Object.keys(spec)).toEqual(["schemaVersion", "name", "category", "description", "parameters", "services", "volumes", "ingress"]);
  });

  it("types a generated secret and a customer secret", () => {
    expect(spec.parameters).toEqual([
      { key: "site_title", label: "Site title", type: "string", default: "My blog", customer: true },
      {
        key: "db_password",
        label: "Database password",
        type: "secret",
        required: true,
        customer: false,
        generate: { kind: "password", length: 32 },
      },
      { key: "api_token", label: "API token", type: "secret", required: false, customer: true, generate: null },
    ]);
  });

  it("gives every service a profile: the one it names, or strict", () => {
    expect(spec.services.map((service) => [service.key, "profile" in service ? service.profile : undefined])).toEqual([
      ["db", "strict"],
      ["web", "standard"],
    ]);
    const web0 = spec.services.find((service) => service.key === "web");
    expect(Object.keys(web0 ?? {})).toEqual([
      "key", "image", "command", "environment", "volumes", "expose", "dependsOn", "healthcheck", "limits", "profile",
    ]);
  });

  it("keeps the environment as written: placeholders stay, a secret entry names its parameter", () => {
    expect(spec.services.find((service) => service.key === "web")?.environment).toEqual([
      { name: "BLOG_TITLE", value: "${site_title}" },
      { name: "DATABASE_URL", value: "postgres://blog:${db_password}@db:5432/${site_title}" },
      { name: "BLOG_DB_PASSWORD", secretParameter: "db_password" },
      { name: "API_TOKEN_FILE", secretParameter: "api_token" },
      { name: "API_TOKEN", secretParameter: "api_token" },
    ]);
  });

  it("accepts an image of any registry, pinned by digest, with or without a tag", () => {
    expect(spec.services.map((service) => service.image)).toEqual([
      { name: "ghcr.io/example/database", tag: null, digest: DB_DIGEST },
      { name: "blog", tag: "1.2.3", digest: WEB_DIGEST },
    ]);
  });

  it.each(APP_SECRET_GENERATE_KINDS)("accepts 'generate' of kind %s at both ends of its range", (kind) => {
    const { min, max } = APP_SECRET_GENERATE_BOUNDS[kind];
    for (const length of [min, max]) {
      const made = specOf(build([param(1, "generate"), { kind, length }]));
      expect(made.parameters[1]).toMatchObject({ generate: { kind, length } });
    }
  });

  it("accepts a generated secret the customer may replace", () => {
    const made = specOf(build([param(1, "customer"), true]));
    expect(made.parameters[1]).toMatchObject({ customer: true, generate: { kind: "password", length: 32 } });
  });

  it("accepts up to four secret references in one value", () => {
    const value = "${db_password}:${api_token}:${db_password}:${api_token}";
    expect(specOf(build([env(1, "value"), value])).services.find((service) => service.key === "web")?.environment[1]).toEqual({
      name: "DATABASE_URL",
      value,
    });
  });

  it("does not hold a secret-carrying value to the worst-case length of its secrets", () => {
    const literal = "x".repeat(4_000);
    expect(validateAppTemplate(build([env(1, "value"), `${literal}\${db_password}\${api_token}`])).ok).toBe(true);
  });
});

describe("a v2 source is still refused what a stack must not have", () => {
  const LEVEL_PATHS: Readonly<Record<AppTemplateKeyLevelName, TemplatePath>> = {
    root: [],
    header: ["x-hp-stack"],
    parameter: param(0),
    generate: param(1, "generate"),
    service: web(),
    environmentEntry: env(0),
    healthcheck: web("healthcheck"),
    deploy: web("deploy"),
    resources: web("deploy", "resources"),
    limits: web("deploy", "resources", "limits"),
    ingress: ["x-hp-ingress", 0],
  };
  const rows = Object.entries(APP_TEMPLATE_KEY_LEVELS_V2).flatMap(([level, { refusals }]) => {
    const at = LEVEL_PATHS[level as AppTemplateKeyLevelName];
    const refusedKeys = Object.entries(refusals).flatMap(([code, keys]) => keys.map((key) => [level, key, code] as const));
    return [...refusedKeys, [level, "x-not-a-key", "KEY_UNKNOWN"] as const].map(([name, key, code]) => [name, key, code, at] as const);
  });

  it("covers all eleven levels and every key the v1 table refuses", () => {
    expect(new Set(rows.map(([level]) => level)).size).toBe(11);
    const v1Refused = Object.values(APP_TEMPLATE_KEY_LEVELS).reduce(
      (total, row) => total + Object.values(row.refusals).reduce((sum, keys) => sum + keys.length, 0),
      0,
    );
    expect(rows.filter(([, , code]) => code !== "KEY_UNKNOWN")).toHaveLength(v1Refused);
  });

  it.each(rows)("%s: %s -> %s", (_level, key, code, at) => {
    refused(build([[...at, key], null]), code as AppTemplateIssueCode, formatTemplatePath([...at, key]));
  });

  it.each<Row>([
    ["privileged", build([web("privileged"), true]), "KEY_FORBIDDEN_SECURITY", "services.web.privileged"],
    ["cap_add", build([web("cap_add"), ["SYS_ADMIN"]]), "KEY_FORBIDDEN_SECURITY", "services.web.cap_add"],
    ["user", build([web("user"), "0:0"]), "KEY_FORBIDDEN_SECURITY", "services.web.user"],
    ["devices", build([web("devices"), ["/dev/sda"]]), "KEY_FORBIDDEN_SECURITY", "services.web.devices"],
    ["security_opt", build([web("security_opt"), ["seccomp=unconfined"]]), "KEY_FORBIDDEN_SECURITY", "services.web.security_opt"],
    ["network_mode: host", build([web("network_mode"), "host"]), "KEY_FORBIDDEN_NETWORK", "services.web.network_mode"],
    ["ports", build([web("ports"), ["8080:80"]]), "KEY_FORBIDDEN_NETWORK", "services.web.ports"],
    ["host path", build([web("volumes"), ["/srv:/var/www/html"]]), "VOLUME_HOST_PATH", "services.web.volumes[0]"],
    ["docker socket", build([web("volumes"), ["/var/run/docker.sock:/var/run/docker.sock"]]), "VOLUME_DOCKER_SOCKET", "services.web.volumes[0]"],
    ["entrypoint", build([web("entrypoint"), ["sh"]]), "KEY_UNSUPPORTED", "services.web.entrypoint"],
    ["shell command", build([web("command"), ["sh", "-c", "id"]]), "ARGV_SHELL_REFUSED", "services.web.command[0]"],
    ["image without digest", build([web("image"), "blog:1.2.3"]), "IMAGE_DIGEST_REQUIRED", "services.web.image"],
    ["image tagged latest", build([web("image"), `blog:latest@${WEB_DIGEST}`]), "IMAGE_TAG_LATEST", "services.web.image"],
    ["malformed image", build([web("image"), "Blog Image"]), "IMAGE_MALFORMED", "services.web.image"],
    ["a profile outside the closed list", build([web("x-hp-profile"), "privileged"]), "SERVICE_PROFILE_INVALID", "services.web.x-hp-profile"],
    ["a profile that is a mapping", build([web("x-hp-profile"), { cap_add: ["SYS_ADMIN"] }]), "SERVICE_PROFILE_INVALID", "services.web.x-hp-profile"],
    ["a null profile", build([web("x-hp-profile"), null]), "SERVICE_PROFILE_INVALID", "services.web.x-hp-profile"],
    ["a profile in another case", build([web("x-hp-profile"), "Standard"]), "SERVICE_PROFILE_INVALID", "services.web.x-hp-profile"],
  ])("%s", (_name, document, code, path) => {
    refused(document, code, path);
  });

  it("never raises IMAGE_NOT_ALLOWLISTED, whatever the repository", () => {
    for (const image of [`evil.example/any/thing@${WEB_DIGEST}`, `localhost:5000/x:9@${WEB_DIGEST}`]) {
      expect(validateAppTemplate(build([web("image"), image]), undefined, { allowlist: [] }).ok).toBe(true);
    }
  });
});

describe("generated secrets", () => {
  it.each<Row>([
    ["on a string parameter", build([param(0, "generate"), { kind: "password", length: 32 }]), "PARAM_GENERATE_INVALID", "x-hp-parameters[0].generate"],
    ["not a mapping", build([param(1, "generate"), "password"]), "PARAM_GENERATE_INVALID", "x-hp-parameters[1].generate"],
    ["null", build([param(1, "generate"), null]), "PARAM_GENERATE_INVALID", "x-hp-parameters[1].generate"],
    ["no kind", build([param(1, "generate"), { length: 32 }]), "PARAM_GENERATE_INVALID", "x-hp-parameters[1].generate"],
    ["unknown kind", build([param(1, "generate"), { kind: "uuid", length: 32 }]), "PARAM_GENERATE_INVALID", "x-hp-parameters[1].generate.kind"],
    ["no length", build([param(1, "generate"), { kind: "hex" }]), "PARAM_GENERATE_INVALID", "x-hp-parameters[1].generate"],
    ["length as text", build([param(1, "generate"), { kind: "hex", length: "32" }]), "PARAM_GENERATE_INVALID", "x-hp-parameters[1].generate.length"],
    ["fractional length", build([param(1, "generate"), { kind: "hex", length: 32.5 }]), "PARAM_GENERATE_INVALID", "x-hp-parameters[1].generate.length"],
    ["password too short", build([param(1, "generate"), { kind: "password", length: 15 }]), "PARAM_GENERATE_INVALID", "x-hp-parameters[1].generate.length"],
    ["password too long", build([param(1, "generate"), { kind: "password", length: 129 }]), "PARAM_GENERATE_INVALID", "x-hp-parameters[1].generate.length"],
    ["base64 too long", build([param(1, "generate"), { kind: "base64", length: 97 }]), "PARAM_GENERATE_INVALID", "x-hp-parameters[1].generate.length"],
    ["user too short", build([param(1, "generate"), { kind: "user", length: 7 }]), "PARAM_GENERATE_INVALID", "x-hp-parameters[1].generate.length"],
    ["user too long", build([param(1, "generate"), { kind: "user", length: 33 }]), "PARAM_GENERATE_INVALID", "x-hp-parameters[1].generate.length"],
    ["an extra key", build([param(1, "generate"), { kind: "hex", length: 32, charset: "abc" }]), "KEY_UNKNOWN", "x-hp-parameters[1].generate.charset"],
    ["a fixed value", build([param(1, "generate"), { kind: "hex", length: 32, value: "x" }]), "KEY_UNKNOWN", "x-hp-parameters[1].generate.value"],
    ["generated but optional", build([param(1, "required"), false]), "PARAM_REQUIRED_INVALID", "x-hp-parameters[1].required"],
    ["hidden from the customer without 'generate'", build([param(2, "customer"), false]), "PARAM_SECRET_NOT_CUSTOMER", "x-hp-parameters[2].customer"],
    ["a default on a generated secret", build([param(1, "default"), "x"]), "PARAM_DEFAULT_NOT_ALLOWED", "x-hp-parameters[1].default"],
  ])("refuses 'generate' %s", (_name, document, code, path) => {
    refused(document, code, path);
  });

  it("names the range without echoing what was written", () => {
    const [issue] = refused(build([param(1, "generate"), { kind: "hex", length: 999_999 }]), "PARAM_GENERATE_INVALID", "x-hp-parameters[1].generate.length");
    expect(issue?.message).toContain("16 to 128");
    expect(issue?.message).not.toContain("999999");
  });
});

describe("secrets in the environment", () => {
  it.each<Row>([
    ["a secret in a command item", build([web("command"), ["serve", "${db_password}"]]), "INTERP_SECRET_PARAMETER", "services.web.command[1]"],
    ["five secret references in one value", build([env(1, "value"), "${db_password}".repeat(5)]), "ENV_SECRET_REFERENCES_TOO_MANY", "services.web.environment[1].value"],
    ["a reserved name on a secret-carrying value", build([env(1, "name"), "HP_DATABASE_URL"]), "ENV_NAME_RESERVED", "services.web.environment[1].name"],
    ["a *_FILE name on a secret-carrying value", build([env(1, "name"), "DATABASE_URL_FILE"]), "ENV_NAME_RESERVED", "services.web.environment[1].name"],
    ["PATH as a secret entry", build([env(2, "name"), "PATH"]), "ENV_SECRET_NAME_INVALID", "services.web.environment[2].name"],
    ["a DOCKER_ name as a secret entry", build([env(2, "name"), "DOCKER_HOST"]), "ENV_SECRET_NAME_INVALID", "services.web.environment[2].name"],
    ["an LD_ name as a secret entry", build([env(2, "name"), "LD_PRELOAD"]), "ENV_SECRET_NAME_INVALID", "services.web.environment[2].name"],
    ["a reserved *_FILE name as a secret entry", build([env(3, "name"), "HP_TOKEN_FILE"]), "ENV_SECRET_NAME_INVALID", "services.web.environment[3].name"],
    ["a secret entry naming a string parameter", build([env(2, "secret"), "site_title"]), "ENV_SECRET_UNKNOWN", "services.web.environment[2].secret"],
    ["a secret entry naming nothing declared", build([env(2, "secret"), "nope"]), "ENV_SECRET_UNKNOWN", "services.web.environment[2].secret"],
    ["an undeclared placeholder beside a secret", build([env(1, "value"), "${db_password}${nope}"]), "INTERP_UNKNOWN_VARIABLE", "services.web.environment[1].value"],
    ["a default-value placeholder", build([env(1, "value"), "${db_password:-x}"]), "INTERP_SYNTAX", "services.web.environment[1].value"],
    [
      "a literal credential beside a secret reference",
      build([env(1, "value"), "https://admin:hunter2hunter2@host/${db_password}"]),
      "ENV_VALUE_SECRET_LIKE",
      "services.web.environment[1].value",
    ],
    [
      "the Docker socket beside a secret reference",
      build([env(1, "value"), "unix:///var/run/docker.sock?k=${db_password}"]),
      "ENV_VALUE_DOCKER_SOCKET",
      "services.web.environment[1].value",
    ],
    [
      "a metadata endpoint beside a secret reference",
      build([env(1, "value"), "http://169.254.169.254/${db_password}"]),
      "ENV_VALUE_METADATA_ENDPOINT",
      "services.web.environment[1].value",
    ],
    ["a secret-looking name on a plain value", build([env(0, "name"), "BLOG_PASSWORD"]), "ENV_NAME_SECRET_LIKE", "services.web.environment[0].name"],
    ["a literal credential in a plain value", build([env(0, "value"), "https://admin:hunter2hunter2@host/"]), "ENV_VALUE_SECRET_LIKE", "services.web.environment[0].value"],
    ["the same name twice", build([env(2, "name"), "DATABASE_URL"]), "ENV_NAME_DUPLICATE", "services.web.environment[2].name"],
  ])("refuses %s", (_name, document, code, path) => {
    refused(document, code, path);
  });

  it("lets a value that carries a secret have a name that looks like one", () => {
    expect(validateAppTemplate(build([env(1, "name"), "DATABASE_PASSWORD"])).ok).toBe(true);
    expect(validateAppTemplate(build([env(2, "name"), "ADMIN_SECRET_KEY"])).ok).toBe(true);
  });

  it("accepts a URL whose password is a secret reference: only the text around it is checked", () => {
    expect(validateAppTemplate(build([env(1, "value"), "mysql://app:${db_password}@db:3306/app"])).ok).toBe(true);
  });

  it("counts the other parameters of a secret-carrying value towards its length", () => {
    const value = (literal: number): string => `${"x".repeat(literal)}\${site_title}\${db_password}`;
    expect(validateAppTemplate(build([env(1, "value"), value(3_840)])).ok).toBe(true);
    refused(build([env(1, "value"), value(3_841)]), "ENV_VALUE_TOO_LONG", "services.web.environment[1].value");
  });

  it("lists the secrets a template delivers in the environment", () => {
    expect([...appTemplateEnvironmentSecretKeys(specOf(BASE))].sort()).toEqual(["api_token", "db_password"]);
    const filesOnly = specOf(build([web("environment"), [{ name: "API_TOKEN_FILE", secret: "api_token" }]], [["services", "db", "environment"], []]));
    expect([...appTemplateEnvironmentSecretKeys(filesOnly)]).toEqual([]);
    const byValue = specOf(build([web("environment"), [{ name: "DSN", value: "x:${api_token}" }]]));
    expect([...appTemplateEnvironmentSecretKeys(byValue)].sort()).toEqual(["api_token", "db_password"]);
  });
});

describe("a v1 source never gains a v2 power", () => {
  const asV1 = (...edits: Edit[]): unknown =>
    build(
      [["x-hp-stack", "schemaVersion"], 1],
      [param(1, "generate"), REMOVE],
      [param(1, "customer"), true],
      [web("x-hp-profile"), REMOVE],
      [web("environment"), [{ name: "API_TOKEN_FILE", secret: "api_token" }]],
      [["services", "db", "environment"], []],
      ...edits,
    );
  const allowlist = [
    { repository: "blog", runAsUser: null, note: "test" },
    { repository: "ghcr.io/example/database", runAsUser: null, note: "test" },
  ];
  const v1Errors = (document: unknown): AppTemplateIssue[] => {
    const result = validateAppTemplate(document, undefined, { allowlist });
    if (result.ok) throw new Error("expected the document to be refused");
    return result.errors;
  };

  it("the same document without its v2 keys is a valid v1 source, with a v1 spec", () => {
    const result = validateAppTemplate(asV1(), undefined, { allowlist });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.spec.schemaVersion).toBe(1);
    expect(result.spec.services.every((service) => !("profile" in service))).toBe(true);
    expect(result.spec.parameters[1]).toEqual({ key: "db_password", label: "Database password", type: "secret", required: true, customer: true });
  });

  it.each<readonly [name: string, edits: Edit[], code: AppTemplateIssueCode, path: string]>([
    ["a generated secret", [[param(1, "generate"), { kind: "password", length: 32 }]], "KEY_UNKNOWN", "x-hp-parameters[1].generate"],
    ["a run profile", [[web("x-hp-profile"), "standard"]], "KEY_UNKNOWN", "services.web.x-hp-profile"],
    ["the strict profile, named", [[web("x-hp-profile"), "strict"]], "KEY_UNKNOWN", "services.web.x-hp-profile"],
    ["a secret hidden from the customer", [[param(1, "customer"), false]], "PARAM_SECRET_NOT_CUSTOMER", "x-hp-parameters[1].customer"],
    ["a secret in an environment value", [[web("environment"), [{ name: "DSN", value: "x:${db_password}" }]]], "INTERP_SECRET_PARAMETER", "services.web.environment[0].value"],
    ["a secret as a variable", [[web("environment"), [{ name: "DB_PASSWORD", secret: "db_password" }]]], "ENV_SECRET_NAME_INVALID", "services.web.environment[0].name"],
  ])("refuses %s", (_name, edits, code, path) => {
    expect(v1Errors(asV1(...edits))).toContainEqual(expect.objectContaining({ path, code, reason: APP_TEMPLATE_ISSUE_REASON[code] }));
  });

  it("still needs every image on the allowlist", () => {
    const result = validateAppTemplate(asV1());
    if (result.ok) throw new Error("expected the document to be refused");
    expect(result.errors.map((issue) => [issue.path, issue.code])).toEqual([
      ["services.db.image", "IMAGE_NOT_ALLOWLISTED"],
      ["services.web.image", "IMAGE_NOT_ALLOWLISTED"],
    ]);
  });

  it("refuses any other version, and a v2 key under it", () => {
    for (const version of [0, 3, "2", 2.5, null]) {
      const errors = errorsOf(build([["x-hp-stack", "schemaVersion"], version]));
      expect(errors.map((issue) => issue.code)).toContain("HEADER_VERSION_UNSUPPORTED");
      expect(errors).toContainEqual(expect.objectContaining({ path: "services.web.x-hp-profile", code: "KEY_UNKNOWN" }));
    }
  });
});

describe("compiling a v2 source", () => {
  const plan = planOf();

  it("gives a version 2 plan that passes the plan schema and carries its own hash", () => {
    expect(plan.schemaVersion).toBe(2);
    expect(ApprovedStackPlanSchema.safeParse(plan).success).toBe(true);
    expect(verifyAppStackPlanHash(plan)).toBe(true);
    expect(plan.components.map((component) => component.key)).toEqual(["db", "web"]);
  });

  it("gives every component its profile and the image as name@digest, with no user for an unlisted image", () => {
    expect(plan.components.map((component) => [component.key, component.image, component.runAsUser, appStackComponentProfile(component)])).toEqual([
      ["db", `ghcr.io/example/database@${DB_DIGEST}`, null, "strict"],
      ["web", `blog@${WEB_DIGEST}`, null, "standard"],
    ]);
  });

  it("takes the user of an image the platform lists", () => {
    const listed = compileAppStackPlan(input(), { allowlist: [{ repository: "blog", runAsUser: "33:33", note: "test" }] });
    if (!listed.ok) throw new Error(JSON.stringify(listed.issues));
    expect(componentOf(listed.plan, "web").runAsUser).toBe("33:33");
    expect(componentOf(listed.plan, "db").runAsUser).toBeNull();
  });

  it("splits a secret-carrying value into text and references, and expands the other parameters", () => {
    expect(componentOf(plan, "web")).toMatchObject({
      environment: [{ name: "BLOG_TITLE", value: "My blog" }],
      secretFiles: [{ envName: "API_TOKEN_FILE", parameterKey: "api_token", version: 3 }],
      secretEnvironment: [
        { name: "API_TOKEN", pieces: [{ parameterKey: "api_token", version: 3 }] },
        { name: "BLOG_DB_PASSWORD", pieces: [{ parameterKey: "db_password", version: 1 }] },
        { name: "DATABASE_URL", pieces: [{ literal: "postgres://blog:" }, { parameterKey: "db_password", version: 1 }, { literal: "@db:5432/My blog" }] },
      ],
    });
    expect(componentOf(plan, "db")).toMatchObject({
      environment: [],
      secretFiles: [],
      secretEnvironment: [{ name: "DB_PASSWORD", pieces: [{ parameterKey: "db_password", version: 1 }] }],
    });
  });

  it("puts the two v2 keys after the eleven v1 keys of a component", () => {
    for (const component of plan.components) {
      expect(Object.keys(component)).toEqual([
        "key", "image", "runAsUser", "argv", "environment", "secretFiles", "resources", "expose", "dependsOn", "volumes", "healthcheck",
        "profile", "secretEnvironment",
      ]);
    }
  });

  it("merges the text between two references and drops empty text", () => {
    const source = edit(SOURCE, '"postgres://blog:${db_password}@db:5432/${site_title}"', '"${db_password}${api_token}-${site_title}-$$-${db_password}"');
    expect(appStackComponentSecretEnvironment(componentOf(planOf({ source }), "web"))).toContainEqual({
      name: "DATABASE_URL",
      pieces: [
        { parameterKey: "db_password", version: 1 },
        { parameterKey: "api_token", version: 3 },
        { literal: "-My blog-$-" },
        { parameterKey: "db_password", version: 1 },
      ],
    });
  });

  it("uses the customer's value of the other parameters inside a secret-carrying value", () => {
    const made = planOf({ parameters: [{ key: "site_title", value: "news" }] });
    expect(appStackComponentSecretEnvironment(componentOf(made, "web"))).toContainEqual({
      name: "DATABASE_URL",
      pieces: [{ literal: "postgres://blog:" }, { parameterKey: "db_password", version: 1 }, { literal: "@db:5432/news" }],
    });
    expect(made.planHash).not.toBe(plan.planHash);
  });

  it("refuses a customer value that turns the text around a secret into something forbidden", () => {
    const source = edit(SOURCE, '"postgres://blog:${db_password}@db:5432/${site_title}"', '"x-docker.${site_title}-${db_password}"');
    expect(compileAppStackPlan(input({ source })).ok).toBe(true);
    const result = compileAppStackPlan(input({ source, parameters: [{ key: "site_title", value: "sock" }] }));
    if (result.ok) throw new Error("expected the compile to be refused");
    expect(result.issues.map(({ path, code }) => ({ path, code }))).toEqual([{ path: "parameters.site_title", code: "RENDERED_VALUE_FORBIDDEN" }]);
    expect(JSON.stringify(result.issues)).not.toContain("docker.sock");
  });

  it("leaves out every variable of an optional secret nobody set, and needs the required ones", () => {
    const withoutToken = planOf({ secretVersions: new Map([["db_password", 1]]) });
    const webComponent = componentOf(withoutToken, "web");
    expect(webComponent.secretFiles).toEqual([]);
    expect(appStackComponentSecretEnvironment(webComponent).map((entry) => entry.name)).toEqual(["BLOG_DB_PASSWORD", "DATABASE_URL"]);

    const mixed = edit(SOURCE, '"postgres://blog:${db_password}@db:5432/${site_title}"', '"${db_password}:${api_token}"');
    const mixedWeb = componentOf(planOf({ source: mixed, secretVersions: new Map([["db_password", 1]]) }), "web");
    expect(appStackComponentSecretEnvironment(mixedWeb).map((entry) => entry.name)).toEqual(["BLOG_DB_PASSWORD"]);

    const missing = compileAppStackPlan(input({ secretVersions: new Map([["api_token", 1]]) }));
    if (missing.ok) throw new Error("expected the compile to be refused");
    expect(missing.issues.map(({ path, code, reason }) => ({ path, code, reason }))).toEqual([
      { path: "parameters.db_password", code: "SECRET_MISSING", reason: APP_TEMPLATE_ISSUE_REASON.SECRET_MISSING },
    ]);
  });

  it("changes the plan hash and the component hash when a secret version changes", () => {
    const rotated = planOf({ secretVersions: new Map([["db_password", 2], ["api_token", 3]]) });
    expect(rotated.planHash).not.toBe(plan.planHash);
    expect(computeAppStackComponentHash(rotated, "db")).not.toBe(computeAppStackComponentHash(plan, "db"));
    expect(computeAppStackComponentHash(rotated, "web")).not.toBe(computeAppStackComponentHash(plan, "web"));
    const tokenOnly = planOf({ secretVersions: new Map([["db_password", 1], ["api_token", 4]]) });
    expect(computeAppStackComponentHash(tokenOnly, "db")).toBe(computeAppStackComponentHash(plan, "db"));
    expect(computeAppStackComponentHash(tokenOnly, "web")).not.toBe(computeAppStackComponentHash(plan, "web"));
  });

  it("changes the component hash with the profile", () => {
    const strict = planOf({ source: edit(SOURCE, "    x-hp-profile: standard\n", "") });
    expect(componentOf(strict, "web")).toMatchObject({ profile: "strict" });
    expect(computeAppStackComponentHash(strict, "web")).not.toBe(computeAppStackComponentHash(plan, "web"));
    expect(computeAppStackComponentHash(strict, "db")).toBe(computeAppStackComponentHash(plan, "db"));
  });

  it("is deterministic and canonical: no undefined, the same bytes twice", () => {
    expect(canonicalAppStackJson(planOf())).toBe(canonicalAppStackJson(plan));
    expect(() => canonicalAppStackJson(plan)).not.toThrow();
  });

  it("carries no secret value, no privilege key and no Docker input", () => {
    expect(findPlaintextSecretKeys(plan)).toEqual([]);
    expect(findUnsafeDockerInputFields(plan)).toEqual([]);
    const text = JSON.stringify(plan);
    for (const word of ["CapAdd", "cap_add", "privileged", "Privileged", "docker.sock", "ReadonlyRootfs"]) expect(text).not.toContain(word);
  });

  it("previews the same body without ids, hash and versions", () => {
    const result = previewAppTemplateSource(SOURCE);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.spec.schemaVersion).toBe(2);
    const previewWeb = result.preview.components.find((component) => component.key === "web");
    expect(previewWeb).toMatchObject({
      profile: "standard",
      secretFiles: [{ envName: "API_TOKEN_FILE", parameterKey: "api_token" }],
      secretEnvironment: [
        { name: "API_TOKEN", pieces: [{ parameterKey: "api_token" }] },
        { name: "BLOG_DB_PASSWORD", pieces: [{ parameterKey: "db_password" }] },
        { name: "DATABASE_URL", pieces: [{ literal: "postgres://blog:" }, { parameterKey: "db_password" }, { literal: "@db:5432/My blog" }] },
      ],
    });
    expect(JSON.stringify(result.preview)).not.toContain('"version"');
  });

  it("refuses to compile a v2 source that stopped being valid, with the validator's issues", () => {
    const result = compileAppStackPlan(input({ source: edit(SOURCE, "x-hp-profile: standard", "x-hp-profile: root") }));
    if (result.ok) throw new Error("expected the compile to be refused");
    expect(result.issues.map(({ path, code }) => ({ path, code }))).toEqual([{ path: "services.web.x-hp-profile", code: "SERVICE_PROFILE_INVALID" }]);
  });
});
