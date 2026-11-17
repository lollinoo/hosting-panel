import { describe, expect, it } from "vitest";
import { selectExpired, type RetentionRow } from "../src/backups/backup-retention.js";

const NOW = new Date("2026-11-15T03:00:00Z");
const DAY_MS = 86_400_000;
const RETENTION_DAYS = 14;

function daysAgo(days: number, offsetMs = 0): Date {
  return new Date(NOW.getTime() - days * DAY_MS + offsetMs);
}

// Good copies newer than any tested row, so that row is outside the newest retentionDays (R207 restore.3).
function newerCopies(count: number): RetentionRow[] {
  return Array.from({ length: count }, (_, n) => makeRow({ id: `bak_fill${String(n)}`, startedAt: daysAgo(0, -(n + 1) * 1_000) }));
}

function makeRow(overrides: Partial<RetentionRow> & Pick<RetentionRow, "id" | "startedAt">): RetentionRow {
  return {
    kind: "nightly",
    status: "succeeded",
    snapshotId: `snap_${overrides.id}`,
    ...overrides,
  };
}

describe("backup retention selectExpired", () => {
  it("R1: forgets a succeeded nightly backup older than retention when a newer succeeded backup exists", () => {
    const newer = makeRow({ id: "bak_new", startedAt: daysAgo(1) });
    const old = makeRow({ id: "bak_old", startedAt: daysAgo(15) });

    const result = selectExpired([old, newer, ...newerCopies(RETENTION_DAYS)], NOW, RETENTION_DAYS, true);

    expect(result.forget.map((row) => row.id)).toEqual(["bak_old"]);
    expect(result.drop).toEqual([]);
  });

  it("R2: keeps the only succeeded backup at 30 days old when the site exists", () => {
    const only = makeRow({ id: "bak_only", startedAt: daysAgo(30) });

    const result = selectExpired([only], NOW, RETENTION_DAYS, true);

    expect(result.forget).toEqual([]);
    expect(result.drop).toEqual([]);
  });

  it("R3: forgets the only succeeded backup at 30 days old when the site no longer exists", () => {
    const only = makeRow({ id: "bak_only", startedAt: daysAgo(30) });

    const result = selectExpired([only], NOW, RETENTION_DAYS, false);

    expect(result.forget.map((row) => row.id)).toEqual(["bak_only"]);
    expect(result.drop).toEqual([]);
  });

  it("R4: keeps the 3 newest succeeded manual backups today and forgets the 2 oldest", () => {
    const manuals = [
      makeRow({ id: "bak_m1", kind: "manual", startedAt: daysAgo(0, -50 * 60_000) }),
      makeRow({ id: "bak_m2", kind: "manual", startedAt: daysAgo(0, -40 * 60_000) }),
      makeRow({ id: "bak_m3", kind: "manual", startedAt: daysAgo(0, -30 * 60_000) }),
      makeRow({ id: "bak_m4", kind: "manual", startedAt: daysAgo(0, -20 * 60_000) }),
      makeRow({ id: "bak_m5", kind: "manual", startedAt: daysAgo(0, -10 * 60_000) }),
    ];

    const result = selectExpired(manuals, NOW, RETENTION_DAYS, true);

    expect(result.forget.map((row) => row.id)).toEqual(["bak_m2", "bak_m1"]);
    expect(result.drop).toEqual([]);
  });

  it("R5: drops failed backups older than retention without snapshot and keeps recent failed backups", () => {
    const oldFailedNoSnap = makeRow({
      id: "bak_fail_old",
      status: "failed",
      snapshotId: null,
      startedAt: daysAgo(20),
    });
    const recentFailedNoSnap = makeRow({
      id: "bak_fail_recent",
      status: "failed",
      snapshotId: null,
      startedAt: daysAgo(2),
    });

    const result = selectExpired([oldFailedNoSnap, recentFailedNoSnap], NOW, RETENTION_DAYS, true);

    expect(result.forget).toEqual([]);
    expect(result.drop.map((row) => row.id)).toEqual(["bak_fail_old"]);
  });

  it("R6: leaves a 40-day-old running backup untouched", () => {
    const staleRunningNoSnap = makeRow({
      id: "bak_run_null",
      status: "running",
      snapshotId: null,
      startedAt: daysAgo(40),
    });
    const staleRunningWithSnap = makeRow({
      id: "bak_run_snap",
      status: "running",
      snapshotId: "snap_run",
      startedAt: daysAgo(40),
    });

    const result = selectExpired(
      [staleRunningNoSnap, staleRunningWithSnap],
      NOW,
      RETENTION_DAYS,
      false,
    );

    expect(result.forget).toEqual([]);
    expect(result.drop).toEqual([]);
  });

  it("R7: keeps a backup at the exact cutoff timestamp and forgets one millisecond older", () => {
    const newer = makeRow({ id: "bak_new", startedAt: daysAgo(1) });
    const exactCutoff = makeRow({ id: "bak_exact", startedAt: daysAgo(RETENTION_DAYS) });
    const justExpired = makeRow({ id: "bak_just_past", startedAt: daysAgo(RETENTION_DAYS, -1) });

    const result = selectExpired([exactCutoff, justExpired, newer, ...newerCopies(RETENTION_DAYS)], NOW, RETENTION_DAYS, true);

    expect(result.forget.map((row) => row.id)).toEqual(["bak_just_past"]);
    expect(result.drop).toEqual([]);
  });

  it("R8: honors retentionDays=1", () => {
    const newer = makeRow({ id: "bak_new", startedAt: daysAgo(0, -60_000) });
    const withinOneDay = makeRow({ id: "bak_within", startedAt: daysAgo(1) });
    const pastOneDay = makeRow({ id: "bak_past", startedAt: daysAgo(1, -1) });

    const result = selectExpired([pastOneDay, withinOneDay, newer], NOW, 1, true);

    expect(result.forget.map((row) => row.id)).toEqual(["bak_past"]);
    expect(result.drop).toEqual([]);
  });

  it("R9: honors a 365-day retention boundary", () => {
    const newer = makeRow({ id: "bak_new", startedAt: daysAgo(1) });
    const atBoundary = makeRow({ id: "bak_365", startedAt: daysAgo(365) });
    const pastBoundary = makeRow({ id: "bak_366", startedAt: daysAgo(366) });

    const result = selectExpired([pastBoundary, atBoundary, newer, ...newerCopies(365)], NOW, 365, true);

    expect(result.forget.map((row) => row.id)).toEqual(["bak_366"]);
    expect(result.drop).toEqual([]);
  });
  it("R10: keeps the 3 newest good pre_update copies and forgets the oldest of 4", () => {
    const copies = [1, 2, 3, 4].map((n) =>
      makeRow({ id: `bak_p${String(n)}`, kind: "pre_update", startedAt: daysAgo(0, -(5 - n) * 60_000) }),
    );

    const result = selectExpired(copies, NOW, RETENTION_DAYS, true);

    expect(result.forget.map((row) => row.id)).toEqual(["bak_p1"]);
    expect(result.drop).toEqual([]);
  });

  it("R11: 3 manual and 3 pre_update copies use separate slots, none is excess", () => {
    const rows = [1, 2, 3].flatMap((n) => [
      makeRow({ id: `bak_m${String(n)}`, kind: "manual", startedAt: daysAgo(0, -n * 60_000) }),
      makeRow({ id: `bak_p${String(n)}`, kind: "pre_update", startedAt: daysAgo(0, -n * 30_000) }),
    ]);

    const result = selectExpired(rows, NOW, RETENTION_DAYS, true);

    expect(result.forget).toEqual([]);
    expect(result.drop).toEqual([]);
  });

  it("R12: old pre_update copies among the newest retentionDays good copies of the site stay", () => {
    const old = makeRow({ id: "bak_p_old", kind: "pre_update", startedAt: daysAgo(20) });
    const oldest = makeRow({ id: "bak_p_oldest", kind: "pre_update", startedAt: daysAgo(30) });

    expect(selectExpired([old, oldest], NOW, RETENTION_DAYS, true).forget.map((row) => row.id)).toEqual([]);
  });
  // R207 restore.3: a stalled schedule never empties a site down to one copy, whatever the clock says.
  it("R13: keeps the newest retentionDays good copies when now is 400 days after the newest", () => {
    const later = new Date(NOW.getTime() + 400 * DAY_MS);
    const copies = Array.from({ length: RETENTION_DAYS + 2 }, (_, n) => makeRow({ id: `bak_n${String(n)}`, startedAt: daysAgo(n) }));
    copies.push(makeRow({ id: "bak_failed", status: "failed", snapshotId: null, startedAt: daysAgo(3) }));

    const result = selectExpired(copies, later, RETENTION_DAYS, true);

    expect(result.forget.map((row) => row.id)).toEqual(["bak_n14", "bak_n15"]);
    expect(result.drop.map((row) => row.id)).toEqual(["bak_failed"]);
  });
});
