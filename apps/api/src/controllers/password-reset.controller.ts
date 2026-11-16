import { Body, Controller, HttpCode, HttpStatus, Inject, Post } from "@nestjs/common";
import { PasswordResetConfirmInputSchema, PasswordResetRequestInputSchema } from "@hosting-panel/contracts";
import { PasswordResetService } from "../auth/password-reset.service.js";

/** Password reset by mail for customer accounts; both routes work without a session. */
@Controller()
export class PasswordResetController {
  public constructor(@Inject(PasswordResetService) private readonly reset: PasswordResetService) {}

  /** Always 202 with an empty body, so the answer never tells whether the account exists. */
  @Post("v1/auth/password-reset/request")
  @HttpCode(HttpStatus.ACCEPTED)
  public request(@Body() rawBody: unknown): void {
    const { email } = PasswordResetRequestInputSchema.parse(rawBody ?? {});
    this.reset.request(email);
  }

  @Post("v1/auth/password-reset/confirm")
  @HttpCode(HttpStatus.NO_CONTENT)
  public async confirm(@Body() rawBody: unknown): Promise<void> {
    const { token, newPassword } = PasswordResetConfirmInputSchema.parse(rawBody ?? {});
    await this.reset.confirm(token, newPassword);
  }
}
