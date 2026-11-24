import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AppStackStatusIpcResultSchema,
  type ApprovedStackPlan,
  type AppStackRouteWire,
} from "@hosting-panel/contracts";
import { isStackExecutor } from "@hosting-panel/executor-contracts";
import { computeAppStackComponentHash } from "@hosting-panel/hosting-domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_STACK_CONTAINER_BODY_VERSION,
  APP_STACK_LABELS,
  AppStackExecutorError,
  assertExecutableAppStackPlan,
  buildAppStackContainerCreatePayload,
} from "../src/app-stacks/index.js";
import { ExecutorIpcClientError, InMemoryDockerSimulatorAdapter, type InMemoryDockerSimulatorAdapterOptions } from "../src/index.js";
import { TEST_ALLOWLIST, appStackTestPlan, rehash } from "./support/app-stack-plans.js";

const plan = appStackTestPlan();
const [web, worker] = plan.components as [ApprovedStackPlan["components"][number], ApprovedStackPlan["components"][number]];
const ID = plan.stackId;
const ref = { stackId: ID, organizationId: plan.organizationId };
const SECRET = { parameterKey: "shared_key", version: 1, content: "s3cr3t-content" };
const ROUTES: AppStackRouteWire[] = [
  { componentKey: "web", internalPort: 8080, hosts: [{ hostname: "shop.example.org", tls: true, httpsRedirect: true, redirectTo: null }] },
];
const withComponents = (...components: unknown[]) => rehash({ ...plan, components } as ApprovedStackPlan);

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hp-sim-stack-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const simulator = (options: InMemoryDockerSimulatorAdapterOptions = {}) =>
  new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST, ...options });

async function deploy(sim: InMemoryDockerSimulatorAdapter): Promise<void> {
  await sim.pullAppStackImage({ plan, image: web.image });
  await sim.prepareAppStack({ plan });
  await sim.createAppStackComponents({ plan });
  await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
  await sim.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [SECRET] });
}

async function failure(promise: Promise<unknown>): Promise<{ reason?: string; code?: string; message?: string; ambiguousOutcome?: boolean }> {
  try {
    await promise;
  } catch (err) {
    return err as { reason?: string; code?: string; message?: string };
  }
  throw new Error("expected a refusal");
}

const kinds = (sim: InMemoryDockerSimulatorAdapter) => sim.appStacks.appStackMutations.map((m) => m.kind);

/** Makes a container look built by a release before the body version label (#96). */
function withoutBodyVersion(sim: InMemoryDockerSimulatorAdapter, key: string): void {
  const stacks = (sim.appStacks as unknown as { stacks: Map<string, { containers: Map<string, { labels: Record<string, string> }> }> }).stacks;
  const container = stacks.get(ID)?.containers.get(key);
  if (container === undefined) throw new Error(`no container ${key}`);
  container.labels = Object.fromEntries(Object.entries(container.labels).filter(([label]) => label !== APP_STACK_LABELS.bodyVersion));
}

