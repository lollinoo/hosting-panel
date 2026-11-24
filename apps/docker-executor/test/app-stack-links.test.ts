import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppStackLinksIpcResultSchema, appStackLinkAlias, type ApprovedStackPlan } from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppStackEngine, appStackNetworkLabels } from "../src/app-stacks/index.js";
import { InMemoryDockerSimulatorAdapter } from "../src/index.js";
import type { AppStackRouteEntry } from "../src/traefik-config.js";
import { createAppStackFakeEngine } from "./support/app-stack-fake-engine.js";
import { TEST_ALLOWLIST, appStackTestPlan } from "./support/app-stack-plans.js";

// ADR-0039: the single component of a database is attached to the private network of each application it is linked
// to, under a name the executor derives itself, and to nothing else.

const ORG = "org_acme";
const OTHER_ORG = "org_other";
const DB = "stk_0123456789abcdef01234567";
const APP_A = "stk_aaaaaaaaaaaaaaaaaaaaaaaa";
const APP_B = "stk_bbbbbbbbbbbbbbbbbbbbbbbb";
const APP_C = "stk_cccccccccccccccccccccccc";
const ALIAS = "stk-0123456789abcdef01234567";
const IMAGE = `registry.test/acme/web@sha256:${"c".repeat(64)}`;
const PROXY = "hp_ingress_proxy_test";
const net = (stackId: string) => `hp_appnet_${stackId}`;
const container = (stackId: string, key: string) => `hp_app_${stackId}_${key}`;
const DB_CONTAINER = container(DB, "db");
const link = (consumerStackIds: string[], over: Partial<{ stackId: string; organizationId: string; componentKey: string }> = {}) => ({
  stackId: DB,
  organizationId: ORG,
  componentKey: "db",
  consumerStackIds,
  ...over,
});

const [web] = appStackTestPlan().components as [ApprovedStackPlan["components"][number]];

/** One component, one port, no address: what a database is for a link. */
function databasePlan(stackId = DB, organizationId = ORG): ApprovedStackPlan {
  return appStackTestPlan({
    stackId,
    organizationId,
    components: [{ ...web, key: "db", expose: [3306], healthcheck: null }],
    volumes: [],
    ingress: [],
  });
}

