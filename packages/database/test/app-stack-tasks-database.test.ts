import { createHash } from "node:crypto";
import {
  APP_STACK_BUSY_STATUSES,
  APP_STACK_RESOURCE_TYPE,
  APP_STACK_STATUSES,
  APP_STACK_TASK_KIND,
  APP_STACK_TASK_LIMITS,
  APP_STACK_TASK_RUNNABLE_STATUSES,
  APP_STACK_TASK_STEPS,
  appStackLockKey,
  appStackTaskQueueKey,
  type AppStackStatus,
} from "@hosting-panel/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  and,
  appStackTaskRuns,
  appStackTaskScheduleOf,
  beginAppStackTaskRunTransactional,
  appStackTaskSchedules,
  appStacks,
  closeAppStackTaskSlot,
  createDatabaseClient,
  enqueueAppStackOperationTransactional,
  enqueueAppStackTaskRunTransactional,
  eq,
  finishAppStackTaskRun,
  getAppStackTaskRun,
  hostAllocations,
  hosts,
  listAppStackTaskRuns,
  listAppStackTaskSchedules,
  listAppStackTaskSchedulesOfLiveStacks,
  listLatestAppStackTaskRuns,
  newAppEntityId,
  noteAppStackTaskSlotRefused,
  operations,
  operationSteps,
  organizations,
  outboxEvents,
  platformInstallations,
  reopenAppStackTaskSlot,
  repairAppStackTaskSchedulesAheadOfClock,
  repairOrphanedAppStackTaskRunsTransactional,
  setAppStackTaskScheduleTransactional,
  sql,
  startAppStackTaskRun,
  users,
  type DatabaseClient,
  type EnqueueAppStackTaskRunInput,
  type EnqueueAppStackTaskRunResult,
  type HostingPanelDatabase,
} from "../src/index.js";

// Tasks of applications (0031, ADR-0042): what the two tables refuse, what a deleted application leaves, and the
// repository — a run waits under a lock of its own and takes the application's lock when it begins, a time of a
// schedule starts at most once.
const orgA = "org_tk_a";
const orgB = "org_tk_b";
const USER = "usr_tk";
const HASH = "a".repeat(64);
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");
const at = (iso: string) => new Date(iso);

