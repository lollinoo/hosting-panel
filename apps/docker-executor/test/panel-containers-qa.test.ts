// Independent QA of M5b (cycle 11): the two panel calls, the phpMyAdmin mask, log rotation, disks.
// Own fake Engine (a recorder on a unix socket), not the engineers' mock daemon.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  HostTelemetryWireSchema,
  PANEL_CONTAINERS,
  signIpcRequest,
  type IpcSigningKey,
  type IpcVerificationKey,
  type PanelContainer,
} from "@hosting-panel/contracts";
import { createApprovedServiceSpec } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { LinuxSystemHostAdapter } from "../../host-agent/src/linux-adapter.js";
import {
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  InMemoryDockerSimulatorAdapter,
  SHARED_DB_CONFIG_SHA256_LABEL,
  buildHardenedContainerCreatePayload,
  buildSharedDatabaseContainerPayload,
  detectOutOfBandContainerModification,
  type DockerContainerInspectPayload,
} from "../src/index.js";
import { maskPhpMyAdminQuery } from "../src/docker-logs.js";

const KEY = { keyId: "qa-k1", algorithm: "hmac-sha256", secret: "qa-sentinel-hmac-secret-0123456789abcdef" } as const;
const DOCKER_ID = "feedc0de".repeat(8);
const FIXED_NAMES: Record<PanelContainer, string> = {
  ingress_proxy: "hp_ingress_proxy",
  shared_database: "hp_mariadb",
  phpmyadmin: "hp_phpmyadmin",
  sftp: "hp_sftp",
  mail_relay: "hp_mail_relay",
};

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) {
    await task();
  }
});

type Answer = { status: number; body: Buffer | string | object };

/** A fake Engine that records every request and answers from per-name tables. */
async function fakeEngine(dir: string) {
  const seen: string[] = [];
  const inspect = new Map<string, Answer>();
  const logs = new Map<string, Answer>();
  const list: { value: object[] } = { value: [] };
  const socketPath = path.join(dir, "engine.sock");
  const server = http.createServer((req, res) => {
    seen.push(`${req.method ?? ""} ${req.url ?? ""}`);
    const url = (req.url ?? "").replace(/^\/v\d+\.\d+/, "");
    const pathname = url.split("?")[0] ?? "";
    const m = /^\/containers\/([^/]+)\/(json|logs)$/.exec(pathname);
    const send = (a: Answer | undefined) => {
      const answer = a ?? { status: 404, body: { message: "No such container" } };
      const body = Buffer.isBuffer(answer.body) || typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
      res.writeHead(answer.status, { "Content-Type": Buffer.isBuffer(answer.body) ? "application/vnd.docker.raw-stream" : "application/json" });
      res.end(body);
    };
    if (pathname === "/containers/json") return send({ status: 200, body: list.value });
    if (m) return send((m[2] === "json" ? inspect : logs).get(decodeURIComponent(m[1] ?? "")));
    send({ status: 404, body: { message: "page not found" } });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanup.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { socketPath, seen, inspect, logs, list };
}

async function setup() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-qa-m5h-"));
  cleanup.push(() => rm(tmp, { recursive: true, force: true }));
  const engine = await fakeEngine(tmp);
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: engine.socketPath,
    secretsRootDir: path.join(tmp, "secrets"),
    ingressRootDir: path.join(tmp, "ingress"),
    mailRelaySecretDir: path.join(tmp, "mail"),
    sftpStateDir: path.join(tmp, "sftp"),
  });
  return { tmp, engine, adapter };
}

/** Raw signed GET to a real IPC server, so the query string is exactly what the test writes. */
async function rawIpc(executor: DockerEngineSocketAdapter | InMemoryDockerSimulatorAdapter) {
  const server = new DockerExecutorIpcServer({
    executor,
    keyring: { [KEY.keyId]: KEY as IpcVerificationKey },
    transport: "loopback-test",
  });
  cleanup.push(() => server.stop());
  const { port } = await server.start();
  return async (pathWithQuery: string) => {
    const headers = signIpcRequest({ method: "GET", pathWithQuery, body: null, key: KEY as IpcSigningKey });
    const res = await fetch(`http://127.0.0.1:${String(port)}${pathWithQuery}`, { headers: { ...headers } });
    return { status: res.status, text: await res.text() };
  };
}

