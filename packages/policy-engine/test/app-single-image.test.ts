/**
 * The one-image form of the administrator (ADR-0043): what `buildAppSingleImageTemplate` writes is an ordinary
 * HCP-STACK/v1 source. The validator below is the server's: it accepts every source the form writes from names and
 * values a hand-written template may use, and it stays the authority for the ones it refuses.
 */
import { describe, expect, it } from "vitest";
import {
  buildAppSingleImageTemplate,
  type AppImageAllowlistEntry,
  type AppSingleImageHealth,
  type AppSingleImageSetting,
  type AppSingleImageTemplateInput,
} from "@hosting-panel/contracts";
import { compileAppStackPlan } from "../src/app-template-compile.js";
import { validateAppTemplateSource } from "../src/app-template-validation.js";

const DIGEST = `sha256:${"b".repeat(64)}`;
const ALLOWLIST: readonly AppImageAllowlistEntry[] = [{ repository: "registry.test/acme/notes", runAsUser: "1000:1000", note: "test" }];
const options = { allowlist: ALLOWLIST };

const FIXED: AppSingleImageSetting = { kind: "fixed", name: "APP_MODE", value: 'production "A" $1 \\ ok' };
const CUSTOMER: AppSingleImageSetting = { kind: "customer", name: "SITE_TITLE", label: "Title of the site", default: "My notes" };
const PRIVATE: AppSingleImageSetting = { kind: "private", name: "ADMIN_KEY_FILE", label: "Administrator key", required: true };
const OPTIONAL: AppSingleImageSetting = { kind: "private", name: "MAIL_KEY_FILE", label: "Mail key", required: false };

const base: AppSingleImageTemplateInput = {
  name: "Notes",
  category: "productivity",
  description: "Shared notes for a team.",
  componentKey: "app",
  repository: "registry.test/acme/notes",
  tag: "2.4.1",
  digest: DIGEST,
  port: 8080,
  webAddress: true,
  health: { kind: "http", path: "/healthz" },
  settings: [FIXED, CUSTOMER, PRIVATE, OPTIONAL],
  dataPath: "/var/lib/notes",
  cpuMilli: 500,
  memoryMb: 256,
};

/** Every combination of the form's choices that the form itself accepts. */
function combinations(): AppSingleImageTemplateInput[] {
  const out: AppSingleImageTemplateInput[] = [];
  const healths: AppSingleImageHealth[] = [{ kind: "none" }, { kind: "tcp" }, { kind: "http", path: "/" }, { kind: "http", path: "/status/ready" }];
  const settings: AppSingleImageSetting[][] = [[], [FIXED], [CUSTOMER], [PRIVATE], [OPTIONAL], [FIXED, CUSTOMER, PRIVATE, OPTIONAL]];
  for (const port of [null, 80, 8080, 65_535]) {
    for (const webAddress of [false, true]) {
      for (const health of healths) {
        for (const set of settings) {
          for (const dataPath of [null, "/var/lib/notes", "/data"]) {
            for (const [tag, description, cpuMilli, memoryMb] of [
              [null, "", 50, 32],
              ["2.4.1", "Shared notes for a team.", 1_250, 512],
              ["v9_rc.1", 'With "quotes", a # and a colon: here', 16_000, 16_384],
            ] as const) {
              out.push({ ...base, port, webAddress, health, settings: set, dataPath, tag, description, cpuMilli, memoryMb });
            }
          }
        }
      }
    }
  }
  return out;
}