function applicationPlan(stackId: string, organizationId = ORG): ApprovedStackPlan {
  return appStackTestPlan({ stackId, organizationId, components: [{ ...web, healthcheck: null }], volumes: [], ingress: [] });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const mutations = (log: readonly string[]) => log.filter((line) => !line.startsWith("GET "));

async function failure(promise: Promise<unknown>): Promise<{ reason?: string; code?: string; message?: string; ambiguousOutcome?: boolean }> {
  try {
    await promise;
  } catch (err) {
    return err as { reason?: string; code?: string; message?: string };
  }
  throw new Error("expected a refusal");
}

async function setup() {
  const fake = createAppStackFakeEngine();
  const root = await mkdtemp(path.join(os.tmpdir(), "hp-app-links-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const routes = {
    write: vi.fn(async (_stackId: string, _entries: readonly AppStackRouteEntry[]) => ({ changed: false, hostnames: [] })),
    remove: vi.fn(async () => {
      fake.log.push("ROUTES remove");
      return false;
    }),
    read: vi.fn(async () => []),
  };
  const engine = new AppStackEngine({
    request: fake.request,
    secretsRootDir: root,
    pullMissingImages: false,
    allowlist: TEST_ALLOWLIST,
    routes,
    proxy: { containerName: PROXY, ensure: vi.fn(async () => undefined) },
    readLogs: vi.fn(async () => []),
    probe: vi.fn(async () => "passed" as const),
    now: () => new Date("2026-11-23T03:00:00.000Z"),
  });
  fake.images.set(IMAGE, { repoDigests: [IMAGE] });
  fake.images.set("traefik:test", { repoDigests: [] });
  await fake.request("POST", `/containers/create?name=${PROXY}`, { Image: "traefik:test" });
  const clear = () => {
    fake.log.length = 0;
    fake.bodies.clear();
  };
  clear();
  return { fake, engine, clear };
}

type Harness = Awaited<ReturnType<typeof setup>>;

async function install(h: Harness, plan: ApprovedStackPlan, options: { start?: boolean } = {}) {
  await h.engine.prepareAppStack({ plan });
  await h.engine.createAppStackComponents({ plan });
  if (options.start !== false) {
    for (const c of plan.components) await h.engine.startAppStackComponent({ plan, componentKey: c.key, secretFileContents: [] });
  }
  h.clear();
}

/** A database and the applications named, all running. */
async function installed(...applications: string[]) {
  const h = await setup();
  await install(h, databasePlan());
  for (const id of applications) await install(h, applicationPlan(id));
  return h;
}

const idOf = (h: Harness, name: string) => h.fake.containers.get(name)?.Id ?? "missing";
const attachedTo = (h: Harness, name = DB_CONTAINER) => [...(h.fake.containers.get(name)?.networks.keys() ?? [])].sort();
const connectLine = (stackId: string) => `POST /networks/${net(stackId)}/connect`;
const disconnectLine = (stackId: string) => `POST /networks/${net(stackId)}/disconnect`;

describe("syncAppStackLinks attaches a database to the applications it is linked to", () => {
  it("derives the name from the database's id, which no component key can take", () => {
    expect(appStackLinkAlias(DB)).toBe(ALIAS);
  });

  it("attaches the component under the derived name, and does nothing the second time", async () => {
    const h = await installed(APP_A, APP_B);
    const result = await h.engine.syncAppStackLinks(link([APP_B, APP_A]));
    expect(result).toEqual({
      container: true,
      links: [
        { consumerStackId: APP_B, outcome: "connected" },
        { consumerStackId: APP_A, outcome: "connected" },
      ],
      disconnected: [],
    });
    expect(AppStackLinksIpcResultSchema.parse(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/ctr\d|net\d/);
    expect(mutations(h.fake.log)).toEqual([connectLine(APP_B), connectLine(APP_A)]);
    for (const id of [APP_A, APP_B]) {
      expect(h.fake.bodies.get(connectLine(id))).toEqual([{ Container: idOf(h, DB_CONTAINER), EndpointConfig: { Aliases: [ALIAS] } }]);
      expect(h.fake.containers.get(DB_CONTAINER)?.endpoints.get(net(id))).toEqual({
        networkId: h.fake.networks.get(net(id))?.Id,
        aliases: [ALIAS],
      });
    }
    // Only the database moved: no application is on the database's network, and the two applications do not meet.
    expect(attachedTo(h)).toEqual([net(DB), net(APP_A), net(APP_B)].sort());
    expect([...(h.fake.networks.get(net(DB))?.members ?? [])]).toEqual([DB_CONTAINER]);
    expect(attachedTo(h, container(APP_A, "web"))).toEqual([net(APP_A)]);
    expect(attachedTo(h, container(APP_B, "web"))).toEqual([net(APP_B)]);
    expect(h.fake.containers.get(DB_CONTAINER)?.State.Running).toBe(true);

    h.clear();
    await expect(h.engine.syncAppStackLinks(link([APP_B, APP_A]))).resolves.toEqual({
      container: true,
      links: [
        { consumerStackId: APP_B, outcome: "already_connected" },
        { consumerStackId: APP_A, outcome: "already_connected" },
      ],
      disconnected: [],
    });
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("attaches a database that is created and not started, and never starts it", async () => {
    const h = await setup();
    await install(h, databasePlan(), { start: false });
    await install(h, applicationPlan(APP_A));
    await expect(h.engine.syncAppStackLinks(link([APP_A]))).resolves.toMatchObject({ links: [{ consumerStackId: APP_A, outcome: "connected" }] });
    // Nothing recorded the network's id yet: the attachment follows the name and is not taken for a stale one.
    expect(h.fake.containers.get(DB_CONTAINER)?.endpoints.get(net(APP_A))?.networkId).toBe("");
    h.clear();
    await expect(h.engine.syncAppStackLinks(link([APP_A]))).resolves.toMatchObject({
      links: [{ consumerStackId: APP_A, outcome: "already_connected" }],
    });
    expect(mutations(h.fake.log)).toEqual([]);
    expect(h.fake.containers.get(DB_CONTAINER)?.State.Status).toBe("created");
  });

  it("detaches from the applications no longer declared, in ascending order; an empty list detaches from all", async () => {
    const h = await installed(APP_A, APP_B, APP_C);
    await h.engine.syncAppStackLinks(link([APP_C, APP_B, APP_A]));
    h.clear();
    await expect(h.engine.syncAppStackLinks(link([APP_B]))).resolves.toEqual({
      container: true,
      links: [{ consumerStackId: APP_B, outcome: "already_connected" }],
      disconnected: [APP_A, APP_C],
    });
    expect(mutations(h.fake.log)).toEqual([disconnectLine(APP_A), disconnectLine(APP_C)]);
    expect(h.fake.bodies.get(disconnectLine(APP_A))).toEqual([{ Container: idOf(h, DB_CONTAINER), Force: true }]);
    expect(attachedTo(h)).toEqual([net(DB), net(APP_B)].sort());

    h.clear();
    await expect(h.engine.syncAppStackLinks(link([]))).resolves.toEqual({ container: true, links: [], disconnected: [APP_B] });
    expect(mutations(h.fake.log)).toEqual([disconnectLine(APP_B)]);
    expect(attachedTo(h)).toEqual([net(DB)]);
    expect(h.fake.containers.get(DB_CONTAINER)?.State.Running).toBe(true);
  });

  it("changes nothing while the database has no component on the server", async () => {
    const h = await setup();
    await install(h, applicationPlan(APP_A));
    const waiting = { container: false, links: [{ consumerStackId: APP_A, outcome: "pending" }], disconnected: [] };
    await expect(h.engine.syncAppStackLinks(link([APP_A]))).resolves.toEqual(waiting);
    await h.engine.prepareAppStack({ plan: databasePlan() });
    h.clear();
    await expect(h.engine.syncAppStackLinks(link([APP_A]))).resolves.toEqual(waiting);
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("leaves a link pending while the application has no private network, and applies it later", async () => {
    const h = await installed(APP_A);
    await expect(h.engine.syncAppStackLinks(link([APP_A, APP_B]))).resolves.toEqual({
      container: true,
      links: [
        { consumerStackId: APP_A, outcome: "connected" },
        { consumerStackId: APP_B, outcome: "pending" },
      ],
      disconnected: [],
    });
    expect(mutations(h.fake.log)).toEqual([connectLine(APP_A)]);
    await install(h, applicationPlan(APP_B));
    await expect(h.engine.syncAppStackLinks(link([APP_A, APP_B]))).resolves.toMatchObject({
      links: [
        { consumerStackId: APP_A, outcome: "already_connected" },
        { consumerStackId: APP_B, outcome: "connected" },
      ],
    });
  });

  it("reads the answers of the server: gone in between, attached in between, out of order", async () => {
    const h = await installed(APP_A);
    h.fake.failNext(/\/connect$/, 404, JSON.stringify({ message: `network ${net(APP_A)} not found` }));
    await expect(h.engine.syncAppStackLinks(link([APP_A]))).resolves.toMatchObject({ links: [{ consumerStackId: APP_A, outcome: "pending" }] });
    h.fake.failNext(/\/connect$/, 403, JSON.stringify({ message: `endpoint with name ${DB_CONTAINER} already exists in network ${net(APP_A)}` }));
    await expect(h.engine.syncAppStackLinks(link([APP_A]))).resolves.toMatchObject({
      links: [{ consumerStackId: APP_A, outcome: "already_connected" }],
    });
    h.fake.failNext(/\/connect$/, 500);
    expect(await failure(h.engine.syncAppStackLinks(link([APP_A])))).toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
      message: "Failed to attach a database to an application (HTTP 500)",
    });
    expect(attachedTo(h)).toEqual([net(DB)]);

    await h.engine.syncAppStackLinks(link([APP_A]));
    h.fake.failNext(/\/disconnect$/, 500);
    expect(await failure(h.engine.syncAppStackLinks(link([])))).toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
      message: "Failed to detach a database from an application (HTTP 500)",
    });
    h.fake.failNext(/\/disconnect$/, 403, JSON.stringify({ message: `container x is not connected to the network ${net(APP_A)}` }));
    await expect(h.engine.syncAppStackLinks(link([]))).resolves.toEqual({ container: true, links: [], disconnected: [APP_A] });
  });
});

describe("syncAppStackLinks refuses before it changes anything", () => {
  it.each([
    ["a database whose id gives no name", link([APP_A], { stackId: "stk_0123456789abcdef" }), "This application cannot be linked"],
    ["a component key that is not one", link([APP_A], { componentKey: "DB;rm" }), "This application cannot be linked"],
    ["the database itself in the list", link([APP_A, DB]), "The list of linked applications is invalid"],
    ["an application id that is not one", link(["hp-ingress-net"]), "The list of linked applications is invalid"],
    ["a component the database does not have", link([APP_A], { componentKey: "cache" }), "Only an application with one component can be linked"],
  ])("%s", async (_name, request, message) => {
    const h = await installed(APP_A);
    expect(await failure(h.engine.syncAppStackLinks(request))).toMatchObject({ reason: "STACK_PLAN_INVALID", code: "VALIDATION_ERROR", message });
    expect(mutations(h.fake.log)).toEqual([]);
    expect(attachedTo(h)).toEqual([net(DB)]);
  });

  it("an application with more than one component is not a database", async () => {
    const h = await setup();
    const two = appStackTestPlan({ stackId: DB, components: [{ ...web, key: "db", healthcheck: null }, { ...web, key: "admin", healthcheck: null }], volumes: [], ingress: [] });
    await install(h, two);
    await install(h, applicationPlan(APP_A));
    expect(await failure(h.engine.syncAppStackLinks(link([APP_A])))).toMatchObject({
      reason: "STACK_PLAN_INVALID",
      message: "Only an application with one component can be linked",
    });
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("a database of another customer", async () => {
    const h = await installed(APP_A);
    expect(await failure(h.engine.syncAppStackLinks(link([APP_A], { organizationId: OTHER_ORG })))).toMatchObject({
      reason: "STACK_NAMESPACE_CONFLICT",
      code: "HOST_POLICY_DENIED",
    });
    expect(mutations(h.fake.log)).toEqual([]);
  });

  it("an application of another customer", async () => {
    const h = await setup();
    await install(h, databasePlan());
    await install(h, applicationPlan(APP_A, OTHER_ORG));
    expect(await failure(h.engine.syncAppStackLinks(link([APP_A])))).toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    expect(mutations(h.fake.log)).toEqual([]);
    expect(attachedTo(h)).toEqual([net(DB)]);
  });

  it.each([
    ["without labels", { Driver: "bridge", Internal: true }],
    ["that is not closed to the outside", { Driver: "bridge", Internal: false, Labels: appStackNetworkLabels({ stackId: APP_A, organizationId: ORG }, "app_internal") }],
    ["labelled as an edge network", { Driver: "bridge", Internal: true, Labels: appStackNetworkLabels({ stackId: APP_A, organizationId: ORG }, "app_edge") }],
    ["labelled for another application", { Driver: "bridge", Internal: true, Labels: appStackNetworkLabels({ stackId: APP_B, organizationId: ORG }, "app_internal") }],
  ])("a network with the application's name %s", async (_name, body) => {
    const h = await setup();
    await install(h, databasePlan());
    await install(h, applicationPlan(APP_B));
    await h.fake.request("POST", "/networks/create", { Name: net(APP_A), ...body });
    h.clear();
    // One bad network refuses the whole call: the good one is not attached either.
    expect(await failure(h.engine.syncAppStackLinks(link([APP_B, APP_A])))).toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    expect(mutations(h.fake.log)).toEqual([]);
    expect(attachedTo(h)).toEqual([net(DB)]);
  });

  it.each([
    ["a platform network", "hp_ingress_net_test"],
    ["the edge network of an application", `hp_appedge_${APP_A}`],
    ["a network that is not the panel's", "bridge_of_someone"],
  ])("a database found on %s", async (_name, foreign) => {
    const h = await installed(APP_A);
    await h.fake.request("POST", "/networks/create", { Name: foreign, Driver: "bridge" });
    await h.fake.request("POST", `/networks/${foreign}/connect`, { Container: DB_CONTAINER });
    h.clear();
    expect(await failure(h.engine.syncAppStackLinks(link([APP_A])))).toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    expect(await failure(h.engine.syncAppStackLinks(link([])))).toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    expect(mutations(h.fake.log)).toEqual([]);
    expect(attachedTo(h)).toEqual([net(DB), foreign].sort());
  });
});

describe("syncAppStackLinks and the changes that run next to it", () => {
  it("gives way to a change of the database, and to another link call for it", async () => {
    const h = await installed(APP_A);
    const stop = h.fake.hold(/\/stop\?t=10$/);
    const stopping = h.engine.stopAppStack({ stackId: DB, organizationId: ORG });
    expect(await failure(h.engine.syncAppStackLinks(link([APP_A])))).toMatchObject({
      reason: "STACK_BUSY",
      code: "RESOURCE_LOCKED",
      message: "Another change of this application stack is running",
    });
    stop.release();
    await stopping;

    const held = h.fake.hold(/^GET \/containers\/json/);
    const first = h.engine.syncAppStackLinks(link([APP_A]));
    expect(await failure(h.engine.syncAppStackLinks(link([])))).toMatchObject({ reason: "STACK_BUSY" });
    held.release();
    await expect(first).resolves.toMatchObject({ links: [{ consumerStackId: APP_A, outcome: "connected" }] });
    await expect(h.engine.syncAppStackLinks(link([APP_A]))).resolves.toMatchObject({ container: true });
  });

  it("never makes a change of the database wait or fail", async () => {
    const h = await installed(APP_A);
    const held = h.fake.hold(/\/connect$/);
    const linking = h.engine.syncAppStackLinks(link([APP_A]));
    await vi.waitFor(() => expect(h.fake.log).toContain(connectLine(APP_A)));
    await expect(h.engine.stopAppStack({ stackId: DB, organizationId: ORG })).resolves.toEqual({
      components: [{ componentKey: "db", outcome: "stopped" }],
    });
    held.release();
    await expect(linking).resolves.toMatchObject({ links: [{ consumerStackId: APP_A, outcome: "connected" }] });
  });

  it("attaches nothing to an application that is being changed", async () => {
    const h = await installed(APP_A, APP_B);
    const stop = h.fake.hold(/\/stop\?t=10$/);
    const removing = h.engine.removeAppStack({ stackId: APP_A, organizationId: ORG, removeVolumes: true });
    await expect(h.engine.syncAppStackLinks(link([APP_A, APP_B]))).resolves.toEqual({
      container: true,
      links: [
        { consumerStackId: APP_A, outcome: "pending" },
        { consumerStackId: APP_B, outcome: "connected" },
      ],
      disconnected: [],
    });
    expect(mutations(h.fake.log)).not.toContain(connectLine(APP_A));
    stop.release();
    await removing;
    expect(h.fake.networks.has(net(APP_A))).toBe(false);
    expect(attachedTo(h)).toEqual([net(DB), net(APP_B)].sort());
  });
});

describe("syncAppStackLinks repairs an attachment the server can no longer honour", () => {
  /** The database linked to APP_A and stopped, then APP_A's network removed behind its back, as the server allows. */
  async function orphaned() {
    const h = await installed(APP_A);
    await h.engine.syncAppStackLinks(link([APP_A]));
    await h.engine.stopAppStack({ stackId: DB, organizationId: ORG });
    h.fake.networks.delete(net(APP_A));
    h.clear();
    return h;
  }
  const start = (h: Harness) => h.engine.startAppStackComponent({ plan: databasePlan(), componentKey: "db", secretFileContents: [] });

  it("a database attached to a network that is gone cannot start until the attachment is removed", async () => {
    const h = await orphaned();
    // The container is there: the refusal names the missing network, never a missing container, a network or an id.
    expect(await failure(start(h))).toMatchObject({
      reason: "STACK_COMPONENT_NOT_READY",
      message: "Component db is attached to a network that is missing",
    });
    h.clear();
    await expect(h.engine.syncAppStackLinks(link([]))).resolves.toEqual({ container: true, links: [], disconnected: [APP_A] });
    expect(mutations(h.fake.log)).toEqual([disconnectLine(APP_A)]);
    expect(h.fake.bodies.get(disconnectLine(APP_A))).toEqual([{ Container: idOf(h, DB_CONTAINER), Force: true }]);
    await expect(start(h)).resolves.toEqual({ componentKey: "db", outcome: "started" });
  });

  it("a link still declared loses the attachment too, and waits for the network", async () => {
    const h = await orphaned();
    await expect(h.engine.syncAppStackLinks(link([APP_A]))).resolves.toEqual({
      container: true,
      links: [{ consumerStackId: APP_A, outcome: "pending" }],
      disconnected: [],
    });
    expect(mutations(h.fake.log)).toEqual([disconnectLine(APP_A)]);
    await expect(start(h)).resolves.toEqual({ componentKey: "db", outcome: "started" });
  });

  it("a network made again under the same name gets a new attachment", async () => {
    const h = await orphaned();
    await h.fake.request("POST", "/networks/create", {
      Name: net(APP_A),
      Driver: "bridge",
      Internal: true,
      Labels: appStackNetworkLabels({ stackId: APP_A, organizationId: ORG }, "app_internal"),
    });
    h.clear();
    await expect(h.engine.syncAppStackLinks(link([APP_A]))).resolves.toEqual({
      container: true,
      links: [{ consumerStackId: APP_A, outcome: "connected" }],
      disconnected: [],
    });
    expect(mutations(h.fake.log)).toEqual([disconnectLine(APP_A), connectLine(APP_A)]);
    await expect(start(h)).resolves.toEqual({ componentKey: "db", outcome: "started" });
    expect(h.fake.containers.get(DB_CONTAINER)?.endpoints.get(net(APP_A))).toEqual({
      networkId: h.fake.networks.get(net(APP_A))?.Id,
      aliases: [ALIAS],
    });
  });

  it("an attachment without the database's name is made again; one whose names the server does not report is kept", async () => {
    const h = await installed(APP_A, APP_B);
    await h.fake.request("POST", `/networks/${net(APP_A)}/connect`, { Container: DB_CONTAINER });
    await h.fake.request("POST", `/networks/${net(APP_B)}/connect`, { Container: DB_CONTAINER });
    (h.fake.containers.get(DB_CONTAINER)?.endpoints.get(net(APP_B)) as { aliases: string[] | null }).aliases = null;
    h.clear();
    await expect(h.engine.syncAppStackLinks(link([APP_A, APP_B]))).resolves.toEqual({
      container: true,
      links: [
        { consumerStackId: APP_A, outcome: "connected" },
        { consumerStackId: APP_B, outcome: "already_connected" },
      ],
      disconnected: [],
    });
    expect(mutations(h.fake.log)).toEqual([disconnectLine(APP_A), connectLine(APP_A)]);
    expect(h.fake.containers.get(DB_CONTAINER)?.endpoints.get(net(APP_A))?.aliases).toEqual([ALIAS]);
  });
});

describe("removeAppStack of an application a database is linked to", () => {
  const remove = (h: Harness, stackId = APP_A) => h.engine.removeAppStack({ stackId, organizationId: ORG, removeVolumes: true });
  const removeLine = `DELETE /networks/${net(APP_A)}`;

  it.each([
    ["running", false],
    ["stopped", true],
  ])("detaches the %s database before the private network goes, and leaves the database alone", async (_name, stopped) => {
    const h = await installed(APP_A, APP_B);
    await h.engine.syncAppStackLinks(link([APP_A, APP_B]));
    if (stopped) await h.engine.stopAppStack({ stackId: DB, organizationId: ORG });
    const database = idOf(h, DB_CONTAINER);
    h.clear();
    await expect(remove(h)).resolves.toMatchObject({ removedComponents: ["web"], removedNetworks: ["app_internal"] });
    const changed = mutations(h.fake.log);
    expect(changed.filter((line) => line.includes("/networks/"))).toEqual([disconnectLine(APP_A), removeLine]);
    expect(h.fake.bodies.get(disconnectLine(APP_A))).toEqual([{ Container: database, Force: true }]);
    expect(changed.filter((line) => line.includes(database))).toEqual([]);
    expect(h.fake.networks.has(net(APP_A))).toBe(false);
    expect(idOf(h, DB_CONTAINER)).toBe(database);
    expect(h.fake.containers.get(DB_CONTAINER)?.State.Running).toBe(!stopped);
    expect(attachedTo(h)).toEqual([net(DB), net(APP_B)].sort());
    // A stopped database starts again: nothing of the removed network is left on it.
    await expect(
      h.engine.startAppStackComponent({ plan: databasePlan(), componentKey: "db", secretFileContents: [] }),
    ).resolves.toEqual({ componentKey: "db", outcome: stopped ? "started" : "already_running" });
  });

  it("removing the database takes it off every application's network with its container", async () => {
    const h = await installed(APP_A);
    await h.engine.syncAppStackLinks(link([APP_A]));
    h.clear();
    await expect(remove(h, DB)).resolves.toMatchObject({ removedComponents: ["db"], removedNetworks: ["app_internal"] });
    expect([...(h.fake.networks.get(net(APP_A))?.members ?? [])]).toEqual([container(APP_A, "web")]);
    expect(mutations(h.fake.log).filter((line) => line.includes(net(APP_A)))).toEqual([]);
  });

  it("detaches once more when a database was attached between the list and the removal", async () => {
    const h = await installed(APP_A);
    await h.engine.syncAppStackLinks(link([APP_A]));
    h.clear();
    h.fake.failNext(new RegExp(`^${removeLine}$`), 409, JSON.stringify({ message: "network has active endpoints" }));
    await expect(remove(h)).resolves.toMatchObject({ removedNetworks: ["app_internal"] });
    expect(mutations(h.fake.log).filter((line) => line.includes("/networks/"))).toEqual([disconnectLine(APP_A), removeLine, removeLine]);
    expect(h.fake.networks.has(net(APP_A))).toBe(false);
  });

  it("fails, and keeps the network, when the database cannot be detached", async () => {
    const h = await installed(APP_A);
    await h.engine.syncAppStackLinks(link([APP_A]));
    h.clear();
    h.fake.failNext(new RegExp(`^${disconnectLine(APP_A)}$`), 500);
    expect(await failure(remove(h))).toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
      message: "Failed to detach a database from an application (HTTP 500)",
    });
    expect(mutations(h.fake.log)).not.toContain(removeLine);
    expect(attachedTo(h)).toEqual([net(DB), net(APP_A)].sort());
  });

  it("detaches nothing that is not a component of an application of the same customer", async () => {
    const h = await installed(APP_A);
    // A database of another customer, and a container nobody labelled, found on the application's network.
    await install(h, databasePlan(DB.replace("0123", "9999"), OTHER_ORG));
    const stranger = container(DB.replace("0123", "9999"), "db");
    await h.fake.request("POST", `/networks/${net(APP_A)}/connect`, { Container: stranger });
    await h.fake.request("POST", "/containers/create?name=squatter", { Image: "traefik:test", HostConfig: { NetworkMode: net(APP_A) } });
    h.clear();
    expect(await failure(remove(h))).toMatchObject({
      reason: "STACK_NAMESPACE_CONFLICT",
      message: "A stack network is still used by another container",
    });
    expect(mutations(h.fake.log).filter((line) => line.endsWith("/disconnect"))).toEqual([]);
    expect(attachedTo(h, stranger)).toContain(net(APP_A));
    expect(h.fake.networks.has(net(APP_A))).toBe(true);
  });
});

describe("the simulator keeps the same contract", () => {
  const simulator = () => new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST });
  async function deploy(sim: InMemoryDockerSimulatorAdapter, plan: ApprovedStackPlan, options: { start?: boolean } = {}) {
    await sim.pullAppStackImage({ plan, image: IMAGE });
    await sim.prepareAppStack({ plan });
    await sim.createAppStackComponents({ plan });
    if (options.start !== false) {
      for (const c of plan.components) await sim.startAppStackComponent({ plan, componentKey: c.key, secretFileContents: [] });
    }
  }
  const linkMutations = (sim: InMemoryDockerSimulatorAdapter) =>
    sim.appStacks.appStackMutations.filter((m) => m.kind === "network_connect" || m.kind === "network_disconnect");

  it("attaches, reports what is already attached, and detaches what is no longer declared", async () => {
    const sim = simulator();
    await deploy(sim, databasePlan());
    await deploy(sim, applicationPlan(APP_A));
    await deploy(sim, applicationPlan(APP_B));
    const result = await sim.syncAppStackLinks(link([APP_B, APP_A, APP_C]));
    expect(result).toEqual({
      container: true,
      links: [
        { consumerStackId: APP_B, outcome: "connected" },
        { consumerStackId: APP_A, outcome: "connected" },
        { consumerStackId: APP_C, outcome: "pending" },
      ],
      disconnected: [],
    });
    expect(AppStackLinksIpcResultSchema.parse(result)).toEqual(result);
    expect(linkMutations(sim)).toEqual([
      { kind: "network_connect", name: net(APP_B) },
      { kind: "network_connect", name: net(APP_A) },
    ]);
    expect(sim.appStacks.getAppStackLinkedApplications(DB)).toEqual([APP_A, APP_B]);
    expect(sim.appStacks.appStackCalls.at(-1)).toEqual({ method: "syncAppStackLinks", stackId: DB, componentKey: "db" });

    await expect(sim.syncAppStackLinks(link([APP_A]))).resolves.toEqual({
      container: true,
      links: [{ consumerStackId: APP_A, outcome: "already_connected" }],
      disconnected: [APP_B],
    });
    expect(linkMutations(sim).at(-1)).toEqual({ kind: "network_disconnect", name: net(APP_B) });
    await expect(sim.syncAppStackLinks(link([]))).resolves.toEqual({ container: true, links: [], disconnected: [APP_A] });
    expect(sim.appStacks.getAppStackLinkedApplications(DB)).toEqual([]);
  });

  it("changes nothing while the database has no component, and a new component starts without links", async () => {
    const sim = simulator();
    await deploy(sim, applicationPlan(APP_A));
    const waiting = { container: false, links: [{ consumerStackId: APP_A, outcome: "pending" }], disconnected: [] };
    await expect(sim.syncAppStackLinks(link([APP_A]))).resolves.toEqual(waiting);
    await deploy(sim, databasePlan(), { start: false });
    await expect(sim.syncAppStackLinks(link([APP_A]))).resolves.toMatchObject({ container: true, links: [{ outcome: "connected" }] });
    await sim.removeAppStackComponents({ plan: databasePlan(), componentKeys: ["db"] });
    await expect(sim.syncAppStackLinks(link([APP_A]))).resolves.toEqual(waiting);
    await sim.createAppStackComponents({ plan: databasePlan() });
    expect(sim.appStacks.getAppStackLinkedApplications(DB)).toEqual([]);
    await expect(sim.syncAppStackLinks(link([APP_A]))).resolves.toMatchObject({ links: [{ consumerStackId: APP_A, outcome: "connected" }] });
    expect(linkMutations(sim)).toEqual([
      { kind: "network_connect", name: net(APP_A) },
      { kind: "network_connect", name: net(APP_A) },
    ]);
  });

  it("refuses what the engine refuses", async () => {
    const sim = simulator();
    await deploy(sim, databasePlan());
    await deploy(sim, applicationPlan(APP_A, OTHER_ORG));
    expect(await failure(sim.syncAppStackLinks(link([APP_A])))).toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    expect(await failure(sim.syncAppStackLinks(link([], { organizationId: OTHER_ORG })))).toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    expect(await failure(sim.syncAppStackLinks(link([DB])))).toMatchObject({ reason: "STACK_PLAN_INVALID" });
    expect(await failure(sim.syncAppStackLinks(link([], { stackId: "stk_0123456789abcdef" })))).toMatchObject({ reason: "STACK_PLAN_INVALID" });
    expect(await failure(sim.syncAppStackLinks(link([], { componentKey: "cache" })))).toMatchObject({
      reason: "STACK_PLAN_INVALID",
      message: "Only an application with one component can be linked",
    });
    expect(linkMutations(sim)).toEqual([]);
  });

  it("takes the faults a test injects in the links step", async () => {
    const sim = simulator();
    await deploy(sim, databasePlan());
    await deploy(sim, applicationPlan(APP_A));
    sim.appStacks.failNextAppStackStep("links", "engine_unavailable");
    expect(await failure(sim.syncAppStackLinks(link([APP_A])))).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(sim.appStacks.getAppStackLinkedApplications(DB)).toEqual([]);
    sim.appStacks.failNextAppStackStep("links", "ambiguous_after");
    expect(await failure(sim.syncAppStackLinks(link([APP_A])))).toMatchObject({ code: "OPERATION_AMBIGUOUS", ambiguousOutcome: true });
    expect(sim.appStacks.getAppStackLinkedApplications(DB)).toEqual([APP_A]);
    await expect(sim.syncAppStackLinks(link([APP_A]))).resolves.toMatchObject({ links: [{ outcome: "already_connected" }] });
  });

  it("removing an application detaches the databases linked to it", async () => {
    const sim = simulator();
    await deploy(sim, databasePlan());
    await deploy(sim, applicationPlan(APP_A));
    await sim.syncAppStackLinks(link([APP_A]));
    await sim.removeAppStack({ stackId: APP_A, organizationId: ORG, removeVolumes: true });
    expect(sim.appStacks.getAppStackLinkedApplications(DB)).toEqual([]);
    const kinds = sim.appStacks.appStackMutations.filter((m) => m.name === net(APP_A)).map((m) => m.kind);
    expect(kinds.slice(-2)).toEqual(["network_disconnect", "network_remove"]);
    await expect(sim.syncAppStackLinks(link([APP_A]))).resolves.toMatchObject({ links: [{ consumerStackId: APP_A, outcome: "pending" }] });
  });
});
