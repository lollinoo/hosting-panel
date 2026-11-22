import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AppTemplateIssueSchema } from "../src/app-templates/issues.js";
import {
  type AppTemplateParameterEntry,
  type AppTemplateParameterResolution,
  AppTemplateParameterEntriesSchema,
  appTemplateValueProblem,
  appTemplateValueText,
  resolveAppTemplateParameters,
} from "../src/app-templates/parameters.js";
import { type AppTemplateParameter, type AppTemplateSpec, AppTemplateSpecSchema } from "../src/app-templates/spec.js";

const FIXTURE = AppTemplateSpecSchema.parse(
  JSON.parse(readFileSync(new URL("./fixtures/app-stack-notes-demo/spec.json", import.meta.url), "utf8")),
);
const withParameters = (parameters: AppTemplateParameter[]): AppTemplateSpec =>
  AppTemplateSpecSchema.parse({ ...FIXTURE, parameters: [...FIXTURE.parameters, ...parameters] });

/** The fixture plus one parameter of every other type, and one customer:false parameter. */
const SPEC = withParameters([
  { key: "mode", label: "Mode", type: "enum", options: ["fast", "safe"], default: "safe", customer: true },
  { key: "title", label: "Title", type: "string", default: "Notes", customer: true },
  { key: "debug", label: "Debug", type: "boolean", default: false, customer: true },
  { key: "upload", label: "Upload", type: "size", default: "64M", customer: true },
  { key: "offset", label: "Offset", type: "integer", default: 0, customer: true },
  { key: "fixed", label: "Fixed", type: "integer", default: 7, customer: false },
]);
const DEFAULTS = { worker_count: 2, mode: "safe", title: "Notes", debug: false, upload: "64M", offset: 0, fixed: 7 };

const entries = (...items: [string, unknown][]): AppTemplateParameterEntry[] =>
  items.map(([key, value]) => ({ key, value })) as AppTemplateParameterEntry[];
