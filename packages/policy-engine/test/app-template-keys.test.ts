import { describe, expect, it } from "vitest";
import { APP_TEMPLATE_KEY_LEVELS, appTemplateKeyVerdict, type AppTemplateRefusalCode } from "../src/app-template-keys.js";

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
