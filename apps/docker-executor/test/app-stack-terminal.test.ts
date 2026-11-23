import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AppStackTerminalOpenIpcRequest, IpcSigningKey, IpcVerificationKey } from "@hosting-panel/contracts";
import { type DockerExecutorPort, isAppStackTerminalExecutor } from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_STACK_COMPONENT_ROLE, APP_STACK_LABELS, appStackContainerName } from "../src/app-stacks/index.js";
import {
  APP_STACK_TERMINAL_KILL_SCRIPT,
  type DockerExecTarget,
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  InMemoryDockerSimulatorAdapter,
  MANAGED_DOCKER_LABELS,
  SignedDockerExecutorIpcClient,
  TERMINAL_KILL_SCRIPT,
  reapAppStackTerminalShells,
  startAppStackTerminal,
} from "../src/index.js";
import { TerminalSessions, type TerminalShell, type TerminalShellSink } from "../src/terminal-sessions.js";
import { ExecutorCodedError } from "../src/traefik-config.js";
import { type MockDockerContainerRecord, type MockDockerDaemon, startMockDockerDaemon } from "./mock-docker-daemon.js";
import { TEST_ALLOWLIST, appStackTestPlan } from "./support/app-stack-plans.js";

// ADR-0041: a terminal in a component of an application. The shell is the user the component runs as: the executor
// names no user and no folder, finds the container by the name it derives itself and checks its labels first.

const ID = (n: number) => `term_${String(n).padStart(32, "0")}`;
const SID = ID(1);
const STACK = "stk_0123456789abcdef";
const ORG = "org_acme";
const STARTED = "2026-11-23T01:00:00.000000001Z";
const WEB = appStackContainerName(STACK, "web");
const REQ: AppStackTerminalOpenIpcRequest = { sessionId: SID, stackId: STACK, organizationId: ORG, componentKey: "web" };

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

const labelsOf = (key: string, stackId = STACK, organizationId = ORG): Record<string, string> => ({
  [APP_STACK_LABELS.managed]: "true",
  [APP_STACK_LABELS.role]: APP_STACK_COMPONENT_ROLE,
  [APP_STACK_LABELS.stackId]: stackId,
  [APP_STACK_LABELS.organizationId]: organizationId,
  [APP_STACK_LABELS.component]: key,
});

function component(key: string, extra?: Partial<MockDockerContainerRecord>, stackId = STACK): MockDockerContainerRecord {
  const name = appStackContainerName(stackId, key);
  return {
    id: `${name}_id`, name, image: "registry.test/acme/web:test", env: [], running: true, status: "running", restartCount: 0,
    startedAt: STARTED, hostConfig: {}, networks: {}, labels: labelsOf(key, stackId),
    ...extra,
  };
}

function add(d: MockDockerDaemon, r: MockDockerContainerRecord): void {
  d.containers.set(r.id, r);
}

async function setup(execExitCode?: number) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-app-term-"));
  cleanup.push(() => rm(tmp, { recursive: true, force: true }));
  const mockDaemon = await startMockDockerDaemon({ execUpgrade: true, execExitCode });
  cleanup.push(() => mockDaemon.close());
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: mockDaemon.socketPath,
    secretsRootDir: path.join(tmp, "secrets"),
    ingressRootDir: path.join(tmp, "ingress"),
    terminalLimits: { readWaitMs: 2_000 },
  });
  cleanup.push(() => adapter.listTerminals().then((all) => Promise.all(all.map((s) => adapter.closeTerminal(s)))));
  add(mockDaemon, component("web"));
  return { adapter, mockDaemon };
}

const paths = (d: MockDockerDaemon, from = 0) => d.requestedPaths.slice(from).map((p) => decodeURIComponent(p.replace(/^\/v1\.\d+/, "")));
const appKills = (d: MockDockerDaemon) => d.execBodies.filter((b) => (b.Cmd as string[])[2] === APP_STACK_TERMINAL_KILL_SCRIPT);
const siteKills = (d: MockDockerDaemon) => d.execBodies.filter((b) => (b.Cmd as string[])[2] === TERMINAL_KILL_SCRIPT);

