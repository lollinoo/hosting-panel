import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppStackStatusIpcResultSchema, type AppStackRouteWire, type ApprovedStackPlan } from "@hosting-panel/contracts";
import type { ServiceLogLine } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_STACK_LABELS,
  APP_STACK_PULL_ENGINE_TIMEOUT_MS,
  AppStackEngine,
  appStackNetworkLabels,
  appStackVolumeLabels,
  buildAppStackContainerCreatePayload,
  type AppStackHealthProbe,
} from "../src/app-stacks/index.js";
import type { AppStackRouteEntry } from "../src/traefik-config.js";
import { createAppStackFakeEngine } from "./support/app-stack-fake-engine.js";
import { TEST_ALLOWLIST, appStackTestPlan, rehash } from "./support/app-stack-plans.js";

const ID = "stk_0123456789abcdef";
const ORG = "org_acme";
const IMAGE = `registry.test/acme/web@sha256:${"c".repeat(64)}`;
const enc = encodeURIComponent;
const NET = `hp_appnet_${ID}`;
const EDGE = `hp_appedge_${ID}`;
const VOL = `hp_appvol_${ID}_data`;
const WEB = `hp_app_${ID}_web`;
const WORKER = `hp_app_${ID}_worker`;
const PROXY = "hp_ingress_proxy_test";
const SECRET = "s3cret-value-42";
const SECRETS = [{ parameterKey: "shared_key", version: 1, content: SECRET }];
const REF = { stackId: ID, organizationId: ORG };
const HOST = { hostname: "shop.example.org", tls: true, httpsRedirect: true, redirectTo: null };
const ROUTES: AppStackRouteWire[] = [{ componentKey: "web", internalPort: 8080, hosts: [HOST] }];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const mutations = (log: readonly string[]) => log.filter((line) => !line.startsWith("GET "));

async function setup(options: { pullMissingImages?: boolean; secretsRootDir?: string; probe?: AppStackHealthProbe } = {}) {
  const fake = createAppStackFakeEngine();
  const root = await mkdtemp(path.join(os.tmpdir(), "hp-app-engine-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const stored = new Map<string, AppStackRouteEntry[]>();
  const routes = {
    write: vi.fn(async (stackId: string, entries: readonly AppStackRouteEntry[]) => {
      fake.log.push("ROUTES write");
      const active = entries.filter((entry) => entry.hosts.length > 0);
      const before = JSON.stringify(stored.get(stackId) ?? []);
      if (active.length === 0) stored.delete(stackId);
      else stored.set(stackId, [...active]);
      const hostnames = active.flatMap((entry) => entry.hosts.map((h) => h.hostname)).sort();
      return { changed: before !== JSON.stringify(stored.get(stackId) ?? []), hostnames };
    }),
    remove: vi.fn(async (stackId: string) => {
      fake.log.push("ROUTES remove");
      return stored.delete(stackId);
    }),
    read: vi.fn(async (stackId: string) => stored.get(stackId) ?? []),
  };
  const proxy = { containerName: PROXY, ensure: vi.fn(async () => void fake.log.push("PROXY ensure")) };
  const logLines: ServiceLogLine[] = [];
  const readLogs = vi.fn(async () => logLines);
  const probe = vi.fn<AppStackHealthProbe>(options.probe ?? (async () => "passed"));
  const request = vi.fn(fake.request);
  const engine = new AppStackEngine({
    request,
    secretsRootDir: options.secretsRootDir ?? root,
    pullMissingImages: options.pullMissingImages ?? true,
    allowlist: TEST_ALLOWLIST,
    routes,
    proxy,
    readLogs,
    probe,
    now: () => new Date("2026-11-22T03:00:00.000Z"),
  });
  fake.images.set("traefik:test", { repoDigests: [] });
  await fake.request("POST", `/containers/create?name=${PROXY}`, { Image: "traefik:test" });
  fake.log.length = 0;
  fake.bodies.clear();
  return { fake, root, routes, stored, proxy, readLogs, logLines, probe, request, engine };
}

type Harness = Awaited<ReturnType<typeof setup>>;

async function prepared(h: Harness, plan = appStackTestPlan()) {
  h.fake.images.set(IMAGE, { repoDigests: [IMAGE] });
  await h.engine.prepareAppStack({ plan });
  await h.engine.createAppStackComponents({ plan });
  h.fake.log.length = 0;
}

async function deployed(h: Harness, plan = appStackTestPlan()) {
  await prepared(h, plan);
  await h.engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
  await h.engine.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS });
  h.fake.log.length = 0;
}

const idOf = (h: Harness, name: string) => h.fake.containers.get(name)?.Id ?? "missing";
const secretDir = (h: Harness, key: string) => path.join(h.root, `app_${ID}__${key}`);
const exists = (file: string) => stat(file).then(() => true, () => false);

async function foreignContainer(h: Harness, name: string, labels: Record<string, string> = {}, extra: object = {}) {
  await h.fake.request("POST", `/containers/create?name=${name}`, { Image: "traefik:test", Labels: labels, ...extra });
  h.fake.log.length = 0;
}

function withWorkerEnv(value: string): ApprovedStackPlan {
  const plan = appStackTestPlan();
  return rehash({
    ...plan,
    components: plan.components.map((c) => (c.key === "worker" ? { ...c, environment: [{ name: "WEB_HOST", value }] } : c)),
  });
}

describe("plan refusals reach no Engine request", () => {
  const plan = appStackTestPlan();
  const tampered = { ...plan, components: plan.components.map((c) => ({ ...c, environment: [] })) };
  const invalid = { ...plan, components: plan.components.map((c) => ({ ...c, resources: { ...c.resources, cpuMilli: 16_001 } })) };
  const calls = (engine: AppStackEngine, p: ApprovedStackPlan) => [
    () => engine.pullAppStackImage({ plan: p, image: IMAGE }),
    () => engine.prepareAppStack({ plan: p }),
    () => engine.createAppStackComponents({ plan: p }),
    () => engine.startAppStackComponent({ plan: p, componentKey: "web", secretFileContents: [] }),
    () => engine.restartAppStackComponent({ plan: p, componentKey: "web", secretFileContents: [] }),
    () => engine.publishAppStackRoutes({ plan: p, routes: ROUTES }),
    () => engine.removeAppStackComponents({ plan: p, componentKeys: ["web"] }),
  ];

  it.each([
    ["tampered", tampered, "STACK_PLAN_HASH_MISMATCH", "HOST_POLICY_DENIED", "The application plan does not match its hash"],
    ["invalid", invalid, "STACK_PLAN_INVALID", "VALIDATION_ERROR", "The application plan is invalid at components.0.resources.cpuMilli"],
  ])("%s plan", async (_name, bad, reason, code, message) => {
    const h = await setup();
    for (const call of calls(h.engine, bad as ApprovedStackPlan)) {
      await expect(call()).rejects.toMatchObject({ reason, code, message });
    }
    expect(h.fake.log).toEqual([]);
  });

  it("a plan image that is not allowlisted", async () => {
    const h = await setup();
    const strict = new AppStackEngine({ ...h, request: h.fake.request, secretsRootDir: h.root, pullMissingImages: true, allowlist: [] });
    for (const call of calls(strict, plan)) {
      await expect(call()).rejects.toMatchObject({ reason: "STACK_IMAGE_NOT_ALLOWED", code: "HOST_POLICY_DENIED" });
    }
    expect(h.fake.log).toEqual([]);
  });
});