/** The SQLSTATE of a refused statement (drizzle wraps the driver error: the code is on a cause). */
function stateOf(error: unknown): string | null {
  for (let current: unknown = error, depth = 0; typeof current === "object" && current !== null && depth < 5; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

describe("@hosting-panel/database — tasks of applications", () => {
  let client: DatabaseClient;
  const db = (): HostingPanelDatabase => client.db;
  let counter = 0;

  /** An application with one revision, installed (the applied revision is `srev_<id>`). */
  async function stack(id: string, org = orgA, status: AppStackStatus = "running"): Promise<void> {
    const rev = `srev_${id}`;
    await db().execute(sql`INSERT INTO app_stacks (id, organization_id, host_allocation_id, template_id, template_version_id, name, status)
      VALUES (${id}, ${org}, ${`alloc_${org}`}, 'atpl_tk', 'atv_tk1', ${id}, ${status})`);
    await db().execute(sql`INSERT INTO app_stack_revisions (id, stack_id, organization_id, revision_number, template_version_id, plan,
        plan_hash, component_count, cpu_milli, memory_bytes)
      VALUES (${rev}, ${id}, ${org}, 1, 'atv_tk1', '{}', ${HASH}, 1, 100, 1)`);
    await db().execute(sql`UPDATE app_stacks SET desired_revision_id = ${rev}, applied_revision_id = ${rev} WHERE id = ${id}`);
  }

  const status = (id: string, value: AppStackStatus) => db().update(appStacks).set({ status: value }).where(eq(appStacks.id, id));
  /** Ends every operation of the application, as a worker that has finished. */
  const settle = (id: string, value: "succeeded" | "failed" = "succeeded") =>
    db().update(operations).set({ status: value }).where(eq(operations.resourceId, id));
  const forget = (id: string) => db().update(appStacks).set({ status: "deleted", deletedAt: new Date() }).where(eq(appStacks.id, id));

  function manual(stackId: string, taskKey: string, over: Partial<EnqueueAppStackTaskRunInput> = {}): Promise<EnqueueAppStackTaskRunResult> {
    counter += 1;
    return enqueueAppStackTaskRunTransactional(db(), {
      organizationId: orgA,
      stackId,
      runId: newAppEntityId("srun"),
      taskKey,
      componentKey: "app",
      appliedRevisionId: `srev_${stackId}`,
      request: { trigger: "manual", requestedByUserId: USER, idempotencyKey: `tk-${String(counter)}`, requestHash: hex(`tk ${String(counter)}`) },
      ...over,
    });
  }

  function scheduled(stackId: string, taskKey: string, slot: Date, changedAt: Date): Promise<EnqueueAppStackTaskRunResult> {
    return enqueueAppStackTaskRunTransactional(db(), {
      organizationId: orgA,
      stackId,
      runId: newAppEntityId("srun"),
      taskKey,
      componentKey: "app",
      appliedRevisionId: `srev_${stackId}`,
      request: { trigger: "schedule", slot, changedAt },
    });
  }

  /** Queues a run and ends it: the application is free again. */
  async function finished(stackId: string, taskKey: string, now: Date): Promise<string> {
    const result = await manual(stackId, taskKey, { now });
    if (result.outcome !== "queued") throw new Error(`not queued: ${result.outcome}`);
    await finishAppStackTaskRun(db(), {
      runId: result.run.id,
      status: "succeeded",
      problem: null,
      exitCode: 0,
      startedAt: now,
      endedAt: now,
      output: `run of ${now.toISOString()}`,
      outputTruncated: false,
    });
    await settle(stackId);
    return result.run.id;
  }

  /** The SQL of each statement `work` sends outside a transaction (drizzle hands each one to the client's `query`). */
  async function statementsOf(work: () => Promise<unknown>): Promise<string[]> {
    const pg = (db() as unknown as { $client: { query: (...args: unknown[]) => Promise<unknown> } }).$client;
    const query = pg.query;
    const seen: string[] = [];
    pg.query = (...args: unknown[]) => {
      seen.push(String(args[0]));
      return query.apply(pg, args);
    };
    try {
      await work();
    } finally {
      pg.query = query;
    }
    return seen;
  }

  const scheduleOf = async (stackId: string, taskKey: string) =>
    (await db().select().from(appStackTaskSchedules).where(eq(appStackTaskSchedules.stackId, stackId))).find((row) => row.taskKey === taskKey) ?? null;
  const runsOf = (stackId: string) => db().select().from(appStackTaskRuns).where(eq(appStackTaskRuns.stackId, stackId));

  beforeAll(async () => {
    client = createDatabaseClient({ mode: "pglite" });
    await client.migrate();
    await db().insert(platformInstallations).values({ id: "pin_tk", name: "Platform" });
    await db().insert(hosts).values({
      id: "hst_tk",
      platformInstallationId: "pin_tk",
      name: "tk-host",
      hostname: "panel.tk.example",
      ipv4Address: "10.0.0.71",
      totalCpuMilli: 4000,
      totalMemoryBytes: "4000000000",
      totalStorageBytes: "100000000000",
    });
    for (const org of [orgA, orgB]) {
      await db().insert(organizations).values({ id: org, platformInstallationId: "pin_tk", name: org, slug: org.replace(/_/g, "-") });
      await db().insert(hostAllocations).values({ id: `alloc_${org}`, hostId: "hst_tk", organizationId: org, status: "active" });
    }
    await db().insert(users).values({ id: USER, email: "tk@example.test", name: "Task Tester" });
    await db().execute(sql`INSERT INTO app_templates (id, slug, name, category) VALUES ('atpl_tk', 'tk', 'Tk', 'web')`);
    await db().execute(sql`INSERT INTO app_template_versions (id, template_id, version_number, source, spec_version, compiled_schema, spec_hash)
      VALUES ('atv_tk1', 'atpl_tk', 1, 'x', 1, '{}', ${HASH})`);
  }, 120_000);

  afterAll(async () => {
    await client.close();
  });

  describe("what the tables refuse", () => {
    const STACK = "stk_tk_rules";
    const insert = (table: string, row: Record<string, string>) =>
      sql.raw(`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).join(", ")})`);
    const SCHEDULE: Record<string, string> = {
      stack_id: `'${STACK}'`,
      organization_id: `'${orgA}'`,
      task_key: "'probe'",
      frequency: "'daily'",
      hour_utc: "3",
    };
    const RUN: Record<string, string> = {
      id: "'srun_0123456789abcdef01234567'",
      stack_id: `'${STACK}'`,
      organization_id: `'${orgA}'`,
      task_key: "'probe'",
      component_key: "'app'",
      run_trigger: "'manual'",
      operation_id: "'op_tk_probe'",
    };
    const ENDED = { status: "'succeeded'", ended_at: "NOW()" };

    /** Tries one row on a clean table: the SQLSTATE of the refusal, or null when the row is taken. */
    async function tried(table: "app_stack_task_schedules" | "app_stack_task_runs", row: Record<string, string>): Promise<string | null> {
      try {
        await db().execute(insert(table, row));
        return null;
      } catch (error) {
        return stateOf(error) ?? "unknown";
      } finally {
        await db().execute(sql.raw(`DELETE FROM ${table} WHERE stack_id = '${STACK}'`));
      }
    }

    beforeAll(async () => {
      await stack(STACK);
      await stack("stk_tk_rules_b", orgB);
    });

    it.each<[string, Record<string, string>]>([
      ["every hour", { frequency: "'hourly'", hour_utc: "NULL" }],
      ["every day at midnight", { hour_utc: "0" }],
      ["every day at 23", { hour_utc: "23" }],
      ["every Monday", { frequency: "'weekly'", weekday: "1" }],
      ["every Sunday", { frequency: "'weekly'", weekday: "7" }],
      ["a skipped time with its reason", { skipped_slot_at: "NOW()", skip_reason: "'busy'" }],
      ["the longest key", { task_key: `'a${"b".repeat(31)}'` }],
      ["a person who changed it", { changed_by: `'${USER}'` }],
    ])("takes a schedule: %s", async (_label, over) => {
      expect(await tried("app_stack_task_schedules", { ...SCHEDULE, ...over })).toBeNull();
    });

    it.each<[string, Record<string, string>, string]>([
      ["never is no row", { frequency: "'never'", hour_utc: "NULL" }, "23514"],
      ["a frequency that is not offered", { frequency: "'monthly'" }, "23514"],
      ["an hour on an hourly schedule", { frequency: "'hourly'" }, "23514"],
      ["a weekday on an hourly schedule", { frequency: "'hourly'", hour_utc: "NULL", weekday: "1" }, "23514"],
      ["a daily schedule without its hour", { hour_utc: "NULL" }, "23514"],
      ["a weekday on a daily schedule", { weekday: "2" }, "23514"],
      ["a weekly schedule without its weekday", { frequency: "'weekly'" }, "23514"],
      ["a weekly schedule without its hour", { frequency: "'weekly'", weekday: "2", hour_utc: "NULL" }, "23514"],
      ["hour -1", { hour_utc: "-1" }, "23514"],
      ["hour 24", { hour_utc: "24" }, "23514"],
      ["weekday 0", { frequency: "'weekly'", weekday: "0" }, "23514"],
      ["weekday 8", { frequency: "'weekly'", weekday: "8" }, "23514"],
      ["a skipped time without a reason", { skipped_slot_at: "NOW()" }, "23514"],
      ["a reason without a skipped time", { skip_reason: "'busy'" }, "23514"],
      ["a reason outside the list", { skipped_slot_at: "NOW()", skip_reason: "'stopped'" }, "23514"],
      ["a key with a capital", { task_key: "'Probe'" }, "23514"],
      ["a key that ends with a dash", { task_key: "'probe-'" }, "23514"],
      ["a key that is too long", { task_key: `'a${"b".repeat(32)}'` }, "23514"],
      ["a key with a space", { task_key: "'pro be'" }, "23514"],
      ["an application that does not exist", { stack_id: "'stk_tk_none'" }, "23503"],
      ["an application of another customer", { stack_id: "'stk_tk_rules_b'" }, "23503"],
      ["a person who does not exist", { changed_by: "'usr_none'" }, "23503"],
      ["no application", { stack_id: "NULL" }, "23502"],
    ])("refuses a schedule: %s", async (_label, over, state) => {
      expect(await tried("app_stack_task_schedules", { ...SCHEDULE, ...over })).toBe(state);
    });

    it("keeps one schedule per task of an application", async () => {
      await db().execute(insert("app_stack_task_schedules", SCHEDULE));
      await db().execute(insert("app_stack_task_schedules", { ...SCHEDULE, task_key: "'other'" }));
      expect(await tried("app_stack_task_schedules", { ...SCHEDULE, frequency: "'hourly'", hour_utc: "NULL" })).toBe("23505");
    });

    it.each<[string, Record<string, string>]>([
      ["asked by a person", { requested_by: `'${USER}'` }],
      ["asked by nobody the panel still knows", {}],
      ["of a schedule", { run_trigger: "'schedule'", slot_at: "'2026-11-23T03:00:00Z'" }],
      ["that is running", { status: "'running'", started_at: "NOW()" }],
      ["that ended well", { ...ENDED, exit_code: "0", started_at: "NOW()" }],
      ["that ended with the highest code", { status: "'failed'", ended_at: "NOW()", exit_code: "255" }],
      ["that went over its time", { status: "'timed_out'", ended_at: "NOW()" }],
      ["that never started", { status: "'not_started'", ended_at: "NOW()", problem: "'component_not_running'" }],
      ["whose outcome nobody knows", { status: "'unknown'", ended_at: "NOW()", problem: "'outcome_lost'" }],
      ["with the most it may have printed", { ...ENDED, output: `repeat('x', ${String(APP_STACK_TASK_LIMITS.outputBytes)})`, output_truncated: "TRUE" }],
    ])("takes a run: %s", async (_label, over) => {
      expect(await tried("app_stack_task_runs", { ...RUN, ...over })).toBeNull();
    });

    it.each<[string, Record<string, string>, string]>([
      ["an id of another kind", { id: "'sdep_0123456789abcdef01234567'" }, "23514"],
      ["an id that is too short", { id: "'srun_0123456789abcdef'" }, "23514"],
      ["an id with capitals", { id: "'srun_0123456789ABCDEF01234567'" }, "23514"],
      ["a status outside the list", { status: "'interrupted'", ended_at: "NOW()" }, "23514"],
      ["a problem outside the list", { problem: "'stopped'" }, "23514"],
      ["exit code -1", { ...ENDED, exit_code: "-1" }, "23514"],
      ["exit code 256", { ...ENDED, exit_code: "256" }, "23514"],
      ["one byte too many", { ...ENDED, output: `repeat('x', ${String(APP_STACK_TASK_LIMITS.outputBytes + 1)})` }, "23514"],
      ["too many bytes in few characters", { ...ENDED, output: `repeat('é', ${String(APP_STACK_TASK_LIMITS.outputBytes / 2 + 1)})` }, "23514"],
      ["a time on a run a person asked", { slot_at: "NOW()" }, "23514"],
      ["a run of a schedule without its time", { run_trigger: "'schedule'" }, "23514"],
      ["a person on a run of a schedule", { run_trigger: "'schedule'", slot_at: "NOW()", requested_by: `'${USER}'` }, "23514"],
      ["a trigger outside the list", { run_trigger: "'cron'" }, "23514"],
      ["an end on a queued run", { ended_at: "NOW()" }, "23514"],
      ["an end on a running run", { status: "'running'", ended_at: "NOW()" }, "23514"],
      ["an ended run without its end", { status: "'succeeded'" }, "23514"],
      ["a component key with a capital", { component_key: "'App'" }, "23514"],
      ["a task key with a dot", { task_key: "'pro.be'" }, "23514"],
      ["an application that does not exist", { stack_id: "'stk_tk_none'" }, "23503"],
      ["an application of another customer", { stack_id: "'stk_tk_rules_b'" }, "23503"],
      ["a person who does not exist", { requested_by: "'usr_none'" }, "23503"],
      ["no component", { component_key: "NULL" }, "23502"],
      ["no operation", { operation_id: "NULL" }, "23502"],
    ])("refuses a run: %s", async (_label, over, state) => {
      expect(await tried("app_stack_task_runs", { ...RUN, ...over })).toBe(state);
    });

    it("keeps one run per operation and one per time of a schedule", async () => {
      const slot = { run_trigger: "'schedule'", slot_at: "'2026-11-23T03:00:00Z'" };
      await db().execute(insert("app_stack_task_runs", { ...RUN, ...ENDED, ...slot }));
      const second = { ...RUN, id: "'srun_1123456789abcdef01234567'" };
      // The same operation, the same time of the same task; another task at that time is its own run.
      expect(await stateOfInsert(insert("app_stack_task_runs", second))).toBe("23505");
      expect(await stateOfInsert(insert("app_stack_task_runs", { ...second, operation_id: "'op_tk_probe2'", ...slot }))).toBe("23505");
      expect(await stateOfInsert(insert("app_stack_task_runs", { ...second, operation_id: "'op_tk_probe2'", ...slot, task_key: "'other'" }))).toBeNull();
      await db().execute(sql.raw(`DELETE FROM app_stack_task_runs WHERE stack_id = '${STACK}'`));
    });

    async function stateOfInsert(query: ReturnType<typeof insert>): Promise<string | null> {
      try {
        await db().execute(query);
        return null;
      } catch (error) {
        return stateOf(error) ?? "unknown";
      }
    }

    it("forgets the person, not the row, when a user is removed", async () => {
      await db().insert(users).values({ id: "usr_tk_gone", email: "gone@example.test", name: "Gone" });
      await db().execute(insert("app_stack_task_schedules", { ...SCHEDULE, changed_by: "'usr_tk_gone'" }));
      await db().execute(insert("app_stack_task_runs", { ...RUN, requested_by: "'usr_tk_gone'" }));
      await db().delete(users).where(eq(users.id, "usr_tk_gone"));
      expect((await scheduleOf(STACK, "probe"))?.changedBy).toBeNull();
      expect((await runsOf(STACK)).map((run) => run.requestedBy)).toEqual([null]);
      await db().execute(sql.raw(`DELETE FROM app_stack_task_runs WHERE stack_id = '${STACK}'`));
      await db().execute(sql.raw(`DELETE FROM app_stack_task_schedules WHERE stack_id = '${STACK}'`));
    });
  });

  describe("a deleted application", () => {
    it("takes its schedules and its runs with it, and nobody else's", async () => {
      await stack("stk_tk_del");
      await stack("stk_tk_keep");
      for (const id of ["stk_tk_del", "stk_tk_keep"]) {
        await setAppStackTaskScheduleTransactional(db(), {
          organizationId: orgA,
          stackId: id,
          taskKey: "cleanup",
          schedule: { frequency: "hourly" },
          changedBy: USER,
        });
        await finished(id, "cleanup", at("2026-11-23T08:00:00Z"));
        await finished(id, "report", at("2026-11-23T09:00:00Z"));
      }
      // A change that is not the delete leaves everything.
      await status("stk_tk_del", "stopped");
      await db().update(appStacks).set({ updatedAt: new Date(), deletedAt: null }).where(eq(appStacks.id, "stk_tk_del"));
      expect(await runsOf("stk_tk_del")).toHaveLength(2);
      expect(await scheduleOf("stk_tk_del", "cleanup")).not.toBeNull();

      await forget("stk_tk_del");
      expect(await runsOf("stk_tk_del")).toEqual([]);
      expect(await scheduleOf("stk_tk_del", "cleanup")).toBeNull();
      expect(await runsOf("stk_tk_keep")).toHaveLength(2);
      expect(await scheduleOf("stk_tk_keep", "cleanup")).not.toBeNull();
    });

    it("has no schedule the scheduler reads, and takes no new schedule or run", async () => {
      await stack("stk_tk_del2");
      await forget("stk_tk_del2");
      // A row written behind the repository's back is still not read.
      await db().execute(sql`INSERT INTO app_stack_task_schedules (stack_id, organization_id, task_key, frequency)
        VALUES ('stk_tk_del2', ${orgA}, 'cleanup', 'hourly')`);
      expect((await listAppStackTaskSchedulesOfLiveStacks(db())).map((row) => row.schedule.stackId)).not.toContain("stk_tk_del2");
      await expect(
        setAppStackTaskScheduleTransactional(db(), {
          organizationId: orgA,
          stackId: "stk_tk_del2",
          taskKey: "cleanup",
          schedule: { frequency: "daily", hourUtc: 1 },
          changedBy: null,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(manual("stk_tk_del2", "cleanup")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("the schedule of a task", () => {
    const scope = { organizationId: orgA, stackId: "stk_tk_sched", taskKey: "cleanup" };
    const T0 = at("2026-11-22T12:00:00.000Z");

    beforeAll(async () => {
      await stack("stk_tk_sched");
      await stack("stk_tk_sched_b", orgB);
    });

    it("reads a row as a schedule, and no row as never", () => {
      expect(appStackTaskScheduleOf(null)).toEqual({ frequency: "never" });
      expect(appStackTaskScheduleOf(undefined)).toEqual({ frequency: "never" });
      expect(appStackTaskScheduleOf({ frequency: "hourly", hourUtc: null, weekday: null })).toEqual({ frequency: "hourly" });
      expect(appStackTaskScheduleOf({ frequency: "daily", hourUtc: 0, weekday: null })).toEqual({ frequency: "daily", hourUtc: 0 });
      expect(appStackTaskScheduleOf({ frequency: "weekly", hourUtc: 23, weekday: 7 })).toEqual({ frequency: "weekly", weekday: 7, hourUtc: 23 });
    });

    it("writes a schedule, and a change starts clean", async () => {
      const first = await setAppStackTaskScheduleTransactional(db(), { ...scope, schedule: { frequency: "daily", hourUtc: 3 }, changedBy: USER, now: T0 });
      expect(first).toMatchObject({
        stackId: "stk_tk_sched",
        organizationId: orgA,
        taskKey: "cleanup",
        frequency: "daily",
        hourUtc: 3,
        weekday: null,
        changedBy: USER,
        servedSlotAt: null,
        skippedSlotAt: null,
        skipReason: null,
      });
      expect(first?.changedAt).toEqual(T0);

      const slot = at("2026-11-23T03:00:00Z");
      expect(await noteAppStackTaskSlotRefused(db(), { ...scope, changedAt: T0, slot, reason: "busy" })).toBe(true);
      expect(await closeAppStackTaskSlot(db(), { ...scope, changedAt: T0, slot, skipped: true })).toBe(true);
      expect(await scheduleOf(scope.stackId, "cleanup")).toMatchObject({ servedSlotAt: slot, skippedSlotAt: slot, skipReason: "busy" });

      const T1 = at("2026-11-23T04:00:00.000Z");
      const weekly = await setAppStackTaskScheduleTransactional(db(), {
        ...scope,
        schedule: { frequency: "weekly", weekday: 5, hourUtc: 22 },
        changedBy: null,
        now: T1,
      });
      expect(weekly).toMatchObject({ frequency: "weekly", hourUtc: 22, weekday: 5, changedBy: null, servedSlotAt: null, skippedSlotAt: null, skipReason: null });
      expect(weekly?.changedAt).toEqual(T1);

      const hourly = await setAppStackTaskScheduleTransactional(db(), { ...scope, schedule: { frequency: "hourly" }, changedBy: USER });
      expect(hourly).toMatchObject({ frequency: "hourly", hourUtc: null, weekday: null, changedBy: USER });
      expect(await listAppStackTaskSchedules(db(), scope)).toHaveLength(1);
    });

    it("removes the row for never, also when there is none", async () => {
      expect(await setAppStackTaskScheduleTransactional(db(), { ...scope, schedule: { frequency: "never" }, changedBy: USER })).toBeNull();
      expect(await listAppStackTaskSchedules(db(), scope)).toEqual([]);
      expect(await setAppStackTaskScheduleTransactional(db(), { ...scope, schedule: { frequency: "never" }, changedBy: USER })).toBeNull();
    });

    it("lists the schedules of one application of one customer, by task", async () => {
      for (const taskKey of ["report", "cleanup"]) {
        await setAppStackTaskScheduleTransactional(db(), { ...scope, taskKey, schedule: { frequency: "hourly" }, changedBy: null });
      }
      await setAppStackTaskScheduleTransactional(db(), {
        organizationId: orgB,
        stackId: "stk_tk_sched_b",
        taskKey: "cleanup",
        schedule: { frequency: "daily", hourUtc: 5 },
        changedBy: null,
      });
      expect((await listAppStackTaskSchedules(db(), scope)).map((row) => row.taskKey)).toEqual(["cleanup", "report"]);
      expect(await listAppStackTaskSchedules(db(), { organizationId: orgB, stackId: "stk_tk_sched" })).toEqual([]);
      expect(await listAppStackTaskSchedules(db(), { organizationId: orgA, stackId: "stk_tk_sched_b" })).toEqual([]);

      await status("stk_tk_sched_b", "stopped");
      const live = await listAppStackTaskSchedulesOfLiveStacks(db());
      expect(live.filter((row) => row.schedule.stackId === "stk_tk_sched").map((row) => [row.schedule.taskKey, row.stackStatus, row.appliedRevisionId])).toEqual([
        ["cleanup", "running", "srev_stk_tk_sched"],
        ["report", "running", "srev_stk_tk_sched"],
      ]);
      expect(live.find((row) => row.schedule.stackId === "stk_tk_sched_b")).toMatchObject({ stackStatus: "stopped", appliedRevisionId: "srev_stk_tk_sched_b" });
    });

    it("refuses an application of another customer or one that does not exist", async () => {
      const schedule = { frequency: "hourly" } as const;
      await expect(
        setAppStackTaskScheduleTransactional(db(), { organizationId: orgB, stackId: "stk_tk_sched", taskKey: "cleanup", schedule, changedBy: null }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        setAppStackTaskScheduleTransactional(db(), { organizationId: orgA, stackId: "stk_tk_none", taskKey: "cleanup", schedule, changedBy: null }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("a run a person asks", () => {
    beforeAll(async () => {
      await stack("stk_tk_run");
      await stack("stk_tk_run_b", orgB);
    });

    it("queues one operation under the lock of the application's runs, one run row and nothing of the command", async () => {
      const result = await manual("stk_tk_run", "cleanup", { now: at("2026-11-23T10:00:00.000Z") });
      if (result.outcome !== "queued") throw new Error(result.outcome);
      expect(result.idempotentReplay).toBe(false);
      expect(result.run).toMatchObject({
        stackId: "stk_tk_run",
        organizationId: orgA,
        taskKey: "cleanup",
        componentKey: "app",
        trigger: "manual",
        requestedBy: USER,
        slotAt: null,
        operationId: result.operationId,
        status: "queued",
        problem: null,
        exitCode: null,
        startedAt: null,
        endedAt: null,
        output: "",
        outputTruncated: false,
      });
      expect(result.run.id).toMatch(/^srun_[0-9a-f]{24}$/);
      expect(result.run.requestedAt).toEqual(at("2026-11-23T10:00:00.000Z"));

      const [operation] = await db().select().from(operations).where(eq(operations.id, result.operationId));
      expect(operation).toMatchObject({
        organizationId: orgA,
        kind: APP_STACK_TASK_KIND,
        resourceType: APP_STACK_RESOURCE_TYPE,
        resourceId: "stk_tk_run",
        lockKey: appStackTaskQueueKey("stk_tk_run"),
        status: "queued",
        requestedByUserId: USER,
      });
      const steps = await db().select().from(operationSteps).where(eq(operationSteps.operationId, result.operationId));
      expect(steps.map((step) => [step.key, step.label])).toEqual(APP_STACK_TASK_STEPS.map((step) => [step.key, step.label]));
      const events = (await db().select().from(outboxEvents).where(eq(outboxEvents.aggregateId, "stk_tk_run"))).filter(
        (event) => (event.payload as { operationId?: string }).operationId === result.operationId,
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe(`operation.queued.${APP_STACK_TASK_KIND}`);
      expect(events[0]?.payload).toEqual({
        operationId: result.operationId,
        organizationId: orgA,
        kind: APP_STACK_TASK_KIND,
        resourceType: APP_STACK_RESOURCE_TYPE,
        resourceId: "stk_tk_run",
        stackId: "stk_tk_run",
        runId: result.run.id,
      });
      // The application is as it was: a task is not a change of the application.
      const [row] = await db().select().from(appStacks).where(eq(appStacks.id, "stk_tk_run"));
      expect(row).toMatchObject({ status: "running", appliedRevisionId: "srev_stk_tk_run", desiredRevisionId: "srev_stk_tk_run" });
    });

    it("answers the same request with the same run, and refuses the key for another request", async () => {
      const [first] = await runsOf("stk_tk_run");
      const request = { trigger: "manual", requestedByUserId: USER, idempotencyKey: `tk-${String(counter)}`, requestHash: hex(`tk ${String(counter)}`) } as const;
      const again = await manual("stk_tk_run", "cleanup", { request });
      expect(again).toMatchObject({ outcome: "queued", idempotentReplay: true, operationId: first?.operationId, run: { id: first?.id } });
      expect(await runsOf("stk_tk_run")).toHaveLength(1);

      await expect(manual("stk_tk_run", "cleanup", { request: { ...request, requestHash: hex("another body") } })).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
      });
      await expect(manual("stk_tk_run", "report", { request })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      await stack("stk_tk_run2");
      await expect(manual("stk_tk_run2", "cleanup", { request })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      expect(await runsOf("stk_tk_run2")).toEqual([]);
    });

    it("refuses a second run while one waits, and a change of the application while one runs", async () => {
      expect(await manual("stk_tk_run", "report")).toEqual({ outcome: "refused", reason: "busy", status: "running" });
      expect(await manual("stk_tk_run", "cleanup")).toEqual({ outcome: "refused", reason: "busy", status: "running" });
      // A run that waits does not hold the application (see "a run that waits for the lane of tasks"); this one begins.
      const [waiting] = await runsOf("stk_tk_run");
      expect(
        await beginAppStackTaskRunTransactional(db(), {
          runId: waiting!.id,
          operationId: waiting!.operationId,
          revisionId: "srev_stk_tk_run",
          componentKey: "app",
          startedAt: new Date(),
        }),
      ).toEqual({ outcome: "started" });
      expect(await manual("stk_tk_run", "report")).toEqual({ outcome: "refused", reason: "busy", status: "running" });
      await expect(
        enqueueAppStackOperationTransactional(db(), {
          organizationId: orgA,
          stackId: "stk_tk_run",
          kind: "stack.stop",
          requestedByUserId: null,
          idempotencyKey: "tk-stop-while-running",
          requestHash: hex("stop"),
          revision: null,
          destroyData: false,
        }),
      ).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
      const [row] = await db().select().from(appStacks).where(eq(appStacks.id, "stk_tk_run"));
      expect(row?.status).toBe("running");
      expect(await runsOf("stk_tk_run")).toHaveLength(1);

      await settle("stk_tk_run");
      expect(await manual("stk_tk_run", "report")).toMatchObject({ outcome: "queued" });
      await settle("stk_tk_run");
    });

    it.each(APP_STACK_STATUSES.filter((value) => value !== "deleted").map((value) => [value] as const))(
      "while the application is %s: queued only when it runs, busy while it is being changed",
      async (value) => {
        await status("stk_tk_run", value);
        const result = await manual("stk_tk_run", "cleanup");
        const expected = (APP_STACK_BUSY_STATUSES as readonly AppStackStatus[]).includes(value)
          ? { outcome: "refused", reason: "busy", status: value }
          : (APP_STACK_TASK_RUNNABLE_STATUSES as readonly AppStackStatus[]).includes(value)
            ? { outcome: "queued", idempotentReplay: false }
            : { outcome: "refused", reason: "not_running", status: value };
        expect(result).toMatchObject(expected);
        await settle("stk_tk_run");
        await status("stk_tk_run", "running");
      },
    );

    it("refuses an application that has just changed, and one never installed", async () => {
      const before = (await runsOf("stk_tk_run")).length;
      expect(await manual("stk_tk_run", "cleanup", { appliedRevisionId: "srev_of_a_moment_ago" })).toEqual({
        outcome: "refused",
        reason: "busy",
        status: "running",
      });
      await db().update(appStacks).set({ appliedRevisionId: null }).where(eq(appStacks.id, "stk_tk_run"));
      expect(await manual("stk_tk_run", "cleanup")).toEqual({ outcome: "refused", reason: "not_running", status: "running" });
      await db().update(appStacks).set({ appliedRevisionId: "srev_stk_tk_run" }).where(eq(appStacks.id, "stk_tk_run"));
      expect(await runsOf("stk_tk_run")).toHaveLength(before);
    });

    it("refuses an application of another customer or one that does not exist", async () => {
      await expect(manual("stk_tk_run_b", "cleanup")).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(manual("stk_tk_none", "cleanup")).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await runsOf("stk_tk_run_b")).toEqual([]);
    });
  });

  describe("how a run ends", () => {
    beforeAll(async () => {
      await stack("stk_tk_end");
    });

    async function queued(taskKey = "cleanup"): Promise<string> {
      await settle("stk_tk_end");
      const result = await manual("stk_tk_end", taskKey);
      if (result.outcome !== "queued") throw new Error(result.outcome);
      return result.run.id;
    }

    it("starts once and ends once", async () => {
      const runId = await queued();
      const startedAt = at("2026-11-23T10:00:01.000Z");
      const endedAt = at("2026-11-23T10:00:09.000Z");
      expect(await startAppStackTaskRun(db(), { runId, startedAt })).toBe(true);
      expect(await getAppStackTaskRun(db(), { runId })).toMatchObject({ status: "running", startedAt, endedAt: null });
      expect(await startAppStackTaskRun(db(), { runId, startedAt: endedAt })).toBe(false);

      const end = { runId, status: "failed", problem: null, exitCode: 3, startedAt: null, endedAt, output: "one\ntwo", outputTruncated: false } as const;
      expect(await finishAppStackTaskRun(db(), end)).toBe(true);
      const row = await getAppStackTaskRun(db(), { runId });
      expect(row).toMatchObject({ status: "failed", problem: null, exitCode: 3, startedAt, endedAt, output: "one\ntwo", outputTruncated: false });

      // A second answer (a late one, or the repair) changes nothing.
      expect(await finishAppStackTaskRun(db(), { ...end, status: "succeeded", exitCode: 0, output: "late" })).toBe(false);
      expect(await startAppStackTaskRun(db(), { runId, startedAt })).toBe(false);
      expect(await getAppStackTaskRun(db(), { runId })).toEqual(row);
      expect(await getAppStackTaskRun(db(), { runId: "srun_ffffffffffffffffffffffff" })).toBeNull();
    });

    it("ends a run that never started, and takes the start the executor reports", async () => {
      const never = await queued();
      const endedAt = at("2026-11-23T11:00:00.000Z");
      expect(
        await finishAppStackTaskRun(db(), {
          runId: never,
          status: "not_started",
          problem: "component_not_running",
          exitCode: null,
          startedAt: null,
          endedAt,
          output: "",
          outputTruncated: false,
        }),
      ).toBe(true);
      expect(await getAppStackTaskRun(db(), { runId: never })).toMatchObject({
        status: "not_started",
        problem: "component_not_running",
        exitCode: null,
        startedAt: null,
        endedAt,
        output: "",
      });

      const reported = await queued();
      await startAppStackTaskRun(db(), { runId: reported, startedAt: at("2026-11-23T11:00:01.000Z") });
      const startedAt = at("2026-11-23T11:00:02.500Z");
      await finishAppStackTaskRun(db(), {
        runId: reported,
        status: "timed_out",
        problem: null,
        exitCode: null,
        startedAt,
        endedAt: at("2026-11-23T11:01:02.500Z"),
        output: "",
        outputTruncated: false,
      });
      expect(await getAppStackTaskRun(db(), { runId: reported })).toMatchObject({ status: "timed_out", startedAt });

      // Sent, then refused for sure: the start written when it was sent goes, because nothing started.
      const refused = await queued();
      await startAppStackTaskRun(db(), { runId: refused, startedAt: at("2026-11-23T11:02:00.000Z") });
      await finishAppStackTaskRun(db(), {
        runId: refused,
        status: "not_started",
        problem: "unavailable",
        exitCode: null,
        startedAt: at("2026-11-23T11:02:01.000Z"),
        endedAt: at("2026-11-23T11:02:02.000Z"),
        output: "",
        outputTruncated: false,
      });
      expect(await getAppStackTaskRun(db(), { runId: refused })).toMatchObject({ status: "not_started", startedAt: null });
    });

    it("bounds again what a run printed before it writes it", async () => {
      const runId = await queued();
      const lines = Array.from({ length: APP_STACK_TASK_LIMITS.outputLines + 100 }, (_, index) => `line ${String(index)} \u0007bell\u001b[0m`);
      const end = { runId, status: "succeeded", problem: null, exitCode: 0, startedAt: null, endedAt: new Date(), outputTruncated: false } as const;
      expect(await finishAppStackTaskRun(db(), { ...end, output: lines.join("\n") })).toBe(true);
      const row = await getAppStackTaskRun(db(), { runId });
      const kept = row?.output.split("\n") ?? [];
      expect(kept).toHaveLength(APP_STACK_TASK_LIMITS.outputLines);
      expect(kept[kept.length - 1]).toBe(`line ${String(lines.length - 1)} bell[0m`);
      expect(row?.outputTruncated).toBe(true);

      // More bytes than the row takes: the last lines that fit are kept and the row's own rule never fires.
      const big = await queued();
      const wide = Array.from({ length: 40 }, (_, index) => `${String(index).padStart(2, "0")}${"é".repeat(600)}`);
      expect(await finishAppStackTaskRun(db(), { ...end, runId: big, output: wide.join("\n") })).toBe(true);
      const bigRow = await getAppStackTaskRun(db(), { runId: big });
      expect(Buffer.byteLength(bigRow?.output ?? "", "utf8")).toBeLessThanOrEqual(APP_STACK_TASK_LIMITS.outputBytes);
      expect(bigRow?.output.endsWith(wide[39]!)).toBe(true);
      expect(bigRow?.outputTruncated).toBe(true);

      // What the executor already cut stays marked as cut.
      const cut = await queued();
      await finishAppStackTaskRun(db(), { ...end, runId: cut, output: "tail", outputTruncated: true });
      expect(await getAppStackTaskRun(db(), { runId: cut })).toMatchObject({ output: "tail", outputTruncated: true });
      await settle("stk_tk_end");
    });
  });

  describe("the runs a customer sees", () => {
    beforeAll(async () => {
      await stack("stk_tk_list");
      await stack("stk_tk_list_b", orgB);
    });

    it("keeps the last runs of each task and drops the older ones", async () => {
      const day = Date.parse("2026-11-01T00:00:00Z");
      const other = await finished("stk_tk_list", "report", new Date(day - 3_600_000));
      const ids: string[] = [];
      for (let index = 0; index < APP_STACK_TASK_LIMITS.runsKept + 5; index += 1) {
        ids.push(await finished("stk_tk_list", "cleanup", new Date(day + index * 3_600_000)));
      }
      const scope = { organizationId: orgA, stackId: "stk_tk_list", taskKey: "cleanup" };
      const kept = await listAppStackTaskRuns(db(), scope);
      expect(kept).toHaveLength(APP_STACK_TASK_LIMITS.runsKept);
      expect(kept.map((run) => run.id)).toEqual(ids.slice(5).reverse());
      expect(kept[0]?.output).toBe(`run of ${new Date(day + (ids.length - 1) * 3_600_000).toISOString()}`);
      // The runs of another task are counted by themselves.
      expect((await listAppStackTaskRuns(db(), { ...scope, taskKey: "report" })).map((run) => run.id)).toEqual([other]);
      expect(await runsOf("stk_tk_list")).toHaveLength(APP_STACK_TASK_LIMITS.runsKept + 1);
      // The operations of the dropped runs stay: they are the history of the application's operations.
      expect((await db().select().from(operations).where(eq(operations.resourceId, "stk_tk_list"))).length).toBe(ids.length + 1);
    }, 60_000);

    it("gives the latest run of every task without what it printed, to its own customer only", async () => {
      const latest = await listLatestAppStackTaskRuns(db(), { organizationId: orgA, stackId: "stk_tk_list" });
      expect(latest.map((run) => run.taskKey)).toEqual(["cleanup", "report"]);
      const newest = (await listAppStackTaskRuns(db(), { organizationId: orgA, stackId: "stk_tk_list", taskKey: "cleanup" }))[0];
      expect(latest[0]).toMatchObject({ id: newest?.id, status: "succeeded", exitCode: 0, trigger: "manual" });
      for (const run of latest) {
        expect(Object.keys(run)).not.toContain("output");
        expect(Object.keys(run)).not.toContain("outputTruncated");
      }
      expect(await listLatestAppStackTaskRuns(db(), { organizationId: orgB, stackId: "stk_tk_list" })).toEqual([]);
      expect(await listAppStackTaskRuns(db(), { organizationId: orgB, stackId: "stk_tk_list", taskKey: "cleanup" })).toEqual([]);
      expect(await listLatestAppStackTaskRuns(db(), { organizationId: orgB, stackId: "stk_tk_list_b" })).toEqual([]);
    });
  });

  describe("a time of a schedule", () => {
    const scope = { organizationId: orgA, stackId: "stk_tk_slot", taskKey: "cleanup" };
    const T0 = at("2026-11-22T12:00:00.000Z");
    const S1 = at("2026-11-23T03:00:00.000Z");
    const S2 = at("2026-11-24T03:00:00.000Z");
    const S3 = at("2026-11-25T03:00:00.000Z");
    const S4 = at("2026-11-26T03:00:00.000Z");
    const daily = () => setAppStackTaskScheduleTransactional(db(), { ...scope, schedule: { frequency: "daily", hourUtc: 3 }, changedBy: USER, now: T0 });
    const slot = (value: Date) => ({ stackId: scope.stackId, taskKey: scope.taskKey, changedAt: T0, slot: value });

    beforeAll(async () => {
      await stack("stk_tk_slot");
    });

    it("is queued once: the run carries the time and no person, and the schedule remembers it", async () => {
      await daily();
      expect(await noteAppStackTaskSlotRefused(db(), { ...slot(S1), reason: "busy" })).toBe(true);
      const result = await scheduled("stk_tk_slot", "cleanup", S1, T0);
      if (result.outcome !== "queued") throw new Error(result.outcome);
      expect(result.run).toMatchObject({ trigger: "schedule", slotAt: S1, requestedBy: null, status: "queued", taskKey: "cleanup" });
      const [operation] = await db().select().from(operations).where(eq(operations.id, result.operationId));
      expect(operation).toMatchObject({ kind: APP_STACK_TASK_KIND, idempotencyKey: null, requestedByUserId: null, lockKey: appStackTaskQueueKey("stk_tk_slot") });
      expect(await scheduleOf("stk_tk_slot", "cleanup")).toMatchObject({ servedSlotAt: S1, skippedSlotAt: null, skipReason: null });

      await settle("stk_tk_slot");
      // The same time again, or an earlier one, is not owed any more.
      expect(await scheduled("stk_tk_slot", "cleanup", S1, T0)).toEqual({ outcome: "stale" });
      expect(await scheduled("stk_tk_slot", "cleanup", at("2026-11-22T03:00:00.000Z"), T0)).toEqual({ outcome: "stale" });
      expect(await runsOf("stk_tk_slot")).toHaveLength(1);
    });

    it("is not queued for a schedule that has changed since it was read", async () => {
      expect(await scheduled("stk_tk_slot", "cleanup", S2, at("2026-11-22T11:59:59.000Z"))).toEqual({ outcome: "stale" });
      expect(await scheduled("stk_tk_slot", "report", S2, T0)).toEqual({ outcome: "stale" });
      expect(await noteAppStackTaskSlotRefused(db(), { ...slot(S2), changedAt: at("2026-11-22T11:59:59.000Z"), reason: "busy" })).toBe(false);
      expect(await closeAppStackTaskSlot(db(), { ...slot(S2), changedAt: at("2026-11-22T11:59:59.000Z"), skipped: true })).toBe(false);
      expect(await scheduleOf("stk_tk_slot", "cleanup")).toMatchObject({ servedSlotAt: S1, skippedSlotAt: null, skipReason: null });
    });

    it("stays owed while the application is busy or stopped, with the reason noted", async () => {
      await status("stk_tk_slot", "updating");
      expect(await scheduled("stk_tk_slot", "cleanup", S2, T0)).toEqual({ outcome: "refused", reason: "busy", status: "updating" });
      expect(await noteAppStackTaskSlotRefused(db(), { ...slot(S2), reason: "busy" })).toBe(true);
      expect(await scheduleOf("stk_tk_slot", "cleanup")).toMatchObject({ servedSlotAt: S1, skippedSlotAt: S2, skipReason: "busy" });

      await status("stk_tk_slot", "stopped");
      expect(await scheduled("stk_tk_slot", "cleanup", S2, T0)).toEqual({ outcome: "refused", reason: "not_running", status: "stopped" });
      expect(await noteAppStackTaskSlotRefused(db(), { ...slot(S2), reason: "not_running" })).toBe(true);
      expect(await scheduleOf("stk_tk_slot", "cleanup")).toMatchObject({ servedSlotAt: S1, skippedSlotAt: S2, skipReason: "not_running" });
      expect(await runsOf("stk_tk_slot")).toHaveLength(1);
    });

    it("is closed as skipped with the reason noted for it, or as missed when there is none", async () => {
      expect(await closeAppStackTaskSlot(db(), { ...slot(S2), skipped: true })).toBe(true);
      expect(await scheduleOf("stk_tk_slot", "cleanup")).toMatchObject({ servedSlotAt: S2, skippedSlotAt: S2, skipReason: "not_running" });
      // Closed: no note, no second close, no run for it.
      expect(await noteAppStackTaskSlotRefused(db(), { ...slot(S2), reason: "busy" })).toBe(false);
      expect(await closeAppStackTaskSlot(db(), { ...slot(S2), skipped: true })).toBe(false);
      await status("stk_tk_slot", "running");
      expect(await scheduled("stk_tk_slot", "cleanup", S2, T0)).toEqual({ outcome: "stale" });

      expect(await closeAppStackTaskSlot(db(), { ...slot(S3), skipped: true })).toBe(true);
      expect(await scheduleOf("stk_tk_slot", "cleanup")).toMatchObject({ servedSlotAt: S3, skippedSlotAt: S3, skipReason: "missed" });
    });

    it("passes with no note when the installed version does not have the task", async () => {
      expect(await closeAppStackTaskSlot(db(), { ...slot(S4), skipped: false })).toBe(true);
      expect(await scheduleOf("stk_tk_slot", "cleanup")).toMatchObject({ servedSlotAt: S4, skippedSlotAt: S3, skipReason: "missed" });
      expect(await runsOf("stk_tk_slot")).toHaveLength(1);
    });

    it("clears the note of a skipped time when a later time is queued", async () => {
      const S5 = at("2026-11-27T03:00:00.000Z");
      expect(await scheduled("stk_tk_slot", "cleanup", S5, T0)).toMatchObject({ outcome: "queued", run: { slotAt: S5 } });
      expect(await scheduleOf("stk_tk_slot", "cleanup")).toMatchObject({ servedSlotAt: S5, skippedSlotAt: null, skipReason: null });
      await settle("stk_tk_slot");
    });

    it("compares the change of a schedule at the millisecond, whatever wrote the row", async () => {
      await stack("stk_tk_micro");
      await db().execute(sql`INSERT INTO app_stack_task_schedules (stack_id, organization_id, task_key, frequency, changed_at)
        VALUES ('stk_tk_micro', ${orgA}, 'cleanup', 'hourly', '2026-11-23T10:00:00.123456Z')`);
      const row = await scheduleOf("stk_tk_micro", "cleanup");
      expect(row?.changedAt).toEqual(at("2026-11-23T10:00:00.123Z"));
      const read = { stackId: "stk_tk_micro", taskKey: "cleanup", changedAt: row!.changedAt };
      expect(await noteAppStackTaskSlotRefused(db(), { ...read, slot: at("2026-11-23T11:00:00Z"), reason: "busy" })).toBe(true);
      expect(await closeAppStackTaskSlot(db(), { ...read, slot: at("2026-11-23T11:00:00Z"), skipped: true })).toBe(true);
      expect(await scheduled("stk_tk_micro", "cleanup", at("2026-11-23T12:00:00Z"), row!.changedAt)).toMatchObject({ outcome: "queued" });
      expect(await scheduled("stk_tk_micro", "cleanup", at("2026-11-23T13:00:00Z"), at("2026-11-23T10:00:00.124Z"))).toEqual({ outcome: "stale" });
      await settle("stk_tk_micro");
    });
  });

  describe("a schedule written while the clock ran ahead", () => {
    const STACK = "stk_tk_ahead";
    // Later than the times the other cases of this file store: the repair looks at every schedule of the database.
    const NOW = at("2030-01-10T10:20:00.000Z");
    const AHEAD = at("2030-01-12T09:00:00.000Z");
    const rowOf = async (taskKey: string) => (await scheduleOf(STACK, taskKey))!;
    /** A schedule set at `changedAt` whose latest served time is `served`. */
    async function written(taskKey: string, changedAt: Date, served: Date | null): Promise<void> {
      await setAppStackTaskScheduleTransactional(db(), {
        organizationId: orgA,
        stackId: STACK,
        taskKey,
        schedule: { frequency: "hourly" },
        changedBy: USER,
        now: changedAt,
      });
      await db()
        .update(appStackTaskSchedules)
        .set({ servedSlotAt: served })
        .where(and(eq(appStackTaskSchedules.stackId, STACK), eq(appStackTaskSchedules.taskKey, taskKey)));
    }

    beforeAll(async () => {
      await stack(STACK);
      await written("both", AHEAD, AHEAD);
      await written("changed", AHEAD, at("2030-01-09T10:00:00.000Z"));
      await written("served", at("2030-01-09T10:20:00.000Z"), AHEAD);
      await written("past", at("2030-01-07T10:20:00.000Z"), at("2030-01-10T10:00:00.000Z"));
      await written("now", NOW, NOW);
    });

    it("resets only the schedules whose stored time is later than the clock", async () => {
      const [past, now] = [await rowOf("past"), await rowOf("now")];
      expect(await repairAppStackTaskSchedulesAheadOfClock(db(), NOW)).toBe(3);
      for (const key of ["both", "changed", "served"]) {
        expect(await rowOf(key), key).toMatchObject({ servedSlotAt: null, changedAt: NOW, skippedSlotAt: null, skipReason: null });
      }
      // A time in the past, or exactly now, is trusted.
      expect(await rowOf("past")).toEqual(past);
      expect(await rowOf("now")).toEqual(now);
      expect(await repairAppStackTaskSchedulesAheadOfClock(db(), NOW)).toBe(0);
    });
  });

  describe("a run that waits for the lane of tasks", () => {
    // The lane of tasks takes one run at a time for the whole server: A, B and C each have a run queued, and C's run
    // waits behind the other two. Only a run that executes holds its application.
    const [A, B, C] = ["stk_tk_wait_a", "stk_tk_wait_b", "stk_tk_wait_c"];
    const stop = (stackId: string, key: string) =>
      enqueueAppStackOperationTransactional(db(), {
        organizationId: orgA,
        stackId,
        kind: "stack.stop",
        requestedByUserId: null,
        idempotencyKey: key,
        requestHash: hex(key),
        revision: null,
        destroyData: false,
      });
    const begin = (stackId: string, run: { runId: string; operationId: string }, revisionId = `srev_${stackId}`) =>
      beginAppStackTaskRunTransactional(db(), { ...run, revisionId, componentKey: "app", startedAt: at("2026-11-23T03:18:00.000Z") });
    const lockOf = async (operationId: string) => (await db().select().from(operations).where(eq(operations.id, operationId)))[0]?.lockKey;
    const end = (operationId: string) => db().update(operations).set({ status: "succeeded" }).where(eq(operations.id, operationId));
    async function queuedRun(stackId: string): Promise<{ runId: string; operationId: string }> {
      const result = await manual(stackId, "cleanup");
      if (result.outcome !== "queued") throw new Error(`not queued: ${result.outcome}`);
      return { runId: result.run.id, operationId: result.operationId };
    }

    beforeAll(async () => {
      for (const id of [A, B, C, "stk_tk_wait_d"]) await stack(id);
    });

    it("does not hold its application: a stop is accepted, and the run then does not start", async () => {
      const runs = { [A]: await queuedRun(A), [B]: await queuedRun(B), [C]: await queuedRun(C) };
      // One run waiting or running per application stays the rule.
      expect(await manual(C, "report")).toEqual({ outcome: "refused", reason: "busy", status: "running" });

      // 03:05: the customer stops C while its run only waits.
      const stopC = await stop(C, "tk-wait-stop-c");
      expect(stopC.operation).toMatchObject({ kind: "stack.stop", status: "queued" });
      expect(await lockOf(runs[C]!.operationId)).toBe(appStackTaskQueueKey(C));

      // 03:00: A's run begins and from then on holds A like any operation of it.
      expect(await begin(A, runs[A]!)).toEqual({ outcome: "started" });
      expect(await lockOf(runs[A]!.operationId)).toBe(appStackLockKey(A));
      expect(await getAppStackTaskRun(db(), { runId: runs[A]!.runId })).toMatchObject({ status: "running", startedAt: at("2026-11-23T03:18:00.000Z") });
      await expect(stop(A, "tk-wait-stop-a")).rejects.toMatchObject({ code: "RESOURCE_LOCKED" });
      expect(await manual(A, "report")).toEqual({ outcome: "refused", reason: "busy", status: "running" });
      expect(await begin(A, runs[A]!)).toEqual({ outcome: "gone" });
      expect(await begin(B, runs[B]!)).toEqual({ outcome: "started" });

      // 03:18: C's run reaches the front while the stop is in flight: it does not start and takes nothing.
      expect(await begin(C, runs[C]!)).toEqual({ outcome: "refused", reason: "busy" });
      expect(await lockOf(runs[C]!.operationId)).toBe(appStackTaskQueueKey(C));
      expect(await getAppStackTaskRun(db(), { runId: runs[C]!.runId })).toMatchObject({ status: "queued", startedAt: null });
      // Once stopped, the application is not running.
      await end(stopC.operation!.id);
      await status(C, "stopped");
      expect(await begin(C, runs[C]!)).toEqual({ outcome: "refused", reason: "not_running" });
      // An application changed since the run read its task is busy too.
      await status(C, "running");
      expect(await begin(C, runs[C]!, "srev_of_a_moment_ago")).toEqual({ outcome: "refused", reason: "busy" });
      for (const id of [A, B, C]) await settle(id);
      await status(C, "running");
    });

    it("gives a scheduled time back to its schedule when it could not start: it is tried again inside its window", async () => {
      const D = "stk_tk_wait_d";
      const T0 = at("2026-11-22T12:00:00.000Z");
      const S = at("2026-11-23T03:00:00.000Z");
      await setAppStackTaskScheduleTransactional(db(), { organizationId: orgA, stackId: D, taskKey: "cleanup", schedule: { frequency: "daily", hourUtc: 3 }, changedBy: USER, now: T0 });
      const queued = await scheduled(D, "cleanup", S, T0);
      if (queued.outcome !== "queued") throw new Error(queued.outcome);
      const run = { runId: queued.run.id, operationId: queued.operationId };

      const stopD = await stop(D, "tk-wait-stop-d");
      expect(await begin(D, run)).toEqual({ outcome: "refused", reason: "busy" });
      // The time is owed again with its reason, and its run that never started goes: a skipped time is not a run.
      let reopened: boolean | null = null;
      const statements = await statementsOf(async () => {
        reopened = await reopenAppStackTaskSlot(db(), { runId: run.runId, reason: "busy" });
      });
      expect(reopened).toBe(true);
      // The run's row is locked before the schedule's: the order of the trigger that forgets a deleted application's
      // tasks (its runs, then its schedules), so the two never wait on each other.
      const runLocked = statements.findIndex((s) => /from "app_stack_task_runs".* for update$/is.test(s.trim()));
      const scheduleChanged = statements.findIndex((s) => /^update "app_stack_task_schedules"/i.test(s.trim()));
      expect(runLocked, statements.join("\n")).toBeGreaterThanOrEqual(0);
      expect(runLocked).toBeLessThan(scheduleChanged);
      expect(await scheduleOf(D, "cleanup")).toMatchObject({ servedSlotAt: null, skippedSlotAt: S, skipReason: "busy" });
      expect(await runsOf(D)).toEqual([]);
      expect(await reopenAppStackTaskSlot(db(), { runId: run.runId, reason: "busy" })).toBe(false);

      // The application is free again inside the window: the same time is queued once more, and runs.
      await end(stopD.operation!.id);
      await settle(D);
      await status(D, "running");
      const again = await scheduled(D, "cleanup", S, T0);
      if (again.outcome !== "queued") throw new Error(again.outcome);
      expect(again.run).toMatchObject({ slotAt: S, trigger: "schedule" });
      const second = { runId: again.run.id, operationId: again.operationId };
      expect(await begin(D, second)).toEqual({ outcome: "started" });
      // A time that started is never given back.
      expect(await reopenAppStackTaskSlot(db(), { runId: second.runId, reason: "busy" })).toBe(false);
      expect(await scheduleOf(D, "cleanup")).toMatchObject({ servedSlotAt: S, skippedSlotAt: null, skipReason: null });
      expect(await scheduled(D, "cleanup", S, T0)).toEqual({ outcome: "stale" });
      await settle(D);
    });
  });

  describe("runs left behind by a stop of the panel", () => {
    it("ends the ones whose operation has ended, and starts none again", async () => {
      // The tests above ended operations without ending their runs: those are repaired first, so the count is this test's.
      await repairOrphanedAppStackTaskRunsTransactional(db(), at("2026-11-23T09:00:00.000Z"));
      for (const id of ["stk_tk_orph_q", "stk_tk_orph_r", "stk_tk_orph_live"]) await stack(id);
      const queuedRun = await manual("stk_tk_orph_q", "cleanup");
      const runningRun = await manual("stk_tk_orph_r", "cleanup");
      const liveRun = await manual("stk_tk_orph_live", "cleanup");
      if (queuedRun.outcome !== "queued" || runningRun.outcome !== "queued" || liveRun.outcome !== "queued") throw new Error("not queued");
      const startedAt = at("2026-11-23T10:00:00.000Z");
      await startAppStackTaskRun(db(), { runId: runningRun.run.id, startedAt });
      await startAppStackTaskRun(db(), { runId: liveRun.run.id, startedAt });
      await settle("stk_tk_orph_q", "failed");
      await settle("stk_tk_orph_r", "failed");
      const operationsBefore = (await db().select().from(operations)).length;

      const now = at("2026-11-23T10:30:00.000Z");
      expect(await repairOrphanedAppStackTaskRunsTransactional(db(), now)).toBe(2);
      expect(await getAppStackTaskRun(db(), { runId: queuedRun.run.id })).toMatchObject({
        status: "not_started",
        problem: "unavailable",
        startedAt: null,
        endedAt: now,
        exitCode: null,
      });
      expect(await getAppStackTaskRun(db(), { runId: runningRun.run.id })).toMatchObject({ status: "unknown", problem: "outcome_lost", startedAt, endedAt: now });
      expect(await getAppStackTaskRun(db(), { runId: liveRun.run.id })).toMatchObject({ status: "running", problem: null, endedAt: null });

      expect(await repairOrphanedAppStackTaskRunsTransactional(db(), now)).toBe(0);
      expect((await db().select().from(operations)).length).toBe(operationsBefore);
      await settle("stk_tk_orph_live");
      expect(await repairOrphanedAppStackTaskRunsTransactional(db(), now)).toBe(1);
    });
  });
});
