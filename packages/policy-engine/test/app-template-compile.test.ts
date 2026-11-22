import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ApprovedStackPlanSchema,
  appStackPlanHashInput,
  appStackPlanImageProblems,
  canonicalAppStackJson,
  toAppStackPreview,
  type AppImageAllowlistEntry,
  type AppTemplateIssue,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import { computeAppStackComponentHash, verifyAppStackPlanHash } from "@hosting-panel/hosting-domain";
import { compileAppStackPlan, previewAppTemplateSource, type AppStackCompileInput } from "../src/app-template-compile.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../contracts/test/fixtures/app-stack-notes-demo/${name}`, import.meta.url), "utf8");
const SOURCE = fixture("source.yaml");
const SPEC: unknown = JSON.parse(fixture("spec.json"));
const PLAN: unknown = JSON.parse(fixture("plan.json"));
const PREVIEW: unknown = JSON.parse(fixture("preview.json"));
const ALLOWLIST = JSON.parse(fixture("allowlist.json")) as AppImageAllowlistEntry[];
const options = { allowlist: ALLOWLIST };
const IDS = {
  stackId: "stk_0123456789abcdef0123456789abcdef",
  organizationId: "org_acme",
  hostAllocationId: "alloc_0123456789abcdef0123456789abcdef",
  templateVersionId: "atv_0123456789abcdef01234567",
  revisionId: "astr_0123456789abcdef0123456789abcdef",
};
const APP_DIGEST = `sha256:${"a".repeat(64)}`;
const CACHE_DIGEST = `sha256:${"b".repeat(64)}`;

const input = (change: Partial<AppStackCompileInput> = {}): AppStackCompileInput => ({
  source: SOURCE,
  parameters: [],
  secretVersions: new Map([["app_secret", 1]]),
  ids: IDS,
  ...change,
});
const planOf = (change?: Partial<AppStackCompileInput>): ApprovedStackPlan => {
  const result = compileAppStackPlan(input(change), options);
  if (!result.ok) throw new Error(`expected a plan, got ${JSON.stringify(result.issues)}`);
  return result.plan;
};
const issuesOf = (change?: Partial<AppStackCompileInput>): AppTemplateIssue[] => {
  const result = compileAppStackPlan(input(change), options);
  if (result.ok) throw new Error("expected the compile to be refused");
  return result.issues;
};
const summary = (issues: readonly AppTemplateIssue[]) => issues.map(({ path, code, reason }) => ({ path, code, reason }));
/** Replaces `from`, which must be present, so a stale edit cannot pass silently. */
const edit = (source: string, from: string, to: string): string => {
  if (!source.includes(from)) throw new Error(`not in the source: ${from}`);
  return source.replace(from, () => to);
};
const withParameters = (yaml: string, source = SOURCE): string => edit(source, "x-hp-parameters:\n", `x-hp-parameters:\n${yaml}`);
const stringParameter = (key: string, value: string): string =>
  `  - key: ${key}\n    label: ${key}\n    type: string\n    default: "${value}"\n    customer: true\n`;

/** Two services of 64 env values, each `${p}` 16 times: with a 256-character value the plan exceeds 262 144 bytes. */
const bigSource = (defaultValue: string): string => {
  const value = `"${"${p}".repeat(16)}"`;
  const environment = Array.from({ length: 64 }, (_, i) => `      - name: V${String(i).padStart(2, "0")}\n        value: ${value}\n`).join("");
  const service = (key: string) =>
    `  ${key}:\n    image: registry.example.invalid/demo/app@${APP_DIGEST}\n    environment:\n${environment}` +
    '    deploy:\n      resources:\n        limits:\n          cpus: "0.5"\n          memory: 256M\n';
  return (
    `x-hp-stack:\n  schemaVersion: 1\n  name: Big\n  category: test\nx-hp-parameters:\n${stringParameter("p", defaultValue)}` +
    `services:\n${service("one")}${service("two")}`
  );
};

