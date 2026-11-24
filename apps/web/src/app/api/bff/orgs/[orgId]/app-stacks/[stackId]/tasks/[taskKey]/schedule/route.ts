import { SetAppStackTaskScheduleInputSchema } from "@hosting-panel/contracts";
import { validatePathSegments } from "@/lib/bff-guard";
import { forwardToUpstream } from "@/lib/bff-proxy";

/** When a task runs by itself: one of the four choices, whole hours in UTC (ADR-0042). */
export async function PUT(req: Request, context: { params: Promise<{ orgId: string; stackId: string; taskKey: string }> }) {
  const { orgId, stackId, taskKey } = await context.params;
  const segmentError = validatePathSegments({ orgId, stackId, taskKey });
  if (segmentError) return segmentError;
  return forwardToUpstream(req, `v1/organizations/${orgId}/app-stacks/${stackId}/tasks/${taskKey}/schedule`, "PUT", undefined, {
    body: (b) => SetAppStackTaskScheduleInputSchema.safeParse(b).success,
  });
}
