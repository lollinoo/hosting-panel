import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  APP_STACK_TASK_LIMITS,
  AppStackTaskRunIpcResultSchema,
  appStackTextProblem,
  type AppStackTaskRunIpcRequest,
  type AppStackTaskRunIpcResult,
  type IpcSigningKey,
  type IpcVerificationKey,
} from "@hosting-panel/contracts";
import {
  APP_STACK_TASK_EXECUTOR_METHODS,
  Phase1DisabledDockerExecutor,
  isStackExecutor,
  isStackTaskExecutor,
} from "@hosting-panel/executor-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_STACK_COMPONENT_ROLE,
  APP_STACK_LABELS,
  APP_STACK_TASK_KILL_OWN_MARK_EXIT,
  APP_STACK_TASK_KILL_PASSES,
  APP_STACK_TASK_KILL_SCRIPT,
  APP_STACK_TASK_MARK,
  APP_STACK_TASK_READ_TIMEOUT_MS,
  APP_STACK_TASK_REAP_CONCURRENCY,
  APP_STACK_TASK_RUN_MARGIN_MS,
  AppStackExecutorError,
  DockerEngineSocketAdapter,
  DockerExecutorIpcServer,
  ExecutorIpcClientError,
  InMemoryDockerSimulatorAdapter,
  SignedDockerExecutorIpcClient,
  appStackContainerName,
  assertExecutableAppStackPlan,
  appStackSecretDirKey,
  type AppStackTaskLimits,
  type IngressCapableDockerExecutor,
} from "../src/index.js";
import { type MockDockerContainerRecord, type MockDockerDaemon, type MockExecPlan, startMockDockerDaemon } from "./mock-docker-daemon.js";
import { TEST_ALLOWLIST, appStackTestPlan, rehash } from "./support/app-stack-plans.js";

// ADR-0042: a task of an application. The command runs in the existing container of one component, started directly
// with no user, no folder, no terminal and no input; it ends at its time limit and what it started is killed.

const STACK = "stk_0123456789abcdef";
const OTHER_STACK = "stk_fedcba9876543210";
const ORG = "org_acme";
const RUN = (n: number) => `srun_${String(n).padStart(24, "0")}`;
const WEB = appStackContainerName(STACK, "web");
const CANARY = "CANARY-secret-7d41e9";
/** What the engine writes when it cannot start /bin/sh in an image that has none (exit 127; 126: not runnable). */
const NO_SHELL = 'OCI runtime exec failed: exec failed: unable to start container process: exec: "/bin/sh": stat /bin/sh: no such file or directory: unknown\r\n';
const ARGV = ["php", "artisan", "schedule:run"];

const request = (n: number, extra: Partial<AppStackTaskRunIpcRequest> = {}): AppStackTaskRunIpcRequest => ({
  stackId: STACK,
  organizationId: ORG,
  componentKey: "web",
  runId: RUN(n),
  argv: ARGV,
  timeoutSeconds: 5,
  ...extra,
});

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
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
    startedAt: "2026-11-23T01:00:00.000000001Z", hostConfig: {}, networks: {}, labels: labelsOf(key, stackId),
    ...extra,
  };
}

interface ExecCall {
  readonly execId: string;
  readonly container: string;
  readonly Cmd: string[];
  readonly Env: string[];
}
const isKill = (call: { readonly Cmd: string[] }) => call.Cmd[2] === APP_STACK_TASK_KILL_SCRIPT;
/** The run a clean-up is for; "" = the one before a command (any run). */
const killOf = (call: { readonly Cmd: string[] }) => call.Cmd[4];

/** What each exec does: `command` for the task's command, `kill` for the clean-up (default: it ends with code 0). */
interface Script {
  command?: (call: ExecCall, daemon: MockDockerDaemon) => MockExecPlan | undefined;
  kill?: (call: ExecCall, daemon: MockDockerDaemon) => MockExecPlan | undefined;
}

async function setup(script: Script = {}, limits: AppStackTaskLimits = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-app-task-"));
  cleanup.push(() => rm(tmp, { recursive: true, force: true }));
  const secretsRootDir = path.join(tmp, "secrets");
  const holder: { daemon?: MockDockerDaemon } = {};
  const mockDaemon = await startMockDockerDaemon({
    execUpgrade: true,
    execScript: (call) => (isKill(call) ? script.kill?.(call, holder.daemon!) : (script.command?.(call, holder.daemon!) ?? {})),
  });
  holder.daemon = mockDaemon;
  cleanup.push(() => mockDaemon.close());
  const adapter = new DockerEngineSocketAdapter({
    dockerSocketPath: mockDaemon.socketPath,
    secretsRootDir,
    ingressRootDir: path.join(tmp, "ingress"),
    // One "second" of a time limit lasts 20 ms here.
    appStackTaskLimits: { secondMs: 20, killTimeoutMs: 1_000, endSettleMs: 100, retryDelayMs: 20, ...limits },
  });
  mockDaemon.containers.set(`${WEB}_id`, component("web"));
  return { adapter, mockDaemon, secretsRootDir };
}

async function refusal(work: Promise<unknown>): Promise<{ code?: string; reason?: string; message: string }> {
  try {
    await work;
  } catch (err) {
    return err as { code?: string; reason?: string; message: string };
  }
  throw new Error("expected a refusal");
}

const cmds = (d: MockDockerDaemon) => d.execBodies.map((body) => body.Cmd as string[]);
/** The run of each clean-up, in order ("" = the one before a command). */
const killRuns = (d: MockDockerDaemon) => cmds(d).filter((cmd) => cmd[2] === APP_STACK_TASK_KILL_SCRIPT).map((cmd) => cmd[4]);
const paths = (d: MockDockerDaemon) => d.requestedPaths.map((p) => decodeURIComponent(p.replace(/^\/v1\.\d+/, "")));
const until = async (done: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(done()).toBe(true);
};

