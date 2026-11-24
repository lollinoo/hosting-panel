import { describe, expect, it } from "vitest";
import {
  APP_STACK_REASONS,
  APP_TEMPLATE_ISSUE_CODES,
  APP_TEMPLATE_ISSUE_REASON,
  APP_TEMPLATE_VALIDATOR_ISSUE_CODES,
  APP_TEMPLATE_VALUE_ISSUE_CODES,
  AppTemplateIssueSchema,
  sortAppTemplateIssues,
  type AppTemplateIssue,
} from "../src/app-templates/issues.js";
import { YAML_ERROR_CODES } from "../src/site-templates/yaml-subset.js";

describe("APP_STACK_REASONS", () => {
  it("holds the ten spec §16 names verbatim plus STACK_PARAMETER_INVALID", () => {
    expect(APP_STACK_REASONS).toEqual([
      "STACK_TEMPLATE_INVALID",
      "STACK_TEMPLATE_UNPUBLISHED",
      "STACK_IMAGE_NOT_ALLOWED",
      "STACK_QUOTA_EXCEEDED",
      "STACK_DEPENDENCY_CYCLE",
      "STACK_HEALTH_TIMEOUT",
      "STACK_PORT_UNAVAILABLE",
      "STACK_SECRET_MISSING",
      "STACK_VOLUME_IN_USE",
      "STACK_UNSUPPORTED_FEATURE",
      "STACK_PARAMETER_INVALID",
    ]);
  });
});