describe("openAppStackTerminal on the Docker Engine", () => {
  it("creates /bin/sh with a TTY in the checked container and names no user and no folder", async () => {
    const { adapter, mockDaemon } = await setup();
    const opened = await adapter.openAppStackTerminal(REQ);
    expect(opened.containerName).toBe(WEB);
    expect(Object.keys(opened).sort()).toEqual(["containerName", "openedAt"]);
    // The container is found by the derived name, and the exec goes to the id that inspect returned.
    expect(paths(mockDaemon).filter((p) => p.startsWith("/containers/"))).toEqual([
      `/containers/${WEB}/json`,
      `/containers/${WEB}_id/json`,
      `/containers/${WEB}_id/exec`,
    ]);
    expect(mockDaemon.execCalls[0]?.container).toBe(`${WEB}_id`);
    const body = mockDaemon.execBodies[0]!;
    expect(body).toEqual({
      Cmd: ["/bin/sh"],
      Env: ["TERM=dumb", "PS1=$PWD $ ", `HP_TERMINAL_SESSION=${SID}`],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      ConsoleSize: [24, 80],
    });
    for (const key of ["User", "WorkingDir", "Privileged"]) expect(body, key).not.toHaveProperty(key);

    const stream = mockDaemon.execStreams[0]!.socket;
    const typed = new Promise<string>((resolve) => stream.on("data", (b: Buffer) => b.includes("id\n") && resolve("id\n")));
    await adapter.writeTerminal({ sessionId: SID, input: "id\n" });
    await expect(typed).resolves.toBe("id\n");
    stream.write("uid=101(nginx)\r\n");
    await expect(adapter.readTerminal({ sessionId: SID, cursor: 0 })).resolves.toMatchObject({ output: "uid=101(nginx)\r\n", ended: null });
  });

  it("lists the session by application and component, with the container's name and no Docker id", async () => {
    const { adapter } = await setup();
    await adapter.openAppStackTerminal(REQ);
    const listed = await adapter.listTerminals();
    expect(listed).toEqual([
      { sessionId: SID, stackId: STACK, organizationId: ORG, componentKey: "web", containerName: WEB, openedAt: expect.any(String), ended: null },
    ]);
    expect(JSON.stringify(listed)).not.toContain(`${WEB}_id`);
  });

  it("refuses a missing or stopped component with NOT_FOUND, before any exec", async () => {
    const { adapter, mockDaemon } = await setup();
    add(mockDaemon, component("worker", { running: false, status: "exited" }));
    await expect(adapter.openAppStackTerminal({ ...REQ, componentKey: "cache" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Component not found",
    });
    await expect(adapter.openAppStackTerminal({ ...REQ, componentKey: "worker" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "The component is not running",
    });
    await expect(adapter.openAppStackTerminal({ ...REQ, stackId: "stk_other" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockDaemon.execCalls).toEqual([]);
    await expect(adapter.listTerminals()).resolves.toEqual([]);
  });

  const foreign: Array<[string, Record<string, string>]> = [
    ["another customer's", labelsOf("web", STACK, "org_other")],
    ["another application's", labelsOf("web", "stk_other")],
    ["another component's", labelsOf("worker")],
    ["not a component", { ...labelsOf("web"), [APP_STACK_LABELS.role]: "backup_job" }],
    ["not the panel's", { ...labelsOf("web"), [APP_STACK_LABELS.managed]: "false" }],
    ["a site's", { [MANAGED_DOCKER_LABELS.siteId]: "site_a", [MANAGED_DOCKER_LABELS.serviceInstanceId]: "svc_site_a" }],
    ["without labels", {}],
  ];
  it.each(foreign)("refuses a container with the derived name whose labels are %s, before any exec", async (_name, labels) => {
    const { adapter, mockDaemon } = await setup();
    add(mockDaemon, component("web", { labels }));
    const err = await adapter.openAppStackTerminal(REQ).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT", code: "HOST_POLICY_DENIED" });
    expect(mockDaemon.execCalls).toEqual([]);
    expect(paths(mockDaemon).filter((p) => p.endsWith("/exec"))).toEqual([]);
    await expect(adapter.listTerminals()).resolves.toEqual([]);
  });

  it("close runs the builtin-only script with the session id, without a user, and ends as closed", async () => {
    const { adapter, mockDaemon } = await setup();
    await adapter.openAppStackTerminal(REQ);
    await expect(adapter.closeTerminal({ sessionId: SID })).resolves.toMatchObject({ reason: "closed" });
    expect(appKills(mockDaemon)).toEqual([
      { Cmd: ["/bin/sh", "-c", APP_STACK_TERMINAL_KILL_SCRIPT, "sh", SID], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false },
    ]);
    expect(siteKills(mockDaemon)).toEqual([]);
    expect(mockDaemon.execCalls[1]?.container).toBe(`${WEB}_id`);
    await vi.waitFor(() => expect(mockDaemon.execStreams[0]!.socket.destroyed).toBe(true));
  });

  const endings: Array<[string, (d: MockDockerDaemon) => void, "shell_exited" | "container_gone"]> = [
    ["the same container still runs", () => undefined, "shell_exited"],
    ["the container is gone", (d) => d.containers.delete(`${WEB}_id`), "container_gone"],
    ["the container stopped", (d) => Object.assign(d.containers.get(`${WEB}_id`)!, { running: false, status: "exited" }), "container_gone"],
    ["the container started again", (d) => Object.assign(d.containers.get(`${WEB}_id`)!, { startedAt: "2026-11-23T01:05:00Z" }), "container_gone"],
  ];
  it.each(endings)("when the stream ends and %s the session ends for that reason", async (_name, change, reason) => {
    const { adapter, mockDaemon } = await setup();
    await adapter.openAppStackTerminal(REQ);
    change(mockDaemon);
    mockDaemon.execStreams[0]!.socket.end();
    await expect(adapter.readTerminal({ sessionId: SID, cursor: 0 })).resolves.toMatchObject({ ended: { reason } });
    // Ctrl-D leaves background children: they are killed. A container that went away has nothing left.
    await vi.waitFor(() => expect(appKills(mockDaemon)).toHaveLength(reason === "shell_exited" ? 1 : 0));
  });

  it("the kill says whether it worked", async () => {
    const { adapter, mockDaemon } = await setup();
    const target = (adapter as unknown as { execTarget: DockerExecTarget }).execTarget;
    const { shell, containerName } = await startAppStackTerminal(target, `${WEB}_id`, SID, { data: () => undefined, exit: () => undefined });
    expect(containerName).toBe(WEB);
    mockDaemon.failExecStarts.remaining = 1;
    await expect(shell.kill()).resolves.toBe(false);
    await expect(shell.kill()).resolves.toBe(true);
    mockDaemon.containers.delete(`${WEB}_id`);
    await expect(shell.kill()).resolves.toBe(true); // gone: nothing is left to kill
    expect(appKills(mockDaemon)).toHaveLength(2);
  });
});

describe("the clean-up script of a component", () => {
  // The text is pinned: a change here must be tried again in real containers (infra/linux/accept-app-terminal.mjs).
  const PINNED =
    'm="HP_TERMINAL_SESSION=${1:-term_}"; s=" "; ' +
    'marked() { while IFS= read -r x || [ -n "$x" ]; do case "$x" in *"$m"*) return 0;; esac; done 2>/dev/null <"$1/environ"; return 1; }; ' +
    'sid() { l=""; while IFS= read -r x || [ -n "$x" ]; do l=$x; done 2>/dev/null <"$1/stat"; l=${l##*) }; set -- $l; i=${4:-0}; }; ' +
    'for p in /proc/[0-9]*; do marked "$p" || continue; sid "$p"; [ "$i" -gt 1 ] 2>/dev/null && s="$s$i "; ' +
    '[ "${p#/proc/}" -gt 1 ] && kill -KILL "${p#/proc/}" 2>/dev/null; done; ' +
    'for p in /proc/[0-9]*; do [ "${p#/proc/}" -gt 1 ] || continue; sid "$p"; ' +
    'case "$s" in *" $i "*) kill -KILL "${p#/proc/}" 2>/dev/null;; esac; done; exit 0';

  it("is the text that was tried in real containers", () => {
    expect(APP_STACK_TERMINAL_KILL_SCRIPT).toBe(PINNED);
    expect(APP_STACK_TERMINAL_KILL_SCRIPT).not.toBe(TERMINAL_KILL_SCRIPT);
  });

  it("uses only what a shell has built in: the image may have no grep, ps or pkill", () => {
    // Outside the quoted strings every word is a shell keyword, a builtin, one of its own names or a part of /proc and /dev/null.
    const known = new Set([
      "while", "do", "done", "for", "in", "case", "esac", "return", "continue", "exit", // keywords and flow
      "read", "set", "kill", "KILL", "IFS", "r", "n", "gt", // builtins and their options
      "m", "s", "l", "i", "x", "p", "marked", "sid", // its own variables and functions
      "proc", "dev", "null",
    ]);
    const words = new Set(APP_STACK_TERMINAL_KILL_SCRIPT.replace(/"[^"]*"/g, " ").match(/[A-Za-z_]+/g));
    expect([...words].filter((word) => !known.has(word))).toEqual([]);
    // Nothing is run inside a string either: no command substitution anywhere.
    for (const substitution of ["$(", "`"]) expect(APP_STACK_TERMINAL_KILL_SCRIPT, substitution).not.toContain(substitution);
    for (const program of ["grep", "pkill", "pgrep", "awk", "sed ", "cut ", "cat ", "xargs"]) {
      expect(APP_STACK_TERMINAL_KILL_SCRIPT, program).not.toContain(program);
    }
    expect(APP_STACK_TERMINAL_KILL_SCRIPT).not.toMatch(/\bps\b/);
  });

  it("never signals pid 1 and never collects session 0 or 1", () => {
    const kills = APP_STACK_TERMINAL_KILL_SCRIPT.split("kill -KILL").length - 1;
    expect(kills).toBe(2);
    // Each kill is behind a test that the pid is above 1; a session id is kept only when above 1.
    expect(APP_STACK_TERMINAL_KILL_SCRIPT).toContain('[ "${p#/proc/}" -gt 1 ] && kill -KILL "${p#/proc/}"');
    expect(APP_STACK_TERMINAL_KILL_SCRIPT).toContain('for p in /proc/[0-9]*; do [ "${p#/proc/}" -gt 1 ] || continue; sid "$p"; case');
    expect(APP_STACK_TERMINAL_KILL_SCRIPT).toContain('[ "$i" -gt 1 ] 2>/dev/null && s="$s$i "');
    expect(APP_STACK_TERMINAL_KILL_SCRIPT.endsWith("exit 0")).toBe(true);
  });
});

describe("reapAppStackTerminalShells", () => {
  it("lists component containers and runs the script, without a user, only where an exec is left", async () => {
    const { adapter, mockDaemon } = await setup();
    const target = (adapter as unknown as { execTarget: DockerExecTarget }).execTarget;
    add(mockDaemon, component("web", { execIds: ["e1"] }));
    add(mockDaemon, component("worker", { execIds: [] }));
    add(mockDaemon, component("cache", { execIds: ["e2"], running: false, status: "exited" }));
    add(mockDaemon, { ...component("other", { execIds: ["e3"] }), labels: { [MANAGED_DOCKER_LABELS.siteId]: "site_a" } });
    const mark = mockDaemon.requestedPaths.length;
    await reapAppStackTerminalShells(target);
    const seen = paths(mockDaemon, mark);
    expect(seen.filter((p) => p.startsWith("/containers/json"))).toEqual([`/containers/json?filters={"label":["${APP_STACK_LABELS.component}"]}`]);
    expect(seen.filter((p) => /^\/containers\/[^/]+\/json$/.test(p))).toEqual([
      `/containers/${WEB}_id/json`,
      `/containers/${appStackContainerName(STACK, "worker")}_id/json`,
      `/containers/${appStackContainerName(STACK, "cache")}_id/json`,
    ]);
    expect(mockDaemon.execCalls.map((e) => e.container)).toEqual([`${WEB}_id`]);
    expect(appKills(mockDaemon)).toEqual([
      { Cmd: ["/bin/sh", "-c", APP_STACK_TERMINAL_KILL_SCRIPT, "sh", ""], AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false },
    ]);
  });

  it("the executor's start pass cleans the components even when the pass over the sites failed", async () => {
    const mockDaemon = await startMockDockerDaemon({ execUpgrade: true });
    cleanup.push(() => mockDaemon.close());
    const siteLabels = { [MANAGED_DOCKER_LABELS.siteId]: "site_a", [MANAGED_DOCKER_LABELS.serviceInstanceId]: "svc_site_a" };
    add(mockDaemon, { ...component("site", { execIds: ["e0"] }), id: "hp_site_a_id", name: "hp_site_a", labels: siteLabels });
    add(mockDaemon, component("web", { execIds: ["e1"] }));
    mockDaemon.failInspects.remaining = 1; // the site's inspect answers 500 "boom"
    const adapter = new DockerEngineSocketAdapter({ dockerSocketPath: mockDaemon.socketPath });
    const err = (await adapter.reapTerminalShells().catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE", message: "Failed to inspect the site container" });
    expect(err.message).not.toContain("boom");
    expect(appKills(mockDaemon)).toHaveLength(1);
    expect(mockDaemon.execCalls.map((e) => e.container)).toContain(`${WEB}_id`);
  });

  it("a failure is one coded fixed sentence", async () => {
    const broken: DockerExecTarget = { request: () => Promise.resolve({ statusCode: 500, body: Buffer.from("secret detail") }), socketPath: "", apiPrefix: "" };
    await expect(reapAppStackTerminalShells(broken)).rejects.toMatchObject({
      code: "DOCKER_ENGINE_UNAVAILABLE",
      message: "Failed to list application containers",
    });
  });
});

describe("limits shared by sites and components", () => {
  const fakeStart = (kills: string[], name: string) => async (_sink: TerminalShellSink): Promise<{ shell: TerminalShell; containerName: string }> => ({
    containerName: name,
    shell: { write: () => undefined, kill: async () => { kills.push(name); return true; } },
  });
  const site = (terms: TerminalSessions, n: number, kills: string[] = []) =>
    terms.open({ sessionId: ID(n), siteId: `site_${n}`, serviceInstanceId: `svc_${n}` }, fakeStart(kills, `hp_svc_svc_${n}`));
  const app = (terms: TerminalSessions, n: number, stackId: string, componentKey: string, kills: string[] = []) =>
    terms.open({ sessionId: ID(n), stackId, organizationId: ORG, componentKey }, fakeStart(kills, appStackContainerName(stackId, componentKey)));
  const refusal = (p: Promise<unknown>) => p.then(() => ({ code: "resolved", message: "" }), (e: { code?: string; message?: string }) => ({ code: e.code, message: e.message }));

  it("four sessions on the server, whatever they are opened on", async () => {
    const terms = new TerminalSessions();
    await site(terms, 1);
    await app(terms, 2, STACK, "web");
    await site(terms, 3);
    await app(terms, 4, STACK, "worker");
    await expect(refusal(app(terms, 5, "stk_other", "web"))).resolves.toEqual({ code: "QUOTA_EXCEEDED", message: "Too many terminal sessions open" });
    await expect(refusal(site(terms, 6))).resolves.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await terms.close({ sessionId: ID(2) });
    await expect(app(terms, 5, "stk_other", "web")).resolves.toMatchObject({ containerName: appStackContainerName("stk_other", "web") });
  });

  it("one session per component; another component, another application and a site with the same id are free", async () => {
    const terms = new TerminalSessions();
    await app(terms, 1, STACK, "web");
    await expect(refusal(app(terms, 2, STACK, "web"))).resolves.toEqual({
      code: "RESOURCE_LOCKED",
      message: "A terminal is already open on this component",
    });
    await app(terms, 2, STACK, "worker");
    await app(terms, 3, "stk_other", "web");
    // A site whose id is the application's does not hold the component, and the other way round.
    await expect(terms.open({ sessionId: ID(4), siteId: STACK, serviceInstanceId: "web" }, fakeStart([], "hp_svc_web"))).resolves.toBeDefined();
    await expect(refusal(terms.open({ sessionId: ID(5), siteId: STACK, serviceInstanceId: "web" }, fakeStart([], "hp_svc_web")))).resolves.toEqual({
      code: "RESOURCE_LOCKED",
      message: "A terminal is already open on this site",
    });
  });

  it("the same session id is refused whatever it was opened on", async () => {
    const terms = new TerminalSessions();
    await site(terms, 1);
    await expect(refusal(app(terms, 1, STACK, "web"))).resolves.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  it("ends the sessions of one component, or of the whole application, and leaves the others", async () => {
    const terms = new TerminalSessions();
    const kills: string[] = [];
    await site(terms, 1, kills);
    await app(terms, 2, STACK, "web", kills);
    await app(terms, 3, STACK, "worker", kills);
    await app(terms, 4, "stk_other", "web", kills);
    const ended = () => terms.list().map((s) => s.ended?.reason ?? null);

    terms.endService("web", "container_gone"); // a service id never ends a component of that name
    terms.endService(STACK, "container_gone");
    expect(ended()).toEqual([null, null, null, null]);
    terms.endAppStack(STACK, "web", "container_gone");
    expect(ended()).toEqual([null, "container_gone", null, null]);
    terms.endAppStack(STACK, null, "container_gone");
    expect(ended()).toEqual([null, "container_gone", "container_gone", null]);
    // As for a site: the kill is asked for all the same (it finds nothing when the container is gone).
    expect(kills).toEqual([WEB, appStackContainerName(STACK, "worker")]);
    terms.endService("svc_1", "container_gone");
    expect(ended()).toEqual(["container_gone", "container_gone", "container_gone", null]);
    expect(terms.list()[3]).toMatchObject({ sessionId: ID(4), stackId: "stk_other", organizationId: ORG, componentKey: "web" });
  });
});

describe("application terminal IPC route", () => {
  const HMAC_KEY = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: "0123456789abcdef0123456789abcdef-app-term-key" } as const;
  const AT = "2026-11-23T10:00:00.000Z";

  function recordingPort(withMethod = true) {
    const calls: Array<[string, unknown]> = [];
    let failure: Error | null = null;
    const answer = <T>(name: string, req: unknown, value: T): Promise<T> => {
      calls.push([name, req]);
      return failure ? Promise.reject(failure) : Promise.resolve(value);
    };
    const port = {
      isRuntimeAvailable: true,
      openTerminal: (req: unknown) => answer("openTerminal", req, { containerName: "hp_svc_svc_1", openedAt: AT }),
      ...(withMethod ? { openAppStackTerminal: (req: unknown) => answer("openAppStackTerminal", req, { containerName: WEB, openedAt: AT }) } : {}),
    } as unknown as DockerExecutorPort;
    return { port, calls, fail: (err: Error) => { failure = err; } };
  }

  async function ipc(executor: DockerExecutorPort) {
    const server = new DockerExecutorIpcServer({ executor, keyring: { "hmac-v1": HMAC_KEY as IpcVerificationKey }, transport: "loopback-test" });
    cleanup.push(() => server.stop());
    const bound = await server.start();
    return new SignedDockerExecutorIpcClient({ signingKey: HMAC_KEY as IpcSigningKey, transport: "loopback-test", port: bound.port });
  }

  it("the client's call reaches the port with the four names and returns the parsed answer", async () => {
    const { port, calls } = recordingPort();
    const client = await ipc(port);
    expect(isAppStackTerminalExecutor(client)).toBe(true);
    await expect(client.openAppStackTerminal(REQ)).resolves.toEqual({ containerName: WEB, openedAt: AT });
    expect(calls).toEqual([["openAppStackTerminal", REQ]]);
  });

  it("refuses a bad request with VALIDATION_ERROR before the port is called", async () => {
    const { port, calls } = recordingPort();
    const client = await ipc(port);
    const bad: unknown[] = [
      { ...REQ, user: "0:0" },
      { ...REQ, workingDir: "/" },
      { ...REQ, containerName: "hp_ingress_proxy" },
      { ...REQ, cmd: ["/bin/bash"] },
      { ...REQ, stackId: "stk_1/../x" },
      { ...REQ, componentKey: "web_1" },
      { ...REQ, componentKey: "../web" },
      { ...REQ, organizationId: "" },
      { ...REQ, sessionId: "term_NOT_A_SESSION" },
      { sessionId: SID, siteId: "site_1", serviceInstanceId: "svc_1" },
    ];
    for (const req of bad) {
      await expect(client.openAppStackTerminal(req as AppStackTerminalOpenIpcRequest), JSON.stringify(req)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    }
    // The site route does not take an application either.
    await expect(client.openTerminal(REQ as never)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls).toEqual([]);
  });

  it("answers NOT_SUPPORTED when the active backend has no terminal for applications", async () => {
    const { port, calls } = recordingPort(false);
    expect(isAppStackTerminalExecutor(port)).toBe(false);
    const client = await ipc(port);
    await expect(client.openAppStackTerminal(REQ)).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message: "Application terminals are not supported by the active executor backend",
    });
    await expect(client.openAppStackTerminal({ ...REQ, user: "0:0" } as never)).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    expect(calls).toEqual([]);
  });

  it("passes the port's refusals to the client with their code", async () => {
    const { port, fail } = recordingPort();
    const client = await ipc(port);
    for (const code of ["NOT_FOUND", "RESOURCE_LOCKED", "QUOTA_EXCEEDED", "ALREADY_EXISTS", "DOCKER_ENGINE_UNAVAILABLE"] as const) {
      fail(new ExecutorCodedError("refused", code));
      await expect(client.openAppStackTerminal(REQ), code).rejects.toMatchObject({ code });
    }
  });

  it("works end to end on the simulator through the signed route", async () => {
    const sim = new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST });
    await deploy(sim);
    const client = await ipc(sim);
    await expect(client.openAppStackTerminal(REQ)).resolves.toMatchObject({ containerName: WEB });
    await expect(client.listTerminals()).resolves.toEqual([
      { sessionId: SID, stackId: STACK, organizationId: ORG, componentKey: "web", containerName: WEB, openedAt: expect.any(String), ended: null },
    ]);
    const other = { ...REQ, sessionId: ID(2), componentKey: "worker", organizationId: "org_other" };
    const conflict = (await client.openAppStackTerminal(other).catch((e: unknown) => e)) as {
      code?: string; details?: ReadonlyArray<{ reason?: string }>;
    };
    expect(conflict.code).toBe("HOST_POLICY_DENIED");
    expect(conflict.details?.[0]?.reason).toBe("STACK_NAMESPACE_CONFLICT");
    await expect(client.closeTerminal({ sessionId: SID })).resolves.toMatchObject({ reason: "closed" });
  });
});

const plan = appStackTestPlan();
const ref = { stackId: plan.stackId, organizationId: plan.organizationId };

async function deploy(sim: InMemoryDockerSimulatorAdapter): Promise<void> {
  await sim.pullAppStackImage({ plan, image: plan.components[0]!.image });
  await sim.prepareAppStack({ plan });
  await sim.createAppStackComponents({ plan });
  await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
  await sim.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [{ parameterKey: "shared_key", version: 1, content: "s3cr3t-content" }] });
}

describe("simulator: a terminal in a component", () => {
  const simulator = async () => {
    const sim = new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST });
    await deploy(sim);
    return sim;
  };
  const type = async (sim: InMemoryDockerSimulatorAdapter, cursor: number, input: string) => {
    await sim.writeTerminal({ sessionId: SID, input });
    return sim.readTerminal({ sessionId: SID, cursor });
  };

  it("opens a shell in a running component as the user the component runs as", async () => {
    expect(STACK).toBe(plan.stackId);
    const sim = await simulator();
    expect(isAppStackTerminalExecutor(sim)).toBe(true);
    await expect(sim.openAppStackTerminal(REQ)).resolves.toMatchObject({ containerName: WEB });
    const first = await sim.readTerminal({ sessionId: SID, cursor: 0 });
    expect(first.output).toBe("/ $ ");
    const id = await type(sim, first.cursor, "id\r");
    expect(id.output).toBe("id\r\nuid=65534 gid=65534\r\n/ $ ");
    expect(await sim.listTerminals()).toEqual([
      { sessionId: SID, stackId: STACK, organizationId: ORG, componentKey: "web", containerName: WEB, openedAt: expect.any(String), ended: null },
    ]);
    await expect(sim.closeTerminal({ sessionId: SID })).resolves.toMatchObject({ reason: "closed" });
  });

  it("refuses a missing or stopped component, another customer's id and an unreachable engine", async () => {
    const sim = await simulator();
    await expect(sim.openAppStackTerminal({ ...REQ, componentKey: "cache" })).rejects.toMatchObject({ code: "NOT_FOUND", message: "Component not found" });
    await expect(sim.openAppStackTerminal({ ...REQ, stackId: "stk_other" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(sim.openAppStackTerminal({ ...REQ, organizationId: "org_other" })).rejects.toMatchObject({ reason: "STACK_NAMESPACE_CONFLICT" });
    await sim.stopAppStack(ref);
    await expect(sim.openAppStackTerminal(REQ)).rejects.toMatchObject({ code: "NOT_FOUND", message: "The component is not running" });
    sim.setEngineReachable(false);
    await expect(sim.openAppStackTerminal(REQ)).rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    sim.setEngineReachable(true);
    await expect(sim.listTerminals()).resolves.toEqual([]);
  });

  it("shares the limits with the sites' sessions", async () => {
    const sim = await simulator();
    await sim.openAppStackTerminal(REQ);
    await expect(sim.openAppStackTerminal({ ...REQ, sessionId: ID(2) })).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
    await expect(sim.openAppStackTerminal({ ...REQ, sessionId: ID(2), componentKey: "worker" })).resolves.toMatchObject({
      containerName: appStackContainerName(STACK, "worker"),
    });
  });

  const gone: Array<[string, (sim: InMemoryDockerSimulatorAdapter) => Promise<unknown> | void]> = [
    ["the application stops", (sim) => sim.stopAppStack(ref)],
    ["the component restarts", (sim) => sim.restartAppStackComponent({ plan, componentKey: "web", secretFileContents: [] })],
    ["the application is removed", (sim) => sim.removeAppStack({ ...ref, removeVolumes: false })],
    ["the component crashes", (sim) => sim.appStacks.crashAppStackComponent(STACK, "web")],
  ];
  it.each(gone)("ends the session as container_gone when %s", async (_name, change) => {
    const sim = await simulator();
    await sim.openAppStackTerminal(REQ);
    await sim.openAppStackTerminal({ ...REQ, sessionId: ID(2), stackId: STACK, componentKey: "worker" }).catch(() => undefined);
    await change(sim);
    await expect(sim.readTerminal({ sessionId: SID, cursor: 0 })).resolves.toMatchObject({ ended: { reason: "container_gone" } });
    await expect(sim.writeTerminal({ sessionId: SID, input: "id\r" })).rejects.toMatchObject({ code: "OPERATION_INTERRUPTED" });
  });

  it("a restart of one component leaves the session of another open", async () => {
    const sim = await simulator();
    await sim.openAppStackTerminal({ ...REQ, componentKey: "worker" });
    await sim.restartAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
    await expect(sim.listTerminals()).resolves.toMatchObject([{ componentKey: "worker", ended: null }]);
  });
});
