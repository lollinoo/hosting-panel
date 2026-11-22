import { APP_BUILT_IN_TEMPLATES, APP_IMAGE_ALLOWLIST, APP_TEMPLATE_SPEC_VERSION, type AppImageAllowlistEntry } from "@hosting-panel/contracts";
import { computeAppTemplateSpecHash } from "@hosting-panel/hosting-domain";
import { validateAppTemplateSource } from "@hosting-panel/policy-engine";
import type { ensureBuiltInAppTemplates } from "./app-templates-repository.js";

export type BuiltInAppTemplateItem = Parameters<typeof ensureBuiltInAppTemplates>[1][number];

/** Validated, hashed seed rows. Throws Error("built-in app template <slug> is invalid: <CODE,CODE>") when a source does
 *  not validate: only a code change of the same release can cause it, and its unit test fails first. */
export function builtInAppTemplateItems(allowlist: readonly AppImageAllowlistEntry[] = APP_IMAGE_ALLOWLIST): readonly BuiltInAppTemplateItem[] {
  return APP_BUILT_IN_TEMPLATES.map((t) => {
    const result = validateAppTemplateSource(t.source, { allowlist });
    if (!result.ok) throw new Error(`built-in app template ${t.slug} is invalid: ${result.errors.map((e) => e.code).join(",")}`);
    return {
      templateId: t.templateId,
      versionId: t.versionId,
      slug: t.slug,
      name: t.name,
      description: t.description,
      category: t.category,
      version: {
        source: t.source,
        specVersion: APP_TEMPLATE_SPEC_VERSION,
        compiledSchema: result.spec,
        specHash: computeAppTemplateSpecHash(result.spec),
      },
    };
  });
}
