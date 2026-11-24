import { describe, expect, it } from "vitest";
import {
  APP_AUDIT_ACTIONS,
  APP_ID_PREFIXES,
  APP_STACK_BUSY_STATUSES,
  APP_STACK_ID_PATTERN,
  APP_STACK_OPERATION_KINDS,
  APP_STACK_TASK_EXECUTOR_OUTCOMES,
  APP_STACK_TASK_KIND,
  APP_STACK_TASK_LIMITS,
  APP_STACK_TASK_NO_SCHEDULE,
  APP_STACK_TASK_RUN_FINAL_STATUSES,
  APP_STACK_TASK_RUN_PROBLEMS,
  APP_STACK_TASK_RUN_STATUSES,
  APP_STACK_TASK_RUNNABLE_STATUSES,
  APP_STACK_TASK_SKIP_REASONS,
  APP_STACK_TASK_STEPS,
  AppStackTaskDtoSchema,
  AppStackTaskOperationPayloadSchema,
  AppStackTaskOutputSchema,
  AppStackTaskReadIpcRequestSchema,
  AppStackTaskReadIpcResultSchema,
  AppStackTaskRunAcceptedEnvelopeSchema,
  AppStackTaskRunDtoSchema,
  AppStackTaskRunIdSchema,
  AppStackTaskRunIpcRequestSchema,
  AppStackTaskRunIpcResultSchema,
  AppStackTaskRunSummaryDtoSchema,
  AppStackTaskRunsDtoSchema,
  AppStackTaskScheduleSchema,
  AppStackTasksDtoSchema,
  OPERATION_KINDS,
  RunAppStackTaskInputSchema,
  SetAppStackTaskScheduleInputSchema,
  appStackTaskDueSlot,
  appStackTaskSlotAfter,
  appStackTaskSlotAtOrBefore,
  appStackLockKey,
  appStackTaskQueueKey,
  boundAppStackTaskOutput,
  findForbiddenPublicDtoKeys,
  findPemValues,
  findPlaintextSecretKeys,
  type AppStackTaskSchedule,
} from "../src/index.js";

const RUN = "srun_0123456789abcdef01234567";
const STACK = "stk_0123456789abcdef01234567";
const ORG = "org_3984baf6-928d-40dd-b388-bfac50b5e54f";
const at = (iso: string): Date => new Date(iso);
const iso = (date: Date | null): string | null => date?.toISOString() ?? null;
const guards = (value: unknown): string[][] => [findPlaintextSecretKeys(value), findForbiddenPublicDtoKeys(value), findPemValues(value)];
const bytes = (text: string): number => new TextEncoder().encode(text).length;

describe("the operation of a task run", () => {
  it("is an operation kind of its own: not one of the kinds that deploy or change an application", () => {
    expect(APP_STACK_TASK_KIND).toBe("stack.task");
    expect(OPERATION_KINDS).toContain(APP_STACK_TASK_KIND);
    expect(APP_STACK_OPERATION_KINDS as readonly string[]).not.toContain(APP_STACK_TASK_KIND);
  });

  it("has one step, named without a technical word", () => {
    expect(APP_STACK_TASK_STEPS).toEqual([{ key: "run", label: "Run the task" }]);
    for (const step of APP_STACK_TASK_STEPS) expect(step.label).not.toMatch(/container|image|volume|service|network|template|command|exec/i);
  });

  it("can be asked only while the application runs", () => {
    expect(APP_STACK_TASK_RUNNABLE_STATUSES).toEqual(["running", "degraded"]);
    for (const status of APP_STACK_TASK_RUNNABLE_STATUSES) expect(APP_STACK_BUSY_STATUSES as readonly string[]).not.toContain(status);
  });

  it("the payload names the application and the run, never a command; the schema strips the envelope keys", () => {
    const business = { stackId: STACK, runId: RUN };
    const payload = { operationId: "op_1", organizationId: ORG, kind: APP_STACK_TASK_KIND, resourceType: "stack", resourceId: STACK, ...business };
    expect(guards(payload)).toEqual([[], [], []]);
    expect(AppStackTaskOperationPayloadSchema.parse(payload)).toEqual(business);
    expect(Object.keys(AppStackTaskOperationPayloadSchema.shape)).toEqual(["stackId", "runId"]);
    expect(AppStackTaskOperationPayloadSchema.safeParse({ stackId: STACK, runId: "sdep_0123456789abcdef01234567" }).success).toBe(false);
    expect(AppStackTaskOperationPayloadSchema.safeParse({ stackId: STACK }).success).toBe(false);
  });

  it("audit actions for what a person does", () => {
    expect([APP_AUDIT_ACTIONS.taskRun, APP_AUDIT_ACTIONS.taskSchedule]).toEqual(["app.task.run", "app.task.schedule"]);
  });
});

