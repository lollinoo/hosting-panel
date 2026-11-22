import { SITE_TYPE_KEYS, type AdminSiteTemplateSummaryDto } from "@hosting-panel/contracts";

export type TemplateStatusKey = "builtIn" | "enabled" | "disabled" | "archived";

export const STATUS_BADGE_VARIANT = { enabled: "success", disabled: "secondary", archived: "outline", builtIn: "outline" } as const;

/** An archived template is only "archived" (a built-in one cannot be archived); otherwise built-in, then offered or not. */
export function templateStatusKeys(t: AdminSiteTemplateSummaryDto): TemplateStatusKey[] {
  if (t.archivedAt !== null) return ["archived"];
  return [...(t.builtIn ? (["builtIn"] as const) : []), t.enabled ? "enabled" : "disabled"];
}

const rank = (t: AdminSiteTemplateSummaryDto) => (t.archivedAt !== null ? 2 : t.builtIn ? 0 : 1);

/** Known modules in catalog order, unknown ones after (alphabetical); inside a group: built-in, live by name, archived. */
export function groupByModule(templates: readonly AdminSiteTemplateSummaryDto[]): { module: string; templates: AdminSiteTemplateSummaryDto[] }[] {
  const known = SITE_TYPE_KEYS as readonly string[];
  const order = (module: string) => known.indexOf(module);
  const modules = [...new Set(templates.map((t) => t.module as string))].sort((a, b) => {
    const [ia, ib] = [order(a), order(b)];
    if (ia >= 0 && ib >= 0) return ia - ib;
    return ia >= 0 ? -1 : ib >= 0 ? 1 : a.localeCompare(b);
  });
  return modules.map((module) => ({
    module,
    templates: templates.filter((t) => t.module === module).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)),
  }));
}
