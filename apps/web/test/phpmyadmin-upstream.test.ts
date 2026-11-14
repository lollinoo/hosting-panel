import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPhpMyAdminUpstream } from "@/lib/phpmyadmin-upstream";

interface TestServerHandle {
  url: string;
  close: () => Promise<void>;
  activeSockets: () => number;
}

async function startHttpTestServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<TestServerHandle> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    activeSockets: () => sockets.size,
    close: async () => {
      for (const s of sockets) {
        s.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("fetchPhpMyAdminUpstream", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("sets no timeout of any kind on the HTTP request or socket", async () => {
    const requestSpy = vi.spyOn(http, "request");
    const srv = await startHttpTestServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
    cleanups.push(srv.close);

    const res = await fetchPhpMyAdminUpstream(`${srv.url}/ping`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    expect(requestSpy).toHaveBeenCalledTimes(1);
    const reqOpts = requestSpy.mock.calls[0]?.[1] as http.RequestOptions | undefined;
    expect(reqOpts?.timeout).toBeUndefined();
    const clientReq = requestSpy.mock.results[0]?.value as http.ClientRequest | undefined;
    const seenSocketTimeout = clientReq?.socket?.timeout;
    expect(seenSocketTimeout).toBeUndefined();
  });

  it("forwards method, headers, exact content-length, and streams request body without buffering", async () => {
    let seenMethod = "";
    let seenUrl = "";
    let seenHeaders: http.IncomingHttpHeaders = {};
    const serverChunks: string[] = [];
    let markFirstChunkReceived!: () => void;
    const firstChunkReceived = new Promise<void>((resolve) => {
      markFirstChunkReceived = resolve;
    });

    const srv = await startHttpTestServer((req, res) => {
      seenMethod = req.method ?? "";
      seenUrl = req.url ?? "";
      seenHeaders = req.headers;
      req.on("data", (chunk: Buffer) => {
        serverChunks.push(chunk.toString("utf8"));
        if (serverChunks.length === 1) {
          markFirstChunkReceived();
        }
      });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(serverChunks.join(""));
      });
    });
    cleanups.push(srv.close);

    const encoder = new TextEncoder();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });

    const payloadPart1 = "hello-";
    const payloadPart2 = "world!";
    const totalLength = Buffer.byteLength(payloadPart1 + payloadPart2);

    const resPromise = fetchPhpMyAdminUpstream(`${srv.url}/import?db=wp_1`, {
      method: "POST",
      headers: {
        authorization: "Basic dGVzdDpwYXNz",
        "content-type": "text/plain",
        "content-length": String(totalLength),
        "x-forwarded-prefix": "/phpmyadmin/site-1/",
      },
      body,
      duplex: "half",
    } as RequestInit);

    // Push chunk 1 only and assert the server receives it before chunk 2 is even enqueued.
    ctrl.enqueue(encoder.encode(payloadPart1));
    await firstChunkReceived;
    expect(serverChunks).toEqual([payloadPart1]);

    ctrl.enqueue(encoder.encode(payloadPart2));
    ctrl.close();

    const res = await resPromise;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello-world!");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("/import?db=wp_1");
    expect(seenHeaders["authorization"]).toBe("Basic dGVzdDpwYXNz");
    expect(seenHeaders["x-forwarded-prefix"]).toBe("/phpmyadmin/site-1/");
    expect(seenHeaders["content-length"]).toBe(String(totalLength));
    expect(seenHeaders["transfer-encoding"]).toBeUndefined();
  });

  it("resolves as soon as response headers arrive and streams response body incrementally", async () => {
    let serverRes!: http.ServerResponse;
    const srv = await startHttpTestServer((_req, res) => {
      serverRes = res;
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("part-1|");
    });
    cleanups.push(srv.close);

    const res = await fetchPhpMyAdminUpstream(`${srv.url}/stream`);
    expect(res.status).toBe(200);
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toBe("part-1|");

    // Push part 2 only after headers and part 1 have already been observed on client.
    serverRes.write("part-2");
    serverRes.end();
    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(decoder.decode(second.value)).toBe("part-2");
    expect((await reader.read()).done).toBe(true);
  });

  it("returns null body for HEAD, 204, 205, and 304 without leaving sockets hanging", async () => {
    const srv = await startHttpTestServer((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Length": "42", "X-Head": "1" });
        res.end();
        return;
      }
      const status = Number(req.url?.slice(1) ?? "204");
      res.writeHead(status, { "X-Status": String(status) });
      res.end();
    });
    cleanups.push(srv.close);

    const headRes = await fetchPhpMyAdminUpstream(`${srv.url}/head`, { method: "HEAD" });
    expect(headRes.status).toBe(200);
    expect(headRes.body).toBeNull();
    expect(headRes.headers.get("x-head")).toBe("1");

    for (const status of [204, 205, 304]) {
      const res = await fetchPhpMyAdminUpstream(`${srv.url}/${status}`);
      expect(res.status).toBe(status);
      expect(res.body).toBeNull();
      expect(res.headers.get("x-status")).toBe(String(status));
    }

    await new Promise((r) => setTimeout(r, 30));
    expect(srv.activeSockets()).toBe(0);
    await expect(srv.close()).resolves.toBeUndefined();
  });

  it("does not follow 302 redirects and preserves Location and multiple Set-Cookie headers", async () => {
    let hitCount = 0;
    const srv = await startHttpTestServer((_req, res) => {
      hitCount += 1;
      res.writeHead(302, {
        Location: "/phpmyadmin/site-1/index.php?route=/",
        "Set-Cookie": [
          "phpMyAdmin=sess1; path=/; HttpOnly",
          "pma_lang=en; path=/; SameSite=Strict",
        ],
      });
      res.end("redirecting");
    });
    cleanups.push(srv.close);

    const res = await fetchPhpMyAdminUpstream(`${srv.url}/index.php`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/phpmyadmin/site-1/index.php?route=/");
    expect(res.headers.getSetCookie()).toEqual([
      "phpMyAdmin=sess1; path=/; HttpOnly",
      "pma_lang=en; path=/; SameSite=Strict",
    ]);
    expect(hitCount).toBe(1);
    await res.body?.cancel();
  });

  it("rejects on connection refused, connection reset, and premature close before headers", async () => {
    // 1) Nothing listening
    const tempServer = net.createServer();
    await new Promise<void>((resolve) => tempServer.listen(0, "127.0.0.1", resolve));
    const deadPort = (tempServer.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => tempServer.close(() => resolve()));

    await expect(fetchPhpMyAdminUpstream(`http://127.0.0.1:${deadPort}/`)).rejects.toThrow();

    // 2) Connection reset / closed before headers
    const rawServer = net.createServer((socket) => {
      socket.once("data", (buf) => {
        if (buf.toString().includes("/reset")) {
          socket.destroy();
        } else {
          socket.end();
        }
      });
    });
    await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
    const rawPort = (rawServer.address() as net.AddressInfo).port;
    cleanups.push(() => new Promise<void>((resolve) => rawServer.close(() => resolve())));

    await expect(fetchPhpMyAdminUpstream(`http://127.0.0.1:${rawPort}/reset`)).rejects.toThrow();
    await expect(fetchPhpMyAdminUpstream(`http://127.0.0.1:${rawPort}/close`)).rejects.toThrow();
  });

  it("rejects and destroys the server request when the request body stream fails mid-upload", async () => {
    let serverGotChunk = false;
    let serverReqEndedNormally = false;
    let serverReqClosedIncomplete = false;
    let markFirstChunk!: () => void;
    const gotFirstChunk = new Promise<void>((resolve) => {
      markFirstChunk = resolve;
    });
    let markServerClosed!: () => void;
    const serverClosed = new Promise<void>((resolve) => {
      markServerClosed = resolve;
    });

    const srv = await startHttpTestServer((req) => {
      req.on("data", () => {
        serverGotChunk = true;
        markFirstChunk();
      });
      req.on("end", () => {
        serverReqEndedNormally = true;
      });
      req.on("close", () => {
        if (!req.complete) {
          serverReqClosedIncomplete = true;
        }
        markServerClosed();
      });
    });
    cleanups.push(srv.close);

    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });

    const reqPromise = fetchPhpMyAdminUpstream(`${srv.url}/upload`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
      duplex: "half",
    } as RequestInit);

    ctrl.enqueue(new TextEncoder().encode("partial-upload-data"));
    await gotFirstChunk;
    expect(serverGotChunk).toBe(true);

    ctrl.error(new Error("browser disconnected mid-upload"));
    await expect(reqPromise).rejects.toThrow("browser disconnected mid-upload");
    await serverClosed;
    expect(serverReqEndedNormally).toBe(false);
    expect(serverReqClosedIncomplete).toBe(true);
  });

  it("fails the Response body stream when the upstream response body breaks mid-stream", async () => {
    const srv = await startHttpTestServer((req, res) => {
      if (req.url === "/cl-break") {
        res.writeHead(200, { "Content-Length": "100" });
        res.write("first-half");
        setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      res.writeHead(200, { "Transfer-Encoding": "chunked" });
      res.write("chunk-half");
      setTimeout(() => req.socket.destroy(), 20);
    });
    cleanups.push(srv.close);

    for (const path of ["/cl-break", "/chunked-break"]) {
      const res = await fetchPhpMyAdminUpstream(`${srv.url}${path}`);
      expect(res.status).toBe(200);
      await expect(res.text()).rejects.toThrow();
    }
  });

  it("honours init.signal both before sending and while waiting for upstream headers", async () => {
    let connectionsSeen = 0;
    let markServerClosedSocket!: () => void;
    const serverClosedSocket = new Promise<void>((resolve) => {
      markServerClosedSocket = resolve;
    });

    const srv = await startHttpTestServer((req) => {
      connectionsSeen += 1;
      req.on("close", () => markServerClosedSocket());
      // Intentionally hold response open until client aborts.
    });
    cleanups.push(srv.close);

    const preAborted = new AbortController();
    preAborted.abort(new Error("already aborted"));
    await expect(
      fetchPhpMyAdminUpstream(`${srv.url}/never`, { signal: preAborted.signal }),
    ).rejects.toThrow("already aborted");
    expect(connectionsSeen).toBe(0);

    const ac = new AbortController();
    const pending = fetchPhpMyAdminUpstream(`${srv.url}/slow`, { signal: ac.signal });
    setTimeout(() => ac.abort(new Error("caller aborted")), 20);
    await expect(pending).rejects.toThrow("caller aborted");
    await serverClosedSocket;
    expect(connectionsSeen).toBe(1);
  });

  it("delivers early 200 response in full when upstream stops reading a 10 MB upload", async () => {
    const expectedText = "phpMyAdmin: file too large (early answer)";
    const upstreamSrv = await startHttpTestServer((req, res) => {
      let received = 0;
      let answered = false;
      const onData = (chunk: Buffer) => {
        received += chunk.length;
        if (!answered && received >= 64 * 1024) {
          answered = true;
          req.off("data", onData);
          req.pause();
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(expectedText);
        }
      };
      req.on("data", onData);
    });
    cleanups.push(upstreamSrv.close);

    const frontSrv = await startFrontProxyServer(upstreamSrv.url);
    cleanups.push(frontSrv.close);

    const result = await uploadChunked10Mb(`${frontSrv.url}/import`);
    expect(result.status).toBe(200);
    expect(result.body).toBe(expectedText);
  });

  it("delivers early 200 response in full when upstream destroys its socket right after answering", async () => {
    const expectedText = "phpMyAdmin: file too large (socket destroyed)";
    const upstreamSrv = await startHttpTestServer((req, res) => {
      let received = 0;
      let answered = false;
      const onData = (chunk: Buffer) => {
        received += chunk.length;
        if (!answered && received >= 64 * 1024) {
          answered = true;
          req.off("data", onData);
          req.pause();
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(expectedText, () => {
            setTimeout(() => req.socket.destroy(), 20);
          });
        }
      };
      req.on("data", onData);
    });
    cleanups.push(upstreamSrv.close);

    const frontSrv = await startFrontProxyServer(upstreamSrv.url);
    cleanups.push(frontSrv.close);

    const result = await uploadChunked10Mb(`${frontSrv.url}/import`);
    expect(result.status).toBe(200);
    expect(result.body).toBe(expectedText);
  });

  it("delivers front 503 response cleanly during a 10 MB upload when upstream port is closed", async () => {
    const tempServer = net.createServer();
    await new Promise<void>((resolve) => tempServer.listen(0, "127.0.0.1", resolve));
    const deadPort = (tempServer.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => tempServer.close(() => resolve()));

    const frontSrv = await startFrontProxyServer(`http://127.0.0.1:${deadPort}`);
    cleanups.push(frontSrv.close);

    const result = await uploadChunked10Mb(`${frontSrv.url}/import`);
    expect(result.status).toBe(503);
    expect(result.body).toBe("front 503 unavailable");
  });

  it("rejects without an uncaught exception when upstream status cannot construct a Response", async () => {
    const rawServer = net.createServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 999 Odd\r\nContent-Length: 0\r\n\r\n");
      });
    });
    await new Promise<void>((resolve) => rawServer.listen(0, "127.0.0.1", resolve));
    const rawPort = (rawServer.address() as net.AddressInfo).port;
    cleanups.push(() => new Promise<void>((resolve) => rawServer.close(() => resolve())));

    await expect(fetchPhpMyAdminUpstream(`http://127.0.0.1:${rawPort}/odd`)).rejects.toThrow();
  });
});

