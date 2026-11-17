import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { Duplex } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExecutorCodedError,
  runDockerExec,
  startDockerExec,
  type DockerExecTarget,
} from "../src/index.js";

function encodeDockerFrame(stream: 1 | 2, data: Buffer | string): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

interface ExecCreateBody {
  Cmd: string[];
  User?: string;
  WorkingDir?: string;
  Env?: string[];
  AttachStdin?: boolean;
  AttachStdout?: boolean;
  AttachStderr?: boolean;
  Tty?: boolean;
}

interface FakeExecRecord {
  readonly id: string;
  readonly container: string;
  readonly spec: ExecCreateBody;
  stdin: Buffer;
}

interface FakeExecEngine {
  readonly socketPath: string;
  readonly target: DockerExecTarget;
  readonly created: FakeExecRecord[];
  readonly inspected: string[];
  setCreateHandler(
    handler: (
      container: string,
      spec: ExecCreateBody,
    ) => { statusCode: number; body: unknown },
  ): void;
  setStartHandler(
    handler: (
      execId: string,
      req: http.IncomingMessage,
      socket: Duplex,
      head: Buffer,
      record: FakeExecRecord | undefined,
    ) => void,
  ): void;
  setInspectHandler(
    handler: (execId: string, callIndex: number) => { statusCode: number; body: unknown },
  ): void;
}

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanupTasks.length > 0) {
    await cleanupTasks.pop()?.();
  }
});

