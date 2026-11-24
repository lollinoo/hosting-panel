import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { format, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { getServerSession } from "@/lib/server-session";
import { fetchServerAdminAppStack } from "@/lib/server-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AppStackUnavailable } from "@/components/admin/app-stack-unavailable";
import { AppStackLogs } from "@/components/app-stacks/app-stack-logs";

export const dynamic = "force-dynamic";

/** One customer's application for the server administrator (ADR-0041): whose it is, its components, their logs and a terminal in each. */
export default async function AdminAppStackPage({ params }: { params: Promise<{ stackId: string }> }) {
  const session = await getServerSession();
  if (!session) redirect("/login");
  const { stackId } = await params;
  const [m, r] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAdminAppStack(stackId)]);
  if (!r.ok) {
    if (r.outcome === "notFound") notFound();
    return <AppStackUnavailable m={m} code={r.code} />;
  }
  const t = m.admin.appStack;
  const stack = r.data;

  return (
    <div className="space-y-6">
      <Link href="/admin/sites" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft aria-hidden className="h-4 w-4" />
        {t.back}
      </Link>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{stack.name}</h1>
          <Badge variant="outline">{m.admin.appTemplates.stackStatus[stack.status]}</Badge>
        </div>
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted-foreground">{t.customer}</dt>
          <dd>{stack.organizationName}</dd>
          <dt className="text-muted-foreground">{t.template}</dt>
          <dd>{format(m.admin.sites.templateVersion, { name: stack.templateName, version: stack.versionNumber })}</dd>
          <dt className="text-muted-foreground">{t.address}</dt>
          <dd>{stack.primaryHostname ?? t.noAddress}</dd>
        </dl>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t.componentsTitle}</CardTitle>
          <CardDescription>{t.componentsHint}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.colComponent}</TableHead>
                <TableHead>{t.colHealth}</TableHead>
                <TableHead>{t.colActions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stack.components.map((c) => (
                <TableRow key={c.key}>
                  <TableCell className="font-mono">{c.key}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{m.apps.health[c.health]}</Badge>
                  </TableCell>
                  <TableCell>
                    <Button asChild size="sm" variant="outline">
                      <Link href={`/admin/apps/${stack.id}/terminal/${c.key}`} aria-label={format(t.terminalAria, { component: c.key })}>
                        {t.terminalLink}
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t.logsTitle}</CardTitle>
          <CardDescription>{t.logsHint}</CardDescription>
        </CardHeader>
        <CardContent>
          <AppStackLogs
            orgId={stack.organizationId}
            stackId={stack.id}
            componentKeys={stack.components.map((c) => c.key)}
            basePath={`/api/admin/app-stacks/${stack.id}`}
          />
        </CardContent>
      </Card>
    </div>
  );
}
