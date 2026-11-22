import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerEngineSocketAdapter,
  INGRESS_PROXY_CONTAINER_NAME,
  type PanelIngressConfig,
} from "../src/index.js";
import { startMockDockerDaemon } from "./mock-docker-daemon.js";

const panel: PanelIngressConfig = {
  hostname: "srv12.example.it",
  ipv4: "203.0.113.10",
  acmeEmail: "ops@example.it",
  acmeStaging: false,
  acmeCaServer: null,
  acmeCaCertFile: null,
  upstreamPort: 3000,
};

const SITE_EDGES = ["hp_edge_site_a_net", "hp_edge_site_b_net"];
const APP_EDGE = "hp_appedge_shop";

describe("ingress proxy re-attach to application edge networks (M4, L17)", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const task of cleanupTasks.splice(0).reverse()) await task();
  });

  async function setup(withAppEdge: boolean) {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const tmpBaseDir = await mkdtemp(path.join(os.tmpdir(), "hp-proxy-reattach-"));
    cleanupTasks.push(() => rm(tmpBaseDir, { recursive: true, force: true }));
    const mockDaemon = await startMockDockerDaemon();
    cleanupTasks.push(() => mockDaemon.close());
    for (const name of SITE_EDGES) {
      mockDaemon.createdNetworks.push({ Name: name, Labels: { "io.hostingpanel.network_role": "site_edge" } });
    }
    mockDaemon.createdNetworks.push({
      Name: "hp_appnet_shop",
      Labels: { "io.hostingpanel.network_role": "app_internal" },
    });
    if (withAppEdge) {
      mockDaemon.createdNetworks.push({ Name: APP_EDGE, Labels: { "io.hostingpanel.network_role": "app_edge" } });
    }
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: mockDaemon.socketPath,
      secretsRootDir: path.join(tmpBaseDir, "secrets"),
      ingressRootDir: path.join(tmpBaseDir, "ingress"),
      pullMissingImages: false,
      panel,
    });
    const proxyConnects = () =>
      mockDaemon.networkConnectCalls
        .filter((c) => c.container === INGRESS_PROXY_CONTAINER_NAME)
        .map((c) => c.network)
        .sort();
    const proxy = () => [...mockDaemon.containers.values()].find((c) => c.name === INGRESS_PROXY_CONTAINER_NAME);
    return { adapter, mockDaemon, proxyConnects, proxy };
  }

  it("connects the proxy to the app_edge and site_edge networks, again after a drift recreate", async () => {
    const { adapter, mockDaemon, proxyConnects, proxy } = await setup(true);
    await adapter.ensureIngressProxy();
    expect(proxyConnects()).toEqual([...SITE_EDGES, APP_EDGE].sort());

    mockDaemon.networkConnectCalls.length = 0;
    const first = proxy();
    if (first) first.hostConfig = { ...first.hostConfig, ExtraHosts: [] };
    await adapter.ensureIngressProxy();
    expect(proxy()?.id).not.toBe(first?.id);
    expect(proxyConnects()).toEqual([...SITE_EDGES, APP_EDGE].sort());
  });

  it("still resolves running with the site edges connected when the app_edge list answers 500", async () => {
    const { adapter, proxyConnects } = await setup(true);
    const client = (
      adapter as unknown as {
        dockerClient: { request: (m: string, p: string, ...rest: unknown[]) => Promise<{ statusCode: number }> };
      }
    ).dockerClient;
    const original = client.request.bind(client);
    vi.spyOn(client, "request").mockImplementation((m, p, ...rest) =>
      m === "GET" && p.startsWith("/networks?") && decodeURIComponent(p).includes("app_edge")
        ? Promise.resolve({ statusCode: 500, headers: {}, body: Buffer.from("{}") })
        : original(m, p, ...rest),
    );
    await expect(adapter.ensureIngressProxy()).resolves.toMatchObject({ status: "running" });
    expect(proxyConnects()).toEqual(SITE_EDGES);
  });

  it("still resolves running when connecting an app_edge network answers 500", async () => {
    const { adapter, mockDaemon, proxyConnects } = await setup(true);
    mockDaemon.brokenNetworks.connect.add(APP_EDGE);
    await expect(adapter.ensureIngressProxy()).resolves.toMatchObject({ status: "running" });
    expect(proxyConnects()).toEqual([...SITE_EDGES, APP_EDGE].sort());
  });

  it("connects every other app_edge network when the first connect answers 500", async () => {
    const { adapter, mockDaemon, proxy } = await setup(true);
    const others = ["hp_appedge_blog", "hp_appedge_wiki"];
    for (const name of others) {
      mockDaemon.createdNetworks.push({ Name: name, Labels: { "io.hostingpanel.network_role": "app_edge" } });
    }
    mockDaemon.brokenNetworks.connect.add(APP_EDGE);
    await expect(adapter.ensureIngressProxy()).resolves.toMatchObject({ status: "running" });
    expect(proxy()?.running).toBe(true);
    const attached = Object.keys(proxy()?.networks ?? {});
    expect(attached).toEqual(expect.arrayContaining([...SITE_EDGES, ...others]));
    expect(attached).not.toContain(APP_EDGE);
  });

  it("with no app_edge network connects exactly the site edge networks", async () => {
    const { adapter, proxyConnects } = await setup(false);
    await adapter.ensureIngressProxy();
    expect(proxyConnects()).toEqual(SITE_EDGES);
  });
});
