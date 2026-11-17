import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_ENDED_KEPT_MS,
  TerminalSessions,
  incompleteUtf8Tail,
  type TerminalShell,
  type TerminalShellSink,
} from "../src/terminal-sessions.js";

const ID = (n: number) => `term_${String(n).padStart(32, "0")}`;

interface Fake {
  sink: TerminalShellSink;
  written: string[];
  kills: number;
  failKills: number; // the first kills that do not work
}

function fakeStart(fakes: Fake[], containerName = "hp_svc_svc_1") {
  return async (sink: TerminalShellSink): Promise<{ shell: TerminalShell; containerName: string }> => {
    const fake: Fake = { sink, written: [], kills: 0, failKills: 0 };
    fakes.push(fake);
    return {
      containerName,
      shell: {
        write: (bytes) => { fake.written.push(bytes.toString("utf8")); },
        kill: async () => (fake.kills += 1) > fake.failKills,
      },
    };
  };
}

async function openOne(terms: TerminalSessions, n = 1, site = `site_${n}`) {
  const fakes: Fake[] = [];
  const result = await terms.open({ sessionId: ID(n), siteId: site, serviceInstanceId: `svc_${n}` }, fakeStart(fakes));
  return { fake: fakes[0]!, result };
}

const code = (p: Promise<unknown>) => p.then(() => "resolved", (e: { code?: string }) => e.code);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("TerminalSessions output and cursor", () => {
  it("counts the cursor in bytes and repeats a read from the same cursor", async () => {
    const terms = new TerminalSessions();
    const { fake, result } = await openOne(terms);
    expect(result.containerName).toBe("hp_svc_svc_1");
    fake.sink.data(Buffer.from("é$ ", "utf8"));
    const first = await terms.read({ sessionId: ID(1), cursor: 0 });
    expect(first).toEqual({ output: "é$ ", cursor: 4, dropped: false, ended: null });
    expect(await terms.read({ sessionId: ID(1), cursor: 0 })).toEqual(first);
    expect((await terms.read({ sessionId: ID(1), cursor: 2 })).output).toBe("$ ");
  });

  it("never cuts a character of several bytes and turns bad bytes into U+FFFD", async () => {
    const terms = new TerminalSessions();
    const { fake } = await openOne(terms);
    const euro = Buffer.from("€", "utf8");
    fake.sink.data(Buffer.concat([Buffer.from("a"), euro.subarray(0, 2)]));
    expect(await terms.read({ sessionId: ID(1), cursor: 0 })).toMatchObject({ output: "a", cursor: 1 });
    fake.sink.data(Buffer.concat([euro.subarray(2), Buffer.from([0xff]), Buffer.from("b")]));
    expect(await terms.read({ sessionId: ID(1), cursor: 1 })).toMatchObject({ output: "€�b", cursor: 6 });
  });

  it("decodes an unfinished tail once the session has ended", async () => {
    const terms = new TerminalSessions();
    const { fake } = await openOne(terms);
    fake.sink.data(Buffer.from([0x61, 0xe2, 0x82]));
    fake.sink.exit("shell_exited");
    const read = await terms.read({ sessionId: ID(1), cursor: 0 });
    expect(read.output.startsWith("a")).toBe(true);
    expect(read.output).toContain("�");
    expect(read.cursor).toBe(3);
    expect(read.ended?.reason).toBe("shell_exited");
  });

  it("gives dropped past the kept window and skips leading continuation bytes", async () => {
    const terms = new TerminalSessions({ keptBytes: 8 });
    const { fake } = await openOne(terms);
    fake.sink.data(Buffer.from("abc€€", "utf8")); // 9 bytes: the first byte falls out
    const read = await terms.read({ sessionId: ID(1), cursor: 0 });
    expect(read).toMatchObject({ output: "bc€€", cursor: 9, dropped: true });
    fake.sink.data(Buffer.from("€", "utf8")); // 12 bytes: "abc" and the lead byte of the first € fall out
    expect(await terms.read({ sessionId: ID(1), cursor: 0 })).toMatchObject({ output: "€€", cursor: 12, dropped: true });
  });

  it("refuses a cursor beyond the end with VALIDATION_ERROR", async () => {
    const terms = new TerminalSessions();
    const { fake } = await openOne(terms);
    fake.sink.data(Buffer.from("ab"));
    expect(await code(terms.read({ sessionId: ID(1), cursor: 3 }))).toBe("VALIDATION_ERROR");
  });

  it("incompleteUtf8Tail counts only an unfinished character", () => {
    const euro = Buffer.from("€", "utf8");
    expect(incompleteUtf8Tail(Buffer.from("a"))).toBe(0);
    expect(incompleteUtf8Tail(euro)).toBe(0);
    expect(incompleteUtf8Tail(euro.subarray(0, 1))).toBe(1);
    expect(incompleteUtf8Tail(euro.subarray(0, 2))).toBe(2);
  });
});

