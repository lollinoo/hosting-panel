"use client";

import type { CustomerSiteTypeDto } from "@hosting-panel/contracts";
import { useMessages } from "@/i18n/provider";

/** One choice per site type; the name and description are the administrator's own words, shown as given. */
export function SiteTypeChooser({
  siteTypes,
  value,
  onChange,
}: {
  siteTypes: readonly CustomerSiteTypeDto[];
  value: string | null;
  onChange: (id: string) => void;
}) {
  const t = useMessages().site.create;
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t.siteTypeLabel}</legend>
      <p className="text-xs text-muted-foreground">{t.siteTypeHint}</p>
      {siteTypes.map((type) => (
        <label key={type.id} className="flex gap-3 rounded-md border p-3 has-[:checked]:border-primary">
          <input type="radio" name="site-type" value={type.id} checked={type.id === value} onChange={() => onChange(type.id)} />
          <span className="space-y-1">
            <span className="block text-sm font-medium">{type.name}</span>
            {type.description && <span className="block text-xs text-muted-foreground">{type.description}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
