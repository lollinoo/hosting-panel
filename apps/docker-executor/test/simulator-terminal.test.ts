import { createApprovedServiceSpec } from "@hosting-panel/executor-contracts";
import { describe, expect, it, vi } from "vitest";
import { InMemoryDockerSimulatorAdapter } from "../src/index.js";

const ID = (n: number) => `term_${String(n).padStart(32, "0")}`;
const PROMPT = "/var/www/html $ ";

function spec(n: number) {
  return createApprovedServiceSpec({
    serviceInstanceId: `svc_${n}`,
    siteId: `site_${n}`,
    organizationId: "org_1",
    image: "wordpress:7.1.4-php8.4-apache",
    containerName: `hp_svc_svc_${n}`,
  });
}

async function setup(n = 1, options?: ConstructorParameters<typeof InMemoryDockerSimulatorAdapter>[0]) {
  const sim = new InMemoryDockerSimulatorAdapter(options);
  await sim.deployService(spec(n));
  return sim;
}

const open = (sim: InMemoryDockerSimulatorAdapter, n = 1, site = `site_${n}`, svc = `svc_${n}`) =>
  sim.openTerminal({ sessionId: ID(n), siteId: site, serviceInstanceId: svc });

/** Types input and returns what the shell printed since the cursor. */
async function type(sim: InMemoryDockerSimulatorAdapter, cursor: number, input: string, n = 1) {
  await sim.writeTerminal({ sessionId: ID(n), input });
  return sim.readTerminal({ sessionId: ID(n), cursor });
}

const code = (p: Promise<unknown>) => p.then(() => "resolved", (e: { code?: string }) => e.code);

describe("simulator terminal shell", () => {
  it("prints the prompt, echoes with CR LF, and knows id, echo and unknown commands", async () => {
    const sim = await setup();
    expect(await open(sim)).toMatchObject({ containerName: "hp_svc_svc_1" });
    const first = await sim.readTerminal({ sessionId: ID(1), cursor: 0 });
    expect(first.output).toBe(PROMPT);
    const id = await type(sim, first.cursor, "id\r");
    expect(id.output).toBe(`id\r\nuid=33(www-data) gid=33(www-data) groups=33(www-data)\r\n${PROMPT}`);
    const echo = await type(sim, id.cursor, "echo hello there\n");
    expect(echo.output).toBe(`echo hello there\r\nhello there\r\n${PROMPT}`);
    const nope = await type(sim, echo.cursor, "ls -la\r");
    expect(nope.output).toBe(`ls -la\r\n/bin/sh: 1: ls: not found\r\n${PROMPT}`);
    const ctrlC = await type(sim, nope.cursor, "sleep\x03");
    expect(ctrlC.output).toBe(`sleep^C\r\n${PROMPT}`);
    expect(ctrlC.ended).toBeNull();
  });

  it("exit ends the session as shell_exited", async () => {
    const sim = await setup();
    await open(sim);
    const read = await type(sim, 0, "exit\r");
    expect(read.ended?.reason).toBe("shell_exited");
    await expect(sim.writeTerminal({ sessionId: ID(1), input: "id\r" })).rejects.toMatchObject({ code: "OPERATION_INTERRUPTED" });
    expect(await sim.closeTerminal({ sessionId: ID(1) })).toMatchObject({ reason: "shell_exited" });
  });

  it("Ctrl-D ends only on an empty line", async () => {
    const sim = await setup();
    await open(sim);
    expect((await type(sim, 0, "ab\x04")).ended).toBeNull();
    expect((await type(sim, 0, "\x03\x04")).ended?.reason).toBe("shell_exited");
  });

  it("emitTerminalOutput adds output and close answers closed", async () => {
    const sim = await setup();
    await open(sim);
    sim.emitTerminalOutput(ID(1), "x".repeat(300 * 1024));
    const read = await sim.readTerminal({ sessionId: ID(1), cursor: 0 });
    expect(read.dropped).toBe(true);
    expect(read.output.length).toBe(256 * 1024);
    expect(await sim.closeTerminal({ sessionId: ID(1) })).toMatchObject({ reason: "closed" });
    expect(await sim.listTerminals()).toEqual([]);
  });

  it("terminalLimits sets short limits", async () => {
    const sim = await setup(1, { terminalLimits: { maxSessions: 1 } });
    await sim.deployService(spec(2));
    await open(sim, 1);
    expect(await code(open(sim, 2))).toBe("QUOTA_EXCEEDED");
  });
});

