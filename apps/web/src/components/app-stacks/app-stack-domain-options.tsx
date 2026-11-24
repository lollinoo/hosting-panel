"use client";

import { useRef, useState } from "react";
import {
  APP_ROUTE_PASSWORD_PATTERN,
  APP_ROUTE_PATH_PREFIX_MAX,
  APP_ROUTE_PATH_PREFIX_PATTERN,
  APP_ROUTE_USERNAME_PATTERN,
  MAX_APP_ROUTE_PATHS,
  type AppStackDetailDto,
  type AppStackDomainDto,
  type UpdateAppStackDomainInput,
} from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format } from "@/i18n";
import { useMessages } from "@/i18n/provider";

/** A path as the form holds it: the target is `component:port`, so a target the application no longer has stays visible. */
export interface PathDraft {
  pathPrefix: string;
  target: string;
  stripPrefix: boolean;
}

const targetKey = (to: { componentKey: string; port: number }) => `${to.componentKey}:${String(to.port)}`;
const SELECT = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm";

/**
 * What the form sends, or the fields to correct. The same rules as UpdateAppStackDomainInputSchema, checked here
 * because a body the schema refuses comes back without saying which field is wrong.
 */
export function buildDomainOptions(
  form: { redirectTo: string; compression: boolean; protect: boolean; username: string; password: string; paths: readonly PathDraft[] },
  hasPassword: boolean,
): { ok: true; body: UpdateAppStackDomainInput } | { ok: false; problems: Record<string, "username" | "password" | "passwordRequired" | "path" | "pathTwice"> } {
  if (form.redirectTo !== "") {
    return { ok: true, body: { redirectToDomainId: form.redirectTo, compression: form.compression, protection: null, pathRoutes: [] } };
  }
  const problems: Record<string, "username" | "password" | "passwordRequired" | "path" | "pathTwice"> = {};
  const username = form.username.trim();
  if (form.protect) {
    if (!APP_ROUTE_USERNAME_PATTERN.test(username)) problems.username = "username";
    if (form.password === "") {
      if (!hasPassword) problems.password = "passwordRequired";
    } else if (!APP_ROUTE_PASSWORD_PATTERN.test(form.password)) problems.password = "password";
  }
  const seen = new Set<string>();
  const pathRoutes = form.paths.map((path, i) => {
    const pathPrefix = path.pathPrefix.trim();
    const cut = path.target.lastIndexOf(":");
    if (pathPrefix.length > APP_ROUTE_PATH_PREFIX_MAX || !APP_ROUTE_PATH_PREFIX_PATTERN.test(pathPrefix)) problems[`path:${String(i)}`] = "path";
    else if (seen.has(pathPrefix)) problems[`path:${String(i)}`] = "pathTwice";
    seen.add(pathPrefix);
    return { pathPrefix, componentKey: path.target.slice(0, cut), port: Number(path.target.slice(cut + 1)), stripPrefix: path.stripPrefix };
  });
  if (Object.keys(problems).length > 0) return { ok: false, problems };
  const protection = form.protect ? { username, ...(form.password === "" ? {} : { password: form.password }) } : null;
  return { ok: true, body: { redirectToDomainId: null, compression: form.compression, protection, pathRoutes } };
}

/**
 * Options of one web address: redirect, password, compression, paths. The four are sent together. The password is
 * write-only: it lives in its field until it is sent and is never shown again.
 */