describe("pullAppStackImage (5.8)", () => {
  const plan = appStackTestPlan();
  const inspect = `GET /images/${enc(IMAGE)}/json`;
  const pull = `POST /images/create?fromImage=${enc(IMAGE)}`;

  it("a present image with its digest is not pulled", async () => {
    const h = await setup();
    h.fake.images.set(IMAGE, { repoDigests: [IMAGE] });
    await expect(h.engine.pullAppStackImage({ plan, image: IMAGE })).resolves.toEqual({ image: IMAGE, pulled: false });
    expect(h.fake.log).toEqual([inspect]);
  });

  it("refuses an image outside the plan with no request", async () => {
    const h = await setup();
    const other = `registry.test/acme/web@sha256:${"d".repeat(64)}`;
    await expect(h.engine.pullAppStackImage({ plan, image: other })).rejects.toMatchObject({
      reason: "STACK_PLAN_INVALID",
      message: "The image is not part of the plan",
    });
    expect(h.fake.log).toEqual([]);
  });

  it("pulls a missing image by digest, then verifies it", async () => {
    const h = await setup();
    h.fake.pullable.add(IMAGE);
    await expect(h.engine.pullAppStackImage({ plan, image: IMAGE })).resolves.toEqual({ image: IMAGE, pulled: true });
    expect(h.fake.log).toEqual([inspect, pull, inspect]);
    expect(h.request).toHaveBeenCalledWith("POST", `/images/create?fromImage=${enc(IMAGE)}`, undefined, {
      timeoutMs: APP_STACK_PULL_ENGINE_TIMEOUT_MS,
    });
    expect(APP_STACK_PULL_ENGINE_TIMEOUT_MS).toBe(240_000);
  });

  it("never pulls when pullMissingImages is false", async () => {
    const h = await setup({ pullMissingImages: false });
    h.fake.pullable.add(IMAGE);
    await expect(h.engine.pullAppStackImage({ plan, image: IMAGE })).rejects.toMatchObject({
      reason: "STACK_IMAGE_MISSING",
      code: "NOT_FOUND",
      message: "The image is not available on this server",
    });
    expect(h.fake.log).toEqual([inspect]);
  });

  it.each([
    ["an error line in the 200 stream", (h: Harness) => void h],
    ["a pull HTTP 500", (h: Harness) => (h.fake.pullable.add(IMAGE), h.fake.failNext(/^POST \/images\/create/, 500))],
    [
      "an inspect failure after the pull",
      (h: Harness) => (h.fake.pullable.add(IMAGE), h.fake.failNext(/^GET \/images/, 404), h.fake.failNext(/^GET \/images/, 500)),
    ],
  ])("%s is STACK_IMAGE_PULL_FAILED", async (_name, arrange) => {
    const h = await setup();
    arrange(h);
    const err = await h.engine.pullAppStackImage({ plan, image: IMAGE }).catch((e: Error) => e);
    expect(err).toMatchObject({
      reason: "STACK_IMAGE_PULL_FAILED",
      code: "DOCKER_ENGINE_UNAVAILABLE",
      message: "Could not download the software of the application",
    });
    expect(String(err)).not.toContain("manifest");
  });

  it("refuses a local image whose RepoDigests do not hold the digest and leaves it", async () => {
    const h = await setup();
    h.fake.images.set(IMAGE, { repoDigests: [`registry.test/acme/web@sha256:${"d".repeat(64)}`] });
    await expect(h.engine.pullAppStackImage({ plan, image: IMAGE })).rejects.toMatchObject({
      reason: "STACK_IMAGE_DIGEST_MISMATCH",
      code: "HOST_POLICY_DENIED",
    });
    expect(mutations(h.fake.log)).toEqual([]);
    expect(h.fake.images.has(IMAGE)).toBe(true);
  });

  it("an unexpected inspect status is a plain engine error", async () => {
    const h = await setup();
    h.fake.failNext(/^GET \/images/, 500);
    const err = await h.engine.pullAppStackImage({ plan, image: IMAGE }).catch((e: Error & { reason?: string }) => e);
    expect(err).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", message: expect.stringContaining("(HTTP 500)") });
    expect(err).not.toHaveProperty("reason");
  });
});