function frame(text: string, stream: 1 | 2 = 1): Buffer {
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(Buffer.byteLength(text), 4);
  return Buffer.concat([head, Buffer.from(text)]);
}

const running = (extra: Record<string, unknown> = {}): Answer => ({
  status: 200,
  body: { Id: DOCKER_ID, State: { Status: "running", Running: true, StartedAt: "2026-11-16T09:00:00.987654321Z" }, RestartCount: 1, ...extra },
});

describe("1. no name from outside reaches the Engine", () => {
  const badComponents = [
    "hp_mariadb", "docker", "..%2Fx", "../x", "ingress_proxy%2F..%2Fx", "ingress_proxy/../x", "ingress_proxy%00",
    "", "INGRESS_PROXY", "Sftp", "sftp&component=sftp", "shared_database&component=phpmyadmin",
  ];
  it.each(badComponents)("component=%s is refused with 400 and the Engine sees nothing", async (component) => {
    const { engine, adapter } = await setup();
    const get = await rawIpc(adapter);
    const res = await get(`/v1/panel/logs?component=${component}&tail=5`);
    expect(res.status).toBe(400);
    expect(res.text).toContain("VALIDATION_ERROR");
    expect(engine.seen).toEqual([]);
  });

  it.each(["0", "501", "-1", "1e3", "abc", "", "5&tail=999"])("tail=%s is refused with 400 and the Engine sees nothing", async (tail) => {
    const { engine, adapter } = await setup();
    const get = await rawIpc(adapter);
    const res = await get(`/v1/panel/logs?component=sftp&tail=${tail}`);
    expect(res.status).toBe(400);
    expect(res.text).toContain("VALIDATION_ERROR");
    expect(engine.seen).toEqual([]);
  });

  it("no tail at all is refused too", async () => {
    const { engine, adapter } = await setup();
    const res = await (await rawIpc(adapter))("/v1/panel/logs?component=sftp");
    expect(res.status).toBe(400);
    expect(engine.seen).toEqual([]);
  });

  it("each allowed component reads exactly its fixed container name, and the status call inspects only the five", async () => {
    const { engine, adapter } = await setup();
    for (const name of Object.values(FIXED_NAMES)) {
      engine.logs.set(name, { status: 200, body: frame("2026-11-16T09:00:00Z ok\n") });
    }
    const get = await rawIpc(adapter);
    for (const component of PANEL_CONTAINERS) {
      engine.seen.length = 0;
      const res = await get(`/v1/panel/logs?component=${component}&tail=500`);
      expect(res.status).toBe(200);
      expect(engine.seen).toEqual([
        `GET /v1.45/containers/${FIXED_NAMES[component]}/logs?stdout=1&stderr=1&timestamps=1&tail=500`,
      ]);
    }
    engine.seen.length = 0;
    expect((await get("/v1/panel/containers")).status).toBe(200);
    expect([...engine.seen].sort()).toEqual(
      Object.values(FIXED_NAMES).map((n) => `GET /v1.45/containers/${n}/json`).sort(),
    );
  });
});