describe("APP_TEMPLATE_ISSUE_CODES", () => {
  it("is the YAML codes, then the validator codes, then the value codes, all unique UPPER_SNAKE", () => {
    expect(APP_TEMPLATE_ISSUE_CODES).toEqual([...YAML_ERROR_CODES, ...APP_TEMPLATE_VALIDATOR_ISSUE_CODES, ...APP_TEMPLATE_VALUE_ISSUE_CODES]);
    expect(new Set(APP_TEMPLATE_ISSUE_CODES).size).toBe(APP_TEMPLATE_ISSUE_CODES.length);
    for (const code of APP_TEMPLATE_ISSUE_CODES) expect(code).toMatch(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
    expect(APP_TEMPLATE_VALIDATOR_ISSUE_CODES).toHaveLength(112);
    expect(APP_TEMPLATE_VALUE_ISSUE_CODES).toHaveLength(14);
    expect(APP_TEMPLATE_VALIDATOR_ISSUE_CODES[0]).toBe("DOCUMENT_NOT_MAPPING");
    expect(APP_TEMPLATE_VALIDATOR_ISSUE_CODES.at(-1)).toBe("SPEC_INTERNAL");
    expect(APP_TEMPLATE_VALUE_ISSUE_CODES[0]).toBe("PARAM_VALUE_UNKNOWN");
    expect(APP_TEMPLATE_VALUE_ISSUE_CODES.at(-1)).toBe("PLAN_TOO_LARGE");
  });
});

describe("APP_TEMPLATE_ISSUE_REASON", () => {
  it("is frozen and total: exactly one known reason per code", () => {
    expect(Object.isFrozen(APP_TEMPLATE_ISSUE_REASON)).toBe(true);
    expect(Object.keys(APP_TEMPLATE_ISSUE_REASON).sort()).toEqual([...APP_TEMPLATE_ISSUE_CODES].sort());
    for (const code of APP_TEMPLATE_ISSUE_CODES) expect(APP_STACK_REASONS).toContain(APP_TEMPLATE_ISSUE_REASON[code]);
  });

  it("maps every YAML parser code to STACK_TEMPLATE_INVALID", () => {
    for (const code of YAML_ERROR_CODES) expect(APP_TEMPLATE_ISSUE_REASON[code]).toBe("STACK_TEMPLATE_INVALID");
  });

  it("maps the non-default codes of the design tables", () => {
    const expected: Record<string, string> = {
      KEY_UNSUPPORTED: "STACK_UNSUPPORTED_FEATURE",
      HEADER_VERSION_UNSUPPORTED: "STACK_UNSUPPORTED_FEATURE",
      PARAM_TYPE_UNSUPPORTED: "STACK_UNSUPPORTED_FEATURE",
      INGRESS_PROTOCOL_UNSUPPORTED: "STACK_UNSUPPORTED_FEATURE",
      IMAGE_MISSING: "STACK_IMAGE_NOT_ALLOWED",
      IMAGE_MALFORMED: "STACK_IMAGE_NOT_ALLOWED",
      IMAGE_DIGEST_REQUIRED: "STACK_IMAGE_NOT_ALLOWED",
      IMAGE_TAG_LATEST: "STACK_IMAGE_NOT_ALLOWED",
      IMAGE_NOT_ALLOWLISTED: "STACK_IMAGE_NOT_ALLOWED",
      DEPENDS_ON_SELF: "STACK_DEPENDENCY_CYCLE",
      DEPENDENCY_CYCLE: "STACK_DEPENDENCY_CYCLE",
      SECRET_MISSING: "STACK_SECRET_MISSING",
      PLAN_TOO_LARGE: "STACK_TEMPLATE_INVALID",
      KEY_FORBIDDEN_HOST_ACCESS: "STACK_TEMPLATE_INVALID",
      SPEC_INTERNAL: "STACK_TEMPLATE_INVALID",
    };
    for (const [code, reason] of Object.entries(expected)) expect(APP_TEMPLATE_ISSUE_REASON[code as keyof typeof APP_TEMPLATE_ISSUE_REASON], code).toBe(reason);
    for (const code of APP_TEMPLATE_VALIDATOR_ISSUE_CODES) {
      if (!(code in expected)) expect(APP_TEMPLATE_ISSUE_REASON[code], code).toBe("STACK_TEMPLATE_INVALID");
    }
    for (const code of APP_TEMPLATE_VALUE_ISSUE_CODES) {
      if (!(code in expected)) expect(APP_TEMPLATE_ISSUE_REASON[code], code).toBe("STACK_PARAMETER_INVALID");
    }
  });
});

describe("AppTemplateIssueSchema", () => {
  it("accepts a positioned issue and refuses unknown codes, reasons and keys", () => {
    const issue = { path: "services.web.image", line: 3, column: 5, code: "IMAGE_TAG_LATEST", reason: "STACK_IMAGE_NOT_ALLOWED", message: "x" };
    expect(AppTemplateIssueSchema.safeParse(issue).success).toBe(true);
    expect(AppTemplateIssueSchema.safeParse({ ...issue, code: "NOPE" }).success).toBe(false);
    expect(AppTemplateIssueSchema.safeParse({ ...issue, reason: "NOPE" }).success).toBe(false);
    expect(AppTemplateIssueSchema.safeParse({ ...issue, extra: 1 }).success).toBe(false);
    expect(AppTemplateIssueSchema.safeParse({ ...issue, line: 0 }).success).toBe(false);
    expect(AppTemplateIssueSchema.safeParse({ ...issue, message: "" }).success).toBe(false);
  });
});

describe("sortAppTemplateIssues", () => {
  const issue = (path: string, code: AppTemplateIssue["code"], line?: number, column?: number, message = "m"): AppTemplateIssue => ({
    path,
    code,
    reason: APP_TEMPLATE_ISSUE_REASON[code],
    message,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  });

  it("orders by line (missing last), column, path then code in code-unit order", () => {
    const input = [
      issue("b", "KEY_UNKNOWN"),
      issue("a", "TYPE_MISMATCH"),
      issue("a", "KEY_UNKNOWN"),
      issue("z", "KEY_UNKNOWN", 2, 1),
      issue("y", "KEY_UNKNOWN", 1, 9),
      issue("x", "KEY_UNKNOWN", 1, 2),
      issue("B", "KEY_UNKNOWN", 1, 2),
      issue("a", "KEY_UNKNOWN", 1, undefined, "positioned"),
    ];
    const sorted = sortAppTemplateIssues(input).map((i) => `${i.line ?? "-"}:${i.column ?? "-"}:${i.path}:${i.code}`);
    expect(sorted).toEqual([
      "1:2:B:KEY_UNKNOWN",
      "1:2:x:KEY_UNKNOWN",
      "1:9:y:KEY_UNKNOWN",
      "1:-:a:KEY_UNKNOWN",
      "2:1:z:KEY_UNKNOWN",
      "-:-:a:KEY_UNKNOWN",
      "-:-:a:TYPE_MISMATCH",
      "-:-:b:KEY_UNKNOWN",
    ]);
  });

  it("dedupes on path + code + message and does not mutate its input", () => {
    const input = [issue("a", "KEY_UNKNOWN", 2), issue("a", "KEY_UNKNOWN", 1), issue("a", "KEY_UNKNOWN", 1, 1, "other")];
    const copy = structuredClone(input);
    const sorted = sortAppTemplateIssues(input);
    expect(sorted).toEqual([issue("a", "KEY_UNKNOWN", 1, 1, "other"), issue("a", "KEY_UNKNOWN", 1)]);
    expect(input).toEqual(copy);
  });

  it("cuts to 50 issues after sorting", () => {
    const input = Array.from({ length: 60 }, (_, i) => issue(`p${i}`, "KEY_UNKNOWN", 60 - i));
    const sorted = sortAppTemplateIssues(input);
    expect(sorted).toHaveLength(50);
    expect(sorted[0]?.line).toBe(1);
    expect(sorted.at(-1)?.line).toBe(50);
  });
});