describe("prepareAppStack (5.9)", () => {
  const plan = appStackTestPlan();

  it("creates both bridges and the volume with owner labels, then re-runs as a no-op", async () => {
    const h = await setup();
    await expect(h.engine.prepareAppStack({ plan })).resolves.toEqual({
      networks: [
        { role: "app_internal", created: true },
        { role: "app_edge", created: true },
      ],
      volumes: [{ volumeKey: "data", created: true }],
    });
    expect(h.fake.bodies.get("POST /networks/create")).toEqual([
      { Name: NET, Driver: "bridge", Internal: true, CheckDuplicate: true, Labels: appStackNetworkLabels(plan, "app_internal") },
      { Name: EDGE, Driver: "bridge", Internal: false, CheckDuplicate: true, Labels: appStackNetworkLabels(plan, "app_edge") },
    ]);
    expect(h.fake.bodies.get("POST /volumes/create")).toEqual([
      { Name: VOL, Driver: "local", Labels: appStackVolumeLabels(plan, "data") },
    ]);
    h.fake.log.length = 0;
    await expect(h.engine.prepareAppStack({ plan })).resolves.toEqual({
      networks: [
        { role: "app_internal", created: false },
        { role: "app_edge", created: false },
      ],
      volumes: [{ volumeKey: "data", created: false }],
    });
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("creates no edge network without ingress", async () => {
    const h = await setup();
    const result = await h.engine.prepareAppStack({ plan: appStackTestPlan({ ingress: [] }) });
    expect(result.networks).toEqual([{ role: "app_internal", created: true }]);
    expect(h.fake.networks.has(EDGE)).toBe(false);
  });

  it.each([
    ["a foreign network with the derived name", { Name: NET, Driver: "bridge", Internal: true }],
    [
      "an own network with a bridge name option",
      { Name: NET, Driver: "bridge", Internal: true, Labels: appStackNetworkLabels(plan, "app_internal"), Options: { "com.docker.network.bridge.name": "br-x" } },
    ],
    ["an own network that is not internal", { Name: NET, Driver: "bridge", Internal: false, Labels: appStackNetworkLabels(plan, "app_internal") }],
    ["another organisation's network", { Name: NET, Driver: "bridge", Internal: true, Labels: appStackNetworkLabels({ ...plan, organizationId: "org_other" }, "app_internal") }],
  ])("refuses %s and creates nothing", async (_name, network) => {
    const h = await setup();
    await h.fake.request("POST", "/networks/create", network);
    h.fake.log.length = 0;
    await expect(h.engine.prepareAppStack({ plan })).rejects.toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT", code: "HOST_POLICY_DENIED" });
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it.each([
    ["a foreign volume", { Name: VOL, Driver: "local" }],
    ["an own volume of another key", { Name: VOL, Driver: "local", Labels: appStackVolumeLabels(plan, "other") }],
    ["an own volume of another driver", { Name: VOL, Driver: "nfs", Labels: appStackVolumeLabels(plan, "data") }],
  ])("refuses %s", async (_name, volume) => {
    const h = await setup();
    await h.fake.request("POST", "/volumes/create", volume);
    await expect(h.engine.prepareAppStack({ plan })).rejects.toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    expect(h.fake.bodies.get("POST /volumes/create")).toHaveLength(1);
  });

  it("a 409 on network create re-inspects once (race won by an own create)", async () => {
    const h = await setup();
    await h.fake.request("POST", "/networks/create", { Name: NET, Driver: "bridge", Internal: true, Labels: appStackNetworkLabels(plan, "app_internal") });
    h.fake.failNext(new RegExp(`^GET /networks/${NET}$`), 404);
    const result = await h.engine.prepareAppStack({ plan });
    expect(result.networks[0]).toEqual({ role: "app_internal", created: false });
  });

  it("a 409 race won by a foreign network is a conflict", async () => {
    const h = await setup();
    await h.fake.request("POST", "/networks/create", { Name: NET, Driver: "bridge", Internal: true });
    h.fake.failNext(new RegExp(`^GET /networks/${NET}$`), 404);
    await expect(h.engine.prepareAppStack({ plan })).rejects.toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
  });

  it("a partial failure keeps what was created and a re-run continues", async () => {
    const h = await setup();
    h.fake.failNext(/^POST \/volumes\/create/, 500);
    await expect(h.engine.prepareAppStack({ plan })).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect([...h.fake.networks.keys()].sort()).toEqual([EDGE, NET]);
    const result = await h.engine.prepareAppStack({ plan });
    expect(result).toEqual({
      networks: [
        { role: "app_internal", created: false },
        { role: "app_edge", created: false },
      ],
      volumes: [{ volumeKey: "data", created: true }],
    });
  });
});

describe("createAppStackComponents (5.10)", () => {
  const plan = appStackTestPlan();

  it.each([
    ["no network", (h: Harness) => void h, "STACK_COMPONENT_NOT_READY", "The stack network is not prepared"],
    [
      "no volume",
      async (h: Harness) => {
        await h.engine.prepareAppStack({ plan });
        h.fake.volumes.clear();
      },
      "STACK_COMPONENT_NOT_READY",
      "A stack volume is not prepared",
    ],
    ["no image", (h: Harness) => h.engine.prepareAppStack({ plan }), "STACK_IMAGE_MISSING", "The image is not available on this server"],
    [
      "an image of another digest",
      async (h: Harness) => {
        await h.engine.prepareAppStack({ plan });
        h.fake.images.set(IMAGE, { repoDigests: [] });
      },
      "STACK_IMAGE_DIGEST_MISMATCH",
      "The downloaded software does not match its pinned fingerprint",
    ],
  ])("refuses with %s before any change", async (_name, arrange, reason, message) => {
    const h = await setup();
    await arrange(h);
    h.fake.log.length = 0;
    await expect(h.engine.createAppStackComponents({ plan })).rejects.toMatchObject({ reason, message });
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("creates every component from the stack body without starting it; a re-run changes nothing", async () => {
    const h = await setup();
    h.fake.images.set(IMAGE, { repoDigests: [IMAGE] });
    await h.engine.prepareAppStack({ plan });
    await expect(h.engine.createAppStackComponents({ plan })).resolves.toEqual({
      components: [
        { componentKey: "web", outcome: "created" },
        { componentKey: "worker", outcome: "created" },
      ],
      removedComponents: [],
    });
    expect(h.fake.bodies.get(`POST /containers/create?name=${WEB}`)).toEqual([
      buildAppStackContainerCreatePayload(plan, "web", { secretsRootDir: h.root }),
    ]);
    expect(h.fake.containers.get(WORKER)?.State.Status).toBe("created");
    expect(h.fake.log.some((line) => /\/(start|restart)/.test(line))).toBe(false);
    h.fake.log.length = 0;
    const again = await h.engine.createAppStackComponents({ plan });
    expect(again.components.map((c) => c.outcome)).toEqual(["unchanged", "unchanged"]);
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("replaces only the component whose hash changed and keeps its volume", async () => {
    const h = await setup();
    await deployed(h);
    const oldWorker = idOf(h, WORKER);
    const oldWeb = idOf(h, WEB);
    const result = await h.engine.createAppStackComponents({ plan: withWorkerEnv("other") });
    expect(result.components).toEqual([
      { componentKey: "web", outcome: "unchanged" },
      { componentKey: "worker", outcome: "replaced" },
    ]);
    expect(mutations(h.fake.log)).toEqual([
      `POST /containers/${oldWorker}/stop?t=10`,
      `DELETE /containers/${oldWorker}?force=true&v=true`,
      `POST /containers/create?name=${WORKER}`,
    ]);
    expect(idOf(h, WEB)).toBe(oldWeb);
    expect(h.fake.containers.get(WEB)?.State.Running).toBe(true);
    expect(h.fake.volumes.has(VOL)).toBe(true);
    expect(await exists(secretDir(h, "worker"))).toBe(true);
  });

  it("removes a stale component and purges its secret dir", async () => {
    const h = await setup();
    await deployed(h);
    expect(await exists(secretDir(h, "worker"))).toBe(true);
    const only = appStackTestPlan({ components: [appStackTestPlan().components[0]!], volumes: [] });
    const result = await h.engine.createAppStackComponents({ plan: only });
    expect(result).toEqual({ components: [{ componentKey: "web", outcome: "unchanged" }], removedComponents: ["worker"] });
    expect(h.fake.containers.has(WORKER)).toBe(false);
    expect(await exists(secretDir(h, "worker"))).toBe(false);
    expect(h.fake.volumes.has(VOL)).toBe(true);
  });

  it("refuses a foreign container that holds a derived name and leaves it alone", async () => {
    const h = await setup();
    h.fake.images.set(IMAGE, { repoDigests: [IMAGE] });
    await h.engine.prepareAppStack({ plan });
    await foreignContainer(h, WORKER);
    await expect(h.engine.createAppStackComponents({ plan })).rejects.toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    expect(h.fake.containers.has(WORKER)).toBe(true);
    expect(h.fake.containers.has(WEB)).toBe(false);
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("a body refused by the hardening check removes and creates nothing", async () => {
    const h = await setup({ secretsRootDir: "/var/run/hp-app-engine-test" });
    const [webComponent, workerComponent] = plan.components;
    await prepared(h, appStackTestPlan({ components: [webComponent!, { ...workerComponent!, secretFiles: [] }] }));
    const oldWeb = idOf(h, WEB);
    const oldWorker = idOf(h, WORKER);
    const webWithSecret = { ...webComponent!, secretFiles: [{ envName: "SHARED_KEY_FILE", parameterKey: "shared_key", version: 1 }] };
    await expect(h.engine.createAppStackComponents({ plan: appStackTestPlan({ components: [webWithSecret], volumes: [] }) })).rejects.toMatchObject({
      code: "HOST_POLICY_DENIED",
    });
    expect(mutations(h.fake.log)).toEqual([]);
    expect([idOf(h, WEB), idOf(h, WORKER)]).toEqual([oldWeb, oldWorker]);
  });

  it("replaces a component whose environment holds a /var/run path", async () => {
    const h = await setup();
    await deployed(h);
    const base = appStackTestPlan();
    const pidFile = rehash({
      ...base,
      components: base.components.map((c) => (c.key === "worker" ? { ...c, environment: [{ name: "PIDFILE", value: "/var/run/app.pid" }] } : c)),
    });
    await expect(h.engine.createAppStackComponents({ plan: pidFile })).resolves.toEqual({
      components: [
        { componentKey: "web", outcome: "unchanged" },
        { componentKey: "worker", outcome: "replaced" },
      ],
      removedComponents: [],
    });
    expect(h.fake.bodies.get(`POST /containers/create?name=${WORKER}`)?.at(-1)).toMatchObject({ Env: ["PIDFILE=/var/run/app.pid", "SHARED_KEY_FILE=/run/secrets/shared_key"] });
  });

  it("refuses when a container labelled with the stack id belongs to another organisation", async () => {
    const h = await setup();
    h.fake.images.set(IMAGE, { repoDigests: [IMAGE] });
    await h.engine.prepareAppStack({ plan });
    await foreignContainer(h, "intruder", { [APP_STACK_LABELS.stackId]: ID, [APP_STACK_LABELS.organizationId]: "org_other" });
    await expect(h.engine.createAppStackComponents({ plan })).rejects.toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("a partial failure keeps earlier components and every volume; a re-run converges", async () => {
    const h = await setup();
    h.fake.images.set(IMAGE, { repoDigests: [IMAGE] });
    await h.engine.prepareAppStack({ plan });
    h.fake.failNext(new RegExp(`^POST /containers/create\\?name=${WORKER}`), 500);
    await expect(h.engine.createAppStackComponents({ plan })).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(h.fake.containers.has(WEB)).toBe(true);
    expect(h.fake.containers.has(WORKER)).toBe(false);
    expect(h.fake.volumes.has(VOL)).toBe(true);
    const again = await h.engine.createAppStackComponents({ plan });
    expect(again.components).toEqual([
      { componentKey: "web", outcome: "unchanged" },
      { componentKey: "worker", outcome: "created" },
    ]);
  });

  it("refuses a plan asking for more processors than the server has before any change", async () => {
    const h = await setup();
    await deployed(h);
    const oldWorker = idOf(h, WORKER);
    h.fake.info.NCPU = 1;
    const cpus = (cpuMilli: number) =>
      rehash({ ...plan, components: plan.components.map((c) => (c.key === "worker" ? { ...c, resources: { ...c.resources, cpuMilli } } : c)) });
    await expect(h.engine.createAppStackComponents({ plan: cpus(1_001) })).rejects.toMatchObject({
      reason: "STACK_PLAN_INVALID",
      message: "The application needs more processors than this server has",
    });
    expect(h.fake.log[0]).toBe("GET /info");
    expect(mutations(h.fake.log)).toEqual([]);
    expect(idOf(h, WORKER)).toBe(oldWorker);
    await expect(h.engine.createAppStackComponents({ plan: cpus(1_000) })).resolves.toMatchObject({
      components: [{ componentKey: "web", outcome: "unchanged" }, { componentKey: "worker", outcome: "replaced" }],
    });
  });

  it.each([
    [409, "STACK_NAMESPACE_CONFLICT"],
    [404, "STACK_COMPONENT_NOT_READY"],
  ])("a create answered %s is %s", async (status, reason) => {
    const h = await setup();
    h.fake.images.set(IMAGE, { repoDigests: [IMAGE] });
    await h.engine.prepareAppStack({ plan });
    h.fake.failNext(/^POST \/containers\/create/, status);
    await expect(h.engine.createAppStackComponents({ plan })).rejects.toMatchObject({ reason });
  });
});

describe("start and restart (5.11)", () => {
  const plan = appStackTestPlan();

  it.each([
    ["a component outside the plan", { componentKey: "ghost", secretFileContents: [] }, "STACK_PLAN_INVALID", "The component is not part of the plan"],
    ["a missing secret", { componentKey: "worker", secretFileContents: [] }, "STACK_SECRET_MISSING", "A secret of component worker is missing"],
    [
      "a stale secret version",
      { componentKey: "worker", secretFileContents: [{ ...SECRETS[0]!, version: 2 }] },
      "STACK_PLAN_INVALID",
      "A secret entry is not part of the plan",
    ],
  ])("refuses %s with no request", async (_name, req, reason, message) => {
    const h = await setup();
    await expect(h.engine.startAppStackComponent({ plan, ...req })).rejects.toMatchObject({ reason, message });
    await expect(h.engine.restartAppStackComponent({ plan, ...req })).rejects.toMatchObject({ reason, message });
    expect(h.fake.log).toEqual([]);
  });

  it("refuses a dependent whose dependency is not running and writes no secret", async () => {
    const h = await setup();
    await prepared(h);
    await expect(
      h.engine.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS }),
    ).rejects.toMatchObject({ reason: "STACK_COMPONENT_NOT_READY", code: "RESOURCE_LOCKED", message: "Component web is not running" });
    expect(mutations(h.fake.log)).toEqual([]);
    expect(await exists(secretDir(h, "worker"))).toBe(false);
  });

  it("refuses a component that is not created", async () => {
    const h = await setup();
    await expect(h.engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })).rejects.toMatchObject({
      reason: "STACK_COMPONENT_NOT_READY",
      message: "Component web is not created",
    });
  });

  it("refuses a foreign container under the derived name", async () => {
    const h = await setup();
    await foreignContainer(h, WEB);
    await expect(h.engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })).rejects.toMatchObject({
      reason: "STACK_NAMESPACE_CONFLICT",
    });
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("refuses a container created from another plan", async () => {
    const h = await setup();
    await prepared(h);
    await h.engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
    await expect(
      h.engine.startAppStackComponent({ plan: withWorkerEnv("other"), componentKey: "worker", secretFileContents: SECRETS }),
    ).rejects.toMatchObject({ reason: "STACK_COMPONENT_NOT_READY", message: "Component worker was created from another plan" });
  });

  it("starts after the dependency, writes the secret files first, and a second start is a no-op", async () => {
    const h = await setup();
    await prepared(h);
    const stray = secretDir(h, "web");
    await mkdir(stray, { recursive: true });
    await writeFile(path.join(stray, "old"), "x");
    await expect(h.engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })).resolves.toEqual({
      componentKey: "web",
      outcome: "started",
    });
    expect(await exists(stray)).toBe(false);
    await expect(
      h.engine.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS }),
    ).resolves.toEqual({ componentKey: "worker", outcome: "started" });
    const file = path.join(secretDir(h, "worker"), "shared_key");
    expect(await readFile(file, "utf8")).toBe(SECRET);
    expect((await stat(file)).mode & 0o777).toBe(0o444);
    expect(h.fake.containers.get(WORKER)?.State.Running).toBe(true);
    expect(JSON.stringify(h.fake.bodies.get(`POST /containers/create?name=${WORKER}`))).not.toContain(SECRET);
    h.fake.log.length = 0;
    await expect(
      h.engine.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS }),
    ).resolves.toEqual({ componentKey: "worker", outcome: "already_running" });
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("restart rewrites the secret files before /restart and also starts a stopped component", async () => {
    const h = await setup();
    await deployed(h);
    await h.engine.stopAppStack(REF);
    await h.fake.request("POST", `/containers/${WEB}/start`);
    const held = h.fake.hold(/\/restart\?t=10$/);
    const fresh = [{ ...SECRETS[0]!, content: "rotated-secret-99" }];
    const pending = h.engine.restartAppStackComponent({ plan, componentKey: "worker", secretFileContents: fresh });
    await vi.waitFor(() => expect(h.fake.log.at(-1)).toBe(`POST /containers/${idOf(h, WORKER)}/restart?t=10`));
    expect(await readFile(path.join(secretDir(h, "worker"), "shared_key"), "utf8")).toBe("rotated-secret-99");
    held.release();
    await expect(pending).resolves.toEqual({ componentKey: "worker", outcome: "restarted" });
    expect(h.fake.containers.get(WORKER)?.State.Running).toBe(true);
  });

  it("a secret write failure names no value", async () => {
    const blocker = path.join(await mkdtemp(path.join(os.tmpdir(), "hp-app-engine-file-")), "not-a-dir");
    await writeFile(blocker, "x");
    cleanups.push(() => rm(path.dirname(blocker), { recursive: true, force: true }));
    const h = await setup({ secretsRootDir: blocker });
    await deployedWithout(h);
    const err = await h.engine
      .startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS })
      .catch((e: Error) => e);
    expect(err).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", message: "Could not prepare the secret files of component worker" });
    expect(h.fake.log.some((line) => line.endsWith("/start"))).toBe(false);
  });

  it.each([
    [404, { reason: "STACK_COMPONENT_NOT_READY" }],
    [500, { code: "DOCKER_ENGINE_UNAVAILABLE" }],
  ])("a start answered %s", async (status, expected) => {
    const h = await setup();
    await prepared(h);
    h.fake.failNext(/\/start$/, status);
    await expect(h.engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })).rejects.toMatchObject(expected);
  });
});

