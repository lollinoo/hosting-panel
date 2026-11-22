import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type ApprovedStackPlan } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppStackEngine, appStackNetworkLabels, type AppStackHealthProbe } from "../src/app-stacks/index.js";
import type { AppStackRouteEntry } from "../src/traefik-config.js";
import { createAppStackFakeEngine, type AppStackFakeEngine } from "./support/app-stack-fake-engine.js";
import { TEST_ALLOWLIST, appStackTestPlan, rehash } from "./support/app-stack-plans.js";

const ID = "stk_0123456789abcdef";
const OTHER_ID = "stk_fedcba9876543210";
const ORG = "org_acme";
const IMAGE = `registry.test/acme/web@sha256:${"c".repeat(64)}`;
const PROXY = "hp_ingress_proxy_test";
const SECRETS = [{ parameterKey: "shared_key", version: 1, content: "s3cret-value-42" }];
const REF = { stackId: ID, organizationId: ORG };
const ROUTES = [
  { componentKey: "web", internalPort: 8080, hosts: [{ hostname: "shop.example.org", tls: true, httpsRedirect: true, redirectTo: null }] },
];
const NET = `hp_appnet_${ID}`;
const EDGE = `hp_appedge_${ID}`;
const VOL = `hp_appvol_${ID}_data`;
const WEB = `hp_app_${ID}_web`;
const WORKER = `hp_app_${ID}_worker`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const mutations = (log: readonly string[]) => log.filter((line) => !line.startsWith("GET "));
const deletes = (log: readonly string[]) => log.filter((line) => line.startsWith("DELETE "));
const exists = (file: string) => stat(file).then(() => true, () => false);

async function setup() {
  const fake = createAppStackFakeEngine();
  const root = await mkdtemp(path.join(os.tmpdir(), "hp-app-lifecycle-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const stored = new Map<string, AppStackRouteEntry[]>();
  const routes = {
    write: async (stackId: string, entries: readonly AppStackRouteEntry[]) => {
      const active = entries.filter((entry) => entry.hosts.length > 0);
      const before = JSON.stringify(stored.get(stackId) ?? []);
      if (active.length === 0) stored.delete(stackId);
      else stored.set(stackId, [...active]);
      return { changed: before !== JSON.stringify(stored.get(stackId) ?? []), hostnames: active.flatMap((e) => e.hosts.map((h) => h.hostname)).sort() };
    },
    remove: async (stackId: string) => stored.delete(stackId),
    read: async (stackId: string) => stored.get(stackId) ?? [],
  };
  const probe = vi.fn<AppStackHealthProbe>(async () => "passed");
  const engine = new AppStackEngine({
    request: fake.request,
    secretsRootDir: root,
    pullMissingImages: true,
    allowlist: TEST_ALLOWLIST,
    routes,
    proxy: { containerName: PROXY, ensure: async () => undefined },
    readLogs: async () => [],
    probe,
    now: () => new Date("2026-11-22T03:00:00.000Z"),
  });
  fake.images.set("traefik:test", { repoDigests: [] });
  await fake.request("POST", `/containers/create?name=${PROXY}`, { Image: "traefik:test" });
  fake.pullable.add(IMAGE);
  fake.log.length = 0;
  fake.bodies.clear();
  return { fake, root, engine, probe };
}
type Harness = Awaited<ReturnType<typeof setup>>;

const stepsOf = (h: Harness, plan: ApprovedStackPlan) =>
  [
    ["pull", () => h.engine.pullAppStackImage({ plan, image: IMAGE })],
    ["prepare", () => h.engine.prepareAppStack({ plan })],
    ["create", () => h.engine.createAppStackComponents({ plan })],
    ["start web", () => h.engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })],
    ["start worker", () => h.engine.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS })],
  ] as const;

async function apply(h: Harness, plan: ApprovedStackPlan, upTo = 5) {
  for (const [, run] of stepsOf(h, plan).slice(0, upTo)) await run();
}

