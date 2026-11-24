/**
 * Security matrix of the application template validator (acceptance rows A4–A7, A12, A13). Each row is the smallest
 * change to the valid notes-demo fixture that would give a stack a power it must not have; it must be refused with the
 * exact code, reason and path.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_TEMPLATE_ISSUE_REASON,
  formatTemplatePath,
  parseTemplateYaml,
  type AppImageAllowlistEntry,
  type AppTemplateIssue,
  type AppTemplateIssueCode,
  type TemplatePath,
} from "@hosting-panel/contracts";
import { APP_TEMPLATE_KEY_LEVELS } from "../src/app-template-keys.js";
import { validateAppTemplate, validateAppTemplateSource } from "../src/app-template-validation.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../contracts/test/fixtures/app-stack-notes-demo/${name}`, import.meta.url), "utf8");
const SOURCE = fixture("source.yaml");
const ALLOWLIST = JSON.parse(fixture("allowlist.json")) as AppImageAllowlistEntry[];
const parsed = parseTemplateYaml(SOURCE);
if (!parsed.ok) throw new Error("the fixture must parse");
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

const app = (...rest: (string | number)[]): TemplatePath => ["services", "app", ...rest];
const param = (index: number, ...rest: string[]): TemplatePath => ["x-hp-parameters", index, ...rest];
const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = "registry.example.invalid/demo/app";

const errorsOf = (document: unknown): AppTemplateIssue[] => {
  const result = validateAppTemplate(document, undefined, { allowlist: ALLOWLIST });
  if (result.ok) throw new Error("expected the document to be refused");
  return result.errors;
};
const accepted = (document: unknown): boolean => validateAppTemplate(document, undefined, { allowlist: ALLOWLIST }).ok;

/** The document is refused with `code` (and its mapped reason) at `path`. */
function refused(document: unknown, code: AppTemplateIssueCode, path: string): AppTemplateIssue[] {
  const errors = errorsOf(document);
  expect(errors).toContainEqual(expect.objectContaining({ path, code, reason: APP_TEMPLATE_ISSUE_REASON[code] }));
  return errors;
}

type Row = readonly [name: string, document: unknown, code: AppTemplateIssueCode, path: string];

describe("baseline", () => {
  it("the unchanged fixture is accepted", () => {
    expect(accepted(BASE)).toBe(true);
  });
});

describe("A4: every refused key at every level", () => {
  const LEVEL_PATHS: Readonly<Record<keyof typeof APP_TEMPLATE_KEY_LEVELS, TemplatePath>> = {
    root: [],
    header: ["x-hp-stack"],
    parameter: param(0),
    service: app(),
    environmentEntry: app("environment", 0),
    healthcheck: app("healthcheck"),
    deploy: app("deploy"),
    resources: app("deploy", "resources"),
    limits: app("deploy", "resources", "limits"),
    ingress: ["x-hp-ingress", 0],
    task: ["x-hp-tasks", 0],
  };
  /** The fixture declares no task: the task level is checked on one added to it. */
  const SETUP: Partial<Record<string, Edit[]>> = {
    task: [[["x-hp-tasks"], [{ key: "tidy", label: "Tidy up", service: "app", command: ["/app/bin/tidy"] }]]],
  };
  const rows = Object.entries(APP_TEMPLATE_KEY_LEVELS).flatMap(([level, { refusals }]) => {
    const at = LEVEL_PATHS[level as keyof typeof APP_TEMPLATE_KEY_LEVELS];
    const refusedKeys = Object.entries(refusals).flatMap(([code, keys]) => keys.map((key) => [level, key, code] as const));
    return [...refusedKeys, [level, "x-not-a-key", "KEY_UNKNOWN"] as const].map(([name, key, code]) => [name, key, code, at] as const);
  });

  it("covers all eleven levels", () => {
    expect(new Set(rows.map(([level]) => level)).size).toBe(11);
  });

  it.each(rows)("%s: %s -> %s", (level, key, code, at) => {
    refused(build(...(SETUP[level] ?? []), [[...at, key], null]), code as AppTemplateIssueCode, formatTemplatePath([...at, key]));
  });

  it("refuses an own __proto__ key without touching Object.prototype", () => {
    const document = build() as Node;
    Object.defineProperty(document.services, "__proto__", { value: { privileged: true }, enumerable: true });
    refused(document, "KEY_FORBIDDEN_SECURITY", "services.__proto__.privileged");
    expect(({} as Record<string, unknown>).privileged).toBeUndefined();
  });
});

