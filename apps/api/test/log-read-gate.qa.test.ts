import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiExceptionFilter } from "../src/common/api-exception.filter.js";
import { ControlPlaneError } from "../src/common/control-plane.error.js";
import { LOG_READS_MAX, LOG_READS_PER_ORG_MAX, LogReadGate } from "../src/sites/log-read-gate.js";

function deferred(): { promise: Promise<string>; resolve: (v: string) => void; reject: (e: Error) => void } {
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Holds `n` reads of `org` open; returns what is needed to end them. */
function hold(gate: LogReadGate, org: string, n: number) {
  const held = Array.from({ length: n }, () => deferred());
  const reads = held.map((d) => gate.run(org, () => d.promise));
  return { held, reads };
}

async function refused(gate: LogReadGate, org: string): Promise<boolean> {
  try {
    await gate.run(org, async () => "ok");
    return false;
  } catch (err) {
    expect(err).toMatchObject({ code: "RATE_LIMITED" });
    return true;
  }
}

describe("log read gate (M7) edge cases", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exposes the caps of the design: 8 in total, 2 per organisation", () => {
    expect([LOG_READS_MAX, LOG_READS_PER_ORG_MAX]).toEqual([8, 2]);
  });

  it("frees the slot when the read throws synchronously", async () => {
    const gate = new LogReadGate();
    const throwing = (): Promise<string> => {
      throw new Error("sync boom");
    };
    // Two sync throws would fill the per-organisation cap if a throw kept its slot.
    for (let i = 0; i < 5; i += 1) {
      await expect(gate.run("org_a", throwing)).rejects.toThrow("sync boom");
    }
    await expect(gate.run("org_a", async () => "ok")).resolves.toBe("ok");
  });

  it("frees the slot when a hung read ends by the time-out of the executor client", async () => {
    vi.useFakeTimers();
    const gate = new LogReadGate();
    const timedOut = (): Promise<string> =>
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 35_000));
    const settled = [gate.run("org_a", timedOut), gate.run("org_a", timedOut)].map((p) =>
      p.then(
        () => "ok",
        (e: Error) => e.message,
      ),
    );
    // While both hang the organisation is full.
    await vi.advanceTimersByTimeAsync(34_999);
    expect(await refused(gate, "org_a")).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all(settled)).toEqual(["timed out", "timed out"]);
    await expect(gate.run("org_a", async () => "ok")).resolves.toBe("ok");
  });

  it("counts the global cap across organisations: 2 each from 4 organisations refuses a fifth that holds none", async () => {
    const gate = new LogReadGate();
    const all = ["org_1", "org_2", "org_3", "org_4"].map((o) => hold(gate, o, 2));
    const probe = vi.fn(async () => "never");
    await expect(gate.run("org_5", probe)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(probe).not.toHaveBeenCalled();
    // One read ends anywhere: the fifth organisation gets exactly one slot.
    all[2]!.held[0]!.resolve("done");
    await all[2]!.reads[0];
    const fifth = deferred();
    const fifthRead = gate.run("org_5", () => fifth.promise);
    expect(await refused(gate, "org_6")).toBe(true);
    // org_5 is under its own cap (1 of 2) but the global cap is full again.
    expect(await refused(gate, "org_5")).toBe(true);
    fifth.resolve("done");
    await fifthRead;
    for (const a of all) for (const d of a.held) d.resolve("done");
    await Promise.all(all.flatMap((a) => a.reads));
  });

  it("restores exact counts when reads end in any order", async () => {
    const gate = new LogReadGate();
    const a = hold(gate, "org_a", 2);
    const b = hold(gate, "org_b", 2);
    const c = hold(gate, "org_c", 2);
    const d = hold(gate, "org_d", 2);
    // Ends in an order that is neither FIFO nor LIFO, mixing a failure in.
    c.held[1]!.resolve("done");
    a.held[0]!.reject(new Error("boom"));
    d.held[1]!.resolve("done");
    b.held[0]!.resolve("done");
    await Promise.allSettled([c.reads[1]!, a.reads[0]!, d.reads[1]!, b.reads[0]!]);
    // 4 slots are free globally; org_a, b, c and d have 1 each, so each can take exactly one more.
    const more = ["org_a", "org_b", "org_c", "org_d"].map((o) => {
      const h = deferred();
      return { h, p: gate.run(o, () => h.promise) };
    });
    // Now 8 are in flight and every organisation holds 2: nothing more fits anywhere.
    for (const o of ["org_a", "org_b", "org_c", "org_d", "org_e"]) expect(await refused(gate, o)).toBe(true);
    for (const m of more) m.h.resolve("done");
    c.held[0]!.resolve("done");
    a.held[1]!.resolve("done");
    d.held[0]!.resolve("done");
    b.held[1]!.resolve("done");
    await Promise.all([...more.map((m) => m.p), c.reads[0]!, a.reads[1]!, d.reads[0]!, b.reads[1]!]);
    // Fully idle: all 8 slots are back, 2 per organisation.
    const fresh = Array.from({ length: 4 }, (_, i) => hold(gate, `org_${String(i)}`, 2));
    expect(await refused(gate, "org_x")).toBe(true);
    for (const f of fresh) for (const x of f.held) x.resolve("done");
    await Promise.all(fresh.flatMap((f) => f.reads));
  });

  it("does not leak or go negative after 1000 acquire/release cycles of every outcome", async () => {
    const gate = new LogReadGate();
    for (let i = 0; i < 1000; i += 1) {
      const org = `org_${String(i % 7)}`;
      const kind = i % 4;
      const p = gate.run(org, () => {
        if (kind === 0) return Promise.resolve("ok");
        if (kind === 1) return Promise.reject(new Error("rejected"));
        if (kind === 2) throw new Error("thrown");
        return new Promise<string>((res) => setImmediate(() => res("later")));
      });
      await p.catch(() => undefined);
    }
    // Neither counter drifted: the full capacity is available, and not more than it.
    const fresh = Array.from({ length: 4 }, (_, i) => hold(gate, `fresh_${String(i)}`, 2));
    expect(await refused(gate, "fresh_x")).toBe(true);
    for (const f of fresh) for (const x of f.held) x.resolve("done");
    await Promise.all(fresh.flatMap((f) => f.reads));
    const one = hold(gate, "org_0", 2);
    expect(await refused(gate, "org_0")).toBe(true);
    for (const x of one.held) x.resolve("done");
    await Promise.all(one.reads);
  });

  it("keeps no empty per-organisation entry once the last read of an organisation ended", async () => {
    // `#byOrg` is a private field: watch the Map writes whose keys are this test's organisations.
    const tracked = new Set<Map<string, number>>();
    const realSet = Map.prototype.set;
    vi.spyOn(Map.prototype, "set").mockImplementation(function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
      if (typeof k === "string" && k.startsWith("m7qa_") && typeof v === "number") tracked.add(this as Map<string, number>);
      return realSet.call(this, k, v);
    });
    try {
      const gate = new LogReadGate();
      const h = hold(gate, "m7qa_a", 2);
      const other = hold(gate, "m7qa_b", 1);
      expect(await refused(gate, "m7qa_a")).toBe(true);
      expect([...tracked].map((m) => [...m.entries()])).toEqual([
        [
          ["m7qa_a", 2],
          ["m7qa_b", 1],
        ],
      ]);
      h.held[0]!.resolve("done");
      await h.reads[0];
      expect([...tracked][0]!.get("m7qa_a")).toBe(1);
      for (const x of [...h.held.slice(1), ...other.held]) x.resolve("done");
      await Promise.all([...h.reads, ...other.reads]);
      for (let i = 0; i < 20; i += 1) {
        await gate.run(`m7qa_${String(i)}`, async () => "ok");
        await gate.run(`m7qa_${String(i)}`, () => Promise.reject(new Error("x"))).catch(() => undefined);
        await gate.run(`m7qa_${String(i)}`, () => {
          throw new Error("sync");
        }).catch(() => undefined);
      }
      expect(tracked.size).toBe(1);
      expect([...tracked][0]!.size).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("answers RATE_LIMITED as 429 with the standard error envelope and no Retry-After header", async () => {
    const gate = new LogReadGate();
    const h = hold(gate, "org_a", 2);
    const error = await gate.run("org_a", async () => "third").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ControlPlaneError);
    expect(error).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: undefined });

    const headers: Record<string, string> = {};
    let status = 0;
    let body: { error: Record<string, unknown> } = { error: {} };
    const reply = {
      sent: false,
      raw: { headersSent: false },
      header: (k: string, v: string) => {
        headers[k.toLowerCase()] = v;
        return reply;
      },
      status: (s: number) => {
        status = s;
        return reply;
      },
      send: (b: typeof body) => {
        body = b;
      },
    };
    new ApiExceptionFilter().catch(error, {
      switchToHttp: () => ({
        getRequest: () => ({ url: "/x", raw: { url: "/x" }, headers: { "x-request-id": "req-m7" } }),
        getResponse: () => reply,
      }),
    } as never);

    expect(status).toBe(429);
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error).toEqual({
      code: "RATE_LIMITED",
      message: "Too many log reads right now. Try again in a minute.",
      requestId: "req-m7",
      retryable: false,
      details: [],
    });
    // The message says "in a minute"; a header with another number would contradict it, so there is none.
    expect(headers["retry-after"]).toBeUndefined();
    expect(headers["x-request-id"]).toBe("req-m7");
    for (const x of h.held) x.resolve("done");
    await Promise.all(h.reads);
  });
});