describe("2. always five, never an error for a missing one", () => {
  it("none present: five rows, all missing, in contract order", async () => {
    const { adapter } = await setup();
    const rows = await adapter.getPanelContainers();
    expect(rows.map((r) => [r.component, r.state, r.startedAt, r.restartCount])).toEqual(
      PANEL_CONTAINERS.map((c) => [c, "missing", null, 0]),
    );
    expect(rows.map((r) => r.expected)).toEqual([false, true, false, false, false]);
  });

  it("some and all present, with states the mapper does not name", async () => {
    const { engine, adapter } = await setup();
    engine.inspect.set("hp_mariadb", running());
    engine.inspect.set("hp_sftp", { status: 200, body: { Id: DOCKER_ID, State: { Status: "exited", Running: false, StartedAt: "0001-01-01T00:00:00Z" } } });
    const some = await adapter.getPanelContainers();
    expect(some.map((r) => r.state)).toEqual(["missing", "running", "missing", "stopped", "missing"]);
    expect(some[1]).toMatchObject({ startedAt: "2026-11-16T09:00:00.987Z", restartCount: 1 });
    expect(some[3]).toMatchObject({ startedAt: null, restartCount: 0 });

    engine.inspect.set("hp_ingress_proxy", running());
    engine.inspect.set("hp_phpmyadmin", { status: 200, body: { Id: DOCKER_ID, State: { Status: "removing" } } });
    engine.inspect.set("hp_mail_relay", { status: 200, body: { Id: DOCKER_ID } });
    const all = await adapter.getPanelContainers();
    expect(all.map((r) => r.state)).toEqual(["running", "running", "unknown", "stopped", "unknown"]);
    // Exists, so expected (design table: ingress when present, phpMyAdmin when present).
    expect(all[0]?.expected).toBe(true);
    expect(all[2]?.expected).toBe(true);
    expect(JSON.stringify(all)).not.toContain(DOCKER_ID);
  });

  it("one inspect answering 500 fails the whole call as DOCKER_ENGINE_UNAVAILABLE (design: an Engine error is not 'missing')", async () => {
    const { engine, adapter } = await setup();
    engine.inspect.set("hp_mariadb", running());
    engine.inspect.set("hp_sftp", { status: 500, body: { message: "boom" } });
    await expect(adapter.getPanelContainers()).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
  });

  it("an unreachable Engine reaches the IPC caller as 503 DOCKER_ENGINE_UNAVAILABLE, never as five missing", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-qa-m5h-gone-"));
    cleanup.push(() => rm(tmp, { recursive: true, force: true }));
    const adapter = new DockerEngineSocketAdapter({ dockerSocketPath: path.join(tmp, "absent.sock"), secretsRootDir: path.join(tmp, "s"), ingressRootDir: path.join(tmp, "i") });
    const get = await rawIpc(adapter);
    const res = await get("/v1/panel/containers");
    expect(res.status).toBe(503);
    expect(res.text).toContain("DOCKER_ENGINE_UNAVAILABLE");
    expect(res.text).not.toContain("missing");
    expect(res.text).not.toContain(tmp);
  });
});