// Starts a local front HTTP server that forwards Readable.toWeb(req) via fetchPhpMyAdminUpstream.
function startFrontProxyServer(upstreamBaseUrl: string): Promise<TestServerHandle> {
  return startHttpTestServer(async (nodeReq, nodeRes) => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(nodeReq.headers)) {
      if (Array.isArray(v)) {
        for (const item of v) headers.append(k, item);
      } else if (typeof v === "string") {
        headers.set(k, v);
      }
    }
    const method = (nodeReq.method ?? "GET").toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD";
    try {
      const upstreamRes = await fetchPhpMyAdminUpstream(`${upstreamBaseUrl}${nodeReq.url ?? "/"}`, {
        method,
        headers,
        ...(hasBody
          ? { body: Readable.toWeb(nodeReq) as ReadableStream<Uint8Array>, duplex: "half" as const }
          : {}),
      } as RequestInit);
      const outHeaders: Record<string, string | string[]> = {};
      upstreamRes.headers.forEach((val, key) => {
        if (key.toLowerCase() !== "set-cookie") outHeaders[key] = val;
      });
      const cookies = upstreamRes.headers.getSetCookie();
      if (cookies.length > 0) outHeaders["set-cookie"] = cookies;
      nodeRes.writeHead(upstreamRes.status, outHeaders);
      if (upstreamRes.body) {
        const nodeStream = Readable.fromWeb(
          upstreamRes.body as unknown as import("node:stream/web").ReadableStream,
        );
        nodeStream.pipe(nodeRes);
      } else {
        nodeRes.end();
      }
    } catch {
      if (!nodeRes.headersSent && !nodeRes.destroyed) {
        nodeRes.writeHead(503, { "Content-Type": "text/plain" });
        nodeRes.end("front 503 unavailable");
      }
    }
  });
}

