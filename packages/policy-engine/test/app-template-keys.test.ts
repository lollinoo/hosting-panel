import { describe, expect, it } from "vitest";
import {
  APP_TEMPLATE_KEY_LEVELS,
  APP_TEMPLATE_KEY_LEVELS_V2,
  appTemplateKeyVerdict,
  type AppTemplateKeyLevelName,
  type AppTemplateRefusalCode,
} from "../src/app-template-keys.js";

type Level = keyof typeof APP_TEMPLATE_KEY_LEVELS;
const LEVELS = Object.keys(APP_TEMPLATE_KEY_LEVELS) as Level[];
const CODES: readonly AppTemplateRefusalCode[] = [
  "KEY_FORBIDDEN_SECURITY",
  "KEY_FORBIDDEN_NETWORK",
  "KEY_FORBIDDEN_HOST_ACCESS",
  "KEY_UNSUPPORTED",
];

describe("APP_TEMPLATE_KEY_LEVELS", () => {
  it("has exactly the ten levels of an HCP-STACK/v1 source", () => {
    expect(LEVELS).toEqual([
      "root", "header", "parameter", "service", "environmentEntry", "healthcheck", "deploy", "resources", "limits", "ingress",
    ]);
  });

  it("is deep-frozen", () => {
    expect(Object.isFrozen(APP_TEMPLATE_KEY_LEVELS)).toBe(true);
    for (const level of LEVELS) {
      const row = APP_TEMPLATE_KEY_LEVELS[level];
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.allowed)).toBe(true);
      expect(Object.isFrozen(row.refusals)).toBe(true);
      for (const keys of Object.values(row.refusals)) expect(Object.isFrozen(keys)).toBe(true);
    }
  });

  it("uses only the four refusal codes, each with a non-empty list", () => {
    for (const level of LEVELS) {
      for (const [code, keys] of Object.entries(APP_TEMPLATE_KEY_LEVELS[level].refusals)) {
        expect(CODES).toContain(code);
        expect(keys.length).toBeGreaterThan(0);
      }
    }
  });

  it("never allows a refused key and lists a key in at most one category of its level", () => {
    for (const level of LEVELS) {
      const { allowed, refusals } = APP_TEMPLATE_KEY_LEVELS[level];
      const all = [...allowed, ...Object.values(refusals).flat()];
      expect(new Set(all).size, level).toBe(all.length);
    }
  });

  it("allows the keys the validator reads and refuses the Compose host and security keys", () => {
    expect(APP_TEMPLATE_KEY_LEVELS.service.allowed).toEqual([
      "image", "command", "environment", "volumes", "expose", "depends_on", "healthcheck", "deploy",
    ]);
    expect(APP_TEMPLATE_KEY_LEVELS.service.refusals.KEY_FORBIDDEN_SECURITY).toEqual(
      expect.arrayContaining(["privileged", "cap_add", "devices", "security_opt", "sysctls", "pid", "ipc", "user", "use_api_socket"]),
    );
    expect(APP_TEMPLATE_KEY_LEVELS.service.refusals.KEY_FORBIDDEN_NETWORK).toEqual(
      expect.arrayContaining(["ports", "network_mode", "networks", "extra_hosts", "dns"]),
    );
    expect(APP_TEMPLATE_KEY_LEVELS.service.refusals.KEY_FORBIDDEN_HOST_ACCESS).toEqual(
      expect.arrayContaining(["build", "env_file", "secrets", "configs", "labels", "volumes_from", "tmpfs"]),
    );
    expect(APP_TEMPLATE_KEY_LEVELS.root.refusals).toEqual({
      KEY_FORBIDDEN_NETWORK: ["networks"],
      KEY_FORBIDDEN_HOST_ACCESS: ["secrets", "configs", "include", "extends"],
      KEY_UNSUPPORTED: ["x-hp-ports", "name", "version", "models"],
    });
    for (const level of ["header", "parameter", "environmentEntry"] as const) {
      expect(APP_TEMPLATE_KEY_LEVELS[level].refusals).toEqual({});
    }
  });
});

describe("appTemplateKeyVerdict", () => {
  it("returns null for every allowed key and the listed code for every refused key", () => {
    for (const level of LEVELS) {
      const { allowed, refusals } = APP_TEMPLATE_KEY_LEVELS[level];
      for (const key of allowed) expect(appTemplateKeyVerdict(level, key)).toBeNull();
      for (const [code, keys] of Object.entries(refusals)) {
        for (const key of keys) expect(appTemplateKeyVerdict(level, key)).toBe(code);
      }
    }
  });

  it("judges a key by its level only", () => {
    expect(appTemplateKeyVerdict("header", "name")).toBeNull();
    expect(appTemplateKeyVerdict("root", "name")).toBe("KEY_UNSUPPORTED");
    expect(appTemplateKeyVerdict("service", "volumes")).toBeNull();
    expect(appTemplateKeyVerdict("root", "volumes")).toBeNull();
    expect(appTemplateKeyVerdict("ingress", "hostname")).toBe("KEY_FORBIDDEN_NETWORK");
    expect(appTemplateKeyVerdict("service", "hostname")).toBe("KEY_FORBIDDEN_NETWORK");
    expect(appTemplateKeyVerdict("healthcheck", "test")).toBe("KEY_UNSUPPORTED");
    expect(appTemplateKeyVerdict("limits", "pids")).toBe("KEY_UNSUPPORTED");
    expect(appTemplateKeyVerdict("deploy", "replicas")).toBe("KEY_UNSUPPORTED");
    expect(appTemplateKeyVerdict("environmentEntry", "secretRef")).toBe("KEY_UNKNOWN");
  });

  it("returns KEY_UNKNOWN for an unlisted key, prototype names and case variants included", () => {
    for (const level of LEVELS) {
      for (const key of ["", "x-hp-php", "__proto__", "constructor", "toString", "hasOwnProperty", "length", "0"]) {
        expect(appTemplateKeyVerdict(level, key)).toBe("KEY_UNKNOWN");
      }
    }
    expect(appTemplateKeyVerdict("service", "Privileged")).toBe("KEY_UNKNOWN");
    expect(appTemplateKeyVerdict("service", "image ")).toBe("KEY_UNKNOWN");
  });
});

