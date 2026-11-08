import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { LoginInput, LoginResultDto } from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  eq,
  sql,
  users,
  type DatabaseClient,
} from "@hosting-panel/database";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";
import { OidcService } from "./oidc.service.js";
import { hashPassword, verifyPassword } from "./password.js";
import { checkUserTotp, saveTotpStep } from "./totp-secret.js";

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const INVALID_CREDENTIALS_MESSAGE = "Email o password non corretti.";
const MESSAGES: Record<"ACCOUNT_LOCKED" | "TOTP_INVALID" | "ACCOUNT_SETUP_INCOMPLETE", string> = {
  ACCOUNT_LOCKED: "Account temporaneamente bloccato. Riprova più tardi.",
  TOTP_INVALID: "Codice di verifica non valido.",
  ACCOUNT_SETUP_INCOMPLETE: "Configurazione dell'account incompleta: è richiesta l'autenticazione a due fattori.",
};

// Hash of a random password, so unknown emails cost one scrypt like real ones.
let dummyHash: Promise<string> | undefined;

type UserRow = typeof users.$inferSelect;

@Injectable()
export class LoginService {
  public constructor(
    @Inject(CONTROL_PLANE_CONFIG_TOKEN)
    private readonly config: ControlPlaneRuntimeConfig,
    @Inject(DATABASE_CLIENT_TOKEN)
    private readonly dbClient: DatabaseClient,
    @Inject(OidcService)
    private readonly oidcService: OidcService,
  ) {}

