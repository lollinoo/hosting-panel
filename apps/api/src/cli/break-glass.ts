import { pathToFileURL } from "node:url";
import { redactSensitiveString } from "@hosting-panel/contracts";
import {
  appendAuditEvent,
  createDatabaseClient,
  eq,
  unlockOperationBreakGlassTransactional,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { OidcService, type IssuedJwtResult } from "../auth/oidc.service.js";
import { ControlPlaneError } from "../common/control-plane.error.js";

export const MAX_BREAK_GLASS_TOKEN_TTL_SECONDS = 300;
export const DEFAULT_BREAK_GLASS_USER_ID = "usr_infra";

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

  const token = await input.oidcService.issueToken({
    subject: user.id,
    email: user.email,
    displayName: user.name,
    expiresInSeconds: clampedTtlSeconds,
  });

  const sanitizedReason = redactSensitiveString(trimmedReason);
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

      const oidcService = new OidcService({
        oidcIssuer: process.env["OIDC_ISSUER"] ?? "https://auth.hcp.local",
        oidcAudience: process.env["OIDC_AUDIENCE"] ?? "hosting-panel-api",
        enableDevOidc: false,
        runtimeBackend: "disabled",
        secretsMasterKey: Buffer.alloc(32, 0),
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
