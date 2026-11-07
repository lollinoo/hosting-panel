import type {
  AuditEventOutcome,
  CertificateStatus,
  DomainVerificationStatus,
  ObservedResourceStatus,
  OperationStatus,
  ProviderConnectionStatus,
  ResourceHealthStatus,
} from "@hosting-panel/contracts";
import {
  formatAuditOutcomeIt,
  formatCertificateStatusIt,
  formatDomainVerificationIt,
  formatHealthStatusIt,
  formatOperationStatusIt,
  formatOrgStatusIt,
  formatProviderStatusIt,
  formatResourceStatusIt,
} from "@/lib/format";

export function ResourceStatusBadge({
  status,
}: {
  readonly status: ObservedResourceStatus;
}) {
  const info = formatResourceStatusIt(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${info.className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {info.label}
    </span>
  );
}

export function HealthStatusBadge({
  health,
}: {
  readonly health: ResourceHealthStatus;
}) {
  const info = formatHealthStatusIt(health);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${info.className}`}
    >
      {info.label}
    </span>
  );
}

export function OperationStatusBadge({
  status,
}: {
  readonly status: OperationStatus;
}) {
  const info = formatOperationStatusIt(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${info.className}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full bg-current ${info.inProgress ? "animate-pulse" : ""}`}
        aria-hidden="true"
      />
      {info.label}
    </span>
  );
}

export function OrgCommercialStatusBadge({
  status,
}: {
  readonly status: string;
}) {
  const info = formatOrgStatusIt(status);
  const classes =
    info.tone === "emerald"
      ? "bg-emerald-50 text-emerald-800 ring-emerald-600/20"
      : info.tone === "amber"
        ? "bg-amber-50 text-amber-800 ring-amber-600/20"
        : info.tone === "rose"
          ? "bg-rose-50 text-rose-800 ring-rose-600/20"
          : "bg-slate-100 text-slate-700 ring-slate-500/20";

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${classes}`}
    >
      {info.label}
    </span>
  );
}

export function DomainVerificationBadge({
  status,
}: {
  readonly status: DomainVerificationStatus;
}) {
  const info = formatDomainVerificationIt(status);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${info.className}`}
    >
      {info.label}
    </span>
  );
}

export function CertificateStatusBadge({
  status,
}: {
  readonly status: CertificateStatus;
}) {
  const info = formatCertificateStatusIt(status);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${info.className}`}
    >
      {info.label}
    </span>
  );
}

export function ProviderStatusBadge({
  status,
}: {
  readonly status: ProviderConnectionStatus;
}) {
  const info = formatProviderStatusIt(status);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${info.className}`}
    >
      {info.label}
    </span>
  );
}

export function AuditOutcomeBadge({
  outcome,
}: {
  readonly outcome: AuditEventOutcome;
}) {
  const info = formatAuditOutcomeIt(outcome);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${info.className}`}
    >
      {info.label}
    </span>
  );
}