/** Everything the Engine holds, by name: identity (Id) and run state, so a re-run that recreates anything shows. */
function snapshot(fake: AppStackFakeEngine, ownedBy: (name: string) => boolean = () => true) {
  const pick = <T>(entries: Array<[string, T]>) => Object.fromEntries(entries.filter(([name]) => ownedBy(name)).sort(([a], [b]) => a.localeCompare(b)));
  return {
    containers: pick([...fake.containers].map(([n, c]) => [n, { id: c.Id, running: c.State.Running, status: c.State.Status, startedAt: c.State.StartedAt }])),
    networks: pick([...fake.networks].map(([n, v]) => [n, { id: v.Id, members: [...v.members].sort() }])),
    volumes: pick([...fake.volumes].map(([n, v]) => [n, v])),
  };
}
const ofStack = (id: string) => (name: string) => name.includes(id);

describe("A16: re-applying creates nothing", () => {
  it("the whole apply sequence run again over a running stack sends no create, delete, start or pull", async () => {
    const h = await setup();
    const plan = appStackTestPlan();
    await apply(h, plan);
    const before = snapshot(h.fake);
    const secretsBefore = await readdir(h.root);
    h.fake.log.length = 0;
    const outcomes: unknown[] = [];
    for (const [, run] of stepsOf(h, plan)) outcomes.push(await run());
    expect(outcomes).toEqual([
      { image: IMAGE, pulled: false },
      { networks: [{ role: "app_internal", created: false }, { role: "app_edge", created: false }], volumes: [{ volumeKey: "data", created: false }] },
      { components: [{ componentKey: "web", outcome: "unchanged" }, { componentKey: "worker", outcome: "unchanged" }], removedComponents: [] },
      { componentKey: "web", outcome: "already_running" },
      { componentKey: "worker", outcome: "already_running" },
    ]);
    expect(mutations(h.fake.log)).toEqual([]);
    expect(snapshot(h.fake)).toEqual(before);
    expect(await readdir(h.root)).toEqual(secretsBefore);
  });

  it("re-applying a created-but-never-started stack does not start anything", async () => {
    const h = await setup();
    const plan = appStackTestPlan();
    await apply(h, plan, 3);
    const before = snapshot(h.fake);
    h.fake.log.length = 0;
    await apply(h, plan, 3);
    expect(mutations(h.fake.log)).toEqual([]);
    expect(snapshot(h.fake)).toEqual(before);
    expect([...h.fake.containers.values()].filter((c) => c.Name.startsWith("hp_app_")).every((c) => !c.State.Running)).toBe(true);
  });

  it("a stopped stack re-applied keeps its containers (no recreate) and a start brings it back", async () => {
    const h = await setup();
    const plan = appStackTestPlan();
    await apply(h, plan);
    const ids = [h.fake.containers.get(WEB)?.Id, h.fake.containers.get(WORKER)?.Id];
    await h.engine.stopAppStack(REF);
    h.fake.log.length = 0;
    await apply(h, plan, 3);
    expect(h.fake.log.filter((line) => /^(POST \/containers\/create|DELETE)/.test(line))).toEqual([]);
    await h.engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
    await h.engine.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS });
    expect([h.fake.containers.get(WEB)?.Id, h.fake.containers.get(WORKER)?.Id]).toEqual(ids);
    expect([...h.fake.containers.values()].filter((c) => c.Name.startsWith("hp_app_")).every((c) => c.State.Running)).toBe(true);
  });

  const labels = ["pull", "prepare", "create", "start web", "start worker"];
  it.each([0, 1, 2, 3, 4])("an apply interrupted after %i steps converges to the clean result, and one more run changes nothing", async (done) => {
    const clean = await setup();
    const plan = appStackTestPlan();
    await apply(clean, plan);

    const h = await setup();
    await apply(h, plan, done);
    await apply(h, plan);
    const converged = snapshot(h.fake, ofStack(ID));
    const shape = (s: ReturnType<typeof snapshot>) => ({
      containers: Object.entries(s.containers).map(([n, c]) => [n, c.running, c.status]),
      networks: Object.keys(s.networks),
      volumes: Object.keys(s.volumes),
    });
    expect(shape(converged), `after ${labels[done - 1] ?? "nothing"}`).toEqual(shape(snapshot(clean.fake, ofStack(ID))));
    h.fake.log.length = 0;
    await apply(h, plan);
    expect(mutations(h.fake.log)).toEqual([]);
    expect(snapshot(h.fake, ofStack(ID))).toEqual(converged);
  });

  it("re-applying one stack never touches another stack on the same host", async () => {
    const h = await setup();
    const other = appStackTestPlan({ stackId: OTHER_ID });
    await apply(h, other);
    const otherBefore = snapshot(h.fake, ofStack(OTHER_ID));
    const plan = appStackTestPlan();
    await apply(h, plan);
    h.fake.log.length = 0;
    await apply(h, plan);
    expect(snapshot(h.fake, ofStack(OTHER_ID))).toEqual(otherBefore);
    expect(h.fake.log.filter((line) => line.includes(OTHER_ID) && !line.startsWith("GET "))).toEqual([]);
  });
});

