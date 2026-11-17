"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Search, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/provider";
import { auditHref, isoToLocalInput, type AuditFilters as Filters } from "@/lib/admin-address";

// datetime-local → ISO in the browser's own zone; a value the browser cannot read goes as is, the API refuses it.
const toIso = (v: string) => {
  const d = new Date(v);
  return v && !Number.isNaN(d.getTime()) ? d.toISOString() : v;
};

/** Audit filters; Apply and Clear start again from the first page. */
export function AuditFilters({ initial }: { initial: Filters }) {
  const t = useMessages().admin.audit;
  const router = useRouter();
  const [org, setOrg] = React.useState(initial.organizationId ?? "");
  const [action, setAction] = React.useState(initial.action ?? "");
  // The browser's zone is only known on the client: the server renders the fields empty.
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  React.useEffect(() => {
    setFrom(isoToLocalInput(initial.from));
    setTo(isoToLocalInput(initial.to));
  }, [initial.from, initial.to]);

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    router.push(auditHref({ organizationId: org.trim(), action: action.trim(), from: toIso(from), to: toIso(to) }, []));
  };

  return (
    <form onSubmit={apply} className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
      <div className="relative flex-1">
        <Search aria-hidden className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input aria-label={t.filterOrg} placeholder={t.filterOrg} value={org} onChange={(e) => setOrg(e.target.value)} className="pl-8 text-xs" />
      </div>
      <div className="relative flex-1">
        <Filter aria-hidden className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input aria-label={t.filterAction} placeholder={t.filterAction} value={action} onChange={(e) => setAction(e.target.value)} className="pl-8 text-xs" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="audit-from">{t.from}</Label>
        <Input id="audit-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className="text-xs" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="audit-to">{t.to}</Label>
        <Input id="audit-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className="text-xs" />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          {t.apply}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => router.push("/admin/audit")}>
          {t.clear}
        </Button>
      </div>
    </form>
  );
}
