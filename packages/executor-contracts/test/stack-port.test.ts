import { describe, expect, it } from "vitest";
import { APP_STACK_EXECUTOR_METHODS, Phase1DisabledDockerExecutor, isStackExecutor } from "../src/index.js";

const stub = (): Record<string, unknown> =>
  Object.fromEntries(APP_STACK_EXECUTOR_METHODS.map((m) => [m, () => Promise.resolve()]));

describe("@hosting-panel/executor-contracts — StackExecutorPort (ADR-0035)", () => {
  it("lists 12 unique methods", () => {
    expect(APP_STACK_EXECUTOR_METHODS).toHaveLength(12);
    expect(new Set(APP_STACK_EXECUTOR_METHODS).size).toBe(12);
  });

  it("detects an object with all 12 functions", () => {
    expect(isStackExecutor(stub())).toBe(true);
  });

  it.each(APP_STACK_EXECUTOR_METHODS)("refuses an object without %s", (method) => {
    const value = stub();
    delete value[method];
    expect(isStackExecutor(value)).toBe(false);
  });

  it("refuses a non-function member", () => {
    expect(isStackExecutor({ ...stub(), getAppStackStatus: "yes" })).toBe(false);
  });

  it.each([null, undefined, 0, "pullAppStackImage", true])("refuses %s", (value) => {
    expect(isStackExecutor(value)).toBe(false);
  });

  it("refuses the Phase 1 disabled executor", () => {
    expect(isStackExecutor(new Phase1DisabledDockerExecutor())).toBe(false);
  });
});
