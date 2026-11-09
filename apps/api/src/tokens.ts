import type { RuntimeBackend } from "@hosting-panel/contracts";

export const CONTROL_PLANE_CONFIG_TOKEN = Symbol.for("hosting-panel.api.config");
export const DATABASE_CLIENT_TOKEN = Symbol.for("hosting-panel.api.databaseClient");
export const DNS_LOOKUP_TOKEN = Symbol.for("hosting-panel.api.dnsLookup");
export const DOCKER_EXECUTOR_TOKEN = Symbol.for("hosting-panel.api.dockerExecutor");
export const HOST_AGENT_TOKEN = Symbol.for("hosting-panel.api.hostAgent");

export interface ControlPlaneRuntimeConfig {
  readonly oidcIssuer: string;
  readonly oidcAudience: string;
  readonly enableDevOidc: boolean;
  readonly runtimeBackend: RuntimeBackend;
  readonly secretsMasterKey: Buffer;
  readonly breakglassSigningKey?: Uint8Array;
  readonly jwtSigningKeyPem: string | null;
  readonly autoProcessOutbox: boolean;
  readonly outboxPollIntervalMs?: number | null;
  readonly driftReconcileIntervalMs?: number | null;
  readonly domainReconcileIntervalMs?: number | null;
  readonly mailRelayRetryIntervalMs?: number | null;
}
