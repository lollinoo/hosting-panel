import {
  appStackPlanSecretRefs,
  type APP_STACK_DIFF_CHANGES,
  type AppStackPlanDiffDto,
  type AppTemplateParameterEntry,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import { computeAppStackComponentHash } from "@hosting-panel/hosting-domain";
import { appStackReplacedComponents, appStackRestartSet } from "./app-stack-runtime-policy.js";

type Change = (typeof APP_STACK_DIFF_CHANGES)[number];
type Route = { readonly componentKey: string; readonly port: number };

const changeOf = (before: string | undefined, after: string | undefined): Change =>
  before === undefined ? "added" : after === undefined ? "removed" : before === after ? "unchanged" : "updated";

/** Union of keys, sorted code-unit; equal tokens = unchanged. */
function keyed(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): { key: string; change: Change }[] {
  return [...new Set([...before.keys(), ...after.keys()])].sort().map((key) => ({ key, change: changeOf(before.get(key), after.get(key)) }));
}

function componentHashes(plan: ApprovedStackPlan | null): Map<string, string> {
  return new Map(plan === null ? [] : plan.components.map((c) => [c.key, computeAppStackComponentHash(plan, c.key)]));
}

/** Public values and secret versions as opaque tokens: compared, never returned. */
function parameterTokens(plan: ApprovedStackPlan | null, entries: readonly AppTemplateParameterEntry[]): Map<string, string> {
  const tokens = new Map(entries.map((e) => [e.key, `value:${JSON.stringify(e.value)}`]));
  const versions = new Map<string, number>();
  for (const ref of plan === null ? [] : appStackPlanSecretRefs(plan)) {
    versions.set(ref.parameterKey, Math.max(versions.get(ref.parameterKey) ?? 0, ref.version));
  }
  for (const [key, version] of versions) tokens.set(key, `secret:${version}`);
  return tokens;
}

const byRoute = (a: Route, b: Route): number =>
  a.componentKey < b.componentKey ? -1 : a.componentKey > b.componentKey ? 1 : a.port - b.port;

export function diffAppStackPlans(input: {
  readonly from: ApprovedStackPlan | null;
  readonly to: ApprovedStackPlan;
  readonly fromParameters: readonly AppTemplateParameterEntry[];
  readonly toParameters: readonly AppTemplateParameterEntry[];
  /** Parameter keys left out of `parameters`: the secrets the customer never sees (ADR-0036). */
  readonly hidden?: ReadonlySet<string>;
}): Pick<AppStackPlanDiffDto, "components" | "volumes" | "parameters" | "ingress" | "downtime" | "dataRisk"> {
  const { from, to } = input;
  const replaced = from === null ? [] : appStackReplacedComponents(from, to);
  const restarted = new Set([...replaced, ...appStackRestartSet(to, replaced)]);
  const components = keyed(componentHashes(from), componentHashes(to)).map(({ key, change }) => ({
    key,
    change,
    restart: change !== "added" && restarted.has(key),
  }));
  const volumeKeys = (plan: ApprovedStackPlan | null) => new Map((plan?.volumes ?? []).map((v) => [v.key, ""]));
  const fromRoutes = from?.ingress ?? [];
  const has = (routes: readonly Route[], route: Route): string | undefined =>
    routes.some((r) => r.componentKey === route.componentKey && r.port === route.port) ? "" : undefined;
  const ingress = [...fromRoutes, ...to.ingress.filter((r) => has(fromRoutes, r) === undefined)]
    .sort(byRoute)
    .map((r) => ({ componentKey: r.componentKey, port: r.port, change: changeOf(has(fromRoutes, r), has(to.ingress, r)) }));
  const byKey = new Map(components.map((c) => [c.key, c]));
  return {
    components,
    volumes: keyed(volumeKeys(from), volumeKeys(to)),
    parameters: keyed(parameterTokens(from, input.fromParameters), parameterTokens(to, input.toParameters)).filter(
      ({ key }) => input.hidden?.has(key) !== true,
    ),
    ingress,
    downtime: fromRoutes.some((r) => {
      const c = byKey.get(r.componentKey);
      return c !== undefined && (c.change === "removed" || c.restart);
    }),
    dataRisk: from !== null && (from.volumes.length > 0 || to.volumes.length > 0) && components.some((c) => c.change !== "unchanged"),
  };
}
