import {
  APP_STACK_STEP_KEYS,
  ERROR_CODES,
  type AppStackComponentHealth,
  type AppStackComponentObservation,
  type AppStackPlanComponent,
  type AppStackStatus,
  type AppStackStatusIpcResult,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import type { AppStackDomainRow } from "@hosting-panel/database";
import { ExecutorIpcClientError } from "@hosting-panel/docker-executor";
import { computeAppStackComponentHash } from "@hosting-panel/hosting-domain";
import { describe, expect, it } from "vitest";
import {
  APP_STACK_FAILURE,
  APP_STACK_NO_ADDRESS_TEXT,
  APP_STACK_RUNTIME_PROBLEMS,
  APP_STACK_STEP_DONE_TEXT,
  APP_STACK_STEP_FAILED_TEXT,
  APP_STACK_STEP_RUNNING_TEXT,
  APP_STACK_STEP_SKIPPED_TEXT,
  APP_STACK_START_INCOMPLETE_TEXT,
  APP_STACK_UNCERTAIN_TEXT,
  appStackAggregate,
  appStackDisplayStatus,
  appStackEssentialKeys,
  appStackHealthRows,
  appStackProblemOf,
  appStackRecordedHealth,
  appStackRecoveryVerdict,
  appStackReplacedComponents,
  appStackRestartSet,
  appStackRoutePlan,
  appStackRoutesHash,
  appStackRoutesHealthOnly,
  appStackSettleTarget,
} from "../src/app-stacks/app-stack-runtime-policy.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const IMAGE = `registry.test/acme/web@sha256:${"c".repeat(64)}`;

function component(key: string, dependsOn: string[] = [], patch: Partial<AppStackPlanComponent> = {}): AppStackPlanComponent {
  return {
    key,
    image: IMAGE,
    runAsUser: null,
    argv: null,
    environment: [],
    secretFiles: [],
    resources: { cpuMilli: 250, memoryBytes: "134217728" },
    expose: [8080, 9000],
    dependsOn,
    volumes: [],
    healthcheck: { kind: "tcp", port: 8080, intervalSeconds: 10, timeoutSeconds: 3 },
    ...patch,
  };
}

function plan(components: AppStackPlanComponent[], ingress: ApprovedStackPlan["ingress"] = []): ApprovedStackPlan {
  return {
    schemaVersion: 1,
    stackId: "stk_0123456789abcdef",
    organizationId: "org_acme",
    hostAllocationId: "alloc_0123456789abcdef",
    templateVersionId: "atv_0123456789abcdef",
    revisionId: "astr_0123456789abcdef",
    planHash: "0".repeat(64),
    components,
    volumes: [],
    ingress,
  };
}

function seen(
  componentKey: string,
  state: AppStackComponentObservation["state"] = "running",
  health: AppStackComponentObservation["health"] = "healthy",
  componentHash: string | null = null,
): AppStackComponentObservation {
  return {
    componentKey,
    state,
    health,
    probe: "passed",
    componentHash,
    revisionId: null,
    startedAt: null,
    restartCount: 0,
    exitCode: null,
    oomKilled: false,
  };
}

function observed(components: AppStackComponentObservation[], patch: Partial<AppStackStatusIpcResult> = {}): AppStackStatusIpcResult {
  return {
    stackId: "stk_0123456789abcdef",
    observedAt: NOW.toISOString(),
    components,
    networks: { internal: true, edge: true },
    volumes: [],
    routes: { published: true, hostnames: [] },
    ...patch,
  };
}

function domain(hostname: string, componentKey: string, internalPort: number, patch: Partial<AppStackDomainRow> = {}): AppStackDomainRow {
  return {
    id: `asd_${hostname}`,
    stackId: "stk_0123456789abcdef",
    organizationId: "org_acme",
    componentKey,
    internalPort,
    hostname,
    status: "pending",
    dnsStatus: "ok",
    dnsObserved: { a: [], aaaa: [] },
    dnsCheckedAt: null,
    dnsNextCheckAt: NOW,
    dnsAttempts: 0,
    certStatus: "none",
    certProblem: null,
    certChallenge: "http-01",
    certRequestedAt: null,
    certRetryAt: null,
    certAttempts: 0,
    certExpiresAt: null,
    certTrusted: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

const BANNED = /container|image|volume|service|network|template/i;

describe("fixed texts, problems and codes", () => {
  it("never names the machinery in a customer text", () => {
    expect(Object.keys(APP_STACK_STEP_DONE_TEXT)).toEqual([...APP_STACK_STEP_KEYS]);
    const texts = [
      ...Object.values(APP_STACK_STEP_DONE_TEXT),
      APP_STACK_STEP_RUNNING_TEXT,
      APP_STACK_STEP_FAILED_TEXT,
      APP_STACK_STEP_SKIPPED_TEXT,
      APP_STACK_NO_ADDRESS_TEXT,
      APP_STACK_START_INCOMPLETE_TEXT,
      APP_STACK_UNCERTAIN_TEXT,
      ...Object.values(APP_STACK_FAILURE).map((f) => f.text),
    ];
    for (const text of texts) expect(BANNED.test(text), text).toBe(false);
  });

  it("maps every problem to a well-formed code and an existing error code", () => {
    expect(Object.keys(APP_STACK_FAILURE)).toEqual([...APP_STACK_RUNTIME_PROBLEMS]);
    for (const problem of APP_STACK_RUNTIME_PROBLEMS) {
      expect(problem).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
      expect(ERROR_CODES).toContain(APP_STACK_FAILURE[problem].code);
    }
  });

  it.each([
    ["an executor reason", new ExecutorIpcClientError("refused", "HOST_POLICY_DENIED", 403, false, [{ field: "image", message: "x", reason: "STACK_IMAGE_NOT_ALLOWED" }]), "STACK_IMAGE_NOT_ALLOWED"],
    ["a control-plane reason", new ControlPlaneError("VALIDATION_ERROR", "x", { details: [{ field: "s", message: "x", reason: "STACK_SECRET_MISSING" }] }), "STACK_SECRET_MISSING"],
    ["a reason that wins over the code", new ExecutorIpcClientError("busy", "RESOURCE_LOCKED", 409, false, [{ field: "v", message: "x", reason: "STACK_VOLUME_IN_USE" }]), "STACK_VOLUME_IN_USE"],
    ["an unknown reason falls back to the code", new ExecutorIpcClientError("x", "HOST_POLICY_DENIED", 403, false, [{ field: "t", message: "x", reason: "TLS_VERSION_MISSING" }]), "STACK_IMAGE_NOT_ALLOWED"],
    ["VALIDATION_ERROR", new ControlPlaneError("VALIDATION_ERROR", "x"), "STACK_TEMPLATE_INVALID"],
    ["NOT_SUPPORTED", new ControlPlaneError("NOT_SUPPORTED", "x"), "STACK_UNSUPPORTED_FEATURE"],
    ["a message with a secret", new ExecutorIpcClientError("password=hunter2", "DOCKER_ENGINE_UNAVAILABLE", 502, true), "DOCKER_ENGINE_UNAVAILABLE"],
    ["a plain error", new Error("STACK_SECRET_MISSING password=hunter2"), "DOCKER_ENGINE_UNAVAILABLE"],
    ["not an error", null, "DOCKER_ENGINE_UNAVAILABLE"],
  ])("appStackProblemOf: %s", (_name, err, problem) => {
    const result = appStackProblemOf(err);
    expect(result).toBe(problem);
    expect(result).not.toContain("hunter2");
  });
});

describe("components", () => {
  it("appStackEssentialKeys: ingress targets, or every component without ingress", () => {
    const web = component("web");
    const cache = component("cache");
    expect([...appStackEssentialKeys(plan([cache, web], [{ componentKey: "web", port: 8080 }]))]).toEqual(["web"]);
    expect([...appStackEssentialKeys(plan([cache, web]))]).toEqual(["cache", "web"]);
  });

  it.each([
    [undefined, "waiting", "missing"],
    [seen("web", "running", "healthy"), "final", "healthy"],
    [seen("web", "running", "unhealthy"), "waiting", "starting"],
    [seen("web", "running", "unhealthy"), "final", "unhealthy"],
    [seen("web", "running", "unhealthy"), "observer", "unhealthy"],
    [seen("web", "restarting", "unhealthy"), "waiting", "starting"],
    [seen("web", "restarting", "unhealthy"), "observer", "unhealthy"],
    [seen("web", "created", "stopped"), "waiting", "stopped"],
    [seen("web", "exited", "stopped"), "final", "stopped"],
    [seen("web", "dead", "stopped"), "observer", "stopped"],
  ] as const)("appStackRecordedHealth(%o, %s) = %s", (observation, phase, health) => {
    expect(appStackRecordedHealth(observation, phase)).toBe(health);
  });

  it("appStackHealthRows: one row per plan component in plan order, absent ones missing", () => {
    const p = plan([component("db"), component("web", ["db"])]);
    expect(appStackHealthRows(p, observed([seen("web", "running", "unhealthy")]), "waiting")).toEqual([
      { componentKey: "db", health: "missing" },
      { componentKey: "web", health: "starting" },
    ]);
  });

  it("appStackAggregate: essential, accessory, routes", () => {
    const p = plan([component("cache"), component("web", ["cache"])], [{ componentKey: "web", port: 8080 }]);
    const health = (web: AppStackComponentHealth, cache: AppStackComponentHealth) =>
      new Map([["web", web], ["cache", cache]]);
    expect(appStackAggregate({ plan: p, health: health("unhealthy", "healthy"), domainCount: 1, routesPublished: true })).toBe("failed");
    expect(appStackAggregate({ plan: p, health: health("healthy", "unhealthy"), domainCount: 1, routesPublished: true })).toBe("degraded");
    expect(appStackAggregate({ plan: p, health: health("healthy", "healthy"), domainCount: 1, routesPublished: false })).toBe("degraded");
    expect(appStackAggregate({ plan: p, health: health("healthy", "healthy"), domainCount: 0, routesPublished: false })).toBe("running");
  });
});

describe("replaced and restarted components", () => {
  const chain = plan([component("db"), component("api", ["db"]), component("web", ["api"])]);

  it("a changed dependency is replaced and its dependents are restarted", () => {
    const next = plan([component("db", [], { argv: ["serve"] }), component("api", ["db"]), component("web", ["api"])]);
    const replaced = appStackReplacedComponents(chain, next);
    expect(replaced).toEqual(["db"]);
    expect(appStackRestartSet(next, replaced)).toEqual(["api", "web"]);
  });

  it("a first deploy replaces everything and restarts nothing", () => {
    const replaced = appStackReplacedComponents(null, chain);
    expect(replaced).toEqual(["db", "api", "web"]);
    expect(appStackRestartSet(chain, replaced)).toEqual([]);
  });

  it("identical plans change nothing; a new component is replaced", () => {
    expect(appStackReplacedComponents(chain, plan([...chain.components]))).toEqual([]);
    expect(appStackRestartSet(chain, [])).toEqual([]);
    const grown = plan([...chain.components, component("worker", ["db"])]);
    expect(appStackReplacedComponents(chain, grown)).toEqual(["worker"]);
  });
});

describe("routes", () => {
  const p = plan([component("admin"), component("web")], [
    { componentKey: "admin", port: 9000 },
    { componentKey: "web", port: 8080 },
  ]);
  const all = new Set(["admin", "web"]);
  const future = new Date(NOW.getTime() + 86_400_000);

  it("groups rows by ingress target, sorted, and counts orphans", () => {
    const { entries, orphaned } = appStackRoutePlan({
      plan: p,
      domains: [
        domain("www.example.com", "web", 8080),
        domain("admin.example.com", "admin", 9000),
        domain("app.example.com", "web", 8080),
        domain("stray.example.com", "web", 9000),
      ],
      include: all,
      now: NOW,
      acmeEnabled: true,
    });
    expect(orphaned).toBe(1);
    expect(entries.map((e) => [e.componentKey, e.internalPort, e.hosts.map((h) => h.hostname)])).toEqual([
      ["admin", 9000, ["admin.example.com"]],
      ["web", 8080, ["www.example.com", "app.example.com"]],
    ]);
    for (const host of entries.flatMap((e) => e.hosts)) {
      expect(host.redirectTo).toBeNull();
      expect(host).not.toHaveProperty("source");
    }
  });

  it("include drops a target; an empty plan has no entries", () => {
    const { entries } = appStackRoutePlan({
      plan: p,
      domains: [domain("admin.example.com", "admin", 9000), domain("www.example.com", "web", 8080)],
      include: new Set(["web"]),
      now: NOW,
      acmeEnabled: true,
    });
    expect(entries.map((e) => e.componentKey)).toEqual(["web"]);
    expect(appStackRoutePlan({ plan: p, domains: [], include: all, now: NOW, acmeEnabled: true }).entries).toEqual([]);
  });

  it.each([
    [{ certStatus: "active", certExpiresAt: future }, true, { tls: true, httpsRedirect: true }],
    [{ certStatus: "none" }, true, { tls: false, httpsRedirect: false }],
    [{ certStatus: "active", certExpiresAt: future }, false, { tls: false, httpsRedirect: false }],
    [{ certStatus: "requested", certChallenge: "dns-01" }, true, { tls: true, httpsRedirect: false, challenge: "dns-01" }],
  ] as const)("host flags for %o (acme %s)", (patch, acmeEnabled, flags) => {
    const { entries } = appStackRoutePlan({
      plan: p,
      domains: [domain("www.example.com", "web", 8080, patch)],
      include: all,
      now: NOW,
      acmeEnabled,
    });
    expect(entries[0]?.hosts).toEqual([{ hostname: "www.example.com", redirectTo: null, ...flags }]);
  });

  it("appStackRoutesHash: independent of row order, sensitive to tls, constant for []", () => {
    const rows = [
      domain("www.example.com", "web", 8080, { certStatus: "active", certExpiresAt: future }),
      domain("admin.example.com", "admin", 9000),
      domain("app.example.com", "web", 8080),
    ];
    const hash = (domains: AppStackDomainRow[]) =>
      appStackRoutesHash(appStackRoutePlan({ plan: p, domains, include: all, now: NOW, acmeEnabled: true }).entries);
    expect(hash(rows)).toMatch(/^[0-9a-f]{64}$/);
    expect(hash([...rows].reverse())).toBe(hash(rows));
    expect(hash([domain("www.example.com", "web", 8080), ...rows.slice(1)])).not.toBe(hash(rows));
    expect(appStackRoutesHash([])).toBe(appStackRoutesHash([]));
    expect(appStackRoutesHash([])).not.toBe(hash(rows));
  });

  it("appStackRoutesHealthOnly: true only when the published routes are today's addresses of some targets", () => {
    const www = domain("www.example.com", "web", 8080);
    const admin = domain("admin.example.com", "admin", 9000);
    const app = domain("app.example.com", "web", 8080);
    const routed = (domains: AppStackDomainRow[], include: ReadonlySet<string> = all) =>
      appStackRoutesHash(appStackRoutePlan({ plan: p, domains, include, now: NOW, acmeEnabled: true }).entries);
    const healthOnly = (domains: AppStackDomainRow[], appliedRoutesHash: string | null) =>
      appStackRoutesHealthOnly({ plan: p, domains, now: NOW, acmeEnabled: true, appliedRoutesHash });

    // A target left out or back.
    expect(healthOnly([www, admin, app], routed([www, admin, app]))).toBe(true);
    expect(healthOnly([www, admin, app], routed([www, admin, app], new Set(["admin"])))).toBe(true);
    expect(healthOnly([www, admin], null)).toBe(true);
    // An address added, removed, moved, or its certificate state changed.
    expect(healthOnly([www, admin, app], routed([www]))).toBe(false);
    expect(healthOnly([www], routed([www, app]))).toBe(false);
    expect(healthOnly([], routed([admin]))).toBe(false);
    expect(healthOnly([www, admin], routed([domain("www.example.com", "admin", 9000)]))).toBe(false);
    expect(healthOnly([domain("www.example.com", "web", 8080, { certStatus: "requested" })], routed([www]))).toBe(false);
  });
});

describe("appStackDisplayStatus", () => {
  const p = plan([component("cache"), component("web", ["cache"])], [{ componentKey: "web", port: 8080 }]);
  const fresh = new Date(NOW.getTime() - 60_000);
  const stale = new Date(NOW.getTime() - 6 * 60_000);
  const view = (status: AppStackStatus, cacheAt: Date | null, cacheHealth: "healthy" | "unhealthy" = "healthy") =>
    appStackDisplayStatus({
      stack: { status, appliedRoutesHash: "a".repeat(64) },
      plan: p,
      components: [
        { componentKey: "web", health: "healthy", healthObservedAt: fresh },
        { componentKey: "cache", health: cacheHealth, healthObservedAt: cacheAt },
      ],
      domainCount: 1,
      now: NOW,
    });

  it("reads a stale or never observed component as unknown", () => {
    expect(view("running", stale)).toBe("unknown");
    expect(view("degraded", null)).toBe("unknown");
  });

  it("aggregates fresh observations", () => {
    expect(view("running", fresh)).toBe("running");
    expect(view("running", fresh, "unhealthy")).toBe("degraded");
  });

  it("keeps any other stored status, and the stored one without a plan", () => {
    expect(view("stopped", stale)).toBe("stopped");
    expect(appStackDisplayStatus({ stack: { status: "running", appliedRoutesHash: null }, plan: null, components: [], domainCount: 0, now: NOW })).toBe("running");
  });
});

describe("appStackRecoveryVerdict", () => {
  const p = plan([component("cache"), component("web", ["cache"])], [{ componentKey: "web", port: 8080 }]);
  const hash = (key: string) => computeAppStackComponentHash(p, key);
  const matching = (cacheHealth: AppStackComponentObservation["health"] = "healthy") => [
    seen("cache", "running", cacheHealth, hash("cache")),
    seen("web", "running", "healthy", hash("web")),
  ];
  const empty = observed([], { networks: { internal: false, edge: false }, routes: { published: false, hostnames: [] } });
  const finalRows = (cache: AppStackComponentHealth, web: AppStackComponentHealth) => [
    { componentKey: "cache", health: cache },
    { componentKey: "web", health: web },
  ];

  it.each([
    ["delete: everything gone", "stack.delete", p, empty, false, { outcome: "succeeded", stackStatus: "deleted", applied: false, health: [], problem: null }],
    ["delete: a container left", "stack.delete", p, observed(matching()), false, { outcome: "failed", stackStatus: "delete_failed", applied: false, health: [], problem: "OPERATION_INTERRUPTED" }],
    ["delete: routes left", "stack.delete", p, observed([], { networks: { internal: false, edge: false } }), false, { outcome: "failed", stackStatus: "delete_failed", applied: false, health: [], problem: "OPERATION_INTERRUPTED" }],
    ["stop: never planned", "stack.stop", null, empty, false, { outcome: "succeeded", stackStatus: "stopped", applied: false, health: [], problem: null }],
    ["stop: all stopped", "stack.stop", p, observed([seen("cache", "exited", "stopped"), seen("web", "exited", "stopped")]), false, { outcome: "succeeded", stackStatus: "stopped", applied: false, health: finalRows("stopped", "stopped"), problem: null }],
    ["stop: one still running", "stack.stop", p, observed([seen("cache", "exited", "stopped"), seen("web")]), false, { outcome: "failed", stackStatus: "degraded", applied: false, health: finalRows("stopped", "healthy"), problem: "OPERATION_INTERRUPTED" }],
    ["stop: one restarting", "stack.stop", p, observed([seen("cache", "restarting", "unhealthy"), seen("web", "exited", "stopped")]), false, { outcome: "failed", stackStatus: "degraded", applied: false, health: finalRows("unhealthy", "stopped"), problem: "OPERATION_INTERRUPTED" }],
    ["deploy: a component absent", "stack.deploy", p, observed([seen("web", "running", "healthy", hash("web"))]), false, { outcome: "failed", stackStatus: "failed", applied: false, health: finalRows("missing", "healthy"), problem: "OPERATION_INTERRUPTED" }],
    ["upgrade: all ready", "stack.upgrade", p, observed(matching()), false, { outcome: "succeeded", stackStatus: "running", applied: true, health: finalRows("healthy", "healthy"), problem: null }],
    ["rollback: accessory unhealthy", "stack.rollback", p, observed(matching("unhealthy")), false, { outcome: "succeeded", stackStatus: "degraded", applied: true, health: finalRows("unhealthy", "healthy"), problem: null }],
    ["start: essential down", "stack.start", p, observed([seen("cache", "running", "healthy", hash("cache")), seen("web", "exited", "stopped", hash("web"))]), false, { outcome: "failed", stackStatus: "failed", applied: true, health: finalRows("healthy", "stopped"), problem: "OPERATION_INTERRUPTED" }],
    ["restart: routes not published", "stack.restart", p, observed(matching(), { routes: { published: false, hostnames: [] } }), false, { outcome: "succeeded", stackStatus: "degraded", applied: true, health: finalRows("healthy", "healthy"), problem: null }],
    ["deploy: no readable plan", "stack.deploy", null, observed(matching()), false, { outcome: "failed", stackStatus: "failed", applied: false, health: [], problem: "OPERATION_INTERRUPTED" }],
    ["start: no readable plan", "stack.start", null, observed(matching()), false, { outcome: "failed", stackStatus: "failed", applied: false, health: [], problem: "OPERATION_INTERRUPTED" }],
  ] as const)("%s", (_name, kind, stackPlan, observation, destroyVolumes, verdict) => {
    expect(appStackRecoveryVerdict({ kind, plan: stackPlan, observed: observation, domainCount: 1, destroyVolumes })).toEqual(verdict);
  });

  it("a hash mismatch on one component of three fails", () => {
    const three = plan([component("db"), component("cache", ["db"]), component("web", ["cache"])]);
    const result = appStackRecoveryVerdict({
      kind: "stack.deploy",
      plan: three,
      observed: observed([
        seen("db", "running", "healthy", computeAppStackComponentHash(three, "db")),
        seen("cache", "running", "healthy", "f".repeat(64)),
        seen("web", "running", "healthy", computeAppStackComponentHash(three, "web")),
      ]),
      domainCount: 0,
      destroyVolumes: false,
    });
    expect(result).toMatchObject({ outcome: "failed", stackStatus: "failed", applied: false, problem: "OPERATION_INTERRUPTED" });
  });

  it("a new revision that never ran while the applied one still serves settles like a pre-flight failure", () => {
    const v2 = { environment: [{ name: "MODE", value: "v2" }] };
    const next = plan([component("cache", [], v2), component("web", ["cache"], v2)], p.ingress);
    const input = { kind: "stack.upgrade", plan: next, previous: p, domainCount: 1, destroyVolumes: false } as const;
    expect(appStackRecoveryVerdict({ ...input, observed: observed(matching()) })).toEqual({
      outcome: "failed",
      stackStatus: "running",
      applied: false,
      health: finalRows("healthy", "healthy"),
      problem: "OPERATION_INTERRUPTED",
    });
    expect(appStackRecoveryVerdict({ ...input, observed: observed(matching("unhealthy")) })).toMatchObject({ outcome: "failed", stackStatus: "degraded", applied: false });
    // One component already replaced: neither revision is whole.
    const mixed = observed([seen("cache", "running", "healthy", hash("cache")), seen("web", "running", "healthy", computeAppStackComponentHash(next, "web"))]);
    expect(appStackRecoveryVerdict({ ...input, observed: mixed })).toMatchObject({ outcome: "failed", stackStatus: "failed", applied: false });
  });

  it("a retained volume finishes a delete unless the data is destroyed", () => {
    const left = observed([], { networks: { internal: false, edge: false }, volumes: ["data"], routes: { published: false, hostnames: [] } });
    const input = { kind: "stack.delete", plan: p, observed: left, domainCount: 0 } as const;
    expect(appStackRecoveryVerdict({ ...input, destroyVolumes: false }).stackStatus).toBe("deleted");
    expect(appStackRecoveryVerdict({ ...input, destroyVolumes: true })).toMatchObject({ outcome: "failed", stackStatus: "delete_failed" });
  });
});

describe("appStackSettleTarget", () => {
  it.each([
    ["queued", "failed", "failed"],
    ["queued", "running", "failed"],
    ["deploying", "running", "running"],
    ["stopping", "failed", "failed"],
    ["stopped", "failed", null],
    ["unknown", "degraded", "degraded"],
    ["running", "running", "running"],
  ] as const)("%s → %s = %s", (current, wanted, target) => {
    expect(appStackSettleTarget(current, wanted)).toBe(target);
  });
});
