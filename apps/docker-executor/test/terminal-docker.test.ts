import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DockerExecTarget, DockerEngineSocketAdapter, MANAGED_DOCKER_LABELS, TERMINAL_KILL_SCRIPT, reapTerminalShells, startDockerTerminal, WORDPRESS_EXECUTOR_SITE_TYPE,
} from "../src/index.js";
import { type MockDockerContainerRecord, type MockDockerDaemon, startMockDockerDaemon } from "./mock-docker-daemon.js";

const SID = `term_${"a1".repeat(16)}`;
const STARTED = "2026-11-17T01:00:00.000000001Z";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});

function site(name: string, siteId: string, extra?: Partial<MockDockerContainerRecord>): MockDockerContainerRecord {
  return {
    id: `${name}_id`, name, image: "wordpress:test", env: [], running: true, status: "running", restartCount: 0,
    startedAt: STARTED, hostConfig: {}, networks: {},
    labels: { [MANAGED_DOCKER_LABELS.siteId]: siteId, [MANAGED_DOCKER_LABELS.serviceInstanceId]: `svc_${siteId}` },
    ...extra,
  };
}

function add(d: MockDockerDaemon, r: MockDockerContainerRecord): void {
  d.containers.set(r.id, r);
}

async function setup(execExitCode?: number) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-m5c-term-"));
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
  add(mockDaemon, site("hp_site_a", "site_a"));
  return { adapter, mockDaemon };
}

const open = (adapter: DockerEngineSocketAdapter, siteId = "site_a", serviceInstanceId = "svc_site_a") =>
  adapter.openTerminal({ sessionId: SID, siteId, serviceInstanceId });

const killCalls = (d: MockDockerDaemon) => d.execBodies.filter((b) => (b.Cmd as string[])[2] === TERMINAL_KILL_SCRIPT);