/** Web running, worker created; the secrets root may be unusable. */
async function deployedWithout(h: Harness) {
  const plan = appStackTestPlan();
  h.fake.images.set(IMAGE, { repoDigests: [IMAGE] });
  await h.engine.prepareAppStack({ plan });
  await h.engine.createAppStackComponents({ plan });
  await h.fake.request("POST", `/containers/${WEB}/start`);
  h.fake.log.length = 0;
}

describe("stopAppStack (5.12)", () => {
  it("stops in reverse start order, keeps secrets and routes, and a re-run is a no-op", async () => {
    const h = await setup();
    await deployed(h);
    await expect(h.engine.stopAppStack(REF)).resolves.toEqual({
      components: [
        { componentKey: "worker", outcome: "stopped" },
        { componentKey: "web", outcome: "stopped" },
      ],
    });
    expect(mutations(h.fake.log)).toEqual([
      `POST /containers/${idOf(h, WORKER)}/stop?t=10`,
      `POST /containers/${idOf(h, WEB)}/stop?t=10`,
    ]);
    expect(await exists(secretDir(h, "worker"))).toBe(true);
    expect(h.routes.remove).not.toHaveBeenCalled();
    h.fake.log.length = 0;
    const again = await h.engine.stopAppStack(REF);
    expect(again.components.map((c) => c.outcome)).toEqual(["already_stopped", "already_stopped"]);
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("skips a container that vanished and fails on an engine error", async () => {
    const h = await setup();
    await deployed(h);
    h.fake.failNext(new RegExp(`/containers/${idOf(h, WORKER)}/stop`), 404);
    await expect(h.engine.stopAppStack(REF)).resolves.toEqual({ components: [{ componentKey: "web", outcome: "stopped" }] });
    h.fake.failNext(/\/stop/, 500);
    await expect(h.engine.stopAppStack(REF)).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
  });

  it("refuses a container labelled with the stack id that is not own", async () => {
    const h = await setup();
    await deployed(h);
    await foreignContainer(h, "lookalike", { [APP_STACK_LABELS.stackId]: ID, [APP_STACK_LABELS.organizationId]: ORG, [APP_STACK_LABELS.managed]: "true" });
    await expect(h.engine.stopAppStack(REF)).rejects.toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    expect(mutations(h.fake.log)).toEqual([]);
  });
});

describe("publishAppStackRoutes and unpublishAppStackRoutes (5.13, 5.14)", () => {
  const plan = appStackTestPlan();

  it.each([
    ["a route outside the plan ingress", [{ ...ROUTES[0]!, componentKey: "worker" }], "STACK_PLAN_INVALID", "The route is not an ingress of the plan"],
    ["a manual certificate", [{ ...ROUTES[0]!, hosts: [{ ...HOST, source: "manual" as const }] }], "STACK_UNSUPPORTED_FEATURE", undefined],
    ["a redirect", [{ ...ROUTES[0]!, hosts: [{ ...HOST, redirectTo: "https://x.example.org" }] }], "STACK_UNSUPPORTED_FEATURE", undefined],
  ])("refuses %s with no request", async (_name, routes, reason, message) => {
    const h = await setup();
    await expect(h.engine.publishAppStackRoutes({ plan, routes })).rejects.toMatchObject({
      reason,
      message: message ?? "Only automatic certificates and plain host routes are supported for applications",
    });
    expect(h.fake.log).toEqual([]);
    expect(h.routes.write).not.toHaveBeenCalled();
  });

  it("refuses a target that is not running", async () => {
    const h = await setup();
    await prepared(h);
    await expect(h.engine.publishAppStackRoutes({ plan, routes: ROUTES })).rejects.toMatchObject({ reason: "STACK_COMPONENT_NOT_READY" });
    expect(h.proxy.ensure).not.toHaveBeenCalled();
    expect(h.routes.write).not.toHaveBeenCalled();
  });

  it("attaches the proxy before writing; a second publish writes nothing new", async () => {
    const h = await setup();
    await deployed(h);
    await expect(h.engine.publishAppStackRoutes({ plan, routes: ROUTES })).resolves.toEqual({
      routeCount: 1,
      hostnames: ["shop.example.org"],
      changed: true,
    });
    expect(mutations(h.fake.log)).toEqual(["PROXY ensure", `POST /networks/${EDGE}/connect`, "ROUTES write"]);
    expect(h.fake.bodies.get(`POST /networks/${EDGE}/connect`)).toEqual([{ Container: PROXY }]);
    expect(h.fake.networks.get(EDGE)?.members.has(PROXY)).toBe(true);
    h.fake.log.length = 0;
    await expect(h.engine.publishAppStackRoutes({ plan, routes: ROUTES })).resolves.toMatchObject({ changed: false });
    expect(mutations(h.fake.log)).toEqual(["PROXY ensure", `POST /networks/${EDGE}/connect`, "ROUTES write"]);
  });

  it("a failed proxy connect writes no route file", async () => {
    const h = await setup();
    await deployed(h);
    h.fake.failNext(/\/connect$/, 500);
    await expect(h.engine.publishAppStackRoutes({ plan, routes: ROUTES })).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(h.routes.write).not.toHaveBeenCalled();
  });

  it("an empty route set removes the file without touching the proxy; unpublish is idempotent", async () => {
    const h = await setup();
    await deployed(h);
    await h.engine.publishAppStackRoutes({ plan, routes: ROUTES });
    h.proxy.ensure.mockClear();
    h.fake.log.length = 0;
    await expect(h.engine.publishAppStackRoutes({ plan, routes: [] })).resolves.toEqual({ routeCount: 0, hostnames: [], changed: true });
    expect(h.proxy.ensure).not.toHaveBeenCalled();
    await h.engine.publishAppStackRoutes({ plan, routes: ROUTES });
    h.fake.log.length = 0;
    await expect(h.engine.unpublishAppStackRoutes(REF)).resolves.toEqual({ routeCount: 0, hostnames: [], changed: true });
    await expect(h.engine.unpublishAppStackRoutes(REF)).resolves.toEqual({ routeCount: 0, hostnames: [], changed: false });
    expect(mutations(h.fake.log)).toEqual(["ROUTES remove", "ROUTES remove"]);
    expect(h.fake.networks.get(EDGE)?.members.has(PROXY)).toBe(true);
  });

  it("unpublish refuses a stack id labelled by another organisation", async () => {
    const h = await setup();
    await h.fake.request("POST", "/volumes/create", { Name: VOL, Labels: appStackVolumeLabels({ stackId: ID, organizationId: "org_other" }, "data") });
    await expect(h.engine.unpublishAppStackRoutes(REF)).rejects.toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    expect(h.routes.remove).not.toHaveBeenCalled();
  });
});

describe("removeAppStack (5.15)", () => {
  const plan = appStackTestPlan();

  it("removes routes, containers, networks in order and keeps volumes unless asked", async () => {
    const h = await setup();
    await deployed(h);
    await h.engine.publishAppStackRoutes({ plan, routes: ROUTES });
    const [web, worker] = [idOf(h, WEB), idOf(h, WORKER)];
    h.fake.log.length = 0;
    await expect(h.engine.removeAppStack({ ...REF, removeVolumes: false })).resolves.toEqual({
      removedComponents: ["worker", "web"],
      removedNetworks: ["app_edge", "app_internal"],
      removedVolumes: [],
      retainedVolumes: ["data"],
    });
    expect(mutations(h.fake.log)).toEqual([
      "ROUTES remove",
      `POST /containers/${worker}/stop?t=10`,
      `DELETE /containers/${worker}?force=true&v=true`,
      `POST /containers/${web}/stop?t=10`,
      `DELETE /containers/${web}?force=true&v=true`,
      `POST /networks/${EDGE}/disconnect`,
      `DELETE /networks/${EDGE}`,
      `DELETE /networks/${NET}`,
    ]);
    expect(h.fake.bodies.get(`POST /networks/${EDGE}/disconnect`)).toEqual([{ Container: PROXY, Force: true }]);
    expect(h.fake.volumes.has(VOL)).toBe(true);
    expect(await readdir(h.root)).toEqual([]);
    h.fake.log.length = 0;
    await expect(h.engine.removeAppStack({ ...REF, removeVolumes: false })).resolves.toEqual({
      removedComponents: [],
      removedNetworks: [],
      removedVolumes: [],
      retainedVolumes: ["data"],
    });
    await expect(h.engine.removeAppStack({ ...REF, removeVolumes: true })).resolves.toMatchObject({ removedVolumes: ["data"] });
    expect(h.fake.volumes.has(VOL)).toBe(false);
    h.fake.log.length = 0;
    await expect(h.engine.removeAppStack({ ...REF, removeVolumes: true })).resolves.toEqual({
      removedComponents: [],
      removedNetworks: [],
      removedVolumes: [],
      retainedVolumes: [],
    });
    expect(mutations(h.fake.log)).toEqual(["ROUTES remove"]);
  });

  it("a volume still mounted is STACK_VOLUME_IN_USE", async () => {
    const h = await setup();
    await deployed(h);
    await foreignContainer(h, "borrower", {}, { HostConfig: { Mounts: [{ Type: "volume", Source: VOL, Target: "/x" }] } });
    await expect(h.engine.removeAppStack({ ...REF, removeVolumes: true })).rejects.toMatchObject({
      reason: "STACK_VOLUME_IN_USE",
      code: "RESOURCE_LOCKED",
      message: "A stack volume is still in use",
    });
  });

  it("a network used by a foreign container stops the removal", async () => {
    const h = await setup();
    await deployed(h);
    await foreignContainer(h, "squatter", {}, { HostConfig: { NetworkMode: NET } });
    await expect(h.engine.removeAppStack({ ...REF, removeVolumes: true })).rejects.toMatchObject({
      reason: "STACK_NAMESPACE_CONFLICT",
      message: "A stack network is still used by another container",
    });
    expect(h.fake.log.some((line) => line.startsWith("DELETE /volumes"))).toBe(false);
  });

  it("refuses everything when a labelled object is not own", async () => {
    const h = await setup();
    await deployed(h);
    await h.fake.request("POST", "/networks/create", { Name: "elsewhere", Labels: { [APP_STACK_LABELS.stackId]: ID } });
    h.fake.log.length = 0;
    await expect(h.engine.removeAppStack({ ...REF, removeVolumes: true })).rejects.toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    expect(mutations(h.fake.log)).toEqual([]);
    expect(h.routes.remove).not.toHaveBeenCalled();
  });
});

describe("removeAppStackComponents (5.15b)", () => {
  const plan = appStackTestPlan();

  it("removes only the named own containers and their secret dirs", async () => {
    const h = await setup();
    await deployed(h);
    await h.engine.publishAppStackRoutes({ plan, routes: ROUTES });
    h.fake.log.length = 0;
    await expect(h.engine.removeAppStackComponents({ plan, componentKeys: ["worker", "ghost"] })).resolves.toEqual({
      removedComponents: ["worker"],
    });
    expect(h.fake.containers.has(WORKER)).toBe(false);
    expect(h.fake.containers.has(WEB)).toBe(true);
    expect(await exists(secretDir(h, "worker"))).toBe(false);
    expect(h.fake.volumes.has(VOL)).toBe(true);
    expect([...h.fake.networks.keys()]).toEqual(expect.arrayContaining([NET, EDGE]));
    expect(h.stored.has(ID)).toBe(true);
    expect(mutations(h.fake.log).every((line) => line.includes("/containers/"))).toBe(true);
    h.fake.log.length = 0;
    await expect(h.engine.removeAppStackComponents({ plan, componentKeys: ["worker"] })).resolves.toEqual({ removedComponents: [] });
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("a 409 delete waits for the concurrent removal", async () => {
    const h = await setup();
    await deployed(h);
    const id = idOf(h, WORKER);
    h.fake.failNext(new RegExp(`^DELETE /containers/${id}`), 409);
    h.fake.failNext(new RegExp(`^GET /containers/${id}/json`), 404);
    await expect(h.engine.removeAppStackComponents({ plan, componentKeys: ["worker"] })).resolves.toEqual({ removedComponents: ["worker"] });
  });
});

describe("getAppStackStatus (5.16)", () => {
  it("observes with GETs only and probes running components on the private network", async () => {
    const h = await setup();
    await deployed(h);
    const result = await h.engine.getAppStackStatus(REF);
    expect(AppStackStatusIpcResultSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      stackId: ID,
      observedAt: "2026-11-22T03:00:00.000Z",
      networks: { internal: true, edge: true },
      volumes: ["data"],
      routes: { published: false, hostnames: [] },
    });
    expect(result.components.map((c) => [c.componentKey, c.state, c.health, c.probe])).toEqual([
      ["web", "running", "healthy", "passed"],
      ["worker", "running", "healthy", "none"],
    ]);
    expect(result.components[0]).toMatchObject({ revisionId: "astr_0123456789abcdef", restartCount: 0, exitCode: null, oomKilled: false });
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.probe).toHaveBeenCalledWith({
      address: h.fake.containers.get(WEB)?.networks.get(NET),
      componentKey: "web",
      health: { kind: "http", port: 8080, timeoutSeconds: 3, path: "/healthz" },
    });
    expect(h.fake.log.every((line) => line.startsWith("GET "))).toBe(true);
  });

  it("maps states, a failed probe and malformed labels", async () => {
    const h = await setup({ probe: async () => "failed" });
    await deployed(h);
    await h.engine.publishAppStackRoutes({ plan: appStackTestPlan(), routes: ROUTES });
    const web = h.fake.containers.get(WEB)!;
    const worker = h.fake.containers.get(WORKER)!;
    let result = await h.engine.getAppStackStatus(REF);
    expect(result.components[0]).toMatchObject({ health: "unhealthy", probe: "failed" });
    expect(result.routes).toEqual({ published: true, hostnames: ["shop.example.org"] });
    web.Labels[APP_STACK_LABELS.health] = "http:8080:99:/x";
    web.Labels[APP_STACK_LABELS.componentHash] = "bogus";
    worker.State = { ...worker.State, Status: "exited", Running: false, ExitCode: 137, OOMKilled: true };
    result = await h.engine.getAppStackStatus(REF);
    expect(result.components[0]).toMatchObject({ state: "running", health: "unhealthy", probe: "failed", componentHash: null });
    expect(result.components[1]).toMatchObject({ state: "exited", health: "stopped", probe: "not_run", exitCode: 137, oomKilled: true });
    web.State = { ...web.State, Restarting: true, Status: "restarting" };
    worker.State = { ...worker.State, Status: "dead" };
    result = await h.engine.getAppStackStatus(REF);
    expect(result.components.map((c) => [c.state, c.health, c.probe])).toEqual([
      ["restarting", "unhealthy", "not_run"],
      ["dead", "stopped", "not_run"],
    ]);
  });

  it("a created component is stopped and never started", async () => {
    const h = await setup();
    await prepared(h);
    const result = await h.engine.getAppStackStatus(REF);
    expect(result.components[0]).toMatchObject({ state: "created", health: "stopped", probe: "not_run", startedAt: null });
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.fake.log.every((line) => line.startsWith("GET "))).toBe(true);
  });

  it("refuses when a labelled object is not own", async () => {
    const h = await setup();
    await foreignContainer(h, "lookalike", { [APP_STACK_LABELS.stackId]: ID });
    await expect(h.engine.getAppStackStatus(REF)).rejects.toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
  });
});

describe("getAppStackComponentLogs (5.17)", () => {
  const AT = "2026-11-22T03:00:00.000000000Z";
  const logs = (h: Harness) => h.fake.containers.get(WORKER)?.logs ?? [];
  const read = (h: Harness, tail = 50) => h.engine.getAppStackComponentLogs({ ...REF, componentKey: "worker", tail });

  it("returns the masked tail of an own component", async () => {
    const h = await setup();
    await deployed(h);
    logs(h).push({ stream: "stdout", payload: "dropped\n" }, { stream: "stdout", payload: `${AT} key=${SECRET} ok\r\n` }, { stream: "stderr", payload: "plain\n" });
    await expect(read(h, 2)).resolves.toEqual([
      { at: AT, stream: "stdout", text: "key=[REDACTED] ok" },
      { at: null, stream: "stderr", text: "plain" },
    ]);
    expect(h.fake.log).toEqual([`GET /containers/${enc(WORKER)}/json`, `GET /containers/${idOf(h, WORKER)}/logs?stdout=1&stderr=1&timestamps=1&tail=2`]);
    expect(h.readLogs).not.toHaveBeenCalled();
  });

  it("masks a value that crosses the 2 000-character cut of its line", async () => {
    const h = await setup();
    await deployed(h);
    logs(h).push({ stream: "stdout", payload: `${AT} ${"x".repeat(1_990)}${SECRET}@cache\n` });
    expect((await read(h))[0]?.text).toBe(`${"x".repeat(1_990)}[REDACTED]`);
  });

  it("masks the parts of a value split by Docker's frames and by the 2 MiB read limit", async () => {
    const h = await setup();
    await deployed(h);
    logs(h).push({ stream: "stdout", payload: `${AT} key=${SECRET.slice(0, 7)}` }, { stream: "stdout", payload: `${AT} ${SECRET.slice(7)} done\n` });
    expect((await read(h)).map((line) => line.text)).toEqual(["key=[REDACTED]", "[REDACTED] done"]);
    // The read keeps the first 2 MiB: the second frame's payload starts at byte 8 + filler + 8 and is cut 8 characters into the value.
    const filler = 2 * 1024 * 1024 - 8 - 8 - "key=".length - 8;
    logs(h).splice(0, 2, { stream: "stdout", payload: "x".repeat(filler - 1) + "\n" }, { stream: "stderr", payload: `key=${SECRET}\n` });
    expect((await read(h)).at(-1)).toEqual({ at: null, stream: "stderr", text: "key=[REDACTED]" });
  });

  it.each([
    [404, { code: "NOT_FOUND", message: "Component not found" }],
    [500, { code: "DOCKER_ENGINE_UNAVAILABLE", message: "Failed to read service logs (HTTP 500)" }],
  ])("a log read answered %s is refused", async (status, error) => {
    const h = await setup();
    await deployed(h);
    h.fake.failNext(/\/logs\?/, status);
    await expect(read(h)).rejects.toMatchObject(error);
  });

  it("an absent component is NOT_FOUND and a foreign one a conflict", async () => {
    const h = await setup();
    await expect(h.engine.getAppStackComponentLogs({ ...REF, componentKey: "web", tail: 5 })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Component not found",
    });
    await foreignContainer(h, WEB);
    await expect(h.engine.getAppStackComponentLogs({ ...REF, componentKey: "web", tail: 5 })).rejects.toMatchObject({
      reason: "STACK_NAMESPACE_CONFLICT",
    });
    expect(h.readLogs).not.toHaveBeenCalled();
  });
});

