"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { OwnerSelect, type Customers } from "@/components/admin/change-owner-dialog";
import { SiteForm, type SiteFormBody } from "@/components/customer/site-form";
import { errorMessage } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";

export function CreateSiteForCustomerDialog({ customers, csrfToken }: { customers: Customers; csrfToken: string }) {
  const m = useMessages();
  const t = m.admin.sites;
  const router = useRouter();
  const keys = React.useRef<Record<string, string>>({});
  const [open, setOpen] = React.useState(false);
  const [owner, setOwner] = React.useState(customers.length === 1 ? customers[0]!.organizationId : "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(body: SiteFormBody) {
    setBusy(true);
    setError(null);
    const sent = await keyedSend(keys.current, csrfToken, "create", "POST", "/api/admin/sites", {
      ...body,
      ownerOrganizationId: owner || null,
    });
    setBusy(false);
    if (!sent.ok) return setError(sent.code === "DOMAIN_CONFLICT" ? m.site.create.domainConflict : errorMessage(m, sent.code));
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">{t.create}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.createTitle}</DialogTitle>
          <DialogDescription>{t.createHint}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <SiteForm
          onSubmit={submit}
          submitting={busy}
          extraFields={<OwnerSelect id="create-owner" value={owner} onChange={setOwner} customers={customers} />}
        />
      </DialogContent>
    </Dialog>
  );
}