describe("3. the phpMyAdmin mask", () => {
  const cases: Array<[string, string, string]> = [
    [
      "token in the query",
      '10.0.0.5 - admin [16/Nov/2026:10:00:00 +0000] "GET /index.php?route=/&token=SENTINELTOKEN0001 HTTP/1.1" 200 1234 "-" "Mozilla/5.0"',
      '10.0.0.5 - admin [16/Nov/2026:10:00:00 +0000] "GET /index.php?[masked] HTTP/1.1" 200 1234 "-" "Mozilla/5.0"',
    ],
    [
      "SQL in the query",
      '10.0.0.5 - admin [x] "GET /index.php?route=/sql&db=wp&sql_query=SELECT+%2A+FROM+wp_users&token=SENTINELTOKEN0002 HTTP/1.1" 200 1',
      '10.0.0.5 - admin [x] "GET /index.php?[masked] HTTP/1.1" 200 1',
    ],
    [
      "query in the referer only",
      '10.0.0.5 - admin [x] "POST /index.php HTTP/1.1" 200 1 "https://panel.example.test/phpmyadmin/s1/index.php?route=/sql&token=SENTINELTOKEN0003" "agent"',
      '10.0.0.5 - admin [x] "POST /index.php HTTP/1.1" 200 1 "https://panel.example.test/phpmyadmin/s1/index.php?[masked]" "agent"',
    ],
    [
      "two ? in one URL",
      '"GET /index.php?a=1?token=SENTINELTOKEN0004 HTTP/1.1" 200 1',
      '"GET /index.php?[masked] HTTP/1.1" 200 1',
    ],
    ["a ? with nothing after it", '"GET /index.php? HTTP/1.1" 200 1', '"GET /index.php?[masked] HTTP/1.1" 200 1'],
    [
      "an encoded %3F after a real ?",
      '"GET /index.php?x=1%3Ftoken=SENTINELTOKEN0005 HTTP/1.1" 200 1',
      '"GET /index.php?[masked] HTTP/1.1" 200 1',
    ],
    [
      "not an access log, no ?",
      "AH00558: apache2: Could not reliably determine the server's fully qualified domain name, using 10.0.0.5",
      "AH00558: apache2: Could not reliably determine the server's fully qualified domain name, using 10.0.0.5",
    ],
    [
      "a multi-byte character in the query and outside it",
      '10.0.0.5 - admin [x] "GET /café/index.php?db=wp&q=café™&token=SENTINELTOKEN0006 HTTP/1.1" 200 1 "-" "Mozilla (ü)"',
      '10.0.0.5 - admin [x] "GET /café/index.php?[masked] HTTP/1.1" 200 1 "-" "Mozilla (ü)"',
    ],
    [
      "Apache's escaped bytes in the query",
      '"GET /index.php?q=caf\\xc3\\xa9&token=SENTINELTOKEN0007 HTTP/1.1" 200 1',
      '"GET /index.php?[masked] HTTP/1.1" 200 1',
    ],
    [
      "a PHP error line with a referer",
      "PHP Warning:  Undefined index in /var/www/html/libraries/x.php on line 5, referer: https://panel.example.test/index.php?route=/&token=SENTINELTOKEN0008",
      "PHP Warning:  Undefined index in /var/www/html/libraries/x.php on line 5, referer: https://panel.example.test/index.php?[masked]",
    ],
    [
      "Apache's escaped quote inside the query",
      '"GET /index.php?sql_query=SELECT+\\"a\\"&token=SENTINELTOKEN0009 HTTP/1.1" 200 1',
      '"GET /index.php?[masked] HTTP/1.1" 200 1',
    ],
  ];

  it.each(cases)("%s: no parameter value is left, the rest is unchanged", (_name, line, masked) => {
    const out = maskPhpMyAdminQuery(line);
    expect(out).not.toMatch(/SENTINELTOKEN|sql_query|SELECT|wp_users/);
    expect(out).toBe(masked);
  });

  it("a very long query is masked whole, also after the 2000-character cut", async () => {
    const huge = `"GET /index.php?token=SENTINELTOKEN0010&sql_query=${"A".repeat(200_000)} HTTP/1.1" 200 1`;
    expect(maskPhpMyAdminQuery(huge)).toBe('"GET /index.php?[masked] HTTP/1.1" 200 1');

    const { engine, adapter } = await setup();
    engine.logs.set("hp_phpmyadmin", { status: 200, body: frame(`2026-11-16T09:00:00Z ${huge}\n`) });
    const [line] = await adapter.getPanelContainerLogs({ component: "phpmyadmin", tail: 1 });
    expect(line?.text).toBe('"GET /index.php?[masked]');
  });

  it("is applied to phpMyAdmin on both streams, and to no other component", async () => {
    const { engine, adapter } = await setup();
    const raw = '"GET /index.php?token=SENTINELTOKEN0011 HTTP/1.1" 200 1';
    const body = Buffer.concat([frame(`2026-11-16T09:00:00Z ${raw}\n`, 1), frame(`2026-11-16T09:00:01Z ${raw}\n`, 2)]);
    for (const name of Object.values(FIXED_NAMES)) {
      engine.logs.set(name, { status: 200, body });
    }
    const pma = await adapter.getPanelContainerLogs({ component: "phpmyadmin", tail: 10 });
    expect(pma.map((l) => [l.stream, l.text])).toEqual([
      ["stdout", '"GET /index.php?[masked] HTTP/1.1" 200 1'],
      ["stderr", '"GET /index.php?[masked] HTTP/1.1" 200 1'],
    ]);
    for (const component of PANEL_CONTAINERS.filter((c) => c !== "phpmyadmin")) {
      const lines = await adapter.getPanelContainerLogs({ component, tail: 10 });
      expect(lines.map((l) => l.text)).toEqual([raw, raw]);
    }
  });
});