describe("TerminalSessions long poll", () => {
  it("answers a waiting read when data arrives", async () => {
    const terms = new TerminalSessions();
    const { fake } = await openOne(terms);
    const pending = terms.read({ sessionId: ID(1), cursor: 0 });
    fake.sink.data(Buffer.from("x"));
    expect(await pending).toMatchObject({ output: "x", cursor: 1 });
  });

  it("answers a waiting read empty at the wait limit", async () => {
    const terms = new TerminalSessions({ readWaitMs: 1000 });
    await openOne(terms);
    let done = false;
    const pending = terms.read({ sessionId: ID(1), cursor: 0 }).finally(() => { done = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ output: "", cursor: 0, dropped: false, ended: null });
  });

  it("answers a waiting read on the end", async () => {
    const terms = new TerminalSessions();
    const { fake } = await openOne(terms);
    const pending = terms.read({ sessionId: ID(1), cursor: 0 });
    fake.sink.exit("container_gone");
    expect((await pending).ended?.reason).toBe("container_gone");
  });

  it("a newer read answers the older one at once, empty at its own cursor", async () => {
    const terms = new TerminalSessions();
    const { fake } = await openOne(terms);
    fake.sink.data(Buffer.from("ab"));
    const older = terms.read({ sessionId: ID(1), cursor: 2 });
    const newer = terms.read({ sessionId: ID(1), cursor: 2 });
    expect(await older).toEqual({ output: "", cursor: 2, dropped: false, ended: null });
    fake.sink.data(Buffer.from("c"));
    expect(await newer).toMatchObject({ output: "c", cursor: 3 });
  });
});

describe("TerminalSessions timers", () => {
  it("ends an idle session as idle, kills once, and a read resets the idle clock", async () => {
    const terms = new TerminalSessions({ idleMs: 1000, readWaitMs: 10 });
    const { fake } = await openOne(terms);
    await vi.advanceTimersByTimeAsync(900);
    const waiting = terms.read({ sessionId: ID(1), cursor: 0 });
    await vi.advanceTimersByTimeAsync(10);
    await waiting;
    await vi.advanceTimersByTimeAsync(900);
    expect(terms.list()[0]?.ended).toBeNull();
    await vi.advanceTimersByTimeAsync(200);
    expect(terms.list()[0]?.ended?.reason).toBe("idle");
    expect(fake.kills).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.kills).toBe(1);
  });

  it("ends a session at the time limit and kills once", async () => {
    const terms = new TerminalSessions({ sessionMaxMs: 5000, idleMs: 60_000 });
    const { fake } = await openOne(terms);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await terms.read({ sessionId: ID(1), cursor: 0 })).ended?.reason).toBe("time_limit");
    expect(fake.kills).toBe(1);
  });

  it("keeps an ended record ten minutes, and a close on it returns its reason and drops it", async () => {
    expect(TERMINAL_ENDED_KEPT_MS).toBe(600_000);
    const terms = new TerminalSessions();
    const one = await openOne(terms, 1);
    const two = await openOne(terms, 2);
    one.fake.sink.exit("shell_exited");
    two.fake.sink.exit("shell_exited");
    const ended = await terms.close({ sessionId: ID(1) });
    expect(ended.reason).toBe("shell_exited");
    expect(one.fake.kills).toBe(1); // the end's kill worked: the close does not kill again
    expect(await code(terms.read({ sessionId: ID(1), cursor: 0 }))).toBe("NOT_FOUND");
    await vi.advanceTimersByTimeAsync(TERMINAL_ENDED_KEPT_MS - 1);
    expect(terms.list().map((r) => r.sessionId)).toEqual([ID(2)]);
    await vi.advanceTimersByTimeAsync(1);
    expect(terms.list()).toEqual([]);
  });

  it("close on a live session kills once and returns closed", async () => {
    const terms = new TerminalSessions();
    const { fake } = await openOne(terms);
    const pending = terms.read({ sessionId: ID(1), cursor: 0 });
    expect((await terms.close({ sessionId: ID(1) })).reason).toBe("closed");
    expect((await pending).ended?.reason).toBe("closed");
    expect(fake.kills).toBe(1);
    expect(terms.list()).toEqual([]);
  });
});