describe("the id of a run", () => {
  it("is srun_ and 24 lowercase hexadecimal digits, and nothing else", () => {
    expect(APP_ID_PREFIXES.taskRun).toBe("srun");
    expect(RUN).toMatch(APP_STACK_ID_PATTERN);
    expect(AppStackTaskRunIdSchema.safeParse(RUN).success).toBe(true);
    for (const id of [
      "",
      "srun_",
      "srun_0123456789abcdef0123456",
      "srun_0123456789abcdef012345678",
      "srun_0123456789ABCDEF01234567",
      "srun_0123456789abcdef0123456g",
      "sdep_0123456789abcdef01234567",
      "term_0123456789abcdef01234567",
      " srun_0123456789abcdef01234567",
      "srun_0123456789abcdef01234567\n",
      "srun_0123456789abcdef01234567;id",
      "srun_0123456789abcdef0123$(id)",
    ]) {
      expect(AppStackTaskRunIdSchema.safeParse(id).success, JSON.stringify(id)).toBe(false);
    }
  });
});

describe("statuses of a run", () => {
  it("are the closed lists of ADR-0042", () => {
    expect(APP_STACK_TASK_RUN_STATUSES).toEqual(["queued", "running", "succeeded", "failed", "timed_out", "not_started", "unknown"]);
    expect(APP_STACK_TASK_RUN_FINAL_STATUSES).toEqual(["succeeded", "failed", "timed_out", "not_started", "unknown"]);
    expect(APP_STACK_TASK_EXECUTOR_OUTCOMES).toEqual(["succeeded", "failed", "timed_out", "not_started"]);
    expect(APP_STACK_TASK_RUN_PROBLEMS).toEqual([
      "component_not_running",
      "cannot_run_tasks",
      "task_gone",
      "unavailable",
      "refused",
      "outcome_lost",
      "busy",
    ]);
    expect(APP_STACK_TASK_SKIP_REASONS).toEqual(["busy", "not_running", "missed"]);
  });

  it("a run waits under a lock of its own, not under the application's", () => {
    expect(appStackTaskQueueKey("stk_a")).toBe("stack:stk_a:task");
    expect(appStackTaskQueueKey("stk_a")).not.toBe(appStackLockKey("stk_a"));
  });

  it("the limits of ADR-0042", () => {
    expect(APP_STACK_TASK_LIMITS).toEqual({
      outputBytes: 16_384,
      outputLines: 200,
      outputLineChars: 2_000,
      runsKept: 20,
      retryWindowMs: 1_800_000,
      clockAheadToleranceMs: 60_000,
    });
  });
});

