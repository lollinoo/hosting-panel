import { describe, expect, it } from "vitest";
import {
  APP_STACK_PRE_RESTORE_BACKUPS_KEPT,
  MANUAL_BACKUPS_KEPT,
  type AppStackBackupKind,
  type AppStackBackupStatus,
} from "@hosting-panel/contracts";
import type { AppStackBackupCopyRow, AppStackBackupRow } from "@hosting-panel/database";
import { expiredAppStackBackups } from "../src/app-stacks/app-stack-backup-retention.js";

// ADR-0038 K7: which backups of an application the retention rule lets go. The rule is the sites' (`selectExpired`);
// these cases pin how an application's rows enter it, and that the numbers the page shows are the ones it applies.
const NOW = new Date("2026-11-23T03:00:00Z");
const DAY = 86_400_000;
const DAYS = 14;
const SNAP = "a".repeat(64);

interface Spec {
  readonly id: string;
  readonly kind?: AppStackBackupKind;
  readonly status?: AppStackBackupStatus;
  /** Whole days before NOW; rows of the same day are told apart by their order in the list. */
  readonly age: number;
  /** Copies with a snapshot on a destination (default: one when the backup is good). */
  readonly snapshots?: number;
}

function expired(specs: readonly Spec[], live = true): string[] {
  const backups = specs.map(
    (s, n) =>
      ({
        id: s.id,
        kind: s.kind ?? "manual",
        status: s.status ?? "succeeded",
        startedAt: new Date(NOW.getTime() - s.age * DAY - n * 1_000),
      }) as AppStackBackupRow,
  );
  const copies = new Map<string, AppStackBackupCopyRow[]>(
    specs.map((s) => {
      const good = s.snapshots ?? ((s.status ?? "succeeded") === "succeeded" || s.status === "partial" ? 1 : 0);
      return [s.id, Array.from({ length: good }, () => ({ snapshotId: SNAP }) as AppStackBackupCopyRow)];
    }),
  );
  return expiredAppStackBackups(backups, copies, NOW, DAYS, live).sort();
}
const many = (count: number, over: Omit<Spec, "id" | "age">, prefix: string, age = 1): Spec[] =>
  Array.from({ length: count }, (_, n) => ({ id: `${prefix}${String(n + 1)}`, age, ...over }));

describe("retention of application backups", () => {
  it("keeps as many manual backups as the page says, and lets the older ones go", () => {
    expect(MANUAL_BACKUPS_KEPT).toBe(3);
    const rows = many(MANUAL_BACKUPS_KEPT + 2, {}, "m");
    expect(expired(rows)).toEqual([`m${String(MANUAL_BACKUPS_KEPT + 1)}`, `m${String(MANUAL_BACKUPS_KEPT + 2)}`]);
    expect(expired(many(MANUAL_BACKUPS_KEPT, {}, "m"))).toEqual([]);
  });

  it("keeps as many safety backups as the page says: the number is not only a sentence", () => {
    const rows = many(APP_STACK_PRE_RESTORE_BACKUPS_KEPT + 2, { kind: "pre_restore" }, "p");
    expect(expired(rows)).toEqual([`p${String(APP_STACK_PRE_RESTORE_BACKUPS_KEPT + 1)}`, `p${String(APP_STACK_PRE_RESTORE_BACKUPS_KEPT + 2)}`]);
    expect(expired(many(APP_STACK_PRE_RESTORE_BACKUPS_KEPT, { kind: "pre_restore" }, "p"))).toEqual([]);
  });

  it("gives the two kinds their own slots: safety backups never push a manual one out", () => {
    const rows = [...many(APP_STACK_PRE_RESTORE_BACKUPS_KEPT, { kind: "pre_restore" }, "p"), ...many(MANUAL_BACKUPS_KEPT, {}, "m")];
    expect(expired(rows)).toEqual([]);
    expect(expired([...rows, { id: "p_old", kind: "pre_restore", age: 2 }, { id: "m_old", age: 2 }])).toEqual(["m_old", "p_old"]);
  });

  it("counts a backup that reached one destination only as good: it takes a slot", () => {
    const rows = [...many(MANUAL_BACKUPS_KEPT, { status: "partial" }, "half"), { id: "m_old", age: 2 }];
    expect(expired(rows)).toEqual(["m_old"]);
  });

  it("a failed backup takes no slot and goes with the retention period, not before", () => {
    const failed = many(4, { status: "failed" }, "f");
    expect(expired([...failed, ...many(MANUAL_BACKUPS_KEPT, {}, "m")])).toEqual([]);
    expect(expired([...many(MANUAL_BACKUPS_KEPT, {}, "m"), { id: "f_old", status: "failed", age: DAYS + 1 }])).toEqual(["f_old"]);
  });

  it("never touches a backup that is still running, however old", () => {
    expect(expired([{ id: "r_old", status: "running", age: DAYS + 30 }], true)).toEqual([]);
    expect(expired([{ id: "r_old", status: "running", age: DAYS + 30 }], false)).toEqual([]);
  });

  it("an application that exists keeps its newest good backups past the retention period", () => {
    const rows: Spec[] = [
      { id: "m_a", age: DAYS + 10 },
      { id: "m_b", age: DAYS + 20 },
      { id: "p_a", kind: "pre_restore", age: DAYS + 30 },
    ];
    expect(expired(rows, true)).toEqual([]);
  });

  it("a deleted application keeps its backups for the retention period, then all of them go", () => {
    const rows: Spec[] = [
      { id: "m_new", age: DAYS - 1 },
      { id: "m_old", age: DAYS + 1 },
      { id: "p_old", kind: "pre_restore", age: DAYS + 2 },
      { id: "half_old", status: "partial", age: DAYS + 3 },
      { id: "f_old", status: "failed", age: DAYS + 4 },
    ];
    expect(expired(rows, false)).toEqual(["f_old", "half_old", "m_old", "p_old"]);
  });

  it("lists a row without a snapshot too: there is nothing to remove from a destination, only the row", () => {
    const rows: Spec[] = [...many(MANUAL_BACKUPS_KEPT, {}, "m"), { id: "m_bare", age: 2, snapshots: 0 }, { id: "m_two", age: 3, snapshots: 2 }];
    expect(expired(rows)).toEqual(["m_bare", "m_two"]);
  });
});