describe("A4: value-level refusals", () => {
  const rows: readonly Row[] = [
    ["docker socket mount", build([app("volumes"), ["/var/run/docker.sock:/var/run/docker.sock"]]), "VOLUME_DOCKER_SOCKET", "services.app.volumes[0]"],
    ["absolute host path", build([app("volumes"), ["/srv/data:/data"]]), "VOLUME_HOST_PATH", "services.app.volumes[0]"],
    ["relative host path", build([app("volumes"), ["./x:/data"]]), "VOLUME_HOST_PATH", "services.app.volumes[0]"],
    ["home host path", build([app("volumes"), ["~/x:/data"]]), "VOLUME_HOST_PATH", "services.app.volumes[0]"],
    ["Windows drive", build([app("volumes"), ["c:\\x:/data"]]), "VOLUME_HOST_PATH", "services.app.volumes[0]"],
    ["long bind syntax", build([app("volumes"), [{ type: "bind", source: "/", target: "/h" }]]), "VOLUME_SYNTAX", "services.app.volumes[0]"],
    ["mount on /etc", build([app("volumes"), ["data:/etc"]]), "VOLUME_TARGET_INVALID", "services.app.volumes[0]"],
    ["mount under /proc", build([app("volumes"), ["data:/proc/x"]]), "VOLUME_TARGET_INVALID", "services.app.volumes[0]"],
    ["mount on /run/secrets", build([app("volumes"), ["data:/run/secrets"]]), "VOLUME_TARGET_INVALID", "services.app.volumes[0]"],
    ["mount on /tmp", build([app("volumes"), ["data:/tmp"]]), "VOLUME_TARGET_RESERVED", "services.app.volumes[0]"],
    ["mount under /run", build([app("volumes"), ["data:/run/x"]]), "VOLUME_TARGET_RESERVED", "services.app.volumes[0]"],
    ["bad mount mode", build([app("volumes"), ["data:/app/data:z"]]), "VOLUME_MODE_INVALID", "services.app.volumes[0]"],
    ["undeclared volume", build([app("volumes"), ["other:/app/data"]]), "VOLUME_UNDECLARED", "services.app.volumes[0]"],
    ["same target twice", build([app("volumes"), ["data:/app/data", "data:/app/data"]]), "VOLUME_DUPLICATE", "services.app.volumes[1]"],
    [
      "volume driver options",
      build([["volumes", "data"], { driver: "local", driver_opts: { type: "none", device: "/", o: "bind" } }]),
      "VOLUME_OPTIONS_REFUSED",
      "volumes.data",
    ],
    ["unused volume", build([["volumes", "spare"], {}]), "VOLUME_UNUSED", "volumes.spare"],
    ["network_mode: host", build([app("network_mode"), "host"]), "KEY_FORBIDDEN_NETWORK", "services.app.network_mode"],
    ["pid: host", build([app("pid"), "host"]), "KEY_FORBIDDEN_SECURITY", "services.app.pid"],
    ["ipc: host", build([app("ipc"), "host"]), "KEY_FORBIDDEN_SECURITY", "services.app.ipc"],
    ["sh -c", build([app("command"), ["sh", "-c", "x"]]), "ARGV_SHELL_REFUSED", "services.app.command[0]"],
    ["/bin/bash", build([app("command"), ["/bin/bash"]]), "ARGV_SHELL_REFUSED", "services.app.command[0]"],
    ["busybox sh", build([app("command"), ["busybox", "sh"]]), "ARGV_SHELL_REFUSED", "services.app.command[0]"],
    ["/usr/bin/env sh", build([app("command"), ["/usr/bin/env", "sh"]]), "ARGV_SHELL_REFUSED", "services.app.command[0]"],
    ["a shell after a launcher", build([app("command"), ["nohup", "/bin/sh", "-c", "x"]]), "ARGV_SHELL_REFUSED", "services.app.command[1]"],
    ["a shell after the loader", build([app("command"), ["/lib64/ld-linux-x86-64.so.2", "/bin/sh", "-c", "${worker_count}"]]), "ARGV_SHELL_REFUSED", "services.app.command[1]"],
    ["a padded shell later in argv", build([app("command"), ["timeout", "5", " bash "]]), "ARGV_SHELL_REFUSED", "services.app.command[2]"],
    ["env later in argv", build([app("command"), ["serve", "/usr/bin/env"]]), "ARGV_SHELL_REFUSED", "services.app.command[1]"],
    ["shell-form command", build([app("command"), "serve --x"]), "TYPE_MISMATCH", "services.app.command"],
    ["Compose test health check", build([app("healthcheck"), { test: ["CMD-SHELL", "x"] }]), "KEY_UNSUPPORTED", "services.app.healthcheck.test"],
    ["health check without kind", build([app("healthcheck"), { test: ["CMD-SHELL", "x"] }]), "HEALTH_KIND_INVALID", "services.app.healthcheck"],
    ["replicas", build([app("deploy", "replicas"), 2]), "KEY_UNSUPPORTED", "services.app.deploy.replicas"],
    ["tcp ingress", build([["x-hp-ingress", 0, "protocol"], "tcp"]), "INGRESS_PROTOCOL_UNSUPPORTED", "x-hp-ingress[0].protocol"],
    ["port_choice parameter", build([param(0, "type"), "port_choice"]), "PARAM_TYPE_UNSUPPORTED", "x-hp-parameters[0].type"],
    ["x-hp-ports", build([["x-hp-ports"], [{ service: "app", port: 8080 }]]), "KEY_UNSUPPORTED", "x-hp-ports"],
    ["build", build([app("build"), "."]), "KEY_FORBIDDEN_HOST_ACCESS", "services.app.build"],
  ];
  it.each(rows)("%s", (_name, document, code, path) => {
    refused(document, code, path);
  });
});

