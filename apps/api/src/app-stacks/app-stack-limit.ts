import { AppStackQuotaError } from "@hosting-panel/database";
import { ControlPlaneError } from "../common/control-plane.error.js";

/** Like siteLimitError: exactly one detail, because the web reads `details[0].reason`. Anything else passes through. */
export function appStackQuotaError(err: unknown): unknown {
  if (!(err instanceof AppStackQuotaError)) return err;
  return new ControlPlaneError(
    "QUOTA_EXCEEDED",
    "This customer has reached its application limit. Delete an application or ask the administrator to raise the limit.",
    {
      details: [
        { field: err.field, reason: err.reason, message: `${String(err.used)} of ${String(err.limit)} in use.` },
      ],
    },
  );
}
