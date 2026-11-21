import Link from "next/link";
import { redirect } from "next/navigation";
import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import {
  fetchServerAdminBackupPolicy,
  fetchServerAdminBackups,
  fetchServerAdminBackupSites,
  fetchServerAdminBackupTargets,
  fetchServerMe,
} from "@/lib/server-api";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { BackupDisasterRecovery } from "@/components/admin/backup-disaster-recovery";
import { BackupPolicyForm } from "@/components/admin/backup-policy";
import { BackupSettings } from "@/components/admin/backup-settings";
import { BackupTargets } from "@/components/admin/backup-targets";

export const dynamic = "force-dynamic";

const TABS = ["destinations", "policy", "recovery"] as const;
type Tab = (typeof TABS)[number];

const tabOf = (raw: string | string[] | undefined): Tab => TABS.find((x) => x === raw) ?? "destinations";

/** A secondary read that fails (or throws) leaves its own block empty; a dead session still redirects. */
async function optional<T>(read: Promise<T | null>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (String((error as { digest?: unknown } | null)?.digest ?? "").startsWith("NEXT_REDIRECT")) throw error;
    return null;
  }
}

/** The administrator's backups: destinations, policy and what to do if the server is lost, one tab per page load. */
export default async function AdminBackupsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const tab = tabOf((await searchParams)?.tab);
  const [m] = await Promise.all([getRequestLocale().then(getMessages)]);
  const t = m.admin.backups;
  const failed = (text: string) => (
    <Alert variant="destructive" role="alert">
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  );

  let body;
  if (tab === "destinations") {
    const [settings, sites, targets, me] = await Promise.all([
      fetchServerAdminBackups(),
      fetchServerAdminBackupSites(),
      optional(fetchServerAdminBackupTargets()),
      optional(fetchServerMe()),
    ]);
    body = (
      <>
        {settings ? <BackupSettings csrfToken={session.csrfToken} initial={settings} sites={sites} /> : failed(m.errors.generic)}
        {targets ? (
          <BackupTargets
            csrfToken={session.csrfToken}
            initial={targets}
            localAvailable={me?.platformCapabilities.localBackupTargetsAvailable === true}
          />
        ) : (
          failed(t.targets.loadFailed)
        )}
      </>
    );
  } else if (tab === "policy") {
    const [siteDefault, panel, targets] = await Promise.all([
      optional(fetchServerAdminBackupPolicy("default")),
      optional(fetchServerAdminBackupPolicy("panel")),
      optional(fetchServerAdminBackupTargets()),
    ]);
    body =
      siteDefault && panel && targets ? (
        <BackupPolicyForm csrfToken={session.csrfToken} siteDefault={siteDefault} panel={panel} targets={targets.targets} />
      ) : (
        failed(t.policy.loadFailed)
      );
  } else {
    const targets = await optional(fetchServerAdminBackupTargets());
    body = targets ? <BackupDisasterRecovery m={m} targets={targets.targets} /> : failed(t.targets.loadFailed);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
      </div>
      <nav aria-label={t.tabs.label} className="inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground">
        {TABS.map((x) => (
          <Link
            key={x}
            href={`/admin/backups?tab=${x}`}
            aria-current={x === tab ? "page" : undefined}
            className={cn(
              "inline-flex items-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              x === tab && "bg-background text-foreground shadow",
            )}
          >
            {t.tabs[x]}
          </Link>
        ))}
      </nav>
      {body}
    </div>
  );
}
