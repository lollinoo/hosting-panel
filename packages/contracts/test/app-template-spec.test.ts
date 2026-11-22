import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type AppTemplateParameter,
  type AppTemplateService,
  type AppTemplateSpec,
  APP_TEMPLATE_PARAMETER_TYPES,
  AppTemplateParameterSchema,
  AppTemplateSpecSchema,
} from "../src/app-templates/spec.js";

const FIXTURE: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/app-stack-notes-demo/spec.json", import.meta.url), "utf8"),
);
const SPEC = AppTemplateSpecSchema.parse(FIXTURE);

/** A deep copy of the fixture spec changed by `change`. */
const variant = (change: (spec: AppTemplateSpec, app: AppTemplateService, cache: AppTemplateService) => void): AppTemplateSpec => {
  const spec = structuredClone(SPEC);
  change(spec, spec.services[0] as AppTemplateService, spec.services[1] as AppTemplateService);
  return spec;
};
const secret = (key: string): AppTemplateParameter => ({ key, label: "S", type: "secret", required: false, customer: true });
const pathsOf = (value: unknown): string[] => {
  const result = AppTemplateSpecSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
};

describe("AppTemplateSpecSchema: the fixture", () => {
  it("parses spec.json to an equal value with the same key order", () => {
    expect(SPEC).toEqual(FIXTURE);
    expect(JSON.stringify(SPEC)).toBe(JSON.stringify(FIXTURE));
  });

  it("round-trips through JSON", () => {
    expect(AppTemplateSpecSchema.parse(JSON.parse(JSON.stringify(SPEC)))).toEqual(SPEC);
  });

  it("parses one parameter of every type", () => {
    const parameters: AppTemplateParameter[] = [
      { key: "mode", label: "Mode", type: "enum", options: ["fast", "safe"], default: "safe", customer: true },
      { key: "workers", label: "Workers", type: "integer", default: -1_000_000_000, customer: false },
      { key: "title", label: "Title", type: "string", default: "", customer: true },
      { key: "debug", label: "Debug", type: "boolean", default: false, customer: false },
      { key: "upload", label: "Upload", type: "size", default: "64M", customer: true },
      { key: "token_a", label: "Token", type: "secret", required: false, customer: true },
    ];
    expect(parameters.map((parameter) => parameter.type)).toEqual(APP_TEMPLATE_PARAMETER_TYPES);
    const spec = variant((s) => s.parameters.push(...parameters));
    expect(AppTemplateSpecSchema.parse(spec)).toEqual(spec);
  });
});

