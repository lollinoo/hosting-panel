import type { AppTemplateValidationOptions } from "@hosting-panel/policy-engine";

export const APP_TEMPLATE_VALIDATION_OPTIONS_TOKEN = Symbol.for("hosting-panel.api.appTemplateValidationOptions");

/** Production passes nothing: the code allowlist APP_IMAGE_ALLOWLIST applies. Tests inject their own rows. */
export function resolveAppTemplateValidationOptions(options?: AppTemplateValidationOptions): AppTemplateValidationOptions {
  return Object.freeze({ ...(options ?? {}) });
}
