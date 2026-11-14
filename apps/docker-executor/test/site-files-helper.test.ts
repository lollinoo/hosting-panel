import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { Duplex } from "node:stream";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PHP_VERSION,
  SITE_FILE_CHUNK_BYTES,
  SITE_FILE_ERROR_REASONS,
  SITE_FILE_REASON_CODES,
  SITE_FILES_MAX_FILE_BYTES,
  resolveWordpressImage,
} from "@hosting-panel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExecutorCodedError,
  SITE_FILES_ROLE,
  SiteFilesHelpers,
  buildSiteFilesHelperPayload,
  parseSiteFilesRequest,
  siteFilesHelperName,
  type DockerExecTarget,
} from "../src/index.js";

function encodeDockerFrame(stream: 1 | 2, data: Buffer | string): Buffer {
  const payload = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

interface FakeContainer {
  id: string;
  name: string;
  running: boolean;
  labels: Record<string, string>;
  image: string;
  payload?: Record<string, unknown>;
}

interface FakeVolume {
  name: string;
  labels: Record<string, string>;
}

interface FakeDockerState {
  containers: Map<string, FakeContainer>;
  volumes: Map<string, FakeVolume>;
  images: Set<string>;
  calls: Array<{ method: string; path: string; body?: unknown }>;
  execCount: number;
  sweepRequests: unknown[];
  execHandler: (
    reqPayload: Record<string, unknown>,
    execIndex: number,
  ) => Promise<{
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    hang?: boolean;
    runningForever?: boolean;
  }> | {
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    hang?: boolean;
    runningForever?: boolean;
  };
  onExecCreate?: (containerRef: string) => { statusCode: number; body: unknown } | null;
  onDeleteContainer?: (containerRef: string) => Promise<void> | void;
  conflictNextCreate: boolean;
  createDelayMs: number;
}

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanupTasks.length > 0) {
    await cleanupTasks.pop()?.();
  }
});

