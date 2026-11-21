import { SITE_LIMIT_REACHED_REASON } from "@hosting-panel/contracts";
import { SiteLimitReachedError } from "@hosting-panel/database";
import { ControlPlaneError } from "../common/control-plane.error.js";

/**
 * The exception filter keeps only `code` and `message` of a database error, so the site limit becomes a
 * ControlPlaneError here: exactly one detail, because the web reads `details[0].reason`. Anything else passes through.
 */
export function siteLimitError(err: unknown): unknown {
  if (!(err instanceof SiteLimitReachedError)) return err;
  return new ControlPlaneError(
    "QUOTA_EXCEEDED",
    "This customer has reached its site limit. Delete a site or ask the administrator to raise the limit.",
    {
      details: [
        {
          field: "sites",
          reason: SITE_LIMIT_REACHED_REASON,
          message: `${String(err.usedSites)} of ${String(err.maxSites)} sites in use.`,
        },
      ],
    },
  );
}
