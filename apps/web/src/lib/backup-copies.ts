import type { BackupTargetChoiceDto, SiteBackupDto } from "@hosting-panel/contracts";
import { format, type Messages } from "@/i18n";

type TargetTexts = Messages["site"]["backups"]["target"];
export type BackupCopy = SiteBackupDto["copies"][number];
export type BackupTargetKind = BackupTargetChoiceDto["kind"];

/** Row statuses plus the copy-only ones; `partial` is typed here before the contracts list it (M4). */
export type CopyViewStatus = "running" | "succeeded" | "failed" | "partial" | "unknown" | "missing";

export interface StatusView {
  variant: "default" | "secondary" | "destructive" | "warning" | "outline";
  /** An icon name, so the state never depends on the colour alone. */
  icon: "check" | "x" | "clock" | "alert" | "help";
  /** The key of the status text in the catalog. */
  textKey: CopyViewStatus;
}

const STATUS_VIEWS: Record<CopyViewStatus, StatusView> = {
  succeeded: { variant: "default", icon: "check", textKey: "succeeded" },
  failed: { variant: "destructive", icon: "x", textKey: "failed" },
  partial: { variant: "warning", icon: "alert", textKey: "partial" },
  running: { variant: "secondary", icon: "clock", textKey: "running" },
  unknown: { variant: "outline", icon: "help", textKey: "unknown" },
  missing: { variant: "outline", icon: "x", textKey: "missing" },
};

/** Badge variant, icon and text key of a backup or copy status; an unknown value reads as `unknown`. */
export function statusView(status: string): StatusView {
  return Object.hasOwn(STATUS_VIEWS, status) ? STATUS_VIEWS[status as CopyViewStatus] : STATUS_VIEWS.unknown;
}

/**
 * Neutral customer label of a destination: never an endpoint, bucket or path.
 * `n` numbers off-server destinations and is only given when there is more than one.
 */
export function copyLabel(t: TargetTexts, kind: BackupTargetKind, n: number | null = null): string {
  if (kind === "local") return t.thisServer;
  return n === null ? t.offServer : format(t.offServerN, { n });
}

/** Labels for a list of destinations, keyed by position; off-server ones are numbered only when two or more. */
export function choiceLabels(t: TargetTexts, items: readonly { kind: BackupTargetKind }[]): string[] {
  const offServer = items.filter((i) => i.kind === "s3").length;
  let seen = 0;
  return items.map((i) => {
    if (i.kind === "local") return copyLabel(t, "local");
    seen += 1;
    return copyLabel(t, "s3", offServer > 1 ? seen : null);
  });
}

/** The copies a restore or a download can read from. */
export function restorableCopies(b: Pick<SiteBackupDto, "copies">): BackupCopy[] {
  return (b.copies ?? []).filter((c) => c.status === "succeeded");
}

/**
 * True when the backup can be restored or downloaded: a copy succeeded. A succeeded backup that
 * lists no copies at all (written by an older release) stays usable on its single destination.
 */
export function hasRestorableCopy(b: Pick<SiteBackupDto, "copies" | "status">): boolean {
  if (restorableCopies(b).length > 0) return true;
  return b.status === "succeeded" && (b.copies ?? []).length === 0;
}

/** Copies paired with their neutral label, in order. */
export function labelledCopies(t: TargetTexts, copies: readonly BackupCopy[]): (BackupCopy & { label: string })[] {
  const labels = choiceLabels(t, copies);
  return copies.map((c, i) => ({ ...c, label: labels[i] ?? copyLabel(t, c.kind) }));
}
