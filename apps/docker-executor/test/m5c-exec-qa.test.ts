// Independent QA of M5c (cycle 12): the six terminal and restart calls over the signed IPC.
// Real IPC server on 127.0.0.1, raw signed requests, the simulator and the shipped mock daemon.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ERROR_CODE_HTTP_STATUS,
  PANEL_CONTAINERS,
  TERMINAL_READ_WAIT_MS,
  signIpcRequest,
  type ErrorCode,
  type IpcSigningKey,
  type IpcVerificationKey,
  type PanelContainer,
} from "@hosting-panel/contracts";
import { createApprovedServiceSpec, type DockerExecutorPort } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  InMemoryDockerSimulatorAdapter,
  MANAGED_DOCKER_LABELS,
  SignedDockerExecutorIpcClient,
  TERMINAL_KILL_SCRIPT,
  type TerminalLimits,
} from "../src/index.js";
import { TERMINAL_READ_TIMEOUT_MS } from "../src/client.js";
import { TERMINAL_ENDED_KEPT_MS } from "../src/terminal-sessions.js";
import { type MockDockerContainerRecord, type MockDockerDaemon, startMockDockerDaemon } from "./mock-docker-daemon.js";

const KEY = { keyId: "qa-m5c", algorithm: "hmac-sha256", secret: "qa-m5c-sentinel-hmac-secret-0123456789abcdef" } as const;
const WRONG_KEY = { ...KEY, secret: "qa-m5c-sentinel-WRONG-secret-0123456789abcdef" } as const;
const SID = (n: number) => `term_${n.toString(16).padStart(32, "0")}`;
const PROMPT = "/var/www/html $ ";
const IN_CANARY = "HPQAIN7f3a";
const OUT_CANARY = "HPQAOUT9c1e";
const SIX = ["openTerminal", "writeTerminal", "readTerminal", "closeTerminal", "listTerminals", "restartPanelContainer"] as const;

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const task of cleanup.splice(0).reverse()) await task();
});

type How = "signed" | "none" | "wrong" | "old";
interface Raw { status: number; text: string; body: { data?: unknown; error?: { code?: string; message?: string } } }

/** A real signed IPC server; `raw` sends exactly the bytes and headers the test chooses. */
async function ipc(executor: DockerExecutorPort) {
  const server = new DockerExecutorIpcServer({ executor, keyring: { [KEY.keyId]: KEY as IpcVerificationKey }, transport: "loopback-test" });
  cleanup.push(() => server.stop());
  const { port } = await server.start();
  const client = new SignedDockerExecutorIpcClient({ signingKey: KEY as IpcSigningKey, transport: "loopback-test", port });
  const raw = async (method: "GET" | "POST", pathWithQuery: string, body?: unknown, how: How = "signed"): Promise<Raw> => {
    const text = body === undefined ? null : JSON.stringify(body);
    const headers =
      how === "none"
        ? {}
        : signIpcRequest({
            method, pathWithQuery, body: text, key: (how === "wrong" ? WRONG_KEY : KEY) as IpcSigningKey,
            ...(how === "old" ? { timestampMs: Date.now() - 5 * 60_000 } : {}),
          });
    const res = await fetch(`http://127.0.0.1:${String(port)}${pathWithQuery}`, {
      method, headers: { ...headers, ...(text ? { "content-type": "application/json" } : {}) }, ...(text ? { body: text } : {}),
    });
    const t = await res.text();
    return { status: res.status, text: t, body: (t ? JSON.parse(t) : {}) as Raw["body"] };
  };
  return { client, raw };
}

/** The six port methods as spies that still call the real ones. */
function spySix(executor: DockerExecutorPort) {
  return SIX.map((m) => vi.spyOn(executor, m));
}

function spec(n: number) {
  return createApprovedServiceSpec({
    serviceInstanceId: `svc_${n}`, siteId: `site_${n}`, organizationId: "org_1",
    image: "wordpress:7.1.4-php8.4-apache", containerName: `hp_svc_svc_${n}`,
  });
}

async function sim(sites = 1, terminalLimits?: Partial<TerminalLimits>) {
  const s = new InMemoryDockerSimulatorAdapter(terminalLimits ? { terminalLimits } : undefined);
  for (let n = 1; n <= sites; n++) await s.deployService(spec(n));
  return s;
}

