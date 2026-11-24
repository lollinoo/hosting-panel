import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppStackRouteWire, ApprovedStackPlan } from "@hosting-panel/contracts";
import type { StackExecutorPort } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AppStackEngine, type AppStackHealthProbe } from "../src/app-stacks/index.js";
import { ExecutorIpcClientError, InMemoryDockerSimulatorAdapter } from "../src/index.js";
import type { AppStackRouteEntry } from "../src/traefik-config.js";
import { createAppStackFakeEngine } from "./support/app-stack-fake-engine.js";
import { TEST_ALLOWLIST, appStackTestPlan, rehash } from "./support/app-stack-plans.js";

const plan = appStackTestPlan();
const [web, worker] = plan.components as [ApprovedStackPlan["components"][number], ApprovedStackPlan["components"][number]];
const ID = plan.stackId;
const IMAGE = web.image;
const REF = { stackId: ID, organizationId: plan.organizationId };
const SECRETS = [{ parameterKey: "shared_key", version: 1, content: "s3cret-value-42" }];
const HOST = { hostname: "shop.example.org", tls: true, httpsRedirect: true, redirectTo: null };
const ROUTES: AppStackRouteWire[] = [{ componentKey: "web", internalPort: 8080, hosts: [HOST] }];
const withComponents = (...components: unknown[]) => rehash({ ...plan, components } as ApprovedStackPlan);

interface Outcome {
  readonly reason?: string;
  readonly code?: string;
  readonly message?: string;
}
async function outcome(promise: Promise<unknown>): Promise<Outcome> {
  try {
    await promise;
  } catch (err) {
    const { reason, code, message } = err as Outcome;
    return { reason, code, message };
  }
  return { reason: "NO_REFUSAL" };
}
async function failure(promise: Promise<unknown>): Promise<ExecutorIpcClientError> {
  try {
    await promise;
  } catch (err) {
    return err as ExecutorIpcClientError;
  }
  throw new Error("expected an error");
}

const roots: string[] = [];
afterEach(async () => {
  for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Target {
  readonly port: StackExecutorPort;
  /** Engine requests seen (engine target only). */
  readonly requests: () => number;
}
type Factory = (options?: { probe?: AppStackHealthProbe; pull?: boolean }) => Promise<Target>;

const simulatorTarget: Factory = async () => {
  const sim = new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST });
  return { port: sim, requests: () => sim.appStacks.appStackCalls.length };
};

const engineTarget: Factory = async (options = {}) => {
  const fake = createAppStackFakeEngine();
  const root = await mkdtemp(path.join(os.tmpdir(), "hp-sim-qa-"));
  roots.push(root);
  const stored = new Map<string, AppStackRouteEntry[]>();
  if (options.pull !== false) fake.images.set(IMAGE, { repoDigests: [IMAGE] });
  fake.images.set("traefik:test", { repoDigests: [] });
  await fake.request("POST", "/containers/create?name=hp_proxy_test", { Image: "traefik:test" });
  fake.log.length = 0;
  const engine = new AppStackEngine({
    request: fake.request,
    secretsRootDir: root,
    pullMissingImages: options.pull ?? true,
    allowlist: TEST_ALLOWLIST,
    routes: {
      write: async (stackId, entries) => {
        const active = entries.filter((e) => e.hosts.length > 0);
        const before = JSON.stringify(stored.get(stackId) ?? []);
        if (active.length === 0) stored.delete(stackId);
        else stored.set(stackId, [...active]);
        return { changed: before !== JSON.stringify(stored.get(stackId) ?? []), hostnames: active.flatMap((e) => e.hosts.map((h) => h.hostname)).sort() };
      },
      remove: async (stackId) => stored.delete(stackId),
      read: async (stackId) => stored.get(stackId) ?? [],
    },
    proxy: { containerName: "hp_proxy_test", ensure: async () => undefined },
    readLogs: async () => [],
    probe: options.probe ?? (async () => "passed"),
    now: () => new Date("2026-11-22T03:00:00.000Z"),
  });
  return { port: engine, requests: () => fake.log.length };
};

