import { describe, expect, it } from "vitest";
import {
  APP_STACK_EXECUTOR_METHODS,
  APP_STACK_TASK_EXECUTOR_METHODS,
  Phase1DisabledDockerExecutor,
  isStackExecutor,
  isStackTaskExecutor,
} from "../src/index.js";

const stub = (): Record<string, unknown> =>
  Object.fromEntries(APP_STACK_TASK_EXECUTOR_METHODS.map((m) => [m, () => Promise.resolve()]));

describe("@hosting-panel/executor-contracts — StackTaskExecutorPort (ADR-0042)", () => {
  it("lists the two calls, and none of them is a call of the application port", () => {
    expect([...APP_STACK_TASK_EXECUTOR_METHODS]).toEqual(["runAppStackTask", "getAppStackTaskRun"]);
    for (const method of APP_STACK_TASK_EXECUTOR_METHODS) expect(APP_STACK_EXECUTOR_METHODS).not.toContain(method);
  });

  it("detects an object with both functions, whatever else it has", () => {
    expect(isStackTaskExecutor(stub())).toBe(true);
    expect(isStackExecutor(stub())).toBe(false);
  });

  it.each(APP_STACK_TASK_EXECUTOR_METHODS)("refuses an object without %s", (method) => {
    const value = stub();
    delete value[method];
    expect(isStackTaskExecutor(value)).toBe(false);
  });

  it.each([null, undefined, 0, "runAppStackTask", true, { runAppStackTask: "yes", getAppStackTaskRun: 1 }])("refuses %s", (value) => {
    expect(isStackTaskExecutor(value)).toBe(false);
  });

  it("refuses the Phase 1 disabled executor: without the port a run is refused before anything is sent", () => {
    expect(isStackTaskExecutor(new Phase1DisabledDockerExecutor())).toBe(false);
  });
});