// Uploads 10 MiB asynchronously in 64 KiB chunks and collects the HTTP status and body.
function uploadChunked10Mb(targetUrl: string): Promise<{ status: number; body: string }> {
  const totalBytes = 10 * 1024 * 1024;
  const chunkSize = 64 * 1024;
  const chunk = Buffer.alloc(chunkSize, 0x78);

  return new Promise((resolve, reject) => {
    let settled = false;
    let resEnded = false;
    let reqFinished = false;
    let waitingForDrain = false;
    let pumpDone = false;
    let status = 0;
    const chunks: Buffer[] = [];

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const maybeResolve = () => {
      if (!settled && resEnded && reqFinished) {
        settled = true;
        resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
      }
    };

    const clientReq = http.request(
      targetUrl,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(totalBytes),
        },
      },
      (res) => {
        status = res.statusCode ?? 0;
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("error", fail);
        res.on("end", () => {
          resEnded = true;
          // ClientRequest detaches socket drain forwarding once res ends; resume on socket.
          if (waitingForDrain && clientReq.socket && !clientReq.destroyed) {
            if (!clientReq.socket.writableNeedDrain) {
              waitingForDrain = false;
              setImmediate(schedulePump);
            } else {
              clientReq.socket.once("drain", () => {
                waitingForDrain = false;
                schedulePump();
              });
            }
          }
          maybeResolve();
        });
        res.on("close", () => {
          if (!resEnded) fail(new Error("Response closed before end"));
        });
      },
    );
    clientReq.on("error", fail);
    clientReq.on("finish", () => {
      reqFinished = true;
      maybeResolve();
    });

    let sent = 0;
    const schedulePump = () => {
      if (waitingForDrain || pumpDone || settled || clientReq.destroyed) return;
      if (sent >= totalBytes) {
        pumpDone = true;
        clientReq.end();
        return;
      }
      const next = Math.min(chunkSize, totalBytes - sent);
      const slice = next === chunkSize ? chunk : chunk.subarray(0, next);
      sent += next;
      const canContinue = clientReq.write(slice);
      if (canContinue) {
        if (sent % (512 * 1024) === 0) {
          setTimeout(schedulePump, 2);
        } else {
          setImmediate(schedulePump);
        }
      } else {
        waitingForDrain = true;
        const emitter = resEnded && clientReq.socket ? clientReq.socket : clientReq;
        emitter.once("drain", () => {
          waitingForDrain = false;
          schedulePump();
        });
      }
    };
    setImmediate(schedulePump);
  });
}