const TARGETS: Array<[string, Factory]> = [
  ["simulator", simulatorTarget],
  ["engine", engineTarget],
];

const prepared = async (port: StackExecutorPort, p = plan) => {
  await port.pullAppStackImage({ plan: p, image: IMAGE });
  await port.prepareAppStack({ plan: p });
  await port.createAppStackComponents({ plan: p });
};
const deployed = async (port: StackExecutorPort) => {
  await prepared(port);
  await port.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
  await port.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS });
};

async function simulator() {
  const sim = new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST });
  return { sim, hooks: sim.appStacks };
}

describe("engine / simulator parity: the same refusal gives the same reason, code and message", () => {
  const badPlans: Array<[string, () => ApprovedStackPlan, string]> = [
    ["a tampered plan", () => ({ ...plan, components: [{ ...web, environment: [] }, worker] }) as ApprovedStackPlan, "STACK_PLAN_HASH_MISMATCH"],
    ["cpu over the ceiling", () => withComponents({ ...web, resources: { ...web.resources, cpuMilli: 16_001 } }, worker), "STACK_PLAN_INVALID"],
    ["nine components", () => rehash({ ...plan, volumes: [], ingress: [], components: Array.from({ length: 9 }, (_, i) => ({ ...web, key: `c${i}` })) }), "STACK_PLAN_INVALID"],
    ["a /tmp mount", () => withComponents(web, { ...worker, volumes: [{ volumeKey: "data", containerPath: "/tmp", readOnly: false }] }), "STACK_PLAN_INVALID"],
    ["a /run mount", () => withComponents(web, { ...worker, volumes: [{ volumeKey: "data", containerPath: "/run/x", readOnly: false }] }), "STACK_PLAN_INVALID"],
    ["sh as argv[0]", () => withComponents(web, { ...worker, argv: ["sh", "-c", "worker"] }), "STACK_PLAN_INVALID"],
    ["a tag instead of a digest", () => withComponents({ ...web, image: "registry.test/acme/web:latest" }, worker), "STACK_PLAN_INVALID"],
    ["a registry look-alike", () => withComponents({ ...web, image: `registry.test.evil/acme/web@sha256:${"c".repeat(64)}` }, worker), "STACK_IMAGE_NOT_ALLOWED"],
    ["an image not allowlisted", () => withComponents(web, { ...worker, image: `registry.test/other/web@sha256:${"d".repeat(64)}` }), "STACK_IMAGE_NOT_ALLOWED"],
    ["a user that is not the allowlisted one", () => withComponents(web, { ...worker, runAsUser: "0" }), "STACK_IMAGE_NOT_ALLOWED"],
    ["an unknown key in a component", () => withComponents({ ...web, privileged: true }, worker), "STACK_PLAN_INVALID"],
  ];

  it.each(badPlans)("%s: identical outcome through both", async (_label, build, reason) => {
    const bad = build();
    const results: Outcome[][] = [];
    for (const [, factory] of TARGETS) {
      const { port, requests } = await factory();
      const before = requests();
      const row = [
        await outcome(port.pullAppStackImage({ plan: bad, image: IMAGE })),
        await outcome(port.prepareAppStack({ plan: bad })),
        await outcome(port.createAppStackComponents({ plan: bad })),
        await outcome(port.startAppStackComponent({ plan: bad, componentKey: "web", secretFileContents: [] })),
        await outcome(port.publishAppStackRoutes({ plan: bad, routes: ROUTES })),
        await outcome(port.removeAppStackComponents({ plan: bad, componentKeys: ["web"] })),
      ];
      results.push(row);
      // engine target: no Engine request at all; simulator target counts calls, so only the engine side is checked.
      if (port instanceof AppStackEngine) expect(requests()).toBe(before);
    }
    expect(results[0]).toEqual(results[1]);
    for (const o of results[0]!) expect(o.reason).toBe(reason);
  });

  const states: Array<[string, (p: StackExecutorPort) => Promise<void>, (p: StackExecutorPort) => Promise<unknown>, string, string | undefined]> = [
    ["start of a component that is not created", async () => undefined, (p) => p.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }), "STACK_COMPONENT_NOT_READY", "Component web is not created"],
    ["start of a dependent whose dependency is only created", prepared, (p) => p.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS }), "STACK_COMPONENT_NOT_READY", "Component web is not running"],
    ["start of a component outside the plan", prepared, (p) => p.startAppStackComponent({ plan, componentKey: "ghost", secretFileContents: [] }), "STACK_PLAN_INVALID", "The component is not part of the plan"],
    ["start with a missing secret", prepared, (p) => p.restartAppStackComponent({ plan, componentKey: "worker", secretFileContents: [] }), "STACK_SECRET_MISSING", undefined],
    ["start with a stale secret version", prepared, (p) => p.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [{ ...SECRETS[0]!, version: 2 }] }), "STACK_PLAN_INVALID", "A secret entry is not part of the plan"],
    ["start from another plan", async (p) => { await prepared(p); await p.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }); }, (p) => p.startAppStackComponent({ plan: withComponents(web, { ...worker, environment: [{ name: "WEB_HOST", value: "web2" }] }), componentKey: "worker", secretFileContents: SECRETS }), "STACK_COMPONENT_NOT_READY", "Component worker was created from another plan"],
    ["an image outside the plan", async () => undefined, (p) => p.pullAppStackImage({ plan, image: `registry.test/acme/web@sha256:${"e".repeat(64)}` }), "STACK_PLAN_INVALID", "The image is not part of the plan"],
    ["a route outside the ingress", deployed, (p) => p.publishAppStackRoutes({ plan, routes: [{ ...ROUTES[0]!, componentKey: "worker" }] }), "STACK_PLAN_INVALID", "The route is not an ingress of the plan"],
    ["a manual certificate route", deployed, (p) => p.publishAppStackRoutes({ plan, routes: [{ ...ROUTES[0]!, hosts: [{ ...HOST, source: "manual" as const }] }] }), "STACK_UNSUPPORTED_FEATURE", undefined],
    ["a path rule outside the ingress", deployed, (p) => p.publishAppStackRoutes({ plan, routes: [{ ...ROUTES[0]!, hosts: [{ ...HOST, paths: [{ pathPrefix: "/api", componentKey: "worker", internalPort: 9000, stripPrefix: false }] }] }] }), "STACK_PLAN_INVALID", "A path of the route is not an ingress of the plan"],
    ["a route to a component that is not running", prepared, (p) => p.publishAppStackRoutes({ plan, routes: ROUTES }), "STACK_COMPONENT_NOT_READY", undefined],
    ["a stack id of another organisation (prepare)", deployed, (p) => p.prepareAppStack({ plan: rehash({ ...plan, organizationId: "org_other" }) }), "STACK_NAMESPACE_CONFLICT", undefined],
    ["a stack id of another organisation (remove)", deployed, (p) => p.removeAppStack({ stackId: ID, organizationId: "org_other", removeVolumes: true }), "STACK_NAMESPACE_CONFLICT", undefined],
    ["a stack id of another organisation (status)", deployed, (p) => p.getAppStackStatus({ stackId: ID, organizationId: "org_other" }), "STACK_NAMESPACE_CONFLICT", undefined],
  ];

  it.each(states)("%s: same reason through the simulator and the engine", async (_label, arrange, act, reason, message) => {
    const results: Outcome[] = [];
    for (const [, factory] of TARGETS) {
      const { port } = await factory();
      await arrange(port);
      results.push(await outcome(act(port)));
    }
    // The design fixes the reason and the code; the free-text message of a state refusal may differ per backend.
    expect(results.map((r) => [r.reason, r.code])).toEqual([[reason, results[0]!.code], [reason, results[0]!.code]]);
    expect(results[0]!.code).toBeDefined();
    if (message !== undefined) expect(results.map((r) => r.message)).toEqual([message, message]);
  });

  it("create with an image the server does not have: STACK_IMAGE_MISSING through both when pulling is off", async () => {
    const results: Outcome[] = [];
    for (const [, factory] of TARGETS) {
      const { port } = await factory({ pull: false });
      await port.prepareAppStack({ plan });
      results.push(await outcome(port.createAppStackComponents({ plan })));
    }
    // Neither target has the image: the simulator because nothing pulled it, the engine because pulling is off.
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.reason).toBe("STACK_IMAGE_MISSING");
  });

  it("an engine and a simulator agree on the health of a running component whose probe fails", async () => {
    const results: unknown[] = [];
    for (const [name, factory] of TARGETS) {
      const { port } = await factory({ probe: async () => "failed" });
      await deployed(port);
      if (name === "simulator") (port as InMemoryDockerSimulatorAdapter).appStacks.setAppStackComponentProbe(ID, "web", "failed");
      const { components } = await port.getAppStackStatus(REF);
      results.push(components.map((c) => ({ key: c.componentKey, state: c.state, health: c.health, probe: c.probe })));
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual([
      { key: "web", state: "running", health: "unhealthy", probe: "failed" },
      { key: "worker", state: "running", health: "healthy", probe: "none" },
    ]);
  });
});

