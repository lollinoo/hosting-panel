"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import type { AdminUserDto } from "@hosting-panel/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorMessage, format } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { TempPasswordBody } from "./create-customer-dialog";

type Pending = { user: AdminUserDto; kind: "resetPassword" | "resetTotp" | "disable" };

export function UsersTable({ users, csrfToken }: { users: AdminUserDto[]; csrfToken: string }) {
  const m = useMessages();
  const t = m.admin.users;
  const router = useRouter();
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [temp, setTemp] = React.useState<{ password: string; who: string } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function run(user: AdminUserDto, kind: Pending["kind"] | "enable") {
    setBusy(true);
    setError(null);
    const base = `/api/admin/users/${encodeURIComponent(user.id)}`;
    const [url, method, body] =
      kind === "resetPassword"
        ? [`${base}/reset-password`, "POST", undefined]
        : kind === "resetTotp"
          ? [`${base}/reset-totp`, "POST", undefined]
          : [base, "PATCH", JSON.stringify({ status: kind === "enable" ? "active" : "disabled" })];
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) return setError(errorMessage(m, data?.error?.code ?? ""));
      setPending(null);
      if (kind === "resetPassword" && typeof data?.data?.temporaryPassword === "string") {
        setTemp({ password: data.data.temporaryPassword, who: user.name });
      }
      router.refresh();
    } catch {
      setError(m.errors.generic);
    } finally {
      setBusy(false);
    }
  }

  const confirmText = pending
    ? format(
        pending.kind === "resetPassword"
          ? t.confirmResetPassword
          : pending.kind === "resetTotp"
            ? t.confirmResetTotp
            : t.confirmDisable,
        { name: pending.user.name },
      )
    : "";

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t.colName}</TableHead>
            <TableHead>{t.colRole}</TableHead>
            <TableHead>{t.colStatus}</TableHead>
            <TableHead>{t.col2fa}</TableHead>
            <TableHead className="text-right">{t.colActions}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="text-center py-6 text-muted-foreground text-xs">
                {t.empty}
              </TableCell>
            </TableRow>
          ) : (
            users.map((u) => {
              const locked = u.lockedUntil && new Date(u.lockedUntil) > new Date();
              const isCustomer = u.role === "customer";
              return (
                <TableRow key={u.id}>
                  <TableCell>
                    <div className="font-medium">{u.name}</div>
                    <div className="text-xs text-muted-foreground">{u.email}</div>
                  </TableCell>
                  <TableCell>{isCustomer ? t.roleCustomer : t.roleAdmin}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <Badge variant={u.status === "active" ? "success" : "secondary"}>
                        {u.status === "active" ? t.active : t.disabled}
                      </Badge>
                      {locked && (
                        <Badge variant="warning">
                          {format(t.locked, { time: new Date(u.lockedUntil!).toLocaleTimeString(m.common.dateLocale) })}
                        </Badge>
                      )}
                      {u.mustChangePassword && <Badge variant="outline">{t.mustChange}</Badge>}
                    </div>
                  </TableCell>
                  <TableCell>{u.totpEnabled ? t.twoFaOn : t.twoFaOff}</TableCell>
                  <TableCell>
                    {isCustomer && (
                      <div role="group" aria-label={format(t.actionsFor, { name: u.name })} className="flex flex-wrap justify-end gap-2">
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => setPending({ user: u, kind: "resetPassword" })}>
                          {t.resetPassword}
                        </Button>
                        {u.totpEnabled && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => setPending({ user: u, kind: "resetTotp" })}>
                            {t.resetTotp}
                          </Button>
                        )}
                        {u.status === "active" ? (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => setPending({ user: u, kind: "disable" })}>
                            {t.disable}
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => run(u, "enable")}>
                            {t.enable}
                          </Button>
                        )}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
      {error && !pending && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <Dialog open={pending !== null} onOpenChange={(o) => !o && !busy && (setPending(null), setError(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pending ? t[pending.kind] : ""}</DialogTitle>
            <DialogDescription>{confirmText}</DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => { setPending(null); setError(null); }}>
              {m.common.cancel}
            </Button>
            <Button type="button" disabled={busy} onClick={() => pending && run(pending.user, pending.kind)}>
              {t.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={temp !== null} onOpenChange={(o) => !o && setTemp(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.tempTitle}</DialogTitle>
            <DialogDescription>{t.tempOnce}</DialogDescription>
          </DialogHeader>
          {temp && <TempPasswordBody password={temp.password} who={temp.who} />}
          <DialogFooter>
            <Button type="button" onClick={() => setTemp(null)}>
              {t.close}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
