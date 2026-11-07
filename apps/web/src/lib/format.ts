import type {
  AuditEventOutcome,
  CertificateStatus,
  DatabaseEngine,
  DomainVerificationStatus,
  ObservedResourceStatus,
  OperationKind,
  OperationStatus,
  OperationStepStatus,
  OrganizationStatus,
  ProviderConnectionStatus,
  ResourceHealthStatus,
} from "@hosting-panel/contracts";

const ITALIAN_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("it-IT", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "Europe/Rome",
});

export function formatDateTimeIt(isoString: string | null | undefined): string {
  if (!isoString) {
    return "Mai rilevato";
  }
  const timestamp = Date.parse(isoString);
  if (Number.isNaN(timestamp)) {
    return "Data non valida";
  }
  return ITALIAN_DATE_TIME_FORMATTER.format(new Date(timestamp));
}

export function formatMemoryGb(memoryMb: number): string {
  const gb = memoryMb / 1024;
  return Number.isInteger(gb) ? `${String(gb)} GB` : `${gb.toFixed(1)} GB`;
}

export function formatRoleLabelIt(role: string): string {
  switch (role) {
    case "customer_owner":
      return "Titolare Organizzazione";
    case "hosting_manager":
      return "Responsabile Hosting";
    case "developer":
      return "Sviluppatore";
    case "database_manager":
      return "Amministratore Database";
    case "billing_manager":
      return "Responsabile Fatturazione";
    case "viewer":
      return "Sola Lettura";
    case "platform_admin":
      return "Amministratore Piattaforma";
    default:
      return role;
  }
}

export function formatOrgStatusIt(status: OrganizationStatus | string): {
  readonly label: string;
  readonly tone: "emerald" | "amber" | "rose" | "slate";
} {
  switch (status) {
    case "active":
      return { label: "Attiva", tone: "emerald" };
    case "past_due":
      return { label: "Pagamento in scadenza", tone: "amber" };
    case "suspended":
      return { label: "Sospesa", tone: "rose" };
    case "cancelled":
      return { label: "Disdetta", tone: "slate" };
    default:
      return { label: status, tone: "slate" };
  }
}

export function formatResourceStatusIt(status: ObservedResourceStatus): {
  readonly label: string;
  readonly className: string;
} {
  switch (status) {
    case "running":
      return {
        label: "In esecuzione",
        className: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
      };
    case "degraded":
      return {
        label: "Degradata",
        className: "bg-amber-50 text-amber-800 ring-amber-600/20",
      };
    case "deploying":
      return {
        label: "Deploy in corso",
        className: "bg-sky-50 text-sky-800 ring-sky-600/20",
      };
    case "stopped":
      return {
        label: "Fermata",
        className: "bg-slate-100 text-slate-700 ring-slate-500/20",
      };
    case "failed":
      return {
        label: "Errore critico",
        className: "bg-rose-50 text-rose-800 ring-rose-600/20",
      };
    case "unknown":
      return {
        label: "Stato sconosciuto",
        className: "bg-zinc-100 text-zinc-700 ring-zinc-500/20",
      };
  }
}

export function formatHealthStatusIt(health: ResourceHealthStatus): {
  readonly label: string;
  readonly className: string;
} {
  switch (health) {
    case "healthy":
      return {
        label: "Integro",
        className: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
      };
    case "unhealthy":
      return {
        label: "Anomalo",
        className: "bg-rose-50 text-rose-700 ring-rose-600/20",
      };
    case "unknown":
      return {
        label: "Non verificato",
        className: "bg-slate-100 text-slate-600 ring-slate-500/20",
      };
  }
}

export function formatOperationStatusIt(status: OperationStatus): {
  readonly label: string;
  readonly className: string;
  readonly inProgress: boolean;
} {
  switch (status) {
    case "queued":
      return {
        label: "In coda",
        className: "bg-slate-100 text-slate-800 ring-slate-500/20",
        inProgress: true,
      };
    case "processing":
      return {
        label: "Invio al provider",
        className: "bg-sky-50 text-sky-800 ring-sky-600/20",
        inProgress: true,
      };
    case "accepted_by_provider":
      return {
        label: "Accettata dal motore",
        className: "bg-indigo-50 text-indigo-800 ring-indigo-600/20",
        inProgress: true,
      };
    case "reconciling":
      return {
        label: "Riconciliazione in corso",
        className: "bg-amber-50 text-amber-800 ring-amber-600/20",
        inProgress: true,
      };
    case "succeeded":
      return {
        label: "Completata",
        className: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
        inProgress: false,
      };
    case "failed":
      return {
        label: "Fallita",
        className: "bg-rose-50 text-rose-800 ring-rose-600/20",
        inProgress: false,
      };
    case "cancelled":
      return {
        label: "Annullata",
        className: "bg-zinc-100 text-zinc-700 ring-zinc-500/20",
        inProgress: false,
      };
    case "unknown":
      return {
        label: "Esito incerto (verifica in corso)",
        className: "bg-orange-50 text-orange-800 ring-orange-600/20",
        inProgress: true,
      };
  }
}

