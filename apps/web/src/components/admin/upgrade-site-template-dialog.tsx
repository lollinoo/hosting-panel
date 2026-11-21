"use client";

import * as React from "react";
import type { AdminSiteDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { errorMessage, format } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";

/** The newer default version of the site's template, or null when the site has no template or is not behind it. */
export function upgradeTarget(s: AdminSiteDto): { versionId: string; versionNumber: number; templateName: string } | null {
  const r = s.template ?? null;
  if (!r || r.defaultVersionId === null || r.defaultVersionNumber === null || r.defaultVersionNumber <= r.versionNumber) return null;
  return { versionId: r.defaultVersionId, versionNumber: r.defaultVersionNumber, templateName: r.templateName };
}

export function UpgradeSiteTemplateDialog({
  site,
  csrfToken,
  onClose,
  onDone,
}: {
  site: AdminSiteDto | null;
  csrfToken: string;
  onClose: () => void;
  onDone: (text: string) => void;
}) {
  const m = useMessages();
  const t = m.admin.sites;
  const keys = React.useRef<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const target = site ? upgradeTarget(site) : null;

  React.useEffect(() => setError(null), [site]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!site || !target) return;
    setBusy(true);
    setError(null);
    const sent = await keyedSend(keys.current, csrfToken, `upgrade:${site.id}:${target.versionId}`, "POST", `/api/admin/sites/${site.id}/template-version`, {
      versionId: target.versionId,
    });
    setBusy(false);
    if (!sent.ok) return setError(errorMessage(m, sent.code));
    onClose();
    onDone(t.accepted);
  }

  return (
    <Dialog open={site !== null && target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {site && target ? format(t.upgradeTitle, { site: site.name, name: target.templateName, version: target.versionNumber }) : ""}
            </DialogTitle>
            <DialogDescription>{t.upgradeBody}</DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t.working : t.upgradeConfirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
