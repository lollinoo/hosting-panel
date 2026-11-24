import { AppStackQuotaError, type AppStackQuotaField } from "@hosting-panel/database";
import { ControlPlaneError } from "../common/control-plane.error.js";

const LIMIT_REACHED =
  "This customer has reached its application limit. Delete an application or ask the administrator to raise the limit.";
const usesMore = (what: string) =>
  `The applications of this customer would use more ${what} than the customer has on this server. Delete an application or ask the administrator.`;

/** The application limit keeps the stack reason; processor and memory say which one, so the page does not tell a customer who has room for more applications that the limit is theirs. */
const REFUSALS: Readonly<Record<AppStackQuotaField, { readonly message: string; readonly reason: string }>> = {
  appStacks: { message: LIMIT_REACHED, reason: "STACK_QUOTA_EXCEEDED" },
  cpuMilli: { message: usesMore("processor"), reason: "cpu_limit_reached" },
  memoryBytes: { message: usesMore("memory"), reason: "memory_limit_reached" },
};

/** Like siteLimitError: exactly one detail, because the web reads `details[0].reason`. Anything else passes through. */
export function appStackQuotaError(err: unknown): unknown {
  if (!(err instanceof AppStackQuotaError)) return err;
  const { message, reason } = REFUSALS[err.field];
  return new ControlPlaneError("QUOTA_EXCEEDED", message, {
    details: [{ field: err.field, reason, message: `${String(err.used)} of ${String(err.limit)} in use.` }],
  });
}