describe("openTerminal on the Docker Engine", () => {
  it("creates /bin/sh as 33:33 with a TTY, the fixed size, the prompt and the session mark", async () => {
    const { adapter, mockDaemon } = await setup();
    const opened = await open(adapter);
    expect(opened.containerName).toBe("hp_site_a");
    expect(mockDaemon.execCalls[0]?.container).toBe("hp_site_a_id");
    expect(mockDaemon.execBodies[0]).toEqual({
      Cmd: ["/bin/sh"],
      User: "33:33",
      WorkingDir: "/var/www/html",
      Env: ["TERM=dumb", "PS1=$PWD $ ", `HP_TERMINAL_SESSION=${SID}`],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      ConsoleSize: [24, 80],
    });
    const stream = mockDaemon.execStreams[0]!.socket;
    const typed = new Promise<string>((resolve) => stream.on("data", (b: Buffer) => b.includes("id\n") && resolve("id\n")));
    await adapter.writeTerminal({ sessionId: SID, input: "id\n" });
    await expect(typed).resolves.toBe("id\n");
    stream.write("uid=33(www-data)\r\n");
    await expect(adapter.readTerminal({ sessionId: SID, cursor: 0 })).resolves.toMatchObject({ output: "uid=33(www-data)\r\n", ended: null });
  });

  it("refuses with NOT_FOUND a container that is missing, stopped or another site's, before any exec", async () => {
    const { adapter, mockDaemon } = await setup();
    add(mockDaemon, site("hp_site_b", "site_b", { running: false, status: "exited" }));
    await expect(open(adapter, "site_x", "svc_site_x")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(open(adapter, "site_b", "svc_site_a")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(open(adapter, "site_b", "svc_site_b")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockDaemon.execCalls).toEqual([]);
    await expect(adapter.listTerminals()).resolves.toEqual([]);
  });

  it("close runs the kill script as 33:33 with the session id and ends as closed", async () => {
    const { adapter, mockDaemon } = await setup();
    await open(adapter);
    await expect(adapter.closeTerminal({ sessionId: SID })).resolves.toMatchObject({ reason: "closed" });
    expect(killCalls(mockDaemon)).toEqual([
      expect.objectContaining({ Cmd: ["/bin/sh", "-c", TERMINAL_KILL_SCRIPT, "sh", SID], User: "33:33", Tty: false }),
    ]);
    await vi.waitFor(() => expect(mockDaemon.execStreams[0]!.socket.destroyed).toBe(true));
  });
});

describe("the kill says whether it worked", () => {
  const shellOf = async (execExitCode?: number) => {
    const { adapter, mockDaemon } = await setup(execExitCode);
    const target = (adapter as unknown as { execTarget: DockerExecTarget }).execTarget;
    const { shell } = await startDockerTerminal(target, "hp_site_a_id", SID, { data: () => undefined, exit: () => undefined }, WORDPRESS_EXECUTOR_SITE_TYPE);
    return { shell, mockDaemon };
  };
  it("true when the kill exec exits 0", async () => {
    const { shell, mockDaemon } = await shellOf();
    await expect(shell.kill()).resolves.toBe(true);
    expect(killCalls(mockDaemon)).toHaveLength(1);
  });
  it("false when the kill exec exits 1", async () => {
    const { shell, mockDaemon } = await shellOf(1);
    await expect(shell.kill()).resolves.toBe(false);
    expect(killCalls(mockDaemon)).toHaveLength(1);
  });
  it("false when the kill exec's start is refused, and true on the next try", async () => {
    const { shell, mockDaemon } = await shellOf();
    mockDaemon.failExecStarts.remaining = 1;
    await expect(shell.kill()).resolves.toBe(false);
    await expect(shell.kill()).resolves.toBe(true);
    expect(killCalls(mockDaemon)).toHaveLength(2);
  });
  it("true when the container is gone: nothing is left to kill", async () => {
    const { shell, mockDaemon } = await shellOf();
    mockDaemon.containers.delete("hp_site_a_id");
    await expect(shell.kill()).resolves.toBe(true);
  });
});

describe("why a stream ended", () => {
  const cases: Array<[string, (d: MockDockerDaemon) => void, "shell_exited" | "container_gone"]> = [
    ["the same container still runs", () => undefined, "shell_exited"],
    ["the container is gone", (d) => d.containers.delete("hp_site_a_id"), "container_gone"],
    ["the container stopped", (d) => Object.assign(d.containers.get("hp_site_a_id")!, { running: false, status: "exited" }), "container_gone"],
    ["the container started again", (d) => Object.assign(d.containers.get("hp_site_a_id")!, { startedAt: "2026-11-17T01:05:00Z" }), "container_gone"],
    ["the inspect fails", (d) => (d.failInspects.remaining = 1), "shell_exited"],
    // On the real Engine the stream ends as the container dies, before the Engine reports it stopped.
    ["the container stops just after the stream ends", (d) => void setTimeout(() => d.containers.delete("hp_site_a_id"), 100), "container_gone"],
  ];
  it.each(cases)("%s", async (_name, change, reason) => {
    const { adapter, mockDaemon } = await setup();
    await open(adapter);
    change(mockDaemon);
    mockDaemon.execStreams[0]!.socket.end();
    await expect(adapter.readTerminal({ sessionId: SID, cursor: 0 })).resolves.toMatchObject({ ended: { reason } });
    await vi.waitFor(() => expect(killCalls(mockDaemon)).toHaveLength(reason === "shell_exited" ? 1 : 0));
    await new Promise((r) => setTimeout(r, 50));
    expect(killCalls(mockDaemon)).toHaveLength(reason === "shell_exited" ? 1 : 0);
  });
});

describe("reapTerminalShells", () => {
  it("inspects running site containers and runs the kill script only where an exec is left", async () => {
    const { adapter, mockDaemon } = await setup();
    add(mockDaemon, site("hp_site_a", "site_a", { execIds: ["e1"] }));
    add(mockDaemon, site("hp_site_b", "site_b", { execIds: [] }));
    add(mockDaemon, { ...site("hp_other", "x", { execIds: ["e2"] }), labels: { other: "1" } });
    const mark = mockDaemon.requestedPaths.length;
    await adapter.reapTerminalShells();
    const paths = mockDaemon.requestedPaths.slice(mark).map((p) => decodeURIComponent(p.replace(/^\/v1\.\d+/, "")));
    // The sites first, then the components of applications (ADR-0041): none here, so nothing more is inspected.
    expect(paths.filter((p) => p.startsWith("/containers/json"))).toEqual([
      `/containers/json?filters={"label":["${MANAGED_DOCKER_LABELS.siteId}"]}`,
      '/containers/json?filters={"label":["io.hostingpanel.app_component"]}',
    ]);
    expect(paths.filter((p) => /^\/containers\/[^/]+\/json$/.test(p))).toEqual([
      "/containers/hp_site_a_id/json",
      "/containers/hp_site_b_id/json",
    ]);
    expect(mockDaemon.execCalls.map((e) => e.container)).toEqual(["hp_site_a_id"]);
    expect(killCalls(mockDaemon)).toEqual([
      expect.objectContaining({ Cmd: ["/bin/sh", "-c", TERMINAL_KILL_SCRIPT, "sh", ""], User: "33:33" }),
    ]);
  });

  it("a failure on one container does not stop the pass and throws one coded fixed sentence", async () => {
    const mockDaemon = await startMockDockerDaemon({ execUpgrade: true });
    cleanup.push(() => mockDaemon.close());
    add(mockDaemon, site("hp_site_b", "site_b", { execIds: ["e0"] }));
    add(mockDaemon, site("hp_site_a", "site_a", { execIds: ["e1"] }));
    mockDaemon.failInspects.remaining = 1; // the first container's inspect answers 500 "boom"
    const adapter = new DockerEngineSocketAdapter({ dockerSocketPath: mockDaemon.socketPath });
    const err = (await adapter.reapTerminalShells().catch((e: unknown) => e)) as Error;
    expect(err).toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
    expect(err.message).not.toContain("boom");
    expect(mockDaemon.execCalls.map((e) => e.container)).toEqual(["hp_site_a_id"]);
    await expect(reapTerminalShells({ request: () => Promise.resolve({ statusCode: 500, body: Buffer.from("x") }), socketPath: "", apiPrefix: "" }, WORDPRESS_EXECUTOR_SITE_TYPE))
      .rejects.toMatchObject({ code: "DOCKER_ENGINE_UNAVAILABLE" });
  });
});
