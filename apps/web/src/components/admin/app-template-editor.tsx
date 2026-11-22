"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  APP_TEMPLATE_SLUG_PATTERN,
  parseTemplateYaml,
  type AppTemplateIssue,
  type AppTemplateValidationDto,
} from "@hosting-panel/contracts";
import { CodeEditor, type CodeEditorMarker } from "@/components/admin/code-editor";
import { appTemplateRefusalText } from "@/components/admin/app-template-text";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { format, type Messages } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { keyedSend } from "@/lib/keyed-send";

export type AppEditorTarget = { kind: "create" } | { kind: "version"; templateId: string; archived: boolean };

type EditorMessages = Messages["admin"]["appTemplates"]["editor"];

/** Gutter markers of the server issues that carry a line. */
export function appIssueMarkers(issues: readonly AppTemplateIssue[]): CodeEditorMarker[] {
  return issues.flatMap((i) => (i.line !== undefined ? [{ line: i.line, message: `${i.code}: ${i.message}` }] : []));
}

/** "Riga 3, colonna 5 · services.web.image · IMAGE_NOT_ALLOWLISTED · <message>"; missing parts omitted, column only with a line. */
export function appIssueText(t: EditorMessages, i: AppTemplateIssue): string {
  const at =
    i.line === undefined
      ? null
      : [format(t.line, { line: i.line }), i.column === undefined ? null : format(t.column, { column: i.column })]
          .filter(Boolean)
          .join(", ");
  return [at, i.path, i.code, i.message].filter(Boolean).join(" · ");
}

export function canSaveAppTemplate(s: { source: string; syntaxOk: boolean; busy: boolean; archived: boolean; slug: string | null }): boolean {
  if (s.busy || !s.syntaxOk || s.archived || s.source.trim() === "") return false;
  return s.slug === null || APP_TEMPLATE_SLUG_PATTERN.test(s.slug);
}

/** The issues as a list; also shown by the edit page for a stored version that no longer passes. */
export function AppIssueList({ issues }: { issues: readonly AppTemplateIssue[] }) {
  const t = useMessages().admin.appTemplates.editor;
  return (
    <ul className="mt-2 list-disc space-y-1 pl-5">
      {issues.map((issue, i) => (
        <li key={i}>{appIssueText(t, issue)}</li>
      ))}
    </ul>
  );
}

