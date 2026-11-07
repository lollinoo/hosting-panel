import {
  DEFAULT_COOLIFY_V4_CAPABILITIES,
  getDatabaseBackupCapabilities,
  type DatabaseEngine,
  type ErrorCode,
  type ObservedResourceStatus,
  type ProviderCapabilities,
  type ResourceHealthStatus,
} from "@hosting-panel/contracts";
import { z } from "zod";
import { redactSensitiveString, redactSensitiveValue } from "./redaction.js";
import {
  CoolifyAdapterError,
  type AuthorizedProviderContext,
  type CoolifyAdapterLogEntry,
  type DeployApplicationOptions,
  type HostingProvider,
  type ProviderApplicationSnapshot,
  type ProviderDatabaseSnapshot,
  type ProviderDeploymentSnapshot,
  type ProviderDeploymentState,
  type ProviderOperationAccepted,
  type ProviderServerSnapshot,
  type ProviderVersionInfo,
  type TriggerDatabaseRestoreInput,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_097_152; // 2 MiB
const DEFAULT_STALE_AFTER_MS = 300_000; // 5 minutes
const DEFAULT_MAX_GET_RETRIES = 1;
const DEFAULT_RETRY_BASE_DELAY_MS = 40;
const DEFAULT_RETRY_MAX_DELAY_MS = 120;
const DEFAULT_COOLDOWN_MS = 5_000;
const DEFAULT_MAX_COOLDOWN_MS = 300_000; // 5 minutes
const MAX_ERROR_BODY_BYTES = 16_384;

const SAFE_PROVIDER_IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PLAIN_VERSION_TEXT_PATTERN = /^v?\d+\.\d+\.\d+[A-Za-z0-9._+-]*$/;

function hasUnsafeUrlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code <= 0x20 ||
      code === 0x7f ||
      code === 0x5c /* backslash */
    ) {
      return true;
    }
  }
  return false;
}

const LOCALHOST_HOSTNAMES: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
]);

const FORBIDDEN_METADATA_HOSTNAMES: ReadonlySet<string> = new Set([
  "169.254.169.254",
  "fd00:ec2::254",
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "0.0.0.0",
  "::",
]);

type AllowlistedEndpoint =
  | { readonly kind: "version"; readonly method: "GET" }
  | { readonly kind: "applications.list"; readonly method: "GET" }
  | {
      readonly kind: "applications.get";
      readonly method: "GET";
      readonly uuid: string;
    }
  | {
      readonly kind: "applications.deploy";
      readonly method: "POST";
      readonly uuid: string;
      readonly forceRebuild: boolean;
    }
  | {
      readonly kind: "applications.restart";
      readonly method: "POST";
      readonly uuid: string;
    }
  | {
      readonly kind: "deployments.get";
      readonly method: "GET";
      readonly uuid: string;
    }
  | { readonly kind: "databases.list"; readonly method: "GET" }
  | { readonly kind: "servers.list"; readonly method: "GET" }
  | {
      readonly kind: "servers.get";
      readonly method: "GET";
      readonly uuid: string;
    };

class ResponseTooLargeError extends Error {
  public readonly limitBytes: number;

  public constructor(limitBytes: number) {
    super(`Coolify response exceeded maximum size limit of ${String(limitBytes)} bytes.`);
    this.name = "ResponseTooLargeError";
    this.limitBytes = limitBytes;
  }
}

const RawCoolifyVersionObjectSchema = z.object({
  version: z.string().trim().min(1),
});

const RawCoolifyEnvironmentFieldSchema = z
  .union([
    z.string(),
    z.object({
      name: z.string().optional(),
    }),
  ])
  .nullable()
  .optional();

const RawCoolifyApplicationSchema = z.object({
  uuid: z.string().min(1),
  name: z.string().min(1),
  fqdn: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  health: z.string().nullable().optional(),
  health_status: z.string().nullable().optional(),
  git_repository: z.string().nullable().optional(),
  repository_url: z.string().nullable().optional(),
  git_branch: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  build_pack: z.string().nullable().optional(),
  environment_name: z.string().nullable().optional(),
  environment: RawCoolifyEnvironmentFieldSchema,
});

const RawCoolifyDeployEntrySchema = z.object({
  deployment_uuid: z.string().min(1),
  resource_uuid: z.string().optional(),
  message: z.string().nullable().optional(),
});

const RawCoolifyDeployResponseSchema = z.union([
  z.object({
    deployments: z.array(RawCoolifyDeployEntrySchema).min(1),
    message: z.string().nullable().optional(),
  }),
  z.object({
    deployment_uuid: z.string().min(1),
    message: z.string().nullable().optional(),
  }),
]);

const RawCoolifyRestartFallbackSchema = z.object({
  uuid: z.string().min(1).optional(),
  message: z.string().min(1),
});

const RawCoolifyDeploymentSchema = z.object({
  deployment_uuid: z.string().min(1).optional(),
  uuid: z.string().min(1).optional(),
  status: z.string().nullable().optional(),
  commit: z.string().nullable().optional(),
  commit_sha: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  created_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});

const RawCoolifyDatabaseSchema = z.object({
  uuid: z.string().min(1),
  name: z.string().min(1),
  database_type: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  engine: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  health: z.string().nullable().optional(),
  internal_db_url: z.string().nullable().optional(),
  public_port: z.number().int().min(1).max(65535).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
});

const RawCoolifyServerSettingsSchema = z.object({
  is_reachable: z.boolean().nullable().optional(),
  is_usable: z.boolean().nullable().optional(),
  is_sentinel_enabled: z.boolean().nullable().optional(),
  sentinel_updated_at: z.string().nullable().optional(),
});

const RawCoolifyServerSchema = z.object({
  uuid: z.string().min(1),
  name: z.string().min(1),
  ip: z.string().nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  region: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  health: z.string().nullable().optional(),
  is_reachable: z.boolean().nullable().optional(),
  is_usable: z.boolean().nullable().optional(),
  sentinel_enabled: z.boolean().nullable().optional(),
  sentinel_updated_at: z.string().nullable().optional(),
  last_heartbeat_at: z.string().nullable().optional(),
  settings: RawCoolifyServerSettingsSchema.nullable().optional(),
});

export interface CoolifyV4AdapterOptions {
  readonly allowedHosts: readonly string[];
  readonly allowInsecureLocalhost?: boolean;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly staleAfterMs?: number;
  readonly maxGetRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly defaultCooldownMs?: number;
  readonly maxCooldownMs?: number;
  readonly capabilities?: ProviderCapabilities;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly logger?: (entry: CoolifyAdapterLogEntry) => void;
}

function normalizeHostname(rawHostname: string): string {
  const lower = rawHostname.trim().toLowerCase();
  if (lower.startsWith("[") && lower.endsWith("]")) {
    return lower.slice(1, -1);
  }
  return lower;
}

function isForbiddenMetadataHost(normalizedHost: string): boolean {
  if (FORBIDDEN_METADATA_HOSTNAMES.has(normalizedHost)) {
    return true;
  }
  if (normalizedHost.startsWith("169.254.")) {
    return true;
  }
  if (
    normalizedHost.startsWith("::ffff:a9fe:") ||
    normalizedHost.startsWith("::ffff:169.254.")
  ) {
    return true;
  }
  if (normalizedHost.startsWith("fe80:")) {
    return true;
  }
  if (/^fd00:0*ec2:(?:0+:)*0*254$/i.test(normalizedHost)) {
    return true;
  }
  return false;
}

