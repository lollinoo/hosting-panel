import {
  UpdateDefaultSiteBackupPolicyInputSchema,
  UpdatePanelBackupPolicyInputSchema,
} from "@hosting-panel/contracts";
import { bffErrorResponse } from "@/lib/bff-response";
import { forwardToUpstream } from "@/lib/bff-proxy";

type Ctx = { params: Promise<{ scope: string }> };

// The whitelist runs before the session is read: any other scope is a 400.
async function forward(req: Request, context: Ctx, method: "GET" | "PATCH") {
  const { scope } = await context.params;
  if (scope !== "default" && scope !== "panel") {
    return bffErrorResponse("VALIDATION_ERROR", "Ambito della policy non valido", 400);
  }
  const schema = scope === "default" ? UpdateDefaultSiteBackupPolicyInputSchema : UpdatePanelBackupPolicyInputSchema;
  return forwardToUpstream(req, `v1/admin/backup-policies/${scope}`, method, undefined, {
    timeoutMs: 20_000,
    ...(method === "PATCH" ? { body: (b: unknown) => schema.safeParse(b).success } : {}),
  });
}

export const GET = (req: Request, context: Ctx) => forward(req, context, "GET");
export const PATCH = (req: Request, context: Ctx) => forward(req, context, "PATCH");
