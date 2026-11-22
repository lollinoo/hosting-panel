import {
  AppStackActionInputSchema,
  DeployAppStackInputSchema,
  RollbackAppStackInputSchema,
  UpgradeAppStackInputSchema,
} from "@hosting-panel/contracts";
import { bffErrorResponse } from "@/lib/bff-response";
import { forwardIdempotent } from "@/lib/bff-idempotent";

/** Queueing stack actions (spec §9.2). `plan`, `secrets`, `domains`, `components` are static siblings. */
export const APP_STACK_ACTIONS = {
  deploy: { schema: DeployAppStackInputSchema, timeoutMs: 20_000 }, // the API compiles before enqueueing
  start: { schema: AppStackActionInputSchema, timeoutMs: 8_000 },
  stop: { schema: AppStackActionInputSchema, timeoutMs: 8_000 },
  restart: { schema: AppStackActionInputSchema, timeoutMs: 8_000 },
  upgrade: { schema: UpgradeAppStackInputSchema, timeoutMs: 20_000 },
  rollback: { schema: RollbackAppStackInputSchema, timeoutMs: 20_000 },
} as const;
type Ctx = { params: Promise<{ orgId: string; stackId: string; action: string }> };

export async function POST(req: Request, context: Ctx) {
  const { orgId, stackId, action } = await context.params;
  if (!Object.hasOwn(APP_STACK_ACTIONS, action)) return bffErrorResponse("NOT_FOUND", "Azione sconosciuta", 404);
  const a = APP_STACK_ACTIONS[action as keyof typeof APP_STACK_ACTIONS];
  return forwardIdempotent(req, { orgId, stackId }, `v1/organizations/${orgId}/app-stacks/${stackId}/${action}`, "POST", {
    timeoutMs: a.timeoutMs,
    body: (b) => a.schema.safeParse(b).success,
  });
}
