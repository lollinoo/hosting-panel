"use client";

import { useState } from "react";
import {
  APP_TEMPLATE_LIMITS,
  type ComposeImportDto,
  type ComposeImportLevel,
  type ComposeImportNoteDto,
} from "@hosting-panel/contracts";
import { AppTemplateEditor } from "@/components/admin/app-template-editor";
import { appTemplateRefusalText } from "@/components/admin/app-template-text";
import { CodeEditor } from "@/components/admin/code-editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format, type Messages } from "@/i18n";
import { useMessages } from "@/i18n/provider";

const SELECT_CLASS = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm";
const IMPORT_URL = "/api/admin/app-templates/import-compose";

/** Most serious first: what stops the import, what the draft lost, what it changed, what is only a remark. */
const LEVEL_ORDER: readonly ComposeImportLevel[] = ["refused", "dropped", "changed", "info"];

/** "services.db.image · IMAGE_PINNED · <message>"; a note about the whole file has no path. */
export function composeNoteText(note: ComposeImportNoteDto): string {
  return [note.path, note.code, note.message].filter(Boolean).join(" · ");
}

/** The notes of a report by level, most serious first, each level in the importer's order; an empty level is left out. */
export function composeReportGroups(report: readonly ComposeImportNoteDto[]): { level: ComposeImportLevel; notes: ComposeImportNoteDto[] }[] {
  return LEVEL_ORDER.map((level) => ({ level, notes: report.filter((note) => note.level === level) })).filter((group) => group.notes.length > 0);
}

/** The API's bound on the file, counted the way the API counts it. */
export function composeTooLarge(compose: string): boolean {
  return new TextEncoder().encode(compose).length > APP_TEMPLATE_LIMITS.sourceBytes;
}

export function canImportCompose(s: { compose: string; busy: boolean }): boolean {
  return !s.busy && s.compose.trim() !== "" && !composeTooLarge(s.compose);
}

/** The request for the pasted file: a blank name and the «from the file» category are not sent, so the file's own apply. */
export function composeImportBody(s: { compose: string; name: string; category: string }): { compose: string; name?: string; category?: string } {
  const name = s.name.replace(/\p{Cc}+/gu, " ").trim();
  return { compose: s.compose, ...(name === "" ? {} : { name }), ...(s.category === "" ? {} : { category: s.category }) };
}

/** Why an import gave no report. The import stores nothing, so an answer that never arrived lost nothing. */
export function composeImportRefusalText(m: Messages, status: number, code: string, reason?: string): string {
  const i = m.admin.appTemplates.importer;
  if (code === "DOCKER_ENGINE_UNAVAILABLE") return i.lookupFailed;
  if (status === 502 || status === 504) return i.noAnswer;
  return appTemplateRefusalText(m, code, reason);
}

/** What the importer did with the file, grouped by how much it matters. */
export function ComposeReport({ report }: { report: readonly ComposeImportNoteDto[] }) {
  const i = useMessages().admin.appTemplates.importer;
  return (
    <div className="space-y-3">
      {composeReportGroups(report).map(({ level, notes }) => (
        <div key={level} className="space-y-1">
          <p className="text-sm font-medium">{format(i.level[level], { n: notes.length })}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {notes.map((note, index) => (
              <li key={index}>{composeNoteText(note)}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * «Importa da Compose»: the administrator pastes a Compose file, the API answers with a draft template and the report of
 * what it changed, and the draft continues in the template editor, which is where it is saved. Nothing is stored before
 * that, here or on the server.
 */
export function AppTemplateComposeImport({ csrfToken }: { csrfToken: string }) {
  const m = useMessages();
  const t = m.admin.appTemplates;
  const i = t.importer;
  const [compose, setCompose] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<ComposeImportDto | null>(null);

  // A report describes the file it was made for: an edit drops it.
  function edit(next: string) {
    setCompose(next);
    setAnswer(null);
    setError(null);
  }

  async function run() {
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const res = await fetch(IMPORT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: JSON.stringify(composeImportBody({ compose, name, category })),
      });
      const body = (await res.json().catch(() => null)) as {
        data?: ComposeImportDto;
        error?: { code?: string; details?: { reason?: string }[] };
      } | null;
      if (res.ok && body?.data) setAnswer(body.data);
      else setError(composeImportRefusalText(m, res.status, body?.error?.code ?? "", body?.error?.details?.[0]?.reason));
    } catch {
      setError(m.errors.generic);
    }
    setBusy(false);
  }

  if (answer !== null && answer.source !== null) {
    const invalid = answer.validation !== null && !answer.validation.valid;
    return (
      <div className="space-y-6">
        <Alert variant={invalid ? "warning" : "default"} role="status">
          <AlertDescription>{invalid ? i.draftInvalid : i.draftReady}</AlertDescription>
        </Alert>
        {answer.report.length > 0 && (
          <section className="space-y-2" aria-labelledby="compose-import-report">
            <h2 id="compose-import-report" className="text-lg font-semibold">
              {i.report}
            </h2>
            <ComposeReport report={answer.report} />
          </section>
        )}
        <div>
          <Button type="button" variant="outline" onClick={() => setAnswer(null)}>
            {i.again}
          </Button>
        </div>
        <section className="space-y-3" aria-labelledby="compose-import-draft">
          <h2 id="compose-import-draft" className="text-lg font-semibold">
            {i.draft}
          </h2>
          <AppTemplateEditor csrfToken={csrfToken} target={{ kind: "create" }} initialSource={answer.source} initialResult={answer.validation} />
        </section>
      </div>
    );
  }

  const tooLarge = composeTooLarge(compose);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="compose-import-file">{i.compose}</Label>
        <p id="compose-import-file-hint" className="text-sm text-muted-foreground">
          {i.composeHint}
        </p>
        <CodeEditor
          id="compose-import-file"
          value={compose}
          onChange={edit}
          label={i.compose}
          describedBy={tooLarge ? "compose-import-file-hint compose-import-file-error" : "compose-import-file-hint"}
          rows={18}
          // Read-only while the request is out, so the report never describes text that has changed since.
          readOnly={busy}
        />
        {tooLarge && (
          <p id="compose-import-file-error" role="alert" className="text-sm text-destructive">
            {i.tooLarge}
          </p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="compose-import-name">{i.name}</Label>
          <Input
            id="compose-import-name"
            value={name}
            maxLength={APP_TEMPLATE_LIMITS.stackName}
            disabled={busy}
            aria-describedby="compose-import-name-hint"
            onChange={(ev) => setName(ev.target.value)}
          />
          <p id="compose-import-name-hint" className="text-sm text-muted-foreground">
            {i.nameHint}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="compose-import-category">{i.category}</Label>
          <select
            id="compose-import-category"
            value={category}
            disabled={busy}
            className={SELECT_CLASS}
            onChange={(ev) => setCategory(ev.target.value)}
          >
            <option value="">{i.categoryFromFile}</option>
            {Object.entries(t.category).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={!canImportCompose({ compose, busy })} onClick={run}>
          {busy ? i.running : i.run}
        </Button>
        <p role="status" className="text-sm text-muted-foreground">
          {busy ? i.runningHint : null}
        </p>
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {answer !== null && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            <p>{i.refused}</p>
            <div className="mt-2">
              <ComposeReport report={answer.report} />
            </div>
            <p className="mt-2">{i.refusedHint}</p>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