describe("the clean-up script of tasks", () => {
  it("uses only /proc and what a shell has built in, looks for the mark of a run and never kills pid 1", () => {
    expect(APP_STACK_TASK_MARK).toBe("HP_TASK_RUN");
    expect(APP_STACK_TASK_KILL_SCRIPT).toContain('m="HP_TASK_RUN=${1:-srun_}"');
    expect(APP_STACK_TASK_KILL_SCRIPT).toContain("/proc/[0-9]*");
    for (const program of ["ps ", "pkill", "pgrep", "grep", "awk", "sed ", "cut ", "xargs", "cat ", "tr "]) {
      expect(APP_STACK_TASK_KILL_SCRIPT, program).not.toContain(program);
    }
    // One kill, guarded by "the pid is above 1"; the scan of the sessions never looks at pid 1 either.
    expect(APP_STACK_TASK_KILL_SCRIPT.match(/kill -KILL/g)).toHaveLength(1);
    expect(APP_STACK_TASK_KILL_SCRIPT).toContain('hit() { [ "$1" -gt 1 ] || return 0; kill -KILL "$1" 2>/dev/null;');
    expect(APP_STACK_TASK_KILL_SCRIPT).toContain('[ "${p#/proc/}" -gt 1 ] || continue;');
    expect(APP_STACK_TASK_KILL_SCRIPT.match(/hit "\$\{p#\/proc\/\}"/g)).toHaveLength(2);
  });

  it("repeats its pass until one finds no process it had not killed yet, and fails when the last one still does", () => {
    // A process forked while a pass ran is found by the next one; one already killed but not gone yet does not count.
    expect(APP_STACK_TASK_KILL_SCRIPT).toContain('case "$k" in *" $1 "*) ;; *) k="$k$1 "; f=1;; esac;');
    expect(APP_STACK_TASK_KILL_SCRIPT).toContain("pass() { f=0;");
    expect(APP_STACK_TASK_KILL_SCRIPT).toContain(`n=0; while [ "$n" -lt ${String(APP_STACK_TASK_KILL_PASSES)} ]; do pass; [ "$f" = 0 ] && exit 0; n=$((n+1)); done; exit 1`);
    expect(APP_STACK_TASK_KILL_PASSES).toBeGreaterThanOrEqual(3);
    expect(APP_STACK_TASK_KILL_PASSES).toBeLessThanOrEqual(10);
    // The one exit 0 is a pass that found nothing new; at the bound the clean-up did not finish (the retry path).
    expect(APP_STACK_TASK_KILL_SCRIPT.match(/exit 0/g)).toHaveLength(1);
    expect(APP_STACK_TASK_KILL_SCRIPT.endsWith("exit 1")).toBe(true);
  });

  it("kills nothing where pid 1 itself carries the mark, and says so with a code of its own", () => {
    const script = APP_STACK_TASK_KILL_SCRIPT;
    const check = `marked /proc/1 && exit ${String(APP_STACK_TASK_KILL_OWN_MARK_EXIT)}; `;
    // The environment of pid 1 is read as any other, first: before any kill and before the first pass.
    expect(script).toContain(check);
    expect(script.indexOf("marked() {")).toBeLessThan(script.indexOf(check));
    for (const later of ["hit() {", "kill -KILL", "pass() {", "n=0; while"]) expect(script.indexOf(check), later).toBeLessThan(script.indexOf(later));
    expect(script.match(/marked /g)).toHaveLength(2);
    // A code no other end gives: 0 done, 1 not finished, 2 a shell's own error, 126 and 127 the engine's, 128 and up a
    // signal (137: the script killed itself).
    expect(Number.isInteger(APP_STACK_TASK_KILL_OWN_MARK_EXIT)).toBe(true);
    expect(APP_STACK_TASK_KILL_OWN_MARK_EXIT).toBeGreaterThan(2);
    expect(APP_STACK_TASK_KILL_OWN_MARK_EXIT).toBeLessThan(126);
    expect(script.match(new RegExp(`exit ${String(APP_STACK_TASK_KILL_OWN_MARK_EXIT)}\\b`, "g"))).toHaveLength(1);
    expect(script.match(/exit \d+/g)).toEqual([`exit ${String(APP_STACK_TASK_KILL_OWN_MARK_EXIT)}`, "exit 0", "exit 1"]);
  });
});

describe("the mark of a run in the environment of a component", () => {
  // ADR-0042 §7: the clean-up finds what a run started by "HP_TASK_RUN=" as text anywhere in an environment, so no value
  // of a component may hold it; the executor re-checks every plan. The rule is the platform's process marks (ADR-0041).
  it("is refused in a plan before anything reaches Docker", () => {
    const plan = appStackTestPlan();
    const [web, worker] = plan.components;
    // Not through the plan schema of the test helper, which refuses the mark already: the executor's own check is under test.
    const marked = rehash({ ...plan, components: [{ ...web!, environment: [{ name: "APP_MODE", value: `x ${APP_STACK_TASK_MARK}=srun_` }] }, worker!] });
    let refused: unknown = null;
    try {
      assertExecutableAppStackPlan(marked, { allowlist: TEST_ALLOWLIST });
    } catch (err) {
      refused = err;
    }
    expect(refused).toMatchObject({ reason: "STACK_PLAN_INVALID" });
    // The mark the executor sets is the one the rule names.
    expect(appStackTextProblem(`x ${APP_STACK_TASK_MARK}=srun_1`)).toBe("process_mark");
  });
});

