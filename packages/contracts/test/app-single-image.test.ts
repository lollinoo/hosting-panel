import { describe, expect, it } from "vitest";
import {
  APP_SINGLE_IMAGE_PROBLEM_CODES,
  APP_SINGLE_IMAGE_SETTINGS_MAX,
  appSingleImageParameterKey,
  buildAppSingleImageTemplate,
  parseTemplateYaml,
  type AppImageAllowlistEntry,
  type AppSingleImageTemplateInput,
} from "../src/index.js";

// ADR-0043: the one-image form of the administrator writes a template source and nothing else. The server's validator
// stays the authority (packages/policy-engine/test/app-single-image.test.ts runs it on what this function writes).

const DIGEST = `sha256:${"a".repeat(64)}`;
const ALLOWLIST: readonly AppImageAllowlistEntry[] = [
  { repository: "registry.test/acme/notes", runAsUser: "1000:1000", note: "test" },
  { repository: "valkey/valkey", runAsUser: "999:1000", note: "test" },
];
const FULL: AppSingleImageTemplateInput = {
  name: 'Notes "Pro"',
  category: "productivity",
  description: "Shared notes for a team.",
  componentKey: "app",
  repository: "registry.test/acme/notes",
  tag: "2.4.1",
  digest: DIGEST,
  port: 8080,
  webAddress: true,
  health: { kind: "http", path: "/healthz" },
  settings: [
    { kind: "fixed", name: "APP_MODE", value: "production" },
    { kind: "fixed", name: "PRICE_LABEL", value: "5 $ a month" },
    { kind: "customer", name: "SITE_TITLE", label: "Title of the site", default: "My notes" },
    { kind: "private", name: "ADMIN_KEY_FILE", label: "Administrator key", required: true },
  ],
  dataPath: "/var/lib/notes",
  cpuMilli: 500,
  memoryMb: 256,
};
const MINIMAL: AppSingleImageTemplateInput = {
  name: "Worker",
  category: "jobs",
  description: "",
  componentKey: "app",
  repository: "valkey/valkey",
  tag: null,
  digest: DIGEST,
  port: null,
  webAddress: false,
  health: { kind: "none" },
  settings: [],
  dataPath: null,
  cpuMilli: 1000,
  memoryMb: 32,
};
const build = (change: Partial<AppSingleImageTemplateInput> = {}, base = FULL) => buildAppSingleImageTemplate({ ...base, ...change }, ALLOWLIST);
const codes = (change: Partial<AppSingleImageTemplateInput>, base = FULL) => {
  const result = build(change, base);
  return result.ok ? [] : result.problems.map((p) => `${p.field}:${p.code}`);
};

