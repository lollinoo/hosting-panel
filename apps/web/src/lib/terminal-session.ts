import {
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_REFUSALS,
  TerminalReadDtoSchema,
  type TerminalEndReason,
  type TerminalReadDto,
} from "@hosting-panel/contracts";
import type { Messages } from "@/i18n";

/** No answer to a read for this long and the page counts the session as ended. */
export const TERMINAL_PAGE_LOST_MS = 40_000;

export type ReadClass =
  | { kind: "read"; read: TerminalReadDto }
  | { kind: "ended"; reason: "executor_gone" }
  | { kind: "refused"; status: number; body: unknown }
  | { kind: "retry" };

export type ReadLoopEnd = { reason: TerminalEndReason | "lost" } | { status: number; body: unknown };

/** What the page does with one answer of the read route. */
export function classifyRead(status: number, body: unknown): ReadClass {
  if (status === 200) {
    const parsed = TerminalReadDtoSchema.safeParse((body as { data?: unknown } | null)?.data);
    return parsed.success ? { kind: "read", read: parsed.data } : { kind: "retry" };
  }
  if (status === 404) return { kind: "ended", reason: "executor_gone" };
  if (status === 401 || status === 403) return { kind: "refused", status, body };
  return { kind: "retry" };
}

/** Wait before the n-th retry in a row: 1, 2, 4, then 8 seconds. */
export const readRetryDelay = (failures: number): number => Math.min(8000, 1000 * 2 ** (failures - 1));

export const isLost = (lastAnswerAt: number, now: number): boolean => now - lastAnswerAt >= TERMINAL_PAGE_LOST_MS;

export const inputFits = (input: string): boolean => new TextEncoder().encode(input).length <= TERMINAL_INPUT_MAX_BYTES;

/** What a key in the command field sends: Enter the line, Ctrl-C (no selection) and Ctrl-D their bytes. */
export function keyToInput(
  e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing?: boolean },
  line: string,
  selected: boolean,
): string | null {
  if (e.altKey || e.metaKey || e.isComposing) return null;
  if (!e.ctrlKey) return e.key === "Enter" ? `${line}\n` : null;
  const key = e.key.toLowerCase();
  if (key === "c" && !selected) return "\x03";
  if (key === "d") return "\x04";
  return null;
}

const CODES = ["TOTP_INVALID", "ACCOUNT_LOCKED", "ACCOUNT_SETUP_INCOMPLETE", "VALIDATION_ERROR", "DOCKER_ENGINE_UNAVAILABLE", "NOT_FOUND"] as const;

/** Where the shell runs: the container of a site, or of one component of an application (ADR-0041). */
export type TerminalKind = "site" | "component";

/** The fixed sentence for a refused terminal call; never built from the answer's text. */
export function terminalErrorText(m: Messages, status: number, body: unknown, kind: TerminalKind = "site"): string {
  // A component has its own sentence only where the site's one names the site.
  const e = kind === "component" ? { ...m.admin.terminal.errors, ...m.admin.appStack.terminal.errors } : m.admin.terminal.errors;
  const err = (body as { error?: { code?: unknown; details?: Array<{ reason?: unknown }> } } | null)?.error;
  const code = err?.code;
  if (status === 401 && code !== "TOTP_INVALID") return e.signedOut;
  if (code === "RESOURCE_LOCKED") {
    const reason = err?.details?.[0]?.reason;
    return TERMINAL_REFUSALS.find((r) => r === reason) ? e[reason as (typeof TERMINAL_REFUSALS)[number]] : e.generic;
  }
  if (code === "PERMISSION_DENIED") return m.errors.PERMISSION_DENIED;
  const known = CODES.find((c) => c === code);
  return known ? e[known] : e.generic;
}

export const endText = (m: Messages, reason: TerminalEndReason | "lost", kind: TerminalKind = "site"): string =>
  (kind === "component" ? { ...m.admin.terminal.ended, ...m.admin.appStack.terminal.ended } : m.admin.terminal.ended)[reason];

/** Long-polls the session's output until it ends, is refused, is lost or the signal aborts (null). */
export async function runReadLoop(o: {
  sessionId: string;
  csrfToken: string;
  signal: AbortSignal;
  onRead: (read: TerminalReadDto) => void;
  onRetry: () => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<ReadLoopEnd | null> {
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  let cursor = 0;
  let failures = 0;
  let lastAnswer = now();
  while (!o.signal.aborted) {
    let status = 0;
    let body: unknown = null;
    // A read with no answer for TERMINAL_PAGE_LOST_MS is cut and counts as a failed read.
    const limit = new AbortController();
    const cut = () => limit.abort();
    const timer = setTimeout(cut, TERMINAL_PAGE_LOST_MS);
    o.signal.addEventListener("abort", cut);
    try {
      const res = await doFetch(`/api/admin/terminal/${o.sessionId}/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": o.csrfToken },
        body: JSON.stringify({ cursor }),
        signal: limit.signal,
      });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch {
      // A network error counts as a failed read and is retried.
    } finally {
      clearTimeout(timer);
      o.signal.removeEventListener("abort", cut);
    }
    if (o.signal.aborted) return null;
    const c = classifyRead(status, body);
    if (c.kind === "read") {
      failures = 0;
      lastAnswer = now();
      cursor = c.read.cursor;
      o.onRead(c.read);
      if (o.signal.aborted) return null;
      if (c.read.ended) return { reason: c.read.ended.reason };
      continue;
    }
    if (c.kind === "ended") return { reason: c.reason };
    if (c.kind === "refused") return { status: c.status, body: c.body };
    if (isLost(lastAnswer, now())) return { reason: "lost" };
    o.onRetry();
    await sleep(readRetryDelay(++failures));
  }
  return null;
}