const openReq = (n: number, site = n) => ({ sessionId: SID(n), siteId: `site_${site}`, serviceInstanceId: `svc_${site}` });

/** Reads by cursor until `until` is in the text read so far. */
async function readUntil(client: SignedDockerExecutorIpcClient, sessionId: string, cursor: number, until: string) {
  let text = "";
  for (let i = 0; i < 20 && !text.includes(until); i++) {
    const r = await client.readTerminal({ sessionId, cursor });
    text += r.output;
    cursor = r.cursor;
    if (r.ended) break;
  }
  return { text, cursor };
}

function siteRecord(n: number, extra?: Partial<MockDockerContainerRecord>): MockDockerContainerRecord {
  return {
    id: `hp_site_${n}_id`, name: `hp_site_${n}`, image: "wordpress:test", env: [], running: true, status: "running",
    restartCount: 0, startedAt: "2026-11-17T01:00:00.000000001Z", hostConfig: {}, networks: {},
    labels: { [MANAGED_DOCKER_LABELS.siteId]: `site_${n}`, [MANAGED_DOCKER_LABELS.serviceInstanceId]: `svc_${n}` },
    ...extra,
  };
}

/** The real adapter on the shipped mock daemon, with a tmp data folder. */
async function engine(sites: number, terminalLimits?: Partial<TerminalLimits>) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-qa-m5c-"));
  cleanup.push(() => rm(tmp, { recursive: true, force: true }));
  const mockDaemon = await startMockDockerDaemon({ execUpgrade: true });
  cleanup.push(() => mockDaemon.close());
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: mockDaemon.socketPath,
    secretsRootDir: path.join(tmp, "secrets"),
    ingressRootDir: path.join(tmp, "ingress"),
    mailRelaySecretDir: path.join(tmp, "mail"),
    sftpStateDir: path.join(tmp, "sftp"),
    sharedDbDataDir: path.join(tmp, "db"),
    sharedDbRootKeyFile: path.join(tmp, "db.key"),
    phpMyAdminConfigDir: path.join(tmp, "pma"),
    pullMissingImages: false,
    terminalLimits: { readWaitMs: 100, ...terminalLimits },
  });
  cleanup.push(() => adapter.listTerminals().then((all) => Promise.all(all.map((s) => adapter.closeTerminal(s).catch(() => undefined)))));
  for (let n = 1; n <= sites; n++) mockDaemon.containers.set(`hp_site_${n}_id`, siteRecord(n));
  return { tmp, adapter, mockDaemon };
}

/** Every kill-script exec as [container, session argument, user]. */
function kills(d: MockDockerDaemon) {
  return d.execBodies.flatMap((b, i) =>
    (b.Cmd as string[])[2] === TERMINAL_KILL_SCRIPT ? [[d.execCalls[i]!.container, (b.Cmd as string[])[4], b.User]] : [],
  );
}

/** The raw stream of the n-th exec created (1-based). */
const stream = (d: MockDockerDaemon, n: number) => d.execStreams.find((s) => s.execId === `exec_${String(n)}`)!.socket;

const settled = (ps: Array<Promise<unknown>>) =>
  Promise.all(ps.map((p) => p.then(() => "ok", (e: { code?: string }) => e.code ?? "?")));

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) out.push(path.join(e.parentPath, e.name));
  }
  return out.sort();
}

// ---------------------------------------------------------------------------------------------