/** The HCP-STACK/v1 editor: instant syntax feedback, the server's validation with the sanitised plan, and the save. */
export function AppTemplateEditor({
  csrfToken,
  initialSource,
  target,
}: {
  csrfToken: string;
  initialSource: string;
  target: AppEditorTarget;
}) {
  const m = useMessages();
  const router = useRouter();
  const t = m.admin.appTemplates;
  const e = t.editor;
  const [source, setSource] = useState(initialSource);
  const [result, setResult] = useState<AppTemplateValidationDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"validate" | "save" | null>(null);
  const [makeDefault, setMakeDefault] = useState(true);
  const [slug, setSlug] = useState("");
  const [unchanged, setUnchanged] = useState(false);
  const keys = useRef<Record<string, string>>({});

  const parsed = parseTemplateYaml(source);
  const syntaxError = parsed.ok ? null : parsed.errors[0];
  const archived = target.kind === "version" && target.archived;
  const slugTaken = error === t.reasons.slug_taken;
  const slugInvalid = slugTaken || (slug !== "" && !APP_TEMPLATE_SLUG_PATTERN.test(slug));

  // A result describes the source it was made for: any edit drops it, so a stale preview is never shown.
  function edit(next: string) {
    setSource(next);
    setResult(null);
    setError(null);
    setUnchanged(false);
  }

  /** Asks the server to validate the source; keeps its answer on the page, or the reason it could not. Resolves to the answer, or null. */
  async function check() {
    try {
      const res = await fetch("/api/admin/app-templates/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify({ source }),
      });
      const body = (await res.json().catch(() => null)) as {
        data?: AppTemplateValidationDto;
        error?: { code?: string; details?: { reason?: string }[] };
      } | null;
      if (res.ok && body?.data) {
        setResult(body.data);
        return body.data;
      }
      setError(appTemplateRefusalText(m, body?.error?.code ?? "", body?.error?.details?.[0]?.reason));
    } catch {
      setError(m.errors.generic);
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
    setUnchanged(false);
    if ((await check())?.valid) {
      // The key is named by the body: a retry after a lost reply sends the same key, an edited body a new one.
      const body = target.kind === "create" ? { slug, source } : { source, makeDefault };
      const url = target.kind === "create" ? "/api/admin/app-templates" : `/api/admin/app-templates/${target.templateId}/versions`;
      const action = `${url}:${JSON.stringify(body)}`;
      const retried = Object.hasOwn(keys.current, action);
      const sent = await keyedSend(keys.current, csrfToken, action, "POST", url, body);
      if (sent.ok) {
        const data = (sent.data as { data?: { id?: string; created?: boolean } } | null)?.data;
        // Stay busy while the page changes, so a second click cannot save twice.
        if (target.kind === "create") return router.push(`/admin/templates/apps/${encodeURIComponent(data?.id ?? "")}`);
        if (data?.created !== false) {
          router.push(`/admin/templates/apps/${encodeURIComponent(target.templateId)}`);
          return router.refresh();
        }
        setUnchanged(true);
      } else if (sent.code === "VALIDATION_ERROR") await check();
      // After a lost reply the slug is most likely taken by the template that attempt created.
      else if (sent.code === "ALREADY_EXISTS" && sent.reason === "slug_taken") setError(retried ? e.createRetried : t.reasons.slug_taken);
      else setError(appTemplateRefusalText(m, sent.code, sent.reason));
    }
    setBusy(null);
  }

  const markers = [
    ...(syntaxError ? [{ line: syntaxError.line, message: syntaxError.message }] : []),
    ...(result ? appIssueMarkers(result.issues) : []),
  ];

  return (
    <div className="space-y-4">
      {target.kind === "create" && (
        <div className="space-y-2">
          <Label htmlFor="app-template-slug">{e.slug}</Label>
          <Input
            id="app-template-slug"
            value={slug}
            maxLength={48}
            spellCheck={false}
            aria-invalid={slugInvalid}
            aria-describedby={slugTaken ? "app-template-slug-hint app-template-slug-error" : "app-template-slug-hint"}
            onChange={(ev) => {
              setSlug(ev.target.value);
              setError(null);
            }}
          />
          <p id="app-template-slug-hint" className={slugInvalid && !slugTaken ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
            {e.slugHint}
          </p>
          {slugTaken && (
            <p id="app-template-slug-error" role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="app-template-source">{e.source}</Label>
        <p id="app-template-source-hint" className="text-sm text-muted-foreground">
          {e.sourceHint}
        </p>
        <CodeEditor
          id="app-template-source"
          value={source}
          onChange={edit}
          markers={markers}
          label={e.source}
          describedBy="app-template-source-hint app-template-source-status"
          // Read-only while a request is out, so an answer never describes text that has changed since.
          readOnly={archived || busy !== null}
        />
        <p id="app-template-source-status" role="status" className="text-sm text-muted-foreground">
          {syntaxError
            ? format(e.syntaxError, { line: syntaxError.line, column: syntaxError.column, message: syntaxError.message })
            : e.syntaxOk}
        </p>
      </div>
      {target.kind === "version" &&
        (archived ? (
          <Alert variant="warning" role="status">
            <AlertDescription>{e.archived}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="app-template-make-default"
              checked={makeDefault}
              onChange={(ev) => setMakeDefault(ev.target.checked)}
            />
            <Label htmlFor="app-template-make-default">{e.makeDefault}</Label>
          </div>
        ))}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={busy !== null || syntaxError !== null} onClick={validate}>
          {busy === "validate" ? e.validating : e.validate}
        </Button>
        <Button
          type="button"
          disabled={
            !canSaveAppTemplate({
              source,
              syntaxOk: syntaxError === null,
              busy: busy !== null,
              archived,
              slug: target.kind === "create" ? slug : null,
            })
          }
          onClick={save}
        >
          {busy === "save" ? e.saving : target.kind === "create" ? e.saveCreate : e.save}
        </Button>
      </div>
      {unchanged && (
        <Alert role="status">
          <AlertDescription>{e.unchanged}</AlertDescription>
        </Alert>
      )}
      {error && !slugTaken && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {result &&
        (result.valid ? (
          <div className="space-y-4">
            <Alert role="status">
              <AlertDescription>{e.valid}</AlertDescription>
            </Alert>
            {result.parameters.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium">{e.parameters}</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{e.paramKey}</TableHead>
                      <TableHead>{e.paramLabel}</TableHead>
                      <TableHead>{e.paramType}</TableHead>
                      <TableHead>{e.paramCustomer}</TableHead>
                      <TableHead>{e.paramDefault}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.parameters.map((p) => (
                      <TableRow key={p.key}>
                        <TableCell className="font-mono">{p.key}</TableCell>
                        <TableCell>{p.label}</TableCell>
                        <TableCell className="font-mono">{p.type}</TableCell>
                        <TableCell>{p.customer ? e.customerYes : e.customerNo}</TableCell>
                        <TableCell className="font-mono">{p.type === "secret" ? e.secretNoDefault : String(p.default)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{e.preview}</h3>
              <p className="text-sm text-muted-foreground">{e.previewHint}</p>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
                {JSON.stringify(result.preview, null, 2)}
              </pre>
            </div>
          </div>
        ) : (
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              <p>{e.invalid}</p>
              <AppIssueList issues={result.issues} />
            </AlertDescription>
          </Alert>
        ))}
    </div>
  );
}
