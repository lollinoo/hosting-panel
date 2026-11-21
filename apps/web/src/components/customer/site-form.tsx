"use client";

import { useState } from "react";
import {
  DEFAULT_PHP_VERSION,
  PHP_VERSION_PARAMETER_KEY,
  SITE_TEMPLATE_STRING_PARAMETER_MAX,
  SUPPORTED_PHP_VERSIONS,
  suggestWwwPair,
  type CreateManagedSiteInput,
  type CustomerSiteTypeDto,
} from "@hosting-panel/contracts";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/provider";

/** phpVersion is absent when the site type offers no PHP choice: the API then uses the type's own. */
export type SiteFormBody = Omit<CreateManagedSiteInput, "phpVersion" | "includeWww"> & { phpVersion?: string; includeWww: boolean };

type SiteTypeParameter = CustomerSiteTypeDto["parameters"][number];
type ParameterInputs = Readonly<Record<string, string | boolean>>;

/** The field errors this form can show; an option's is `param:<key>`. A refusal naming any other field needs a sentence of its own. */
export const SITE_FORM_FIELDS: readonly string[] = ["name", "domain", "title", "adminUser", "adminEmail", "adminPassword", "phpVersion"];

/**
 * What a control shows for an option: what the customer typed, else the default, else an empty control. Own keys only: an option may be
 * named `constructor` or `__proto__`. What was typed for another site type's option of the same key counts only if this option can take it.
 */
const shownValue = (p: SiteTypeParameter, inputs: ParameterInputs): string | number | boolean => {
  const typed = Object.hasOwn(inputs, p.key) ? inputs[p.key] : undefined;
  const fits = p.type === "boolean" ? typeof typed === "boolean" : typeof typed === "string" && (p.type !== "enum" || (p.options?.includes(typed) ?? false));
  return (fits ? typed : undefined) ?? p.default ?? (p.type === "boolean" ? false : p.type === "enum" ? (p.options?.[0] ?? "") : "");
};

/** The values to send: what the controls show, converted to the option's type; a blank one falls back to the default, or is omitted without one. */
export function buildParameterValues(defs: readonly SiteTypeParameter[], inputs: ParameterInputs): { key: string; value: string | number | boolean }[] {
  const entries: { key: string; value: string | number | boolean }[] = [];
  for (const p of defs) {
    // The PHP version travels as phpVersion, never as an option.
    if (p.key === PHP_VERSION_PARAMETER_KEY) continue;
    const shown = shownValue(p, inputs);
    if (p.type === "boolean") {
      entries.push({ key: p.key, value: shown === true });
      continue;
    }
    const text = String(shown).trim() || (p.default === undefined ? "" : String(p.default));
    if (text !== "") entries.push({ key: p.key, value: p.type === "integer" ? Number(text) : text });
  }
  return entries;
}

const selectClass = "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm";