describe("busy lock", () => {
  it("refuses a second change of the same stack while one runs; reads and other stacks pass", async () => {
    const h = await setup();
    await deployed(h);
    const plan = appStackTestPlan();
    const held = h.fake.hold(/^GET \/networks\/hp_appnet_/);
    const first = h.engine.prepareAppStack({ plan });
    for (const call of [
      () => h.engine.prepareAppStack({ plan }),
      () => h.engine.stopAppStack(REF),
      () => h.engine.removeAppStack({ ...REF, removeVolumes: false }),
      () => h.engine.unpublishAppStackRoutes(REF),
    ]) {
      await expect(call()).rejects.toMatchObject({
        reason: "STACK_BUSY",
        code: "RESOURCE_LOCKED",
        message: "Another change of this application stack is running",
      });
    }
    await expect(h.engine.getAppStackStatus(REF)).resolves.toMatchObject({ stackId: ID });
    await expect(h.engine.stopAppStack({ stackId: "stk_other", organizationId: ORG })).resolves.toEqual({ components: [] });
    held.release();
    await first;
    await expect(h.engine.prepareAppStack({ plan })).resolves.toBeDefined();
  });

  it("is released after a failure", async () => {
    const h = await setup();
    h.fake.failNext(/^GET \/networks/, 500);
    await expect(h.engine.prepareAppStack({ plan: appStackTestPlan() })).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    await expect(h.engine.prepareAppStack({ plan: appStackTestPlan() })).resolves.toBeDefined();
  });
});