/** The fixture with services, parameters, env entries and root keys in another order. */
const PERMUTED_SOURCE = `x-hp-ingress:
  - service: app
    port: 8080
    protocol: http
volumes:
  data: {}
services:
  cache:
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: "0.5"
    expose:
      - 6379
    image: registry.example.invalid/demo/cache:4.5.6@${CACHE_DIGEST}
  app:
    deploy:
      resources:
        limits:
          memory: 512M
          cpus: "1.0"
    healthcheck:
      timeoutSeconds: 3
      intervalSeconds: 15
      port: 8080
      kind: tcp
    depends_on:
      - cache
    expose:
      - 8080
    volumes:
      - data:/app/data
    environment:
      - secret: app_secret
        name: APP_SECRET_FILE
      - value: cache
        name: CACHE_HOST
    command: ["serve", "--workers", "\${worker_count}"]
    image: registry.example.invalid/demo/app:1.2.3@${APP_DIGEST}
x-hp-parameters:
  - key: app_secret
    label: Application secret
    type: secret
    required: true
    customer: true
  - key: worker_count
    label: Worker count
    type: integer
    min: 1
    max: 4
    default: 2
    customer: true
x-hp-stack:
  description: Two components with private cache and HTTP ingress
  category: productivity
  name: Notes Demo
  schemaVersion: 1
`;

/** Three services whose inner lists are written in source order or reversed. */
const sortDemo = (reversed: boolean): string => {
  const order = (lines: string[]): string => (reversed ? [...lines].reverse() : lines).join("");
  const limits = '    deploy:\n      resources:\n        limits:\n          cpus: "0.5"\n          memory: 256M\n';
  const services = {
    web:
      `  web:\n    image: registry.example.invalid/demo/app@${APP_DIGEST}\n` +
      '    command: ["serve", "--mode", "${mode}"]\n' +
      `    environment:\n${order(["      - name: Z_LAST\n        value: z\n", '      - name: A_FIRST\n        value: "${mode}-a"\n', "      - name: TOKEN_FILE\n        secret: api_key\n"])}` +
      `    volumes:\n${order(["      - logs:/var/log/app\n", "      - data:/app/data:ro\n"])}` +
      `    expose:\n${order(["      - 9090\n", "      - 8080\n"])}` +
      `    depends_on:\n${order(["      - db\n", "      - cache\n"])}` +
      "    healthcheck:\n      kind: http\n      port: 8080\n      path: /health\n" +
      limits,
    db:
      `  db:\n    image: registry.example.invalid/demo/cache@${CACHE_DIGEST}\n` +
      "    volumes:\n      - data:/var/lib/db\n    expose:\n      - 5432\n    depends_on:\n      - cache\n" +
      limits,
    cache: `  cache:\n    image: registry.example.invalid/demo/cache@${CACHE_DIGEST}\n    expose:\n      - 6379\n${limits}`,
  };
  return (
    "x-hp-stack:\n  schemaVersion: 1\n  name: Sort Demo\n  category: test\n" +
    "x-hp-parameters:\n" +
    order([
      "  - key: mode\n    label: Mode\n    type: enum\n    options: [fast, slow]\n    default: fast\n    customer: true\n",
      "  - key: api_key\n    label: API key\n    type: secret\n    required: false\n    customer: true\n",
    ]) +
    `services:\n${order([services.web, services.db, services.cache])}` +
    `volumes:\n${order(["  logs: {}\n", "  data: {}\n"])}` +
    `x-hp-ingress:\n${order(["  - service: web\n    port: 9090\n    protocol: http\n", "  - service: web\n    port: 8080\n    protocol: http\n"])}`
  );
};