describe("schedule of a task", () => {
  const ok: AppStackTaskSchedule[] = [
    { frequency: "never" },
    { frequency: "hourly" },
    { frequency: "daily", hourUtc: 0 },
    { frequency: "daily", hourUtc: 23 },
    { frequency: "weekly", weekday: 1, hourUtc: 0 },
    { frequency: "weekly", weekday: 7, hourUtc: 23 },
  ];

  it("accepts the four choices and gives them back unchanged", () => {
    for (const schedule of ok) expect(AppStackTaskScheduleSchema.parse(schedule), JSON.stringify(schedule)).toEqual(schedule);
    expect(SetAppStackTaskScheduleInputSchema).toBe(AppStackTaskScheduleSchema);
    expect(APP_STACK_TASK_NO_SCHEDULE).toEqual({ frequency: "never" });
  });

  it.each([
    [{}],
    [{ frequency: "minutely" }],
    [{ frequency: "monthly", hourUtc: 3 }],
    [{ frequency: "never", hourUtc: 3 }],
    [{ frequency: "hourly", hourUtc: 3 }],
    [{ frequency: "hourly", minute: 30 }],
    [{ frequency: "daily" }],
    [{ frequency: "daily", hourUtc: 24 }],
    [{ frequency: "daily", hourUtc: -1 }],
    [{ frequency: "daily", hourUtc: 3.5 }],
    [{ frequency: "daily", hourUtc: "3" }],
    [{ frequency: "daily", hourUtc: 3, weekday: 1 }],
    [{ frequency: "daily", hourUtc: 3, minute: 15 }],
    [{ frequency: "weekly", hourUtc: 3 }],
    [{ frequency: "weekly", weekday: 1 }],
    [{ frequency: "weekly", weekday: 0, hourUtc: 3 }],
    [{ frequency: "weekly", weekday: 8, hourUtc: 3 }],
    [{ frequency: "weekly", weekday: 1, hourUtc: 3, cron: "0 3 * * 1" }],
    [{ frequency: "daily", hourUtc: 3, command: ["/bin/true"] }],
    [{ cron: "0 3 * * *" }],
    ["0 3 * * *"],
    [null],
  ])("refuses %j", (input) => {
    expect(AppStackTaskScheduleSchema.safeParse(input).success).toBe(false);
  });

  it.each<[AppStackTaskSchedule, string, string | null, string | null]>([
    // schedule, now, the latest time at or before now, the first time after now
    [{ frequency: "never" }, "2026-11-23T10:20:00.000Z", null, null],
    [{ frequency: "hourly" }, "2026-11-23T10:20:00.000Z", "2026-11-23T10:00:00.000Z", "2026-11-23T11:00:00.000Z"],
    [{ frequency: "hourly" }, "2026-11-23T10:00:00.000Z", "2026-11-23T10:00:00.000Z", "2026-11-23T11:00:00.000Z"],
    [{ frequency: "hourly" }, "2026-11-23T09:59:59.999Z", "2026-11-23T09:00:00.000Z", "2026-11-23T10:00:00.000Z"],
    [{ frequency: "hourly" }, "2026-12-31T23:30:00.000Z", "2026-12-31T23:00:00.000Z", "2027-01-01T00:00:00.000Z"],
    [{ frequency: "daily", hourUtc: 3 }, "2026-11-23T10:20:00.000Z", "2026-11-23T03:00:00.000Z", "2026-11-24T03:00:00.000Z"],
    [{ frequency: "daily", hourUtc: 3 }, "2026-11-23T03:00:00.000Z", "2026-11-23T03:00:00.000Z", "2026-11-24T03:00:00.000Z"],
    [{ frequency: "daily", hourUtc: 3 }, "2026-11-23T02:59:59.999Z", "2026-11-22T03:00:00.000Z", "2026-11-23T03:00:00.000Z"],
    [{ frequency: "daily", hourUtc: 0 }, "2026-11-23T00:00:00.000Z", "2026-11-23T00:00:00.000Z", "2026-11-24T00:00:00.000Z"],
    [{ frequency: "daily", hourUtc: 23 }, "2026-03-01T10:00:00.000Z", "2026-02-28T23:00:00.000Z", "2026-03-01T23:00:00.000Z"],
    // 2026-11-23 is a Monday (1), 2026-11-29 a Sunday (7).
    [{ frequency: "weekly", weekday: 1, hourUtc: 3 }, "2026-11-23T10:20:00.000Z", "2026-11-23T03:00:00.000Z", "2026-11-30T03:00:00.000Z"],
    [{ frequency: "weekly", weekday: 1, hourUtc: 3 }, "2026-11-23T02:00:00.000Z", "2026-11-16T03:00:00.000Z", "2026-11-23T03:00:00.000Z"],
    [{ frequency: "weekly", weekday: 1, hourUtc: 3 }, "2026-11-29T23:59:59.999Z", "2026-11-23T03:00:00.000Z", "2026-11-30T03:00:00.000Z"],
    [{ frequency: "weekly", weekday: 7, hourUtc: 22 }, "2026-11-23T10:20:00.000Z", "2026-11-22T22:00:00.000Z", "2026-11-29T22:00:00.000Z"],
    [{ frequency: "weekly", weekday: 7, hourUtc: 22 }, "2026-11-29T22:00:00.000Z", "2026-11-29T22:00:00.000Z", "2026-12-06T22:00:00.000Z"],
    [{ frequency: "weekly", weekday: 3, hourUtc: 0 }, "2026-11-23T10:20:00.000Z", "2026-11-18T00:00:00.000Z", "2026-11-25T00:00:00.000Z"],
    [{ frequency: "weekly", weekday: 4, hourUtc: 12 }, "2026-12-31T12:00:00.000Z", "2026-12-31T12:00:00.000Z", "2027-01-07T12:00:00.000Z"],
  ])("%j at %s: the time before is %s, the next is %s", (schedule, now, before, after) => {
    expect(iso(appStackTaskSlotAtOrBefore(schedule, at(now)))).toBe(before);
    expect(iso(appStackTaskSlotAfter(schedule, at(now)))).toBe(after);
  });

  it("every time of a weekly schedule falls on its day and hour; the next one is always later than now", () => {
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      for (const hourUtc of [0, 11, 23]) {
        const schedule: AppStackTaskSchedule = { frequency: "weekly", weekday, hourUtc };
        for (let step = 0; step < 24 * 15; step += 5) {
          const now = new Date(Date.UTC(2026, 10, 20, 0, 17) + step * 3_600_000);
          const before = appStackTaskSlotAtOrBefore(schedule, now)!;
          const next = appStackTaskSlotAfter(schedule, now)!;
          for (const slot of [before, next]) {
            expect(((slot.getUTCDay() + 6) % 7) + 1).toBe(weekday);
            expect([slot.getUTCHours(), slot.getUTCMinutes(), slot.getUTCSeconds(), slot.getUTCMilliseconds()]).toEqual([hourUtc, 0, 0, 0]);
          }
          expect(before.getTime()).toBeLessThanOrEqual(now.getTime());
          expect(now.getTime() - before.getTime()).toBeLessThan(7 * 86_400_000);
          expect(next.getTime()).toBeGreaterThan(now.getTime());
          expect(next.getTime() - before.getTime()).toBe(7 * 86_400_000);
        }
      }
    }
  });
});

