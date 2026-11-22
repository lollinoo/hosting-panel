"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  APP_TEMPLATE_LIMITS,
  MAX_APP_STACK_DOMAINS,
  type AppTemplateParameter,
  type AppTemplateParameterEntry,
  type CustomerAppTemplateDto,
} from "@hosting-panel/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { format, type Messages } from "@/i18n";
import { useMessages } from "@/i18n/provider";
import { renewKeyAfter } from "@/lib/site-setup";
import { appStackRefusalText, formatCpu, formatMemory } from "./app-stack-view";
import { WIZARD_STEPS, WizardSteps, type WizardStep } from "./wizard-steps";

export type ParameterInputs = Record<string, string | boolean>;

/** Non-secret customer parameters only; blank text → omitted (default applies); integer text → Number when /^-?\d{1,10}$/, else the text (the API refuses it with a located error); boolean → boolean; others → string. Source order. */
export function buildAppParameterEntries(parameters: readonly AppTemplateParameter[], inputs: ParameterInputs): AppTemplateParameterEntry[] {
  return parameters.flatMap((p): AppTemplateParameterEntry[] => {
    if (!p.customer || p.type === "secret" || !Object.hasOwn(inputs, p.key)) return [];
    const v = inputs[p.key]!;
    if (typeof v === "boolean") return [{ key: p.key, value: v }];
    if (v.trim() === "") return [];
    return [{ key: p.key, value: p.type === "integer" && /^-?\d{1,10}$/.test(v) ? Number(v) : v }];
  });
}

/** Keys of required secret parameters not typed yet. */
export function missingSecretKeys(parameters: readonly AppTemplateParameter[], typed: ReadonlySet<string>): string[] {
  return parameters.filter((p) => p.type === "secret" && p.required && !typed.has(p.key)).map((p) => p.key);
}

export interface DomainRow {
  hostname: string;
  target: number;
}

export function buildDomainEntries(rows: readonly DomainRow[], ingress: CustomerAppTemplateDto["ingress"]): { hostname: string; componentKey: string; port: number }[] {
  return rows.flatMap((r) => {
    const hostname = r.hostname.trim().toLowerCase();
    const to = ingress[r.target];
    return hostname && to ? [{ hostname, componentKey: to.componentKey, port: to.port }] : [];
  });
}

const fieldOf = (field: string | undefined): [string, WizardStep] | null => {
  if (field === "name") return ["name", "configure"];
  if (field?.startsWith("parameters.")) return [`param:${field.slice("parameters.".length)}`, "configure"];
  const domain = field?.match(/^domains\.(\d+)\.hostname$/);
  return domain ? [`domain:${domain[1]}`, "domains"] : null;
};

/** Error envelope → {error, fieldErrors, step}: the first located field decides the step. */
export function wizardErrorView(
  m: Messages,
  code: string,
  details: readonly { field?: string; reason?: string }[],
): { error: string; fieldErrors: Record<string, string>; step: WizardStep | null } {
  const fieldErrors: Record<string, string> = {};
  let step: WizardStep | null = null;
  for (const d of details) {
    const at = fieldOf(d.field);
    if (!at) continue;
    fieldErrors[at[0]] = appStackRefusalText(m, code, d.reason);
    step ??= at[1];
  }
  return { error: appStackRefusalText(m, code, details[0]?.reason), fieldErrors, step };
}

type Envelope = { data?: { stackId?: unknown }; error?: { code?: string; details?: { field?: string; reason?: string }[] } } | null;

/** keyedSend, but a refusal keeps every detail so the form can point at each field. */
async function post(keys: Record<string, string>, csrfToken: string, name: string, url: string, body: unknown): Promise<{ ok: boolean; data: Envelope }> {
  const key = (keys[name] ??= crypto.randomUUID());
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken, "Idempotency-Key": key },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as Envelope;
    if (res.ok || renewKeyAfter(res.status)) delete keys[name];
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: null };
  }
}

const selectClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm";
const noteClass = (error: string | undefined) => (error ? "text-xs text-destructive" : "text-xs text-muted-foreground");

export function AppWizard({ orgId, csrfToken, entry }: { orgId: string; csrfToken: string; entry: CustomerAppTemplateDto }) {
  const m = useMessages();
  const router = useRouter();
  const [step, setStep] = useState<WizardStep>("configure");
  const [name, setName] = useState("");
  const [inputs, setInputs] = useState<ParameterInputs>({});
  const [typedSecrets, setTypedSecrets] = useState<string[]>([]);
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdStackId, setCreatedStackId] = useState<string | null>(null);
  const secretValues = useRef(new Map<string, string>());
  const keys = useRef<Record<string, string>>({});
  useEffect(() => {
    const values = secretValues.current;
    return () => values.clear();
  }, []);

  const t = m.apps.wizard;
  const params = entry.parameters.filter((p) => p.customer);
  const secretKeys = params.filter((p) => p.type === "secret").map((p) => p.key);
  const entries = buildAppParameterEntries(params, inputs);
  const domainEntries = buildDomainEntries(domains, entry.ingress);
  const detailHref = (id: string) => "/apps/" + encodeURIComponent(id);
  const targetText = (to: { componentKey: string; port: number }) => format(t.target, { component: to.componentKey, port: to.port });

  const setInput = (key: string, v: string | boolean) => setInputs({ ...inputs, [key]: v });
  const typeSecret = (key: string, v: string) => {
    if (v) secretValues.current.set(key, v);
    else secretValues.current.delete(key);
    setTypedSecrets(secretKeys.filter((k) => (k === key ? v !== "" : typedSecrets.includes(k))));
  };
  const setRow = (i: number, row: DomainRow) => setDomains(domains.map((r, j) => (j === i ? row : r)));

  const next = () => {
    const errors: Record<string, string> = {};
    if (step === "configure") {
      if (!name.trim()) errors.name = t.required;
      for (const k of missingSecretKeys(params, new Set(typedSecrets))) errors[`param:${k}`] = t.required;
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    // Rows and the sent list keep the same indexes, so a refusal on domains.<i> points at row i.
    if (step === "domains") setDomains(domains.filter((r) => r.hostname.trim() !== ""));
    setStep(WIZARD_STEPS[WIZARD_STEPS.indexOf(step) + 1]!);
  };

  async function install() {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const base = `/api/bff/orgs/${orgId}/app-stacks`;
    let id = createdStackId;
    if (id === null) {
      const r = await post(keys.current, csrfToken, "create", base, {
        templateVersionId: entry.versionId,
        name: name.trim(),
        parameters: entries,
        domains: domainEntries,
        deploy: typedSecrets.length === 0,
      });
      const created = r.ok ? r.data?.data?.stackId : undefined;
      if (typeof created !== "string") {
        const view = wizardErrorView(m, r.data?.error?.code ?? "", r.data?.error?.details ?? []);
        setError(view.error);
        setFieldErrors(view.fieldErrors);
        if (view.step) setStep(view.step);
        setBusy(false);
        return;
      }
      id = created;
      setCreatedStackId(id);
      if (typedSecrets.length === 0) return router.push(detailHref(id));
    }
    const at = `${base}/${encodeURIComponent(id)}`;
    let remaining = typedSecrets;
    for (const key of typedSecrets) {
      const r = await post(keys.current, csrfToken, `secret:${key}`, `${at}/secrets`, { parameterKey: key, value: secretValues.current.get(key) });
      if (!r.ok) {
        setError(t.secretFailed);
        setBusy(false);
        return;
      }
      secretValues.current.delete(key);
      remaining = remaining.filter((k) => k !== key);
      setTypedSecrets(remaining);
    }
    const r = await post(keys.current, csrfToken, "deploy", `${at}/deploy`, {});
    if (!r.ok) {
      setError(appStackRefusalText(m, r.data?.error?.code ?? "", r.data?.error?.details?.[0]?.reason));
      setBusy(false);
      return;
    }
    secretValues.current.clear();
    router.push(detailHref(id));
  }

  const parameterField = (p: AppTemplateParameter) => {
    const id = `app-param-${p.key}`;
    const fieldError = fieldErrors[`param:${p.key}`];
    const typed = Object.hasOwn(inputs, p.key) ? inputs[p.key] : undefined;
    const text = typeof typed === "string" ? typed : "";
    const common = { id, "aria-invalid": fieldError ? true : undefined, "aria-describedby": `${id}-note` } as const;
    const label = <Label htmlFor={id}>{p.label}</Label>;
    let control: ReactNode;
    let note: string;
    if (p.type === "secret") {
      note = typedSecrets.includes(p.key) ? `${t.secretHint} ${t.secretKept}` : t.secretHint;
      control = <Input {...common} type="password" autoComplete="new-password" spellCheck={false} onChange={(e) => typeSecret(p.key, e.target.value)} />;
    } else {
      note = format(t.defaultValue, { value: String(p.default) });
      control =
        p.type === "enum" ? (
          <select {...common} value={typed === undefined ? p.default : text} onChange={(e) => setInput(p.key, e.target.value)} className={selectClass}>
            {p.options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        ) : p.type === "boolean" ? (
          <input type="checkbox" {...common} checked={typeof typed === "boolean" ? typed : p.default} onChange={(e) => setInput(p.key, e.target.checked)} />
        ) : p.type === "integer" ? (
          <Input {...common} type="number" step={1} min={p.min} max={p.max} autoComplete="off" value={text} onChange={(e) => setInput(p.key, e.target.value)} />
        ) : (
          <Input {...common} type="text" maxLength={APP_TEMPLATE_LIMITS.stringValue} autoComplete="off" value={text} onChange={(e) => setInput(p.key, e.target.value)} />
        );
    }
    return (
      <div key={p.key} className="space-y-2">
        {p.type === "boolean" ? (
          <div className="flex items-center gap-2">
            {control}
            {label}
          </div>
        ) : (
          <>
            {label}
            {control}
          </>
        )}
        <p id={`${id}-note`} className={noteClass(fieldError)}>
          {fieldError ?? note}
        </p>
      </div>
    );
  };

  const shownValue = (p: AppTemplateParameter) => {
    if (p.type === "secret") return typedSecrets.includes(p.key) ? t.secretSet : t.secretUnset;
    const given = entries.find((e) => e.key === p.key);
    return given ? String(given.value) : format(t.defaultValue, { value: String(p.default) });
  };

  return (
    <div className="space-y-6">
      <WizardSteps current={step} />
      <h1 className="text-2xl font-bold tracking-tight">{entry.name}</h1>
      <section aria-labelledby="app-step-title" className="space-y-4">
        <h2 id="app-step-title" className="text-lg font-medium">
          {t.step[step]}
        </h2>
        {step === "configure" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="app-name">{t.name}</Label>
              <Input
                id="app-name"
                maxLength={64}
                autoComplete="off"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={fieldErrors.name ? true : undefined}
                aria-describedby="app-name-note"
              />
              <p id="app-name-note" className={noteClass(fieldErrors.name)}>
                {fieldErrors.name ?? t.nameHint}
              </p>
            </div>
            {params.map(parameterField)}
          </>
        )}
        {step === "domains" &&
          (entry.ingress.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.noDomains}</p>
          ) : (
            <>
              <p id="app-domains-note" className="text-sm text-muted-foreground">
                {t.domainsHint}
              </p>
              {domains.map((row, i) => {
                const id = `app-domain-${i}`;
                const fieldError = fieldErrors[`domain:${i}`];
                return (
                  <div key={i} className="space-y-2 rounded-md border p-3">
                    <Label htmlFor={id}>{format(t.domainLabel, { n: i + 1 })}</Label>
                    <Input
                      id={id}
                      inputMode="url"
                      autoComplete="off"
                      value={row.hostname}
                      onChange={(e) => setRow(i, { ...row, hostname: e.target.value })}
                      aria-invalid={fieldError ? true : undefined}
                      aria-describedby={`app-domains-note ${id}-note`}
                    />
                    <p id={`${id}-note`} className={noteClass(fieldError)}>
                      {fieldError ?? ""}
                    </p>
                    {entry.ingress.length > 1 && (
                      <>
                        <Label htmlFor={`${id}-target`}>{t.targetLabel}</Label>
                        <select id={`${id}-target`} value={row.target} onChange={(e) => setRow(i, { ...row, target: Number(e.target.value) })} className={selectClass}>
                          {entry.ingress.map((to, j) => (
                            <option key={j} value={j}>
                              {targetText(to)}
                            </option>
                          ))}
                        </select>
                      </>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={format(t.removeDomain, { n: i + 1 })}
                      onClick={() => setDomains(domains.filter((_, j) => j !== i))}
                    >
                      {m.apps.domains.remove}
                    </Button>
                  </div>
                );
              })}
              {domains.length < MAX_APP_STACK_DOMAINS && (
                <Button type="button" variant="outline" onClick={() => setDomains([...domains, { hostname: "", target: 0 }])}>
                  {t.addDomain}
                </Button>
              )}
            </>
          ))}
        {step === "review" && (
          <>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
              <dt className="font-medium">{t.name}</dt>
              <dd>{name.trim()}</dd>
              <dt className="font-medium">{m.apps.list.col.version}</dt>
              <dd>{format(t.versionLine, { name: entry.name, n: entry.versionNumber })}</dd>
              {params.map((p) => (
                <Fragment key={p.key}>
                  <dt className="font-medium">{p.label}</dt>
                  <dd>{shownValue(p)}</dd>
                </Fragment>
              ))}
              <dt className="font-medium">{m.apps.detail.section.domains}</dt>
              <dd>
                {domainEntries.length === 0 ? (
                  m.apps.list.noAddress
                ) : (
                  <ul>
                    {domainEntries.map((d) => (
                      <li key={d.hostname}>
                        {d.hostname}
                        {entry.ingress.length > 1 ? ` · ${targetText(d)}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
              <dt className="font-medium">{m.apps.detail.section.resources}</dt>
              <dd>{format(m.apps.resources.total, { cpu: formatCpu(entry.cpuMilli), memory: formatMemory(entry.memoryBytes) })}</dd>
            </dl>
            <p className="text-sm text-muted-foreground">{t.dataNote}</p>
            <p className="text-sm text-muted-foreground">{m.apps.detail.backupUnavailable}</p>
          </>
        )}
      </section>
      <p aria-live="polite" className="text-sm text-muted-foreground">
        {busy ? t.installing : null}
      </p>
      {error && (
        <div role="alert" className="space-y-1 text-sm text-destructive">
          <p>{error}</p>
          {createdStackId && (
            <Link href={detailHref(createdStackId)} className="font-medium underline">
              {t.openApp}
            </Link>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {step === "configure" ? (
          <Button asChild variant="outline">
            <Link href="/apps/new">{t.back}</Link>
          </Button>
        ) : (
          <Button type="button" variant="outline" disabled={busy} onClick={() => setStep(WIZARD_STEPS[WIZARD_STEPS.indexOf(step) - 1]!)}>
            {t.back}
          </Button>
        )}
        {step === "review" ? (
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              setStep("install");
              return install();
            }}
          >
            {t.install}
          </Button>
        ) : step === "install" ? (
          error && (
            <Button type="button" disabled={busy} onClick={install}>
              {t.retry}
            </Button>
          )
        ) : (
          <Button type="button" onClick={next}>
            {t.next}
          </Button>
        )}
      </div>
    </div>
  );
}
