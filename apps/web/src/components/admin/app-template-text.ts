import { errorMessage, type Messages } from "@/i18n";

/** APP_STACK_REASONS and the admin string reasons have their own sentence; then the feature gate, then the generic errors. */
export function appTemplateRefusalText(m: Messages, code: string, reason?: string): string {
  const t = m.admin.appTemplates;
  if (reason !== undefined && Object.hasOwn(t.reasons, reason)) return (t.reasons as Record<string, string>)[reason]!;
  if (code === "NOT_SUPPORTED") return t.notAvailable;
  return errorMessage(m, code);
}
