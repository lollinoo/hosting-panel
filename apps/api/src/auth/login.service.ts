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
import {
  assertPasswordGateOpen,
  hashPassword,
  oneCheckPerAccount,
  passwordGateLoad,
  verifyPassword,
} from "./password.js";
import { LOCK_MS, MAX_FAILURES, reservePasswordAttempt, reserveTotpAttempt } from "./attempt-limits.js";
import { checkUserTotp, saveTotpStep } from "./totp-secret.js";

const INVALID_CREDENTIALS_MESSAGE = "Email o password non corretti.";
const MESSAGES: Record<"ACCOUNT_LOCKED" | "TOTP_INVALID" | "ACCOUNT_SETUP_INCOMPLETE", string> = {
  ACCOUNT_LOCKED: "Account temporaneamente bloccato. Riprova più tardi.",
  TOTP_INVALID: "Codice di verifica non valido.",
  ACCOUNT_SETUP_INCOMPLETE: "Configurazione dell'account incompleta: è richiesta l'autenticazione a due fattori.",
};

// Hash of a random password, so unknown emails cost one scrypt like real ones.
let dummyHash: Promise<string> | undefined;
// Places of the password gate that unknown addresses may hold, so a flood of them never keeps real accounts out.
const UNKNOWN_ADDRESS_SHARE = 4;
// Unknown addresses counted in memory; the oldest goes first.
const UNKNOWN_ADDRESSES_MAX = 10_000;

type UserRow = typeof users.$inferSelect;

@Injectable()
export class LoginService {
  // shortcut: counted in this process only (a restart empties it), enough while one API process runs.
  private readonly unknownTries = new Map<string, { count: number; lockedUntil: number }>();

  public constructor(
    @Inject(CONTROL_PLANE_CONFIG_TOKEN)
    private readonly config: ControlPlaneRuntimeConfig,
    @Inject(DATABASE_CLIENT_TOKEN)
    private readonly dbClient: DatabaseClient,
    @Inject(OidcService)
    private readonly oidcService: OidcService,
  ) {}

  public login(input: LoginInput, ip: string | null): Promise<LoginResultDto> {
    // One password check at a time per address, sign-in and account routes together (LR-M1).
    return oneCheckPerAccount(input.email, () => this.loginNow(input, ip));
  }

  private async loginNow(input: LoginInput, ip: string | null): Promise<LoginResultDto> {
    const [user] = await this.dbClient.db.select().from(users).where(eq(users.email, input.email)).limit(1);
    const now = Date.now();
    if (!user) {
      const entry = this.unknownTries.get(input.email);
      if (entry && entry.lockedUntil > now) return this.fail(undefined, ip, "ACCOUNT_LOCKED", "locked");
      this.countUnknownTry(input.email, entry, now);
      const dummy = await getDummyHash();
      // The test and the entry run in the same tick, so a burst cannot pass the test together.
      if (passwordGateLoad() < UNKNOWN_ADDRESS_SHARE) await verifyPassword(input.password, dummy);
      return this.fail(undefined, ip, "INVALID_CREDENTIALS", "unknown_user");
    }
    let locked = user.lockedUntil !== null && user.lockedUntil.getTime() > now;
    // Only password + TOTP may bypass a lock, so other requests to a locked account stop before any check.
    const canBypass = input.totpCode !== undefined && user.totpEnabledAt !== null;
    if (locked && !canBypass) return this.fail(user, ip, "ACCOUNT_LOCKED", "locked");
    // A full gate refuses here, before any try is counted.
    assertPasswordGateOpen();
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

    const passwordOk = await verifyPassword(input.password, user.passwordHash ?? (await getDummyHash()), true);
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

  /** As reservePasswordAttempt: the 5th try locks for 15 minutes and sets the count back to 0. */
  private countUnknownTry(email: string, entry: { count: number; lockedUntil: number } | undefined, now: number): void {
    if (!entry) {
      if (this.unknownTries.size >= UNKNOWN_ADDRESSES_MAX) this.unknownTries.delete(this.unknownTries.keys().next().value!);
      entry = { count: 0, lockedUntil: 0 };
      this.unknownTries.set(email, entry);
    }
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) {
      entry.count = 0;
      entry.lockedUntil = now + LOCK_MS;
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
  ): Promise<never> {
    // No row for an unknown address or a try refused before any check (reason "locked"), so a loop of
    // tries cannot fill the table; every checked try keeps its row, a bypass try on a locked account included.
    if (user && reason !== "locked") await this.audit(user.id, ip, "auth.login.failure", { reason });
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
  // Admitted: one shared hash per process, and a known account without a password has its try counted already.
  // A failed first hash is not kept, or every later unknown address would fail.
  dummyHash ??= hashPassword(randomUUID(), true).catch((error: unknown) => {
    dummyHash = undefined;
    throw error;
  });
  return dummyHash;
}
