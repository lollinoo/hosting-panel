import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { LoginInput, LoginResultDto } from "@hosting-panel/contracts";
import {
  appendAuditEvent,
  eq,
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
import { reservePasswordAttempt, reserveTotpAttempt } from "./attempt-limits.js";
import { checkUserTotp, saveTotpStep } from "./totp-secret.js";

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
    if (!locked && !(await reservePasswordAttempt(this.dbClient.db, user.id))) {
      if (!canBypass) return this.fail(user, ip, "ACCOUNT_LOCKED", "locked");
      locked = true;
    }
    // A bypass attempt is counted before any verification, whatever the password, so the
    // DB side effects (and the lock) never reveal whether the password was right.
    if (locked && !(await reserveTotpAttempt(this.dbClient.db, user.id))) {
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
    if (!locked && !(await reserveTotpAttempt(this.dbClient.db, user.id))) {
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
