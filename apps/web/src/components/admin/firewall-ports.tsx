"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { FirewallDto, FirewallPortName } from "@hosting-panel/contracts";
import { guardDialogClose } from "@/components/customer/file-dialogs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { format } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { firewallErrorText } from "@/lib/admin-firewall";
import { keyedSend } from "@/lib/keyed-send";

/** Whether a stored entry is applied on the server, in words. */
export function FirewallStateBadge({ inForce }: { inForce: boolean | null }) {
  const s = useMessages().admin.firewall.state;
  return inForce === null ? <Badge variant="outline">{s.unknown}</Badge>
    : inForce ? <Badge variant="success">{s.inForce}</Badge>
    : <Badge variant="warning">{s.notInForce}</Badge>;
}

/** One row per port of the safe list: its sentence, an open/closed switch and its state. */
export function FirewallPorts({ ports, csrfToken, disabled }: { ports: FirewallDto["ports"]; csrfToken: string; disabled: boolean }) {
  const m = useMessages();
  const t = m.admin.firewall;
  const router = useRouter();
  const keys = React.useRef<Record<string, string>>({});
  const busyRef = React.useRef(false);
  const [busy, setBusy] = React.useState<FirewallPortName | null>(null);
  const [closing, setClosing] = React.useState<FirewallDto["ports"][number] | null>(null);
  const [error, setError] = React.useState<{ name: FirewallPortName; text: string } | null>(null);

  async function send(name: FirewallPortName, open: boolean) {
    busyRef.current = true;
    setBusy(name);
    setError(null);
    const action = open ? "open" : "close";
    const sent = await keyedSend(keys.current, csrfToken, `port:${name}:${action}`, "POST", `/api/admin/firewall/ports/${name}/${action}`, {});
    busyRef.current = false;
    setBusy(null);
    setClosing(null);
    if (!sent.ok) setError({ name, text: firewallErrorText(m, sent.code, sent.reason) });
    else router.refresh();
  }

  return (
    <>
      <ul className="divide-y">
        {ports.map((p) => (
          <li key={p.name} className="flex flex-wrap items-center gap-3 py-3">
            <Button type="button" role="switch" aria-checked={p.open} size="sm" variant={p.open ? "default" : "outline"}
              aria-label={format(t.portsCard.switchLabel, { port: p.port })} disabled={disabled || busy !== null}
              onClick={() => (p.open ? setClosing(p) : void send(p.name, true))}>
              {p.open ? t.portsCard.open : t.portsCard.closed}
            </Button>
            <span className="flex-1 min-w-[16rem] text-sm">{format(t.ports[p.name], { port: p.port })}</span>
            <FirewallStateBadge inForce={p.inForce} />
            {error?.name === p.name && <p role="alert" className="basis-full text-xs text-destructive">{error.text}</p>}
          </li>
        ))}
      </ul>
      <Dialog open={closing !== null} onOpenChange={guardDialogClose(() => busyRef.current, (o: boolean) => !o && setClosing(null))}>
        <DialogContent>
          {closing && (
            <>
              <DialogHeader>
                <DialogTitle>{format(t.portsCard.closeTitle, { port: closing.port })}</DialogTitle>
                <DialogDescription>{format(t.portsCard.closeBody, { port: closing.port })}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setClosing(null)} disabled={busy !== null}>{m.common.cancel}</Button>
                <Button type="button" variant="destructive" onClick={() => void send(closing.name, false)} disabled={busy !== null}>
                  {t.portsCard.closeConfirm}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
