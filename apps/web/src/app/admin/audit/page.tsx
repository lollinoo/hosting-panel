import Link from "next/link";
import { format, getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerAudit } from "@/lib/server-api";
import { AUDIT_TRAIL_MAX, auditHref, parseTrail, type AuditFilters as Filters } from "@/lib/admin-address";
import { AuditTable } from "@/components/admin/audit-table";
import { AuditFilters } from "@/components/admin/audit-filters";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { ShieldCheck } from "lucide-react";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : undefined);

export default async function AdminAuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const q = await searchParams;
  const filters: Filters = {};
  for (const k of ["organizationId", "action", "from", "to"] as const) if (one(q[k])) filters[k] = one(q[k]);
  const trail = parseTrail(one(q.trail));
  const cursor = trail.at(-1);
  const [m, result] = await Promise.all([
    getRequestLocale().then(getMessages),
    fetchServerAudit(cursor ? { ...filters, cursor } : filters),
  ]);
  const t = m.admin.audit;
  const next = result.ok && result.page?.hasMore && result.page.nextCursor ? result.page.nextCursor : null;
  // At page AUDIT_TRAIL_MAX the trail stops growing: the admin narrows the range instead.
  const atLimit = trail.length + 1 >= AUDIT_TRAIL_MAX;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{t.subtitle}</p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck aria-hidden className="h-4 w-4 text-emerald-600" />
            <CardTitle className="text-base">{t.cardTitle}</CardTitle>
          </div>
          <CardDescription className="text-xs">{t.cardHint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <AuditFilters key={JSON.stringify(filters)} initial={filters} />
          {result.ok ? (
            <>
              <AuditTable initialEvents={result.data} />
              <nav aria-label={t.pages} className="flex items-center justify-between gap-3 text-xs">
                <span>{format(t.pageOf, { n: trail.length + 1 })}</span>
                <div className="flex gap-2">
                  {trail.length > 0 && (
                    <Button asChild size="sm" variant="outline">
                      <Link href={auditHref(filters, trail.slice(0, -1))}>{t.previous}</Link>
                    </Button>
                  )}
                  {next && !atLimit && (
                    <Button asChild size="sm" variant="outline">
                      <Link href={auditHref(filters, [...trail, next])}>{t.next}</Link>
                    </Button>
                  )}
                </div>
              </nav>
              {next && atLimit && <p className="text-xs text-muted-foreground">{t.narrow}</p>}
            </>
          ) : (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{result.status === 400 ? t.filtersInvalid : t.loadFailed}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
