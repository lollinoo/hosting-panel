import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PANEL_DUMP_MAX_OUTPUT_BYTES,
  PANEL_DUMP_TIMEOUT_MS,
  PG_DUMP_PATH,
  PanelDumpError,
  buildPanelDumpCommand,
  runPanelDump,
} from "../src/backups/panel-dump.js";

const OUT = "/var/lib/hosting-panel/panel-dump/op_00000000000000000000000000000001.dump";
const ARGS = ["--format=custom", "--compress=none", "--no-password", "--file", OUT];
const BASE_ENV = { LC_ALL: "C", PGCONNECT_TIMEOUT: "10", PGAPPNAME: "hp-panel-backup" };

describe("buildPanelDumpCommand", () => {
  it("TCP URL: fixed path, fixed arguments, credentials only in an environment built from nothing", () => {
    process.env.HP_CANARY_PARENT_VAR = "must-not-leak";
    try {
      const cmd = buildPanelDumpCommand(
        "postgresql://hosting_panel:s3cret@db.internal:6543/hosting_panel?sslmode=require",
        OUT,
      );
      expect(PG_DUMP_PATH).toBe("/usr/lib/postgresql/18/bin/pg_dump");
      expect(cmd.args).toEqual(ARGS);
      expect(cmd.env).toEqual({
        ...BASE_ENV,
        PGHOST: "db.internal",
        PGPORT: "6543",
        PGUSER: "hosting_panel",
        PGPASSWORD: "s3cret",
        PGDATABASE: "hosting_panel",
        PGSSLMODE: "require",
      });
      expect(JSON.stringify(cmd.args)).not.toContain("s3cret");
    } finally {
      delete process.env.HP_CANARY_PARENT_VAR;
    }
  });

  it("socket URL with @/ and a host query value", () => {
    const cmd = buildPanelDumpCommand("postgresql://u:p@/panel?host=/run/postgresql", OUT);
    expect(cmd.env).toEqual({
      ...BASE_ENV,
      PGHOST: "/run/postgresql",
      PGUSER: "u",
      PGPASSWORD: "p",
      PGDATABASE: "panel",
    });
  });

  it("socket URL with a percent-encoded host", () => {
    const cmd = buildPanelDumpCommand("postgres://u@%2Frun%2Fpostgresql/panel", OUT);
    expect(cmd.env).toEqual({ ...BASE_ENV, PGHOST: "/run/postgresql", PGUSER: "u", PGDATABASE: "panel" });
  });

  it("decodes special characters in user, password and database", () => {
    const pw = "p@ss/w:rd%?#& x";
    const cmd = buildPanelDumpCommand(
      `postgresql://us%40er:${encodeURIComponent(pw)}@127.0.0.1/my%20db`,
      OUT,
    );
    expect(cmd.env).toMatchObject({ PGUSER: "us@er", PGPASSWORD: pw, PGDATABASE: "my db" });
    expect(cmd.args).toEqual(ARGS);
  });

  it("keeps a known sslmode and refuses an unknown one or another protocol", () => {
    expect(buildPanelDumpCommand("postgresql://u@h/d?sslmode=verify-full", OUT).env.PGSSLMODE).toBe(
      "verify-full",
    );
    expect(() => buildPanelDumpCommand("postgresql://u@h/d?sslmode=bogus", OUT)).toThrow(PanelDumpError);
    expect(() => buildPanelDumpCommand("mysql://u@h/d", OUT)).toThrow(PanelDumpError);
  });
});

describe("runPanelDump", () => {
  let dir: string;
  let out: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hp-panel-dump-"));
    out = join(dir, "op_x.dump");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs execFile on the fixed path with the limits and no shell", async () => {
    const cmd = buildPanelDumpCommand("postgresql://u:pw@h/d", out);
    const calls: unknown[][] = [];
    await runPanelDump(cmd, async (...a: unknown[]) => {
      calls.push(a);
    });
    expect(calls).toEqual([
      [
        PG_DUMP_PATH,
        cmd.args,
        {
          env: cmd.env,
          timeout: PANEL_DUMP_TIMEOUT_MS,
          maxBuffer: PANEL_DUMP_MAX_OUTPUT_BYTES,
          killSignal: "SIGKILL",
          shell: false,
        },
      ],
    ]);
    expect(PANEL_DUMP_TIMEOUT_MS).toBe(30 * 60_000);
    expect(PANEL_DUMP_MAX_OUTPUT_BYTES).toBe(64 * 1024);
  });

  it("starts PG_DUMP_PATH even when the command carries another program", async () => {
    const forged = { ...buildPanelDumpCommand("postgresql://u:pw@h/d", out), file: "/bin/sh" };
    const files: unknown[] = [];
    await runPanelDump(forged, async (file: unknown) => {
      files.push(file);
    });
    expect(files).toEqual([PG_DUMP_PATH]);
  });

  const cases: [string, Record<string, unknown>, string, string][] = [
    ["absent tool", { code: "ENOENT" }, "tool_missing", "panel_dump_tool_missing"],
    ["non-zero exit", { code: 1 }, "exit", "panel_dump_failed"],
    ["time limit", { killed: true, signal: "SIGKILL", code: null }, "timeout", "panel_dump_failed"],
    ["output cap", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "output_cap", "panel_dump_failed"],
  ];
  for (const [name, fault, reason, problem] of cases) {
    it(`${name}: maps to ${problem} and removes the partial file`, async () => {
      const cmd = buildPanelDumpCommand("postgresql://u:pw@h/d", out);
      const err = await runPanelDump(cmd, async () => {
        await writeFile(out, "partial");
        throw Object.assign(new Error("pg_dump: connection to server at h failed for user u"), fault);
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PanelDumpError);
      expect(err).toMatchObject({ reason, problem });
      // pg_dump's own output never travels in the error.
      expect((err as Error).message).not.toContain("connection");
      expect(await readdir(dir)).toEqual([]);
    });
  }
});
