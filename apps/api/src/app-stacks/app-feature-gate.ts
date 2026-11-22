import { appFeaturesFor, type AppFeatureFlags, type RuntimeBackend } from "@hosting-panel/contracts";
import { ControlPlaneError } from "../common/control-plane.error.js";

export const APP_FEATURE_GATE_TOKEN = Symbol.for("hosting-panel.api.appFeatureGate");
export type AppFeatureGate = AppFeatureFlags;

/**
 * The features of this server: those of its runtime backend (ADR-0036 §2.10). `flags` is the tests' seam; no
 * environment variable and no launcher option reaches it.
 */
export function resolveAppFeatureGate(runtimeBackend: RuntimeBackend, flags?: Partial<AppFeatureFlags>): AppFeatureGate {
  return Object.freeze({ ...appFeaturesFor(runtimeBackend), ...flags });
}

/** After the authz call (stranger 404, non-member 403 first), before the body is used. */
export function requireAppFeature(gate: AppFeatureGate, flag: keyof AppFeatureFlags): void {
  if (gate[flag] !== true) {
    const message = "Applications are not available on this server.";
    throw new ControlPlaneError("NOT_SUPPORTED", message, { details: [{ message, reason: "STACK_UNSUPPORTED_FEATURE" }] });
  }
}
