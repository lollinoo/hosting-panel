import { describe, expect, it } from "vitest";
import {
  ALLOWED_APP_STACK_TRANSITIONS,
  APP_STACK_ENQUEUE_TRANSITIONS,
  APP_STACK_HEALTH_STALE_AFTER_MS,
  APP_STACK_OPERATION_KINDS,
  APP_STACK_STATUSES,
  aggregateAppStackStatus,
  appStackEnqueueTarget,
  appTemplateState,
  canTransitionAppStack,
  effectiveComponentHealth,
  type AppStackStatus,
} from "../src/index.js";

describe("application stack statuses", () => {
  it("the transition table equals the design literally", () => {
    expect(ALLOWED_APP_STACK_TRANSITIONS).toEqual({
      draft: ["queued", "deleting"],
      queued: ["deploying", "failed", "deleting"],
      deploying: ["running", "degraded", "failed", "unknown", "deleting"],
      running: ["stopping", "starting", "updating", "deleting"],
      degraded: ["stopping", "starting", "updating", "deleting"],
      failed: ["starting", "stopping", "updating", "deleting"],
      unknown: ["running", "degraded", "stopped", "failed", "starting", "stopping", "updating", "deleting"],
      stopping: ["stopped", "running", "degraded", "failed", "unknown", "deleting"],
      stopped: ["starting", "updating", "deleting"],
      starting: ["running", "degraded", "failed", "unknown", "deleting"],
      updating: ["running", "degraded", "failed", "unknown", "deleting"],
      deleting: ["deleted", "delete_failed"],
      delete_failed: ["deleting"],
      deleted: [],
    });
    expect(Object.isFrozen(ALLOWED_APP_STACK_TRANSITIONS)).toBe(true);
  });

  it("every status has an entry and deleted is terminal", () => {
    expect(APP_STACK_STATUSES).toHaveLength(14);
    expect(Object.keys(ALLOWED_APP_STACK_TRANSITIONS).sort()).toEqual([...APP_STACK_STATUSES].sort());
    for (const to of APP_STACK_STATUSES) expect(canTransitionAppStack("deleted", to)).toBe(false);
  });

  it("canTransitionAppStack answers representative pairs", () => {
    const pairs: [AppStackStatus, AppStackStatus, boolean][] = [
      ["unknown", "failed", true],
      ["deleting", "unknown", false],
      ["draft", "queued", true],
      ["draft", "running", false],
      ["queued", "failed", true],
      ["running", "updating", true],
      ["stopped", "stopping", false],
      ["stopping", "running", true],
      ["stopping", "failed", true],
      ["delete_failed", "deleting", true],
      ["deleting", "deleted", true],
    ];
    for (const [from, to, allowed] of pairs) expect(canTransitionAppStack(from, to), `${from}->${to}`).toBe(allowed);
  });

  it("every enqueue target is an allowed transition", () => {
    let checked = 0;
    for (const kind of APP_STACK_OPERATION_KINDS) {
      for (const [from, target] of Object.entries(APP_STACK_ENQUEUE_TRANSITIONS[kind])) {
        expect(canTransitionAppStack(from as AppStackStatus, target), `${kind} ${from}->${target}`).toBe(true);
        expect(appStackEnqueueTarget(kind, from as AppStackStatus)).toBe(target);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(appStackEnqueueTarget("stack.deploy", "draft")).toBe("queued");
    expect(appStackEnqueueTarget("stack.start", "running")).toBeNull();
    expect(appStackEnqueueTarget("stack.delete", "deleted")).toBeNull();
    expect(appStackEnqueueTarget("stack.delete", "delete_failed")).toBe("deleting");
  });

  it("aggregateAppStackStatus", () => {
    const healthy = { health: "healthy", essential: true } as const;
    const cases: [Parameters<typeof aggregateAppStackStatus>[0], string][] = [
      [{ components: [healthy], hasIngress: false, routesPublished: false }, "running"],
      [{ components: [healthy], hasIngress: true, routesPublished: true }, "running"],
      [{ components: [healthy], hasIngress: true, routesPublished: false }, "degraded"],
      [{ components: [healthy, { health: "unhealthy", essential: false }], hasIngress: false, routesPublished: false }, "degraded"],
      [{ components: [{ health: "starting", essential: true }], hasIngress: false, routesPublished: false }, "failed"],
      [{ components: [{ health: "missing", essential: true }, healthy], hasIngress: true, routesPublished: true }, "failed"],
    ];
    for (const [input, expected] of cases) expect(aggregateAppStackStatus(input)).toBe(expected);
  });

  it("effectiveComponentHealth reads stale and missing observations as unknown", () => {
    const now = new Date("2026-11-22T10:00:00.000Z");
    expect(effectiveComponentHealth("healthy", new Date(now.getTime() - 60_000), now)).toBe("healthy");
    expect(effectiveComponentHealth("healthy", new Date(now.getTime() - APP_STACK_HEALTH_STALE_AFTER_MS - 1), now)).toBe(
      "unknown",
    );
    expect(effectiveComponentHealth("unhealthy", null, now)).toBe("unknown");
  });

  it("appTemplateState", () => {
    expect(appTemplateState({ enabled: false, archivedAt: null })).toBe("draft");
    expect(appTemplateState({ enabled: true, archivedAt: null })).toBe("published");
    expect(appTemplateState({ enabled: true, archivedAt: "2026-11-22T10:00:00.000Z" })).toBe("archived");
  });
});