function collectKnownSecrets(ctx: AuthorizedProviderContext): string[] {
  const secrets: string[] = [];
  for (const candidate of [ctx.tokens.read, ctx.tokens.deploy, ctx.tokens.write]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      secrets.push(candidate.trim());
    }
  }
  return secrets;
}

function sanitizeHeaderToken(value: string, fallback: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code > 0x1f && code !== 0x7f) {
      out += value.charAt(index);
    }
  }
  const cleaned = out.trim();
  return cleaned.length > 0 ? cleaned.slice(0, 128) : fallback;
}

export function normalizeCoolifyStatus(
  rawStatus: string | null | undefined,
  rawHealth?: string | null | undefined,
): { readonly status: ObservedResourceStatus; readonly health: ResourceHealthStatus } {
  const cleanedStatus = rawStatus?.trim().toLowerCase() ?? "";
  const cleanedExplicitHealth = rawHealth?.trim().toLowerCase() ?? "";

  const [statePartRaw, suffixHealthRaw] = cleanedStatus.split(":", 2);
  const statePart = statePartRaw?.trim() ?? "";
  const healthCandidate = (suffixHealthRaw?.trim() || cleanedExplicitHealth).toLowerCase();

  let explicitHealth: ResourceHealthStatus | undefined;
  if (healthCandidate === "healthy") {
    explicitHealth = "healthy";
  } else if (healthCandidate === "unhealthy") {
    explicitHealth = "unhealthy";
  } else if (healthCandidate === "unknown") {
    explicitHealth = "unknown";
  }

  switch (statePart) {
    case "running":
    case "online":
    case "up":
    case "reachable":
      return {
        status: "running",
        health: explicitHealth ?? "unknown",
      };
    case "healthy":
      return {
        status: "running",
        health: explicitHealth ?? "healthy",
      };
    case "exited":
    case "stopped":
    case "paused":
    case "created":
    case "down":
    case "offline":
      return {
        status: "stopped",
        health: explicitHealth ?? "unknown",
      };
    case "starting":
    case "restarting":
    case "deploying":
    case "building":
    case "in_progress":
    case "queued":
    case "pending":
      return {
        status: "deploying",
        health: explicitHealth ?? "unknown",
      };
    case "degraded":
      return {
        status: "degraded",
        health: explicitHealth ?? "unhealthy",
      };
    case "failed":
    case "error":
    case "crashed":
    case "dead":
    case "unhealthy":
    case "unreachable":
      return {
        status: "failed",
        health: explicitHealth ?? "unhealthy",
      };
    default:
      return {
        status: "unknown",
        health: explicitHealth ?? "unknown",
      };
  }
}

function normalizeDeploymentState(rawStatus: string | null | undefined): {
  readonly state: ProviderDeploymentState;
  readonly status: ObservedResourceStatus;
  readonly health: ResourceHealthStatus;
} {
  const cleaned = rawStatus?.trim().toLowerCase() ?? "";
  switch (cleaned) {
    case "queued":
    case "pending":
      return { state: "queued", status: "deploying", health: "unknown" };
    case "in_progress":
    case "running":
    case "building":
    case "deploying":
    case "starting":
      return { state: "in_progress", status: "deploying", health: "unknown" };
    case "finished":
    case "succeeded":
    case "success":
    case "completed":
      return { state: "succeeded", status: "running", health: "healthy" };
    case "failed":
    case "error":
    case "timed_out":
      return { state: "failed", status: "failed", health: "unhealthy" };
    case "cancelled":
    case "canceled":
    case "cancelled-by-user":
      return { state: "cancelled", status: "stopped", health: "unknown" };
    default:
      return { state: "unknown", status: "unknown", health: "unknown" };
  }
}

function normalizeDatabaseEngine(
  rawDatabaseType?: string | null,
  rawType?: string | null,
  rawEngine?: string | null,
  rawImage?: string | null,
): DatabaseEngine | null {
  const candidates = [rawEngine, rawDatabaseType, rawType, rawImage];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const lower = candidate.toLowerCase();
    if (lower.includes("postgres")) {
      return "postgresql";
    }
    if (lower.includes("mariadb")) {
      return "mariadb";
    }
    if (lower.includes("mysql")) {
      return "mysql";
    }
    if (lower.includes("mongo")) {
      return "mongodb";
    }
    if (
      lower.includes("redis") ||
      lower.includes("valkey") ||
      lower.includes("dragonfly") ||
      lower.includes("keydb")
    ) {
      return "redis";
    }
  }
  return null;
}

function extractDatabaseVersion(
  rawVersion?: string | null,
  rawImage?: string | null,
): string {
  if (rawVersion && rawVersion.trim().length > 0) {
    return rawVersion.trim();
  }
  if (rawImage && rawImage.includes(":")) {
    const [, tag] = rawImage.split(":", 2);
    if (tag && tag.trim().length > 0) {
      return tag.trim();
    }
  }
  return "unknown";
}

function extractSafeDbEndpoint(
  internalDbUrl?: string | null,
  explicitPort?: number | null,
): { readonly internalHostname: string | null; readonly port: number | null } {
  if (!internalDbUrl || internalDbUrl.trim().length === 0) {
    return { internalHostname: null, port: explicitPort ?? null };
  }

  try {
    const parsed = new URL(internalDbUrl);
    const hostname = parsed.hostname ? normalizeHostname(parsed.hostname) : null;
    const parsedPort = parsed.port ? Number.parseInt(parsed.port, 10) : null;
    const validPort =
      parsedPort !== null &&
      Number.isInteger(parsedPort) &&
      parsedPort >= 1 &&
      parsedPort <= 65535
        ? parsedPort
        : (explicitPort ?? null);
    return {
      internalHostname: hostname && hostname.length > 0 ? hostname : null,
      port: validPort,
    };
  } catch {
    return { internalHostname: null, port: explicitPort ?? null };
  }
}

function parseDomains(fqdn: string | null | undefined): {
  readonly primaryFqdn: string | null;
  readonly domains: readonly string[];
} {
  if (!fqdn || fqdn.trim().length === 0) {
    return { primaryFqdn: null, domains: [] };
  }

  const domains = fqdn
    .split(",")
    .map((entry) => redactSensitiveString(entry.trim()))
    .filter((entry) => entry.length > 0);

  return {
    primaryFqdn: domains[0] ?? null,
    domains,
  };
}

function unwrapDataEnvelope(payload: unknown): unknown {
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "data" in payload
  ) {
    return (payload as { readonly data: unknown }).data;
  }
  return payload;
}