describe("the time a schedule owes", () => {
  const hourly: AppStackTaskSchedule = { frequency: "hourly" };
  const daily: AppStackTaskSchedule = { frequency: "daily", hourUtc: 3 };
  const due = (schedule: AppStackTaskSchedule, now: string, changedAt: string, servedSlotAt: string | null) => {
    const found = appStackTaskDueSlot({ schedule, now: at(now), changedAt: at(changedAt), servedSlotAt: servedSlotAt === null ? null : at(servedSlotAt) });
    return found === null ? null : [found.slot.toISOString(), found.queueable];
  };

  it("never owes anything when the schedule is 'never'", () => {
    expect(due({ frequency: "never" }, "2026-11-23T10:00:00.000Z", "2026-01-01T00:00:00.000Z", null)).toBeNull();
  });

  it("owes the latest time once, and never one at or before the moment the schedule was set", () => {
    // set at 10:20: 10:00 is not owed; 11:00 is.
    expect(due(hourly, "2026-11-23T10:21:00.000Z", "2026-11-23T10:20:00.000Z", null)).toBeNull();
    expect(due(hourly, "2026-11-23T10:59:59.999Z", "2026-11-23T10:20:00.000Z", null)).toBeNull();
    expect(due(hourly, "2026-11-23T11:00:00.000Z", "2026-11-23T10:20:00.000Z", null)).toEqual(["2026-11-23T11:00:00.000Z", true]);
    // set exactly on the hour: that hour is not owed.
    expect(due(hourly, "2026-11-23T10:00:30.000Z", "2026-11-23T10:00:00.000Z", null)).toBeNull();
    // already dealt with.
    expect(due(hourly, "2026-11-23T11:05:00.000Z", "2026-11-23T10:20:00.000Z", "2026-11-23T11:00:00.000Z")).toBeNull();
    expect(due(hourly, "2026-11-23T12:00:10.000Z", "2026-11-23T10:20:00.000Z", "2026-11-23T11:00:00.000Z")).toEqual(["2026-11-23T12:00:00.000Z", true]);
    // a schedule changed after a time was served starts again from the change.
    expect(due(daily, "2026-11-24T03:00:05.000Z", "2026-11-23T09:00:00.000Z", "2026-11-23T03:00:00.000Z")).toEqual(["2026-11-24T03:00:00.000Z", true]);
  });

  it("can be queued for thirty minutes, then it is only written as skipped; an older time is never caught up", () => {
    expect(due(daily, "2026-11-23T03:29:59.999Z", "2026-11-01T00:00:00.000Z", "2026-11-22T03:00:00.000Z")).toEqual(["2026-11-23T03:00:00.000Z", true]);
    expect(due(daily, "2026-11-23T03:30:00.000Z", "2026-11-01T00:00:00.000Z", "2026-11-22T03:00:00.000Z")).toEqual(["2026-11-23T03:00:00.000Z", false]);
    // the panel was off for three days: only the latest time is owed, and it is too late to queue it.
    expect(due(daily, "2026-11-23T09:00:00.000Z", "2026-11-01T00:00:00.000Z", "2026-11-19T03:00:00.000Z")).toEqual(["2026-11-23T03:00:00.000Z", false]);
    // hourly, off from 09:50 to 12:20: 12:00 is queued, 10:00 and 11:00 are not.
    expect(due(hourly, "2026-11-23T12:20:00.000Z", "2026-11-01T00:00:00.000Z", "2026-11-23T09:00:00.000Z")).toEqual(["2026-11-23T12:00:00.000Z", true]);
  });
});

