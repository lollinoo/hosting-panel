"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { AdminSiteDto, AdminSitesListDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { errorMessage, format } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";

export type Customers = AdminSitesListDto["customers"];

/** "" means not assigned. */
export function OwnerSelect({ id, value, onChange, customers }: { id: string; value: string; onChange: (v: string) => void; customers: Customers }) {
  const t = useMessages().admin.sites;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t.owner}</Label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
      >
        <option value="">{t.unassignedOption}</option>
        {customers.map((c) => (
          <option key={c.organizationId} value={c.organizationId}>
            {format(t.customerOption, { name: c.name, email: c.ownerEmail })}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ChangeOwnerDialog({
  site,
  customers,
  csrfToken,
  onClose,
}: {
  site: AdminSiteDto | null;
  customers: Customers;
  csrfToken: string;
  onClose: () => void;
}) {
  const m = useMessages();
  const t = m.admin.sites;
  const router = useRouter();
  const keys = React.useRef<Record<string, string>>({});
  const [owner, setOwner] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setOwner(site?.owner?.organizationId ?? "");
    setError(null);
  }, [site]);

  const target = customers.find((c) => c.organizationId === owner);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!site) return;
    setBusy(true);
    setError(null);
    const sent = await keyedSend(keys.current, csrfToken, `owner:${site.id}:${owner}`, "POST", `/api/admin/sites/${site.id}/owner`, {
      ownerOrganizationId: owner || null,
    });
    setBusy(false);
    if (!sent.ok) return setError(errorMessage(m, sent.code));
    onClose();
    router.refresh();
  }

  return (
    <Dialog open={site !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{format(t.changeOwnerTitle, { site: site?.name ?? "" })}</DialogTitle>
            <DialogDescription>
              {owner && target
                ? format(t.moveTo, { site: site?.name ?? "", owner: target.name })
                : t.moveToNone}
            </DialogDescription>
          </DialogHeader>
          <OwnerSelect id="change-owner" value={owner} onChange={setOwner} customers={customers} />
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={busy || owner === (site?.owner?.organizationId ?? "")}>
              {busy ? t.working : t.confirmMove}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
