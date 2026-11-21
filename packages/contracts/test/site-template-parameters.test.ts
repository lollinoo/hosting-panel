import { describe, expect, it } from "vitest";
import {
  type ResolveSiteTemplateParametersResult,
  type SiteTemplateAudience,
  resolveSiteTemplateParameters,
  restoreSiteTemplateParameterMap,
  sampleSiteTemplateParameterMap,
  toStoredSiteTemplateParameters,
} from "../src/site-templates/parameters.js";
import {
  type SiteTemplateParameterEntry,
  type SiteTemplateSpec,
  SiteTemplateSpecSchema,
} from "../src/site-templates/spec.js";

const specOf = (parameters: unknown[]): SiteTemplateSpec =>
  SiteTemplateSpecSchema.parse({
    specVersion: 1,
    module: "wordpress",
    parameters,
    service: {
      name: "app",
      image: "${HP_MODULE_IMAGE}",
      environment: [],
      volumes: [{ volume: "html", containerPath: "/var/www/html" }],
      expose: [80],
      limits: null,
    },
    php: null,
  });

const PHP = { key: "php_version", label: "PHP", type: "enum", options: ["8.3", "8.4", "8.5"], default: "8.4", customer: true };

/** One parameter of every type, customer and not, with and without a default. */
const SPEC = specOf([
  PHP,
  { key: "mode", label: "Mode", type: "enum", options: ["fast", "safe"], default: "safe", customer: true },
  { key: "workers", label: "Workers", type: "integer", min: 1, max: 8, default: 2, customer: true },
  { key: "title", label: "Title", type: "string", customer: true },
  { key: "debug", label: "Debug", type: "boolean", default: false, customer: false },
  { key: "upload", label: "Upload", type: "size", default: "64M", customer: false },
]);

const entries = (...items: [string, unknown][]): SiteTemplateParameterEntry[] =>
  items.map(([key, value]) => ({ key, value })) as SiteTemplateParameterEntry[];
const TITLE = entries(["title", "Hello"]);
const deepFreeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

