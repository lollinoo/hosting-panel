import type { OperationDto, OperationKind, OperationStatus } from "@hosting-panel/contracts";
import { format, getMessages, type Messages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerOrgOperations } from "@/lib/server-api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SiteProgress } from "@/components/customer/site-progress";
import { StatusPill, toSiteStatusView } from "@/components/customer/status-pill";
import { getCustomerContext, getSite } from "../data";

// Only operations a site owner would recognise; anything else is not shown.
const ACTIVITY: Partial<Record<OperationKind, keyof Messages["site"]["activity"]>> = {
  "site.deploy": "deploy",
  "service.deploy": "deploy",
  "service.restart": "restart",
  "service.stop": "stop",
};

const outcome = (s: OperationStatus) =>
  s === "succeeded" ? "done" : s === "failed" || s === "cancelled" ? "failed" : "running";

export default async function SiteOverviewPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const { orgId, session } = await getCustomerContext();
  const result = await getSite(orgId, siteId);
  if (!result.ok || !orgId) return null; // the layout shows the 404 or the load error
  const site = result.data;

  const locale = await getRequestLocale();
  const m = getMessages(locale);
  const ids = new Set([site.id, ...site.services.map((s) => s.id), ...site.domains.map((d) => d.id)]);
  const operations = await fetchServerOrgOperations(orgId);
  const recent = (operations ?? [])
    .filter((op: OperationDto) => ids.has(op.resourceId) && ACTIVITY[op.kind])
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
    .slice(0, 5);
  const provision = (operations ?? [])
    .filter((op: OperationDto) => op.kind === "site.provision" && op.resourceId === site.id)
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
  // A degraded site only shows the setup when that is what failed.
  const showProgress =
    site.phpVersion !== null &&
    (site.status === "deploying" || (site.status === "degraded" && provision?.status === "failed"));
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const { labelKey } = toSiteStatusView(site.status, site.driftSummary);

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {showProgress && (
        <div className="md:col-span-2">
          <SiteProgress
            orgId={orgId}
            siteId={site.id}
            csrfToken={session.csrfToken}
            initial={provision ? { id: provision.id, status: provision.status, steps: provision.steps } : null}
          />
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{m.site.overview.statusTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <StatusPill status={site.status} driftSummary={site.driftSummary} labels={m.site.status} />
          <p className="text-sm text-muted-foreground">{m.site.statusHint[labelKey]}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{m.site.overview.domainsTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          {site.domains.length === 0 ? (
            <CardDescription>{m.site.overview.noDomains}</CardDescription>
          ) : (
            <ul className="divide-y text-sm">
              {site.domains.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-4 py-2">
                  <span className="truncate font-medium">{d.hostname}</span>
                  <span className="shrink-0 text-muted-foreground">{m.site.domainStatus[d.status]}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="md:col-span-2">
        <CardHeader>
          <CardTitle className="text-base">{m.site.overview.activityTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          {operations === null ? (
            <CardDescription role="alert">{m.site.overview.activityLoadError}</CardDescription>
          ) : recent.length === 0 ? (
            <CardDescription>{m.site.overview.noActivity}</CardDescription>
          ) : (
            <ul className="divide-y text-sm">
              {recent.map((op) => (
                <li key={op.id} className="flex items-center justify-between gap-4 py-2">
                  <span>
                    {format(m.site.activity[outcome(op.status)], { action: m.site.activity[ACTIVITY[op.kind]!] })}
                  </span>
                  <time dateTime={op.submittedAt} className="shrink-0 text-muted-foreground">
                    {when.format(new Date(op.submittedAt))}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