async function createFakeHelperDocker(): Promise<{
  target: DockerExecTarget;
  state: FakeDockerState;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hp-files-helper-test-"));
  const socketPath = path.join(dir, "docker.sock");
  const apiPrefix = "/v1.45";

  const state: FakeDockerState = {
    containers: new Map(),
    volumes: new Map(),
    images: new Set([resolveWordpressImage(DEFAULT_PHP_VERSION)]),
    calls: [],
    execCount: 0,
    sweepRequests: [],
    execHandler: () => ({
      exitCode: 0,
      stdout: JSON.stringify({ ok: true, result: { entries: [], truncated: false } }),
    }),
    conflictNextCreate: false,
    createDelayMs: 0,
  };

  let containerSeq = 1;
  let execSeq = 1;
  const execResults = new Map<string, { exitCode: number | null; runningForever?: boolean }>();
  const execPayloads = new Map<string, { isSweep: boolean; execIndex: number }>();
  const openSockets = new Set<Duplex>();

  const findContainer = (nameOrId: string): FakeContainer | undefined => {
    const byId = state.containers.get(nameOrId);
    if (byId) return byId;
    for (const c of state.containers.values()) {
      if (c.name === nameOrId) return c;
    }
    return undefined;
  };

  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
    const urlPath = (req.url ?? "/").replace(apiPrefix, "").split("?")[0] ?? "/";
    const match = /^\/exec\/([^/]+)\/start$/.exec(urlPath);
    const execId = match?.[1] ? decodeURIComponent(match[1]) : "";
    const meta = execPayloads.get(execId);
    const parsedLength = Number(req.headers["content-length"] ?? 0);
    const contentLength = Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : 0;

    const handleUpgraded = (trailing: Buffer) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
      );

      const chunks: Buffer[] = trailing.length > 0 ? [trailing] : [];
      socket.on("data", (c: Buffer) => chunks.push(c));
      socket.on("end", async () => {
        const rawStdin = Buffer.concat(chunks).toString("utf8").trim();
        const parsedStdin =
          rawStdin.length > 0 ? (JSON.parse(rawStdin) as Record<string, unknown>) : {};
        if (parsedStdin.op === "sweep") {
          state.sweepRequests.push(parsedStdin);
          execResults.set(execId, { exitCode: 0 });
          socket.write(encodeDockerFrame(1, JSON.stringify({ ok: true, result: { removed: 0 } })));
          socket.end();
          return;
        }

        const reply = await state.execHandler(parsedStdin, meta?.execIndex ?? 1);
        if (reply.hang) {
          return;
        }
        execResults.set(execId, {
          exitCode: reply.exitCode ?? 0,
          ...(reply.runningForever ? { runningForever: true } : {}),
        });
        if (reply.stdout !== undefined && reply.stdout.length > 0) {
          socket.write(encodeDockerFrame(1, reply.stdout));
        }
        if (reply.stderr !== undefined && reply.stderr.length > 0) {
          socket.write(encodeDockerFrame(2, reply.stderr));
        }
        socket.end();
      });
    };

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
        handleUpgraded(Buffer.concat([reqBody.subarray(contentLength), head]));
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
            finish();
            return;
          }
        }
      };
      const onAbort = () => socket.off("readable", onReadable);

      const finish = () => {
        req.off("error", onReqError);
        socket.off("close", onSocketClose);
        socket.off("close", onAbort);
        handleUpgraded(Buffer.concat(bodyChunks).subarray(contentLength));
      };

      if (bodyBytes >= contentLength) {
        finish();
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

  const request: DockerExecTarget["request"] = async (method, endpointPath, jsonBody) => {
    state.calls.push({ method, path: endpointPath, body: jsonBody });
    const [pathname, queryString] = endpointPath.split("?");
    const params = new URLSearchParams(queryString ?? "");

    if (method === "GET" && pathname === "/containers/json") {
      const rawFilters = params.get("filters");
      const parsedFilters = rawFilters
        ? (JSON.parse(rawFilters) as { label?: string[] })
        : {};
      const requiredLabels = parsedFilters.label ?? [];
      const matches = [...state.containers.values()]
        .filter((c) =>
          requiredLabels.every((kv) => {
            const eq = kv.indexOf("=");
            if (eq === -1) return Object.hasOwn(c.labels, kv);
            const key = kv.slice(0, eq);
            const val = kv.slice(eq + 1);
            return c.labels[key] === val;
          }),
        )
        .map((c) => ({ Id: c.id, Names: [`/${c.name}`], Labels: c.labels, Image: c.image }));
      return { statusCode: 200, body: Buffer.from(JSON.stringify(matches), "utf8") };
    }

    const inspectContainerMatch = /^\/containers\/([^/]+)\/json$/.exec(pathname ?? "");
    if (method === "GET" && inspectContainerMatch?.[1]) {
      const c = findContainer(decodeURIComponent(inspectContainerMatch[1]));
      if (!c) {
        return { statusCode: 404, body: Buffer.from(JSON.stringify({ message: "not found" })) };
      }
      return {
        statusCode: 200,
        body: Buffer.from(
          JSON.stringify({
            Id: c.id,
            Name: `/${c.name}`,
            State: { Running: c.running, Dead: false },
            Config: { Image: c.image, Labels: c.labels },
          }),
        ),
      };
    }

    const volumeMatch = /^\/volumes\/([^/]+)$/.exec(pathname ?? "");
    if (method === "GET" && volumeMatch?.[1]) {
      const v = state.volumes.get(decodeURIComponent(volumeMatch[1]));
      if (!v) {
        return { statusCode: 404, body: Buffer.from(JSON.stringify({ message: "no such volume" })) };
      }
      return {
        statusCode: 200,
        body: Buffer.from(JSON.stringify({ Name: v.name, Labels: v.labels })),
      };
    }

    const imageMatch = /^\/images\/([^/]+)\/json$/.exec(pathname ?? "");
    if (method === "GET" && imageMatch?.[1]) {
      const img = decodeURIComponent(imageMatch[1]);
      if (!state.images.has(img)) {
        return { statusCode: 404, body: Buffer.from(JSON.stringify({ message: "no such image" })) };
      }
      return { statusCode: 200, body: Buffer.from(JSON.stringify({ Id: `img:${img}` })) };
    }

    if (method === "POST" && pathname === "/containers/create") {
      if (state.createDelayMs > 0) {
        await new Promise((r) => setTimeout(r, state.createDelayMs));
      }
      const name = params.get("name") ?? `anon_${String(containerSeq)}`;
      if (state.conflictNextCreate) {
        state.conflictNextCreate = false;
        return { statusCode: 409, body: Buffer.from(JSON.stringify({ message: "name in use" })) };
      }
      const payload = (jsonBody ?? {}) as Record<string, unknown>;
      const id = `cid_${String(containerSeq++)}`;
      state.containers.set(id, {
        id,
        name,
        running: false,
        labels: { ...((payload.Labels as Record<string, string>) ?? {}) },
        image: String(payload.Image ?? ""),
        payload,
      });
      return { statusCode: 201, body: Buffer.from(JSON.stringify({ Id: id })) };
    }

    const startContainerMatch = /^\/containers\/([^/]+)\/start$/.exec(pathname ?? "");
    if (method === "POST" && startContainerMatch?.[1]) {
      const c = findContainer(decodeURIComponent(startContainerMatch[1]));
      if (!c) {
        return { statusCode: 404, body: Buffer.alloc(0) };
      }
      c.running = true;
      return { statusCode: 204, body: Buffer.alloc(0) };
    }

    const deleteContainerMatch = /^\/containers\/([^/]+)$/.exec(pathname ?? "");
    if (method === "DELETE" && deleteContainerMatch?.[1]) {
      const ref = decodeURIComponent(deleteContainerMatch[1]);
      if (state.onDeleteContainer) {
        await state.onDeleteContainer(ref);
      }
      const c = findContainer(ref);
      if (!c) {
        return { statusCode: 404, body: Buffer.alloc(0) };
      }
      state.containers.delete(c.id);
      return { statusCode: 204, body: Buffer.alloc(0) };
    }

    const execCreateMatch = /^\/containers\/([^/]+)\/exec$/.exec(pathname ?? "");
    if (method === "POST" && execCreateMatch?.[1]) {
      const ref = decodeURIComponent(execCreateMatch[1]);
      if (state.onExecCreate) {
        const override = state.onExecCreate(ref);
        if (override) {
          return { statusCode: override.statusCode, body: Buffer.from(JSON.stringify(override.body)) };
        }
      }
      const c = findContainer(ref);
      if (!c || !c.running) {
        return { statusCode: 404, body: Buffer.from(JSON.stringify({ message: "not found" })) };
      }
      state.execCount += 1;
      const execId = `exec_${String(execSeq++)}`;
      execPayloads.set(execId, { isSweep: false, execIndex: state.execCount });
      return { statusCode: 201, body: Buffer.from(JSON.stringify({ Id: execId })) };
    }

    const execInspectMatch = /^\/exec\/([^/]+)\/json$/.exec(pathname ?? "");
    if (method === "GET" && execInspectMatch?.[1]) {
      const execId = decodeURIComponent(execInspectMatch[1]);
      const result = execResults.get(execId) ?? { exitCode: 0 };
      if (result.runningForever) {
        return {
          statusCode: 200,
          body: Buffer.from(JSON.stringify({ Running: true, ExitCode: 0 })),
        };
      }
      return {
        statusCode: 200,
        body: Buffer.from(JSON.stringify({ Running: false, ExitCode: result.exitCode })),
      };
    }

    return { statusCode: 404, body: Buffer.from(JSON.stringify({ message: "unknown endpoint" })) };
  };

  return {
    target: { request, socketPath, apiPrefix },
    state,
  };
}

