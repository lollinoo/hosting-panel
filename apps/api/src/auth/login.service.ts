import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { LoginInput, LoginResultDto } from "@hosting-panel/contracts";
import {
  and,
  appendAuditEvent,
  decryptSecretAesGcm,
  eq,
  isNull,
  lt,
  or,
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
import { verifyTotp } from "./totp.js";

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
    const now = Date.now();
    const locked = user?.lockedUntil != null && user.lockedUntil.getTime() > now;
    // Only password + TOTP may bypass a lock, so lock-only requests stop before any check.
    if (locked && input.totpCode === undefined) {
      return this.fail(user, ip, "ACCOUNT_LOCKED", "locked", false);
    }

    const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? (await getDummyHash()));
    if (!user || !user.passwordHash || !passwordOk || user.userStatus !== "active") {
      const reason = !user ? "unknown_user" : !passwordOk || !user.passwordHash ? "bad_password" : "inactive";
      return this.fail(user, ip, locked ? "ACCOUNT_LOCKED" : "INVALID_CREDENTIALS", reason, !locked);
    }

    if (user.totpEnabledAt === null) {
      if (locked) return this.fail(user, ip, "ACCOUNT_LOCKED", "locked", false);
      if (user.platformRole === "infrastructure_admin") {
        return this.fail(user, ip, "ACCOUNT_SETUP_INCOMPLETE", "totp_not_enrolled", false);
      }
      await this.dbClient.db
        .update(users)
        .set({ failedLoginCount: 0, lockedUntil: null })
        .where(eq(users.id, user.id));
      return this.succeed(user, ip);
    }

    if (input.totpCode === undefined) return { status: "totp_required" };

    const result = this.checkTotp(user, input.totpCode, now);
    if (!result.ok) {
      return this.fail(user, ip, locked ? "ACCOUNT_LOCKED" : "TOTP_INVALID", "bad_totp", !locked);
    }
    // Conditional step save: of two concurrent logins with the same code, only one matches.
    const saved = await this.dbClient.db
      .update(users)
      .set({ totpLastStep: result.step, failedLoginCount: 0, lockedUntil: null })
      .where(
        and(
          eq(users.id, user.id),
          or(isNull(users.totpLastStep), lt(users.totpLastStep, result.step)),
        ),
      )
      .returning({ id: users.id });
    if (saved.length === 0) {
      return this.fail(user, ip, locked ? "ACCOUNT_LOCKED" : "TOTP_INVALID", "totp_reused", !locked);
    }
    return this.succeed(user, ip);
  }

  private checkTotp(user: UserRow, code: string, now: number): { ok: true; step: number } | { ok: false } {
    try {
      const secret = decryptSecretAesGcm({
        ciphertextBase64: user.totpCiphertextBase64 ?? "",
        ivBase64: user.totpIvBase64 ?? "",
        authTagBase64: user.totpAuthTagBase64 ?? "",
        masterKey: this.config.secretsMasterKey,
        organizationId: "platform",
        siteId: null,
        secretKey: `totp:${user.id}`,
      });
      return verifyTotp(secret, code, now, user.totpLastStep);
    } catch {
      // A corrupt or undecryptable secret is a failed code, never a 500.
      return { ok: false };
    }
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
    countFailure: boolean,
  ): Promise<never> {
    if (user && countFailure) await this.recordFailure(user.id);
    await this.audit(user?.id ?? null, ip, "auth.login.failure", { reason });
    throw new ControlPlaneError(
      code,
      code === "INVALID_CREDENTIALS" ? INVALID_CREDENTIALS_MESSAGE : MESSAGES[code],
    );
  }

  /** One atomic statement: increment, and at the threshold lock and reset the counter. */
  private async recordFailure(userId: string): Promise<void> {
    const next = sql`${users.failedLoginCount} + 1`;
    const lockedUntil = new Date(Date.now() + LOCK_MS);
    await this.dbClient.db
      .update(users)
      .set({
        failedLoginCount: sql`CASE WHEN ${next} >= ${MAX_FAILURES} THEN 0 ELSE ${next} END`,
        lockedUntil: sql`CASE WHEN ${next} >= ${MAX_FAILURES} THEN ${lockedUntil.toISOString()}::timestamptz ELSE ${users.lockedUntil} END`,
      })
      .where(eq(users.id, userId));
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
