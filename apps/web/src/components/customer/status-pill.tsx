import type { DriftSummary, SiteStatus } from "@hosting-panel/contracts";
import type { Messages } from "@/i18n";
import { Badge } from "@/components/ui/badge";

type Tone = "ok" | "warn" | "error" | "muted";
type LabelKey = keyof Messages["site"]["status"];

const VIEWS: Record<SiteStatus, { tone: Tone; labelKey: LabelKey }> = {
  ready: { tone: "ok", labelKey: "online" },
  deploying: { tone: "muted", labelKey: "settingUp" },
  degraded: { tone: "error", labelKey: "problem" },
  stopped: { tone: "muted", labelKey: "stopped" },
  maintenance: { tone: "warn", labelKey: "maintenance" },
};

export function toSiteStatusView(
  status: SiteStatus,
  driftSummary?: DriftSummary,
): { tone: Tone; labelKey: LabelKey } {
  // A "ready" site whose running setup no longer matches what was asked for is not really fine.
  if (status === "ready" && driftSummary?.overallDriftStatus === "drifted") {
    return { tone: "warn", labelKey: "problem" };
  }
  return VIEWS[status];
}

const BADGE_VARIANT = { ok: "success", warn: "warning", error: "destructive", muted: "secondary" } as const;

export function StatusPill({
  status,
  driftSummary,
  labels,
}: {
  status: SiteStatus;
  driftSummary?: DriftSummary;
  labels: Messages["site"]["status"];
}) {
  const { tone, labelKey } = toSiteStatusView(status, driftSummary);
  return <Badge variant={BADGE_VARIANT[tone]}>{labels[labelKey]}</Badge>;
}
