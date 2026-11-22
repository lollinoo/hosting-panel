import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeAppStackHealthLabel, probeAppStackHealth, type AppStackProbeTarget } from "../src/app-stacks/index.js";

// Q4: bounds of the L18 health probe (arch-executor §5.6) against hostile or broken local servers.

const servers: net.Server[] = [];
const sockets: net.Socket[] = [];
const timers: NodeJS.Timeout[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const timer of timers.splice(0)) clearInterval(timer);
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

function httpTarget(port: number, timeoutSeconds = 1, path = "/healthz"): AppStackProbeTarget {
  return { address: "127.0.0.1", componentKey: "web", health: { kind: "http", port, timeoutSeconds, path } };
}

function tcpTarget(port: number, timeoutSeconds = 1): AppStackProbeTarget {
  return { address: "127.0.0.1", componentKey: "web", health: { kind: "tcp", port, timeoutSeconds } };
}

/** Raw TCP server that answers every connection with `reply` after reading the request head. */
function rawServer(onConnection: (socket: net.Socket) => void): net.Server {
  return net.createServer((socket) => {
    socket.once("data", () => onConnection(socket));
  });
}

async function timed<T>(work: Promise<T>): Promise<{ result: T; ms: number }> {
  const started = Date.now();
  const result = await work;
  return { result, ms: Date.now() - started };
}