describe("TerminalSessions when a kill does not work", () => {
  it("keeps the record, kills again on the next close, and frees the site and the slot meanwhile", async () => {
    const terms = new TerminalSessions({ maxSessions: 2 });
    const one = await openOne(terms, 1, "site_a");
    one.fake.failKills = 1;
    const first = await terms.close({ sessionId: ID(1) });
    expect(first.reason).toBe("closed");
    expect(one.fake.kills).toBe(1);
    expect(terms.list().map((r) => [r.sessionId, r.ended?.reason])).toEqual([[ID(1), "closed"]]);
    await openOne(terms, 2, "site_a");
    await openOne(terms, 3, "site_b");
    expect(await code(openOne(terms, 4, "site_c"))).toBe("QUOTA_EXCEEDED");
    expect(await terms.close({ sessionId: ID(1) })).toEqual(first);
    expect(one.fake.kills).toBe(2);
    expect(terms.list().map((r) => r.sessionId)).toEqual([ID(2), ID(3)]);
  });

  it("drops the record after the kept time and logs one line with only the event and a code", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    const terms = new TerminalSessions({ idleMs: 1000 });
    const { fake } = await openOne(terms);
    fake.failKills = Infinity;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await terms.close({ sessionId: ID(1) })).toMatchObject({ reason: "idle" });
    expect(fake.kills).toBe(2);
    await vi.advanceTimersByTimeAsync(TERMINAL_ENDED_KEPT_MS - 1);
    expect(terms.list()).toHaveLength(1);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(terms.list()).toEqual([]);
    expect(lines.map((l) => { const { timestamp, ...rest } = JSON.parse(l) as Record<string, unknown>; return [typeof timestamp, rest]; }))
      .toEqual([["string", { component: "hp-docker-executor", event: "terminal_kill_failed", code: "INTERNAL_ERROR" }]]);
    vi.restoreAllMocks();
  });

  it("a shell that exited by itself: its kill failed, the first close keeps the record, the second kills again and drops it", async () => {
    const terms = new TerminalSessions();
    const { fake } = await openOne(terms);
    fake.failKills = 1;
    fake.sink.exit("shell_exited");
    expect(fake.kills).toBe(1);
    expect((await terms.close({ sessionId: ID(1) })).reason).toBe("shell_exited");
    expect(fake.kills).toBe(1); // the close waited for the end's kill rather than run a second one
    expect(terms.list().map((r) => r.sessionId)).toEqual([ID(1)]);
    expect((await terms.close({ sessionId: ID(1) })).reason).toBe("shell_exited");
    expect(fake.kills).toBe(2);
    expect(terms.list()).toEqual([]);
  });

  it("a shell that exited by itself and is never killed: one log line after the kept time", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    const terms = new TerminalSessions();
    const { fake } = await openOne(terms);
    fake.failKills = Infinity;
    fake.sink.exit("shell_exited");
    await vi.advanceTimersByTimeAsync(TERMINAL_ENDED_KEPT_MS - 1);
    expect(terms.list()).toHaveLength(1);
    expect(lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(terms.list()).toEqual([]);
    expect(fake.kills).toBe(1);
    expect(lines.map((l) => (JSON.parse(l) as Record<string, unknown>).event)).toEqual(["terminal_kill_failed"]);
    vi.restoreAllMocks();
  });
});