describe("siteFilesHelperName & buildSiteFilesHelperPayload", () => {
  it("builds helper container name and rejects unsafe serviceInstanceId", () => {
    expect(siteFilesHelperName("svc_1")).toBe("hp_files_svc_1");
    expect(() => siteFilesHelperName("../svc")).toThrow(
      expect.objectContaining({ code: "HOST_POLICY_DENIED" }),
    );
  });

  it("produces the hardened helper container spec with no service_instance_id label and exact two binds", () => {
    const payload = buildSiteFilesHelperPayload({
      image: "wordpress:7.1.4-php8.4-apache",
      serviceInstanceId: "svc_site1",
      siteId: "site_1",
      programDir: "/var/lib/hosting-panel/site-files",
    }) as {
      Image: string;
      Entrypoint: string[];
      Cmd: string[];
      User: string;
      WorkingDir: string;
      Env: string[];
      NetworkDisabled: boolean;
      StopSignal?: string;
      Labels: Record<string, string>;
      HostConfig: Record<string, unknown>;
    };

    expect(payload.Image).toBe("wordpress:7.1.4-php8.4-apache");
    expect(payload.Entrypoint).toEqual(["sleep", "infinity"]);
    expect(payload.Cmd).toEqual([]);
    expect(payload.User).toBe("33:33");
    expect(payload.WorkingDir).toBe("/var/www/html");
    expect(payload.Env).toEqual([]);
    expect(payload.NetworkDisabled).toBe(true);
    expect(payload.StopSignal).toBe("SIGKILL");
    expect(payload.Labels["io.hostingpanel.role"]).toBe(SITE_FILES_ROLE);
    expect(payload.Labels["io.hostingpanel.site_id"]).toBe("site_1");
    expect(payload.Labels["io.hostingpanel.files_for"]).toBe("svc_site1");
    expect(payload.Labels["io.hostingpanel.service_instance_id"]).toBeUndefined();

    expect(payload.HostConfig).toEqual({
      NetworkMode: "none",
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
      PidsLimit: 64,
      Memory: 536_870_912,
      MemorySwap: 536_870_912,
      NanoCpus: 1_000_000_000,
      RestartPolicy: { Name: "no" },
      Binds: [
        "hp_vol_svc_site1_html:/var/www/html:rw",
        "/var/lib/hosting-panel/site-files:/usr/local/lib/hp-files:ro",
      ],
    });
  });

  it("refuses unsafe programDir paths, docker.sock, or extra binds with HOST_POLICY_DENIED", () => {
    const base = {
      image: "wordpress:7.1.4-php8.4-apache",
      serviceInstanceId: "svc_site1",
      siteId: "site_1",
    };

    for (const badDir of [
      "relative/path",
      "/",
      "/var/lib/site-files/",
      "/var/lib/../etc",
      "/var/lib/site:files",
      "/var/run/docker.sock",
      "/tmp/docker.sock/files",
    ]) {
      expect(() => buildSiteFilesHelperPayload({ ...base, programDir: badDir })).toThrow(
        expect.objectContaining({ code: "HOST_POLICY_DENIED" }),
      );
    }

    expect(() =>
      buildSiteFilesHelperPayload({
        ...base,
        programDir: "/var/lib/hosting-panel/site-files",
        extraBinds: ["/etc:/etc:ro"],
      } as Parameters<typeof buildSiteFilesHelperPayload>[0]),
    ).toThrow(expect.objectContaining({ code: "HOST_POLICY_DENIED" }));
  });
});