describe("probeAppStackHealth: hostile servers", () => {
  it("bounds a slow-loris body by the deadline and destroys the connection", async () => {
    let closed: Promise<unknown> = Promise.resolve();
    const port = await listen(
      rawServer((socket) => {
        closed = new Promise((resolve) => socket.once("close", resolve));
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n");
        timers.push(setInterval(() => socket.write("1\r\na\r\n"), 50));
      }),
    );
    const { result, ms } = await timed(probeAppStackHealth(httpTarget(port, 1)));
    expect(["passed", "failed"]).toContain(result);
    expect(ms).toBeLessThan(1_200);
    await closed;
  });

  it("bounds a slow-loris response head (bytes of the status line dribbled out) and fails", async () => {
    let closed: Promise<unknown> = Promise.resolve();
    const port = await listen(
      rawServer((socket) => {
        closed = new Promise((resolve) => socket.once("close", resolve));
        const head = "HTTP/1.1 200 OK\r\nX-Slow: ".split("");
        timers.push(setInterval(() => socket.write(head.shift() ?? "a"), 50));
      }),
    );
    const { result, ms } = await timed(probeAppStackHealth(httpTarget(port, 1)));
    expect(result).toBe("failed");
    expect(ms).toBeLessThan(1_200);
    await closed;
  });

  it("fails fast on a header flood without waiting for the deadline", async () => {
    let closed: Promise<unknown> = Promise.resolve();
    const port = await listen(
      rawServer((socket) => {
        closed = new Promise((resolve) => socket.once("close", resolve));
        socket.write("HTTP/1.1 200 OK\r\n");
        const junk = `X-Junk: ${"a".repeat(1_000)}\r\n`;
        // Never terminates the header block; stops once the client hangs up.
        const flood = setInterval(() => {
          if (!socket.destroyed) socket.write(junk);
        }, 1);
        timers.push(flood);
      }),
    );
    const { result, ms } = await timed(probeAppStackHealth(httpTarget(port, 5)));
    expect(result).toBe("failed");
    expect(ms).toBeLessThan(2_000);
    await closed;
  });

  it("fails a header flood of many small headers within the deadline plus 200 ms", async () => {
    const port = await listen(
      rawServer((socket) => {
        socket.write("HTTP/1.1 200 OK\r\n");
        let index = 0;
        timers.push(setInterval(() => !socket.destroyed && socket.write(`X-${index++}: v\r\n`), 1));
      }),
    );
    const { result, ms } = await timed(probeAppStackHealth(httpTarget(port, 1)));
    expect(result).toBe("failed");
    expect(ms).toBeLessThan(1_200);
  });

  it("never follows a redirect loop: one request, the 3xx passes", async () => {
    let hits = 0;
    const paths: string[] = [];
    const port = await listen(
      http.createServer((request, response) => {
        hits += 1;
        paths.push(request.url ?? "");
        response.writeHead(302, { Location: "/healthz" }).end();
      }),
    );
    await expect(probeAppStackHealth(httpTarget(port, 2))).resolves.toBe("passed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(hits).toBe(1);
    expect(paths).toEqual(["/healthz"]);
  });

  it("never follows a redirect to another host or port (301/307/308 pass, target untouched)", async () => {
    let targetHits = 0;
    const targetPort = await listen(
      http.createServer((_request, response) => {
        targetHits += 1;
        response.end();
      }),
    );
    for (const status of [301, 307, 308]) {
      const port = await listen(
        http.createServer((_request, response) => {
          response.writeHead(status, { Location: `http://127.0.0.1:${targetPort}/x` }).end();
        }),
      );
      await expect(probeAppStackHealth(httpTarget(port, 2))).resolves.toBe("passed");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(targetHits).toBe(0);
  });

  it.each([
    { name: "200 with a body closed by the server", reply: "HTTP/1.0 200 OK\r\n\r\nhello", expected: "passed" },
    { name: "200 without any body", reply: "HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n", expected: "passed" },
    { name: "302", reply: "HTTP/1.0 302 Found\r\nLocation: /elsewhere\r\n\r\n", expected: "passed" },
    { name: "404", reply: "HTTP/1.0 404 Not Found\r\n\r\nno", expected: "failed" },
    { name: "503", reply: "HTTP/1.0 503 Service Unavailable\r\n\r\n", expected: "failed" },
  ] as const)("handles an HTTP/1.0 server: $name -> $expected", async ({ reply, expected }) => {
    const port = await listen(rawServer((socket) => socket.end(reply)));
    const { result, ms } = await timed(probeAppStackHealth(httpTarget(port, 2)));
    expect(result).toBe(expected);
    expect(ms).toBeLessThan(1_000);
  });

  it("resolves an HTTP/1.0 server that streams until close past 64 KiB without waiting for the end", async () => {
    let closed: Promise<unknown> = Promise.resolve();
    const port = await listen(
      rawServer((socket) => {
        closed = new Promise((resolve) => socket.once("close", resolve));
        socket.write("HTTP/1.0 200 OK\r\n\r\n");
        timers.push(setInterval(() => !socket.destroyed && socket.write(Buffer.alloc(16_384, 0x62)), 1));
      }),
    );
    const { result, ms } = await timed(probeAppStackHealth(httpTarget(port, 5)));
    expect(result).toBe("passed");
    expect(ms).toBeLessThan(1_500);
    await closed;
  });

  it("fails an http probe whose connection is reset before any response", async () => {
    const port = await listen(net.createServer((socket) => socket.resetAndDestroy()));
    const { result, ms } = await timed(probeAppStackHealth(httpTarget(port, 3)));
    expect(result).toBe("failed");
    expect(ms).toBeLessThan(1_000);
  });

  it("fails an http probe reset after the request was read but before a response", async () => {
    const port = await listen(rawServer((socket) => socket.resetAndDestroy()));
    const { result, ms } = await timed(probeAppStackHealth(httpTarget(port, 3)));
    expect(result).toBe("failed");
    expect(ms).toBeLessThan(1_000);
  });

  it("fails a server that closes with a half response head", async () => {
    const port = await listen(rawServer((socket) => socket.end("HTTP/1.1 200 O")));
    const { result, ms } = await timed(probeAppStackHealth(httpTarget(port, 3)));
    expect(result).toBe("failed");
    expect(ms).toBeLessThan(1_000);
  });

  it("fails a server that answers garbage instead of HTTP", async () => {
    const port = await listen(rawServer((socket) => socket.end("\x00\x01SSH-2.0-nope\r\n\r\n")));
    const { result } = await timed(probeAppStackHealth(httpTarget(port, 3)));
    expect(result).toBe("failed");
  });

  it("never throws or rejects when a reset hits mid-body", async () => {
    const port = await listen(
      rawServer((socket) => {
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\npartial");
        setTimeout(() => socket.resetAndDestroy(), 20);
      }),
    );
    const { result, ms } = await timed(probeAppStackHealth(httpTarget(port, 3)));
    expect(["passed", "failed"]).toContain(result);
    expect(ms).toBeLessThan(1_000);
  });

  it("settles a tcp probe promptly when the server resets right after accept (race: either outcome, never a hang)", async () => {
    const port = await listen(net.createServer((socket) => socket.resetAndDestroy()));
    const { result, ms } = await timed(probeAppStackHealth(tcpTarget(port, 3)));
    expect(["passed", "failed"]).toContain(result);
    expect(ms).toBeLessThan(1_000);
  });

  it("sends only a bounded GET with the plan path, component Host and no body or credentials", async () => {
    const seen: { head: string }[] = [];
    const port = await listen(
      rawServer((socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")).on("connection", (socket) => {
        socket.once("data", (chunk: Buffer) => seen.push({ head: chunk.toString("latin1") }));
      }),
    );
    await expect(probeAppStackHealth(httpTarget(port, 2, "/a/b-c_d.e~f"))).resolves.toBe("passed");
    expect(seen).toHaveLength(1);
    const head = seen[0]?.head ?? "";
    expect(head.startsWith("GET /a/b-c_d.e~f HTTP/1.1\r\n")).toBe(true);
    expect(head).toMatch(/^host: web\r$/im);
    expect(head).not.toMatch(/authorization|cookie|content-length|transfer-encoding/i);
    expect(head.endsWith("\r\n\r\n")).toBe(true);
  });
});

describe("probeAppStackHealth: addresses that are never connected to", () => {
  it.each([
    "::1",
    "::ffff:127.0.0.1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "fe80::1",
    "localhost",
    "",
    " 127.0.0.1",
    "127.0.0.1 ",
    "127.0.0.1\r\nHost: evil",
    "127.0.0.1:80",
    "2130706433",
    "0x7f.0.0.1",
    "127.1",
    "127.000.000.001",
    "256.0.0.1",
    "0.0.0.0",
    "255.255.255.255",
    "240.0.0.1",
    "169.254.169.254",
    "224.0.0.1",
  ])("refuses the address %j for tcp and http with no connection attempt", async (address) => {
    let connections = 0;
    const server = net.createServer();
    server.on("connection", () => (connections += 1));
    const port = await listen(server);
    const connect = vi.spyOn(net, "connect");
    const request = vi.spyOn(http, "request");
    const started = Date.now();
    await expect(probeAppStackHealth({ ...tcpTarget(port), address })).resolves.toBe("failed");
    await expect(probeAppStackHealth({ ...httpTarget(port), address })).resolves.toBe("failed");
    expect(Date.now() - started).toBeLessThan(500);
    expect(connect).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(connections).toBe(0);
  });
});

describe("probeAppStackHealth: tampered health labels", () => {
  it.each([
    "http:8080:3:/../x",
    "http:8080:3:/a/../b",
    "http:8080:3:/./x",
    "http:8080:3:/a//b",
    "http:8080:3:x",
    "http:8080:3:",
    "http:8080:3://evil.example/x",
    "http:8080:3:/x?y=1",
    "http:8080:3:/x#f",
    "http:8080:3:/x y",
    "http:8080:3:/x%2e%2e/y",
    "http:8080:3:/x\r\nHost: evil",
    `http:8080:3:/${"a".repeat(300)}`,
    "http:0:3:/x",
    "tcp:0:3",
    "http:65536:3:/x",
    "tcp:65536:3",
    "http:99999:3:/x",
    "tcp:8080:0",
    "tcp:8080:31",
    "http:8080:31:/x",
    "http:8080:0:/x",
    "tcp:8080:-1",
    "tcp:-1:3",
    "tcp:8080:3.5",
    "tcp:8080:3:extra",
    "tcp:8080",
    "tcp:08080x:3",
    "TCP:8080:3",
    "https:8080:3:/x",
    "udp:8080:3",
    "none ",
    "",
    "tcp:8080:3\nhttp:1:1:/x",
  ])("decodes the label %j as malformed (null)", (label) => {
    expect(decodeAppStackHealthLabel(label)).toBeNull();
  });

  it("decodes the undefined label as malformed and the valid labels exactly", () => {
    expect(decodeAppStackHealthLabel(undefined)).toBeNull();
    expect(decodeAppStackHealthLabel("none")).toEqual({ kind: "none" });
    expect(decodeAppStackHealthLabel("tcp:1:1")).toEqual({ kind: "tcp", port: 1, timeoutSeconds: 1 });
    expect(decodeAppStackHealthLabel("tcp:65535:30")).toEqual({ kind: "tcp", port: 65_535, timeoutSeconds: 30 });
    expect(decodeAppStackHealthLabel("http:8080:3:/healthz")).toEqual({
      kind: "http",
      port: 8080,
      timeoutSeconds: 3,
      path: "/healthz",
    });
  });

  it.each([
    { name: "path traversal", health: { kind: "http", port: 0, timeoutSeconds: 3, path: "/../x" } },
    { name: "path traversal in the middle", health: { kind: "http", port: 0, timeoutSeconds: 3, path: "/a/../x" } },
    { name: "query string", health: { kind: "http", port: 0, timeoutSeconds: 3, path: "/x?y=1" } },
    { name: "authority-like path", health: { kind: "http", port: 0, timeoutSeconds: 3, path: "//evil.example/x" } },
    { name: "CRLF in the path", health: { kind: "http", port: 0, timeoutSeconds: 3, path: "/x\r\nHost: evil" } },
    { name: "relative path", health: { kind: "http", port: 0, timeoutSeconds: 3, path: "x" } },
    { name: "empty path", health: { kind: "http", port: 0, timeoutSeconds: 3, path: "" } },
  ] as const)("fails a tampered http target ($name) without any connection, even with a live port", async ({ health }) => {
    let connections = 0;
    const server = net.createServer();
    server.on("connection", () => (connections += 1));
    const port = await listen(server);
    const connect = vi.spyOn(net, "connect");
    const request = vi.spyOn(http, "request");
    const started = Date.now();
    await expect(
      probeAppStackHealth({ address: "127.0.0.1", componentKey: "web", health: { ...health, port } }),
    ).resolves.toBe("failed");
    expect(Date.now() - started).toBeLessThan(500);
    expect(connect).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(connections).toBe(0);
  });

  it.each([
    { name: "port 0", health: { kind: "tcp", port: 0, timeoutSeconds: 1 } },
    { name: "port 65536", health: { kind: "tcp", port: 65_536, timeoutSeconds: 1 } },
    { name: "negative port", health: { kind: "tcp", port: -1, timeoutSeconds: 1 } },
    { name: "fractional port", health: { kind: "tcp", port: 80.5, timeoutSeconds: 1 } },
    { name: "NaN port", health: { kind: "tcp", port: Number.NaN, timeoutSeconds: 1 } },
    { name: "http port 0", health: { kind: "http", port: 0, timeoutSeconds: 1, path: "/x" } },
    { name: "http port 65536", health: { kind: "http", port: 65_536, timeoutSeconds: 1, path: "/x" } },
  ] as const)("fails a tampered port ($name) without any connection", async ({ health }) => {
    const connect = vi.spyOn(net, "connect");
    const request = vi.spyOn(http, "request");
    await expect(probeAppStackHealth({ address: "127.0.0.1", componentKey: "web", health })).resolves.toBe("failed");
    expect(connect).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([0, 31, 3600, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "fails a tampered timeout %s immediately and without any connection, for tcp and http",
    async (timeoutSeconds) => {
      let connections = 0;
      const server = net.createServer();
      server.on("connection", () => (connections += 1));
      const port = await listen(server);
      const connect = vi.spyOn(net, "connect");
      const request = vi.spyOn(http, "request");
      const started = Date.now();
      await expect(probeAppStackHealth(tcpTarget(port, timeoutSeconds))).resolves.toBe("failed");
      await expect(probeAppStackHealth(httpTarget(port, timeoutSeconds))).resolves.toBe("failed");
      expect(Date.now() - started).toBeLessThan(500);
      expect(connect).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(connections).toBe(0);
    },
  );

  it.each(["", "Web", "web_x", "1web", "web\r\nX: y", "a".repeat(40), "web x"])(
    "fails a tampered component key %j without any connection",
    async (componentKey) => {
      const connect = vi.spyOn(net, "connect");
      const request = vi.spyOn(http, "request");
      const port = await listen(net.createServer());
      await expect(probeAppStackHealth({ ...httpTarget(port), componentKey })).resolves.toBe("failed");
      await expect(probeAppStackHealth({ ...tcpTarget(port), componentKey })).resolves.toBe("failed");
      expect(connect).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );
});

describe("probeAppStackHealth: parallel probes", () => {
  it("finishes the probes of eight components within the largest timeout plus 200 ms", async () => {
    const timeouts = [1, 1, 1, 1, 2, 2, 2, 2];
    const targets: AppStackProbeTarget[] = [];
    for (const [index, timeoutSeconds] of timeouts.entries()) {
      // Half the components are silent http servers (deadline), half are silent tcp-accepting servers probed over http.
      const port = await listen(net.createServer());
      targets.push({
        address: "127.0.0.1",
        componentKey: `c${index}`,
        health: { kind: "http", port, timeoutSeconds, path: "/healthz" },
      });
    }
    const { result, ms } = await timed(Promise.all(targets.map((target) => probeAppStackHealth(target))));
    expect(result).toEqual(Array.from({ length: 8 }, () => "failed"));
    expect(ms).toBeLessThan(Math.max(...timeouts) * 1000 + 200);
    // Run in parallel: the sum of the deadlines would be 12 s.
    expect(ms).toBeGreaterThanOrEqual(Math.max(...timeouts) * 1000 - 100);
  });

  it("keeps each outcome independent: a fast pass is not delayed by slow neighbours", async () => {
    const slow = await listen(net.createServer());
    const ok = await listen(http.createServer((_request, response) => response.end("ok")));
    const closed = await (async () => {
      const server = net.createServer();
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = server.address() as AddressInfo;
      await new Promise((resolve) => server.close(resolve));
      return port;
    })();
    const started = Date.now();
    const finishedAt: number[] = [];
    const track = async (target: AppStackProbeTarget): Promise<"passed" | "failed"> => {
      const outcome = await probeAppStackHealth(target);
      finishedAt.push(Date.now() - started);
      return outcome;
    };
    const outcomes = await Promise.all([
      track(httpTarget(slow, 2)),
      track(httpTarget(ok, 2)),
      track(tcpTarget(closed, 2)),
      track(tcpTarget(ok, 2)),
    ]);
    expect(outcomes).toEqual(["failed", "passed", "failed", "passed"]);
    // Three probes settle at once; only the silent one waits for its deadline.
    expect(finishedAt.filter((ms) => ms < 500)).toHaveLength(3);
    expect(Math.max(...finishedAt)).toBeLessThan(2_200);
  });
});