describe("A17: create without start is observable by GET only", () => {
  it("status after create reports every component created/stopped and changes nothing", async () => {
    const h = await setup();
    const plan = appStackTestPlan();
    await apply(h, plan, 3);
    const before = snapshot(h.fake);
    h.fake.log.length = 0;
    const status = await h.engine.getAppStackStatus(REF);
    expect(status.components.map((c) => [c.componentKey, c.state, c.health, c.probe, c.startedAt, c.exitCode === null || c.exitCode === 0])).toEqual([
      ["web", "created", "stopped", "not_run", null, true],
      ["worker", "created", "stopped", "not_run", null, true],
    ]);
    expect(status.networks).toEqual({ internal: true, edge: true });
    expect(status.volumes).toEqual(["data"]);
    expect(status.routes).toEqual({ published: false, hostnames: [] });
    expect(h.fake.log.length).toBeGreaterThan(0);
    expect(h.fake.log.every((line) => line.startsWith("GET "))).toBe(true);
    expect(h.probe).not.toHaveBeenCalled();
    expect(snapshot(h.fake)).toEqual(before);
    expect(await readdir(h.root)).toEqual([]);
  });

  it("status of a half-started stack tells started from created, still GET only", async () => {
    const h = await setup();
    const plan = appStackTestPlan();
    await apply(h, plan, 4);
    h.fake.log.length = 0;
    const status = await h.engine.getAppStackStatus(REF);
    expect(status.components.map((c) => [c.componentKey, c.state])).toEqual([
      ["web", "running"],
      ["worker", "created"],
    ]);
    expect(status.components[0]?.startedAt).not.toBeNull();
    expect(h.fake.log.every((line) => line.startsWith("GET "))).toBe(true);
  });

  it("status of a stack that does not exist is empty and sends only GETs", async () => {
    const h = await setup();
    const status = await h.engine.getAppStackStatus(REF);
    expect(status.components).toEqual([]);
    expect(status.networks).toEqual({ internal: false, edge: false });
    expect(status.volumes).toEqual([]);
    expect(h.fake.log.every((line) => line.startsWith("GET "))).toBe(true);
  });

  it("status after a stop reads components as stopped without starting or writing anything", async () => {
    const h = await setup();
    await apply(h, appStackTestPlan());
    await h.engine.stopAppStack(REF);
    h.fake.log.length = 0;
    const status = await h.engine.getAppStackStatus(REF);
    expect(status.components.map((c) => [c.state, c.health, c.probe])).toEqual([
      ["exited", "stopped", "not_run"],
      ["exited", "stopped", "not_run"],
    ]);
    expect(mutations(h.fake.log)).toEqual([]);
  });
});