describe("AppTemplateSpecSchema: cross-field rules", () => {
  const refused: [string, AppTemplateSpec, string][] = [
    ["a duplicate parameter key", variant((s) => s.parameters.push(secret("app_secret"))), "parameters.2.key"],
    ["9 secret parameters", variant((s) => s.parameters.push(...["a", "b", "c", "d", "e", "f", "g", "h"].map(secret))), "parameters"],
    ["unsorted services", variant((s) => s.services.reverse()), "services.1.key"],
    ["a duplicate service key", variant((s, app, cache) => (cache.key = app.key)), "services.1.key"],
    ["unsorted volumes", variant((s, app) => {
      s.volumes = [{ key: "data" }, { key: "cache" }];
      app.volumes.push({ volumeKey: "cache", containerPath: "/cache", readOnly: true });
    }), "volumes.1.key"],
    ["a duplicate volume", variant((s) => s.volumes.push({ key: "data" })), "volumes.1.key"],
    ["a mount of an undeclared volume", variant((s, app) => app.volumes.push({ volumeKey: "logs", containerPath: "/logs", readOnly: false })), "services.0.volumes.1.volumeKey"],
    ["a mount to a reserved path", variant((s, app) => ((app.volumes[0] as { containerPath: string }).containerPath = "/tmp")), "services.0.volumes.0.containerPath"],
    ["a mount to an invalid path", variant((s, app) => ((app.volumes[0] as { containerPath: string }).containerPath = "/app/../etc")), "services.0.volumes.0.containerPath"],
    ["a duplicate container path", variant((s, app) => app.volumes.push({ volumeKey: "data", containerPath: "/app/data", readOnly: true })), "services.0.volumes.1.containerPath"],
    ["an unused volume", variant((s) => s.volumes.push({ key: "logs" })), "volumes.1.key"],
    ["a duplicate exposed port", variant((s, app) => app.expose.push(8080)), "services.0.expose.1"],
    ["17 exposed ports in total", variant((s, app, cache) => {
      app.expose.push(...Array.from({ length: 8 }, (_, i) => 9000 + i));
      cache.expose.push(...Array.from({ length: 7 }, (_, i) => 7000 + i));
    }), "services"],
    ["a dependency on itself", variant((s, app) => app.dependsOn.push("app")), "services.0.dependsOn.1"],
    ["a dependency on an unknown service", variant((s, app) => (app.dependsOn = ["db"])), "services.0.dependsOn.0"],
    ["a duplicate dependency", variant((s, app) => app.dependsOn.push("cache")), "services.0.dependsOn.1"],
    ["a duplicate env name", variant((s, app) => app.environment.push({ name: "CACHE_HOST", value: "x" })), "services.0.environment.2.name"],
    ["a *_FILE value entry", variant((s, app) => app.environment.push({ name: "DATA_FILE", value: "x" })), "services.0.environment.2.name"],
    ["a reserved value entry name", variant((s, app) => app.environment.push({ name: "LD_PRELOAD", value: "x" })), "services.0.environment.2.name"],
    ["a secret entry name without _FILE", variant((s, app) => app.environment.push({ name: "TOKEN", secretParameter: "app_secret" })), "services.0.environment.2.name"],
    ["a secret entry naming a non-secret parameter", variant((s, app) => app.environment.push({ name: "WORKERS_FILE", secretParameter: "worker_count" })), "services.0.environment.2.secretParameter"],
    ["a secret entry naming no parameter", variant((s, app) => app.environment.push({ name: "OTHER_FILE", secretParameter: "other" })), "services.0.environment.2.secretParameter"],
    ["a health port that is not exposed", variant((s, app) => (app.healthcheck = { kind: "tcp", port: 9999, intervalSeconds: 10, timeoutSeconds: 3 })), "services.0.healthcheck.port"],
    ["ingress to a service without a health check", variant((s) => s.ingress.push({ service: "cache", port: 6379 })), "ingress.1.service"],
    ["ingress to an unknown service", variant((s) => s.ingress.push({ service: "web", port: 8080 })), "ingress.1.service"],
    ["ingress to a port that is not exposed", variant((s) => s.ingress.push({ service: "app", port: 9090 })), "ingress.1.port"],
    ["a duplicate ingress", variant((s) => s.ingress.push({ service: "app", port: 8080 })), "ingress.1"],
  ];

  it.each(refused)("refuses %s", (_name, spec, path) => {
    expect(pathsOf(spec)).toContain(path);
  });

  it("accepts a shared volume mounted read-only by a second service", () => {
    expect(pathsOf(variant((s, app, cache) => cache.volumes.push({ volumeKey: "data", containerPath: "/data", readOnly: true })))).toEqual([]);
  });
});

describe("AppTemplateSpecSchema: service key length", () => {
  const withService = (key: string) => variant((s, app, cache) => s.services.push({ ...structuredClone(cache), key }));

  it("accepts a 27-character service key and refuses a 28-character one at its key", () => {
    expect(pathsOf(withService(`z${"a".repeat(26)}`))).toEqual([]);
    expect(pathsOf(withService(`z${"a".repeat(27)}`))).toEqual(["services.2.key"]);
  });
});

describe("AppTemplateParameterSchema", () => {
  const ok = (parameter: Record<string, unknown>) => AppTemplateParameterSchema.safeParse(parameter).success;
  const base = { key: "p", label: "P", customer: true };

  it.each<[string, Record<string, unknown>]>([
    ["a secret with a default", { key: "s", label: "S", type: "secret", required: true, default: "x", customer: true }],
    ["a secret with customer false", { key: "s", label: "S", type: "secret", required: true, customer: false }],
    ["a secret without required", { key: "s", label: "S", type: "secret", customer: true }],
    ["an hp_ key", { ...base, key: "hp_x", type: "boolean", default: true }],
    ["a key with an uppercase letter", { ...base, key: "Px", type: "boolean", default: true }],
    ["the unsupported type port_choice", { ...base, type: "port_choice", default: 1 }],
    ["a label with a control character", { ...base, label: "a\u0007b", type: "boolean", default: true }],
    ["an empty label", { ...base, label: "", type: "boolean", default: true }],
    ["an 81-character label", { ...base, label: "a".repeat(81), type: "boolean", default: true }],
    ["a non-secret without a default", { ...base, type: "string" }],
    ["duplicate enum options", { ...base, type: "enum", options: ["a", "a"], default: "a" }],
    ["an enum option outside the pattern", { ...base, type: "enum", options: ["a b"], default: "a b" }],
    ["33 enum options", { ...base, type: "enum", options: Array.from({ length: 33 }, (_, i) => `o${i}`), default: "o0" }],
    ["an enum default not in the options", { ...base, type: "enum", options: ["a"], default: "b" }],
    ["integer min above max", { ...base, type: "integer", min: 5, max: 1, default: 3 }],
    ["an integer default out of range", { ...base, type: "integer", min: 1, max: 4, default: 5 }],
    ["an integer bound above 1e9", { ...base, type: "integer", max: 1_000_000_001, default: 1 }],
    ["a float default", { ...base, type: "integer", default: 1.5 }],
    ["options on a string", { ...base, type: "string", options: ["a"], default: "a" }],
    ["min on a string", { ...base, type: "string", min: 1, default: "a" }],
    ["a string default with a placeholder", { ...base, type: "string", default: "${x}" }],
    ["a string default naming docker.sock", { ...base, type: "string", default: "/var/run/docker.sock" }],
    ["a 257-character string default", { ...base, type: "string", default: "a".repeat(257) }],
    ["a size default outside the pattern", { ...base, type: "size", default: "1T" }],
    ["a boolean default as a string", { ...base, type: "boolean", default: "true" }],
  ])("refuses %s", (_name, parameter) => {
    expect(ok(parameter)).toBe(false);
  });

  it("accepts integer bounds of ±1e9", () => {
    expect(ok({ ...base, type: "integer", min: -1_000_000_000, max: 1_000_000_000, default: 0 })).toBe(true);
  });
});

