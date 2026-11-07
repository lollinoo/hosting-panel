export const CONTROL_PLANE_CONFIG_TOKEN = Symbol.for("hosting-panel.api.config");
export const DATABASE_CLIENT_TOKEN = Symbol.for("hosting-panel.api.databaseClient");
export const DOCKER_EXECUTOR_TOKEN = Symbol.for("hosting-panel.api.dockerExecutor");
export const HOST_AGENT_TOKEN = Symbol.for("hosting-panel.api.hostAgent");

export interface ControlPlaneRuntimeConfig {
  readonly oidcIssuer: string;
  readonly oidcAudience: string;
  readonly enableDevOidc: boolean;
}