describe("A5: parser abuse is one positioned STACK_TEMPLATE_INVALID issue", () => {
  const nested = (depth: number): string => `${Array.from({ length: depth }, (_, i) => `${"  ".repeat(i)}a:`).join("\n")} 1\n`;
  const rows: readonly (readonly [name: string, source: string, code: string])[] = [
    ["anchor", "a: &x 1\n", "ANCHOR"],
    ["alias", "a: [*x]\n", "ALIAS"],
    ["merge key", "a:\n  <<: {b: 1}\n", "MERGE_KEY"],
    ["multi-document", "a: 1\n---\nb: 2\n", "MULTI_DOCUMENT"],
    ["tag", "a: !!python/object/apply:os.system ['id']\n", "TAG"],
    ["65 537 bytes", `# ${"x".repeat(65_534)}\n`, "TOO_LARGE"],
    ["depth 17", nested(17), "TOO_DEEP"],
    ["4 097 nodes", "- 1\n".repeat(4_096), "TOO_MANY_NODES"],
    ["duplicate key", "services: {}\nservices: {}\n", "DUPLICATE_KEY"],
    ["__proto__ key", "__proto__: {privileged: true}\n", "FORBIDDEN_KEY"],
    ["block scalar", "a: |\n  x\n", "BLOCK_SCALAR"],
  ];

  it("the depth row is exactly one level too deep", () => {
    expect(validateAppTemplateSource(nested(16)).ok).toBe(false);
    expect(errorsOfSource(nested(16))[0]?.code).not.toBe("TOO_DEEP");
  });

  it.each(rows)("%s", (_name, source, code) => {
    const started = performance.now();
    const errors = errorsOfSource(source);
    expect(performance.now() - started).toBeLessThan(200);
    expect(errors).toEqual([
      { path: "", line: expect.any(Number), column: expect.any(Number), code, reason: "STACK_TEMPLATE_INVALID", message: expect.any(String) },
    ]);
  });
});

function errorsOfSource(source: string): AppTemplateIssue[] {
  const result = validateAppTemplateSource(source, { allowlist: ALLOWLIST });
  if (result.ok) throw new Error("expected the source to be refused");
  return result.errors;
}

