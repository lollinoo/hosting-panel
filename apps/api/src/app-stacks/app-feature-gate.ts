import { APP_FEATURES_OFF, type AppFeatureFlags } from "@hosting-panel/contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";

export const APP_FEATURE_GATE_TOKEN = Symbol.for("hosting-panel.api.appFeatureGate");
export type AppFeatureGate = AppFeatureFlags;

export function resolveAppFeatureGate(flags?: Partial<AppFeatureFlags>): AppFeatureGate {
  return Object.freeze({ ...APP_FEATURES_OFF, ...flags });
}

/** After the authz call (stranger 404, non-member 403 first), before the body is used. */
export function requireAppFeature(gate: AppFeatureGate, flag: keyof AppFeatureFlags): void {
  if (gate[flag] !== true) {
    const message = "Applications are not available on this server.";
    throw new ControlPlaneError("NOT_SUPPORTED", message, { details: [{ message, reason: "STACK_UNSUPPORTED_FEATURE" }] });
  }
}
