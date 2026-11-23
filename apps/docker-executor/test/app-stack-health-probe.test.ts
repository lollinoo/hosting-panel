import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_STACK_HTTP_PROBE_BODY_MAX_BYTES, probeAppStackHealth, type AppStackProbeTarget } from "../src/app-stacks/index.js";

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function listen(server: net.Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket: net.Socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function tcp(port: number, address = "127.0.0.1"): AppStackProbeTarget {
  return { address, componentKey: "web", health: { kind: "tcp", port, timeoutSeconds: 1 } };
}

function httpTarget(port: number, timeoutSeconds = 1, address = "127.0.0.1"): AppStackProbeTarget {
  return { address, componentKey: "web", health: { kind: "http", port, timeoutSeconds, path: "/healthz" } };
}

describe("probeAppStackHealth", () => {
  it("passes a tcp probe when the port accepts and fails it when the port is closed", async () => {
    const port = await listen(net.createServer());
    await expect(probeAppStackHealth(tcp(port))).resolves.toBe("passed");
    await expect(probeAppStackHealth(tcp(await closedPort()))).resolves.toBe("failed");
  });

  it("passes an http 200 with a plain GET of the plan path", async () => {
    const seen: http.IncomingMessage[] = [];
    const port = await listen(
      http.createServer((request, response) => {
        seen.push(request);
        response.end("ok");
      }),
    );
    await expect(probeAppStackHealth(httpTarget(port))).resolves.toBe("passed");
    expect(seen.map((request) => [request.method, request.url, request.headers.host])).toEqual([["GET", "/healthz", "web"]]);
  });

  it("passes an http 302 and never contacts the redirect target", async () => {
    let redirectHits = 0;
    const redirectPort = await listen(
      http.createServer((_request, response) => {
        redirectHits += 1;
        response.end();
      }),
    );
    const port = await listen(
      http.createServer((_request, response) => {
        response.writeHead(302, { Location: `http://127.0.0.1:${redirectPort}/elsewhere` }).end();
      }),
    );
    await expect(probeAppStackHealth(httpTarget(port))).resolves.toBe("passed");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(redirectHits).toBe(0);
  });

  it.each([404, 500])("fails an http %i", async (status) => {
    const port = await listen(http.createServer((_request, response) => response.writeHead(status).end()));
    await expect(probeAppStackHealth(httpTarget(port))).resolves.toBe("failed");
  });

  it("fails a silent server within the timeout plus 100 ms", async () => {
    const port = await listen(net.createServer());
    const started = Date.now();
    await expect(probeAppStackHealth(httpTarget(port))).resolves.toBe("failed");
    expect(Date.now() - started).toBeLessThan(1_100);
  });

  it("cuts a 1 MiB body: the result comes before the body ends and the socket is destroyed", async () => {
    let serverSocketClosed: Promise<unknown> = Promise.resolve();
    const port = await listen(
      http.createServer((request, response) => {
        serverSocketClosed = new Promise((resolve) => request.socket.once("close", resolve));
        response.writeHead(200);
        response.write(Buffer.alloc(1024 * 1024, 0x61));
      }),
    );
    expect(APP_STACK_HTTP_PROBE_BODY_MAX_BYTES).toBe(65_536);
    const started = Date.now();
    await expect(probeAppStackHealth(httpTarget(port, 5))).resolves.toBe("passed");
    expect(Date.now() - started).toBeLessThan(1_000);
    await serverSocketClosed;
  });

  it("passes a 200 as soon as the head arrives, even when the body never ends", async () => {
    const port = await listen(
      http.createServer((_request, response) => {
        response.writeHead(200, { "Content-Length": "100" });
        response.write("0123456789");
      }),
    );
    const started = Date.now();
    await expect(probeAppStackHealth(httpTarget(port))).resolves.toBe("passed");
    expect(Date.now() - started).toBeLessThan(900);
  });

  it.each(["0.0.0.0", "169.254.169.254", "224.0.0.1", "not-an-ip"])("refuses %s with no connection attempt", async (address) => {
    let connections = 0;
    const server = net.createServer();
    server.on("connection", () => (connections += 1));
    const port = await listen(server);
    const connect = vi.spyOn(net, "connect");
    const request = vi.spyOn(http, "request");
    await expect(probeAppStackHealth(tcp(port, address))).resolves.toBe("failed");
    await expect(probeAppStackHealth(httpTarget(port, 1, address))).resolves.toBe("failed");
    expect(connect).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(connections).toBe(0);
  });

  it.each([
    { kind: "tcp", port: 0, timeoutSeconds: 1 },
    { kind: "tcp", port: 8080, timeoutSeconds: 31 },
    { kind: "http", port: 8080, timeoutSeconds: 3, path: "/../x" },
  ] as const)("refuses a tampered health target %j with no connection attempt", async (health) => {
    const connect = vi.spyOn(net, "connect");
    const request = vi.spyOn(http, "request");
    await expect(probeAppStackHealth({ address: "127.0.0.1", componentKey: "web", health })).resolves.toBe("failed");
    expect(connect).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});