describe("A6: dependencies", () => {
  it("refuses a cycle a <-> b with one issue per service", () => {
    const errors = refused(build([["services", "cache", "depends_on"], ["app"]]), "DEPENDENCY_CYCLE", "services.app.depends_on");
    expect(errors).toContainEqual(expect.objectContaining({ path: "services.cache.depends_on", code: "DEPENDENCY_CYCLE", reason: "STACK_DEPENDENCY_CYCLE" }));
  });

  it.each<Row>([
    ["self", build([app("depends_on"), ["app"]]), "DEPENDS_ON_SELF", "services.app.depends_on[0]"],
    ["unknown", build([app("depends_on"), ["nope"]]), "DEPENDS_ON_UNKNOWN", "services.app.depends_on[0]"],
    ["duplicate", build([app("depends_on"), ["cache", "cache"]]), "DEPENDS_ON_DUPLICATE", "services.app.depends_on[1]"],
    ["long syntax", build([app("depends_on"), { cache: { condition: "service_healthy" } }]), "DEPENDS_ON_INVALID", "services.app.depends_on"],
    ["too many", build([app("depends_on"), Array.from({ length: 9 }, (_, i) => `s${i}`)]), "DEPENDS_ON_TOO_MANY", "services.app.depends_on"],
  ])("%s", (_name, document, code, path) => {
    refused(document, code, path);
  });

  it("reports no cycle while a dependency is unknown", () => {
    const errors = errorsOf(build([app("depends_on"), ["nope"]], [["services", "cache", "depends_on"], ["app"]]));
    expect(errors.some((issue) => issue.code === "DEPENDENCY_CYCLE")).toBe(false);
  });
});

describe("A7: interpolation and injection", () => {
  const command = (...items: unknown[]) => build([app("command"), ["serve", ...items]]);
  const env = (value: unknown) => build([app("environment", 0, "value"), value]);
  const rows: readonly Row[] = [
    ["two placeholders in one item", command("${worker_count}${worker_count}"), "ARGV_PLACEHOLDER_NOT_WHOLE", "services.app.command[1]"],
    ["placeholder inside an option", command("--x=${worker_count}"), "ARGV_PLACEHOLDER_NOT_WHOLE", "services.app.command[1]"],
    ["placeholder as the executable", build([app("command"), ["${worker_count}"]]), "ARGV_EXECUTABLE_PLACEHOLDER", "services.app.command[0]"],
    ["secret in argv", command("${app_secret}"), "INTERP_SECRET_PARAMETER", "services.app.command[1]"],
    ["secret in env", env("${app_secret}"), "INTERP_SECRET_PARAMETER", "services.app.environment[0].value"],
    ["default syntax", env("${worker_count:-x}"), "INTERP_SYNTAX", "services.app.environment[0].value"],
    ["bare $x", command("$x"), "INTERP_SYNTAX", "services.app.command[1]"],
    ["unknown variable", env("${nope}"), "INTERP_UNKNOWN_VARIABLE", "services.app.environment[0].value"],
    ["no magic variables", env("${HP_SITE_ID}"), "INTERP_UNKNOWN_VARIABLE", "services.app.environment[0].value"],
    ["newline in env literal", env("a\nb"), "ENV_VALUE_INVALID", "services.app.environment[0].value"],
    ["NUL in argv literal", command("a\u0000b"), "ARGV_ITEM_INVALID", "services.app.command[1]"],
    ["empty argv item", command(""), "ARGV_ITEM_INVALID", "services.app.command[1]"],
    ["docker socket in argv", command("--sock=/var/run/docker.sock"), "ARGV_ITEM_INVALID", "services.app.command[1]"],
    ["number in argv", command(8080), "ARGV_ITEM_NOT_STRING", "services.app.command[1]"],
    ["empty command", build([app("command"), []]), "ARGV_EMPTY", "services.app.command"],
    ["65 argv items", build([app("command"), Array.from({ length: 65 }, () => "x")]), "ARGV_TOO_MANY", "services.app.command"],
    ["URL credentials in env", env("https://u:pw1234@db.example.invalid"), "ENV_VALUE_SECRET_LIKE", "services.app.environment[0].value"],
    ["metadata endpoint in env", env("http://169.254.169.254/latest"), "ENV_VALUE_METADATA_ENDPOINT", "services.app.environment[0].value"],
    ["docker socket in env", env("unix:///var/run/docker.sock"), "ENV_VALUE_DOCKER_SOCKET", "services.app.environment[0].value"],
    ["number in env", env(1), "ENV_VALUE_NOT_STRING", "services.app.environment[0].value"],
    ["4097-char env literal", env("x".repeat(4_097)), "ENV_VALUE_TOO_LONG", "services.app.environment[0].value"],
  ];
  it.each(rows)("%s", (_name, document, code, path) => {
    refused(document, code, path);
  });

  it("refuses a value that could exceed 4096 characters once filled in", () => {
    const document = build(
      [["x-hp-parameters", 2], { key: "motd", label: "Motd", type: "string", default: "hi", customer: true }],
      [app("environment", 0, "value"), `${"x".repeat(3_900)}\${motd}`],
    );
    refused(document, "ENV_VALUE_TOO_LONG", "services.app.environment[0].value");
  });

  it("never echoes the refused value", () => {
    const value = "https://admin:SuperSecret42@db.example.invalid";
    expect(JSON.stringify(errorsOf(env(value)))).not.toContain("SuperSecret42");
  });

  it("treats shell metacharacters in a literal argv item as inert text", () => {
    expect(accepted(command("a;b|c&&$$(rm -rf /)`x`"))).toBe(true);
  });

  it("accepts argv items that only contain a shell name", () => {
    expect(accepted(command("--shell=sh", "bashful", "/srv/sh.d"))).toBe(true);
  });
});