describe("the one-image form writes sources the server accepts", () => {
  it("every combination the form accepts validates, and reads back as what was asked", () => {
    let written = 0;
    for (const input of combinations()) {
      const built = buildAppSingleImageTemplate(input, ALLOWLIST);
      if (!built.ok) {
        // The form itself refuses these three shapes; nothing else.
        const refused = built.problems.map((p) => p.code).sort();
        expect(["health_needs_port", "web_needs_health", "web_needs_port"]).toEqual(expect.arrayContaining(refused));
        continue;
      }
      written += 1;
      const result = validateAppTemplateSource(built.source, options);
      if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.errors)}\n${built.source}`);
      const { spec } = result;
      expect(spec.name).toBe(input.name);
      expect(spec.category).toBe(input.category);
      expect(spec.description).toBe(input.description);
      expect(spec.services).toHaveLength(1);
      const service = spec.services[0]!;
      expect(service.key).toBe("app");
      expect(service.image).toEqual({ name: input.repository, tag: input.tag, digest: input.digest });
      expect(service.command).toBeNull();
      expect(service.expose).toEqual(input.port === null ? [] : [input.port]);
      expect(service.volumes).toEqual(input.dataPath === null ? [] : [{ volumeKey: "data", containerPath: input.dataPath, readOnly: false }]);
      expect(spec.volumes).toEqual(input.dataPath === null ? [] : [{ key: "data" }]);
      expect(spec.ingress).toEqual(input.webAddress && input.port !== null ? [{ service: "app", port: input.port }] : []);
      expect(service.healthcheck?.kind ?? "none").toBe(input.health.kind);
      expect(service.limits).toEqual({ cpuMilli: input.cpuMilli, memoryBytes: String(input.memoryMb * 1_048_576) });
      expect(service.environment.map((e) => e.name)).toEqual(input.settings.map((s) => s.name));
      expect(spec.parameters.map((p) => [p.key, p.type, p.customer])).toEqual(
        input.settings
          .filter((s) => s.kind !== "fixed")
          .map((s) => [s.kind === "private" ? s.name.slice(0, -5).toLowerCase() : s.name.toLowerCase(), s.kind === "private" ? "secret" : "string", true]),
      );
    }
    expect(written).toBeGreaterThan(1_000);
  });

  it("compiles to a plan: the fixed value as typed, the customer's value in its place, the private value as a file", () => {
    const built = buildAppSingleImageTemplate(base, ALLOWLIST);
    if (!built.ok) throw new Error(JSON.stringify(built.problems));
    const compiled = compileAppStackPlan(
      {
        source: built.source,
        parameters: [{ key: "site_title", value: "Team notes" }],
        secretVersions: new Map([["admin_key", 1]]),
        ids: {
          stackId: "stk_0123456789abcdef0123456789abcdef",
          organizationId: "org_acme",
          hostAllocationId: "alloc_0123456789abcdef0123456789abcdef",
          templateVersionId: "atv_0123456789abcdef",
          revisionId: "srev_0123456789abcdef0123456789abcdef",
        },
      },
      options,
    );
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.issues));
    const [component] = compiled.plan.components;
    expect(compiled.plan.components).toHaveLength(1);
    expect(component).toMatchObject({
      key: "app",
      image: `registry.test/acme/notes@${DIGEST}`,
      runAsUser: "1000:1000",
      argv: null,
      expose: [8080],
      volumes: [{ volumeKey: "data", containerPath: "/var/lib/notes", readOnly: false }],
      resources: { cpuMilli: 500, memoryBytes: "268435456" },
    });
    expect(component!.environment).toEqual([
      { name: "APP_MODE", value: 'production "A" $1 \\ ok' },
      { name: "SITE_TITLE", value: "Team notes" },
    ]);
    expect(component!.secretFiles).toEqual([{ envName: "ADMIN_KEY_FILE", parameterKey: "admin_key", version: 1 }]);
    expect(compiled.plan.ingress).toEqual([{ componentKey: "app", port: 8080 }]);
    // No value of the form reaches the plan as a secret, a host path or a capability.
    expect(JSON.stringify(compiled.plan)).not.toMatch(/docker\.sock|privileged|capAdd|hostPath/i);
  });

  it("leaves to the server what only the server judges: its issue comes back with a line of the written source", () => {
    const cases: Array<[AppSingleImageSetting, string]> = [
      [{ kind: "fixed", name: "DB_PASSWORD", value: "x" }, "ENV_NAME_SECRET_LIKE"],
      [{ kind: "fixed", name: "API_TOKEN", value: "x" }, "ENV_NAME_SECRET_LIKE"],
    ];
    for (const [setting, code] of cases) {
      const built = buildAppSingleImageTemplate({ ...base, settings: [setting] }, ALLOWLIST);
      if (!built.ok) throw new Error(JSON.stringify(built.problems));
      const result = validateAppTemplateSource(built.source, options);
      if (result.ok) throw new Error("expected the server to refuse");
      expect(result.errors.map((e) => e.code)).toEqual([code]);
      const line = result.errors[0]!.line!;
      expect(built.source.split("\n")[line - 1]).toContain(setting.name);
    }
    // The repository must be on the server's list too: the form's own list is only what it offers.
    const built = buildAppSingleImageTemplate(base, ALLOWLIST);
    if (!built.ok) throw new Error("unexpected");
    const elsewhere = validateAppTemplateSource(built.source, { allowlist: [] });
    expect(elsewhere.ok ? [] : elsewhere.errors.map((e) => e.code)).toEqual(["IMAGE_NOT_ALLOWLISTED"]);
  });
});
