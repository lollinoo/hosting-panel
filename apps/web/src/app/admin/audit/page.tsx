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
  const events = await fetchServerAudit();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Registro Audit Immutabile</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Tracciamento forense conforme ad append-only triggers per ogni mutazione autoritativa (HCP-SPEC-002 §4.3).
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            <CardTitle className="text-base">Eventi di Sicurezza e Operazioni di Sistema</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Ogni operazione registrata è protetta da vincoli SQL di sola aggiunta e non può essere modificata o cancellata.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AuditTable initialEvents={events} />
        </CardContent>
      </Card>
    </div>
  );
}
