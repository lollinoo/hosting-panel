import {
  MANUAL_BACKUPS_KEPT,
  PRE_UPDATE_BACKUPS_KEPT,
  type BackupKind,
  type BackupStatus,
} from "@hosting-panel/contracts";

export interface RetentionRow {
  id: string;
  kind: BackupKind;
  status: BackupStatus;
  snapshotId: string | null;
  startedAt: Date;
}

const MS_PER_DAY = 86_400_000;
// Good copies kept per kind, each in its own slots; nightly copies only expire by age.
const KEPT_PER_KIND: Partial<Record<BackupKind, number>> = {
  manual: MANUAL_BACKUPS_KEPT,
  pre_update: PRE_UPDATE_BACKUPS_KEPT,
};

/** Selects expired or excess backups to forget in S3 or drop from the database. */
export function selectExpired(
  rows: readonly RetentionRow[],
  now: Date,
  retentionDays: number,
  siteExists: boolean,
): { forget: RetentionRow[]; drop: RetentionRow[] } {
  const cutoffMs = now.getTime() - retentionDays * MS_PER_DAY;
  const byNewest = [...rows].sort(
    (a, b) =>
      b.startedAt.getTime() - a.startedAt.getTime() ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  // An existing site keeps its newest retentionDays good copies whatever the clock says (R207 restore.3).
  const recent = new Set(
    siteExists
      ? byNewest
          .filter((row) => row.status === "succeeded")
          .slice(0, retentionDays)
          .map((row) => row.id)
      : [],
  );
  const kept = new Set(
    Object.entries(KEPT_PER_KIND).flatMap(([kind, count]) =>
      byNewest
        .filter((row) => row.kind === kind && row.status === "succeeded")
        .slice(0, count)
        .map((row) => row.id),
    ),
  );

  const forget: RetentionRow[] = [];
  const drop: RetentionRow[] = [];

  for (const row of byNewest) {
    if (row.status === "running") {
      continue;
    }
    const expired = row.startedAt.getTime() < cutoffMs && !recent.has(row.id);
    const excess = row.kind in KEPT_PER_KIND && row.status === "succeeded" && !kept.has(row.id);
    if (!expired && !excess) {
      continue;
    }
    (row.snapshotId ? forget : drop).push(row);
  }

  return { forget, drop };
}
