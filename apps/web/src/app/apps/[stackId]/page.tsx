import { notFound } from "next/navigation";
import { AppStackActions } from "@/components/app-stacks/app-stack-actions";
import { AppStackBackups } from "@/components/app-stacks/app-stack-backups";
import { AppStackDelete } from "@/components/app-stacks/app-stack-delete";
import { AppStackDomains } from "@/components/app-stacks/app-stack-domains";
import { AppStackLogs } from "@/components/app-stacks/app-stack-logs";
import { AppStackProgress } from "@/components/app-stacks/app-stack-progress";
import { AppStackSecrets } from "@/components/app-stacks/app-stack-secrets";
import { AppStackComponents, AppStackData, AppStackHistory, AppStackResources, AppStackSettings } from "@/components/app-stacks/app-stack-sections";
import { StackStatusBadge } from "@/components/app-stacks/app-stack-status";
import { AppsUnavailable, appsGate } from "@/components/app-stacks/apps-unavailable";
import { LoadError } from "@/components/shared/load-error";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { format, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import {
  fetchServerOrgAppStack,
  fetchServerOrgAppStackBackups,
  fetchServerOrgAppStackDeployments,
  fetchServerOrgAppStackDomains,
} from "@/lib/server-api";
import { getCustomerContext } from "@/app/sites/data";

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`app-section-${id}`} className="space-y-3">
      <h2 id={`app-section-${id}`} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default async function AppStackPage({ params }: { params: Promise<{ stackId: string }> }) {
  const ctx = await getCustomerContext();
  const locale = await getRequestLocale();
  const m = getMessages(locale);
  if (ctx.loadError) return <LoadError m={m} />;
  const gate = appsGate(ctx);
  if (gate) return <AppsUnavailable m={m} reason={gate} />;
  if (!ctx.orgId) return <LoadError m={m} />;
  const orgId = ctx.orgId;
  const { stackId } = await params;
  const r = await fetchServerOrgAppStack(orgId, stackId);
  if (!r.ok) {
    if (r.outcome === "notFound") notFound();
    return r.code === "NOT_SUPPORTED" ? <AppsUnavailable m={m} reason="off" /> : <LoadError m={m} />;
  }
  const s = r.data;
  const [deployments, domains, backups] = await Promise.all([
    fetchServerOrgAppStackDeployments(orgId, stackId),
    fetchServerOrgAppStackDomains(orgId, stackId),
    fetchServerOrgAppStackBackups(orgId, stackId),
  ]);
  const d = m.apps.detail;
  const csrfToken = ctx.session.csrfToken;
  const ids = { orgId, stackId, csrfToken };
  // The version that runs: after a change that failed once its components were being created, not the one asked for.
  const shown = s.installed ?? { templateVersionNumber: s.templateVersionNumber, revisionNumber: s.revisionNumber };

  return (
    <div className="space-y-8">
      <section aria-labelledby="app-title" className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 id="app-title" className="text-2xl font-bold tracking-tight">
            {s.name}
          </h1>
          <StackStatusBadge status={s.status} m={m} />
        </div>
        <p className="text-sm text-muted-foreground">{format(d.versionLine, { name: s.templateName, n: shown.templateVersionNumber })}</p>
        {shown.revisionNumber !== null && <p className="text-sm text-muted-foreground">{format(d.releaseLine, { n: shown.revisionNumber })}</p>}
        {s.installed && s.activeOperationId === null && s.revisionNumber !== null && (
          <p className="text-sm">{format(d.notInstalledLine, { version: s.templateVersionNumber, release: s.revisionNumber })}</p>
        )}
        {s.status === "unknown" && (
          <Alert variant="warning" role="status">
            <AlertTitle>{m.apps.status.unknown}</AlertTitle>
            <AlertDescription>{d.unknownBody}</AlertDescription>
          </Alert>
        )}
        {s.status === "draft" && (
          <Alert role="status">
            <AlertDescription>{d.draftBody}</AlertDescription>
          </Alert>
        )}
        {/* Work of the platform holds the application: a refused action has this to point at. */}
        {s.platformWork !== null && (
          <Alert role="status">
            <AlertDescription>{d.platformWork[s.platformWork]}</AlertDescription>
          </Alert>
        )}
        <AppStackActions {...ids} status={s.status} upgrade={s.upgrade} rollback={s.rollback} />
      </section>
      {s.activeOperationId !== null && <AppStackProgress orgId={orgId} operationId={s.activeOperationId} />}
      <Section id="components" title={d.section.components}>
        <AppStackComponents components={s.components} m={m} locale={locale} />
      </Section>
      <Section id="logs" title={d.section.logs}>
        <AppStackLogs orgId={orgId} stackId={stackId} componentKeys={s.components.map((c) => c.key)} />
      </Section>
      <Section id="settings" title={d.section.settings}>
        <AppStackSettings parameters={s.parameters} m={m} />
        <AppStackSecrets {...ids} secrets={s.secretParameters} />
      </Section>
      <Section id="domains" title={d.section.domains}>
        <AppStackDomains {...ids} initial={domains} ingress={s.ingress} pathTargets={s.pathTargets} pending={s.routesPending} />
      </Section>
      <Section id="data" title={d.section.data}>
        <AppStackData volumes={s.volumes} m={m} />
      </Section>
      <Section id="backups" title={d.section.backups}>
        <AppStackBackups {...ids} stackName={s.name} status={s.status} backups={backups} />
      </Section>
      <Section id="resources" title={d.section.resources}>
        <AppStackResources cpuMilli={s.cpuMilli} memoryBytes={s.memoryBytes} components={s.components} m={m} />
      </Section>
      <Section id="history" title={d.section.history}>
        <AppStackHistory deployments={deployments} m={m} locale={locale} />
      </Section>
      <Section id="danger" title={d.section.danger}>
        <AppStackDelete {...ids} stackName={s.name} hasData={s.volumes.length > 0} status={s.status} />
      </Section>
    </div>
  );
}