describe("4. bounds", () => {
  it("a tail above 500 never reaches the Engine; the shared reader clamps to 500", async () => {
    const { engine, adapter } = await setup();
    engine.logs.set("hp_mariadb", { status: 200, body: frame("2026-11-16T09:00:00Z x\n") });
    await expect(adapter.getPanelContainerLogs({ component: "shared_database", tail: 10_000 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(engine.seen).toEqual([]);
    await adapter.readContainerLogs("hp_mariadb", 10_000);
    expect(engine.seen).toEqual(["GET /v1.45/containers/hp_mariadb/logs?stdout=1&stderr=1&timestamps=1&tail=500"]);
  });

  it("one line of several megabytes gives an answer of one 2000-character line, without id or host path", async () => {
    const { tmp, engine, adapter } = await setup();
    engine.logs.set("hp_sftp", { status: 200, body: frame(`2026-11-16T09:00:00Z ${"B".repeat(6 * 1024 * 1024)}\n`, 2) });
    engine.inspect.set("hp_sftp", running());
    const get = await rawIpc(adapter);
    const res = await get("/v1/panel/logs?component=sftp&tail=500");
    expect(res.status).toBe(200);
    expect(Buffer.byteLength(res.text)).toBeLessThan(2_200);
    const data = (JSON.parse(res.text) as { data: Array<{ text: string }> }).data;
    expect(data).toHaveLength(1);
    expect(data[0]?.text).toHaveLength(2000);
    const status = await get("/v1/panel/containers");
    for (const text of [res.text, status.text]) {
      expect(text).not.toContain(DOCKER_ID);
      expect(text).not.toContain(tmp);
      expect(text).not.toContain("/var/");
    }
  });
});

describe("5. rotation changes nothing the comparisons read", () => {
  const spec = () =>
    createApprovedServiceSpec({
      serviceInstanceId: "svc_qa_rot",
      siteId: "site_qa_rot",
      organizationId: "org_qa_rot",
      image: "ghcr.io/example/webapp:2.0.0",
      containerName: "hp-site-qa-rot",
      revisionNumber: 7,
      specHash: "sentinel_spec_hash_qa",
    });

  it("a site container made before M5b (no LogConfig) is not flagged as drift, and neither is a new one", () => {
    const payload = buildHardenedContainerCreatePayload(spec());
    expect(payload.HostConfig.LogConfig).toEqual({ Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } });
    const { LogConfig: _dropped, ...before } = payload.HostConfig;
    const asInspect = (hostConfig: object): DockerContainerInspectPayload =>
      ({ Id: DOCKER_ID, Config: { Image: payload.Image, Labels: payload.Labels, Env: payload.Env }, HostConfig: hostConfig }) as DockerContainerInspectPayload;
    const expected = {
      serviceInstanceId: "svc_qa_rot", siteId: "site_qa_rot", organizationId: "org_qa_rot",
      image: payload.Image, containerName: "hp-site-qa-rot", specHash: "sentinel_spec_hash_qa", revisionNumber: 7, expectedEnv: [],
    };
    expect(detectOutOfBandContainerModification(asInspect(before), "svc_qa_rot", "/nonexistent-secrets", expected)).toBe(false);
    expect(detectOutOfBandContainerModification(asInspect(payload.HostConfig), "svc_qa_rot", "/nonexistent-secrets", expected)).toBe(false);
    // The comparison key itself: the spec hash label is the spec's, untouched by the payload's HostConfig.
    expect(payload.Labels["io.hostingpanel.spec_hash"]).toBe("sentinel_spec_hash_qa");
  });

  it("the hp_mariadb label is the hash of Image, Cmd, User, Env and Binds only, whatever HostConfig carries", () => {
    const payload = buildSharedDatabaseContainerPayload({
      user: "999:999",
      dataDirHostPath: "/srv/qa/mariadb",
      rootKeyHostPath: "/srv/qa/root.key",
      adminSubnet: "172.31.250.0/24",
    });
    const hashOf = (p: { Image: string; Cmd: readonly string[]; User?: string; Env: readonly string[]; HostConfig: { Binds: readonly string[] } }) =>
      createHash("sha256").update(JSON.stringify({ Image: p.Image, Cmd: p.Cmd, User: p.User, Env: p.Env, Binds: [...p.HostConfig.Binds].sort() })).digest("hex");
    const sentWithRotation = { ...payload, HostConfig: { ...payload.HostConfig, LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } } } };
    expect(payload.Labels[SHARED_DB_CONFIG_SHA256_LABEL]).toBe(hashOf(payload));
    expect(payload.Labels[SHARED_DB_CONFIG_SHA256_LABEL]).toBe(hashOf(sentWithRotation));
    expect("LogConfig" in payload.HostConfig).toBe(false);
  });
});