describe("parseSiteFilesRequest", () => {
  it("normalizes valid paths and rejects traversal, reserved names, move-into-itself, and oversize writes", () => {
    const valid = parseSiteFilesRequest({
      serviceInstanceId: "svc_1",
      op: "list",
      path: "wp-content//uploads/",
    });
    expect(valid).toEqual({ serviceInstanceId: "svc_1", op: "list", path: "wp-content/uploads" });

    for (const badPath of ["../x", "/etc/x", "a\u0000b", ".htpanel-upload-x", "dir/.htpanel-tmp"]) {
      expect(() =>
        parseSiteFilesRequest({ serviceInstanceId: "svc_1", op: "stat", path: badPath }),
      ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR", message: "invalid_path" }));
    }

    expect(() =>
      parseSiteFilesRequest({ serviceInstanceId: "svc_1", op: "move", from: "dir", to: "dir/sub" }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR", message: "invalid_path" }));

    expect(() =>
      parseSiteFilesRequest({
        serviceInstanceId: "svc_1",
        op: "write",
        path: "big.bin",
        uploadId: "upload_1234567890123456",
        offset: SITE_FILES_MAX_FILE_BYTES,
        dataBase64: "AAAA",
        final: true,
        overwrite: true,
      }),
    ).toThrow(expect.objectContaining({ code: "QUOTA_EXCEEDED", message: "too_large" }));

    const overChunk = Buffer.alloc(SITE_FILE_CHUNK_BYTES + 1, 0x61).toString("base64");
    expect(() =>
      parseSiteFilesRequest({
        serviceInstanceId: "svc_1",
        op: "write",
        path: "chunk.bin",
        uploadId: "upload_1234567890123456",
        offset: 0,
        dataBase64: overChunk,
        final: false,
        overwrite: true,
      }),
    ).toThrow(expect.objectContaining({ code: "QUOTA_EXCEEDED", message: "too_large" }));
  });
});

describe("SiteFilesHelpers", () => {
  it("fails NOT_FOUND/not_found when the volume is missing and never creates container or volume", async () => {
    const { target, state } = await createFakeHelperDocker();
    const helpers = new SiteFilesHelpers({
      target,
      programDir: "/var/lib/hosting-panel/site-files",
    });
    cleanupTasks.push(async () => helpers.stop());

    await expect(
      helpers.run({ serviceInstanceId: "svc_missing", op: "list", path: "" }),
    ).rejects.toMatchObject({
      name: "ExecutorCodedError",
      code: "NOT_FOUND",
      message: "not_found",
    });

    expect(state.calls.some((c) => c.path.startsWith("/containers/create"))).toBe(false);
    expect(state.calls.some((c) => c.path.startsWith("/volumes/create"))).toBe(false);
  });

  it("uses allowlisted WordPress image from site container, falls back to default, and never pulls missing images", async () => {
    const { target, state } = await createFakeHelperDocker();
    const helpers = new SiteFilesHelpers({
      target,
      programDir: "/var/lib/hosting-panel/site-files",
    });
    cleanupTasks.push(async () => helpers.stop());

    const php85Image = resolveWordpressImage("8.5");
    state.images.add(php85Image);
    state.volumes.set("hp_vol_svc_85_html", {
      name: "hp_vol_svc_85_html",
      labels: { "io.hostingpanel.site_id": "site_85" },
    });
    state.containers.set("site_c_85", {
      id: "site_c_85",
      name: "wp_svc_85",
      running: true,
      image: php85Image,
      labels: { "io.hostingpanel.service_instance_id": "svc_85" },
    });

    await helpers.run({ serviceInstanceId: "svc_85", op: "list", path: "" });
    const created85 = state.containers.get("cid_1");
    expect(created85?.image).toBe(php85Image);

    // Site container reporting an image id / unknown tag falls back to DEFAULT_PHP_VERSION.
    state.volumes.set("hp_vol_svc_fb_html", {
      name: "hp_vol_svc_fb_html",
      labels: { "io.hostingpanel.site_id": "site_fb" },
    });
    state.containers.set("site_c_fb", {
      id: "site_c_fb",
      name: "wp_svc_fb",
      running: true,
      image: "sha256:deadbeef",
      labels: { "io.hostingpanel.service_instance_id": "svc_fb" },
    });

    await helpers.run({ serviceInstanceId: "svc_fb", op: "list", path: "" });
    const createdFb = state.containers.get("cid_2");
    expect(createdFb?.image).toBe(resolveWordpressImage(DEFAULT_PHP_VERSION));

    // Missing image fails DOCKER_ENGINE_UNAVAILABLE and never issues /images/create (pull).
    state.images.delete(resolveWordpressImage(DEFAULT_PHP_VERSION));
    state.volumes.set("hp_vol_svc_noimg_html", {
      name: "hp_vol_svc_noimg_html",
      labels: { "io.hostingpanel.site_id": "site_noimg" },
    });

    await expect(
      helpers.run({ serviceInstanceId: "svc_noimg", op: "list", path: "" }),
    ).rejects.toMatchObject({
      name: "ExecutorCodedError",
      code: "DOCKER_ENGINE_UNAVAILABLE",
    });
    expect(state.calls.some((c) => c.path.startsWith("/images/create"))).toBe(false);
  });

  it("coalesces concurrent run calls into a single container create and handles 409 name race", async () => {
    const { target, state } = await createFakeHelperDocker();
    state.volumes.set("hp_vol_svc_conc_html", {
      name: "hp_vol_svc_conc_html",
      labels: { "io.hostingpanel.site_id": "site_conc" },
    });
    state.createDelayMs = 20;
    state.conflictNextCreate = true;
    state.execHandler = (payload) => {
      if (payload.op === "stat") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            result: {
              entry: {
                name: "",
                kind: "dir",
                size: 0,
                modifiedAt: "2026-01-01T00:00:00Z",
                writable: true,
              },
            },
          }),
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, result: { entries: [], truncated: false } }),
      };
    };

    const helpers = new SiteFilesHelpers({
      target,
      programDir: "/var/lib/hosting-panel/site-files",
    });
    cleanupTasks.push(async () => helpers.stop());

    const [listRes, statRes] = await Promise.all([
      helpers.run({ serviceInstanceId: "svc_conc", op: "list", path: "" }),
      helpers.run({ serviceInstanceId: "svc_conc", op: "stat", path: "" }),
    ]);

    expect(listRes).toEqual({ entries: [], truncated: false });
    expect(statRes.entry.kind).toBe("dir");
    // 1 conflicted 409 attempt + 1 succeeded create inside the single shared ensure
    const creates = state.calls.filter((c) => c.path.startsWith("/containers/create"));
    expect(creates).toHaveLength(2);
    expect([...state.containers.values()].filter((c) => c.name === "hp_files_svc_conc")).toHaveLength(1);

    // Wait briefly for fire-and-forget sweep to register on the fake engine
    await new Promise((r) => setTimeout(r, 20));
    expect(state.sweepRequests).toEqual([{ op: "sweep" }]);
  });

  it("re-ensures and retries once when the helper container vanishes before exec", async () => {
    const { target, state } = await createFakeHelperDocker();
    state.volumes.set("hp_vol_svc_vanish_html", {
      name: "hp_vol_svc_vanish_html",
      labels: { "io.hostingpanel.site_id": "site_vanish" },
    });

    let listExecAttempts = 0;
    state.onExecCreate = (ref) => {
      const c = state.containers.get(ref);
      // Let sweep pass or vanish on first op exec
      if (c && listExecAttempts === 0) {
        listExecAttempts += 1;
        state.containers.delete(c.id);
        return { statusCode: 404, body: { message: "container vanished" } };
      }
      return null;
    };

    const helpers = new SiteFilesHelpers({
      target,
      programDir: "/var/lib/hosting-panel/site-files",
    });
    cleanupTasks.push(async () => helpers.stop());

    const res = await helpers.run({ serviceInstanceId: "svc_vanish", op: "list", path: "" });
    expect(res).toEqual({ entries: [], truncated: false });
    expect(state.calls.filter((c) => c.path.startsWith("/containers/create"))).toHaveLength(2);
  });

  it("force-removes helper and throws OPERATION_INTERRUPTED on exec timeout", async () => {
    const { target, state } = await createFakeHelperDocker();
    state.volumes.set("hp_vol_svc_to_html", {
      name: "hp_vol_svc_to_html",
      labels: { "io.hostingpanel.site_id": "site_to" },
    });
    state.execHandler = () => ({ hang: true });

    const helpers = new SiteFilesHelpers({
      target,
      programDir: "/var/lib/hosting-panel/site-files",
      opTimeoutMs: 40,
    });
    cleanupTasks.push(async () => helpers.stop());

    await expect(
      helpers.run({ serviceInstanceId: "svc_to", op: "list", path: "" }),
    ).rejects.toMatchObject({
      name: "ExecutorCodedError",
      code: "OPERATION_INTERRUPTED",
    });

    expect(state.containers.has("cid_1")).toBe(false);
    expect(state.calls.some((c) => c.method === "DELETE" && c.path.includes("force=true"))).toBe(
      true,
    );
  });

  it("maps valid helper error reasons using SITE_FILE_REASON_CODES and rejects invalid replies as INTERNAL_ERROR", async () => {
    const { target, state } = await createFakeHelperDocker();
    state.volumes.set("hp_vol_svc_err_html", {
      name: "hp_vol_svc_err_html",
      labels: { "io.hostingpanel.site_id": "site_err" },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const helpers = new SiteFilesHelpers({
      target,
      programDir: "/var/lib/hosting-panel/site-files",
    });
    cleanupTasks.push(async () => helpers.stop());

    // Test every helper-valid reason token from SITE_FILE_ERROR_REASONS (except API-only not_ready)
    for (const reason of SITE_FILE_ERROR_REASONS) {
      if (reason === "not_ready") continue;
      const expectedCode = SITE_FILE_REASON_CODES[reason];
      state.execHandler = () => ({
        exitCode: 0,
        stdout: JSON.stringify({ ok: false, code: expectedCode, reason }),
      });

      const err = await helpers
        .run({ serviceInstanceId: "svc_err", op: "list", path: "" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExecutorCodedError);
      expect((err as ExecutorCodedError).code).toBe(expectedCode);
      expect((err as ExecutorCodedError).message).toBe(reason);
    }

    // Non-allowlisted error code (e.g. RESOURCE_LOCKED / HOST_POLICY_DENIED / INTERNAL_ERROR) -> INTERNAL_ERROR
    for (const badReply of [
      JSON.stringify({ ok: false, code: "HOST_POLICY_DENIED", reason: "protected" }),
      JSON.stringify({ ok: false, code: "RESOURCE_LOCKED", reason: "not_ready" }),
      JSON.stringify({ ok: false, code: "VALIDATION_ERROR", reason: "invented_reason" }),
      JSON.stringify({ ok: false, code: "NOT_FOUND", reason: "invalid_path" }),
      JSON.stringify({ ok: true, result: { wrong: "shape" } }),
      "not-json-at-all-SECRET_FILE_BYTES",
    ]) {
      state.execHandler = () => ({ exitCode: 0, stdout: badReply });
      await expect(
        helpers.run({ serviceInstanceId: "svc_err", op: "list", path: "" }),
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    }

    // Non-zero exit code -> INTERNAL_ERROR + logged event without file content
    state.execHandler = () => ({
      exitCode: 255,
      stdout: "SECRET_CONTENT_SHOULD_NOT_BE_LOGGED",
    });
    await expect(
      helpers.run({ serviceInstanceId: "svc_err", op: "list", path: "" }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    // Oversized stdout (truncated) -> INTERNAL_ERROR
    state.execHandler = () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        ok: true,
        result: {
          entries: [
            {
              name: "a".repeat(200),
              kind: "file",
              size: 1,
              modifiedAt: "2026-01-01T00:00:00Z",
              writable: true,
            },
          ],
          truncated: false,
        },
      }).repeat(6000),
    });
    await expect(
      helpers.run({ serviceInstanceId: "svc_err", op: "list", path: "" }),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });

    const loggedText = warnSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(loggedText).toContain("site_files_helper_failed");
    expect(loggedText).not.toContain("SECRET_CONTENT_SHOULD_NOT_BE_LOGGED");
    expect(loggedText).not.toContain("SECRET_FILE_BYTES");
  });

  it("idle sweep removes only idle helpers with no active op and removeAll removes by role", async () => {
    const { target, state } = await createFakeHelperDocker();
    state.volumes.set("hp_vol_svc_busy_html", {
      name: "hp_vol_svc_busy_html",
      labels: { "io.hostingpanel.site_id": "site_busy" },
    });
    state.volumes.set("hp_vol_svc_idle_html", {
      name: "hp_vol_svc_idle_html",
      labels: { "io.hostingpanel.site_id": "site_idle" },
    });

    let releaseBusy!: () => void;
    const busyWait = new Promise<void>((resolve) => {
      releaseBusy = resolve;
    });

    state.execHandler = async (payload) => {
      if (payload.op === "stat") {
        await busyWait;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            result: {
              entry: {
                name: "",
                kind: "dir",
                size: 0,
                modifiedAt: "2026-01-01T00:00:00Z",
                writable: true,
              },
            },
          }),
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, result: { entries: [], truncated: false } }),
      };
    };

    const helpers = new SiteFilesHelpers({
      target,
      programDir: "/var/lib/hosting-panel/site-files",
      idleMs: 30,
    });
    cleanupTasks.push(async () => {
      releaseBusy();
      helpers.stop();
    });

    const busyPromise = helpers.run({ serviceInstanceId: "svc_busy", op: "stat", path: "" });
    await helpers.run({ serviceInstanceId: "svc_idle", op: "list", path: "" });

    // Wait past idleMs while svc_busy is still active
    await new Promise((r) => setTimeout(r, 80));
    const remainingNames = [...state.containers.values()].map((c) => c.name);
    expect(remainingNames).not.toContain("hp_files_svc_idle");
    expect(remainingNames).toContain("hp_files_svc_busy");

    releaseBusy();
    await busyPromise;

    // Now test removeAll with an external site_files container + a non-helper site container
    state.containers.set("orphan_helper", {
      id: "orphan_helper",
      name: "hp_files_orphan",
      running: true,
      image: resolveWordpressImage(DEFAULT_PHP_VERSION),
      labels: { "io.hostingpanel.role": SITE_FILES_ROLE },
    });
    state.containers.set("real_site", {
      id: "real_site",
      name: "wp_site_real",
      running: true,
      image: resolveWordpressImage(DEFAULT_PHP_VERSION),
      labels: { "io.hostingpanel.service_instance_id": "svc_real" },
    });

    await helpers.removeAll();
    expect(state.containers.has("orphan_helper")).toBe(false);
    expect(state.containers.has("real_site")).toBe(true);
  });

  it("rejects invalid paths before touching Docker and replaces stopped or mismatched helpers", async () => {
    const { target, state } = await createFakeHelperDocker();
    state.volumes.set("hp_vol_svc_check_html", {
      name: "hp_vol_svc_check_html",
      labels: { "io.hostingpanel.site_id": "site_check" },
    });

    const helpers = new SiteFilesHelpers({
      target,
      programDir: "/var/lib/hosting-panel/site-files",
    });
    cleanupTasks.push(async () => helpers.stop());

    await expect(
      helpers.run({ serviceInstanceId: "svc_check", op: "list", path: "../etc" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "invalid_path" });
    expect(state.calls).toHaveLength(0);

    // Pre-existing stopped container with matching name gets force-removed and replaced.
    state.containers.set("stale_stopped", {
      id: "stale_stopped",
      name: "hp_files_svc_check",
      running: false,
      image: resolveWordpressImage(DEFAULT_PHP_VERSION),
      labels: { "io.hostingpanel.role": SITE_FILES_ROLE, "io.hostingpanel.files_for": "svc_check" },
    });

    const res = await helpers.run({ serviceInstanceId: "svc_check", op: "list", path: "" });
    expect(res).toEqual({ entries: [], truncated: false });
    expect(state.containers.has("stale_stopped")).toBe(false);
    expect([...state.containers.values()].filter((c) => c.name === "hp_files_svc_check")).toHaveLength(
      1,
    );
  });

  it("rejects volumes with missing or unsafe site_id label using HOST_POLICY_DENIED", async () => {
    const { target, state } = await createFakeHelperDocker();
    state.volumes.set("hp_vol_svc_badvol_html", {
      name: "hp_vol_svc_badvol_html",
      labels: { "io.hostingpanel.site_id": "../bad" },
    });

    const helpers = new SiteFilesHelpers({
      target,
      programDir: "/var/lib/hosting-panel/site-files",
    });
    cleanupTasks.push(async () => helpers.stop());

    await expect(
      helpers.run({ serviceInstanceId: "svc_badvol", op: "list", path: "" }),
    ).rejects.toMatchObject({ code: "HOST_POLICY_DENIED" });
    expect(state.calls.some((c) => c.path.startsWith("/containers/create"))).toBe(false);
  });

  it("starts the PHP program under timeout -s KILL with whole-second budgets below the Node budget", async () => {
    const { target, state } = await createFakeHelperDocker();
    state.volumes.set("hp_vol_svc_cmd_html", {
      name: "hp_vol_svc_cmd_html",
      labels: { "io.hostingpanel.site_id": "site_cmd" },
    });
    state.execHandler = (payload) => {
      if (payload.op === "delete") {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: {} }) };
      }
      if (payload.op === "archive") {
        return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { entries: 1 } }) };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, result: { entries: [], truncated: false } }),
      };
    };

    const helpers = new SiteFilesHelpers({
      target,
      programDir: "/var/lib/hosting-panel/site-files",
    });
    cleanupTasks.push(async () => helpers.stop());

    await helpers.run({ serviceInstanceId: "svc_cmd", op: "list", path: "" });
    await helpers.run({ serviceInstanceId: "svc_cmd", op: "delete", paths: ["a.txt"] });
    await helpers.run({ serviceInstanceId: "svc_cmd", op: "archive", paths: ["a"], to: "a.zip" });

    // Wait briefly for initial fire-and-forget sweep to register
    await new Promise((r) => setTimeout(r, 20));
    const execCmds = state.calls
      .filter((c) => c.method === "POST" && /^\/containers\/[^/]+\/exec$/.test(c.path))
      .map((c) => (c.body as { Cmd?: string[] } | undefined)?.Cmd);

    expect(execCmds).toContainEqual([
      "timeout",
      "-s",
      "KILL",
      "43",
      "php",
      "-d",
      "memory_limit=256M",
      "-d",
      "display_errors=stderr",
      "-d",
      "max_execution_time=0",
      "/usr/local/lib/hp-files/hp-files.php",
    ]);
    expect(execCmds.some((cmd) => cmd?.slice(0, 5).join(" ") === "timeout -s KILL 88 php")).toBe(
      true,
    );
    expect(execCmds.some((cmd) => cmd?.slice(0, 5).join(" ") === "timeout -s KILL 568 php")).toBe(
      true,
    );
  });

  it("keeps the shared helper alive when one of two concurrent run() calls times out (Node backstop or exit 137/124)", async () => {
    const { target, state } = await createFakeHelperDocker();
    state.volumes.set("hp_vol_svc_conc_to_html", {
      name: "hp_vol_svc_conc_to_html",
      labels: { "io.hostingpanel.site_id": "site_conc_to" },
    });

    // Part A: Node-side backstop timeout while a second operation is running on the same helper.
    let signalOpAEntered!: () => void;
    const opAEntered = new Promise<void>((r) => {
      signalOpAEntered = r;
    });
    let signalOpBEntered!: () => void;
    const opBEntered = new Promise<void>((r) => {
      signalOpBEntered = r;
    });
    let releaseOpB!: () => void;
    const opBGate = new Promise<void>((r) => {
      releaseOpB = r;
    });

    state.execHandler = async (payload) => {
      if (payload.op === "list") {
        signalOpAEntered();
        return { hang: true };
      }
      if (payload.op === "stat") {
        signalOpBEntered();
        await opBGate;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            result: {
              entry: {
                name: "",
                kind: "dir",
                size: 0,
                modifiedAt: "2026-01-01T00:00:00Z",
                writable: true,
              },
            },
          }),
        };
      }
      return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: {} }) };
    };

    const helpers = new SiteFilesHelpers({
      target,
      programDir: "/var/lib/hosting-panel/site-files",
      opTimeoutMs: 200,
    });
    cleanupTasks.push(async () => {
      releaseOpB();
      helpers.stop();
    });

    const opA = helpers.run({ serviceInstanceId: "svc_conc_to", op: "list", path: "" });
    const opACatch = opA.catch((err: unknown) => err);
    await opAEntered;

    // Delay opB slightly so opA's 200ms timer expires while opB still has headroom.
    await new Promise((r) => setTimeout(r, 80));
    const opB = helpers.run({ serviceInstanceId: "svc_conc_to", op: "stat", path: "" });
    cleanupTasks.push(async () => {
      releaseOpB();
      await opB.catch(() => undefined);
    });
    await opBEntered;

    const opAErr = await opACatch;
    expect(opAErr).toBeInstanceOf(ExecutorCodedError);
    expect((opAErr as ExecutorCodedError).code).toBe("OPERATION_INTERRUPTED");
    expect(state.calls.some((c) => c.method === "DELETE")).toBe(false);

    releaseOpB();
    const statRes = await opB;
    expect(statRes.entry.kind).toBe("dir");
    expect(state.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(state.containers.has("cid_1")).toBe(true);

    // Part B: timeout -s KILL exit codes (137 and 124) answer OPERATION_INTERRUPTED without deleting the helper.
    for (const killedCode of [137, 124]) {
      state.execHandler = () => ({ exitCode: killedCode, stdout: "" });
      await expect(
        helpers.run({ serviceInstanceId: "svc_conc_to", op: "list", path: "" }),
      ).rejects.toMatchObject({ name: "ExecutorCodedError", code: "OPERATION_INTERRUPTED" });
    }
    expect(state.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(state.containers.has("cid_1")).toBe(true);
  });

  it("idle sweep re-checks active and lastUsed inside the loop so a newly reused helper is never deleted", async () => {
    const { target, state } = await createFakeHelperDocker();
    state.volumes.set("hp_vol_svc_sweep_1_html", {
      name: "hp_vol_svc_sweep_1_html",
      labels: { "io.hostingpanel.site_id": "site_sweep_1" },
    });
    state.volumes.set("hp_vol_svc_sweep_2_html", {
      name: "hp_vol_svc_sweep_2_html",
      labels: { "io.hostingpanel.site_id": "site_sweep_2" },
    });

    let signalSecondRunEntered!: () => void;
    const secondRunEntered = new Promise<void>((r) => {
      signalSecondRunEntered = r;
    });
    let releaseSecondRun!: () => void;
    const secondRunGate = new Promise<void>((r) => {
      releaseSecondRun = r;
    });

    state.execHandler = async (payload) => {
      if (payload.op === "stat") {
        signalSecondRunEntered();
        await secondRunGate;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ok: true,
            result: {
              entry: {
                name: "",
                kind: "dir",
                size: 0,
                modifiedAt: "2026-01-01T00:00:00Z",
                writable: true,
              },
            },
          }),
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, result: { entries: [], truncated: false } }),
      };
    };

    let releaseFirstDelete: (() => void) | undefined;
    const helpers = new SiteFilesHelpers({
      target,
      programDir: "/var/lib/hosting-panel/site-files",
      idleMs: 30,
    });
    cleanupTasks.push(async () => {
      releaseFirstDelete?.();
      releaseSecondRun();
      helpers.stop();
    });

    await helpers.run({ serviceInstanceId: "svc_sweep_1", op: "list", path: "" });
    await helpers.run({ serviceInstanceId: "svc_sweep_2", op: "list", path: "" });

    let firstDeletedRef: string | null = null;
    let signalFirstDeleteStarted!: () => void;
    const firstDeleteStarted = new Promise<void>((r) => {
      signalFirstDeleteStarted = r;
    });
    const firstDeleteGate = new Promise<void>((r) => {
      releaseFirstDelete = r;
    });

    state.onDeleteContainer = async (ref) => {
      if (firstDeletedRef === null) {
        firstDeletedRef = ref;
        signalFirstDeleteStarted();
        await firstDeleteGate;
      }
    };

    await firstDeleteStarted;
    const firstDeletedContainer = [...state.containers.values()].find(
      (c) => c.id === firstDeletedRef || c.name === firstDeletedRef,
    );
    const secondSvc =
      firstDeletedContainer?.labels["io.hostingpanel.files_for"] === "svc_sweep_1"
        ? "svc_sweep_2"
        : "svc_sweep_1";
    const secondHelperName = `hp_files_${secondSvc}`;
    const secondContainerId = [...state.containers.values()].find(
      (c) => c.name === secondHelperName,
    )?.id;
    expect(secondContainerId).toBeDefined();

    // Reuse the second helper while the first DELETE in the sweep loop is still pending.
    const secondOp = helpers.run({ serviceInstanceId: secondSvc, op: "stat", path: "" });
    cleanupTasks.push(async () => {
      releaseSecondRun();
      await secondOp.catch(() => undefined);
    });
    await secondRunEntered;

    releaseFirstDelete?.();
    await new Promise((r) => setTimeout(r, 40));

    // The reused helper must still exist and must never have received a DELETE.
    expect(state.containers.has(secondContainerId!)).toBe(true);
    const deletePaths = state.calls
      .filter((c) => c.method === "DELETE")
      .map((c) => decodeURIComponent(c.path));
    expect(deletePaths.some((p) => p.includes(secondContainerId!) || p.includes(secondHelperName))).toBe(
      false,
    );

    releaseSecondRun();
    const statRes = await secondOp;
    expect(statRes.entry.kind).toBe("dir");
    helpers.stop();
  });

  it("uses a complete valid stdout reply when exec inspect stays Running: true for 2s without removing the helper", async () => {
    const { target, state } = await createFakeHelperDocker();
    state.volumes.set("hp_vol_svc_unk_html", {
      name: "hp_vol_svc_unk_html",
      labels: { "io.hostingpanel.site_id": "site_unk" },
    });

    const helpers = new SiteFilesHelpers({
      target,
      programDir: "/var/lib/hosting-panel/site-files",
    });
    cleanupTasks.push(async () => helpers.stop());

    // Valid ok:true final write reply with Running:true for >2s resolves and keeps helper alive.
    state.execHandler = () => ({
      exitCode: null,
      runningForever: true,
      stdout: JSON.stringify({ ok: true, result: { received: 5 } }),
    });
    const writeRes = await helpers.run({
      serviceInstanceId: "svc_unk",
      op: "write",
      path: "chunk.txt",
      uploadId: "upload_1234567890abcdef",
      offset: 0,
      dataBase64: Buffer.from("hello").toString("base64"),
      final: true,
      overwrite: true,
    });
    expect(writeRes).toEqual({ received: 5 });
    expect(state.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(state.containers.has("cid_1")).toBe(true);

    // Valid ok:false R2 refusal reply with Running:true for >2s propagates refusal and keeps helper alive.
    state.execHandler = () => ({
      exitCode: null,
      runningForever: true,
      stdout: JSON.stringify({ ok: false, code: "ALREADY_EXISTS", reason: "exists" }),
    });
    await expect(
      helpers.run({ serviceInstanceId: "svc_unk", op: "mkdir", path: "existing" }),
    ).rejects.toMatchObject({ name: "ExecutorCodedError", code: "ALREADY_EXISTS", message: "exists" });
    expect(state.calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(state.containers.has("cid_1")).toBe(true);

    // Broken or missing stdout with Running:true for >2s answers OPERATION_INTERRUPTED and removes helper.
    state.execHandler = () => ({
      exitCode: null,
      runningForever: true,
      stdout: "{truncated-json",
    });
    await expect(
      helpers.run({ serviceInstanceId: "svc_unk", op: "list", path: "" }),
    ).rejects.toMatchObject({ name: "ExecutorCodedError", code: "OPERATION_INTERRUPTED" });
    expect(state.calls.some((c) => c.method === "DELETE")).toBe(true);
    expect(state.containers.has("cid_1")).toBe(false);
  }, 10_000);
});
