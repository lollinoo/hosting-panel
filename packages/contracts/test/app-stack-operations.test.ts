import { describe, expect, it } from "vitest";
import {
  APP_ID_PREFIXES,
  APP_STACK_ID_PATTERN,
  APP_STACK_OPERATION_KINDS,
  APP_STACK_STEP_KEYS,
  APP_STACK_STEP_LABELS,
  APP_STACK_STEPS_BY_KIND,
  AppStackOperationPayloadSchema,
  OPERATION_KINDS,
  OPERATION_RESOURCE_TYPES,
  appStackLockKey,
  appStackOperationSteps,
  findForbiddenPublicDtoKeys,
  findPemValues,
  findPlaintextSecretKeys,
} from "../src/index.js";

const guards = (value: unknown): string[][] => [
  findPlaintextSecretKeys(value),
  findForbiddenPublicDtoKeys(value),
  findPemValues(value),
];

describe("application stack operations", () => {
  it("the stack kinds and resource type are operation kinds and resource types", () => {
    for (const kind of APP_STACK_OPERATION_KINDS) expect(OPERATION_KINDS).toContain(kind);
    expect(OPERATION_KINDS.slice(-7)).toEqual(APP_STACK_OPERATION_KINDS);
    expect(OPERATION_RESOURCE_TYPES).toContain("stack");
  });

  it("steps by kind are step keys; deploy runs the nine steps in order", () => {
    for (const kind of APP_STACK_OPERATION_KINDS) {
      for (const step of APP_STACK_STEPS_BY_KIND[kind]) expect(APP_STACK_STEP_KEYS).toContain(step);
    }
    expect(APP_STACK_STEPS_BY_KIND["stack.deploy"]).toEqual([
      "validate", "reserve", "pull", "prepare", "create", "start", "health", "publish", "settle",
    ]);
    expect(appStackOperationSteps("stack.stop")).toEqual([
      { key: "validate", label: "Check the request" },
      { key: "unpublish", label: "Withdraw the web addresses" },
      { key: "stop", label: "Stop the components" },
      { key: "settle", label: "Finish" },
    ]);
  });

  it("step labels name no technical object", () => {
    for (const key of APP_STACK_STEP_KEYS) {
      expect(APP_STACK_STEP_LABELS[key], key).not.toMatch(/container|image|volume|service|network|template/i);
    }
  });

  it("lock key", () => {
    expect(appStackLockKey("stk_a")).toBe("stack:stk_a");
  });

  it("the outbox payload passes the secret guards and the schema strips the envelope keys", () => {
    const business = { stackId: "stk_0123456789abcdef01234567", deploymentId: "sdep_0123456789abcdef01234567", revisionId: null };
    const payload = {
      operationId: "op_1",
      organizationId: "org_1",
      kind: "stack.deploy",
      resourceType: "stack",
      resourceId: business.stackId,
      ...business,
    };
    expect(guards(payload)).toEqual([[], [], []]);
    expect(AppStackOperationPayloadSchema.parse(payload)).toEqual(business);
    expect(AppStackOperationPayloadSchema.safeParse({ ...business, stackId: "Stk-1" }).success).toBe(false);
  });

  it("secret metadata passes the secret guards", () => {
    expect(guards({ key: "admin_password", set: true, version: 2, rotatedAt: "2026-11-22T10:00:00.000Z" })).toEqual([[], [], []]);
  });

  it("every id prefix mints ids that match the id pattern", () => {
    for (const prefix of Object.values(APP_ID_PREFIXES)) {
      expect(`${prefix}_0123456789abcdef01234567`).toMatch(APP_STACK_ID_PATTERN);
    }
    expect(Object.values(APP_ID_PREFIXES)).toEqual(["atpl", "atv", "stk", "srev", "sdep", "sdom", "ssec"]);
  });
});