export function AppStackDomainOptions({
  domain,
  rows,
  ingress,
  busy,
  error,
  onSave,
  onClose,
}: {
  domain: AppStackDomainDto;
  rows: readonly AppStackDomainDto[];
  ingress: AppStackDetailDto["ingress"];
  busy: boolean;
  error: string | null;
  onSave: (body: UpdateAppStackDomainInput) => void | Promise<void>;
  onClose: () => void;
}) {
  const m = useMessages();
  const t = m.apps.domains.options;
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const [redirectTo, setRedirectTo] = useState(domain.redirectToDomainId ?? "");
  const [compression, setCompression] = useState(domain.compression);
  const [protect, setProtect] = useState(domain.protection !== null);
  const [username, setUsername] = useState(domain.protection?.username ?? "");
  const [paths, setPaths] = useState<PathDraft[]>(domain.pathRoutes.map((p) => ({ pathPrefix: p.pathPrefix, target: targetKey(p), stripPrefix: p.stripPrefix })));
  const [problems, setProblems] = useState<Record<string, keyof typeof t.problems>>({});

  // A destination shows the application itself: an address that redirects, this one, or one being removed cannot be chosen.
  const destinations = rows.filter((r) => r.id !== domain.id && r.redirectToDomainId === null && !r.removing);
  const isDestination = rows.some((r) => r.redirectToDomainId === domain.id);
  const redirecting = redirectTo !== "";
  const hasPassword = domain.protection !== null;
  const targets = ingress.map((to) => ({ key: targetKey(to), text: format(m.apps.wizard.target, { component: to.componentKey, port: to.port }) }));
  const firstTarget = targets.some((to) => to.key === targetKey(domain)) ? targetKey(domain) : (targets[0]?.key ?? "");
  const setPath = (i: number, path: PathDraft) => setPaths(paths.map((p, j) => (j === i ? path : p)));
  const problem = (field: string) => {
    const kind = problems[field];
    return kind ? t.problems[kind] : null;
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const built = buildDomainOptions({ redirectTo, compression, protect, username, password: passwordRef.current?.value ?? "", paths }, hasPassword);
    if (!built.ok) return setProblems(built.problems);
    setProblems({});
    if (passwordRef.current) passwordRef.current.value = "";
    await onSave(built.body);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <DialogHeader>
            <DialogTitle>{format(t.title, { hostname: domain.hostname })}</DialogTitle>
            <DialogDescription>{t.intro}</DialogDescription>
          </DialogHeader>

          <div className="space-y-1">
            {isDestination || destinations.length === 0 ? (
              <>
                <p className="text-sm font-medium">{t.redirect}</p>
                <p className="text-sm text-muted-foreground">{isDestination ? t.redirectIsTarget : t.redirectNoTarget}</p>
              </>
            ) : (
              <>
                <Label htmlFor="app-domain-redirect">{t.redirect}</Label>
                <select
                  id="app-domain-redirect"
                  value={redirectTo}
                  onChange={(e) => setRedirectTo(e.target.value)}
                  disabled={busy}
                  aria-describedby="app-domain-redirect-note"
                  className={SELECT}
                >
                  <option value="">{t.redirectNone}</option>
                  {destinations.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.hostname}
                    </option>
                  ))}
                </select>
                <p id="app-domain-redirect-note" className="text-sm text-muted-foreground">
                  {redirecting ? t.redirectOn : t.redirectHint}
                </p>
              </>
            )}
          </div>

          {!redirecting && (
            <>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    id="app-domain-protect"
                    type="checkbox"
                    checked={protect}
                    onChange={(e) => setProtect(e.target.checked)}
                    disabled={busy}
                    aria-describedby="app-domain-protect-note"
                  />
                  <Label htmlFor="app-domain-protect">{t.protect}</Label>
                </div>
                <p id="app-domain-protect-note" className="text-sm text-muted-foreground">
                  {t.protectHint}
                </p>
                {protect && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor="app-domain-username">{t.username}</Label>
                      <Input
                        id="app-domain-username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={32}
                        readOnly={busy}
                        aria-invalid={problems.username !== undefined || undefined}
                        aria-describedby={problems.username ? "app-domain-username-problem" : undefined}
                      />
                      {problem("username") && (
                        <p id="app-domain-username-problem" role="alert" className="text-sm text-destructive">
                          {problem("username")}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="app-domain-password">{t.password}</Label>
                      <Input
                        id="app-domain-password"
                        ref={passwordRef}
                        type="password"
                        autoComplete="new-password"
                        spellCheck={false}
                        maxLength={128}
                        readOnly={busy}
                        aria-invalid={problems.password !== undefined || undefined}
                        aria-describedby={`app-domain-password-note${problems.password ? " app-domain-password-problem" : ""}`}
                      />
                      <p id="app-domain-password-note" className="text-sm text-muted-foreground">
                        {hasPassword ? t.passwordKeep : t.passwordNew}
                      </p>
                      {problem("password") && (
                        <p id="app-domain-password-problem" role="alert" className="text-sm text-destructive">
                          {problem("password")}
                        </p>
                      )}
                    </div>
                    {domain.certificateStatus !== "active" && (
                      <p role="status" className="text-sm font-medium sm:col-span-2">
                        {t.insecure}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <input
                    id="app-domain-compression"
                    type="checkbox"
                    checked={compression}
                    onChange={(e) => setCompression(e.target.checked)}
                    disabled={busy}
                    aria-describedby="app-domain-compression-note"
                  />
                  <Label htmlFor="app-domain-compression">{t.compression}</Label>
                </div>
                <p id="app-domain-compression-note" className="text-sm text-muted-foreground">
                  {t.compressionHint}
                </p>
              </div>

              {targets.length > 0 && (
                <details open={domain.pathRoutes.length > 0 || undefined} className="space-y-3 rounded-md border p-3 text-sm">
                  <summary className="cursor-pointer font-medium">{t.pathsAdvanced}</summary>
                  <p id="app-domain-paths-note" className="mt-2 text-muted-foreground">
                    {t.pathsHint}
                  </p>
                  {paths.map((path, i) => {
                    const id = `app-domain-path-${String(i)}`;
                    const n = i + 1;
                    const known = targets.some((to) => to.key === path.target);
                    return (
                      <div key={i} className="mt-3 space-y-2 rounded-md border p-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1">
                            <Label htmlFor={id}>{format(t.path, { n })}</Label>
                            <Input
                              id={id}
                              value={path.pathPrefix}
                              onChange={(e) => setPath(i, { ...path, pathPrefix: e.target.value })}
                              autoComplete="off"
                              spellCheck={false}
                              maxLength={APP_ROUTE_PATH_PREFIX_MAX}
                              readOnly={busy}
                              aria-invalid={problems[`path:${String(i)}`] !== undefined || undefined}
                              aria-describedby={`app-domain-paths-note${problems[`path:${String(i)}`] ? ` ${id}-problem` : ""}`}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`${id}-target`}>{format(t.pathTarget, { n })}</Label>
                            <select
                              id={`${id}-target`}
                              value={path.target}
                              onChange={(e) => setPath(i, { ...path, target: e.target.value })}
                              disabled={busy}
                              className={SELECT}
                            >
                              {!known && <option value={path.target}>{t.pathTargetGone}</option>}
                              {targets.map((to) => (
                                <option key={to.key} value={to.key}>
                                  {to.text}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        {problem(`path:${String(i)}`) && (
                          <p id={`${id}-problem`} role="alert" className="text-destructive">
                            {problem(`path:${String(i)}`)}
                          </p>
                        )}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <input
                              id={`${id}-strip`}
                              type="checkbox"
                              checked={path.stripPrefix}
                              onChange={(e) => setPath(i, { ...path, stripPrefix: e.target.checked })}
                              disabled={busy}
                            />
                            <Label htmlFor={`${id}-strip`}>{format(t.pathStrip, { n })}</Label>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            aria-label={format(t.pathRemove, { n })}
                            onClick={() => {
                              setPaths(paths.filter((_, j) => j !== i));
                              setProblems({});
                            }}
                          >
                            {m.apps.domains.remove}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                  {paths.length < MAX_APP_ROUTE_PATHS && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      disabled={busy}
                      onClick={() => setPaths([...paths, { pathPrefix: "", target: firstTarget, stripPrefix: false }])}
                    >
                      {t.pathAdd}
                    </Button>
                  )}
                </details>
              )}
            </>
          )}

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {m.apps.actions.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t.saving : t.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
