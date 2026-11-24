import type { AppStackComponentHealth, AppStackStatus } from "@hosting-panel/contracts";
import { Badge } from "@/components/ui/badge";
import type { Messages } from "@/i18n";
import { APP_STACK_STATUS_TONE, COMPONENT_HEALTH_TONE } from "./app-stack-view";

/**
 * `stale`: the status reads `unknown` only because the components could not be read lately (issue #106). That reading
 * gets its own words; «Outcome to be verified» stays for an operation whose outcome is not known.
 */
export function StackStatusBadge({ status, m, stale = false }: { status: AppStackStatus; m: Messages; stale?: boolean }) {
  return <Badge variant={APP_STACK_STATUS_TONE[status]}>{stale && status === "unknown" ? m.apps.detail.staleBadge : m.apps.status[status]}</Badge>;
}

export function HealthBadge({ health, m }: { health: AppStackComponentHealth; m: Messages }) {
  return <Badge variant={COMPONENT_HEALTH_TONE[health]}>{m.apps.health[health]}</Badge>;
}
