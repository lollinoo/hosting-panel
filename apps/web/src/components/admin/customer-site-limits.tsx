"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { UpdateOrganizationSiteLimitInputSchema, type AdminSitesListDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage, format, type Messages } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";

export type SiteLimitCustomer = AdminSitesListDto["customers"][number];

/** "3 di 5", or "3 (nessun limite)" without a limit. */
export function siteUsageText(t: Messages["admin"]["sites"]["customers"], used: number, max: number | null): string {
  return max === null ? format(t.usageUnlimited, { used }) : format(t.usage, { used, max });
}

/** The form's value as the request body wants it: "No limit" is null; what the contract would refuse is "invalid". */
export function parseSiteLimit(input: string, unlimited: boolean): number | null | "invalid" {
  if (unlimited) return null;
  const text = input.trim();
  const parsed = UpdateOrganizationSiteLimitInputSchema.safeParse({ maxSites: /^\d+$/.test(text) ? Number(text) : text });
  return parsed.success ? parsed.data.maxSites : "invalid";
}

/** What each customer may have and uses, with the editor of the limit. */
export function CustomerSiteLimits({ customers, csrfToken }: { customers: SiteLimitCustomer[]; csrfToken: string }) {
  const m = useMessages();
  const t = m.admin.sites.customers;
  const router = useRouter();
  const keys = useRef<Record<string, string>>({});
  const [editing, setEditing] = useState<SiteLimitCustomer | null>(null);
  const [unlimited, setUnlimited] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (customers.length === 0) return null;

  const parsed = editing ? parseSiteLimit(value, unlimited) : null;

  function edit(c: SiteLimitCustomer) {
    setEditing(c);
    setUnlimited(c.maxSites === null);
    setValue(c.maxSites === null ? "" : String(c.maxSites));
    setError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const maxSites = parseSiteLimit(value, unlimited);
    if (maxSites === "invalid") return setError(t.invalid);
    setBusy(true);
    setError(null);
    const orgId = editing.organizationId;
    const sent = await keyedSend(keys.current, csrfToken, `limit:${orgId}`, "PATCH", `/api/admin/organizations/${orgId}/site-limit`, { maxSites });
    setBusy(false);
    if (!sent.ok) return setError(errorMessage(m, sent.code));
    setEditing(null);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.title}</CardTitle>
        <CardDescription>{t.intro}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.colCustomer}</TableHead>
              <TableHead>{t.colSites}</TableHead>
              <TableHead className="text-right">{t.colActions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.map((c) => (
              <TableRow key={c.organizationId}>
                <TableCell>
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">{c.ownerEmail}</div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <span>{siteUsageText(t, c.siteCount, c.maxSites)}</span>
                    {c.maxSites !== null && c.siteCount >= c.maxSites && <Badge variant="warning">{t.full}</Badge>}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <Button size="sm" variant="outline" aria-label={format(t.editAria, { name: c.name })} onClick={() => edit(c)}>
                    {t.edit}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && !busy && setEditing(null)}>
        <DialogContent>
          <form onSubmit={save} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{format(t.editTitle, { name: editing?.name ?? "" })}</DialogTitle>
            </DialogHeader>
            <label className="flex items-center gap-2 text-sm" htmlFor="site-limit-unlimited">
              <input id="site-limit-unlimited" type="checkbox" checked={unlimited} onChange={(e) => setUnlimited(e.target.checked)} />
              {t.unlimitedLabel}
            </label>
            <div className="space-y-2">
              <Label htmlFor="site-limit-max">{t.maxLabel}</Label>
              <Input
                id="site-limit-max"
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                value={value}
                disabled={unlimited}
                onChange={(e) => setValue(e.target.value)}
              />
              {editing && typeof parsed === "number" && parsed < editing.siteCount && (
                <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
                  {format(t.belowUsage, { name: editing.name, used: editing.siteCount, max: parsed })}
                </p>
              )}
            </div>
            {error && (
              <Alert variant="destructive" role="alert">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)} disabled={busy}>
                {t.cancel}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? t.saving : t.save}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
