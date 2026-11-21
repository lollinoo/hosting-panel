"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  SITE_TYPE_KEYS,
  parseTemplateYaml,
  type SiteTemplateValidationDto,
  type SiteTypeKey,
} from "@hosting-panel/contracts";
import { CodeEditor, type CodeEditorMarker } from "@/components/admin/code-editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, format, type Messages } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";

export type EditorTarget =
  | { kind: "create"; name: string; description: string }
  | { kind: "version"; templateId: string; archived: boolean };

type EditorMessages = Messages["admin"]["templates"]["editor"];
type ValidationIssue = SiteTemplateValidationDto["errors"][number];

const markersOf = (parsed: ReturnType<typeof parseTemplateYaml>): CodeEditorMarker[] =>
  parsed.ok ? [] : parsed.errors.map((e) => ({ line: e.line, message: e.message }));

/** The client syntax pass: the parser's error as a marker, nothing when the source parses. */
export function syntaxMarkers(source: string): CodeEditorMarker[] {
  return markersOf(parseTemplateYaml(source));
}

/** The server's errors that have a line become markers; the others only appear in the list. */
export function validationMarkers(errors: readonly ValidationIssue[]): CodeEditorMarker[] {
  return errors.flatMap((e) => (typeof e.line === "number" ? [{ line: e.line, message: e.message }] : []));
}

/** "Riga 3, colonna 5 · services.app.ports: …": the position, the path and the message, whichever exist. */
export function validationErrorText(t: EditorMessages, e: ValidationIssue): string {
  const at = typeof e.line === "number" ? format(t.errorAt, { line: e.line, column: e.column ?? 1 }) : null;
  return [at, e.path, e.message].filter(Boolean).join(" · ");
}

export function canSave(s: {
  source: string;
  initialSource: string;
  syntaxOk: boolean;
  target: EditorTarget;
  name: string;
  busy: boolean;
}): boolean {
  if (s.busy || !s.syntaxOk || s.source.trim() === "") return false;
  return s.target.kind === "create" ? s.name.trim() !== "" : !s.target.archived && s.source !== s.initialSource;
}

const SELECT_CLASS = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm";