describe("SimulatedAppStacks deploy flow", () => {
  it("pulls, prepares, creates, starts and reports a healthy stack", async () => {
    const sim = simulator();
    expect(isStackExecutor(sim)).toBe(true);

    expect(await sim.pullAppStackImage({ plan, image: web.image })).toEqual({ image: web.image, pulled: true });
    expect(await sim.prepareAppStack({ plan })).toEqual({
      networks: [
        { role: "app_internal", created: true },
        { role: "app_edge", created: true },
      ],
      volumes: [{ volumeKey: "data", created: true }],
    });
    expect(await sim.createAppStackComponents({ plan })).toEqual({
      components: [
        { componentKey: "web", outcome: "created" },
        { componentKey: "worker", outcome: "created" },
      ],
      removedComponents: [],
    });
    expect(await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })).toEqual({
      componentKey: "web",
      outcome: "started",
    });
    expect(await sim.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [SECRET] })).toEqual({
      componentKey: "worker",
      outcome: "started",
    });

    const status = AppStackStatusIpcResultSchema.parse(await sim.getAppStackStatus(ref));
    expect(status).toMatchObject({
      stackId: ID,
      networks: { internal: true, edge: true },
      volumes: ["data"],
      routes: { published: false, hostnames: [] },
    });
    expect(status.components).toEqual([
      {
        componentKey: "web",
        state: "running",
        health: "healthy",
        probe: "passed",
        componentHash: computeAppStackComponentHash(plan, "web"),
        revisionId: plan.revisionId,
        startedAt: expect.any(String),
        restartCount: 0,
        exitCode: null,
        oomKilled: false,
      },
      expect.objectContaining({ componentKey: "worker", state: "running", health: "healthy", probe: "none" }),
    ]);

    expect(kinds(sim)).toEqual(["pull", "network", "network", "volume", "container_create", "container_create", "container_start", "container_start"]);
    expect(sim.appStacks.appStackCalls.map((c) => c.method)).toEqual([
      "pullAppStackImage", "prepareAppStack", "createAppStackComponents", "startAppStackComponent", "startAppStackComponent", "getAppStackStatus",
    ]);
    const snapshot = sim.appStacks.getAppStackSnapshot(ID);
    expect(snapshot?.containers.web).toEqual({
      name: `hp_app_${ID}_web`,
      labels: buildAppStackContainerCreatePayload(plan, "web", { secretsRootDir: "/run/hosting-panel/secrets" }).Labels,
      payload: buildAppStackContainerCreatePayload(plan, "web", { secretsRootDir: "/run/hosting-panel/secrets" }),
      state: "running",
    });
    expect(Object.keys(snapshot?.networks ?? {})).toEqual(["app_internal", "app_edge"]);
    expect(Object.keys(snapshot?.volumes ?? {})).toEqual(["data"]);
  });

  it("starts a component only from its plan, after its dependencies and with its secrets", async () => {
    const sim = simulator();
    await sim.pullAppStackImage({ plan, image: web.image });
    await sim.prepareAppStack({ plan });
    expect(await failure(sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }))).toMatchObject({
      reason: "STACK_COMPONENT_NOT_READY",
      message: "Component web is not created",
    });
    await sim.createAppStackComponents({ plan });
    expect(await failure(sim.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [SECRET] }))).toMatchObject({
      reason: "STACK_COMPONENT_NOT_READY",
      message: "Component web is not running",
    });
    await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
    expect(await failure(sim.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [] }))).toMatchObject({
      reason: "STACK_SECRET_MISSING",
    });
    const other = withComponents(web, { ...worker, environment: [{ name: "WEB_HOST", value: "web2" }] });
    expect(await failure(sim.startAppStackComponent({ plan: other, componentKey: "worker", secretFileContents: [SECRET] }))).toMatchObject({
      reason: "STACK_COMPONENT_NOT_READY",
      message: "Component worker was created from another plan",
    });
    expect(await failure(sim.startAppStackComponent({ plan, componentKey: "ghost", secretFileContents: [] }))).toMatchObject({
      reason: "STACK_PLAN_INVALID",
    });
  });
});

