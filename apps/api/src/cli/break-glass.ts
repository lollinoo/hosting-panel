import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { redactSensitiveString } from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  createDatabaseClient,
  eq,
  membershipRoles,
  memberships,
  roles,
  unlockOperationBreakGlassTransactional,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { OidcService, type IssuedJwtResult } from "../auth/oidc.service.js";
import { ControlPlaneError } from "../common/control-plane.error.js";

export const MAX_BREAK_GLASS_TOKEN_TTL_SECONDS = 300;
export const DEFAULT_BREAK_GLASS_USER_ID = "usr_infra";
export const DEFAULT_BREAKGLASS_KEY_FILE = "/etc/hosting-panel/breakglass-jwt.key";

export function parseBreakglassSigningKey(
  raw: string | Buffer | Uint8Array,
): Uint8Array {
  let bytes: Buffer;
  if (Buffer.isBuffer(raw)) {
    bytes = Buffer.from(raw);
  } else if (raw instanceof Uint8Array) {
    bytes = Buffer.from(raw);
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^[0-9a-fA-F]{64,}$/.test(trimmed) && trimmed.length % 2 === 0) {
      bytes = Buffer.from(trimmed, "hex");
    } else {
      bytes = Buffer.from(trimmed, "utf8");
    }
  } else {
    throw new Error("Break-glass signing key must be a non-empty string or byte buffer.");
  }

  if (bytes.byteLength < 32) {
    throw new Error(
      "Break-glass JWT signing key must be at least 32 bytes (HP_BREAKGLASS_KEY or HP_BREAKGLASS_KEY_FILE).",
    );
  }

  return new Uint8Array(bytes);
}

export async function resolveRequiredBreakglassSigningKey(): Promise<Uint8Array> {
  const inlineKey = process.env["HP_BREAKGLASS_KEY"]?.trim();
  if (inlineKey && inlineKey.length > 0) {
    return parseBreakglassSigningKey(inlineKey);
  }

  const keyFile =
    process.env["HP_BREAKGLASS_KEY_FILE"]?.trim() || DEFAULT_BREAKGLASS_KEY_FILE;
  const content = await readFile(keyFile, "utf8");
  return parseBreakglassSigningKey(content);
}

export interface RunBreakGlassUnlockInput {
  readonly dbClient: DatabaseClient;
  readonly operationId: string;
  readonly reason: string;
  readonly actorId?: string | null;
}

export interface IssueBreakGlassEmergencyTokenInput {
  readonly dbClient: DatabaseClient;
  readonly oidcService: OidcService;
  readonly reason: string;
  readonly ttlSeconds?: number;
  readonly userId?: string;
}

export interface BreakGlassEmergencyTokenResult {
  readonly token: IssuedJwtResult;
  readonly auditEventId: string;
  readonly userId: string;
  readonly ttlSeconds: number;
}

export async function runBreakGlassUnlock(input: RunBreakGlassUnlockInput) {
  return unlockOperationBreakGlassTransactional(input.dbClient.db, {
    operationId: input.operationId,
    reason: input.reason,
    actorId: input.actorId ?? null,
  });
}

