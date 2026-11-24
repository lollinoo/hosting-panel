import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AppTemplateIssueSchema,
  AppTemplateSpecSchema,
  parseTemplateYaml,
  sortAppTemplateIssues,
  type AppImageAllowlistEntry,
} from "@hosting-panel/contracts";
import { validateAppTemplate, validateAppTemplateSource } from "../src/app-template-validation.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../contracts/test/fixtures/app-stack-notes-demo/${name}`, import.meta.url), "utf8");
const SOURCE = fixture("source.yaml");
const SPEC: unknown = JSON.parse(fixture("spec.json"));
const ALLOWLIST = JSON.parse(fixture("allowlist.json")) as AppImageAllowlistEntry[];
const options = { allowlist: ALLOWLIST };

const parsed = parseTemplateYaml(SOURCE);
if (!parsed.ok) throw new Error("the fixture must parse");
const DOCUMENT = parsed.value;

const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const errorsOf = (source: string) => {
  const result = validateAppTemplateSource(source, options);
  if (result.ok) throw new Error("expected the source to be refused");
  return result.errors;
};

describe("validateAppTemplateSource on the notes-demo fixture", () => {
  it("validates to exactly spec.json, in the stored key order", () => {
    const result = validateAppTemplateSource(SOURCE, options);
    expect(result).toEqual({ ok: true, spec: SPEC });
    if (!result.ok) return;
    expect(JSON.stringify(result.spec)).toBe(JSON.stringify(SPEC));
    expect(AppTemplateSpecSchema.safeParse(result.spec).success).toBe(true);
  });

  it("gives the same spec from a JSON rendering of the document", () => {
    const json: unknown = JSON.parse(JSON.stringify(DOCUMENT));
    expect(validateAppTemplate(json, undefined, options)).toEqual({ ok: true, spec: SPEC });
  });

  it("does not mutate the document or the allowlist", () => {
    const document = deepFreeze(structuredClone(DOCUMENT));
    const allowlist = deepFreeze(structuredClone(ALLOWLIST));
    const before = JSON.stringify([document, allowlist]);
    expect(validateAppTemplate(document, parsed.locate, { allowlist })).toEqual({ ok: true, spec: SPEC });
    expect(JSON.stringify([document, allowlist])).toBe(before);
  });

  it("refuses both fixture images with the default allowlist", () => {
    const result = validateAppTemplateSource(SOURCE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((issue) => [issue.path, issue.code, issue.reason])).toEqual([
      ["services.app.image", "IMAGE_NOT_ALLOWLISTED", "STACK_IMAGE_NOT_ALLOWED"],
      ["services.cache.image", "IMAGE_NOT_ALLOWLISTED", "STACK_IMAGE_NOT_ALLOWED"],
    ]);
  });
});

describe("issue positions", () => {
  const cases: readonly [code: string, from: string, to: string, path: string, line: number, column: number][] = [
    ["HEADER_VERSION_UNSUPPORTED", "schemaVersion: 1", "schemaVersion: 3", "x-hp-stack.schemaVersion", 2, 18],
    ["PARAM_DEFAULT_INVALID", "default: 2", "default: 9", "x-hp-parameters[0].default", 12, 14],
    ["KEY_FORBIDDEN_SECURITY", "  app:\n", "  app:\n    privileged: true\n", "services.app.privileged", 21, 5],
    ["ARGV_SHELL_REFUSED", '["serve",', '["sh",', "services.app.command[0]", 22, 15],
    ["ENV_NAME_SECRET_LIKE", "name: CACHE_HOST", "name: CACHE_PASSWORD", "services.app.environment[0].name", 24, 15],
    ["VOLUME_HOST_PATH", "- data:/app/data", "- /srv:/app/data", "services.app.volumes[0]", 29, 9],
    ["DEPENDS_ON_UNKNOWN", "      - cache\n", "      - cachex\n", "services.app.depends_on[0]", 33, 9],
    ["HEALTH_INTERVAL_INVALID", "intervalSeconds: 15", "intervalSeconds: 400", "services.app.healthcheck.intervalSeconds", 37, 24],
    ["IMAGE_NOT_ALLOWLISTED", "demo/cache:4.5.6", "demo/other:4.5.6", "services.cache.image", 45, 12],
    ["LIMIT_MEMORY_RANGE", "memory: 256M", "memory: 16M", "services.cache.deploy.resources.limits.memory", 52, 19],
    ["INGRESS_PROTOCOL_UNSUPPORTED", "protocol: http", "protocol: tcp", "x-hp-ingress[0].protocol", 58, 15],
  ];

  it.each(cases)("%s carries its line and column", (code, from, to, path, line, column) => {
    expect(SOURCE).toContain(from);
    expect(errorsOf(SOURCE.replace(from, to))).toContainEqual(expect.objectContaining({ code, path, line, column }));
  });
});