const values = (result: ResolveSiteTemplateParametersResult) => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.issues)}`);
  return result.values;
};
const issuesOf = (result: ResolveSiteTemplateParametersResult): [string, string][] => {
  if (result.ok) throw new Error(`expected issues, got ${JSON.stringify(result.values)}`);
  return result.issues.map((issue) => [issue.field, issue.reason]);
};
const admin = (extra: SiteTemplateParameterEntry[] = [], phpVersion?: string | null) =>
  resolveSiteTemplateParameters(SPEC, [...TITLE, ...extra], { audience: "admin", phpVersion });
const customer = (extra: SiteTemplateParameterEntry[] = [], phpVersion?: string | null) =>
  resolveSiteTemplateParameters(SPEC, [...TITLE, ...extra], { audience: "customer", phpVersion });

describe("resolveSiteTemplateParameters: defaults and required", () => {
  it("applies defaults and returns every declared parameter", () => {
    expect(values(admin())).toEqual({
      php_version: "8.4",
      mode: "safe",
      workers: 2,
      title: "Hello",
      debug: false,
      upload: "64M",
    });
  });

  it("lets the given entries override the defaults", () => {
    expect(values(customer(entries(["mode", "fast"], ["workers", 8])))).toMatchObject({ mode: "fast", workers: 8, debug: false });
  });

  it("reports a parameter with neither a value nor a default as required, for both audiences", () => {
    for (const audience of ["customer", "admin"] as SiteTemplateAudience[]) {
      expect(issuesOf(resolveSiteTemplateParameters(SPEC, [], { audience }))).toEqual([["parameters.title", "required"]]);
    }
  });

  it("returns a message with every issue", () => {
    const result = resolveSiteTemplateParameters(SPEC, [], { audience: "admin" });
    expect(!result.ok && result.issues[0]?.message).toEqual(expect.any(String));
  });

  it("does not mutate deep-frozen inputs", () => {
    const spec = deepFreeze(structuredClone(SPEC));
    const given = deepFreeze(structuredClone(TITLE));
    const result = resolveSiteTemplateParameters(spec, given, { audience: "admin", phpVersion: "8.3" });
    expect(values(result).php_version).toBe("8.3");
    expect(() => toStoredSiteTemplateParameters(spec, values(result))).not.toThrow();
    expect(() => restoreSiteTemplateParameterMap(spec, given, "8.3")).not.toThrow();
    expect(() => sampleSiteTemplateParameterMap(spec)).not.toThrow();
  });
});

describe("resolveSiteTemplateParameters: value rules per type", () => {
  const reasonFor = (key: string, value: unknown, audience: SiteTemplateAudience = "admin") =>
    resolveSiteTemplateParameters(SPEC, [...TITLE.filter((e) => e.key !== key), ...entries([key, value])], { audience });

  it("checks an enum against its options", () => {
    expect(issuesOf(reasonFor("mode", "turbo"))).toEqual([["parameters.mode", "not_in_options"]]);
    expect(issuesOf(reasonFor("mode", 1))).toEqual([["parameters.mode", "invalid_type"]]);
    expect(values(reasonFor("mode", "fast")).mode).toBe("fast");
  });

  it("checks an integer for type and range", () => {
    expect(issuesOf(reasonFor("workers", 9))).toEqual([["parameters.workers", "out_of_range"]]);
    expect(issuesOf(reasonFor("workers", 0))).toEqual([["parameters.workers", "out_of_range"]]);
    expect(issuesOf(reasonFor("workers", 1.5))).toEqual([["parameters.workers", "invalid_type"]]);
    expect(issuesOf(reasonFor("workers", "3"))).toEqual([["parameters.workers", "invalid_type"]]);
    expect(issuesOf(reasonFor("workers", Number.NaN))).toEqual([["parameters.workers", "invalid_type"]]);
    expect(issuesOf(reasonFor("workers", 2 ** 60))).toEqual([["parameters.workers", "invalid_type"]]);
    expect(values(reasonFor("workers", 1)).workers).toBe(1);
    expect(values(reasonFor("workers", 8)).workers).toBe(8);
  });

  it("checks a string for length, control characters and interpolation", () => {
    expect(issuesOf(reasonFor("title", "x".repeat(257)))).toEqual([["parameters.title", "too_long"]]);
    expect(issuesOf(reasonFor("title", "a\nb"))).toEqual([["parameters.title", "invalid_characters"]]);
    expect(issuesOf(reasonFor("title", "a\u0000b"))).toEqual([["parameters.title", "invalid_characters"]]);
    expect(issuesOf(reasonFor("title", "a\u007fb"))).toEqual([["parameters.title", "invalid_characters"]]);
    expect(issuesOf(reasonFor("title", "${HP_SITE_ID}"))).toEqual([["parameters.title", "invalid_characters"]]);
    expect(issuesOf(reasonFor("title", 5))).toEqual([["parameters.title", "invalid_type"]]);
    for (const ok of ["x".repeat(256), "", "a$b", "$$", "$ {x}", "caffè ☕"]) expect(values(reasonFor("title", ok)).title).toBe(ok);
  });

  it("checks a boolean for type", () => {
    expect(issuesOf(reasonFor("debug", "true"))).toEqual([["parameters.debug", "invalid_type"]]);
    expect(issuesOf(reasonFor("debug", 1))).toEqual([["parameters.debug", "invalid_type"]]);
    expect(values(reasonFor("debug", true)).debug).toBe(true);
  });

  it("checks a size against the K/M/G shape", () => {
    for (const bad of ["64MB", "0M", "64", "M", "64m", "100000M", "-1M", "1.5M", ""]) {
      expect(issuesOf(reasonFor("upload", bad)), bad).toEqual([["parameters.upload", "invalid_type"]]);
    }
    expect(issuesOf(reasonFor("upload", 64))).toEqual([["parameters.upload", "invalid_type"]]);
    for (const ok of ["64M", "1K", "99999G"]) expect(values(reasonFor("upload", ok)).upload).toBe(ok);
  });

  it("treats any other JSON value as invalid_type", () => {
    for (const value of [null, undefined, {}, [], ["a"]]) {
      expect(issuesOf(reasonFor("mode", value))).toEqual([["parameters.mode", "invalid_type"]]);
      expect(issuesOf(reasonFor("title", value))).toEqual([["parameters.title", "invalid_type"]]);
    }
  });
});

describe("resolveSiteTemplateParameters: audience and keys", () => {
  it("refuses a non-customer parameter for a customer and accepts it for an admin", () => {
    expect(issuesOf(customer(entries(["debug", true])))).toEqual([["parameters.debug", "not_customer"]]);
    expect(issuesOf(customer(entries(["upload", "64M"])))).toEqual([["parameters.upload", "not_customer"]]);
    expect(values(admin(entries(["debug", true], ["upload", "128M"])))).toMatchObject({ debug: true, upload: "128M" });
  });

  it("reserves php_version in the entries", () => {
    expect(issuesOf(admin(entries(["php_version", "8.5"])))).toEqual([["parameters.php_version", "reserved"]]);
    const spec = specOf([{ key: "x", label: "X", type: "boolean", default: false, customer: true }]);
    expect(issuesOf(resolveSiteTemplateParameters(spec, entries(["php_version", "8.5"]), { audience: "admin" }))).toEqual([
      ["parameters.php_version", "reserved"],
    ]);
    const result = admin(entries(["php_version", "8.5"]));
    expect(!result.ok && result.issues[0]?.message).toContain("phpVersion");
  });

  it("refuses an undeclared key and a duplicate key", () => {
    expect(issuesOf(admin(entries(["nope", 1])))).toEqual([["parameters.nope", "unknown"]]);
    expect(issuesOf(admin(entries(["mode", "fast"], ["mode", "safe"])))).toEqual([["parameters.mode", "duplicate"]]);
  });

  it("collects every issue, entries first (in order), then the declaration order", () => {
    const result = resolveSiteTemplateParameters(SPEC, entries(["nope", 1], ["mode", "x"], ["workers", 99]), {
      audience: "customer",
      phpVersion: "8.2",
    });
    expect(issuesOf(result)).toEqual([
      ["parameters.nope", "unknown"],
      ["parameters.mode", "not_in_options"],
      ["parameters.workers", "out_of_range"],
      ["phpVersion", "not_in_options"],
      ["parameters.title", "required"],
    ]);
  });

  it("does not resolve a key through the object prototype", () => {
    const result = admin(JSON.parse('[{"key":"__proto__","value":1},{"key":"constructor","value":1},{"key":"tostring","value":1}]'));
    expect(issuesOf(result)).toEqual([
      ["parameters.__proto__", "unknown"],
      ["parameters.constructor", "unknown"],
      ["parameters.tostring", "unknown"],
    ]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("resolveSiteTemplateParameters: phpVersion", () => {
  it("takes a valid phpVersion from the options", () => {
    expect(values(customer([], "8.5")).php_version).toBe("8.5");
    expect(values(admin([], "8.3")).php_version).toBe("8.3");
  });

  it("falls back to the default when phpVersion is absent", () => {
    expect(values(customer()).php_version).toBe("8.4");
    expect(values(customer([], null)).php_version).toBe("8.4");
    expect(values(customer([], undefined)).php_version).toBe("8.4");
  });

  it("refuses a phpVersion outside the options or of the wrong type, under the field phpVersion", () => {
    expect(issuesOf(customer([], "8.2"))).toEqual([["phpVersion", "not_in_options"]]);
    expect(issuesOf(customer([], ""))).toEqual([["phpVersion", "not_in_options"]]);
    expect(issuesOf(customer([], 8.4 as unknown as string))).toEqual([["phpVersion", "invalid_type"]]);
  });

  it("refuses phpVersion when the spec has no php_version parameter", () => {
    const spec = specOf([{ key: "x", label: "X", type: "boolean", default: false, customer: true }]);
    expect(issuesOf(resolveSiteTemplateParameters(spec, [], { audience: "customer", phpVersion: "8.4" }))).toEqual([
      ["phpVersion", "not_applicable"],
    ]);
    expect(values(resolveSiteTemplateParameters(spec, [], { audience: "customer" }))).toEqual({ x: false });
    expect(values(resolveSiteTemplateParameters(spec, [], { audience: "customer", phpVersion: null }))).toEqual({ x: false });
  });

  it("lets a customer send only the default for a php_version that is not customer-editable", () => {
    const fixed = specOf([{ ...PHP, customer: false }]);
    const run = (audience: SiteTemplateAudience, phpVersion?: string) =>
      resolveSiteTemplateParameters(fixed, [], { audience, phpVersion });
    expect(issuesOf(run("customer", "8.3"))).toEqual([["phpVersion", "not_customer"]]);
    expect(values(run("customer", "8.4")).php_version).toBe("8.4");
    expect(values(run("customer")).php_version).toBe("8.4");
    expect(values(run("admin", "8.3")).php_version).toBe("8.3");
  });

  it("reports a php_version with no default and no phpVersion as required under phpVersion", () => {
    const { default: _default, ...noDefault } = PHP;
    const spec = specOf([noDefault]);
    expect(issuesOf(resolveSiteTemplateParameters(spec, [], { audience: "admin" }))).toEqual([["phpVersion", "required"]]);
    expect(values(resolveSiteTemplateParameters(spec, [], { audience: "admin", phpVersion: "8.5" })).php_version).toBe("8.5");
  });
});

describe("parameters named like Object.prototype members", () => {
  const spec = specOf([
    { key: "constructor", label: "C", type: "string", default: "c", customer: true },
    { key: "tostring", label: "T", type: "integer", min: 0, max: 9, default: 3, customer: true },
    { key: "hasownproperty", label: "H", type: "boolean", default: false, customer: true },
  ]);

  it("resolves them as own properties", () => {
    const result = values(resolveSiteTemplateParameters(spec, entries(["constructor", "z"]), { audience: "customer" }));
    expect(Object.hasOwn(result, "constructor")).toBe(true);
    expect(result.constructor).toBe("z");
    expect(result.tostring).toBe(3);
    expect(Object.keys(result)).toEqual(["constructor", "tostring", "hasownproperty"]);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it("stores, restores and samples them as own properties", () => {
    const map = values(resolveSiteTemplateParameters(spec, entries(["tostring", 7]), { audience: "customer" }));
    const stored = toStoredSiteTemplateParameters(spec, map);
    expect(stored).toEqual([
      { key: "constructor", value: "c" },
      { key: "hasownproperty", value: false },
      { key: "tostring", value: 7 },
    ]);
    expect(restoreSiteTemplateParameterMap(spec, stored, null)).toEqual(map);
    expect(Object.hasOwn(sampleSiteTemplateParameterMap(spec), "constructor")).toBe(true);
  });
});

describe("toStoredSiteTemplateParameters and restoreSiteTemplateParameterMap", () => {
  const resolved = values(customer(entries(["mode", "fast"], ["workers", 5]), "8.5"));

  it("stores every declared parameter except php_version, sorted by key", () => {
    expect(toStoredSiteTemplateParameters(SPEC, resolved)).toEqual([
      { key: "debug", value: false },
      { key: "mode", value: "fast" },
      { key: "title", value: "Hello" },
      { key: "upload", value: "64M" },
      { key: "workers", value: 5 },
    ]);
  });

  it("stores null when only php_version is declared, as for the built-in template", () => {
    const builtIn = specOf([PHP]);
    const map = values(resolveSiteTemplateParameters(builtIn, [], { audience: "customer" }));
    expect(toStoredSiteTemplateParameters(builtIn, map)).toBeNull();
    expect(toStoredSiteTemplateParameters(specOf([]), {})).toBeNull();
  });

  it("round-trips through JSON to an equal map", () => {
    const stored = JSON.parse(JSON.stringify(toStoredSiteTemplateParameters(SPEC, resolved)));
    expect(restoreSiteTemplateParameterMap(SPEC, stored, "8.5")).toEqual(resolved);
  });

  it("ignores unknown keys, php_version and invalid stored values", () => {
    const restored = restoreSiteTemplateParameterMap(
      SPEC,
      [
        { key: "gone", value: 1 },
        { key: "php_version", value: "8.3" },
        { key: "mode", value: "turbo" },
        { key: "workers", value: 99 },
        { key: "debug", value: "yes" },
        { key: "upload", value: "64MB" },
        { key: "title", value: "kept" },
      ],
      null,
    );
    expect(restored).toEqual({ php_version: "8.4", mode: "safe", workers: 2, title: "kept", debug: false, upload: "64M" });
  });

  it("never throws on a stored value of any shape", () => {
    for (const stored of [42, null, undefined, "x", {}, [{}], [null], [1], [{ key: 1, value: 2 }], [{ key: "mode" }], [[]], true]) {
      const restored = restoreSiteTemplateParameterMap(SPEC, stored, null);
      expect(restored).toMatchObject({ php_version: "8.4", mode: "safe", workers: 2, debug: false, upload: "64M" });
    }
  });

  it("takes php_version from a valid phpVersion and the default otherwise", () => {
    expect(restoreSiteTemplateParameterMap(SPEC, null, "8.3").php_version).toBe("8.3");
    expect(restoreSiteTemplateParameterMap(SPEC, null, "8.2").php_version).toBe("8.4");
    expect(restoreSiteTemplateParameterMap(SPEC, null, null).php_version).toBe("8.4");
  });

  it("does not add php_version when the spec does not declare it", () => {
    const spec = specOf([{ key: "x", label: "X", type: "boolean", default: false, customer: true }]);
    expect(restoreSiteTemplateParameterMap(spec, null, "8.4")).toEqual({ x: false });
  });

  it("fills a parameter that has no default and no valid stored value with its sample", () => {
    expect(restoreSiteTemplateParameterMap(SPEC, null, null).title).toBe("sample");
  });

  it("applies a newer spec to values stored for an older one", () => {
    const newer = specOf([
      PHP,
      { key: "mode", label: "Mode", type: "enum", options: ["fast"], default: "fast", customer: true },
      { key: "extra", label: "Extra", type: "integer", min: 10, max: 20, customer: true },
    ]);
    expect(restoreSiteTemplateParameterMap(newer, [{ key: "mode", value: "safe" }, { key: "workers", value: 3 }], "8.4")).toEqual({
      php_version: "8.4",
      mode: "fast",
      extra: 10,
    });
  });
});

describe("sampleSiteTemplateParameterMap", () => {
  it("uses the default, else a value valid for the type", () => {
    const spec = specOf([
      PHP,
      { key: "e", label: "E", type: "enum", options: ["one", "two"], customer: true },
      { key: "i", label: "I", type: "integer", min: 5, max: 9, customer: true },
      { key: "j", label: "J", type: "integer", customer: true },
      { key: "k", label: "K", type: "integer", max: -3, customer: true },
      { key: "s", label: "S", type: "string", customer: true },
      { key: "b", label: "B", type: "boolean", customer: true },
      { key: "z", label: "Z", type: "size", customer: false },
      { key: "d", label: "D", type: "size", default: "8M", customer: false },
    ]);
    expect(sampleSiteTemplateParameterMap(spec)).toEqual({
      php_version: "8.4",
      e: "one",
      i: 5,
      j: 0,
      k: -3,
      s: "sample",
      b: false,
      z: "1M",
      d: "8M",
    });
  });

  it("yields a value that resolveSiteTemplateParameters accepts for every type", () => {
    for (const spec of [SPEC, specOf([PHP, { key: "e", label: "E", type: "enum", options: ["o"], customer: true }, { key: "z", label: "Z", type: "size", customer: false }])]) {
      const sample = sampleSiteTemplateParameterMap(spec);
      const given = Object.entries(sample)
        .filter(([key]) => key !== "php_version")
        .map(([key, value]) => ({ key, value })) as SiteTemplateParameterEntry[];
      const result = resolveSiteTemplateParameters(spec, given, {
        audience: "admin",
        phpVersion: sample.php_version as string,
      });
      expect(values(result)).toEqual(sample);
    }
  });
});