describe("runAppStackTask on the Docker Engine", () => {
  it("runs the command directly in the checked container: no user, no folder, no terminal, only the mark", async () => {
    const { adapter, mockDaemon } = await setup({
      command: () => ({ frames: [[1, "Running scheduled command\n"], [2, "one warning\r\n"], [1, "done\n"]] }),
    });
    const result = await adapter.runAppStackTask(request(1));
    expect(AppStackTaskRunIpcResultSchema.safeParse(result).success).toBe(true);
    expect(result).toEqual({
      runId: RUN(1),
      outcome: "succeeded",
      problem: null,
      exitCode: 0,
      startedAt: expect.any(String) as string,
      endedAt: expect.any(String) as string,
      output: "Running scheduled command\none warning\ndone",
      outputTruncated: false,
    });

    // The container is found by the name the executor derives; every exec goes to the id that the inspect returned.
    expect(paths(mockDaemon)[0]).toBe(`/containers/${WEB}/json`);
    expect(mockDaemon.execCalls.map((c) => c.container)).toEqual([`${WEB}_id`, `${WEB}_id`, `${WEB}_id`]);
    // 1. the clean-up, for any run (it also proves the command can be stopped); 2. the command; 3. the clean-up of this run.
    const [before, command, after] = mockDaemon.execBodies as [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
    expect(before.Cmd).toEqual(["/bin/sh", "-c", APP_STACK_TASK_KILL_SCRIPT, "sh", ""]);
    expect(after.Cmd).toEqual(["/bin/sh", "-c", APP_STACK_TASK_KILL_SCRIPT, "sh", RUN(1)]);
    expect(command).toEqual({
      Cmd: ARGV,
      Env: [`HP_TASK_RUN=${RUN(1)}`],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    for (const body of [before, command, after]) {
      expect(body).not.toHaveProperty("User");
      expect(body).not.toHaveProperty("WorkingDir");
      expect(body).not.toHaveProperty("Privileged");
      expect(body.Tty).toBe(false);
    }
    // No Docker id leaves the executor.
    expect(JSON.stringify(result)).not.toMatch(/_id|exec_/);
  });

  it("tells how the command ended: its exit code, or none when the engine does not tell", async () => {
    const codes: Array<number | null> = [3, 255, null, 300];
    const { adapter } = await setup({ command: () => ({ exitCode: codes.shift() ?? null }) });
    const seen: Array<[string, number | null]> = [];
    for (let n = 1; n <= 4; n += 1) {
      const result = await adapter.runAppStackTask(request(n));
      expect(AppStackTaskRunIpcResultSchema.safeParse(result).success).toBe(true);
      seen.push([result.outcome, result.exitCode]);
    }
    expect(seen).toEqual([["failed", 3], ["failed", 255], ["failed", null], ["failed", null]]);
  });

  it("does not return the engine's own message when it could not start the program: it names the program", async () => {
    const engine = 'OCI runtime exec failed: exec failed: unable to start container process: exec: "php": executable file not found in $PATH: unknown\r\n';
    const plans: MockExecPlan[] = [
      { frames: [[1, engine]], exitCode: 127 },
      { frames: [[2, engine]], exitCode: 126 },
      // A program that ran and ended with 127 by itself keeps what it printed; so does the engine's text with another code.
      { frames: [[1, "my own error\n"]], exitCode: 127 },
      { frames: [[1, engine]], exitCode: 1 },
      // The engine did not tell the exit code: its own message still never comes back.
      { frames: [[2, engine]], exitCode: null },
      { frames: [[1, "printed by the task\n"]], exitCode: null },
    ];
    const { adapter } = await setup({ command: () => plans.shift() });
    const results = [];
    for (let n = 1; n <= 6; n += 1) results.push(await adapter.runAppStackTask(request(n)));
    expect(results.map((r) => [r.outcome, r.exitCode, r.output === "" ? "" : r.output.slice(0, 12)])).toEqual([
      ["failed", 127, ""],
      ["failed", 126, ""],
      ["failed", 127, "my own error"],
      ["failed", 1, "OCI runtime "],
      ["failed", null, ""],
      ["failed", null, "printed by t"],
    ]);
    expect(JSON.stringify([...results.slice(0, 2), results[4]])).not.toContain("php");
    for (const result of results) expect(AppStackTaskRunIpcResultSchema.safeParse(result).success).toBe(true);
  });

  it("returns nothing of a command that never started, whatever the engine wrote: no process, or an exec it dropped", async () => {
    // The component stopped between the creation and the start of the exec: the engine's text carries a Docker id.
    const dockerId = "4f".repeat(32);
    const plans: MockExecPlan[] = [
      { frames: [[1, `container ${dockerId} is not running\r\n`]], exitCode: 126, pid: 0 },
      { frames: [[1, `No such exec instance: ${dockerId}\r\n`]], exitCode: null, forgotten: true },
      // A command whose process started keeps what it printed, whatever its exit code.
      { frames: [[1, "my own error\n"]], exitCode: 126, pid: 4242 },
      { frames: [[2, "printed by the task\n"]], exitCode: null, pid: 4243 },
    ];
    const { adapter } = await setup({ command: () => plans.shift() });
    const results = [];
    for (let n = 1; n <= 4; n += 1) results.push(await adapter.runAppStackTask(request(n)));
    expect(results.map((r) => [r.outcome, r.exitCode, r.output])).toEqual([
      ["failed", 126, ""],
      ["failed", null, ""],
      ["failed", 126, "my own error"],
      ["failed", null, "printed by the task"],
    ]);
    expect(JSON.stringify(results)).not.toContain(dockerId);
    for (const result of results) expect(AppStackTaskRunIpcResultSchema.safeParse(result).success).toBe(true);
  });

  it("masks the secrets of the component in what the command printed", async () => {
    const { adapter, secretsRootDir } = await setup({
      command: () => ({ frames: [[1, `key=${CANARY}\n`], [2, `again ${CANARY} here\n`], [1, "clean\n"]] }),
    });
    const dir = path.join(secretsRootDir, appStackSecretDirKey(STACK, "web"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "app_key"), CANARY);
    const result = await adapter.runAppStackTask(request(1));
    expect(result.output).toBe("key=[REDACTED]\nagain [REDACTED] here\nclean");
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it("keeps the last lines only, cleaned, and says when something was left out", async () => {
    const many = Array.from({ length: 300 }, (_, i) => `line ${String(i + 1)}\n`).join("");
    const plans: MockExecPlan[] = [
      { frames: [[1, many]] },
      // More than the executor keeps while the command runs: the beginning is dropped, with the line the cut broke.
      { frames: [[1, `${"a".repeat(70_000)}\nlast\n`]] },
      { frames: [[1, "bell\u0007 esc\u001b[31m tab\there\n"]] },
      // A frame split in pieces, a stream that is not one of the two outputs, and text with no frame at all.
      { frames: [[1, "kept\n"]], raw: Buffer.concat([Buffer.from([3, 0, 0, 0, 0, 0, 0, 5]), Buffer.from("other"), Buffer.from("OCI runtime exec failed")]) },
      { frames: [[1, "no newline at the end"]] },
    ];
    const { adapter } = await setup({ command: () => plans.shift() });
    const lines = await adapter.runAppStackTask(request(1));
    expect(lines.output.split("\n")).toHaveLength(APP_STACK_TASK_LIMITS.outputLines);
    expect(lines.output.split("\n")[0]).toBe("line 101");
    expect(lines.output.endsWith("line 300")).toBe(true);
    expect(lines.outputTruncated).toBe(true);

    const bytes = await adapter.runAppStackTask(request(2));
    expect(bytes.outputTruncated).toBe(true);
    expect(Buffer.byteLength(bytes.output, "utf8")).toBeLessThanOrEqual(APP_STACK_TASK_LIMITS.outputBytes);
    expect(bytes.output.endsWith("last")).toBe(true);

    const cleaned = await adapter.runAppStackTask(request(3));
    expect(cleaned.output).toBe("bell esc[31m tab\there");
    expect(cleaned.outputTruncated).toBe(false);

    const odd = await adapter.runAppStackTask(request(4));
    expect(odd.output).toBe("kept");
    expect((await adapter.runAppStackTask(request(5))).output).toBe("no newline at the end");
    for (const result of [lines, bytes, cleaned, odd]) expect(AppStackTaskRunIpcResultSchema.safeParse(result).success).toBe(true);
  });

  it("ends the command at its time limit, kills what it started and says timed_out", async () => {
    let commandExec = "";
    const { adapter, mockDaemon } = await setup({
      command: (call) => {
        commandExec = call.execId;
        return { stayOpen: true, frames: [[1, "started\n"]] };
      },
      // The clean-up of this run kills the command: its output ends.
      kill: (call, daemon) => {
        if (killOf(call) === RUN(1)) daemon.endExec(commandExec, 137);
        return undefined;
      },
    });
    const startedAt = Date.now();
    const result = await adapter.runAppStackTask(request(1, { timeoutSeconds: 5 }));
    const took = Date.now() - startedAt;
    expect(took).toBeGreaterThanOrEqual(95);
    expect(took).toBeLessThan(5_000);
    expect(result).toMatchObject({ outcome: "timed_out", problem: null, exitCode: null, output: "started", outputTruncated: false });
    expect(AppStackTaskRunIpcResultSchema.safeParse(result).success).toBe(true);
    expect(killRuns(mockDaemon)).toEqual(["", RUN(1)]);
  });

  it("answers at the time limit also when the output never ends", async () => {
    const { adapter, mockDaemon } = await setup({ command: () => ({ stayOpen: true, frames: [[2, "stuck\n"]] }) });
    const result = await adapter.runAppStackTask(request(1));
    expect(result).toMatchObject({ outcome: "timed_out", exitCode: null, output: "stuck" });
    expect(killRuns(mockDaemon)).toEqual(["", RUN(1)]);
    // The run is over for the executor: the next task of the application starts.
    const next = await adapter.runAppStackTask(request(2));
    expect(next.outcome).toBe("timed_out");
  });

  it("refuses a container whose labels are not the ones of this component, before any exec", async () => {
    const wrong: Array<Record<string, string>> = [
      labelsOf("web", STACK, "org_other"),
      labelsOf("web", OTHER_STACK),
      labelsOf("worker"),
      { ...labelsOf("web"), [APP_STACK_LABELS.role]: "site" },
      { ...labelsOf("web"), [APP_STACK_LABELS.managed]: "false" },
      {},
    ];
    for (const labels of wrong) {
      const { adapter, mockDaemon } = await setup();
      mockDaemon.containers.set(`${WEB}_id`, component("web", { labels }));
      const err = await refusal(adapter.runAppStackTask(request(1)));
      expect([err.reason, err.code], JSON.stringify(labels)).toEqual(["STACK_NAMESPACE_CONFLICT", "HOST_POLICY_DENIED"]);
      expect(mockDaemon.execBodies).toEqual([]);
      expect(await adapter.getAppStackTaskRun({ stackId: STACK, organizationId: ORG, runId: RUN(1) })).toEqual({ state: "unknown" });
    }
  });

  it("refuses a component that is missing or not running, before any exec", async () => {
    const stopped = await setup();
    stopped.mockDaemon.containers.set(`${WEB}_id`, component("web", { running: false, status: "exited" }));
    const first = await refusal(stopped.adapter.runAppStackTask(request(1)));
    expect([first.reason, first.code]).toEqual(["STACK_COMPONENT_NOT_READY", "RESOURCE_LOCKED"]);
    expect(stopped.mockDaemon.execBodies).toEqual([]);

    const missing = await setup();
    missing.mockDaemon.containers.clear();
    expect((await refusal(missing.adapter.runAppStackTask(request(1)))).reason).toBe("STACK_COMPONENT_NOT_READY");
    expect((await refusal(missing.adapter.runAppStackTask(request(2, { componentKey: "worker" })))).reason).toBe("STACK_COMPONENT_NOT_READY");
    expect(missing.mockDaemon.execBodies).toEqual([]);
    // Nothing ran: the same run may be asked again once the component is back.
    missing.mockDaemon.containers.set(`${WEB}_id`, component("web"));
    expect((await missing.adapter.runAppStackTask(request(1))).outcome).toBe("succeeded");
  });

  it("does not start a command it could not stop: a component with no shell answers not_started", async () => {
    for (const exitCode of [126, 127]) {
      const { adapter, mockDaemon } = await setup({ kill: () => ({ exitCode, frames: [[1, NO_SHELL]] }) });
      const result = await adapter.runAppStackTask(request(1));
      expect(result).toEqual({
        runId: RUN(1),
        outcome: "not_started",
        problem: "no_shell",
        exitCode: null,
        startedAt: null,
        endedAt: expect.any(String) as string,
        output: "",
        outputTruncated: false,
      });
      expect(AppStackTaskRunIpcResultSchema.safeParse(result).success).toBe(true);
      // Only the clean-up was tried; the command was never created.
      expect(mockDaemon.execBodies).toHaveLength(1);
      expect(await adapter.runAppStackTask(request(1))).toEqual(result);
      expect(mockDaemon.execBodies).toHaveLength(1);
    }
  });

  it("takes a 126 or 127 of the clean-up for no shell only with the engine's own message", async () => {
    // The script itself, in a component that has a shell, ending with 126 or 127: the clean-up did not finish.
    for (const exitCode of [126, 127]) {
      const { adapter, mockDaemon } = await setup({ kill: () => ({ exitCode, frames: [[2, "kill: something of its own\n"]] }) });
      const err = await refusal(adapter.runAppStackTask(request(1)));
      expect([err.code, err.reason], String(exitCode)).toEqual(["DOCKER_ENGINE_UNAVAILABLE", undefined]);
      expect(cmds(mockDaemon).every((cmd) => cmd[2] === APP_STACK_TASK_KILL_SCRIPT)).toBe(true);
    }
    const silent = await setup({ kill: () => ({ exitCode: 127 }) });
    expect((await refusal(silent.adapter.runAppStackTask(request(1)))).code).toBe("DOCKER_ENGINE_UNAVAILABLE");
  });

  it("starts nothing when the clean-up before the command does not finish, and forgets the run", async () => {
    const plans: Array<MockExecPlan | undefined> = [{ exitCode: 1 }, { failStart: true }, { stayOpen: true }];
    const { adapter, mockDaemon } = await setup({ kill: () => plans.shift() });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const err = await refusal(adapter.runAppStackTask(request(1)));
      expect([err.code, err.reason], String(attempt)).toEqual(["DOCKER_ENGINE_UNAVAILABLE", undefined]);
      expect(cmds(mockDaemon).every((cmd) => cmd[2] === APP_STACK_TASK_KILL_SCRIPT)).toBe(true);
      expect(await adapter.getAppStackTaskRun({ stackId: STACK, organizationId: ORG, runId: RUN(1) })).toEqual({ state: "unknown" });
    }
    // Nothing ran, so the same run may still start.
    expect((await adapter.runAppStackTask(request(1))).outcome).toBe("succeeded");
  });

  it("starts nothing in a component whose own environment carries the mark, and never retries a clean-up there", async () => {
    // pid 1 carries the mark: the script killed nothing and said so. The probe refuses the run as not available.
    const own: MockExecPlan = { exitCode: APP_STACK_TASK_KILL_OWN_MARK_EXIT };
    const { adapter, mockDaemon } = await setup({ kill: () => own });
    const err = await refusal(adapter.runAppStackTask(request(1)));
    expect([err.code, err.reason]).toEqual(["DOCKER_ENGINE_UNAVAILABLE", undefined]);
    expect(cmds(mockDaemon).every((cmd) => cmd[2] === APP_STACK_TASK_KILL_SCRIPT)).toBe(true);
    expect(await adapter.getAppStackTaskRun({ stackId: STACK, organizationId: ORG, runId: RUN(1) })).toEqual({ state: "unknown" });

    // The same answer after a run: trying again would kill nothing again, so it is logged as not finished at once.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const after = await setup({ kill: (call) => (killOf(call) === RUN(1) ? own : undefined) });
    expect((await after.adapter.runAppStackTask(request(1))).outcome).toBe("succeeded");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(killRuns(after.mockDaemon)).toEqual(["", RUN(1)]);
    expect(warn.mock.calls.map((call) => (JSON.parse(String(call[0])) as { event?: unknown }).event)).toEqual(["app_task_cleanup_failed"]);
  });

  it("refuses when the component goes away between the clean-up and the command", async () => {
    const { adapter, mockDaemon } = await setup({
      kill: (_call, daemon) => {
        daemon.containers.clear();
        return undefined;
      },
    });
    const err = await refusal(adapter.runAppStackTask(request(1)));
    expect(err.reason).toBe("STACK_COMPONENT_NOT_READY");
    expect(mockDaemon.execBodies).toHaveLength(1);
    expect(await adapter.getAppStackTaskRun({ stackId: STACK, organizationId: ORG, runId: RUN(1) })).toEqual({ state: "unknown" });
  });

  it("treats a command whose start failed as one that may be running: it cleans up and says failed", async () => {
    const { adapter, mockDaemon } = await setup({ command: () => ({ failStart: true }) });
    const result = await adapter.runAppStackTask(request(1));
    expect(result).toMatchObject({ outcome: "failed", problem: null, exitCode: null, output: "" });
    expect(result.startedAt).not.toBeNull();
    expect(AppStackTaskRunIpcResultSchema.safeParse(result).success).toBe(true);
    expect(killRuns(mockDaemon)).toEqual(["", RUN(1)]);
  });

  it("cleans up and says failed when the connection to the engine drops while the command runs", async () => {
    let commandExec = "";
    const { adapter } = await setup({
      command: (call) => {
        commandExec = call.execId;
        return { cut: true, frames: [[1, "half\n"]] };
      },
      kill: (call, daemon) => {
        if (killOf(call) === RUN(1)) daemon.endExec(commandExec, 137);
        return undefined;
      },
    });
    const result = await adapter.runAppStackTask(request(1));
    expect(result).toMatchObject({ outcome: "failed", exitCode: 137, output: "half" });
  });

  it("runs one task of an application at a time, and never the same run twice", async () => {
    let held = "";
    let commands = 0;
    const { adapter, mockDaemon } = await setup({
      command: (call) => {
        commands += 1;
        if (commands > 1) return {};
        held = call.execId;
        return { stayOpen: true, frames: [[1, "going\n"]] };
      },
    });
    mockDaemon.containers.set("other_id", component("web", { id: "other_id" }, OTHER_STACK));
    const first = adapter.runAppStackTask(request(1, { timeoutSeconds: 600 }));
    await until(() => held !== "");
    const read = { stackId: STACK, organizationId: ORG, runId: RUN(1) };
    expect(await adapter.getAppStackTaskRun(read)).toEqual({ state: "running" });

    const second = await refusal(adapter.runAppStackTask(request(2)));
    expect([second.reason, second.code, second.message]).toEqual(["STACK_BUSY", "RESOURCE_LOCKED", "A task of this application is already running"]);
    const same = await refusal(adapter.runAppStackTask(request(1)));
    expect([same.reason, same.message]).toEqual(["STACK_BUSY", "This run is still going"]);
    // Another application is not held back.
    expect((await adapter.runAppStackTask(request(3, { stackId: OTHER_STACK }))).outcome).toBe("succeeded");

    mockDaemon.endExec(held, 0);
    const result = await first;
    expect(result).toMatchObject({ outcome: "succeeded", exitCode: 0, output: "going" });
    expect(await adapter.getAppStackTaskRun(read)).toEqual({ state: "finished", result });

    const execs = mockDaemon.execBodies.length;
    expect(await adapter.runAppStackTask(request(1))).toEqual(result);
    expect(await adapter.runAppStackTask(request(1, { argv: ["other"], timeoutSeconds: 9 }))).toEqual(result);
    expect(mockDaemon.execBodies).toHaveLength(execs);
    expect(commands).toBe(2);
  });

  it("keeps the engine off the containers of an application while its task runs, and a task off while the engine works", async () => {
    let held = "";
    const { adapter, mockDaemon } = await setup({
      command: (call) => {
        if (held !== "") return {};
        held = call.execId;
        return { stayOpen: true, frames: [[1, "going\n"]] };
      },
    });
    mockDaemon.containers.set("other_id", component("web", { id: "other_id" }, OTHER_STACK));
    const ref = { stackId: STACK, organizationId: ORG };
    const plan = appStackTestPlan();
    const first = adapter.runAppStackTask(request(1, { timeoutSeconds: 600 }));
    await until(() => held !== "");

    // The executor does not trust the API's lock: create, start, restart, stop and remove are refused meanwhile.
    const asked = mockDaemon.requestedPaths.length;
    const changes: Array<() => Promise<unknown>> = [
      () => adapter.createAppStackComponents({ plan }),
      () => adapter.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }),
      () => adapter.restartAppStackComponent({ plan, componentKey: "web", secretFileContents: [] }),
      () => adapter.stopAppStack(ref),
      () => adapter.removeAppStack({ ...ref, removeVolumes: false }),
      () => adapter.removeAppStackComponents({ plan, componentKeys: ["worker"] }),
    ];
    for (const change of changes) {
      const err = await refusal(change());
      expect([err.reason, err.code, err.message]).toEqual(["STACK_BUSY", "RESOURCE_LOCKED", "A task of this application stack is running"]);
    }
    expect(mockDaemon.requestedPaths.length).toBe(asked);
    // Another application is not held back.
    await adapter.stopAppStack({ stackId: OTHER_STACK, organizationId: ORG });
    mockDaemon.endExec(held, 0);
    expect((await first).outcome).toBe("succeeded");

    // The reverse: while the engine changes the application, a task is refused before anything is asked to Docker.
    const execs = mockDaemon.execBodies.length;
    const stopping = adapter.stopAppStack(ref);
    const err = await refusal(adapter.runAppStackTask(request(2)));
    expect([err.reason, err.code, err.message]).toEqual(["STACK_BUSY", "RESOURCE_LOCKED", "The application is being changed"]);
    await stopping;
    expect(mockDaemon.execBodies).toHaveLength(execs);
    // Nothing ran: the same run may be asked again once the engine is done.
    mockDaemon.containers.set(`${WEB}_id`, component("web"));
    expect((await adapter.runAppStackTask(request(2))).outcome).toBe("succeeded");
  });

  it("tells a run only to the application and the customer it belongs to", async () => {
    const { adapter, mockDaemon } = await setup();
    const result = await adapter.runAppStackTask(request(1));
    expect(await adapter.getAppStackTaskRun({ stackId: STACK, organizationId: ORG, runId: RUN(1) })).toEqual({ state: "finished", result });
    expect(await adapter.getAppStackTaskRun({ stackId: STACK, organizationId: "org_other", runId: RUN(1) })).toEqual({ state: "unknown" });
    expect(await adapter.getAppStackTaskRun({ stackId: OTHER_STACK, organizationId: ORG, runId: RUN(1) })).toEqual({ state: "unknown" });
    expect(await adapter.getAppStackTaskRun({ stackId: STACK, organizationId: ORG, runId: RUN(2) })).toEqual({ state: "unknown" });
    const execs = mockDaemon.execBodies.length;
    for (const other of [{ organizationId: "org_other" }, { stackId: OTHER_STACK }]) {
      const err = await refusal(adapter.runAppStackTask(request(1, other)));
      expect(err.reason).toBe("STACK_NAMESPACE_CONFLICT");
    }
    // A read starts nothing.
    expect(mockDaemon.execBodies).toHaveLength(execs);
  });

  it("refuses a request that is not valid before it asks the engine anything", async () => {
    const { adapter, mockDaemon } = await setup();
    const bad: unknown[] = [
      request(1, { argv: ["/bin/sh", "-c", "id"] }),
      request(1, { argv: ["bash", "-lc", "id"] }),
      request(1, { argv: [] }),
      request(1, { timeoutSeconds: 601 }),
      request(1, { timeoutSeconds: 4 }),
      request(1, { runId: "srun_1" }),
      request(1, { componentKey: "Web" }),
      { ...request(1), user: "0" },
      { ...request(1), workingDir: "/" },
      { ...request(1), containerId: "abc" },
      { ...request(1), env: ["A=b"] },
    ];
    for (const body of bad) {
      const err = await refusal(adapter.runAppStackTask(body as AppStackTaskRunIpcRequest));
      expect(err.code, JSON.stringify(body)).toBe("VALIDATION_ERROR");
      expect(err.message).toBe("The request of a task run is not valid");
    }
    const read = await refusal(adapter.getAppStackTaskRun({ stackId: STACK, organizationId: ORG, runId: "x" }));
    expect(read.code).toBe("VALIDATION_ERROR");
    expect(mockDaemon.requestedPaths).toEqual([]);
  });

  it("tries the clean-up again when it fails after a run, and logs a code only when it gives up", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let failing = 3;
    const retried = await setup({
      kill: (call) => {
        if (killOf(call) !== RUN(1) || failing === 0) return undefined;
        failing -= 1;
        return { exitCode: 1 };
      },
    });
    expect((await retried.adapter.runAppStackTask(request(1))).outcome).toBe("succeeded");
    const kills = (d: MockDockerDaemon) => killRuns(d).filter((runId) => runId === RUN(1)).length;
    await until(() => kills(retried.mockDaemon) === 4);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(kills(retried.mockDaemon)).toBe(4);
    expect(warn).not.toHaveBeenCalled();

    const never = await setup({ kill: (call) => (killOf(call) === RUN(1) ? { exitCode: 1 } : undefined) });
    expect((await never.adapter.runAppStackTask(request(1))).outcome).toBe("succeeded");
    await until(() => warn.mock.calls.length === 1);
    expect(kills(never.mockDaemon)).toBe(6);
    const logged = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(Object.keys(logged).sort()).toEqual(["code", "component", "event", "timestamp"]);
    expect([logged.component, logged.event, logged.code]).toEqual(["hp-docker-executor", "app_task_cleanup_failed", "INTERNAL_ERROR"]);
  });
});

describe("reapAppStackTasks at the start of the executor", () => {
  it("cleans every running component, also one whose execs have all ended, and nothing else", async () => {
    const { adapter, mockDaemon } = await setup();
    const add = (record: MockDockerContainerRecord) => mockDaemon.containers.set(record.id, record);
    mockDaemon.containers.clear();
    add(component("web", { execIds: ["old_exec"] }));
    // The engine drops an exec from ExecIDs once its command ends; what the command left in the background stays.
    add(component("worker", { execIds: [] }));
    add(component("cache"));
    add(component("db", { execIds: ["x"], running: false, status: "exited" }));
    // The labels of a component under a name the engine does not give it: not touched.
    add({ ...component("web", { execIds: ["x"] }, OTHER_STACK), id: "odd_id", name: "odd-name" });
    // A site container is not a component.
    add({ ...component("web", { execIds: ["x"] }), id: "site_id", name: "hp_svc_site", labels: { [APP_STACK_LABELS.managed]: "true" } });
    await adapter.reapAppStackTasks();
    const kill = ["/bin/sh", "-c", APP_STACK_TASK_KILL_SCRIPT, "sh", ""];
    expect([...mockDaemon.execCalls].sort((a, b) => a.container.localeCompare(b.container))).toEqual(
      ["cache", "web", "worker"].map((key) => ({ container: `${appStackContainerName(STACK, key)}_id`, Cmd: kill })).sort((a, b) => a.container.localeCompare(b.container)),
    );
    for (const body of mockDaemon.execBodies) {
      expect(body).not.toHaveProperty("User");
      expect(body).not.toHaveProperty("Env");
    }
  });

  it("goes on after a component that fails and tells the failure at the end; no shell is not a failure", async () => {
    const outcomes = new Map<string, MockExecPlan>([
      [`${appStackContainerName(STACK, "web")}_id`, { exitCode: 1 }],
      [`${appStackContainerName(STACK, "worker")}_id`, { exitCode: 127, frames: [[1, NO_SHELL]] }],
    ]);
    const { adapter, mockDaemon } = await setup({ kill: (call) => outcomes.get(call.container) });
    for (const key of ["web", "worker", "cache"]) {
      const record = component(key, { execIds: ["left"] });
      mockDaemon.containers.set(record.id, record);
    }
    const err = await refusal(adapter.reapAppStackTasks());
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(mockDaemon.execCalls.map((c) => c.container).sort()).toEqual(
      ["cache", "web", "worker"].map((key) => `${appStackContainerName(STACK, key)}_id`).sort(),
    );
    outcomes.clear();
    await expect(adapter.reapAppStackTasks()).resolves.toBeUndefined();
  });

  it("leaves a component whose own environment carries the mark, logs a count once and goes on", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const own = new Set(["web", "cache"].map((key) => `${appStackContainerName(STACK, key)}_id`));
    const { adapter, mockDaemon } = await setup({ kill: (call) => (own.has(call.container) ? { exitCode: APP_STACK_TASK_KILL_OWN_MARK_EXIT } : undefined) });
    for (const key of ["web", "worker", "cache"]) {
      const record = component(key);
      mockDaemon.containers.set(record.id, record);
    }
    await expect(adapter.reapAppStackTasks()).resolves.toBeUndefined();
    expect(mockDaemon.execCalls.map((c) => c.container).sort()).toEqual(
      ["cache", "web", "worker"].map((key) => `${appStackContainerName(STACK, key)}_id`).sort(),
    );
    // One line for the pass, with a count only: no name and no id.
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(Object.keys(logged).sort()).toEqual(["component", "count", "event", "timestamp"]);
    expect([logged.component, logged.event, logged.count]).toEqual(["hp-docker-executor", "app_task_mark_in_component", 2]);
  });

  const KEYS = ["web", "worker", "cache", "db", "queue", "mail"];
  const addAll = (d: MockDockerDaemon) => {
    for (const key of KEYS) d.containers.set(`${appStackContainerName(STACK, key)}_id`, component(key));
  };

  it("cleans a few components at once, not more", async () => {
    const held: string[] = [];
    const { adapter, mockDaemon } = await setup(
      {
        kill: (call) => {
          held.push(call.execId);
          return { stayOpen: true };
        },
      },
      { reapDeadlineMs: 5_000, killTimeoutMs: 5_000 },
    );
    addAll(mockDaemon);
    const pass = adapter.reapAppStackTasks();
    await until(() => held.length === APP_STACK_TASK_REAP_CONCURRENCY);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held).toHaveLength(APP_STACK_TASK_REAP_CONCURRENCY);
    expect(APP_STACK_TASK_REAP_CONCURRENCY).toBeLessThan(KEYS.length);
    // One ends: the next component starts.
    mockDaemon.endExec(held[0]!, 0);
    await until(() => held.length === APP_STACK_TASK_REAP_CONCURRENCY + 1);
    for (const execId of held.slice(1)) mockDaemon.endExec(execId, 0);
    await until(() => held.length === KEYS.length);
    for (const execId of held) mockDaemon.endExec(execId, 0);
    await expect(pass).resolves.toBeUndefined();
  });

  it("ends at its deadline: a component that never answers does not hold the start, and its tasks wait for its clean-up", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stuck: string[] = [];
    const { adapter, mockDaemon } = await setup(
      {
        kill: (call) => {
          // Only the start-up clean-up of this component hangs.
          if (call.container !== `${WEB}_id` || stuck.length > 0) return undefined;
          stuck.push(call.execId);
          return { stayOpen: true };
        },
      },
      { reapDeadlineMs: 200, killTimeoutMs: 5_000 },
    );
    addAll(mockDaemon);
    const began = Date.now();
    await expect(adapter.reapAppStackTasks()).resolves.toBeUndefined();
    // Well before the clean-up of that component would give up by itself.
    expect(Date.now() - began).toBeLessThan(1_500);
    expect(stuck).toHaveLength(1);
    expect(new Set(mockDaemon.execCalls.map((c) => c.container))).toEqual(new Set(KEYS.map((key) => `${appStackContainerName(STACK, key)}_id`)));
    // One line for the pass, with a count only: no name and no id.
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(Object.keys(logged).sort()).toEqual(["component", "count", "event", "timestamp"]);
    expect([logged.component, logged.event, logged.count]).toEqual(["hp-docker-executor", "app_task_reap_unfinished", 1]);

    // While that clean-up still goes, no task of its application starts (it would be killed by it); then one does.
    const execs = mockDaemon.execBodies.length;
    const err = await refusal(adapter.runAppStackTask(request(1)));
    expect([err.reason, err.code]).toEqual(["STACK_BUSY", "RESOURCE_LOCKED"]);
    expect(mockDaemon.execBodies).toHaveLength(execs);
    mockDaemon.endExec(stuck[0]!, 0);
    await until(() => paths(mockDaemon).includes(`/exec/${stuck[0]!}/json`));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await adapter.runAppStackTask(request(1))).outcome).toBe("succeeded");
  });

  it("says the engine is unavailable when the components cannot be listed", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "hp-app-task-"));
    cleanup.push(() => rm(tmp, { recursive: true, force: true }));
    const adapter = new DockerEngineSocketAdapter({
      dockerSocketPath: path.join(tmp, "no.sock"),
      secretsRootDir: path.join(tmp, "secrets"),
      ingressRootDir: path.join(tmp, "ingress"),
    });
    expect((await refusal(adapter.reapAppStackTasks())).code).toBe("DOCKER_ENGINE_UNAVAILABLE");
  });
});

