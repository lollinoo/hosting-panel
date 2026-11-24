"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AppStackTaskDto, AppStackTaskRunDto, AppStackTaskSchedule } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { format, type Messages } from "@/i18n";
import { useLocale, useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";
import { appStackRefusalText } from "./app-stack-view";

type Frequency = AppStackTaskSchedule["frequency"];
const FREQUENCIES: readonly Frequency[] = ["never", "hourly", "daily", "weekly"];
const SELECT = "flex h-9 rounded-md border border-input bg-transparent px-3 text-sm";
const tone = (status: string) =>
  status === "succeeded" ? "success" : status === "queued" || status === "running" ? "secondary" : "destructive";

const utcHour = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
/** A UTC hour of today as the reader's local time. */
function localHour(hour: number, locale: string): string {
  const date = new Date();
  date.setUTCHours(hour, 0, 0, 0);
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
/** 1 (Monday) to 7 (Sunday). */
function weekdayName(m: Messages, weekday: number): string {
  return (m.apps.tasks.weekdays as Record<string, string>)[`d${String(weekday)}`] ?? "";
}

/** The schedule in words, whole hours in UTC with the reader's local time beside them. */
export function appStackTaskScheduleText(m: Messages, schedule: AppStackTaskSchedule, locale: string): string {
  const t = m.apps.tasks.schedule;
  if (schedule.frequency === "never") return t.never;
  if (schedule.frequency === "hourly") return t.hourly;
  const hours = { utc: utcHour(schedule.hourUtc), local: localHour(schedule.hourUtc, locale) };
  if (schedule.frequency === "daily") return format(t.daily, hours);
  return format(t.weekly, { ...hours, day: weekdayName(m, schedule.weekday) });
}

/** The choice of the form as a schedule: a field the frequency does not use is left out. */
export function appStackTaskScheduleOf(frequency: Frequency, hourUtc: number, weekday: number): AppStackTaskSchedule {
  if (frequency === "daily") return { frequency, hourUtc };
  if (frequency === "weekly") return { frequency, weekday, hourUtc };
  return { frequency };
}

/**
 * Scheduled tasks (ADR-0042): what the application's template lets its customer run. The customer sees a name, when it
 * runs by itself and how the last runs went; nothing here shows or sends what the task executes.
 */
export function AppStackTasks({
  orgId,
  stackId,
  csrfToken,
  initial,
}: {
  orgId: string;
  stackId: string;
  csrfToken: string;
  initial: AppStackTaskDto[];
}) {
  const m = useMessages();
  const t = m.apps.tasks;
  const locale = useLocale();
  const router = useRouter();
  const keys = useRef<Record<string, string>>({});
  const [tasks, setTasks] = useState<AppStackTaskDto[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The task whose schedule is being changed, and the choice so far. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ frequency: Frequency; hourUtc: number; weekday: number }>({ frequency: "never", hourUtc: 3, weekday: 1 });
  /** The task whose last runs are shown; null rows = not loaded yet. */
  const [shown, setShown] = useState<string | null>(null);
  const [runs, setRuns] = useState<AppStackTaskRunDto[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  // router.refresh() keeps client state: take the fresh server rows (a run that ended, a time that passed).
  useEffect(() => {
    setTasks(initial);
  }, [initial]);
  const base = `/api/bff/orgs/${orgId}/app-stacks/${stackId}/tasks`;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const when = (iso: string) => date.format(new Date(iso));

  async function send(name: string, method: string, url: string, body: object, done: string): Promise<unknown> {
    if (busy) return null;
    setBusy(true);
    setError(null);
    setNotice(null);
    const sent = await keyedSend(keys.current, csrfToken, name, method, url, body);
    setBusy(false);
    if (!sent.ok) {
      setError(appStackRefusalText(m, sent.code, sent.reason));
      return null;
    }
    setNotice(done);
    router.refresh();
    return (sent.data as { data?: unknown } | null)?.data ?? {};
  }

  async function runNow(taskKey: string) {
    await send(`run:${taskKey}`, "POST", `${base}/${encodeURIComponent(taskKey)}/runs`, {}, t.accepted);
  }

  function edit(task: AppStackTaskDto) {
    const s = task.schedule;
    setDraft({ frequency: s.frequency, hourUtc: "hourUtc" in s ? s.hourUtc : 3, weekday: "weekday" in s ? s.weekday : 1 });
    setEditing(task.key);
  }

  async function save(e: React.FormEvent, taskKey: string) {
    e.preventDefault();
    const schedule = appStackTaskScheduleOf(draft.frequency, draft.hourUtc, draft.weekday);
    const data = await send(`schedule:${taskKey}`, "PUT", `${base}/${encodeURIComponent(taskKey)}/schedule`, schedule, t.saved);
    if (data === null) return;
    const list = (data as { tasks?: unknown }).tasks;
    if (Array.isArray(list)) setTasks(list as AppStackTaskDto[]);
    setEditing(null);
  }

  async function toggleRuns(taskKey: string) {
    if (shown === taskKey) {
      setShown(null);
      return;
    }
    setShown(taskKey);
    setRuns(null);
    setRunsError(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(taskKey)}/runs`, { cache: "no-store" });
      const body = await res.json().catch(() => null);
      if (res.ok && Array.isArray(body?.data?.runs)) setRuns(body.data.runs as AppStackTaskRunDto[]);
      else setRunsError(t.runs.error);
    } catch {
      setRunsError(t.runs.error);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t.intro}</p>
      <ul className="divide-y rounded-md border text-sm">
        {tasks.map((task) => {
          const id = `app-task-${task.key}`;
          const last = task.lastRun;
          return (
            <li key={task.key} className="space-y-2 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="space-y-1">
                  <h3 className="font-medium">{task.label}</h3>
                  {task.description !== "" && <p className="text-muted-foreground">{task.description}</p>}
                </div>
                <Button type="button" size="sm" disabled={busy} onClick={() => runNow(task.key)}>
                  {t.runNow}
                </Button>
              </div>
              <p>{appStackTaskScheduleText(m, task.schedule, locale)}</p>
              {task.nextRunAt && <p className="text-muted-foreground">{format(t.next, { date: when(task.nextRunAt) })}</p>}
              {task.skipped && (
                <p className="text-muted-foreground">
                  {format(task.skipped.pending && task.skipped.reason !== "missed" ? t.waiting[task.skipped.reason] : t.skipped[task.skipped.reason], {
                    date: when(task.skipped.at),
                  })}
                </p>
              )}
              {last === null ? (
                <p className="text-muted-foreground">{t.never}</p>
              ) : (
                <p className="flex flex-wrap items-center gap-2">
                  <Badge variant={tone(last.status)}>{t.status[last.status]}</Badge>
                  <span className="text-muted-foreground">
                    {format(t.last, { status: t.trigger[last.trigger], date: when(last.endedAt ?? last.startedAt ?? last.requestedAt) })}
                  </span>
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => (editing === task.key ? setEditing(null) : edit(task))}>
                  {t.schedule.change}
                </Button>
                <Button type="button" variant="outline" size="sm" aria-expanded={shown === task.key} onClick={() => toggleRuns(task.key)}>
                  {shown === task.key ? t.runs.hide : t.runs.show}
                </Button>
              </div>
              {editing === task.key && (
                <form onSubmit={(e) => save(e, task.key)} className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-frequency`}>{t.schedule.frequency}</Label>
                    <select
                      id={`${id}-frequency`}
                      value={draft.frequency}
                      onChange={(e) => setDraft({ ...draft, frequency: e.target.value as Frequency })}
                      className={SELECT}
                    >
                      {FREQUENCIES.map((f) => (
                        <option key={f} value={f}>
                          {t.schedule.option[f]}
                        </option>
                      ))}
                    </select>
                  </div>
                  {draft.frequency === "weekly" && (
                    <div className="space-y-1">
                      <Label htmlFor={`${id}-weekday`}>{t.schedule.weekday}</Label>
                      <select
                        id={`${id}-weekday`}
                        value={draft.weekday}
                        onChange={(e) => setDraft({ ...draft, weekday: Number(e.target.value) })}
                        className={SELECT}
                      >
                        {WEEKDAYS.map((day) => (
                          <option key={day} value={day}>
                            {weekdayName(m, day)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {(draft.frequency === "daily" || draft.frequency === "weekly") && (
                    <div className="space-y-1">
                      <Label htmlFor={`${id}-hour`}>{t.schedule.hour}</Label>
                      <select
                        id={`${id}-hour`}
                        value={draft.hourUtc}
                        onChange={(e) => setDraft({ ...draft, hourUtc: Number(e.target.value) })}
                        className={SELECT}
                      >
                        {Array.from({ length: 24 }, (_, h) => (
                          <option key={h} value={h}>
                            {format(t.schedule.hourOption, { utc: utcHour(h), local: localHour(h, locale) })}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <Button type="submit" disabled={busy}>
                    {t.schedule.save}
                  </Button>
                  <Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(null)}>
                    {m.apps.actions.cancel}
                  </Button>
                </form>
              )}
              {shown === task.key && (
                <div className="space-y-2">
                  {runsError && (
                    <Alert variant="destructive" role="alert">
                      <AlertDescription>{runsError}</AlertDescription>
                    </Alert>
                  )}
                  {runs === null && !runsError && (
                    <p role="status" className="text-muted-foreground">
                      {t.runs.loading}
                    </p>
                  )}
                  {runs !== null && runs.length === 0 && <p className="text-muted-foreground">{t.runs.empty}</p>}
                  {runs !== null && runs.length > 0 && (
                    <ol className="space-y-2">
                      {runs.map((run) => (
                        <li key={run.id} className="space-y-1 rounded-md border p-2">
                          <p className="flex flex-wrap items-center gap-2">
                            <Badge variant={tone(run.status)}>{t.status[run.status]}</Badge>
                            <time dateTime={run.requestedAt}>{when(run.requestedAt)}</time>
                            <span className="text-muted-foreground">{t.trigger[run.trigger]}</span>
                          </p>
                          {run.problem && <p>{t.problem[run.problem]}</p>}
                          {run.output !== "" ? (
                            <>
                              <p className="text-muted-foreground">{t.runs.output}</p>
                              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">{run.output}</pre>
                              {run.outputTruncated && <p className="text-xs text-muted-foreground">{t.runs.truncated}</p>}
                            </>
                          ) : (
                            run.endedAt !== null && run.status !== "not_started" && <p className="text-muted-foreground">{t.runs.noOutput}</p>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