export async function issueBreakGlassEmergencyToken(
  input: IssueBreakGlassEmergencyTokenInput,
): Promise<BreakGlassEmergencyTokenResult> {
  const trimmedReason = input.reason?.trim() ?? "";
  if (trimmedReason.length === 0) {
    throw new ControlPlaneError(
      "VALIDATION_ERROR",
      "Break-glass emergency token issuance requires a mandatory non-empty reason.",
    );
  }

  const requestedTtl = input.ttlSeconds ?? MAX_BREAK_GLASS_TOKEN_TTL_SECONDS;
  if (!Number.isFinite(requestedTtl) || requestedTtl <= 0) {
    throw new ControlPlaneError(
      "VALIDATION_ERROR",
      "Break-glass emergency token ttlSeconds must be a positive number.",
    );
  }

  const clampedTtlSeconds = Math.max(
    1,
    Math.min(MAX_BREAK_GLASS_TOKEN_TTL_SECONDS, Math.floor(requestedTtl)),
  );

  const targetUserId = input.userId?.trim() || DEFAULT_BREAK_GLASS_USER_ID;
  const [user] = await input.dbClient.db
    .select()
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);

  if (!user) {
    throw new ControlPlaneError(
      "NOT_FOUND",
      `Break-glass principal '${targetUserId}' not found.`,
    );
  }

  const sanitizedReason = redactSensitiveString(trimmedReason);

  if (user.userStatus !== "active") {
    await appendAuditEvent(input.dbClient.db, {
      actorId: null,
      actorType: "system",
      organizationId: null,
      action: "breakglass.token.denied",
      targetType: "user",
      targetId: user.id,
      details: {
        userId: user.id,
        email: user.email,
        userStatus: user.userStatus,
        reason: sanitizedReason,
      },
    });
    throw new ControlPlaneError(
      "PERMISSION_DENIED",
      `Break-glass principal '${user.id}' is not active.`,
    );
  }

  const isSeededInfraAdmin =
    user.id === "usr_infra" || user.email === "infra@hcp.local";
  let hasInfraRoleInDb = false;
  if (!isSeededInfraAdmin) {
    const infraRows = await input.dbClient.db
      .select({ roleName: roles.name })
      .from(memberships)
      .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
      .where(
        and(
          eq(memberships.userId, user.id),
          eq(memberships.status, "active"),
          eq(roles.name, "infrastructure_admin"),
        ),
      )
      .limit(1);
    hasInfraRoleInDb = infraRows.length > 0;
  }

  if (!isSeededInfraAdmin && !hasInfraRoleInDb) {
    await appendAuditEvent(input.dbClient.db, {
      actorId: null,
      actorType: "system",
      organizationId: null,
      action: "breakglass.token.denied",
      targetType: "user",
      targetId: user.id,
      details: {
        userId: user.id,
        email: user.email,
        reason: sanitizedReason,
      },
    });
    throw new ControlPlaneError(
      "PERMISSION_DENIED",
      `Break-glass emergency tokens may only be issued for active infrastructure_admin principals ('${user.id}' denied).`,
    );
  }

  const token = await input.oidcService.issueBreakGlassToken({
    subject: user.id,
    email: user.email,
    displayName: user.name,
    expiresInSeconds: clampedTtlSeconds,
  });

  const auditEvent = await appendAuditEvent(input.dbClient.db, {
    actorId: null,
    actorType: "system",
    organizationId: null,
    action: "breakglass.token.issued",
    targetType: "jwt",
    targetId: token.jti,
    details: {
      userId: user.id,
      email: user.email,
      ttlSeconds: clampedTtlSeconds,
      expiresAt: token.expiresAt,
      reason: sanitizedReason,
    },
  });

  return {
    token,
    auditEventId: auditEvent!.id,
    userId: user.id,
    ttlSeconds: clampedTtlSeconds,
  };
}

function parseCliFlag(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) {
    return undefined;
  }
  return args[idx + 1];
}

async function runCli(argv: readonly string[]): Promise<void> {
  const command = argv[0];
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL environment variable is required for break-glass CLI.");
  }

  const dbClient = createDatabaseClient({
    mode: "postgres",
    connectionString: databaseUrl.trim(),
  });

  try {
    if (command === "unlock") {
      const operationId = parseCliFlag(argv, "--operation-id") ?? "";
      const reason = parseCliFlag(argv, "--reason") ?? "";
      const result = await runBreakGlassUnlock({
        dbClient,
        operationId,
        reason,
      });
      process.stdout.write(
        `${JSON.stringify({
          operationId: result.operation.id,
          status: result.operation.status,
          errorCode: result.operation.errorCode,
          auditEventId: result.auditEvent.id,
        })}\n`,
      );
      return;
    }

    if (command === "emergency-token") {
      const reason = parseCliFlag(argv, "--reason") ?? "";
      const rawTtl = parseCliFlag(argv, "--ttl");
      const userId = parseCliFlag(argv, "--user-id");
      const ttlSeconds = rawTtl !== undefined ? Number.parseInt(rawTtl, 10) : undefined;

      const breakglassSigningKey = await resolveRequiredBreakglassSigningKey();
      const oidcService = new OidcService({
        oidcIssuer: process.env["OIDC_ISSUER"] ?? "https://auth.hcp.local",
        oidcAudience: process.env["OIDC_AUDIENCE"] ?? "hosting-panel-api",
        enableDevOidc: false,
        runtimeBackend: "disabled",
        secretsMasterKey: Buffer.alloc(32, 0),
        breakglassSigningKey,
        autoProcessOutbox: false,
      });
      await oidcService.onModuleInit();

      const issued = await issueBreakGlassEmergencyToken({
        dbClient,
        oidcService,
        reason,
        ttlSeconds,
        userId,
      });

      process.stdout.write(
        `${JSON.stringify({
          accessToken: issued.token.accessToken,
          jti: issued.token.jti,
          expiresIn: issued.ttlSeconds,
          expiresAt: issued.token.expiresAt,
          auditEventId: issued.auditEventId,
        })}\n`,
      );
      return;
    }

    throw new Error(
      "Usage: break-glass <unlock --operation-id <id> --reason <text> | emergency-token --reason <text> [--ttl 300]>",
    );
  } finally {
    await dbClient.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${redactSensitiveString(msg)}\n`);
    process.exitCode = 1;
  });
}
