import type { AppStackComponentHealth, AppStackStatus } from "@hosting-panel/contracts";
import { Badge } from "@/components/ui/badge";
import type { Messages } from "@/i18n";
import { APP_STACK_STATUS_TONE, COMPONENT_HEALTH_TONE } from "./app-stack-view";

export function StackStatusBadge({ status, m }: { status: AppStackStatus; m: Messages }) {
  return <Badge variant={APP_STACK_STATUS_TONE[status]}>{m.apps.status[status]}</Badge>;
}

export function HealthBadge({ health, m }: { health: AppStackComponentHealth; m: Messages }) {
  return <Badge variant={COMPONENT_HEALTH_TONE[health]}>{m.apps.health[health]}</Badge>;
}