describe("issue list", () => {
  it("is sorted, schema-valid and capped at 50", () => {
    const keys = Array.from({ length: 60 }, (_, i) => `    k${i}: 1\n`).join("");
    const errors = errorsOf(SOURCE.replace("  app:\n", `  app:\n${keys}`));
    expect(errors).toHaveLength(50);
    expect(errors).toEqual(sortAppTemplateIssues(errors));
    for (const issue of errors) expect(AppTemplateIssueSchema.parse(issue)).toEqual(issue);
    expect(errors.every((issue) => issue.code === "KEY_UNKNOWN")).toBe(true);
  });

  it("never throws: a failure inside the validator is one SPEC_INTERNAL issue", () => {
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("boom"); } });
    expect(validateAppTemplate(hostile, undefined, options)).toEqual({
      ok: false,
      errors: [{ path: "", code: "SPEC_INTERNAL", reason: "STACK_TEMPLATE_INVALID", message: expect.any(String) }],
    });
  });

  it("refuses a document that is not a mapping", () => {
    expect(errorsOf("- 1\n")).toEqual([expect.objectContaining({ path: "", code: "DOCUMENT_NOT_MAPPING", reason: "STACK_TEMPLATE_INVALID" })]);
  });

  it("keeps every path within the 512 characters of the issue schema", () => {
    const key = "\\".repeat(128);
    const document = structuredClone(DOCUMENT) as { services: Record<string, unknown> };
    document.services[key] = { [key]: 1 };
    const result = validateAppTemplate(document, undefined, options);
    if (result.ok) throw new Error("expected the document to be refused");
    expect(result.errors.some((issue) => issue.path.endsWith("..."))).toBe(true);
    for (const issue of result.errors) expect(AppTemplateIssueSchema.parse(issue)).toEqual(issue);
  });

  it("clips a duplicate key name to 64 characters in the message", () => {
    const key = "k".repeat(100);
    const [issue] = errorsOf(`${key}: 1\n${key}: 2\n`);
    expect(issue?.code).toBe("DUPLICATE_KEY");
    expect(issue?.message).not.toContain("k".repeat(65));
    expect(issue?.message).toContain(`"${"k".repeat(61)}..."`);
  });
});

describe("service key length", () => {
  const renamed = (key: string) => SOURCE.replace("  cache:\n", `  ${key}:\n`).replace("      - cache\n", `      - ${key}\n`);

  it("accepts a 27-character service key and refuses a 28-character one at services.<key>", () => {
    expect(validateAppTemplateSource(renamed(`c${"a".repeat(26)}`), options).ok).toBe(true);
    const key = `c${"a".repeat(27)}`;
    expect(errorsOf(renamed(key)).map((issue) => [issue.path, issue.code])).toEqual([[`services.${key}`, "SERVICE_NAME_INVALID"]]);
  });
});

describe("explicit YAML null is not an absent key", () => {
  it.each([
    ["intervalSeconds: 15", "intervalSeconds: ~", "services.app.healthcheck.intervalSeconds"],
    ["timeoutSeconds: 3", "timeoutSeconds:", "services.app.healthcheck.timeoutSeconds"],
    ["description: Two components with private cache and HTTP ingress", "description: ~", "x-hp-stack.description"],
  ])("%j written as %j is one TYPE_MISMATCH", (from, to, path) => {
    expect(SOURCE).toContain(from);
    expect(errorsOf(SOURCE.replace(from, to)).map((issue) => [issue.path, issue.code])).toEqual([[path, "TYPE_MISMATCH"]]);
  });
});

describe("lone UTF-16 surrogates", () => {
  it.each([["high", "\ud800"], ["low", "\udc00"]])("refuse the source before it is parsed (a %s surrogate)", (_, unit) => {
    expect(errorsOf(SOURCE.replace("name: Notes Demo", `name: Notes ${unit}Demo`))).toEqual([
      { path: "", line: 3, column: 15, code: "CONTROL_CHARACTER", reason: "STACK_TEMPLATE_INVALID", message: expect.any(String) },
    ]);
  });

  it("leave a well-formed pair alone", () => {
    expect(validateAppTemplateSource(SOURCE.replace("name: Notes Demo", "name: Notes \u{1F600} Demo"), options).ok).toBe(true);
  });
});
