import { ApprovedStackPlanSchema, type AppStackStatus } from "@hosting-panel/contracts";
import {
  and,
  appStackComponents,
  appStackDomains,
  appStackRevisions,
  inArray,
  isNull,
  type AppStackRow,
  type DatabaseExecutor,
} from "@hosting-panel/database";
import { APP_STACK_STATUSES_SHOWN_FROM_HEALTH, appStackDisplayStatus } from "./app-stack-runtime-policy.js";

export type ShownAppStack = Pick<AppStackRow, "id" | "status" | "appliedRevisionId" | "appliedRoutesHash">;

/**
 * The status the customer's list and page show (appStackSummaryDto), for the readers that select rows of their own: the
 * administrator's list and the usage of a template. Only an application whose status follows its health and that has a
 * revision applied is computed, from three queries for all of them; the others, and one whose plan cannot be read, show
 * the stored status. Keyed by stack id.
 */
export async function appStackDisplayStatuses(
  db: DatabaseExecutor,
  stacks: readonly ShownAppStack[],
  now: Date,
): Promise<ReadonlyMap<string, AppStackStatus>> {
  const shown = new Map<string, AppStackStatus>(stacks.map((s) => [s.id, s.status]));
  const followed = stacks.filter((s) => s.appliedRevisionId !== null && APP_STACK_STATUSES_SHOWN_FROM_HEALTH.includes(s.status));
  if (followed.length === 0) return shown;
  const stackIds = followed.map((s) => s.id);
  const [revisions, components, domains] = await Promise.all([
    db
      .select({ id: appStackRevisions.id, plan: appStackRevisions.plan })
      .from(appStackRevisions)
      .where(inArray(appStackRevisions.id, followed.map((s) => s.appliedRevisionId!))),
    db.select().from(appStackComponents).where(inArray(appStackComponents.stackId, stackIds)),
    // An address being removed is no usable address, as in the customer's list.
    db
      .select({ stackId: appStackDomains.stackId })
      .from(appStackDomains)
      .where(and(inArray(appStackDomains.stackId, stackIds), isNull(appStackDomains.removalRequestedAt))),
  ]);
  const plans = new Map(revisions.map((r) => [r.id, ApprovedStackPlanSchema.safeParse(r.plan)]));
  for (const stack of followed) {
    const parsed = plans.get(stack.appliedRevisionId!);
    shown.set(
      stack.id,
      appStackDisplayStatus({
        stack,
        plan: parsed?.success ? parsed.data : null,
        components: components.filter((c) => c.stackId === stack.id),
        domainCount: domains.filter((d) => d.stackId === stack.id).length,
        now,
      }),
    );
  }
  return shown;
}