describe("1. only a signed request reaches a terminal", () => {
  const routes: Array<[string, "GET" | "POST", string, unknown]> = [
    ["open", "POST", "/v1/terminal/open", openReq(1)],
    ["write", "POST", "/v1/terminal/write", { sessionId: SID(1), input: "id\n" }],
    ["read", "POST", "/v1/terminal/read", { sessionId: SID(1), cursor: 0 }],
    ["close", "POST", "/v1/terminal/close", { sessionId: SID(1) }],
    ["list", "GET", "/v1/terminal/sessions", undefined],
    ["restart", "POST", "/v1/panel/restart", { component: "shared_database" }],
  ];
  it.each(routes)("%s refuses no signature, a wrong one and an old one with 401, before the adapter", async (_n, method, p, body) => {
    const s = await sim();
    const spies = spySix(s);
    const { raw } = await ipc(s);
    for (const how of ["none", "wrong", "old"] as const) {
      const r = await raw(method, p, body, how);
      expect([how, r.status, r.body.error?.code]).toEqual([how, 401, "UNAUTHENTICATED"]);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // the same request, signed, does reach the adapter
    await raw(method, p, body);
    expect(spies.some((spy) => spy.mock.calls.length === 1)).toBe(true);
  });
});

describe("2. a whole session over the signed IPC, on the simulator", () => {
  it("open, id, a waiting read answered by output, a read empty at its limit, exit, list, close", async () => {
    const s = await sim(1, { readWaitMs: 400 });
    const { client } = await ipc(s);
    const opened = await client.openTerminal(openReq(1));
    expect(opened).toMatchObject({ containerName: "hp_svc_svc_1" });
    let { text, cursor } = await readUntil(client, SID(1), 0, PROMPT);
    expect(text).toBe(PROMPT);

    await client.writeTerminal({ sessionId: SID(1), input: "id\n" });
    ({ text, cursor } = await readUntil(client, SID(1), cursor, `\r\n${PROMPT}`));
    expect(text).toBe(`id\r\nuid=33(www-data) gid=33(www-data) groups=33(www-data)\r\n${PROMPT}`);

    // a read with nothing new waits, and is answered when output comes
    const t0 = Date.now();
    const waiting = client.readTerminal({ sessionId: SID(1), cursor });
    await new Promise((r) => setTimeout(r, 100));
    s.emitTerminalOutput(SID(1), "late\r\n");
    const answered = await waiting;
    expect(answered).toMatchObject({ output: "late\r\n", ended: null, dropped: false });
    expect(Date.now() - t0).toBeLessThan(400);
    cursor = answered.cursor;

    // a read that waits to its limit comes back empty at the same cursor
    const t1 = Date.now();
    await expect(client.readTerminal({ sessionId: SID(1), cursor })).resolves.toEqual({ output: "", cursor, dropped: false, ended: null });
    expect(Date.now() - t1).toBeGreaterThanOrEqual(350);

    await client.writeTerminal({ sessionId: SID(1), input: "exit\n" });
    const last = await readUntil(client, SID(1), cursor, "never");
    expect(last.text).toBe("exit\r\n");
    const listed = await client.listTerminals();
    expect(listed).toEqual([{ ...openReq(1), containerName: "hp_svc_svc_1", openedAt: opened.openedAt, ended: { reason: "shell_exited", at: expect.any(String) } }]);
    await expect(client.closeTerminal({ sessionId: SID(1) })).resolves.toEqual(listed[0]!.ended);
    await expect(client.listTerminals()).resolves.toEqual([]);

    // a live session closed by the administrator answers closed
    await client.openTerminal(openReq(2, 1));
    await expect(client.closeTerminal({ sessionId: SID(2) })).resolves.toMatchObject({ reason: "closed" });
    await expect(client.listTerminals()).resolves.toEqual([]);
  });

  it(
    "with the shipped wait, an empty read comes back after TERMINAL_READ_WAIT_MS, inside the client's own limit",
    async () => {
      expect(TERMINAL_READ_WAIT_MS).toBeLessThan(TERMINAL_READ_TIMEOUT_MS);
      const s = await sim(1);
      const { client } = await ipc(s);
      await client.openTerminal(openReq(1));
      const t0 = Date.now();
      await expect(client.readTerminal({ sessionId: SID(1), cursor: PROMPT.length })).resolves.toMatchObject({ output: "", ended: null });
      const took = Date.now() - t0;
      expect(took).toBeGreaterThanOrEqual(TERMINAL_READ_WAIT_MS - 100);
      expect(took).toBeLessThan(TERMINAL_READ_TIMEOUT_MS);
    },
    TERMINAL_READ_TIMEOUT_MS + 5_000,
  );

  it("each executor error code arrives with the HTTP status of ERROR_CODE_HTTP_STATUS", async () => {
    const s = await sim(5);
    const { raw } = await ipc(s);
    const seen: Array<[string, number]> = [];
    const expectCode = async (r: Promise<Raw>, code: ErrorCode) => {
      const got = await r;
      seen.push([got.body.error?.code ?? "?", got.status]);
      expect([got.body.error?.code, got.status]).toEqual([code, ERROR_CODE_HTTP_STATUS[code]]);
    };
    expect((await raw("POST", "/v1/terminal/open", openReq(1))).status).toBe(200);
    await expectCode(raw("POST", "/v1/terminal/open", openReq(1)), "ALREADY_EXISTS");
    await expectCode(raw("POST", "/v1/terminal/open", openReq(9, 1)), "RESOURCE_LOCKED");
    for (const n of [2, 3, 4]) expect((await raw("POST", "/v1/terminal/open", openReq(n))).status).toBe(200);
    await expectCode(raw("POST", "/v1/terminal/open", openReq(5)), "QUOTA_EXCEEDED");
    await expectCode(raw("POST", "/v1/terminal/read", { sessionId: SID(77), cursor: 0 }), "NOT_FOUND");
    await expectCode(raw("POST", "/v1/terminal/write", { sessionId: SID(77), input: "x" }), "NOT_FOUND");
    await expectCode(raw("POST", "/v1/terminal/close", { sessionId: SID(77) }), "NOT_FOUND");
    await expectCode(raw("POST", "/v1/terminal/read", { sessionId: SID(1), cursor: 10_000 }), "VALIDATION_ERROR");
    await raw("POST", "/v1/terminal/write", { sessionId: SID(2), input: "exit\n" });
    await expectCode(raw("POST", "/v1/terminal/write", { sessionId: SID(2), input: "id\n" }), "OPERATION_INTERRUPTED");
    await expectCode(raw("POST", "/v1/panel/restart", { component: "phpmyadmin" }), "NOT_FOUND");
    s.setEngineReachable(false);
    for (const [m, p, b] of [
      ["POST", "/v1/terminal/open", openReq(5)],
      ["POST", "/v1/terminal/read", { sessionId: SID(1), cursor: 0 }],
      ["GET", "/v1/terminal/sessions", undefined],
      ["POST", "/v1/panel/restart", { component: "sftp" }],
    ] as const) {
      await expectCode(raw(m, p, b), "DOCKER_ENGINE_UNAVAILABLE");
    }
    expect(seen).toHaveLength(13);
  });

  it("the real adapter's restart errors arrive with their status too: RESOURCE_LOCKED, NOT_FOUND, INTERNAL_ERROR", async () => {
    const { adapter, mockDaemon } = await engine(0);
    const { raw } = await ipc(adapter);
    mockDaemon.containers.set("hp_mail_relay", { ...siteRecord(1), id: "hp_mail_relay", name: "hp_mail_relay", labels: {} });
    let release!: () => void;
    mockDaemon.holdRestarts.until = new Promise<void>((r) => (release = r));
    const held = raw("POST", "/v1/panel/restart", { component: "mail_relay" });
    await vi.waitFor(() => expect(mockDaemon.requestedPaths.some((p) => p.includes("/hp_mail_relay/restart"))).toBe(true));
    const locked = await raw("POST", "/v1/panel/restart", { component: "mail_relay" });
    expect([locked.status, locked.body.error?.code]).toEqual([ERROR_CODE_HTTP_STATUS.RESOURCE_LOCKED, "RESOURCE_LOCKED"]);
    release();
    expect((await held).status).toBe(200);
    mockDaemon.holdRestarts.until = null;
    const missing = await raw("POST", "/v1/panel/restart", { component: "sftp" });
    expect([missing.status, missing.body.error?.code]).toEqual([ERROR_CODE_HTTP_STATUS.NOT_FOUND, "NOT_FOUND"]);
    mockDaemon.failRestarts.remaining = 1;
    const failed = await raw("POST", "/v1/panel/restart", { component: "mail_relay" });
    expect([failed.status, failed.body.error?.code]).toEqual([ERROR_CODE_HTTP_STATUS.INTERNAL_ERROR, "INTERNAL_ERROR"]);
    expect(failed.text).not.toContain("restart failed");
  });
});

describe("3. refused before the adapter", () => {
  const long = `${IN_CANARY}${"x".repeat(4097 - IN_CANARY.length)}`;
  const badIds: unknown[] = [
    `term_${"A".repeat(32)}`, `term_${"a".repeat(31)}`, `term_${"a".repeat(33)}`, `term_${"g".repeat(32)}`,
    `../term_${"a".repeat(32)}`, ` term_${"a".repeat(32)}`, `term_${"a".repeat(32)}\n`, "term_", 42, null,
  ];
  const badCursors: unknown[] = [-1, 1.5, "0", Number.MAX_SAFE_INTEGER + 1, null];
  const cases: Array<[string, string, unknown]> = [
    ["input of 4097 bytes", "/v1/terminal/write", { sessionId: SID(1), input: long }],
    ["4095 bytes and a 2-byte character", "/v1/terminal/write", { sessionId: SID(1), input: `${"€".repeat(1365)}é` }],
    ["empty input", "/v1/terminal/write", { sessionId: SID(1), input: "" }],
    ...badIds.map((id): [string, string, unknown] => [`read with session id ${JSON.stringify(id)}`, "/v1/terminal/read", { sessionId: id, cursor: 0 }]),
    ...badIds.map((id): [string, string, unknown] => [`close with session id ${JSON.stringify(id)}`, "/v1/terminal/close", { sessionId: id }]),
    ...badIds.map((id): [string, string, unknown] => [`open with session id ${JSON.stringify(id)}`, "/v1/terminal/open", { ...openReq(1), sessionId: id }]),
    ...badCursors.map((c): [string, string, unknown] => [`cursor ${String(c)}`, "/v1/terminal/read", { sessionId: SID(1), cursor: c }]),
    ["open with an extra key", "/v1/terminal/open", { ...openReq(1), user: "0:0" }],
    ["write with an extra key", "/v1/terminal/write", { sessionId: SID(1), input: "id\n", raw: true }],
    ["read with an extra key", "/v1/terminal/read", { sessionId: SID(1), cursor: 0, wait: 1 }],
    ["close with an extra key", "/v1/terminal/close", { sessionId: SID(1), force: true }],
    ["restart with an extra key", "/v1/panel/restart", { component: "sftp", name: "hp_site_1" }],
    ["restart of a component outside the five", "/v1/panel/restart", { component: "hp_api" }],
  ];
  it("every malformed body is a 400 VALIDATION_ERROR, no port method is called, and no body echoes the input", async () => {
    const s = await sim();
    const { client, raw } = await ipc(s);
    await client.openTerminal(openReq(1));
    const spies = spySix(s);
    for (const [name, p, body] of cases) {
      const r = await raw("POST", p, body);
      expect([name, r.status, r.body.error?.code]).toEqual([name, 400, "VALIDATION_ERROR"]);
      expect(r.text).not.toContain(IN_CANARY);
      expect(r.text).not.toContain("€");
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // the bounds themselves pass: 4096 bytes, and 4094 bytes plus a 2-byte character
    expect((await raw("POST", "/v1/terminal/write", { sessionId: SID(1), input: "y".repeat(4096) })).status).toBe(200);
    expect((await raw("POST", "/v1/terminal/write", { sessionId: SID(1), input: `${"€".repeat(1364)}aaé` })).status).toBe(200);
    expect(spies[1]).toHaveBeenCalledTimes(2);
  });
});

describe("4. the limits hold when asked at the same moment (real adapter, mock daemon, over IPC)", () => {
  it("ten opens at once on one site give one session", async () => {
    const { adapter } = await engine(1);
    const { client } = await ipc(adapter);
    const results = await settled(Array.from({ length: 10 }, (_, i) => client.openTerminal(openReq(100 + i, 1))));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "RESOURCE_LOCKED")).toHaveLength(9);
    expect((await client.listTerminals()).filter((r) => !r.ended)).toHaveLength(1);
  });

  it("opens at once on six sites give four; an ended session is not counted", async () => {
    const { adapter, mockDaemon } = await engine(6);
    const { client } = await ipc(adapter);
    const results = await settled([1, 2, 3, 4, 5, 6].map((n) => client.openTerminal(openReq(n))));
    expect(results.filter((r) => r === "ok")).toHaveLength(4);
    expect(results.filter((r) => r === "QUOTA_EXCEEDED")).toHaveLength(2);
    // the list may also hold sessions of application components (ADR-0041); these are all sites'
    const live = (await client.listTerminals()).filter((r) => "siteId" in r);
    expect(live).toHaveLength(4);
    // the shell of one of the four exits on its own: its place is free again
    const first = live[0]!;
    const execNo = mockDaemon.execCalls.findIndex((c, i) => c.container === `hp_${first.siteId}_id` && (mockDaemon.execBodies[i]!.Cmd as string[])[0] === "/bin/sh" && mockDaemon.execBodies[i]!.Tty === true) + 1;
    stream(mockDaemon, execNo).end();
    await vi.waitFor(async () => expect((await client.listTerminals()).find((r) => r.sessionId === first.sessionId)?.ended?.reason).toBe("shell_exited"), { timeout: 3_000 });
    const free = [1, 2, 3, 4, 5, 6].find((n) => !live.some((r) => r.siteId === `site_${n}`))!;
    await expect(client.openTerminal(openReq(50, free))).resolves.toMatchObject({ containerName: `hp_site_${free}` });
  });

  it("failed starts give their place back", async () => {
    const { adapter, mockDaemon } = await engine(4);
    for (const n of [5, 6, 7, 8]) mockDaemon.containers.set(`hp_site_${n}_id`, siteRecord(n, { running: false, status: "exited" }));
    const { client } = await ipc(adapter);
    expect(await settled([5, 6, 7, 8].map((n) => client.openTerminal(openReq(n))))).toEqual(Array(4).fill("NOT_FOUND"));
    expect(await settled([1, 2, 3, 4].map((n) => client.openTerminal(openReq(n))))).toEqual(Array(4).fill("ok"));
  });
});

