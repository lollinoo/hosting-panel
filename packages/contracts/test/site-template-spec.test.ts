import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VOLUME_SUFFIX_PATTERN } from "../src/ipc-schemas.js";
import {
  SITE_TEMPLATE_VOLUME_PATTERN,
  SiteTemplateParameterEntriesSchema,
  SiteTemplateParameterSchema,
  SiteTemplateSpecSchema,
} from "../src/site-templates/spec.js";

/** The built-in WordPress spec of the design (§6), spelled out here so the test does not depend on built-in.ts. */
const SPEC = {
  specVersion: 1,
  module: "wordpress",
  parameters: [
    { key: "php_version", label: "Versione PHP", type: "enum", options: ["8.3", "8.4", "8.5"], default: "8.4", customer: true },
  ],
  service: {
    name: "app",
    image: "${HP_MODULE_IMAGE}",
    environment: [],
    volumes: [{ volume: "html", containerPath: "/var/www/html" }],
    expose: [80],
    limits: { cpuMilli: 1000, memoryBytes: "536870912" },
  },
  php: null,
};

const withService = (patch: Record<string, unknown>) => ({ ...SPEC, service: { ...SPEC.service, ...patch } });
const withParameter = (patch: Record<string, unknown>) => ({
  ...SPEC,
  parameters: [{ key: "p", label: "P", type: "string", customer: false, ...patch }],
});

describe("SiteTemplateSpecSchema", () => {
  it("parses the built-in WordPress spec to an equal value", () => {
    expect(SiteTemplateSpecSchema.parse(SPEC)).toEqual(SPEC);
  });

  it("parses a spec with every parameter type, environment, php settings and null limits", () => {
    const spec = {
      ...SPEC,
      parameters: [
        { key: "mode", label: "Mode", type: "enum", options: ["a", "b"], default: "a", customer: true },
        { key: "workers", label: "Workers", type: "integer", min: 1, max: 8, default: 2, customer: true },
        { key: "title", label: "Title", type: "string", customer: true },
        { key: "debug", label: "Debug", type: "boolean", default: false, customer: false },
        { key: "upload", label: "Upload", type: "size", default: "64M", customer: false },
      ],
      service: { ...SPEC.service, environment: [{ name: "WP_DEBUG", value: "${debug}" }], limits: null },
      php: [{ key: "memory_limit", value: "256M" }],
    };
    expect(SiteTemplateSpecSchema.parse(spec)).toEqual(spec);
  });

  const rejected: [string, unknown][] = [
    ["an unknown top-level key", { ...SPEC, extra: true }],
    ["an unknown service key", withService({ privileged: true })],
    ["specVersion 2", { ...SPEC, specVersion: 2 }],
    ["an unknown module", { ...SPEC, module: "drupal" }],
    ["an enum without options", withParameter({ type: "enum" })],
    ["options on an integer", withParameter({ type: "integer", options: ["1"] })],
    ["options on a string", withParameter({ type: "string", options: ["x"] })],
    ["an enum with duplicate options", withParameter({ type: "enum", options: ["a", "a"] })],
    ["an integer min greater than max", withParameter({ type: "integer", min: 5, max: 1 })],
    ["min on a string", withParameter({ type: "string", min: 1 })],
    ["max on an enum", withParameter({ type: "enum", options: ["a"], max: 1 })],
    ["an enum default outside the options", withParameter({ type: "enum", options: ["a"], default: "b" })],
    ["an integer default outside the range", withParameter({ type: "integer", min: 1, max: 3, default: 4 })],
    ["an integer default that is a string", withParameter({ type: "integer", default: "1" })],
    ["a string default that is a number", withParameter({ type: "string", default: 1 })],
    ["a boolean default that is a string", withParameter({ type: "boolean", default: "false" })],
    ["a size default of the wrong shape", withParameter({ type: "size", default: "64MB" })],
    ["a parameter key in upper case", withParameter({ key: "Upper" })],
    ["duplicate parameter keys", { ...SPEC, parameters: [SPEC.parameters[0], SPEC.parameters[0]] }],
    ["more than 32 parameters", { ...SPEC, parameters: Array.from({ length: 33 }, (_, i) => ({ key: `p${i}`, label: "P", type: "boolean", customer: false })) }],
    ["a lower-case environment name", withService({ environment: [{ name: "lower", value: "x" }] })],
    ["duplicate environment names", withService({ environment: [{ name: "A", value: "1" }, { name: "A", value: "2" }] })],
    ["an environment value over 4096 characters", withService({ environment: [{ name: "A", value: "x".repeat(4097) }] })],
    ["memoryBytes written as 512M", withService({ limits: { cpuMilli: 1000, memoryBytes: "512M" } })],
    ["cpuMilli 99", withService({ limits: { cpuMilli: 99, memoryBytes: "536870912" } })],
    ["a fractional cpuMilli", withService({ limits: { cpuMilli: 100.5, memoryBytes: "536870912" } })],
    ["expose [0]", withService({ expose: [0] })],
    ["expose above 65535", withService({ expose: [65536] })],
    ["more than 8 volumes", withService({ volumes: Array.from({ length: 9 }, (_, i) => ({ volume: `v${i}`, containerPath: `/data/${i}` })) })],
    ["a volume name with a slash", withService({ volumes: [{ volume: "a/b", containerPath: "/data" }] })],
    ["a service name in upper case", withService({ name: "App" })],
    ["an empty php list", { ...SPEC, php: [] }],
    ["a php entry with an extra key", { ...SPEC, php: [{ key: "memory_limit", value: "1M", extra: 1 }] }],
    ["more than 6 php entries", { ...SPEC, php: Array.from({ length: 7 }, (_, i) => ({ key: `k${String.fromCharCode(97 + i)}`, value: "1" })) }],
  ];
  it.each(rejected)("rejects %s", (_name, value) => {
    expect(SiteTemplateSpecSchema.safeParse(value).success).toBe(false);
  });
});

