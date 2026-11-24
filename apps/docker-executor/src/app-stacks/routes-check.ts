import type { AppStackRouteWire, ApprovedStackPlan } from "@hosting-panel/contracts";
import { AppStackExecutorError } from "./errors.js";

/**
 * A route request against its plan, before anything is touched: every route and every path rule (ADR-0037) targets an
 * ingress of the plan, and no host asks for an uploaded certificate. Returns the components that must be ready to
 * receive traffic, each once and in a fixed order. Shared by the engine and the simulator, so they refuse alike.
 */
export function assertAppStackRoutesInPlan(plan: ApprovedStackPlan, routes: readonly AppStackRouteWire[]): string[] {
  const isIngress = (componentKey: string, port: number): boolean =>
    plan.ingress.some((ingress) => ingress.componentKey === componentKey && ingress.port === port);
  const components = new Set<string>();
  for (const route of routes) {
    if (!isIngress(route.componentKey, route.internalPort)) {
      throw new AppStackExecutorError("STACK_PLAN_INVALID", "The route is not an ingress of the plan");
    }
    components.add(route.componentKey);
    for (const host of route.hosts) {
      if (host.source !== undefined) {
        throw new AppStackExecutorError("STACK_UNSUPPORTED_FEATURE", "Only automatic certificates are supported for applications");
      }
      for (const path of host.paths ?? []) {
        if (!isIngress(path.componentKey, path.internalPort)) {
          throw new AppStackExecutorError("STACK_PLAN_INVALID", "A path of the route is not an ingress of the plan");
        }
        components.add(path.componentKey);
      }
    }
  }
  return [...components].sort();
}