describe("5. a session is of one site", () => {
  it("on the simulator over IPC: another site's container, a stopped one and a gone one are NOT_FOUND", async () => {
    const s = await sim(3);
    const { raw } = await ipc(s);
    await s.stopService("svc_2");
    await s.deleteService("svc_3");
    for (const body of [
      { sessionId: SID(1), siteId: "site_1", serviceInstanceId: "svc_2" },
      { sessionId: SID(2), siteId: "site_2", serviceInstanceId: "svc_2" },
      { sessionId: SID(3), siteId: "site_3", serviceInstanceId: "svc_3" },
    ]) {
      const r = await raw("POST", "/v1/terminal/open", body);
      expect([r.status, r.body.error?.code]).toEqual([404, "NOT_FOUND"]);
    }
    expect(await s.listTerminals()).toEqual([]);
  });

  it("on the real adapter the site comes from the container's label, not from the request", async () => {
    const { adapter, mockDaemon } = await engine(2);
    // a container that carries site_1's service label but belongs to site_2
    mockDaemon.containers.set("hp_site_1_id", siteRecord(1, { labels: { [MANAGED_DOCKER_LABELS.siteId]: "site_2", [MANAGED_DOCKER_LABELS.serviceInstanceId]: "svc_1" } }));
    const { raw } = await ipc(adapter);
    const r = await raw("POST", "/v1/terminal/open", openReq(1));
    expect([r.status, r.body.error?.code]).toEqual([404, "NOT_FOUND"]);
    expect(mockDaemon.execCalls).toEqual([]);
    expect((await raw("POST", "/v1/terminal/open", openReq(2))).status).toBe(200);
    expect(mockDaemon.execCalls.map((c) => c.container)).toEqual(["hp_site_2_id"]);
  });
});

