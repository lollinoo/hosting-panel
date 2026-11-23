"use client";

import { useState } from "react";
import {
  APP_SINGLE_IMAGE_DEFAULT_COMPONENT_KEY,
  APP_SINGLE_IMAGE_SETTINGS_MAX,
  buildAppSingleImageTemplate,
  type AppSingleImageHealth,
  type AppSingleImageProblem,
  type AppSingleImageSetting,
  type AppSingleImageTemplateInput,
} from "@hosting-panel/contracts";
import { AppTemplateEditor } from "@/components/admin/app-template-editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format } from "@/i18n";
import { useMessages } from "@/i18n/provider";

const SELECT = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm";

export interface AppImageFormSetting {
  kind: AppSingleImageSetting["kind"];
  name: string;
  /** The fixed value, or the default of a value the customer chooses. */
  value: string;
  label: string;
  required: boolean;
}

/** What the administrator typed, as typed. */
export interface AppImageFormFields {
  name: string;
  category: string;
  description: string;
  repository: string;
  tag: string;
  digest: string;
  port: string;
  webAddress: boolean;
  health: AppSingleImageHealth["kind"];
  healthPath: string;
  settings: AppImageFormSetting[];
  dataPath: string;
  cpus: string;
  memoryMb: string;
}

export function emptyAppImageForm(repository: string, category: string): AppImageFormFields {
  return {
    name: "",
    category,
    description: "",
    repository,
    tag: "",
    digest: "",
    port: "",
    webAddress: false,
    health: "none",
    healthPath: "/",
    settings: [],
    dataPath: "",
    cpus: "0.5",
    memoryMb: "256",
  };
}

const whole = (text: string): number => (/^[0-9]{1,9}$/.test(text.trim()) ? Number(text.trim()) : Number.NaN);

/** The typed fields as the input of the template writer: an empty box is "none", a number that cannot be read is NaN. */
export function appImageFormInput(f: AppImageFormFields): AppSingleImageTemplateInput {
  const cpus = /^[0-9]{1,2}(\.[0-9]{1,3})?$/.test(f.cpus.trim()) ? Math.round(Number(f.cpus.trim()) * 1000) : Number.NaN;
  return {
    name: f.name.trim(),
    category: f.category,
    description: f.description.trim(),
    componentKey: APP_SINGLE_IMAGE_DEFAULT_COMPONENT_KEY,
    repository: f.repository,
    tag: f.tag.trim() === "" ? null : f.tag.trim(),
    digest: f.digest.trim(),
    port: f.port.trim() === "" ? null : whole(f.port),
    webAddress: f.webAddress,
    health: f.health === "http" ? { kind: "http", path: f.healthPath.trim() } : { kind: f.health },
    settings: f.settings.map((s): AppSingleImageSetting => {
      const name = s.name.trim();
      if (s.kind === "fixed") return { kind: "fixed", name, value: s.value };
      if (s.kind === "customer") return { kind: "customer", name, label: s.label.trim(), default: s.value };
      return { kind: "private", name, label: s.label.trim(), required: s.required };
    }),
    dataPath: f.dataPath.trim() === "" ? null : f.dataPath.trim(),
    cpuMilli: cpus,
    memoryMb: whole(f.memoryMb),
  };
}

/**
 * The one-image form of the administrator (ADR-0043): a few fields become the source of a one-component template, which
 * opens in the usual editor. Nothing is saved or sent from here: the editor validates on the server and saves.
 */
