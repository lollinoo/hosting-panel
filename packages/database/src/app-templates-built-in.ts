import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST, type AppImageAllowlistEntry } from "@hosting-panel/contracts";
import { computeAppTemplateSpecHash } from "@hosting-panel/hosting-domain";
import { validateAppTemplateSource } from "@hosting-panel/policy-engine";
import type { BuiltInAppTemplateVersionSeed, ensureBuiltInAppTemplates, NewAppTemplateVersion } from "./app-templates-repository.js";

export type BuiltInAppTemplateItem = Parameters<typeof ensureBuiltInAppTemplates>[1][number];

/** Validated, hashed seed rows. Throws Error("built-in app template <slug> is invalid: <CODE,CODE>") when a source does
 *  not validate: only a code change of the same release can cause it, and its unit test fails first. */
export function builtInAppTemplateItems(allowlist: readonly AppImageAllowlistEntry[] = APP_IMAGE_ALLOWLIST): readonly BuiltInAppTemplateItem[] {
  return APP_BUILT_IN_TEMPLATES.map((t) => {
    const item = {
      templateId: t.templateId,
      versionId: t.versionId,
      slug: t.slug,
      name: t.name,
      description: t.description,
      category: t.category,
      version: validated(t.slug, t.source, allowlist).version,
    };
    if (t.previousVersions === undefined) return item;
    const previousVersions = t.previousVersions.map((p): BuiltInAppTemplateVersionSeed => ({ versionId: p.versionId, ...validated(t.slug, p.source, allowlist) }));
    return { ...item, previousVersions };
  });
}

/** One source, validated and hashed, with the description its catalog entry showed. */
function validated(
  slug: string,
  source: string,
  allowlist: readonly AppImageAllowlistEntry[],
): { readonly description: string; readonly version: NewAppTemplateVersion } {
  const result = validateAppTemplateSource(source, { allowlist });
  if (!result.ok) throw new Error(`built-in app template ${slug} is invalid: ${result.errors.map((e) => e.code).join(",")}`);
  return {
    description: result.spec.description,
    version: { source, specVersion: result.spec.schemaVersion, compiledSchema: result.spec, specHash: computeAppTemplateSpecHash(result.spec) },
  };
}
