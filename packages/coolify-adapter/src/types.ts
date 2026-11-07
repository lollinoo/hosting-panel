import {
  isDefaultRetryableErrorCode,
  type DatabaseEngine,
  type ErrorCode,
  type ObservedResourceStatus,
  type ProviderCapabilities,
  type ProviderConnectionStatus,
  type ResourceHealthStatus,
} from "@hosting-panel/contracts";
import { redactSensitiveString } from "./redaction.js";

export interface ProviderTokenSet {
  readonly read: string;
  readonly deploy?: string;
  readonly write?: string;
}

export interface AuthorizedProviderContext {
  readonly connectionId: string;
  readonly baseUrl: string;
  readonly teamId?: string | null;
  readonly tokens: ProviderTokenSet;
  readonly requestId: string;
}

export interface ProviderVersionInfo {
  readonly version: string;
  readonly status: ProviderConnectionStatus;
  readonly capabilities: ProviderCapabilities;
  readonly observedAt: string;
  readonly source: "coolify";
  readonly stale?: boolean;
}

/**
 * Normalized server-side Coolify application observation.
 * `providerId` is strictly server-only for internal backend correlation and
 * MUST NEVER be serialized into public `/v1` DTOs or client responses.
 */
export interface ProviderApplicationSnapshot {
  /** Server-only upstream Coolify application UUID for internal backend correlation. */
  readonly providerId: string;
  readonly name: string;
  readonly fqdn: string | null;
  readonly domains: readonly string[];
  readonly repositoryUrl: string | null;
  readonly branch: string | null;
  readonly buildPack: string;
  readonly environment: string | null;
  readonly status: ObservedResourceStatus;
  readonly health: ResourceHealthStatus;
  readonly observedAt: string;
  readonly source: "coolify";
  readonly stale?: boolean;
}

/**
 * Normalized server-side Coolify database observation.
 * `providerId` is strictly server-only for internal backend correlation and
 * MUST NEVER be serialized into public `/v1` DTOs or client responses.
 */
export interface ProviderDatabaseSnapshot {
  /** Server-only upstream Coolify database UUID for internal backend correlation. */
  readonly providerId: string;
  readonly name: string;
  readonly engine: DatabaseEngine;
  readonly engineVersion: string;
  readonly internalHostname: string | null;
  readonly port: number | null;
  readonly backupSupported: boolean;
  readonly restoreSupported: boolean;
  readonly backupUnsupportedReason: string | null;
  readonly status: ObservedResourceStatus;
  readonly health: ResourceHealthStatus;
  readonly observedAt: string;
  readonly source: "coolify";
  readonly stale?: boolean;
}

/**
 * Normalized server-side Coolify server observation.
 * `providerId` is strictly server-only for internal backend correlation and
 * MUST NEVER be serialized into public `/v1` DTOs or client responses.
 */
export interface ProviderServerSnapshot {
  /** Server-only upstream Coolify server UUID for internal backend correlation. */
  readonly providerId: string;
  readonly name: string;
  readonly ip: string | null;
  readonly port: number | null;
  readonly region: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly status: ObservedResourceStatus;
  readonly health: ResourceHealthStatus;
  readonly observedAt: string;
  readonly source: "coolify";
  readonly stale?: boolean;
}

export type ProviderDeploymentState =
  | "queued"
  | "in_progress"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

/**
 * Normalized server-side Coolify deployment observation.
 * `providerId` is strictly server-only for internal backend correlation and
 * MUST NEVER be serialized into public `/v1` DTOs or client responses.
 */
export interface ProviderDeploymentSnapshot {
  /** Server-only upstream Coolify deployment UUID for internal backend correlation. */
  readonly providerId: string;
  readonly state: ProviderDeploymentState;
  readonly commitSha: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly status: ObservedResourceStatus;
  readonly health: ResourceHealthStatus;
  readonly observedAt: string;
  readonly source: "coolify";
  readonly stale?: boolean;
}

/**
 * Normalized server-side mutation acknowledgement from Coolify.
 * `providerId` holds the server-only upstream deployment/correlation UUID and
 * MUST NEVER be serialized into public `/v1` DTOs or client responses.
 */
export interface ProviderOperationAccepted {
  /** Server-only upstream Coolify deployment UUID for internal backend reconciliation. */
  readonly providerId: string;
  readonly message: string | null;
  readonly status: ObservedResourceStatus;
  readonly health: ResourceHealthStatus;
  readonly observedAt: string;
  readonly source: "coolify";
  readonly stale?: boolean;
}