describe("SiteTemplateParameterSchema", () => {
  it("accepts the five parameter types with their own constraints", () => {
    for (const parameter of [
      { key: "a", label: "A", type: "enum", options: ["x"], customer: true },
      { key: "b", label: "B", type: "integer", min: -5, max: 5, default: 0, customer: false },
      { key: "c", label: "C", type: "string", default: "", customer: true },
      { key: "d", label: "D", type: "boolean", customer: false },
      { key: "e", label: "E", type: "size", default: "1G", customer: false },
    ]) {
      expect(SiteTemplateParameterSchema.safeParse(parameter).success).toBe(true);
    }
  });

  it("rejects a missing customer flag and an empty label", () => {
    expect(SiteTemplateParameterSchema.safeParse({ key: "a", label: "A", type: "boolean" }).success).toBe(false);
    expect(SiteTemplateParameterSchema.safeParse({ key: "a", label: "", type: "boolean", customer: true }).success).toBe(false);
  });
});

describe("SiteTemplateParameterEntriesSchema", () => {
  it("accepts string, integer and boolean values", () => {
    const entries = [{ key: "a", value: true }, { key: "b", value: 3 }, { key: "c", value: "x" }];
    expect(SiteTemplateParameterEntriesSchema.parse(entries)).toEqual(entries);
    expect(SiteTemplateParameterEntriesSchema.parse([])).toEqual([]);
  });

  it("rejects duplicate keys, more than 32 entries and values of other shapes", () => {
    const bad: unknown[] = [
      [{ key: "a", value: 1 }, { key: "a", value: 2 }],
      Array.from({ length: 33 }, (_, i) => ({ key: `k${i}`, value: 1 })),
      [{ key: "a", value: 1.5 }],
      [{ key: "a", value: null }],
      [{ key: "a", value: {} }],
      [{ key: "a", value: "x".repeat(257) }],
      [{ key: "A", value: 1 }],
      [{ key: "a", value: 1, extra: 1 }],
    ];
    for (const value of bad) expect(SiteTemplateParameterEntriesSchema.safeParse(value).success).toBe(false);
  });

  it("reports a duplicate key at the second entry", () => {
    const result = SiteTemplateParameterEntriesSchema.safeParse([{ key: "a", value: 1 }, { key: "a", value: 2 }]);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((i) => i.path)).toContainEqual([1, "key"]);
  });

  it("accepts exactly 32 entries", () => {
    expect(SiteTemplateParameterEntriesSchema.safeParse(Array.from({ length: 32 }, (_, i) => ({ key: `k${i}`, value: 1 }))).success).toBe(true);
  });
});

describe("spec.ts as a leaf", () => {
  it("imports only zod and the site type keys, so site-runtime.ts can import it without a cycle", () => {
    const source = readFileSync(new URL("../src/site-templates/spec.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../site-types/keys.js", "zod"]);
  });

  it("keeps its volume pattern equal to the executor's VOLUME_SUFFIX_PATTERN", () => {
    expect(SITE_TEMPLATE_VOLUME_PATTERN.source).toBe(VOLUME_SUFFIX_PATTERN.source);
  });
});
