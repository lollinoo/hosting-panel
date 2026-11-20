import { describe, expect, it } from "vitest";
import { LogReadGate } from "../src/sites/log-read-gate.js";

function deferred(): { promise: Promise<string>; resolve: (v: string) => void; reject: (e: Error) => void } {
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("log read gate (M7)", () => {
  it("refuses the ninth read in flight with RATE_LIMITED and frees the slot when a read ends", async () => {
    const gate = new LogReadGate();
    const held = Array.from({ length: 8 }, () => deferred());
    const reads = held.map((d, i) => gate.run(`org_${String(i)}`, () => d.promise));
    await expect(gate.run("org_9", async () => "ninth")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    held[0]!.resolve("done");
    await expect(reads[0]).resolves.toBe("done");
    await expect(gate.run("org_9", async () => "ninth")).resolves.toBe("ninth");
    for (const d of held) d.resolve("done");
    await Promise.all(reads);
  });

  it("refuses the third read of one organisation while another organisation still reads", async () => {
    const gate = new LogReadGate();
    const held = [deferred(), deferred()];
    const reads = held.map((d) => gate.run("org_a", () => d.promise));
    await expect(gate.run("org_a", async () => "third")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(gate.run("org_b", async () => "other")).resolves.toBe("other");
    for (const d of held) d.resolve("done");
    await Promise.all(reads);
    await expect(gate.run("org_a", async () => "again")).resolves.toBe("again");
  });

  it("frees the slot when the read throws", async () => {
    const gate = new LogReadGate();
    const held = deferred();
    const first = gate.run("org_a", () => held.promise);
    await expect(gate.run("org_a", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(gate.run("org_a", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(gate.run("org_a", async () => "ok")).resolves.toBe("ok");
    held.resolve("done");
    await first;
  });
});