describe("compileAppStackPlan on the notes-demo fixture", () => {
  it("compiles to exactly plan.json, whose planHash verifies", () => {
    const result = compileAppStackPlan(input(), options);
    expect(result).toEqual({ ok: true, plan: PLAN });
    if (!result.ok) return;
    expect(JSON.stringify(result.plan)).toBe(JSON.stringify(PLAN));
    expect(result.plan.planHash).toBe("6247134963c40efc9f135593adc6f42c5aa59391ec8889dada24d538726d0f33");
    expect(verifyAppStackPlanHash(result.plan)).toBe(true);
  });

  it("compiles for a UUID-form organisation and allocation with the same planHash", () => {
    const uuid = "3984baf6-928d-40dd-b388-bfac50b5e54f";
    const ids = { ...IDS, organizationId: `org_${uuid}`, hostAllocationId: `alloc_${uuid}` };
    const plan = planOf({ ids });
    expect(plan).toEqual({ ...(PLAN as ApprovedStackPlan), ...ids });
    expect(plan.planHash).toBe("6247134963c40efc9f135593adc6f42c5aa59391ec8889dada24d538726d0f33");
  });

  it("parses with ApprovedStackPlanSchema and passes the image check only with the fixture allowlist", () => {
    const plan = planOf();
    expect(ApprovedStackPlanSchema.safeParse(plan).success).toBe(true);
    expect(appStackPlanImageProblems(plan, ALLOWLIST)).toEqual([]);
    expect(appStackPlanImageProblems(plan)).not.toEqual([]);
  });

  it("returns the validator's issues for a refused source", () => {
    const result = compileAppStackPlan(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain("IMAGE_NOT_ALLOWLISTED");
  });

  it("does not mutate its inputs", () => {
    const parameters = Object.freeze([Object.freeze({ key: "worker_count", value: 3 })]);
    const ids = Object.freeze({ ...IDS });
    const secretVersions = new Map([["app_secret", 4]]);
    expect(planOf({ parameters, ids, secretVersions }).components[1]?.argv).toEqual(["serve", "--workers", "3"]);
    expect([...secretVersions]).toEqual([["app_secret", 4]]);
  });

  it("ignores secret versions of keys that are not secret parameters", () => {
    expect(planOf({ secretVersions: new Map([["app_secret", 1], ["worker_count", 7], ["old_key", 2]]) })).toEqual(PLAN);
  });
});

describe("determinism", () => {
  it("gives JSON-identical plans over 50 runs", () => {
    const first = JSON.stringify(planOf());
    for (let run = 0; run < 50; run += 1) expect(JSON.stringify(planOf())).toBe(first);
  });

  it("gives plan.json for the fixture written in another order", () => {
    expect(JSON.stringify(planOf({ source: PERMUTED_SOURCE }))).toBe(JSON.stringify(PLAN));
  });

  it("keeps the topological order and sorts every inner list whatever the source order", () => {
    const secretVersions = new Map([["api_key", 1]]);
    const plan = planOf({ source: sortDemo(false), secretVersions });
    expect(JSON.stringify(planOf({ source: sortDemo(true), secretVersions }))).toBe(JSON.stringify(plan));
    expect(plan.components.map((component) => component.key)).toEqual(["cache", "db", "web"]);
    const web = plan.components[2];
    expect(web?.environment).toEqual([
      { name: "A_FIRST", value: "fast-a" },
      { name: "Z_LAST", value: "z" },
    ]);
    expect(web?.secretFiles).toEqual([{ envName: "TOKEN_FILE", parameterKey: "api_key", version: 1 }]);
    expect(web?.expose).toEqual([8080, 9090]);
    expect(web?.dependsOn).toEqual(["cache", "db"]);
    expect(web?.volumes.map((mount) => mount.containerPath)).toEqual(["/app/data", "/var/log/app"]);
    expect(plan.volumes).toEqual([{ key: "data" }, { key: "logs" }]);
    expect(plan.ingress).toEqual([
      { componentKey: "web", port: 8080 },
      { componentKey: "web", port: 9090 },
    ]);
  });
});

describe("planHash: what goes in and what stays out (§4)", () => {
  const base = planOf().planHash;
  const changed: Array<[string, Partial<AppStackCompileInput>]> = [
    ["template version id", { ids: { ...IDS, templateVersionId: "atv_other" } }],
    ["image digest", { source: edit(SOURCE, APP_DIGEST, `sha256:${"c".repeat(64)}`) }],
    ["argv", { parameters: [{ key: "worker_count", value: 3 }] }],
    ["env value", { source: edit(SOURCE, "value: cache", "value: cache-two") }],
    ["secret version", { secretVersions: new Map([["app_secret", 2]]) }],
    ["resources", { source: edit(SOURCE, 'cpus: "1.0"', 'cpus: "2.0"') }],
    ["expose", { source: edit(SOURCE, "      - 6379\n", "      - 6379\n      - 6380\n") }],
    ["dependsOn", { source: edit(SOURCE, "    depends_on:\n      - cache\n", "") }],
    ["mounts", { source: edit(SOURCE, "data:/app/data", "data:/app/data:ro") }],
    ["health", { source: edit(SOURCE, "intervalSeconds: 15", "intervalSeconds: 20") }],
    ["volume set", { source: edit(edit(SOURCE, "  data: {}\n", "  data: {}\n  logs: {}\n"), "      - data:/app/data\n", "      - data:/app/data\n      - logs:/app/logs\n") }],
    ["ingress set", { source: edit(SOURCE, "x-hp-ingress:\n  - service: app\n    port: 8080\n    protocol: http\n", "") }],
  ];
  it.each(changed)("changes with the %s", (_, change) => {
    expect(planOf(change).planHash).not.toBe(base);
  });

  it.each(["stackId", "organizationId", "hostAllocationId", "revisionId"] as const)("does not change with %s", (id) => {
    const plan = planOf({ ids: { ...IDS, [id]: "other_id" } });
    expect(plan[id]).toBe("other_id");
    expect(plan.planHash).toBe(base);
  });
});

describe("customer values (§5)", () => {
  it.each([
    ["worker_count out of range", [{ key: "worker_count", value: 9 }], "parameters.worker_count", "PARAM_VALUE_OUT_OF_RANGE"],
    ["worker_count as a string", [{ key: "worker_count", value: "2" }], "parameters.worker_count", "PARAM_VALUE_INVALID_TYPE"],
    ["an inline secret value", [{ key: "app_secret", value: "x" }], "parameters.app_secret", "PARAM_VALUE_SECRET"],
  ])("refuses %s", (_, parameters, path, code) => {
    expect(summary(issuesOf({ parameters }))).toEqual([{ path, code, reason: "STACK_PARAMETER_INVALID" }]);
  });

  it("refuses a value for a customer:false parameter even when it equals the default", () => {
    const source = edit(SOURCE, "default: 2\n    customer: true", "default: 2\n    customer: false");
    expect(summary(issuesOf({ source, parameters: [{ key: "worker_count", value: 2 }] }))).toEqual([
      { path: "parameters.worker_count", code: "PARAM_VALUE_NOT_CUSTOMER", reason: "STACK_PARAMETER_INVALID" },
    ]);
  });
});

describe("secrets", () => {
  it("refuses a required secret without a version", () => {
    expect(summary(issuesOf({ secretVersions: new Map() }))).toEqual([
      { path: "parameters.app_secret", code: "SECRET_MISSING", reason: "STACK_SECRET_MISSING" },
    ]);
  });

  it("omits the env entries of an optional secret without a version", () => {
    const plan = planOf({ source: edit(SOURCE, "required: true", "required: false"), secretVersions: new Map() });
    expect(plan.components[1]?.secretFiles).toEqual([]);
    expect(plan.components[1]?.environment).toEqual([{ name: "CACHE_HOST", value: "cache" }]);
  });
});

describe("rendered values", () => {
  const argvSource = edit(withParameters(stringParameter("mode", "fast")), '"${worker_count}"]', '"${worker_count}", "${mode}"]');

  it("renders a whole placeholder argument and unescapes $$ in a literal one", () => {
    const source = edit(argvSource, '"serve"', '"cost-$$5"');
    expect(planOf({ source, parameters: [{ key: "mode", value: "slow" }] }).components[1]?.argv).toEqual(["cost-$5", "--workers", "2", "slow"]);
  });

  it.each(["", "-x", "--eval"])("refuses the argument %j (option injection)", (value) => {
    expect(summary(issuesOf({ source: argvSource, parameters: [{ key: "mode", value }] }))).toEqual([
      { path: "parameters.mode", code: "PARAM_VALUE_ARGV_UNSAFE", reason: "STACK_PARAMETER_INVALID" },
    ]);
  });

  it.each(["sh", "/bin/bash", " busybox"])("refuses the argument %j (a shell)", (value) => {
    expect(summary(issuesOf({ source: argvSource, parameters: [{ key: "mode", value }] }))).toEqual([
      { path: "parameters.mode", code: "PARAM_VALUE_ARGV_UNSAFE", reason: "STACK_PARAMETER_INVALID" },
    ]);
  });

  it.each(["docker.sock", "169.254.169.254"])("refuses the enum option %j as a whole argument", (value) => {
    const source = edit(
      withParameters('  - key: target\n    label: Target\n    type: enum\n    options: ["local", "docker.sock", "169.254.169.254"]\n    default: local\n    customer: true\n'),
      '"${worker_count}"]',
      '"${worker_count}", "${target}"]',
    );
    expect(planOf({ source }).components[1]?.argv).toEqual(["serve", "--workers", "2", "local"]);
    expect(summary(issuesOf({ source, parameters: [{ key: "target", value }] }))).toEqual([
      { path: "parameters.target", code: "RENDERED_VALUE_FORBIDDEN", reason: "STACK_PARAMETER_INVALID" },
    ]);
  });

  it("refuses an integer argument that renders with a leading '-'", () => {
    const source = edit(SOURCE, "min: 1", "min: -5");
    expect(summary(issuesOf({ source, parameters: [{ key: "worker_count", value: -1 }] }))).toEqual([
      { path: "parameters.worker_count", code: "PARAM_VALUE_ARGV_UNSAFE", reason: "STACK_PARAMETER_INVALID" },
    ]);
  });

  it("refuses an env value that renders to forbidden content from two harmless values", () => {
    const source = edit(
      withParameters(stringParameter("left", "a") + stringParameter("right", "b")),
      "        value: cache\n",
      '        value: cache\n      - name: JOINED\n        value: "${left}${right}"\n',
    );
    const parameters = [
      { key: "left", value: "docker." },
      { key: "right", value: "sock" },
    ];
    expect(summary(issuesOf({ source, parameters }))).toEqual([
      { path: "parameters.left", code: "RENDERED_VALUE_FORBIDDEN", reason: "STACK_PARAMETER_INVALID" },
    ]);
  });
});

describe("limits and ids", () => {
  it("refuses a plan over 262 144 bytes", () => {
    const source = bigSource("x");
    expect(planOf({ source }).components).toHaveLength(2);
    expect(summary(issuesOf({ source, parameters: [{ key: "p", value: "a".repeat(256) }] }))).toEqual([
      { path: "", code: "PLAN_TOO_LARGE", reason: "STACK_TEMPLATE_INVALID" },
    ]);
  });

  it.each([
    ["an upper-case stack id", { ids: { ...IDS, stackId: "STK_1" } }],
    ["an empty revision id", { ids: { ...IDS, revisionId: "" } }],
    ["a stack id with a hyphen", { ids: { ...IDS, stackId: "stk_3984baf6-928d" } }],
    ["a 65-character stack id", { ids: { ...IDS, stackId: `s${"a".repeat(64)}` } }],
    ["a revision id with a hyphen", { ids: { ...IDS, revisionId: "astr_a-b" } }],
    ["a 129-character organization id", { ids: { ...IDS, organizationId: `o${"a".repeat(128)}` } }],
    ["an allocation id with a dot", { ids: { ...IDS, hostAllocationId: "alloc.1" } }],
    ["a secret version 0", { secretVersions: new Map([["app_secret", 0]]) }],
    ["a fractional secret version", { secretVersions: new Map([["app_secret", 1.5]]) }],
    ["a secret version over 2^31-1", { secretVersions: new Map([["app_secret", 2_147_483_648]]) }],
  ])("reports SPEC_INTERNAL for %s", (_, change) => {
    expect(summary(issuesOf(change))).toEqual([{ path: "", code: "SPEC_INTERNAL", reason: "STACK_TEMPLATE_INVALID" }]);
  });
});

describe("component hashes", () => {
  it("rotating a secret version changes the hash of the component that mounts it and of no other", () => {
    const before = planOf();
    const after = planOf({ secretVersions: new Map([["app_secret", 2]]) });
    expect(computeAppStackComponentHash(after, "app")).not.toBe(computeAppStackComponentHash(before, "app"));
    expect(computeAppStackComponentHash(after, "cache")).toBe(computeAppStackComponentHash(before, "cache"));
  });
});

describe("A8 static: a secret marker never leaks", () => {
  const marker = randomBytes(20).toString("hex");

  it("is 40 characters and absent from the plan, the preview and the hash input", () => {
    expect(marker).toHaveLength(40);
    const plan = planOf();
    const preview = previewAppTemplateSource(SOURCE, options);
    for (const text of [JSON.stringify(plan), JSON.stringify(preview), canonicalAppStackJson(appStackPlanHashInput(plan))]) {
      expect(text).not.toContain(marker);
    }
  });

  it.each([
    ["an inline secret", [{ key: "app_secret", value: marker }]],
    ["a wrong type", [{ key: "worker_count", value: marker }]],
    ["an unknown parameter", [{ key: "api_token", value: marker }]],
  ])("is never echoed when given as %s", (_, parameters) => {
    expect(JSON.stringify(issuesOf({ parameters }))).not.toContain(marker);
  });

  it("is never echoed when written as a secret-like env literal", () => {
    const source = edit(SOURCE, "value: cache", `value: sk-${marker}`);
    const issues = issuesOf({ source });
    expect(issues.map((issue) => issue.code)).toEqual(["ENV_VALUE_SECRET_LIKE"]);
    expect(JSON.stringify(issues)).not.toContain(marker);
    expect(JSON.stringify(previewAppTemplateSource(source, options))).not.toContain(marker);
  });
});

describe("previewAppTemplateSource (A1)", () => {
  it("gives spec.json and preview.json for the fixture, equal to the preview of the compiled plan", () => {
    const result = previewAppTemplateSource(SOURCE, options);
    expect(result).toEqual({ ok: true, spec: SPEC, preview: PREVIEW });
    if (!result.ok) return;
    expect(JSON.stringify(result.preview)).toBe(JSON.stringify(PREVIEW));
    expect(result.preview).toEqual(toAppStackPreview(planOf()));
  });

  it("treats every secret as set and equals toAppStackPreview of the plan compiled with defaults", () => {
    const source = sortDemo(true);
    const result = previewAppTemplateSource(source, options);
    if (!result.ok) throw new Error("expected a preview");
    expect(result.preview).toEqual(toAppStackPreview(planOf({ source, secretVersions: new Map([["api_key", 9]]) })));
    expect(result.preview.components[2]?.secretFiles).toEqual([{ envName: "TOKEN_FILE", parameterKey: "api_key" }]);
  });

  it("refuses a template whose default renders an unsafe argument", () => {
    const source = edit(withParameters(stringParameter("mode", "-v")), '"${worker_count}"]', '"${worker_count}", "${mode}"]');
    const result = previewAppTemplateSource(source, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(summary(result.errors)).toEqual([{ path: "parameters.mode", code: "PARAM_VALUE_ARGV_UNSAFE", reason: "STACK_PARAMETER_INVALID" }]);
  });

  it("refuses a template whose plan with every default exceeds 262 144 bytes, as every install would", () => {
    const source = bigSource("a".repeat(256));
    const tooLarge = [{ path: "", code: "PLAN_TOO_LARGE", reason: "STACK_TEMPLATE_INVALID" }];
    const result = previewAppTemplateSource(source, options);
    expect(result.ok ? [] : summary(result.errors)).toEqual(tooLarge);
    expect(summary(issuesOf({ source }))).toEqual(tooLarge);
  });

  it("measures the preview with ids of the longest allowed length, foreign ids included", () => {
    const longest = { stackId: "s".repeat(64), organizationId: "o".repeat(128), hostAllocationId: "h".repeat(128), templateVersionId: "t".repeat(64), revisionId: "r".repeat(64) };
    const padded = (n: number) =>
      edit(bigSource("a".repeat(125)), `value: "${"${p}".repeat(16)}"`, `value: "${"a".repeat(n)}"`);
    const bytes = JSON.stringify(planOf({ source: padded(1), ids: longest })).length;
    const source = padded(262_144 + 2 - bytes);
    const tooLarge = [{ path: "", code: "PLAN_TOO_LARGE", reason: "STACK_TEMPLATE_INVALID" }];
    expect(summary(issuesOf({ source, ids: longest }))).toEqual(tooLarge);
    expect(planOf({ source, ids: { ...longest, organizationId: "o".repeat(64), hostAllocationId: "h".repeat(64) } }).components).toHaveLength(2);
    const result = previewAppTemplateSource(source, options);
    expect(result.ok ? [] : summary(result.errors)).toEqual(tooLarge);
  });

  it("reports SPEC_INTERNAL for a body the plan schema refuses", () => {
    const allowlist = ALLOWLIST.map((entry) => ({ ...entry, runAsUser: "root" }));
    const result = previewAppTemplateSource(SOURCE, { allowlist });
    expect(result.ok ? [] : summary(result.errors)).toEqual([{ path: "", code: "SPEC_INTERNAL", reason: "STACK_TEMPLATE_INVALID" }]);
  });

  it("returns the validator's errors for a refused source", () => {
    const result = previewAppTemplateSource(SOURCE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map((issue) => issue.code)).toContain("IMAGE_NOT_ALLOWLISTED");
  });
});