describe("6. every end ends the shell, and only that shell", () => {
  type End = "closed" | "shell_exited" | "idle" | "time_limit" | "container_gone";
  const cases: Array<[End, Partial<TerminalLimits>]> = [
    ["closed", {}],
    ["shell_exited", {}],
    ["idle", { idleMs: 500 }],
    ["time_limit", { sessionMaxMs: 1_000 }],
    ["container_gone", {}],
  ];
  it.each(cases)("%s: the kill runs as 33:33 with that session's mark and nothing else's", async (end, limits) => {
    const { adapter, mockDaemon } = await engine(2, limits);
    const { client } = await ipc(adapter);
    await client.openTerminal(openReq(1));
    if (end === "time_limit") await new Promise((r) => setTimeout(r, 600));
    await client.openTerminal(openReq(2));
    const s2 = { alive: true };
    const keepS2 = (async () => {
      let cursor = 0;
      while (s2.alive) cursor = (await client.readTerminal({ sessionId: SID(2), cursor })).cursor;
    })();
    if (end === "closed") await client.closeTerminal({ sessionId: SID(1) });
    if (end === "shell_exited") stream(mockDaemon, 1).end();
    if (end === "container_gone") {
      mockDaemon.containers.delete("hp_site_1_id");
      stream(mockDaemon, 1).end();
    }
    if (end !== "closed") {
      await vi.waitFor(async () => expect((await adapter.listTerminals()).find((r) => r.sessionId === SID(1))?.ended?.reason).toBe(end), { timeout: 3_000 });
    }
    await new Promise((r) => setTimeout(r, 150));
    expect(kills(mockDaemon)).toEqual(end === "container_gone" ? [] : [["hp_site_1_id", SID(1), "33:33"]]);
    expect((await adapter.listTerminals()).find((r) => r.sessionId === SID(2))?.ended).toBeNull();
    s2.alive = false;
    await keepS2;
  });

  it("no input, output or Engine error text reaches a log line, an error or an IPC body", async () => {
    const lines: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    }
    for (const s of [process.stdout, process.stderr]) {
      vi.spyOn(s, "write").mockImplementation(((c: unknown) => (lines.push(String(c)), true)) as never);
    }

    const { adapter, mockDaemon } = await engine(2);
    const { client, raw } = await ipc(adapter);
    const texts: string[] = [];
    await client.openTerminal(openReq(1));
    const shell = stream(mockDaemon, 1);
    const typed = new Promise<void>((resolve) => shell.on("data", (b: Buffer) => b.includes(IN_CANARY) && resolve()));
    await client.writeTerminal({ sessionId: SID(1), input: `echo ${IN_CANARY}\n` });
    await typed;
    shell.write(`${OUT_CANARY}\r\n`);
    expect((await readUntil(client, SID(1), 0, OUT_CANARY)).text).toContain(OUT_CANARY);
    // Engine failures: an inspect that fails at open, at the end rule, and a failed restart
    mockDaemon.failInspects.remaining = 1;
    texts.push((await raw("POST", "/v1/terminal/open", openReq(2))).text);
    mockDaemon.failInspects.remaining = 1;
    shell.end();
    await vi.waitFor(async () => expect((await adapter.listTerminals())[0]?.ended?.reason).toBe("shell_exited"), { timeout: 3_000 });
    mockDaemon.containers.set("hp_sftp", { ...siteRecord(9), id: "hp_sftp", name: "hp_sftp", labels: {} });
    mockDaemon.failRestarts.remaining = 1;
    texts.push((await raw("POST", "/v1/panel/restart", { component: "sftp" })).text);
    texts.push((await raw("POST", "/v1/terminal/write", { sessionId: SID(1), input: `${IN_CANARY}\n` })).text);
    texts.push((await raw("POST", "/v1/terminal/write", { sessionId: SID(9), input: `${IN_CANARY}\n` })).text);
    texts.push(await adapter.reapTerminalShells().then(() => "", (e: Error) => `${e.message} ${JSON.stringify(e)}`));

    expect(texts.join("\n")).toMatch(/OPERATION_INTERRUPTED/);
    for (const forbidden of [IN_CANARY, OUT_CANARY, "boom", "restart failed", "No such container"]) {
      expect(lines.join("\n")).not.toContain(forbidden);
      expect(texts.join("\n")).not.toContain(forbidden);
    }
  });
});