describe("simulator terminal and the container", () => {
  it("refuses a missing, stopped or other site's container with NOT_FOUND, and gives the slot back", async () => {
    const sim = await setup();
    expect(await code(open(sim, 9))).toBe("NOT_FOUND");
    expect(await code(open(sim, 1, "site_other", "svc_1"))).toBe("NOT_FOUND");
    await sim.stopService("svc_1");
    expect(await code(open(sim, 1))).toBe("NOT_FOUND");
    expect(await sim.listTerminals()).toEqual([]);
    await sim.restartService("svc_1");
    await open(sim, 1);
  });

  it.each([
    ["stop", (sim: InMemoryDockerSimulatorAdapter) => sim.stopService("svc_1")],
    ["delete", (sim: InMemoryDockerSimulatorAdapter) => sim.deleteService("svc_1")],
    ["restart", (sim: InMemoryDockerSimulatorAdapter) => sim.restartService("svc_1")],
    ["redeploy", (sim: InMemoryDockerSimulatorAdapter) => sim.deployService(spec(1))],
  ])("%s ends that service's session with container_gone", async (_name, change) => {
    const sim = await setup();
    await sim.deployService(spec(2));
    await open(sim, 1);
    await open(sim, 2);
    const waiting = sim.readTerminal({ sessionId: ID(1), cursor: PROMPT.length });
    await change(sim);
    expect((await waiting).ended?.reason).toBe("container_gone");
    const ends = (await sim.listTerminals()).map((r) => [r.sessionId, r.ended?.reason ?? null]);
    expect(ends).toEqual([[ID(1), "container_gone"], [ID(2), null]]);
  });

  it.each([
    ["exit", (sim: InMemoryDockerSimulatorAdapter) => sim.writeTerminal({ sessionId: ID(1), input: "exit\r" })],
    ["idle", async () => {}],
    ["container_gone", (sim: InMemoryDockerSimulatorAdapter) => sim.stopService("svc_1")],
    ["close", (sim: InMemoryDockerSimulatorAdapter) => sim.closeTerminal({ sessionId: ID(1) })],
  ])("a session ended by %s lets go of its output sink", async (_name, end) => {
    const sim = await setup(1, { terminalLimits: { idleMs: 50 } });
    await open(sim);
    const sinks = (sim as unknown as { terminalSinks: Map<string, unknown> }).terminalSinks;
    expect(sinks.has(ID(1))).toBe(true);
    await end(sim);
    await vi.waitFor(() => expect(sinks.has(ID(1))).toBe(false));
    sim.emitTerminalOutput(ID(1), "late");
  });

  it("forgetTerminalSessions drops every session", async () => {
    const sim = await setup();
    await open(sim);
    expect((await sim.listTerminals()).map((r) => r.sessionId)).toEqual([ID(1)]);
    sim.forgetTerminalSessions();
    expect(await sim.listTerminals()).toEqual([]);
    expect(await code(sim.readTerminal({ sessionId: ID(1), cursor: 0 }))).toBe("NOT_FOUND");
  });

  it("an unreachable engine answers DOCKER_ENGINE_UNAVAILABLE on every terminal call", async () => {
    const sim = await setup();
    await open(sim);
    sim.setEngineReachable(false);
    const codes = await Promise.all([
      open(sim, 2),
      sim.writeTerminal({ sessionId: ID(1), input: "id\r" }),
      sim.readTerminal({ sessionId: ID(1), cursor: 0 }),
      sim.closeTerminal({ sessionId: ID(1) }),
      sim.listTerminals(),
    ].map(code));
    expect(codes).toEqual(Array(5).fill("DOCKER_ENGINE_UNAVAILABLE"));
    sim.setEngineReachable(true);
    expect((await sim.listTerminals()).map((r) => r.ended)).toEqual([null]);
  });

  it("restartPanelContainer changes one start time and answers NOT_FOUND for a missing component", async () => {
    const sim = new InMemoryDockerSimulatorAdapter();
    const before = await sim.getPanelContainers();
    const { startedAt } = await sim.restartPanelContainer({ component: "shared_database" });
    const after = await sim.getPanelContainers();
    expect(after.filter((r, i) => r.startedAt !== before[i]!.startedAt).map((r) => r.component)).toEqual(["shared_database"]);
    expect(after.find((r) => r.component === "shared_database")?.startedAt).toBe(startedAt);
    expect(await code(sim.restartPanelContainer({ component: "phpmyadmin" }))).toBe("NOT_FOUND");
  });
});