describe("what a run printed", () => {
  it("keeps short output as it is", () => {
    expect(boundAppStackTaskOutput([])).toEqual({ output: "", truncated: false });
    expect(boundAppStackTaskOutput(["one", "", "two\tcolumns"])).toEqual({ output: "one\n\ntwo\tcolumns", truncated: false });
  });

  it("removes control characters, escape sequences' control byte, line breaks inside a line and unpaired surrogates", () => {
    const bound = boundAppStackTaskOutput(["a\u0000b\u001b[31mred\u0007", "x\ry\nz", "del\u007f c1\u0085 end", "lone \ud83d here", "pair 😀 stays"]);
    expect(bound).toEqual({ output: "ab[31mred\nxyz\ndel c1 end\nlone  here\npair 😀 stays", truncated: false });
    expect(AppStackTaskOutputSchema.safeParse(bound.output).success).toBe(true);
  });

  it("keeps the last 200 lines", () => {
    const lines = Array.from({ length: 450 }, (_, i) => `line ${String(i + 1)}`);
    const bound = boundAppStackTaskOutput(lines);
    expect(bound.truncated).toBe(true);
    expect(bound.output.split("\n")).toEqual(lines.slice(-200));
    expect(boundAppStackTaskOutput(lines.slice(0, 200))).toEqual({ output: lines.slice(0, 200).join("\n"), truncated: false });
  });

  it("keeps the last lines that fit 16 KiB of UTF-8, counting bytes and not characters", () => {
    const line = "è".repeat(500); // 1 000 bytes
    const bound = boundAppStackTaskOutput(Array.from({ length: 40 }, () => line));
    expect(bound.truncated).toBe(true);
    expect(bound.output.split("\n")).toHaveLength(16); // 16 lines of 1 000 bytes and 15 breaks; a 17th does not fit
    expect(bytes(bound.output)).toBe(16_015);
    expect(AppStackTaskOutputSchema.safeParse(bound.output).success).toBe(true);
    const exact = boundAppStackTaskOutput(["a".repeat(384), ...Array.from({ length: 8 }, () => "b".repeat(1_999))]);
    expect([bytes(exact.output), exact.truncated]).toEqual([16_384, false]);
    const over = boundAppStackTaskOutput(["a".repeat(385), ...Array.from({ length: 8 }, () => "b".repeat(1_999))]);
    expect([over.output.split("\n").length, over.truncated]).toEqual([8, true]);
  });

  it("cuts a line at 2 000 characters without splitting a surrogate pair", () => {
    const bound = boundAppStackTaskOutput(["first", `${"x".repeat(1_999)}😀tail`]);
    expect(bound.truncated).toBe(true);
    expect(bound.output).toBe(`first\n${"x".repeat(1_999)}`);
    expect(AppStackTaskOutputSchema.safeParse(bound.output).success).toBe(true);
  });

  it("whatever comes in, the result passes the schema", () => {
    const pieces = ["", "plain", "è€😀", "\u0000\u001b\u007f\u0085", "\ud800", "\udc00", "x".repeat(2_500), "\t", "😀".repeat(1_200), "a\nb\r\nc"];
    for (let seed = 1; seed <= 40; seed += 1) {
      const lines = Array.from({ length: (seed * 37) % 260 }, (_, i) => pieces[(i * seed + seed) % pieces.length]! + pieces[(i + seed * 3) % pieces.length]!);
      const bound = boundAppStackTaskOutput(lines);
      expect(AppStackTaskOutputSchema.safeParse(bound.output).success, `seed ${String(seed)}`).toBe(true);
    }
  });

  it("the schema refuses what the bound would never give", () => {
    expect(AppStackTaskOutputSchema.safeParse("").success).toBe(true);
    expect(AppStackTaskOutputSchema.safeParse("a\tb\nc").success).toBe(true);
    for (const text of [
      "a\u0000b",
      "a\rb",
      "\u001b[2J",
      "a\u007fb",
      "a\u0085b",
      "\ud83d",
      "x".repeat(16_385),
      "è".repeat(8_193), // 16 386 bytes in 8 193 characters
      Array.from({ length: 201 }, () => "l").join("\n"),
    ]) {
      expect(AppStackTaskOutputSchema.safeParse(text).success, JSON.stringify(text.slice(0, 12))).toBe(false);
    }
    expect(AppStackTaskOutputSchema.safeParse("è".repeat(8_192)).success).toBe(true);
    expect(AppStackTaskOutputSchema.safeParse(Array.from({ length: 200 }, () => "l").join("\n")).success).toBe(true);
  });
});