describe("A14 / A15: inputs the API relies on", () => {
  it("A14: a healthy running target is published; an unhealthy one is still observable as unhealthy", async () => {
    const { sim, hooks } = await simulator();
    await deployed(sim);
    expect((await sim.getAppStackStatus(REF)).components.find((c) => c.componentKey === "web")).toMatchObject({
      state: "running",
      health: "healthy",
      probe: "passed",
    });
    expect(await sim.publishAppStackRoutes({ plan, routes: ROUTES })).toMatchObject({ routeCount: 1, changed: true });
    hooks.setAppStackComponentProbe(ID, "web", "failed");
    const web1 = (await sim.getAppStackStatus(REF)).components.find((c) => c.componentKey === "web");
    expect(web1).toMatchObject({ state: "running", health: "unhealthy", probe: "failed" });
    expect((await sim.getAppStackStatus(REF)).routes).toEqual({ published: true, hostnames: ["shop.example.org"] });
  });

  it("A15: a dependency that is running but unhealthy does not block the start of its dependent", async () => {
    const { sim, hooks } = await simulator();
    await prepared(sim);
    await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
    hooks.setAppStackComponentProbe(ID, "web", "failed");
    expect((await sim.getAppStackStatus(REF)).components[0]).toMatchObject({ componentKey: "web", health: "unhealthy" });
    expect(await sim.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS })).toEqual({
      componentKey: "worker",
      outcome: "started",
    });
  });

  it("A15: a dependency that is not running blocks the dependent, created or crashed or stopped", async () => {
    const { sim, hooks } = await simulator();
    await prepared(sim);
    const start = () => sim.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS });
    const refusal = { reason: "STACK_COMPONENT_NOT_READY", code: "RESOURCE_LOCKED", message: "Component web is not running" };
    expect(await outcome(start())).toEqual(refusal);

    await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
    hooks.crashAppStackComponent(ID, "web", 137);
    expect(await outcome(start())).toEqual(refusal);
    expect((await sim.getAppStackStatus(REF)).components[0]).toMatchObject({ state: "exited", health: "stopped", probe: "not_run", exitCode: 137 });

    await sim.restartAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
    expect((await start()).outcome).toBe("started");
    await sim.stopAppStack(REF);
    expect(await outcome(start())).toEqual(refusal);
    expect(hooks.getAppStackSnapshot(ID)?.containers.worker?.state).toBe("exited");
  });

  it("the probe hook only affects the component it names and only a component with a health check", async () => {
    const { sim, hooks } = await simulator();
    await deployed(sim);
    hooks.setAppStackComponentProbe(ID, "worker", "failed");
    const status = (await sim.getAppStackStatus(REF)).components;
    expect(status.find((c) => c.componentKey === "worker")).toMatchObject({ health: "healthy", probe: "none" });
    expect(status.find((c) => c.componentKey === "web")).toMatchObject({ health: "healthy", probe: "passed" });

    hooks.setAppStackComponentProbe(ID, "web", "failed");
    hooks.setAppStackComponentProbe(ID, "web", "passed");
    expect((await sim.getAppStackStatus(REF)).components.find((c) => c.componentKey === "web")).toMatchObject({ health: "healthy", probe: "passed" });
  });

  it("a probe hook set before the start is honoured, and a stopped component reports stopped whatever the hook says", async () => {
    const { sim, hooks } = await simulator();
    hooks.setAppStackComponentProbe(ID, "web", "failed");
    await prepared(sim);
    expect((await sim.getAppStackStatus(REF)).components[0]).toMatchObject({ componentKey: "web", state: "created", health: "stopped", probe: "not_run" });
    await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
    expect((await sim.getAppStackStatus(REF)).components[0]).toMatchObject({ health: "unhealthy", probe: "failed" });
    await sim.stopAppStack(REF);
    expect((await sim.getAppStackStatus(REF)).components[0]).toMatchObject({ state: "exited", health: "stopped", probe: "not_run", exitCode: 0 });
  });

  it("the status result never exposes a secret value", async () => {
    const { sim } = await simulator();
    await deployed(sim);
    expect(JSON.stringify(await sim.getAppStackStatus(REF))).not.toContain("s3cret-value-42");
  });
});

