import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import {
  ERROR_CODES,
  ERROR_CODE_HTTP_STATUS,
  createErrorEnvelope,
  redactSensitiveString,
  type ErrorCode,
  type ErrorDetail,
} from "@hosting-panel/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  ControlPlaneError,
  resolveRequestId,
} from "./control-plane.error.js";

const ERROR_CODE_SET: ReadonlySet<string> = new Set(ERROR_CODES);

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  public catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    if (reply.sent || reply.raw.headersSent) {
      return;
    }

    const requestId = resolveRequestId(request);

    let code: ErrorCode = "INTERNAL_ERROR";
    let message = "An unexpected internal error occurred.";
    let retryable: boolean | undefined;
    let details: ErrorDetail[] = [];
    let retryAfterSeconds: number | undefined;

    if (exception instanceof ControlPlaneError) {
      code = exception.code;
      message = redactSensitiveString(exception.message);
      retryable = exception.retryable;
      details = exception.details.map((d) => ({
        ...(d.field ? { field: redactSensitiveString(d.field) } : {}),
        message: redactSensitiveString(d.message),
        ...(d.reason ? { reason: redactSensitiveString(d.reason) } : {}),
      }));
      if (exception.retryAfterMs !== undefined && exception.retryAfterMs > 0) {
        retryAfterSeconds = Math.max(1, Math.ceil(exception.retryAfterMs / 1_000));
      }
    } else if (
      exception !== null &&
      typeof exception === "object" &&
      "code" in exception &&
      typeof (exception as { code: unknown }).code === "string" &&
      ERROR_CODE_SET.has((exception as { code: string }).code)
    ) {
      const errWithCode = exception as { code: ErrorCode; message?: string };
      code = errWithCode.code;
      message = redactSensitiveString(errWithCode.message || `Error code: ${code}`);
    } else if (exception instanceof ZodError) {
      code = "VALIDATION_ERROR";
      message = "Request validation failed.";
      retryable = false;
      details = exception.issues.map((issue) => ({
        ...(issue.path.length > 0 ? { field: issue.path.map(String).join(".") } : {}),
        message: redactSensitiveString(issue.message),
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
        message = redactSensitiveString(exception.message || "Invalid request.");
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

    const statusCode = ERROR_CODE_HTTP_STATUS[code] ?? 500;
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