async function startFakeExecEngine(apiPrefix = "/v1.45"): Promise<FakeExecEngine> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hp-docker-exec-test-"));
  const socketPath = path.join(dir, "docker.sock");

  const created: FakeExecRecord[] = [];
  const execMap = new Map<string, FakeExecRecord>();
  const inspected: string[] = [];
  const inspectCounts = new Map<string, number>();
  const openSockets = new Set<Duplex>();

  let nextExecSeq = 1;
  let createHandler: (
    container: string,
    spec: ExecCreateBody,
  ) => { statusCode: number; body: unknown } = (container, spec) => {
    const id = `exec_${String(nextExecSeq++)}`;
    const record: FakeExecRecord = { id, container, spec, stdin: Buffer.alloc(0) };
    created.push(record);
    execMap.set(id, record);
    return { statusCode: 201, body: { Id: id } };
  };

  let startHandler: (
    execId: string,
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    record: FakeExecRecord | undefined,
  ) => void = (_execId, _req, socket, _head, record) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: Upgrade\r\n" +
        "Upgrade: tcp\r\n\r\n",
    );
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on("end", () => {
      const input = Buffer.concat(chunks);
      if (record) {
        record.stdin = input;
      }
      socket.end(encodeDockerFrame(1, input));
    });
  };

  let inspectHandler: (
    execId: string,
    callIndex: number,
  ) => { statusCode: number; body: unknown } = () => ({
    statusCode: 200,
    body: { Running: false, ExitCode: 0 },
  });

  const stripPrefix = (urlPath: string): string =>
    apiPrefix.length > 0 && urlPath.startsWith(apiPrefix)
      ? urlPath.slice(apiPrefix.length)
      : urlPath;

  const readJsonBody = (req: http.IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined);
      });
      req.on("error", reject);
    });

  const server = http.createServer(async (req, res) => {
    const urlPath = stripPrefix((req.url ?? "/").split("?")[0] ?? "/");
    const createMatch = /^\/containers\/([^/]+)\/exec$/.exec(urlPath);
    if (req.method === "POST" && createMatch?.[1]) {
      const container = decodeURIComponent(createMatch[1]);
      const spec = (await readJsonBody(req)) as ExecCreateBody;
      const out = createHandler(container, spec);
      res.writeHead(out.statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
      return;
    }

    const inspectMatch = /^\/exec\/([^/]+)\/json$/.exec(urlPath);
    if (req.method === "GET" && inspectMatch?.[1]) {
      const execId = decodeURIComponent(inspectMatch[1]);
      inspected.push(execId);
      const count = (inspectCounts.get(execId) ?? 0) + 1;
      inspectCounts.set(execId, count);
      const out = inspectHandler(execId, count);
      res.writeHead(out.statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });

  server.on("upgrade", (req, socket, head) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
    const urlPath = stripPrefix((req.url ?? "/").split("?")[0] ?? "/");
    const startMatch = /^\/exec\/([^/]+)\/start$/.exec(urlPath);
    const execId = startMatch?.[1] ? decodeURIComponent(startMatch[1]) : "";
    const parsedLength = Number(req.headers["content-length"] ?? 0);
    const contentLength = Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : 0;

    // Node 26 consumes Content-Length bytes into `req` during Upgrade (leaving `head` for post-body bytes);
    // Node <=24 stops before the body and delivers it through `head` and raw `socket`.
    const reqChunks: Buffer[] = [];
    let closed = false;
    const onReqError = () => {
      closed = true;
    };
    const onSocketClose = () => {
      closed = true;
      req.off("error", onReqError);
    };
    req.on("error", onReqError);
    socket.once("close", onSocketClose);

    req.on("data", (chunk: Buffer) => {
      reqChunks.push(chunk);
    });
    req.on("end", () => {
      if (closed) return;
      const reqBody = Buffer.concat(reqChunks);
      if (reqBody.length >= contentLength) {
        req.off("error", onReqError);
        socket.off("close", onSocketClose);
        const startJson = reqBody.subarray(0, contentLength);
        const trailing = Buffer.concat([reqBody.subarray(contentLength), head]);
        if (trailing.length > 0) {
          socket.unshift(trailing);
        }
        startHandler(execId, req, socket, startJson, execMap.get(execId));
        return;
      }

      const initial = Buffer.concat([reqBody, head]);
      const bodyChunks: Buffer[] = initial.length > 0 ? [initial] : [];
      let bodyBytes = initial.length;

      const onReadable = () => {
        for (;;) {
          const chunk = socket.read() as Buffer | null;
          if (chunk === null) break;
          bodyChunks.push(chunk);
          bodyBytes += chunk.length;
          if (bodyBytes >= contentLength) {
            socket.off("readable", onReadable);
            dispatch();
            return;
          }
        }
      };
      const onAbort = () => socket.off("readable", onReadable);

      const dispatch = () => {
        req.off("error", onReqError);
        socket.off("close", onSocketClose);
        socket.off("close", onAbort);
        const full = Buffer.concat(bodyChunks);
        const startJson = full.subarray(0, contentLength);
        const trailing = full.subarray(contentLength);
        if (trailing.length > 0) {
          socket.unshift(trailing);
        }
        startHandler(execId, req, socket, startJson, execMap.get(execId));
      };

      if (bodyBytes >= contentLength) {
        dispatch();
        return;
      }

      socket.once("close", onAbort);
      socket.on("readable", onReadable);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(socketPath, resolve);
  });

  cleanupTasks.push(async () => {
    for (const sock of openSockets) {
      sock.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const request: DockerExecTarget["request"] = (method, endpointPath, jsonBody, options) => {
    const serialized =
      jsonBody !== undefined ? Buffer.from(JSON.stringify(jsonBody), "utf8") : undefined;
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          method,
          path: `${apiPrefix}${endpointPath}`,
          timeout: options?.timeoutMs ?? 10_000,
          headers: {
            Host: "docker",
            Accept: "application/json",
            ...(serialized
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": serialized.length,
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode ?? 500,
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("request timeout"));
      });
      if (serialized) {
        req.write(serialized);
      }
      req.end();
    });
  };

  return {
    socketPath,
    target: { request, socketPath, apiPrefix },
    created,
    inspected,
    setCreateHandler(handler) {
      createHandler = handler;
    },
    setStartHandler(handler) {
      startHandler = handler;
    },
    setInspectHandler(handler) {
      inspectHandler = handler;
    },
  };
}

describe("docker-exec primitive", () => {
  it("delivers binary stdin with EOF and demuxes echoed stdout", async () => {
    const engine = await startFakeExecEngine();
    const binaryInput = Buffer.from([0x00, 0x7b, 0xff, 0xfe, 0x0a, 0x80, 0x7d]);

    const result = await runDockerExec(
      engine.target,
      {
        container: "hp_files_svc_1",
        cmd: ["/bin/cat"],
        user: "33:33",
        workingDir: "/var/www/html",
        env: ["HP_TEST=1"],
      },
      {
        stdin: binaryInput,
        timeoutMs: 2_000,
        maxOutputBytes: 4096,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.exitUnknown).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.stderr.length).toBe(0);
    expect(result.stdout.equals(binaryInput)).toBe(true);
    expect(engine.created).toHaveLength(1);
    expect(engine.created[0]?.spec).toEqual({
      Cmd: ["/bin/cat"],
      User: "33:33",
      WorkingDir: "/var/www/html",
      Env: ["HP_TEST=1"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
  });

  it("demuxes stdout and stderr across split TCP chunks and upgrade head bytes", async () => {
    const engine = await startFakeExecEngine("");
    const out1 = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const err1 = Buffer.from("warn-one\n", "utf8");
    const out2 = Buffer.from("ok-two", "utf8");
    const err2 = Buffer.from([0x00, 0x01, 0x81, 0xff]);

    const combinedFrames = Buffer.concat([
      encodeDockerFrame(1, out1),
      encodeDockerFrame(2, err1),
      encodeDockerFrame(1, Buffer.alloc(0)),
      encodeDockerFrame(1, out2),
      encodeDockerFrame(2, err2),
    ]);

    engine.setStartHandler((_execId, _req, socket) => {
      // First chunk is sent inline with the 101 response so Node delivers it via `head`.
      const splitAt = 11; // crosses header/payload boundary inside frame 1/2
      const firstPart = combinedFrames.subarray(0, splitAt);
      const rest = combinedFrames.subarray(splitAt);

      socket.write(
        Buffer.concat([
          Buffer.from(
            "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
            "ascii",
          ),
          firstPart,
        ]),
      );

      let offset = 0;
      const sendNext = () => {
        if (offset >= rest.length) {
          socket.end();
          return;
        }
        const next = rest.subarray(offset, offset + 3);
        offset += 3;
        socket.write(next);
        setTimeout(sendNext, 2);
      };
      setTimeout(sendNext, 2);
    });

    const result = await runDockerExec(
      engine.target,
      { container: "hp_files_svc_1", cmd: ["php", "-v"] },
      { timeoutMs: 2_000, maxOutputBytes: 4096 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.exitUnknown).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.stdout.equals(Buffer.concat([out1, out2]))).toBe(true);
    expect(result.stderr.equals(Buffer.concat([err1, err2]))).toBe(true);
  });

  it("caps stdout and stderr independently at maxOutputBytes and marks truncated", async () => {
    const engine = await startFakeExecEngine();

    engine.setStartHandler((_execId, _req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
      );
      socket.write(encodeDockerFrame(1, "123456"));
      socket.write(encodeDockerFrame(2, "abcdef"));
      socket.write(encodeDockerFrame(1, "789012345"));
      socket.write(encodeDockerFrame(2, "ghij"));
      socket.end();
    });

    const result = await runDockerExec(
      engine.target,
      { container: "hp_files_svc_1", cmd: ["php"] },
      { timeoutMs: 2_000, maxOutputBytes: 10 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.stdout.toString("utf8")).toBe("1234567890");
    expect(result.stderr.toString("utf8")).toBe("abcdefghij");
  });

  it("does not mark truncated when streams exactly equal maxOutputBytes", async () => {
    const engine = await startFakeExecEngine();

    engine.setStartHandler((_execId, _req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
      );
      socket.write(encodeDockerFrame(1, "0123456789"));
      socket.write(encodeDockerFrame(2, "abcdefghij"));
      socket.end();
    });

    const result = await runDockerExec(
      engine.target,
      { container: "hp_files_svc_1", cmd: ["php"] },
      { timeoutMs: 2_000, maxOutputBytes: 10 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.exitUnknown).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.stdout.toString("utf8")).toBe("0123456789");
    expect(result.stderr.toString("utf8")).toBe("abcdefghij");
  });

  it("returns exitCode: null and destroys the socket when timeoutMs expires", async () => {
    const engine = await startFakeExecEngine();
    let serverSocketClosed = false;
    let serverSocket!: Duplex;

    engine.setStartHandler((_execId, _req, socket) => {
      serverSocket = socket;
      socket.on("error", () => {
        // EPIPE when probing closed client socket after destroy
      });
      socket.on("close", () => {
        serverSocketClosed = true;
      });
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
      );
      socket.write(encodeDockerFrame(1, "partial"));
    });

    const result = await runDockerExec(
      engine.target,
      { container: "hp_files_svc_1", cmd: ["sleep", "60"] },
      { timeoutMs: 40, maxOutputBytes: 1024 },
    );

    expect(result.exitCode).toBeNull();
    expect(result.exitUnknown).toBe(false);
    expect(result.stdout.toString("utf8")).toBe("partial");
    expect(engine.inspected).toHaveLength(0);

    // Client destroyed its end of the socket; writing from server fails with EPIPE and closes.
    serverSocket.write(encodeDockerFrame(1, "after-timeout"));
    await new Promise((r) => setTimeout(r, 30));
    expect(serverSocketClosed).toBe(true);
  });

  it("maps exec create 404/409 to NOT_FOUND and 500 to DOCKER_ENGINE_UNAVAILABLE", async () => {
    const engine = await startFakeExecEngine();

    engine.setCreateHandler(() => ({ statusCode: 404, body: { message: "no such container" } }));
    await expect(
      runDockerExec(
        engine.target,
        { container: "missing", cmd: ["id"] },
        { timeoutMs: 1_000, maxOutputBytes: 1024 },
      ),
    ).rejects.toMatchObject({ name: "ExecutorCodedError", code: "NOT_FOUND" });

    engine.setCreateHandler(() => ({ statusCode: 409, body: { message: "container paused" } }));
    await expect(
      runDockerExec(
        engine.target,
        { container: "paused", cmd: ["id"] },
        { timeoutMs: 1_000, maxOutputBytes: 1024 },
      ),
    ).rejects.toMatchObject({ name: "ExecutorCodedError", code: "NOT_FOUND" });

    engine.setCreateHandler(() => ({ statusCode: 500, body: { message: "engine error" } }));
    await expect(
      runDockerExec(
        engine.target,
        { container: "broken", cmd: ["id"] },
        { timeoutMs: 1_000, maxOutputBytes: 1024 },
      ),
    ).rejects.toMatchObject({ name: "ExecutorCodedError", code: "DOCKER_ENGINE_UNAVAILABLE" });
  });

  it("maps a 200 response without upgrade on exec start to DOCKER_ENGINE_UNAVAILABLE", async () => {
    const engine = await startFakeExecEngine();

    engine.setStartHandler((_execId, _req, socket) => {
      socket.end(
        "HTTP/1.1 200 OK\r\n" +
          "Content-Type: application/json\r\n" +
          "Content-Length: 15\r\n" +
          "Connection: close\r\n\r\n" +
          '{"status":"ok"}',
      );
    });

    await expect(
      runDockerExec(
        engine.target,
        { container: "hp_files_svc_1", cmd: ["id"] },
        { timeoutMs: 1_000, maxOutputBytes: 1024 },
      ),
    ).rejects.toMatchObject({ name: "ExecutorCodedError", code: "DOCKER_ENGINE_UNAVAILABLE" });
  });

  it("maps a 404 or 409 response without upgrade on exec start to NOT_FOUND", async () => {
    const engine = await startFakeExecEngine();

    engine.setStartHandler((_execId, _req, socket) => {
      socket.end(
        "HTTP/1.1 404 Not Found\r\n" +
          "Content-Length: 0\r\n" +
          "Connection: close\r\n\r\n",
      );
    });

    await expect(
      runDockerExec(
        engine.target,
        { container: "hp_files_svc_1", cmd: ["id"] },
        { timeoutMs: 1_000, maxOutputBytes: 1024 },
      ),
    ).rejects.toMatchObject({ name: "ExecutorCodedError", code: "NOT_FOUND" });
  });

  it("polls exec inspect when Running is true and returns final ExitCode", async () => {
    const engine = await startFakeExecEngine();

    engine.setInspectHandler((_execId, callIndex) => {
      if (callIndex < 3) {
        return { statusCode: 200, body: { Running: true, ExitCode: 0 } };
      }
      return { statusCode: 200, body: { Running: false, ExitCode: 17 } };
    });

    const result = await runDockerExec(
      engine.target,
      { container: "hp_files_svc_1", cmd: ["false"] },
      { timeoutMs: 2_000, maxOutputBytes: 1024 },
    );

    expect(result.exitCode).toBe(17);
    expect(engine.inspected).toHaveLength(3);
  });

  it("supports startDockerExec with tty: true and preserves head bytes", async () => {
    const engine = await startFakeExecEngine();

    engine.setStartHandler((_execId, _req, socket, startJson) => {
      expect(JSON.parse(startJson.toString("utf8"))).toEqual({ Detach: false, Tty: true });
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nhello-tty",
      );
    });

    const { execId, socket } = await startDockerExec(engine.target, {
      container: "hp_files_svc_1",
      cmd: ["/bin/sh"],
      tty: true,
    });
    expect(execId).toBe("exec_1");
    expect(engine.created[0]?.spec.Tty).toBe(true);

    const chunk = await new Promise<Buffer>((resolve) => {
      socket.once("data", (d: Buffer) => resolve(d));
    });
    expect(chunk.toString("utf8")).toBe("hello-tty");
    socket.destroy();
  });

  it("maps an unreachable socket path on startDockerExec to DOCKER_ENGINE_UNAVAILABLE", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "hp-missing-sock-"));
    cleanupTasks.push(() => rm(dir, { recursive: true, force: true }));
    const missingSocket = path.join(dir, "missing.sock");

    const target: DockerExecTarget = {
      socketPath: missingSocket,
      apiPrefix: "/v1.45",
      request: async () => ({ statusCode: 201, body: Buffer.from(JSON.stringify({ Id: "exec_1" })) }),
    };

    const err = await startDockerExec(target, {
      container: "hp_files_svc_1",
      cmd: ["id"],
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExecutorCodedError);
    expect((err as ExecutorCodedError).code).toBe("DOCKER_ENGINE_UNAVAILABLE");
  });

  it("maps mid-stream abrupt socket reset and non-200 inspect to DOCKER_ENGINE_UNAVAILABLE", async () => {
    const engine = await startFakeExecEngine();

    engine.setStartHandler((_execId, _req, socket) => {
      socket.on("error", () => {
        // Ignore expected EPIPE/ECONNRESET on abrupt server destroy
      });
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
      );
      socket.once("data", () => {
        socket.destroy();
      });
    });

    await expect(
      runDockerExec(
        engine.target,
        { container: "hp_files_svc_1", cmd: ["id"] },
        { stdin: Buffer.alloc(4 * 1024 * 1024, 0x41), timeoutMs: 1_000, maxOutputBytes: 1024 },
      ),
    ).rejects.toMatchObject({ name: "ExecutorCodedError", code: "DOCKER_ENGINE_UNAVAILABLE" });

    // Restore normal start handler, fail inspect with 500
    engine.setStartHandler((_execId, _req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
      );
      socket.end(encodeDockerFrame(1, "ok"));
    });
    engine.setInspectHandler(() => ({ statusCode: 500, body: { message: "inspect error" } }));

    await expect(
      runDockerExec(
        engine.target,
        { container: "hp_files_svc_1", cmd: ["id"] },
        { timeoutMs: 1_000, maxOutputBytes: 1024 },
      ),
    ).rejects.toMatchObject({ name: "ExecutorCodedError", code: "DOCKER_ENGINE_UNAVAILABLE" });
  });

  it("returns exitCode: null and exitUnknown: true if exec inspect stays Running: true for 2s", async () => {
    const engine = await startFakeExecEngine();
    engine.setInspectHandler(() => ({ statusCode: 200, body: { Running: true, ExitCode: 0 } }));

    const result = await runDockerExec(
      engine.target,
      { container: "hp_files_svc_1", cmd: ["id"] },
      { timeoutMs: 2_000, maxOutputBytes: 1024 },
    );

    expect(result.exitCode).toBeNull();
    expect(result.exitUnknown).toBe(true);
    expect(engine.inspected.length).toBeGreaterThan(5);
  });
});