// ---- the signed IPC ----

const SECRET = "0123456789abcdef0123456789abcdef-app-task-ipc";
const SIGNING_KEY: IpcSigningKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: SECRET };
const VERIFICATION_KEY: IpcVerificationKey = { keyId: "hmac-v1", algorithm: "hmac-sha256", secret: SECRET };
const socketPathFor = () => `/tmp/hp-exec-tsk-${randomBytes(5).toString("hex")}.sock`;

const DONE: AppStackTaskRunIpcResult = {
  runId: RUN(1),
  outcome: "succeeded",
  problem: null,
  exitCode: 0,
  startedAt: "2026-11-23T03:00:00.000Z",
  endedAt: "2026-11-23T03:00:02.000Z",
  output: "done",
  outputTruncated: false,
};

function taskStub() {
  const fns = {
    runAppStackTask: vi.fn(async (_req: unknown): Promise<unknown> => structuredClone(DONE)),
    getAppStackTaskRun: vi.fn(async (_req: unknown): Promise<unknown> => ({ state: "finished", result: structuredClone(DONE) })),
  };
  const executor: IngressCapableDockerExecutor = Object.assign(
    Object.create(new Phase1DisabledDockerExecutor()) as Phase1DisabledDockerExecutor,
    fns,
  );
  return { executor, fns };
}