describe("SimulatedAppStacks refusals", () => {
  it.each([
    ["cpu 16 001", () => withComponents({ ...web, resources: { ...web.resources, cpuMilli: 16_001 } }, worker)],
    ["9 components", () => rehash({ ...plan, volumes: [], ingress: [], components: Array.from({ length: 9 }, (_, i) => ({ ...web, key: `c${i}` })) })],
    ["a /tmp mount", () => withComponents(web, { ...worker, volumes: [{ volumeKey: "data", containerPath: "/tmp", readOnly: false }] })],
    ["sh as argv[0]", () => withComponents(web, { ...worker, argv: ["sh", "-c", "worker"] })],
    ["an image without digest", () => withComponents({ ...web, image: "registry.test/acme/web:latest" }, worker)],
    ["an image not allowlisted", () => withComponents(web, { ...worker, image: `registry.test/other/web@sha256:${"d".repeat(64)}` })],
    ["another user", () => withComponents(web, { ...worker, runAsUser: "0" })],
    ["a tampered plan", () => ({ ...plan, components: [{ ...web, environment: [{ name: "APP_MODE", value: "debug" }] }, worker] })],
  ])("refuses %s exactly like the engine plan check, with no change", async (_name, build) => {
    const bad = build() as ApprovedStackPlan;
    let expected: AppStackExecutorError | undefined;
    try {
      assertExecutableAppStackPlan(bad, { allowlist: TEST_ALLOWLIST });
    } catch (err) {
      expected = err as AppStackExecutorError;
    }
    expect(expected).toBeInstanceOf(AppStackExecutorError);
    const sim = simulator();
    for (const call of [
      () => sim.pullAppStackImage({ plan: bad, image: web.image }),
      () => sim.prepareAppStack({ plan: bad }),
      () => sim.createAppStackComponents({ plan: bad }),
      () => sim.startAppStackComponent({ plan: bad, componentKey: "web", secretFileContents: [] }),
      () => sim.restartAppStackComponent({ plan: bad, componentKey: "web", secretFileContents: [] }),
      () => sim.publishAppStackRoutes({ plan: bad, routes: ROUTES }),
      () => sim.removeAppStackComponents({ plan: bad, componentKeys: ["web"] }),
    ]) {
      expect(await failure(call())).toMatchObject({ reason: expected?.reason, code: expected?.code, message: expected?.message });
    }
    expect(sim.appStacks.appStackMutations).toEqual([]);
    expect(sim.appStacks.getAppStackSnapshot(ID)).toBeNull();
  });

  it("refuses an image outside the plan, a route outside the ingress and a manual certificate", async () => {
    const sim = simulator();
    await deploy(sim);
    expect(await failure(sim.pullAppStackImage({ plan, image: `registry.test/acme/web@sha256:${"e".repeat(64)}` }))).toMatchObject({
      reason: "STACK_PLAN_INVALID",
      message: "The image is not part of the plan",
    });
    expect(await failure(sim.publishAppStackRoutes({ plan, routes: [{ ...ROUTES[0]!, componentKey: "worker" }] }))).toMatchObject({
      reason: "STACK_PLAN_INVALID",
    });
    const manual = [{ ...ROUTES[0]!, hosts: [{ ...ROUTES[0]!.hosts[0]!, source: "manual" as const }] }];
    expect(await failure(sim.publishAppStackRoutes({ plan, routes: manual }))).toMatchObject({ reason: "STACK_UNSUPPORTED_FEATURE" });
  });

  it("refuses the same stack id of another organisation", async () => {
    const sim = simulator();
    await deploy(sim);
    const foreign = rehash({ ...plan, organizationId: "org_other" });
    const before = sim.appStacks.appStackMutations.length;
    expect(await failure(sim.prepareAppStack({ plan: foreign }))).toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT", code: "HOST_POLICY_DENIED" });
    expect(await failure(sim.getAppStackStatus({ stackId: ID, organizationId: "org_other" }))).toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    expect(await failure(sim.removeAppStack({ stackId: ID, organizationId: "org_other", removeVolumes: true }))).toMatchObject({
      reason: "STACK_NAMESPACE_CONFLICT",
    });
    expect(sim.appStacks.appStackMutations).toHaveLength(before);
  });

  it("refuses a concurrent change of the same stack as STACK_BUSY", async () => {
    const sim = simulator();
    await deploy(sim);
    const first = sim.stopAppStack(ref);
    expect(await failure(sim.prepareAppStack({ plan }))).toMatchObject({ reason: "STACK_BUSY", code: "RESOURCE_LOCKED" });
    await first;
    expect((await sim.prepareAppStack({ plan })).volumes).toEqual([{ volumeKey: "data", created: false }]);
  });

  it("refuses every method while the engine is unreachable", async () => {
    const sim = simulator();
    sim.setEngineReachable(false);
    const calls = [
      () => sim.pullAppStackImage({ plan, image: web.image }),
      () => sim.prepareAppStack({ plan }),
      () => sim.createAppStackComponents({ plan }),
      () => sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }),
      () => sim.restartAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }),
      () => sim.stopAppStack(ref),
      () => sim.publishAppStackRoutes({ plan, routes: ROUTES }),
      () => sim.unpublishAppStackRoutes(ref),
      () => sim.removeAppStack({ ...ref, removeVolumes: true }),
      () => sim.removeAppStackComponents({ plan, componentKeys: ["web"] }),
      () => sim.getAppStackStatus(ref),
      () => sim.getAppStackComponentLogs({ ...ref, componentKey: "web", tail: 10 }),
    ];
    expect(calls).toHaveLength(12);
    for (const call of calls) expect(await failure(call())).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(sim.appStacks.appStackMutations).toEqual([]);
  });
});

