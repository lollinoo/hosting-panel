import {
  APP_STACK_ID_PATTERN,
  APP_STACK_KEY_PATTERN,
  type AppStackNetworkRole,
  type ApprovedStackPlan,
} from "@hosting-panel/contracts";
import { computeAppStackComponentHash } from "@hosting-panel/hosting-domain";
import { ExecutorCodedError, assertSafeIdentifier } from "../traefik-config.js";
import { encodeAppStackHealthLabel, encodeAppStackSecretEnvLabel } from "./container-payload.js";

function checked(value: string, pattern: RegExp, fieldName: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ExecutorCodedError(`Unsafe or malformed identifier for ${fieldName}`, "HOST_POLICY_DENIED");
  }
  return value;
}

const stack = (stackId: string) => checked(stackId, APP_STACK_ID_PATTERN, "stackId");
const key = (value: string, fieldName: string) => checked(value, APP_STACK_KEY_PATTERN, fieldName);

export function appStackContainerName(stackId: string, componentKey: string): string {
  return assertSafeIdentifier(`hp_app_${stack(stackId)}_${key(componentKey, "componentKey")}`, "containerName");
}

export function appStackInternalNetworkName(stackId: string): string {
  return assertSafeIdentifier(`hp_appnet_${stack(stackId)}`, "networkName");
}

export function appStackEdgeNetworkName(stackId: string): string {
  return assertSafeIdentifier(`hp_appedge_${stack(stackId)}`, "networkName");
}

export function appStackVolumeName(stackId: string, volumeKey: string): string {
  return assertSafeIdentifier(`hp_appvol_${stack(stackId)}_${key(volumeKey, "volumeKey")}`, "volumeName");
}

export function appStackSecretDirKey(stackId: string, componentKey: string): string {
  return assertSafeIdentifier(`app_${stack(stackId)}__${key(componentKey, "componentKey")}`, "secretDir");
}

export function appStackRouteFileName(stackId: string): string {
  return assertSafeIdentifier(`app_${stack(stackId)}.yml`, "routeFile");
}

export const APP_STACK_LABELS = Object.freeze({
  managed: "io.hostingpanel.managed",
  role: "io.hostingpanel.role",
  stackId: "io.hostingpanel.stack_id",
  organizationId: "io.hostingpanel.organization_id",
  networkRole: "io.hostingpanel.network_role",
  component: "io.hostingpanel.app_component",
  componentHash: "io.hostingpanel.app_component_hash",
  revisionId: "io.hostingpanel.app_revision_id",
  startIndex: "io.hostingpanel.app_start_index",
  health: "io.hostingpanel.app_health",
  /** Only on a component with environment secrets (v2): their names and template text, never a value. */
  secretEnvironment: "io.hostingpanel.app_secret_env",
  volumeKey: "io.hostingpanel.app_volume_key",
} as const);
export const APP_STACK_COMPONENT_ROLE = "app_component" as const;

export function appStackComponentLabels(plan: ApprovedStackPlan, componentKey: string): Readonly<Record<string, string>> {
  const index = plan.components.findIndex((component) => component.key === componentKey);
  const component = plan.components[index];
  if (component === undefined) throw new RangeError(`Unknown stack component: ${componentKey}`);
  const secretEnvironment = encodeAppStackSecretEnvLabel(component);
  return Object.freeze({
    [APP_STACK_LABELS.managed]: "true",
    [APP_STACK_LABELS.role]: APP_STACK_COMPONENT_ROLE,
    [APP_STACK_LABELS.stackId]: plan.stackId,
    [APP_STACK_LABELS.organizationId]: plan.organizationId,
    [APP_STACK_LABELS.component]: componentKey,
    [APP_STACK_LABELS.componentHash]: computeAppStackComponentHash(plan, componentKey),
    [APP_STACK_LABELS.revisionId]: plan.revisionId,
    [APP_STACK_LABELS.startIndex]: String(index),
    [APP_STACK_LABELS.health]: encodeAppStackHealthLabel(component.healthcheck),
    ...(secretEnvironment === null ? {} : { [APP_STACK_LABELS.secretEnvironment]: secretEnvironment }),
  });
}

export function appStackNetworkLabels(
  plan: Pick<ApprovedStackPlan, "stackId" | "organizationId">,
  role: AppStackNetworkRole,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [APP_STACK_LABELS.managed]: "true",
    [APP_STACK_LABELS.networkRole]: role,
    [APP_STACK_LABELS.stackId]: plan.stackId,
    [APP_STACK_LABELS.organizationId]: plan.organizationId,
  });
}

export function appStackVolumeLabels(
  plan: Pick<ApprovedStackPlan, "stackId" | "organizationId">,
  volumeKey: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [APP_STACK_LABELS.managed]: "true",
    [APP_STACK_LABELS.stackId]: plan.stackId,
    [APP_STACK_LABELS.organizationId]: plan.organizationId,
    [APP_STACK_LABELS.volumeKey]: volumeKey,
  });
}

/** "own" = managed "true" AND stack_id === stackId AND organization_id === organizationId. */
export function isOwnAppStackResource(
  labels: Readonly<Record<string, string>> | undefined,
  stackId: string,
  organizationId: string,
): boolean {
  return (
    labels?.[APP_STACK_LABELS.managed] === "true" &&
    labels[APP_STACK_LABELS.stackId] === stackId &&
    labels[APP_STACK_LABELS.organizationId] === organizationId
  );
}
