"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FIREWALL_ADDRESS_MAX, FIREWALL_NOTE_MAX, type FirewallDto } from "@hosting-panel/contracts";
import { ConfirmAction } from "@/components/admin/confirm-action";
import { FirewallStateBadge } from "@/components/admin/firewall-ports";
import { guardDialogClose } from "@/components/customer/file-dialogs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { firewallErrorText } from "@/lib/admin-firewall";
import { keyedSend } from "@/lib/keyed-send";

type Block = FirewallDto["blocks"][number] & { since: string };

/** The block form with its confirmation, and the blocked addresses newest first with Unblock. */
export function FirewallBlocks({ blocks, csrfToken, disabled }: { blocks: Block[]; csrfToken: string; disabled: boolean }) {
  const m = useMessages();
  const t = m.admin.firewall.blocks;
  const router = useRouter();
  const keys = React.useRef<Record<string, string>>({});
  const busyRef = React.useRef(false);
  const [address, setAddress] = React.useState("");
  const [note, setNote] = React.useState("");
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function block() {
    busyRef.current = true;
    setBusy(true);
    const body = { address: address.trim(), note: note.trim() || null };
    const sent = await keyedSend(keys.current, csrfToken, `block:${body.address}:${body.note ?? ""}`, "POST", "/api/admin/firewall/blocks", body);
    busyRef.current = false;
    setBusy(false);
    setConfirming(false);
    if (!sent.ok) return setError(firewallErrorText(m, sent.code, sent.reason));
    setAddress("");
    setNote("");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <form className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (address.trim()) setConfirming(true);
        }}>
        <div className="space-y-1">
          <Label htmlFor="firewall-block-address">{t.address}</Label>
          <Input id="firewall-block-address" name="address" value={address} onChange={(e) => setAddress(e.target.value)}
            maxLength={FIREWALL_ADDRESS_MAX} required disabled={disabled} autoComplete="off" spellCheck={false} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="firewall-block-note">{format(t.note, { max: FIREWALL_NOTE_MAX })}</Label>
          <Input id="firewall-block-note" name="note" value={note} onChange={(e) => setNote(e.target.value)}
            maxLength={FIREWALL_NOTE_MAX} disabled={disabled} aria-describedby="firewall-block-note-hint" />
          <p id="firewall-block-note-hint" className="text-xs text-muted-foreground">{t.noteHint}</p>
        </div>
        <Button type="submit" variant="destructive" disabled={disabled || busy}>{t.add}</Button>
      </form>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Dialog open={confirming} onOpenChange={guardDialogClose(() => busyRef.current, setConfirming)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{format(t.confirmTitle, { address: address.trim() })}</DialogTitle>
            <DialogDescription>{format(t.confirmBody, { address: address.trim() })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={busy}>{m.common.cancel}</Button>
            <Button type="button" variant="destructive" onClick={() => void block()} disabled={busy}>{t.confirm}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {blocks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.colWhat}</TableHead>
              <TableHead>{t.colNote}</TableHead>
              <TableHead>{t.colSince}</TableHead>
              <TableHead>{t.colState}</TableHead>
              <TableHead>{t.colActions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {blocks.map((b) => (
              <TableRow key={b.id}>
                <TableCell className="font-mono text-xs">{b.address}</TableCell>
                <TableCell className="text-sm break-words">{b.note}</TableCell>
                <TableCell className="text-sm">{b.since}</TableCell>
                <TableCell><FirewallStateBadge inForce={b.inForce} /></TableCell>
                <TableCell>
                  <ConfirmAction csrfToken={csrfToken} name={`unblock:${b.id}`} url={`/api/admin/firewall/blocks/${b.id}`} method="DELETE"
                    label={t.unblock} ariaLabel={format(t.unblockLabel, { address: b.address })} errors="firewall" disabled={disabled} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
