import Link from "next/link";
import type { PlatformCapabilitiesDto } from "@hosting-panel/contracts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { Messages } from "@/i18n";

export function AppsUnavailable({ m, reason }: { m: Messages; reason: "off" | "support" }) {
  return (
    <div className="mx-auto max-w-md space-y-4">
      <Alert variant="warning" role="status">
        <AlertTitle>{m.apps.unavailable.title}</AlertTitle>
        <AlertDescription>{m.apps.unavailable[reason]}</AlertDescription>
      </Alert>
      <Link href="/sites" className="text-sm font-medium text-primary hover:underline">
        {m.apps.unavailable.back}
      </Link>
    </div>
  );
}

/** The gate every /apps page runs first; null = go on. */
export function appsGate(ctx: { capabilities: PlatformCapabilitiesDto | null; support: unknown }): "off" | "support" | null {
  if (ctx.support !== null) return "support";
  return ctx.capabilities?.applicationStacksAvailable === true ? null : "off";
}