describe("SimulatedAppStacks create refusals (#111)", () => {
  const marked = async (promise: Promise<unknown>) => ((await failure(promise)) as { beforeChange?: unknown }).beforeChange === true;

  it("a refusal raised before the first removal or create carries the mark, like the engine's", async () => {
    const sim = simulator();
    expect(await marked(sim.createAppStackComponents({ plan }))).toBe(true); // no network yet
    await sim.prepareAppStack({ plan });
    expect(await marked(sim.createAppStackComponents({ plan }))).toBe(true); // no image yet
    await sim.pullAppStackImage({ plan, image: web.image });
    expect(await marked(sim.createAppStackComponents({ plan: { ...plan, planHash: "0".repeat(64) } }))).toBe(true);
    expect(await marked(sim.createAppStackComponents({ plan, secretContents: [{ ...SECRET, parameterKey: "not_in_plan" }] }))).toBe(true);
    expect(sim.appStacks.appStackMutations.map((m) => m.kind)).not.toContain("container_create");

    await sim.createAppStackComponents({ plan });
    const stopping = sim.stopAppStack(ref);
    expect(await marked(sim.createAppStackComponents({ plan }))).toBe(true); // another change is running
    await stopping;
  });

  it("an engine that is down, a lost answer and a call that went through do not carry it", async () => {
    const sim = simulator();
    await sim.pullAppStackImage({ plan, image: web.image });
    await sim.prepareAppStack({ plan });
    sim.appStacks.failNextAppStackStep("create", "engine_unavailable");
    expect(await marked(sim.createAppStackComponents({ plan }))).toBe(false);
    sim.appStacks.failNextAppStackStep("create", "ambiguous_before");
    expect(await marked(sim.createAppStackComponents({ plan }))).toBe(false);
    sim.appStacks.failNextAppStackStep("create", "ambiguous_after");
    expect(await marked(sim.createAppStackComponents({ plan }))).toBe(false);
    sim.setEngineReachable(false);
    expect(await marked(sim.createAppStackComponents({ plan }))).toBe(false);
  });
});

