import { Body, Controller, HttpCode, HttpStatus, Inject, Patch, Post, Req } from "@nestjs/common";
import { and, encryptSecretAesGcm, eq, isNull, users, type DatabaseClient } from "@hosting-panel/database";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AuthzContextService, type AuthenticatedRequestContext } from "../auth/authz-context.service.js";
import { OidcService } from "../auth/oidc.service.js";
import { reservePasswordAttempt, reserveTotpAttempt } from "../auth/attempt-limits.js";
import { assertPasswordPolicy, hashPassword, verifyPassword } from "../auth/password.js";
import { generateTotpSecret, buildOtpauthUri } from "../auth/totp.js";
import { checkUserTotp, saveTotpStep } from "../auth/totp-secret.js";
import { ControlPlaneError } from "../common/control-plane.error.js";
import {
  CONTROL_PLANE_CONFIG_TOKEN,
  DATABASE_CLIENT_TOKEN,
  type ControlPlaneRuntimeConfig,
} from "../tokens.js";

const PasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) });
const EnableBody = z.object({ code: z.string().min(1) });
const DisableBody = z.object({ password: z.string().min(1), code: z.string().min(1) });
const LocaleBody = z.object({ locale: z.enum(["it", "en"]) });

const BAD_PASSWORD = "Password non corretta.";
const BAD_CODE = "Codice di verifica non valido.";

@Controller("v1/me")
export class AccountController {
  public constructor(
    @Inject(AuthzContextService) private readonly authz: AuthzContextService,
    @Inject(OidcService) private readonly oidc: OidcService,
    @Inject(CONTROL_PLANE_CONFIG_TOKEN) private readonly config: ControlPlaneRuntimeConfig,
    @Inject(DATABASE_CLIENT_TOKEN) private readonly dbClient: DatabaseClient,
  ) {}