async function serve(executor: IngressCapableDockerExecutor) {
  const socketPath = socketPathFor();
  const server = new DockerExecutorIpcServer({ executor, keyring: { "hmac-v1": VERIFICATION_KEY }, socketPath });
  await server.start();
  cleanup.push(() => server.stop());
  const client = new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, socketPath });
  return { client, socketPath };
}

async function failure(work: Promise<unknown>): Promise<ExecutorIpcClientError> {
  try {
    await work;
  } catch (err) {
    expect(err).toBeInstanceOf(ExecutorIpcClientError);
    return err as ExecutorIpcClientError;
  }
  throw new Error("expected the call to fail");
}

describe("application task IPC routes", () => {
  const read = { stackId: STACK, organizationId: ORG, runId: RUN(1) };

  it("the two calls are an optional port of their own", () => {
    expect([...APP_STACK_TASK_EXECUTOR_METHODS]).toEqual(["runAppStackTask", "getAppStackTaskRun"]);
    const { executor } = taskStub();
    expect(isStackTaskExecutor(executor)).toBe(true);
    expect(isStackExecutor(executor)).toBe(false);
    expect(isStackTaskExecutor(new Phase1DisabledDockerExecutor())).toBe(false);
    expect(isStackTaskExecutor({ runAppStackTask: () => undefined })).toBe(false);
    for (const value of [null, undefined, "runAppStackTask", 1]) expect(isStackTaskExecutor(value)).toBe(false);
    expect(isStackTaskExecutor(new InMemoryDockerSimulatorAdapter())).toBe(true);
    expect(isStackTaskExecutor(new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, socketPath: socketPathFor() }))).toBe(true);
  });

  it("each client method reaches its executor method with the parsed request and returns its result", async () => {
    const { executor, fns } = taskStub();
    const { client } = await serve(executor);
    await expect(client.runAppStackTask(request(1))).resolves.toEqual(DONE);
    expect(fns.runAppStackTask.mock.calls).toEqual([[request(1)]]);
    await expect(client.getAppStackTaskRun(read)).resolves.toEqual({ state: "finished", result: DONE });
    expect(fns.getAppStackTaskRun.mock.calls).toEqual([[read]]);
    fns.getAppStackTaskRun.mockResolvedValueOnce({ state: "running" });
    await expect(client.getAppStackTaskRun(read)).resolves.toEqual({ state: "running" });
    fns.getAppStackTaskRun.mockResolvedValueOnce({ state: "unknown" });
    await expect(client.getAppStackTaskRun(read)).resolves.toEqual({ state: "unknown" });
  });

  it("an executor without the task calls answers 422 NOT_SUPPORTED, also when it has the application calls", async () => {
    const stacksOnly: IngressCapableDockerExecutor = Object.assign(
      Object.create(new Phase1DisabledDockerExecutor()) as Phase1DisabledDockerExecutor,
      Object.fromEntries(["getAppStackStatus", "getAppStackComponentLogs"].map((name) => [name, vi.fn()])),
    );
    for (const executor of [new Phase1DisabledDockerExecutor(), stacksOnly]) {
      const { client } = await serve(executor);
      for (const call of [client.runAppStackTask(request(1)), client.getAppStackTaskRun(read)]) {
        const err = await failure(call);
        expect([err.statusCode, err.code, err.ambiguousOutcome]).toEqual([422, "NOT_SUPPORTED", false]);
        expect(err.message).toBe("Application tasks are not supported by the active executor backend");
      }
    }
  });

  it("refuses a request that is not valid before the executor is called, and repeats nothing of it", async () => {
    const { executor, fns } = taskStub();
    const { client } = await serve(executor);
    const bodies: unknown[] = [
      request(1, { argv: ["/bin/sh", "-c", `echo ${CANARY}`] }),
      { ...request(1), user: CANARY },
      request(1, { timeoutSeconds: 3_600 }),
      request(1, { runId: CANARY }),
    ];
    for (const body of bodies) {
      const err = await failure(client.runAppStackTask(body as AppStackTaskRunIpcRequest));
      expect([err.statusCode, err.code]).toEqual([400, "VALIDATION_ERROR"]);
      expect(err.message).toMatch(/^Invalid application task run payload/);
      expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain(CANARY);
    }
    for (const bad of [{ ...read, runId: "nope" }, { ...read, stackId: "BAD/id" }, { ...read, organizationId: "" }]) {
      const err = await failure(client.getAppStackTaskRun(bad));
      expect([err.statusCode, err.code]).toEqual([400, "VALIDATION_ERROR"]);
    }
    expect(fns.runAppStackTask).not.toHaveBeenCalled();
    expect(fns.getAppStackTaskRun).not.toHaveBeenCalled();
  });

  it("forwards the reason of a refusal", async () => {
    const { executor, fns } = taskStub();
    const { client } = await serve(executor);
    fns.runAppStackTask.mockRejectedValueOnce(new AppStackExecutorError("STACK_BUSY", "A task of this application is already running"));
    const busy = await failure(client.runAppStackTask(request(1)));
    expect([busy.statusCode, busy.code, busy.reason, busy.ambiguousOutcome]).toEqual([409, "RESOURCE_LOCKED", "STACK_BUSY", false]);
    fns.runAppStackTask.mockRejectedValueOnce(new AppStackExecutorError("STACK_COMPONENT_NOT_READY", "The component of this task is not running"));
    expect((await failure(client.runAppStackTask(request(1)))).reason).toBe("STACK_COMPONENT_NOT_READY");
    fns.runAppStackTask.mockRejectedValueOnce(new AppStackExecutorError("STACK_NAMESPACE_CONFLICT", "An object on this server uses the name"));
    const conflict = await failure(client.runAppStackTask(request(1)));
    expect([conflict.statusCode, conflict.code, conflict.reason]).toEqual([403, "HOST_POLICY_DENIED", "STACK_NAMESPACE_CONFLICT"]);
  });

  it("waits for a run its own time limit plus the margin, and reads with a GET", async () => {
    expect({ APP_STACK_TASK_RUN_MARGIN_MS, APP_STACK_TASK_READ_TIMEOUT_MS }).toEqual({
      APP_STACK_TASK_RUN_MARGIN_MS: 120_000,
      APP_STACK_TASK_READ_TIMEOUT_MS: 15_000,
    });
    const client = new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, socketPath: socketPathFor() });
    const seen: Array<[string | undefined, string | null | undefined, number | undefined]> = [];
    vi.spyOn(http, "request").mockImplementation(((opts: http.RequestOptions) => {
      seen.push([opts.method, opts.path, opts.timeout]);
      throw new Error("stop");
    }) as never);
    await client.runAppStackTask(request(1, { timeoutSeconds: 5 })).catch(() => undefined);
    await client.runAppStackTask(request(1, { timeoutSeconds: 600 })).catch(() => undefined);
    await client.getAppStackTaskRun(read).catch(() => undefined);
    expect(seen).toEqual([
      ["POST", "/v1/app-stacks/tasks/run", 125_000],
      ["POST", "/v1/app-stacks/tasks/run", 720_000],
      ["GET", `/v1/app-stacks/${STACK}/task-runs/${RUN(1)}?organizationId=${ORG}`, 15_000],
    ]);
  });

  it("a run whose answer does not come is a lost answer; a read that gets none is a plain unavailable", async () => {
    const socketPath = socketPathFor();
    const silent = http.createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(socketPath, () => resolve()));
    cleanup.push(async () => {
      silent.closeAllConnections();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
      await rm(socketPath, { force: true });
    });
    const client = new SignedDockerExecutorIpcClient({ signingKey: SIGNING_KEY, socketPath, timeoutMs: 150 });
    const run = await failure(client.runAppStackTask(request(1)));
    expect([run.code, run.statusCode, run.ambiguousOutcome]).toEqual(["OPERATION_AMBIGUOUS", 502, true]);
    const seen = await failure(client.getAppStackTaskRun(read));
    expect([seen.code, seen.statusCode, seen.ambiguousOutcome]).toEqual(["DOCKER_ENGINE_UNAVAILABLE", 503, false]);
  });

  it("drives the socket adapter through the signed client against the mock Engine", async () => {
    const { adapter, mockDaemon } = await setup({ command: () => ({ frames: [[1, "through the socket\n"]], exitCode: 2 }) });
    const { client } = await serve(adapter);
    const result = await client.runAppStackTask(request(1));
    expect(result).toMatchObject({ runId: RUN(1), outcome: "failed", exitCode: 2, output: "through the socket" });
    expect(await client.getAppStackTaskRun(read)).toEqual({ state: "finished", result });
    expect(mockDaemon.execBodies[1]).toMatchObject({ Cmd: ARGV, Env: [`HP_TASK_RUN=${RUN(1)}`], Tty: false });
  });
});