async function readBoundedResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null && /^\d+$/.test(contentLengthHeader.trim())) {
    const declaredBytes = Number.parseInt(contentLengthHeader.trim(), 10);
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(maxBytes);
    }
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new ResponseTooLargeError(maxBytes);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function sleepMs(durationMs: number): Promise<void> {
  if (durationMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export class CoolifyV4Adapter implements HostingProvider {
  public readonly capabilities: ProviderCapabilities;

  readonly #allowedHosts: ReadonlySet<string>;
  readonly #allowInsecureLocalhost: boolean;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #staleAfterMs: number;
  readonly #maxGetRetries: number;
  readonly #retryBaseDelayMs: number;
  readonly #retryMaxDelayMs: number;
  readonly #defaultCooldownMs: number;
  readonly #maxCooldownMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #logger?: (entry: CoolifyAdapterLogEntry) => void;
  readonly #cooldownUntilByConnection = new Map<string, number>();

  public constructor(options: CoolifyV4AdapterOptions) {
    const normalizedAllowedHosts = new Set<string>();
    for (const host of options.allowedHosts) {
      const normalized = normalizeHostname(host);
      if (normalized.length > 0 && !normalized.endsWith(".")) {
        normalizedAllowedHosts.add(normalized);
      }
    }

    this.#allowedHosts = normalizedAllowedHosts;
    this.#allowInsecureLocalhost = options.allowInsecureLocalhost ?? false;
    this.#timeoutMs = Math.max(50, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#maxResponseBytes = Math.max(
      256,
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    );
    this.#staleAfterMs = Math.max(1_000, options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS);
    this.#maxGetRetries = Math.max(0, options.maxGetRetries ?? DEFAULT_MAX_GET_RETRIES);
    this.#retryBaseDelayMs = Math.max(
      0,
      options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    );
    this.#retryMaxDelayMs = Math.max(
      this.#retryBaseDelayMs,
      options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
    );
    this.#defaultCooldownMs = Math.max(
      100,
      options.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS,
    );
    this.#maxCooldownMs = Math.max(
      this.#defaultCooldownMs,
      options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS,
    );
    this.capabilities = options.capabilities ?? DEFAULT_COOLIFY_V4_CAPABILITIES;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? (() => Date.now());
    this.#logger = options.logger;
  }

  public async testConnection(
    ctx: AuthorizedProviderContext,
  ): Promise<ProviderVersionInfo> {
    const rawResponse = await this.#executeRequest(
      ctx,
      { kind: "version", method: "GET" },
      "read",
    );

    const observedAt = new Date(this.#now()).toISOString();
    const trimmed = rawResponse.bodyText.trim();
    const contentType = rawResponse.contentType.toLowerCase();

    if (
      !contentType.includes("application/json") &&
      !trimmed.startsWith("{") &&
      !trimmed.startsWith("[") &&
      !trimmed.startsWith('"') &&
      PLAIN_VERSION_TEXT_PATTERN.test(trimmed)
    ) {
      return {
        version: trimmed,
        status: "connected",
        capabilities: this.capabilities,
        observedAt,
        source: "coolify",
        stale: false,
      };
    }

    const parsedJson = this.#parseJsonPayload(ctx, rawResponse.bodyText, false, "GET", "/api/v1/version");
    if (typeof parsedJson === "string" && parsedJson.trim().length > 0) {
      return {
        version: redactSensitiveString(parsedJson.trim(), collectKnownSecrets(ctx)),
        status: "connected",
        capabilities: this.capabilities,
        observedAt,
        source: "coolify",
        stale: false,
      };
    }

    const versionResult = RawCoolifyVersionObjectSchema.safeParse(
      unwrapDataEnvelope(parsedJson),
    );
    if (!versionResult.success) {
      throw this.#createAndLogError(ctx, "GET", "/api/v1/version", {
        code: "COOLIFY_UNAVAILABLE",
        message: "Coolify version response failed schema normalization.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    return {
      version: redactSensitiveString(versionResult.data.version, collectKnownSecrets(ctx)),
      status: "connected",
      capabilities: this.capabilities,
      observedAt,
      source: "coolify",
      stale: false,
    };
  }

  public async listApplications(
    ctx: AuthorizedProviderContext,
  ): Promise<readonly ProviderApplicationSnapshot[]> {
    const rawResponse = await this.#executeRequest(
      ctx,
      { kind: "applications.list", method: "GET" },
      "read",
    );
    const parsedJson = unwrapDataEnvelope(
      this.#parseJsonPayload(ctx, rawResponse.bodyText, false, "GET", "/api/v1/applications"),
    );

    const listResult = z.array(RawCoolifyApplicationSchema).safeParse(parsedJson);
    if (!listResult.success) {
      throw this.#createAndLogError(ctx, "GET", "/api/v1/applications", {
        code: "COOLIFY_UNAVAILABLE",
        message: "Coolify applications list response failed schema normalization.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    const observedAt = new Date(this.#now()).toISOString();
    const knownSecrets = collectKnownSecrets(ctx);
    return listResult.data.map((item) =>
      this.#normalizeApplication(item, observedAt, knownSecrets),
    );
  }

  public async getApplication(
    ctx: AuthorizedProviderContext,
    providerApplicationUuid: string,
  ): Promise<ProviderApplicationSnapshot> {
    const validUuid = this.#validateIdentifier(
      ctx,
      providerApplicationUuid,
      "providerApplicationUuid",
    );
    const endpointPath = `/api/v1/applications/${validUuid}`;
    const rawResponse = await this.#executeRequest(
      ctx,
      { kind: "applications.get", method: "GET", uuid: validUuid },
      "read",
    );
    const parsedJson = unwrapDataEnvelope(
      this.#parseJsonPayload(ctx, rawResponse.bodyText, false, "GET", endpointPath),
    );

    const appResult = RawCoolifyApplicationSchema.safeParse(parsedJson);
    if (!appResult.success) {
      throw this.#createAndLogError(ctx, "GET", endpointPath, {
        code: "COOLIFY_UNAVAILABLE",
        message: "Coolify application detail response failed schema normalization.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    const observedAt = new Date(this.#now()).toISOString();
    return this.#normalizeApplication(
      appResult.data,
      observedAt,
      collectKnownSecrets(ctx),
    );
  }

  public async deployApplication(
    ctx: AuthorizedProviderContext,
    providerApplicationUuid: string,
    options?: DeployApplicationOptions,
  ): Promise<ProviderOperationAccepted> {
    const validUuid = this.#validateIdentifier(
      ctx,
      providerApplicationUuid,
      "providerApplicationUuid",
    );
    const forceRebuild = options?.forceRebuild === true;
    const endpointPath = forceRebuild
      ? `/api/v1/deploy?uuid=${validUuid}&force=true`
      : `/api/v1/deploy?uuid=${validUuid}`;

    const rawResponse = await this.#executeRequest(
      ctx,
      {
        kind: "applications.deploy",
        method: "POST",
        uuid: validUuid,
        forceRebuild,
      },
      "deploy",
    );

    const parsedJson = unwrapDataEnvelope(
      this.#parseJsonPayload(ctx, rawResponse.bodyText, true, "POST", endpointPath),
    );

    const deployResult = RawCoolifyDeployResponseSchema.safeParse(parsedJson);
    if (!deployResult.success) {
      throw this.#createAndLogError(ctx, "POST", endpointPath, {
        code: "OPERATION_AMBIGUOUS",
        message:
          "Coolify deploy response did not contain an expected deployment identifier; reconciliation required.",
        retryable: false,
        ambiguousSideEffect: true,
      });
    }

    const deploymentUuid =
      "deployments" in deployResult.data
        ? deployResult.data.deployments[0]?.deployment_uuid
        : deployResult.data.deployment_uuid;

    if (!deploymentUuid || !SAFE_PROVIDER_IDENTIFIER_PATTERN.test(deploymentUuid)) {
      throw this.#createAndLogError(ctx, "POST", endpointPath, {
        code: "OPERATION_AMBIGUOUS",
        message:
          "Coolify deploy response returned an invalid deployment identifier; reconciliation required.",
        retryable: false,
        ambiguousSideEffect: true,
      });
    }

    const rawMessage =
      "deployments" in deployResult.data
        ? (deployResult.data.deployments[0]?.message ?? deployResult.data.message ?? null)
        : (deployResult.data.message ?? null);

    const knownSecrets = collectKnownSecrets(ctx);
    return {
      providerId: deploymentUuid,
      message: rawMessage ? redactSensitiveString(rawMessage, knownSecrets) : null,
      status: "deploying",
      health: "unknown",
      observedAt: new Date(this.#now()).toISOString(),
      source: "coolify",
      stale: false,
    };
  }

  public async restartApplication(
    ctx: AuthorizedProviderContext,
    providerApplicationUuid: string,
  ): Promise<ProviderOperationAccepted> {
    const validUuid = this.#validateIdentifier(
      ctx,
      providerApplicationUuid,
      "providerApplicationUuid",
    );
    const endpointPath = `/api/v1/applications/${validUuid}/restart`;

    const rawResponse = await this.#executeRequest(
      ctx,
      {
        kind: "applications.restart",
        method: "POST",
        uuid: validUuid,
      },
      "deploy",
    );

    const parsedJson = unwrapDataEnvelope(
      this.#parseJsonPayload(ctx, rawResponse.bodyText, true, "POST", endpointPath),
    );

    const deployShape = RawCoolifyDeployResponseSchema.safeParse(parsedJson);
    const knownSecrets = collectKnownSecrets(ctx);
    const observedAt = new Date(this.#now()).toISOString();

    if (deployShape.success) {
      const deploymentUuid =
        "deployments" in deployShape.data
          ? deployShape.data.deployments[0]?.deployment_uuid
          : deployShape.data.deployment_uuid;

      if (!deploymentUuid || !SAFE_PROVIDER_IDENTIFIER_PATTERN.test(deploymentUuid)) {
        throw this.#createAndLogError(ctx, "POST", endpointPath, {
          code: "OPERATION_AMBIGUOUS",
          message:
            "Coolify restart response returned an invalid deployment identifier; reconciliation required.",
          retryable: false,
          ambiguousSideEffect: true,
        });
      }

      const rawMessage =
        "deployments" in deployShape.data
          ? (deployShape.data.deployments[0]?.message ?? deployShape.data.message ?? null)
          : (deployShape.data.message ?? null);

      return {
        providerId: deploymentUuid,
        message: rawMessage ? redactSensitiveString(rawMessage, knownSecrets) : null,
        status: "deploying",
        health: "unknown",
        observedAt,
        source: "coolify",
        stale: false,
      };
    }

    const fallbackShape = RawCoolifyRestartFallbackSchema.safeParse(parsedJson);
    if (!fallbackShape.success) {
      throw this.#createAndLogError(ctx, "POST", endpointPath, {
        code: "OPERATION_AMBIGUOUS",
        message:
          "Coolify restart response could not be normalized; reconciliation required.",
        retryable: false,
        ambiguousSideEffect: true,
      });
    }

    const candidateId = fallbackShape.data.uuid ?? validUuid;
    if (!SAFE_PROVIDER_IDENTIFIER_PATTERN.test(candidateId)) {
      throw this.#createAndLogError(ctx, "POST", endpointPath, {
        code: "OPERATION_AMBIGUOUS",
        message:
          "Coolify restart response returned an unsafe identifier; reconciliation required.",
        retryable: false,
        ambiguousSideEffect: true,
      });
    }

    return {
      providerId: candidateId,
      message: redactSensitiveString(fallbackShape.data.message, knownSecrets),
      status: "deploying",
      health: "unknown",
      observedAt,
      source: "coolify",
      stale: false,
    };
  }

  public async getDeployment(
    ctx: AuthorizedProviderContext,
    providerDeploymentUuid: string,
  ): Promise<ProviderDeploymentSnapshot> {
    const validUuid = this.#validateIdentifier(
      ctx,
      providerDeploymentUuid,
      "providerDeploymentUuid",
    );
    const endpointPath = `/api/v1/deployments/${validUuid}`;

    const rawResponse = await this.#executeRequest(
      ctx,
      { kind: "deployments.get", method: "GET", uuid: validUuid },
      "read",
    );
    const parsedJson = unwrapDataEnvelope(
      this.#parseJsonPayload(ctx, rawResponse.bodyText, false, "GET", endpointPath),
    );

    const deploymentResult = RawCoolifyDeploymentSchema.safeParse(parsedJson);
    if (!deploymentResult.success) {
      throw this.#createAndLogError(ctx, "GET", endpointPath, {
        code: "COOLIFY_UNAVAILABLE",
        message: "Coolify deployment response failed schema normalization.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    const data = deploymentResult.data;
    const providerId = data.deployment_uuid ?? data.uuid ?? validUuid;
    const normalized = normalizeDeploymentState(data.status);
    const knownSecrets = collectKnownSecrets(ctx);

    const rawCommit = data.commit_sha ?? data.commit ?? null;
    return {
      providerId,
      state: normalized.state,
      commitSha: rawCommit ? redactSensitiveString(rawCommit, knownSecrets) : null,
      startedAt: data.started_at ?? data.created_at ?? null,
      finishedAt: data.finished_at ?? null,
      status: normalized.status,
      health: normalized.health,
      observedAt: new Date(this.#now()).toISOString(),
      source: "coolify",
      stale: false,
    };
  }

  public async listDatabases(
    ctx: AuthorizedProviderContext,
  ): Promise<readonly ProviderDatabaseSnapshot[]> {
    const rawResponse = await this.#executeRequest(
      ctx,
      { kind: "databases.list", method: "GET" },
      "read",
    );
    const parsedJson = unwrapDataEnvelope(
      this.#parseJsonPayload(ctx, rawResponse.bodyText, false, "GET", "/api/v1/databases"),
    );

    const listResult = z.array(RawCoolifyDatabaseSchema).safeParse(parsedJson);
    if (!listResult.success) {
      throw this.#createAndLogError(ctx, "GET", "/api/v1/databases", {
        code: "COOLIFY_UNAVAILABLE",
        message: "Coolify databases response failed schema normalization.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    const observedAt = new Date(this.#now()).toISOString();
    const knownSecrets = collectKnownSecrets(ctx);

    return listResult.data.map((rawDb) => {
      const engine = normalizeDatabaseEngine(
        rawDb.database_type,
        rawDb.type,
        rawDb.engine,
        rawDb.image,
      );
      if (!engine) {
        throw this.#createAndLogError(ctx, "GET", "/api/v1/databases", {
          code: "COOLIFY_UNAVAILABLE",
          message: `Coolify database '${redactSensitiveString(rawDb.name, knownSecrets)}' reported an unrecognized database engine.`,
          retryable: false,
          ambiguousSideEffect: false,
        });
      }

      const normalizedStatus = normalizeCoolifyStatus(rawDb.status, rawDb.health);
      const endpointInfo = extractSafeDbEndpoint(
        rawDb.internal_db_url,
        rawDb.port ?? rawDb.public_port ?? null,
      );
      const backupCaps = getDatabaseBackupCapabilities(engine);

      return {
        providerId: rawDb.uuid,
        name: redactSensitiveString(rawDb.name, knownSecrets),
        engine,
        engineVersion: redactSensitiveString(
          extractDatabaseVersion(rawDb.version, rawDb.image),
          knownSecrets,
        ),
        internalHostname: endpointInfo.internalHostname,
        port: endpointInfo.port,
        backupSupported: backupCaps.backupSupported,
        restoreSupported: backupCaps.restoreSupported,
        backupUnsupportedReason: backupCaps.backupUnsupportedReason,
        status: normalizedStatus.status,
        health: normalizedStatus.health,
        observedAt,
        source: "coolify",
        stale: false,
      };
    });
  }

  public async listServers(
    ctx: AuthorizedProviderContext,
  ): Promise<readonly ProviderServerSnapshot[]> {
    const rawResponse = await this.#executeRequest(
      ctx,
      { kind: "servers.list", method: "GET" },
      "read",
    );
    const parsedJson = unwrapDataEnvelope(
      this.#parseJsonPayload(ctx, rawResponse.bodyText, false, "GET", "/api/v1/servers"),
    );

    const listResult = z.array(RawCoolifyServerSchema).safeParse(parsedJson);
    if (!listResult.success) {
      throw this.#createAndLogError(ctx, "GET", "/api/v1/servers", {
        code: "COOLIFY_UNAVAILABLE",
        message: "Coolify servers list response failed schema normalization.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    const nowMs = this.#now();
    const observedAt = new Date(nowMs).toISOString();
    const knownSecrets = collectKnownSecrets(ctx);

    return listResult.data.map((server) =>
      this.#normalizeServer(server, nowMs, observedAt, knownSecrets),
    );
  }

  public async getServer(
    ctx: AuthorizedProviderContext,
    providerServerUuid: string,
  ): Promise<ProviderServerSnapshot> {
    const validUuid = this.#validateIdentifier(
      ctx,
      providerServerUuid,
      "providerServerUuid",
    );
    const endpointPath = `/api/v1/servers/${validUuid}`;
    const rawResponse = await this.#executeRequest(
      ctx,
      { kind: "servers.get", method: "GET", uuid: validUuid },
      "read",
    );
    const parsedJson = unwrapDataEnvelope(
      this.#parseJsonPayload(ctx, rawResponse.bodyText, false, "GET", endpointPath),
    );

    const serverResult = RawCoolifyServerSchema.safeParse(parsedJson);
    if (!serverResult.success) {
      throw this.#createAndLogError(ctx, "GET", endpointPath, {
        code: "COOLIFY_UNAVAILABLE",
        message: "Coolify server detail response failed schema normalization.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    const nowMs = this.#now();
    const observedAt = new Date(nowMs).toISOString();
    return this.#normalizeServer(
      serverResult.data,
      nowMs,
      observedAt,
      collectKnownSecrets(ctx),
    );
  }

  public async triggerDatabaseRestore(
    ctx: AuthorizedProviderContext,
    input: TriggerDatabaseRestoreInput,
  ): Promise<ProviderOperationAccepted>;
  public async triggerDatabaseRestore(
    ctx: AuthorizedProviderContext,
    providerDatabaseUuid: string,
    engine: DatabaseEngine,
    backupId?: string,
  ): Promise<ProviderOperationAccepted>;
  public async triggerDatabaseRestore(
    ctx: AuthorizedProviderContext,
    inputOrUuid: TriggerDatabaseRestoreInput | string,
    maybeEngine?: DatabaseEngine,
    maybeBackupId?: string,
  ): Promise<ProviderOperationAccepted> {
    const resolvedInput: TriggerDatabaseRestoreInput =
      typeof inputOrUuid === "string"
        ? {
            providerDatabaseUuid: inputOrUuid,
            engine: maybeEngine ?? ("redis" as DatabaseEngine),
            backupId: maybeBackupId,
          }
        : inputOrUuid;

    const validUuid = this.#validateIdentifier(
      ctx,
      resolvedInput.providerDatabaseUuid,
      "providerDatabaseUuid",
    );
    if (resolvedInput.backupId !== undefined) {
      this.#validateIdentifier(ctx, resolvedInput.backupId, "backupId");
    }

    const engineBackupCaps = getDatabaseBackupCapabilities(resolvedInput.engine);
    const adapterEngineCap =
      this.capabilities.databaseBackupByEngine[resolvedInput.engine];

    if (!engineBackupCaps.restoreSupported || !adapterEngineCap.supported) {
      throw this.#createAndLogError(
        ctx,
        "POST",
        `/api/v1/databases/${validUuid}/restore`,
        {
          code: "NOT_SUPPORTED",
          message:
            engineBackupCaps.backupUnsupportedReason ??
            adapterEngineCap.reason ??
            `Automated database restore is not supported for engine '${resolvedInput.engine}'.`,
          retryable: false,
          ambiguousSideEffect: false,
        },
      );
    }

    if (!ctx.tokens.write || ctx.tokens.write.trim().length === 0) {
      throw this.#createAndLogError(
        ctx,
        "POST",
        `/api/v1/databases/${validUuid}/restore`,
        {
          code: "PERMISSION_DENIED",
          message:
            "Provider connection does not possess a write-scoped token required for database restore.",
          retryable: false,
          ambiguousSideEffect: false,
        },
      );
    }

    throw this.#createAndLogError(ctx, "POST", `/api/v1/databases/${validUuid}/restore`, {
      code: "NOT_SUPPORTED",
      message:
        "Automated database restore execution is not exposed by Coolify v4 REST API.",
      retryable: false,
      ambiguousSideEffect: false,
    });
  }

  #normalizeApplication(
    raw: z.infer<typeof RawCoolifyApplicationSchema>,
    observedAt: string,
    knownSecrets: readonly string[],
  ): ProviderApplicationSnapshot {
    const { primaryFqdn, domains } = parseDomains(raw.fqdn);
    const normalizedStatus = normalizeCoolifyStatus(
      raw.status,
      raw.health ?? raw.health_status,
    );

    const rawRepo = raw.git_repository ?? raw.repository_url ?? null;
    const rawBranch = raw.git_branch ?? raw.branch ?? null;
    const rawBuildPack = raw.build_pack?.trim() || "nixpacks";

    let environmentName: string | null = null;
    if (typeof raw.environment_name === "string" && raw.environment_name.trim().length > 0) {
      environmentName = raw.environment_name.trim();
    } else if (typeof raw.environment === "string" && raw.environment.trim().length > 0) {
      environmentName = raw.environment.trim();
    } else if (
      raw.environment &&
      typeof raw.environment === "object" &&
      typeof raw.environment.name === "string" &&
      raw.environment.name.trim().length > 0
    ) {
      environmentName = raw.environment.name.trim();
    }

    return {
      providerId: raw.uuid,
      name: redactSensitiveString(raw.name, knownSecrets),
      fqdn: primaryFqdn ? redactSensitiveString(primaryFqdn, knownSecrets) : null,
      domains: domains.map((d) => redactSensitiveString(d, knownSecrets)),
      repositoryUrl: rawRepo ? redactSensitiveString(rawRepo, knownSecrets) : null,
      branch: rawBranch ? redactSensitiveString(rawBranch, knownSecrets) : null,
      buildPack: redactSensitiveString(rawBuildPack, knownSecrets),
      environment: environmentName
        ? redactSensitiveString(environmentName, knownSecrets)
        : null,
      status: normalizedStatus.status,
      health: normalizedStatus.health,
      observedAt,
      source: "coolify",
      stale: false,
    };
  }

  #normalizeServer(
    raw: z.infer<typeof RawCoolifyServerSchema>,
    nowMs: number,
    observedAt: string,
    knownSecrets: readonly string[],
  ): ProviderServerSnapshot {
    const heartbeatRaw =
      raw.sentinel_updated_at ??
      raw.last_heartbeat_at ??
      raw.settings?.sentinel_updated_at ??
      null;

    const sentinelEnabled =
      raw.sentinel_enabled === true || raw.settings?.is_sentinel_enabled === true;

    let stale = false;
    let normalizedHeartbeatIso: string | null = null;

    if (heartbeatRaw !== null && heartbeatRaw.trim().length > 0) {
      const parsedHeartbeatMs = Date.parse(heartbeatRaw);
      if (Number.isNaN(parsedHeartbeatMs)) {
        stale = true;
      } else {
        normalizedHeartbeatIso = new Date(parsedHeartbeatMs).toISOString();
        if (nowMs - parsedHeartbeatMs > this.#staleAfterMs) {
          stale = true;
        }
      }
    } else if (sentinelEnabled) {
      stale = true;
    }

    let status: ObservedResourceStatus;
    let health: ResourceHealthStatus;

    if (stale) {
      status = "unknown";
      health = "unknown";
    } else {
      const reachable = raw.is_reachable ?? raw.settings?.is_reachable ?? null;
      const usable = raw.is_usable ?? raw.settings?.is_usable ?? null;

      if (reachable === false) {
        status = "failed";
        health = "unhealthy";
      } else if (usable === false) {
        status = "degraded";
        health = "unhealthy";
      } else if (raw.status && raw.status.trim().length > 0) {
        const normalized = normalizeCoolifyStatus(raw.status, raw.health);
        status = normalized.status;
        health =
          normalized.status === "running" &&
          normalized.health === "unknown" &&
          (reachable === true || normalizedHeartbeatIso !== null)
            ? "healthy"
            : normalized.health;
      } else if (reachable === true || normalizedHeartbeatIso !== null) {
        status = "running";
        health = "healthy";
      } else {
        status = "unknown";
        health = "unknown";
      }
    }

    return {
      providerId: raw.uuid,
      name: redactSensitiveString(raw.name, knownSecrets),
      ip: raw.ip ? redactSensitiveString(raw.ip, knownSecrets) : null,
      port: raw.port ?? null,
      region: raw.region ? redactSensitiveString(raw.region, knownSecrets) : null,
      lastHeartbeatAt: normalizedHeartbeatIso,
      status,
      health,
      observedAt,
      source: "coolify",
      stale,
    };
  }

  #validateIdentifier(
    ctx: AuthorizedProviderContext,
    rawIdentifier: string,
    fieldName: string,
  ): string {
    if (!SAFE_PROVIDER_IDENTIFIER_PATTERN.test(rawIdentifier)) {
      throw this.#createAndLogError(ctx, "GET", `/api/v1/[invalid:${fieldName}]`, {
        code: "VALIDATION_ERROR",
        message: `Invalid Coolify identifier provided for '${fieldName}'.`,
        retryable: false,
        ambiguousSideEffect: false,
      });
    }
    return rawIdentifier;
  }

  #resolveToken(
    ctx: AuthorizedProviderContext,
    scope: "read" | "deploy" | "write",
    method: "GET" | "POST",
    endpointPath: string,
  ): string {
    const candidate = ctx.tokens[scope];
    if (typeof candidate !== "string" || candidate.trim().length === 0) {
      throw this.#createAndLogError(ctx, method, endpointPath, {
        code: "PERMISSION_DENIED",
        message: `Provider connection lacks required '${scope}' token scope.`,
        retryable: false,
        ambiguousSideEffect: false,
      });
    }
    return candidate.trim();
  }

  #buildAllowlistedUrl(
    ctx: AuthorizedProviderContext,
    endpoint: AllowlistedEndpoint,
  ): { readonly url: URL; readonly endpointPath: string } {
    const endpointPath = this.#formatEndpointPath(endpoint);
    const rawBaseUrl = ctx.baseUrl;

    if (
      typeof rawBaseUrl !== "string" ||
      rawBaseUrl.trim().length === 0 ||
      hasUnsafeUrlCharacters(rawBaseUrl) ||
      rawBaseUrl.includes("..")
    ) {
      throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
        code: "VALIDATION_ERROR",
        message: "Provider baseUrl is malformed or contains unsafe characters.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    let parsedBase: URL;
    try {
      parsedBase = new URL(rawBaseUrl);
    } catch {
      throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
        code: "VALIDATION_ERROR",
        message: "Provider baseUrl is not a valid URL.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    if (parsedBase.username !== "" || parsedBase.password !== "") {
      throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
        code: "VALIDATION_ERROR",
        message: "Provider baseUrl must not include embedded credentials.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    if (parsedBase.search !== "" || parsedBase.hash !== "") {
      throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
        code: "VALIDATION_ERROR",
        message: "Provider baseUrl must not include query parameters or hash fragments.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    const rawHostname = parsedBase.hostname.toLowerCase();
    if (rawHostname.length === 0 || rawHostname.endsWith(".")) {
      throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
        code: "VALIDATION_ERROR",
        message: "Provider baseUrl hostname is invalid.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    const normalizedHost = normalizeHostname(rawHostname);

    if (isForbiddenMetadataHost(normalizedHost)) {
      throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
        code: "VALIDATION_ERROR",
        message: "Provider baseUrl targets a forbidden cloud metadata or link-local address.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    if (!this.#allowedHosts.has(normalizedHost)) {
      throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
        code: "VALIDATION_ERROR",
        message: `Provider host '${normalizedHost}' is not in the configured allowedHosts list.`,
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    if (parsedBase.protocol === "http:") {
      if (!this.#allowInsecureLocalhost || !LOCALHOST_HOSTNAMES.has(normalizedHost)) {
        throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
          code: "VALIDATION_ERROR",
          message:
            "Provider baseUrl must use HTTPS unless allowInsecureLocalhost is enabled for localhost.",
          retryable: false,
          ambiguousSideEffect: false,
        });
      }
    } else if (parsedBase.protocol !== "https:") {
      throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
        code: "VALIDATION_ERROR",
        message: "Provider baseUrl protocol must be HTTPS.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    const trimmedBasePath = parsedBase.pathname.replace(/\/+$/, "");
    if (trimmedBasePath !== "" && trimmedBasePath !== "/api/v1") {
      throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
        code: "VALIDATION_ERROR",
        message: "Provider baseUrl path must be '/' or '/api/v1'.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    const targetUrl = new URL(parsedBase.origin);
    switch (endpoint.kind) {
      case "version":
        targetUrl.pathname = "/api/v1/version";
        break;
      case "applications.list":
        targetUrl.pathname = "/api/v1/applications";
        break;
      case "applications.get":
        targetUrl.pathname = `/api/v1/applications/${encodeURIComponent(endpoint.uuid)}`;
        break;
      case "applications.deploy":
        targetUrl.pathname = "/api/v1/deploy";
        targetUrl.searchParams.set("uuid", endpoint.uuid);
        if (endpoint.forceRebuild) {
          targetUrl.searchParams.set("force", "true");
        }
        break;
      case "applications.restart":
        targetUrl.pathname = `/api/v1/applications/${encodeURIComponent(endpoint.uuid)}/restart`;
        break;
      case "deployments.get":
        targetUrl.pathname = `/api/v1/deployments/${encodeURIComponent(endpoint.uuid)}`;
        break;
      case "databases.list":
        targetUrl.pathname = "/api/v1/databases";
        break;
      case "servers.list":
        targetUrl.pathname = "/api/v1/servers";
        break;
      case "servers.get":
        targetUrl.pathname = `/api/v1/servers/${encodeURIComponent(endpoint.uuid)}`;
        break;
    }

    return { url: targetUrl, endpointPath };
  }

  #formatEndpointPath(endpoint: AllowlistedEndpoint): string {
    switch (endpoint.kind) {
      case "version":
        return "/api/v1/version";
      case "applications.list":
        return "/api/v1/applications";
      case "applications.get":
        return `/api/v1/applications/${endpoint.uuid}`;
      case "applications.deploy":
        return endpoint.forceRebuild
          ? `/api/v1/deploy?uuid=${endpoint.uuid}&force=true`
          : `/api/v1/deploy?uuid=${endpoint.uuid}`;
      case "applications.restart":
        return `/api/v1/applications/${endpoint.uuid}/restart`;
      case "deployments.get":
        return `/api/v1/deployments/${endpoint.uuid}`;
      case "databases.list":
        return "/api/v1/databases";
      case "servers.list":
        return "/api/v1/servers";
      case "servers.get":
        return `/api/v1/servers/${endpoint.uuid}`;
    }
  }

  async #executeRequest(
    ctx: AuthorizedProviderContext,
    endpoint: AllowlistedEndpoint,
    tokenScope: "read" | "deploy" | "write",
  ): Promise<{ readonly bodyText: string; readonly contentType: string }> {
    const endpointPath = this.#formatEndpointPath(endpoint);
    if (!ctx.connectionId || ctx.connectionId.trim().length === 0) {
      throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
        code: "VALIDATION_ERROR",
        message: "AuthorizedProviderContext.connectionId is required.",
        retryable: false,
        ambiguousSideEffect: false,
      });
    }

    const { url } = this.#buildAllowlistedUrl(ctx, endpoint);
    const token = this.#resolveToken(ctx, tokenScope, endpoint.method, endpointPath);
    const knownSecrets = collectKnownSecrets(ctx);

    this.#enforceActiveCooldown(ctx, endpoint.method, endpointPath);

    const isMutating = endpoint.method === "POST";
    const maxRetries = isMutating ? 0 : this.#maxGetRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      let didTimeout = false;
      const timeoutHandle = setTimeout(() => {
        didTimeout = true;
        controller.abort(new Error("Coolify request timed out."));
      }, this.#timeoutMs);

      try {
        const response = await this.#fetch(url.toString(), {
          method: endpoint.method,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "X-Request-Id": sanitizeHeaderToken(ctx.requestId, "unknown-request"),
            "User-Agent": "hosting-panel-coolify-adapter/0.1.0",
          },
        });

        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
            code: "COOLIFY_UNAVAILABLE",
            httpStatus: response.status,
            message: `Coolify returned HTTP ${String(response.status)} redirect; redirects are blocked to protect Authorization credentials.`,
            retryable: false,
            ambiguousSideEffect: false,
          });
        }

        if (response.status === 429) {
          const retryAfterMs = this.#parseRetryAfterMs(response.headers);
          await response.body?.cancel().catch(() => undefined);
          this.#cooldownUntilByConnection.set(
            ctx.connectionId,
            this.#now() + retryAfterMs,
          );
          throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
            code: "PROVIDER_RATE_LIMIT",
            httpStatus: 429,
            retryAfterMs,
            retryable: true,
            ambiguousSideEffect: false,
            message: `Coolify rate limit exceeded; cooling down connection for ${String(retryAfterMs)}ms.`,
          });
        }

        if (response.status < 200 || response.status >= 300) {
          const safeDetail = await this.#readSafeErrorSummary(response, knownSecrets);

          if (
            !isMutating &&
            attempt < maxRetries &&
            (response.status === 502 ||
              response.status === 503 ||
              response.status === 504)
          ) {
            clearTimeout(timeoutHandle);
            await sleepMs(this.#computeRetryJitterMs());
            continue;
          }

          throw this.#mapHttpStatusError(
            ctx,
            endpoint.method,
            endpointPath,
            response.status,
            isMutating,
            safeDetail,
          );
        }

        const bodyText = await readBoundedResponseBytes(
          response,
          this.#maxResponseBytes,
        );
        const contentType = response.headers.get("content-type") ?? "";
        return { bodyText, contentType };
      } catch (error: unknown) {
        if (error instanceof CoolifyAdapterError) {
          throw error;
        }

        if (error instanceof ResponseTooLargeError) {
          throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
            code: isMutating ? "OPERATION_AMBIGUOUS" : "COOLIFY_UNAVAILABLE",
            message: error.message,
            retryable: false,
            ambiguousSideEffect: isMutating,
          });
        }

        const isAbortOrTimeout =
          didTimeout ||
          (error instanceof Error &&
            (error.name === "AbortError" || error.name === "TimeoutError"));

        if (isMutating) {
          throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
            code: "OPERATION_AMBIGUOUS",
            message: isAbortOrTimeout
              ? "Coolify mutation request timed out; provider state is ambiguous and must be reconciled."
              : "Network transport failed during Coolify mutation; provider state is ambiguous and must be reconciled.",
            retryable: false,
            ambiguousSideEffect: true,
          });
        }

        if (attempt < maxRetries) {
          clearTimeout(timeoutHandle);
          await sleepMs(this.#computeRetryJitterMs());
          continue;
        }

        throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
          code: "COOLIFY_UNAVAILABLE",
          message: isAbortOrTimeout
            ? "Timed out waiting for Coolify provider response."
            : "Failed to reach Coolify provider over network.",
          retryable: true,
          ambiguousSideEffect: false,
        });
      } finally {
        clearTimeout(timeoutHandle);
      }
    }

    throw this.#createAndLogError(ctx, endpoint.method, endpointPath, {
      code: "COOLIFY_UNAVAILABLE",
      message: "Coolify request exhausted retry budget.",
      retryable: true,
      ambiguousSideEffect: false,
    });
  }

  #enforceActiveCooldown(
    ctx: AuthorizedProviderContext,
    method: "GET" | "POST",
    endpointPath: string,
  ): void {
    const cooldownUntil = this.#cooldownUntilByConnection.get(ctx.connectionId);
    if (cooldownUntil === undefined) {
      return;
    }

    const remainingMs = cooldownUntil - this.#now();
    if (remainingMs <= 0) {
      this.#cooldownUntilByConnection.delete(ctx.connectionId);
      return;
    }

    throw this.#createAndLogError(ctx, method, endpointPath, {
      code: "PROVIDER_RATE_LIMIT",
      httpStatus: 429,
      retryAfterMs: remainingMs,
      retryable: true,
      ambiguousSideEffect: false,
      message: `Coolify connection is in rate-limit cooldown for another ${String(remainingMs)}ms.`,
    });
  }

  #parseRetryAfterMs(headers: Headers): number {
    const nowMs = this.#now();
    const retryAfterHeader = headers.get("retry-after");

    if (retryAfterHeader !== null && retryAfterHeader.trim().length > 0) {
      const trimmed = retryAfterHeader.trim();
      if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
        const seconds = Number.parseFloat(trimmed);
        if (Number.isFinite(seconds) && seconds > 0) {
          return Math.min(this.#maxCooldownMs, Math.max(1, Math.ceil(seconds * 1_000)));
        }
      } else {
        const parsedDateMs = Date.parse(trimmed);
        if (!Number.isNaN(parsedDateMs)) {
          const deltaMs = parsedDateMs - nowMs;
          if (deltaMs > 0) {
            return Math.min(this.#maxCooldownMs, deltaMs);
          }
        }
      }
    }

    const rateLimitReset = headers.get("x-ratelimit-reset");
    if (rateLimitReset !== null && /^\d+(?:\.\d+)?$/.test(rateLimitReset.trim())) {
      const rawValue = Number.parseFloat(rateLimitReset.trim());
      if (Number.isFinite(rawValue) && rawValue > 0) {
        let deltaMs: number;
        if (rawValue >= 1_000_000_000_000) {
          deltaMs = Math.ceil(rawValue - nowMs);
        } else if (rawValue >= 1_000_000_000) {
          deltaMs = Math.ceil(rawValue * 1_000 - nowMs);
        } else {
          deltaMs = Math.ceil(rawValue * 1_000);
        }
        if (deltaMs > 0) {
          return Math.min(this.#maxCooldownMs, deltaMs);
        }
      }
    }

    return this.#defaultCooldownMs;
  }

  async #readSafeErrorSummary(
    response: Response,
    knownSecrets: readonly string[],
  ): Promise<string | null> {
    try {
      const rawBody = await readBoundedResponseBytes(
        response,
        Math.min(this.#maxResponseBytes, MAX_ERROR_BODY_BYTES),
      );
      if (!rawBody || rawBody.trim().length === 0) {
        return null;
      }

      const parsed: unknown = JSON.parse(rawBody);
      if (parsed !== null && typeof parsed === "object" && "message" in parsed) {
        const rawMessage = (parsed as { readonly message?: unknown }).message;
        if (typeof rawMessage === "string" && rawMessage.trim().length > 0) {
          const sanitized = redactSensitiveString(rawMessage.trim(), knownSecrets);
          return sanitized.slice(0, 240);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  #mapHttpStatusError(
    ctx: AuthorizedProviderContext,
    method: "GET" | "POST",
    endpointPath: string,
    status: number,
    isMutating: boolean,
    safeDetail: string | null,
  ): CoolifyAdapterError {
    const suffix = safeDetail ? `: ${safeDetail}` : ".";

    if (status === 401) {
      return this.#createAndLogError(ctx, method, endpointPath, {
        code: "UNAUTHENTICATED",
        httpStatus: 401,
        retryable: false,
        ambiguousSideEffect: false,
        message: `Coolify rejected provider credentials (HTTP 401)${suffix}`,
      });
    }

    if (status === 403) {
      return this.#createAndLogError(ctx, method, endpointPath, {
        code: "PERMISSION_DENIED",
        httpStatus: 403,
        retryable: false,
        ambiguousSideEffect: false,
        message: `Coolify denied team or token permission (HTTP 403)${suffix}`,
      });
    }

    if (status === 404) {
      return this.#createAndLogError(ctx, method, endpointPath, {
        code: "NOT_FOUND",
        httpStatus: 404,
        retryable: false,
        ambiguousSideEffect: false,
        message: `Requested Coolify resource was not found (HTTP 404)${suffix}`,
      });
    }

    if (status === 409) {
      return this.#createAndLogError(ctx, method, endpointPath, {
        code: "RESOURCE_LOCKED",
        httpStatus: 409,
        retryable: true,
        ambiguousSideEffect: false,
        message: `Coolify resource is currently busy or locked by another deployment (HTTP 409)${suffix}`,
      });
    }

    if (status === 400 || status === 422) {
      return this.#createAndLogError(ctx, method, endpointPath, {
        code: "VALIDATION_ERROR",
        httpStatus: status,
        retryable: false,
        ambiguousSideEffect: false,
        message: `Coolify rejected request validation (HTTP ${String(status)})${suffix}`,
      });
    }

    if (status === 408 || status >= 500) {
      if (isMutating) {
        return this.#createAndLogError(ctx, method, endpointPath, {
          code: "OPERATION_AMBIGUOUS",
          httpStatus: status,
          retryable: false,
          ambiguousSideEffect: true,
          message: `Coolify returned HTTP ${String(status)} during mutation; side-effect outcome is ambiguous${suffix}`,
        });
      }

      return this.#createAndLogError(ctx, method, endpointPath, {
        code: "COOLIFY_UNAVAILABLE",
        httpStatus: status,
        retryable: true,
        ambiguousSideEffect: false,
        message: `Coolify upstream service unavailable (HTTP ${String(status)})${suffix}`,
      });
    }

    return this.#createAndLogError(ctx, method, endpointPath, {
      code: "VALIDATION_ERROR",
      httpStatus: status,
      retryable: false,
      ambiguousSideEffect: false,
      message: `Coolify rejected request with HTTP ${String(status)}${suffix}`,
    });
  }

  #parseJsonPayload(
    ctx: AuthorizedProviderContext,
    bodyText: string,
    isMutating: boolean,
    method: "GET" | "POST",
    endpointPath: string,
  ): unknown {
    try {
      return JSON.parse(bodyText) as unknown;
    } catch {
      throw this.#createAndLogError(ctx, method, endpointPath, {
        code: isMutating ? "OPERATION_AMBIGUOUS" : "COOLIFY_UNAVAILABLE",
        message: isMutating
          ? "Coolify returned malformed JSON for mutation response; reconciliation required."
          : "Coolify returned malformed JSON response.",
        retryable: false,
        ambiguousSideEffect: isMutating,
      });
    }
  }

  #computeRetryJitterMs(): number {
    if (this.#retryMaxDelayMs <= this.#retryBaseDelayMs) {
      return this.#retryBaseDelayMs;
    }
    const span = this.#retryMaxDelayMs - this.#retryBaseDelayMs;
    return Math.floor(this.#retryBaseDelayMs + Math.random() * span);
  }

  #createAndLogError(
    ctx: AuthorizedProviderContext,
    method: "GET" | "POST",
    endpointPath: string,
    params: {
      readonly code: ErrorCode;
      readonly message: string;
      readonly httpStatus?: number;
      readonly retryable?: boolean;
      readonly retryAfterMs?: number;
      readonly ambiguousSideEffect?: boolean;
    },
  ): CoolifyAdapterError {
    const knownSecrets = collectKnownSecrets(ctx);
    const error = new CoolifyAdapterError({
      ...params,
      knownSecrets,
    });

    if (this.#logger) {
      const rawEntry: CoolifyAdapterLogEntry = {
        level:
          error.code === "PROVIDER_RATE_LIMIT" || error.code === "RESOURCE_LOCKED"
            ? "warn"
            : "error",
        event: "coolify_adapter.request_failed",
        connectionId: redactSensitiveString(ctx.connectionId, knownSecrets),
        requestId: redactSensitiveString(ctx.requestId, knownSecrets),
        method,
        endpoint: redactSensitiveString(endpointPath, knownSecrets),
        code: error.code,
        httpStatus: error.httpStatus,
        retryAfterMs: error.retryAfterMs,
        ambiguousSideEffect: error.ambiguousSideEffect,
        message: error.message,
      };
      this.#logger(
        redactSensitiveValue(rawEntry, knownSecrets) as CoolifyAdapterLogEntry,
      );
    }

    return error;
  }
}