describe("SimulatedAppStacks test hooks", () => {
  it("pull_failed refuses one pull and records no image", async () => {
    const sim = simulator();
    sim.appStacks.failNextAppStackStep("pull", "pull_failed");
    expect(await failure(sim.pullAppStackImage({ plan, image: web.image }))).toMatchObject({
      reason: "STACK_IMAGE_PULL_FAILED",
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
    expect(sim.appStacks.appStackMutations).toEqual([]);
    expect(await sim.pullAppStackImage({ plan, image: web.image })).toEqual({ image: web.image, pulled: true });
  });

  it("engine_unavailable refuses one step before doing anything", async () => {
    const sim = simulator();
    sim.appStacks.failNextAppStackStep("prepare", "engine_unavailable");
    expect(await failure(sim.prepareAppStack({ plan }))).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(sim.appStacks.getAppStackSnapshot(ID)).toBeNull();
    expect((await sim.prepareAppStack({ plan })).volumes).toEqual([{ volumeKey: "data", created: true }]);
  });

  it("ambiguous_before throws an ambiguous outcome and changes nothing", async () => {
    const sim = simulator();
    await sim.pullAppStackImage({ plan, image: web.image });
    await sim.prepareAppStack({ plan });
    const before = sim.appStacks.getAppStackSnapshot(ID);
    sim.appStacks.failNextAppStackStep("create", "ambiguous_before");
    const err = await failure(sim.createAppStackComponents({ plan }));
    expect(err).toBeInstanceOf(ExecutorIpcClientError);
    expect(err).toMatchObject({ code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true });
    expect(sim.appStacks.getAppStackSnapshot(ID)).toEqual(before);
    expect(sim.appStacks.getAppStackSnapshot(ID)?.containers).toEqual({});
  });

  it("ambiguous_after applies the step, then throws an ambiguous outcome", async () => {
    const sim = simulator();
    await sim.pullAppStackImage({ plan, image: web.image });
    await sim.prepareAppStack({ plan });
    await sim.createAppStackComponents({ plan });
    sim.appStacks.failNextAppStackStep("start", "ambiguous_after");
    const err = await failure(sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }));
    expect(err).toBeInstanceOf(ExecutorIpcClientError);
    expect(err).toMatchObject({ code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true });
    expect(sim.appStacks.getAppStackSnapshot(ID)?.containers.web?.state).toBe("running");
    expect(await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })).toEqual({
      componentKey: "web",
      outcome: "already_running",
    });
  });

  it("a failed probe is unhealthy and a crashed component is stopped", async () => {
    const sim = simulator();
    await deploy(sim);
    sim.appStacks.setAppStackComponentProbe(ID, "web", "failed");
    sim.appStacks.crashAppStackComponent(ID, "worker");
    const { components } = await sim.getAppStackStatus(ref);
    expect(components[0]).toMatchObject({ componentKey: "web", state: "running", health: "unhealthy", probe: "failed" });
    expect(components[1]).toMatchObject({ componentKey: "worker", state: "exited", health: "stopped", probe: "not_run", exitCode: 1 });
    sim.appStacks.setAppStackComponentProbe(ID, "web", "passed");
    expect(await sim.restartAppStackComponent({ plan, componentKey: "worker", secretFileContents: [SECRET] })).toEqual({
      componentKey: "worker",
      outcome: "restarted",
    });
    expect((await sim.getAppStackStatus(ref)).components.map((c) => c.health)).toEqual(["healthy", "healthy"]);
  });

  it("masks the component's secret values in its logs", async () => {
    const sim = simulator();
    await deploy(sim);
    sim.appStacks.setAppStackComponentLogs(ID, "worker", [
      { at: null, stream: "stdout", text: "one" },
      { at: null, stream: "stderr", text: "key=s3cr3t-content" },
    ]);
    expect(await sim.getAppStackComponentLogs({ ...ref, componentKey: "worker", tail: 1 })).toEqual([
      { at: null, stream: "stderr", text: "key=[REDACTED]" },
    ]);
    expect(await failure(sim.getAppStackComponentLogs({ ...ref, componentKey: "ghost", tail: 1 }))).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("SimulatedAppStacks idempotency and removal", () => {
  it("status never mutates and a re-apply adds no mutation", async () => {
    const sim = simulator();
    await deploy(sim);
    await sim.publishAppStackRoutes({ plan, routes: ROUTES });
    const before = [...sim.appStacks.appStackMutations];
    await sim.getAppStackStatus(ref);
    expect(sim.appStacks.appStackMutations).toEqual(before);

    expect(await sim.pullAppStackImage({ plan, image: web.image })).toEqual({ image: web.image, pulled: false });
    expect((await sim.prepareAppStack({ plan })).networks.map((n) => n.created)).toEqual([false, false]);
    expect((await sim.createAppStackComponents({ plan })).components.map((c) => c.outcome)).toEqual(["unchanged", "unchanged"]);
    expect((await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })).outcome).toBe("already_running");
    expect(await sim.publishAppStackRoutes({ plan, routes: ROUTES })).toEqual({ routeCount: 1, hostnames: ["shop.example.org"], changed: false });
    expect(sim.appStacks.appStackMutations).toEqual(before);

    expect(await sim.stopAppStack(ref)).toEqual({
      components: [
        { componentKey: "worker", outcome: "stopped" },
        { componentKey: "web", outcome: "stopped" },
      ],
    });
    const stopped = sim.appStacks.appStackMutations.length;
    expect((await sim.stopAppStack(ref)).components.map((c) => c.outcome)).toEqual(["already_stopped", "already_stopped"]);
    expect(sim.appStacks.appStackMutations).toHaveLength(stopped);
  });

  it("replaces only a changed component and removes a dropped one", async () => {
    const sim = simulator();
    await deploy(sim);
    const changed = withComponents(web, { ...worker, environment: [{ name: "WEB_HOST", value: "web2" }] });
    expect(await sim.createAppStackComponents({ plan: changed })).toEqual({
      components: [
        { componentKey: "web", outcome: "unchanged" },
        { componentKey: "worker", outcome: "replaced" },
      ],
      removedComponents: [],
    });
    const webOnly = rehash({ ...plan, components: [web], volumes: [] });
    expect(await sim.createAppStackComponents({ plan: webOnly })).toEqual({
      components: [{ componentKey: "web", outcome: "unchanged" }],
      removedComponents: ["worker"],
    });
    expect(Object.keys(sim.appStacks.getAppStackSnapshot(ID)?.volumes ?? {})).toEqual(["data"]);
  });

  it("a deploy replaces once a container with an equal hash and no body version label; start and restart leave it", async () => {
    const sim = simulator();
    await deploy(sim);
    withoutBodyVersion(sim, "web");
    const before = sim.appStacks.appStackMutations.length;
    expect((await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })).outcome).toBe("already_running");
    expect((await sim.restartAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })).outcome).toBe("restarted");
    await sim.stopAppStack(ref);
    expect((await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })).outcome).toBe("started");
    expect((await sim.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [SECRET] })).outcome).toBe("started");
    const kept = sim.appStacks.appStackMutations.slice(before).map((m) => m.kind);
    expect(kept).not.toContain("container_remove");
    expect(kept).not.toContain("container_create");
    expect(sim.appStacks.getAppStackSnapshot(ID)?.containers.web?.labels[APP_STACK_LABELS.bodyVersion]).toBeUndefined();

    // The worker has the current body version and an equal hash: unchanged.
    expect(await sim.createAppStackComponents({ plan })).toEqual({
      components: [
        { componentKey: "web", outcome: "replaced" },
        { componentKey: "worker", outcome: "unchanged" },
      ],
      removedComponents: [],
    });
    const labels = sim.appStacks.getAppStackSnapshot(ID)?.containers.web?.labels;
    expect(labels?.[APP_STACK_LABELS.bodyVersion]).toBe(String(APP_STACK_CONTAINER_BODY_VERSION));
    expect(labels?.[APP_STACK_LABELS.componentHash]).toBe(computeAppStackComponentHash(plan, "web"));
    expect((await sim.createAppStackComponents({ plan })).components.map((c) => c.outcome)).toEqual(["unchanged", "unchanged"]);
  });

  it("removes components, then the stack, keeping volumes unless asked", async () => {
    const sim = simulator();
    await deploy(sim);
    await sim.publishAppStackRoutes({ plan, routes: ROUTES });
    expect(await sim.removeAppStackComponents({ plan, componentKeys: ["worker", "ghost"] })).toEqual({ removedComponents: ["worker"] });
    expect(await sim.removeAppStack({ ...ref, removeVolumes: false })).toEqual({
      removedComponents: ["web"],
      removedNetworks: ["app_edge", "app_internal"],
      removedVolumes: [],
      retainedVolumes: ["data"],
    });
    const snapshot = sim.appStacks.getAppStackSnapshot(ID);
    expect(snapshot).toMatchObject({ containers: {}, networks: {}, routes: [] });
    expect(Object.keys(snapshot?.volumes ?? {})).toEqual(["data"]);
    expect(kinds(sim)).not.toContain("volume_remove");
    expect((await sim.getAppStackStatus(ref)).volumes).toEqual(["data"]);

    expect(await sim.removeAppStack({ ...ref, removeVolumes: true })).toEqual({
      removedComponents: [],
      removedNetworks: [],
      removedVolumes: ["data"],
      retainedVolumes: [],
    });
    expect(sim.appStacks.getAppStackSnapshot(ID)).toBeNull();
    expect(await sim.removeAppStack({ ...ref, removeVolumes: true })).toEqual({
      removedComponents: [],
      removedNetworks: [],
      removedVolumes: [],
      retainedVolumes: [],
    });
  });
});