/** A plan whose web component also mounts a second volume, so retention is observable per volume key. */
function twoVolumePlan(stackId = ID) {
  const base = appStackTestPlan({ stackId });
  return rehash({
    ...base,
    volumes: [{ key: "cache" }, { key: "data" }],
    components: base.components.map((c) => (c.key === "web" ? { ...c, volumes: [{ volumeKey: "cache", containerPath: "/cache", readOnly: false }] } : c)),
  });
}

describe("A18: remove keeps the named volumes unless asked", () => {
  it("removeVolumes false deletes containers and networks, never a volume, and keeps volume identity and labels", async () => {
    const h = await setup();
    const plan = twoVolumePlan();
    await apply(h, plan);
    const volumes = snapshot(h.fake).volumes;
    expect(Object.keys(volumes)).toEqual([`hp_appvol_${ID}_cache`, VOL]);
    h.fake.log.length = 0;
    const result = await h.engine.removeAppStack({ ...REF, removeVolumes: false });
    expect(result).toMatchObject({ removedVolumes: [], retainedVolumes: ["cache", "data"] });
    expect(h.fake.log.filter((line) => line.startsWith("DELETE /volumes"))).toEqual([]);
    expect(h.fake.log.some((line) => /volumes\/.*\?force|prune/.test(line))).toBe(false);
    expect(snapshot(h.fake).volumes).toEqual(volumes);
    expect([...h.fake.containers.keys()]).toEqual([PROXY]);
    expect([...h.fake.networks.keys()]).toEqual([]);
    expect(await readdir(h.root)).toEqual([]);
  });

  it("a stack removed with volumes kept is installed again onto the same volumes (created: false)", async () => {
    const h = await setup();
    const plan = appStackTestPlan();
    await apply(h, plan);
    const volume = h.fake.volumes.get(VOL);
    await h.engine.removeAppStack({ ...REF, removeVolumes: false });
    h.fake.log.length = 0;
    const prepared = await h.engine.prepareAppStack({ plan });
    expect(prepared.volumes).toEqual([{ volumeKey: "data", created: false }]);
    expect(h.fake.volumes.get(VOL)).toBe(volume);
    expect(h.fake.log.filter((line) => line.startsWith("POST /volumes"))).toEqual([]);
  });

  it("removeVolumes true deletes exactly this stack's own volumes and no other volume", async () => {
    const h = await setup();
    await apply(h, twoVolumePlan());
    await apply(h, twoVolumePlan(OTHER_ID));
    await h.fake.request("POST", "/volumes/create", { Name: "someone_elses_volume" });
    const otherBefore = snapshot(h.fake, ofStack(OTHER_ID));
    h.fake.log.length = 0;
    const result = await h.engine.removeAppStack({ ...REF, removeVolumes: true });
    expect(result).toMatchObject({ removedVolumes: ["cache", "data"], retainedVolumes: [] });
    expect(deletes(h.fake.log).filter((line) => line.startsWith("DELETE /volumes"))).toEqual([
      `DELETE /volumes/hp_appvol_${ID}_cache`,
      `DELETE /volumes/${VOL}`,
    ]);
    expect([...h.fake.volumes.keys()].sort()).toEqual([`hp_appvol_${OTHER_ID}_cache`, `hp_appvol_${OTHER_ID}_data`, "someone_elses_volume"]);
    expect(snapshot(h.fake, ofStack(OTHER_ID))).toEqual(otherBefore);
  });

  it("removing a stack that was only prepared (no containers) keeps its volumes the same way", async () => {
    const h = await setup();
    await apply(h, appStackTestPlan(), 2);
    h.fake.log.length = 0;
    await expect(h.engine.removeAppStack({ ...REF, removeVolumes: false })).resolves.toEqual({
      removedComponents: [],
      removedNetworks: ["app_edge", "app_internal"],
      removedVolumes: [],
      retainedVolumes: ["data"],
    });
    expect(h.fake.volumes.has(VOL)).toBe(true);
  });
});