export interface DeployApplicationOptions {
  readonly forceRebuild?: boolean;
}

export interface TriggerDatabaseRestoreInput {
  readonly providerDatabaseUuid: string;
  readonly engine: DatabaseEngine;
  readonly backupId?: string;
}

export interface CoolifyAdapterErrorOptions {
  readonly httpStatus?: number;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly ambiguousSideEffect?: boolean;
  readonly knownSecrets?: readonly string[];
}

export interface CoolifyAdapterErrorInit extends CoolifyAdapterErrorOptions {
  readonly code: ErrorCode;
  readonly message: string;
}

export class CoolifyAdapterError extends Error {
  public readonly code: ErrorCode;
  public readonly httpStatus?: number;
  public readonly retryable: boolean;
  public readonly retryAfterMs?: number;
  public readonly ambiguousSideEffect: boolean;

  public constructor(init: CoolifyAdapterErrorInit);
  public constructor(
    code: ErrorCode,
    message: string,
    options?: CoolifyAdapterErrorOptions,
  );
  public constructor(
    initOrCode: CoolifyAdapterErrorInit | ErrorCode,
    maybeMessage?: string,
    maybeOptions?: CoolifyAdapterErrorOptions,
  ) {
    const init: CoolifyAdapterErrorInit =
      typeof initOrCode === "string"
        ? {
            code: initOrCode,
            message: maybeMessage ?? "Coolify provider error.",
            ...maybeOptions,
          }
        : initOrCode;

    const safeMessage = redactSensitiveString(init.message, init.knownSecrets);
    super(safeMessage);

    this.name = "CoolifyAdapterError";
    this.code = init.code;
    this.httpStatus = init.httpStatus;
    const ambiguous = init.ambiguousSideEffect ?? init.code === "OPERATION_AMBIGUOUS";
    this.ambiguousSideEffect = ambiguous;
    this.retryable =
      init.retryable ?? (ambiguous ? false : isDefaultRetryableErrorCode(init.code));
    this.retryAfterMs = init.retryAfterMs;

    Object.setPrototypeOf(this, new.target.prototype);
  }

  public toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      ambiguousSideEffect: this.ambiguousSideEffect,
    };
  }
}

export interface CoolifyAdapterLogEntry {
  readonly level: "warn" | "error";
  readonly event: string;
  readonly connectionId: string;
  readonly requestId: string;
  readonly method: "GET" | "POST";
  readonly endpoint: string;
  readonly code: ErrorCode;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;
  readonly ambiguousSideEffect: boolean;
  readonly message: string;
}

export interface HostingProvider {
  readonly capabilities: ProviderCapabilities;

  testConnection(ctx: AuthorizedProviderContext): Promise<ProviderVersionInfo>;

  listApplications(
    ctx: AuthorizedProviderContext,
  ): Promise<readonly ProviderApplicationSnapshot[]>;

  getApplication(
    ctx: AuthorizedProviderContext,
    providerApplicationUuid: string,
  ): Promise<ProviderApplicationSnapshot>;

  deployApplication(
    ctx: AuthorizedProviderContext,
    providerApplicationUuid: string,
    options?: DeployApplicationOptions,
  ): Promise<ProviderOperationAccepted>;

  restartApplication(
    ctx: AuthorizedProviderContext,
    providerApplicationUuid: string,
  ): Promise<ProviderOperationAccepted>;

  getDeployment(
    ctx: AuthorizedProviderContext,
    providerDeploymentUuid: string,
  ): Promise<ProviderDeploymentSnapshot>;

  listDatabases(
    ctx: AuthorizedProviderContext,
  ): Promise<readonly ProviderDatabaseSnapshot[]>;

  getServer(
    ctx: AuthorizedProviderContext,
    providerServerUuid: string,
  ): Promise<ProviderServerSnapshot>;

  listServers?(
    ctx: AuthorizedProviderContext,
  ): Promise<readonly ProviderServerSnapshot[]>;

  triggerDatabaseRestore(
    ctx: AuthorizedProviderContext,
    input: TriggerDatabaseRestoreInput,
  ): Promise<ProviderOperationAccepted>;
  triggerDatabaseRestore(
    ctx: AuthorizedProviderContext,
    providerDatabaseUuid: string,
    engine: DatabaseEngine,
    backupId?: string,
  ): Promise<ProviderOperationAccepted>;
}
