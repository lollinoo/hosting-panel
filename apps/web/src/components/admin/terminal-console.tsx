"use client";

import * as React from "react";
import { AppTerminalSessionDtoSchema, TerminalSessionDtoSchema, type TerminalSessionDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { emptyText, feed, type TerminalText } from "@/lib/terminal-text";
import { endText, inputFits, keyToInput, runReadLoop, terminalErrorText } from "@/lib/terminal-session";

/** The output as text nodes only: finished lines in a polite log, the line in progress outside it. */
export function TerminalOutput({ text, label }: { text: TerminalText; label: string }) {
  const box = React.useRef<HTMLDivElement>(null);
  const atEnd = React.useRef(true);
  React.useEffect(() => {
    if (box.current && atEnd.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);
  return (
    <div
      ref={box}
      tabIndex={0}
      role="region"
      aria-label={label}
      onScroll={(e) => {
        const b = e.currentTarget;
        atEnd.current = b.scrollHeight - b.scrollTop - b.clientHeight < 20;
      }}
      className="max-h-[60vh] overflow-auto rounded-md border bg-muted p-3 font-mono text-sm whitespace-pre-wrap break-all"
    >
      <div role="log" aria-live="polite" aria-relevant="additions" aria-label={label}>
        {text.lines.map((l, i) => (
          <div key={text.base + i}>{l || " "}</div>
        ))}
      </div>
      <div>{text.current}</div>
    </div>
  );
}

type Phase = "code" | "opening" | "open" | "ended";

/** One component of a customer's application, as the place of the shell instead of a site (ADR-0041). */
export interface TerminalComponent {
  readonly stackId: string;
  readonly componentKey: string;
}

type TerminalConsoleProps = { csrfToken: string } & (
  | { siteId: string; component?: undefined }
  | { siteId?: undefined; component: TerminalComponent }
);

/** A plain-text shell on one site, or in one component of an application: code, opening, open, ended. */
export function TerminalConsole({ siteId, component, csrfToken }: TerminalConsoleProps) {
  const m = useMessages();
  const t = m.admin.terminal;
  const kind = component ? "component" : "site";
  // What differs between the two is the address of the open call, its answer and a few sentences.
  const about = component ? m.admin.appStack.terminal : t;
  const [phase, setPhase] = React.useState<Phase>("code");
  const [code, setCode] = React.useState("");
  const [notice, setNotice] = React.useState<string | null>(null);
  const [session, setSession] = React.useState<Pick<TerminalSessionDto, "sessionId" | "expiresAt"> | null>(null);
  const [text, setText] = React.useState<TerminalText>(emptyText);
  const [line, setLine] = React.useState("");
  const [inputError, setInputError] = React.useState<string | null>(null);
  const [reconnecting, setReconnecting] = React.useState(false);
  const codeRef = React.useRef<HTMLInputElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const live = React.useRef<{ id: string; abort: AbortController } | null>(null);
  const writes = React.useRef<Promise<void>>(Promise.resolve());
  const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrfToken };

  // Stops reading and tells the server; keepalive lets it leave with the page.
  const leave = React.useCallback(() => {
    const s = live.current;
    if (!s) return null;
    live.current = null;
    s.abort.abort();
    return fetch(`/api/admin/terminal/${s.id}/close`, { method: "POST", headers: { "X-CSRF-Token": csrfToken }, keepalive: true }).catch(() => null);
  }, [csrfToken]);

  React.useEffect(() => {
    // Shown again from the back/forward cache: the session is gone, so start the page over.
    const back = (e: PageTransitionEvent) => {
      if (e.persisted) window.location.reload();
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", back);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", back);
      leave();
    };
  }, [leave]);

  React.useEffect(() => {
    if (phase === "open") inputRef.current?.focus();
    if (phase === "ended") codeRef.current?.focus();
  }, [phase]);

  function end(sentence: string) {
    setNotice(sentence);
    setReconnecting(false);
    setInputError(null);
    setPhase("ended");
  }

  async function open(e: React.FormEvent) {
    e.preventDefault();
    const before = phase;
    setPhase("opening");
    setNotice(null);
    const address = component ? `/api/admin/app-stacks/${component.stackId}/components/${component.componentKey}/terminal` : `/api/admin/sites/${siteId}/terminal`;
    const res = await fetch(address, { method: "POST", headers, body: JSON.stringify({ code }) }).catch(() => null);
    const body: unknown = await res?.json().catch(() => null);
    setCode("");
    const answer = component ? AppTerminalSessionDtoSchema : TerminalSessionDtoSchema;
    const parsed = res?.status === 201 ? answer.safeParse((body as { data?: unknown } | null)?.data) : null;
    if (!parsed?.success) {
      setNotice(terminalErrorText(m, res?.status ?? 0, body, kind));
      setPhase(before);
      return;
    }
    const abort = new AbortController();
    live.current = { id: parsed.data.sessionId, abort };
    setSession(parsed.data);
    setText(emptyText());
    setLine("");
    setPhase("open");
    const ended = await runReadLoop({
      sessionId: parsed.data.sessionId,
      csrfToken,
      signal: abort.signal,
      onRead: (r) => {
        setReconnecting(false);
        setText((prev) => feed(prev, r.output, r.dropped));
      },
      onRetry: () => setReconnecting(true),
    });
    if (!ended || live.current?.abort !== abort) return;
    // The server may still hold a session the page counts as lost: give it up there too.
    if ("reason" in ended && ended.reason === "lost") void leave();
    live.current = null;
    end("reason" in ended ? endText(m, ended.reason, kind) : terminalErrorText(m, ended.status, ended.body, kind));
  }

  // Writes go one after another so Ctrl-C never overtakes the line before it.
  function send(input: string, sentLine?: string) {
    if (!inputFits(input)) return setInputError(t.tooLong);
    if (sentLine !== undefined) setLine("");
    writes.current = writes.current.then(async () => {
      const s = live.current;
      if (!s) return;
      const res = await fetch(`/api/admin/terminal/${s.id}/write`, { method: "POST", headers, body: JSON.stringify({ input }) }).catch(() => null);
      if (res?.status === 204) return setInputError(null);
      const body: unknown = await res?.json().catch(() => null);
      if (sentLine !== undefined) setLine((cur) => (cur === "" ? sentLine : cur));
      setInputError(!res || res.status >= 500 ? t.writeFailed : res.status === 400 ? t.tooLong : terminalErrorText(m, res.status, body, kind));
    });
  }

  function onKey(e: React.KeyboardEvent) {
    const el = e.currentTarget as HTMLInputElement;
    const selected = el.selectionStart !== el.selectionEnd || (window.getSelection()?.toString() ?? "") !== "";
    const input = keyToInput({ key: e.key, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, isComposing: e.nativeEvent.isComposing }, line, selected);
    if (input === null) return;
    e.preventDefault();
    send(input, input.endsWith("\n") ? line : undefined);
  }

  async function close() {
    await leave();
    end(endText(m, "closed", kind));
  }

  const showOutput = text.lines.length > 0 || text.current !== "" || phase === "open";
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{about.intro}</p>
      <p className="text-sm text-muted-foreground">{about.limits}</p>
      {notice && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {phase !== "open" && (
        <form onSubmit={open} className="max-w-sm space-y-2">
          <Label htmlFor="terminal-code">{m.login.totp}</Label>
          <Input
            id="terminal-code"
            ref={codeRef}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            pattern="[0-9]{6}"
            required
            aria-describedby="terminal-code-hint"
          />
          <p id="terminal-code-hint" className="text-sm text-muted-foreground">
            {m.login.totpHint} {t.codeOnce}
          </p>
          <Button type="submit" disabled={phase === "opening"}>
            {phase === "opening" ? t.opening : t.open}
          </Button>
        </form>
      )}
      {showOutput && <TerminalOutput text={text} label={t.outputLabel} />}
      {text.dropped && <p className="text-sm text-muted-foreground">{t.dropped}</p>}
      {phase === "open" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(`${line}\n`, line);
          }}
          className="space-y-2"
        >
          {session && <p className="text-sm text-muted-foreground">{format(t.ends, { time: new Date(session.expiresAt).toLocaleTimeString(m.common.dateLocale, { hour: "2-digit", minute: "2-digit" }) })}</p>}
          {reconnecting && <p role="status" className="text-sm">{t.reconnecting}</p>}
          <Label htmlFor="terminal-input">{t.inputLabel}</Label>
          <Input
            id="terminal-input"
            ref={inputRef}
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={onKey}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-describedby="terminal-input-hint"
            className="font-mono"
          />
          <p id="terminal-input-hint" className="text-sm text-muted-foreground">{t.inputHint}</p>
          {inputError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{inputError}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit">{t.send}</Button>
            <Button type="button" variant="outline" aria-label={t.ctrlCLabel} onClick={() => send("\x03")}>
              {t.ctrlC}
            </Button>
            <Button type="button" variant="outline" aria-label={t.ctrlDLabel} onClick={() => send("\x04")}>
              {t.ctrlD}
            </Button>
            <Button type="button" variant="destructive" onClick={() => void close()}>
              {t.close}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