export function AppTemplateImageForm({
  csrfToken,
  repositories,
  categories,
}: {
  csrfToken: string;
  /** The repositories of the allowlist, as the server knows them. */
  repositories: readonly string[];
  categories: readonly string[];
}) {
  const m = useMessages();
  const t = m.admin.appTemplates.imageForm;
  const [fields, setFields] = useState<AppImageFormFields>(emptyAppImageForm(repositories[0] ?? "", categories[0] ?? ""));
  const [problems, setProblems] = useState<readonly AppSingleImageProblem[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const set = (change: Partial<AppImageFormFields>) => setFields({ ...fields, ...change });
  const setSetting = (index: number, change: Partial<AppImageFormSetting>) =>
    set({ settings: fields.settings.map((s, i) => (i === index ? { ...s, ...change } : s)) });
  const problemsOf = (field: string) => problems.filter((p) => p.field === field);
  const categoryLabels: Record<string, string> = m.admin.appTemplates.category;
  const problemTexts: Record<string, string> = t.problem;

  function write(e: React.FormEvent) {
    e.preventDefault();
    const built = buildAppSingleImageTemplate(appImageFormInput(fields), repositories.map((repository) => ({ repository, runAsUser: null, note: "" })));
    if (built.ok) {
      setProblems([]);
      setSource(built.source);
    } else setProblems(built.problems);
  }

  const errors = (field: string, id: string) =>
    problemsOf(field).map((p) => (
      <p key={p.code} id={`${id}-error`} role="alert" className="text-sm text-destructive">
        {problemTexts[p.code] ?? t.problem.other}
      </p>
    ));
  const invalid = (field: string) => (problemsOf(field).length > 0 ? true : undefined);

  if (source !== null) {
    return (
      <div className="space-y-4">
        <Alert role="status">
          <AlertDescription>{t.written}</AlertDescription>
        </Alert>
        <Button type="button" variant="outline" onClick={() => setSource(null)}>
          {t.backToForm}
        </Button>
        <AppTemplateEditor csrfToken={csrfToken} target={{ kind: "create" }} initialSource={source} />
      </div>
    );
  }

  if (repositories.length === 0) {
    return (
      <Alert variant="warning" role="status">
        <AlertDescription>{t.noSoftware}</AlertDescription>
      </Alert>
    );
  }

  return (
    <form onSubmit={write} className="space-y-6" noValidate>
      <p className="text-sm text-muted-foreground">{t.intro}</p>

      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">{t.section.about}</legend>
        <div className="space-y-1">
          <Label htmlFor="image-form-name">{t.name}</Label>
          <Input id="image-form-name" value={fields.name} maxLength={80} aria-invalid={invalid("name")} onChange={(e) => set({ name: e.target.value })} />
          {errors("name", "image-form-name")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="image-form-category">{t.category}</Label>
          <select id="image-form-category" value={fields.category} onChange={(e) => set({ category: e.target.value })} className={SELECT}>
            {categories.map((c) => (
              <option key={c} value={c}>
                {categoryLabels[c] ?? c}
              </option>
            ))}
          </select>
          {errors("category", "image-form-category")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="image-form-description">{t.description}</Label>
          <Input
            id="image-form-description"
            value={fields.description}
            maxLength={500}
            aria-invalid={invalid("description")}
            onChange={(e) => set({ description: e.target.value })}
          />
          {errors("description", "image-form-description")}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">{t.section.software}</legend>
        <div className="space-y-1">
          <Label htmlFor="image-form-repository">{t.repository}</Label>
          <select id="image-form-repository" value={fields.repository} onChange={(e) => set({ repository: e.target.value })} className={SELECT}>
            {repositories.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">{t.repositoryHint}</p>
          {errors("repository", "image-form-repository")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="image-form-tag">{t.tag}</Label>
          <Input id="image-form-tag" value={fields.tag} autoComplete="off" aria-invalid={invalid("tag")} onChange={(e) => set({ tag: e.target.value })} />
          <p className="text-xs text-muted-foreground">{t.tagHint}</p>
          {errors("tag", "image-form-tag")}
        </div>
        <div className="space-y-1">
          <Label htmlFor="image-form-digest">{t.digest}</Label>
          <Input
            id="image-form-digest"
            value={fields.digest}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-invalid={invalid("digest")}
            aria-describedby="image-form-digest-hint"
            onChange={(e) => set({ digest: e.target.value })}
          />
          <p id="image-form-digest-hint" className="text-xs text-muted-foreground">
            {t.digestHint}
          </p>
          {errors("digest", "image-form-digest")}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">{t.section.network}</legend>
        <div className="space-y-1">
          <Label htmlFor="image-form-port">{t.port}</Label>
          <Input id="image-form-port" value={fields.port} inputMode="numeric" aria-invalid={invalid("port")} onChange={(e) => set({ port: e.target.value })} />
          <p className="text-xs text-muted-foreground">{t.portHint}</p>
          {errors("port", "image-form-port")}
        </div>
        <div className="flex items-center gap-2">
          <input
            id="image-form-web"
            type="checkbox"
            checked={fields.webAddress}
            onChange={(e) => set({ webAddress: e.target.checked, ...(e.target.checked && fields.health === "none" ? { health: "http" as const } : {}) })}
          />
          <Label htmlFor="image-form-web">{t.webAddress}</Label>
        </div>
        {errors("webAddress", "image-form-web")}
        <div className="space-y-1">
          <Label htmlFor="image-form-health">{t.health}</Label>
          <select
            id="image-form-health"
            value={fields.health}
            onChange={(e) => set({ health: e.target.value as AppImageFormFields["health"] })}
            className={SELECT}
          >
            <option value="none">{t.healthKind.none}</option>
            <option value="tcp">{t.healthKind.tcp}</option>
            <option value="http">{t.healthKind.http}</option>
          </select>
          {errors("health", "image-form-health")}
        </div>
        {fields.health === "http" && (
          <div className="space-y-1">
            <Label htmlFor="image-form-health-path">{t.healthPath}</Label>
            <Input id="image-form-health-path" value={fields.healthPath} onChange={(e) => set({ healthPath: e.target.value })} />
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">{t.section.settings}</legend>
        <p className="text-sm text-muted-foreground">{t.settingsHint}</p>
        {errors("settings", "image-form-settings")}
        {fields.settings.map((s, i) => {
          const id = `image-form-setting-${String(i)}`;
          return (
            <div key={i} className="space-y-2 rounded-md border p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor={`${id}-kind`}>{t.setting.kind}</Label>
                  <select
                    id={`${id}-kind`}
                    value={s.kind}
                    onChange={(e) => setSetting(i, { kind: e.target.value as AppImageFormSetting["kind"] })}
                    className={SELECT}
                  >
                    <option value="fixed">{t.setting.kinds.fixed}</option>
                    <option value="customer">{t.setting.kinds.customer}</option>
                    <option value="private">{t.setting.kinds.private}</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${id}-name`}>{t.setting.name}</Label>
                  <Input
                    id={`${id}-name`}
                    value={s.name}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                    aria-invalid={invalid(`settings.${String(i)}`)}
                    onChange={(e) => setSetting(i, { name: e.target.value })}
                  />
                  {s.kind === "private" && <p className="text-xs text-muted-foreground">{t.setting.privateHint}</p>}
                </div>
                {s.kind !== "fixed" && (
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-label`}>{t.setting.label}</Label>
                    <Input id={`${id}-label`} value={s.label} maxLength={80} onChange={(e) => setSetting(i, { label: e.target.value })} />
                  </div>
                )}
                {s.kind !== "private" && (
                  <div className="space-y-1">
                    <Label htmlFor={`${id}-value`}>{s.kind === "fixed" ? t.setting.value : t.setting.default}</Label>
                    <Input id={`${id}-value`} value={s.value} autoComplete="off" onChange={(e) => setSetting(i, { value: e.target.value })} />
                  </div>
                )}
                {s.kind === "private" && (
                  <div className="flex items-center gap-2">
                    <input id={`${id}-required`} type="checkbox" checked={s.required} onChange={(e) => setSetting(i, { required: e.target.checked })} />
                    <Label htmlFor={`${id}-required`}>{t.setting.required}</Label>
                  </div>
                )}
              </div>
              {errors(`settings.${String(i)}`, id)}
              <Button type="button" variant="outline" size="sm" onClick={() => set({ settings: fields.settings.filter((_, j) => j !== i) })}>
                {format(t.setting.remove, { n: i + 1 })}
              </Button>
            </div>
          );
        })}
        {fields.settings.length < APP_SINGLE_IMAGE_SETTINGS_MAX && (
          <Button
            type="button"
            variant="outline"
            onClick={() => set({ settings: [...fields.settings, { kind: "fixed", name: "", value: "", label: "", required: true }] })}
          >
            {t.setting.add}
          </Button>
        )}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-base font-semibold">{t.section.resources}</legend>
        <div className="space-y-1">
          <Label htmlFor="image-form-data">{t.dataPath}</Label>
          <Input
            id="image-form-data"
            value={fields.dataPath}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            aria-invalid={invalid("dataPath")}
            onChange={(e) => set({ dataPath: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">{t.dataPathHint}</p>
          {errors("dataPath", "image-form-data")}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="image-form-cpus">{t.cpus}</Label>
            <Input id="image-form-cpus" value={fields.cpus} inputMode="decimal" aria-invalid={invalid("cpuMilli")} onChange={(e) => set({ cpus: e.target.value })} />
            {errors("cpuMilli", "image-form-cpus")}
          </div>
          <div className="space-y-1">
            <Label htmlFor="image-form-memory">{t.memory}</Label>
            <Input
              id="image-form-memory"
              value={fields.memoryMb}
              inputMode="numeric"
              aria-invalid={invalid("memoryMb")}
              onChange={(e) => set({ memoryMb: e.target.value })}
            />
            {errors("memoryMb", "image-form-memory")}
          </div>
        </div>
      </fieldset>

      {problems.length > 0 && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{t.fix}</AlertDescription>
        </Alert>
      )}
      <Button type="submit">{t.write}</Button>
    </form>
  );
}
