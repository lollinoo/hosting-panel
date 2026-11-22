import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_TEMPLATE_LIMITS,
  AppStackResourcesSchema,
  AppTemplateParameterKeySchema,
} from "../src/app-templates/limits.js";
import { SITE_TEMPLATE_ENV_VALUE_MAX, SITE_TEMPLATE_STRING_PARAMETER_MAX } from "../src/site-templates/spec.js";
import { TEMPLATE_SOURCE_MAX_BYTES, YAML_MAX_DEPTH, YAML_MAX_NODES } from "../src/site-templates/yaml-subset.js";

describe("APP_TEMPLATE_LIMITS", () => {
  it("equals the parser and site-template constants it mirrors", () => {
    expect(APP_TEMPLATE_LIMITS.sourceBytes).toBe(TEMPLATE_SOURCE_MAX_BYTES);
    expect(APP_TEMPLATE_LIMITS.depth).toBe(YAML_MAX_DEPTH);
    expect(APP_TEMPLATE_LIMITS.nodes).toBe(YAML_MAX_NODES);
    expect(APP_TEMPLATE_LIMITS.stringValue).toBe(SITE_TEMPLATE_STRING_PARAMETER_MAX);
    expect(APP_TEMPLATE_LIMITS.envValueLength).toBe(SITE_TEMPLATE_ENV_VALUE_MAX);
  });

  it("stays within the policy-engine service ceilings (MAX_SERVICE_CPU_MILLI, MAX_SERVICE_MEMORY_BYTES)", () => {
    expect(APP_TEMPLATE_LIMITS.cpuMilliMax).toBeLessThanOrEqual(64_000);
    expect(BigInt(APP_TEMPLATE_LIMITS.memoryBytesMax)).toBeLessThanOrEqual(64n * 1024n ** 3n);
  });

  it("keeps the health defaults inside their ranges and timeout <= interval", () => {
    const l = APP_TEMPLATE_LIMITS;
    expect(l.healthIntervalDefault).toBeGreaterThanOrEqual(l.healthIntervalMin);
    expect(l.healthIntervalDefault).toBeLessThanOrEqual(l.healthIntervalMax);
    expect(l.healthTimeoutDefault).toBeGreaterThanOrEqual(l.healthTimeoutMin);
    expect(l.healthTimeoutDefault).toBeLessThanOrEqual(Math.min(l.healthTimeoutMax, l.healthIntervalDefault));
  });
});

describe("shared primitives", () => {
  it("refuses the reserved hp_ parameter prefix", () => {
    expect(AppTemplateParameterKeySchema.safeParse("app_secret").success).toBe(true);
    expect(AppTemplateParameterKeySchema.safeParse("hp_x").success).toBe(false);
  });

  it("bounds resources to 50..16000 milli and 32 MiB..16 GiB", () => {
    const ok = (cpuMilli: number, memoryBytes: string) => AppStackResourcesSchema.safeParse({ cpuMilli, memoryBytes }).success;
    expect(ok(50, "33554432")).toBe(true);
    expect(ok(16_000, "17179869184")).toBe(true);
    expect(ok(49, "33554432")).toBe(false);
    expect(ok(16_001, "33554432")).toBe(false);
    expect(ok(50, "33554431")).toBe(false);
    expect(ok(50, "17179869185")).toBe(false);
    expect(ok(50, "0033554432")).toBe(false);
  });

  it.each(["abc", "1.5", "1e3"])("refuses memoryBytes %j without throwing", (memoryBytes) => {
    expect(AppStackResourcesSchema.safeParse({ cpuMilli: 50, memoryBytes }).success).toBe(false);
  });
});

describe("app-templates/*.ts imports", () => {
  const dir = new URL("../src/app-templates/", import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));

  it("covers the folder", () => {
    expect(files).toEqual(expect.arrayContaining(["limits.ts", "issues.ts", "text.ts", "images.ts", "canonical.ts", "index.ts"]));
  });

  it.each(files)("%s imports only zod and relative files, with no dynamic import or require", (name) => {
    const source = readFileSync(new URL(name, dir), "utf8");
    const imports = [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map((m) => m[1] as string);
    expect(imports.filter((s) => s !== "zod" && !/^\.\.?\/[\w./-]+\.js$/.test(s))).toEqual([]);
    expect(source).not.toMatch(/\bimport\s+"/);
    expect(source).not.toContain("import(");
    expect(source).not.toContain("require(");
    expect(source).not.toMatch(/\bnode:|\bBuffer\b|\bprocess\b/);
  });
});