describe("idempotency (5.18)", () => {
  it("a second identical call issues only the mutating requests of the table", async () => {
    const h = await setup();
    const plan = appStackTestPlan();
    h.fake.pullable.add(IMAGE);
    const twice = async (call: () => Promise<unknown>) => {
      await call();
      h.fake.log.length = 0;
      await call();
      return mutations(h.fake.log).filter((line) => !line.startsWith("ROUTES") && !line.startsWith("PROXY"));
    };
    expect(await twice(() => h.engine.pullAppStackImage({ plan, image: IMAGE }))).toEqual([]);
    expect(await twice(() => h.engine.prepareAppStack({ plan }))).toEqual([]);
    expect(await twice(() => h.engine.createAppStackComponents({ plan }))).toEqual([]);
    expect(await twice(() => h.engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }))).toEqual([]);
    expect(await twice(() => h.engine.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS }))).toEqual([]);
    expect(await twice(() => h.engine.restartAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }))).toEqual([
      `POST /containers/${idOf(h, WEB)}/restart?t=10`,
    ]);
    expect(await twice(() => h.engine.publishAppStackRoutes({ plan, routes: ROUTES }))).toEqual([`POST /networks/${EDGE}/connect`]);
    expect(h.routes.write).toHaveLastResolvedWith({ changed: false, hostnames: ["shop.example.org"] });
    expect(await twice(() => h.engine.unpublishAppStackRoutes(REF))).toEqual([]);
    expect(await twice(() => h.engine.stopAppStack(REF))).toEqual([]);
    expect(await twice(() => h.engine.removeAppStackComponents({ plan, componentKeys: ["worker"] }))).toEqual([]);
    expect(await twice(() => h.engine.removeAppStack({ ...REF, removeVolumes: true }))).toEqual([]);
  });
});