export function formatStepStatusIt(status: OperationStepStatus): {
  readonly label: string;
  readonly dotClassName: string;
} {
  switch (status) {
    case "pending":
      return { label: "In attesa", dotClassName: "bg-slate-300" };
    case "running":
      return { label: "In esecuzione", dotClassName: "bg-sky-500 animate-pulse" };
    case "succeeded":
      return { label: "Completato", dotClassName: "bg-emerald-500" };
    case "failed":
      return { label: "Fallito", dotClassName: "bg-rose-500" };
    case "cancelled":
      return { label: "Annullato", dotClassName: "bg-zinc-400" };
    case "skipped":
      return { label: "Saltato", dotClassName: "bg-slate-400" };
    case "unknown":
      return { label: "Incerto", dotClassName: "bg-orange-500" };
  }
}

export function formatOperationKindIt(kind: OperationKind): string {
  switch (kind) {
    case "application.deploy":
      return "Deploy applicazione";
    case "application.restart":
      return "Riavvio applicazione";
    case "domain.recheck":
      return "Ricontrollo dominio e TLS";
    case "provider.connection.test":
      return "Verifica connessione provider";
  }
}

export function formatDatabaseEngineIt(engine: DatabaseEngine): string {
  switch (engine) {
    case "postgresql":
      return "PostgreSQL";
    case "mysql":
      return "MySQL";
    case "mariadb":
      return "MariaDB";
    case "mongodb":
      return "MongoDB";
    case "redis":
      return "Redis";
  }
}

export function formatDatabaseBackupUnsupportedIt(
  engine: DatabaseEngine,
  fallbackReason: string | null,
): string {
  if (engine === "redis") {
    return "Backup e ripristino automatici non supportati per istanze Redis.";
  }
  return fallbackReason ?? "Backup automatici non supportati per questo motore database.";
}

export function formatDomainVerificationIt(status: DomainVerificationStatus): {
  readonly label: string;
  readonly className: string;
} {
  switch (status) {
    case "verified":
      return {
        label: "DNS verificato",
        className: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
      };
    case "pending":
      return {
        label: "DNS in verifica",
        className: "bg-amber-50 text-amber-800 ring-amber-600/20",
      };
    case "conflict":
      return {
        label: "Conflitto DNS",
        className: "bg-rose-50 text-rose-800 ring-rose-600/20",
      };
    case "failed":
      return {
        label: "Verifica DNS fallita",
        className: "bg-rose-50 text-rose-800 ring-rose-600/20",
      };
  }
}

export function formatCertificateStatusIt(status: CertificateStatus): {
  readonly label: string;
  readonly className: string;
} {
  switch (status) {
    case "valid":
      return {
        label: "Certificato TLS valido",
        className: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
      };
    case "expiring_soon":
      return {
        label: "In scadenza a breve",
        className: "bg-amber-50 text-amber-800 ring-amber-600/20",
      };
    case "expired":
      return {
        label: "Certificato scaduto",
        className: "bg-rose-50 text-rose-800 ring-rose-600/20",
      };
    case "mismatch":
      return {
        label: "Hostname non corrispondente",
        className: "bg-rose-50 text-rose-800 ring-rose-600/20",
      };
    case "missing":
      return {
        label: "Certificato assente",
        className: "bg-slate-100 text-slate-700 ring-slate-500/20",
      };
    case "unknown":
      return {
        label: "Stato TLS sconosciuto",
        className: "bg-zinc-100 text-zinc-700 ring-zinc-500/20",
      };
  }
}

export function formatProviderStatusIt(status: ProviderConnectionStatus): {
  readonly label: string;
  readonly className: string;
} {
  switch (status) {
    case "connected":
      return {
        label: "Connesso",
        className: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
      };
    case "degraded":
      return {
        label: "Degradato (Rate Limit)",
        className: "bg-amber-50 text-amber-800 ring-amber-600/20",
      };
    case "unreachable":
      return {
        label: "Irraggiungibile",
        className: "bg-rose-50 text-rose-800 ring-rose-600/20",
      };
    case "misconfigured":
      return {
        label: "Credenziali non valide",
        className: "bg-rose-50 text-rose-800 ring-rose-600/20",
      };
    case "unknown":
      return {
        label: "Non verificato",
        className: "bg-slate-100 text-slate-700 ring-slate-500/20",
      };
  }
}

export function formatAuditOutcomeIt(outcome: AuditEventOutcome): {
  readonly label: string;
  readonly className: string;
} {
  switch (outcome) {
    case "succeeded":
      return {
        label: "Completato",
        className: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
      };
    case "allowed":
      return {
        label: "Autorizzato",
        className: "bg-sky-50 text-sky-800 ring-sky-600/20",
      };
    case "denied":
      return {
        label: "Negato",
        className: "bg-rose-50 text-rose-800 ring-rose-600/20",
      };
    case "failed":
      return {
        label: "Fallito",
        className: "bg-amber-50 text-amber-800 ring-amber-600/20",
      };
  }
}