describe("AppTemplateSpecSchema: header and images", () => {
  it.each<[string, AppTemplateSpec]>([
    ["schemaVersion 2", { ...SPEC, schemaVersion: 2 as 1 }],
    ["an empty name", { ...SPEC, name: "" }],
    ["a name with a newline", { ...SPEC, name: "a\nb" }],
    ["a description with a NUL", { ...SPEC, description: "a\u0000" }],
    ["a 501-character description", { ...SPEC, description: "a".repeat(501) }],
    ["a category outside the pattern", { ...SPEC, category: "Productivity" }],
    ["no service", { ...SPEC, services: [] }],
    ["the latest tag", variant((s, app) => (app.image.tag = "latest"))],
    ["a short digest", variant((s, app) => (app.image.digest = "sha256:abc"))],
    ["an empty command", variant((s, app) => (app.command = []))],
    ["an empty argv item", variant((s, app) => (app.command = [""]))],
    ["a service key with an underscore", variant((s, app, cache) => (cache.key = "my_cache"))],
    ["a health timeout above the interval", variant((s, app) => (app.healthcheck = { kind: "tcp", port: 8080, intervalSeconds: 5, timeoutSeconds: 6 }))],
    ["memory below 32 MiB", variant((s, app) => (app.limits.memoryBytes = "1024"))],
  ])("refuses %s", (_name, spec) => {
    expect(AppTemplateSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("accepts a null tag", () => {
    expect(AppTemplateSpecSchema.safeParse(variant((s, app) => (app.image.tag = null))).success).toBe(true);
  });
});

describe("AppTemplateSpecSchema: strict at every object", () => {
  const withExtra = (pick: (spec: AppTemplateSpec) => object): AppTemplateSpec =>
    variant((spec) => Object.assign(pick(spec), { extra: true }));
  const app = (spec: AppTemplateSpec) => spec.services[0] as AppTemplateService;

  it.each<[string, (spec: AppTemplateSpec) => object]>([
    ["the spec", (spec) => spec],
    ["an integer parameter", (spec) => spec.parameters[0] as object],
    ["a secret parameter", (spec) => spec.parameters[1] as object],
    ["a service", app],
    ["an image", (spec) => app(spec).image],
    ["a value env entry", (spec) => app(spec).environment[0] as object],
    ["a secret env entry", (spec) => app(spec).environment[1] as object],
    ["a mount", (spec) => app(spec).volumes[0] as object],
    ["a health check", (spec) => app(spec).healthcheck as object],
    ["the limits", (spec) => app(spec).limits],
    ["a volume", (spec) => spec.volumes[0] as object],
    ["an ingress", (spec) => spec.ingress[0] as object],
  ])("refuses an unknown key in %s", (_name, pick) => {
    expect(AppTemplateSpecSchema.safeParse(withExtra(pick)).success).toBe(false);
  });

  it.each(["enum", "string", "boolean", "size"] as const)("refuses an unknown key in a %s parameter", (type) => {
    const parameter = {
      enum: { key: "p", label: "P", type, options: ["a"], default: "a", customer: true },
      string: { key: "p", label: "P", type, default: "a", customer: true },
      boolean: { key: "p", label: "P", type, default: true, customer: true },
      size: { key: "p", label: "P", type, default: "1M", customer: true },
    }[type];
    expect(AppTemplateParameterSchema.safeParse(parameter).success).toBe(true);
    expect(AppTemplateParameterSchema.safeParse({ ...parameter, extra: true }).success).toBe(false);
  });

  it("refuses an env entry with both value and secretParameter", () => {
    const spec = variant((s, a) => Object.assign(a.environment[0] as object, { secretParameter: "app_secret" }));
    expect(AppTemplateSpecSchema.safeParse(spec).success).toBe(false);
  });
});