describe("APP_TEMPLATE_KEY_LEVELS_V2", () => {
  const LEVELS_V2 = Object.keys(APP_TEMPLATE_KEY_LEVELS_V2) as AppTemplateKeyLevelName[];

  it("has the ten v1 levels and the level of a 'generate' rule", () => {
    expect([...LEVELS_V2].sort()).toEqual([...LEVELS, "generate"].sort());
  });

  it("is deep-frozen and shares no list with the v1 table where it differs", () => {
    expect(Object.isFrozen(APP_TEMPLATE_KEY_LEVELS_V2)).toBe(true);
    for (const level of LEVELS_V2) {
      const row = APP_TEMPLATE_KEY_LEVELS_V2[level];
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.allowed)).toBe(true);
      expect(Object.isFrozen(row.refusals)).toBe(true);
      for (const keys of Object.values(row.refusals)) expect(Object.isFrozen(keys)).toBe(true);
    }
    expect(APP_TEMPLATE_KEY_LEVELS_V2.parameter.allowed).not.toBe(APP_TEMPLATE_KEY_LEVELS.parameter.allowed);
    expect(APP_TEMPLATE_KEY_LEVELS_V2.service.allowed).not.toBe(APP_TEMPLATE_KEY_LEVELS.service.allowed);
  });

  it("adds exactly three keys to the v1 table and removes none", () => {
    for (const level of LEVELS) {
      const added = APP_TEMPLATE_KEY_LEVELS_V2[level].allowed.filter((key) => !APP_TEMPLATE_KEY_LEVELS[level].allowed.includes(key));
      expect(added, level).toEqual(level === "parameter" ? ["generate"] : level === "service" ? ["x-hp-profile"] : []);
      expect(APP_TEMPLATE_KEY_LEVELS_V2[level].allowed.slice(0, APP_TEMPLATE_KEY_LEVELS[level].allowed.length)).toEqual(
        APP_TEMPLATE_KEY_LEVELS[level].allowed,
      );
    }
    expect(APP_TEMPLATE_KEY_LEVELS_V2.generate).toEqual({ allowed: ["kind", "length"], refusals: {} });
  });

  it("refuses every key the v1 table refuses, with the same code", () => {
    for (const level of LEVELS) expect(APP_TEMPLATE_KEY_LEVELS_V2[level].refusals, level).toEqual(APP_TEMPLATE_KEY_LEVELS[level].refusals);
  });

  it("never allows a refused key and lists a key in at most one category of its level", () => {
    for (const level of LEVELS_V2) {
      const { allowed, refusals } = APP_TEMPLATE_KEY_LEVELS_V2[level];
      const all = [...allowed, ...Object.values(refusals).flat()];
      expect(new Set(all).size, level).toBe(all.length);
    }
  });

  it("allows no key that names a privilege, a user, a host path or a port", () => {
    const allowed = LEVELS_V2.flatMap((level) => [...APP_TEMPLATE_KEY_LEVELS_V2[level].allowed]);
    for (const key of ["privileged", "cap_add", "cap_drop", "devices", "security_opt", "user", "ports", "network_mode", "pid", "ipc", "tmpfs", "read_only", "pids_limit", "entrypoint"]) {
      expect(allowed).not.toContain(key);
    }
  });
});

describe("appTemplateKeyVerdict with a version", () => {
  it("judges a v1 source by the v1 table by default", () => {
    expect(appTemplateKeyVerdict("parameter", "generate")).toBe("KEY_UNKNOWN");
    expect(appTemplateKeyVerdict("parameter", "generate", 1)).toBe("KEY_UNKNOWN");
    expect(appTemplateKeyVerdict("service", "x-hp-profile", 1)).toBe("KEY_UNKNOWN");
    expect(appTemplateKeyVerdict("generate", "kind", 1)).toBe("KEY_UNKNOWN");
    expect(appTemplateKeyVerdict("generate", "length")).toBe("KEY_UNKNOWN");
  });

  it("allows the three v2 keys in a v2 source only", () => {
    expect(appTemplateKeyVerdict("parameter", "generate", 2)).toBeNull();
    expect(appTemplateKeyVerdict("service", "x-hp-profile", 2)).toBeNull();
    expect(appTemplateKeyVerdict("generate", "kind", 2)).toBeNull();
    expect(appTemplateKeyVerdict("generate", "length", 2)).toBeNull();
    expect(appTemplateKeyVerdict("generate", "charset", 2)).toBe("KEY_UNKNOWN");
  });

  it("keeps every v1 verdict in a v2 source", () => {
    for (const level of LEVELS) {
      const { allowed, refusals } = APP_TEMPLATE_KEY_LEVELS[level];
      for (const key of allowed) expect(appTemplateKeyVerdict(level, key, 2)).toBeNull();
      for (const [code, keys] of Object.entries(refusals)) {
        for (const key of keys) expect(appTemplateKeyVerdict(level, key, 2)).toBe(code);
      }
      for (const key of ["", "__proto__", "constructor", "x-hp-php", "profile", "x-hp-user", "x-hp-capabilities"]) {
        expect(appTemplateKeyVerdict(level, key, 2)).toBe("KEY_UNKNOWN");
      }
    }
  });
});