describe("SimulatedAppStacks stop and remove order (#100)", () => {
  /** An upgrade that kept web's old label: web carries the later one although worker uses it. */
  function shifted(sim: InMemoryDockerSimulatorAdapter): void {
    const stacks = (sim.appStacks as unknown as { stacks: Map<string, { containers: Map<string, { labels: Record<string, string> }> }> }).stacks;
    const containers = stacks.get(ID)?.containers;
    if (containers === undefined) throw new Error("no stack");
    for (const [key, index] of [["web", "5"], ["worker", "1"]] as const) {
      const container = containers.get(key);
      if (container === undefined) throw new Error(`no container ${key}`);
      container.labels = { ...container.labels, [APP_STACK_LABELS.startIndex]: index };
    }
  }

  it("stops by reverse position in the order, a key it does not list first, and by the labels without one", async () => {
    const stopped = async (order?: string[]) => {
      const sim = simulator();
      await deploy(sim);
      shifted(sim);
      const result = await sim.stopAppStack(order === undefined ? ref : { ...ref, order });
      return result.components.map((c) => c.componentKey);
    };
    expect(await stopped()).toEqual(["web", "worker"]);
    expect(await stopped(["web", "worker"])).toEqual(["worker", "web"]);
    expect(await stopped(["worker"])).toEqual(["web", "worker"]);
    expect(await stopped(["ghost"])).toEqual(["web", "worker"]);
  });

  it("removes in the same order", async () => {
    const removed = async (order?: string[]) => {
      const sim = simulator();
      await deploy(sim);
      shifted(sim);
      const result = await sim.removeAppStack(order === undefined ? { ...ref, removeVolumes: false } : { ...ref, removeVolumes: false, order });
      return result.removedComponents;
    };
    expect(await removed()).toEqual(["web", "worker"]);
    expect(await removed(["web", "worker"])).toEqual(["worker", "web"]);
  });
});