describe("environment names", () => {
  const entry = (value: unknown) => build([app("environment", 2), value]);
  it("allows PORT as a value entry", () => {
    expect(accepted(entry({ name: "PORT", value: "8080" }))).toBe(true);
  });

  it.each<Row>([
    ["secret-like value name", entry({ name: "APP_SECRET", value: "x" }), "ENV_NAME_SECRET_LIKE", "services.app.environment[2].name"],
    ["*_FILE value entry", entry({ name: "X_FILE", value: "/x" }), "ENV_NAME_RESERVED", "services.app.environment[2].name"],
    ["HP_ prefix", entry({ name: "HP_X", value: "x" }), "ENV_NAME_RESERVED", "services.app.environment[2].name"],
    ["lower-case name", entry({ name: "lower", value: "x" }), "ENV_NAME_INVALID", "services.app.environment[2].name"],
    ["duplicate name", entry({ name: "CACHE_HOST", value: "x" }), "ENV_NAME_DUPLICATE", "services.app.environment[2].name"],
    ["value and secret", entry({ name: "B_FILE", value: "x", secret: "app_secret" }), "ENV_ENTRY_INVALID", "services.app.environment[2]"],
    ["neither value nor secret", entry({ name: "B" }), "ENV_ENTRY_INVALID", "services.app.environment[2]"],
    ["Compose string entry", entry("A=b"), "ENV_ENTRY_INVALID", "services.app.environment[2]"],
    ["secret without _FILE", entry({ name: "APP_KEY", secret: "app_secret" }), "ENV_SECRET_NAME_INVALID", "services.app.environment[2].name"],
    ["secret with a reserved name", entry({ name: "HP_X_FILE", secret: "app_secret" }), "ENV_SECRET_NAME_INVALID", "services.app.environment[2].name"],
    ["secret naming a plain parameter", entry({ name: "B_FILE", secret: "worker_count" }), "ENV_SECRET_UNKNOWN", "services.app.environment[2].secret"],
    ["secret naming nothing", entry({ name: "B_FILE", secret: "nope" }), "ENV_SECRET_UNKNOWN", "services.app.environment[2].secret"],
    ["65 entries", build([app("environment"), Array.from({ length: 65 }, (_, i) => ({ name: `V${i}`, value: "x" }))]), "ENV_TOO_MANY", "services.app.environment"],
  ])("%s", (_name, document, code, path) => {
    refused(document, code, path);
  });
});