  public async login(input: LoginInput, ip: string | null): Promise<LoginResultDto> {
    const [user] = await this.dbClient.db.select().from(users).where(eq(users.email, input.email)).limit(1);
    if (!user) {
      await verifyPassword(input.password, await getDummyHash());
      return this.fail(undefined, ip, "INVALID_CREDENTIALS", "unknown_user");
    }
    const now = Date.now();
    let locked = user.lockedUntil !== null && user.lockedUntil.getTime() > now;
    // Only password + TOTP may bypass a lock, so other requests to a locked account stop before any check.
    const canBypass = input.totpCode !== undefined && user.totpEnabledAt !== null;
    if (locked && !canBypass) return this.fail(user, ip, "ACCOUNT_LOCKED", "locked");
    // Reserve (count) the password attempt before scrypt, so parallel bursts get at most 5 checks.
    if (!locked && !(await this.reservePasswordAttempt(user.id))) {
      if (!canBypass) return this.fail(user, ip, "ACCOUNT_LOCKED", "locked");
      locked = true;
    }
    // A bypass attempt is counted before any verification, whatever the password, so the
    // DB side effects (and the lock) never reveal whether the password was right.
    if (locked && !(await this.reserveTotpAttempt(user.id))) {
      return this.fail(user, ip, "ACCOUNT_LOCKED", "locked");
    }

    const passwordOk = await verifyPassword(input.password, user.passwordHash ?? (await getDummyHash()));
    if (!user.passwordHash || !passwordOk || user.userStatus !== "active") {
      const reason = !passwordOk || !user.passwordHash ? "bad_password" : "inactive";
      return this.fail(user, ip, locked ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS", reason);
    }
    // Correct password: give the reserved attempt back.
    if (!locked) await this.dbClient.db.update(users).set({ failedLoginCount: 0 }).where(eq(users.id, user.id));

    if (user.totpEnabledAt === null) {
      if (user.platformRole === "infrastructure_admin") {
        return this.fail(user, ip, "ACCOUNT_SETUP_INCOMPLETE", "totp_not_enrolled");
      }
      await this.dbClient.db
        .update(users)
        .set({ failedLoginCount: 0, totpFailedCount: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
      return this.succeed(user, ip);
    }

    if (input.totpCode === undefined) return { status: "totp_required" };
    // Reserve (count) the TOTP guess before verifying (the locked path already did); refused while a
    // TOTP-caused lock is active.
    if (!locked && !(await this.reserveTotpAttempt(user.id))) {
      return this.fail(user, ip, "ACCOUNT_LOCKED", "locked");
    }

    const result = checkUserTotp(user, input.totpCode, now, this.config.secretsMasterKey);
    if (!result.ok) {
      return this.fail(user, ip, locked ? "ACCOUNT_LOCKED" : "TOTP_INVALID", "bad_totp");
    }
    // Conditional step save: of two concurrent logins with the same code, only one matches.
    const saved = await saveTotpStep(this.dbClient.db, user.id, result.step, {
      failedLoginCount: 0,
      totpFailedCount: 0,
      lockedUntil: null,
    });
    if (!saved) {
      return this.fail(user, ip, locked ? "ACCOUNT_LOCKED" : "TOTP_INVALID", "totp_reused");
    }
    return this.succeed(user, ip);
  }

  private async succeed(user: UserRow, ip: string | null): Promise<LoginResultDto> {
    const token = await this.oidcService.issueSessionToken({
      userId: user.id,
      email: user.email,
      displayName: user.name,
      ip,
    });
    await this.audit(user.id, ip, "auth.login.success", { jti: token.jti });
    return {
      status: "ok",
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      mustChangePassword: user.mustChangePassword,
    };
  }

  private async fail(
    user: UserRow | undefined,
    ip: string | null,
    code: "INVALID_CREDENTIALS" | keyof typeof MESSAGES,
    reason: string,
  ): Promise<never> {
    await this.audit(user?.id ?? null, ip, "auth.login.failure", { reason });
    throw new ControlPlaneError(
      code,
      code === "INVALID_CREDENTIALS" ? INVALID_CREDENTIALS_MESSAGE : MESSAGES[code],
    );
  }

  /**
   * One atomic statement, only while unlocked: count the attempt; the 5th locks for 15 minutes
   * and resets the counter. Returns false (no row) when the account is locked.
   */
  private async reservePasswordAttempt(userId: string): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const lockIso = new Date(Date.now() + LOCK_MS).toISOString();
    const next = sql`${users.failedLoginCount} + 1`;
    const rows = await this.dbClient.db
      .update(users)
      .set({
        failedLoginCount: sql`CASE WHEN ${next} >= ${MAX_FAILURES} THEN 0 ELSE ${next} END`,
        lockedUntil: sql`CASE WHEN ${next} >= ${MAX_FAILURES} THEN ${lockIso}::timestamptz ELSE ${users.lockedUntil} END`,
        // Runs only while unlocked, so a TOTP count >= 5 is left over from an expired TOTP lock;
        // clear it when locking, or it would refuse the bypass of this password-caused lock.
        totpFailedCount: sql`CASE WHEN ${next} >= ${MAX_FAILURES} AND ${users.totpFailedCount} >= ${MAX_FAILURES} THEN 0 ELSE ${users.totpFailedCount} END`,
      })
      .where(
        and(
          eq(users.id, userId),
          sql`(${users.lockedUntil} IS NULL OR ${users.lockedUntil} <= ${nowIso}::timestamptz)`,
        ),
      )
      .returning({ id: users.id });
    return rows.length > 0;
  }

  /**
   * Separate TOTP counter, counted even under a password-caused lock. After a TOTP lock has
   * passed it starts fresh; the 5th guess locks for 15 minutes. Returns false (no row) while a
   * TOTP-caused lock is active, so at most 5 codes are ever verified per lock window.
   */
  private async reserveTotpAttempt(userId: string): Promise<boolean> {
    const nowIso = new Date().toISOString();
    const lockIso = new Date(Date.now() + LOCK_MS).toISOString();
    const expired = sql`(${users.lockedUntil} IS NULL OR ${users.lockedUntil} <= ${nowIso}::timestamptz)`;
    const next = sql`CASE WHEN ${expired} AND ${users.totpFailedCount} >= ${MAX_FAILURES} THEN 1 ELSE ${users.totpFailedCount} + 1 END`;
    const rows = await this.dbClient.db
      .update(users)
      .set({
        totpFailedCount: next,
        lockedUntil: sql`CASE WHEN ${next} >= ${MAX_FAILURES} THEN GREATEST(${users.lockedUntil}, ${lockIso}::timestamptz) ELSE ${users.lockedUntil} END`,
      })
      .where(and(eq(users.id, userId), sql`(${expired} OR ${users.totpFailedCount} < ${MAX_FAILURES})`))
      .returning({ id: users.id });
    return rows.length > 0;
  }

  private async audit(
    userId: string | null,
    ip: string | null,
    action: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await appendAuditEvent(this.dbClient.db, {
      actorId: userId,
      actorType: userId ? "user" : "system",
      action,
      targetType: "user",
      targetId: userId,
      ipAddress: ip,
      details: { outcome: action === "auth.login.success" ? "succeeded" : "failed", ...details },
    });
  }
}

function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomUUID());
  return dummyHash;
}