describe("A19 (executor half): a changed component hash replaces only that component", () => {
  const edit = (plan: ApprovedStackPlan, key: string, patch: object) =>
    rehash({ ...plan, components: plan.components.map((c) => (c.key === key ? { ...c, ...patch } : c)) });

  it.each([
    ["web", { environment: [{ name: "APP_MODE", value: "debug" }] }, "web", "worker"],
    ["worker", { argv: ["worker", "--queue", "mail"] }, "worker", "web"],
    ["worker", { resources: { cpuMilli: 300, memoryBytes: "134217728" } }, "worker", "web"],
  ])("changing %s (%j) replaces %s and leaves %s alone", async (key, patch, replaced, untouched) => {
    const h = await setup();
    await apply(h, appStackTestPlan());
    const containerName = (k: string) => `hp_app_${ID}_${k}`;
    const idBefore = (k: string) => h.fake.containers.get(containerName(k))?.Id;
    const untouchedId = idBefore(untouched);
    const volume = h.fake.volumes.get(VOL);
    const networks = snapshot(h.fake).networks;
    h.fake.log.length = 0;
    const result = await h.engine.createAppStackComponents({ plan: edit(appStackTestPlan(), key, patch) });
    expect(result.removedComponents).toEqual([]);
    expect(Object.fromEntries(result.components.map((c) => [c.componentKey, c.outcome]))).toEqual({ [replaced]: "replaced", [untouched]: "unchanged" });
    expect(h.fake.containers.get(containerName(untouched))?.Id).toBe(untouchedId);
    expect(h.fake.containers.get(containerName(untouched))?.State.Running).toBe(true);
    expect(h.fake.containers.get(containerName(replaced))?.State.Status).toBe("created");
    expect(h.fake.log.filter((line) => line.includes(`/containers/${untouchedId}`))).toEqual([]);
    expect(h.fake.volumes.get(VOL)).toBe(volume);
    expect(snapshot(h.fake).networks).toEqual(networks);
    expect(deletes(h.fake.log).filter((line) => !line.startsWith("DELETE /containers/"))).toEqual([]);
  });

  it("the replaced component mounts the same named volume (same name, same identity) and may be started again", async () => {
    const h = await setup();
    const plan = appStackTestPlan();
    await apply(h, plan);
    const volume = h.fake.volumes.get(VOL);
    const changed = edit(plan, "worker", { argv: ["worker", "--queue", "mail"] });
    await h.engine.createAppStackComponents({ plan: changed });
    expect(h.fake.containers.get(WORKER)?.mounts).toEqual([VOL]);
    await h.engine.startAppStackComponent({ plan: changed, componentKey: "worker", secretFileContents: SECRETS });
    expect(h.fake.containers.get(WORKER)?.State.Running).toBe(true);
    expect(h.fake.volumes.get(VOL)).toBe(volume);
    expect(await exists(path.join(h.root, `app_${ID}__worker`))).toBe(true);
  });

  it("applying the changed plan twice replaces once", async () => {
    const h = await setup();
    await apply(h, appStackTestPlan());
    const changed = edit(appStackTestPlan(), "web", { environment: [{ name: "APP_MODE", value: "debug" }] });
    await h.engine.createAppStackComponents({ plan: changed });
    h.fake.log.length = 0;
    const again = await h.engine.createAppStackComponents({ plan: changed });
    expect(again.components.map((c) => c.outcome)).toEqual(["unchanged", "unchanged"]);
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("a replace never touches the same component of another stack", async () => {
    const h = await setup();
    await apply(h, appStackTestPlan());
    await apply(h, appStackTestPlan({ stackId: OTHER_ID }));
    const otherBefore = snapshot(h.fake, ofStack(OTHER_ID));
    await h.engine.createAppStackComponents({ plan: edit(appStackTestPlan(), "web", { environment: [{ name: "APP_MODE", value: "debug" }] }) });
    expect(snapshot(h.fake, ofStack(OTHER_ID))).toEqual(otherBefore);
  });
});

describe("B5 (executor half): failures keep data, touch nothing foreign, and a re-run converges", () => {
  /** Another stack, fully deployed, whose objects no failure of this one may change. */
  async function withNeighbour(h: Harness) {
    await apply(h, appStackTestPlan({ stackId: OTHER_ID }));
    await h.engine.publishAppStackRoutes({
      plan: appStackTestPlan({ stackId: OTHER_ID }),
      routes: [{ ...ROUTES[0]!, hosts: [{ ...ROUTES[0]!.hosts[0]!, hostname: "neighbour.example.org" }] }],
    });
    h.fake.log.length = 0;
    return snapshot(h.fake, ofStack(OTHER_ID));
  }

  it.each([
    ["an error line in the 200 stream", (h: Harness) => (h.fake.images.delete(IMAGE), h.fake.pullable.delete(IMAGE))],
    ["a pull HTTP 500", (h: Harness) => (h.fake.images.delete(IMAGE), h.fake.failNext(/^POST \/images\/create/, 500))],
  ])("pull error (%s): nothing is created or deleted; the re-run pulls", async (_name, arrange) => {
    const h = await setup();
    const neighbour = await withNeighbour(h);
    arrange(h);
    await expect(h.engine.pullAppStackImage({ plan: appStackTestPlan(), image: IMAGE })).rejects.toMatchObject({
      reason: "STACK_IMAGE_PULL_FAILED",
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
    expect(mutations(h.fake.log).filter((line) => !line.startsWith("POST /images/create"))).toEqual([]);
    expect(h.fake.images.has(IMAGE)).toBe(false);
    h.fake.pullable.add(IMAGE);
    await expect(h.engine.pullAppStackImage({ plan: appStackTestPlan(), image: IMAGE })).resolves.toEqual({ image: IMAGE, pulled: true });
    await apply(h, appStackTestPlan());
    expect(snapshot(h.fake, ofStack(OTHER_ID))).toEqual(neighbour);
  });

  it("a pull error on a clean host leaves the host with no image, no network, no volume", async () => {
    const h = await setup();
    h.fake.failNext(/^POST \/images\/create/, 500);
    await expect(h.engine.pullAppStackImage({ plan: appStackTestPlan(), image: IMAGE })).rejects.toMatchObject({ reason: "STACK_IMAGE_PULL_FAILED" });
    expect(h.fake.images.has(IMAGE)).toBe(false);
    expect(h.fake.networks.size + h.fake.volumes.size).toBe(0);
    await apply(h, appStackTestPlan());
    expect(h.fake.containers.get(WORKER)?.State.Running).toBe(true);
  });

  it.each([
    ["the internal network", false, [NET]],
    ["the edge network, after the internal one exists", true, [NET]],
  ])("network create 500 on %s: nothing deleted, no volume or container made, the re-run converges", async (_name, internalExists, kept) => {
    const h = await setup();
    const neighbour = await withNeighbour(h);
    const plan = appStackTestPlan();
    if (internalExists) {
      await h.fake.request("POST", "/networks/create", { Name: NET, Driver: "bridge", Internal: true, Labels: appStackNetworkLabels(plan, "app_internal") });
      h.fake.log.length = 0;
    }
    h.fake.failNext(/^POST \/networks\/create/, 500);
    await expect(h.engine.prepareAppStack({ plan })).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(deletes(h.fake.log)).toEqual([]);
    expect([...h.fake.networks.keys()].filter(ofStack(ID))).toEqual(internalExists ? kept : []);
    expect([...h.fake.volumes.keys()].filter(ofStack(ID))).toEqual([]);
    expect([...h.fake.containers.keys()].filter(ofStack(ID))).toEqual([]);
    await apply(h, plan);
    expect([...h.fake.networks.keys()].filter(ofStack(ID)).sort()).toEqual([EDGE, NET]);
    expect(h.fake.containers.get(WORKER)?.State.Running).toBe(true);
    expect(snapshot(h.fake, ofStack(OTHER_ID))).toEqual(neighbour);
  });

  it("container create 500 on the second component: the first, the networks and the volume stay; no delete; re-run converges", async () => {
    const h = await setup();
    const neighbour = await withNeighbour(h);
    const plan = appStackTestPlan();
    await apply(h, plan, 2);
    const volume = h.fake.volumes.get(VOL);
    h.fake.log.length = 0;
    h.fake.failNext(new RegExp(`^POST /containers/create\\?name=${WORKER}`), 500);
    await expect(h.engine.createAppStackComponents({ plan })).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(deletes(h.fake.log)).toEqual([]);
    expect(h.fake.containers.has(WEB)).toBe(true);
    expect(h.fake.containers.has(WORKER)).toBe(false);
    expect(h.fake.volumes.get(VOL)).toBe(volume);
    expect([...h.fake.networks.keys()].filter(ofStack(ID)).sort()).toEqual([EDGE, NET]);
    const webId = h.fake.containers.get(WEB)?.Id;
    await apply(h, plan);
    expect(h.fake.containers.get(WEB)?.Id).toBe(webId);
    expect(h.fake.containers.get(WORKER)?.State.Running).toBe(true);
    expect(snapshot(h.fake, ofStack(OTHER_ID))).toEqual(neighbour);
  });

  it("container create 500 right after a replace removed the old one: only that component is absent, status says so, the re-run recreates it", async () => {
    const h = await setup();
    const plan = appStackTestPlan();
    await apply(h, plan);
    const volume = h.fake.volumes.get(VOL);
    const changed = rehash({ ...plan, components: plan.components.map((c) => (c.key === "worker" ? { ...c, argv: ["worker", "--other"] } : c)) });
    h.fake.failNext(new RegExp(`^POST /containers/create\\?name=${WORKER}`), 500);
    await expect(h.engine.createAppStackComponents({ plan: changed })).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(h.fake.containers.has(WORKER)).toBe(false);
    expect(h.fake.containers.get(WEB)?.State.Running).toBe(true);
    expect(h.fake.volumes.get(VOL)).toBe(volume);
    const status = await h.engine.getAppStackStatus(REF);
    expect(status.components.map((c) => c.componentKey)).toEqual(["web"]);
    await expect(h.engine.createAppStackComponents({ plan: changed })).resolves.toMatchObject({
      components: [
        { componentKey: "web", outcome: "unchanged" },
        { componentKey: "worker", outcome: "created" },
      ],
    });
    expect(h.fake.volumes.get(VOL)).toBe(volume);
  });

  it("start 500: the dependency keeps running, the volume and secret files stay, nothing is deleted, the re-run starts", async () => {
    const h = await setup();
    const neighbour = await withNeighbour(h);
    const plan = appStackTestPlan();
    await apply(h, plan, 4);
    const volume = h.fake.volumes.get(VOL);
    h.fake.log.length = 0;
    h.fake.failNext(/^POST \/containers\/ctr\d+\/start$/, 500);
    await expect(h.engine.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS })).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
    expect(deletes(h.fake.log)).toEqual([]);
    expect(h.fake.containers.get(WEB)?.State.Running).toBe(true);
    expect(h.fake.containers.get(WORKER)?.State.Running).toBe(false);
    expect(h.fake.volumes.get(VOL)).toBe(volume);
    expect((await h.engine.getAppStackStatus(REF)).components.map((c) => [c.componentKey, c.state])).toEqual([
      ["web", "running"],
      ["worker", "created"],
    ]);
    await expect(h.engine.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS })).resolves.toEqual({
      componentKey: "worker",
      outcome: "started",
    });
    expect(snapshot(h.fake, ofStack(OTHER_ID))).toEqual(neighbour);
  });

  it("start 500 of a dependency stops the dependent from starting at all", async () => {
    const h = await setup();
    const plan = appStackTestPlan();
    await apply(h, plan, 3);
    h.fake.failNext(/^POST \/containers\/ctr\d+\/start$/, 500);
    await expect(h.engine.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
    await expect(h.engine.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: SECRETS })).rejects.toMatchObject({
      reason: "STACK_COMPONENT_NOT_READY",
    });
    expect([...h.fake.containers.values()].filter((c) => c.Name.startsWith("hp_app_") && c.State.Running)).toEqual([]);
  });

  it.each([
    ["a foreign container still mounts the volume", true],
    ["the Engine answers 409 on the volume delete", false],
  ])("volume delete 409 (%s): containers and networks are gone, the volume stays, nothing foreign is deleted, the re-run converges", async (_name, borrowed) => {
    const h = await setup();
    const neighbour = await withNeighbour(h);
    await apply(h, appStackTestPlan());
    const ownIds = [WEB, WORKER].map((n) => h.fake.containers.get(n)?.Id);
    if (borrowed) {
      await h.fake.request("POST", "/containers/create?name=borrower", { Image: "traefik:test", HostConfig: { Mounts: [{ Type: "volume", Source: VOL, Target: "/x" }] } });
    } else {
      h.fake.failNext(/^DELETE \/volumes\//, 409);
    }
    h.fake.log.length = 0;
    await expect(h.engine.removeAppStack({ ...REF, removeVolumes: true })).rejects.toMatchObject({
      reason: "STACK_VOLUME_IN_USE",
      code: "RESOURCE_LOCKED",
    });
    expect(h.fake.volumes.has(VOL)).toBe(true);
    expect([...h.fake.containers.keys()].filter(ofStack(ID))).toEqual([]);
    expect([...h.fake.networks.keys()].filter(ofStack(ID))).toEqual([]);
    expect(deletes(h.fake.log).filter((line) => !ownIds.some((id) => line.startsWith(`DELETE /containers/${id}?`)) && !line.includes(ID))).toEqual([]);
    expect(snapshot(h.fake, ofStack(OTHER_ID))).toEqual(neighbour);
    expect(h.fake.containers.has(PROXY)).toBe(true);
    // the re-run continues where it stopped, then reports the stack gone
    if (borrowed) await h.fake.request("DELETE", "/containers/borrower");
    await expect(h.engine.removeAppStack({ ...REF, removeVolumes: true })).resolves.toEqual({
      removedComponents: [],
      removedNetworks: [],
      removedVolumes: ["data"],
      retainedVolumes: [],
    });
    expect(h.fake.volumes.has(VOL)).toBe(false);
    expect(snapshot(h.fake, ofStack(OTHER_ID))).toEqual(neighbour);
  });

  it("a failing removal with removeVolumes false never reaches the volumes", async () => {
    const h = await setup();
    await apply(h, appStackTestPlan());
    await h.fake.request("POST", "/containers/create?name=squatter", { Image: "traefik:test", HostConfig: { NetworkMode: NET } });
    h.fake.log.length = 0;
    await expect(h.engine.removeAppStack({ ...REF, removeVolumes: false })).rejects.toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    expect(h.fake.volumes.has(VOL)).toBe(true);
    expect(h.fake.log.filter((line) => line.includes("/volumes") && !line.startsWith("GET "))).toEqual([]);
    await h.fake.request("DELETE", "/containers/squatter");
    await expect(h.engine.removeAppStack({ ...REF, removeVolumes: false })).resolves.toMatchObject({ removedVolumes: [], retainedVolumes: ["data"] });
    expect(h.fake.volumes.has(VOL)).toBe(true);
  });

  it("a network delete 500 mid-removal stops there with every volume kept; the re-run finishes", async () => {
    const h = await setup();
    await apply(h, appStackTestPlan());
    h.fake.failNext(/^DELETE \/networks\//, 500);
    await expect(h.engine.removeAppStack({ ...REF, removeVolumes: true })).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(h.fake.volumes.has(VOL)).toBe(true);
    await expect(h.engine.removeAppStack({ ...REF, removeVolumes: true })).resolves.toMatchObject({ removedVolumes: ["data"] });
    expect([...h.fake.networks.keys(), ...h.fake.volumes.keys()].filter(ofStack(ID))).toEqual([]);
  });
});
