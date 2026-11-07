export const CONTROL_PLANE_CONFIG_TOKEN = Symbol.for("hosting-panel.api.config");
export const DATABASE_CLIENT_TOKEN = Symbol.for("hosting-panel.api.databaseClient");
export const COOLIFY_ADAPTER_TOKEN = Symbol.for("hosting-panel.api.coolifyAdapter");

export interface ControlPlaneRuntimeConfig {
  readonly oidcIssuer: string;
  readonly oidcAudience: string;
  readonly enableDevOidc: boolean;
  readonly enableBackgroundWorker: boolean;
  readonly workerIntervalMs: number;
}