describe("A12: resource bounds", () => {
  const limits = (key: string, value: unknown) => build([app("deploy", "resources", "limits", key), value]);
  it.each<Row>([
    ["cpus 16.001", limits("cpus", "16.001"), "LIMIT_CPU_RANGE", "services.app.deploy.resources.limits.cpus"],
    ["cpus 0.01", limits("cpus", "0.01"), "LIMIT_CPU_RANGE", "services.app.deploy.resources.limits.cpus"],
    ["cpus 1.0000", limits("cpus", "1.0000"), "LIMIT_CPU_FORMAT", "services.app.deploy.resources.limits.cpus"],
    ["memory 17G", limits("memory", "17G"), "LIMIT_MEMORY_RANGE", "services.app.deploy.resources.limits.memory"],
    ["memory 16M", limits("memory", "16M"), "LIMIT_MEMORY_RANGE", "services.app.deploy.resources.limits.memory"],
    ["memory 1T", limits("memory", "1T"), "LIMIT_MEMORY_FORMAT", "services.app.deploy.resources.limits.memory"],
    ["limits.pids", limits("pids", 100), "KEY_UNSUPPORTED", "services.app.deploy.resources.limits.pids"],
    ["no deploy", build([app("deploy"), REMOVE]), "LIMIT_MISSING", "services.app"],
    ["no memory", limits("memory", REMOVE), "LIMIT_MISSING", "services.app.deploy.resources.limits"],
    ["reservations", build([app("deploy", "resources", "reservations"), {}]), "KEY_UNSUPPORTED", "services.app.deploy.resources.reservations"],
    ["17 exposed ports", build([app("expose"), Array.from({ length: 17 }, (_, i) => 9000 + i)]), "EXPOSE_TOO_MANY", "services"],
    ["port as a string", build([app("expose"), ["8080"]]), "EXPOSE_INVALID", "services.app.expose[0]"],
    ["port 0", build([app("expose"), [0]]), "EXPOSE_INVALID", "services.app.expose[0]"],
    ["same port twice", build([app("expose"), [8080, 8080]]), "EXPOSE_DUPLICATE", "services.app.expose[1]"],
    ["ten services", build(...Array.from({ length: 8 }, (_, i): Edit => [["services", `s${i}`], {}])), "SERVICES_TOO_MANY", "services"],
  ])("%s", (_name, document, code, path) => {
    refused(document, code, path);
  });

  it("accepts the bounds themselves", () => {
    expect(accepted(build([app("deploy", "resources", "limits"), { cpus: "0.05", memory: "32M" }]))).toBe(true);
    expect(accepted(build([app("deploy", "resources", "limits"), { cpus: 16, memory: "16G" }]))).toBe(true);
  });
});

describe("A13: image rules", () => {
  const image = (value: unknown) => build([app("image"), value]);
  it.each<Row>([
    ["no digest", image(`${IMAGE}:1.2.3`), "IMAGE_DIGEST_REQUIRED", "services.app.image"],
    ["latest", image(`${IMAGE}:latest@${DIGEST}`), "IMAGE_TAG_LATEST", "services.app.image"],
    ["short digest", image(`${IMAGE}@sha256:abc`), "IMAGE_MALFORMED", "services.app.image"],
    ["not allowlisted", image(`registry.example.invalid/demo/other@${DIGEST}`), "IMAGE_NOT_ALLOWLISTED", "services.app.image"],
    ["look-alike repository", image(`registry.example.invalid/demo/app-evil@${DIGEST}`), "IMAGE_NOT_ALLOWLISTED", "services.app.image"],
    ["registry dropped", image(`demo/app@${DIGEST}`), "IMAGE_NOT_ALLOWLISTED", "services.app.image"],
    ["credentials", image(`user:pw@host/x@${DIGEST}`), "IMAGE_MALFORMED", "services.app.image"],
    ["placeholder", image(`${IMAGE}:\${worker_count}@${DIGEST}`), "IMAGE_MALFORMED", "services.app.image"],
    ["not a string", image(5), "IMAGE_MALFORMED", "services.app.image"],
    ["missing", image(REMOVE), "IMAGE_MISSING", "services.app"],
  ])("%s", (_name, document, code, path) => {
    refused(document, code, path);
  });

  it("accepts a digest-pinned allowlisted image without a tag", () => {
    expect(accepted(image(`${IMAGE}@${DIGEST}`))).toBe(true);
  });
});

