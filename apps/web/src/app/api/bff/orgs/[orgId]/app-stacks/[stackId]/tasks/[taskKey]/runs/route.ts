import { RunAppStackTaskInputSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { forwardIdempotent } from "@/lib/bff-idempotent";
import { forwardToUpstream } from "@/lib/bff-proxy";

type Ctx = { params: Promise<{ orgId: string; stackId: string; taskKey: string }> };
const upstream = (orgId: string, stackId: string, taskKey: string) =>
  `v1/organizations/${orgId}/app-stacks/${stackId}/tasks/${taskKey}/runs`;

/** The last runs of a task, with what each printed. */
export async function GET(req: Request, context: Ctx) {
  const { orgId, stackId, taskKey } = await context.params;
  const segmentError = validatePathSegments({ orgId, stackId, taskKey });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, upstream(orgId, stackId, taskKey), "GET", undefined, { timeoutMs: 10_000 });
}

/** Runs a task now. The body is empty: a task is named by its key, never by a command (ADR-0042). */
export async function POST(req: Request, context: Ctx) {
  const { orgId, stackId, taskKey } = await context.params;
  return forwardIdempotent(req, { orgId, stackId, taskKey }, upstream(orgId, stackId, taskKey), "POST", {
    timeoutMs: 8_000,
    body: (b) => RunAppStackTaskInputSchema.safeParse(b).success,
  });
}