  @Post("password")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async changePassword(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<void> {
    const { auth, user } = await this.load(req);
    const body = PasswordBody.parse(raw ?? {});
    await this.reservePassword(auth, req, "account.password.change", user.id);
    if (!user.passwordHash || !(await verifyPassword(body.currentPassword, user.passwordHash))) {
      await this.fail(auth, req, "account.password.change", "INVALID_CREDENTIALS", BAD_PASSWORD);
    }
    assertPasswordPolicy(body.newPassword);
    await this.dbClient.db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), mustChangePassword: false, failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, user.id));
    await this.oidc.revokeAllSessionsForUser(user.id, auth.claims.jti);
    await this.authz.recordAudit(auth, req, { action: "account.password.change", targetType: "user", targetId: user.id });
  }

  @Post("totp/setup")
  @HttpCode(HttpStatus.OK)
  public async setupTotp(
    @Req() req: FastifyRequest,
  ): Promise<{ data: { secretBase32: string; otpauthUri: string } }> {
    const { auth, user } = await this.load(req);
    if (user.totpEnabledAt !== null) {
      throw new ControlPlaneError("VALIDATION_ERROR", "L'autenticazione a due fattori è già attiva.");
    }
    const secret = generateTotpSecret();
    const env = encryptSecretAesGcm({
      plaintext: secret,
      masterKey: this.config.secretsMasterKey,
      organizationId: "platform",
      siteId: null,
      secretKey: `totp:${user.id}`,
    });
    // Conditional on 2FA still being off, so a concurrent enable is never overwritten.
    const written = await this.dbClient.db
      .update(users)
      .set({
        totpCiphertextBase64: env.ciphertextBase64,
        totpIvBase64: env.ivBase64,
        totpAuthTagBase64: env.authTagBase64,
        totpLastStep: null,
      })
      .where(and(eq(users.id, user.id), isNull(users.totpEnabledAt)))
      .returning({ id: users.id });
    if (written.length === 0) {
      throw new ControlPlaneError("VALIDATION_ERROR", "L'autenticazione a due fattori è già attiva.");
    }
    await this.authz.recordAudit(auth, req, { action: "account.totp.setup", targetType: "user", targetId: user.id });
    return { data: { secretBase32: secret, otpauthUri: buildOtpauthUri(secret, user.email, "Hosting Panel") } };
  }

  @Post("totp/enable")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async enableTotp(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<void> {
    const { auth, user } = await this.load(req);
    const body = EnableBody.parse(raw ?? {});
    if (user.totpEnabledAt !== null) {
      throw new ControlPlaneError("VALIDATION_ERROR", "L'autenticazione a due fattori è già attiva.");
    }
    await this.reserveTotp(auth, req, "account.totp.enable", user.id);
    const result = checkUserTotp(user, body.code, Date.now(), this.config.secretsMasterKey);
    // Final write only if the secret we verified against is still the stored one.
    const sameSecret = and(isNull(users.totpEnabledAt), eq(users.totpCiphertextBase64, user.totpCiphertextBase64 ?? ""));
    const extra = { totpEnabledAt: new Date(), totpFailedCount: 0 };
    if (!result.ok || !(await saveTotpStep(this.dbClient.db, user.id, result.step, extra, sameSecret))) {
      await this.fail(auth, req, "account.totp.enable", "TOTP_INVALID", BAD_CODE);
    }
    await this.authz.recordAudit(auth, req, { action: "account.totp.enable", targetType: "user", targetId: user.id });
  }

  @Post("totp/disable")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async disableTotp(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<void> {
    const { auth, user } = await this.load(req);
    const body = DisableBody.parse(raw ?? {});
    if (user.platformRole === "infrastructure_admin") {
      await this.fail(auth, req, "account.totp.disable", "PERMISSION_DENIED", "Gli amministratori devono mantenere l'autenticazione a due fattori.");
    }
    await this.reservePassword(auth, req, "account.totp.disable", user.id);
    if (!user.passwordHash || !(await verifyPassword(body.password, user.passwordHash))) {
      await this.fail(auth, req, "account.totp.disable", "INVALID_CREDENTIALS", BAD_PASSWORD);
    }
    // Correct password: give the reserved attempt back, then count the code guess.
    await this.dbClient.db.update(users).set({ failedLoginCount: 0 }).where(eq(users.id, user.id));
    await this.reserveTotp(auth, req, "account.totp.disable", user.id);
    const result = user.totpEnabledAt
      ? checkUserTotp(user, body.code, Date.now(), this.config.secretsMasterKey)
      : ({ ok: false } as const);
    const cleared = {
      totpCiphertextBase64: null,
      totpIvBase64: null,
      totpAuthTagBase64: null,
      totpEnabledAt: null,
      totpLastStep: null,
      // Full success, as at login: also drop a lock set by this request's own 5th reservation.
      failedLoginCount: 0,
      totpFailedCount: 0,
      lockedUntil: null,
    };
    if (!result.ok || !(await saveTotpStep(this.dbClient.db, user.id, result.step, cleared))) {
      await this.fail(auth, req, "account.totp.disable", "TOTP_INVALID", BAD_CODE);
    }
    await this.authz.recordAudit(auth, req, { action: "account.totp.disable", targetType: "user", targetId: user.id });
  }

  @Patch("locale")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async setLocale(@Req() req: FastifyRequest, @Body() raw: unknown): Promise<void> {
    const { auth, user } = await this.load(req);
    const { locale } = LocaleBody.parse(raw ?? {});
    await this.dbClient.db.update(users).set({ locale }).where(eq(users.id, user.id));
    await this.authz.recordAudit(auth, req, {
      action: "account.locale.update",
      targetType: "user",
      targetId: user.id,
      details: { locale },
    });
  }

  // Same atomic reservations and limits as login: 5 per 15 minutes, then 423.
  private async reservePassword(auth: AuthenticatedRequestContext, req: FastifyRequest, action: string, userId: string) {
    if (!(await reservePasswordAttempt(this.dbClient.db, userId))) await this.locked(auth, req, action);
  }

  private async reserveTotp(auth: AuthenticatedRequestContext, req: FastifyRequest, action: string, userId: string) {
    if (!(await reserveTotpAttempt(this.dbClient.db, userId))) await this.locked(auth, req, action);
  }

  private locked(auth: AuthenticatedRequestContext, req: FastifyRequest, action: string): Promise<never> {
    return this.fail(auth, req, action, "ACCOUNT_LOCKED", "Account temporaneamente bloccato. Riprova più tardi.");
  }

  private async load(req: FastifyRequest) {
    const auth = await this.authz.authenticateRequest(req);
    const [user] = await this.dbClient.db.select().from(users).where(eq(users.id, auth.user.id)).limit(1);
    if (!user) throw new ControlPlaneError("UNAUTHENTICATED", "User account is not active.");
    return { auth, user };
  }

  private async fail(
    auth: AuthenticatedRequestContext,
    req: FastifyRequest,
    action: string,
    code: "INVALID_CREDENTIALS" | "TOTP_INVALID" | "PERMISSION_DENIED" | "ACCOUNT_LOCKED",
    message: string,
  ): Promise<never> {
    await this.authz.recordAudit(auth, req, {
      action,
      targetType: "user",
      targetId: auth.user.id,
      details: { outcome: "failed", reason: code },
    });
    throw new ControlPlaneError(code, message);
  }
}