describe("parameter definitions", () => {
  const secret = (key: string) => ({ key, label: "S", type: "secret", required: false, customer: true });
  it.each<Row>([
    ["33 parameters", build([["x-hp-parameters"], Array.from({ length: 33 }, (_, i) => ({ ...secret(`p${i}`), type: "boolean", default: true }))]), "PARAM_TOO_MANY", "x-hp-parameters"],
    ["9 secrets", build([["x-hp-parameters"], [...(BASE as Node)["x-hp-parameters"] as unknown[], ...Array.from({ length: 8 }, (_, i) => secret(`s${i}`))]]), "PARAM_SECRET_TOO_MANY", "x-hp-parameters"],
    ["no label", build([param(0, "label"), REMOVE]), "PARAM_FIELD_MISSING", "x-hp-parameters[0]"],
    ["no customer", build([param(0, "customer"), REMOVE]), "PARAM_FIELD_MISSING", "x-hp-parameters[0]"],
    ["upper-case key", build([param(0, "key"), "Workers"]), "PARAM_KEY_INVALID", "x-hp-parameters[0].key"],
    ["hp_ key", build([param(0, "key"), "hp_x"]), "PARAM_KEY_INVALID", "x-hp-parameters[0].key"],
    ["duplicate key", build([param(1, "key"), "worker_count"]), "PARAM_KEY_DUPLICATE", "x-hp-parameters[1].key"],
    ["unknown type", build([param(0, "type"), "float"]), "PARAM_TYPE_INVALID", "x-hp-parameters[0].type"],
    ["empty label", build([param(0, "label"), ""]), "PARAM_LABEL_INVALID", "x-hp-parameters[0].label"],
    ["control char in label", build([param(0, "label"), "a\u0007"]), "PARAM_LABEL_INVALID", "x-hp-parameters[0].label"],
    ["enum without options", build([param(0), { key: "mode", label: "M", type: "enum", default: "a", customer: true }]), "PARAM_OPTIONS_INVALID", "x-hp-parameters[0]"],
    ["duplicate option", build([param(0), { key: "mode", label: "M", type: "enum", options: ["a", "a"], default: "a", customer: true }]), "PARAM_OPTIONS_INVALID", "x-hp-parameters[0].options[1]"],
    ["options on an integer", build([param(0, "options"), ["1"]]), "PARAM_OPTIONS_INVALID", "x-hp-parameters[0].options"],
    ["min above max", build([param(0, "min"), 5]), "PARAM_BOUNDS_INVALID", "x-hp-parameters[0].min"],
    ["bound beyond 1e9", build([param(0, "max"), 1_000_000_001]), "PARAM_BOUNDS_INVALID", "x-hp-parameters[0].max"],
    ["min on a secret", build([param(1, "min"), 1]), "PARAM_BOUNDS_INVALID", "x-hp-parameters[1].min"],
    ["no default", build([param(0, "default"), REMOVE]), "PARAM_DEFAULT_MISSING", "x-hp-parameters[0]"],
    ["default out of range", build([param(0, "default"), 9]), "PARAM_DEFAULT_INVALID", "x-hp-parameters[0].default"],
    ["default of the wrong type", build([param(0, "default"), "2"]), "PARAM_DEFAULT_INVALID", "x-hp-parameters[0].default"],
    ["secret with a default", build([param(1, "default"), "x"]), "PARAM_DEFAULT_NOT_ALLOWED", "x-hp-parameters[1].default"],
    ["required on a plain parameter", build([param(0, "required"), true]), "PARAM_REQUIRED_INVALID", "x-hp-parameters[0].required"],
    ["secret without required", build([param(1, "required"), REMOVE]), "PARAM_REQUIRED_INVALID", "x-hp-parameters[1]"],
    ["secret with customer: false", build([param(1, "customer"), false]), "PARAM_SECRET_NOT_CUSTOMER", "x-hp-parameters[1].customer"],
    [
      "string default that looks like an API key",
      build([["x-hp-parameters", 2], { key: "token", label: "T", type: "string", default: `sk-${"A".repeat(30)}`, customer: false }]),
      "ENV_VALUE_SECRET_LIKE",
      "x-hp-parameters[2].default",
    ],
    [
      "string default that looks like a cloud key",
      build([["x-hp-parameters", 2], { key: "token", label: "T", type: "string", default: `AKIA${"B".repeat(16)}`, customer: true }]),
      "ENV_VALUE_SECRET_LIKE",
      "x-hp-parameters[2].default",
    ],
    [
      "string default with URL credentials",
      build([["x-hp-parameters", 2], { key: "dsn", label: "D", type: "string", default: "http://u:p@h", customer: false }]),
      "PARAM_DEFAULT_INVALID",
      "x-hp-parameters[2].default",
    ],
  ])("%s", (_name, document, code, path) => {
    refused(document, code, path);
  });

  it("a broken parameter is still declared: no unknown-variable cascade", () => {
    const errors = errorsOf(build([param(0, "default"), 9]));
    expect(errors.some((issue) => issue.code === "INTERP_UNKNOWN_VARIABLE")).toBe(false);
  });
});