// ---- the simulator ----

describe("tasks in the simulator", () => {
  const plan = appStackTestPlan();
  const web = plan.components[0]!;
  const ids = { stackId: plan.stackId, organizationId: plan.organizationId };
  const SHARED = { parameterKey: "shared_key", version: 1, content: CANARY };
  const run = (n: number, extra: Partial<AppStackTaskRunIpcRequest> = {}) => request(n, { ...ids, ...extra });
  const readOf = (n: number) => ({ ...ids, runId: RUN(n) });

  async function deployed() {
    const sim = new InMemoryDockerSimulatorAdapter({ appImageAllowlist: TEST_ALLOWLIST });
    await sim.pullAppStackImage({ plan, image: web.image });
    await sim.prepareAppStack({ plan });
    await sim.createAppStackComponents({ plan });
    await sim.startAppStackComponent({ plan, componentKey: "web", secretFileContents: [] });
    await sim.startAppStackComponent({ plan, componentKey: "worker", secretFileContents: [SHARED] });
    return sim;
  }

  it("a run ends well by default and the call is recorded apart from the application calls", async () => {
    const sim = await deployed();
    const before = sim.appStacks.appStackCalls.length;
    const result = await sim.runAppStackTask(run(1));
    expect(result).toMatchObject({ runId: RUN(1), outcome: "succeeded", problem: null, exitCode: 0, output: "", outputTruncated: false });
    expect(AppStackTaskRunIpcResultSchema.safeParse(result).success).toBe(true);
    expect(sim.appStackTasks.appStackTaskCalls).toEqual([
      { method: "runAppStackTask", stackId: plan.stackId, runId: RUN(1), componentKey: "web", argv: ARGV, timeoutSeconds: 5 },
    ]);
    expect(sim.appStacks.appStackCalls).toHaveLength(before);
    expect(sim.appStacks.appStackMutations.filter((m) => m.kind.startsWith("container_")).map((m) => m.kind)).not.toContain("container_restart");
    // The same run is never started twice.
    expect(await sim.runAppStackTask(run(1, { argv: ["other"] }))).toEqual(result);
    expect(await sim.getAppStackTaskRun(readOf(1))).toEqual({ state: "finished", result });
  });

  it("follows the behaviour set for the next runs, with the production masking and bounds", async () => {
    const sim = await deployed();
    sim.appStackTasks.setNextAppStackTaskRun({ exitCode: 2, lines: ["bad"] });
    sim.appStackTasks.setNextAppStackTaskRun({ timedOut: true, lines: ["slow"] });
    sim.appStackTasks.setNextAppStackTaskRun({ noShell: true, lines: ["never"] });
    sim.appStackTasks.setNextAppStackTaskRun({ exitCode: null });
    sim.appStackTasks.setNextAppStackTaskRun({ lines: [`key ${CANARY}`, ...Array.from({ length: 250 }, (_, i) => `l${String(i)}`)] });
    const results = [];
    for (let n = 1; n <= 5; n += 1) results.push(await sim.runAppStackTask(run(n, { componentKey: "worker" })));
    expect(results.map((r) => [r.outcome, r.problem, r.exitCode, r.outputTruncated])).toEqual([
      ["failed", null, 2, false],
      ["timed_out", null, null, false],
      ["not_started", "no_shell", null, false],
      ["failed", null, null, false],
      ["succeeded", null, 0, true],
    ]);
    expect(results.map((r) => r.output).slice(0, 4)).toEqual(["bad", "slow", "", ""]);
    expect(results[4]!.output.split("\n")).toHaveLength(APP_STACK_TASK_LIMITS.outputLines);
    for (const result of results) expect(AppStackTaskRunIpcResultSchema.safeParse(result).success).toBe(true);

    sim.appStackTasks.setNextAppStackTaskRun({ lines: [`key ${CANARY}`] });
    expect((await sim.runAppStackTask(run(6, { componentKey: "worker" }))).output).toBe("key [REDACTED]");
  });

  it("refuses a component that is not running, an unknown one and another customer's application", async () => {
    const sim = await deployed();
    sim.appStacks.crashAppStackComponent(plan.stackId, "worker");
    expect((await refusal(sim.runAppStackTask(run(1, { componentKey: "worker" })))).reason).toBe("STACK_COMPONENT_NOT_READY");
    expect((await refusal(sim.runAppStackTask(run(2, { componentKey: "nope" })))).reason).toBe("STACK_COMPONENT_NOT_READY");
    expect((await refusal(sim.runAppStackTask(run(3, { stackId: OTHER_STACK })))).reason).toBe("STACK_COMPONENT_NOT_READY");
    expect((await refusal(sim.runAppStackTask(run(4, { organizationId: "org_other" })))).reason).toBe("STACK_NAMESPACE_CONFLICT");
    expect((await refusal(sim.runAppStackTask(run(5, { argv: ["sh", "-c", "id"] })))).code).toBe("VALIDATION_ERROR");
    for (let n = 1; n <= 5; n += 1) expect(await sim.getAppStackTaskRun(readOf(n))).toEqual({ state: "unknown" });
    sim.setEngineReachable(false);
    expect((await refusal(sim.runAppStackTask(run(6)))).code).toBe("DOCKER_ENGINE_UNAVAILABLE");
  });

  it("simulates an unavailable engine and the three ways an answer is lost", async () => {
    const sim = await deployed();
    const tasks = sim.appStackTasks;
    tasks.failNextAppStackTaskStep("run", "engine_unavailable");
    expect((await refusal(sim.runAppStackTask(run(1)))).code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    expect(await sim.getAppStackTaskRun(readOf(1))).toEqual({ state: "unknown" });

    tasks.failNextAppStackTaskStep("run", "ambiguous_before");
    const before = (await refusal(sim.runAppStackTask(run(2)))) as ExecutorIpcClientError;
    expect([before.code, before.ambiguousOutcome]).toEqual(["OPERATION_AMBIGUOUS", true]);
    expect(await sim.getAppStackTaskRun(readOf(2))).toEqual({ state: "unknown" });

    tasks.failNextAppStackTaskStep("run", "ambiguous_after");
    tasks.setNextAppStackTaskRun({ exitCode: 4, lines: ["lost"] });
    expect(((await refusal(sim.runAppStackTask(run(3)))) as ExecutorIpcClientError).ambiguousOutcome).toBe(true);
    expect(await sim.getAppStackTaskRun(readOf(3))).toMatchObject({ state: "finished", result: { outcome: "failed", exitCode: 4, output: "lost" } });

    tasks.failNextAppStackTaskStep("run", "ambiguous_running");
    expect(((await refusal(sim.runAppStackTask(run(4)))) as ExecutorIpcClientError).ambiguousOutcome).toBe(true);
    expect(await sim.getAppStackTaskRun(readOf(4))).toEqual({ state: "running" });
    expect((await refusal(sim.runAppStackTask(run(5)))).reason).toBe("STACK_BUSY");
    expect((await refusal(sim.runAppStackTask(run(4)))).reason).toBe("STACK_BUSY");
    tasks.settleAppStackTaskRun(RUN(4));
    expect(await sim.getAppStackTaskRun(readOf(4))).toMatchObject({ state: "finished", result: { outcome: "succeeded" } });
    expect((await sim.runAppStackTask(run(5))).outcome).toBe("succeeded");

    tasks.failNextAppStackTaskStep("read", "engine_unavailable");
    expect((await refusal(sim.getAppStackTaskRun(readOf(5)))).code).toBe("DOCKER_ENGINE_UNAVAILABLE");
    // As after a restart of the executor: no run is known any more.
    tasks.forgetAppStackTaskRuns();
    expect(await sim.getAppStackTaskRun(readOf(5))).toEqual({ state: "unknown" });
  });
});
