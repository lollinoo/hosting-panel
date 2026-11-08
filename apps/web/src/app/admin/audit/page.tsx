import { getMessages } from "@/i18n";
import { getRequestLocale } from "@/i18n/server";
import { fetchServerAudit } from "@/lib/server-api";
import { AuditTable } from "@/components/admin/audit-table";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { ShieldCheck } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage() {
  const [m, events] = await Promise.all([getRequestLocale().then(getMessages), fetchServerAudit()]);
  const t = m.admin.audit;

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
        <CardContent>
          <AuditTable initialEvents={events} />
        </CardContent>
      </Card>
    </div>
  );
}
