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
  writeAppStackComponentSecrets,
  type AppStackHealthProbe,
} from "../src/app-stacks/index.js";
import { LOG_READ_MAX_BYTES } from "../src/docker-logs.js";
import type { AppStackRouteEntry } from "../src/traefik-config.js";
import { createAppStackFakeEngine, type FakeHostConfig } from "./support/app-stack-fake-engine.js";
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
/** The list of the application's backup job containers that start, restart, create and remove read first (ADR-0038 K4). */
const JOB_LIST = `GET /containers/json?all=true&filters=${enc(JSON.stringify({ label: [`io.hostingpanel.app_backup_of=${ID}`] }))}`;

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
    expect(h.fake.log.slice(0, 2)).toEqual([JOB_LIST, "GET /info"]);
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
    [
      "a path rule outside the plan ingress",
      [{ ...ROUTES[0]!, hosts: [{ ...HOST, paths: [{ pathPrefix: "/api", componentKey: "worker", internalPort: 9000, stripPrefix: false }] }] }],
      "STACK_PLAN_INVALID",
      "A path of the route is not an ingress of the plan",
    ],
  ])("refuses %s with no request", async (_name, routes, reason, message) => {
    const h = await setup();
    await expect(h.engine.publishAppStackRoutes({ plan, routes })).rejects.toMatchObject({
      reason,
      message: message ?? "Only automatic certificates are supported for applications",
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

  it("a path rule waits for its own target, and the options reach the route file as sent (ADR-0037)", async () => {
    const h = await setup();
    const [web, worker] = plan.components;
    const two = appStackTestPlan({
      components: [web!, { ...worker!, expose: [9000], healthcheck: { ...web!.healthcheck!, port: 9000 } }],
      ingress: [{ componentKey: "web", port: 8080 }, { componentKey: "worker", port: 9000 }],
    });
    const routes: AppStackRouteWire[] = [
      {
        componentKey: "web",
        internalPort: 8080,
        hosts: [
          {
            ...HOST,
            compress: true,
            protection: { username: "team", passwordHash: "$apr1$r31.....$HqJZimcKQFAMYayBlzkrA/" },
            paths: [{ pathPrefix: "/jobs", componentKey: "worker", internalPort: 9000, stripPrefix: true }],
          },
          { hostname: "www.example.org", tls: true, httpsRedirect: true, redirectTo: "https://shop.example.org" },
        ],
      },
    ];
    await prepared(h, two);
    await h.engine.startAppStackComponent({ plan: two, componentKey: "web", secretFileContents: [] });
    h.fake.log.length = 0;
    await expect(h.engine.publishAppStackRoutes({ plan: two, routes })).rejects.toMatchObject({
      reason: "STACK_COMPONENT_NOT_READY",
      message: "Component worker is not ready to receive traffic",
    });
    expect(h.proxy.ensure).not.toHaveBeenCalled();
    expect(h.routes.write).not.toHaveBeenCalled();
    await h.engine.startAppStackComponent({ plan: two, componentKey: "worker", secretFileContents: SECRETS });
    await expect(h.engine.publishAppStackRoutes({ plan: two, routes })).resolves.toMatchObject({ routeCount: 1, changed: true });
    expect(h.routes.write).toHaveBeenCalledWith(ID, routes);
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

  it("joins a line Docker split into frames and drops the line the 2 MiB read limit cut", async () => {
    const h = await setup();
    await deployed(h);
    logs(h).push({ stream: "stdout", payload: `${AT} key=${SECRET.slice(0, 7)}` }, { stream: "stdout", payload: `${AT} ${SECRET.slice(7)} done\n` });
    expect(await read(h)).toEqual([{ at: AT, stream: "stdout", text: "key=[REDACTED] done" }]);
    // The read keeps the first 2 MiB: the second frame's payload starts at byte 8 + filler + 8 and is cut 8 characters into the value.
    const filler = 2 * 1024 * 1024 - 8 - 8 - "key=".length - 8;
    logs(h).splice(0, 2, { stream: "stdout", payload: "x".repeat(filler - 1) + "\n" }, { stream: "stderr", payload: `key=${SECRET}\n` });
    expect(await read(h)).toEqual([{ at: null, stream: "stdout", text: "x".repeat(2_000) }]);
  });

  describe("a value Docker split into 16 KiB frames", () => {
    const ASCII = "Kx9vQ2mT7pLw4rZs8nBd3hFj6yGc1aVe5uXo0iNk";
    const WIDE = "秘密钥匙安全口令保护数据";
    const frame = (stream: 1 | 2, payload: Buffer | string) => {
      const header = Buffer.alloc(8);
      header[0] = stream;
      header.writeUInt32BE(Buffer.byteLength(payload), 4);
      return Buffer.concat([header, Buffer.from(payload)]);
    };
    /** A frame of 16 KiB of message ending with the value's first `split` bytes, then its continuation frame. */
    const splitLine = (value: string, split: number, lead = 16_384 - split) => {
      const bytes = Buffer.from(value);
      return [
        frame(1, Buffer.concat([Buffer.from(`${AT} `), Buffer.alloc(lead, "m"), bytes.subarray(0, split)])),
        frame(1, Buffer.concat([Buffer.from(`${AT} `), bytes.subarray(split), Buffer.from(" end\n")])),
      ] as const;
    };
    /** Filler before `frames` so the read limit cuts them `cut` bytes in. */
    const cutAt = (frames: readonly Buffer[], cut: number) =>
      Buffer.concat([frame(1, `${".".repeat(LOG_READ_MAX_BYTES - cut - 9)}\n`), ...frames]);
    const serve = (h: Harness, body: Buffer) =>
      h.request.mockImplementation(async (method, endpointPath, payload, options) =>
        endpointPath.includes("/logs?")
          ? { statusCode: 200, body: body.subarray(0, options?.maxBodyBytes) }
          : h.fake.request(method, endpointPath, payload, options),
      );
    /** Every six consecutive characters of the value that a line shows. */
    const leaks = (lines: readonly ServiceLogLine[], value: string) =>
      Array.from({ length: value.length - 5 }, (_, i) => value.slice(i, i + 6)).filter((piece) => lines.some((line) => line.text.includes(piece)));

    async function stack() {
      const h = await setup();
      await deployed(h);
      // The folder is written whole: the file the worker's container was given stays, or the read is refused (BUG-43).
      await writeAppStackComponentSecrets(h.root, ID, "worker", { shared_key: SECRET, ascii: ASCII, wide: WIDE });
      return h;
    }

    it("drops the continuation the read limit cut instead of returning a middle piece of the value", async () => {
      const h = await stack();
      const frames = splitLine(ASCII, 15);
      serve(h, cutAt(frames, frames[0].length + 8 + `${AT} `.length + 18));
      const lines = await read(h);
      expect(leaks(lines, ASCII)).toEqual([]);
      expect(lines).toEqual([{ at: null, stream: "stdout", text: ".".repeat(2_000) }]);
    });

    it("masks a value of three-byte characters split inside a character", async () => {
      const h = await stack();
      serve(h, Buffer.concat(splitLine(WIDE, 3 * 5 + 1, 4)));
      expect(await read(h)).toEqual([{ at: AT, stream: "stdout", text: "mmmm[REDACTED] end" }]);
    });

    it("never returns six consecutive characters of the value over 300 seeded layouts", { timeout: 60_000 }, async () => {
      const h = await stack();
      let seed = 20_261_122;
      const random = (n: number) => {
        seed = (seed * 48_271) % 2_147_483_647;
        return Math.floor((seed / 2_147_483_647) * n);
      };
      for (let run = 0; run < 300; run++) {
        const value = run % 2 === 0 ? ASCII : WIDE;
        const size = Buffer.byteLength(value);
        const frames = splitLine(value, 1 + random(size - 1));
        const length = frames[0].length + frames[1].length;
        const cut = 16_384 - 64 + random(length - 16_384 + 64 + 32);
        const body = cut > length ? Buffer.concat([frame(2, "plain\n"), ...frames]) : cutAt(frames, cut);
        serve(h, body);
        expect(leaks(await read(h), value), `run ${String(run)}, cut ${String(cut)}`).toEqual([]);
      }
    });
  });

  describe("a value it could not mask (BUG-43)", () => {
    const unmaskable = (key: string) => ({ code: "DOCKER_ENGINE_UNAVAILABLE", message: `The logs of component ${key} cannot be masked` });
    const readOf = (h: Harness, componentKey: string) => h.engine.getAppStackComponentLogs({ ...REF, componentKey, tail: 50 });
    const readLogs = (h: Harness) => h.fake.log.some((line) => line.includes("/logs?"));
    const TOKEN = "t0ken-value-77";
    /** worker is given two secret files. */
    const twoFiles = () => {
      const plan = appStackTestPlan();
      return rehash({
        ...plan,
        components: plan.components.map((c) =>
          c.key === "worker" ? { ...c, secretFiles: [{ envName: "API_TOKEN_FILE", parameterKey: "api_token", version: 1 }, ...c.secretFiles] } : c,
        ),
      });
    };
    async function twoFilesDeployed(h: Harness) {
      const plan = twoFiles();
      await prepared(h, plan);
      await h.engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
      await h.engine.startAppStackComponent({
        plan,
        componentKey: "worker",
        secretFileContents: [...SECRETS, { parameterKey: "api_token", version: 1, content: TOKEN }],
      });
      logs(h).push({ stream: "stdout", payload: `${AT} key=${SECRET} token=${TOKEN}\n` });
      h.fake.log.length = 0;
    }
    /** What Docker does after a host reboot emptied the tmpfs: it makes each missing bind source a directory. */
    async function recreatedByDocker(h: Harness) {
      for (const entry of await readdir(h.root)) await rm(path.join(h.root, entry), { recursive: true, force: true });
      for (const container of h.fake.containers.values()) {
        for (const bind of container.HostConfig?.Binds ?? []) await mkdir(bind.split(":")[0] ?? "", { recursive: true });
      }
    }

    it("masks every file of a container given two secret files, when the folder holds both", async () => {
      const h = await setup();
      await twoFilesDeployed(h);
      expect((await readOf(h, "worker")).map((line) => line.text)).toEqual(["key=[REDACTED] token=[REDACTED]"]);
    });

    it("refuses, before any log read, when one file the container was given is missing", async () => {
      const h = await setup();
      await twoFilesDeployed(h);
      await rm(path.join(secretDir(h, "worker"), "api_token"));
      await expect(readOf(h, "worker")).rejects.toMatchObject(unmaskable("worker"));
      expect(readLogs(h)).toBe(false);
    });

    it("refuses when the folder is gone, and when Docker recreated each bind source as a directory", async () => {
      const h = await setup();
      await twoFilesDeployed(h);
      await rm(secretDir(h, "worker"), { recursive: true, force: true });
      await expect(readOf(h, "worker")).rejects.toMatchObject(unmaskable("worker"));
      await recreatedByDocker(h);
      expect((await readdir(secretDir(h, "worker"))).sort()).toEqual(["api_token", "shared_key"]);
      await expect(readOf(h, "worker")).rejects.toMatchObject(unmaskable("worker"));
      expect(readLogs(h)).toBe(false);
    });

    it("reads a container given no secret file, with its folder and without", async () => {
      const h = await setup();
      await deployed(h);
      const web = h.fake.containers.get(WEB)!;
      web.logs.push({ stream: "stdout", payload: `${AT} GET / 200\n` });
      expect(web.HostConfig).toEqual({ Binds: [] });
      await expect(exists(secretDir(h, "web"))).resolves.toBe(false);
      await expect(readOf(h, "web")).resolves.toEqual([{ at: AT, stream: "stdout", text: "GET / 200" }]);
      await mkdir(secretDir(h, "web"));
      await expect(readOf(h, "web")).resolves.toEqual([{ at: AT, stream: "stdout", text: "GET / 200" }]);
      // Docker's answer for a container created without binds: no list, or null.
      for (const host of [{ Binds: null }, {}]) {
        web.HostConfig = host as FakeHostConfig;
        await expect(readOf(h, "web")).resolves.toEqual([{ at: AT, stream: "stdout", text: "GET / 200" }]);
      }
    });

    it("never counts or reads a bind whose source is outside the component's folder", async () => {
      const h = await setup();
      await deployed(h);
      const elsewhere = path.join(h.root, "elsewhere");
      await mkdir(elsewhere);
      await writeFile(path.join(elsewhere, "token"), TOKEN);
      const web = h.fake.containers.get(WEB)!;
      web.HostConfig = {
        Binds: [
          `${path.join(elsewhere, "token")}:/run/secrets/token:ro`,
          `${path.join(secretDir(h, "web"), "..", `app_${ID}__worker`, "shared_key")}:/run/secrets/shared_key:ro`,
          `${path.join(elsewhere, "missing")}:/run/secrets/missing:ro`,
        ],
      };
      web.logs.push({ stream: "stdout", payload: `${AT} token=${TOKEN}\n` });
      await expect(readOf(h, "web")).resolves.toEqual([{ at: AT, stream: "stdout", text: `token=${TOKEN}` }]);
    });

    it("refuses a bind into the folder that is not one file of it, and an inspect whose binds cannot be read", async () => {
      const h = await setup();
      await deployed(h);
      logs(h).push({ stream: "stdout", payload: `${AT} key=${SECRET}\n` });
      const worker = h.fake.containers.get(WORKER)!;
      const own = worker.HostConfig?.Binds ?? [];
      expect(own).toEqual([`${path.join(secretDir(h, "worker"), "shared_key")}:/run/secrets/shared_key:ro`]);
      for (const host of [
        { Binds: [...own, `${secretDir(h, "worker")}:/run/secrets:ro`] },
        { Binds: [...own, `${path.join(secretDir(h, "worker"), "sub", "x")}:/run/secrets/x:ro`] },
        { Binds: [...own, "no-target"] },
        { Binds: [...own, 42] },
        { Binds: own.join(",") },
        null,
      ]) {
        worker.HostConfig = host as FakeHostConfig;
        await expect(readOf(h, "worker")).rejects.toMatchObject(unmaskable("worker"));
      }
      expect(readLogs(h)).toBe(false);
      worker.HostConfig = { Binds: own };
      expect((await readOf(h, "worker")).map((line) => line.text)).toEqual(["key=[REDACTED]"]);
    });

    it("refuses a container built with a secret file the plan it was first installed from did not have", async () => {
      // The reviewer's case: an upgrade gives web its first secret file, then a reboot; the API's stored "applied" plan
      // may still be the older one, and the executor asks it nothing.
      const h = await setup();
      await deployed(h);
      const plan = appStackTestPlan();
      const upgraded = rehash({
        ...plan,
        components: plan.components.map((c) =>
          c.key === "web" ? { ...c, secretFiles: [{ envName: "WEB_TOKEN_FILE", parameterKey: "web_token", version: 1 }] } : c,
        ),
      });
      await h.engine.createAppStackComponents({ plan: upgraded });
      await h.engine.startAppStackComponent({ plan: upgraded, componentKey: "web", secretFileContents: [{ parameterKey: "web_token", version: 1, content: TOKEN }] });
      h.fake.containers.get(WEB)?.logs.push({ stream: "stdout", payload: `${AT} token=${TOKEN}\n` });
      expect((await readOf(h, "web")).map((line) => line.text)).toEqual(["token=[REDACTED]"]);
      await rm(secretDir(h, "web"), { recursive: true, force: true });
      const gone = await readOf(h, "web").then(() => null, (err: unknown) => err);
      expect(gone).toMatchObject(unmaskable("web"));
      await recreatedByDocker(h);
      const recreated = await readOf(h, "web").then(() => null, (err: unknown) => err);
      expect(recreated).toMatchObject(unmaskable("web"));
      expect(JSON.stringify([String(gone), String(recreated)])).not.toContain(TOKEN);
    });

    it("refuses a stored value shorter than six characters, which it would show as it is", async () => {
      const h = await setup();
      await deployed(h);
      await writeAppStackComponentSecrets(h.root, ID, "worker", { shared_key: "abcde" });
      logs(h).push({ stream: "stdout", payload: `${AT} key=abcde\n` });
      await expect(readOf(h, "worker")).rejects.toMatchObject(unmaskable("worker"));
      expect(readLogs(h)).toBe(false);
    });

    it("masks the value as a URL or a form writes it", async () => {
      const h = await setup();
      await deployed(h);
      const value = "Pa ss&wd+42/x";
      await writeAppStackComponentSecrets(h.root, ID, "worker", { shared_key: value });
      logs(h).push(
        { stream: "stdout", payload: `${AT} GET /login?p=${encodeURIComponent(value)}&next=/\n` },
        { stream: "stdout", payload: `${AT} body p=${encodeURIComponent(value).replace(/%20/g, "+")}&ok=1\n` },
        { stream: "stdout", payload: `${AT} plain ${value} end\n` },
      );
      expect((await readOf(h, "worker")).map((line) => line.text)).toEqual([
        "GET /login?p=[REDACTED]&next=/",
        "body p=[REDACTED]&ok=1",
        "plain [REDACTED] end",
      ]);
    });
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

describe("the backup lane of the application (ADR-0038 K4)", () => {
  /** The runner's side of the lane: a copy, restore or removal job of the application holds it while `job` is true. */
  function backupLanes() {
    const held = new Set<string>();
    const state = { job: false, asked: [] as string[] };
    const holdAppStackLane = (stackId: string): (() => void) | null => {
      state.asked.push(stackId);
      if (state.job || held.has(stackId)) return null;
      held.add(stackId);
      return () => void held.delete(stackId);
    };
    return { held, state, holdAppStackLane };
  }
  const withLanes = (h: Harness, lanes: ReturnType<typeof backupLanes>) =>
    new AppStackEngine({ ...h, request: h.fake.request, secretsRootDir: h.root, pullMissingImages: true, allowlist: TEST_ALLOWLIST, backupLanes: lanes });
  const plan = appStackTestPlan();
  const web = { plan, componentKey: "web", secretFileContents: [] };

  it("refuses start, restart, create and remove with no Engine request while a job holds it; the other calls do not ask", async () => {
    const h = await setup();
    await prepared(h);
    const lanes = backupLanes();
    const engine = withLanes(h, lanes);
    lanes.state.job = true;
    for (const call of [
      () => engine.startAppStackComponent(web),
      () => engine.restartAppStackComponent(web),
      () => engine.createAppStackComponents({ plan }),
      () => engine.removeAppStack({ ...REF, removeVolumes: false }),
      () => engine.removeAppStackComponents({ plan, componentKeys: ["worker"] }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        reason: "STACK_BUSY",
        code: "RESOURCE_LOCKED",
        message: "A backup or a restore of this application is running",
      });
    }
    expect(h.fake.log).toEqual([]);
    expect(lanes.state.asked).toEqual([ID, ID, ID, ID, ID]);
    expect(h.fake.containers.has(WORKER)).toBe(true);
    // Stopping, reading and preparing never make the application write to its volumes.
    await engine.stopAppStack(REF);
    await engine.unpublishAppStackRoutes(REF);
    await engine.pullAppStackImage({ plan, image: IMAGE });
    await engine.prepareAppStack({ plan });
    await engine.getAppStackStatus(REF);
    expect(lanes.state.asked).toHaveLength(5);
  });

  it("is held for the whole change and given back after it, also after a refusal or a failure", async () => {
    const h = await setup();
    await prepared(h);
    const lanes = backupLanes();
    const engine = withLanes(h, lanes);
    const held = h.fake.hold(/^POST \/containers\/[^/]+\/start$/);
    const starting = engine.startAppStackComponent(web);
    await vi.waitFor(() => expect(h.fake.log.some((line) => line.endsWith("/start"))).toBe(true));
    expect([...lanes.held]).toEqual([ID]);
    held.release();
    await expect(starting).resolves.toMatchObject({ outcome: "started" });
    expect(lanes.held.size).toBe(0);
    await expect(engine.startAppStackComponent({ ...web, componentKey: "other" })).rejects.toMatchObject({ reason: "STACK_PLAN_INVALID" });
    expect(lanes.held.size).toBe(0);
    h.fake.failNext(/^POST \/containers\/[^/]+\/restart/, 500);
    await expect(engine.restartAppStackComponent(web)).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(lanes.held.size).toBe(0);
    await expect(engine.removeAppStack({ ...REF, removeVolumes: true })).resolves.toBeDefined();
    expect(lanes.held.size).toBe(0);
  });

  /** A job container of the application's backups that outlived its job (its kill or its removal failed). */
  const JOB = `hp_bk_op_${"7".repeat(32)}-apply_rs_data`;

  it("refuses start, restart, create and remove while a job container of its backups runs, whether a job holds the lane or not", async () => {
    const h = await setup();
    await prepared(h);
    await foreignContainer(h, JOB, { "io.hostingpanel.role": "site_job", "io.hostingpanel.app_backup_of": ID });
    await h.fake.request("POST", `/containers/${JOB}/start`);
    h.fake.log.length = 0;
    const lanes = backupLanes();
    for (const engine of [h.engine, withLanes(h, lanes)]) {
      for (const call of [
        () => engine.startAppStackComponent(web),
        () => engine.restartAppStackComponent(web),
        () => engine.createAppStackComponents({ plan }),
        () => engine.removeAppStack({ ...REF, removeVolumes: false }),
        () => engine.removeAppStackComponents({ plan, componentKeys: ["worker"] }),
      ]) {
        await expect(call()).rejects.toMatchObject({ reason: "STACK_BUSY", code: "RESOURCE_LOCKED" });
      }
      // One list of the job containers per call, all states, and nothing else reaches Docker.
      expect(h.fake.log).toEqual([JOB_LIST, JOB_LIST, JOB_LIST, JOB_LIST, JOB_LIST]);
      h.fake.log.length = 0;
    }
    expect(lanes.held.size).toBe(0);

    // A stopped job container writes nothing.
    await h.fake.request("POST", `/containers/${JOB}/stop`);
    h.fake.log.length = 0;
    await expect(h.engine.startAppStackComponent(web)).resolves.toMatchObject({ outcome: "started" });
    expect(h.fake.log[0]).toBe(JOB_LIST);
    expect(h.fake.containers.get(WEB)?.State.Running).toBe(true);
  });

  it("refuses with no change when Docker cannot list the job containers of its backups", async () => {
    const h = await setup();
    await prepared(h);
    h.fake.failNext(/app_backup_of/, 500);
    await expect(h.engine.startAppStackComponent(web)).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(h.fake.log).toEqual([JOB_LIST]);
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
