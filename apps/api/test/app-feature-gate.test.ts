import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { APP_FEATURES_OFF, ERROR_CODE_HTTP_STATUS, type AppFeatureFlags } from "@hosting-panel/contracts";
import { DEMO_IDS } from "@hosting-panel/database";
import { afterEach, describe, expect, it } from "vitest";
import { requireAppFeature, resolveAppFeatureGate } from "../src/app-stacks/app-feature-gate.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { createControlPlaneApp, type ControlPlaneAppHandle } from "../src/index.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const FLAGS = Object.keys(APP_FEATURES_OFF) as (keyof AppFeatureFlags)[];

describe("HCP-SPEC-005 application feature gate", () => {
  it("defaults to every flag off, frozen", () => {
    const gate = resolveAppFeatureGate();
    expect(gate).toEqual(APP_FEATURES_OFF);
    expect(FLAGS).toHaveLength(4);
    expect(Object.isFrozen(gate)).toBe(true);
  });

  it("no production path turns a flag on", () => {
    expect(readFileSync(join(SRC, "main.ts"), "utf8")).not.toContain("appFeatures");
    const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    for (const file of files) {
      expect(readFileSync(join(SRC, file), "utf8"), file).not.toMatch(/process\.env\[?["']?HP_[A-Z_]*(APP|STACK)/);
    }
  });

  it("a flag that is off refuses with 422 NOT_SUPPORTED reason STACK_UNSUPPORTED_FEATURE", () => {
    const refusal = (() => {
      try {
        requireAppFeature(resolveAppFeatureGate(), "applicationStacksAvailable");
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(refusal).toBeInstanceOf(ControlPlaneError);
    expect(refusal).toMatchObject({ code: "NOT_SUPPORTED", details: [{ reason: "STACK_UNSUPPORTED_FEATURE" }] });
    expect(ERROR_CODE_HTTP_STATUS.NOT_SUPPORTED).toBe(422);
    expect(() =>
      requireAppFeature(resolveAppFeatureGate({ applicationStacksAvailable: true }), "applicationStacksAvailable"),
    ).not.toThrow();
  });

  describe("capability DTOs", () => {
    let app: ControlPlaneAppHandle | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    async function capabilities(appFeatures?: Partial<AppFeatureFlags>) {
      app = await createControlPlaneApp({
        seedPhase1: true,
        enableDevOidc: true,
        listen: true,
        host: "127.0.0.1",
        port: 0,
        autoProcessOutbox: false,
        outboxPollIntervalMs: null,
        driftReconcileIntervalMs: null,
        domainReconcileIntervalMs: null,
        ...(appFeatures ? { appFeatures } : {}),
      });
      const tokenRes = await fetch(`${app.baseUrl!}/v1/dev/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: "usr_elena" }),
      });
      const token = ((await tokenRes.json()) as { data: { accessToken: string } }).data.accessToken;
      const get = async (path: string) => {
        const res = await fetch(`${app!.baseUrl!}${path}`, { headers: { Authorization: `Bearer ${token}` } });
        expect(res.status, path).toBe(200);
        return ((await res.json()) as { data: Record<string, unknown> }).data;
      };
      const me = await get("/v1/me");
      const org = await get(`/v1/organizations/${DEMO_IDS.organizations.acme}`);
      return [me["platformCapabilities"], org["capabilities"]] as Record<string, unknown>[];
    }

    it("a default app shows the four flags false in /v1/me and the organisation", async () => {
      for (const set of await capabilities()) {
        for (const flag of FLAGS) expect(set![flag], flag).toBe(false);
      }
    });

    it("the tests-only appFeatures option turns on exactly the flags it names", async () => {
      for (const set of await capabilities({ applicationStacksAvailable: true })) {
        for (const flag of FLAGS) expect(set![flag], flag).toBe(flag === "applicationStacksAvailable");
      }
    });
  });
});
