"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AppStackLinksDtoSchema,
  MAX_APP_STACK_LINKS_PER_APPLICATION,
  MAX_APP_STACK_LINKS_PER_DATABASE,
  type AppStackLinkConnectionDto,
  type AppStackLinkDto,
  type AppStackLinksDto,
} from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { format, type Messages } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";
import { appHref, appStackRefusalText } from "./app-stack-view";

const tone = (s: AppStackLinkDto["state"]) => (s === "active" ? "success" : "secondary");

/** The two values the customer types into the application: the name the database answers at, and its port. */
function Address({ connection, t }: { connection: AppStackLinkConnectionDto | null; t: Messages["apps"]["links"] }) {
  if (connection === null) return <p className="text-muted-foreground">{t.noAddress}</p>;
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1">
      <div className="flex gap-2">
        <dt className="text-muted-foreground">{t.host}</dt>
        <dd>
          <code className="select-all font-mono">{connection.host}</code>
        </dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-muted-foreground">{t.port}</dt>
        <dd>
          <code className="select-all font-mono">{connection.port}</code>
        </dd>
      </div>
    </dl>
  );
}

/**
 * A database shows where it is reached and the applications that use it; any other application shows the databases it
 * uses and connects one more. Connecting and disconnecting are synchronous and the answer is the whole section.
 * Nothing here knows a user name or a password: the customer types them into the application.
 */
export function AppStackLinks({
  orgId,
  stackId,
  csrfToken,
  initial,
}: {
  orgId: string;
  stackId: string;
  csrfToken: string;
  initial: AppStackLinksDto | null;
}) {
  const m = useMessages();
  const t = m.apps.links;
  const router = useRouter();
  const keys = useRef<Record<string, string>>({});
  const [data, setData] = useState<AppStackLinksDto | null>(initial);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // router.refresh() keeps client state: take the fresh server answer.
  useEffect(() => {
    if (initial) setData(initial);
  }, [initial]);
  const base = `/api/bff/orgs/${orgId}/app-stacks/${stackId}/links`;

  if (initial === null || data === null) return <p className="text-sm text-muted-foreground">{m.apps.detail.sectionError}</p>;

  const { links, candidates } = data;
  const isDatabase = data.role === "database";
  const confirming = links.find((l) => l.id === removing);
  const chosen = candidates.some((c) => c.stackId === choice) ? choice : (candidates[0]?.stackId ?? "");

  async function send(name: string, method: string, url: string, body: object): Promise<boolean> {
    setBusy(true);
    setError(null);
    const sent = await keyedSend(keys.current, csrfToken, name, method, url, body);
    setBusy(false);
    if (!sent.ok) {
      // The plan's sentence for this reason speaks of applications and resources: here the limit is of links.
      setError(
        sent.reason === "STACK_QUOTA_EXCEEDED"
          ? format(t.limitReached, { databases: MAX_APP_STACK_LINKS_PER_APPLICATION, applications: MAX_APP_STACK_LINKS_PER_DATABASE })
          : appStackRefusalText(m, sent.code, sent.reason),
      );
      return false;
    }
    const answered = AppStackLinksDtoSchema.safeParse((sent.data as { data?: unknown } | null)?.data);
    if (answered.success) setData(answered.data);
    router.refresh();
    return true;
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (busy || chosen === "") return;
    if (await send(`connect:${chosen}`, "POST", base, { databaseStackId: chosen })) setChoice("");
  }

  async function disconnect(id: string) {
    if (busy) return;
    await send(`disconnect:${id}`, "DELETE", `${base}/${id}`, {});
    setRemoving(null);
  }

  const rows = (
    <ul className="divide-y rounded-md border text-sm">
      {links.map((l) => (
        <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
          <div className="space-y-1">
            <p className="font-medium">
              <Link href={appHref("stack", isDatabase ? l.applicationStackId : l.databaseStackId)} className="underline-offset-4 hover:underline">
                {isDatabase ? l.applicationName : l.databaseName}
              </Link>
            </p>
            {!isDatabase && (
              <>
                <p className="text-muted-foreground">{l.databaseKind}</p>
                <Address connection={l.connection} t={t} />
              </>
            )}
            <Badge variant={tone(l.state)}>{t.state[l.state]}</Badge>
          </div>
          {l.state !== "removing" && (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setRemoving(l.id)}>
              {t.disconnect}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="space-y-3">
      {isDatabase ? (
        <>
          <div className="space-y-2 text-sm">
            <h3 className="font-medium">{t.addressTitle}</h3>
            {data.connection === null ? (
              <p className="text-muted-foreground">{t.notLinkable}</p>
            ) : (
              <>
                <Address connection={data.connection} t={t} />
                <p className="text-muted-foreground">{t.addressHint}</p>
              </>
            )}
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">{t.usedByTitle}</h3>
            {links.length === 0 ? <p className="text-sm text-muted-foreground">{t.usedByNone}</p> : rows}
            <p className="text-sm text-muted-foreground">{t.usedByHint}</p>
          </div>
        </>
      ) : (
        <>
          {links.length === 0 ? <p className="text-sm text-muted-foreground">{t.none}</p> : rows}
          {links.length >= data.limit ? (
            <p className="text-sm text-muted-foreground">{format(t.limit, { n: data.limit })}</p>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t.noCandidates}{" "}
              <Link href="/apps/new" className="underline">
                {t.catalog}
              </Link>
            </p>
          ) : (
            <form onSubmit={connect} className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="app-link-database">{t.choose}</Label>
                <select
                  id="app-link-database"
                  value={chosen}
                  onChange={(e) => setChoice(e.target.value)}
                  disabled={busy}
                  aria-describedby="app-link-hint"
                  className="flex h-9 rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  {candidates.map((c) => (
                    <option key={c.stackId} value={c.stackId}>
                      {format(t.candidate, { name: c.name, kind: c.kind })}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="submit" disabled={busy}>
                {t.connect}
              </Button>
            </form>
          )}
          <p id="app-link-hint" className="text-sm text-muted-foreground">
            {t.connectHint}
          </p>
        </>
      )}
      {links.some((l) => l.state === "pending") && <p className="text-sm text-muted-foreground">{t.pendingHint}</p>}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Dialog open={confirming !== undefined} onOpenChange={(o) => !o && !busy && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.disconnectTitle}</DialogTitle>
            <DialogDescription>
              {format(t.disconnectBody, { application: confirming?.applicationName ?? "", database: confirming?.databaseName ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setRemoving(null)}>
              {m.apps.actions.cancel}
            </Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => confirming && disconnect(confirming.id)}>
              {t.disconnect}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