const resolve = (...items: [string, unknown][]) => resolveAppTemplateParameters(SPEC, entries(...items));
const valuesOf = (result: AppTemplateParameterResolution) => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`);
  return result.values;
};
const issuesOf = (result: AppTemplateParameterResolution) => {
  if (result.ok) throw new Error(`expected issues, got ${JSON.stringify(result.values)}`);
  return result.issues;
};
const codesOf = (result: AppTemplateParameterResolution): [string, string][] =>
  issuesOf(result).map((issue) => [issue.path, issue.code]);
const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

describe("resolveAppTemplateParameters: defaults", () => {
  it("fills every non-secret default when nothing is given (fixture: worker_count = 2)", () => {
    expect(valuesOf(resolveAppTemplateParameters(FIXTURE, []))).toEqual({ worker_count: 2 });
    expect(valuesOf(resolve())).toEqual(DEFAULTS);
  });

  it("overrides the defaults with the given entries and never lists a secret", () => {
    const values = valuesOf(
      resolve(["worker_count", 4], ["mode", "fast"], ["title", ""], ["debug", true], ["upload", "1G"], ["offset", -1_000_000_000]),
    );
    expect(values).toEqual({ ...DEFAULTS, worker_count: 4, mode: "fast", title: "", debug: true, upload: "1G", offset: -1_000_000_000 });
    expect(Object.hasOwn(values, "app_secret")).toBe(false);
  });

  it("keeps falsy given values (false, 0, empty string)", () => {
    const spec = withParameters([{ key: "on", label: "On", type: "boolean", default: true, customer: true }]);
    expect(valuesOf(resolveAppTemplateParameters(spec, entries(["on", false])))).toEqual({ worker_count: 2, on: false });
  });
});

describe("resolveAppTemplateParameters: the A3 matrix", () => {
  it.each<[string, [string, unknown][], [string, string][]]>([
    ["an unknown key", [["nope", 1]], [["parameters.nope", "PARAM_VALUE_UNKNOWN"]]],
    ["a duplicate key", [["worker_count", 3], ["worker_count", 3]], [["parameters.worker_count", "PARAM_VALUE_DUPLICATE"]]],
    ["a duplicate after an invalid value", [["worker_count", 9], ["worker_count", 3]], [
      ["parameters.worker_count", "PARAM_VALUE_DUPLICATE"],
      ["parameters.worker_count", "PARAM_VALUE_OUT_OF_RANGE"],
    ]],
    ["a secret", [["app_secret", "x"]], [["parameters.app_secret", "PARAM_VALUE_SECRET"]]],
    ["a customer:false parameter equal to its default", [["fixed", 7]], [["parameters.fixed", "PARAM_VALUE_NOT_CUSTOMER"]]],
    ["a customer:false parameter with another value", [["fixed", 8]], [["parameters.fixed", "PARAM_VALUE_NOT_CUSTOMER"]]],
    ["a customer:false parameter with an invalid value", [["fixed", "8"]], [["parameters.fixed", "PARAM_VALUE_NOT_CUSTOMER"]]],
    ["worker_count 9", [["worker_count", 9]], [["parameters.worker_count", "PARAM_VALUE_OUT_OF_RANGE"]]],
    ["worker_count \"2\"", [["worker_count", "2"]], [["parameters.worker_count", "PARAM_VALUE_INVALID_TYPE"]]],
    ["a float", [["worker_count", 2.5]], [["parameters.worker_count", "PARAM_VALUE_INVALID_TYPE"]]],
    ["an integer above 1e9", [["offset", 1_000_000_001]], [["parameters.offset", "PARAM_VALUE_OUT_OF_RANGE"]]],
    ["an integer below -1e9", [["offset", -1_000_000_001]], [["parameters.offset", "PARAM_VALUE_OUT_OF_RANGE"]]],
    ["an unsafe integer", [["offset", 2 ** 53]], [["parameters.offset", "PARAM_VALUE_INVALID_TYPE"]]],
    ["an enum value not in the options", [["mode", "slow"]], [["parameters.mode", "PARAM_VALUE_NOT_IN_OPTIONS"]]],
    ["an enum value that is a number", [["mode", 1]], [["parameters.mode", "PARAM_VALUE_INVALID_TYPE"]]],
    ["a 257-character string", [["title", "a".repeat(257)]], [["parameters.title", "PARAM_VALUE_TOO_LONG"]]],
    ["a string with a newline", [["title", "a\nb"]], [["parameters.title", "PARAM_VALUE_INVALID_CHARACTERS"]]],
    ["a string with a NUL", [["title", "a\u0000"]], [["parameters.title", "PARAM_VALUE_INVALID_CHARACTERS"]]],
    ["a string with U+2028", [["title", "a b"]], [["parameters.title", "PARAM_VALUE_INVALID_CHARACTERS"]]],
    ["a string with a placeholder", [["title", "${worker_count}"]], [["parameters.title", "PARAM_VALUE_INVALID_CHARACTERS"]]],
    ["a string naming docker.sock", [["title", "/var/run/Docker.Sock"]], [["parameters.title", "PARAM_VALUE_FORBIDDEN_CONTENT"]]],
    ["a string naming a metadata endpoint", [["title", "169.254.169.254"]], [["parameters.title", "PARAM_VALUE_FORBIDDEN_CONTENT"]]],
    ["a string with URL credentials", [["title", "http://u:p@h"]], [["parameters.title", "PARAM_VALUE_FORBIDDEN_CONTENT"]]],
    ["a boolean as a string", [["debug", "true"]], [["parameters.debug", "PARAM_VALUE_INVALID_TYPE"]]],
    ["a size outside the pattern", [["upload", "1T"]], [["parameters.upload", "PARAM_VALUE_INVALID_TYPE"]]],
  ])("refuses %s", (_name, items, expected) => {
    expect(codesOf(resolve(...items))).toEqual(expected);
  });

  it("A3 variant: worker_count customer:false refuses even the default value 2", () => {
    const spec = AppTemplateSpecSchema.parse({
      ...FIXTURE,
      parameters: FIXTURE.parameters.map((parameter) => (parameter.type === "integer" ? { ...parameter, customer: false } : parameter)),
    });
    expect(codesOf(resolveAppTemplateParameters(spec, entries(["worker_count", 2])))).toEqual([
      ["parameters.worker_count", "PARAM_VALUE_NOT_CUSTOMER"],
    ]);
    expect(valuesOf(resolveAppTemplateParameters(spec, []))).toEqual({ worker_count: 2 });
  });

  it("gives every issue the STACK_PARAMETER_INVALID reason and a valid issue shape", () => {
    const issues = issuesOf(resolve(["nope", 1], ["app_secret", "x"], ["fixed", 7], ["title", "a\n"], ["title", 1]));
    expect(issues).toHaveLength(5);
    for (const issue of issues) {
      expect(issue.reason).toBe("STACK_PARAMETER_INVALID");
      expect(AppTemplateIssueSchema.parse(issue)).toEqual(issue);
    }
  });

  it("sorts the issues and caps them at 50", () => {
    const many = Array.from({ length: 60 }, (_, i): [string, unknown] => [`k${String(i).padStart(2, "0")}`, 1]);
    const issues = issuesOf(resolve(...many.reverse()));
    expect(issues).toHaveLength(50);
    expect(issues[0]?.path).toBe("parameters.k00");
    expect(issues[49]?.path).toBe("parameters.k49");
  });
});

describe("resolveAppTemplateParameters: safety", () => {
  it("treats Object.prototype names as unknown keys and pollutes nothing", () => {
    const result = resolve(["constructor", 1], ["__proto__", "polluted"], ["toString", 1], ["hasOwnProperty", 1]);
    expect(codesOf(result)).toEqual([
      ["parameters.__proto__", "PARAM_VALUE_UNKNOWN"],
      ["parameters.constructor", "PARAM_VALUE_UNKNOWN"],
      ["parameters.hasOwnProperty", "PARAM_VALUE_UNKNOWN"],
      ["parameters.toString", "PARAM_VALUE_UNKNOWN"],
    ]);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("returns values as own properties only", () => {
    const values = valuesOf(resolveAppTemplateParameters(FIXTURE, []));
    expect(Object.keys(values)).toEqual(["worker_count"]);
    expect(Object.hasOwn(values, "constructor")).toBe(false);
    const spec = withParameters([{ key: "constructor", label: "C", type: "string", default: "c", customer: true }]);
    const own = valuesOf(resolveAppTemplateParameters(spec, entries(["constructor", "given"])));
    expect(Object.hasOwn(own, "constructor")).toBe(true);
    expect(own.constructor).toBe("given");
  });

  it("does not mutate deep-frozen inputs", () => {
    const spec = deepFreeze(structuredClone(SPEC));
    const given = deepFreeze(entries(["worker_count", 3], ["nope", 1]));
    expect(() => resolveAppTemplateParameters(spec, given)).not.toThrow();
    expect(valuesOf(resolveAppTemplateParameters(spec, entries(["worker_count", 3])))).toEqual({ ...DEFAULTS, worker_count: 3 });
    expect(spec).toEqual(SPEC);
    expect(given).toEqual(entries(["worker_count", 3], ["nope", 1]));
  });

  it("never echoes the given value in an issue", () => {
    const MARK = "Zq7Marker";
    const result = resolve(
      ["nope", MARK],
      ["app_secret", MARK],
      ["fixed", MARK],
      ["mode", MARK],
      ["title", `${MARK}\n`],
      ["upload", MARK],
      ["worker_count", MARK],
      ["debug", MARK],
      ["offset", MARK],
    );
    expect(issuesOf(result)).toHaveLength(9);
    expect(JSON.stringify(result)).not.toContain(MARK);
    expect(JSON.stringify(resolve(["title", `${MARK}docker.sock`]))).not.toContain(MARK);
    expect(JSON.stringify(resolve(["title", MARK.repeat(40)]))).not.toContain(MARK);
  });

  it("does not leak a secret value: 'x' for app_secret appears nowhere in the result", () => {
    expect(JSON.stringify(resolveAppTemplateParameters(FIXTURE, entries(["app_secret", "x"])))).not.toContain("x");
  });
});

describe("appTemplateValueProblem", () => {
  it("refuses any inline value for a secret", () => {
    expect(appTemplateValueProblem(FIXTURE.parameters[1] as AppTemplateParameter, "x")).toBe("PARAM_VALUE_SECRET");
  });

  it("accepts integer bounds of exactly ±1e9", () => {
    const parameter: AppTemplateParameter = { key: "n", label: "N", type: "integer", default: 0, customer: true };
    expect(appTemplateValueProblem(parameter, 1_000_000_000)).toBeNull();
    expect(appTemplateValueProblem(parameter, -1_000_000_000)).toBeNull();
  });
});

describe("AppTemplateParameterEntriesSchema", () => {
  const ok = (value: unknown) => AppTemplateParameterEntriesSchema.safeParse(value).success;

  it("accepts entries of every value kind", () => {
    expect(ok(entries(["a", "x"], ["b", 1], ["c", false]))).toBe(true);
  });

  it("refuses a duplicate key at [index, key]", () => {
    const result = AppTemplateParameterEntriesSchema.safeParse(entries(["a", 1], ["b", 1], ["a", 2]));
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path)).toEqual([[2, "key"]]);
  });

  it.each<[string, unknown]>([
    ["33 entries", Array.from({ length: 33 }, (_, i) => ({ key: `k${i}`, value: 1 }))],
    ["an hp_ key", entries(["hp_x", 1])],
    ["a key outside the pattern", entries(["__proto__", 1])],
    ["a 257-character string", entries(["a", "a".repeat(257)])],
    ["a float", entries(["a", 1.5])],
    ["null", entries(["a", null])],
    ["an object value", entries(["a", { b: 1 }])],
    ["an unknown entry key", [{ key: "a", value: 1, extra: true }]],
    ["a keyed object", { a: 1 }],
  ])("refuses %s", (_name, value) => {
    expect(ok(value)).toBe(false);
  });
});

describe("appTemplateValueText", () => {
  it("renders integers in decimal, booleans as words and strings as they are", () => {
    expect([appTemplateValueText(2), appTemplateValueText(-7), appTemplateValueText(true), appTemplateValueText(false), appTemplateValueText("a b")]).toEqual([
      "2",
      "-7",
      "true",
      "false",
      "a b",
    ]);
  });
});