describe("SimulatedAppStacks on disk", () => {
  it("writes real secret files only when secretsRootDir is set", async () => {
    const root = tempDir();
    const sim = simulator({ secretsRootDir: root });
    await deploy(sim);
    const file = path.join(root, `app_${ID}__worker`, "shared_key");
    expect(readFileSync(file, "utf8")).toBe("s3cr3t-content");
    expect(existsSync(path.join(root, `app_${ID}__web`))).toBe(false);
    sim.appStacks.setAppStackComponentLogs(ID, "worker", [{ at: null, stream: "stdout", text: "s3cr3t-content" }]);
    expect((await sim.getAppStackComponentLogs({ ...ref, componentKey: "worker", tail: 5 }))[0]?.text).toBe("[REDACTED]");
    await sim.removeAppStack({ ...ref, removeVolumes: true });
    expect(existsSync(path.join(root, `app_${ID}__worker`))).toBe(false);

    const virtual = simulator();
    await deploy(virtual);
    expect(existsSync(path.join("/run/hosting-panel/secrets", `app_${ID}__worker`))).toBe(false);
  });

  it("refuses, like the engine, a log read short of the secret files the container was given (BUG-43)", async () => {
    const root = tempDir();
    const sim = simulator({ secretsRootDir: root });
    await deploy(sim);
    sim.appStacks.setAppStackComponentLogs(ID, "worker", [{ at: null, stream: "stdout", text: "key=s3cr3t-content" }]);
    sim.appStacks.setAppStackComponentLogs(ID, "web", [{ at: null, stream: "stdout", text: "GET / 200" }]);
    const dir = path.join(root, `app_${ID}__worker`);
    rmSync(dir, { recursive: true, force: true });
    const refused = async () => {
      const err = await failure(sim.getAppStackComponentLogs({ ...ref, componentKey: "worker", tail: 5 }));
      expect(err).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", message: "The logs of component worker cannot be masked" });
      expect(JSON.stringify([String(err), err])).not.toContain("s3cr3t-content");
    };
    await refused();
    // What Docker does after a reboot: the missing bind source comes back as a directory.
    mkdirSync(path.join(dir, "shared_key"), { recursive: true });
    await refused();
    // web was given no secret file: served, with or without a folder.
    const web = () => sim.getAppStackComponentLogs({ ...ref, componentKey: "web", tail: 5 });
    expect(await web()).toEqual([{ at: null, stream: "stdout", text: "GET / 200" }]);
    mkdirSync(path.join(root, `app_${ID}__web`));
    expect(await web()).toEqual([{ at: null, stream: "stdout", text: "GET / 200" }]);
  });

  it("recognises a secret file by where the container sees it, like the engine: from another folder it is refused (BUG-43)", async () => {
    for (const sim of [simulator({ secretsRootDir: tempDir() }), simulator()]) {
      await deploy(sim);
      const own = sim.appStacks.getAppStackSnapshot(ID)?.containers.worker?.payload.HostConfig.Binds ?? [];
      expect(own).toEqual([expect.stringMatching(new RegExp(`/app_${ID}__worker/shared_key:/run/secrets/shared_key:ro$`))]);
      const source = own[0]!.split(":")[0]!;
      sim.appStacks.setAppStackComponentLogs(ID, "worker", [{ at: null, stream: "stdout", text: "key=s3cr3t-content" }]);
      sim.appStacks.setAppStackComponentLogs(ID, "web", [{ at: null, stream: "stdout", text: "GET / 200" }]);
      const read = (componentKey: string) => sim.getAppStackComponentLogs({ ...ref, componentKey, tail: 5 });
      // The same file name under an earlier secrets root, or in another component's folder: refused, though the
      // component's own folder holds the file.
      for (const elsewhere of [`/var/lib/earlier-root/app_${ID}__worker/shared_key`, source.replace(`__worker/`, `__web/`)]) {
        sim.appStacks.setAppStackComponentBinds(ID, "worker", [`${elsewhere}:/run/secrets/shared_key:ro`]);
        const err = await failure(read("worker"));
        expect(err).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", message: "The logs of component worker cannot be masked" });
        expect(JSON.stringify([String(err), err])).not.toContain("s3cr3t-content");
      }
      // A bind to another target is not a secret file, wherever it comes from.
      sim.appStacks.setAppStackComponentBinds(ID, "web", ["/var/lib/elsewhere/token:/etc/token:ro", `${source}:/srv/key:ro`]);
      expect(await read("web")).toEqual([{ at: null, stream: "stdout", text: "GET / 200" }]);
      // From the component's own folder: served, masked.
      sim.appStacks.setAppStackComponentBinds(ID, "worker", own);
      expect((await read("worker"))[0]?.text).toBe("key=[REDACTED]");
    }
  });

  it("refuses in memory too when the container was given a file the simulator does not hold yet", async () => {
    const sim = simulator();
    await deploy(sim);
    // An upgrade gives web its first secret file: its new container has the bind before its start writes the file.
    const upgraded = rehash({
      ...plan,
      components: plan.components.map((c) =>
        c.key === "web" ? { ...c, secretFiles: [{ envName: "WEB_TOKEN_FILE", parameterKey: "web_token", version: 1 }] } : c,
      ),
    });
    await sim.createAppStackComponents({ plan: upgraded });
    const token = "w3b-token-value";
    sim.appStacks.setAppStackComponentLogs(ID, "web", [{ at: null, stream: "stdout", text: `token=${token}` }]);
    const read = () => sim.getAppStackComponentLogs({ ...ref, componentKey: "web", tail: 5 });
    await expect(read()).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", message: "The logs of component web cannot be masked" });
    await sim.startAppStackComponent({ plan: upgraded, componentKey: "web", secretFileContents: [{ parameterKey: "web_token", version: 1, content: token }] });
    expect((await read())[0]?.text).toBe("token=[REDACTED]");
  });

  it("writes a real app_<stackId>.yml only when ingressRootDir is set", async () => {
    const ingressRootDir = tempDir();
    const sim = simulator({ ingressRootDir });
    await deploy(sim);
    expect(await sim.publishAppStackRoutes({ plan, routes: ROUTES })).toEqual({ routeCount: 1, hostnames: ["shop.example.org"], changed: true });
    const file = path.join(ingressRootDir, "dynamic", `app_${ID}.yml`);
    expect(readFileSync(file, "utf8")).toContain('# @hp-app-route {"componentKey":"web","internalPort":8080');
    expect((await sim.getAppStackStatus(ref)).routes).toEqual({ published: true, hostnames: ["shop.example.org"] });
    expect(await sim.unpublishAppStackRoutes(ref)).toEqual({ routeCount: 0, hostnames: [], changed: true });
    expect(existsSync(file)).toBe(false);
    expect(kinds(sim).slice(-2)).toEqual(["route_write", "route_remove"]);

    const virtual = simulator();
    await deploy(virtual);
    expect((await virtual.publishAppStackRoutes({ plan, routes: ROUTES })).changed).toBe(true);
    expect(virtual.appStacks.getAppStackSnapshot(ID)?.routes).toHaveLength(1);
  });
});