describe("A17: ambiguous_after applies the step and the error carries the ambiguous outcome", () => {
  interface Row {
    readonly name: string;
    readonly step: Parameters<InMemoryDockerSimulatorAdapter["appStacks"]["failNextAppStackStep"]>[0];
    readonly arrange: (sim: StackExecutorPort) => Promise<void>;
    readonly act: (sim: InMemoryDockerSimulatorAdapter) => Promise<unknown>;
    /** What the step must have done although the call threw. */
    readonly effect: (sim: InMemoryDockerSimulatorAdapter) => Promise<void>;
    /** The retry converges: nothing is applied twice. */
    readonly retry: (sim: InMemoryDockerSimulatorAdapter) => Promise<unknown>;
    readonly retried: unknown;
  }
  const none = async (): Promise<void> => undefined;
  const rows: Row[] = [
    {
      name: "pull",
      step: "pull",
      arrange: none,
      act: (s) => s.pullAppStackImage({ plan, image: IMAGE }),
      effect: async (s) => expect(s.appStacks.appStackMutations.map((m) => m.kind)).toEqual(["pull"]),
      retry: (s) => s.pullAppStackImage({ plan, image: IMAGE }),
      retried: { image: IMAGE, pulled: false },
    },
    {
      name: "prepare",
      step: "prepare",
      arrange: (s) => s.pullAppStackImage({ plan, image: IMAGE }).then(() => undefined),
      act: (s) => s.prepareAppStack({ plan }),
      effect: async (s) => {
        expect(Object.keys(s.appStacks.getAppStackSnapshot(ID)?.networks ?? {})).toEqual(["app_internal", "app_edge"]);
        expect(Object.keys(s.appStacks.getAppStackSnapshot(ID)?.volumes ?? {})).toEqual(["data"]);
      },
      retry: (s) => s.prepareAppStack({ plan }),
      retried: {
        networks: [{ role: "app_internal", created: false }, { role: "app_edge", created: false }],
        volumes: [{ volumeKey: "data", created: false }],
      },
    },
    {
      name: "create",
      step: "create",
      arrange: async (s) => { await s.pullAppStackImage({ plan, image: IMAGE }); await s.prepareAppStack({ plan }); },
      act: (s) => s.createAppStackComponents({ plan }),
      effect: async (s) => {
        const snap = s.appStacks.getAppStackSnapshot(ID);
        expect(Object.keys(snap?.containers ?? {}).sort()).toEqual(["web", "worker"]);
        // A17: created, never started.
        expect(Object.values(snap?.containers ?? {}).map((c) => c.state)).toEqual(["created", "created"]);
        const status = await s.getAppStackStatus(REF);
        expect(status.components.map((c) => [c.state, c.health])).toEqual([["created", "stopped"], ["created", "stopped"]]);
      },
      retry: (s) => s.createAppStackComponents({ plan }),
      retried: { components: [{ componentKey: "web", outcome: "unchanged" }, { componentKey: "worker", outcome: "unchanged" }], removedComponents: [] },
    },
    {
      name: "start",
      step: "start",
      arrange: prepared,
      act: (s) => s.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }),
      effect: async (s) => expect(s.appStacks.getAppStackSnapshot(ID)?.containers.web?.state).toBe("running"),
      retry: (s) => s.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }),
      retried: { componentKey: "web", outcome: "already_running" },
    },
    {
      name: "restart",
      step: "restart",
      arrange: deployed,
      act: (s) => s.restartAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }),
      effect: async (s) => expect(s.appStacks.appStackMutations.at(-1)).toEqual({ kind: "container_restart", name: `hp_app_${ID}_web` }),
      retry: (s) => s.restartAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }),
      retried: { componentKey: "web", outcome: "restarted" },
    },
    {
      name: "stop",
      step: "stop",
      arrange: deployed,
      act: (s) => s.stopAppStack(REF),
      effect: async (s) =>
        expect(Object.values(s.appStacks.getAppStackSnapshot(ID)?.containers ?? {}).map((c) => c.state)).toEqual(["exited", "exited"]),
      retry: (s) => s.stopAppStack(REF),
      retried: { components: [{ componentKey: "worker", outcome: "already_stopped" }, { componentKey: "web", outcome: "already_stopped" }] },
    },
    {
      name: "routes",
      step: "routes",
      arrange: deployed,
      act: (s) => s.publishAppStackRoutes({ plan, routes: ROUTES }),
      effect: async (s) => expect(s.appStacks.getAppStackSnapshot(ID)?.routes).toHaveLength(1),
      retry: (s) => s.publishAppStackRoutes({ plan, routes: ROUTES }),
      retried: { routeCount: 1, hostnames: ["shop.example.org"], changed: false },
    },
    {
      name: "unpublish",
      step: "unpublish",
      arrange: async (s) => { await deployed(s); await s.publishAppStackRoutes({ plan, routes: ROUTES }); },
      act: (s) => s.unpublishAppStackRoutes(REF),
      effect: async (s) => expect(s.appStacks.getAppStackSnapshot(ID)?.routes).toEqual([]),
      retry: (s) => s.unpublishAppStackRoutes(REF),
      retried: { routeCount: 0, hostnames: [], changed: false },
    },
    {
      name: "remove_components",
      step: "remove_components",
      arrange: deployed,
      act: (s) => s.removeAppStackComponents({ plan, componentKeys: ["worker"] }),
      effect: async (s) => expect(Object.keys(s.appStacks.getAppStackSnapshot(ID)?.containers ?? {})).toEqual(["web"]),
      retry: (s) => s.removeAppStackComponents({ plan, componentKeys: ["worker"] }),
      retried: { removedComponents: [] },
    },
    {
      name: "remove",
      step: "remove",
      arrange: deployed,
      act: (s) => s.removeAppStack({ ...REF, removeVolumes: false }),
      effect: async (s) => {
        const snap = s.appStacks.getAppStackSnapshot(ID);
        expect(snap?.containers).toEqual({});
        expect(Object.keys(snap?.volumes ?? {})).toEqual(["data"]);
      },
      retry: (s) => s.removeAppStack({ ...REF, removeVolumes: false }),
      retried: { removedComponents: [], removedNetworks: [], removedVolumes: [], retainedVolumes: ["data"] },
    },
  ];

  it.each(rows)("$name: the step is applied, the error says the outcome is ambiguous, the retry converges", async (row) => {
    const sim = new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST });
    await row.arrange(sim);
    sim.appStacks.failNextAppStackStep(row.step, "ambiguous_after");
    const err = await failure(row.act(sim));
    expect(err).toBeInstanceOf(ExecutorIpcClientError);
    expect(err).toMatchObject({ code: "OPERATION_AMBIGUOUS", statusCode: 502, ambiguousOutcome: true });
    await row.effect(sim);
    // The fault was one-shot and the stack lock was released: the retry runs and converges.
    expect(await row.retry(sim)).toEqual(row.retried);
  });

  it("ambiguous_before: the same rows change nothing", async () => {
    for (const row of rows) {
      const sim = new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST });
      await row.arrange(sim);
      const before = sim.appStacks.getAppStackSnapshot(ID);
      const mutations = sim.appStacks.appStackMutations.length;
      sim.appStacks.failNextAppStackStep(row.step, "ambiguous_before");
      expect(await failure(row.act(sim)), row.name).toMatchObject({ code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true });
      expect(sim.appStacks.getAppStackSnapshot(ID), row.name).toEqual(before);
      expect(sim.appStacks.appStackMutations, row.name).toHaveLength(mutations);
    }
  });

  it("a fault is consumed by its own step only, FIFO, one call each", async () => {
    const sim = new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST });
    await prepared(sim);
    sim.appStacks.failNextAppStackStep("start", "ambiguous_after");
    sim.appStacks.failNextAppStackStep("start", "ambiguous_before");
    // another step is not affected
    expect((await sim.getAppStackStatus(REF)).components).toHaveLength(2);
    await expect(sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })).rejects.toMatchObject({ ambiguousOutcome: true });
    expect(sim.appStacks.getAppStackSnapshot(ID)?.containers.web?.state).toBe("running"); // first: after
    await sim.stopAppStack(REF);
    await expect(sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })).rejects.toMatchObject({ ambiguousOutcome: true });
    expect(sim.appStacks.getAppStackSnapshot(ID)?.containers.web?.state).toBe("exited"); // second: before, not applied
    expect((await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })).outcome).toBe("started");
  });

  it("a refusal wins over ambiguous_after: a refused step is not reported as applied", async () => {
    const sim = new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST });
    await prepared(sim);
    sim.appStacks.failNextAppStackStep("start", "ambiguous_after");
    const error = await failure(sim.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS }));
    expect(error).toMatchObject({ reason: "STACK_COMPONENT_NOT_READY" });
    expect(error).not.toBeInstanceOf(ExecutorIpcClientError);
    expect(sim.appStacks.getAppStackSnapshot(ID)?.containers.worker?.state).toBe("created");
  });

  it("ambiguous_after on a refused plan check does not hide the plan refusal", async () => {
    const sim = new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST });
    sim.appStacks.failNextAppStackStep("prepare", "ambiguous_after");
    const bad = rehash({ ...plan, components: [{ ...web, resources: { ...web.resources, cpuMilli: 16_001 } }, worker] } as ApprovedStackPlan);
    expect(await outcome(sim.prepareAppStack({ plan: bad }))).toMatchObject({ reason: "STACK_PLAN_INVALID" });
    expect(sim.appStacks.appStackMutations).toEqual([]);
  });

  it("the API-visible state after an ambiguous start is read back with status (GET-only, no mutation)", async () => {
    const sim = new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST });
    await prepared(sim);
    sim.appStacks.failNextAppStackStep("start", "ambiguous_after");
    await failure(sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }));
    const mutations = sim.appStacks.appStackMutations.length;
    const status = await sim.getAppStackStatus(REF);
    expect(status.components.map((c) => [c.componentKey, c.state, c.health])).toEqual([
      ["web", "running", "healthy"],
      ["worker", "created", "stopped"],
    ]);
    expect(sim.appStacks.appStackMutations).toHaveLength(mutations);
  });

  it("ambiguous faults on read steps (status, logs) throw the ambiguous error too", async () => {
    const sim = new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST });
    await deployed(sim);
    sim.appStacks.failNextAppStackStep("status", "ambiguous_before");
    expect(await failure(sim.getAppStackStatus(REF))).toMatchObject({ ambiguousOutcome: true });
    sim.appStacks.failNextAppStackStep("logs", "engine_unavailable");
    expect(await outcome(sim.getAppStackComponentLogs({ ...REF, componentKey: "web", tail: 5 }))).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect((await sim.getAppStackStatus(REF)).components).toHaveLength(2);
  });
});