describe("buildAppSingleImageTemplate", () => {
  it("writes the whole source of a one-component application, field by field", () => {
    const result = build();
    expect(result).toEqual({
      ok: true,
      source: [
        "x-hp-stack:",
        "  schemaVersion: 1",
        '  name: "Notes \\"Pro\\""',
        "  category: productivity",
        '  description: "Shared notes for a team."',
        "x-hp-parameters:",
        "  - key: site_title",
        '    label: "Title of the site"',
        "    type: string",
        '    default: "My notes"',
        "    customer: true",
        "  - key: admin_key",
        '    label: "Administrator key"',
        "    type: secret",
        "    required: true",
        "    customer: true",
        "services:",
        "  app:",
        `    image: registry.test/acme/notes:2.4.1@${DIGEST}`,
        "    environment:",
        "      - name: APP_MODE",
        '        value: "production"',
        "      - name: PRICE_LABEL",
        '        value: "5 $$ a month"',
        "      - name: SITE_TITLE",
        '        value: "${site_title}"',
        "      - name: ADMIN_KEY_FILE",
        "        secret: admin_key",
        "    volumes:",
        '      - "data:/var/lib/notes"',
        "    expose:",
        "      - 8080",
        "    healthcheck:",
        "      kind: http",
        "      port: 8080",
        '      path: "/healthz"',
        "      intervalSeconds: 10",
        "      timeoutSeconds: 3",
        "    deploy:",
        "      resources:",
        "        limits:",
        '          cpus: "0.5"',
        "          memory: 256M",
        "volumes:",
        "  data: {}",
        "x-hp-ingress:",
        "  - service: app",
        "    port: 8080",
        "    protocol: http",
        "",
      ].join("\n"),
    });
  });

  it("leaves out every part the fields do not ask for", () => {
    const result = build({}, MINIMAL);
    expect(result).toEqual({
      ok: true,
      source: [
        "x-hp-stack:",
        "  schemaVersion: 1",
        '  name: "Worker"',
        "  category: jobs",
        "services:",
        "  app:",
        `    image: valkey/valkey@${DIGEST}`,
        "    deploy:",
        "      resources:",
        "        limits:",
        '          cpus: "1"',
        "          memory: 32M",
        "",
      ].join("\n"),
    });
  });

  it("writes a source the template parser reads back to the same values", () => {
    for (const input of [FULL, MINIMAL, { ...FULL, name: "a\\b 'c' # d: e", description: "ünïcödé — ok" }]) {
      const result = buildAppSingleImageTemplate(input, ALLOWLIST);
      if (!result.ok) throw new Error(JSON.stringify(result.problems));
      const parsed = parseTemplateYaml(result.source);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed));
      const root = parsed.value as Record<string, Record<string, unknown>>;
      expect(root["x-hp-stack"]).toMatchObject({ schemaVersion: 1, name: input.name, category: input.category });
      expect(Object.keys(root.services ?? {})).toEqual([input.componentKey]);
      expect(result.source.endsWith("\n")).toBe(true);
      expect(result.source).not.toMatch(/[\r\t]/);
    }
  });

  it("writes cpus as a decimal of at most three places and memory in whole megabytes", () => {
    const limits = (cpuMilli: number, memoryMb: number) => {
      const result = build({ cpuMilli, memoryMb }, MINIMAL);
      if (!result.ok) throw new Error(JSON.stringify(result.problems));
      return [/cpus: "([^"]+)"/.exec(result.source)?.[1], /memory: (\S+)/.exec(result.source)?.[1]];
    };
    expect(limits(50, 32)).toEqual(["0.05", "32M"]);
    expect(limits(125, 64)).toEqual(["0.125", "64M"]);
    expect(limits(1500, 1024)).toEqual(["1.5", "1024M"]);
    expect(limits(16_000, 16_384)).toEqual(["16", "16384M"]);
  });

  it("derives the parameter of a setting from its name", () => {
    expect(appSingleImageParameterKey({ kind: "customer", name: "SITE_TITLE" })).toBe("site_title");
    expect(appSingleImageParameterKey({ kind: "private", name: "ADMIN_KEY_FILE" })).toBe("admin_key");
    expect(appSingleImageParameterKey({ kind: "customer", name: "MY_FILE_NAME" })).toBe("my_file_name");
  });

  it("names the field that cannot be written, and writes nothing", () => {
    expect(codes({ name: "" })).toEqual(["name:name"]);
    expect(codes({ name: "x".repeat(81) })).toEqual(["name:name"]);
    expect(codes({ name: "two\nlines" })).toEqual(["name:name"]);
    expect(codes({ category: "Web" })).toEqual(["category:category"]);
    expect(codes({ description: "d".repeat(501) })).toEqual(["description:description"]);
    expect(codes({ componentKey: "App_1" })).toEqual(["componentKey:component_key"]);
    expect(codes({ componentKey: "a".repeat(28) })).toEqual(["componentKey:component_key"]);
    expect(codes({ repository: "docker.io/library/nginx" })).toEqual(["repository:repository_not_allowed"]);
    expect(codes({ repository: "valkey/valkey:9" })).toEqual(["repository:repository_not_allowed"]);
    expect(codes({ tag: "latest" })).toEqual(["tag:tag"]);
    expect(codes({ tag: "a b" })).toEqual(["tag:tag"]);
    expect(codes({ digest: "sha256:abc" })).toEqual(["digest:digest"]);
    expect(codes({ digest: `sha512:${"a".repeat(64)}` })).toEqual(["digest:digest"]);
    expect(codes({ digest: `SHA256:${"A".repeat(64)}` })).toEqual(["digest:digest"]);
    expect(codes({ port: 0 })).toEqual(["port:port"]);
    expect(codes({ port: 70_000 })).toEqual(["port:port"]);
    expect(codes({ port: 80.5 })).toEqual(["port:port"]);
    expect(codes({ dataPath: "relative/path" })).toEqual(["dataPath:data_path"]);
    expect(codes({ dataPath: "/tmp" })).toEqual(["dataPath:data_path"]);
    expect(codes({ dataPath: "/data:ro" })).toEqual(["dataPath:data_path"]);
    expect(codes({ cpuMilli: 49 })).toEqual(["cpuMilli:cpu"]);
    expect(codes({ cpuMilli: 16_001 })).toEqual(["cpuMilli:cpu"]);
    expect(codes({ memoryMb: 31 })).toEqual(["memoryMb:memory"]);
    expect(codes({ memoryMb: 16_385 })).toEqual(["memoryMb:memory"]);
    expect(codes({ memoryMb: 64.5 })).toEqual(["memoryMb:memory"]);
  });

  it("refuses a web address without a port or without a health check, and a health check without a port", () => {
    expect(codes({ port: null, webAddress: true, health: { kind: "none" } })).toEqual(["webAddress:web_needs_port", "health:web_needs_health"]);
    expect(codes({ health: { kind: "none" } })).toEqual(["health:web_needs_health"]);
    expect(codes({ port: null, webAddress: false })).toEqual(["health:health_needs_port"]);
    expect(codes({ health: { kind: "http", path: "healthz" } })).toEqual(["health:health_path"]);
    expect(codes({ health: { kind: "http", path: "/a/../b" } })).toEqual(["health:health_path"]);
    // A port with no web address and a plain connection check is fine.
    expect(build({ webAddress: false, health: { kind: "tcp" } }).ok).toBe(true);
    expect(build({ webAddress: false, health: { kind: "none" } }).ok).toBe(true);
  });

  it("refuses the settings that could never be written", () => {
    const one = (setting: AppSingleImageTemplateInput["settings"][number]) => codes({ settings: [setting] });
    expect(one({ kind: "fixed", name: "lower", value: "x" })).toEqual(["settings.0:setting_name"]);
    expect(one({ kind: "fixed", name: "HP_MODE", value: "x" })).toEqual(["settings.0:setting_name_reserved"]);
    expect(one({ kind: "fixed", name: "PATH", value: "x" })).toEqual(["settings.0:setting_name_reserved"]);
    expect(one({ kind: "fixed", name: "CONFIG_FILE", value: "x" })).toEqual(["settings.0:setting_name_reserved"]);
    expect(one({ kind: "fixed", name: "APP_MODE", value: "two\nlines" })).toEqual(["settings.0:setting_value"]);
    expect(one({ kind: "fixed", name: "APP_MODE", value: "v".repeat(4_097) })).toEqual(["settings.0:setting_value"]);
    expect(one({ kind: "customer", name: "SITE_TITLE", label: "", default: "x" })).toEqual(["settings.0:setting_label"]);
    expect(one({ kind: "customer", name: "SITE_TITLE", label: "Title", default: "d".repeat(257) })).toEqual(["settings.0:setting_value"]);
    expect(one({ kind: "customer", name: `A${"B".repeat(40)}`, label: "Long", default: "" })).toEqual(["settings.0:setting_key"]);
    expect(one({ kind: "customer", name: "_PRIVATE", label: "Underscore", default: "" })).toEqual(["settings.0:setting_key"]);
    expect(one({ kind: "private", name: "ADMIN_KEY", label: "Key", required: true })).toEqual(["settings.0:setting_name_private"]);
    expect(one({ kind: "private", name: "HP_KEY_FILE", label: "Key", required: true })).toEqual(["settings.0:setting_name_private"]);
    expect(one({ kind: "private", name: "_FILE", label: "Key", required: false })).toEqual(["settings.0:setting_name_private"]);
    expect(
      codes({
        settings: [
          { kind: "fixed", name: "APP_MODE", value: "a" },
          { kind: "fixed", name: "APP_MODE", value: "b" },
          { kind: "customer", name: "ADMIN_KEY", label: "Key", default: "" },
          { kind: "private", name: "ADMIN_KEY_FILE", label: "Key", required: true },
        ],
      }),
    ).toEqual(["settings.1:setting_name_duplicate", "settings.3:setting_name_duplicate"]);
    const many = (n: number, kind: "fixed" | "private") =>
      Array.from({ length: n }, (_, i) =>
        kind === "fixed"
          ? ({ kind, name: `VAR_${String(i)}`, value: "x" } as const)
          : ({ kind, name: `KEY_${String(i)}_FILE`, label: "Key", required: false } as const),
      );
    expect(build({ settings: many(APP_SINGLE_IMAGE_SETTINGS_MAX, "fixed") }).ok).toBe(true);
    expect(codes({ settings: many(APP_SINGLE_IMAGE_SETTINGS_MAX + 1, "fixed") })).toEqual(["settings:settings_too_many"]);
    expect(build({ settings: many(8, "private") }).ok).toBe(true);
    expect(codes({ settings: many(9, "private") })).toEqual(["settings:private_too_many"]);
  });

  it("uses a closed list of problem codes, and the code allowlist when none is given", () => {
    expect(new Set(APP_SINGLE_IMAGE_PROBLEM_CODES).size).toBe(APP_SINGLE_IMAGE_PROBLEM_CODES.length);
    const result = buildAppSingleImageTemplate({ ...MINIMAL, repository: "registry.test/acme/notes" });
    expect(result).toEqual({ ok: false, problems: [{ field: "repository", code: "repository_not_allowed" }] });
    expect(buildAppSingleImageTemplate(MINIMAL).ok).toBe(true);
  });
});
