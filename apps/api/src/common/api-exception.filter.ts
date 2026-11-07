import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import {
  createErrorEnvelope,
  ERROR_CODE_HTTP_STATUS,
  type ErrorCode,
  type ErrorDetail,
} from "@hosting-panel/contracts";
import { CoolifyAdapterError, redactSensitiveString } from "@hosting-panel/coolify-adapter";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  ControlPlaneError,
  extractRawHeader,
  resolveRequestId,
} from "./control-plane.error.js";
import { SecretVaultService } from "../vault/secret-vault.service.js";

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  public constructor(
    @Inject(SecretVaultService) private readonly secretVault: SecretVaultService,
  ) {}

  public catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    if (reply.sent || reply.raw.headersSent) {
      return;
    }

    const requestId = resolveRequestId(request);
    const knownSecrets = [...this.secretVault.getAllKnownSecrets()];
    const rawAuth = extractRawHeader(
      request.headers as Record<string, string | string[] | undefined>,
      "authorization",
    );
    if (typeof rawAuth === "string" && rawAuth.trim().length >= 4) {
      knownSecrets.push(rawAuth.trim());
      const parts = rawAuth.trim().split(/\s+/);
      if (parts[1] && parts[1].length >= 4) {
        knownSecrets.push(parts[1]);
      }
    }

    let code: ErrorCode = "INTERNAL_ERROR";
    let message = "An unexpected internal error occurred.";
    let retryable: boolean | undefined;
    let details: ErrorDetail[] = [];
    let retryAfterSeconds: number | undefined;

    if (exception instanceof ControlPlaneError) {
      code = exception.code;
      message = redactSensitiveString(exception.message, knownSecrets);
      retryable = exception.retryable;
      details = exception.details.map((d) => ({
        ...(d.field ? { field: redactSensitiveString(d.field, knownSecrets) } : {}),
        message: redactSensitiveString(d.message, knownSecrets),
        ...(d.reason ? { reason: redactSensitiveString(d.reason, knownSecrets) } : {}),
      }));
      if (exception.retryAfterMs !== undefined && exception.retryAfterMs > 0) {
        retryAfterSeconds = Math.max(1, Math.ceil(exception.retryAfterMs / 1_000));
      }
    } else if (exception instanceof CoolifyAdapterError) {
      code = exception.code;
      message = redactSensitiveString(exception.message, knownSecrets);
      retryable = exception.retryable;
      if (exception.retryAfterMs !== undefined && exception.retryAfterMs > 0) {
        retryAfterSeconds = Math.max(1, Math.ceil(exception.retryAfterMs / 1_000));
      }
    } else if (exception instanceof ZodError) {
      code = "VALIDATION_ERROR";
      message = "Request validation failed.";
      retryable = false;
      details = exception.issues.map((issue) => ({
        ...(issue.path.length > 0 ? { field: issue.path.map(String).join(".") } : {}),
        message: redactSensitiveString(issue.message, knownSecrets),
        reason: issue.code,
      }));
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === 401) {
        code = "UNAUTHENTICATED";
        message = "Authentication required.";
      } else if (status === 403) {
        code = "PERMISSION_DENIED";
        message = "Permission denied.";
      } else if (status === 404) {
        code = "NOT_FOUND";
        message = "Requested endpoint or resource was not found.";
      } else if (status === 400 || status === 422) {
        code = "VALIDATION_ERROR";
        message = redactSensitiveString(exception.message || "Invalid request.", knownSecrets);
      } else {
        code = "INTERNAL_ERROR";
        message = "An unexpected internal error occurred.";
      }
    } else if (
      exception !== null &&
      typeof exception === "object" &&
      "statusCode" in exception &&
      (exception as { readonly statusCode?: unknown }).statusCode === 400
    ) {
      // Fastify JSON body parser error
      code = "VALIDATION_ERROR";
      message = "Malformed request payload.";
      retryable = false;
    }

    const statusCode = ERROR_CODE_HTTP_STATUS[code];
    const envelope = createErrorEnvelope({
      code,
      message,
      requestId,
      retryable,
      details,
    });

    reply.header("X-Request-ID", requestId);
    if (retryAfterSeconds !== undefined) {
      reply.header("Retry-After", String(retryAfterSeconds));
    }

    void reply.status(statusCode).send(envelope);
  }
}
