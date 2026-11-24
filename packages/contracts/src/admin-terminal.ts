import { z } from "zod";
import { AppStackKeySchema } from "./app-templates/limits.js";
import { AppEntityIdSchema } from "./app-templates/stack-ids.js";

export const TERMINAL_SESSIONS_MAX = 4; // sites and applications together; one per container is a rule, enforced in the repository
export const TERMINAL_SESSION_MAX_MS = 30 * 60_000;
export const TERMINAL_IDLE_MS = 60_000;
export const TERMINAL_INPUT_MAX_BYTES = 4096;
export const TERMINAL_OUTPUT_KEPT_BYTES = 256 * 1024;
export const TERMINAL_READ_WAIT_MS = 20_000;

// not_started and executor_gone are written only by the API.
export const TERMINAL_END_REASONS = ["closed", "shell_exited", "idle", "time_limit", "container_gone", "executor_gone", "not_started"] as const;
export type TerminalEndReason = (typeof TERMINAL_END_REASONS)[number];
export const TERMINAL_REFUSALS = ["container_down", "site_changing", "site_busy", "server_full", "session_ended"] as const;
export type TerminalRefusal = (typeof TERMINAL_REFUSALS)[number];
export const TERMINAL_DENIALS = ["code_missing", "code_wrong", "code_used", "locked", "totp_not_enrolled"] as const;

const Iso = z.string().datetime({ offset: true });
export const TERMINAL_SESSION_ID_PATTERN = /^term_[0-9a-f]{32}$/;
export const TerminalSessionIdSchema = z.string().regex(TERMINAL_SESSION_ID_PATTERN);

export const OpenTerminalInputSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const WriteTerminalInputSchema = z.object({
  input: z.string().min(1).refine(
    (s) => new TextEncoder().encode(s).length <= TERMINAL_INPUT_MAX_BYTES,
    `Input longer than ${TERMINAL_INPUT_MAX_BYTES} bytes`,
  ),
}).strict();
export const ReadTerminalInputSchema = z.object({ cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();

export const TerminalSessionDtoSchema = z.object({
  sessionId: TerminalSessionIdSchema, siteId: z.string(), containerName: z.string(), openedAt: Iso, expiresAt: Iso,
}).strict();
/** A session open in one component of an application (ADR-0041); the site DTO above does not change. */
export const AppTerminalSessionDtoSchema = z.object({
  sessionId: TerminalSessionIdSchema, stackId: AppEntityIdSchema, componentKey: AppStackKeySchema,
  containerName: z.string(), openedAt: Iso, expiresAt: Iso,
}).strict();
export const TerminalEndedSchema = z.object({ reason: z.enum(TERMINAL_END_REASONS), at: Iso }).strict();
export const TerminalReadDtoSchema = z.object({
  output: z.string(), cursor: z.number().int().min(0), dropped: z.boolean(), ended: TerminalEndedSchema.nullable(),
}).strict();
export type TerminalSessionDto = z.infer<typeof TerminalSessionDtoSchema>;
export type AppTerminalSessionDto = z.infer<typeof AppTerminalSessionDtoSchema>;
export type TerminalReadDto = z.infer<typeof TerminalReadDtoSchema>;
