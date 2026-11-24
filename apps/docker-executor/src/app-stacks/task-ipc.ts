import {
  AppStackTaskReadIpcRequestSchema,
  AppStackTaskRunIpcRequestSchema,
  type AppStackTaskReadIpcRequest,
} from "@hosting-panel/contracts";
import { isStackTaskExecutor, type StackTaskExecutorPort } from "@hosting-panel/executor-contracts";
import type { z } from "zod";
import { ExecutorCodedError } from "../traefik-config.js";

/** POST, the body is the run request: answered when the command ended, or at its time limit. */
export const APP_STACK_TASK_RUN_PATH = "/v1/app-stacks/tasks/run";
/**
 * What the caller waits beyond the time limit of a run before it calls the answer lost: the checks, the clean-up
 * before and after the command, and reading how it ended.
 */
export const APP_STACK_TASK_RUN_MARGIN_MS = 120_000;
export const APP_STACK_TASK_READ_TIMEOUT_MS = 15_000;

const READ_PATH = /^\/v1\/app-stacks\/([^/]+)\/task-runs\/([^/]+)$/;

/** GET: how a run went. A read, so a caller that got no answer may simply ask again. */
export function appStackTaskReadPath(req: AppStackTaskReadIpcRequest): string {
  const query = new URLSearchParams({ organizationId: req.organizationId });
  return `/v1/app-stacks/${encodeURIComponent(req.stackId)}/task-runs/${encodeURIComponent(req.runId)}?${query.toString()}`;
}

function parse<S extends z.ZodType>(schema: S, value: unknown, what: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw new ExecutorCodedError(
    issue ? `Invalid application task ${what} payload: ${issue.message}` : `Invalid application task ${what} payload`,
    "VALIDATION_ERROR",
  );
}

function jsonBody(rawBody: Buffer): unknown {
  const text = rawBody.toString("utf8").trim();
  if (text.length === 0) throw new ExecutorCodedError("Request JSON body must not be empty", "VALIDATION_ERROR");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ExecutorCodedError("Malformed JSON request body", "VALIDATION_ERROR");
  }
}

/** A malformed escape stays as sent and fails the id pattern. */
function segment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The task routes of the executor's IPC server (ADR-0042); null = not one of them. Tasks are an optional port of
 * their own, so they are answered before the application routes: capability, then a strict parse, then one port call.
 */
export function appStackTaskIpcRoute(
  method: string,
  pathname: string,
  parsedUrl: URL,
  rawBody: Buffer,
): ((executor: unknown) => Promise<unknown>) | null {
  let call: ((tasks: StackTaskExecutorPort) => Promise<unknown>) | null = null;
  if (method === "POST" && pathname === APP_STACK_TASK_RUN_PATH) {
    call = (tasks) => tasks.runAppStackTask(parse(AppStackTaskRunIpcRequestSchema, jsonBody(rawBody), "run"));
  } else if (method === "GET") {
    const read = READ_PATH.exec(pathname);
    if (read?.[1] !== undefined && read[2] !== undefined) {
      // A name given twice reaches the schema as an array, which it refuses.
      const given = parsedUrl.searchParams.getAll("organizationId");
      const value = {
        stackId: segment(read[1]),
        runId: segment(read[2]),
        organizationId: given.length > 1 ? given : (given[0] ?? null),
      };
      call = (tasks) => tasks.getAppStackTaskRun(parse(AppStackTaskReadIpcRequestSchema, value, "read"));
    }
  }
  if (call === null) return null;
  const route = call;
  return async (executor) => {
    if (!isStackTaskExecutor(executor)) {
      throw new ExecutorCodedError("Application tasks are not supported by the active executor backend", "NOT_SUPPORTED");
    }
    return route(executor);
  };
}