describe("the executor call that runs a task", () => {
  const request = { stackId: STACK, organizationId: ORG, componentKey: "app", runId: RUN, argv: ["/app/bin/tidy", "--all"], timeoutSeconds: 60 };

  it("accepts a component, a run id, arguments and a time limit", () => {
    expect(AppStackTaskRunIpcRequestSchema.parse(request)).toEqual(request);
    expect(AppStackTaskRunIpcRequestSchema.safeParse({ ...request, timeoutSeconds: 5 }).success).toBe(true);
    expect(AppStackTaskRunIpcRequestSchema.safeParse({ ...request, timeoutSeconds: 600 }).success).toBe(true);
    // a dollar is plain text here: nothing is ever replaced in a task's arguments.
    expect(AppStackTaskRunIpcRequestSchema.safeParse({ ...request, argv: ["/app/bin/tidy", "--price=$5", "${NOT_A_PLACEHOLDER}"] }).success).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a shell", { argv: ["/bin/sh", "-c", "id"] }],
    ["a shell by its bare name", { argv: ["bash", "-c", "id"] }],
    ["a shell through env", { argv: ["env", "sh", "-c", "id"] }],
    ["no argument", { argv: [] }],
    ["an empty argument", { argv: ["/app/bin/tidy", ""] }],
    ["a control character", { argv: ["/app/bin/tidy", "a\nb"] }],
    ["the engine socket", { argv: ["/app/bin/tidy", "/var/run/docker.sock"] }],
    ["sixty-five arguments", { argv: Array.from({ length: 65 }, () => "a") }],
    ["an argument of 1025 characters", { argv: ["/app/bin/tidy", "a".repeat(1_025)] }],
    ["an argument that is not text", { argv: ["/app/bin/tidy", 3] }],
    ["arguments as one string", { argv: "/app/bin/tidy --all" }],
    ["four seconds", { timeoutSeconds: 4 }],
    ["601 seconds", { timeoutSeconds: 601 }],
    ["half seconds", { timeoutSeconds: 60.5 }],
    ["no time limit", { timeoutSeconds: undefined }],
    ["a deployment id as run id", { runId: "sdep_0123456789abcdef01234567" }],
    ["a run id with a shell character", { runId: "srun_0123456789abcdef0123$(id)" }],
    ["a component key that is a path", { componentKey: "../app" }],
    ["a container name", { container: "hp_mariadb" }],
    ["a user", { user: "0" }],
    ["a working directory", { workingDir: "/" }],
    ["a terminal", { tty: true }],
    ["environment", { env: ["A=b"] }],
    ["another application's id form", { stackId: "Stk-1" }],
  ])("refuses %s", (_name, change) => {
    expect(AppStackTaskRunIpcRequestSchema.safeParse({ ...request, ...change }).success).toBe(false);
  });

  const started = "2026-11-23T10:00:00.000Z";
  const ended = "2026-11-23T10:00:02.000Z";
  const result = { runId: RUN, outcome: "succeeded", problem: null, exitCode: 0, startedAt: started, endedAt: ended, output: "done", outputTruncated: false };

  it("accepts the four ways a run ends", () => {
    for (const good of [
      result,
      { ...result, outcome: "failed", exitCode: 3 },
      { ...result, outcome: "failed", exitCode: 255 },
      { ...result, outcome: "failed", exitCode: null }, // the engine did not tell
      { ...result, outcome: "timed_out", exitCode: null, outputTruncated: true },
      { ...result, outcome: "not_started", problem: "no_shell", exitCode: null, startedAt: null, output: "" },
    ]) {
      expect(AppStackTaskRunIpcResultSchema.parse(good), JSON.stringify(good)).toEqual(good);
    }
  });

  it.each<[string, Record<string, unknown>]>([
    ["success with another exit code", { exitCode: 1 }],
    ["success without an exit code", { exitCode: null }],
    ["failure with exit code 0", { outcome: "failed" }],
    ["a time limit with an exit code", { outcome: "timed_out" }],
    ["a started run without its start", { startedAt: null }],
    ["a problem on a run that started", { problem: "no_shell" }],
    ["not started without a problem", { outcome: "not_started", exitCode: null, startedAt: null, output: "" }],
    ["not started with output", { outcome: "not_started", problem: "no_shell", exitCode: null, startedAt: null }],
    ["not started with a start", { outcome: "not_started", problem: "no_shell", exitCode: null, output: "" }],
    ["not started with an exit code", { outcome: "not_started", problem: "no_shell", startedAt: null, output: "" }],
    ["an outcome only the API gives", { outcome: "unknown", exitCode: null }],
    ["a problem only the API gives", { outcome: "not_started", problem: "task_gone", exitCode: null, startedAt: null, output: "" }],
    ["exit code 256", { outcome: "failed", exitCode: 256 }],
    ["a negative exit code", { outcome: "failed", exitCode: -1 }],
    ["output with a control character", { output: "a\u001b[0m" }],
    ["output over the bound", { output: "x".repeat(16_385) }],
    ["a time that is not ISO", { endedAt: "yesterday" }],
    ["an engine id", { containerId: "0123456789ab" }],
    ["an exec id", { execId: "0123456789ab" }],
  ])("refuses %s", (_name, change) => {
    expect(AppStackTaskRunIpcResultSchema.safeParse({ ...result, ...change }).success).toBe(false);
  });

  it("the call that reads how a run ended", () => {
    const read = { stackId: STACK, organizationId: ORG, runId: RUN };
    expect(AppStackTaskReadIpcRequestSchema.parse(read)).toEqual(read);
    expect(AppStackTaskReadIpcRequestSchema.safeParse({ ...read, componentKey: "app" }).success).toBe(false);
    expect(AppStackTaskReadIpcRequestSchema.safeParse({ ...read, runId: "x" }).success).toBe(false);
    for (const good of [{ state: "unknown" }, { state: "running" }, { state: "finished", result }]) {
      expect(AppStackTaskReadIpcResultSchema.parse(good)).toEqual(good);
    }
    for (const bad of [{ state: "finished" }, { state: "running", result }, { state: "unknown", runId: RUN }, { state: "lost" }, {}]) {
      expect(AppStackTaskReadIpcResultSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("what the customer's pages receive", () => {
  const summary = {
    id: RUN,
    taskKey: "tidy",
    trigger: "manual",
    status: "succeeded",
    problem: null,
    requestedAt: "2026-11-23T10:00:00.000Z",
    startedAt: "2026-11-23T10:00:01.000Z",
    endedAt: "2026-11-23T10:00:02.000Z",
  };
  const run = { ...summary, output: "done", outputTruncated: false };
  const task = {
    key: "tidy",
    label: "Tidy up",
    description: "",
    componentKey: "app",
    schedule: { frequency: "daily", hourUtc: 3 },
    nextRunAt: "2026-11-24T03:00:00.000Z",
    skipped: { at: "2026-11-23T03:00:00.000Z", reason: "busy", pending: true },
    lastRun: summary,
  };

  it("a task, a run and the lists parse and pass the secret guards", () => {
    expect(AppStackTaskRunSummaryDtoSchema.parse(summary)).toEqual(summary);
    expect(AppStackTaskRunDtoSchema.parse(run)).toEqual(run);
    expect(AppStackTaskDtoSchema.parse(task)).toEqual(task);
    const never = { ...task, schedule: { frequency: "never" }, nextRunAt: null, skipped: null, lastRun: null };
    expect(AppStackTaskDtoSchema.parse(never)).toEqual(never);
    expect(AppStackTasksDtoSchema.parse({ tasks: [task, never] })).toEqual({ tasks: [task, never] });
    expect(AppStackTaskRunsDtoSchema.parse({ runs: [run] })).toEqual({ runs: [run] });
    expect(guards({ tasks: [task], runs: [run] })).toEqual([[], [], []]);
  });

  it("carry no command, no arguments, no exit code and no time limit", () => {
    expect(Object.keys(AppStackTaskDtoSchema.shape)).toEqual(["key", "label", "description", "componentKey", "schedule", "nextRunAt", "skipped", "lastRun"]);
    expect(Object.keys(AppStackTaskRunSummaryDtoSchema.shape)).toEqual(["id", "taskKey", "trigger", "status", "problem", "requestedAt", "startedAt", "endedAt"]);
    expect(Object.keys(AppStackTaskRunDtoSchema.shape)).toEqual([...Object.keys(AppStackTaskRunSummaryDtoSchema.shape), "output", "outputTruncated"]);
    const parsed = AppStackTaskDtoSchema.parse({ ...task, command: ["/app/bin/tidy"], timeoutSeconds: 60, lastRun: { ...summary, exitCode: 0 } });
    expect(parsed).toEqual(task);
  });

  it("the lists are bounded: eight tasks, twenty runs", () => {
    expect(AppStackTasksDtoSchema.safeParse({ tasks: Array.from({ length: 8 }, () => task) }).success).toBe(true);
    expect(AppStackTasksDtoSchema.safeParse({ tasks: Array.from({ length: 9 }, () => task) }).success).toBe(false);
    expect(AppStackTaskRunsDtoSchema.safeParse({ runs: Array.from({ length: 20 }, () => run) }).success).toBe(true);
    expect(AppStackTaskRunsDtoSchema.safeParse({ runs: Array.from({ length: 21 }, () => run) }).success).toBe(false);
  });

  it("refuse a status, a problem, a trigger or a skip reason outside the lists", () => {
    expect(AppStackTaskRunSummaryDtoSchema.safeParse({ ...summary, status: "interrupted" }).success).toBe(false);
    expect(AppStackTaskRunSummaryDtoSchema.safeParse({ ...summary, problem: "no_shell" }).success).toBe(false);
    expect(AppStackTaskRunSummaryDtoSchema.safeParse({ ...summary, trigger: "cron" }).success).toBe(false);
    expect(AppStackTaskRunSummaryDtoSchema.safeParse({ ...summary, id: "sdep_0123456789abcdef01234567" }).success).toBe(false);
    expect(AppStackTaskDtoSchema.safeParse({ ...task, skipped: { ...task.skipped, reason: "stopped" } }).success).toBe(false);
    // A skipped time always says whether it is still tried.
    expect(AppStackTaskDtoSchema.safeParse({ ...task, skipped: { at: task.skipped.at, reason: "busy" } }).success).toBe(false);
    expect(AppStackTaskDtoSchema.safeParse({ ...task, label: "" }).success).toBe(false);
    expect(AppStackTaskDtoSchema.safeParse({ ...task, schedule: { frequency: "daily", hourUtc: 24 } }).success).toBe(false);
  });

  it("the run request has an empty body: a body with a command is refused", () => {
    expect(RunAppStackTaskInputSchema.parse({})).toEqual({});
    for (const body of [{ command: ["/bin/true"] }, { argv: ["id"] }, { taskKey: "tidy" }, { timeoutSeconds: 600 }]) {
      expect(RunAppStackTaskInputSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("the answer to a run request links the runs and the operation", () => {
    const envelope = {
      data: { runId: RUN, operationId: "op_0123456789abcdef0123456789abcdef", status: "queued" },
      links: { runs: `/v1/organizations/${ORG}/app-stacks/${STACK}/tasks/tidy/runs`, operation: "/v1/operations/op_0123456789abcdef0123456789abcdef" },
    };
    expect(AppStackTaskRunAcceptedEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(guards(envelope)).toEqual([[], [], []]);
    expect(AppStackTaskRunAcceptedEnvelopeSchema.safeParse({ ...envelope, data: { ...envelope.data, operationId: null } }).success).toBe(false);
  });
});
