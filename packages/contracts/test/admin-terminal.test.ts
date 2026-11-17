import { describe, expect, it } from "vitest";
import {
  OpenTerminalInputSchema,
  PanelContainerRestartIpcRequestSchema,
  ReadTerminalInputSchema,
  RestartInputSchema,
  TERMINAL_END_REASONS,
  TERMINAL_EXECUTOR_END_REASONS,
  TERMINAL_IDLE_MS,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_OUTPUT_KEPT_BYTES,
  TERMINAL_READ_WAIT_MS,
  TERMINAL_SESSION_ID_PATTERN,
  TERMINAL_SESSION_MAX_MS,
  TERMINAL_SESSIONS_MAX,
  TerminalEndedSchema,
  TerminalReadDtoSchema,
  TerminalReadIpcRequestSchema,
  TerminalSessionDtoSchema,
  TerminalSessionIdSchema,
  TerminalWriteIpcRequestSchema,
  WriteTerminalInputSchema,
} from "../src/index.js";

const SESSION_ID = `term_${"ab12".repeat(8)}`;
const AT = "2026-11-17T10:00:00.000Z";

describe("admin terminal contract", () => {
  it("pins the limits of D17", () => {
    expect(TERMINAL_SESSIONS_MAX).toBe(4);
    expect(TERMINAL_SESSION_MAX_MS).toBe(30 * 60_000);
    expect(TERMINAL_IDLE_MS).toBe(60_000);
    expect(TERMINAL_INPUT_MAX_BYTES).toBe(4096);
    expect(TERMINAL_OUTPUT_KEPT_BYTES).toBe(256 * 1024);
    expect(TERMINAL_READ_WAIT_MS).toBe(20_000);
    expect(TERMINAL_EXECUTOR_END_REASONS.every((r) => TERMINAL_END_REASONS.includes(r))).toBe(true);
  });

  it("takes a six-digit code only", () => {
    expect(OpenTerminalInputSchema.safeParse({ code: "123456" }).success).toBe(true);
    for (const code of ["12345", "1234567", "12a456"]) {
      expect(OpenTerminalInputSchema.safeParse({ code }).success).toBe(false);
    }
  });

  it("matches the session id pattern only", () => {
    expect(TERMINAL_SESSION_ID_PATTERN.test(SESSION_ID)).toBe(true);
    expect(TerminalSessionIdSchema.safeParse(SESSION_ID).success).toBe(true);
    expect(TerminalSessionIdSchema.safeParse(SESSION_ID.toUpperCase().replace("TERM_", "term_")).success).toBe(false);
    expect(TerminalSessionIdSchema.safeParse(SESSION_ID.slice(0, -1)).success).toBe(false);
  });

  it("limits input to 4096 UTF-8 bytes with a fixed message", () => {
    expect(WriteTerminalInputSchema.safeParse({ input: "a".repeat(4096) }).success).toBe(true);
    expect(WriteTerminalInputSchema.safeParse({ input: "a".repeat(4097) }).success).toBe(false);
    expect(WriteTerminalInputSchema.safeParse({ input: "€".repeat(1366) }).success).toBe(false);
    expect(WriteTerminalInputSchema.safeParse({ input: "" }).success).toBe(false);
    const refused = WriteTerminalInputSchema.safeParse({ input: "Z".repeat(4097) });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe("Input longer than 4096 bytes");
  });

  it("refuses a negative or fractional cursor", () => {
    expect(ReadTerminalInputSchema.safeParse({ cursor: 0 }).success).toBe(true);
    expect(ReadTerminalInputSchema.safeParse({ cursor: -1 }).success).toBe(false);
    expect(ReadTerminalInputSchema.safeParse({ cursor: 1.5 }).success).toBe(false);
  });

  it("keeps every DTO strict", () => {
    const session = { sessionId: SESSION_ID, siteId: "site_1", containerName: "hp_svc_svc_1", openedAt: AT, expiresAt: AT };
    expect(TerminalSessionDtoSchema.safeParse(session).success).toBe(true);
    expect(TerminalSessionDtoSchema.safeParse({ ...session, extra: 1 }).success).toBe(false);
    const read = { output: "", cursor: 0, dropped: false, ended: { reason: "closed", at: AT } };
    expect(TerminalReadDtoSchema.safeParse(read).success).toBe(true);
    expect(TerminalReadDtoSchema.safeParse({ ...read, extra: 1 }).success).toBe(false);
    expect(TerminalEndedSchema.safeParse({ reason: "closed", at: AT, extra: 1 }).success).toBe(false);
    expect(OpenTerminalInputSchema.safeParse({ code: "123456", extra: 1 }).success).toBe(false);
    expect(WriteTerminalInputSchema.safeParse({ input: "a", extra: 1 }).success).toBe(false);
    expect(ReadTerminalInputSchema.safeParse({ cursor: 0, extra: 1 }).success).toBe(false);
  });
});

describe("restart reason", () => {
  it("trims, needs 1 to 500 characters and refuses extra keys", () => {
    expect(RestartInputSchema.parse({ reason: "  disk full  " })).toEqual({ reason: "disk full" });
    expect(RestartInputSchema.safeParse({ reason: "   " }).success).toBe(false);
    expect(RestartInputSchema.safeParse({ reason: "x".repeat(500) }).success).toBe(true);
    expect(RestartInputSchema.safeParse({ reason: "x".repeat(501) }).success).toBe(false);
    expect(RestartInputSchema.safeParse({ reason: "ok", extra: 1 }).success).toBe(false);
  });
});

describe("terminal IPC schemas", () => {
  it("never echoes refused input in the error", () => {
    const canary = "HPCANARY".repeat(513);
    const refused = TerminalWriteIpcRequestSchema.safeParse({ sessionId: SESSION_ID, input: canary });
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.error)).not.toContain("HPCANARY");
    expect(refused.error?.issues[0]?.message).toBe("Input longer than 4096 bytes");
  });

  it("refuses a bad session id and cursor", () => {
    expect(TerminalReadIpcRequestSchema.safeParse({ sessionId: SESSION_ID, cursor: 0 }).success).toBe(true);
    expect(TerminalReadIpcRequestSchema.safeParse({ sessionId: "term_x", cursor: 0 }).success).toBe(false);
    expect(TerminalReadIpcRequestSchema.safeParse({ sessionId: SESSION_ID, cursor: -1 }).success).toBe(false);
  });

  it("restarts only one of the five panel containers", () => {
    expect(PanelContainerRestartIpcRequestSchema.safeParse({ component: "sftp" }).success).toBe(true);
    expect(PanelContainerRestartIpcRequestSchema.safeParse({ component: "hp_api" }).success).toBe(false);
    expect(PanelContainerRestartIpcRequestSchema.safeParse({ component: "sftp", extra: 1 }).success).toBe(false);
  });
});
