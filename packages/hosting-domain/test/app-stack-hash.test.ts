import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AppTemplateSpec, ApprovedStackPlan } from "@hosting-panel/contracts";
import {
  computeAppStackComponentHash,
  computeAppStackPlanHash,
  computeAppTemplateSpecHash,
  verifyAppStackPlanHash,
} from "../src/index.js";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../contracts/test/fixtures/app-stack-notes-demo/${name}`, import.meta.url),
      "utf8",
    ),
  );
const plan = (): ApprovedStackPlan => fixture("plan.json") as ApprovedStackPlan;
const spec = (): AppTemplateSpec => fixture("spec.json") as AppTemplateSpec;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const reverseKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, item]) => [key, reverseKeys(item)]),
    );
  }
  return value;
};

describe("computeAppStackPlanHash", () => {
  it("is the SHA-256 hex of the literal canonical hash input", () => {
    const hash = computeAppStackPlanHash({
      templateVersionId: "atv_x",
      volumes: [],
      ingress: [],
      components: [],
      schemaVersion: 1,
    });
    expect(hash).toBe(
      sha256('{"components":[],"ingress":[],"schemaVersion":1,"templateVersionId":"atv_x","volumes":[]}'),
    );
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ignores the ids, the revision id and planHash", () => {
    const base = computeAppStackPlanHash(plan());
    const moved = {
      ...plan(),
      stackId: "stk_ffffffffffffffffffffffffffffffff",
      organizationId: "org_other",
      hostAllocationId: "alloc_ffffffffffffffffffffffffffffffff",
      revisionId: "astr_ffffffffffffffffffffffffffffffff",
      planHash: "f".repeat(64),
    };
    expect(computeAppStackPlanHash(moved)).toBe(base);
  });

  it("changes with a secret version, an image digest or an argv item", () => {
    const base = computeAppStackPlanHash(plan());

    const secret = plan();
    secret.components[1]!.secretFiles[0]!.version = 2;
    expect(computeAppStackPlanHash(secret)).not.toBe(base);

    const digest = plan();
    digest.components[0]!.image = `registry.example.invalid/demo/cache@sha256:${"c".repeat(64)}`;
    expect(computeAppStackPlanHash(digest)).not.toBe(base);

    const argv = plan();
    argv.components[1]!.argv = ["serve", "--workers", "3"];
    expect(computeAppStackPlanHash(argv)).not.toBe(base);
  });
});

describe("verifyAppStackPlanHash", () => {
  it("accepts only a plan whose planHash is the computed one", () => {
    const placeholder = { ...plan(), planHash: "0".repeat(64) };
    expect(verifyAppStackPlanHash(placeholder)).toBe(false);
    const sealed = { ...placeholder, planHash: computeAppStackPlanHash(placeholder) };
    expect(verifyAppStackPlanHash(sealed)).toBe(true);
    sealed.components[1]!.secretFiles[0]!.version = 2;
    expect(verifyAppStackPlanHash(sealed)).toBe(false);
  });
});

describe("computeAppStackComponentHash", () => {
  it("is the SHA-256 hex of the canonical component hash input", () => {
    expect(computeAppStackComponentHash(plan(), "cache")).toBe(
      sha256(
        '{"component":{"argv":null,"dependsOn":[],"environment":[],"expose":[6379],"healthcheck":null,' +
          `"image":"registry.example.invalid/demo/cache@sha256:${"b".repeat(64)}","key":"cache",` +
          '"resources":{"cpuMilli":500,"memoryBytes":"268435456"},"runAsUser":null,"secretFiles":[],"volumes":[]},' +
          '"edge":false,"schemaVersion":1}',
      ),
    );
  });

  it("ignores ids, other components and ingress entries that keep the edge", () => {
    const base = computeAppStackComponentHash(plan(), "app");

    const ids = { ...plan(), stackId: "stk_ffffffffffffffffffffffffffffffff", templateVersionId: "atv_other" };
    expect(computeAppStackComponentHash(ids, "app")).toBe(base);

    const other = plan();
    other.components[0]!.resources.cpuMilli = 750;
    other.components[0]!.expose = [6380];
    expect(computeAppStackComponentHash(other, "app")).toBe(base);

    const routes = plan();
    routes.ingress = [
      { componentKey: "app", port: 8080 },
      { componentKey: "app", port: 9090 },
    ];
    expect(computeAppStackComponentHash(routes, "app")).toBe(base);
  });

  it("flips with edge membership", () => {
    const internal = plan();
    internal.ingress = [];
    expect(computeAppStackComponentHash(internal, "app")).not.toBe(computeAppStackComponentHash(plan(), "app"));

    const cacheEdge = plan();
    cacheEdge.ingress = [...cacheEdge.ingress, { componentKey: "cache", port: 6379 }];
    expect(computeAppStackComponentHash(cacheEdge, "cache")).not.toBe(computeAppStackComponentHash(plan(), "cache"));
  });

  it("changes with the component itself", () => {
    const changed = plan();
    changed.components[1]!.environment[0]!.value = "cache2";
    expect(computeAppStackComponentHash(changed, "app")).not.toBe(computeAppStackComponentHash(plan(), "app"));
  });

  it("throws RangeError for an unknown component key", () => {
    expect(() => computeAppStackComponentHash(plan(), "missing")).toThrow(RangeError);
  });
});

describe("computeAppTemplateSpecHash", () => {
  it("is stable for permuted object keys", () => {
    const base = computeAppTemplateSpecHash(spec());
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(computeAppTemplateSpecHash(reverseKeys(spec()) as AppTemplateSpec)).toBe(base);
  });

  it("changes with a value of the spec", () => {
    const changed = spec();
    changed.services[0]!.image.digest = `sha256:${"c".repeat(64)}`;
    expect(computeAppTemplateSpecHash(changed)).not.toBe(computeAppTemplateSpecHash(spec()));
  });
});
