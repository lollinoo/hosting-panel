import { redirect } from "next/navigation";
import { format, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminFirewall } from "@/lib/server-api";
import { formatZonedDate } from "@/lib/admin-alerts";
import { canChangeFirewall, hasNotInForce, needsBaseRules } from "@/lib/admin-firewall";
import { RESTART_FOLLOW_MS } from "@/lib/admin-restart";
import { ConfirmAction } from "@/components/admin/confirm-action";
import { FirewallPorts } from "@/components/admin/firewall-ports";
import { FirewallBlocks } from "@/components/admin/firewall-blocks";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

// The shipped host security action that loads the base rules (host-detail-actions.tsx).
const APPLY_POLICY = { policyRef: "apply_dedicated_nftables_22_80_443" };

/** The administrator's Firewall page: base rules, what stays open, ports to open, blocked addresses. */
export default async function AdminFirewallPage() {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const [m, fw] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminFirewall()]);
  const t = m.admin.firewall;

  const apply = (name: string, label: string) => fw?.hostId ? (
    <ConfirmAction csrfToken={session.csrfToken} name={name} url={`/api/bff/hosts/${fw.hostId}/security`} body={APPLY_POLICY}
      label={label} variant="default" errors="firewall-base"
      dialog={{ title: t.base.applyTitle, body: t.base.applyBody, confirm: t.base.applyConfirm }}
      follow={{ ms: RESTART_FOLLOW_MS, running: t.base.applying, done: t.base.applyDone, failed: t.base.applyFailed, unknown: t.base.applyUnknown }} />
  ) : null;

  const body = () => {
    if (!fw) {
      return <Alert variant="destructive" role="alert"><AlertDescription>{t.loadFailed}</AlertDescription></Alert>;
    }
    if (fw.baseRules === "disabled") return <p className="text-sm text-muted-foreground">{t.base.disabled}</p>;
    const disabled = !canChangeFirewall(fw.baseRules);
    return (
      <>
        {fw.baseRules === "current" ? (
          <p className="text-sm text-muted-foreground">{t.base.current}</p>
        ) : (
          <Alert variant="warning">
            <AlertDescription className="space-y-3">
              {/* Without a host row (written by the installer's setup step) there is nothing to apply the rules to. */}
              <p>{needsBaseRules(fw.baseRules) && !fw.hostId ? t.base.unregistered : t.base[fw.baseRules]}</p>
              {needsBaseRules(fw.baseRules) && apply("firewall:base", t.base.apply)}
            </AlertDescription>
          </Alert>
        )}
        {hasNotInForce(fw) && (
          <Alert variant="warning">
            <AlertDescription className="space-y-3">
              <p>{t.notInForce.banner}</p>
              {apply("firewall:again", t.notInForce.again)}
            </AlertDescription>
          </Alert>
        )}
        <Card>
          <CardHeader><CardTitle>{t.static.title}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <ul className="list-disc pl-5 space-y-1">
              {fw.staticRules.map((r) => <li key={r.key}>{format(t.static[r.key], { ports: r.ports.join(", ") })}</li>)}
            </ul>
            <p className="text-muted-foreground">{t.static.why}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t.portsCard.title}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">{t.portsCard.intro}</p>
            <FirewallPorts ports={fw.ports} csrfToken={session.csrfToken} disabled={disabled} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t.blocks.title}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t.blocks.intro}</p>
            <FirewallBlocks blocks={fw.blocks.map((b) => ({ ...b, since: formatZonedDate(b.createdAt, m.common.dateLocale) }))} csrfToken={session.csrfToken} disabled={disabled} />
          </CardContent>
        </Card>
      </>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
      </div>
      {body()}
    </div>
  );
}
