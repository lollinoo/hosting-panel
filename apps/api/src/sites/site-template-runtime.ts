import {
  PHP_VERSION_PARAMETER_KEY,
  SiteTemplateParameterValueSchema,
  restoreSiteTemplateParameterMap,
  renderSiteTemplate,
  resolveSiteTemplateParameters,
  type PhpVersion,
  type SiteTemplateAudience,
  type SiteTemplateParameter,
  type SiteTemplateParameterEntry,
  type SiteTemplateParameterMap,
  type SiteTemplateSpec,
  type SiteTypeKey,
} from "@hosting-panel/contracts";
import {
  getSiteTemplate,
  getSiteTemplateForCreate,
  getSiteTemplateVersion,
  readSiteTemplateSpec,
  type DatabaseExecutor,
  type SiteTemplateRow,
  type SiteTemplateVersionRow,
} from "@hosting-panel/database";
import { validateSiteTemplateSource } from "@hosting-panel/policy-engine";
import { ControlPlaneError } from "../common/control-plane.error.js";

/**
 * The only API file that calls the template functions of the contracts, the database and the policy engine
 * for a site (creation, PHP change, upgrade, Updates drift). Every other site file imports these helpers.
 */
export type TemplateAudience = SiteTemplateAudience;

export interface LoadedTemplate {
  readonly template: SiteTemplateRow;
  readonly version: SiteTemplateVersionRow;
  readonly spec: SiteTemplateSpec;
  readonly module: SiteTypeKey;
}

/** The same answer for an unknown, a disabled (customer) and an archived template: nothing tells them apart. */
export const templateUnavailable = (): ControlPlaneError =>
  new ControlPlaneError("NOT_FOUND", "Requested organization or resource was not found.", {
    details: [{ field: "templateId", message: "This site type is not available.", reason: "template_unavailable" }],
  });

function loaded(template: SiteTemplateRow, version: SiteTemplateVersionRow): LoadedTemplate {
  return { template, version, spec: readSiteTemplateSpec(version), module: template.module };
}

/**
 * Customer: enabled, not archived, default version (an absent id means the built-in of the legacy module).
 * Admin with an id: any template that is not archived, disabled ones included, so a new template can be tried
 * before it is offered. Without an id both audiences take the built-in, whose disabling is never bypassed.
 */
export async function loadTemplateForCreate(
  db: DatabaseExecutor,
  templateId: string | undefined,
  audience: TemplateAudience,
): Promise<LoadedTemplate> {
  if (audience === "customer" || templateId === undefined) {
    const found = await getSiteTemplateForCreate(db, { templateId: templateId ?? null });
    if (!found) throw templateUnavailable();
    return loaded(found.template, found.version);
  }
  const found = await getSiteTemplate(db, templateId);
  if (!found || found.template.archivedAt !== null || found.template.defaultVersionId === null) throw templateUnavailable();
  const version = await getSiteTemplateVersion(db, templateId, found.template.defaultVersionId);
  if (!version) throw templateUnavailable();
  return loaded(found.template, version);
}

/** Runs today's validator on the stored source: a stricter policy of a newer release stops old versions. */
export function assertTemplateUsable(target: { readonly version: Pick<SiteTemplateVersionRow, "source">; readonly module: SiteTypeKey }): void {
  const checked = validateSiteTemplateSource(target.version.source, target.module);
  if (!checked.ok) {
    throw new ControlPlaneError("RESOURCE_LOCKED", "This site type cannot be used right now.", {
      details: [{ message: "This site type cannot be used right now.", reason: "template_invalid" }],
    });
  }
}

/** Strict: a 400 naming `parameters.<key>` (or `phpVersion`) for every problem. */
export function resolveCreateParameters(
  spec: SiteTemplateSpec,
  entries: readonly SiteTemplateParameterEntry[],
  audience: TemplateAudience,
  phpVersion: PhpVersion | undefined,
): SiteTemplateParameterMap {
  const resolved = resolveSiteTemplateParameters(spec, entries, { audience, phpVersion });
  if (resolved.ok) return resolved.values;
  throw new ControlPlaneError("VALIDATION_ERROR", "These settings cannot be used.", {
    details: resolved.issues.map(({ field, message, reason }) => ({ field, message, reason })),
  });
}

/** The stored parameters of a site as wire entries (php_version is never stored); with a spec, only the keys it declares. */
export function storedEntries(site: { readonly templateParameters: unknown }, spec?: SiteTemplateSpec): SiteTemplateParameterEntry[] {
  if (!Array.isArray(site.templateParameters)) return [];
  const declared = spec ? new Set(spec.parameters.map((parameter) => parameter.key)) : null;
  const entries: SiteTemplateParameterEntry[] = [];
  for (const item of site.templateParameters as unknown[]) {
    if (typeof item !== "object" || item === null || !("key" in item) || !("value" in item) || typeof item.key !== "string") continue;
    const value = SiteTemplateParameterValueSchema.safeParse(item.value);
    if (!value.success || item.key === PHP_VERSION_PARAMETER_KEY || (declared && !declared.has(item.key))) continue;
    entries.push({ key: item.key, value: value.data });
  }
  return entries;
}

/** The image a site's template renders today for its PHP version; null when it cannot be rendered (lenient, for Updates). */
export function expectedTemplateImage(
  spec: SiteTemplateSpec,
  site: { readonly id: string; readonly phpVersion: string | null; readonly templateParameters: unknown },
): string | null {
  try {
    const values = restoreSiteTemplateParameterMap(spec, site.templateParameters, site.phpVersion);
    const image = renderSiteTemplate(spec, values, { siteId: site.id, siteDomain: "", siteUrl: "" }).configuration["image"];
    return typeof image === "string" ? image : null;
  } catch {
    return null;
  }
}

export function phpVersionParameter(spec: SiteTemplateSpec): SiteTemplateParameter | undefined {
  return spec.parameters.find((parameter) => parameter.key === PHP_VERSION_PARAMETER_KEY);
}