describe("TerminalSessions limits and refusals", () => {
  it("allows one session per site and four on the server, not counting ended ones", async () => {
    const terms = new TerminalSessions();
    const one = await openOne(terms, 1, "site_a");
    expect(await code(openOne(terms, 2, "site_a"))).toBe("RESOURCE_LOCKED");
    await openOne(terms, 3, "site_b");
    await openOne(terms, 4, "site_c");
    await openOne(terms, 5, "site_d");
    expect(await code(openOne(terms, 6, "site_e"))).toBe("QUOTA_EXCEEDED");
    one.fake.sink.exit("shell_exited");
    await openOne(terms, 7, "site_a");
    expect(terms.list()).toHaveLength(5);
  });

  it("takes the slot before the first await, so concurrent opens cannot pass the limit", async () => {
    const terms = new TerminalSessions({ maxSessions: 2 });
    const results = await Promise.all([
      code(openOne(terms, 1, "site_a")),
      code(openOne(terms, 2, "site_a")),
      code(openOne(terms, 3, "site_b")),
      code(openOne(terms, 4, "site_c")),
    ]);
    expect(results).toEqual(["resolved", "RESOURCE_LOCKED", "resolved", "QUOTA_EXCEEDED"]);
  });

  it("gives the slot back when start fails", async () => {
    const terms = new TerminalSessions({ maxSessions: 1 });
    const failing = terms.open({ sessionId: ID(1), siteId: "site_a", serviceInstanceId: "svc_1" }, async () => {
      throw Object.assign(new Error("gone"), { code: "NOT_FOUND" });
    });
    expect(await code(failing)).toBe("NOT_FOUND");
    expect(terms.list()).toEqual([]);
    await openOne(terms, 1, "site_a");
  });

  it("answers ALREADY_EXISTS on a known id, NOT_FOUND on an unknown one, OPERATION_INTERRUPTED on an ended one", async () => {
    const terms = new TerminalSessions();
    const { fake } = await openOne(terms, 1);
    expect(await code(openOne(terms, 1, "site_other"))).toBe("ALREADY_EXISTS");
    expect(() => terms.write({ sessionId: ID(9), input: "x" })).toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(await code(terms.read({ sessionId: ID(9), cursor: 0 }))).toBe("NOT_FOUND");
    expect(await code(terms.close({ sessionId: ID(9) }))).toBe("NOT_FOUND");
    terms.write({ sessionId: ID(1), input: "ls\r" });
    expect(fake.written).toEqual(["ls\r"]);
    fake.sink.exit("shell_exited");
    expect(() => terms.write({ sessionId: ID(1), input: "x" })).toThrow(expect.objectContaining({ code: "OPERATION_INTERRUPTED" }));
  });

  it("refuses an input over 4096 bytes with a fixed message", async () => {
    const terms = new TerminalSessions();
    await openOne(terms);
    const input = "é".repeat(2049);
    let caught: { code?: string; message?: string } = {};
    try { terms.write({ sessionId: ID(1), input }); } catch (e) { caught = e as typeof caught; }
    expect(caught.code).toBe("VALIDATION_ERROR");
    expect(caught.message).toBe("Input longer than 4096 bytes");
  });

  it("endService ends that service's sessions and kills them; forgetAll drops every record", async () => {
    const terms = new TerminalSessions();
    const one = await openOne(terms, 1);
    const two = await openOne(terms, 2);
    terms.endService("svc_1", "container_gone");
    expect(terms.list().map((r) => [r.sessionId, r.ended?.reason ?? null])).toEqual([[ID(1), "container_gone"], [ID(2), null]]);
    expect(one.fake.kills).toBe(1);
    expect(two.fake.kills).toBe(0);
    const pending = terms.read({ sessionId: ID(2), cursor: 0 });
    terms.forgetAll();
    expect(await code(pending)).toBe("NOT_FOUND");
    expect(terms.list()).toEqual([]);
    await openOne(terms, 3, "site_1");
  });

  it("kills a shell whose start finishes after its session was ended", async () => {
    const terms = new TerminalSessions();
    const fakes: Fake[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const start = fakeStart(fakes);
    const opening = terms.open({ sessionId: ID(1), siteId: "site_1", serviceInstanceId: "svc_1" }, async (sink) => {
      await gate;
      return start(sink);
    });
    terms.endService("svc_1", "container_gone");
    release();
    await opening.catch(() => undefined);
    expect(fakes[0]?.kills).toBe(1);
  });
});
