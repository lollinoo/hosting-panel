import { MANUAL_BACKUPS_KEPT, type BackupKind, type BackupStatus } from "@hosting-panel/contracts";

export interface RetentionRow {
  id: string;
  kind: BackupKind;
  status: BackupStatus;
  snapshotId: string | null;
  startedAt: Date;
}

const MS_PER_DAY = 86_400_000;

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
  // Existing sites always retain their latest good backup regardless of age.
  const newestSucceededId = siteExists
    ? byNewest.find((row) => row.status === "succeeded")?.id
    : undefined;
  const keptManualIds = new Set(
    byNewest
      .filter((row) => row.kind === "manual" && row.status === "succeeded")
      .slice(0, MANUAL_BACKUPS_KEPT)
      .map((row) => row.id),
  );

  const forget: RetentionRow[] = [];
  const drop: RetentionRow[] = [];

  for (const row of byNewest) {
    if (row.status === "running" || row.id === newestSucceededId) {
      continue;
    }
    const expired = row.startedAt.getTime() < cutoffMs;
    const excessManual =
      row.kind === "manual" && row.status === "succeeded" && !keptManualIds.has(row.id);
    if (!expired && !excessManual) {
      continue;
    }
    (row.snapshotId ? forget : drop).push(row);
  }

  return { forget, drop };
}
