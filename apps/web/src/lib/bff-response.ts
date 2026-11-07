import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import {
  findForbiddenPublicDtoKeys,
  redactSensitiveValue,
  type ErrorCode,
  type ErrorDetail,
  ERROR_CODE_HTTP_STATUS,
  isDefaultRetryableErrorCode,
} from "@hosting-panel/contracts";

export function bffJsonResponse(
  data: unknown,
  init?: ResponseInit
): NextResponse {
  let cleanData = data;
  const violations = findForbiddenPublicDtoKeys(cleanData);
  if (violations.length > 0) {
    cleanData = redactSensitiveValue(cleanData);
  }

  return NextResponse.json(cleanData, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, max-age=0",
      ...(init?.headers || {}),
    },
  });
}

export function bffErrorResponse(
  code: ErrorCode,
  message: string,
  statusOverride?: number,
  details: readonly ErrorDetail[] = [],
  requestId?: string
): NextResponse {
  const status = statusOverride ?? ERROR_CODE_HTTP_STATUS[code] ?? 500;
  const reqId = requestId || randomUUID();
  const retryable = isDefaultRetryableErrorCode(code);

  const errorEnvelope = {
    error: {
      code,
      message,
      requestId: reqId,
      retryable,
      details: [...details],
    },
  };

  return NextResponse.json(errorEnvelope, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