describe("7. restart of a panel container", () => {
  const names: Record<PanelContainer, string> = {
    ingress_proxy: "hp_ingress_proxy", shared_database: "hp_mariadb", phpmyadmin: "hp_phpmyadmin", sftp: "hp_sftp", mail_relay: "hp_mail_relay",
  };
  const engineCalls = (d: MockDockerDaemon, from: number) => d.requestedPaths.slice(from).map((p) => p.replace(/^\/v1\.\d+/, ""));

  it("each of the five reaches the daemon over IPC with exactly its fixed name and nothing else changes", async () => {
    const { adapter, mockDaemon } = await engine(0);
    for (const c of PANEL_CONTAINERS) mockDaemon.containers.set(names[c], { ...siteRecord(0), id: names[c], name: names[c], labels: {} });
    const { client } = await ipc(adapter);
    for (const c of PANEL_CONTAINERS) {
      const mark = mockDaemon.requestedPaths.length;
      await client.restartPanelContainer({ component: c });
      const calls = engineCalls(mockDaemon, mark);
      expect(calls.filter((p) => !p.startsWith("/containers/" + names[c] + "/json"))).toEqual([
        `/containers/${names[c]}/restart?t=${c === "mail_relay" ? "10" : "5"}`,
      ]);
    }
  });

  it("no request names another container: slashes, dots, a site's name, capitals, spaces", async () => {
    const { adapter, mockDaemon } = await engine(1);
    const spy = vi.spyOn(adapter, "restartPanelContainer");
    const { raw } = await ipc(adapter);
    const mark = mockDaemon.requestedPaths.length;
    for (const component of [
      "sftp/../hp_site_1", "../hp_site_1", "..", ".", "/", "hp_site_1", "hp_site_1_id", "SFTP", "Mail_Relay", "INGRESS_PROXY",
      " sftp", "sftp ", "sftp\n", "sftp%2f..", "hp_sftp", "", ["sftp"], { sftp: true }, null,
    ]) {
      const r = await raw("POST", "/v1/panel/restart", { component });
      expect([JSON.stringify(component), r.status, r.body.error?.code]).toEqual([JSON.stringify(component), 400, "VALIDATION_ERROR"]);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(engineCalls(mockDaemon, mark)).toEqual([]);
  });

  it("never creates a container: an absent one answers NOT_FOUND and no create or start is sent", async () => {
    const { adapter, mockDaemon } = await engine(0);
    const { raw } = await ipc(adapter);
    const mark = mockDaemon.requestedPaths.length;
    for (const component of PANEL_CONTAINERS) {
      const r = await raw("POST", "/v1/panel/restart", { component });
      expect([component, r.status, r.body.error?.code]).toEqual([component, 404, "NOT_FOUND"]);
    }
    const calls = engineCalls(mockDaemon, mark);
    expect(calls.filter((p) => /\/containers\/create|\/start|\/images\//.test(p))).toEqual([]);
    expect(calls.every((p) => /^\/containers\/hp_[a-z_]+\/restart\?t=\d+$/.test(p))).toBe(true);
    expect([...mockDaemon.containers.keys()]).toEqual([]);
  });

  it("two restarts of one component at the same moment: one runs, the other is RESOURCE_LOCKED", async () => {
    const { adapter, mockDaemon } = await engine(0);
    mockDaemon.containers.set("hp_mariadb", { ...siteRecord(0), id: "hp_mariadb", name: "hp_mariadb", labels: {} });
    const { client } = await ipc(adapter);
    const results = await settled([client.restartPanelContainer({ component: "shared_database" }), client.restartPanelContainer({ component: "shared_database" })]);
    expect(results.sort()).toEqual(["RESOURCE_LOCKED", "ok"]);
    expect(mockDaemon.requestedPaths.filter((p) => p.includes("/restart"))).toHaveLength(1);
  });
});

describe("8. nothing is kept", () => {
  it("ten minutes after its end the record is dropped and the manager holds none of its output (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const s = await sim(1);
    await s.openTerminal(openReq(1));
    s.emitTerminalOutput(SID(1), `${OUT_CANARY}\r\n`);
    await s.writeTerminal({ sessionId: SID(1), input: "exit\n" });
    expect((await s.listTerminals())[0]?.ended?.reason).toBe("shell_exited");
    await vi.advanceTimersByTimeAsync(TERMINAL_ENDED_KEPT_MS - 1);
    expect(await s.listTerminals()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await s.listTerminals()).toEqual([]);
    await expect(s.readTerminal({ sessionId: SID(1), cursor: 0 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const manager = (s as unknown as { terminals: { sessions: Map<string, unknown> } }).terminals;
    expect(manager.sessions.size).toBe(0);
    // the simulator's own map of shell sinks must not keep the dropped session (and its output) alive
    expect((s as unknown as { terminalSinks: Map<string, unknown> }).terminalSinks.has(SID(1))).toBe(false);
  });

  it("on the real adapter a session writes no file, and its dropped record keeps no output", async () => {
    const { tmp, adapter, mockDaemon } = await engine(1, { endedKeptMs: 200 });
    const { client } = await ipc(adapter);
    const before = await files(tmp);
    await client.openTerminal(openReq(1));
    await client.writeTerminal({ sessionId: SID(1), input: `echo ${IN_CANARY}\n` });
    stream(mockDaemon, 1).write(`${OUT_CANARY}\r\n`);
    expect((await readUntil(client, SID(1), 0, OUT_CANARY)).text).toContain(OUT_CANARY);
    stream(mockDaemon, 1).end();
    await vi.waitFor(async () => expect(await client.listTerminals()).toEqual([]), { timeout: 3_000 });
    expect((adapter as unknown as { terminals: { sessions: Map<string, unknown> } }).terminals.sessions.size).toBe(0);
    const after = await files(tmp);
    expect(after).toEqual(before);
    for (const f of after) {
      const body = await readFile(f, "utf8");
      expect(body).not.toContain(IN_CANARY);
      expect(body).not.toContain(OUT_CANARY);
    }
  });
});