/** The YAML editor of a template: instant syntax feedback, the server's validation with a preview, and the save. */
export function SiteTemplateEditor({
  csrfToken,
  module,
  initialSource,
  target,
}: {
  csrfToken: string;
  module: SiteTypeKey;
  initialSource: string;
  target: EditorTarget;
}) {
  const m = useMessages();
  const router = useRouter();
  const t = m.admin.templates;
  const e = t.editor;
  const keys = useRef<Record<string, string>>({});
  const [source, setSource] = useState(initialSource);
  const [name, setName] = useState(target.kind === "create" ? target.name : "");
  const [description, setDescription] = useState(target.kind === "create" ? target.description : "");
  const [chosen, setChosen] = useState<SiteTypeKey>(module);
  const [makeDefault, setMakeDefault] = useState(true);
  const [busy, setBusy] = useState<"validate" | "save" | null>(null);
  const [result, setResult] = useState<SiteTemplateValidationDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parsed = parseTemplateYaml(source);
  const syntax = markersOf(parsed);
  const syntaxOk = parsed.ok;
  const archived = target.kind === "version" && target.archived;

  // A result describes the source it was made for: any edit drops it, so a stale preview is never shown.
  function edit(change: () => void) {
    change();
    setResult(null);
    setError(null);
  }

  /** Asks the server to validate the source; keeps its answer on the page, or the reason it could not. Resolves to the answer, or null. */
  async function check() {
    try {
      const res = await fetch("/api/admin/site-templates/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ module: chosen, source }),
      });
      const body = (await res.json().catch(() => null)) as {
        data?: SiteTemplateValidationDto;
        error?: { code?: string };
      } | null;
      if (res.ok && body?.data) {
        setResult(body.data);
        return body.data;
      }
      setError(errorMessage(m, body?.error?.code ?? ""));
    } catch {
      setError(errorMessage(m, ""));
    }
    return null;
  }

  async function validate() {
    setBusy("validate");
    setError(null);
    await check();
    setBusy(null);
  }

  async function save() {
    setBusy("save");
    setError(null);
    if ((await check())?.valid) {
      // The key is named by the body: a retry sends the same key, an edited body a new one. Only the version route replays it;
      // the create route ignores it, so a create sent again after a lost reply may find the template already there (below).
      const body =
        target.kind === "create"
          ? { module: chosen, name: name.trim(), description: description.trim() || undefined, source }
          : { source, makeDefault };
      const url = target.kind === "create" ? "/api/admin/site-templates" : `/api/admin/site-templates/${target.templateId}/versions`;
      const action = `${url}:${JSON.stringify(body)}`;
      const retried = Object.hasOwn(keys.current, action); // an earlier attempt of this very save got no answer
      const sent = await keyedSend(keys.current, csrfToken, action, "POST", url, body);
      if (sent.ok) {
        // Stay busy while the page changes, so a second click cannot save twice.
        if (target.kind === "create") {
          const id = (sent.data as { data?: { id?: string } } | null)?.data?.id;
          router.push(id ? `/admin/templates/${id}` : "/admin/templates");
        } else {
          router.push(`/admin/templates/${target.templateId}`);
          router.refresh();
        }
        return;
      }
      // A refusal the check did not see: ask again, so the located errors show.
      if (sent.code === "VALIDATION_ERROR") await check();
      // The name is taken by the template the lost attempt created, most likely: not a clash to fix by renaming (that would add a copy).
      else if (target.kind === "create" && retried && sent.code === "ALREADY_EXISTS" && sent.reason === "name_taken") setError(e.createRetried);
      else setError(errorMessage(m, sent.code));
    }
    setBusy(null);
  }

  const markers = [...syntax, ...(result ? validationMarkers(result.errors) : [])];
  const syntaxError = parsed.ok ? null : parsed.errors[0];

  return (
    <div className="space-y-4">
      {target.kind === "create" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="template-name">{e.name}</Label>
            <Input id="template-name" value={name} maxLength={80} onChange={(ev) => setName(ev.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-description">{e.description}</Label>
            <Textarea
              id="template-description"
              rows={2}
              maxLength={500}
              value={description}
              onChange={(ev) => setDescription(ev.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="template-module">{e.module}</Label>
            <select
              id="template-module"
              value={chosen}
              onChange={(ev) => edit(() => setChosen(ev.target.value as SiteTypeKey))}
              className={SELECT_CLASS}
            >
              {SITE_TYPE_KEYS.map((key) => (
                <option key={key} value={key}>
                  {(t.modules as Record<string, string>)[key] ?? key}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      <div className="space-y-2">
        <Label htmlFor="template-source">{e.source}</Label>
        <p id="template-source-hint" className="text-sm text-muted-foreground">
          {e.keyboardHint}
        </p>
        <CodeEditor
          id="template-source"
          value={source}
          onChange={(next) => edit(() => setSource(next))}
          markers={markers}
          label={e.source}
          describedBy="template-source-hint template-source-status"
          // Read-only while a request is out, so an answer never describes text that has changed since.
          readOnly={archived || busy !== null}
        />
        <p id="template-source-status" role="status" className="text-sm text-muted-foreground">
          {syntaxError
            ? format(e.syntaxError, { line: syntaxError.line, column: syntaxError.column, message: syntaxError.message })
            : e.syntaxOk}
        </p>
      </div>
      {target.kind === "version" && (
        <>
          {archived ? (
            <Alert variant="warning" role="status">
              <AlertDescription>{t.detail.archivedNotice}</AlertDescription>
            </Alert>
          ) : (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={makeDefault} onChange={(ev) => setMakeDefault(ev.target.checked)} />
              {e.makeDefault}
            </label>
          )}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy !== null || !syntaxOk} onClick={validate}>
          {busy === "validate" ? e.validating : e.validate}
        </Button>
        <Button
          type="button"
          disabled={!canSave({ source, initialSource, syntaxOk, target, name, busy: busy !== null })}
          onClick={save}
        >
          {busy === "save" ? e.saving : target.kind === "create" ? e.saveCreate : e.save}
        </Button>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {error}
            {error === e.createRetried && (
              <>
                {" "}
                <Link href="/admin/templates" className="underline">
                  {t.back}
                </Link>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}
      {result &&
        (result.valid ? (
          <div className="space-y-2">
            <Alert role="status">
              <AlertDescription>{e.valid}</AlertDescription>
            </Alert>
            <h3 className="text-sm font-medium">{e.preview}</h3>
            <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
              {JSON.stringify(result.preview, null, 2)}
            </pre>
          </div>
        ) : (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              <p>{e.invalid}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {result.errors.map((issue, i) => (
                  <li key={i}>{validationErrorText(e, issue)}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ))}
    </div>
  );
}