describe("6. the simulator", () => {
  it("defaults follow the report with a panel, SFTP users and a mail relay; override, order, missing logs, Engine off", async () => {
    const sim = new InMemoryDockerSimulatorAdapter({
      panel: { hostname: "panel.example.test", ipv4: "192.0.2.10", acmeEmail: null, acmeStaging: false } as never,
    });
    sim.sftpUsers = [{ username: "qa_user" } as never];
    await sim.applyMailRelay({} as never);
    expect(await sim.getPanelContainers()).toEqual([
      { component: "ingress_proxy", state: "running", expected: true, startedAt: null, restartCount: 0, imageCurrent: true },
      { component: "shared_database", state: "running", expected: true, startedAt: null, restartCount: 0, imageCurrent: true },
      { component: "phpmyadmin", state: "missing", expected: false, startedAt: null, restartCount: 0, imageCurrent: null },
      { component: "sftp", state: "running", expected: true, startedAt: null, restartCount: 0, imageCurrent: true },
      { component: "mail_relay", state: "running", expected: true, startedAt: null, restartCount: 0, imageCurrent: true },
    ]);
    sim.setPanelContainer("shared_database", { state: "degraded", startedAt: "2026-11-16T09:00:00.000Z", restartCount: 9 });
    sim.setPanelContainer("shared_database", { expected: false });
    const rows = await sim.getPanelContainers();
    expect(rows.map((r) => r.component)).toEqual([...PANEL_CONTAINERS]);
    expect(rows[1]).toEqual({ component: "shared_database", state: "degraded", expected: false, startedAt: "2026-11-16T09:00:00.000Z", restartCount: 9, imageCurrent: true });
    await expect(sim.getPanelContainerLogs({ component: "phpmyadmin", tail: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    sim.setPanelContainer("sftp", { state: "missing" });
    await expect(sim.getPanelContainerLogs({ component: "sftp", tail: 5 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    sim.setEngineReachable(false);
    await expect(sim.getPanelContainers()).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    await expect(sim.getPanelContainerLogs({ component: "shared_database", tail: 5 })).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
  });

  it("over IPC the simulator answers like the real adapter: 400 for a bad tail, 404 for a missing container", async () => {
    const get = await rawIpc(new InMemoryDockerSimulatorAdapter());
    expect((await get("/v1/panel/logs?component=sftp&tail=501")).status).toBe(400);
    expect((await get("/v1/panel/logs?component=phpmyadmin&tail=5")).status).toBe(404);
    const rows = JSON.parse((await get("/v1/panel/containers")).text) as { data: unknown[] };
    expect(rows.data).toHaveLength(5);
  });
});

describe("7. the disks of the host agent", () => {
  it("two names on one filesystem share a row, a missing folder is skipped, no folder leaks", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-qa-m5h-disk-"));
    cleanup.push(() => rm(tmp, { recursive: true, force: true }));
    const a = path.join(tmp, "panel-a");
    const b = path.join(tmp, "docker-b");
    await mkdir(a);
    await mkdir(b);
    const agent = new LinuxSystemHostAdapter({
      storagePath: a,
      diskPaths: { docker_data: b, database_data: path.join(tmp, "absent"), root: path.join(tmp, "absent-too") },
    });
    const telemetry = await agent.getHostTelemetry("host_qa");
    if (!telemetry) throw new Error("no telemetry");
    expect(HostTelemetryWireSchema.safeParse(telemetry).success).toBe(true);
    expect(telemetry.disks).toEqual([
      { paths: ["panel_data", "docker_data"], usedBytes: expect.stringMatching(/^\d+$/), totalBytes: expect.stringMatching(/^\d+$/) },
    ]);
    const row = telemetry.disks?.[0];
    expect(BigInt(row?.usedBytes ?? "1")).toBeLessThanOrEqual(BigInt(row?.totalBytes ?? "0"));
    const wire = JSON.stringify(telemetry);
    for (const p of [tmp, a, b, "panel-a", "docker-b", "absent"]) {
      expect(wire).not.toContain(p);
    }
  });

  it("the disk reader starts no program: readDisks uses stat and statfs only", async () => {
    const source = await readFile(new URL("../../host-agent/src/linux-adapter.ts", import.meta.url), "utf8");
    const body = /private async readDisks\(\)[\s\S]*?\n {2}\}\n/.exec(source)?.[0] ?? "";
    expect(body).toContain("statfs(");
    expect(body).not.toMatch(/execFile|runAllowlistedBinary|spawn|exec\(|child_process/);
  });
});

describe("8. getServiceLogs after the shared reader", () => {
  const summary = { Id: DOCKER_ID, Names: ["/hp-site-a"], Labels: { "io.hostingpanel.service_instance_id": "svc_qa_logs" } };

  it("returns the same lines as before, clamps the same way, and never masks a site's line", async () => {
    const { engine, adapter } = await setup();
    engine.list.value = [summary];
    const raw = '"GET /wp-login.php?redirect_to=SENTINELSITEQUERY HTTP/1.1" 302 0';
    engine.logs.set(DOCKER_ID, { status: 200, body: Buffer.concat([frame(`2026-11-16T09:00:00.1Z ${raw}\n`), frame("no-timestamp line\n", 2)]) });
    expect(await adapter.getServiceLogs("svc_qa_logs", 9999)).toEqual([
      { at: "2026-11-16T09:00:00.1Z", stream: "stdout", text: raw },
      { at: null, stream: "stderr", text: "no-timestamp line" },
    ]);
    await adapter.getServiceLogs("svc_qa_logs", 0);
    const logPaths = engine.seen.filter((s) => s.includes("/logs?"));
    expect(logPaths).toEqual([
      `GET /v1.45/containers/${DOCKER_ID}/logs?stdout=1&stderr=1&timestamps=1&tail=500`,
      `GET /v1.45/containers/${DOCKER_ID}/logs?stdout=1&stderr=1&timestamps=1&tail=1`,
    ]);
  });

  it("the one named change: a container gone between list and read is NOT_FOUND; an Engine error stays DOCKER_ENGINE_UNAVAILABLE", async () => {
    const { engine, adapter } = await setup();
    await expect(adapter.getServiceLogs("svc_qa_logs", 5)).rejects.toMatchObject({ code: "NOT_FOUND" });
    engine.list.value = [summary];
    await expect(adapter.getServiceLogs("svc_qa_logs", 5)).rejects.toMatchObject({ code: "NOT_FOUND" });
    engine.logs.set(DOCKER_ID, { status: 500, body: { message: "boom" } });
    await expect(adapter.getServiceLogs("svc_qa_logs", 5)).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
  });
});
