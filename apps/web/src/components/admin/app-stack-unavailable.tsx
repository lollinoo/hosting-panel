import type { Messages } from "@/i18n";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { LoadError } from "@/components/shared/load-error";

/** In place of an administrator's page of an application that could not be read: applications are off here, or the read failed. */
export function AppStackUnavailable({ m, code }: { m: Messages; code?: string }) {
  if (code === "NOT_SUPPORTED")
    return (
      <Alert variant="warning" role="status">
        <AlertDescription>{m.admin.appStack.notAvailable}</AlertDescription>
      </Alert>
    );
  return <LoadError m={m} />;
}
