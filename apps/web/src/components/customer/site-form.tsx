"use client";

import { useState } from "react";
import { DEFAULT_PHP_VERSION, SUPPORTED_PHP_VERSIONS, suggestWwwPair, type CreateManagedSiteInput } from "@hosting-panel/contracts";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/provider";

export type SiteFormBody = Omit<CreateManagedSiteInput, "phpVersion" | "includeWww"> & { phpVersion: string; includeWww: boolean };

/** Shared by the customer page and the administrator dialog; the caller owns submission and errors. */
export function SiteForm({
  onSubmit,
  submitting,
  fieldErrors = {},
  extraFields,
  initialDomain = "",
}: {
  onSubmit: (body: SiteFormBody) => void;
  submitting: boolean;
  fieldErrors?: Partial<Record<string, string>>;
  extraFields?: React.ReactNode;
  initialDomain?: string;
}) {
  const t = useMessages().site.create;
  const [v, setV] = useState({ name: "", domain: initialDomain, title: "", adminUser: "", adminEmail: "", adminPassword: "" });
  const [php, setPhp] = useState<string>(DEFAULT_PHP_VERSION);
  const [show, setShow] = useState(false);
  const [wwwChoice, setWwwChoice] = useState<boolean | null>(null); // null = follow the suggestion
  const domainName = v.domain.trim().toLowerCase();
  const includeWww = wwwChoice ?? suggestWwwPair(domainName);

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
        onSubmit({ ...v, phpVersion: php, includeWww });
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
      <details className="rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium">{t.advanced}</summary>
        <div className="mt-3 space-y-2">
          <Label htmlFor="site-php">{t.phpVersion}</Label>
          <select
            id="site-php"
            value={php}
            onChange={(e) => setPhp(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {SUPPORTED_PHP_VERSIONS.map((p) => (
              <option key={p} value={p}>
                {p === DEFAULT_PHP_VERSION ? `${p} (${t.recommended})` : p}
              </option>
            ))}
          </select>
        </div>
      </details>
      {extraFields}
      <Button type="submit" disabled={submitting}>
        {submitting ? t.submitting : t.submit}
      </Button>
    </form>
  );
}
