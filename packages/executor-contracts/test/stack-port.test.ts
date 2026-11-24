import { describe, expect, it } from "vitest";
import {
  APP_STACK_EXECUTOR_METHODS,
  Phase1DisabledDockerExecutor,
  isAppStackTerminalExecutor,
  isStackExecutor,
  type TerminalSessionRecord,
} from "../src/index.js";

const stub = (): Record<string, unknown> =>
  Object.fromEntries(APP_STACK_EXECUTOR_METHODS.map((m) => [m, () => Promise.resolve()]));

describe("@hosting-panel/executor-contracts — StackExecutorPort (ADR-0035)", () => {
  it("lists 12 unique methods", () => {
    expect(APP_STACK_EXECUTOR_METHODS).toHaveLength(13);
    expect(new Set(APP_STACK_EXECUTOR_METHODS).size).toBe(13);
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

describe("@hosting-panel/executor-contracts — AppStackTerminalPort (ADR-0041)", () => {
  it("detects an executor that opens a terminal in a component", () => {
    expect(isAppStackTerminalExecutor({ openAppStackTerminal: () => Promise.resolve() })).toBe(true);
    expect(isAppStackTerminalExecutor({ ...stub(), openAppStackTerminal: () => Promise.resolve() })).toBe(true);
  });

  it("is apart from the stack port: an executor of applications without the terminal is still one", () => {
    expect((APP_STACK_EXECUTOR_METHODS as readonly string[]).includes("openAppStackTerminal")).toBe(false);
    expect(isStackExecutor(stub())).toBe(true);
    expect(isAppStackTerminalExecutor(stub())).toBe(false);
  });

  it.each([null, undefined, 0, "openAppStackTerminal", true, {}, { openAppStackTerminal: "yes" }])("refuses %s", (value) => {
    expect(isAppStackTerminalExecutor(value)).toBe(false);
  });

  it("refuses the Phase 1 disabled executor", () => {
    expect(isAppStackTerminalExecutor(new Phase1DisabledDockerExecutor())).toBe(false);
  });

  it("a listed session is a site's or a component's, told apart by its keys", () => {
    const at = "2026-11-23T10:00:00.000Z";
    const records: TerminalSessionRecord[] = [
      { sessionId: "term_a", siteId: "site_1", serviceInstanceId: "svc_1", containerName: "hp_svc_svc_1", openedAt: at, ended: null },
      {
        sessionId: "term_b", stackId: "stk_1", organizationId: "org_1", componentKey: "web",
        containerName: "hp_app_stk_1_web", openedAt: at, ended: { reason: "container_gone", at },
      },
    ];
    expect(records.map((r) => ("stackId" in r ? `${r.stackId}/${r.componentKey}` : r.siteId))).toEqual(["site_1", "stk_1/web"]);
  });
});