describe("header, services and ingress", () => {
  it.each<Row>([
    ["no header", build([["x-hp-stack"], REMOVE]), "HEADER_MISSING", ""],
    ["schemaVersion 3", build([["x-hp-stack", "schemaVersion"], 3]), "HEADER_VERSION_UNSUPPORTED", "x-hp-stack.schemaVersion"],
    ["schemaVersion \"2\"", build([["x-hp-stack", "schemaVersion"], "2"]), "HEADER_VERSION_UNSUPPORTED", "x-hp-stack.schemaVersion"],
    ["no schemaVersion", build([["x-hp-stack", "schemaVersion"], REMOVE]), "HEADER_VERSION_UNSUPPORTED", "x-hp-stack"],
    ["name of 81 chars", build([["x-hp-stack", "name"], "n".repeat(81)]), "HEADER_NAME_INVALID", "x-hp-stack.name"],
    ["category with _", build([["x-hp-stack", "category"], "my_cat"]), "HEADER_CATEGORY_INVALID", "x-hp-stack.category"],
    ["description with a newline", build([["x-hp-stack", "description"], "a\nb"]), "HEADER_DESCRIPTION_INVALID", "x-hp-stack.description"],
    ["no services", build([["services"], REMOVE]), "SERVICES_MISSING", ""],
    ["empty services", build([["services"], {}]), "SERVICES_MISSING", "services"],
    ["service name with _", build([["services", "my_app"], {}]), "SERVICE_NAME_INVALID", "services.my_app"],
    ["nine volumes", build(...Array.from({ length: 8 }, (_, i): Edit => [["volumes", `v${i}`], {}])), "VOLUME_TOO_MANY", "volumes"],
    ["volume name with _", build([["volumes", "my_data"], {}]), "VOLUME_NAME_INVALID", "volumes.my_data"],
    ["http check without path", build([app("healthcheck", "kind"), "http"]), "HEALTH_PATH_MISSING", "services.app.healthcheck"],
    ["tcp check with path", build([app("healthcheck", "path"), "/"]), "HEALTH_PATH_NOT_ALLOWED", "services.app.healthcheck.path"],
    ["http check with .. path", build([app("healthcheck", "kind"), "http"], [app("healthcheck", "path"), "/a/../b"]), "HEALTH_PATH_INVALID", "services.app.healthcheck.path"],
    ["health port not exposed", build([app("healthcheck", "port"), 9090]), "HEALTH_PORT_NOT_EXPOSED", "services.app.healthcheck.port"],
    ["interval 4", build([app("healthcheck", "intervalSeconds"), 4]), "HEALTH_INTERVAL_INVALID", "services.app.healthcheck.intervalSeconds"],
    ["timeout above interval", build([app("healthcheck", "intervalSeconds"), 5], [app("healthcheck", "timeoutSeconds"), 6]), "HEALTH_TIMEOUT_INVALID", "services.app.healthcheck.timeoutSeconds"],
    ["ingress to an unknown service", build([["x-hp-ingress", 0, "service"], "web"]), "INGRESS_SERVICE_UNKNOWN", "x-hp-ingress[0].service"],
    ["ingress port not exposed", build([["x-hp-ingress", 0, "port"], 9090]), "INGRESS_PORT_NOT_EXPOSED", "x-hp-ingress[0].port"],
    ["ingress without protocol", build([["x-hp-ingress", 0, "protocol"], REMOVE]), "INGRESS_PROTOCOL_UNSUPPORTED", "x-hp-ingress[0]"],
    ["ingress twice", build([["x-hp-ingress", 1], { service: "app", port: 8080, protocol: "http" }]), "INGRESS_DUPLICATE", "x-hp-ingress[1]"],
    ["ingress without health check", build([app("healthcheck"), REMOVE]), "INGRESS_HEALTHCHECK_MISSING", "x-hp-ingress[0].service"],
    ["nine ingress routes", build([["x-hp-ingress"], Array.from({ length: 9 }, () => ({ service: "app", port: 8080, protocol: "http" }))]), "INGRESS_TOO_MANY", "x-hp-ingress"],
    ["ingress hostname", build([["x-hp-ingress", 0, "hostname"], "evil.example"]), "KEY_FORBIDDEN_NETWORK", "x-hp-ingress[0].hostname"],
  ])("%s", (_name, document, code, path) => {
    refused(document, code, path);
  });

  it("applies the health check defaults", () => {
    const result = validateAppTemplate(build([app("healthcheck"), { kind: "http", port: 8080, path: "/health" }]), undefined, { allowlist: ALLOWLIST });
    expect(result.ok && result.spec.services[0]?.healthcheck).toEqual({ kind: "http", port: 8080, path: "/health", intervalSeconds: 10, timeoutSeconds: 3 });
  });
});