/** Shared by the customer page and the administrator dialog; the caller owns submission and errors. */
export function SiteForm({
  onSubmit,
  submitting,
  fieldErrors = {},
  extraFields,
  initialDomain = "",
  siteType = null,
}: {
  onSubmit: (body: SiteFormBody) => void;
  submitting: boolean;
  fieldErrors?: Partial<Record<string, string>>;
  extraFields?: React.ReactNode;
  initialDomain?: string;
  /** The customer's pick; without one the form is the legacy one (every supported PHP version, no options). */
  siteType?: CustomerSiteTypeDto | null;
}) {
  const t = useMessages().site.create;
  const [v, setV] = useState({ name: "", domain: initialDomain, title: "", adminUser: "", adminEmail: "", adminPassword: "" });
  const [php, setPhp] = useState<string | null>(null); // null = the default of the site type
  const [show, setShow] = useState(false);
  const [wwwChoice, setWwwChoice] = useState<boolean | null>(null); // null = follow the suggestion
  const [inputs, setInputs] = useState<ParameterInputs>({});
  const domainName = v.domain.trim().toLowerCase();
  const includeWww = wwwChoice ?? suggestWwwPair(domainName);
  const phpVersions: readonly string[] = siteType ? siteType.phpVersions : SUPPORTED_PHP_VERSIONS;
  const phpDefault = siteType ? (siteType.defaultPhpVersion ?? phpVersions[0]) : DEFAULT_PHP_VERSION;
  const phpChoice = phpVersions.length > 1;
  // A pick that the newly chosen site type does not offer falls back to its default.
  const effectivePhp = php !== null && phpVersions.includes(php) ? php : phpDefault;
  const options = (siteType?.parameters ?? []).filter((p) => p.key !== PHP_VERSION_PARAMETER_KEY);
  const setInput = (key: string, value: string | boolean) => setInputs({ ...inputs, [key]: value });

  const field = (key: keyof typeof v, label: string, extra: { type?: string; hint?: string; autoComplete?: string } = {}) => (
    <div className="space-y-2">
      <Label htmlFor={`site-${key}`}>{label}</Label>
      <Input
        id={`site-${key}`}
        type={extra.type ?? "text"}
        autoComplete={extra.autoComplete ?? "off"}
        value={v[key]}
        onChange={(e) => setV({ ...v, [key]: e.target.value })}
        required
        aria-invalid={fieldErrors[key] ? true : undefined}
        aria-describedby={`site-${key}-note`}
      />
      <p id={`site-${key}-note`} className={fieldErrors[key] ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
        {fieldErrors[key] ?? extra.hint ?? ""}
      </p>
    </div>
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          ...v,
          ...(phpChoice ? { phpVersion: effectivePhp } : {}),
          includeWww,
          ...(options.length > 0 ? { parameters: buildParameterValues(options, inputs) } : {}),
        });
      }}
      className="space-y-4"
    >
      {field("name", t.name)}
      {field("domain", t.domain, { hint: t.domainHint })}
      <label className="flex items-center gap-2 text-sm">
        <input id="site-includeWww" type="checkbox" checked={includeWww} onChange={(e) => setWwwChoice(e.target.checked)} />
        {t.alsoWww.replace("{domain}", domainName.replace(/^www\./, "") || "…")}
      </label>
      {field("title", t.siteTitle)}
      {field("adminUser", t.adminUser, { autoComplete: "off" })}
      {field("adminEmail", t.adminEmail, { type: "email" })}
      <div className="space-y-2">
        <Label htmlFor="site-adminPassword">{t.adminPassword}</Label>
        <div className="flex gap-2">
          <Input
            id="site-adminPassword"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            value={v.adminPassword}
            onChange={(e) => setV({ ...v, adminPassword: e.target.value })}
            required
            aria-invalid={fieldErrors.adminPassword ? true : undefined}
            aria-describedby="site-adminPassword-note"
          />
          <Button type="button" variant="outline" size="icon" onClick={() => setShow(!show)} aria-label={show ? t.hidePassword : t.showPassword}>
            {show ? <EyeOff aria-hidden className="h-4 w-4" /> : <Eye aria-hidden className="h-4 w-4" />}
          </Button>
        </div>
        <p id="site-adminPassword-note" className={fieldErrors.adminPassword ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {fieldErrors.adminPassword ?? t.passwordHint}
        </p>
      </div>
      {options.length > 0 && (
        <div className="space-y-4">
          <h2 className="text-sm font-medium">{t.options}</h2>
          {options.map((p) => {
            const id = `site-param-${p.key}`;
            const shown = shownValue(p, inputs);
            const error = fieldErrors[`param:${p.key}`];
            const control =
              p.type === "boolean" ? (
                <label className="flex items-center gap-2 text-sm">
                  <input id={id} type="checkbox" checked={shown === true} onChange={(e) => setInput(p.key, e.target.checked)} aria-describedby={`${id}-note`} />
                  {p.label}
                </label>
              ) : (
                <>
                  <Label htmlFor={id}>{p.label}</Label>
                  {p.type === "enum" ? (
                    <select id={id} value={String(shown)} onChange={(e) => setInput(p.key, e.target.value)} aria-describedby={`${id}-note`} className={selectClass}>
                      {(p.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={id}
                      type={p.type === "integer" ? "number" : "text"}
                      {...(p.type === "integer" ? { min: p.min, max: p.max, step: 1 } : { maxLength: SITE_TEMPLATE_STRING_PARAMETER_MAX })}
                      autoComplete="off"
                      value={String(shown)}
                      onChange={(e) => setInput(p.key, e.target.value)}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={`${id}-note`}
                    />
                  )}
                </>
              );
            return (
              <div key={p.key} className="space-y-2">
                {control}
                <p id={`${id}-note`} className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                  {error ?? ""}
                </p>
              </div>
            );
          })}
        </div>
      )}
      {phpChoice && (
        <details className="rounded-md border px-3 py-2" open={fieldErrors.phpVersion ? true : undefined}>
          <summary className="cursor-pointer text-sm font-medium">{t.advanced}</summary>
          <div className="mt-3 space-y-2">
            <Label htmlFor="site-php">{t.phpVersion}</Label>
            <select
              id="site-php"
              value={effectivePhp}
              onChange={(e) => setPhp(e.target.value)}
              aria-invalid={fieldErrors.phpVersion ? true : undefined}
              aria-describedby="site-php-note"
              className={selectClass}
            >
              {phpVersions.map((p) => (
                <option key={p} value={p}>
                  {p === phpDefault ? `${p} (${t.recommended})` : p}
                </option>
              ))}
            </select>
            <p id="site-php-note" className={fieldErrors.phpVersion ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {fieldErrors.phpVersion ?? ""}
            </p>
          </div>
        </details>
      )}
      {extraFields}
      <Button type="submit" disabled={submitting}>
        {submitting ? t.submitting : t.submit}
      </Button>
    </form>
  );
}
